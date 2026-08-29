/**
 * CB 工作站原型 — Google Apps Script 共用後端(畫線 + 關注清單)
 *
 * 為什麼用 Apps Script:這張 Sheet 掛在個人 Google 帳號,用 Apps Script 綁它就能讀寫,
 * 免服務帳號金鑰、免租主機、免 GCP 專案。發布成 Web App 後有一個固定 HTTPS 網址,
 * 前端直接打它,大家連同一份 → 畫線 / 關注清單跨裝置、跨使用者同步。
 *
 * 部署見同目錄 README.md。部署後把 /exec 網址填進前端 VITE_SHEET_API_URL。
 *
 * ── 分帳號(per-account):每個使用者的畫線 / 關注各存各的,互相看不到 ──
 *   身分 = Google 帳號 email。前端用 Google 登入拿到 ID token,每個請求帶上;
 *   後端用 Google 的 tokeninfo 端點驗證 token、取出 email 當 member key。
 *   token 無效 / 未帶 → 拒絕(不落到別人的資料上)。
 *
 *   分頁 drawings:   A=key(email|sid|period) | B=updatedAt(ms) | C,D,E,F=shapes JSON 分塊
 *   分頁 watchlists: A=key(email)            | B=updatedAt(ms) | C,D,E,F=lists JSON 分塊
 *   單格上限 5 萬字,故 JSON 切成 ≤4 塊(16 萬字,遠大於 500 shapes 需求)。
 *
 * ── API(單一 /exec 端點,GET 讀、POST 寫;都是「簡單請求」免 CORS preflight)──
 *   GET  ?resource=drawings&sid=<現股代號>&period=<週期>&id_token=<Google ID token>
 *          → {shapes:[...], updatedAt}
 *   GET  ?resource=watchlists&id_token=<...>                → {lists:[...], updatedAt}
 *   POST body(text/plain JSON){resource:'drawings', sid, period, shapes, id_token}  → {ok:true}
 *   POST body(text/plain JSON){resource:'watchlists', lists, id_token}              → {ok:true}
 */

var SHEET_ID = '1QMKeXQlnG2-QHBWxGgW0VyTjXxA1M_PNiyws4CjZCSo';
// 允許的 OAuth Client ID(前端 GIS 用的那個)。部署後填入,驗 token 的 aud 必須等於它。
var ALLOWED_CLIENT_ID = '316755433521-ung84br43co07sv0d1h63c7gihsheni1.apps.googleusercontent.com';     // e.g. '1234-abc.apps.googleusercontent.com'
var CHUNK = 45000;              // 單格字數(<5 萬安全值)
var CHUNK_COLS = 4;            // C,D,E,F

/** 驗 Google token → 回 email(失敗回 null)。相容 access token 與 id token 兩種(前端用 access token)。 */
function verifyEmail_(token) {
  if (!token) return null;
  var eps = [
    'https://oauth2.googleapis.com/tokeninfo?access_token=',
    'https://oauth2.googleapis.com/tokeninfo?id_token=',
  ];
  for (var i = 0; i < eps.length; i++) {
    try {
      var resp = UrlFetchApp.fetch(eps[i] + encodeURIComponent(token), { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) continue;
      var info = JSON.parse(resp.getContentText());
      var aud = info.aud || info.azp;
      if (ALLOWED_CLIENT_ID && aud !== ALLOWED_CLIENT_ID) continue;   // 只認自己的 client
      if (!info.email) continue;
      if (info.email_verified !== undefined &&
          String(info.email_verified) !== 'true' && info.email_verified !== true) continue;
      return info.email;
    } catch (e) { /* try next */ }
  }
  return null;
}

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

function tab_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  return sh;
}

function splitJson_(obj) {
  var s = JSON.stringify(obj);
  var parts = [];
  for (var i = 0; i < s.length; i += CHUNK) parts.push(s.slice(i, i + CHUNK));
  while (parts.length < CHUNK_COLS) parts.push('');
  return parts.slice(0, CHUNK_COLS);
}
function joinJson_(cells) {
  var s = (cells || []).join('');
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function findRow_(sh, key) {
  var last = sh.getLastRow();
  if (last < 1) return 0;
  var keys = sh.getRange(1, 1, last, 1).getValues();
  for (var i = 0; i < keys.length; i++) if (String(keys[i][0]) === key) return i + 1;
  return 0;
}

function readRecord_(tabName, key) {
  var sh = tab_(tabName);
  var row = findRow_(sh, key);
  if (!row) return { data: null, updatedAt: null };
  var vals = sh.getRange(row, 2, 1, 1 + CHUNK_COLS).getValues()[0]; // B..F
  return { data: joinJson_(vals.slice(1)), updatedAt: vals[0] || null };
}

function writeRecord_(tabName, key, obj) {
  var sh = tab_(tabName);
  var row = findRow_(sh, key);
  if (!row) row = sh.getLastRow() + 1 || 1;
  var parts = splitJson_(obj);
  sh.getRange(row, 1, 1, 2 + CHUNK_COLS).setValues([[key, Date.now()].concat(parts)]);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.resource === 'health') return json_({ ok: true, service: 'cb-workstation per-account backend' });
    var email = verifyEmail_(p.id_token);
    if (!email) return json_({ error: 'unauthorized' });
    if (p.resource === 'drawings') {
      var rec = readRecord_('drawings', email + '|' + String(p.sid) + '|' + String(p.period));
      return json_({ shapes: (rec.data && rec.data.shapes) || [], updatedAt: rec.updatedAt });
    }
    if (p.resource === 'watchlists') {
      var rec2 = readRecord_('watchlists', email);
      return json_({ lists: (rec2.data && rec2.data.lists) || [], updatedAt: rec2.updatedAt });
    }
    return json_({ error: 'unknown resource' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) {}
  try {
    var email = verifyEmail_(body.id_token);
    if (!email) return json_({ error: 'unauthorized' });
    if (body.resource === 'drawings') {
      writeRecord_('drawings', email + '|' + String(body.sid) + '|' + String(body.period),
        { shapes: Array.isArray(body.shapes) ? body.shapes.slice(0, 500) : [] });
      return json_({ ok: true });
    }
    if (body.resource === 'watchlists') {
      writeRecord_('watchlists', email, { lists: Array.isArray(body.lists) ? body.lists.slice(0, 10) : [] });
      return json_({ ok: true });
    }
    return json_({ error: 'unknown resource' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}
