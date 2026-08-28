import { makeDrawingDocument, normalizeDrawingDocument } from './schema.js'
import { apiFetch } from '../dataSource.js'

const DB_NAME = 'signal-cb-production'
const DB_VERSION = 2
const STORE_NAME = 'chartDrawings'
// 林恩如自製 canvas overlay 的原生 shape 模型（{id,type,x1,y1,x2,y2,region,points,text,...}）。
// 與內建 klinecharts overlay 的 schema 不同（後者只留 {timestamp,value} 點 + name 列舉），
// 因此存在獨立的 object store，避免 schema.normalizeDrawing 把 type/region/vline 等欄位洗掉。
const SHAPE_STORE = 'signalCanvasShapes'
const remoteBase = String(import.meta.env.VITE_DRAWINGS_API_URL || '').replace(/\/$/, '')

const storageKey = (symbol, period) => `${String(symbol)}::${period}`

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return resolve(null)
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
      if (!request.result.objectStoreNames.contains(SHAPE_STORE)) request.result.createObjectStore(SHAPE_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readLocal(symbol, period) {
  const db = await openDatabase()
  if (!db) return makeDrawingDocument(symbol, period, [])
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(storageKey(symbol, period))
    request.onsuccess = () => resolve(normalizeDrawingDocument(request.result, symbol, period))
    request.onerror = () => reject(request.error)
  }).finally(() => db.close())
}

async function writeLocal(document) {
  const db = await openDatabase()
  if (!db) return
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(document, storageKey(document.symbol, document.period))
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  }).finally(() => db.close())
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function readRemote(symbol, period, signal) {
  if (!remoteBase) return null
  const url = `${remoteBase}/v1/chart-drawings/${encodeURIComponent(symbol)}/${encodeURIComponent(period)}`
  const response = await fetch(url, { signal, credentials: 'include', headers: { Accept: 'application/json' } })
  if (response.status === 404) return makeDrawingDocument(symbol, period, [])
  if (!response.ok) throw new Error(`雲端畫線讀取失敗 (${response.status})`)
  return normalizeDrawingDocument(await response.json(), symbol, period)
}

async function writeRemote(document, signal) {
  if (!remoteBase) return false
  const url = `${remoteBase}/v1/chart-drawings/${encodeURIComponent(document.symbol)}/${encodeURIComponent(document.period)}`
  const token = csrfToken()
  const response = await fetch(url, {
    method: 'PUT',
    signal,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    body: JSON.stringify(document),
  })
  if (!response.ok) throw new Error(`雲端畫線儲存失敗 (${response.status})`)
  return true
}

export async function loadDrawingDocument(symbol, period, signal) {
  const local = await readLocal(symbol, period)
  if (!remoteBase) return { document: local, scope: 'device' }
  const remote = await readRemote(symbol, period, signal)
  await writeLocal(remote)
  return { document: remote, scope: 'cloud' }
}

export async function saveDrawingDocument(symbol, period, drawings, signal) {
  const document = makeDrawingDocument(symbol, period, drawings)
  await writeLocal(document)
  const cloud = await writeRemote(document, signal)
  return { document, scope: cloud ? 'cloud' : 'device' }
}

// ===== 自製 canvas overlay 的原生 shape 持久化（IndexedDB，依 symbol::period 分開） =====
const MAX_SHAPES = 500

function sanitizeShapes(input) {
  return (Array.isArray(input) ? input : [])
    .slice(0, MAX_SHAPES)
    .filter(s => s && typeof s === 'object' && typeof s.type === 'string')
}

export async function loadShapes(symbol, period) {
  const db = await openDatabase()
  if (!db) return []
  return new Promise((resolve, reject) => {
    const request = db.transaction(SHAPE_STORE, 'readonly').objectStore(SHAPE_STORE).get(storageKey(symbol, period))
    request.onsuccess = () => resolve(sanitizeShapes(request.result?.shapes))
    request.onerror = () => reject(request.error)
  }).finally(() => db.close())
}

export async function saveShapes(symbol, period, shapes) {
  const db = await openDatabase()
  if (!db) return
  const record = { symbol: String(symbol), period, updatedAt: Date.now(), shapes: sanitizeShapes(shapes) }
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHAPE_STORE, 'readwrite')
    transaction.objectStore(SHAPE_STORE).put(record, storageKey(symbol, period))
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  }).finally(() => db.close())
}

// ===== 畫線雲端同步(登入會員;後端 cb-workstation-data /api/drawings,Google Sheet 正本) =====
// 模式照關注清單:登入=雲端正本+IndexedDB 離線快取;未登入/無後端/失敗=回 null,呼叫端沿用本地。
export async function fetchCloudShapes(symbol, period, signal) {
  try {
    const res = await apiFetch(`drawings/${encodeURIComponent(symbol)}/${encodeURIComponent(period)}`, { signal })
    if (!res || !res.ok) return null
    const data = await res.json()
    return { shapes: sanitizeShapes(data.shapes), updatedAt: data.updatedAt ?? null }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

// 回傳 true=已同步雲端;false=未登入/失敗(本地已存,下次變更會再試)
export async function pushCloudShapes(symbol, period, shapes) {
  try {
    const res = await apiFetch(`drawings/${encodeURIComponent(symbol)}/${encodeURIComponent(period)}`, {
      method: 'PUT', body: { shapes: sanitizeShapes(shapes) },
    })
    return !!(res && res.ok)
  } catch {
    return false
  }
}
