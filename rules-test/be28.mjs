// be28 安全規則測試：定時開放預購、現場預購不受模式限制、選項已售數量、攤位修改未付款預購單
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-tsiok',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const ts = () => firebase.firestore.FieldValue.serverTimestamp();
const out = [];
async function expect(label, shouldPass, fn) {
  try { await fn(); out.push(`[${label}] ${shouldPass ? '通過' : '錯誤：應被擋下卻成功'}`); }
  catch (e) { out.push(`[${label}] ${shouldPass ? `錯誤：${String(e.message).slice(0, 160)}` : '正確擋下'}`); }
}
const H = 3600000;
async function seed(extra = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('settings/app').set({ acceptingPreorders: false, orderMode: 'off', maxItemsPerOrder: 10, presalePayHours: 12,
      presaleMaxItems: 8, presaleClasses: ['901'], presaleSlots: [{ id: 's1', date: '2026-10-31', start: '12:00', end: '', cap: 5 }], ...extra });
    await db.doc('counters/C').set({ value: 0, lastOrderId: null });
    await db.doc('counters/A').set({ value: 0, lastOrderId: null });
    for (let i = 0; i < 10; i++) await db.doc(`items/i${i}`).set({ name: `品項${i}`, price: 10, active: true, soldOut: false, soldCount: 0 });
    await db.doc('users/pm').set({ role: 'presale', disabled: false });
    await db.doc('users/st').set({ role: 'staff', disabled: false });
    await db.doc('users/mg').set({ role: 'manager', disabled: false });
  });
}
let n = 0;
async function submit(type = 'presale', lines = 3) {
  const uid = `c${++n}`;
  const phone = `09110${String(n).padStart(5, '0')}`;
  const db = env.authenticatedContext(uid).firestore();
  await db.doc(`sessions/${uid}`).set({ token: 'a'.repeat(32), used: false, orderId: null, updatedAt: ts() });
  const orderRef = db.collection('orders').doc();
  const C = type === 'presale' ? 'C' : 'A';
  const items = Array.from({ length: lines }, (_, i) => ({ itemId: `i${i}`, qty: 1, option: '甜', sel: ['g0:c1'] }));
  await db.runTransaction(async (tx) => {
    const c = await tx.get(db.doc(`counters/${C}`));
    await tx.get(db.doc(`sessions/${uid}`));
    const seq = (c.exists ? c.data().value : 0) + 1;
    const no = C + String(seq).padStart(3, '0');
    tx.set(db.doc(`counters/${C}`), { value: seq, lastOrderId: orderRef.id });
    const base = { type, seq, no, status: 'pending', uid, items, itemCount: lines, surname: type === 'presale' ? '林敏君' : '王', title: type === 'presale' ? '老師' : '先生', lang: 'zh-Hant', pushEnabled: false, createdAt: ts(), updatedAt: ts() };
    tx.set(orderRef, type === 'presale' ? { ...base, paid: false, payHours: 12, slotId: 's1' } : { ...base, subPref: 'remove' });
    tx.set(db.doc(`contacts/${orderRef.id}`), { orderId: orderRef.id, surname: base.surname, phone, consentNotify: true, consentText: '同意', consentAt: ts(), createdAt: ts() });
    tx.set(db.doc(`activePhones/${phone}`), { uid, orderId: orderRef.id, updatedAt: ts() });
    tx.update(db.doc(`sessions/${uid}`), { used: true, orderId: orderRef.id, updatedAt: ts() });
    tx.set(db.doc(`lookups/${no}_${phone}`), { orderId: orderRef.id, createdAt: ts() });
  });
  return orderRef.id;
}
async function submitOnsite(staffUid = 'mg') {
  const db = env.authenticatedContext(staffUid).firestore();
  const orderRef = db.collection('orders').doc();
  const items = [{ itemId: 'i0', qty: 2, option: null }];
  await db.runTransaction(async (tx) => {
    const c = await tx.get(db.doc('counters/C'));
    const seq = (c.exists ? c.data().value : 0) + 1;
    tx.set(db.doc('counters/C'), { value: seq, lastOrderId: orderRef.id });
    tx.set(orderRef, { type: 'presale', onsite: true, seq, no: 'C' + String(seq).padStart(3, '0'), status: 'pending', uid: null, claimedBy: null, paid: false,
      payHours: 12, slotId: 's1', items, itemCount: 2, surname: '王小明', title: '老師', lang: 'zh-Hant', pushEnabled: false, createdBy: staffUid, createdAt: ts(), updatedAt: ts() });
  });
  return orderRef.id;
}
const now = Date.now();
// ===== 定時開放預購 =====
await seed({ orderMode: 'off', presaleStartAt: now - H });
await expect('平台關閉＋開始時間已到：顧客預購', true, () => submit('presale'));
await expect('平台關閉＋開始時間已到：一般預點 A(應失敗)', false, () => submit('preorder'));
await seed({ orderMode: 'off', presaleStartAt: now + H });
await expect('開始時間還沒到：顧客預購(應失敗)', false, () => submit('presale'));
await seed({ orderMode: 'off', presaleStartAt: now - 2 * H, presaleEndAt: now - H });
await expect('結束時間已過：顧客預購(應失敗)', false, () => submit('presale'));
await seed({ orderMode: 'presale', presaleEndAt: now - H });
await expect('手動預購＋結束時間已過：顧客預購(應失敗)', false, () => submit('presale'));
await seed({ orderMode: 'presale', presaleEndAt: now + H });
await expect('手動預購＋結束時間未到：顧客預購', true, () => submit('presale'));
await seed({ orderMode: 'open', acceptingPreorders: true, presaleStartAt: now + H });
await expect('點餐中＋預購開始時間未到：一般預點 A', true, () => submit('preorder', 10));
await seed({ orderMode: 'open', acceptingPreorders: true, presaleStartAt: now - H });
await expect('點餐中＋預購開始時間已到：一般預點 A(應失敗)', false, () => submit('preorder'));
await seed({ orderMode: 'open', acceptingPreorders: true });
await expect('沒有定時設定：一般預點 A(10 行)', true, () => submit('preorder', 10));
// ===== 現場預購不受平台模式限制 =====
await seed({ orderMode: 'off' });
let onsite;
await expect('平台關閉：攤位主管現場建立預購單', true, async () => { onsite = await submitOnsite('mg'); });
await expect('平台關閉：顧客預購(應失敗)', false, () => submit('presale'));
// ===== 選項已售數量 =====
await expect('店員更新選項已售數量', true, () => env.authenticatedContext('st').firestore().doc('items/i0').update({ choiceSold: { 'g0:c1': 3 }, soldCount: 2, updatedAt: ts() }));
await expect('店員修改選項設定(應失敗)', false, () => env.authenticatedContext('st').firestore().doc('items/i0').update({ optionGroups: [], updatedAt: ts() }));
await expect('預購主管更新選項已售數量', true, () => env.authenticatedContext('pm').firestore().doc('items/i0').update({ choiceSold: { 'g0:c1': 4 }, updatedAt: ts() }));
await expect('預購主管更新品項已售數量(應失敗)', false, () => env.authenticatedContext('pm').firestore().doc('items/i0').update({ soldCount: 9, updatedAt: ts() }));
// ===== 攤位修改訂單 =====
await expect('店員修改未付款預購單的明細', true, () => env.authenticatedContext('st').firestore().doc(`orders/${onsite}`).update({ items: [{ itemId: 'i1', qty: 1, option: null }], itemCount: 1, totalChanged: true, editedAt: Date.now(), updatedAt: ts() }));
await expect('店員修改未付款預購單時順便接單(應失敗)', false, () => env.authenticatedContext('st').firestore().doc(`orders/${onsite}`).update({ status: 'accepted', items: [], updatedAt: ts() }));
await expect('店員更新預購統計(修改已付款預購單時)', true, () => env.authenticatedContext('st').firestore().doc('presaleStats/main').set({ slots: {}, sold: { i1: 1 }, updatedAt: ts() }));
await seed({ orderMode: 'open', acceptingPreorders: true });
let aId;
await expect('一般預點 A(給修改測試)', true, async () => { aId = await submit('preorder', 2); });
await expect('店員修改等待接單的 A 單明細', true, () => env.authenticatedContext('st').firestore().doc(`orders/${aId}`).update({ items: [{ itemId: 'i2', qty: 3, option: null }], itemCount: 3, totalChanged: true, editedAt: Date.now(), updatedAt: ts() }));
await expect('顧客自己修改明細(應失敗)', false, () => env.authenticatedContext('c999').firestore().doc(`orders/${aId}`).update({ items: [], updatedAt: ts() }));
console.log(out.join('\n'));
await env.cleanup();
