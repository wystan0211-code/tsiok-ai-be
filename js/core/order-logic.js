// 訂單共用邏輯：計價、庫存、狀態判斷。前台、攤位與後端(展示模式)共用同一套規則
import { normalizeSel, selPrice, selText, selProblems, blockedByOptions } from './options.js';

export const FINAL_STATUSES = ['picked', 'rejected', 'cancelled'];
export const ACTIVE_STATUSES = ['pending', 'accepted', 'ready'];

// 訂單時效：建立超過 12 小時仍未結束，視為失效(顧客可重新預點)
// firestore.rules 的 finalStatus() 也是 12 小時，兩邊要一起改
export const ORDER_TTL_MS = 12 * 60 * 60 * 1000;

// 建立時間(毫秒)；相容數字、Firestore Timestamp
export function createdMs(order) {
  const c = order?.createdAt;
  if (typeof c === 'number') return c;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (c && typeof c.seconds === 'number') return c.seconds * 1000;
  return 0;
}

// ===== 預購(C 單) =====
// 付款期限預設 12 小時，可設定 1～48 小時；退回未付款時從退回的時間重新計算
export const PRESALE_PAY_HOURS = 12;
export const PRESALE_MAX_PAY_HOURS = 48;

export const isPresale = (order) => order?.type === 'presale';

function toMs(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (v && typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

// 付款期限(毫秒)：(退回時間或建立時間) + 付款期限小時數
export function payDeadline(order) {
  const from = toMs(order?.payFrom) || createdMs(order);
  const hours = Number(order?.payHours) || PRESALE_PAY_HOURS;
  return from ? from + hours * 3600000 : 0;
}

// 預購單超過付款期限仍未付款：視為作廢(不刪除資料，顯示「已作廢」)
export function isPresaleVoid(order, now = Date.now()) {
  if (!isPresale(order) || order.status !== 'pending' || order.deleted === true) return false;
  const deadline = payDeadline(order);
  return deadline > 0 && now > deadline;
}

// 尚未結束、但已超過時效；預購單不套用 12 小時，改用付款期限
// firestore.rules 的 finalStatus() 規則相同，兩邊要一起改
export function isExpired(order, now = Date.now()) {
  if (!order || order.deleted === true || FINAL_STATUSES.includes(order.status)) return false;
  if (isPresale(order)) return isPresaleVoid(order, now);
  const created = createdMs(order);
  return created > 0 && now - created > ORDER_TTL_MS;
}

// ===== 平台模式：關閉 / 預購 / 點餐 =====
export const ORDER_MODES = ['off', 'presale', 'open'];
export function orderMode(settings) {
  if (ORDER_MODES.includes(settings?.orderMode)) return settings.orderMode;
  return settings?.acceptingPreorders === false ? 'off' : 'open';
}

// 品項、橫幅在目前模式是否顯示：一般點餐預設顯示，預購模式預設不顯示
export function visibleIn(entry, mode) {
  if (mode === 'presale') return entry?.showPresale === true;
  return entry?.showNormal !== false;
}

// 預購單的件數上限：學生用「學生預購單最多幾件」，空白時沿用「每張預購單最多幾件」；都空白回傳 null(不限制)
// firestore.rules 的 presaleLimitOk() 規則相同，兩邊要一起改
export function presaleItemLimit(settings, title) {
  const general = Number(settings?.presaleMaxItems) || 0;
  const student = Number(settings?.presaleStudentMaxItems) || 0;
  return (title === '學生' && student) || general || null;
}

// 預購期間每個商品的剩餘數量(沒有設定上限時為 null)；sold 為 presaleStats/main 的 sold { 品項ID: 已付款數量 }
export function presaleLeft(item, sold = {}) {
  if (item?.presaleLimit == null || item.presaleLimit === '') return null;
  return Math.max(0, Number(item.presaleLimit) - (sold[item.id] || 0));
}

// 檢查預購數量上限，回傳 [{ item, left }]
export function presaleIssues(lines, itemsById, sold = {}) {
  const need = {};
  for (const l of lines) need[l.itemId] = (need[l.itemId] || 0) + l.qty;
  const out = [];
  for (const [id, qty] of Object.entries(need)) {
    const left = presaleLeft(itemsById[id], sold);
    if (left != null && qty > left) out.push({ item: itemsById[id], left });
  }
  return out;
}

// 取餐時段：{ id, date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM' 或空白, cap: 名額 }
export function slotTime(slot) {
  if (!slot) return '';
  return slot.end ? `${slot.start}–${slot.end}` : slot.start;
}

const WEEK = { 'zh-Hant': ['日', '一', '二', '三', '四', '五', '六'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], ja: ['日', '月', '火', '水', '木', '金', '土'] };
export function slotDateLabel(date, lang = 'zh-Hant') {
  const [y, m, d] = String(date || '').split('-').map(Number);
  if (!y || !m || !d) return date || '';
  const w = (WEEK[lang] || WEEK['zh-Hant'])[new Date(y, m - 1, d).getDay()];
  return lang === 'en' ? `${m}/${d} (${w})` : `${m}/${d}（${w}）`;
}

export function slotLabel(slot, lang = 'zh-Hant') {
  return slot ? `${slotDateLabel(slot.date, lang)} ${slotTime(slot)}` : '';
}

// 依日期、時間排序並分組：[{ date, slots: [...] }]
export function groupSlots(slots = []) {
  const sorted = [...slots].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  const groups = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === s.date) last.slots.push(s);
    else groups.push({ date: s.date, slots: [s] });
  }
  return groups;
}

// 時段剩餘名額(counts：{ 時段ID: 已付款數 })；沒有設定名額時為 Infinity
export function slotLeft(slot, counts = {}) {
  if (!slot) return 0;
  if (slot.cap == null || slot.cap === '') return Infinity;
  return Math.max(0, Number(slot.cap) - (counts[slot.id] || 0));
}

// 訂單是否已結束(結束後才能再預點)；超過時效也算結束
export function isFinal(order) {
  return !order || order.deleted === true || FINAL_STATUSES.includes(order.status) || isExpired(order);
}

export function countItems(lines = []) {
  return lines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
}

export function lineLabel(line) {
  return line.option ? `${line.name}(${line.option})` : line.name;
}

// 以菜單價格計算明細與總額；找不到的品項放進 missing
export function priceLines(lines, itemsById) {
  const out = [];
  const missing = [];
  for (const l of lines) {
    const item = itemsById[l.itemId];
    if (!item) {
      missing.push(l.itemId);
      continue;
    }
    // 單價 = 品項價格 + 選項加價；option 存中文選項文字(攤位、試算表顯示用)
    const sel = normalizeSel(item, l);
    const price = item.price + selPrice(item, sel);
    out.push({
      itemId: l.itemId,
      name: item.name,
      price,
      qty: l.qty,
      option: selText(item, sel) || null,
      sel,
      subtotal: price * l.qty,
    });
  }
  return { lines: out, total: out.reduce((s, l) => s + l.subtotal, 0), missing };
}

// 檢查品項是否仍可供應，回傳 [{ item, kind: 'deleted'|'inactive'|'soldout'|'short', left }]
export function stockIssues(lines, itemsById) {
  const need = {};
  for (const l of lines) need[l.itemId] = (need[l.itemId] || 0) + l.qty;
  const issues = [];
  for (const [id, qty] of Object.entries(need)) {
    const item = itemsById[id];
    if (!item) issues.push({ item: null, kind: 'deleted' });
    else if (!item.active) issues.push({ item, kind: 'inactive' });
    else if (item.soldOut || blockedByOptions(item)) issues.push({ item, kind: 'soldout' });
    else if (item.stockLimit != null && (item.soldCount || 0) + qty > item.stockLimit) {
      issues.push({ item, kind: 'short', left: Math.max(0, item.stockLimit - (item.soldCount || 0)) });
    }
  }
  return issues;
}

// 預購送出時的檢查：只看已刪除、下架、售完(不看現場的庫存數量上限，預購另有上限)
export function presaleBlockers(lines, itemsById) {
  return stockIssues(lines, itemsById).filter((x) => x.kind !== 'short').map(({ item, kind }) => {
    if (kind === 'deleted') return '已刪除的品項';
    return `${item.name}(${kind === 'inactive' ? '已下架' : '已售完'})`;
  });
}

// 中文說明文字(攤位與後台使用)
export function stockProblems(lines, itemsById) {
  return stockIssues(lines, itemsById).map(({ item, kind, left }) => {
    if (kind === 'deleted') return '已刪除的品項';
    if (kind === 'inactive') return `${item.name}(已下架)`;
    if (kind === 'soldout') return `${item.name}(已售完)`;
    return `${item.name}(剩 ${left} 份)`;
  });
}

// 送出預點前檢查選項：必填未選、選到售完的選項、超過上限(中文說明)
export function optionProblems(lines, itemsById) {
  const out = [];
  for (const l of lines) {
    const item = itemsById[l.itemId];
    if (!item) continue;
    const problems = selProblems(item, normalizeSel(item, l));
    if (problems.length) out.push(`${item.name}(選項${problems[0].reason === 'soldout' ? '已售完' : '不完整'})`);
  }
  return out;
}

// 送到資料庫的訂單明細：品項、數量、選擇(sel)與中文選項文字
export function cleanLines(lines, itemsById = {}) {
  return lines.map((l) => {
    const item = itemsById[l.itemId];
    const sel = item ? normalizeSel(item, l) : (Array.isArray(l.sel) ? l.sel.slice(0, 50) : []);
    const option = item ? (selText(item, sel) || null) : (l.option ?? null);
    const out = { itemId: l.itemId, qty: l.qty, option: option ? option.slice(0, 200) : null };
    if (sel.length) out.sel = sel;
    return out;
  });
}

// 計算接單或現場點餐後的庫存變化：回傳 { 品項ID: { soldCount, soldOut } }
export function stockUpdates(lines, itemsById) {
  const need = {};
  for (const l of lines) need[l.itemId] = (need[l.itemId] || 0) + l.qty;
  const updates = {};
  for (const [id, qty] of Object.entries(need)) {
    const item = itemsById[id];
    if (!item) continue;
    const soldCount = (item.soldCount || 0) + qty;
    const soldOut = item.soldOut || (item.stockLimit != null && soldCount >= item.stockLimit);
    updates[id] = { soldCount, soldOut };
  }
  return updates;
}

// 訂單顯示用的明細：已接單的訂單使用鎖定的價格，未接單則用目前菜單估算
export function displayLines(order, itemsById) {
  if (order.lines && order.lines.length) return order.lines;
  return priceLines(order.items || [], itemsById).lines;
}

export function displayTotal(order, itemsById) {
  if (order.total != null) return order.total;
  return priceLines(order.items || [], itemsById).total;
}

export function summarizeLines(lines) {
  return lines.map((l) => `${lineLabel(l)}×${l.qty}`).join('、');
}

export function normalizePhone(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

// 台灣手機號碼：09 開頭共 10 碼
export function isValidPhone(value) {
  return /^09\d{8}$/.test(value);
}

// 預估完成時間：接單時間加上明細中最長的製作時間
export function estimateReadyAt(order, itemsById) {
  if (!order.acceptedAt) return null;
  const lines = order.items?.length ? order.items : order.lines || [];
  const maxPrep = Math.max(0, ...lines.map((l) => itemsById[l.itemId]?.prepMinutes || 0));
  return order.acceptedAt + maxPrep * 60000;
}

// 是否已收款(列入營收)：現場與手動訂單建立即收款；預點在取餐時收款；預購在標示已付款時收款
export function isPaid(order) {
  if (order.deleted) return false;
  if (order.status === 'cancelled' || order.status === 'rejected') return false;
  if (order.type === 'preorder') return order.status === 'picked';
  // 預購單：預購主管標示已付款才算收款(逾時作廢不算)
  if (order.type === 'presale') return order.paid === true;
  return true;
}
