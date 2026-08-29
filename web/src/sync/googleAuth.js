/* Google 登入(自訂 UI)= 這個 app 的「分帳號」身分來源。
 *
 * 用 GIS OAuth2 token client:我們自己畫登入按鈕,點了才彈 Google 帳號選擇 → 拿 access token,
 * 再用 access token 打 userinfo 取 email。access token 傳給後端(Apps Script)驗證後分帳號存資料。
 * 不用 Google 那顆制式按鈕(renderButton),UI 完全是我們的。
 *
 * 需要 VITE_GOOGLE_CLIENT_ID。沒設 = 不啟用,同步退回本地。
 */
const CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim()
export const googleEnabled = () => !!CLIENT_ID

const LS = 'cbw_gauth'
let _cred = null            // { token, email, name, exp }
let _client = null
let _listeners = new Set()
let _gisReady = null

export const currentUser = () => (_cred ? { email: _cred.email, name: _cred.name } : null)
export const onAuthChange = fn => { _listeners.add(fn); return () => _listeners.delete(fn) }
const notify = () => _listeners.forEach(fn => { try { fn(currentUser()) } catch {} })

function persist() {
  try {
    if (_cred) localStorage.setItem(LS, JSON.stringify({ email: _cred.email, name: _cred.name, exp: _cred.exp }))
    else localStorage.removeItem(LS)
  } catch {}
}

function loadGis() {
  if (_gisReady) return _gisReady
  _gisReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true; s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('GIS 載入失敗'))
    document.head.appendChild(s)
  })
  return _gisReady
}

async function fetchUserInfo(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  })
  if (!r.ok) throw new Error('userinfo 失敗')
  return r.json()   // { email, name, picture, ... }
}

let _pending = null   // 當前登入 Promise 的 resolve;成功/取消/逾時都會呼叫,確保按鈕不卡

function settle(u) { const f = _pending; _pending = null; if (f) f(u) }

async function ensureClient() {
  if (!googleEnabled()) return null
  await loadGis()
  if (!_client) {
    _client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'openid email profile',
      callback: async resp => {
        if (!resp || resp.error || !resp.access_token) return settle(currentUser())
        try {
          const info = await fetchUserInfo(resp.access_token)
          _cred = { token: resp.access_token, email: info.email, name: info.name || info.email, exp: Date.now() + (Number(resp.expires_in) || 3500) * 1000 }
          persist(); notify(); settle(currentUser())
        } catch { settle(currentUser()) }
      },
      // 使用者關掉彈窗 / 未選帳號 / 失敗 → 這裡會被呼叫,務必 resolve 讓 UI 解除 busy
      error_callback: () => settle(currentUser()),
    })
  }
  return _client
}

/* 觸發登入(我們的按鈕呼叫):彈 Google 帳號選擇 → 取 access token → 補 email。
   不論成功、取消或逾時都會 resolve(避免按鈕卡在 busy)。 */
export async function signIn(silent = false) {
  const client = await ensureClient()
  if (!client) return null
  if (_pending) settle(currentUser())   // 前一個未結的登入先收掉(避免並發)
  return new Promise(resolve => {
    const t = setTimeout(() => settle(currentUser()), silent ? 4000 : 90000)   // 安全逾時
    _pending = u => { clearTimeout(t); resolve(u) }
    try { client.requestAccessToken({ prompt: silent ? '' : 'select_account' }) }
    catch { settle(currentUser()) }
  })
}

/* 還原上次登入:localStorage 只留 email(access token 短命不存),靜默重取一張 token */
export async function restore() {
  if (!googleEnabled()) return null
  let hint = null
  try { hint = JSON.parse(localStorage.getItem(LS) || 'null') } catch {}
  if (!hint?.email) return null
  return signIn(true)   // 靜默(prompt:'')嘗試;Google session 在就無感取回
}

/* 拿一張沒過期的 access token(過期→靜默重取) */
export async function getFreshToken() {
  if (_cred && _cred.exp > Date.now() + 60000) return _cred.token
  await signIn(true)
  return _cred?.token || null
}

export function signOut() {
  const tok = _cred?.token
  if (tok && window.google?.accounts?.oauth2) { try { window.google.accounts.oauth2.revoke(tok, () => {}) } catch {} }
  _cred = null; persist(); notify()
}
