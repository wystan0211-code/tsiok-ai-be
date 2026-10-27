/**
 * 九愛！買 Apps Script 後端(免費)
 *
 * 功能
 * 1. syncToSheet：每分鐘把 Firestore 有變動的訂單同步到試算表「訂單」工作表(單向鏡像)
 * 2. doPost push：店員按「完成」或傳訊息時，透過 Firebase Cloud Messaging 推播給顧客
 * 3. doPost createAccount / updateAccount / deleteAccount：管理員管理員工帳號
 * 4. doPost translate：把中文翻成英文與日文(使用 Apps Script 內建的 Google 翻譯，免費)
 * 5. 收件匣(超量預點通知)同步到「收件匣」工作表；doPost sync：管理員立即同步(編號歸零前)
 *
 * 指令碼屬性(專案設定 > 指令碼屬性)
 *   SERVICE_ACCOUNT  服務帳戶金鑰 JSON 全文(機密，只放這裡)
 *   PROJECT_ID       Firebase 專案 ID
 *   API_KEY          Firebase 網頁 API 金鑰(與 js/config.js 相同)
 *   ADMIN_UID        管理員 UID(與 js/config.js、firestore.rules 相同)
 *   SITE_URL         網站網址，結尾要有 /，例如 https://帳號.github.io/tsiok-ai-be/
 *   EMAIL_DOMAIN     員工帳號網域，預設 tsiokaibe.example.com(與 js/config.js 相同)
 */

var SHEET_NAME = '訂單';
var HEADERS = ['訂單ID', '訂單編號', '類型', '狀態', '姓氏', '電話', '品項', '件數', '金額', '付款方式',
  '送出時間', '確立時間', '可取餐時間', '取餐時間', '拒絕原因', '備註', '已刪除', '最後更新',
  '付款狀態', '取餐時段', '全名', '班級'];
var TYPE_LABEL = { preorder: '預點', walkin: '現場', presale: '預購', manual: '手動' };
// 預購單(C)的狀態文字與整列底色
var PRESALE_STATUS_LABEL = { pending: '請付款', accepted: '已接單' };
var PRESALE_ROW_COLOR = '#fff1c4';
var STATUS_LABEL = { pending: '等待接單', accepted: '製作中', ready: '可取餐', picked: '已取餐', rejected: '已拒絕', cancelled: '已取消' };
var TIME_ZONE = 'Asia/Taipei';
// 收件匣(超量預點通知)另存一張工作表：每次顧客送出都新增一列
var INBOX_SHEET_NAME = '收件匣';
var INBOX_HEADERS = ['收到時間', '姓名', '電話', '品項', '件數', '第幾次', '顧客ID'];

// ===== 初次設定：在編輯器選擇 setup 後按「執行」一次 =====
function setup() {
  getSheet_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncToSheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncToSheet').timeBased().everyMinutes(1).create();
  getAccessToken_(); // 順便檢查服務帳戶設定是否正確
  Logger.log('設定完成：已建立每分鐘同步的觸發條件');
}

// 需要從頭重新同步時執行(例如試算表被誤刪)
function resyncAll() {
  props_().deleteProperty('LAST_SYNC');
  var sheet = getSheet_();
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  syncToSheet();
}

// ===== 設定與權杖 =====
function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key) {
  var value = props_().getProperty(key);
  if (!value) throw new Error('缺少指令碼屬性：' + key);
  return value;
}

function base64Url_(text) {
  return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

// 用服務帳戶換取 Google API 存取權杖(快取 50 分鐘)
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('access_token');
  if (cached) return cached;
  var sa = JSON.parse(prop_('SERVICE_ACCOUNT'));
  var now = Math.floor(Date.now() / 1000);
  var header = base64Url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = base64Url_(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  var input = header + '.' + claim;
  var signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + signature },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('取得存取權杖失敗：' + res.getContentText());
  var token = JSON.parse(res.getContentText()).access_token;
  cache.put('access_token', token, 3000);
  return token;
}

// 呼叫 Google API；404 回傳 null
function request_(url, method, body) {
  var options = {
    method: method || 'get',
    headers: { Authorization: 'Bearer ' + getAccessToken_() },
    muteHttpExceptions: true,
  };
  if (body !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 404) return null;
  if (code >= 300) {
    var err = new Error('HTTP ' + code + '：' + text);
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ===== Firestore REST =====
function docUrl_(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/databases/(default)/documents' + (path ? '/' + path : '');
}

function decode_(v) {
  if (v === undefined || v === null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode_);
  if ('mapValue' in v) return decodeFields_(v.mapValue.fields || {});
  return null;
}

function decodeFields_(fields) {
  var out = {};
  Object.keys(fields || {}).forEach(function (k) { out[k] = decode_(fields[k]); });
  return out;
}

function encode_(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encode_) } };
  var fields = {};
  Object.keys(x).forEach(function (k) { fields[k] = encode_(x[k]); });
  return { mapValue: { fields: fields } };
}

function getDoc_(path) {
  var doc = request_(docUrl_(path));
  return doc ? decodeFields_(doc.fields) : null;
}

// 只更新指定欄位
function patchDoc_(path, data) {
  var fields = {};
  var mask = Object.keys(data).map(function (k) {
    fields[k] = encode_(data[k]);
    return 'updateMask.fieldPaths=' + encodeURIComponent(k);
  }).join('&');
  return request_(docUrl_(path) + '?' + mask, 'patch', { fields: fields });
}

function deleteDoc_(path) {
  return request_(docUrl_(path), 'delete');
}

// ===== 試算表同步 =====
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('F:F').setNumberFormat('@'); // 電話保留開頭的 0
    sheet.getRange('B:B').setNumberFormat('@');
  }
  // 舊版試算表補上新增的欄位標題
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
  return sheet;
}

// 預購單超過付款期限仍未付款(與網站的 isPresaleVoid 相同)
function presaleVoid_(o) {
  if (o.type !== 'presale' || o.status !== 'pending') return false;
  var from = o.payFrom || o.createdAt;
  return !!from && Date.now() > from.getTime() + (o.payHours || 12) * 3600000;
}

function slotLabel_(slot) {
  if (!slot) return '';
  return (slot.date || '') + ' ' + (slot.start || '') + (slot.end ? '–' + slot.end : '');
}

function fmtTime_(d) {
  return d ? Utilities.formatDate(d, TIME_ZONE, 'yyyy/MM/dd HH:mm:ss') : '';
}

function toRow_(id, o, phone, itemNames, slots) {
  var lines = (o.lines && o.lines.length) ? o.lines : (o.items || []);
  var summary = lines.map(function (l) {
    var name = l.name || itemNames[l.itemId] || l.itemId;
    return name + (l.option ? '(' + l.option + ')' : '') + '×' + l.qty;
  }).join('、');
  var presale = o.type === 'presale';
  var status = STATUS_LABEL[o.status] || o.status || '';
  var payState = '';
  if (presale) {
    if (presaleVoid_(o)) status = '已作廢';
    else if (PRESALE_STATUS_LABEL[o.status]) status = PRESALE_STATUS_LABEL[o.status];
    payState = o.paid ? '已付款' : (presaleVoid_(o) ? '逾時作廢' : '未付款');
  }
  var slot = presale ? (slots || []).filter(function (x) { return x.id === o.slotId; })[0] : null;
  return [
    id, o.no || '', (TYPE_LABEL[o.type] || o.type || '') + (o.onsite ? '(現場)' : ''), status,
    (o.surname || '') + (o.surname ? o.title || '' : ''), phone || '', summary, o.itemCount || '', o.total != null ? o.total : '',
    o.payment || '', fmtTime_(o.createdAt), fmtTime_(o.establishedAt), fmtTime_(o.readyAt),
    fmtTime_(o.pickedAt), o.rejectReason || '', o.note || '', o.deleted ? '是' : '', fmtTime_(o.updatedAt),
    payState, slot ? slotLabel_(slot) : (presale ? (o.slotId || '') : ''), presale ? (o.surname || '') : '',
    o.className || '',
  ];
}

// 收件匣工作表
function getInboxSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INBOX_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INBOX_SHEET_NAME);
    sheet.getRange(1, 1, 1, INBOX_HEADERS.length).setValues([INBOX_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('C:C').setNumberFormat('@'); // 電話保留開頭的 0
  }
  return sheet;
}

// 同步收件匣：只讀取上次同步後顧客又送出的訊息(lastAt 有變動)，每次送出新增一列
function syncInbox_() {
  var last = props_().getProperty('LAST_INBOX_SYNC') || '1970-01-01T00:00:00Z';
  var result = request_(docUrl_('') + ':runQuery', 'post', {
    structuredQuery: {
      from: [{ collectionId: 'inbox' }],
      where: { fieldFilter: { field: { fieldPath: 'lastAt' }, op: 'GREATER_THAN', value: { timestampValue: last } } },
      orderBy: [{ field: { fieldPath: 'lastAt' }, direction: 'ASCENDING' }],
      limit: 300,
    },
  }) || [];
  var docs = result.filter(function (r) { return r.document; }).map(function (r) { return r.document; });
  if (!docs.length) return;
  var rows = docs.map(function (doc) {
    var m = decodeFields_(doc.fields);
    return [fmtTime_(m.lastAt), m.surname || '', m.phone || '', m.summary || '', m.count || '', m.attempts || '', doc.name.split('/').pop()];
  });
  var sheet = getInboxSheet_();
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, INBOX_HEADERS.length).setValues(rows);
  props_().setProperty('LAST_INBOX_SYNC', docs[docs.length - 1].fields.lastAt.timestampValue);
}

// 每分鐘執行：只讀取上次同步後有變動的訂單，節省 Firestore 免費額度
function syncToSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    try {
      syncInbox_();
    } catch (err) {
      Logger.log('收件匣同步失敗：' + err);
    }
    var last = props_().getProperty('LAST_SYNC') || '1970-01-01T00:00:00Z';
    var result = request_(docUrl_('') + ':runQuery', 'post', {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: { fieldFilter: { field: { fieldPath: 'updatedAt' }, op: 'GREATER_THAN', value: { timestampValue: last } } },
        orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' }],
        limit: 300,
      },
    }) || [];
    var docs = result.filter(function (r) { return r.document; }).map(function (r) { return r.document; });
    if (!docs.length) return;

    var sheet = getSheet_();
    var rowCount = Math.max(0, sheet.getLastRow() - 1);
    var existing = rowCount ? sheet.getRange(2, 1, rowCount, 6).getValues() : [];
    var index = {};
    existing.forEach(function (r, i) { index[r[0]] = { row: i + 2, phone: r[5] }; });

    var itemNames = null;
    var newRows = [];
    var newPresale = [];
    // 有預購單時讀取取餐時段設定
    var slots = null;
    if (docs.some(function (d) { return d.fields.type && d.fields.type.stringValue === 'presale'; })) {
      var st = getDoc_('settings/app');
      slots = (st && st.presaleSlots) || [];
    }
    docs.forEach(function (doc) {
      var id = doc.name.split('/').pop();
      var o = decodeFields_(doc.fields);
      var hit = index[id];
      var phone = hit ? hit.phone : '';
      if (!phone && o.type !== 'manual') {
        var contact = getDoc_('contacts/' + id);
        phone = contact ? contact.phone : '';
      }
      if (!(o.lines && o.lines.length) && !itemNames) itemNames = loadItemNames_();
      var row = toRow_(id, o, phone, itemNames || {}, slots);
      if (hit) {
        sheet.getRange(hit.row, 1, 1, row.length).setValues([row]);
        if (o.type === 'presale') sheet.getRange(hit.row, 1, 1, row.length).setBackground(PRESALE_ROW_COLOR);
      } else {
        newRows.push(row);
        newPresale.push(o.type === 'presale');
        index[id] = { row: -1, phone: phone };
      }
    });
    if (newRows.length) {
      var start = sheet.getLastRow() + 1;
      sheet.getRange(start, 1, newRows.length, HEADERS.length).setValues(newRows);
      // 預購單整列淡黃底
      newPresale.forEach(function (isPresale, i) {
        if (isPresale) sheet.getRange(start + i, 1, 1, HEADERS.length).setBackground(PRESALE_ROW_COLOR);
      });
    }

    // 記錄最後一筆的原始時間字串，下次從這之後開始
    props_().setProperty('LAST_SYNC', docs[docs.length - 1].fields.updatedAt.timestampValue);
  } finally {
    lock.releaseLock();
  }
}

function loadItemNames_() {
  var names = {};
  var res = request_(docUrl_('items') + '?pageSize=300');
  ((res && res.documents) || []).forEach(function (d) {
    names[d.name.split('/').pop()] = decodeFields_(d.fields).name;
  });
  return names;
}

// ===== 網頁應用程式入口 =====
function doGet() {
  return json_({ ok: true, message: '九愛！買 Apps Script 運作中' });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var caller = verifyCaller_(req.idToken);
    if (req.action === 'push') out = handlePush_(caller, req);
    else if (req.action === 'createAccount') out = createAccount_(caller, req);
    else if (req.action === 'updateAccount') out = updateAccount_(caller, req);
    else if (req.action === 'deleteAccount') out = deleteAccount_(caller, req);
    else if (req.action === 'translate') out = handleTranslate_(caller, req);
    else if (req.action === 'sync') out = handleSync_(caller);
    else throw codeError_('invalid', '未知的動作');
  } catch (err) {
    out = { ok: false, code: err.code || 'unknown', error: String(err.message || err) };
  }
  return json_(out);
}

// 立即同步到試算表(管理員；編號歸零刪除收件匣前先存檔)
function handleSync_(caller) {
  if (caller.role !== 'admin') throw codeError_('permission', '只有管理員可以執行');
  syncToSheet();
  return { ok: true };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function codeError_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// 驗證呼叫者的 Firebase 身分憑證，回傳 { uid, role }
function verifyCaller_(idToken) {
  if (!idToken) throw codeError_('permission', '缺少身分憑證');
  var res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + prop_('API_KEY'), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw codeError_('permission', '身分驗證失敗，請重新登入');
  var user = JSON.parse(res.getContentText()).users[0];
  if (user.disabled) throw codeError_('permission', '帳號已停用');
  if (user.localId === prop_('ADMIN_UID')) return { uid: user.localId, role: 'admin' };
  var profile = getDoc_('users/' + user.localId);
  if (!profile || profile.disabled) throw codeError_('permission', '沒有權限');
  return { uid: user.localId, role: profile.role };
}

function requireStaff_(caller) {
  if (['staff', 'manager', 'admin'].indexOf(caller.role) < 0) throw codeError_('permission', '沒有權限');
}

function requireAdmin_(caller) {
  if (caller.role !== 'admin') throw codeError_('permission', '只有管理員可以管理帳號');
}

// ===== 推播 =====
function handlePush_(caller, req) {
  requireStaff_(caller);
  var order = getDoc_('orders/' + req.orderId);
  if (!order) throw codeError_('not-found', '找不到訂單');
  var tokenDoc = getDoc_('pushTokens/' + req.orderId);
  if (!tokenDoc || !tokenDoc.token) return { ok: true, sent: false, reason: 'no-token' };

  // 依顧客點餐時選的語言發送；req.text 已由攤位端翻譯成顧客的語言
  var lang = PUSH_TEXT[order.lang] ? order.lang : 'zh-Hant';
  var tx = PUSH_TEXT[lang];
  var title;
  var body;
  if (req.kind === 'ready') {
    title = tx.readyTitle;
    body = tx.readyBody.replace('{no}', order.no);
  } else if (req.kind === 'rejected') {
    title = tx.rejectTitle;
    body = tx.rejectBody.replace('{no}', order.no).replace('{reason}', req.text ? tx.reasonWrap.replace('{r}', req.text) : '');
  } else {
    title = tx.messageTitle;
    body = String(req.text || '').slice(0, 160);
  }

  var siteUrl = prop_('SITE_URL');
  try {
    request_('https://fcm.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/messages:send', 'post', {
      message: {
        token: tokenDoc.token,
        notification: { title: title, body: body },
        webpush: {
          notification: { icon: siteUrl + 'assets/brand/icon-192.png', tag: req.orderId, renotify: true },
          fcm_options: { link: siteUrl + 'track.html?o=' + encodeURIComponent(req.orderId) },
        },
      },
    });
  } catch (err) {
    // token 失效(顧客清除資料或取消通知權限)
    if (String(err.body || '').indexOf('UNREGISTERED') >= 0 || String(err.body || '').indexOf('NOT_FOUND') >= 0) {
      return { ok: true, sent: false, reason: 'token-invalid' };
    }
    throw err;
  }
  return { ok: true, sent: true };
}

// 推播文字(商標「九愛！買」不翻譯)
var PUSH_TEXT = {
  'zh-Hant': {
    readyTitle: '餐點完成了', readyBody: '訂單 {no} 可以取餐了，請到攤位出示編號。',
    rejectTitle: '訂單未成立', rejectBody: '訂單 {no} 未被接受{reason}。歡迎直接到攤位點餐。', reasonWrap: '：{r}',
    messageTitle: '攤位訊息',
  },
  en: {
    readyTitle: 'Your order is ready', readyBody: 'Order {no} is ready. Please show your order number at the stall.',
    rejectTitle: 'Order not accepted', rejectBody: 'Order {no} was not accepted{reason}. You\'re welcome to order at the stall.', reasonWrap: ': {r}',
    messageTitle: 'Message from the stall',
  },
  ja: {
    readyTitle: '料理ができました', readyBody: '注文 {no} をお受け取りいただけます。屋台で注文番号を提示してください。',
    rejectTitle: 'ご注文をお受けできませんでした', rejectBody: '注文 {no} はお受けできませんでした{reason}。屋台で直接ご注文いただけます。', reasonWrap: '（理由：{r}）',
    messageTitle: '屋台からのメッセージ',
  },
};

// ===== 翻譯 =====
// req.texts：中文字串陣列；req.langs：['en', 'ja']；回傳 { results: { en: [...], ja: [...] } }
function handleTranslate_(caller, req) {
  requireStaff_(caller);
  var texts = (req.texts || []).slice(0, 50).map(function (t) { return String(t || '').slice(0, 1000); });
  var langs = (req.langs || ['en', 'ja']).filter(function (l) { return l === 'en' || l === 'ja'; });
  var results = {};
  langs.forEach(function (lang) {
    results[lang] = texts.map(function (t) {
      if (!t.trim()) return '';
      return unescapeHtml_(LanguageApp.translate(t, 'zh-TW', lang));
    });
  });
  return { ok: true, results: results };
}

// 翻譯結果有時會帶 HTML 跳脫字元，還原成一般文字
function unescapeHtml_(s) {
  return String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ===== 帳號管理(Identity Toolkit 管理 API) =====
function authUrl_(suffix) {
  return 'https://identitytoolkit.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/accounts' + (suffix || '');
}

function validateRole_(role) {
  if (['staff', 'manager', 'presale'].indexOf(role) < 0) throw codeError_('invalid', '權限只能是店員、攤位主管或預購主管');
}

function createAccount_(caller, req) {
  requireAdmin_(caller);
  var username = String(req.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw codeError_('invalid', '帳號格式不正確');
  if (String(req.password || '').length < 8) throw codeError_('invalid', '密碼至少 8 個字');
  validateRole_(req.role);
  var email = username + '@' + (props_().getProperty('EMAIL_DOMAIN') || 'tsiokaibe.example.com');
  var created;
  try {
    created = request_(authUrl_(''), 'post', { email: email, password: req.password, displayName: req.displayName || username });
  } catch (err) {
    if (String(err.body || '').indexOf('EMAIL_EXISTS') >= 0) throw codeError_('username-taken', '帳號名稱已被使用');
    throw err;
  }
  var uid = created.localId;
  patchDoc_('users/' + uid, {
    username: username, displayName: req.displayName || username, role: req.role, disabled: false, createdAt: new Date(),
  });
  return { ok: true, uid: uid };
}

function updateAccount_(caller, req) {
  requireAdmin_(caller);
  if (!req.uid || req.uid === prop_('ADMIN_UID')) throw codeError_('permission', '不能在這裡修改管理員帳號');
  var authPatch = { localId: req.uid };
  var docPatch = {};
  if (req.displayName) {
    authPatch.displayName = req.displayName;
    docPatch.displayName = req.displayName;
  }
  if (req.role) {
    validateRole_(req.role);
    docPatch.role = req.role;
  }
  if (typeof req.disabled === 'boolean') {
    authPatch.disableUser = req.disabled;
    docPatch.disabled = req.disabled;
  }
  if (req.password) {
    if (String(req.password).length < 8) throw codeError_('invalid', '密碼至少 8 個字');
    authPatch.password = req.password;
  }
  request_(authUrl_(':update'), 'post', authPatch);
  if (Object.keys(docPatch).length) patchDoc_('users/' + req.uid, docPatch);
  return { ok: true };
}

function deleteAccount_(caller, req) {
  requireAdmin_(caller);
  if (!req.uid || req.uid === prop_('ADMIN_UID')) throw codeError_('permission', '不能刪除管理員帳號');
  request_(authUrl_(':delete'), 'post', { localId: req.uid });
  deleteDoc_('users/' + req.uid);
  return { ok: true };
}
