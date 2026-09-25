/**
 * 九愛！買 Apps Script 後端(免費)
 *
 * 功能
 * 1. syncToSheet：每分鐘把 Firestore 有變動的訂單同步到試算表「訂單」工作表(單向鏡像)
 * 2. doPost push：店員按「完成」或傳訊息時，透過 Firebase Cloud Messaging 推播給顧客
 * 3. doPost createAccount / updateAccount / deleteAccount：管理員管理員工帳號
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
  '送出時間', '確立時間', '可取餐時間', '取餐時間', '拒絕原因', '備註', '已刪除', '最後更新'];
var TYPE_LABEL = { preorder: '預點', walkin: '現場', manual: '手動' };
var STATUS_LABEL = { pending: '等待接單', accepted: '製作中', ready: '可取餐', picked: '已取餐', rejected: '已拒絕', cancelled: '已取消' };
var TIME_ZONE = 'Asia/Taipei';

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
  return sheet;
}

function fmtTime_(d) {
  return d ? Utilities.formatDate(d, TIME_ZONE, 'yyyy/MM/dd HH:mm:ss') : '';
}

function toRow_(id, o, phone, itemNames) {
  var lines = (o.lines && o.lines.length) ? o.lines : (o.items || []);
  var summary = lines.map(function (l) {
    var name = l.name || itemNames[l.itemId] || l.itemId;
    return name + (l.option ? '(' + l.option + ')' : '') + '×' + l.qty;
  }).join('、');
  return [
    id, o.no || '', TYPE_LABEL[o.type] || o.type || '', STATUS_LABEL[o.status] || o.status || '',
    o.surname || '', phone || '', summary, o.itemCount || '', o.total != null ? o.total : '',
    o.payment || '', fmtTime_(o.createdAt), fmtTime_(o.establishedAt), fmtTime_(o.readyAt),
    fmtTime_(o.pickedAt), o.rejectReason || '', o.note || '', o.deleted ? '是' : '', fmtTime_(o.updatedAt),
  ];
}

// 每分鐘執行：只讀取上次同步後有變動的訂單，節省 Firestore 免費額度
function syncToSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
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
      var row = toRow_(id, o, phone, itemNames || {});
      if (hit) sheet.getRange(hit.row, 1, 1, row.length).setValues([row]);
      else {
        newRows.push(row);
        index[id] = { row: -1, phone: phone };
      }
    });
    if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, HEADERS.length).setValues(newRows);

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
    else throw codeError_('invalid', '未知的動作');
  } catch (err) {
    out = { ok: false, code: err.code || 'unknown', error: String(err.message || err) };
  }
  return json_(out);
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

  var title = '九愛！買';
  var body = '';
  if (req.kind === 'ready') {
    title = '餐點完成了';
    body = '訂單 ' + order.no + ' 可以取餐了，請到攤位出示編號。';
  } else if (req.kind === 'rejected') {
    title = '訂單未成立';
    body = '訂單 ' + order.no + ' 未被接受' + (req.text ? '：' + req.text : '') + '。歡迎直接到攤位點餐。';
  } else {
    title = '攤位訊息';
    body = String(req.text || '').slice(0, 120);
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

// ===== 帳號管理(Identity Toolkit 管理 API) =====
function authUrl_(suffix) {
  return 'https://identitytoolkit.googleapis.com/v1/projects/' + prop_('PROJECT_ID') + '/accounts' + (suffix || '');
}

function validateRole_(role) {
  if (['staff', 'manager'].indexOf(role) < 0) throw codeError_('invalid', '權限只能是店員或攤位主管');
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
