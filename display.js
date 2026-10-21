// 叫號大螢幕：顯示製作中與可取餐的編號，新的可取餐編號出現時播放提示音
// 不用登入也能看：
//   員工已登入：直接讀今日訂單(與原本相同)
//   沒有登入：讀公開叫號資料 board/today(只有編號，由攤位營運頁自動寫入，不含姓名電話)
// 從顧客顯示頁切過來時網址帶 ?screen=配對碼：
//   繼續回報「我還在」、顯示攤位的 QR code 浮動視窗；
//   攤位開始現場點餐、結帳後的謝謝光臨、或攤位切回「輪播」時，自動回到顧客顯示頁
import { api, IS_DEMO } from '../api/index.js';
import { $, showDemoBanner } from '../core/ui.js';
import { hasRole } from '../core/guard.js';
import { escapeHtml, time } from '../core/format.js';
import { beep } from '../core/sound.js';
import { renderOverlay } from '../core/screen-overlay.js';

showDemoBanner(IS_DEMO, false);

const params = new URLSearchParams(location.search);
const SCREEN_PIN = /^\d{6}$/.test(params.get('screen') || '') ? params.get('screen') : '';
const PING_MS = 60 * 1000;
const DONE_MS = 60 * 1000;   // 與顧客顯示頁相同：結帳畫面顯示 1 分鐘

let knownReady = null;

// 依編號清單更新畫面；有新的可取餐編號時響提示音
function renderNos(making, ready) {
  $('#making').innerHTML = making.map((no) => `<span>${escapeHtml(no)}</span>`).join('') || '<span class="muted">—</span>';
  $('#ready').innerHTML = ready.map((no) => `<span>${escapeHtml(no)}</span>`).join('') || '<span class="muted">—</span>';
  const ids = new Set(ready);
  if (knownReady && [...ids].some((no) => !knownReady.has(no))) beep(3);
  knownReady = ids;
}

// 員工登入時：由今日訂單算出編號
function renderOrders(orders) {
  const making = orders.filter((o) => o.status === 'accepted' && o.no).map((o) => o.no);
  const ready = orders.filter((o) => o.status === 'ready' && o.no)
    .sort((a, b) => (b.readyAt || 0) - (a.readyAt || 0)).map((o) => o.no);
  renderNos(making, ready);
}

$('#fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

function tick() {
  $('#clock').textContent = time(Date.now());
}
tick();
setInterval(tick, 10000);

// 資料來源：登入狀態改變時切換(登入 → 今日訂單；沒登入 → 公開叫號資料)
let source = '';
let unwatchData = null;
api.onStaffAuth((profile) => {
  const next = hasRole(profile, 'staff') ? 'orders' : 'board';
  if (next === source) return;
  source = next;
  if (unwatchData) unwatchData();
  knownReady = null;
  unwatchData = next === 'orders'
    ? api.watchTodayOrders(renderOrders)
    : api.watchBoard((b) => renderNos(b?.making || [], b?.ready || []));
});

// ===== 從顧客顯示頁切過來 =====
function backToCustomer() {
  location.replace('customer.html');
}

if (SCREEN_PIN) {
  document.body.classList.add('display--screen');
  const ping = () => api.screenPing(SCREEN_PIN).catch((err) => console.warn('回報失敗', err));
  ping();
  setInterval(ping, PING_MS);
  api.watchScreen(SCREEN_PIN, (s) => {
    // 攤位解除連線：回到顧客顯示頁(會顯示輸入配對碼)
    if (!s) return backToCustomer();
    const doneFresh = s.state === 'done' && Date.now() - (Number(s.done?.at) || 0) < DONE_MS;
    if (s.view !== 'board' || s.state === 'cart' || doneFresh) return backToCustomer();
    renderOverlay(s, ['zh-Hant', 'en', 'ja'].includes(s.lang) ? s.lang : 'zh-Hant');
    return undefined;
  });
}
