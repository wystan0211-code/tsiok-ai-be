// 顧客顯示頁：面向顧客的平板或手機，不用登入
// 輸入現場點餐頁顯示的 6 位數配對碼後，即時顯示點餐明細、合計；結帳後顯示取餐編號與追蹤 QR code
// 語言由攤位的現場點餐頁切換(screens 文件的 lang)，這一頁不提供語言按鈕
import { api, IS_DEMO } from '../api/index.js';
import { $, showDemoBanner } from '../core/ui.js';
import { escapeHtml } from '../core/format.js';
import { t, ensureJapaneseFont } from '../core/i18n.js';
import { visibleIn } from '../core/order-logic.js';
import { qrSvg } from '../core/qr.js';
import { store } from '../core/storage.js';

showDemoBanner(IS_DEMO);

const PIN_KEY = 'tab-screen-pin';
const PING_MS = 60 * 1000;      // 每 1 分鐘回報一次「我還在」
const DONE_MS = 30 * 1000;      // 結帳畫面 30 秒後回到待機
const SLIDE_MS = 5000;          // 待機輪播每 5 秒換一張

let pin = '';
let unwatch = null;
let pingTimer = 0;
let doneTimer = 0;
let screen = null;
let lang = 'zh-Hant';
let doneShownFor = '';          // 已顯示過的結帳畫面(避免 30 秒後又跳回來)
let banners = [];

// ===== 語言：依攤位設定套用靜態文字 =====
function applyLangTo(code) {
  lang = ['zh-Hant', 'en', 'ja'].includes(code) ? code : 'zh-Hant';
  document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant-TW' : lang;
  if (lang === 'ja') ensureJapaneseFont();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, {}, lang);
}

const money = (n) => `$ ${Number(n || 0).toLocaleString('zh-TW')}`;

// ===== 配對 =====
function showPair(error = '') {
  stopWatch();
  $('#cs-pair').hidden = false;
  $('#cs-screen').hidden = true;
  $('#pin-error').hidden = !error;
  $('#pin-error').textContent = error;
  $('#pin-input').focus();
}

$('#pin-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  $('#pin-error').hidden = true;
});

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#pin-input').value.trim();
  if (!/^\d{6}$/.test(code)) {
    showPair(t('screen.pinWrong', {}, lang));
    return;
  }
  if (!await api.screenExists(code)) {
    showPair(t('screen.pinWrong', {}, lang));
    return;
  }
  connect(code);
});

function connect(code) {
  pin = code;
  store.set(PIN_KEY, code);
  $('#cs-pair').hidden = true;
  $('#cs-screen').hidden = false;
  stopWatch();
  unwatch = api.watchScreen(code, (data) => {
    if (!data) {
      // 攤位解除連線或重新產生配對碼：回到輸入配對碼
      store.set(PIN_KEY, '');
      pin = '';
      showPair(t('screen.disconnected', {}, lang));
      return;
    }
    screen = data;
    render();
  });
  ping();
  pingTimer = setInterval(ping, PING_MS);
}

function stopWatch() {
  if (unwatch) unwatch();
  unwatch = null;
  clearInterval(pingTimer);
}

// 回報「我還在」：攤位依此顯示已連線或已離線
function ping() {
  if (pin) api.screenPing(pin).catch((err) => console.warn('回報失敗', err));
}

// ===== 畫面 =====
function render() {
  if (!screen) return;
  if (screen.lang !== lang) applyLangTo(screen.lang);
  let view = screen.state;
  // 結帳畫面只顯示 30 秒
  if (view === 'done') {
    const key = `${screen.done?.no}|${screen.done?.at}`;
    const age = Date.now() - (screen.done?.at || 0);
    if ((doneShownFor === key && !doneTimer) || age > DONE_MS) view = 'idle';
    else if (doneShownFor !== key) {
      doneShownFor = key;
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => {
        doneTimer = 0;
        render();
      }, Math.max(0, DONE_MS - age));
    }
  } else {
    clearTimeout(doneTimer);
    doneTimer = 0;
  }
  $('#cs-idle').hidden = view !== 'idle';
  $('#cs-cart').hidden = view !== 'cart';
  $('#cs-done').hidden = view !== 'done';
  if (view === 'cart') renderCart();
  if (view === 'done') renderDone();
}

// 明細表格：品項靠左(選項換行縮排)，數量、小計靠右
function renderCart() {
  const prev = new Map([...document.querySelectorAll('#cs-lines tr[data-key]')].map((tr) => [tr.dataset.key, tr.dataset.sig]));
  $('#cs-lines').innerHTML = (screen.lines || []).map((l) => {
    const sig = `${l.qty}|${l.subtotal}`;
    const changed = prev.has(l.key) ? prev.get(l.key) !== sig : true;
    return `<tr data-key="${escapeHtml(l.key)}" data-sig="${sig}" class="${changed ? 'is-changed' : ''}">
      <td><span class="cs-table__name">${escapeHtml(l.name)}</span>${l.option ? `<span class="cs-table__opt">${escapeHtml(l.option)}</span>` : ''}</td>
      <td class="num">${l.qty}</td>
      <td class="num">${money(l.subtotal)}</td>
    </tr>`;
  }).join('');
  $('#cs-count').textContent = t('screen.count', { n: screen.count || 0 }, lang);
  $('#cs-total').textContent = money(screen.total);
}

function renderDone() {
  const d = screen.done || {};
  $('#cs-no').textContent = d.no || '';
  $('#cs-paid').textContent = t('screen.paid', { total: money(d.total) }, lang);
  $('#cs-qr-box').hidden = !d.url;
  $('#cs-qr').innerHTML = d.url ? qrSvg(d.url) : '';
}

// ===== 待機：一般點餐頁的橫幅輪播 =====
let slide = 0;
function renderBanners() {
  const box = $('#cs-banners');
  box.innerHTML = banners.map((b, i) => `<img class="cs-banner ${i === 0 ? 'is-current' : ''}" src="${b.data}" alt="">`).join('');
  $('#cs-welcome').hidden = banners.length > 0;
  slide = 0;
}
setInterval(() => {
  const imgs = document.querySelectorAll('.cs-banner');
  if (imgs.length < 2 || $('#cs-idle').hidden) return;
  imgs[slide].classList.remove('is-current');
  slide = (slide + 1) % imgs.length;
  imgs[slide].classList.add('is-current');
}, SLIDE_MS);

api.watchBanners((list) => {
  banners = list.filter((b) => visibleIn(b, 'open'));
  renderBanners();
});

// ===== 啟動：記得上次的配對碼，重新整理後自動連線 =====
applyLangTo('zh-Hant');
const saved = store.get(PIN_KEY, '');
if (saved && /^\d{6}$/.test(saved)) {
  api.screenExists(saved).then((ok) => (ok ? connect(saved) : showPair()));
} else {
  showPair();
}
