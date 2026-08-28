/* 關注清單模型 + 儲存(每會員最多 10 份自訂清單)。
   - 登入:後端 Google Sheet 為正本(GET 讀、變動 PUT 同步),localStorage 當離線快取。
   - 未登入(guest):只存 localStorage(本地清單,不同步)。
   資料形狀:[{ id, name, codes: string[] }]  (codes = CB 代號)。 */
import { apiFetch } from './dataSource.js'

export const MAX_LISTS = 10
const LS_KEY = 'signal_watchlists'
const LS_OLD = 'signal_watch'   // 舊版單一 Set,首次遷移成一份預設清單

let _seq = 0
export const genId = () => `L${Date.now().toString(36)}${(_seq++).toString(36)}`

export const makeList = (name = '我的關注', codes = []) => ({ id: genId(), name, codes: [...codes] })

// 正規化(防呆:限 10 份、name/codes 型別、code 去重),前後端各驗一次
export function normalize(lists) {
  const out = []
  for (const it of Array.isArray(lists) ? lists : []) {
    if (!it || typeof it !== 'object') continue
    const id = String(it.id || genId()).slice(0, 64)
    const name = String(it.name || '').slice(0, 40) || '未命名清單'
    const seen = new Set(); const codes = []
    for (const c of Array.isArray(it.codes) ? it.codes : []) {
      const code = String(c).trim().slice(0, 12)
      if (code && !seen.has(code)) { seen.add(code); codes.push(code) }
    }
    out.push({ id, name, codes })
    if (out.length >= MAX_LISTS) break
  }
  return out
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) { const l = normalize(JSON.parse(raw)); if (l.length) return l }
  } catch { /* noop */ }
  // 遷移舊版 signal_watch(單一 code 集合)→ 一份預設清單
  try {
    const old = JSON.parse(localStorage.getItem(LS_OLD) || '[]')
    if (Array.isArray(old) && old.length) return [makeList('我的關注', old)]
  } catch { /* noop */ }
  return [makeList('我的關注', [])]   // 初始:一份空白預設清單
}

export function saveLocal(lists) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(lists)) } catch { /* noop */ }
}

// 登入後從後端讀正本;未登入/無後端 → null(呼叫端沿用本地)
export async function fetchRemote(signal) {
  try {
    const res = await apiFetch('watchlists', { signal })
    if (!res || !res.ok) return null
    const data = await res.json()
    return normalize(data.lists || [])
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    return null
  }
}

// 變動時整包 PUT(前端持有正本;UI 保證同會員不併發寫)。回傳 true=成功
export async function pushRemote(lists) {
  try {
    const res = await apiFetch('watchlists', { method: 'PUT', body: { lists } })
    return !!(res && res.ok)
  } catch { return false }
}
