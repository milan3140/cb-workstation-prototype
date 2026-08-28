export const KLINE_SCHEMA_VERSION = 1
export const DRAWING_SCHEMA_VERSION = 1
export const DRAWING_GROUP = 'signal-user-drawings'
export const MAX_DRAWINGS = 300
export const MAX_TEXT_LENGTH = 120

export const PERIODS = Object.freeze({
  hour: { type: 'minute', span: 60, label: '60分 K' },
  day: { type: 'day', span: 1, label: '日 K' },
  week: { type: 'week', span: 1, label: '週 K' },
  month: { type: 'month', span: 1, label: '月 K' },
})

// 現股 K 線必備週期(缺任一=真異常,fail-loud);hour(60分)為選配——
// 端點偶爾對冷門標的無 60分K,缺了不該讓整份日/週/月掛掉。
export const REQUIRED_PERIODS = Object.freeze(['day', 'week', 'month'])

export const DRAWING_NAMES = Object.freeze([
  'segment',
  'horizontalStraightLine',
  'signalRectangle',
  'signalText',
  'brush',
])

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value)

function normalizeBar(value) {
  if (!value || typeof value !== 'object') return null
  const bar = {
    timestamp: Number(value.timestamp),
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume ?? 0),
  }
  if (value.turnover != null) bar.turnover = Number(value.turnover)
  if (!Object.values(bar).every(isFiniteNumber)) return null
  if (bar.timestamp < 946684800000 || bar.timestamp > 4102444800000) return null
  if (Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0) return null
  if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return null
  return bar
}

export function normalizeKLineDocument(input, expectedSymbol) {
  if (!input || input.schemaVersion !== KLINE_SCHEMA_VERSION || String(input.symbol) !== String(expectedSymbol)) {
    throw new Error('K 線資料版本或股票代號不符')
  }
  const periods = {}
  for (const key of Object.keys(PERIODS)) {
    const source = Array.isArray(input.periods?.[key]) ? input.periods[key] : []
    const unique = new Map()
    source.forEach(value => {
      const bar = normalizeBar(value)
      if (bar) unique.set(bar.timestamp, bar)
    })
    const bars = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp)
    if (bars.length) periods[key] = bars
    else if (REQUIRED_PERIODS.includes(key)) throw new Error(`${PERIODS[key].label} 沒有有效資料`)
  }
  return {
    schemaVersion: KLINE_SCHEMA_VERSION,
    symbol: String(expectedSymbol),
    updatedAt: Number(input.updatedAt) || periods.day.at(-1).timestamp,
    periods,
  }
}

/* CB 自身 K 線的正規化。與現股那條刻意不同:**允許缺週期**。
   理由:CB 日 K 的原始報表內建深度只有 20 根,冷門檔近 20 日無成交就完全沒有 day;
   那不代表整份資料無效(週/月照樣完整)。現股那條維持 fail-loud——現股缺週期是真異常。
   回 null = 這檔沒有可用的 CB K 線,呼叫端只顯示現股軌。 */
export function normalizeCbKLineDocument(input, expectedSymbol) {
  if (!input || input.schemaVersion !== KLINE_SCHEMA_VERSION
      || String(input.symbol) !== String(expectedSymbol)) return null
  const periods = {}
  for (const key of Object.keys(PERIODS)) {
    const source = Array.isArray(input.periods?.[key]) ? input.periods[key] : []
    const unique = new Map()
    source.forEach(value => {
      const bar = normalizeBar(value)
      if (bar) unique.set(bar.timestamp, bar)
    })
    const bars = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp)
    if (bars.length) periods[key] = bars
  }
  const filled = Object.values(periods)
  if (!filled.length) return null
  return {
    schemaVersion: KLINE_SCHEMA_VERSION,
    symbol: String(expectedSymbol),
    isCb: true,
    updatedAt: Number(input.updatedAt) || Math.max(...filled.map(bars => bars.at(-1).timestamp)),
    periods,
  }
}

function safeColor(value, fallback = '#D8DBE0') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function safeSize(value, fallback = 2) {
  const size = Number(value)
  return Number.isFinite(size) ? Math.min(6, Math.max(1, size)) : fallback
}

function normalizePoint(value) {
  const timestamp = Number(value?.timestamp)
  const price = Number(value?.value)
  if (!isFiniteNumber(timestamp) || !isFiniteNumber(price) || price <= 0) return null
  return { timestamp, value: price }
}

export function normalizeDrawing(value) {
  if (!value || !DRAWING_NAMES.includes(value.name)) return null
  const maxPoints = value.name === 'brush' ? 1500 : 4
  const points = (Array.isArray(value.points) ? value.points : [])
    .slice(0, maxPoints)
    .map(normalizePoint)
    .filter(Boolean)
  if (!points.length) return null
  const color = safeColor(value.style?.color)
  const lineWidth = safeSize(value.style?.lineWidth)
  return {
    id: String(value.id || crypto.randomUUID()).slice(0, 100),
    name: value.name,
    points,
    extendData: value.name === 'signalText'
      ? String(value.extendData || '').trim().slice(0, MAX_TEXT_LENGTH)
      : null,
    style: { color, lineWidth },
    lock: Boolean(value.lock),
  }
}

export function normalizeDrawingDocument(input, symbol, period) {
  const drawings = (Array.isArray(input?.drawings) ? input.drawings : [])
    .slice(0, MAX_DRAWINGS)
    .map(normalizeDrawing)
    .filter(Boolean)
  return {
    schemaVersion: DRAWING_SCHEMA_VERSION,
    symbol: String(symbol),
    period,
    updatedAt: Number(input?.updatedAt) || Date.now(),
    drawings,
  }
}

export function makeDrawingDocument(symbol, period, drawings) {
  return normalizeDrawingDocument({ drawings, updatedAt: Date.now() }, symbol, period)
}
