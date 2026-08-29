/* Google 登入(Google Identity Services)= 這個 app 的「分帳號」身分來源。
 *
 * 使用者用 Google 登入 → 拿到 ID token(JWT,內含 email)→ 每次同步帶給 Apps Script 後端,
 * 後端驗證後用 email 當 key 分帳號存畫線 / 關注清單。
 *
 * 需要 VITE_GOOGLE_CLIENT_ID(GIS OAuth Client ID)。沒設 = 不啟用登入,同步退回本地。
 *
 * ID token 約 1 小時到期;過期時 getFreshToken() 會靜默重新取一張(prompt)。
 */

const CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim()
export const googleEnabled = () => !!CLIENT_ID

const LS_TOKEN = 'cbw_gid_token'
let _cred = null            // { token, email, name, exp }  當前登入者
let _listeners = new Set()
let _gisReady = null        // Promise:GIS script 載入完成

function decodeJwt(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return { email: p.email, name: p.name || p.email, exp: p.exp * 1000 }
  } catch { return null }
}

function setCred(token) {
  const info = token && decodeJwt(token)
  if (!info || !info.email) { _cred = null; try { localStorage.removeItem(LS_TOKEN) } catch {} }
  else { _cred = { token, ...info }; try { localStorage.setItem(LS_TOKEN, token) } catch {} }
  _listeners.forEach(fn => { try { fn(currentUser()) } catch {} })
}

export const currentUser = () => (_cred ? { email: _cred.email, name: _cred.name } : null)
export const onAuthChange = fn => { _listeners.add(fn); return () => _listeners.delete(fn) }

function loadGis() {
  if (_gisReady) return _gisReady
  _gisReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true; s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('GIS 載入失敗'))
    document.head.appendChild(s)
  })
  return _gisReady
}

let _initDone = false
async function ensureInit() {
  if (!googleEnabled()) return false
  await loadGis()
  if (!_initDone) {
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: resp => { if (resp?.credential) setCred(resp.credential) },
      auto_select: true,
    })
    _initDone = true
  }
  return true
}

/* 還原上次登入(token 未過期就直接用;過期則靜默 prompt 重取) */
export async function restore() {
  if (!googleEnabled()) return null
  try {
    const t = localStorage.getItem(LS_TOKEN)
    const info = t && decodeJwt(t)
    if (info && info.exp > Date.now() + 60000) { setCred(t); }
  } catch {}
  await ensureInit()
  return currentUser()
}

/* 在指定 DOM 元素渲染「Sign in with Google」按鈕 */
export async function renderButton(el) {
  if (!(await ensureInit()) || !el) return
  window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'medium', shape: 'pill', text: 'signin_with' })
}

/* 拿一張沒過期的 ID token;過期或沒有 → 嘗試靜默 prompt(需使用者曾登入) */
export async function getFreshToken() {
  if (_cred && _cred.exp > Date.now() + 60000) return _cred.token
  if (!(await ensureInit())) return null
  return new Promise(resolve => {
    let done = false
    const off = onAuthChange(() => { if (!done) { done = true; off(); resolve(_cred?.token || null) } })
    window.google.accounts.id.prompt(() => {})   // 靜默;失敗則下方 timeout 收尾
    setTimeout(() => { if (!done) { done = true; off(); resolve(_cred?.token || null) } }, 4000)
  })
}

export function signOut() {
  try { window.google?.accounts?.id?.disableAutoSelect() } catch {}
  setCred(null)
}
