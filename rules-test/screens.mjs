// 顧客顯示頁(screens/{配對碼})安全規則測試
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
  catch (e) { out.push(`[${label}] ${shouldPass ? `錯誤：${String(e.message).slice(0, 120)}` : '正確擋下'}`); }
}
await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('users/st').set({ role: 'staff', disabled: false }); });
const staff = env.authenticatedContext('st').firestore();
const anon = env.unauthenticatedContext().firestore();
const base = { ownerUid: 'st', state: 'idle', lines: [], total: 0, count: 0, lang: 'zh-Hant', updatedAt: ts() };
await expect('店員建立配對碼', true, () => staff.doc('screens/123456').set(base));
await expect('配對碼不是 6 位數字(應失敗)', false, () => staff.doc('screens/12ab56').set(base));
await expect('未登入的顧客螢幕讀取', true, () => anon.doc('screens/123456').get());
await expect('未登入的顧客螢幕列出全部配對碼(應失敗)', false, () => anon.collection('screens').get());
await expect('顧客螢幕回報我還在', true, () => anon.doc('screens/123456').update({ seenAt: ts() }));
await expect('顧客螢幕修改明細(應失敗)', false, () => anon.doc('screens/123456').update({ total: 999, seenAt: ts() }));
await expect('未登入建立配對碼(應失敗)', false, () => anon.doc('screens/654321').set(base));
await expect('店員更新明細', true, () => staff.doc('screens/123456').update({ state: 'cart', lines: [{ key: 'a', name: '雞蛋糕', option: '', qty: 2, subtotal: 100 }], total: 100, count: 2, lang: 'en', updatedAt: ts() }));
await expect('店員寫入結帳畫面', true, () => staff.doc('screens/123456').update({ state: 'done', lines: [], total: 0, count: 0, done: { no: 'B001', total: 100, url: 'https://x', at: Date.now() }, updatedAt: ts() }));
await expect('店員解除連線', true, () => staff.doc('screens/123456').delete());
console.log(out.join('\n'));
await env.cleanup();
