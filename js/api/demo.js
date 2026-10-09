// 展示模式後端：資料存在瀏覽器 localStorage，用 BroadcastChannel 讓同一瀏覽器的分頁即時同步
// 規則與 Firebase 版相同(一次性連結、每支電話一張進行中訂單、數量上限、庫存)，方便在連接 Firebase 前完整測試流程
import { ApiError } from '../core/errors.js';
import { DEFAULT_SETTINGS, DEMO_ITEMS, DEMO_USERS, DEMO_CATEGORIES } from '../core/defaults.js';
import { itemImageRefs, imageDocId } from '../core/images.js';
import { formatNo, randomToken, startOfDay } from '../core/format.js';
import {
  countItems, isFinal, priceLines, stockProblems, stockUpdates, ORDER_TTL_MS, ACTIVE_STATUSES,
  optionProblems, cleanLines,
} from '../core/order-logic.js';
import { SUB_PREFS, applyLineChanges } from '../core/shortage.js';

const DB_KEY = 'tab-demo-db-v1';
const UID_KEY = 'tab-demo-uid';
const STAFF_KEY = 'tab-demo-staff';
// 圖片另外存放，避免每次存檔都要重寫整份資料
const IMG_PREFIX = 'tab-demo-img:';

function readImg(key) {
  try {
    return localStorage.getItem(IMG_PREFIX + key);
  } catch {
    return null;
  }
}

function writeImg(key, data) {
  try {
    if (data == null) localStorage.removeItem(IMG_PREFIX + key);
    else localStorage.setItem(IMG_PREFIX + key, data);
  } catch {
    // localStorage 容量有限(約 5 MB)，展示模式放太多圖片時會失敗
    throw new ApiError('invalid', '展示模式的瀏覽器儲存空間不足，請改用較小或較少的圖片。');
  }
}

function clearImgs() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(IMG_PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch {
    // 忽略
  }
}

function seed() {
  const items = {};
  for (const it of DEMO_ITEMS) items[it.id] = { ...it, updatedAt: Date.now() };
  const users = {};
  for (const u of DEMO_USERS) users[u.uid] = { ...u, createdAt: Date.now() };
  const categories = {};
  for (const c of DEMO_CATEGORIES) categories[c.id] = { ...c };
  return {
    categories,
    banners: {},
    settings: { ...DEFAULT_SETTINGS },
    items,
    itemImages: {},
    orders: {},
    contacts: {},
    counters: { A: { value: 0 }, B: { value: 0 } },
    sessions: {},
    activePhones: {},
    lookups: {},
    inbox: {},
    users,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // 資料損毀時重建
  }
  const fresh = seed();
  localStorage.setItem(DB_KEY, JSON.stringify(fresh));
  return fresh;
}

let db = load();
const listeners = new Set();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tab-demo') : null;

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

function reloadFromStorage() {
  db = load();
  emit();
}

if (channel) channel.onmessage = reloadFromStorage;
window.addEventListener('storage', (e) => {
  if (e.key === DB_KEY) reloadFromStorage();
});

function commit() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  channel?.postMessage('changed');
  emit();
}

// 監聽：資料變動時重新計算，回傳取消監聽函式
function watch(selector, cb) {
  const run = () => cb(structuredClone(selector(db)));
  listeners.add(run);
  queueMicrotask(run);
  return () => listeners.delete(run);
}

// 模擬網路延遲，讓按鈕處理中狀態在展示模式也看得到
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// 訂單結束時解除電話綁定(與正式版相同規則)
function releasePhone(orderId) {
  const phone = db.contacts[orderId]?.phone;
  if (phone && db.activePhones[phone]?.orderId === orderId) delete db.activePhones[phone];
}

// 清除已結束或已不存在訂單的電話綁定(進行中的不清除)
function cleanupPhoneLocks() {
  for (const [phone, lock] of Object.entries(db.activePhones)) {
    const o = db.orders[lock.orderId];
    if (!o || isFinal(o)) delete db.activePhones[phone];
  }
}

function newId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function customerUid() {
  let uid = localStorage.getItem(UID_KEY);
  if (!uid) {
    uid = `anon-${newId()}`;
    localStorage.setItem(UID_KEY, uid);
  }
  return uid;
}

function currentStaff() {
  const uid = localStorage.getItem(STAFF_KEY);
  const u = uid && db.users[uid];
  if (!u || u.disabled) return null;
  return { uid, username: u.username, displayName: u.displayName, role: u.role };
}

function requireRole(roles) {
  const s = currentStaff();
  if (!s || !roles.includes(s.role)) throw new ApiError('permission');
  return s;
}
const STAFF = ['staff', 'manager', 'admin'];
const MANAGER = ['manager', 'admin'];
const ADMIN = ['admin'];

function getOrder(id) {
  const o = db.orders[id];
  if (!o) throw new ApiError('not-found');
  return o;
}

function itemsMap() {
  return db.items;
}

function sortedItems() {
  return Object.values(db.items).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function nextSeq(type) {
  const c = db.counters[type] || { value: 0 };
  const value = (c.value || 0) + 1;
  db.counters[type] = { value };
  return value;
}

const staffAuthListeners = new Set();
function emitStaffAuth() {
  const s = currentStaff();
  for (const cb of staffAuthListeners) cb(s);
}
window.addEventListener('storage', (e) => {
  if (e.key === STAFF_KEY) emitStaffAuth();
});

export const api = {
  isDemo: true,

  // ===== 點餐者 =====
  async initCustomer() {
    return customerUid();
  },

  async getCustomerState() {
    const uid = customerUid();
    const session = db.sessions[uid] || null;
    const order = session?.orderId ? db.orders[session.orderId] || null : null;
    return { session: structuredClone(session), order: order ? structuredClone(order) : null };
  },

  async startSession() {
    await delay();
    const uid = customerUid();
    const session = db.sessions[uid];
    if (session?.used) {
      const order = db.orders[session.orderId];
      if (!isFinal(order)) throw new ApiError('active-order', null, { orderId: session.orderId });
    }
    const token = randomToken();
    db.sessions[uid] = { token, used: false, orderId: null, updatedAt: Date.now() };
    commit();
    return token;
  },

  async checkSession(token) {
    const s = db.sessions[customerUid()];
    if (!s || s.token !== token) return { ok: false, reason: 'invalid' };
    if (s.used) return { ok: false, reason: 'used', orderId: s.orderId };
    return { ok: true };
  },

  watchSettings(cb) {
    return watch((d) => ({ ...DEFAULT_SETTINGS, ...d.settings }), cb);
  },

  watchMenu(cb) {
    return watch(() => sortedItems().filter((i) => i.active), cb);
  },

  async getItemImages(items) {
    const out = {};
    for (const it of items) {
      const cover = itemImageRefs(it)[0];
      const data = cover && readImg(imageDocId(cover, 's'));
      if (data) out[it.id] = data;
    }
    return out;
  },

  async getImages(refs, size = 'l') {
    const out = {};
    for (const r of refs) {
      const data = readImg(imageDocId(r, size));
      if (data) out[r.id] = data;
    }
    return out;
  },

  watchCategories(cb) {
    return watch((d) => Object.values(d.categories || {}).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), cb);
  },

  watchBanners(cb) {
    // 圖片存在另外的位置，這裡補上
    return watch((d) => Object.values(d.banners || {})
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((b) => ({ ...b, data: readImg(`banner:${b.id}`) }))
      .filter((b) => b.data), cb);
  },

  async getSiteImage(id) {
    return readImg(`site:${id}`);
  },

  async submitPreorder({ lines, surname, title, phone, consentText, lang = 'zh-Hant', subPref }) {
    await delay(300);
    if (!SUB_PREFS.includes(subPref)) throw new ApiError('invalid');
    const uid = customerUid();
    const settings = { ...DEFAULT_SETTINGS, ...db.settings };
    if (!settings.acceptingPreorders) throw new ApiError('closed');
    const count = countItems(lines);
    if (count < 1) throw new ApiError('invalid');
    if (count > settings.maxItemsPerOrder) throw new ApiError('over-limit');
    const session = db.sessions[uid];
    if (!session || session.used) throw new ApiError('session-invalid');
    const lock = db.activePhones[phone];
    // 綁定的舊訂單已不存在時視為已結束
    if (lock && db.orders[lock.orderId] && !isFinal(db.orders[lock.orderId])) throw new ApiError('phone-active');
    const problems = [...stockProblems(lines, itemsMap()), ...optionProblems(lines, itemsMap())];
    if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);

    const id = newId();
    const seq = nextSeq('A');
    const no = formatNo('preorder', seq);
    const now = Date.now();
    db.orders[id] = {
      id, type: 'preorder', seq, no, status: 'pending', uid,
      items: cleanLines(lines, itemsMap()),
      itemCount: count, surname, title, lang, pushEnabled: false, messages: [], subPref,
      createdAt: now, updatedAt: now,
    };
    db.contacts[id] = { orderId: id, surname, phone, consentNotify: true, consentText, consentAt: now, createdAt: now };
    db.activePhones[phone] = { uid, orderId: id, updatedAt: now };
    db.sessions[uid] = { ...session, used: true, orderId: id, updatedAt: now };
    db.lookups[`${no}_${phone}`] = { orderId: id, createdAt: now };
    commit();
    return { orderId: id, no };
  },

  async reportOverLimit({ surname, phone, summary, count }) {
    const uid = customerUid();
    const prev = db.inbox[uid];
    db.inbox[uid] = {
      id: uid, type: 'over-limit', surname, phone, summary, count,
      attempts: (prev?.attempts || 0) + 1, read: false, lastAt: Date.now(),
    };
    commit();
  },

  watchOrder(orderId, cb) {
    return watch((d) => d.orders[orderId] || null, cb);
  },

  async cancelOrder(orderId) {
    await delay();
    const o = getOrder(orderId);
    if (o.uid !== customerUid()) throw new ApiError('permission');
    if (o.status !== 'pending') throw new ApiError('bad-state', '攤位已接單，無法取消，請至攤位洽詢。');
    // 與安全規則相同：送出 3 分鐘內才能取消
    if (Date.now() - o.createdAt >= 3 * 60 * 1000) throw new ApiError('permission');
    Object.assign(o, { status: 'cancelled', cancelledAt: Date.now(), updatedAt: Date.now() });
    commit();
  },

  async findOrder(no, phone) {
    await delay();
    return db.lookups[`${String(no).toUpperCase()}_${phone}`]?.orderId || null;
  },

  async claimOrder(orderId) {
    await delay();
    const uid = customerUid();
    const o = getOrder(orderId);
    if (o.uid === uid || o.claimedBy === uid) return true;
    if (o.type !== 'walkin') return false;
    if (o.claimedBy) throw new ApiError('claimed');
    Object.assign(o, { claimedBy: uid, updatedAt: Date.now() });
    commit();
    return true;
  },

  async enablePush() {
    throw new ApiError('push-unsupported', '展示模式不支援推播，連接 Firebase 後才能使用。');
  },

  // ===== 員工登入 =====
  onStaffAuth(cb) {
    staffAuthListeners.add(cb);
    queueMicrotask(() => cb(currentStaff()));
    return () => staffAuthListeners.delete(cb);
  },

  async staffLogin(username, password) {
    await delay(200);
    const u = Object.values(db.users).find((x) => x.username === username.trim().toLowerCase());
    if (!u || u.password !== password) throw new ApiError('auth');
    if (u.disabled) throw new ApiError('permission', '此帳號已停用，請洽管理員。');
    localStorage.setItem(STAFF_KEY, u.uid);
    emitStaffAuth();
    return currentStaff();
  },

  async staffLogout() {
    localStorage.removeItem(STAFF_KEY);
    emitStaffAuth();
  },

  // ===== 攤位營運 =====
  watchTodayOrders(cb) {
    const today = startOfDay();
    const from = Math.min(today, Date.now() - ORDER_TTL_MS);
    return watch((d) => Object.values(d.orders)
      .filter((o) => o.createdAt >= from && !o.deleted && (o.createdAt >= today || !isFinal(o)))
      .sort((a, b) => a.createdAt - b.createdAt), cb);
  },

  async acceptOrder(orderId) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (o.status !== 'pending') throw new ApiError('bad-state');
    const problems = stockProblems(o.items, itemsMap());
    if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`, { problems });
    const priced = priceLines(o.items, itemsMap());
    for (const [id, st] of Object.entries(stockUpdates(o.items, itemsMap()))) {
      Object.assign(db.items[id], st, { updatedAt: Date.now() });
    }
    const now = Date.now();
    Object.assign(o, {
      status: 'accepted', lines: priced.lines, total: priced.total,
      acceptedAt: now, establishedAt: now, updatedAt: now,
    });
    commit();
  },

  async rejectOrder(orderId, reason, reasonTr = '') {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (o.status !== 'pending') throw new ApiError('bad-state');
    Object.assign(o, { status: 'rejected', rejectReason: reason || '', rejectReasonTr: reasonTr || '', rejectedAt: Date.now(), updatedAt: Date.now() });
    releasePhone(orderId);
    commit();
  },

  async markReady(orderId) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (o.status !== 'accepted') throw new ApiError('bad-state');
    Object.assign(o, { status: 'ready', readyAt: Date.now(), updatedAt: Date.now() });
    commit();
  },

  async undoReady(orderId) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (o.status !== 'ready') throw new ApiError('bad-state');
    Object.assign(o, { status: 'accepted', readyAt: null, updatedAt: Date.now() });
    commit();
  },

  async markPicked(orderId, payment) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (!['accepted', 'ready'].includes(o.status)) throw new ApiError('bad-state');
    const now = Date.now();
    Object.assign(o, { status: 'picked', pickedAt: now, readyAt: o.readyAt || now, payment: payment || o.payment || '園遊券', updatedAt: now });
    releasePhone(orderId);
    commit();
  },

  // ===== 已接單後的缺貨處理 =====
  async changeOrderLines(orderId, actions, {
    message = '', messageTr = '', clearShortage = false, cancelReason = '', shortageId = '',
  } = {}) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (!['accepted', 'ready'].includes(o.status) || !o.lines?.length) throw new ApiError('bad-state');
    if (shortageId && o.shortage?.id !== shortageId) throw new ApiError('bad-state');
    const res = applyLineChanges(o.lines, itemsMap(), actions);
    for (const [id, delta] of Object.entries(res.stock)) {
      if (delta && db.items[id]) db.items[id].soldCount = Math.max(0, (db.items[id].soldCount || 0) + delta);
    }
    const now = Date.now();
    Object.assign(o, { lines: res.lines, total: res.total, itemCount: res.itemCount, totalChanged: true, updatedAt: now });
    if (message) o.messages = [...(o.messages || []), { text: message, at: now, ...(messageTr ? { tr: messageTr } : {}) }];
    if (clearShortage) {
      delete o.shortage;
      delete o.shortageReply;
    }
    const cancelled = res.lines.length === 0;
    if (cancelled) {
      Object.assign(o, { status: 'cancelled', cancelledBy: 'stall', cancelReason: cancelReason || '品項已售完', cancelledAt: now });
      releasePhone(orderId);
    }
    commit();
    return { cancelled, notes: res.notes };
  },

  async requestShortage(orderId, requests) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    const id = newId().slice(0, 12);
    o.shortage = { id, requests, sentAt: Date.now() };
    delete o.shortageReply;
    o.updatedAt = Date.now();
    commit();
    return id;
  },

  async replyShortage(orderId, shortageId, answers) {
    await delay();
    const o = getOrder(orderId);
    if (o.shortage?.id !== shortageId) throw new ApiError('bad-state');
    o.shortageReply = { id: shortageId, answers, at: Date.now() };
    o.updatedAt = Date.now();
    commit();
  },

  async cancelByStall(orderId, reason, reasonTr = '') {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (!['accepted', 'ready'].includes(o.status)) throw new ApiError('bad-state');
    for (const l of o.lines || []) {
      if (db.items[l.itemId]) db.items[l.itemId].soldCount = Math.max(0, (db.items[l.itemId].soldCount || 0) - l.qty);
    }
    const now = Date.now();
    Object.assign(o, { status: 'cancelled', cancelledBy: 'stall', cancelReason: reason || '', cancelReasonTr: reasonTr || '', cancelledAt: now, updatedAt: now });
    delete o.shortage;
    delete o.shortageReply;
    releasePhone(orderId);
    commit();
  },

  async getSubMemory(key) {
    return structuredClone(db.subMemory?.[key]?.candidates || null);
  },

  async saveSubMemory(key, candidates) {
    requireRole(STAFF);
    db.subMemory = db.subMemory || {};
    db.subMemory[key] = { candidates, updatedAt: Date.now() };
    commit();
  },

  async getPhoneLock(phone) {
    await delay();
    const lock = db.activePhones[phone] || null;
    if (!lock) return { lock: null, order: null };
    return { lock, order: db.orders[lock.orderId] || null };
  },

  async releasePhoneLock(phone) {
    await delay();
    delete db.activePhones[phone];
    commit();
  },

  async clearSubMemory() {
    requireRole(ADMIN);
    const n = Object.keys(db.subMemory || {}).length;
    db.subMemory = {};
    commit();
    return n;
  },

  async sendMessage(orderId, text, tr = '') {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    o.messages = [...(o.messages || []), { text, at: Date.now(), ...(tr ? { tr } : {}) }];
    o.updatedAt = Date.now();
    commit();
  },

  async notifyCustomer() {
    return { sent: false, reason: 'demo' };
  },

  // 展示模式沒有翻譯服務
  async translate() {
    return null;
  },

  async getContact(orderId) {
    requireRole(STAFF);
    return db.contacts[orderId] ? structuredClone(db.contacts[orderId]) : null;
  },

  async createWalkin({ lines, payment, later, surname = '', title = '', phone = '' }) {
    await delay(200);
    const staff = requireRole(STAFF);
    const problems = stockProblems(lines, itemsMap());
    if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);
    const priced = priceLines(lines, itemsMap());
    for (const [id, st] of Object.entries(stockUpdates(lines, itemsMap()))) {
      Object.assign(db.items[id], st, { updatedAt: Date.now() });
    }
    const id = newId();
    const seq = nextSeq('B');
    const no = formatNo('walkin', seq);
    const now = Date.now();
    db.orders[id] = {
      id, type: 'walkin', seq, no, status: later ? 'accepted' : 'picked', later: !!later,
      uid: null, claimedBy: null,
      items: cleanLines(lines, itemsMap()),
      lines: priced.lines, total: priced.total, itemCount: countItems(lines),
      payment, surname, title, pushEnabled: false, messages: [], createdBy: staff.uid,
      createdAt: now, updatedAt: now, acceptedAt: now, establishedAt: now,
      ...(later ? {} : { readyAt: now, pickedAt: now }),
    };
    if (phone) {
      db.contacts[id] = { orderId: id, surname, phone, consentNotify: true, consentText: '現場口頭同意', consentAt: now, createdAt: now };
      db.lookups[`${no}_${phone}`] = { orderId: id, createdAt: now };
    }
    commit();
    return { orderId: id, no };
  },

  watchInbox(cb) {
    return watch((d) => Object.values(d.inbox).sort((a, b) => b.lastAt - a.lastAt), cb);
  },

  async markInboxRead(id) {
    requireRole(STAFF);
    if (db.inbox[id]) {
      db.inbox[id].read = true;
      db.inbox[id].readAt = Date.now();
      commit();
    }
  },

  async setAccepting(value) {
    requireRole(STAFF);
    db.settings.acceptingPreorders = !!value;
    commit();
  },

  // ===== 攤位主管 =====
  watchAllItems(cb) {
    return watch(() => sortedItems(), cb);
  },

  async saveItem(item) {
    await delay();
    requireRole(MANAGER);
    const id = item.id || newId();
    const prev = db.items[id] || { soldCount: 0, hasImage: false, imageVersion: 0 };
    db.items[id] = { ...prev, ...item, id, updatedAt: Date.now() };
    commit();
    return id;
  },

  async deleteItem(id) {
    await delay();
    requireRole(MANAGER);
    for (const r of itemImageRefs(db.items[id])) {
      writeImg(imageDocId(r, 's'), null);
      writeImg(imageDocId(r, 'l'), null);
    }
    delete db.items[id];
    commit();
  },

  async saveItemImages(itemId, { add = [], order = [], remove = [] }) {
    await delay();
    requireRole(MANAGER);
    const written = [];
    try {
      for (const img of add) {
        writeImg(`${img.id}_s`, img.small);
        written.push(`${img.id}_s`);
        writeImg(`${img.id}_l`, img.large);
        written.push(`${img.id}_l`);
      }
    } catch (err) {
      written.forEach((k) => writeImg(k, null));
      throw err;
    }
    for (const r of remove) {
      writeImg(imageDocId(r, 's'), null);
      writeImg(imageDocId(r, 'l'), null);
    }
    Object.assign(db.items[itemId], { images: order, hasImage: order.length > 0, imageVersion: Date.now(), updatedAt: Date.now() });
    commit();
  },

  async saveCategory(cat) {
    await delay();
    requireRole(MANAGER);
    const id = cat.id || newId();
    db.categories ??= {};
    db.categories[id] = { ...(db.categories[id] || {}), ...cat, id };
    commit();
    return id;
  },

  async deleteCategory(id) {
    await delay();
    requireRole(MANAGER);
    delete db.categories[id];
    commit();
  },

  async addBanner(dataUrl, sortOrder) {
    await delay();
    requireRole(MANAGER);
    const id = newId();
    writeImg(`banner:${id}`, dataUrl);
    db.banners ??= {};
    db.banners[id] = { id, sortOrder };
    commit();
  },

  async deleteBanner(id) {
    await delay();
    requireRole(MANAGER);
    writeImg(`banner:${id}`, null);
    delete db.banners[id];
    commit();
  },

  async reorderBanners(ids) {
    requireRole(MANAGER);
    ids.forEach((id, i) => { if (db.banners[id]) db.banners[id].sortOrder = i + 1; });
    commit();
  },

  async setSiteImage(id, dataUrl) {
    await delay();
    requireRole(MANAGER);
    writeImg(`site:${id}`, dataUrl);
    commit();
  },

  async saveSettings(patch) {
    await delay();
    requireRole(MANAGER);
    db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...patch };
    commit();
  },

  async ensureSettings() {
    // 展示模式一開始就有完整設定
  },

  async listOrders({ from, to }) {
    await delay();
    requireRole(MANAGER);
    return structuredClone(Object.values(db.orders)
      .filter((o) => o.createdAt >= from && o.createdAt < to)
      .sort((a, b) => a.createdAt - b.createdAt));
  },

  async listContacts(orderIds) {
    requireRole(MANAGER);
    const out = {};
    for (const id of orderIds) if (db.contacts[id]) out[id] = structuredClone(db.contacts[id]);
    return out;
  },

  // ===== 管理員 =====
  async adminUpdateOrder(id, patch) {
    await delay();
    requireRole(ADMIN);
    Object.assign(getOrder(id), patch, { updatedAt: Date.now() });
    commit();
  },

  async adminDeleteOrder(id) {
    await delay();
    requireRole(ADMIN);
    Object.assign(getOrder(id), { deleted: true, deletedAt: Date.now(), updatedAt: Date.now() });
    commit();
  },

  async adminCreateManual({ lines, total, payment, note }) {
    await delay();
    const staff = requireRole(ADMIN);
    const id = newId();
    const now = Date.now();
    const d = new Date(now);
    db.orders[id] = {
      id, type: 'manual', seq: 0,
      no: `M${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`,
      status: 'picked', lines, items: [], total, itemCount: lines.reduce((s, l) => s + l.qty, 0),
      payment, note: note || '', surname: '', createdBy: staff.uid,
      createdAt: now, updatedAt: now, establishedAt: now, pickedAt: now,
    };
    commit();
    return id;
  },

  async listAccounts() {
    requireRole(ADMIN);
    return Object.values(db.users).map(({ password, ...u }) => u);
  },

  async createAccount({ username, password, displayName, role }) {
    await delay();
    requireRole(ADMIN);
    const name = username.trim().toLowerCase();
    if (Object.values(db.users).some((u) => u.username === name)) throw new ApiError('username-taken');
    const uid = `u-${newId()}`;
    db.users[uid] = { uid, username: name, password, displayName, role, disabled: false, createdAt: Date.now() };
    commit();
    return uid;
  },

  async updateAccount(uid, patch) {
    await delay();
    requireRole(ADMIN);
    const u = db.users[uid];
    if (!u) throw new ApiError('not-found', '找不到帳號。');
    if (u.role === 'admin' && (patch.role || patch.disabled)) throw new ApiError('permission', '不能變更管理員的權限。');
    const { password, ...rest } = patch;
    Object.assign(u, rest);
    if (password) u.password = password;
    commit();
  },

  async deleteAccount(uid) {
    await delay();
    requireRole(ADMIN);
    if (db.users[uid]?.role === 'admin') throw new ApiError('permission', '不能刪除管理員帳號。');
    delete db.users[uid];
    commit();
  },

  async listUnfinishedOrders() {
    requireRole(ADMIN);
    return Object.values(db.orders)
      .filter((o) => ACTIVE_STATUSES.includes(o.status) && !o.deleted)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async voidOrders(ids) {
    requireRole(ADMIN);
    const now = Date.now();
    for (const id of ids) {
      const o = db.orders[id];
      if (!o) continue;
      Object.assign(o, { status: 'cancelled', voided: true, cancelledAt: now, updatedAt: now });
    }
    cleanupPhoneLocks();
    commit();
    return ids.length;
  },

  async resetCounters() {
    requireRole(ADMIN);
    db.counters = { A: { value: 0 }, B: { value: 0 } };
    cleanupPhoneLocks();
    commit();
  },

  async resetDemo() {
    localStorage.removeItem(STAFF_KEY);
    clearImgs();
    db = seed();
    commit();
    emitStaffAuth();
  },
};
