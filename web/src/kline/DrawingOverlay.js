/**
 * DrawingOverlay — 圖表無關的自製畫線引擎，移植自自製 canvas overlay（DrawingOverlay.vue）。
 *
 * 座標系統：所有 shape 以「資料座標」儲存（x = 時間戳 timestamp、y = 價格/量值），
 * 透過注入的 toPixel/fromPixel 與圖表庫的像素座標互轉，讓劃線跟著捲動/縮放/換週期一起移動、
 * 黏在同一時間與價格。座標三函式由外部（klinecharts 版）以 convertToPixel/convertFromPixel 實作。
 *
 * 與 Vue 版差異：
 *  - 不綁 Vue、不自帶 localStorage/API：改用 onChange 回呼把 shapes 交回宿主（KLinePanel）做持久化與 undo/redo。
 *  - 不需 date-realign：x 直接錨定 timestamp（換週期天生對齊），且儲存已依 symbol::period 分開。
 *  - 新增 'select' 工具（純選取/移動既有圖形，不畫新圖）。
 */

const HANDLE_R = 5      // 端點把手半徑（CSS px，視覺）
const HANDLE_HIT = 11   // 端點命中半徑
const HIT_THRESHOLD = 12
const MIN_DRAG_PX = 5
const DEFAULT_FONT_SIZE = 16

let _idSeq = 0
function makeId() {
  // 時間戳 + 單調遞增序列已保證 session 內唯一;不用 Math.random(避免 Sonar 弱亂數熱點,圖形 ID 無需密碼學亂數)
  return Date.now().toString(36) + (_idSeq++).toString(36)
}

// 兩端點圖形（提供端點把手）；hline/vline/text/brush 走整體移動
function hasEndpointHandles(t) {
  return t === 'line' || t === 'rect' || t === 'filledRect' || t === 'circle' || t === 'filledCircle'
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export default class DrawingOverlay {
  /**
   * @param {HTMLElement} host 圖表容器（canvas 會絕對定位覆蓋其上，座標原點與 host 左上對齊）
   * @param {object} opts
   *   toPixel(x, y, region) -> [px, py] | null      資料座標→CSS 像素
   *   fromPixel(px, py, region) -> [x, y] | null    CSS 像素→資料座標
   *   gridRect(region) -> {x,y,width,height} | null  該區的繪圖矩形（像素）
   *   onChange(shapes)                              有實際變更（畫完/移動完/擦除/清除/文字）時觸發
   *   panBy(dxPx, dyPx)                             select 模式在空白處拖曳 → 交回宿主平移圖表（可選）
   *   getColor() / getLineWidth()                   目前樣式
   */
  constructor(host, opts = {}) {
    this.host = host
    this.opts = opts
    this.shapes = []
    this.active = false
    this.tool = 'select'
    this.color = opts.getColor?.() || '#D8DBE0'
    this.lineWidth = opts.getLineWidth?.() || 2
    this.hidden = false

    this.canvas = null
    this.ctx = null
    this.dpr = 1
    this.resizeObs = null
    this.textInput = null

    // 繪製暫存
    this.isDrawing = false
    this.pendingSecondHV = false
    this.brushPoints = []
    this.startDx = 0; this.startDy = 0
    this.currentDx = 0; this.currentDy = 0
    this.startPx = 0; this.startPy = 0
    this.currentRegion = 'price'

    // 直接編輯既有圖形
    this.selEditId = null
    this.selectMode = null            // 'move' | 'end1' | 'end2'
    this.hoverSelectId = null
    this.hoverEraseId = null
    this.dragStartD = [0, 0]
    this.dragOrig = null

    // select 模式空白處平移圖表
    this.panning = false
    this.panLastPx = 0; this.panLastPy = 0

    this._onDocMove = this._onDocMouseMove.bind(this)
    this._onDocUp = this._onDocMouseUp.bind(this)

    this._createCanvas()
  }

  // ===== public API =====
  setActive(active) {
    this.active = active
    this._syncActiveState()
    if (active) this.resize()
    this.redraw()
  }

  setTool(tool) {
    this.tool = tool
    this.pendingSecondHV = false
    this.isDrawing = false
    this.hoverEraseId = null
    this.hoverSelectId = null
    this.selEditId = null
    this.selectMode = null
    this.dragOrig = null
    this.brushPoints = []
    this._removeTextInput()
    this._syncActiveState()
    this.redraw()
  }

  setStyle(color, lineWidth) {
    if (color != null) this.color = color
    if (lineWidth != null) this.lineWidth = lineWidth
    // 若有選中圖形則套用到該圖形
    const s = this.selEditId ? this.shapes.find(sh => sh.id === this.selEditId) : null
    if (s) {
      if (color != null) s.color = color
      if (lineWidth != null) s.lineWidth = lineWidth
      this._emitChange()
    }
    this.redraw()
  }

  getSelected() {
    return this.selEditId ? this.shapes.find(sh => sh.id === this.selEditId) || null : null
  }

  /** 程式化選中指定圖形(供「點線即選取」進入選取模式後鎖定該線);需已 setTool('select') */
  selectShape(id) {
    const s = this.shapes.find(sh => sh.id === id)
    if (!s) return
    this.selEditId = s.id
    this.selectMode = null
    this.opts.onSelect?.(s)
    this.redraw()
  }

  setShapes(shapes) {
    this.shapes = Array.isArray(shapes) ? shapes.map(s => ({ ...s })) : []
    this.selEditId = null
    this.selectMode = null
    this.hoverSelectId = null
    this.hoverEraseId = null
    this.redraw()
  }

  getShapes() {
    return this.shapes.map(s => ({ ...s }))
  }

  hasShapes() { return this.shapes.length > 0 }

  clearAll() {
    this.shapes = []
    this.selEditId = null
    this._emitChange()
    this.redraw()
  }

  deleteSelected() {
    if (!this.selEditId) return
    this.shapes = this.shapes.filter(s => s.id !== this.selEditId)
    this.selEditId = null
    this._emitChange()
    this.redraw()
  }

  toggleHidden() {
    this.hidden = !this.hidden
    this._removeTextInput()
    this.redraw()
    return this.hidden
  }

  destroy() {
    this.resizeObs?.disconnect()
    this._removeTextInput()
    document.removeEventListener('mousemove', this._onDocMove)
    document.removeEventListener('mouseup', this._onDocUp)
    this.host.removeEventListener('pointerdown', this._onHostPointerDown)
    this.host.removeEventListener('pointerup', this._onHostPointerUp)
    this.host.removeEventListener('pointercancel', this._onHostPointerCancel)
    this.host.removeEventListener('mousemove', this._selHover)
    this.host.removeEventListener('mousedown', this._selCaptureDown, true)
    this.host.removeEventListener('touchstart', this._selCaptureDown, { capture: true })
    this.host.removeEventListener('touchmove', this._selCaptureMove, { capture: true })
    this.host.removeEventListener('touchend', this._selCaptureEnd, { capture: true })
    this.host.removeEventListener('touchcancel', this._selCaptureCancel, { capture: true })
    this.host.removeEventListener('dblclick', this._selCaptureDbl, true)
    if (this.canvas) {
      this.canvas.remove()
      this.canvas = null
    }
  }

  // ===== canvas =====
  _createCanvas() {
    const canvas = document.createElement('canvas')
    canvas.className = 'signal-drawing-overlay'
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;'
    this.host.appendChild(canvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    canvas.addEventListener('mousedown', e => this._onMouseDown(e))
    canvas.addEventListener('mousemove', e => this._onCanvasMouseMove(e))
    canvas.addEventListener('mouseleave', () => this._onCanvasMouseLeave())
    canvas.addEventListener('dblclick', e => this._onDblClick(e))
    canvas.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false })
    canvas.addEventListener('touchmove', e => this._onTouchMove(e), { passive: false })
    canvas.addEventListener('touchend', e => this._onTouchEnd(e), { passive: false })
    // 中斷觸控(多指/來電/切背景/系統手勢)→ 一律取消手勢、收乾淨,不讓 panning/isDrawing 卡住
    canvas.addEventListener('touchcancel', () => this._cancelGesture(), { passive: false })

    // 看盤模式「點線即選取」:overlay 未啟用時 canvas 是 pointer-events:none,事件全進圖表,
    // 所以掛在 host 層被動偵測「乾淨單擊」(短按+位移小+單指),命中既有圖形 → onShapeTap 交宿主切選取模式。
    // 不 preventDefault,圖表原本的點擊行為(十字線)照舊。
    this._browseTap = null
    this._onHostPointerDown = e => {
      this._browseTap = null
      if (this.hidden || !e.isPrimary) return
      const selMode = this.active && this.tool === 'select'
      if (this.active && !selMode) return                       // 其他畫線工具:canvas 自己接,不做 tap 偵測
      if (!selMode && this.shapes.length === 0) return          // 看盤模式:沒圖形就不用比對
      this._browseTap = { x: e.clientX, y: e.clientY, t: performance.now(), sel: selMode }
    }
    this._onHostPointerUp = e => {
      const tap = this._browseTap
      this._browseTap = null
      if (!tap || this.hidden || !e.isPrimary) return
      if (performance.now() - tap.t > 350) return
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) return
      const [px, py] = this._pixelCoords(e)
      const id = this._hitTest(px, py)
      if (tap.sel) {
        // 選取模式:乾淨單擊「空白處」→ 通知宿主(由點線進入選取模式者,藉此一鍵回看盤)
        if (!id && !this._touchEditing) this.opts.onEmptyTap?.()
        return
      }
      if (this.active) return   // down→up 之間模式已切換,不處理
      if (id) {
        const shape = this.shapes.find(s => s.id === id)
        if (shape) this.opts.onShapeTap?.({ ...shape })
      }
    }
    this._onHostPointerCancel = () => { this._browseTap = null }
    this.host.addEventListener('pointerdown', this._onHostPointerDown)
    this.host.addEventListener('pointerup', this._onHostPointerUp)
    this.host.addEventListener('pointercancel', this._onHostPointerCancel)

    // 穿透式選取模式:canvas 放行(圖表手勢照常),僅當手勢「起點」命中圖形/端點時,
    // 在 host capture 層 stopPropagation 接管編輯(拖本體=移動、拖端點=改端點);
    // 空白處按下只清除選取、不攔截 → 平移/捏合/調軸原生進行。多指一律放行(縮放)。
    this._touchEditing = false
    this._selCaptureDown = e => {
      if (!this.active || this.tool !== 'select' || this.hidden) return
      const isTouch = e.type === 'touchstart'
      if (isTouch && e.touches.length > 1) return
      const fake = isTouch ? this._touchCoords(e) : e
      const [px, py] = this._pixelCoords(fake)
      const hh = this._handleHitTest(px, py)
      const grabId = hh ? hh.id : this._hitTest(px, py)
      if (!grabId) {
        if (this.selEditId) { this.selEditId = null; this.selectMode = null; this.opts.onSelect?.(null); this.redraw() }
        return
      }
      e.stopPropagation()
      e.preventDefault()
      const s = this.shapes.find(sh => sh.id === grabId)
      this.selEditId = grabId
      this.selectMode = hh ? hh.which : 'move'
      this.dragOrig = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, points: s.points ? s.points.map(p => [p[0], p[1]]) : undefined }
      this.dragStartD = this._toData(px, py, s.region || 'price') || [0, 0]
      this.opts.onSelect?.(s)
      this.redraw()
      if (isTouch) {
        this._touchEditing = true
      } else {
        document.addEventListener('mousemove', this._onDocMove)
        document.addEventListener('mouseup', this._onDocUp)
      }
    }
    this._selCaptureMove = e => {
      if (!this._touchEditing) return
      if (e.touches.length > 1) { this._touchEditing = false; this._cancelGesture(); return }
      e.stopPropagation()
      e.preventDefault()
      this._onDocMouseMove(this._touchCoords(e))
    }
    this._selCaptureEnd = e => {
      if (!this._touchEditing) return
      this._touchEditing = false
      e.stopPropagation()
      e.preventDefault()
      this._onDocMouseUp(this._touchCoords(e))
    }
    this._selCaptureCancel = () => {
      if (!this._touchEditing) return
      this._touchEditing = false
      this._cancelGesture()   // 中斷(來電/系統手勢):不 commit,純還原;也避免 changedTouches 為空取座標爆掉
    }
    this._selCaptureDbl = e => {
      if (!this.active || this.tool !== 'select' || this.hidden) return
      const [px, py] = this._pixelCoords(e)
      if (this._hitTest(px, py)) { e.stopPropagation(); this._onDblClick(e) }
    }
    // 選取模式 hover 游標(桌面):rAF 節流 hit-test → 圖形=move、端點=grab、空白=一般箭頭
    this._selHoverRaf = 0
    this._selHover = e => {
      if (!this.active || this.tool !== 'select' || this.hidden || this._selHoverRaf) return
      const cx = e.clientX, cy = e.clientY
      this._selHoverRaf = requestAnimationFrame(() => {
        this._selHoverRaf = 0
        if (!this.active || this.tool !== 'select') return
        const [px, py] = this._pixelCoords({ clientX: cx, clientY: cy })
        const hh = this._handleHitTest(px, py)
        const id = hh ? null : this._hitTest(px, py)
        this.host.classList.toggle('sel-hover-handle', !!hh)
        this.host.classList.toggle('sel-hover-shape', !hh && !!id)
      })
    }
    this.host.addEventListener('mousemove', this._selHover)
    this.host.addEventListener('mousedown', this._selCaptureDown, true)
    this.host.addEventListener('touchstart', this._selCaptureDown, { capture: true, passive: false })
    this.host.addEventListener('touchmove', this._selCaptureMove, { capture: true, passive: false })
    this.host.addEventListener('touchend', this._selCaptureEnd, { capture: true, passive: false })
    this.host.addEventListener('touchcancel', this._selCaptureCancel, { capture: true, passive: false })
    this.host.addEventListener('dblclick', this._selCaptureDbl, true)

    // 尺寸變化統一由 KLinePanel 的 ResizeObserver 驅動(先 chart.resize→rAF→overlay.resize),
    // 保證 overlay 用「已更新的圖表佈局」換算;此處不再自帶 observer(否則多 observer 搶跑造成畫線錯位)。

    this._syncActiveState()
    this.resize()
  }

  _syncActiveState() {
    if (!this.canvas) return
    const selMode = this.active && this.tool === 'select'
    if (this.active && !selMode) {
      this.canvas.style.pointerEvents = 'auto'
      this.canvas.style.cursor = 'crosshair'
    } else {
      // 看盤模式與「穿透式選取模式」都放行:圖表原生手勢(平移/捏合/調X/調Y/副圖)全部照常。
      // 選取模式的圖形編輯改由 host capture 層攔截(見 _selCapture*),只有命中圖形才接管。
      this.canvas.style.pointerEvents = 'none'
      this.canvas.style.cursor = 'default'
    }
    // 選取模式游標語意化:壓掉 klinecharts 的十字 crosshair(CSS !important 蓋 inline),
    // hover 命中圖形/端點時由 _selHover 切 move/grab(見 app.css .sel-mode 規則)
    this.host.classList.toggle('sel-mode', selMode)
    if (!selMode) this.host.classList.remove('sel-hover-shape', 'sel-hover-handle')
  }

  resize() {
    if (!this.canvas) return
    const dpr = window.devicePixelRatio || 1
    this.dpr = dpr
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (w === 0 || h === 0) return
    this.canvas.width = w * dpr
    this.canvas.height = h * dpr
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.ctx = this.canvas.getContext('2d')
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.scale(dpr, dpr)
    this.redraw()
  }

  // ===== 座標 helpers =====
  _pixelCoords(e) {
    const rect = this.canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  _toPix(dx, dy, region = 'price') {
    const r = this.opts.toPixel?.(dx, dy, region)
    return r || null
  }

  _toData(px, py, region = this.currentRegion) {
    const d = this.opts.fromPixel?.(px, py, region)
    return d || null
  }

  _gridRect(region) {
    return this.opts.gridRect?.(region) || null
  }

  // 依像素 y 判斷落在哪個繪圖區
  _regionAt(px, py) {
    const inRect = r => !!r && px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height
    if (inRect(this._gridRect('price'))) return 'price'
    if (inRect(this._gridRect('volume'))) return 'volume'
    return null
  }

  _clampToRegion(px, py) {
    const r = this._gridRect(this.currentRegion)
    if (!r) return [px, py]
    return [Math.max(r.x, Math.min(r.x + r.width, px)), Math.max(r.y, Math.min(r.y + r.height, py))]
  }

  // Shape 資料座標 → 渲染像素（hline/vline 延伸到該區 grid 邊界）
  _shapeToPixels(s) {
    const reg = s.region || 'price'
    const rect = this._gridRect(reg)
    const left = rect ? rect.x : 0
    const right = rect ? rect.x + rect.width : (this.canvas.width / this.dpr)
    const top = rect ? rect.y : 0
    const bottom = rect ? rect.y + rect.height : (this.canvas.height / this.dpr)
    if (s.type === 'hline') {
      const p = this._toPix(s.x1, s.y1, reg)
      if (!p) return null
      return { x1: left, y1: p[1], x2: right, y2: p[1] }
    }
    if (s.type === 'vline') {
      const p = this._toPix(s.x1, s.y1, reg)
      if (!p) return null
      return { x1: p[0], y1: top, x2: p[0], y2: bottom }
    }
    const p1 = this._toPix(s.x1, s.y1, reg)
    const p2 = this._toPix(s.x2, s.y2, reg)
    if (!p1 || !p2) return null
    return { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }
  }

  _getHandles(s) {
    if (!hasEndpointHandles(s.type)) return []
    const px = this._shapeToPixels(s)
    if (!px) return []
    return [
      { which: 'end1', x: px.x1, y: px.y1 },
      { which: 'end2', x: px.x2, y: px.y2 },
    ]
  }

  _handleHitTest(mpx, mpy) {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i]
      for (const h of this._getHandles(s)) {
        if (Math.hypot(mpx - h.x, mpy - h.y) <= HANDLE_HIT) return { id: s.id, which: h.which }
      }
    }
    return null
  }

  // ===== shape 建立 =====
  _pushShape(shape) {
    this.shapes.push({ id: makeId(), coordType: 'data', color: this.color, lineWidth: this.lineWidth, ...shape })
  }

  _emitChange() {
    this.opts.onChange?.(this.getShapes())
  }

  // ===== mouse handlers =====
  _onMouseDown(e) {
    if (e.preventDefault) e.preventDefault()
    if (!this.active) return
    const [px, py] = this._pixelCoords(e)

    // 橡皮擦：任一區直接 hitTest 刪除
    if (this.tool === 'eraser') {
      const hitId = this._hitTest(px, py)
      if (hitId) {
        this.shapes = this.shapes.filter(s => s.id !== hitId)
        this.hoverEraseId = null
        this.selEditId = null
        this._emitChange()
        this.redraw()
      }
      return
    }

    // 直接編輯既有圖形（端點優先於本體）；pendingSecondHV 時不攔截
    const hh = this.pendingSecondHV ? null : this._handleHitTest(px, py)
    const grabId = this.pendingSecondHV ? null : (hh ? hh.id : this._hitTest(px, py))
    if (grabId) {
      const s = this.shapes.find(sh => sh.id === grabId)
      this.selEditId = grabId
      this.selectMode = hh ? hh.which : 'move'
      this.dragOrig = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, points: s.points ? s.points.map(p => [p[0], p[1]]) : undefined }
      this.dragStartD = this._toData(px, py, s.region || 'price') || [0, 0]
      this.opts.onSelect?.(s)
      this.redraw()
      document.addEventListener('mousemove', this._onDocMove)
      document.addEventListener('mouseup', this._onDocUp)
      return
    }
    this.selEditId = null
    this.selectMode = null

    // select 工具：空白處 → 平移圖表（交回宿主），不畫新圖
    if (this.tool === 'select') {
      this.opts.onSelect?.(null)
      if (this.opts.panBy) {
        this.panning = true
        this.panLastPx = px; this.panLastPy = py
        document.addEventListener('mousemove', this._onDocMove)
        document.addEventListener('mouseup', this._onDocUp)
      }
      return
    }

    const reg = this._regionAt(px, py)
    if (!reg) return
    this.currentRegion = reg
    const d = this._toData(px, py, reg)
    if (!d) return
    const [dx, dy] = d

    if (this.tool === 'text') {
      this._openTextInput(px, py, dx, dy, reg)
      return
    }

    if (this.tool === 'hline' || this.tool === 'vline') {
      const push = () => {
        if (this.tool === 'hline') this._pushShape({ type: 'hline', x1: dx, y1: dy, x2: dx, y2: dy, region: reg })
        else this._pushShape({ type: 'vline', x1: dx, y1: dy, x2: dx, y2: dy, region: reg })
        this._emitChange()
      }
      if (!this.pendingSecondHV) {
        push()
        this.pendingSecondHV = true
        this.currentDx = dx; this.currentDy = dy
        this.redraw()
      } else {
        push()
        this.pendingSecondHV = false
        this.redraw()
      }
      return
    }

    this.isDrawing = true
    this.startDx = dx; this.startDy = dy
    this.startPx = px; this.startPy = py
    this.currentDx = dx; this.currentDy = dy
    if (this.tool === 'brush') this.brushPoints = [[dx, dy]]
    document.addEventListener('mousemove', this._onDocMove)
    document.addEventListener('mouseup', this._onDocUp)
  }

  _onCanvasMouseMove(e) {
    if (!this.active) return
    const [px, py] = this._pixelCoords(e)
    const d = this._toData(px, py)
    if (d) { this.currentDx = d[0]; this.currentDy = d[1] }

    if (this.tool === 'eraser') {
      const id = this._hitTest(px, py)
      if (this.canvas) this.canvas.style.cursor = id ? 'pointer' : 'crosshair'
      if (id !== this.hoverEraseId) { this.hoverEraseId = id; this.redraw() }
      return
    }
    // hover 到既有圖形 → move 游標 + 端點把手
    const onHandle = this._handleHitTest(px, py)
    const hovId = onHandle ? onHandle.id : this._hitTest(px, py)
    if (this.canvas) {
      const base = this.tool === 'select' ? 'default' : 'crosshair'
      this.canvas.style.cursor = onHandle ? 'pointer' : (hovId ? 'move' : base)
    }
    if (hovId !== this.hoverSelectId) { this.hoverSelectId = hovId; this.redraw() }
    if (this.pendingSecondHV) this.redraw()
  }

  _onCanvasMouseLeave() {
    let changed = false
    if (this.hoverEraseId !== null) { this.hoverEraseId = null; changed = true }
    if (this.hoverSelectId !== null) { this.hoverSelectId = null; changed = true }
    if (changed) this.redraw()
  }

  _applySelectDrag(e) {
    if (!this.selEditId || !this.selectMode || !this.dragOrig) return
    const s = this.shapes.find(sh => sh.id === this.selEditId)
    if (!s) return
    const reg = s.region || 'price'
    const [px, py] = this._pixelCoords(e)
    const d = this._toData(px, py, reg)
    if (!d) return
    const [cdx, cdy] = d
    if (this.selectMode === 'move') {
      const ddx = cdx - this.dragStartD[0]
      const ddy = cdy - this.dragStartD[1]
      s.x1 = this.dragOrig.x1 + ddx; s.y1 = this.dragOrig.y1 + ddy
      s.x2 = this.dragOrig.x2 + ddx; s.y2 = this.dragOrig.y2 + ddy
      if (this.dragOrig.points) s.points = this.dragOrig.points.map(p => [p[0] + ddx, p[1] + ddy])
    } else if (this.selectMode === 'end1') {
      s.x1 = cdx; s.y1 = cdy
    } else if (this.selectMode === 'end2') {
      s.x2 = cdx; s.y2 = cdy
    }
    this.redraw()
  }

  _onDocMouseMove(e) {
    if (this.panning) {
      const [px, py] = this._pixelCoords(e)
      const ddx = px - this.panLastPx
      const ddy = py - this.panLastPy
      this.panLastPx = px; this.panLastPy = py
      this.opts.panBy?.(ddx, ddy)
      this.redraw()
      return
    }
    if (this.selectMode && this.selEditId) { this._applySelectDrag(e); return }
    if (!this.isDrawing) return
    const [rpx, rpy] = this._pixelCoords(e)
    const [px, py] = this._clampToRegion(rpx, rpy)
    const d = this._toData(px, py, this.currentRegion)
    if (d) {
      this.currentDx = d[0]; this.currentDy = d[1]
      if (this.tool === 'brush') this.brushPoints.push([d[0], d[1]])
    }
    this.redraw()
  }

  _onDocMouseUp(e) {
    document.removeEventListener('mousemove', this._onDocMove)
    document.removeEventListener('mouseup', this._onDocUp)

    if (this.panning) { this.panning = false; return }

    // 完成拖曳編輯
    if (this.selectMode && this.selEditId) {
      this._applySelectDrag(e)
      const s = this.shapes.find(sh => sh.id === this.selEditId)
      const moved = !!(s && this.dragOrig && (s.x1 !== this.dragOrig.x1 || s.y1 !== this.dragOrig.y1 || s.x2 !== this.dragOrig.x2 || s.y2 !== this.dragOrig.y2))
      this.selectMode = null
      this.dragOrig = null
      if (moved) this._emitChange()
      this.redraw()
      return
    }

    if (!this.isDrawing) return
    this.isDrawing = false

    const [rpx, rpy] = this._pixelCoords(e)
    const [px, py] = this._clampToRegion(rpx, rpy)
    const d = this._toData(px, py, this.currentRegion)

    if (this.tool === 'brush') {
      const pts = this.brushPoints.slice()
      this.brushPoints = []
      if (pts.length < 2) { this.redraw(); return }
      this._pushShape({ type: 'brush', x1: pts[0][0], y1: pts[0][1], x2: pts.at(-1)[0], y2: pts.at(-1)[1], points: pts, region: this.currentRegion })
      this._emitChange()
      this.redraw()
      return
    }

    if (Math.abs(px - this.startPx) < MIN_DRAG_PX && Math.abs(py - this.startPy) < MIN_DRAG_PX) {
      this.redraw()
      return
    }
    if (!d) { this.redraw(); return }

    this._pushShape({ type: this.tool, x1: this.startDx, y1: this.startDy, x2: d[0], y2: d[1], region: this.currentRegion })
    this._emitChange()
    this.redraw()
  }

  // ===== touch =====
  _touchCoords(e) {
    const t = e.touches[0] || e.changedTouches[0]
    return { clientX: t.clientX, clientY: t.clientY, preventDefault() {} }
  }
  // 取消進行中的手勢並收乾淨(中斷/多指用):不 commit、不 emit,純還原狀態
  _cancelGesture() {
    document.removeEventListener('mousemove', this._onDocMove)
    document.removeEventListener('mouseup', this._onDocUp)
    this.panning = false
    this.isDrawing = false
    this.selectMode = null
    this.dragOrig = null
    this.brushPoints = []
    this.pendingSecondHV = false
    this.redraw()
  }
  _onTouchStart(e) {
    e.preventDefault()
    if (e.touches.length > 1) { this._cancelGesture(); return }   // 多指(pinch)→ 不當畫線,取消
    this._onMouseDown(this._touchCoords(e))
  }
  _onTouchMove(e) {
    e.preventDefault()
    if (e.touches.length > 1) { this._cancelGesture(); return }   // 拖曳中變多指 → 取消,避免亂畫/亂平移
    const fake = this._touchCoords(e)
    if (this.panning || this.isDrawing || (this.selectMode && this.selEditId)) {
      this._onDocMouseMove(fake)
    } else if (this.pendingSecondHV) {
      const [rpx, rpy] = this._pixelCoords(fake)
      const [px, py] = this._clampToRegion(rpx, rpy)
      const d = this._toData(px, py, this.currentRegion)
      if (d) { this.currentDx = d[0]; this.currentDy = d[1]; this.redraw() }
    }
  }
  _onTouchEnd(e) { e.preventDefault(); this._onDocMouseUp(this._touchCoords(e)) }

  // ===== 打字工具 =====
  _removeTextInput() {
    if (this.textInput) { this.textInput.remove(); this.textInput = null }
  }

  _openTextInput(px, py, dx, dy, region = 'price', editId) {
    this._removeTextInput()
    const editShape = editId ? this.shapes.find(sh => sh.id === editId) : null
    const fs = editShape?.fontSize || DEFAULT_FONT_SIZE
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '輸入文字…'
    input.style.cssText =
      `position:absolute;left:${px}px;top:${py}px;z-index:5;` +
      `font-size:${fs}px;line-height:1.2;color:${this.color};` +
      `background:rgba(19,19,22,.55);border:1px solid ${this.color};border-radius:4px;` +
      `padding:1px 4px;outline:none;min-width:90px;font-family:inherit;`
    this.host.appendChild(input)
    this.textInput = input
    if (editShape) input.value = editShape.text || ''

    const commit = () => {
      if (!this.textInput) return
      const val = input.value.trim()
      this._removeTextInput()
      if (editId) {
        if (!val) this.shapes = this.shapes.filter(sh => sh.id !== editId)
        else { const s = this.shapes.find(sh => sh.id === editId); if (s) s.text = val }
        this._emitChange()
        this.redraw()
        return
      }
      if (val) {
        this._pushShape({ type: 'text', x1: dx, y1: dy, x2: dx, y2: dy, text: val, fontSize: fs, region })
        this._emitChange()
        this.redraw()
      }
    }
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); this._removeTextInput() }
    })
    input.addEventListener('blur', commit)
    setTimeout(() => input.focus(), 0)
  }

  _onDblClick(e) {
    if (!this.active || this.tool === 'eraser') return
    const [px, py] = this._pixelCoords(e)
    const id = this._hitTest(px, py)
    if (!id) return
    const s = this.shapes.find(sh => sh.id === id)
    if (!s || s.type !== 'text') return
    const p = this._toPix(s.x1, s.y1, s.region || 'price')
    if (!p) return
    this._openTextInput(p[0], p[1], s.x1, s.y1, s.region || 'price', s.id)
  }

  // ===== drawing =====
  _drawShapeAbs(ctx, type, x1, y1, x2, y2, color, lineWidth, filled, override) {
    ctx.strokeStyle = override?.color ?? color
    ctx.lineWidth = override?.lineWidth ?? lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (type === 'line' || type === 'hline' || type === 'vline') {
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
    } else if (type === 'rect' || type === 'filledRect') {
      ctx.rect(x1, y1, x2 - x1, y2 - y1)
    } else if (type === 'circle' || type === 'filledCircle') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2
      if (rx > 0 && ry > 0) ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    }
    ctx.stroke()
    if (filled && !override) {
      const prev = ctx.globalAlpha
      ctx.globalAlpha = prev * 0.25
      ctx.fillStyle = color
      ctx.fill()
      ctx.globalAlpha = prev
    }
  }

  _withRegionClip(ctx, region, fn) {
    const r = this._gridRect(region)
    if (!r) { fn(); return }
    ctx.save()
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.width, r.height)
    ctx.clip()
    fn()
    ctx.restore()
  }

  _drawBrushPixels(ctx, points, color, lineWidth, region, override) {
    if (points.length < 2) return
    ctx.strokeStyle = override?.color ?? color
    ctx.lineWidth = override?.lineWidth ?? lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let started = false
    for (const [dx, dy] of points) {
      const p = this._toPix(dx, dy, region)
      if (!p) continue
      if (!started) { ctx.moveTo(p[0], p[1]); started = true }
      else ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()
  }

  _drawTextShape(ctx, s, override) {
    const p = this._toPix(s.x1, s.y1, s.region || 'price')
    if (!p) return
    const fs = s.fontSize || DEFAULT_FONT_SIZE
    ctx.font = `${fs}px "Inter", system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    if (override?.halo) {
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 6
      ctx.strokeStyle = override.color ?? s.color
      ctx.lineJoin = 'round'
      ctx.strokeText(s.text || '', p[0], p[1])
      ctx.restore()
    }
    ctx.fillStyle = override?.color ?? s.color
    ctx.fillText(s.text || '', p[0], p[1])
  }

  redraw() {
    const ctx = this.ctx
    if (!this.canvas || !ctx) return
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    ctx.clearRect(0, 0, w, h)
    if (this.hidden) return

    for (const s of this.shapes) {
      const isHover = this.tool === 'eraser' && s.id === this.hoverEraseId
      const reg = s.region || 'price'
      this._withRegionClip(ctx, reg, () => {
        if (s.type === 'brush') {
          if (s.points && s.points.length >= 2) {
            if (isHover) this._drawBrushPixels(ctx, s.points, s.color, s.lineWidth + 6, reg, { color: s.color, lineWidth: s.lineWidth + 6 })
            this._drawBrushPixels(ctx, s.points, s.color, s.lineWidth, reg)
          }
          return
        }
        if (s.type === 'text') {
          this._drawTextShape(ctx, s, isHover ? { halo: true, color: s.color } : undefined)
          return
        }
        const px = this._shapeToPixels(s)
        if (!px) return
        const isFilled = s.type === 'filledCircle' || s.type === 'filledRect'
        if (isHover) {
          ctx.save()
          ctx.globalAlpha = 0.5
          this._drawShapeAbs(ctx, s.type, px.x1, px.y1, px.x2, px.y2, s.color, s.lineWidth + 6, false)
          ctx.restore()
        }
        this._drawShapeAbs(ctx, s.type, px.x1, px.y1, px.x2, px.y2, s.color, s.lineWidth, isFilled)
      })
    }

    // 端點把手（hover / 抓取中的兩端點圖形）
    if (this.tool !== 'eraser') {
      const targetId = this.selEditId || this.hoverSelectId
      const s = targetId ? this.shapes.find(sh => sh.id === targetId) : null
      if (s) {
        this._withRegionClip(ctx, s.region || 'price', () => {
          for (const hnd of this._getHandles(s)) {
            ctx.save()
            ctx.fillStyle = '#ffffff'
            ctx.strokeStyle = s.color
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.arc(hnd.x, hnd.y, HANDLE_R, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
            ctx.restore()
          }
        })
      }
    }

    // 繪製預覽
    const rect = this._gridRect(this.currentRegion)
    const rLeft = rect ? rect.x : 0, rRight = rect ? rect.x + rect.width : w
    const rTop = rect ? rect.y : 0, rBottom = rect ? rect.y + rect.height : h
    this._withRegionClip(ctx, this.currentRegion, () => {
      if (this.isDrawing && this.tool === 'brush') {
        ctx.globalAlpha = 0.8
        this._drawBrushPixels(ctx, this.brushPoints, this.color, this.lineWidth, this.currentRegion)
        ctx.globalAlpha = 1.0
      } else if (this.isDrawing && this.tool !== 'eraser' && this.tool !== 'select') {
        const p1 = this._toPix(this.startDx, this.startDy, this.currentRegion)
        const p2 = this._toPix(this.currentDx, this.currentDy, this.currentRegion)
        if (p1 && p2) {
          ctx.globalAlpha = 0.6
          this._drawShapeAbs(ctx, this.tool, p1[0], p1[1], p2[0], p2[1], this.color, this.lineWidth, false)
          ctx.globalAlpha = 1.0
        }
      }
      if (this.pendingSecondHV) {
        const p = this._toPix(this.currentDx, this.currentDy, this.currentRegion)
        if (p) {
          ctx.globalAlpha = 0.5
          if (this.tool === 'hline') this._drawShapeAbs(ctx, 'hline', rLeft, p[1], rRight, p[1], this.color, this.lineWidth, false)
          else if (this.tool === 'vline') this._drawShapeAbs(ctx, 'vline', p[0], rTop, p[0], rBottom, this.color, this.lineWidth, false)
          ctx.globalAlpha = 1.0
        }
      }
    })
  }

  // ===== hit test（像素空間） =====
  _hitTest(mpx, mpy) {
    const ctx = this.ctx
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i]
      const reg = s.region || 'price'
      if (s.type === 'brush') {
        if (!s.points || s.points.length < 2) continue
        for (let k = 0; k < s.points.length - 1; k++) {
          const a = this._toPix(s.points[k][0], s.points[k][1], reg)
          const b = this._toPix(s.points[k + 1][0], s.points[k + 1][1], reg)
          if (a && b && pointToSegmentDist(mpx, mpy, a[0], a[1], b[0], b[1]) < HIT_THRESHOLD) return s.id
        }
        continue
      }
      if (s.type === 'text') {
        const p = this._toPix(s.x1, s.y1, reg)
        if (!p) continue
        const fs = s.fontSize || DEFAULT_FONT_SIZE
        let tw = (s.text?.length || 0) * fs * 0.6
        if (ctx) { ctx.font = `${fs}px "Inter", system-ui, sans-serif`; tw = ctx.measureText(s.text || '').width }
        if (mpx >= p[0] - 4 && mpx <= p[0] + tw + 4 && mpy >= p[1] - 4 && mpy <= p[1] + fs + 4) return s.id
        continue
      }
      const px = this._shapeToPixels(s)
      if (!px) continue
      const { x1, y1, x2, y2 } = px
      if (s.type === 'line' || s.type === 'hline' || s.type === 'vline') {
        if (pointToSegmentDist(mpx, mpy, x1, y1, x2, y2) < HIT_THRESHOLD) return s.id
      } else if (s.type === 'rect' || s.type === 'filledRect') {
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2)
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2)
        if (s.type === 'filledRect') {
          if (mpx >= minX && mpx <= maxX && mpy >= minY && mpy <= maxY) return s.id
        } else if (
          pointToSegmentDist(mpx, mpy, minX, minY, maxX, minY) < HIT_THRESHOLD ||
          pointToSegmentDist(mpx, mpy, maxX, minY, maxX, maxY) < HIT_THRESHOLD ||
          pointToSegmentDist(mpx, mpy, maxX, maxY, minX, maxY) < HIT_THRESHOLD ||
          pointToSegmentDist(mpx, mpy, minX, maxY, minX, minY) < HIT_THRESHOLD
        ) return s.id
      } else if (s.type === 'circle' || s.type === 'filledCircle') {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2
        if (rx > 0 && ry > 0) {
          const ndx = (mpx - cx) / rx, ndy = (mpy - cy) / ry
          const dist = Math.hypot(ndx, ndy)
          if (s.type === 'filledCircle') { if (dist <= 1) return s.id }
          else if (Math.abs(dist - 1) * ((rx + ry) / 2) < HIT_THRESHOLD) return s.id
        }
      }
    }
    return null
  }
}
