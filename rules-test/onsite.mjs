// 用 be27 的網站程式碼，在模擬器上以攤位主管身分「現場建立預購單」，記錄實際的錯誤
import { chromium } from 'playwright';
const PROD = 'https://firestore.googleapis.com/v1/projects/tsiok-ai-be/databases/(default)/documents';
const EMU = 'http://127.0.0.1:8080/v1/projects/demo-tsiok/databases/(default)/documents';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const log = (...a) => console.log('[onsite]', ...a);
async function put(path, fields) {
  const r = await fetch(`${EMU}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) log('seed fail', path, r.status, (await r.text()).slice(0, 200));
}
const s = await (await fetch(`${PROD}/settings/app`)).json();
const fields = { ...s.fields,
  orderMode: { stringValue: 'presale' }, acceptingPreorders: { booleanValue: false },
  presaleClasses: { arrayValue: { values: [{ stringValue: '901' }] } },
  presaleSlots: { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 'sx' }, date: { stringValue: '2026-10-31' }, start: { stringValue: '10:00' }, end: { stringValue: '' }, cap: { nullValue: null } } } }] } } };
await put('settings/app', fields);
const items = await (await fetch(`${PROD}/items?pageSize=100`)).json();
let pick = null;
for (const d of items.documents || []) {
  const id = d.name.split('/').pop();
  await put(`items/${id}`, d.fields);
  const f = d.fields;
  const groups = f.optionGroups?.arrayValue?.values || [];
  if (!pick && f.active?.booleanValue !== false && f.soldOut?.booleanValue !== true && !groups.length && f.showPresale?.booleanValue !== false) pick = id;
}
log('items', (items.documents || []).length, 'pick', pick);
// 攤位主管帳號(驗證模擬器)
const su = await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'mgr@tsiokaibe.example.com', password: 'mgr123456', returnSecureToken: true }),
})).json();
log('signup', su.localId ? 'ok' : JSON.stringify(su).slice(0, 200));
await put(`users/${su.localId}`, { role: { stringValue: 'manager' }, disabled: { booleanValue: false }, username: { stringValue: 'mgr' }, displayName: { stringValue: '主管' } });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error' || /ERR/.test(m.text())) log('console', m.type(), m.text().slice(0, 800)); });
page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 400)));
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
  body = body.replace('function mapError(err) {', "function mapError(err) { console.log('RAW_ERR', err?.code, err?.name, String(err?.message || err).slice(0, 600), String(err?.stack || '').slice(0, 400));");
  await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript' } });
});
process.on('unhandledRejection', (e) => { log('script error', String(e).slice(0, 300)); process.exit(0); });
const B = 'http://127.0.0.1:8001/';
await page.goto(B + 'login.html');
await page.waitForTimeout(2000);
await page.fill('#login-form input:not([type=password])', 'mgr');
await page.fill('#login-form input[type=password]', 'mgr123456');
await page.click('#login-form button[type=submit]');
await page.waitForTimeout(3000);
await page.goto(B + 'stall.html');
await page.waitForTimeout(4000);
await page.click('.tab[data-tab=pos]');
await page.waitForTimeout(500);
log('presale btn', await page.locator('#pos-form [data-mode=presale]').isVisible());
await page.click('#pos-form [data-mode=presale]');
await page.click(`[data-pos-add="${pick}"]`);
await page.waitForTimeout(300);
await page.fill('[name=pFullName]', '王小明');
await page.locator('#pos-ptitle label', { hasText: '老師' }).click();
await page.selectOption('[name=pSlot]', 'sx');
for (const phone of ['', '0955000111']) {
  await page.fill('[name=pPhone]', phone);
  if (phone) { await page.click(`[data-pos-add="${pick}"]`); await page.waitForTimeout(300); await page.fill('[name=pFullName]', '王小明'); await page.locator('#pos-ptitle label', { hasText: '老師' }).click(); await page.selectOption('[name=pSlot]', 'sx'); await page.fill('[name=pPhone]', phone); }
  await page.click('#pos-submit');
  await page.waitForTimeout(4000);
  const err = await page.locator('#pos-error').isVisible() ? await page.locator('#pos-error').innerText() : '';
  const dlg = await page.locator('dialog[open]').count() ? (await page.locator('dialog[open]').innerText()).replace(/\n/g, ' ').slice(0, 80) : '';
  log(phone ? '有電話' : '無電話', err ? `錯誤 ${err}` : `成功 ${dlg}`);
  if (dlg) await page.click('dialog[open] button[value=ok]');
}
await browser.close();
