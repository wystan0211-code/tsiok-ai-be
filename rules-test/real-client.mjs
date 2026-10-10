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
let pickSel = [];
// Firestore REST 格式轉成一般物件
const plain = (v) => {
  if (!v) return v;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  const [t, x] = Object.entries(v)[0];
  return t === 'integerValue' ? Number(x) : t === 'nullValue' ? null : x;
};
for (const d of items.documents || []) {
  const id = d.name.split('/').pop();
  await put(`items/${id}`, d.fields);
  const f = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, plain(v)]));
  if (pick || f.active === false || f.soldOut === true) continue;
  // 必填群組選前幾個未售完的選項(與網站的 groupRule 相同)
  let groups = Array.isArray(f.optionGroups) ? f.optionGroups.filter((g) => g && g.choices?.length) : [];
  if (!groups.length && Array.isArray(f.options) && f.options.length) groups = [{ id: 'g0', kind: 'required-single', choices: f.options.map((n, i) => ({ id: `c${i}` })) }];
  const sel = [];
  let ok = true;
  for (const g of groups) {
    const free = g.choices.filter((c) => !c.soldOut);
    let need = 0;
    if (g.kind === 'required-single') need = 1;
    else if (g.kind === 'required-multi') need = Math.max(1, Math.min(g.choices.length, Number(g.min) || 1));
    if (free.length < need) { ok = false; break; }
    free.slice(0, need).forEach((c) => sel.push(`${g.id}:${c.id}`));
  }
  if (ok) { pick = id; pickSel = sel; }
}
log('items', (items.documents || []).length, 'pick', pick, JSON.stringify(pickSel));
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
process.on('unhandledRejection', (e) => { log('script error', String(e).slice(0, 300)); process.exit(0); });

// 依序在同一個瀏覽器(同一個匿名身分)送出多張預點；每張送出後由攤位標記為已取餐
async function order(round, phone) {
  await page.goto(B + 'index.html');
  await page.waitForTimeout(2500);
  const startVisible = await page.locator('#start-btn:not([hidden])').count();
  if (!startVisible) { log(round, 'start 按鈕沒出現', (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' ')); return null; }
  await page.click('#start-btn');
  await page.waitForURL(/order\.html\?t=/, { timeout: 30000 });
  await page.evaluate(([id, sel]) => localStorage.setItem('tab-cart', JSON.stringify({ lines: [{ itemId: id, sel, qty: 1 }] })), [pick, pickSel]);
  await page.reload();
  await page.waitForTimeout(2500);
  await page.evaluate(() => { location.hash = '#info'; });
  await page.waitForTimeout(1200);
  await page.check('#sub-box input[value=remove]', { force: true });
  await page.fill('#checkout-form [name=surname]', '王');
  await page.check('[name=title][value="先生"]', { force: true });
  await page.fill('#checkout-form [name=phone]', phone);
  await page.check('#checkout-form [name=consent]', { force: true });
  await page.click('#submit-btn');
  await page.waitForTimeout(5000);
  const url = page.url();
  const m = url.match(/track\.html\?o=([^&]+)/);
  log(round, phone, m ? `成功 ${m[1]}` : `失敗 ${(await page.locator('#form-error').innerText().catch(() => '')).replace(/\n/g, ' ')}`);
  return m ? m[1] : null;
}
// 攤位標記已取餐(模擬器 owner 權限)；release=false 時保留電話綁定(模擬舊版沒有解除綁定)
async function picked(orderId, phone, release = true) {
  const r = await fetch(`${EMU}/orders/${orderId}?updateMask.fieldPaths=status`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { status: { stringValue: 'picked' } } }) });
  if (release) await fetch(`${EMU}/activePhones/${phone}`, { method: 'DELETE', headers: H });
  log('picked', orderId, r.status);
}

const o1 = await order('第1張', '0911111111');
if (o1) await picked(o1, '0911111111');
const o2 = await order('第2張(新號碼)', '0922222222');
if (o2) await picked(o2, '0922222222', false);
const o3 = await order('第3張(第1支號碼)', '0911111111');
if (o3) await picked(o3, '0911111111');
const o4 = await order('第4張(綁定未解除的號碼)', '0922222222');
await browser.close();
