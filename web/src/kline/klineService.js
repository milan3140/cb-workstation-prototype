import { fetchData } from '../dataSource.js'
import { normalizeCbKLineDocument, normalizeKLineDocument } from './schema.js'

const cache = new Map()

export async function loadKLineDocument(symbol, signal) {
  const key = String(symbol)
  if (!cache.has(key)) {
    const request = fetchData(`kline/${encodeURIComponent(key)}.json`, {
      signal,
      cache: 'no-cache',
    }).then(async response => {
      if (!response.ok) throw new Error(`K 線資料讀取失敗 (${response.status})`)
      return normalizeKLineDocument(await response.json(), key)
    }).catch(error => {
      cache.delete(key)
      throw error
    })
    cache.set(key, request)
  }
  return cache.get(key)
}

export function clearKLineCache(symbol) {
  if (symbol == null) cache.clear()
  else cache.delete(String(symbol))
}

/* CB 自身 K 線(治理 D3)。未接通(404)或無可用週期→回 null,呼叫端退回現股 K。
   資料源=後端 /api/cb_kline/{cbCode}.json(資料集原始報表:日 20 根、週/月上市以來)。 */
const cbCache = new Map()

export async function loadCbKLineDocument(cbCode, signal) {
  const key = `cb:${cbCode}`
  if (!cbCache.has(key)) {
    const request = fetchData(`cb_kline/${encodeURIComponent(cbCode)}.json`, { signal, cache: 'no-cache' })
      .then(async response => {
        if (response.status === 404) return null      // 尚未接通=正常情形
        if (!response.ok) throw new Error(`CB K 線讀取失敗 (${response.status})`)
        return normalizeCbKLineDocument(await response.json(), String(cbCode))
      })
      .catch(error => { cbCache.delete(key); if (error?.name === 'AbortError') throw error; return null })
    cbCache.set(key, request)
  }
  return cbCache.get(key)
}
