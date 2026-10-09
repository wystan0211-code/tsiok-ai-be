// 讀取正式資料庫中與送出預點有關的文件(只讀不寫)，輸出欄位型別
const KEY = 'AIzaSyC-PgGics-Z0R8pXChaWL_xx9VgQ5lhJKI';
const BASE = 'https://firestore.googleapis.com/v1/projects/tsiok-ai-be/databases/(default)/documents';
const out = [];
const brief = (doc) => doc.fields ? Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => {
  const [type, val] = Object.entries(v)[0];
  return [k, `${type}:${typeof val === 'object' ? JSON.stringify(val).slice(0, 60) : String(val).slice(0, 60)}`];
})) : doc;
async function get(path, token) {
  const r = await fetch(`${BASE}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: brief(await r.json()) };
}
out.push(['settings/app', await get('settings/app')]);
// 以匿名身分登入(與顧客相同)，讀取需要登入的計數器
const sign = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
})).json();
out.push(['anon', sign.idToken ? 'ok' : JSON.stringify(sign).slice(0, 200)]);
out.push(['counters/A', await get('counters/A', sign.idToken)]);
out.push(['lookups/A001_0900000000', await get('lookups/A001_0900000000', sign.idToken)]);
console.log(out.map(([k, v]) => `[${k}] ${JSON.stringify(v)}`).join('\n'));
