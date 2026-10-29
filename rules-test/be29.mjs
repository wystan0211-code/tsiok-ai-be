// be29 安全規則測試：復原逾時作廢的預購單
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-tsiok',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const ts = () => firebase.firestore.FieldValue.serverTimestamp();
const at = (ms) => firebase.firestore.Timestamp.fromMillis(ms);
const out = [];
async function expect(label, shouldPass, fn) {
  try { await fn(); out.push(`[${label}] ${shouldPass ? '通過' : '錯誤：應被擋下卻成功'}`); }
  catch (e) { out.push(`[${label}] ${shouldPass ? `錯誤：${String(e.message).slice(0, 160)}` : '正確擋下'}`); }
}
const H = 3600000;
const now = Date.now();
await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc('settings/app').set({ orderMode: 'off', presalePayHours: 12, presaleSlots: [{ id: 's1', date: '2026-10-31', start: '12:00', end: '', cap: 5 }] });
  await db.doc('users/pm').set({ role: 'presale', disabled: false });
  await db.doc('users/st').set({ role: 'staff', disabled: false });
  await db.doc('users/mg').set({ role: 'manager', disabled: false });
  const base = (no, extra) => ({ type: 'presale', seq: 1, no, status: 'pending', uid: 'cust', paid: false, payHours: 12, slotId: 's1',
    items: [{ itemId: 'i0', qty: 1, option: null }], itemCount: 1, surname: '林敏君', title: '老師', lang: 'zh-Hant', pushEnabled: true,
    createdAt: at(now - 30 * H), updatedAt: at(now - 30 * H), ...extra });
  await db.doc('orders/v1').set(base('C001', {}));                              // 線上預購，已作廢
  await db.doc('orders/v2').set(base('C002', { onsite: true, uid: null }));     // 現場預購，已作廢
  await db.doc('orders/v3').set(base('C003', { createdAt: at(now - H) }));      // 還沒過期限
  await db.doc('orders/v4').set(base('C004', {}));
  await db.doc('orders/v5').set(base('C005', {}));
  await db.doc('activePhones/0911000001').set({ uid: 'cust', orderId: 'v1', updatedAt: ts() });
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const restore = (uid, id, extra = {}) => as(uid).doc(`orders/${id}`).update({ payFrom: ts(), payHours: 6, restoredAt: ts(), updatedAt: ts(), ...extra });

await expect('店員復原作廢預購單(應失敗)', false, () => restore('st', 'v1'));
await expect('攤位主管復原線上預購作廢單(應失敗)', false, () => restore('mg', 'v1'));
await expect('顧客自己復原(應失敗)', false, () => restore('cust', 'v1'));
await expect('復原時順便標示已付款(應失敗)', false, () => restore('pm', 'v1', { paid: true }));
await expect('付款期限 49 小時(應失敗)', false, () => restore('pm', 'v1', { payHours: 49 }));
await expect('付款期限不是伺服器時間(應失敗)', false, () => restore('pm', 'v1', { payFrom: at(now) }));
await expect('預購主管復原作廢預購單', true, () => restore('pm', 'v1'));
await expect('已復原的單再復原一次(應失敗)', false, () => restore('pm', 'v1'));
await expect('復原還沒過期限的單(應失敗)', false, () => restore('pm', 'v3'));
await expect('攤位主管復原現場預購作廢單', true, () => restore('mg', 'v2'));
await expect('復原後預購主管標示已付款', true, () => as('pm').doc('orders/v1').update({
  status: 'accepted', paid: true, paidAt: ts(), acceptedAt: ts(), establishedAt: ts(), updatedAt: ts(),
  lines: [{ itemId: 'i0', qty: 1, option: null, name: '品項', price: 10, subtotal: 10 }], total: 10 }));
await expect('預購主管讀取電話綁定(單筆)', true, () => as('pm').doc('activePhones/0911000001').get());
await expect('預購主管列出全部電話綁定(應失敗)', false, () => as('pm').collection('activePhones').get());
await expect('店員讀取電話綁定(單筆)', true, () => as('st').doc('activePhones/0911000001').get());
await expect('管理員復原作廢預購單', true, () => restore('faA2Ez0SF4Ue84HdflQXy8qQhxK2', 'v4'));
console.log(out.join('\n'));
await env.cleanup();
