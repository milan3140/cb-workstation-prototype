/* 分帳號雲端同步:打 Apps Script Web App(Google Sheet 為 DB),帶自建帳號 token。
 *
 * 需要 VITE_SHEET_API_URL(Apps Script /exec 網址)。沒設 = 不啟用,呼叫端退回本地。
 * 身分來自 authClient(自建 email+密碼登入後拿到的 HMAC token);後端驗 token 取 email 分帳號隔離。
 *
 * CORS:Apps Script /exec 只吃「簡單請求」——GET(讀)與 POST + text/plain(寫)都免 preflight。
 */
import { getToken, authEnabled } from './authClient.js'

const API = String(import.meta.env.VITE_SHEET_API_URL || '').replace(/\/$/, '')
export const sheetSyncEnabled = () => !!(API && authEnabled())

async function withToken() { return getToken() }

/* 讀:GET ?resource=...&token=...  回 JSON 或 null(未登入/失敗) */
async function get(params, signal) {
  const token = await withToken()
  if (!token) return null
  const q = new URLSearchParams({ ...params, token }).toString()
  try {
    const res = await fetch(`${API}?${q}`, { method: 'GET', signal, redirect: 'follow' })
    if (!res.ok) return null
    const data = await res.json()
    return data && !data.error ? data : null
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    return null
  }
}

/* 寫:POST text/plain JSON(含 token)。回 true/false */
async function post(payload) {
  const token = await withToken()
  if (!token) return false
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 簡單請求,免 preflight
      body: JSON.stringify({ ...payload, token }),
      redirect: 'follow',
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => ({}))
    return !!data.ok
  } catch { return false }
}

// ── 畫線 ──
export async function fetchShapes(sid, period, signal) {
  const d = await get({ resource: 'drawings', sid: String(sid), period: String(period) }, signal)
  return d ? { shapes: Array.isArray(d.shapes) ? d.shapes : [], updatedAt: d.updatedAt ?? null } : null
}
export function pushShapes(sid, period, shapes) {
  return post({ resource: 'drawings', sid: String(sid), period: String(period), shapes })
}

// ── 關注清單 ──
export async function fetchLists(signal) {
  const d = await get({ resource: 'watchlists' }, signal)
  return d ? (Array.isArray(d.lists) ? d.lists : []) : null
}
export function pushLists(lists) {
  return post({ resource: 'watchlists', lists })
}
