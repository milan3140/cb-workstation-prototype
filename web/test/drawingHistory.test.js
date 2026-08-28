import test from 'node:test'
import assert from 'node:assert/strict'
import { DrawingHistory } from '../src/kline/drawingHistory.js'

test('DrawingHistory 支援復原、重做並截斷分支', () => {
  const history = new DrawingHistory(10)
  history.reset([{ id: 'a' }])
  history.push([{ id: 'a' }, { id: 'b' }])
  history.push([{ id: 'c' }])
  assert.deepEqual(history.undo(), [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(history.undo(), [{ id: 'a' }])
  assert.equal(history.canUndo(), false)
  assert.deepEqual(history.redo(), [{ id: 'a' }, { id: 'b' }])
  history.push([{ id: 'd' }])
  assert.equal(history.canRedo(), false)
})

test('DrawingHistory 忽略內容相同的快照', () => {
  const history = new DrawingHistory()
  history.reset([])
  assert.equal(history.push([]), false)
  assert.equal(history.canUndo(), false)
})
