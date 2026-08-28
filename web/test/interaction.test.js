import test from 'node:test'
import assert from 'node:assert/strict'
import { cooperativeZoomFactor, renewDrawingDraft, wheelIntent } from '../src/kline/interaction.js'

test('普通模式將未按修飾鍵的滾輪交還頁面', () => {
  assert.equal(wheelIntent(), 'page-scroll')
  assert.equal(wheelIntent({ ctrlKey: true }), 'cooperative-zoom')
  assert.equal(wheelIntent({ metaKey: true }), 'cooperative-zoom')
})

test('看盤與畫圖模式具有明確的滾輪意圖', () => {
  assert.equal(wheelIntent({ focusMode: true }), 'chart')
  assert.equal(wheelIntent({ focusMode: true, activeTool: 'segment' }), 'drawing')
})

test('合作式縮放限制單次縮放幅度', () => {
  assert.equal(cooperativeZoomFactor(0), 1)
  assert.ok(cooperativeZoomFactor(-100) > 1)
  assert.ok(cooperativeZoomFactor(100) < 1)
  assert.equal(cooperativeZoomFactor(-10000), 1.28)
  assert.equal(cooperativeZoomFactor(10000), 0.72)
})

test('完成繪圖後保留工具並清空上一筆座標', () => {
  const draft = renewDrawingDraft({
    tool: 'segment', text: null, anchor: { x: 1, y: 2 }, current: { x: 3, y: 4 },
    points: [{ x: 1, y: 2 }], pressed: true, finishing: true,
  })
  assert.equal(draft.tool, 'segment')
  assert.equal(draft.anchor, null)
  assert.equal(draft.current, null)
  assert.deepEqual(draft.points, [])
  assert.equal(draft.pressed, false)
  assert.equal(draft.finishing, false)
})
