// 訂單進度頁：即時顯示狀態、預估時間、攤位訊息，並提供開啟推播、取消、找回訂單
import { selText, selPrice, normalizeSel } from '../core/options.js';
import { REPLY_WAIT_MS } from '../core/shortage.js';
import { api, IS_DEMO } from '../api/index.js';
import {
  $, icon, toast, confirmDialog, openDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { store } from '../core/storage.js';
import {
  escapeHtml, money, time, dateTime,
} from '../core/format.js';
import {
  displayLines, displayTotal, estimateReadyAt, isFinal, isExpired, normalizePhone, isValidPhone,
} from '../core/order-logic.js';
import {
  t, getLang, itemText, totalMoney, withOption,
} from '../core/i18n.js';
import {
  beep, vibrate, unlockAudio, startAlarm, stopAlarm,
} from '../core/sound.js';
import {
  isIOS, isAndroid, isStandalone, isLineInApp,
} from '../core/env.js';
import { goTo, pageReady } from '../core/transition.js';

const CANCEL_WINDOW_MS = 3 * 60 * 1000; // 送出後 3 分鐘內可取消(安全規則也有相同限制)

showDemoBanner(IS_DEMO);

const params = new URLSearchParams(location.search);
const orderId = params.get('o');
const HISTORY_KEY = 'tab-history';

let uid = null;
let order = null;
let prevOrder = null;
let itemsById = {};
let firstSnapshot = true;
let settings = null;
let promptPush = params.get('new') === '1'; // 剛送出訂單：顯示開啟通知的提示卡片

function show(view) {
  $('#state-loading').hidden = view !== 'loading';
  $('#view-find').hidden = view !== 'find';
  $('#view-order').hidden = view !== 'order';
  // 返回鍵：找回訂單畫面顯示；訂單進行中隱藏，結束後才顯示
  $('#back-btn').hidden = !(view === 'find' || (view === 'order' && isFinal(order)));
}

// ===== 可取餐提醒(呼吸效果 + 提醒列 + 重複提示音，按「我知道了」停止) =====
const ackKey = (id) => `tab-ack-${id}`;
const isAcked = () => !!order && store.get(ackKey(order.id), false);

function renderReady() {
  const ready = order.status === 'ready' && !isExpired(order);
  const alerting = ready && !isAcked();
  $('#o-hero').classList.toggle('order-hero--ready', ready);
  $('#o-hero').classList.toggle('is-breathing', alerting);
  $('#ready-bar').hidden = !alerting;
  $('#ready-bar-text').textContent = t('track.readyBar', { no: order.no });
  if (!ready) stopAlarm();
}

$('#ready-ack').addEventListener('click', () => {
  stopAlarm();
  if (order) store.set(ackKey(order.id), true);
  renderReady();
});

// ===== 螢幕常亮：等待取餐期間不讓螢幕變暗(切換分頁或 App 會自動解除，回來時重新請求) =====
let wakeLock = null;
async function updateWakeLock() {
  const want = !!order && !isFinal(order) && !document.hidden;
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // 省電模式等情況可能被系統拒絕，不影響其他功能
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', updateWakeLock);

// ===== 引導我去攤位 =====
let guideKey = '';
function renderGuide() {
  const box = $('#o-guide');
  box.hidden = !settings || settings.guideActive === false || !order || isFinal(order);
  if (box.hidden) return;
  const key = [settings.guideType, settings.guideMapUrl, settings.guideImageVersion, getLang()].join('|');
  if (key === guideKey) return;
  guideKey = key;
  const body = $('#guide-body');
  const mapUrl = settings.guideMapUrl || '';
  if (settings.guideType === 'map' && /^https:\/\/www\.google\.com\/maps\/embed\?/.test(mapUrl)) {
    body.innerHTML = `<iframe class="guide__map" src="${escapeHtml(mapUrl)}" title="${escapeHtml(t('guide.button'))}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>`;
  } else if (settings.guideType === 'image' && settings.guideImageVersion) {
    body.innerHTML = `<span class="loading">${icon('progress_activity', 'spin')}</span>`;
    api.getSiteImage('guide').then((data) => {
      body.innerHTML = data
        ? `<img class="guide__img" src="${data}" alt="${escapeHtml(t('guide.button'))}">`
        : `<p class="muted">${t('guide.soon')}</p>`;
    }).catch(() => { body.innerHTML = `<p class="muted">${t('guide.soon')}</p>`; });
  } else {
    body.innerHTML = `<p class="muted">${t('guide.soon')}</p>`;
  }
}

$('#guide-toggle').addEventListener('click', () => {
  const btn = $('#guide-toggle');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  $('#guide-body').hidden = !open;
});

// ===== 送出訂單後的開啟通知提示 =====
// 系統權限視窗只能在使用者點擊時跳出，所以先顯示提示卡片，由顧客點按鈕
function notifyBlocker() {
  if (isLineInApp()) return t('track.lineTip');
  if (IS_DEMO) return t('track.pushDemo');
  if (isIOS() && !isStandalone()) return t('track.iosBody');
  if ('Notification' in window && Notification.permission === 'denied') return t('track.pushDeniedBody');
  return '';
}

async function maybePromptPush() {
  if (!promptPush || !order || order.pushEnabled || isFinal(order)) return;
  promptPush = false;
  const blocker = notifyBlocker();
  if (blocker) {
    await openDialog({
      title: t('push.promptTitle'),
      body: `<p>${escapeHtml(blocker)}</p>`,
      actions: [{ label: t('common.gotIt'), value: 'ok' }],
      cancelLabel: '',
    });
    return;
  }
  await openDialog({
    title: t('push.promptTitle'),
    body: `<p>${escapeHtml(t('push.promptBody'))}</p>
      <button type="button" class="btn btn--primary btn--lg btn--block" data-push-now>${icon('notifications_active')}${escapeHtml(t('track.enablePush'))}</button>`,
    actions: [],
    cancelLabel: t('push.later'),
    onOpen(dlg) {
      const btn = dlg.querySelector('[data-push-now]');
      btn.addEventListener('click', () => withBusy(btn, async () => {
        try {
          await api.enablePush(order.id);
          toast(t('track.pushOn'), 'success');
          dlg.close('ok');
        } catch (err) {
          toast(errorText(err), 'danger', 5000);
        }
      }));
    },
  });
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
      err.textContent = t('track.findErr');
      err.hidden = false;
      return;
    }
    try {
      const id = await api.findOrder(no, phone);
      if (!id) {
        err.textContent = t('track.noMatch');
        err.hidden = false;
        return;
      }
      goTo(`track.html?o=${encodeURIComponent(id)}`);
    } catch (e2) {
      err.textContent = errorText(e2);
      err.hidden = false;
    }
  });
});

// ===== 訂單進度 =====
const STEP_KEYS = {
  preorder: ['step.sent', 'step.making', 'step.ready', 'step.picked'],
  walkin: ['step.paid', 'step.making', 'step.ready', 'step.picked'],
};
const STEP_INDEX = { pending: 0, accepted: 1, ready: 2, picked: 3 };

function renderNotify() {
  const box = $('#o-notify');
  if (isFinal(order) || order.status === 'ready') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (isLineInApp()) {
    box.innerHTML = `<p class="row">${icon('notifications_off')}<strong>${t('track.pushTitle')}</strong></p><p class="text-sm" style="color:var(--color-danger)">${escapeHtml(t('track.lineTip'))}</p>`;
    return;
  }
  if (order.pushEnabled) {
    box.innerHTML = `<p class="row">${icon('notifications_active')}<strong>${t('track.pushOn')}</strong></p>
      ${isAndroid() ? `<p class="muted text-sm">${escapeHtml(t('track.batteryTip'))}</p>` : ''}`;
    return;
  }
  if (!IS_DEMO && !(isIOS() && !isStandalone()) && 'Notification' in window && Notification.permission === 'denied') {
    box.innerHTML = `<p class="row">${icon('notifications_off')}<strong>${t('track.pushTitle')}</strong></p><p class="text-sm">${escapeHtml(t('track.pushDeniedBody'))}</p>`;
    return;
  }
  if (IS_DEMO) {
    box.innerHTML = `<p class="row">${icon('notifications')}<strong>${t('track.pushTitle')}</strong></p><p class="muted text-sm">${t('track.pushDemo')}</p>`;
    return;
  }
  if (isIOS() && !isStandalone()) {
    box.innerHTML = `
      <p class="row">${icon('notifications')}<strong>${t('track.iosTitle')}</strong></p>
      <p class="text-sm">${escapeHtml(t('track.iosBody'))}</p>
      `;
    return;
  }
  box.innerHTML = `
    <p class="row">${icon('notifications')}<strong>${t('track.notifyMe')}</strong></p>
    <button id="push-btn" class="btn btn--primary btn--block" type="button">${icon('notifications_active')}${t('track.enablePush')}</button>
    `;
  $('#push-btn').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try {
      await api.enablePush(order.id);
      toast(t('track.pushOn'), 'success');
    } catch (err) {
      toast(errorText(err), 'danger', 5000);
    }
  }));
}

// ===== 攤位詢問替代品項 =====
// order.shortage = { id, sentAt, requests: [{ key, itemId, sel, qty, candidates: [{ itemId, sel }] }] }
// 顧客回覆 order.shortageReply = { id, answers: { key: 候選索引(-1 為刪除該品項) } }
let shortTimer = null;
function candText(c) {
  const item = itemsById[c.itemId];
  if (!item) return '';
  const sel = normalizeSel(item, c);
  return withOption(itemText(item).name, selText(item, sel, getLang()));
}

function renderShortage() {
  const box = $('#o-short');
  const sh = order.shortage;
  const active = sh && ['accepted', 'ready'].includes(order.status);
  clearInterval(shortTimer);
  if (!active) {
    box.hidden = true;
    box.dataset.id = '';
    return;
  }
  box.hidden = false;
  const replied = order.shortageReply?.id === sh.id;
  if (replied) {
    box.innerHTML = `<p class="row">${icon('check_circle')}<strong>${t('short.sent')}</strong></p>`;
    box.dataset.id = sh.id;
    return;
  }
  if (box.dataset.id === sh.id && box.querySelector('form')) {
    tickShortage();
    shortTimer = setInterval(tickShortage, 1000);
    return; // 已顯示同一則詢問：保留顧客已勾選的內容
  }
  box.dataset.id = sh.id;
  box.innerHTML = `
    <div class="short-ask__head"><h2 class="section-title" style="margin:0">${t('short.askTitle')}</h2><span class="short-ask__timer" data-short-timer></span></div>
    <p class="text-sm muted">${t('short.askBody')}</p>
    <form class="stack" data-short-form>
      ${sh.requests.map((r) => {
        const item = itemsById[r.itemId];
        const name = item ? withOption(itemText(item).name, selText(item, normalizeSel(item, r), getLang())) : '';
        return `<fieldset class="og short-ask__set">
          <legend class="short-ask__item">${escapeHtml(name)} ×${r.qty}</legend>
          <div class="og__rows">
            ${r.candidates.map((c, i) => {
              const it = itemsById[c.itemId];
              const price = it ? it.price + selPrice(it, normalizeSel(it, c)) : 0;
              return `<label class="og__row"><span class="og__text"><span class="og__name">${escapeHtml(candText(c))}</span><span class="og__price">${money(price)}</span></span>
                <input class="og__input" type="radio" name="r_${escapeHtml(r.key)}" value="${i}" required>
                <span class="og__mark og__mark--radio" aria-hidden="true"></span></label>`;
            }).join('')}
            <label class="og__row"><span class="og__text"><span class="og__name">${t('sub.remove')}</span></span>
              <input class="og__input" type="radio" name="r_${escapeHtml(r.key)}" value="-1" required>
              <span class="og__mark og__mark--radio" aria-hidden="true"></span></label>
          </div>
        </fieldset>`;
      }).join('')}
      <button class="btn btn--primary btn--block press" type="submit">${t('short.submit')}</button>
    </form>`;
  tickShortage();
  shortTimer = setInterval(tickShortage, 1000);
}

function tickShortage() {
  const el = $('[data-short-timer]');
  if (!el || !order?.shortage) return;
  const left = Math.max(0, Math.ceil((order.shortage.sentAt + REPLY_WAIT_MS - Date.now()) / 1000));
  el.textContent = t('short.left', { s: left });
}

$('#o-short').addEventListener('submit', (e) => {
  e.preventDefault();
  const formEl = e.target.closest('[data-short-form]');
  const sh = order?.shortage;
  if (!formEl || !sh) return;
  const data = new FormData(formEl);
  const answers = {};
  for (const r of sh.requests) {
    const v = data.get(`r_${r.key}`);
    if (v == null) {
      formEl.querySelector(`[name="r_${CSS.escape(r.key)}"]`)?.closest('fieldset')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    answers[r.key] = Number(v);
  }
  withBusy(formEl.querySelector('button[type=submit]'), async () => {
    try {
      await api.replyShortage(order.id, sh.id, answers);
      stopAlarm();
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

function renderOrder() {
  show('order');
  const type = order.type === 'walkin' ? 'walkin' : 'preorder';
  const expired = isExpired(order);
  $('#o-no').textContent = order.no;
  $('#o-status').textContent = expired ? t('status.expired') : t(`status.${order.status}`);
  document.title = order.status === 'ready' ? t('track.docReady', { no: order.no }) : t('track.title');

  // 預估時間與說明
  let eta = '';
  if (order.status === 'pending') eta = t('track.etaPending');
  if (order.status === 'accepted') {
    const at = estimateReadyAt(order, itemsById);
    if (at) {
      const mins = Math.ceil((at - Date.now()) / 60000);
      eta = mins > 0 ? t('track.eta', { time: time(at), min: mins }) : t('track.etaSoon');
    } else eta = t('track.etaMaking');
  }
  if (order.status === 'ready') eta = t('track.etaReady');
  if (order.status === 'picked') eta = t('track.etaPicked', { time: time(order.pickedAt) });
  if (expired) eta = '';
  $('#o-eta').textContent = eta;

  // 進度條(狀態沒變時不重畫，避免動畫重播)
  const steps = $('#o-steps');
  // 攤位取消訂單：跳到最後階段，進度條整條變紅
  const stallCancelled = order.status === 'cancelled' && order.cancelledBy === 'stall';
  const idx = expired ? null : (stallCancelled ? 3 : STEP_INDEX[order.status]);
  steps.hidden = idx == null;
  const stepsKey = `${type}:${order.status}:${stallCancelled}:${getLang()}`;
  if (steps.dataset.key !== stepsKey) {
    steps.dataset.key = stepsKey;
    const complete = order.status === 'picked' || stallCancelled;
    steps.classList.toggle('steps--complete', complete);
    steps.innerHTML = complete
      ? `<li class="step ${stallCancelled ? 'step--cancelled' : 'step--complete'}"><span class="step__bar"></span><span class="visually-hidden">${t(stallCancelled ? 'track.stallCancelled' : 'step.picked')}</span></li>`
      : STEP_KEYS[type].map((key, i) => {
        const name = t(key);
        let cls = '';
        if (idx != null && i < idx) cls = 'step--done';
        else if (i === idx) cls = 'step--current';
        return `<li class="step ${cls}" ${i === idx ? 'aria-current="step"' : ''}><span class="step__bar"></span><span class="visually-hidden">${name}</span></li>`;
      }).join('');
  }

  // 特殊狀態提示
  const alertBox = $('#o-alert');
  if (expired) {
    alertBox.innerHTML = `<div class="banner">${icon('info')}<p>${t('track.expired')}</p></div>`;
  } else if (order.status === 'rejected') {
    // 拒絕原因：顧客選英日文時顯示攤位送出時翻譯好的版本
    const reason = getLang() !== 'zh-Hant' && order.rejectReasonTr ? order.rejectReasonTr : order.rejectReason;
    alertBox.innerHTML = `<div class="banner banner--danger">${icon('error')}<div><p><strong>${t('track.rejTitle')}</strong></p>${reason ? `<p>${escapeHtml(t('track.rejReason', { r: reason }))}</p>` : ''}<p>${t('track.rejHint')}</p></div></div>`;
  } else if (stallCancelled) {
    const reason = getLang() !== 'zh-Hant' && order.cancelReasonTr ? order.cancelReasonTr : order.cancelReason;
    alertBox.innerHTML = `<div class="banner banner--danger">${icon('error')}<div><p><strong>${t('track.stallCancelled')}</strong></p>${reason ? `<p>${escapeHtml(t('track.stallCancelledReason', { r: reason }))}</p>` : ''}<p>${t('track.rejHint')}</p></div></div>`;
  } else if (order.status === 'cancelled') {
    alertBox.innerHTML = `<div class="banner">${icon('info')}<p>${t(order.voided ? 'track.voided' : 'track.cancelled')}</p></div>`;
  } else if (order.status === 'ready') {
    alertBox.innerHTML = `<div class="banner">${icon('notifications_active')}<p><strong>${t('track.readyStrong')}</strong> ${escapeHtml(t('track.readyBody', { no: order.no }))}</p></div>`;
  } else alertBox.innerHTML = '';

  renderShortage();
  renderNotify();
  renderGuide();
  renderReady();
  updateWakeLock();

  // 訊息
  const messages = order.messages || [];
  $('#o-messages-box').hidden = messages.length === 0;
  $('#o-messages').innerHTML = messages.slice().reverse().map((m) => `
    <div class="message"><p>${escapeHtml(messageText(m))}</p><p class="muted text-sm">${time(m.at)}</p></div>`).join('');

  // 明細
  const lines = displayLines(order, itemsById);
  $('#o-lines').innerHTML = lines.map((l) => `
    <div class="summary-row"><span>${escapeHtml(localLineLabel(l))} × ${l.qty}</span><span>${money(l.subtotal)}</span></div>`).join('');
  $('#o-total').innerHTML = `${order.totalChanged ? `<span class="total-changed">${t('short.totalChanged')}</span>` : ''}${escapeHtml(totalMoney(displayTotal(order, itemsById)))}`;
  $('#o-time').innerHTML = `<p>${escapeHtml(t('track.sentAt', { t: dateTime(order.createdAt) }))}</p>${order.establishedAt ? `<p>${escapeHtml(t('track.confirmedAt', { t: dateTime(order.establishedAt) }))}</p>` : ''}`;

  $('#o-cancel').hidden = !canCancel();
  $('#o-again').hidden = !isFinal(order);
}

// 品項名稱與口味依語言顯示(訂單內存的是中文)
function localLineLabel(l) {
  const item = itemsById[l.itemId];
  const name = item ? itemText(item).name : l.name;
  // 選項依語言顯示(訂單內存的是選擇 sel 與中文文字)
  const opt = item ? (selText(item, normalizeSel(item, l), getLang()) || l.option) : l.option;
  return withOption(name, opt);
}

// 攤位訊息：有翻譯時顯示翻譯
function messageText(m) {
  return getLang() !== 'zh-Hant' && m.tr ? m.tr : m.text;
}

// 本人、等待接單中、送出 3 分鐘內才顯示取消按鈕
function canCancel() {
  return order.status === 'pending' && order.uid === uid
    && Date.now() - (order.createdAt || 0) < CANCEL_WINDOW_MS;
}

// 狀態變化時的提醒
function notifyChanges() {
  if (firstSnapshot || !prevOrder) return;
  if (prevOrder.status !== order.status) {
    if (order.status === 'ready' && !isExpired(order)) {
      // 重複響到按「我知道了」為止，最長 60 秒
      if (!isAcked()) startAlarm(60000);
      showLocalNotification(t('track.notiTitle'), t('track.notiBody', { no: order.no }));
    } else if (order.status === 'accepted') {
      beep(1);
      toast(t('track.acceptedToast'));
    } else if (order.status === 'rejected') {
      beep(1);
      toast(t('track.rejTitle'), 'danger');
    }
  }
  // 攤位詢問替代品項：響鈴約 10 秒(比取餐通知短)
  if (order.shortage && order.shortage.id !== prevOrder.shortage?.id) {
    startAlarm(10000);
    showLocalNotification(t('short.askTitle'), t('short.askPush', { no: order.no }));
  }
  if (order.status === 'cancelled' && order.cancelledBy === 'stall' && prevOrder.status !== 'cancelled') {
    beep(2);
    vibrate();
  }
  const before = prevOrder.messages?.length || 0;
  const after = order.messages?.length || 0;
  if (after > before) {
    beep(2);
    vibrate();
    toast(t('track.messageToast', { text: messageText(order.messages[after - 1]) }), 'info', 6000);
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
  const ok = await confirmDialog(t('track.cancelBtn'), t('track.cancelConfirm'), {
    confirmLabel: t('track.cancelBtn'), cancelLabel: t('track.cancelKeep'), danger: true, solid: true,
  });
  if (!ok) return;
  withBusy(e.currentTarget, async () => {
    try {
      await api.cancelOrder(order.id);
      toast(t('track.cancelledToast'));
    } catch (err) {
      // 超過可取消時間或攤位已接單時，安全規則會拒絕
      toast(err.code === 'permission' || err.code === 'bad-state' ? t('track.cancelFail') : errorText(err), 'danger');
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
    pageReady();
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
    toast(t('track.sentToast'), 'success');
    params.delete('new');
    history.replaceState(null, '', `track.html?${params}`);
  }

  api.watchMenu((items) => {
    itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
    if (order) renderOrder();
  });

  api.watchSettings((s) => {
    settings = s;
    if (order) renderGuide();
  });

  api.watchOrder(orderId, (o) => {
    if (!o) {
      show('find');
      renderHistory();
      $('#find-error').textContent = t('track.notFound');
      $('#find-error').hidden = false;
      pageReady();
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
    pageReady();
    notifyChanges();
    firstSnapshot = false;
    maybePromptPush();
  });

  // 每 15 秒更新預估時間，也讓超過 12 小時的訂單即時顯示為失效
  setInterval(() => {
    if (order && ['pending', 'accepted', 'ready'].includes(order.status)) renderOrder();
  }, 15000);
}

init();
