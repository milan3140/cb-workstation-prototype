const clone = value => JSON.parse(JSON.stringify(value))
const fingerprint = value => JSON.stringify(value)

export class DrawingHistory {
  constructor(limit = 60) {
    this.limit = limit
    this.reset([])
  }

  reset(snapshot) {
    this.entries = [clone(snapshot)]
    this.index = 0
  }

  push(snapshot) {
    const next = clone(snapshot)
    if (fingerprint(next) === fingerprint(this.entries[this.index])) return false
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push(next)
    if (this.entries.length > this.limit) this.entries.shift()
    this.index = this.entries.length - 1
    return true
  }

  undo() {
    if (!this.canUndo()) return null
    this.index -= 1
    return clone(this.entries[this.index])
  }

  redo() {
    if (!this.canRedo()) return null
    this.index += 1
    return clone(this.entries[this.index])
  }

  canUndo() { return this.index > 0 }
  canRedo() { return this.index < this.entries.length - 1 }
  current() { return clone(this.entries[this.index]) }
}
