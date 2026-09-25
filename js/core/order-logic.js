// 訂單共用邏輯：計價、庫存、狀態判斷。前台、攤位與後端(展示模式)共用同一套規則

export const FINAL_STATUSES = ['picked', 'rejected', 'cancelled'];
export const ACTIVE_STATUSES = ['pending', 'accepted', 'ready'];

// 訂單是否已結束(結束後才能再預點)
export function isFinal(order) {
  return !order || order.deleted === true || FINAL_STATUSES.includes(order.status);
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

// 檢查品項是否仍可供應，回傳無法供應的說明文字陣列
export function stockProblems(lines, itemsById) {
  const need = {};
  for (const l of lines) need[l.itemId] = (need[l.itemId] || 0) + l.qty;
  const problems = [];
  for (const [id, qty] of Object.entries(need)) {
    const item = itemsById[id];
    if (!item || !item.active) {
      problems.push(item ? `${item.name}(已下架)` : '已刪除的品項');
      continue;
    }
    if (item.soldOut) {
      problems.push(`${item.name}(已售完)`);
      continue;
    }
    if (item.stockLimit != null && (item.soldCount || 0) + qty > item.stockLimit) {
      const left = Math.max(0, item.stockLimit - (item.soldCount || 0));
      problems.push(`${item.name}(剩 ${left} 份)`);
    }
  }
  return problems;
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
