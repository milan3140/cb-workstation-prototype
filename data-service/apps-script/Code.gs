/**
 * ParityDesk — Apps Script 後端(自建帳號 + 分帳號畫線/關注)
 *
 * 不依賴 Google 登入:自己的 email+密碼註冊/登入,後端簽發 HMAC token,
 * 每個請求帶 token 驗證後用 email 當 key 分帳號讀寫 Google Sheet。
 * 免服務帳號金鑰、免租主機。部署見同目錄 README.md。
 *
 * ── Sheet 分頁 ──
 *   users:      A=email | B=salt | C=hash(sha256(pw|salt)) | D=createdAt
 *   drawings:   A=key(email|sid|period) | B=updatedAt | C..F=shapes JSON 分塊
 *   watchlists: A=key(email)            | B=updatedAt | C..F=lists  JSON 分塊
 *
 * ── API(單一 /exec;GET/POST + text/plain 皆免 CORS preflight)──
 *   POST {action:'register', email, password}  → {token, email} | {error}
 *   POST {action:'login',    email, password}  → {token, email} | {error}
 *   GET  ?resource=drawings&sid=&period=&token=   → {shapes, updatedAt}
 *   GET  ?resource=watchlists&token=              → {lists, updatedAt}
 *   POST {resource:'drawings', sid, period, shapes, token}  → {ok}
 *   POST {resource:'watchlists', lists, token}             → {ok}
 *   GET  ?resource=health → {ok}
 */

var SHEET_ID = '1QMKeXQlnG2-QHBWxGgW0VyTjXxA1M_PNiyws4CjZCSo';
var CHUNK = 45000, CHUNK_COLS = 4;
var TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;   // token 30 天

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function tab_(name) { var ss = ss_(); return ss.getSheetByName(name) || ss.insertSheet(name); }

// ── token 密鑰:存 Script Properties,首次自動生成(不寫進原始碼)──
function secret_() {
  var sp = PropertiesService.getScriptProperties();
  var s = sp.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); sp.setProperty('TOKEN_SECRET', s); }
  return s;
}
function b64_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function b64str_(str) { return b64_(Utilities.newBlob(str).getBytes()); }
function hmac_(msg) { return b64_(Utilities.computeHmacSha256Signature(msg, secret_())); }
function sha256_(msg) { return b64_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, msg)); }

function makeToken_(email) {
  var body = email + '|' + (Date.now() + TOKEN_TTL_MS);
  return b64str_(body) + '.' + hmac_(body);
}
function verifyToken_(token) {
  if (!token || token.indexOf('.') < 0) return null;
  try {
    var parts = token.split('.'); var body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    if (hmac_(body) !== parts[1]) return null;                 // 簽章不符
    var seg = body.split('|'); if (Number(seg[1]) < Date.now()) return null;   // 過期
    return seg[0];                                             // email
  } catch (e) { return null; }
}

// ── users 表 ──
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function findUser_(email) {
  var sh = tab_('users'); var last = sh.getLastRow(); if (last < 1) return null;
  var rows = sh.getRange(1, 1, last, 3).getValues();
  for (var i = 0; i < rows.length; i++) if (normEmail_(rows[i][0]) === email) return { row: i + 1, salt: rows[i][1], hash: rows[i][2] };
  return null;
}
function register_(email, pw) {
  email = normEmail_(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'email 格式不正確' };
  if (String(pw || '').length < 6) return { error: '密碼至少 6 碼' };
  if (findUser_(email)) return { error: '此 email 已註冊,請直接登入' };
  var salt = Utilities.getUuid();
  tab_('users').appendRow([email, salt, sha256_(pw + '|' + salt), Date.now()]);
  return { token: makeToken_(email), email: email };
}
function login_(email, pw) {
  email = normEmail_(email);
  var u = findUser_(email);
  if (!u || u.hash !== sha256_(pw + '|' + u.salt)) return { error: 'email 或密碼錯誤' };
  return { token: makeToken_(email), email: email };
}

// ── JSON 分塊存取 ──
function splitJson_(obj) { var s = JSON.stringify(obj), a = []; for (var i = 0; i < s.length; i += CHUNK) a.push(s.slice(i, i + CHUNK)); while (a.length < CHUNK_COLS) a.push(''); return a.slice(0, CHUNK_COLS); }
function joinJson_(cells) { var s = (cells || []).join(''); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
function findRow_(sh, key) { var last = sh.getLastRow(); if (last < 1) return 0; var ks = sh.getRange(1, 1, last, 1).getValues(); for (var i = 0; i < ks.length; i++) if (String(ks[i][0]) === key) return i + 1; return 0; }
function readRecord_(tabName, key) { var sh = tab_(tabName), row = findRow_(sh, key); if (!row) return { data: null, updatedAt: null }; var v = sh.getRange(row, 2, 1, 1 + CHUNK_COLS).getValues()[0]; return { data: joinJson_(v.slice(1)), updatedAt: v[0] || null }; }
function writeRecord_(tabName, key, obj) { var sh = tab_(tabName), row = findRow_(sh, key) || (sh.getLastRow() + 1 || 1); sh.getRange(row, 1, 1, 2 + CHUNK_COLS).setValues([[key, Date.now()].concat(splitJson_(obj))]); }

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.resource === 'health') return json_({ ok: true, service: 'ParityDesk backend' });
    var email = verifyToken_(p.token);
    if (!email) return json_({ error: 'unauthorized' });
    if (p.resource === 'drawings') { var r = readRecord_('drawings', email + '|' + String(p.sid) + '|' + String(p.period)); return json_({ shapes: (r.data && r.data.shapes) || [], updatedAt: r.updatedAt }); }
    if (p.resource === 'watchlists') { var r2 = readRecord_('watchlists', email); return json_({ lists: (r2.data && r2.data.lists) || [], updatedAt: r2.updatedAt }); }
    return json_({ error: 'unknown resource' });
  } catch (err) { return json_({ error: String(err) }); }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) {}
  try {
    if (body.action === 'register') return json_(register_(body.email, body.password));
    if (body.action === 'login') return json_(login_(body.email, body.password));
    var email = verifyToken_(body.token);
    if (!email) return json_({ error: 'unauthorized' });
    if (body.resource === 'drawings') { writeRecord_('drawings', email + '|' + String(body.sid) + '|' + String(body.period), { shapes: Array.isArray(body.shapes) ? body.shapes.slice(0, 500) : [] }); return json_({ ok: true }); }
    if (body.resource === 'watchlists') { writeRecord_('watchlists', email, { lists: Array.isArray(body.lists) ? body.lists.slice(0, 10) : [] }); return json_({ ok: true }); }
    return json_({ error: 'unknown resource' });
  } catch (err) { return json_({ error: String(err) }); }
}
