// 正式環境測試(使用者已同意)：全新的瀏覽器(新的匿名顧客)在正式網站送出一張測試訂單
import { chromium } from 'playwright';
const SITE = 'https://wystan0211-code.github.io/tsiok-ai-be/';
const PROD = 'https://firestore.googleapis.com/v1/projects/tsiok-ai-be/databases/(default)/documents';
const log = (...a) => console.log('[probe]', ...a);
process.on('unhandledRejection', (e) => { log('script error', String(e).slice(0, 300)); process.exit(0); });
// 選一個上架、未售完的品項，必填群組選前幾個未售完的選項
const plain = (v) => {
  if (!v) return v;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  const [t, x] = Object.entries(v)[0];
  return t === 'integerValue' ? Number(x) : t === 'nullValue' ? null : x;
};
const items = await (await fetch(`${PROD}/items?pageSize=100`)).json();
const LINES = Number(process.env.LINES || 1);
const cands = [];
for (const d of items.documents || []) {
  const f = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, plain(v)]));
  if (f.active === false || f.soldOut === true) continue;
  if (f.stockLimit != null && (f.soldCount || 0) + 2 > f.stockLimit) continue;
  let groups = Array.isArray(f.optionGroups) ? f.optionGroups.filter((g) => g && g.choices?.length) : [];
  if (!groups.length && Array.isArray(f.options) && f.options.length) groups = [{ id: 'g0', kind: 'required-single', choices: f.options.map((n, i) => ({ id: `c${i}` })) }];
  const sel = []; let ok = true;
  for (const g of groups) {
    const free = g.choices.filter((c) => !c.soldOut);
    const need = g.kind === 'required-single' ? 1 : g.kind === 'required-multi' ? Math.max(1, Math.min(g.choices.length, Number(g.min) || 1)) : 0;
    if (free.length < need) { ok = false; break; }
    free.slice(0, need).forEach((c) => sel.push(`${g.id}:${c.id}`));
  }
  if (ok) cands.push({ id: d.name.split('/').pop(), sel, opt: groups.length > 0 });
}
cands.sort((a, b) => Number(b.opt) - Number(a.opt));
const lines = cands.slice(0, LINES).map((c) => ({ itemId: c.id, sel: c.sel, qty: 1 }));
const pick = lines[0]?.itemId; const pickSel = lines[0]?.sel;
log('lines', lines.length, 'withOptions', cands.slice(0, LINES).filter((c) => c.opt).length);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 200)));
await page.goto(SITE + 'index.html');
await page.waitForSelector('#start-btn:not([hidden])', { timeout: 30000 });
await page.click('#start-btn');
await page.waitForURL(/order\.html\?t=/, { timeout: 30000 });
await page.evaluate((ls) => localStorage.setItem('tab-cart', JSON.stringify({ lines: ls })), lines);
await page.reload();
await page.waitForTimeout(3000);
await page.evaluate(() => { location.hash = '#info'; });
await page.waitForTimeout(1500);
await page.check('#sub-box input[value=remove]', { force: true });
await page.fill('#checkout-form [name=surname]', '測試');
await page.check('[name=title][value="其他"]', { force: true });
await page.fill('#checkout-form [name=phone]', process.env.PHONE || '0999999999');
await page.check('#checkout-form [name=consent]', { force: true });
await page.click('#submit-btn');
await page.waitForTimeout(8000);
const m = page.url().match(/track\.html\?o=([^&]+)/);
log(m ? `成功 ${m[1]}` : `失敗 ${(await page.locator('#form-error').innerText().catch(() => '')).replace(/\n/g, ' ')}`);
await browser.close();
