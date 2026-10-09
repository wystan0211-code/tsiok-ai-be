// Firebase 後端：Firestore 儲存資料、Authentication 管理身分、Cloud Messaging 推播
// 安全性由 firestore.rules 把關；需要伺服器權限的動作(推播、帳號管理)交給 Apps Script
import { CONFIG } from '../config.js';
import { ApiError } from '../core/errors.js';
import { DEFAULT_SETTINGS } from '../core/defaults.js';
import { formatNo, randomToken, startOfDay, pad2 } from '../core/format.js';
import { itemImageRefs, imageDocId } from '../core/images.js';
import {
  countItems, isFinal, priceLines, stockProblems, stockUpdates, ORDER_TTL_MS, ACTIVE_STATUSES,
  optionProblems, cleanLines,
} from '../core/order-logic.js';
import { SUB_PREFS, applyLineChanges } from '../core/shortage.js';

const SDK = `https://www.gstatic.com/firebasejs/${CONFIG.firebaseSdkVersion}`;
const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut,
} = await import(`${SDK}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocFromCache, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch,
  onSnapshot, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, increment, Timestamp, deleteField,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);

// 離線快取：網路短暫中斷時，一般寫入會先存在裝置上，恢復連線後自動上傳
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch {
  db = initializeFirestore(app, {});
}

// ===== 共用工具 =====

// Firestore Timestamp 轉成毫秒數，讓頁面只處理一般數字
function plain(value) {
  if (value == null) return value;
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

function snapData(snap) {
  if (!snap.exists()) return null;
  return { id: snap.id, ...plain(snap.data({ serverTimestamps: 'estimate' })) };
}

function mapError(err) {
  if (err instanceof ApiError) return err;
  const code = err?.code || '';
  if (code === 'permission-denied') return new ApiError('permission');
  if (code === 'unavailable' || code === 'deadline-exceeded') return new ApiError('network');
  if (code === 'not-found') return new ApiError('not-found');
  if (code.startsWith('auth/')) {
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(code)) return new ApiError('auth');
    if (code === 'auth/user-disabled') return new ApiError('permission', '此帳號已停用，請洽管理員。');
    if (code === 'auth/too-many-requests') return new ApiError('auth', '嘗試次數過多，請稍後再試。');
    if (code === 'auth/network-request-failed') return new ApiError('network');
  }
  console.error(err);
  return new ApiError('unknown');
}

async function guard(task) {
  try {
    return await task();
  } catch (err) {
    throw mapError(err);
  }
}

function watchQuery(q, cb, transform = (list) => list) {
  return onSnapshot(q, (snap) => cb(transform(snap.docs.map(snapData))), (err) => {
    console.error('監聽失敗', err);
  });
}

const ref = (path, id) => doc(db, path, id);

async function authReady() {
  if (auth.authStateReady) await auth.authStateReady();
}

async function customerUid() {
  await authReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser.uid;
}

async function readItems(tx, lines) {
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const snaps = await Promise.all(ids.map((id) => tx.get(ref('items', id))));
  const map = {};
  for (const s of snaps) if (s.exists()) map[s.id] = { id: s.id, ...s.data() };
  return map;
}


// 送出預點被安全規則拒絕時的自我檢查(對照 firestore.rules 的 preorderChecks 等條件)
// 回傳代碼清單，全部通過時為 ['OK']；讀取失敗時加上 RD
//   AU 登入身分異常        ST-0 營業設定不存在  ST-A 未開放預點或欄位不是布林值  ST-M 數量上限欄位不是數字  ST-L 超過資料庫中的數量上限
//   SE-0 點餐連結不存在     SE-K 連結文件有多餘欄位  SE-T 連結代碼長度不符  SE-U 連結已使用  SE-O 連結已綁定訂單
//   CT-K 計數器有多餘欄位   CT-V 計數器數值不是整數
//   LN-N 明細行數不是 1～10  LN-K 明細有多餘欄位  LN-I 品項 ID 長度不符  LN-Q 數量不是 1～50 的整數  LN-O 選項文字超過 200 字  LN-S 選擇超過 50 個
//   NM 姓氏長度不是 1～10   TT 稱謂不符  LG 語言不符  PH 電話格式不符  CS 同意文字不是文字或超過 500 字  SP 缺貨偏好不符
//   LK 這組編號與電話的查詢紀錄已存在(僅供參考)
async function diagnoseSubmit({ uid, lines, surname, title, phone, consentText, lang, subPref, count }) {
  const codes = [];
  const len = (v) => [...String(v)].length;
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
  try {
    if (!auth.currentUser || auth.currentUser.uid !== uid) codes.push('AU');
    const [setSnap, sesSnap, cntSnap] = await Promise.all([
      getDoc(ref('settings', 'app')), getDoc(ref('sessions', uid)), getDoc(ref('counters', 'A')),
    ]);
    const st = setSnap.exists() ? setSnap.data() : null;
    if (!st) codes.push('ST-0');
    else {
      if (st.acceptingPreorders !== true) codes.push('ST-A');
      if (typeof st.maxItemsPerOrder !== 'number') codes.push('ST-M');
      else if (count > st.maxItemsPerOrder) codes.push('ST-L');
    }
    const se = sesSnap.exists() ? sesSnap.data() : null;
    if (!se) codes.push('SE-0');
    else {
      if (Object.keys(se).some((k) => !['token', 'used', 'orderId', 'updatedAt'].includes(k))) codes.push('SE-K');
      if (typeof se.token !== 'string' || se.token.length < 16 || se.token.length > 64) codes.push('SE-T');
      if (se.used !== false) codes.push('SE-U');
      if (se.orderId != null) codes.push('SE-O');
    }
    const ct = cntSnap.exists() ? cntSnap.data() : null;
    if (ct) {
      if (Object.keys(ct).some((k) => !['value', 'lastOrderId'].includes(k))) codes.push('CT-K');
      if (!isInt(ct.value)) codes.push('CT-V');
    }
    const itemsById = {};
    const ids = [...new Set(lines.map((l) => l.itemId))];
    const snaps = await Promise.all(ids.map((id) => getDoc(ref('items', id))));
    for (const sn of snaps) if (sn.exists()) itemsById[sn.id] = { id: sn.id, ...sn.data() };
    const items = cleanLines(lines, itemsById);
    if (items.length < 1 || items.length > 10) codes.push('LN-N');
    const add = (c) => { if (!codes.includes(c)) codes.push(c); };
    for (const l of items) {
      if (Object.keys(l).some((k) => !['itemId', 'qty', 'option', 'sel'].includes(k))) add('LN-K');
      if (typeof l.itemId !== 'string' || !l.itemId.length || l.itemId.length > 64) add('LN-I');
      if (!isInt(l.qty) || l.qty < 1 || l.qty > 50) add('LN-Q');
      if (l.option != null && (typeof l.option !== 'string' || len(l.option) > 200)) add('LN-O');
      if (l.sel != null && (!Array.isArray(l.sel) || l.sel.length > 50)) add('LN-S');
    }
    if (typeof surname !== 'string' || len(surname) < 1 || len(surname) > 10) codes.push('NM');
    if (!['先生', '小姐', '其他'].includes(title)) codes.push('TT');
    if (!['zh-Hant', 'en', 'ja'].includes(lang)) codes.push('LG');
    if (!/^09[0-9]{8}$/.test(phone)) codes.push('PH');
    if (typeof consentText !== 'string' || len(consentText) > 500) codes.push('CS');
    if (!SUB_PREFS.includes(subPref)) codes.push('SP');
    if (ct && isInt(ct.value)) {
      const lk = await getDoc(ref('lookups', `${formatNo('preorder', ct.value + 1)}_${phone}`));
      if (lk.exists()) codes.push('LK');
    }
  } catch (err) {
    console.warn('送出檢查失敗', err);
    codes.push('RD');
  }
  // LK 只是參考資訊，不影響判斷
  return codes.filter((c) => c !== 'LK').length ? codes : ['OK', ...codes];
}

// 解除電話綁定：訂單結束(取餐、拒絕、取消、作廢)後刪除該電話的綁定，失敗時不影響主要動作
async function releasePhone(orderId) {
  try {
    const contact = snapData(await getDoc(ref('contacts', orderId)));
    if (!contact?.phone) return;
    const lock = snapData(await getDoc(ref('activePhones', contact.phone)));
    if (lock?.orderId === orderId) await deleteDoc(ref('activePhones', contact.phone));
  } catch (err) {
    console.warn('解除電話綁定失敗', err);
  }
}

// 清除已結束或已不存在訂單的電話綁定(編號歸零、作廢時使用；進行中的訂單不清除)
async function cleanupPhoneLocks() {
  try {
    const snap = await getDocs(collection(db, 'activePhones'));
    for (const d of snap.docs) {
      const orderId = d.data().orderId;
      const order = orderId ? snapData(await getDoc(ref('orders', orderId))) : null;
      if (!order || isFinal(order)) await deleteDoc(d.ref);
    }
  } catch (err) {
    console.warn('清除電話綁定失敗', err);
  }
}

// 呼叫 Apps Script(推播、帳號管理)，附上目前登入者的身分憑證
async function callScript(action, payload = {}) {
  if (!CONFIG.appsScriptUrl) throw new ApiError('no-endpoint');
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new ApiError('permission');
  const idToken = await user.getIdToken();
  let json;
  try {
    const res = await fetch(CONFIG.appsScriptUrl, {
      method: 'POST',
      body: JSON.stringify({ action, idToken, ...payload }),
    });
    json = await res.json();
  } catch {
    throw new ApiError('network');
  }
  if (!json.ok) throw new ApiError(json.code || 'unknown', json.error);
  return json;
}

async function loadProfile(user) {
  if (!user || user.isAnonymous) return null;
  const username = (user.email || '').split('@')[0];
  if (CONFIG.adminUid && user.uid === CONFIG.adminUid) {
    return { uid: user.uid, username, displayName: user.displayName || '管理員', role: 'admin' };
  }
  const snap = await getDoc(ref('users', user.uid));
  if (!snap.exists()) return null;
  const u = snap.data();
  if (u.disabled) return null;
  return { uid: user.uid, username: u.username || username, displayName: u.displayName || username, role: u.role };
}

// 圖片快取：照片內容不會改變(換照片會產生新 ID)，所以先讀裝置上的快取，沒有才向伺服器讀取，
// 同一張照片只會消耗一次讀取額度與流量
const imageCache = new Map();
const siteImageCache = new Map();

async function readImage(coll, id, immutable = true) {
  const cache = immutable ? imageCache : siteImageCache;
  const key = `${coll}/${id}`;
  if (cache.has(key)) return cache.get(key);
  const task = (async () => {
    let snap = null;
    if (immutable) {
      try {
        snap = await getDocFromCache(ref(coll, id));
      } catch {
        snap = null;
      }
    }
    if (!snap || !snap.exists()) snap = await getDoc(ref(coll, id));
    return snap.exists() ? snap.data().data : null;
  })();
  cache.set(key, task);
  try {
    return await task;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export const api = {
  isDemo: false,

  // ===== 點餐者 =====
  initCustomer: () => guard(customerUid),

  getCustomerState: () => guard(async () => {
    const uid = await customerUid();
    const session = snapData(await getDoc(ref('sessions', uid)));
    let order = null;
    if (session?.orderId) order = snapData(await getDoc(ref('orders', session.orderId)));
    return { session, order };
  }),

  startSession: () => guard(async () => {
    const uid = await customerUid();
    const sRef = ref('sessions', uid);
    const session = snapData(await getDoc(sRef));
    if (session?.used && session.orderId) {
      const order = snapData(await getDoc(ref('orders', session.orderId)));
      if (!isFinal(order)) throw new ApiError('active-order', null, { orderId: session.orderId });
    }
    const token = randomToken();
    await setDoc(sRef, { token, used: false, orderId: null, updatedAt: serverTimestamp() });
    return token;
  }),

  checkSession: (token) => guard(async () => {
    const uid = await customerUid();
    const s = snapData(await getDoc(ref('sessions', uid)));
    if (!s || s.token !== token) return { ok: false, reason: 'invalid' };
    if (s.used) return { ok: false, reason: 'used', orderId: s.orderId };
    return { ok: true };
  }),

  watchSettings(cb) {
    return onSnapshot(ref('settings', 'app'), (snap) => {
      cb({ ...DEFAULT_SETTINGS, ...(snapData(snap) || {}) });
    }, (err) => console.error('設定監聽失敗', err));
  },

  watchMenu(cb) {
    return watchQuery(collection(db, 'items'), cb, (list) => list
      .filter((i) => i.active)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
  },

  // 各品項的封面小圖：{ 品項ID: dataURL }
  getItemImages: (items) => guard(async () => {
    const out = {};
    await Promise.all(items.map(async (it) => {
      const cover = itemImageRefs(it)[0];
      if (!cover) return;
      const data = await readImage('itemImages', imageDocId(cover, 's'));
      if (data) out[it.id] = data;
    }));
    return out;
  }),

  // 指定照片的圖：refs 為 itemImageRefs() 的結果，size 為 's' 或 'l'；回傳 { 照片ID: dataURL }
  getImages: (refs, size = 'l') => guard(async () => {
    const out = {};
    await Promise.all(refs.map(async (r) => {
      const data = await readImage('itemImages', imageDocId(r, size));
      if (data) out[r.id] = data;
    }));
    return out;
  }),

  watchCategories(cb) {
    return watchQuery(collection(db, 'categories'), cb, (list) => list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
  },

  // 橫幅輪播：依順序回傳 [{ id, data }]
  watchBanners(cb) {
    return watchQuery(collection(db, 'banners'), cb, (list) => list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
  },

  // 網站圖片(目前只有攤位位置圖 guide)
  getSiteImage: (id) => guard(async () => readImage('siteImages', id, false)),

  submitPreorder: ({ lines, surname, title, phone, consentText, lang = 'zh-Hant', subPref }) => guard(async () => {
    if (!SUB_PREFS.includes(subPref)) throw new ApiError('invalid');
    const uid = await customerUid();
    const settings = { ...DEFAULT_SETTINGS, ...(snapData(await getDoc(ref('settings', 'app'))) || {}) };
    if (!settings.acceptingPreorders) throw new ApiError('closed');
    const count = countItems(lines);
    if (count < 1) throw new ApiError('invalid');
    if (count > settings.maxItemsPerOrder) throw new ApiError('over-limit');

    const orderRef = doc(collection(db, 'orders'));
    const sessionRef = ref('sessions', uid);
    try {
      return await runTransaction(db, async (tx) => {
        const [cSnap, sSnap] = await Promise.all([tx.get(ref('counters', 'A')), tx.get(sessionRef)]);
        if (!sSnap.exists() || sSnap.data().used) throw new ApiError('session-invalid');
        const itemsById = await readItems(tx, lines);
        const problems = [...stockProblems(lines, itemsById), ...optionProblems(lines, itemsById)];
        if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);
        const seq = (cSnap.exists() ? cSnap.data().value : 0) + 1;
        const no = formatNo('preorder', seq);
        tx.set(ref('counters', 'A'), { value: seq, lastOrderId: orderRef.id });
        tx.set(orderRef, {
          type: 'preorder', seq, no, status: 'pending', uid,
          items: cleanLines(lines, itemsById), itemCount: count, surname, title, lang, pushEnabled: false, subPref,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        tx.set(ref('contacts', orderRef.id), {
          orderId: orderRef.id, surname, phone, consentNotify: true, consentText,
          consentAt: serverTimestamp(), createdAt: serverTimestamp(),
        });
        tx.set(ref('activePhones', phone), { uid, orderId: orderRef.id, updatedAt: serverTimestamp() });
        tx.update(sessionRef, { used: true, orderId: orderRef.id, updatedAt: serverTimestamp() });
        tx.set(ref('lookups', `${no}_${phone}`), { orderId: orderRef.id, createdAt: serverTimestamp() });
        return { orderId: orderRef.id, no };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err?.code === 'permission-denied') {
        const s = snapData(await getDoc(sessionRef));
        if (!s || s.used) throw new ApiError('session-invalid');
        // 安全規則拒絕：顧客端讀得到的條件逐項自我檢查，結果以代碼顯示在錯誤訊息下方
        // 檢查都通過(OK)時，最可能的原因是這支電話已有進行中的訂單；有任何一項不通過，就不是電話的問題
        const codes = await diagnoseSubmit({ uid, lines, surname, title, phone, consentText, lang, subPref, count });
        const ok = codes.length === 1 && codes[0] === 'OK';
        throw new ApiError(ok ? 'phone-active' : 'submit-denied', null, { diag: ['PD', ...codes].join(' ') });
      }
      throw err;
    }
  }),

  reportOverLimit: ({ surname, phone, summary, count }) => guard(async () => {
    const uid = await customerUid();
    await setDoc(ref('inbox', uid), {
      type: 'over-limit', surname: surname.slice(0, 12), phone: phone.slice(0, 12),
      summary: summary.slice(0, 300), count, attempts: increment(1), read: false,
      lastAt: serverTimestamp(),
    }, { merge: true });
  }),

  watchOrder(orderId, cb) {
    return onSnapshot(ref('orders', orderId), (snap) => cb(snapData(snap)), (err) => {
      console.error('訂單監聽失敗', err);
      cb(null);
    });
  },

  cancelOrder: (orderId) => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      status: 'cancelled', cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  }),

  findOrder: (no, phone) => guard(async () => {
    await customerUid();
    const snap = await getDoc(ref('lookups', `${String(no).toUpperCase()}_${phone}`));
    return snap.exists() ? snap.data().orderId : null;
  }),

  claimOrder: (orderId) => guard(async () => {
    const uid = await customerUid();
    const o = snapData(await getDoc(ref('orders', orderId)));
    if (!o) throw new ApiError('not-found');
    if (o.uid === uid || o.claimedBy === uid) return true;
    if (o.type !== 'walkin') return false;
    if (o.claimedBy) throw new ApiError('claimed');
    await updateDoc(ref('orders', orderId), { claimedBy: uid, updatedAt: serverTimestamp() });
    return true;
  }),

  enablePush: (orderId) => guard(async () => {
    if (!CONFIG.vapidKey) throw new ApiError('push-unsupported', '尚未設定推播憑證(vapidKey)。');
    if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new ApiError('push-unsupported');
    // 系統權限視窗必須在使用者點擊的當下跳出(iPhone 特別嚴格)，所以在任何等待之前先請求
    const permissionTask = Notification.requestPermission();
    const { getMessaging, getToken, isSupported } = await import(`${SDK}/firebase-messaging.js`);
    if (!(await isSupported())) throw new ApiError('push-unsupported');
    const permission = await permissionTask;
    if (permission !== 'granted') throw new ApiError('push-denied');
    const swUrl = `sw.js?v=${CONFIG.firebaseSdkVersion}&config=${encodeURIComponent(JSON.stringify(CONFIG.firebase))}`;
    const registration = await navigator.serviceWorker.register(swUrl, { scope: './' });
    await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(app), { vapidKey: CONFIG.vapidKey, serviceWorkerRegistration: registration });
    if (!token) throw new ApiError('push-unsupported');
    await customerUid();
    await setDoc(ref('pushTokens', orderId), { token, updatedAt: serverTimestamp() });
    await updateDoc(ref('orders', orderId), { pushEnabled: true, updatedAt: serverTimestamp() });
    return true;
  }),

  // ===== 員工登入 =====
  onStaffAuth(cb) {
    return onAuthStateChanged(auth, async (user) => {
      try {
        cb(await loadProfile(user));
      } catch (err) {
        console.error(err);
        cb(null);
      }
    });
  },

  staffLogin: (username, password) => guard(async () => {
    const name = username.trim().toLowerCase();
    const email = name.includes('@') ? name : `${name}@${CONFIG.staffEmailDomain}`;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const profile = await loadProfile(cred.user);
    if (!profile) {
      await signOut(auth);
      throw new ApiError('permission', '此帳號沒有攤位權限或已停用，請洽管理員。');
    }
    return profile;
  }),

  staffLogout: () => guard(() => signOut(auth)),

  // ===== 攤位營運 =====
  // 今天的訂單，加上 12 小時內建立、跨日但還沒結束的訂單(例如前一晚 23:50 的單)
  watchTodayOrders(cb) {
    const today = startOfDay();
    const from = Math.min(today, Date.now() - ORDER_TTL_MS);
    const q = query(collection(db, 'orders'),
      where('createdAt', '>=', Timestamp.fromMillis(from)), orderBy('createdAt'));
    return watchQuery(q, cb, (list) => list.filter((o) => !o.deleted && (o.createdAt >= today || !isFinal(o))));
  },

  acceptOrder: (orderId) => guard(async () => {
    const oRef = ref('orders', orderId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(oRef);
      if (!snap.exists()) throw new ApiError('not-found');
      const o = snap.data();
      if (o.status !== 'pending') throw new ApiError('bad-state');
      const itemsById = await readItems(tx, o.items);
      const problems = stockProblems(o.items, itemsById);
      if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`, { problems });
      const priced = priceLines(o.items, itemsById);
      for (const [id, st] of Object.entries(stockUpdates(o.items, itemsById))) {
        tx.update(ref('items', id), { ...st, updatedAt: serverTimestamp() });
      }
      tx.update(oRef, {
        status: 'accepted', lines: priced.lines, total: priced.total,
        acceptedAt: serverTimestamp(), establishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    });
  }),

  rejectOrder: (orderId, reason, reasonTr = '') => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      status: 'rejected', rejectReason: reason || '', rejectReasonTr: reasonTr || '',
      rejectedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    await releasePhone(orderId);
  }),

  markReady: (orderId) => guard(async () => {
    await updateDoc(ref('orders', orderId), { status: 'ready', readyAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }),

  undoReady: (orderId) => guard(async () => {
    await updateDoc(ref('orders', orderId), { status: 'accepted', readyAt: null, updatedAt: serverTimestamp() });
  }),

  markPicked: (orderId, payment) => guard(async () => {
    const o = snapData(await getDoc(ref('orders', orderId)));
    await updateDoc(ref('orders', orderId), {
      status: 'picked', pickedAt: serverTimestamp(), payment: payment || '園遊券',
      ...(o?.readyAt ? {} : { readyAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    });
    await releasePhone(orderId);
  }),

  // ===== 已接單後的缺貨處理 =====
  // 修改明細：刪除或替代部分品項，調整庫存並通知顧客；品項全部刪除時視為刪除整張訂單
  // shortageId：處理顧客回覆時帶入，確保同一則回覆只會被套用一次(多台攤位裝置同時處理時)
  changeOrderLines: (orderId, actions, {
    message = '', messageTr = '', clearShortage = false, cancelReason = '', shortageId = '',
  } = {}) => guard(async () => {
    const oRef = ref('orders', orderId);
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(oRef);
      if (!snap.exists()) throw new ApiError('not-found');
      const o = snap.data();
      if (!['accepted', 'ready'].includes(o.status) || !o.lines?.length) throw new ApiError('bad-state');
      if (shortageId && o.shortage?.id !== shortageId) throw new ApiError('bad-state');
      const ids = [...new Set([...o.lines.map((l) => l.itemId), ...actions.map((a) => a.replace?.itemId).filter(Boolean)])];
      const itemsById = await readItems(tx, ids.map((itemId) => ({ itemId })));
      const res = applyLineChanges(o.lines, itemsById, actions);
      for (const [id, delta] of Object.entries(res.stock)) {
        if (delta && itemsById[id]) tx.update(ref('items', id), { soldCount: Math.max(0, (itemsById[id].soldCount || 0) + delta), updatedAt: serverTimestamp() });
      }
      const patch = {
        lines: res.lines, total: res.total, itemCount: res.itemCount, totalChanged: true, updatedAt: serverTimestamp(),
      };
      if (message) patch.messages = [...(o.messages || []), { text: message, at: Date.now(), ...(messageTr ? { tr: messageTr } : {}) }];
      if (clearShortage) {
        patch.shortage = deleteField();
        patch.shortageReply = deleteField();
      }
      const cancelled = res.lines.length === 0;
      if (cancelled) {
        Object.assign(patch, {
          status: 'cancelled', cancelledBy: 'stall', cancelReason: cancelReason || '品項已售完',
          cancelledAt: serverTimestamp(),
        });
      }
      tx.update(oRef, patch);
      return { cancelled, notes: res.notes };
    });
    if (result.cancelled) await releasePhone(orderId);
    return result;
  }),

  // 請顧客選擇替代品：requests = [{ key, index, itemId, sel, qty, candidates: [{ itemId, sel }] }]
  requestShortage: (orderId, requests) => guard(async () => {
    const id = randomToken(6);
    await updateDoc(ref('orders', orderId), {
      shortage: { id, requests, sentAt: Date.now() }, shortageReply: deleteField(), updatedAt: serverTimestamp(),
    });
    return id;
  }),

  // 顧客回覆替代選擇：answers = { 請求key: 候選索引(-1 為刪除該品項) }
  replyShortage: (orderId, shortageId, answers) => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      shortageReply: { id: shortageId, answers, at: Date.now() }, updatedAt: serverTimestamp(),
    });
  }),

  // 攤位刪除整張訂單(已接單後)：已售數量加回，解除電話綁定
  cancelByStall: (orderId, reason, reasonTr = '') => guard(async () => {
    const oRef = ref('orders', orderId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(oRef);
      if (!snap.exists()) throw new ApiError('not-found');
      const o = snap.data();
      if (!['accepted', 'ready'].includes(o.status)) throw new ApiError('bad-state');
      const lines = o.lines || [];
      const itemsById = await readItems(tx, lines);
      const back = {};
      for (const l of lines) back[l.itemId] = (back[l.itemId] || 0) + l.qty;
      for (const [id, qty] of Object.entries(back)) {
        if (itemsById[id]) tx.update(ref('items', id), { soldCount: Math.max(0, (itemsById[id].soldCount || 0) - qty), updatedAt: serverTimestamp() });
      }
      tx.update(oRef, {
        status: 'cancelled', cancelledBy: 'stall', cancelReason: reason || '', cancelReasonTr: reasonTr || '',
        cancelledAt: serverTimestamp(), shortage: deleteField(), shortageReply: deleteField(), updatedAt: serverTimestamp(),
      });
    });
    await releasePhone(orderId);
  }),

  // 攤位的替代設定記憶(所有攤位裝置共用)
  getSubMemory: (key) => guard(async () => snapData(await getDoc(ref('subMemory', key)))?.candidates || null),
  saveSubMemory: (key, candidates) => guard(async () => {
    await setDoc(ref('subMemory', key), { candidates, updatedAt: serverTimestamp() });
  }),
  // 電話綁定查詢(後台)：回傳 { lock: { orderId, uid, updatedAt } | null, order: 訂單 | null }
  getPhoneLock: (phone) => guard(async () => {
    const lock = snapData(await getDoc(ref('activePhones', phone)));
    if (!lock) return { lock: null, order: null };
    const order = lock.orderId ? snapData(await getDoc(ref('orders', lock.orderId))) : null;
    return { lock, order };
  }),

  // 一鍵解除電話綁定(管理員可解除進行中的；店員、主管只能解除已結束訂單的)
  releasePhoneLock: (phone) => guard(async () => {
    await deleteDoc(ref('activePhones', phone));
  }),

  clearSubMemory: () => guard(async () => {
    const snap = await getDocs(collection(db, 'subMemory'));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return snap.size;
  }),

  // tr：翻譯成顧客語言的訊息(顧客使用中文時為空)
  sendMessage: (orderId, text, tr = '') => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      messages: arrayUnion({ text, at: Date.now(), ...(tr ? { tr } : {}) }), updatedAt: serverTimestamp(),
    });
  }),

  // 透過 Apps Script 發送推播；沒有設定或顧客沒開通知時回傳 sent:false
  async notifyCustomer(orderId, kind, text = '') {
    try {
      const res = await callScript('push', { orderId, kind, text });
      return { sent: !!res.sent, reason: res.reason || '' };
    } catch (err) {
      return { sent: false, reason: err.code || 'error' };
    }
  },

  getContact: (orderId) => guard(async () => snapData(await getDoc(ref('contacts', orderId)))),

  // 機器翻譯(Apps Script 內建 Google 翻譯)：回傳 { en: [...], ja: [...] }；失敗時回傳 null
  // 商標「九愛！買」與範本變數 {no}、{surname} 先換成記號，翻譯後再還原，確保不被翻譯
  async translate(texts, langs = ['en', 'ja']) {
    const KEEP = ['九愛！買', '{no}', '{surname}'];
    const protect = (s) => KEEP.reduce((acc, k, i) => acc.split(k).join(`[[${i}]]`), String(s || ''));
    const restore = (s) => String(s || '').replace(/\[\[\s*(\d)\s*\]\]/g, (m, i) => KEEP[Number(i)] ?? m);
    try {
      const res = await callScript('translate', { texts: texts.map(protect), langs });
      if (!res.results) return null;
      const out = {};
      for (const [lang, list] of Object.entries(res.results)) out[lang] = list.map(restore);
      return out;
    } catch (err) {
      console.warn('翻譯失敗', err);
      return null;
    }
  },

  createWalkin: ({ lines, payment, later, surname = '', title = '', phone = '' }) => guard(async () => {
    const staffUid = auth.currentUser?.uid;
    const orderRef = doc(collection(db, 'orders'));
    return runTransaction(db, async (tx) => {
      const cSnap = await tx.get(ref('counters', 'B'));
      const itemsById = await readItems(tx, lines);
      const problems = stockProblems(lines, itemsById);
      if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);
      const priced = priceLines(lines, itemsById);
      const seq = (cSnap.exists() ? cSnap.data().value : 0) + 1;
      const no = formatNo('walkin', seq);
      const now = serverTimestamp();
      for (const [id, st] of Object.entries(stockUpdates(lines, itemsById))) {
        tx.update(ref('items', id), { ...st, updatedAt: now });
      }
      tx.set(ref('counters', 'B'), { value: seq, lastOrderId: orderRef.id });
      tx.set(orderRef, {
        type: 'walkin', seq, no, status: later ? 'accepted' : 'picked', later: !!later,
        uid: null, claimedBy: null, items: cleanLines(lines, itemsById), lines: priced.lines, total: priced.total,
        itemCount: countItems(lines), payment, surname, title, pushEnabled: false, messages: [], createdBy: staffUid,
        createdAt: now, updatedAt: now, acceptedAt: now, establishedAt: now,
        ...(later ? {} : { readyAt: now, pickedAt: now }),
      });
      if (phone) {
        tx.set(ref('contacts', orderRef.id), {
          orderId: orderRef.id, surname, phone, consentNotify: true, consentText: '現場口頭同意',
          consentAt: now, createdAt: now,
        });
        tx.set(ref('lookups', `${no}_${phone}`), { orderId: orderRef.id, createdAt: now });
      }
      return { orderId: orderRef.id, no };
    });
  }),

  watchInbox(cb) {
    return watchQuery(query(collection(db, 'inbox'), orderBy('lastAt', 'desc'), limit(50)), cb);
  },

  markInboxRead: (id) => guard(async () => {
    await updateDoc(ref('inbox', id), { read: true, readAt: serverTimestamp() });
  }),

  setAccepting: (value) => guard(async () => {
    await updateDoc(ref('settings', 'app'), { acceptingPreorders: !!value, updatedAt: serverTimestamp() });
  }),

  // ===== 攤位主管 =====
  watchAllItems(cb) {
    return watchQuery(collection(db, 'items'), cb, (list) => list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
  },

  saveItem: (item) => guard(async () => {
    const { id, ...data } = item;
    if (id) {
      await updateDoc(ref('items', id), { ...data, updatedAt: serverTimestamp() });
      return id;
    }
    const created = await addDoc(collection(db, 'items'), {
      soldCount: 0, hasImage: false, imageVersion: 0, ...data, updatedAt: serverTimestamp(),
    });
    return created.id;
  }),

  deleteItem: (id) => guard(async () => {
    const snap = await getDoc(ref('items', id));
    const refs = snap.exists() ? itemImageRefs({ id, ...snap.data() }) : [];
    const batch = writeBatch(db);
    for (const r of refs) {
      batch.delete(ref('itemImages', imageDocId(r, 's')));
      if (!r.legacy) batch.delete(ref('itemImages', imageDocId(r, 'l')));
    }
    batch.delete(ref('items', id));
    await batch.commit();
  }),

  // 更新品項照片：add 為新照片 [{ id, small, large }]，order 為最後的照片順序，remove 為要刪除的照片參照
  saveItemImages: (itemId, { add = [], order = [], remove = [] }) => guard(async () => {
    // 每張大圖約 150KB，分批寫入避免單次請求過大
    for (const img of add) {
      await setDoc(ref('itemImages', `${img.id}_s`), { data: img.small, itemId });
      await setDoc(ref('itemImages', `${img.id}_l`), { data: img.large, itemId });
    }
    await updateDoc(ref('items', itemId), {
      images: order, hasImage: order.length > 0, imageVersion: Date.now(), updatedAt: serverTimestamp(),
    });
    for (const r of remove) {
      await deleteDoc(ref('itemImages', imageDocId(r, 's')));
      if (!r.legacy) await deleteDoc(ref('itemImages', imageDocId(r, 'l')));
    }
  }),

  // ===== 分類 =====
  saveCategory: (cat) => guard(async () => {
    const { id, ...data } = cat;
    if (id) {
      await updateDoc(ref('categories', id), { ...data, updatedAt: serverTimestamp() });
      return id;
    }
    return (await addDoc(collection(db, 'categories'), { ...data, updatedAt: serverTimestamp() })).id;
  }),

  deleteCategory: (id) => guard(async () => {
    await deleteDoc(ref('categories', id));
  }),

  // ===== 橫幅輪播 =====
  addBanner: (dataUrl, sortOrder) => guard(async () => {
    await addDoc(collection(db, 'banners'), { data: dataUrl, sortOrder, updatedAt: serverTimestamp() });
  }),

  deleteBanner: (id) => guard(async () => {
    await deleteDoc(ref('banners', id));
  }),

  reorderBanners: (ids) => guard(async () => {
    const batch = writeBatch(db);
    ids.forEach((id, i) => batch.update(ref('banners', id), { sortOrder: i + 1 }));
    await batch.commit();
  }),

  setSiteImage: (id, dataUrl) => guard(async () => {
    if (dataUrl) await setDoc(ref('siteImages', id), { data: dataUrl, updatedAt: serverTimestamp() });
    else await deleteDoc(ref('siteImages', id));
    siteImageCache.delete(id);
  }),

  saveSettings: (patch) => guard(async () => {
    await setDoc(ref('settings', 'app'), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  }),

  // 第一次使用時建立設定文件(安全規則需要讀取它)
  ensureSettings: () => guard(async () => {
    const snap = await getDoc(ref('settings', 'app'));
    if (!snap.exists()) await setDoc(ref('settings', 'app'), { ...DEFAULT_SETTINGS, updatedAt: serverTimestamp() });
  }),

  listOrders: ({ from, to }) => guard(async () => {
    const q = query(collection(db, 'orders'),
      where('createdAt', '>=', Timestamp.fromMillis(from)),
      where('createdAt', '<', Timestamp.fromMillis(to)), orderBy('createdAt'));
    return (await getDocs(q)).docs.map(snapData);
  }),

  listContacts: (orderIds) => guard(async () => {
    const out = {};
    await Promise.all(orderIds.map(async (id) => {
      const c = snapData(await getDoc(ref('contacts', id)));
      if (c) out[id] = c;
    }));
    return out;
  }),

  // ===== 管理員 =====
  adminUpdateOrder: (id, patch) => guard(async () => {
    await updateDoc(ref('orders', id), { ...patch, updatedAt: serverTimestamp() });
  }),

  // 軟刪除：保留資料並標記，試算表同步時會顯示「已刪除」
  adminDeleteOrder: (id) => guard(async () => {
    await updateDoc(ref('orders', id), { deleted: true, deletedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }),

  adminCreateManual: ({ lines, total, payment, note }) => guard(async () => {
    const d = new Date();
    const created = await addDoc(collection(db, 'orders'), {
      type: 'manual', seq: 0, no: `M${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
      status: 'picked', lines, items: [], total, itemCount: lines.reduce((s, l) => s + l.qty, 0),
      payment, note: note || '', surname: '', createdBy: auth.currentUser?.uid || null,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      establishedAt: serverTimestamp(), pickedAt: serverTimestamp(),
    });
    return created.id;
  }),

  listAccounts: () => guard(async () => (await getDocs(collection(db, 'users'))).docs.map((s) => ({ uid: s.id, ...plain(s.data()) }))),

  createAccount: (data) => guard(async () => (await callScript('createAccount', data)).uid),

  updateAccount: (uid, patch) => guard(async () => {
    await callScript('updateAccount', { uid, ...patch });
  }),

  deleteAccount: (uid) => guard(async () => {
    await callScript('deleteAccount', { uid });
  }),

  // 所有未結束的訂單(含前幾天、已超過時效的)，給「作廢所有未完成訂單」確認用
  listUnfinishedOrders: () => guard(async () => {
    const snap = await getDocs(query(collection(db, 'orders'), where('status', 'in', ACTIVE_STATUSES)));
    return snap.docs.map(snapData).filter((o) => !o.deleted).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }),

  // 作廢：改為「已取消」並標記 voided，不刪除資料、不通知顧客；每批最多 400 筆
  voidOrders: (ids) => guard(async () => {
    const by = auth.currentUser?.uid || null;
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + 400)) {
        batch.update(ref('orders', id), {
          status: 'cancelled', voided: true, voidedBy: by,
          cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    await cleanupPhoneLocks();
    return ids.length;
  }),

  resetCounters: () => guard(async () => {
    await setDoc(ref('counters', 'A'), { value: 0, lastOrderId: null });
    await setDoc(ref('counters', 'B'), { value: 0, lastOrderId: null });
    await cleanupPhoneLocks();
  }),

  async resetDemo() {
    throw new ApiError('permission', '正式模式不能重設資料。');
  },
};
