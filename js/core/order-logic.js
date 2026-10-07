// 訂單共用邏輯：計價、庫存、狀態判斷。前台、攤位與後端(展示模式)共用同一套規則

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

// 尚未結束、但已超過時效
export function isExpired(order, now = Date.now()) {
  if (!order || order.deleted === true || FINAL_STATUSES.includes(order.status)) return false;
  const created = createdMs(order);
  return created > 0 && now - created > ORDER_TTL_MS;
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
    out.push({
      itemId: l.itemId,
      name: item.name,
      price: item.price,
      qty: l.qty,
      option: l.option ?? null,
      subtotal: item.price * l.qty,
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
    else if (item.soldOut) issues.push({ item, kind: 'soldout' });
    else if (item.stockLimit != null && (item.soldCount || 0) + qty > item.stockLimit) {
      issues.push({ item, kind: 'short', left: Math.max(0, item.stockLimit - (item.soldCount || 0)) });
    }
  }
  return issues;
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

// 是否已收款(列入營收)：現場與手動訂單建立即收款；預點在取餐時收款
export function isPaid(order) {
  if (order.deleted) return false;
  if (order.status === 'cancelled' || order.status === 'rejected') return false;
  if (order.type === 'preorder') return order.status === 'picked';
  return true;
}
