// Firebase 後端：Firestore 儲存資料、Authentication 管理身分、Cloud Messaging 推播
// 安全性由 firestore.rules 把關；需要伺服器權限的動作(推播、帳號管理)交給 Apps Script
import { CONFIG } from '../config.js';
import { ApiError } from '../core/errors.js';
import { DEFAULT_SETTINGS } from '../core/defaults.js';
import { formatNo, randomToken, startOfDay, pad2 } from '../core/format.js';
import {
  countItems, isFinal, priceLines, stockProblems, stockUpdates,
} from '../core/order-logic.js';

const SDK = `https://www.gstatic.com/firebasejs/${CONFIG.firebaseSdkVersion}`;
const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut,
} = await import(`${SDK}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, increment, Timestamp,
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

function cleanLines(lines) {
  return lines.map((l) => ({ itemId: l.itemId, qty: l.qty, option: l.option ?? null }));
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

// 圖片快取：同一版本的圖片只下載一次
const imageCache = new Map();

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

  getItemImages: (items) => guard(async () => {
    const out = {};
    await Promise.all(items.filter((i) => i.hasImage).map(async (it) => {
      const key = `${it.id}:${it.imageVersion || 0}`;
      if (!imageCache.has(key)) {
        const snap = await getDoc(ref('itemImages', it.id));
        imageCache.set(key, snap.exists() ? snap.data().data : null);
      }
      if (imageCache.get(key)) out[it.id] = imageCache.get(key);
    }));
    return out;
  }),

  submitPreorder: ({ lines, surname, phone, consentText }) => guard(async () => {
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
        const problems = stockProblems(lines, itemsById);
        if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);
        const seq = (cSnap.exists() ? cSnap.data().value : 0) + 1;
        const no = formatNo('preorder', seq);
        tx.set(ref('counters', 'A'), { value: seq, lastOrderId: orderRef.id });
        tx.set(orderRef, {
          type: 'preorder', seq, no, status: 'pending', uid,
          items: cleanLines(lines), itemCount: count, surname, pushEnabled: false,
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
      // 安全規則拒絕時，最常見的原因是這支電話已有進行中的訂單
      if (err?.code === 'permission-denied') {
        const s = snapData(await getDoc(sessionRef));
        if (!s || s.used) throw new ApiError('session-invalid');
        throw new ApiError('phone-active');
      }
      throw err;
    }
  }),

  reportOverLimit: ({ surname, phone, summary, count }) => guard(async () => {
    const uid = await customerUid();
    await setDoc(ref('inbox', uid), {
      type: 'over-limit', surname: surname.slice(0, 10), phone: phone.slice(0, 12),
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
    const { getMessaging, getToken, isSupported } = await import(`${SDK}/firebase-messaging.js`);
    if (!(await isSupported())) throw new ApiError('push-unsupported');
    const permission = await Notification.requestPermission();
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
  watchTodayOrders(cb) {
    const q = query(collection(db, 'orders'),
      where('createdAt', '>=', Timestamp.fromMillis(startOfDay())), orderBy('createdAt'));
    return watchQuery(q, cb, (list) => list.filter((o) => !o.deleted));
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

  rejectOrder: (orderId, reason) => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      status: 'rejected', rejectReason: reason || '', rejectedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
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
  }),

  sendMessage: (orderId, text) => guard(async () => {
    await updateDoc(ref('orders', orderId), {
      messages: arrayUnion({ text, at: Date.now() }), updatedAt: serverTimestamp(),
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

  createWalkin: ({ lines, payment, later, surname = '', phone = '' }) => guard(async () => {
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
        uid: null, claimedBy: null, items: cleanLines(lines), lines: priced.lines, total: priced.total,
        itemCount: countItems(lines), payment, surname, pushEnabled: false, messages: [], createdBy: staffUid,
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
    await deleteDoc(ref('itemImages', id));
    await deleteDoc(ref('items', id));
  }),

  setItemImage: (id, dataUrl) => guard(async () => {
    if (dataUrl) await setDoc(ref('itemImages', id), { data: dataUrl });
    else await deleteDoc(ref('itemImages', id));
    await updateDoc(ref('items', id), { hasImage: !!dataUrl, imageVersion: Date.now(), updatedAt: serverTimestamp() });
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

  resetCounters: () => guard(async () => {
    await setDoc(ref('counters', 'A'), { value: 0, lastOrderId: null });
    await setDoc(ref('counters', 'B'), { value: 0, lastOrderId: null });
  }),

  async resetDemo() {
    throw new ApiError('permission', '正式模式不能重設資料。');
  },
};
