/* 資料來源統一入口:一律走後端 API,並帶OIDC access_token(後端驗過才吐資料)。
   - VITE_DATA_API_URL 未設(本機純前端 dev)→ 退回部署包同源靜態檔(dev-only,正式映像已不烤資料)。
   - 設了 → 打 `${API}/api/<path>`,附 `Authorization: Bearer <token>`(登入後才有)。
   治理鐵則「前端不洩漏任何資料」:正式映像零資料,資料由 cb-workstation-data 驗身分後供給。 */
import { getAccessToken } from './auth/oidc.js'

const API_BASE = (import.meta.env.VITE_DATA_API_URL || '').replace(/\/$/, '')

export async function fetchData(path, init = {}) {
  if (API_BASE) {
    try {
      const token = await getAccessToken()
      const headers = { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
      const response = await fetch(`${API_BASE}/api/${path}`, { ...init, headers })
      if (response.ok) return response
    } catch (error) {
      if (error?.name === 'AbortError') throw error   // 使用者取消不該退回
    }
  }
  // dev-only 退路:正式映像已無同源靜態資料,此路在正式站等同 404(不洩漏)。
  return fetch(`${import.meta.env.BASE_URL}${path}`, init)
}

/* 讀寫型 API(關注清單):帶 token 打後端 /api/<path>,支援 GET/PUT/JSON body。
   與 fetchData 不同:不退回靜態檔(這是使用者資料,失敗就是失敗)。
   無 API_BASE(本機純前端 dev)或未登入無 token → 回 null,呼叫端改用 localStorage。 */
export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  if (!API_BASE) return null
  const token = await getAccessToken()
  if (!token) return null   // 未登入 → 不打後端(guest 走本地)
  const headers = { Authorization: `Bearer ${token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${API_BASE}/api/${path}`, {
    method, headers, signal,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
