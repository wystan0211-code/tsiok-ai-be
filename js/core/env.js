// 裝置與瀏覽器判斷(顧客頁面使用)

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

// 已加入主畫面、以 App 方式開啟
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// LINE 內建瀏覽器：不支援推播通知，資料也和 Chrome、Safari 分開
export function isLineInApp() {
  return /\bLine\//i.test(navigator.userAgent);
}
