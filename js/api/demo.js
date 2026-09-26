// 展示模式後端：資料存在瀏覽器 localStorage，用 BroadcastChannel 讓同一瀏覽器的分頁即時同步
// 規則與 Firebase 版相同(一次性連結、每支電話一張進行中訂單、數量上限、庫存)，方便在連接 Firebase 前完整測試流程
import { ApiError } from '../core/errors.js';
import { DEFAULT_SETTINGS, DEMO_ITEMS, DEMO_USERS } from '../core/defaults.js';
import { formatNo, randomToken, startOfDay } from '../core/format.js';
import {
  countItems, isFinal, priceLines, stockProblems, stockUpdates,
} from '../core/order-logic.js';

const DB_KEY = 'tab-demo-db-v1';
const UID_KEY = 'tab-demo-uid';
const STAFF_KEY = 'tab-demo-staff';

function seed() {
  const items = {};
  for (const it of DEMO_ITEMS) items[it.id] = { ...it, updatedAt: Date.now() };
  const users = {};
  for (const u of DEMO_USERS) users[u.uid] = { ...u, createdAt: Date.now() };
  return {
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
    for (const it of items) if (it.hasImage && db.itemImages[it.id]) out[it.id] = db.itemImages[it.id].data;
    return out;
  },

  async submitPreorder({ lines, surname, title, phone, consentText }) {
    await delay(300);
    const uid = customerUid();
    const settings = { ...DEFAULT_SETTINGS, ...db.settings };
    if (!settings.acceptingPreorders) throw new ApiError('closed');
    const count = countItems(lines);
    if (count < 1) throw new ApiError('invalid');
    if (count > settings.maxItemsPerOrder) throw new ApiError('over-limit');
    const session = db.sessions[uid];
    if (!session || session.used) throw new ApiError('session-invalid');
    const lock = db.activePhones[phone];
    if (lock && !isFinal(db.orders[lock.orderId])) throw new ApiError('phone-active');
    const problems = stockProblems(lines, itemsMap());
    if (problems.length) throw new ApiError('sold-out', `無法供應：${problems.join('、')}`);

    const id = newId();
    const seq = nextSeq('A');
    const no = formatNo('preorder', seq);
    const now = Date.now();
    db.orders[id] = {
      id, type: 'preorder', seq, no, status: 'pending', uid,
      items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, option: l.option ?? null })),
      itemCount: count, surname, title, pushEnabled: false, messages: [],
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
    const from = startOfDay();
    return watch((d) => Object.values(d.orders)
      .filter((o) => o.createdAt >= from && !o.deleted)
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

  async rejectOrder(orderId, reason) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    if (o.status !== 'pending') throw new ApiError('bad-state');
    Object.assign(o, { status: 'rejected', rejectReason: reason || '', rejectedAt: Date.now(), updatedAt: Date.now() });
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
    commit();
  },

  async sendMessage(orderId, text) {
    await delay();
    requireRole(STAFF);
    const o = getOrder(orderId);
    o.messages = [...(o.messages || []), { text, at: Date.now() }];
    o.updatedAt = Date.now();
    commit();
  },

  async notifyCustomer() {
    return { sent: false, reason: 'demo' };
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
      items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, option: l.option ?? null })),
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
    delete db.items[id];
    delete db.itemImages[id];
    commit();
  },

  async setItemImage(id, dataUrl) {
    await delay();
    requireRole(MANAGER);
    if (dataUrl) db.itemImages[id] = { data: dataUrl };
    else delete db.itemImages[id];
    Object.assign(db.items[id], { hasImage: !!dataUrl, imageVersion: Date.now(), updatedAt: Date.now() });
    try {
      commit();
    } catch (err) {
      // localStorage 容量有限(約 5 MB)，展示模式放太多圖片時會失敗
      delete db.itemImages[id];
      db.items[id].hasImage = false;
      throw new ApiError('invalid', '展示模式的瀏覽器儲存空間不足，請改用較小的圖片。');
    }
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

  async resetCounters() {
    requireRole(ADMIN);
    db.counters = { A: { value: 0 }, B: { value: 0 } };
    commit();
  },

  async resetDemo() {
    localStorage.removeItem(STAFF_KEY);
    db = seed();
    commit();
    emitStaffAuth();
  },
};
