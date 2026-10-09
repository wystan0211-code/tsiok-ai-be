// 攤位營運頁：訂單看板、現場點餐(POS)、收件匣、取餐核對
import { api, IS_DEMO } from '../api/index.js';
import {
  $, $$, icon, toast, openDialog, confirmDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { requireStaff, hasRole } from '../core/guard.js';
import { store } from '../core/storage.js';
import {
  escapeHtml, money, time, minutesSince, fillTemplate, personName, TITLES, TYPE_LABEL, ROLE_LABEL, STATUS_LABEL,
  startOfDay,
} from '../core/format.js';
import {
  countItems, displayLines, displayTotal, lineLabel, priceLines, stockProblems, summarizeLines,
  normalizePhone, isValidPhone, ACTIVE_STATUSES, createdMs,
} from '../core/order-logic.js';
import { chime, startChimeLoop, stopChimeLoop, unlockAudio } from '../core/sound.js';
import { qrSvg } from '../core/qr.js';
import { personNameFor, t as tr } from '../core/i18n.js';
import {
  SUB_PREF_LABEL, REPLY_WAIT_MS, CANCEL_REASONS, memoryKey, suggestCandidates, candidateLabel, candidatePrice,
  applyLineChanges, notesText,
} from '../core/shortage.js';
import { DEFAULT_SETTINGS } from '../core/defaults.js';
import {
  optionGroups, hasOptions, groupRule, ruleText, sortedChoices, blockedByOptions,
  normalizeSel, selPrice, selText, selKey, selProblems, addOnText,
} from '../core/options.js';

const LANG_BADGE = { en: 'EN', ja: '日' };
// 固定的拒絕原因直接對照翻譯，不必呼叫翻譯服務
const REJECT_TR = {
  品項售完: { en: 'An item is sold out', ja: '商品が売り切れのため' },
  '攤位忙碌，請直接到攤位點餐': { en: 'The stall is busy. Please order at the stall.', ja: '屋台が混み合っているため、屋台で直接ご注文ください' },
  即將收攤: { en: 'The stall is closing soon', ja: 'まもなく閉店のため' },
};

// 翻譯成顧客的語言；中文顧客或翻譯失敗時回傳空字串(顧客端會改顯示中文原文)
async function translateFor(lang, text) {
  if (!text || !lang || lang === 'zh-Hant') return '';
  const res = await api.translate([text], [lang]);
  return res?.[lang]?.[0] || '';
}

showDemoBanner(IS_DEMO);

const POS_KEY = 'tab-pos-cart';
const baseTitle = document.title;

let settings = null;
let orders = [];
let menu = [];
let inbox = [];
const contacts = new Map();      // 訂單ID -> 聯絡資料(展開卡片時才讀取)
const openIds = new Set();       // 目前展開的卡片
let knownPending = null;         // 已看過的新訂單，用來判斷是否播放提示音
let knownUnread = null;
let mobileCol = 'pending';
let pos = store.get(POS_KEY, { lines: [], mode: 'now', payment: '園遊券' });
let findMode = 'no';

const itemsById = () => Object.fromEntries(menu.map((i) => [i.id, i]));
const paymentMethods = () => settings?.paymentMethods?.length ? settings.paymentMethods : ['園遊券', '現金'];
// 只設定一種付款方式時，不需要顯示或選擇付款方式
const singlePayment = () => paymentMethods().length === 1;
const byId = (id) => orders.find((o) => o.id === id);

// ===== 分頁 =====
function selectTab(name) {
  const tabs = $$('.tab');
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  // 手機版底部分頁列：指示線滑到選取的圖示下
  $('.tabs--bar').style.setProperty('--tab-index', Math.max(0, tabs.findIndex((t) => t.dataset.tab === name)));
  for (const panel of ['board', 'pos', 'inbox', 'pickup']) $(`#panel-${panel}`).hidden = panel !== name;
  store.set('tab-stall-tab', name);
  if (name === 'pickup') $('#pickup-q').focus();
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

// ===== 看板 =====
function isOverdue(o) {
  return o.status === 'ready' && minutesSince(o.readyAt) >= (settings?.pickupReminderMinutes || 15);
}

function cardHtml(o, forceOpen = false) {
  const map = itemsById();
  const lines = displayLines(o, map);
  const total = displayTotal(o, map);
  const overdue = isOverdue(o);
  const open = forceOpen || openIds.has(o.id);
  const contact = contacts.get(o.id);
  const badges = [
    `<span class="badge ${o.type === 'preorder' ? 'badge--primary' : ''}">${TYPE_LABEL[o.type] || o.type}</span>`,
    o.pushEnabled ? `<span class="badge badge--success">${icon('notifications_active', 'icon--sm')}推播</span>` : '',
    LANG_BADGE[o.lang] ? `<span class="badge" title="顧客使用的語言">${LANG_BADGE[o.lang]}</span>` : '',
    createdMs(o) < startOfDay() ? '<span class="badge badge--warning">前一天</span>' : '',
    overdue ? `<span class="badge badge--danger">逾時 ${minutesSince(o.readyAt)} 分</span>` : '',
    ['rejected', 'cancelled'].includes(o.status) ? `<span class="badge badge--danger">${o.voided ? '已作廢' : STATUS_LABEL[o.status]}</span>` : '',
    o.status === 'picked' && o.payment && !singlePayment() ? `<span class="badge">${escapeHtml(o.payment)}</span>` : '',
    o.shortage ? '<span class="badge badge--warning">等待顧客選擇替代</span>' : '',
    o.totalChanged && ACTIVE_STATUSES.includes(o.status) ? '<span class="badge">已修改明細</span>' : '',
  ].join('');

  let actions = '';
  if (o.status === 'pending') {
    actions = `
      <button class="btn btn--primary" data-act="accept">${icon('check')}接單</button>
      <button class="btn btn--danger" data-act="reject">${icon('block')}拒絕</button>`;
  } else if (o.status === 'accepted') {
    actions = `${qrButton(o)}
      <button class="btn btn--primary" data-act="ready">${icon('notifications_active')}完成，通知取餐</button>
      <button class="btn" data-act="message">${icon('chat')}傳訊息</button>
      ${o.type === 'preorder' ? `<button class="btn" data-act="shortage">${icon('inventory_2')}缺貨處理</button>` : ''}
      <button class="btn btn--ghost" data-act="picked">${icon('done_all')}已取餐</button>`;
  } else if (o.status === 'ready') {
    // 取餐後一定要按「已取餐」才會結束訂單、解除電話綁定，所以放大並放在最前面
    actions = `<button class="btn btn--primary btn--lg btn--block order-card__pick" data-act="picked">${icon('done_all')}已取餐 / 結帳</button>
      ${qrButton(o)}
      ${o.type === 'preorder' ? `<button class="btn" data-act="shortage">${icon('inventory_2')}缺貨處理</button>` : ''}
      <button class="btn" data-act="message">${icon('chat')}傳訊息</button>
      <button class="btn" data-act="sms">${icon('sms')}簡訊通知</button>
      <button class="btn btn--ghost" data-act="undo">${icon('undo')}退回製作中</button>`;
  }

  const since = o.status === 'ready' ? o.readyAt : o.createdAt;
  return `
    <details class="order-card ${o.status === 'pending' ? 'order-card--pending' : ''} ${overdue ? 'order-card--overdue' : ''}" data-id="${o.id}" ${open ? 'open' : ''}>
      <summary>
        <div class="row row--between">
          <span class="display-no order-card__no">${escapeHtml(o.no)}</span>
          <span class="muted text-sm">${time(o.createdAt)}・${minutesSince(since)} 分鐘</span>
        </div>
        <div class="row">
          ${o.surname ? `<strong>${escapeHtml(personName(o.surname, o.title))}</strong>` : ''}
          <span>${o.itemCount || countItems(lines)} 件</span>
          <span>${money(total)}</span>
          ${badges}
        </div>
        <div class="muted text-sm order-card__peek">${escapeHtml(summarizeLines(lines))}</div>
      </summary>
      <div class="order-card__body">
        <ul class="order-card__lines">
          ${lines.map((l) => `<li class="summary-row"><span>${escapeHtml(lineLabel(l))} × ${l.qty}</span><span>${money(l.subtotal)}</span></li>`).join('')}
          <li class="summary-row"><strong>合計</strong><strong>${money(total)}${o.lines?.length ? '' : '(估)'}</strong></li>
        </ul>
        ${o.messages?.length ? `<div class="text-sm">${o.messages.map((m) => `<p class="muted">${time(m.at)} 已傳：${escapeHtml(m.text)}</p>`).join('')}</div>` : ''}
        ${o.rejectReason ? `<p class="text-sm">拒絕原因：${escapeHtml(o.rejectReason)}</p>` : ''}
        ${o.cancelReason ? `<p class="text-sm">取消原因：${escapeHtml(o.cancelReason)}</p>` : ''}
        ${o.type === 'preorder' && o.subPref && ACTIVE_STATUSES.includes(o.status) ? `<p class="text-sm">缺貨時：<strong>${SUB_PREF_LABEL[o.subPref] || ''}</strong></p>` : ''}
        ${shortageHtml(o)}
        <p class="text-sm muted" data-contact>${contact ? `電話 ${escapeHtml(contact.phone)}` : (contact === null ? '沒有留電話' : '電話載入中')}</p>
        ${actions ? `<div class="order-card__actions">${actions}</div>` : ''}
      </div>
    </details>`;
}

// 稍後取餐的現場訂單：可以再次顯示取餐 QR code
function qrButton(o) {
  return o.type === 'walkin' && o.later
    ? `<button class="btn" data-act="qr">${icon('qr_code_2')}顯示 QR code</button>` : '';
}

function groupOrders() {
  const groups = { pending: [], accepted: [], ready: [], done: [] };
  for (const o of orders) {
    if (ACTIVE_STATUSES.includes(o.status)) groups[o.status].push(o);
    else groups.done.push(o);
  }
  groups.done = groups.done.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);
  // 逾時未取的排在最前面
  groups.ready.sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0));
  return groups;
}

function renderBoard() {
  const groups = groupOrders();
  for (const [col, list] of Object.entries(groups)) {
    const box = $(`[data-list="${col}"]`);
    box.innerHTML = list.length ? list.map((o) => cardHtml(o)).join('') : '<p class="empty">沒有訂單</p>';
    for (const el of $$(`[data-count="${col}"]`)) el.textContent = list.length;
  }
  const pending = groups.pending.length;
  $('#pending-count').classList.toggle('is-empty', pending === 0);
  $('#pending-count').textContent = pending;
  document.title = pending ? `(${pending}) ${baseTitle}` : baseTitle;
  loadOpenContacts();
}

function setMobileCol(col) {
  mobileCol = col;
  for (const b of $$('[data-col]')) b.setAttribute('aria-pressed', String(b.dataset.col === col));
  for (const box of $$('[data-colbox]')) box.classList.toggle('is-shown', box.dataset.colbox === col);
}
$$('[data-col]').forEach((b) => b.addEventListener('click', () => setMobileCol(b.dataset.col)));

// 展開卡片時讀取電話
document.addEventListener('toggle', (e) => {
  const card = e.target;
  if (!(card instanceof HTMLDetailsElement) || !card.classList.contains('order-card')) return;
  // 取餐核對的結果卡片預設展開，不影響看板的展開狀態
  const inPickup = !!card.closest('#pickup-results');
  if (card.open) {
    if (!inPickup) openIds.add(card.dataset.id);
    loadContact(card.dataset.id);
  } else if (!inPickup) openIds.delete(card.dataset.id);
}, true);

async function loadContact(id) {
  if (contacts.has(id)) return contacts.get(id);
  try {
    const c = await api.getContact(id);
    contacts.set(id, c);
    for (const el of $$(`.order-card[data-id="${id}"] [data-contact]`)) {
      el.textContent = c ? `電話 ${c.phone}` : '沒有留電話';
    }
    return c;
  } catch (err) {
    console.warn(err);
    return undefined;
  }
}

function loadOpenContacts() {
  for (const id of openIds) if (!contacts.has(id)) loadContact(id);
}

// 新訂單與收件匣提示音
function detectNewOrders() {
  const pendingIds = orders.filter((o) => o.status === 'pending').map((o) => o.id);
  if (knownPending) {
    const fresh = orders.filter((o) => o.status === 'pending' && !knownPending.has(o.id));
    if (fresh.length) toast(`新訂單 ${fresh.map((o) => o.no).join('、')}`, 'info', 5000);
  }
  knownPending = new Set([...(knownPending || []), ...pendingIds]);
  // 有等待接單的訂單就持續響，直到全部接單或拒單
  if (pendingIds.length) startChimeLoop();
  else stopChimeLoop();
}

// ===== 訂單動作 =====
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('[data-id]');
  const o = card && byId(card.dataset.id);
  if (!o) return;
  const handlers = {
    accept: doAccept, reject: doReject, ready: doReady, picked: doPicked,
    undo: doUndo, message: doMessage, sms: doSms,
    shortage: doShortage, 'short-timeout': doShortageTimeout,
    qr: async (order) => showPickupTicket(order.id, order.no, order.total),
  };
  withBusy(btn, () => handlers[btn.dataset.act](o));
});

async function doAccept(o) {
  try {
    await api.acceptOrder(o.id);
    toast(`已接單 ${o.no}`, 'success');
  } catch (err) {
    if (err.code === 'sold-out') {
      const { value } = await openDialog({
        title: `無法接單 ${o.no}`,
        body: `<p>${escapeHtml(err.message)}</p><p class="muted text-sm">可以拒絕訂單並告知原因，或到後台調整庫存後再接單。</p>`,
        actions: [{ label: '拒絕訂單', value: 'reject', variant: 'danger' }],
      });
      if (value === 'reject') await rejectWith(o, `品項售完：${(err.problems || []).join('、')}`);
      return;
    }
    toast(errorText(err), 'danger');
  }
}

const REJECT_REASONS = ['品項售完', '攤位忙碌，請直接到攤位點餐', '即將收攤', '其他'];

async function doReject(o) {
  const { value, data } = await openDialog({
    title: `拒絕訂單 ${o.no}`,
    body: `
      <fieldset class="field" style="border:none;padding:0;margin:0">
        <legend class="field__label">原因(會顯示給顧客)</legend>
        <div class="radio-group">
          ${REJECT_REASONS.map((r, i) => `<label class="radio-chip"><input type="radio" name="reason" value="${r}" ${i === 0 ? 'checked' : ''}><span>${r}</span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field"><span class="field__label">補充說明(選填)</span><input class="input" name="note" maxlength="60"></label>`,
    actions: [{ label: '確定拒絕', value: 'ok', variant: 'danger' }],
  });
  if (value !== 'ok') return;
  const reason = [data.get('reason') === '其他' ? '' : data.get('reason'), data.get('note')].filter(Boolean).join('：');
  await rejectWith(o, reason);
}

async function rejectWith(o, reason) {
  try {
    let reasonTr = '';
    if (o.lang && o.lang !== 'zh-Hant' && reason) {
      reasonTr = REJECT_TR[reason]?.[o.lang] || await translateFor(o.lang, reason);
    }
    await api.rejectOrder(o.id, reason, reasonTr);
    toast(`已拒絕 ${o.no}`);
    if (o.pushEnabled) api.notifyCustomer(o.id, 'rejected', reasonTr || reason);
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

async function doReady(o) {
  try {
    await api.markReady(o.id);
  } catch (err) {
    toast(errorText(err), 'danger');
    return;
  }
  const res = await api.notifyCustomer(o.id, 'ready');
  if (res.sent) toast(`${o.no} 已完成，已發送推播`, 'success');
  else if (res.reason === 'demo') toast(`${o.no} 已完成(展示模式不發推播)`, 'success');
  else {
    const contact = await loadContact(o.id);
    toast(contact?.phone
      ? `${o.no} 已完成。顧客沒有開啟推播，可按「簡訊通知」`
      : `${o.no} 已完成。顧客頁面開著時會即時看到`, 'info', 5000);
    openIds.add(o.id);
    renderBoard();
  }
}

async function doUndo(o) {
  try {
    await api.undoReady(o.id);
    toast(`${o.no} 已退回製作中`);
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

async function doPicked(o) {
  let payment = o.payment;
  if (o.type === 'preorder') {
    const methods = paymentMethods();
    const total = displayTotal(o, itemsById());
    const { value, data } = await openDialog({
      title: `${o.no} 取餐收款`,
      body: `
        <p class="summary-row summary-row--total"><span>應收</span><span>${money(total)}</span></p>
        <fieldset class="field" style="border:none;padding:0;margin:0" ${methods.length === 1 ? 'hidden' : ''}>
          <legend class="field__label">付款方式</legend>
          <div class="radio-group">
            ${methods.map((m, i) => `<label class="radio-chip"><input type="radio" name="payment" value="${escapeHtml(m)}" ${i === 0 ? 'checked' : ''}><span>${escapeHtml(m)}</span></label>`).join('')}
          </div>
        </fieldset>`,
      actions: [{ label: '確認已取餐', value: 'ok' }],
    });
    if (value !== 'ok') return;
    payment = data.get('payment');
  }
  try {
    await api.markPicked(o.id, payment);
    toast(`${o.no} 已取餐`, 'success');
    openIds.delete(o.id);
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

async function doMessage(o) {
  const templates = settings?.messageTemplates || [];
  const { value, data } = await openDialog({
    title: `傳訊息給 ${o.no}`,
    body: `
      ${templates.length ? `<label class="field"><span class="field__label">常用訊息</span>
        <select class="select" name="tpl"><option value="">自行輸入</option>${templates.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span class="field__label">訊息內容</span>
        <textarea class="textarea" name="text" maxlength="120" required></textarea></label>
      <p class="muted text-sm">顧客的訂單頁會即時顯示；有開啟推播的顧客也會收到通知。</p>`,
    actions: [{ label: '傳送', value: 'ok' }],
    onOpen(dlg) {
      const sel = dlg.querySelector('[name=tpl]');
      sel?.addEventListener('change', () => {
        if (sel.value) dlg.querySelector('[name=text]').value = sel.value;
      });
    },
  });
  if (value !== 'ok') return;
  const text = String(data.get('text') || '').trim();
  if (!text) return;
  try {
    let tr = '';
    if (o.lang && o.lang !== 'zh-Hant') {
      const idx = (settings?.messageTemplates || []).indexOf(text);
      tr = (idx >= 0 && settings?.i18n?.[o.lang]?.messageTemplates?.[idx]) || await translateFor(o.lang, text);
    }
    await api.sendMessage(o.id, text, tr);
    const res = await api.notifyCustomer(o.id, 'message', tr || text);
    toast(res.sent ? '訊息已傳送並推播' : '訊息已傳送', 'success');
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

// 半自動簡訊：開啟店員手機的簡訊 App 並帶入內容，由店員按下傳送
async function doSms(o) {
  const contact = await loadContact(o.id);
  if (!contact?.phone) {
    toast('這筆訂單沒有留電話', 'danger');
    return;
  }
  const lang = o.lang || 'zh-Hant';
  let template = settings?.smsTemplate;
  if (lang !== 'zh-Hant') {
    // 翻譯後的範本若遺失 {no}，改用內建範本，避免簡訊少了訂單編號
    const tr = settings?.i18n?.[lang]?.smsTemplate;
    template = tr && tr.includes('{no}') ? tr : DEFAULT_SETTINGS.i18n[lang].smsTemplate;
  }
  const body = fillTemplate(template, { no: o.no, surname: personNameFor(o.surname || contact.surname || '', o.title, lang) });
  location.href = `sms:${contact.phone}?&body=${encodeURIComponent(body)}`;
}

// ===== 缺貨處理(已接單的預點訂單) =====
// 顧客偏好：choose 立即選擇替代商品 / similar 更換為任何類似商品 / remove 刪除該品項
// 只缺部分數量：直接刪除缺的份數，保留其餘，並通知顧客

// 訂單卡上的替代詢問狀態：倒數 1.5 分鐘，逾時可一鍵刪除
function shortageHtml(o) {
  if (!o.shortage) return '';
  const left = Math.ceil((o.shortage.sentAt + REPLY_WAIT_MS - Date.now()) / 1000);
  const map = itemsById();
  const items = o.shortage.requests.map((r) => `${candidateLabel(r, map)} ×${r.qty}`).join('、');
  if (left > 0) {
    return `<p class="text-sm short-wait">${icon('timer', 'icon--sm')}等待顧客選擇替代品(${escapeHtml(items)})・剩 <strong data-short-left="${o.id}">${left}</strong> 秒</p>`;
  }
  return `<div class="banner banner--danger short-wait">${icon('timer')}<div><p><strong>顧客未回覆</strong>(${escapeHtml(items)})</p>
    <button class="btn btn--sm btn--danger" data-act="short-timeout">刪除該品項</button></div></div>`;
}

// 每秒更新倒數；時間到時重畫訂單卡(顯示「顧客未回覆」)
setInterval(() => {
  let expired = false;
  for (const el of $$('[data-short-left]')) {
    const o = byId(el.dataset.shortLeft);
    if (!o?.shortage) continue;
    const left = Math.ceil((o.shortage.sentAt + REPLY_WAIT_MS - Date.now()) / 1000);
    if (left <= 0) expired = true;
    else el.textContent = left;
  }
  if (expired) renderBoard();
}, 1000);

// 顧客語言的通知文字(中文顧客回傳空字串)
function customerText(o, fn) {
  return o.lang && o.lang !== 'zh-Hant' ? fn(o.lang) : '';
}

async function notifyChange(o, zh, trText) {
  if (o.pushEnabled) api.notifyCustomer(o.id, 'message', trText || zh);
}

// 依明細找到目前的列(明細可能已被修改，索引會變動)
function findLine(lines, itemId, sel) {
  const key = selKey(sel || []);
  return lines.findIndex((l) => l.itemId === itemId && selKey(l.sel || []) === key);
}

// 套用修改並通知顧客
async function applyChanges(o, actions, opts = {}) {
  const map = itemsById();
  const preview = applyLineChanges(o.lines, map, actions);
  const message = notesText(preview.notes, map, 'zh-Hant');
  const messageTr = customerText(o, (lang) => notesText(preview.notes, map, lang));
  const res = await api.changeOrderLines(o.id, actions, { message, messageTr, ...opts });
  notifyChange(o, message, messageTr);
  return res;
}

async function doShortage(o) {
  const lines = o.lines || [];
  if (!lines.length) return;
  const { value, data } = await openDialog({
    title: `缺貨處理 ${o.no}`,
    body: `
      <p class="text-sm">顧客偏好：<strong>${SUB_PREF_LABEL[o.subPref] || SUB_PREF_LABEL.remove}</strong></p>
      ${o.shortage ? '<p class="banner">這張訂單正在等待顧客選擇替代品，新的詢問會取代目前的詢問。</p>' : ''}
      <p class="muted text-sm">勾選缺貨的品項並填寫缺幾份。只缺部分數量時，直接刪除缺的份數並通知顧客。</p>
      <div class="short-lines">
        ${lines.map((l, i) => `<div class="short-line">
          <label class="check"><input type="checkbox" name="pick" value="${i}"><span>${escapeHtml(lineLabel(l))} ×${l.qty}</span></label>
          <label class="short-line__qty"><span class="field__hint">缺</span><input class="input" type="number" name="q_${i}" min="1" max="${l.qty}" value="${l.qty}"></label>
        </div>`).join('')}
      </div>`,
    actions: [
      { label: '刪除整張訂單', value: 'cancel-all', variant: 'danger' },
      { label: '下一步', value: 'next' },
    ],
  });
  if (value === 'cancel-all') return doCancelAll(o);
  if (value !== 'next') return undefined;
  const picks = data.getAll('pick').map(Number);
  if (!picks.length) {
    toast('請勾選缺貨的品項', 'danger');
    return undefined;
  }
  const immediate = []; // 直接刪除或替代
  const requests = []; // 請顧客選擇
  const pref = o.subPref || 'remove';
  for (const i of picks) {
    const line = lines[i];
    const short = Math.max(1, Math.min(line.qty, Math.round(Number(data.get(`q_${i}`)) || line.qty)));
    if (short < line.qty || pref === 'remove') {
      immediate.push({ index: i, removeQty: short });
      continue;
    }
    // 整個品項缺貨：依顧客偏好準備替代清單
    const list = await editCandidates(o, line, pref);
    if (list === null) return undefined; // 攤位取消操作
    if (pref === 'similar') {
      immediate.push({ index: i, removeQty: short, replace: list.picked || null });
    } else if (list.candidates.length) {
      requests.push({ key: `r${i}`, itemId: line.itemId, sel: line.sel || [], qty: short, candidates: list.candidates });
    } else {
      immediate.push({ index: i, removeQty: short }); // 沒有可替代的品項：直接刪除
    }
  }
  try {
    if (immediate.length) {
      const res = await applyChanges(o, immediate);
      if (res.cancelled) {
        toast(`${o.no} 的品項已全部刪除，訂單已取消`, 'info', 5000);
        return undefined;
      }
    }
    if (requests.length) {
      await api.requestShortage(o.id, requests);
      const zh = tr('short.askPush', { no: o.no }, 'zh-Hant');
      notifyChange(o, zh, customerText(o, (lang) => tr('short.askPush', { no: o.no }, lang)));
      toast(`已請顧客選擇替代品，等待 ${Math.round(REPLY_WAIT_MS / 1000)} 秒`, 'success');
    } else {
      toast(`${o.no} 已更新明細並通知顧客`, 'success');
    }
    openIds.add(o.id);
  } catch (err) {
    toast(errorText(err), 'danger');
  }
  return undefined;
}

// 替代清單：先帶入攤位上次的設定(記憶)，沒有時自動建議；攤位可刪除、新增、設定選項
// pref === 'similar'：從清單中選定一項直接替代 → { picked }
// pref === 'choose'：確認清單後送給顧客 → { candidates }
async function editCandidates(o, line, pref) {
  const map = itemsById();
  const key = memoryKey(line.itemId, line.sel || []);
  let list = null;
  try {
    const mem = await api.getSubMemory(key);
    if (mem?.length) list = mem.filter((c) => map[c.itemId]).map((c) => ({ ...c, complete: !selProblems(map[c.itemId], normalizeSel(map[c.itemId], c)).length }));
  } catch (err) {
    console.warn(err);
  }
  if (!list?.length) list = suggestCandidates(line, map);
  const others = menu.filter((it) => it.active !== false);
  const result = await openDialog({
    title: `${lineLabel(line)} 的替代品`,
    size: 'wide',
    body: `
      <p class="muted text-sm">${pref === 'similar' ? '顧客同意由攤位挑選替代品：請選定一項。' : '確認要提供給顧客的替代清單(可刪除或新增)，送出後顧客有 1.5 分鐘可以選擇。'}</p>
      <div class="cand-list" data-cands></div>
      <div class="row">
        <select class="select" data-cand-add-item style="flex:1">${others.map((it) => `<option value="${it.id}">${escapeHtml(it.name)}</option>`).join('')}</select>
        <button type="button" class="btn btn--sm" data-cand-add>${icon('add', 'icon--sm')}加入</button>
      </div>`,
    actions: [{ label: pref === 'similar' ? '套用替代' : '送給顧客', value: 'ok' }],
    onOpen(dlg) {
      const box = dlg.querySelector('[data-cands]');
      const draw = () => {
        box.innerHTML = list.length ? list.map((c, i) => `
          <div class="cand ${c.complete ? '' : 'is-incomplete'}">
            ${pref === 'similar' ? `<input type="radio" name="cand" value="${i}" ${c.complete ? '' : 'disabled'} ${i === 0 && c.complete ? 'checked' : ''} aria-label="選定">` : ''}
            <span class="cand__label">${escapeHtml(candidateLabel(c, map))}<span class="muted text-sm">・${money(candidatePrice(c, map))}</span>${c.complete ? '' : '<span class="badge badge--danger">需設定選項</span>'}</span>
            ${optionGroups(map[c.itemId]).length ? `<button type="button" class="btn btn--sm" data-cand-set="${i}">設定選項</button>` : ''}
            <button type="button" class="btn btn--ghost btn--icon" data-cand-del="${i}" aria-label="刪除">${icon('close', 'icon--sm')}</button>
          </div>`).join('') : '<p class="muted text-sm">清單是空的：送出後會直接刪除該品項。</p>';
      };
      draw();
      dlg.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-cand-del]');
        const set = e.target.closest('[data-cand-set]');
        if (del) {
          list.splice(Number(del.dataset.candDel), 1);
          draw();
        }
        if (set) {
          const c = list[Number(set.dataset.candSet)];
          const res = await chooseOptions(map[c.itemId], { prev: c.sel, withQty: false, title: `${map[c.itemId].name} 的選項` });
          if (res) Object.assign(c, { sel: res.sel, complete: true });
          draw();
        }
        if (e.target.closest('[data-cand-add]')) {
          const it = map[dlg.querySelector('[data-cand-add-item]').value];
          if (!it || list.length >= 8) return;
          let sel = [];
          if (optionGroups(it).length) {
            const res = await chooseOptions(it, { withQty: false, title: `${it.name} 的選項` });
            if (!res) return;
            sel = res.sel;
          }
          list.push({ itemId: it.id, sel, complete: true });
          draw();
        }
      });
      // 送出前檢查：還有未設定選項的項目時不關閉
      dlg.querySelector('form').addEventListener('submit', (e) => {
        if (e.submitter?.value !== 'ok') return;
        if (list.some((c) => !c.complete)) {
          e.preventDefault();
          toast('還有項目需要設定選項', 'danger');
        } else if (pref === 'similar' && list.length && !dlg.querySelector('input[name=cand]:checked')) {
          e.preventDefault();
          toast('請選定一個替代品', 'danger');
        }
      });
    },
  });
  if (result.value !== 'ok') return null;
  const candidates = list.map(({ itemId, sel }) => ({ itemId, sel }));
  // 記住這次的設定，下次相同品項缺貨時自動帶入
  try {
    await api.saveSubMemory(key, candidates);
  } catch (err) {
    console.warn(err);
  }
  if (pref === 'similar') {
    const i = Number(result.data.get('cand'));
    return { picked: Number.isInteger(i) && candidates[i] ? candidates[i] : null };
  }
  return { candidates };
}

// 顧客已回覆：自動套用(多台攤位裝置同時處理時，只會套用一次)
const resolving = new Set();
function resolveReplies() {
  for (const o of orders) {
    const sh = o.shortage;
    if (!sh || o.shortageReply?.id !== sh.id || resolving.has(sh.id)) continue;
    resolving.add(sh.id);
    const map = itemsById();
    const actions = [];
    for (const r of sh.requests) {
      const index = findLine(o.lines || [], r.itemId, r.sel);
      if (index < 0) continue;
      const ans = o.shortageReply.answers?.[r.key];
      const cand = Number.isInteger(ans) && ans >= 0 ? r.candidates[ans] : null;
      actions.push({ index, removeQty: r.qty, replace: cand && map[cand.itemId] ? cand : null });
    }
    applyChanges(o, actions, { clearShortage: true, shortageId: sh.id })
      .then(() => {
        chime();
        toast(`${o.no} 顧客已選擇替代品，明細已更新`, 'success', 5000);
      })
      .catch((err) => {
        if (err.code !== 'bad-state') toast(errorText(err), 'danger');
      });
  }
}

// 顧客未回覆：刪除詢問中的品項
async function doShortageTimeout(o) {
  const sh = o.shortage;
  if (!sh) return;
  const actions = sh.requests
    .map((r) => ({ index: findLine(o.lines || [], r.itemId, r.sel), removeQty: r.qty }))
    .filter((a) => a.index >= 0);
  try {
    const res = await applyChanges(o, actions, { clearShortage: true, shortageId: sh.id });
    toast(res.cancelled ? `${o.no} 的品項已全部刪除，訂單已取消` : `${o.no} 已刪除未回覆的品項`, 'info', 5000);
  } catch (err) {
    if (err.code !== 'bad-state') toast(errorText(err), 'danger');
  }
}

// 刪除整張訂單(已接單後)：常用原因可點選，也可以自行修改文字
async function doCancelAll(o) {
  const { value, data } = await openDialog({
    title: `刪除整張訂單 ${o.no}`,
    body: `
      <div class="radio-group" data-reasons>
        ${CANCEL_REASONS.map((r) => `<button type="button" class="btn btn--sm" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
      </div>
      <label class="field"><span class="field__label">原因(會顯示給顧客，可修改)</span>
        <input class="input" name="reason" maxlength="60" value="${escapeHtml(CANCEL_REASONS[0])}"></label>
      <p class="muted text-sm">已售數量會加回，顧客會收到通知。</p>`,
    actions: [{ label: '確定刪除', value: 'ok', variant: 'danger-solid' }],
    onOpen(dlg) {
      dlg.querySelector('[data-reasons]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-reason]');
        if (b) dlg.querySelector('input[name=reason]').value = b.dataset.reason;
      });
    },
  });
  if (value !== 'ok') return;
  const reason = String(data.get('reason') || '').trim();
  try {
    const reasonTr = o.lang && o.lang !== 'zh-Hant' ? await translateFor(o.lang, reason) : '';
    await api.cancelByStall(o.id, reason, reasonTr);
    const zh = tr('track.stallCancelledPush', { no: o.no, r: reason }, 'zh-Hant');
    const trText = o.lang && o.lang !== 'zh-Hant' ? tr('track.stallCancelledPush', { no: o.no, r: reasonTr || reason }, o.lang) : '';
    notifyChange(o, zh, trText);
    toast(`已刪除 ${o.no}`);
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

// ===== 現場點餐 =====
function savePos() {
  pos.lines = pos.lines.filter((l) => l.qty > 0);
  store.set(POS_KEY, pos);
}

function renderPosGrid() {
  const grid = $('#pos-grid');
  if (!menu.length) {
    grid.innerHTML = '<p class="empty">目前沒有上架的品項</p>';
    return;
  }
  grid.innerHTML = menu.map((item) => {
    const left = item.stockLimit != null ? Math.max(0, item.stockLimit - (item.soldCount || 0)) : null;
    const soldOut = item.soldOut || left === 0 || blockedByOptions(item);
    return `<button type="button" class="pos-item" data-pos-add="${item.id}" ${soldOut ? 'disabled' : ''}>
      <span class="pos-item__name">${escapeHtml(item.name)}</span>
      <span class="row text-sm"><span>${money(item.price)}</span>${soldOut ? '<span class="badge badge--danger">售完</span>' : (left != null ? `<span class="muted">剩 ${left}</span>` : '')}</span>
    </button>`;
  }).join('');
}

function renderPosCart() {
  const map = itemsById();
  const priced = priceLines(pos.lines, map);
  $('#pos-lines').innerHTML = pos.lines.length ? pos.lines.map((l, i) => {
    const item = map[l.itemId];
    if (!item) return '';
    const sel = normalizeSel(item, l);
    const opt = selText(item, sel);
    const unit = item.price + selPrice(item, sel);
    return `<div class="cart-line">
      <div class="cart-line__name">${escapeHtml(item.name)}${opt ? `<span class="muted">(${escapeHtml(opt)})</span>` : ''}
        <div class="muted text-sm">${money(unit * l.qty)}</div></div>
      <div class="stepper">
        <button type="button" data-pos-line="${i}" data-delta="-1" aria-label="減少">${icon(l.qty === 1 ? 'delete' : 'remove', 'icon--sm')}</button>
        <span class="stepper__value">${l.qty}</span>
        <button type="button" data-pos-line="${i}" data-delta="1" aria-label="增加">${icon('add', 'icon--sm')}</button>
      </div></div>`;
  }).join('') : '<p class="muted">點左側品項加入</p>';
  $('#pos-total').textContent = money(priced.total);

  for (const b of $$('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === pos.mode));
  $('#pos-later-fields').hidden = pos.mode !== 'later';
  $('#pos-mode-hint').textContent = pos.mode === 'later'
    ? '先付款，產生取餐編號與 QR code，顧客可掃描追蹤進度並開啟通知。'
    : '當場付款並取餐，直接記入今日收支。';
  $('#pos-submit-text').textContent = pos.mode === 'later' ? '結帳並產生取餐編號' : '結帳記帳';

  const methods = paymentMethods();
  if (!methods.includes(pos.payment)) pos.payment = methods[0];
  $('#pos-payment').closest('fieldset').hidden = methods.length === 1;
  $('#pos-payment').innerHTML = methods.map((m) => `
    <label class="radio-chip"><input type="radio" name="payment" value="${escapeHtml(m)}" ${m === pos.payment ? 'checked' : ''}><span>${escapeHtml(m)}</span></label>`).join('');
}

// 相同品項且相同選擇合併為同一列
function posAdd(itemId, sel = [], qty = 1) {
  const key = selKey(sel);
  const line = pos.lines.find((l) => l.itemId === itemId && selKey(l.sel || []) === key);
  if (line) line.qty += qty;
  else pos.lines.push({ itemId, sel: sel.slice(), qty });
  savePos();
  renderPosCart();
}

$('#pos-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pos-add]');
  if (!btn) return;
  const item = itemsById()[btn.dataset.posAdd];
  if (!item) return;
  if (!hasOptions(item)) {
    posAdd(item.id, []);
    return;
  }
  posChoose(item);
});

// 選擇選項群組(必填單選、非必填複選、必填複選)，未完成時保留選擇並提示
// withQty：是否同時詢問數量；回傳 { sel, qty }，取消時回傳 null
async function chooseOptions(item, { prev = [], qty: prevQty = 1, withQty = true, title = item.name, error = '' } = {}) {
  const picked = new Set(prev);
  const groups = optionGroups(item);
  const { value, data } = await openDialog({
    title,
    body: `${error ? `<p class="banner banner--danger">${escapeHtml(error)}</p>` : ''}
      ${groups.map((g) => {
        const { multi, required } = groupRule(g);
        return `<fieldset class="field" style="border:none;padding:0;margin:0 0 var(--space-3)">
          <legend class="field__label">${escapeHtml(g.name)}<span class="muted text-sm">・${escapeHtml(ruleText(g))}${required ? '・必填' : ''}</span></legend>
          <div class="radio-group">${sortedChoices(g).map((c) => {
            const key = `${g.id}:${c.id}`;
            return `<label class="radio-chip"><input type="${multi ? 'checkbox' : 'radio'}" name="${multi ? `m_${g.id}` : `s_${g.id}`}" value="${escapeHtml(key)}" ${picked.has(key) ? 'checked' : ''} ${c.soldOut ? 'disabled' : ''}><span${c.soldOut ? ' style="text-decoration:line-through;opacity:.5"' : ''}>${escapeHtml(c.name)}${c.price > 0 ? ` ${addOnText(c.price)}` : ''}</span></label>`;
          }).join('')}</div>
        </fieldset>`;
      }).join('')}
      ${withQty ? `<label class="field"><span class="field__label">數量</span><input class="input" type="number" name="qty" min="1" max="99" value="${prevQty}"></label>` : ''}`,
    actions: [{ label: withQty ? '加入' : '確定', value: 'add' }],
  });
  if (value !== 'add') return null;
  const sel = normalizeSel(item, { sel: groups.flatMap((g) => data.getAll(`s_${g.id}`).concat(data.getAll(`m_${g.id}`))) });
  const qty = withQty ? Math.max(1, Number(data.get('qty')) || 1) : 1;
  const problems = selProblems(item, sel);
  if (problems.length) {
    const p = problems[0];
    const msg = p.reason === 'too-many' ? `「${p.group.name}」超過可選數量` : `請完成「${p.group.name}」的選擇`;
    return chooseOptions(item, { prev: sel, qty, withQty, title, error: msg });
  }
  return { sel, qty };
}

async function posChoose(item) {
  const res = await chooseOptions(item);
  if (res) posAdd(item.id, res.sel, res.qty);
}

$('#pos-lines').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pos-line]');
  if (!btn) return;
  const line = pos.lines[Number(btn.dataset.posLine)];
  line.qty += Number(btn.dataset.delta);
  savePos();
  renderPosCart();
});

$$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  pos.mode = b.dataset.mode;
  savePos();
  renderPosCart();
}));

$('#pos-payment').addEventListener('change', (e) => {
  pos.payment = e.target.value;
  savePos();
});

$('#pos-clear').addEventListener('click', () => {
  pos.lines = [];
  savePos();
  renderPosCart();
});

$('#pos-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('#pos-submit'), submitPos);
});

async function submitPos() {
  const err = $('#pos-error');
  err.hidden = true;
  const form = $('#pos-form');
  if (!pos.lines.length) {
    err.textContent = '請先加入品項。';
    err.hidden = false;
    return;
  }
  const problems = stockProblems(pos.lines, itemsById());
  if (problems.length) {
    err.textContent = `無法供應：${problems.join('、')}`;
    err.hidden = false;
    return;
  }
  const later = pos.mode === 'later';
  const surname = later ? form.surname.value.trim() : '';
  const title = later && surname ? form.elements.title.value : '';
  // 稍後取餐：姓氏選填；有填姓氏時需選稱謂
  if (later && surname && !TITLES.includes(title)) {
    err.textContent = '請選擇稱謂。';
    err.hidden = false;
    return;
  }
  const phone = later ? normalizePhone(form.phone.value) : '';
  if (phone && !isValidPhone(phone)) {
    err.textContent = '手機號碼格式不正確，或留空。';
    err.hidden = false;
    return;
  }
  const total = priceLines(pos.lines, itemsById()).total;
  try {
    const { orderId, no } = await api.createWalkin({
      lines: pos.lines, payment: pos.payment, later, surname, title, phone,
    });
    pos.lines = [];
    savePos();
    form.surname.value = '';
    form.phone.value = '';
    form.querySelectorAll('[name=title]').forEach((r) => { r.checked = false; });
    renderPosCart();
    if (later) showPickupTicket(orderId, no, total);
    else toast(`已記帳 ${no}・${money(total)}`, 'success');
  } catch (e2) {
    err.textContent = errorText(e2);
    err.hidden = false;
  }
}

// 稍後取餐：顯示編號與 QR code，讓顧客掃描追蹤進度
function showPickupTicket(orderId, no, total) {
  const url = new URL(`track.html?o=${encodeURIComponent(orderId)}&claim=1`, location.href).href;
  openDialog({
    title: '取餐編號',
    body: `
      <p class="display-no" style="font-size:var(--text-display);text-align:center">${escapeHtml(no)}</p>
      <p style="text-align:center">已收款 ${money(total)}</p>
      <div class="qr-box">${qrSvg(url)}</div>
      <p class="muted text-sm" style="text-align:center">請顧客用手機掃描，可查看進度並開啟取餐通知。<br>沒有掃描也可以憑編號取餐。</p>`,
    actions: [{ label: '完成', value: 'ok' }],
    cancelLabel: '',
  });
}

// ===== 收件匣 =====
function renderInbox() {
  const list = $('#inbox-list');
  const unread = inbox.filter((m) => !m.read);
  $('#inbox-count').classList.toggle('is-empty', unread.length === 0);
  $('#inbox-count').textContent = unread.length;
  if (knownUnread) {
    const fresh = unread.filter((m) => !knownUnread.has(`${m.id}:${m.lastAt}`));
    if (fresh.length) {
      chime();
      toast(`收件匣：${fresh[0].surname || '顧客'} 預點 ${fresh[0].count} 件超過上限`, 'info', 6000);
    }
  }
  knownUnread = new Set(unread.map((m) => `${m.id}:${m.lastAt}`));
  list.innerHTML = inbox.length ? inbox.map((m) => `
    <article class="card stack" style="${m.read ? '' : 'border:2px solid var(--color-primary)'}">
      <div class="row row--between">
        <strong>${m.read ? '' : '【未讀】'}超量預點 ${m.count} 件</strong>
        <span class="muted text-sm">${time(m.lastAt)}${m.attempts > 1 ? `・第 ${m.attempts} 次` : ''}</span>
      </div>
      <p>${escapeHtml(m.surname || '未填姓氏')}・${escapeHtml(m.phone || '未填電話')}</p>
      <p class="muted text-sm">${escapeHtml(m.summary || '')}</p>
      ${m.read ? '' : `<div><button class="btn btn--sm" data-read="${m.id}">${icon('check', 'icon--sm')}標示已讀</button></div>`}
    </article>`).join('') : '<p class="empty">沒有通知</p>';
}

$('#inbox-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-read]');
  if (!btn) return;
  withBusy(btn, async () => {
    try {
      await api.markInboxRead(btn.dataset.read);
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// ===== 取餐核對 =====
$$('[data-find]').forEach((b) => b.addEventListener('click', () => {
  findMode = b.dataset.find;
  for (const x of $$('[data-find]')) x.setAttribute('aria-pressed', String(x.dataset.find === findMode));
  $('#pickup-q').inputMode = findMode === 'phone' ? 'numeric' : 'text';
  $('#pickup-q').value = '';
  renderPickup();
  $('#pickup-q').focus();
}));

$('#pickup-q').addEventListener('input', () => renderPickup());

async function renderPickup() {
  const q = $('#pickup-q').value.trim().toUpperCase();
  const box = $('#pickup-results');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  let found = [];
  if (findMode === 'no') {
    const digits = q.replace(/\D/g, '');
    found = orders.filter((o) => o.no === q || (digits && /^\d+$/.test(q) && Number(o.no.slice(1)) === Number(digits)));
  } else {
    if (!/^\d{3,}$/.test(q)) {
      box.innerHTML = '<p class="muted">請輸入電話末三碼</p>';
      return;
    }
    const active = orders.filter((o) => o.status !== 'cancelled');
    await Promise.all(active.map((o) => loadContact(o.id)));
    found = active.filter((o) => contacts.get(o.id)?.phone?.endsWith(q));
  }
  if ($('#pickup-q').value.trim().toUpperCase() !== q) return; // 輸入已變更
  box.innerHTML = found.length ? found.map((o) => cardHtml(o, true)).join('') : '<p class="empty">今天沒有符合的訂單</p>';
}

// ===== 接受預點開關 =====
$('#accepting').addEventListener('change', async (e) => {
  const value = e.target.checked;
  try {
    await api.setAccepting(value);
    toast(value ? '已開始接受預點' : '已暫停接受預點');
  } catch (err) {
    e.target.checked = !value;
    toast(errorText(err), 'danger');
  }
});

$('#logout').addEventListener('click', async () => {
  if (await confirmDialog('登出', '確定要登出嗎？')) await api.staffLogout();
});

// ===== 初始化 =====
function renderAll() {
  renderBoard();
  renderPosGrid();
  renderPosCart();
  if ($('#pickup-q').value) renderPickup();
}

requireStaff('staff', (p) => {
  // 預設開啟提示音：瀏覽器若仍要求先互動，第一次點擊畫面時會自動開啟
  unlockAudio();
  $('#who').textContent = `${p.displayName}(${ROLE_LABEL[p.role]})`;
  $('#admin-link').hidden = !hasRole(p, 'manager');
  selectTab(store.get('tab-stall-tab', 'board'));
  setMobileCol(mobileCol);

  api.watchSettings((s) => {
    settings = s;
    $('#accepting').checked = !!s.acceptingPreorders;
    renderAll();
  });
  api.watchMenu((items) => {
    menu = items;
    renderAll();
  });
  api.watchTodayOrders((list) => {
    orders = list;
    detectNewOrders();
    resolveReplies();
    renderBoard();
    if ($('#pickup-q').value) renderPickup();
  });
  api.watchInbox((list) => {
    inbox = list;
    renderInbox();
  });

  // 每 30 秒更新經過時間與逾時提醒
  setInterval(renderBoard, 30000);

  // 攤位主管以上登入時，確保營業設定文件存在(安全規則需要讀取它)
  if (hasRole(p, 'manager')) api.ensureSettings().catch((err) => console.warn(err));
});
