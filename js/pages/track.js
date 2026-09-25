// 訂單進度頁：即時顯示狀態、預估時間、攤位訊息，並提供開啟推播、取消、找回訂單
import { api, IS_DEMO } from '../api/index.js';
import {
  $, icon, toast, confirmDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { store } from '../core/storage.js';
import {
  escapeHtml, money, time, dateTime, STATUS_LABEL,
} from '../core/format.js';
import {
  displayLines, displayTotal, estimateReadyAt, isFinal, lineLabel, normalizePhone, isValidPhone,
} from '../core/order-logic.js';
import { beep, vibrate, unlockAudio } from '../core/sound.js';

showDemoBanner(IS_DEMO);

const params = new URLSearchParams(location.search);
const orderId = params.get('o');
const HISTORY_KEY = 'tab-history';
const baseTitle = document.title;

let uid = null;
let order = null;
let prevOrder = null;
let itemsById = {};
let firstSnapshot = true;

function show(view) {
  $('#state-loading').hidden = view !== 'loading';
  $('#view-find').hidden = view !== 'find';
  $('#view-order').hidden = view !== 'order';
}

// ===== 找回訂單 =====
function renderHistory() {
  const history = store.get(HISTORY_KEY, []);
  $('#history').hidden = history.length === 0;
  $('#history-list').innerHTML = history.map((h) => `
    <a class="btn btn--block" style="justify-content:space-between" href="track.html?o=${encodeURIComponent(h.orderId)}">
      <span class="display-no">${escapeHtml(h.no)}</span>
      <span class="muted text-sm">${dateTime(h.at)}</span>
    </a>`).join('');
}

$('#find-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector('button[type=submit]'), async () => {
    const err = $('#find-error');
    err.hidden = true;
    const no = form.no.value.trim().toUpperCase();
    const phone = normalizePhone(form.phone.value);
    if (!/^[AB]\d{3,}$/.test(no) || !isValidPhone(phone)) {
      err.textContent = '請輸入正確的訂單編號(例如 A012)與手機號碼。';
      err.hidden = false;
      return;
    }
    try {
      const id = await api.findOrder(no, phone);
      if (!id) {
        err.textContent = '找不到符合的訂單，請確認編號與電話。';
        err.hidden = false;
        return;
      }
      location.href = `track.html?o=${encodeURIComponent(id)}`;
    } catch (e2) {
      err.textContent = errorText(e2);
      err.hidden = false;
    }
  });
});

// ===== 訂單進度 =====
const STEP_NAMES = {
  preorder: ['已送出', '製作中', '可取餐', '已取餐'],
  walkin: ['已付款', '製作中', '可取餐', '已取餐'],
};
const STEP_INDEX = { pending: 0, accepted: 1, ready: 2, picked: 3 };

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function renderNotify() {
  const box = $('#o-notify');
  if (isFinal(order) || order.status === 'ready') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const keepOpen = '<p class="muted text-sm">開著這個頁面時，狀態會即時更新並播放提示音。</p>';
  if (order.pushEnabled) {
    box.innerHTML = `<p class="row">${icon('notifications_active')}<strong>已開啟取餐通知</strong></p>${keepOpen}`;
    return;
  }
  if (IS_DEMO) {
    box.innerHTML = `<p class="row">${icon('notifications')}<strong>取餐通知</strong></p><p class="muted text-sm">展示模式不支援推播。</p>${keepOpen}`;
    return;
  }
  if (isIOS() && !isStandalone()) {
    box.innerHTML = `
      <p class="row">${icon('notifications')}<strong>iPhone 開啟取餐通知</strong></p>
      <p class="text-sm">iPhone 需要先把網頁加入主畫面才能收到通知：點 Safari 下方的分享按鈕，選「加入主畫面」，再從主畫面開啟「九愛！買」，回到這個頁面按「開啟取餐通知」。</p>
      ${keepOpen}`;
    return;
  }
  box.innerHTML = `
    <p class="row">${icon('notifications')}<strong>餐點完成時通知我</strong></p>
    <button id="push-btn" class="btn btn--primary btn--block" type="button">${icon('notifications_active')}開啟取餐通知</button>
    ${keepOpen}`;
  $('#push-btn').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try {
      await api.enablePush(order.id);
      toast('已開啟取餐通知', 'success');
    } catch (err) {
      toast(errorText(err), 'danger', 5000);
    }
  }));
}

function renderOrder() {
  show('order');
  const type = order.type === 'walkin' ? 'walkin' : 'preorder';
  $('#o-no').textContent = order.no;
  $('#o-status').textContent = STATUS_LABEL[order.status] || order.status;
  document.title = order.status === 'ready' ? `【可取餐】${order.no}｜九愛！買` : baseTitle;

  // 預估時間與說明
  let eta = '';
  if (order.status === 'pending') eta = '等待攤位確認訂單';
  if (order.status === 'accepted') {
    const at = estimateReadyAt(order, itemsById);
    if (at) {
      const mins = Math.ceil((at - Date.now()) / 60000);
      eta = mins > 0 ? `預計 ${time(at)} 完成(約 ${mins} 分鐘)` : '即將完成，請留意通知';
    } else eta = '攤位製作中';
  }
  if (order.status === 'ready') eta = '請到攤位出示訂單編號取餐';
  if (order.status === 'picked') eta = `已於 ${time(order.pickedAt)} 取餐，謝謝光臨`;
  $('#o-eta').textContent = eta;

  // 進度條
  const steps = $('#o-steps');
  const idx = STEP_INDEX[order.status];
  steps.hidden = idx == null;
  steps.innerHTML = STEP_NAMES[type].map((name, i) => {
    let cls = '';
    if (idx != null && (i < idx || order.status === 'picked')) cls = 'step--done';
    else if (i === idx) cls = 'step--current';
    return `<li class="step ${cls}" ${i === idx ? 'aria-current="step"' : ''}><span class="step__bar"></span>${name}</li>`;
  }).join('');

  // 特殊狀態提示
  const alertBox = $('#o-alert');
  if (order.status === 'rejected') {
    alertBox.innerHTML = `<div class="banner banner--danger">${icon('error')}<div><p><strong>攤位未接受這筆訂單</strong></p>${order.rejectReason ? `<p>原因：${escapeHtml(order.rejectReason)}</p>` : ''}<p>歡迎直接到攤位點餐。</p></div></div>`;
  } else if (order.status === 'cancelled') {
    alertBox.innerHTML = `<div class="banner">${icon('info')}<p>訂單已取消。</p></div>`;
  } else if (order.status === 'ready') {
    alertBox.innerHTML = `<div class="banner">${icon('notifications_active')}<p><strong>餐點已完成！</strong>請到攤位出示編號 ${escapeHtml(order.no)} 取餐。</p></div>`;
  } else alertBox.innerHTML = '';

  renderNotify();

  // 訊息
  const messages = order.messages || [];
  $('#o-messages-box').hidden = messages.length === 0;
  $('#o-messages').innerHTML = messages.slice().reverse().map((m) => `
    <div class="message"><p>${escapeHtml(m.text)}</p><p class="muted text-sm">${time(m.at)}</p></div>`).join('');

  // 明細
  const lines = displayLines(order, itemsById);
  $('#o-lines').innerHTML = lines.map((l) => `
    <div class="summary-row"><span>${escapeHtml(lineLabel(l))} × ${l.qty}</span><span>${money(l.subtotal)}</span></div>`).join('');
  $('#o-total').textContent = money(displayTotal(order, itemsById));
  $('#o-price-note').textContent = order.lines?.length ? '' : '攤位接單後會確認最終金額。';
  $('#o-time').textContent = `送出時間 ${dateTime(order.createdAt)}${order.establishedAt ? `｜確立時間 ${dateTime(order.establishedAt)}` : ''}`;

  $('#o-cancel').hidden = !(order.status === 'pending' && order.uid === uid);
  $('#o-again').hidden = !isFinal(order);
}

// 狀態變化時的提醒
function notifyChanges() {
  if (firstSnapshot || !prevOrder) return;
  if (prevOrder.status !== order.status) {
    if (order.status === 'ready') {
      beep(3);
      vibrate([300, 150, 300, 150, 300]);
      toast('餐點已完成，請到攤位取餐！', 'success', 6000);
      showLocalNotification('餐點已完成', `訂單 ${order.no} 可以取餐了`);
    } else if (order.status === 'accepted') {
      beep(1);
      toast('攤位已接單，開始製作');
    } else if (order.status === 'rejected') {
      beep(1);
      toast('攤位未接受這筆訂單', 'danger');
    }
  }
  const before = prevOrder.messages?.length || 0;
  const after = order.messages?.length || 0;
  if (after > before) {
    beep(2);
    vibrate();
    toast(`攤位訊息：${order.messages[after - 1].text}`, 'info', 6000);
  }
}

// 頁面在背景時，用已註冊的 Service Worker 顯示系統通知(需已允許通知權限)
async function showLocalNotification(title, body) {
  try {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.showNotification(title, { body, icon: 'assets/brand/icon-192.png', tag: order.id });
  } catch {
    // 忽略
  }
}

$('#o-cancel').addEventListener('click', async (e) => {
  const ok = await confirmDialog('取消訂單', '確定要取消這筆訂單嗎？', { confirmLabel: '取消訂單', danger: true });
  if (!ok) return;
  withBusy(e.currentTarget, async () => {
    try {
      await api.cancelOrder(order.id);
      toast('訂單已取消');
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

$('#o-sound').addEventListener('click', () => {
  unlockAudio();
  setTimeout(() => beep(2), 50);
  vibrate([150]);
});

async function init() {
  try {
    uid = await api.initCustomer();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
  if (!orderId) {
    show('find');
    renderHistory();
    return;
  }
  if (params.get('claim') === '1') {
    try {
      await api.claimOrder(orderId);
      const hist = store.get(HISTORY_KEY, []);
      if (!hist.some((h) => h.orderId === orderId)) {
        hist.unshift({ orderId, no: '', at: Date.now() });
        store.set(HISTORY_KEY, hist.slice(0, 10));
      }
    } catch (err) {
      toast(errorText(err), 'danger');
    }
    params.delete('claim');
    history.replaceState(null, '', `track.html?${params}`);
  }
  if (params.get('new') === '1') {
    toast('訂單已送出，等待攤位接單', 'success');
    params.delete('new');
    history.replaceState(null, '', `track.html?${params}`);
  }

  api.watchMenu((items) => {
    itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
    if (order) renderOrder();
  });

  api.watchOrder(orderId, (o) => {
    if (!o) {
      show('find');
      renderHistory();
      $('#find-error').textContent = '找不到這筆訂單，請輸入編號與電話查詢。';
      $('#find-error').hidden = false;
      return;
    }
    prevOrder = order;
    order = o;
    // 現場訂單認領後補上編號到本機紀錄
    const hist = store.get(HISTORY_KEY, []);
    const entry = hist.find((h) => h.orderId === o.id);
    if (entry && !entry.no) {
      entry.no = o.no;
      store.set(HISTORY_KEY, hist);
    }
    renderOrder();
    notifyChanges();
    firstSnapshot = false;
  });

  // 每 30 秒更新預估時間
  setInterval(() => {
    if (order && order.status === 'accepted') renderOrder();
  }, 30000);
}

init();
