// 預購(C 單)安全規則測試：顧客送出、預購主管標示付款／退回、店員權限、逾時作廢後電話可再用
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-tsiok',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const ts = () => firebase.firestore.FieldValue.serverTimestamp();
const del = () => firebase.firestore.FieldValue.delete();
const out = [];
const log = (label, ok, extra = '') => out.push(`[${label}] ${ok}${extra ? ' ' + extra : ''}`);
async function expect(label, shouldPass, fn) {
  try { await fn(); log(label, shouldPass ? '通過' : '錯誤：應被擋下卻成功'); }
  catch (e) { log(label, shouldPass ? `錯誤：${String(e.message).slice(0, 160)}` : '正確擋下'); }
}

async function seed(mode = 'presale') {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('settings/app').set({ acceptingPreorders: mode === 'open', orderMode: mode, maxItemsPerOrder: 10, presalePayHours: 12,
      presaleSlots: [{ id: 's1', date: '2026-10-24', start: '12:00', end: '', cap: 1 }] });
    await db.doc('counters/C').set({ value: 0, lastOrderId: null });
    await db.doc('counters/A').set({ value: 0, lastOrderId: null });
    for (let i = 0; i < 10; i++) await db.doc(`items/i${i}`).set({ name: `品項${i}`, price: 10, active: true, soldOut: false, soldCount: 0 });
    await db.doc('users/pm').set({ role: 'presale', disabled: false });
    await db.doc('users/st').set({ role: 'staff', disabled: false });
  });
}

async function submit(uid, phone, { type = 'presale', lines = 8, slotId = 's1', title = '老師', name = '林敏君', payHours = 12 } = {}) {
  const db = env.authenticatedContext(uid).firestore();
  await db.doc(`sessions/${uid}`).set({ token: 'a'.repeat(32), used: false, orderId: null, updatedAt: ts() });
  const orderRef = db.collection('orders').doc();
  const C = type === 'presale' ? 'C' : 'A';
  const items = Array.from({ length: lines }, (_, i) => ({ itemId: `i${i}`, qty: 1, option: '選項文字'.repeat(3), sel: ['g0:c1'] }));
  await db.runTransaction(async (tx) => {
    const c = await tx.get(db.doc(`counters/${C}`));
    await tx.get(db.doc(`sessions/${uid}`));
    const seq = (c.exists ? c.data().value : 0) + 1;
    const no = C + String(seq).padStart(3, '0');
    tx.set(db.doc(`counters/${C}`), { value: seq, lastOrderId: orderRef.id });
    const base = { type, seq, no, status: 'pending', uid, items, itemCount: lines, surname: name, title, lang: 'zh-Hant', pushEnabled: false, createdAt: ts(), updatedAt: ts() };
    tx.set(orderRef, type === 'presale' ? { ...base, paid: false, payHours, slotId } : { ...base, subPref: 'remove' });
    tx.set(db.doc(`contacts/${orderRef.id}`), { orderId: orderRef.id, surname: name, phone, consentNotify: true, consentText: '同意', consentAt: ts(), createdAt: ts() });
    tx.set(db.doc(`activePhones/${phone}`), { uid, orderId: orderRef.id, updatedAt: ts() });
    tx.update(db.doc(`sessions/${uid}`), { used: true, orderId: orderRef.id, updatedAt: ts() });
    tx.set(db.doc(`lookups/${no}_${phone}`), { orderId: orderRef.id, createdAt: ts() });
  });
  return orderRef.id;
}

// 與網站 markPresalePaid 相同的寫入
async function markPaid(uid, id) {
  const db = env.authenticatedContext(uid).firestore();
  await db.runTransaction(async (tx) => {
    const o = (await tx.get(db.doc(`orders/${id}`))).data();
    await tx.get(db.doc('settings/app'));
    const st = await tx.get(db.doc('presaleStats/main'));
    const stats = st.exists ? st.data() : { slots: {}, sold: {} };
    for (const l of o.items) await tx.get(db.doc(`items/${l.itemId}`));
    const sold = { ...stats.sold };
    for (const l of o.items) sold[l.itemId] = (sold[l.itemId] || 0) + l.qty;
    tx.set(db.doc('presaleStats/main'), { slots: { ...stats.slots, [o.slotId]: (stats.slots[o.slotId] || 0) + 1 }, sold, updatedAt: ts() });
    tx.update(db.doc(`orders/${id}`), { status: 'accepted', paid: true, paidAt: ts(), lines: o.items.map((l) => ({ ...l, name: 'x', price: 10, subtotal: 10 })), total: o.items.length * 10, acceptedAt: ts(), establishedAt: ts(), updatedAt: ts() });
  });
}
async function markUnpaid(uid, id, hours = 24) {
  const db = env.authenticatedContext(uid).firestore();
  await db.runTransaction(async (tx) => {
    const o = (await tx.get(db.doc(`orders/${id}`))).data();
    const st = await tx.get(db.doc('presaleStats/main'));
    const stats = st.data();
    tx.set(db.doc('presaleStats/main'), { slots: { ...stats.slots, [o.slotId]: Math.max(0, (stats.slots[o.slotId] || 0) - 1) }, sold: {}, updatedAt: ts() });
    tx.update(db.doc(`orders/${id}`), { status: 'pending', paid: false, payFrom: ts(), payHours: hours, paidAt: del(), lines: del(), total: del(), acceptedAt: del(), establishedAt: del(), updatedAt: ts() });
  });
}

await seed();
let id;
await expect('顧客送出預購單(8 行明細)', true, async () => { id = await submit('cust1', '0911000001'); });
await expect('顧客送出預購單：全名只有 1 字(應失敗)', false, () => submit('cust2', '0911000002', { name: '林' }));
await expect('顧客送出預購單：稱謂先生(應失敗)', false, () => submit('cust3', '0911000003', { title: '先生' }));
await expect('顧客送出預購單：付款期限與設定不同(應失敗)', false, () => submit('cust4', '0911000004', { payHours: 48 }));
await expect('預購模式下送出一般預點 A(應失敗)', false, () => submit('cust5', '0911000005', { type: 'preorder', title: '先生' }));
await expect('店員直接接單未付款的預購單(應失敗)', false, () => env.authenticatedContext('st').firestore().doc(`orders/${id}`).update({ status: 'accepted', updatedAt: ts() }));
await expect('店員讀取預購單清單', true, () => env.authenticatedContext('st').firestore().collection('orders').where('type', '==', 'presale').get());
await expect('預購主管讀取預購單清單', true, () => env.authenticatedContext('pm').firestore().collection('orders').where('type', '==', 'presale').get());
await expect('預購主管讀取全部訂單(應失敗)', false, () => env.authenticatedContext('pm').firestore().collection('orders').get());
await expect('預購主管讀取聯絡資料', true, () => env.authenticatedContext('pm').firestore().doc(`contacts/${id}`).get());
await expect('預購主管標示已付款(8 行明細)', true, () => markPaid('pm', id));
await expect('店員把已付款的預購單完成通知取餐', true, () => env.authenticatedContext('st').firestore().doc(`orders/${id}`).update({ status: 'ready', readyAt: ts(), updatedAt: ts() }));
await expect('店員退回可取餐 → 已接單', true, () => env.authenticatedContext('st').firestore().doc(`orders/${id}`).update({ status: 'accepted', readyAt: null, updatedAt: ts() }));
await expect('店員把預購單改成未付款(應失敗)', false, () => env.authenticatedContext('st').firestore().doc(`orders/${id}`).update({ status: 'pending', paid: false, updatedAt: ts() }));
await expect('預購主管退回未付款(重新給 24 小時)', true, () => markUnpaid('pm', id, 24));
await expect('預購主管修改付款期限設定', true, () => env.authenticatedContext('pm').firestore().doc('settings/app').update({ presalePayHours: 24, updatedAt: ts() }));
await expect('預購主管切換平台模式(應失敗)', false, () => env.authenticatedContext('pm').firestore().doc('settings/app').update({ orderMode: 'open', updatedAt: ts() }));
await expect('店員切換平台模式(應失敗)', false, () => env.authenticatedContext('st').firestore().doc('settings/app').update({ orderMode: 'open', acceptingPreorders: true, updatedAt: ts() }));
// 逾時作廢：付款期限已過，同一支電話可以再送出
await env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(`orders/${id}`).update({ payFrom: firebase.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600000) });
  await ctx.firestore().doc('settings/app').update({ presalePayHours: 12 });
});
await expect('付款期限已過，同一支電話再送出預購單', true, () => submit('cust1', '0911000001', { lines: 2 }));
// 一般點餐模式：A 單 10 行仍可送出
await seed('open');
await expect('點餐模式：一般預點 A(10 行明細)', true, () => submit('cust9', '0911000009', { type: 'preorder', lines: 10, title: '先生', name: '王' }));
await expect('點餐模式下送出預購單(應失敗)', false, () => submit('cust8', '0911000008'));
console.log(out.join('\n'));
await env.cleanup();
