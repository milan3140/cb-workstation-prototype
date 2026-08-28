import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDrawingDocument, normalizeKLineDocument } from '../src/kline/schema.js'

const bar = { timestamp: 1767225600000, open: 10, high: 12, low: 9, close: 11, volume: 100 }

test('K 線契約排序、去重並拒絕錯誤 OHLC', () => {
  const document = normalizeKLineDocument({
    schemaVersion: 1,
    symbol: '1101',
    periods: {
      day: [{ ...bar, timestamp: bar.timestamp + 1000 }, bar, { ...bar, high: 8 }],
      week: [bar],
      month: [bar],
    },
  }, '1101')
  assert.equal(document.periods.day.length, 2)
  assert.ok(document.periods.day[0].timestamp < document.periods.day[1].timestamp)
})

test('畫線契約只保留白名單類型並清理文字與樣式', () => {
  const document = normalizeDrawingDocument({ drawings: [
    { id: 'x', name: 'segment', points: [{ timestamp: bar.timestamp, value: 10 }], style: { color: '#abcdef', lineWidth: 99 } },
    { id: 'bad', name: 'javascript', points: [{ timestamp: bar.timestamp, value: 10 }] },
    { id: 't', name: 'signalText', points: [{ timestamp: bar.timestamp, value: 10 }], extendData: '<b>純文字</b>' },
  ] }, '1101', 'day')
  assert.equal(document.drawings.length, 2)
  assert.equal(document.drawings[0].style.lineWidth, 6)
  assert.equal(document.drawings[1].extendData, '<b>純文字</b>')
})
