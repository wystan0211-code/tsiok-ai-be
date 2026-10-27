// 全站設定檔：部署前依 README「發布教程」填入
// 所有欄位都是公開資訊，可以放進 GitHub；機密金鑰只放在 Apps Script 的指令碼屬性

export const CONFIG = {
  // Firebase 網頁應用程式設定(Firebase 主控台 > 專案設定 > 一般 > 你的應用程式)
  // apiKey 留空時，整個網站會以「展示模式」運作：資料只存在目前瀏覽器，方便預覽與測試
  firebase: {
    apiKey: 'AIzaSyC-PgGics-Z0R8pXChaWL_xx9VgQ5lhJKI',
    authDomain: 'tsiok-ai-be.firebaseapp.com',
    projectId: 'tsiok-ai-be',
    storageBucket: 'tsiok-ai-be.firebasestorage.app',
    messagingSenderId: '986397056354',
    appId: '1:986397056354:web:2aeeb3dc3e917981dee03b',
  },

  // 管理員帳號的 UID(Firebase 主控台 > Authentication > 使用者)
  // 必須和 firestore.rules 與 Apps Script 指令碼屬性 ADMIN_UID 相同
  adminUid: 'faA2Ez0SF4Ue84HdflQXy8qQhxK2',

  // 網頁推播憑證(專案設定 > 雲端通訊 > 網頁推播憑證 > 金鑰組)
  vapidKey: 'BMkSorPpqEZRkk2CZp0YGPeGAFHLqmSHkWyBll0Cyim6jj8fPrUzrGc0oAfgbTX6mPLvNF4YPj1POCdcZ2lwr7o',

  // Apps Script 網頁應用程式網址(部署後取得，以 /exec 結尾)
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyM37eT6i2foVkUhMbNr4gHrzTQHpITy_OTYnHeHN_yqNwsXbaZ86HymDWgMuZHsEvb/exec',

  // 員工帳號名稱轉成登入用 Email 的網域
  // example.com 是保留給範例使用的網域，不會收到真實信件；必須和 Apps Script 的 EMAIL_DOMAIN 相同
  staffEmailDomain: 'tsiokaibe.example.com',

  // Firebase JavaScript SDK 版本(從 gstatic CDN 載入)
  firebaseSdkVersion: '12.19.0',
};

// 未填 Firebase 設定時使用展示模式
export const IS_DEMO = !CONFIG.firebase.apiKey;
