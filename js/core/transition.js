// 顧客端換頁等待畫面：往前換頁時顯示旋轉圓圈，新頁面資料準備好才消失
// 只在顧客端使用；攤位與後台不引入這個模組
const KEY = 'tab-page-wait';
const MIN_MS = 600; // 從按下到新頁面顯示，至少 0.6 秒，避免一閃而過

function showOverlay() {
  if (document.querySelector('.page-wait')) return;
  const el = document.createElement('div');
  el.className = 'page-wait';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span class="page-wait__ring" aria-hidden="true"></span><span>載入中</span>';
  document.body.append(el);
}

// 往前換頁：先顯示等待畫面，再前往新頁面
export function goTo(url, { replace = false } = {}) {
  showOverlay();
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // 無法記錄時新頁面就不顯示等待畫面，不影響功能
  }
  if (replace) location.replace(url);
  else location.href = url;
}

// 新頁面資料準備好時呼叫；未達最短時間會補足後再關閉
let readyCalled = false;
export function pageReady() {
  if (readyCalled) return;
  readyCalled = true;
  if (!window.__pageWaitHide) return;
  const wait = Math.max(0, MIN_MS - performance.now());
  setTimeout(() => window.__pageWaitHide?.(), wait);
}

// 按返回鍵回到這一頁時，瀏覽器可能保留離開前的等待畫面，這裡直接移除
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  document.querySelectorAll('.page-wait').forEach((el) => el.remove());
  document.documentElement.classList.remove('is-page-wait');
});
