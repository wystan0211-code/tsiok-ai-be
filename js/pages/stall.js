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
} from '../core/format.js';
import {
  countItems, displayLines, displayTotal, lineLabel, priceLines, stockProblems, summarizeLines,
  normalizePhone, isValidPhone, ACTIVE_STATUSES,
} from '../core/order-logic.js';
import { beep, isAudioReady } from '../core/sound.js';
import { qrSvg } from '../core/qr.js';

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
const byId = (id) => orders.find((o) => o.id === id);

// ===== 分頁 =====
function selectTab(name) {
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
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
    overdue ? `<span class="badge badge--danger">逾時 ${minutesSince(o.readyAt)} 分</span>` : '',
    ['rejected', 'cancelled'].includes(o.status) ? `<span class="badge badge--danger">${STATUS_LABEL[o.status]}</span>` : '',
    o.status === 'picked' ? `<span class="badge">${escapeHtml(o.payment || '')}</span>` : '',
  ].join('');

  let actions = '';
  if (o.status === 'pending') {
    actions = `
      <button class="btn btn--primary" data-act="accept">${icon('check')}接單</button>
      <button class="btn btn--danger" data-act="reject">${icon('block')}拒絕</button>`;
  } else if (o.status === 'accepted') {
    actions = `
      <button class="btn btn--primary" data-act="ready">${icon('notifications_active')}完成，通知取餐</button>
      <button class="btn" data-act="message">${icon('chat')}傳訊息</button>
      <button class="btn btn--ghost" data-act="picked">${icon('done_all')}已取餐</button>`;
  } else if (o.status === 'ready') {
    actions = `
      <button class="btn btn--primary" data-act="picked">${icon('done_all')}已取餐</button>
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
        <div class="muted text-sm">${escapeHtml(summarizeLines(lines))}</div>
      </summary>
      <div class="order-card__body">
        <ul class="order-card__lines">
          ${lines.map((l) => `<li class="summary-row"><span>${escapeHtml(lineLabel(l))} × ${l.qty}</span><span>${money(l.subtotal)}</span></li>`).join('')}
          <li class="summary-row"><strong>合計</strong><strong>${money(total)}${o.lines?.length ? '' : '(估)'}</strong></li>
        </ul>
        ${o.messages?.length ? `<div class="text-sm">${o.messages.map((m) => `<p class="muted">${time(m.at)} 已傳：${escapeHtml(m.text)}</p>`).join('')}</div>` : ''}
        ${o.rejectReason ? `<p class="text-sm">拒絕原因：${escapeHtml(o.rejectReason)}</p>` : ''}
        <p class="text-sm muted" data-contact>${contact ? `電話 ${escapeHtml(contact.phone)}` : (contact === null ? '沒有留電話' : '電話載入中')}</p>
        ${actions ? `<div class="order-card__actions">${actions}</div>` : ''}
      </div>
    </details>`;
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
    if (fresh.length) {
      beep(3);
      toast(`新訂單 ${fresh.map((o) => o.no).join('、')}`, 'info', 5000);
    }
  }
  knownPending = new Set([...(knownPending || []), ...pendingIds]);
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
    await api.rejectOrder(o.id, reason);
    toast(`已拒絕 ${o.no}`);
    if (o.pushEnabled) api.notifyCustomer(o.id, 'rejected', reason);
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
    const methods = settings?.paymentMethods || ['園遊券', '現金'];
    const total = displayTotal(o, itemsById());
    const { value, data } = await openDialog({
      title: `${o.no} 取餐收款`,
      body: `
        <p class="summary-row summary-row--total"><span>應收</span><span>${money(total)}</span></p>
        <fieldset class="field" style="border:none;padding:0;margin:0">
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
    await api.sendMessage(o.id, text);
    const res = await api.notifyCustomer(o.id, 'message', text);
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
  const body = fillTemplate(settings?.smsTemplate, { no: o.no, surname: personName(o.surname || contact.surname || '', o.title) });
  location.href = `sms:${contact.phone}?&body=${encodeURIComponent(body)}`;
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
    const soldOut = item.soldOut || left === 0;
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
    return `<div class="cart-line">
      <div class="cart-line__name">${escapeHtml(item.name)}${l.option ? `<span class="muted">(${escapeHtml(l.option)})</span>` : ''}
        <div class="muted text-sm">${money(item.price * l.qty)}</div></div>
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

  const methods = settings?.paymentMethods || ['園遊券', '現金'];
  if (!methods.includes(pos.payment)) pos.payment = methods[0];
  $('#pos-payment').innerHTML = methods.map((m) => `
    <label class="radio-chip"><input type="radio" name="payment" value="${escapeHtml(m)}" ${m === pos.payment ? 'checked' : ''}><span>${escapeHtml(m)}</span></label>`).join('');
}

function posAdd(itemId, option, qty = 1) {
  const line = pos.lines.find((l) => l.itemId === itemId && (l.option ?? null) === (option ?? null));
  if (line) line.qty += qty;
  else pos.lines.push({ itemId, option: option ?? null, qty });
  savePos();
  renderPosCart();
}

$('#pos-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pos-add]');
  if (!btn) return;
  const item = itemsById()[btn.dataset.posAdd];
  if (!item) return;
  if (!item.options?.length) {
    posAdd(item.id, null);
    return;
  }
  const { value, data } = await openDialog({
    title: item.name,
    body: `<div class="radio-group">${item.options.map((opt, i) => `<label class="radio-chip"><input type="radio" name="option" value="${escapeHtml(opt)}" ${i === 0 ? 'checked' : ''}><span>${escapeHtml(opt)}</span></label>`).join('')}</div>
      <label class="field"><span class="field__label">數量</span><input class="input" type="number" name="qty" min="1" max="99" value="1"></label>`,
    actions: [{ label: '加入', value: 'add' }],
  });
  if (value === 'add') posAdd(item.id, data.get('option'), Math.max(1, Number(data.get('qty')) || 1));
});

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
  const title = later ? form.elements.title.value : '';
  // 稍後取餐：姓氏與稱謂必填
  if (later && (!surname || !TITLES.includes(title))) {
    err.textContent = '請填寫姓氏並選擇稱謂。';
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
      beep(2, 660);
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
    renderBoard();
    if ($('#pickup-q').value) renderPickup();
  });
  api.watchInbox((list) => {
    inbox = list;
    renderInbox();
  });

  // 提示音需要先點擊畫面才能播放
  const hint = $('#sound-hint');
  hint.hidden = isAudioReady();
  document.addEventListener('pointerdown', () => {
    setTimeout(() => { hint.hidden = isAudioReady(); }, 100);
  });

  // 每 30 秒更新經過時間與逾時提醒
  setInterval(renderBoard, 30000);

  // 攤位主管以上登入時，確保營業設定文件存在(安全規則需要讀取它)
  if (hasRole(p, 'manager')) api.ensureSettings().catch((err) => console.warn(err));
});
