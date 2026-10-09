// 用網站實際的程式碼(main 分支，也就是正式網站)在模擬器上送出一次預點，記錄被擋下的原因
import { chromium } from 'playwright';
const PROD = 'https://firestore.googleapis.com/v1/projects/tsiok-ai-be/databases/(default)/documents';
const EMU = 'http://127.0.0.1:8080/v1/projects/demo-tsiok/databases/(default)/documents';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const log = (...a) => console.log('[real]', ...a);

async function put(path, fields) {
  const r = await fetch(`${EMU}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) log('seed fail', path, r.status);
}
// 複製正式資料庫的公開資料(設定、品項)
const s = await (await fetch(`${PROD}/settings/app`)).json();
await put('settings/app', s.fields);
const items = await (await fetch(`${PROD}/items?pageSize=100`)).json();
let pick = null;
for (const d of items.documents || []) {
  const id = d.name.split('/').pop();
  await put(`items/${id}`, d.fields);
  const f = d.fields;
  const noOpt = !f.optionGroups && !f.options;
  if (!pick && f.active?.booleanValue !== false && f.soldOut?.booleanValue !== true && noOpt) pick = id;
}
log('items', (items.documents || []).length, 'pick', pick);
await put('counters/A', { value: { integerValue: '0' }, lastOrderId: { nullValue: null } });
await put('orders/PpXRKMzZmfWgMQlS3YXm', { type: { stringValue: 'preorder' }, status: { stringValue: 'picked' }, seq: { integerValue: '1' }, no: { stringValue: 'A001' } });
await put('lookups/A001_0900000000', { orderId: { stringValue: 'PpXRKMzZmfWgMQlS3YXm' }, createdAt: { timestampValue: '2026-10-08T03:18:36.663Z' } });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('console', (m) => { if (/RULES_ERR|error/i.test(m.text())) log('console', m.text().slice(0, 600)); });
page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 300)));
// 只改連線目標：專案改成模擬器、連到本機模擬器；其他程式碼與正式網站完全相同
await page.route('**/js/api/firebase.js', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  body = body.replace('const app = initializeApp(CONFIG.firebase);', "const app = initializeApp({ ...CONFIG.firebase, projectId: 'demo-tsiok' });");
  body = body.replace('// ===== 共用工具 =====', `{
  const { connectAuthEmulator } = await import(\`\${SDK}/firebase-auth.js\`);
  const { connectFirestoreEmulator } = await import(\`\${SDK}/firebase-firestore.js\`);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
// ===== 共用工具 =====`);
  body = body.replace("if (err?.code === 'permission-denied') {", "console.log('RULES_ERR', err?.code, err?.message); if (err?.code === 'permission-denied') {");
  await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript' } });
});
const B = 'http://127.0.0.1:8000/';
await page.goto(B + 'index.html');
await page.waitForSelector('#start-btn:not([hidden])', { timeout: 30000 });
await page.click('#start-btn');
await page.waitForURL(/order\.html\?t=/, { timeout: 30000 });
await page.evaluate((id) => localStorage.setItem('tab-cart', JSON.stringify({ lines: [{ itemId: id, sel: [], qty: 1 }] })), pick);
await page.reload();
await page.waitForTimeout(3000);
await page.evaluate(() => { location.hash = '#info'; });
await page.waitForTimeout(1500);
await page.check('#sub-box input[value=remove]', { force: true });
await page.fill('#checkout-form [name=surname]', '王');
await page.check('[name=title][value="先生"]', { force: true });
await page.fill('#checkout-form [name=phone]', '0900000000');
await page.check('#checkout-form [name=consent]', { force: true });
await page.click('#submit-btn');
await page.waitForTimeout(6000);
log('url', page.url());
log('form-error', (await page.locator('#form-error').innerText().catch(() => '')).replace(/\n/g, ' '));
await browser.close();
