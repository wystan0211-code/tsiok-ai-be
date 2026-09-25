/* Service Worker：接收 Firebase Cloud Messaging 背景推播
 * Firebase 設定由註冊網址的 config 參數帶入(見 js/api/firebase.js 的 enablePush)
 * 刻意不快取網頁檔案，避免更新網站後使用者看到舊版本 */
const params = new URL(self.location.href).searchParams;
const version = params.get('v') || '12.19.0';
let config = null;
try {
  config = JSON.parse(params.get('config') || 'null');
} catch (err) {
  config = null;
}

if (config && config.apiKey) {
  importScripts(
    `https://www.gstatic.com/firebasejs/${version}/firebase-app-compat.js`,
    `https://www.gstatic.com/firebasejs/${version}/firebase-messaging-compat.js`,
  );
  firebase.initializeApp(config);
  // 推播內含 notification 欄位時，SDK 會自動顯示通知並在點擊時開啟 fcm_options.link
  firebase.messaging();
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
