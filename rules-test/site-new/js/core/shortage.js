// 已接單後的缺貨處理：顧客的缺貨偏好、替代候選清單、修改訂單明細的計算
// 前台、攤位與展示模式後端共用；純計算，不直接讀寫資料庫
import {
  optionGroups, normalizeSel, selPrice, selText, selKey, selProblems, blockedByOptions,
} from './options.js';
import { t, itemText, withOption } from './i18n.js';

// 顧客送出前選擇的「如果特定商品已售完」偏好
export const SUB_PREFS = ['choose', 'similar', 'remove'];
export const SUB_PREF_LABEL = { choose: '立即選擇替代商品', similar: '更換為任何類似商品', remove: '刪除該品項' };
export const REPLY_WAIT_MS = 90 * 1000; // 顧客回覆替代選擇的等待時間：1.5 分鐘

// 刪除整張訂單的常用原因(攤位可再修改文字)
export const CANCEL_REASONS = ['原料不足', '品項已售完', '攤位設備故障', '即將收攤'];

// 替代記憶的鍵：品項 + 選擇
export function memoryKey(itemId, sel) {
  const key = `${itemId}__${selKey(sel) || 'none'}`;
  // 文件 ID 不能有「/」，其餘字元直接使用
  return key.replace(/\//g, '_').slice(0, 1400);
}

const available = (item) => item && item.active !== false && !item.soldOut
  && !(item.stockLimit != null && (item.soldCount || 0) >= item.stockLimit) && !blockedByOptions(item);

// 依群組名稱與選項名稱，把原本的選擇套到另一個品項；回傳 { sel, complete }
export function mapSel(fromItem, fromSel, toItem) {
  const picked = new Map(); // 群組名稱 → Set(選項名稱)
  const fromGroups = optionGroups(fromItem);
  const set = new Set(fromSel || []);
  for (const g of fromGroups) {
    const names = g.choices.filter((c) => set.has(`${g.id}:${c.id}`)).map((c) => c.name);
    if (names.length) picked.set(g.name, new Set(names));
  }
  const out = [];
  for (const g of optionGroups(toItem)) {
    const names = picked.get(g.name);
    if (!names) continue;
    for (const c of g.choices) if (names.has(c.name) && !c.soldOut) out.push(`${g.id}:${c.id}`);
  }
  const sel = normalizeSel(toItem, { sel: out });
  return { sel, complete: selProblems(toItem, sel).length === 0 };
}

// 候選清單：同品項的其他選項(必填單選群組換成其他可選項)，以及同分類中還有庫存的品項
// 回傳 [{ itemId, sel, complete }]，最多 8 個
export function suggestCandidates(line, itemsById) {
  const out = [];
  const seen = new Set([`${line.itemId}|${selKey(line.sel)}`]);
  const push = (itemId, sel, complete) => {
    const key = `${itemId}|${selKey(sel)}`;
    if (seen.has(key) || out.length >= 8) return;
    seen.add(key);
    out.push({ itemId, sel, complete });
  };
  const item = itemsById[line.itemId];
  if (item && available(item)) {
    const base = normalizeSel(item, line);
    for (const g of optionGroups(item)) {
      if (g.kind !== 'required-single') continue;
      const others = base.filter((k) => !k.startsWith(`${g.id}:`));
      for (const c of g.choices) {
        if (c.soldOut) continue;
        const sel = normalizeSel(item, { sel: [...others, `${g.id}:${c.id}`] });
        push(item.id, sel, selProblems(item, sel).length === 0);
      }
    }
  }
  const catId = item?.categoryId ?? null;
  for (const other of Object.values(itemsById)) {
    if (other.id === line.itemId || !available(other)) continue;
    if ((other.categoryId ?? null) !== catId) continue;
    const { sel, complete } = item ? mapSel(item, line.sel, other) : { sel: [], complete: !optionGroups(other).length };
    push(other.id, sel, complete);
  }
  return out;
}

// 候選項目的顯示文字(中文)
export function candidateLabel(cand, itemsById) {
  const item = itemsById[cand.itemId];
  if (!item) return '已刪除的品項';
  const opt = selText(item, cand.sel);
  return opt ? `${item.name}(${opt})` : item.name;
}

// 候選項目的單價
export function candidatePrice(cand, itemsById) {
  const item = itemsById[cand.itemId];
  return item ? item.price + selPrice(item, normalizeSel(item, cand)) : 0;
}

/**
 * 修改已接單的訂單明細
 * @param {Array} lines 目前的明細(已計價)
 * @param {Object} itemsById 目前菜單
 * @param {Array<{ index: number, removeQty: number, replace?: { itemId, sel } }>} actions
 * @returns {{ lines, total, itemCount, stock: { 品項ID: 已售數量的增減 }, notes: Array }}
 *   notes：[{ type: 'remove'|'replace', name, option, qty, toName, toOption }]，用來產生給顧客的通知
 */
export function applyLineChanges(lines, itemsById, actions) {
  const next = lines.map((l) => ({ ...l }));
  const stock = {};
  const notes = [];
  const added = [];
  for (const a of actions) {
    const line = next[a.index];
    if (!line) continue;
    const qty = Math.max(0, Math.min(line.qty, Math.round(a.removeQty) || 0));
    if (!qty) continue;
    line.qty -= qty;
    line.subtotal = line.price * line.qty;
    stock[line.itemId] = (stock[line.itemId] || 0) - qty;
    const rep = a.replace && itemsById[a.replace.itemId];
    if (rep) {
      const sel = normalizeSel(rep, a.replace);
      const price = rep.price + selPrice(rep, sel);
      added.push({
        itemId: rep.id, name: rep.name, price, qty, option: selText(rep, sel) || null, sel, subtotal: price * qty,
      });
      stock[rep.id] = (stock[rep.id] || 0) + qty;
      notes.push({ type: 'replace', itemId: line.itemId, sel: line.sel || [], qty, toItemId: rep.id, toSel: sel });
    } else {
      notes.push({ type: 'remove', itemId: line.itemId, sel: line.sel || [], qty });
    }
  }
  const out = [...next.filter((l) => l.qty > 0), ...added];
  return {
    lines: out,
    total: out.reduce((s, l) => s + l.subtotal, 0),
    itemCount: out.reduce((s, l) => s + l.qty, 0),
    stock,
    notes,
  };
}

// 給顧客的通知文字(依語言)：例如「雞蛋糕 ×2 已售完，已從訂單中刪除」
function lineName(itemId, sel, itemsById, lang) {
  const item = itemsById[itemId];
  if (!item) return '';
  return withOption(itemText(item, lang).name, selText(item, normalizeSel(item, { sel }), lang), lang);
}

export function notesText(notes, itemsById, lang = 'zh-Hant') {
  return notes.map((n) => (n.type === 'replace'
    ? t('short.replaced', { item: lineName(n.itemId, n.sel, itemsById, lang), qty: n.qty, to: lineName(n.toItemId, n.toSel, itemsById, lang) }, lang)
    : t('short.removed', { item: lineName(n.itemId, n.sel, itemsById, lang), qty: n.qty }, lang))).join(lang === 'en' ? ' ' : '');
}
