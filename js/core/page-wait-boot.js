/* 顧客端換頁等待畫面：開機腳本
 * 以一般 <script> 放在 <head>，在頁面內容顯示前執行
 * 只有上一頁用 goTo() 往前換頁時才會顯示；按返回、重新整理、直接開啟網址都不顯示 */
(function () {
  var KEY = 'tab-page-wait';
  var MAX_MS = 8000; // 保險：最多 8 秒一定關閉，避免卡在等待畫面
  var stamp = 0;
  try {
    stamp = Number(sessionStorage.getItem(KEY)) || 0;
    sessionStorage.removeItem(KEY);
  } catch (e) {
    stamp = 0;
  }
  // 標記超過 15 秒視為過期(例如換頁失敗後留下的標記)
  if (!stamp || Date.now() - stamp > 15000) return;

  var root = document.documentElement;
  var el = null;
  root.classList.add('is-page-wait');

  function mount() {
    if (el || !document.body) return;
    el = document.createElement('div');
    el.className = 'page-wait';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="page-wait__ring" aria-hidden="true"></span><span>載入中</span>';
    document.body.appendChild(el);
  }

  function hide() {
    root.classList.remove('is-page-wait');
    if (!el) return;
    var target = el;
    el = null;
    target.classList.add('is-leaving');
    setTimeout(function () { target.remove(); }, 200);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.__pageWaitHide = hide;
  setTimeout(hide, MAX_MS);
})();
