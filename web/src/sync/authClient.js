/* 自建帳號登入(不依賴 Google)= 這個 app 的「分帳號」身分來源。
 *
 * email + 密碼註冊 / 登入 → 後端(Apps Script)簽發 token → 每次同步帶 token,
 * 後端驗證後用 email 當 key 分帳號存畫線 / 關注。token 存 localStorage。
 *
 * 需要 VITE_SHEET_API_URL(Apps Script /exec)。沒設 = 不啟用,退回純本地。
 */
const API = String(import.meta.env.VITE_SHEET_API_URL || '').replace(/\/$/, '')
export const authEnabled = () => !!API

const LS = 'cbw_auth'
let _cred = null            // { token, email }
let _listeners = new Set()

function load() { try { const j = JSON.parse(localStorage.getItem(LS) || 'null'); if (j?.token && j?.email) _cred = j } catch {} }
load()

export const currentUser = () => (_cred ? { email: _cred.email } : null)
export const getToken = () => _cred?.token || null
export const onAuthChange = fn => { _listeners.add(fn); return () => _listeners.delete(fn) }
const notify = () => _listeners.forEach(fn => { try { fn(currentUser()) } catch {} })

function setCred(c) {
  _cred = c && c.token ? { token: c.token, email: c.email } : null
  try { _cred ? localStorage.setItem(LS, JSON.stringify(_cred)) : localStorage.removeItem(LS) } catch {}
  notify()
}

async function post(action, email, password) {
  if (!API) return { error: '未設定後端' }
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 簡單請求,免 CORS preflight
      body: JSON.stringify({ action, email, password }),
      redirect: 'follow',
    })
    const data = await res.json().catch(() => ({ error: '回應解析失敗' }))
    if (data.token) setCred(data)
    return data
  } catch (e) { return { error: '連線失敗' } }
}

export const register = (email, password) => post('register', email, password)
export const login = (email, password) => post('login', email, password)
export function logout() { setCred(null) }
