// 用 Firestore 官方模擬器重現顧客送出預點的交易，找出被安全規則擋下的那一筆與行數
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const ADMIN = 'faA2Ez0SF4Ue84HdflQXy8qQhxK2';
const env = await initializeTestEnvironment({
  projectId: 'demo-tsiok',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
const ts = () => firebase.firestore.FieldValue.serverTimestamp();

// 用模擬器 REST(owner 權限)寫入指定型別的欄位，例如小數 0.0
async function restSet(path, fields) {
  const url = `http://127.0.0.1:8080/v1/projects/demo-tsiok/databases/(default)/documents/${path}`;
  const r = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`REST ${r.status} ${await r.text()}`);
}

async function seed({ lookupExists = false, uid, staffRole = null, counterDouble = false, maxDouble = false, settingsExtra = null }) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('settings/app').set({ acceptingPreorders: true, maxItemsPerOrder: 10 });
    await db.doc('counters/A').set({ value: 0, lastOrderId: 'oldOrder' });
    await db.doc('items/cake').set({ name: '雞蛋糕', price: 30, active: true, soldOut: false, soldCount: 0 });
    await db.doc('orders/oldOrder').set({ type: 'preorder', status: 'picked', uid: 'someone', seq: 1, no: 'A001' });
    if (lookupExists) await db.doc('lookups/A001_0900000000').set({ orderId: 'oldOrder', createdAt: new Date() });
    if (staffRole) await db.doc(`users/${uid}`).set({ role: staffRole, disabled: false });
  });
  if (counterDouble) await restSet('counters/A', { value: { doubleValue: 0 }, lastOrderId: { stringValue: 'oldOrder' } });
  if (maxDouble) await restSet('settings/app', { acceptingPreorders: { booleanValue: true }, maxItemsPerOrder: { doubleValue: 10 } });
}

// 與 js/api/firebase.js 的 startSession、submitPreorder 相同的寫入
async function run(label, { uid = 'cust1', lookupExists = false, staffRole = null, subPref = 'remove', title = '先生', lang = 'zh-Hant', counterDouble = false, maxDouble = false, items = null } = {}) {
  await seed({ lookupExists, uid, staffRole, counterDouble, maxDouble });
  const db = env.authenticatedContext(uid).firestore();
  const phone = '0900000000';
  try {
    await db.doc(`sessions/${uid}`).set({ token: 'a'.repeat(32), used: false, orderId: null, updatedAt: ts() });
  } catch (e) { console.log(`[${label}] 建立點餐連結失敗：`, e.message); return; }
  const orderRef = db.collection('orders').doc();
  try {
    await db.runTransaction(async (tx) => {
      const c = await tx.get(db.doc('counters/A'));
      const s = await tx.get(db.doc(`sessions/${uid}`));
      await tx.get(db.doc('items/cake'));
      if (!s.exists || s.data().used) throw new Error('session-invalid');
      const seq = (c.exists ? c.data().value : 0) + 1;
      const no = 'A' + String(seq).padStart(3, '0');
      tx.set(db.doc('counters/A'), { value: seq, lastOrderId: orderRef.id });
      tx.set(orderRef, {
        type: 'preorder', seq, no, status: 'pending', uid,
        items: items || [{ itemId: 'cake', qty: 1, option: null }], itemCount: (items || [{ qty: 1 }]).reduce((a, l) => a + l.qty, 0), surname: '王', title, lang, pushEnabled: false, subPref,
        createdAt: ts(), updatedAt: ts(),
      });
      tx.set(db.doc(`contacts/${orderRef.id}`), {
        orderId: orderRef.id, surname: '王', phone, consentNotify: true, consentText: '我同意攤位使用我填寫的姓氏與電話，於餐點完成時通知我取餐。',
        consentAt: ts(), createdAt: ts(),
      });
      tx.set(db.doc(`activePhones/${phone}`), { uid, orderId: orderRef.id, updatedAt: ts() });
      tx.update(db.doc(`sessions/${uid}`), { used: true, orderId: orderRef.id, updatedAt: ts() });
      tx.set(db.doc(`lookups/${no}_${phone}`), { orderId: orderRef.id, createdAt: ts() });
    });
    console.log(`[${label}] 成功`);
  } catch (e) {
    console.log(`[${label}] 失敗：`, e.message);
  }
}

await run('一般顧客');
await run('一般顧客＋查詢紀錄已存在', { lookupExists: true });
await run('管理員帳號登入中', { uid: ADMIN });
await run('店員帳號登入中', { uid: 'staff1', staffRole: 'staff' });
await run('計數器數值為小數 0.0', { counterDouble: true });
await run('數量上限為小數 10.0', { maxDouble: true });
await run('多行明細含選項', { items: [{ itemId: 'cake', qty: 2, option: '糖粉', sel: ['g0:c1'] }, { itemId: 'cake', qty: 1, option: null }] });
await run('10 行明細含選項', { items: Array.from({ length: 10 }, (_, i) => ({ itemId: 'cake', qty: 1, option: '糖粉'.repeat(i + 1), sel: ['g0:c1', 'g1:c2'] })) });
await run('不允許：明細有多餘欄位(應失敗)', { items: [{ itemId: 'cake', qty: 1, option: null, price: 0 }] });
await run('不允許：數量 0(應失敗)', { items: [{ itemId: 'cake', qty: 0, option: null }] });
await env.cleanup();
