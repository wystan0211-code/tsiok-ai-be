// 資料存取入口：頁面只透過 api 物件讀寫資料
// 未設定 Firebase 時自動使用展示模式(demo.js)，兩者提供完全相同的函式
//
// 點餐者
//   initCustomer()                     取得匿名身分，回傳 uid
//   getCustomerState()                 { session, order }
//   startSession()                     建立一次性點餐連結 token；有進行中訂單時丟出 active-order
//   checkSession(token)                { ok, reason, orderId }
//   watchSettings(cb) / watchMenu(cb)  即時監聽設定與上架品項，回傳取消監聽函式
//   getItemImages(items)               { 品項ID: 圖片 dataURL }
//   submitPreorder({ lines, surname, phone, consentText })  { orderId, no }
//   reportOverLimit({ surname, phone, summary, count })     超量時通知攤位收件匣
//   watchOrder(orderId, cb) / cancelOrder(orderId) / findOrder(no, phone) / claimOrder(orderId)
//   enablePush(orderId)                申請通知權限並儲存推播 token
//
// 攤位(店員以上)
//   onStaffAuth(cb) / staffLogin(username, password) / staffLogout()
//   watchTodayOrders(cb) / acceptOrder / rejectOrder / markReady / undoReady / markPicked
//   sendMessage(orderId, text) / notifyCustomer(orderId, kind, text) / getContact(orderId)
//   createWalkin({ lines, payment, later, surname, phone }) / watchInbox(cb) / markInboxRead(id)
//   setAccepting(bool)
//
// 攤位主管以上
//   watchAllItems(cb) / saveItem(item) / deleteItem(id) / setItemImage(id, dataUrl)
//   saveSettings(patch) / ensureSettings() / listOrders({ from, to })
//
// 管理員
//   adminUpdateOrder(id, patch) / adminDeleteOrder(id) / adminCreateManual(data)
//   listAccounts() / createAccount(data) / updateAccount(uid, patch) / deleteAccount(uid)
//   resetCounters() / resetDemo()(僅展示模式)

import { IS_DEMO } from '../config.js';

const mod = IS_DEMO ? await import('./demo.js') : await import('./firebase.js');

export const api = mod.api;
export { IS_DEMO };
