// 點餐頁：驗證一次性連結、瀏覽菜單、購物車、填寫姓氏電話並送出
import { api, IS_DEMO } from '../api/index.js';
import {
  $, icon, toast, openDialog, alertDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { store } from '../core/storage.js';
import { escapeHtml, money, personName, TITLES } from '../core/format.js';
import {
  countItems, priceLines, stockProblems, summarizeLines, normalizePhone, isValidPhone,
} from '../core/order-logic.js';
import { goTo, pageReady } from '../core/transition.js';

showDemoBanner(IS_DEMO);

const CART_KEY = 'tab-cart';
const FORM_KEY = 'tab-checkout';
const HISTORY_KEY = 'tab-history';
const token = new URLSearchParams(location.search).get('t') || '';

let settings = null;
let menu = [];
let images = {};
let cart = store.get(CART_KEY, { lines: [] });
let ready = false;

const itemsById = () => Object.fromEntries(menu.map((i) => [i.id, i]));

// 儲存購物車；菜單載入後才移除已下架的品項，避免載入前把購物車清空
function saveCart() {
  const map = itemsById();
  cart.lines = cart.lines.filter((l) => l.qty > 0 && (!menu.length || map[l.itemId]));
  store.set(CART_KEY, cart);
}

function qtyOf(itemId) {
  return cart.lines.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.qty, 0);
}

function addToCart(itemId, option, qty = 1) {
  const line = cart.lines.find((l) => l.itemId === itemId && (l.option ?? null) === (option ?? null));
  if (line) line.qty += qty;
  else cart.lines.push({ itemId, option: option ?? null, qty });
  saveCart();
  render();
}

function changeLine(index, delta) {
  const line = cart.lines[index];
  if (!line) return;
  line.qty += delta;
  saveCart();
  render();
}

// ===== 畫面切換 =====
function showState(name) {
  for (const s of ['loading', 'invalid', 'closed']) $(`#state-${s}`).hidden = s !== name;
  if (name) {
    $('#view-menu').hidden = true;
    $('#view-checkout').hidden = true;
    $('#cart-bar').hidden = true;
    $('#back-menu').hidden = true;
  }
}

function currentView() {
  return location.hash === '#checkout' && cart.lines.length ? 'checkout' : 'menu';
}

function render() {
  if (!ready || !settings) return;
  const banner = $('#banner');
  banner.hidden = !(settings.bannerActive && settings.bannerText);
  banner.innerHTML = `${icon('campaign')}<p>${escapeHtml(settings.bannerText)}</p>`;

  if (!settings.acceptingPreorders) {
    showState('closed');
    pageReady();
    return;
  }
  showState(null);
  pageReady();
  const view = currentView();
  $('#view-menu').hidden = view !== 'menu';
  $('#view-checkout').hidden = view !== 'checkout';
  $('#back-menu').hidden = view !== 'checkout';
  renderMenu();
  renderCartBar(view);
  if (view === 'checkout') renderCheckout();
}

function renderMenu() {
  const list = $('#menu-list');
  if (!menu.length) {
    list.innerHTML = '<p class="empty">目前沒有上架的品項</p>';
    return;
  }
  list.innerHTML = menu.map((item) => {
    const qty = qtyOf(item.id);
    const left = item.stockLimit != null ? Math.max(0, item.stockLimit - (item.soldCount || 0)) : null;
    const soldOut = item.soldOut || left === 0;
    const img = images[item.id]
      ? `<img class="menu-item__img" src="${images[item.id]}" alt="" loading="lazy">`
      : `<div class="menu-item__img">${icon('restaurant')}</div>`;
    let control;
    if (soldOut) control = '<span class="badge badge--danger">已售完</span>';
    else if (item.options?.length) {
      // 有選項的品項：加號開啟選項視窗，旁邊顯示已加入的數量
      control = `${qty ? `<span class="muted text-sm" aria-label="已加入 ${qty} 份">×${qty}</span>` : ''}
        <button type="button" class="btn-add press" data-action="choose" data-id="${item.id}" aria-label="加入 ${escapeHtml(item.name)}">${icon('add')}</button>`;
    } else if (qty) {
      control = `<div class="stepper">
          <button type="button" class="press" data-action="minus" data-id="${item.id}" aria-label="減少 ${escapeHtml(item.name)}">${icon('remove', 'icon--sm')}</button>
          <span class="stepper__value" aria-live="polite">${qty}</span>
          <button type="button" class="press" data-action="plus" data-id="${item.id}" aria-label="增加 ${escapeHtml(item.name)}">${icon('add', 'icon--sm')}</button>
        </div>`;
    } else {
      control = `<button type="button" class="btn-add press" data-action="plus" data-id="${item.id}" aria-label="加入 ${escapeHtml(item.name)}">${icon('add')}</button>`;
    }
    const showLeft = settings.showStockLeft !== false && left != null && left > 0 && left <= 10;
    return `<article class="menu-item ${soldOut ? 'menu-item--soldout' : ''}">
      ${img}
      <div class="menu-item__body">
        <h3 class="menu-item__name">${escapeHtml(item.name)}</h3>
        ${item.description ? `<p class="menu-item__desc">${escapeHtml(item.description)}</p>` : ''}
        <p class="row text-sm muted">
          ${item.prepMinutes ? `<span class="row" style="gap:2px">${icon('schedule', 'icon--sm')}約 ${item.prepMinutes} 分鐘</span>` : ''}
          ${showLeft ? `<span class="badge badge--warning">剩 ${left} 份</span>` : ''}
        </p>
        <div class="menu-item__foot">
          <span class="menu-item__price">${money(item.price)}</span>
          <div class="menu-item__control">${control}</div>
        </div>
      </div>
    </article>`;
  }).join('');
}

function renderCartBar(view) {
  const count = countItems(cart.lines);
  const { total } = priceLines(cart.lines, itemsById());
  $('#cart-bar').hidden = view !== 'menu' || count === 0;
  $('#cart-bar-text').textContent = `查看訂單 · ${count} 件 · ${money(total)}`;
}

function renderCheckout() {
  const map = itemsById();
  const priced = priceLines(cart.lines, map);
  const max = settings.maxItemsPerOrder;
  const count = countItems(cart.lines);
  $('#cart-lines').innerHTML = cart.lines.map((l, i) => {
    const item = map[l.itemId];
    if (!item) return '';
    return `<div class="cart-line">
      <div class="cart-line__name">
        <div>${escapeHtml(item.name)}${l.option ? `<span class="muted">(${escapeHtml(l.option)})</span>` : ''}</div>
        <div class="muted text-xs">${money(item.price)} × ${l.qty} = ${money(item.price * l.qty)}</div>
      </div>
      <div class="stepper">
        <button type="button" class="press" data-action="line-minus" data-index="${i}" aria-label="減少">${icon(l.qty === 1 ? 'delete' : 'remove', 'icon--sm')}</button>
        <span class="stepper__value">${l.qty}</span>
        <button type="button" class="press" data-action="line-plus" data-index="${i}" aria-label="增加">${icon('add', 'icon--sm')}</button>
      </div>
    </div>`;
  }).join('');
  $('#cart-count').textContent = `${count} 件`;
  $('#cart-total').textContent = money(priced.total);
  const warn = $('#limit-warning');
  warn.hidden = count <= max;
  warn.innerHTML = `${icon('warning')}<p>為了避免惡意棄單，如欲購買大量請至攤位。</p>`;
  $('#consent-text').textContent = settings.consentText;
}

// ===== 互動 =====
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'plus') addToCart(id, null, 1);
  if (action === 'minus') {
    const idx = cart.lines.findIndex((l) => l.itemId === id);
    if (idx >= 0) changeLine(idx, -1);
  }
  if (action === 'line-plus') changeLine(Number(btn.dataset.index), 1);
  if (action === 'line-minus') changeLine(Number(btn.dataset.index), -1);
  if (action === 'choose') chooseOption(id);
});

async function chooseOption(itemId) {
  const item = itemsById()[itemId];
  if (!item) return;
  const { value, data } = await openDialog({
    title: item.name,
    body: `
      <fieldset class="field" style="border:none;padding:0;margin:0">
        <legend class="field__label">口味 / 選項</legend>
        <div class="radio-group">
          ${item.options.map((opt, i) => `<label class="radio-chip"><input type="radio" name="option" value="${escapeHtml(opt)}" ${i === 0 ? 'checked' : ''}><span>${escapeHtml(opt)}</span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field">
        <span class="field__label">數量</span>
        <input class="input" type="number" name="qty" min="1" max="${settings.maxItemsPerOrder}" value="1" required>
      </label>`,
    actions: [{ label: '加入', value: 'add' }],
  });
  if (value !== 'add') return;
  const qty = Math.max(1, Math.min(settings.maxItemsPerOrder, Number(data.get('qty')) || 1));
  addToCart(itemId, data.get('option'), qty);
  toast(`已加入 ${item.name}(${data.get('option')})×${qty}`);
}

$('#back-menu').addEventListener('click', (e) => {
  e.preventDefault();
  history.back();
});

window.addEventListener('hashchange', render);

// 表單草稿存在本機，重新整理不會消失
const form = $('#checkout-form');
const draft = store.get(FORM_KEY, {});
form.surname.value = draft.surname || '';
form.phone.value = draft.phone || '';
if (TITLES.includes(draft.title)) form.querySelector(`[name=title][value="${draft.title}"]`).checked = true;
form.addEventListener('input', () => {
  store.set(FORM_KEY, { surname: form.surname.value, title: form.elements.title.value, phone: form.phone.value });
});

function formError(message) {
  const el = $('#form-error');
  el.hidden = !message;
  el.textContent = message || '';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('#submit-btn'), submit);
});

async function submit() {
  formError('');
  const surname = form.surname.value.trim();
  const title = form.elements.title.value;
  const phone = normalizePhone(form.phone.value);
  if (!surname) return formError('請填寫姓氏。');
  if (!TITLES.includes(title)) return formError('請選擇稱謂。');
  if (!isValidPhone(phone)) return formError('手機號碼格式不正確，請輸入 09 開頭的 10 碼號碼。');
  if (!form.consent.checked) return formError('請勾選同意取餐通知。');

  const map = itemsById();
  const count = countItems(cart.lines);
  if (!count) return formError('購物車是空的。');

  // 超過上限：自動拒絕並通知攤位收件匣
  if (count > settings.maxItemsPerOrder) {
    const summary = summarizeLines(priceLines(cart.lines, map).lines);
    try {
      await api.reportOverLimit({ surname: personName(surname, title), phone, summary, count });
    } catch (err) {
      console.warn(err);
    }
    await alertDialog('訂單未送出', `單筆預點最多 ${settings.maxItemsPerOrder} 件，你選了 ${count} 件，系統已自動拒絕並通知攤位。請直接到攤位點餐。`);
    return undefined;
  }

  const problems = stockProblems(cart.lines, map);
  if (problems.length) return formError(`無法供應：${problems.join('、')}`);

  try {
    const { orderId, no } = await api.submitPreorder({
      lines: cart.lines, surname, title, phone, consentText: settings.consentText,
    });
    const history = store.get(HISTORY_KEY, []);
    history.unshift({ orderId, no, at: Date.now() });
    store.set(HISTORY_KEY, history.slice(0, 10));
    cart = { lines: [] };
    store.set(CART_KEY, cart);
    goTo(`track.html?o=${encodeURIComponent(orderId)}&new=1`, { replace: true });
  } catch (err) {
    formError(errorText(err));
  }
  return undefined;
}

// ===== 初始化 =====
async function loadImages() {
  try {
    images = await api.getItemImages(menu);
    renderMenu();
  } catch (err) {
    console.warn('圖片載入失敗', err);
  }
}

async function init() {
  try {
    await api.initCustomer();
    const check = await api.checkSession(token);
    if (!check.ok) {
      showState('invalid');
      pageReady();
      if (check.reason === 'used' && check.orderId) {
        $('#invalid-text').textContent = '這個點餐連結已經送出過訂單。';
        $('#invalid-action').textContent = '查看訂單進度';
        $('#invalid-action').href = `track.html?o=${encodeURIComponent(check.orderId)}`;
      }
      return;
    }
  } catch (err) {
    showState('invalid');
    pageReady();
    $('#invalid-text').textContent = errorText(err);
    return;
  }
  ready = true;
  api.watchSettings((s) => {
    settings = s;
    render();
  });
  let lastImageKey = '';
  api.watchMenu((items) => {
    menu = items;
    saveCart();
    render();
    const key = items.map((i) => `${i.id}:${i.imageVersion || 0}`).join('|');
    if (key !== lastImageKey) {
      lastImageKey = key;
      loadImages();
    }
  });
}

init();
