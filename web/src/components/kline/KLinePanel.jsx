import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Cloud, Database, LoaderCircle, Rows2,
} from 'lucide-react'
import { dispose, init, registerLocale } from 'klinecharts'
import KLineToolbar from './KLineToolbar.jsx'
import SegToggle from './SegToggle.jsx'
import PillSelect from './PillSelect.jsx'
import { loadCbKLineDocument, loadKLineDocument } from '../../kline/klineService.js'
import { DrawingHistory } from '../../kline/drawingHistory.js'
import { fetchCloudShapes, loadShapes, pushCloudShapes, saveShapes } from '../../kline/drawingRepository.js'
import { PERIODS } from '../../kline/schema.js'
import { cooperativeZoomFactor, wheelIntent } from '../../kline/interaction.js'
import brandMark from '../../assets/brand_mark.svg'
import DrawingOverlay from '../../kline/DrawingOverlay.js'

const DEFAULT_COLOR = '#D8DBE0'
const CANDLE_PANE = 'candle_pane'
const SUB_PANE = 'signal_sub_pane'     // 副圖1 paneId(overlay 也引用它算成交量區座標)
const SUB_PANE_2 = 'signal_sub_pane_2' // 副圖2 paneId
const SUB_OPTS = [{ value: 'MACD', label: 'MACD' }, { value: 'KDJ', label: 'KDJ' }, { value: 'VOL', label: '量' }, { value: 'RSI', label: 'RSI' }, { value: 'NONE', label: '無' }]
const SUB_HEIGHT = 30                // 每個副圖預設=klinecharts 真最小高(主圖 K 棒區最大化);要看大再用把手往上拖
const ZH_TW_LOCALE = {
  time: '時間：', open: '開：', high: '高：', low: '低：', close: '收：',
  volume: '成交量：', turnover: '成交額：', change: '漲幅：',
  second: '秒', minute: '分', hour: '小時', day: '日', week: '週', month: '月', year: '年',
}
const CHART_FONT = '"Noto Sans TC", "PingFang TC", "Segoe UI", sans-serif'   // 圖上文字用我們的字體(非新細明體)
const LINE_COLORS = ['#C9CBD1', '#93A7C4', '#A79BB5']   // 指標線色(薰衣草/柔藍/柔玫瑰);自製 legend 依序上色對齊線
const CHART_STYLES = {
  grid: {
    horizontal: { color: 'rgba(236,236,238,.10)', size: 1, style: 'dashed', dashedValue: [3, 3] },
    vertical: { color: 'rgba(236,236,238,.07)', size: 1, style: 'dashed', dashedValue: [3, 3] },
  },
  candle: {
    bar: {
      upColor: '#FF5C5C', downColor: '#3DD68C', noChangeColor: '#C9CBD1',
      upBorderColor: '#FF5C5C', downBorderColor: '#3DD68C', noChangeBorderColor: '#C9CBD1',
      upWickColor: '#FF5C5C', downWickColor: '#3DD68C', noChangeWickColor: '#C9CBD1',
    },
    tooltip: { showRule: 'none' },        // OHLC 讀值已在 panel 頂列,關掉圖內重複 legend(不壓在 K 棒上)
  },
  indicator: {
    tooltip: { showRule: 'none' },         // 關掉 klinecharts 內建 legend,改用自製 HTML overlay(數字留頂部原位+各自底色)
    // 指標線色=主題常規線色(薰衣草/柔藍/柔玫瑰),不搶眼的金、也不是預設近白。MA/BOLL/MACD/KDJ/RSI 依序循環。
    lines: [{ color: LINE_COLORS[0] }, { color: LINE_COLORS[1] }, { color: LINE_COLORS[2] }],
  },
  xAxis: { axisLine: { color: 'rgba(236,236,238,.18)' }, tickText: { color: '#8A8F98', family: CHART_FONT } },
  yAxis: { axisLine: { color: 'rgba(236,236,238,.18)' }, tickText: { color: '#8A8F98', family: CHART_FONT } },
  crosshair: {
    horizontal: { line: { color: '#D8DBE0', size: 1, style: 'dashed', dashedValue: [4, 4] } },
    vertical: { line: { color: '#D8DBE0', size: 1, style: 'dashed', dashedValue: [4, 4] } },
  },
  // 分隔線:兩條都用同一條低調細線(可見度一致);抓取靠自製把手,不靠這條
  separator: { size: 1, color: 'rgba(255,255,255,.16)', fill: true, activeBackgroundColor: 'rgba(216,219,224,.3)' },
}

const periodFromChart = period => Object.entries(PERIODS).find(([, value]) => value.type === period.type)?.[0] || 'day'
const formatNumber = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits })
  : '—'
const formatDate = timestamp => new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',   // 去年份,只留 MM/DD(省空間)
}).format(timestamp)

/* fixedTrack:'stock'|'cb'(分割模式用)=鎖定標的、藏切換 seg;splitControl:{active,available,onToggle}=分割開關鈕
   syncBus+syncRole('lead'|'follow'):分割同步匯流排——十字線/時間窗雙向鏡射,週期/指標 lead→follow 單向跟隨
   hideControls:follow 格藏完整控制列(規格 17:控制不複製,只留軌標籤+OHLC) */
export default function KLinePanel({ row, focusMode = false, onFocusModeChange, onShowDetails, fixedTrack = null, splitControl = null, syncBus = null, syncRole = null, hideControls = false, hideToolbar = false, axisSide = null }) {
  const hostRef = useRef(null)
  const chartRef = useRef(null)
  const overlayRef = useRef(null)
  const documentRef = useRef(null)
  const periodRef = useRef('day')
  const stkRef = useRef(null)          // 當前現股代號(loadDrawings 競態守衛:換股後丟棄舊的雲端回應)
  const trackPeriodRef = useRef({})    // 各軌(stock/cb)最後使用的週期:切軌維持原時間區,不再一律跳走
  const historyRef = useRef(new DrawingHistory(80))
  const zoomHintTimerRef = useRef(null)
  const defaultBarSpaceRef = useRef(null)
  const paneHeightsRef = useRef({ [SUB_PANE]: SUB_HEIGHT, [SUB_PANE_2]: SUB_HEIGHT })   // 副圖高度(縮放後保留;重建圖表時套用)
  const h1Ref = useRef(null)   // 副圖拖曳把手:主圖↔副1
  const h2Ref = useRef(null)   // 副圖拖曳把手:副1↔副2
  const legRefs = [useRef(null), useRef(null), useRef(null)]   // 自製指標 legend:主圖 / 副1 / 副2

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState('day')
  const [track, setTrack] = useState(fixedTrack || 'stock')   // 'stock'=現股(訊號來源) / 'cb'=可轉債自身
  const [cbAvailable, setCbAvailable] = useState(false)
  const [docVersion, setDocVersion] = useState(0)
  const [sub1, setSub1] = useState('MACD')        // 副圖1(預設 MACD)
  const [sub2, setSub2] = useState('KDJ')         // 副圖2(預設 KDJ);各自可切 MACD/KDJ/量/RSI
  const [mainInd, setMainInd] = useState('MA')    // 主圖疊加:MA 均線 / BOLL 布林(互斥二選一)
  const [activeTool, setActiveTool] = useState(null)   // null=看盤模式(overlay pass-through)
  const tapEnteredSelectRef = useRef(false)            // 選取模式是「點線」進入的 → 點空白一鍵回看盤;工具列進入的不受影響
  const [selected, setSelected] = useState(null)
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [lineWidth, setLineWidth] = useState(2)
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })
  const [hasDrawings, setHasDrawings] = useState(false)
  const [bar, setBar] = useState(null)
  const [storageState, setStorageState] = useState({ kind: 'loading', scope: 'device', message: '載入畫線中' })
  const [zoomHint, setZoomHint] = useState(false)

  periodRef.current = period
  stkRef.current = row.stkCode

  const updateHistoryState = useCallback(() => {
    const history = historyRef.current
    setHistoryState({ canUndo: history.canUndo(), canRedo: history.canRedo() })
    setHasDrawings((overlayRef.current?.getShapes().length || 0) > 0)
  }, [])

  const persistShapes = useCallback(async shapes => {
    setStorageState(state => ({ ...state, kind: 'saving', message: '儲存中' }))
    try {
      await saveShapes(row.stkCode, periodRef.current, shapes)   // 本地一定先存(離線保底)
    } catch (reason) {
      setStorageState({ kind: 'error', scope: 'device', message: reason?.message || '畫線儲存失敗' })
      return
    }
    // 登入 → 雲端同步(照關注清單:整包 PUT,失敗沿用本地、下次變更再試)
    const cloud = await pushCloudShapes(row.stkCode, periodRef.current, shapes)
    setStorageState(cloud
      ? { kind: 'saved', scope: 'cloud', message: '已同步雲端' }
      : { kind: 'saved', scope: 'device', message: '已儲存在此裝置' })
  }, [row.stkCode])

  // overlay 有實際變更 → 推進歷史 + 存檔
  const commit = useCallback(shapes => {
    const next = shapes || overlayRef.current?.getShapes() || []
    historyRef.current.push(next)
    updateHistoryState()
    persistShapes(next)
  }, [persistShapes, updateHistoryState])

  const loadDrawings = useCallback(async nextPeriod => {
    // 本地先上(毫秒級,畫線立即可見)→ 雲端背景抓,到了「無感替換」;
    // 若使用者這段期間已動手畫,不覆蓋(以本地為準,下次儲存整包推上雲=最後寫的贏)。
    setStorageState({ kind: 'loading', scope: 'device', message: '載入畫線中' })
    const sym = row.stkCode
    let localShown = []
    try {
      localShown = await loadShapes(sym, nextPeriod)
      if (periodRef.current !== nextPeriod || stkRef.current !== sym) return
      historyRef.current.reset(localShown)
      overlayRef.current?.setShapes(localShown)
      setSelected(null)
      updateHistoryState()
      setStorageState({ kind: 'syncing', scope: 'device', message: '雲端畫線同步中' })
    } catch (reason) {
      setStorageState({ kind: 'error', scope: 'device', message: reason?.message || '畫線載入失敗' })
    }
    try {
      const cloud = await fetchCloudShapes(sym, nextPeriod)
      if (periodRef.current !== nextPeriod || stkRef.current !== sym) return
      if (!cloud) {   // 未登入/後端不可用 → 維持本地
        setStorageState({ kind: 'saved', scope: 'device', message: '裝置畫線已載入' })
        return
      }
      if (!cloud.shapes.length && localShown.length) {
        // 資料保全鐵則:雲端「空」、本地「有」(未登入時期畫的/還沒同步過)→ 以本地為準反向推上雲。
        // 絕不讓空雲端吞掉本地畫線(watchlist 的本地獨有合併,同精神)。
        const pushed = await pushCloudShapes(sym, nextPeriod, localShown)
        setStorageState(pushed
          ? { kind: 'saved', scope: 'cloud', message: '本地畫線已上傳雲端' }
          : { kind: 'saved', scope: 'device', message: '裝置畫線已載入' })
        return
      }
      saveShapes(sym, nextPeriod, cloud.shapes).catch(() => {})   // 寫回離線快取
      const current = overlayRef.current?.getShapes() || []
      if (JSON.stringify(current) === JSON.stringify(localShown)) {   // 使用者沒動 → 換上雲端正本
        historyRef.current.reset(cloud.shapes)
        overlayRef.current?.setShapes(cloud.shapes)
        setSelected(null)
        updateHistoryState()
      }
      setStorageState({ kind: 'saved', scope: 'cloud', message: '雲端畫線已載入' })
    } catch {
      setStorageState({ kind: 'saved', scope: 'device', message: '裝置畫線已載入' })
    }
  }, [row.stkCode, updateHistoryState])

  useEffect(() => {   // 探測這檔 CB 有沒有自身 K 線
    const controller = new AbortController()
    setCbAvailable(false)
    loadCbKLineDocument(row.code, controller.signal)
      .then(document => setCbAvailable(Boolean(document)))
      .catch(() => setCbAvailable(false))
    return () => controller.abort()
  }, [row.code])

  useEffect(() => {   // 依標的軌載入:現股或 CB 自身
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const loader = track === 'cb'
      ? loadCbKLineDocument(row.code, controller.signal)
      : loadKLineDocument(row.stkCode, controller.signal)
    loader
      .then(document => {
        if (!document && track === 'cb') {
          // 鎖定轉債軌(分割右格)時不能改切現股 → 顯示明確空狀態;一般模式維持自動退回現股
          if (fixedTrack === 'cb') { setError('此檔可轉債無自身 K 線資料'); setLoading(false); return }
          setTrack('stock'); return
        }
        documentRef.current = document
        // 維持原時間區(使用者回報):優先用「本軌上次使用的週期」,其次沿用當前週期;
        // 只有目標週期在本軌真的無資料才退階(hour→day→week→month 依可用序),不再一律跳週。
        const wanted = trackPeriodRef.current[track] || period
        const usable = ['hour', 'day', 'week', 'month'].filter(k => document?.periods?.[k]?.length)
        if (document?.periods?.[wanted]?.length) {
          if (wanted !== period) setPeriod(wanted)
        } else if (usable.length && !usable.includes(period)) {
          setPeriod(usable.includes('day') ? 'day' : usable[0])
        }
        setDocVersion(version => version + 1)
        setLoading(false)
      })
      .catch(reason => {
        if (reason.name !== 'AbortError') { setError(reason.message || 'K 線讀取失敗'); setLoading(false) }
      })
    return () => controller.abort()
  }, [row.stkCode, row.code, track])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loading || error || !hostRef.current || !documentRef.current) return undefined
    registerLocale('zh-TW', ZH_TW_LOCALE)
    const chart = init(hostRef.current, {
      locale: 'zh-TW',
      timezone: 'Asia/Taipei',
      styles: CHART_STYLES,
      hotkey: { enabled: true, exclude: ['input', 'textarea', 'select'] },
      // 分割鏡像軸(規格 17 v3):左格所有 pane 的 Y 軸放左外緣,兩圖 K 棒在中間相鄰、消掉數值溝
      ...(axisSide === 'left' ? { layout: { yAxis: { position: 'left' } } } : {}),
    })
    if (!chart) { setError('K 線初始化失敗'); return undefined }
    chartRef.current = chart
    chart.setDataLoader({
      getBars: ({ type, period: chartPeriod, callback }) => {
        const key = periodFromChart(chartPeriod)
        const bars = documentRef.current?.periods[key] || []
        callback(type === 'init' ? bars : [], false)
        if (type === 'init' && key === periodRef.current) setBar(bars.at(-1) || null)
      },
    })
    chart.setSymbol({ ticker: track === 'cb' ? String(row.code) : String(row.stkCode),
      pricePrecision: (track === 'cb' ? row.cbPx : row.stkPx) >= 500 ? 1 : 2, volumePrecision: 0 })
    chart.setPeriod(PERIODS[period])
    if (mainInd === 'MA') chart.createIndicator({ name: 'MA', paneId: CANDLE_PANE, calcParams: [5, 20, 60] }, false)
    else if (mainInd === 'BOLL') chart.createIndicator({ name: 'BOLL', paneId: CANDLE_PANE }, false)   // 'NONE'=主圖不疊加
    // 兩個副圖各自獨立 pane、分隔線可拖曳縮放(觸控也行);'NONE'=該副圖不出現。
    // order 固定堆疊順序(sub1 在上、sub2 在下),否則重建 pane 時 klinecharts 會把它排到最後、按鈕↔副圖錯位。
    // 高度取自 paneHeightsRef(縮放後保留);dragEnabled:false=關掉 klinecharts 原生分隔線(靠自製把手)
    const ph = paneHeightsRef.current
    if (sub1 !== 'NONE') { chart.createIndicator({ name: sub1, paneId: SUB_PANE }, false); chart.setPaneOptions({ id: SUB_PANE, height: ph[SUB_PANE] || SUB_HEIGHT, dragEnabled: false, order: 10 }) }
    if (sub2 !== 'NONE') { chart.createIndicator({ name: sub2, paneId: SUB_PANE_2 }, false); chart.setPaneOptions({ id: SUB_PANE_2, height: ph[SUB_PANE_2] || SUB_HEIGHT, dragEnabled: false, order: 20 }) }
    defaultBarSpaceRef.current = chart.getBarSpace().bar
    const onCrosshair = event => {
      // klinecharts 10 的 onCrosshairChange 只給像素 {x,y,paneId},要自己換算成 dataIndex(Point.dataIndex)
      const bars = documentRef.current?.periods?.[periodRef.current] || []
      let idx
      if (event && event.x != null && event.paneId) {
        const p = chart.convertFromPixel([{ x: event.x, y: event.y ?? 0 }], { paneId: event.paneId })
        idx = (Array.isArray(p) ? p[0] : p)?.dataIndex
      }
      const hovered = (idx != null && idx >= 0 && idx < bars.length) ? bars[idx] : (bars.at(-1) || null)
      setBar(hovered)
      updateLegends(idx)
    }
    chart.subscribeAction('onCrosshairChange', onCrosshair)

    // ===== 自製畫線 overlay：座標三函式用 klinecharts 10 實作 =====
    const paneOf = region => (region === 'volume' ? SUB_PANE : CANDLE_PANE)
    const toPixel = (x, y, region) => {
      const c = chart.convertToPixel({ timestamp: x, value: y }, { paneId: paneOf(region), absolute: true })
      const pt = Array.isArray(c) ? c[0] : c
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null
      return [pt.x, pt.y]
    }
    const fromPixel = (px, py, region) => {
      const p = chart.convertFromPixel([{ x: px, y: py }], { paneId: paneOf(region), absolute: true })
      const pt = Array.isArray(p) ? p[0] : p
      if (!pt || !Number.isFinite(pt.timestamp) || !Number.isFinite(pt.value)) return null
      return [pt.timestamp, pt.value]
    }
    const gridRect = region => {
      const root = chart.getSize(paneOf(region), 'root')
      if (!root) return null
      const axis = chart.getSize(paneOf(region), 'yAxis')
      const axisWidth = axis?.width || 0   // Y 軸預設在右側 → 從右邊扣掉
      return { x: root.left, y: root.top, width: Math.max(0, root.width - axisWidth), height: root.height }
    }

    const overlay = new DrawingOverlay(hostRef.current, {
      toPixel, fromPixel, gridRect,
      getColor: () => color, getLineWidth: () => lineWidth,
      onChange: shapes => commit(shapes),
      onSelect: shape => {
        if (!shape) { setSelected(null); return }
        setSelected({ id: shape.id, type: shape.type, color: shape.color, lineWidth: shape.lineWidth })
        setColor(shape.color); setLineWidth(shape.lineWidth)
      },
      // select 模式空白處拖曳 → 平移圖表。ddx=手指位移(向右為正);scrollByDistance 與原生拖曳同號
      // (store.scroll 正值=內容跟手指),取負會反向。
      panBy: ddx => chart.scrollByDistance(ddx),
      // 看盤模式乾淨單擊命中已畫圖形 → 直接進選取模式並選中該圖形(免先開工具列切選取)
      onShapeTap: shape => {
        tapEnteredSelectRef.current = true
        setActiveTool('select')
        const ov = overlayRef.current
        if (!ov) return
        ov.setTool('select')
        ov.setActive(true)
        ov.selectShape(shape.id)
      },
      // 選取模式乾淨單擊空白處:若是「點線」進入的,直接回看盤模式(工具列進入的只取消選取)
      onEmptyTap: () => {
        if (!tapEnteredSelectRef.current) return
        tapEnteredSelectRef.current = false
        setActiveTool(null)
        setSelected(null)
        const ov = overlayRef.current
        ov?.setTool('select')
        ov?.setActive(false)
      },
    })
    overlayRef.current = overlay

    // 掛進 klinecharts 版面事件(重排完成後才觸發)→ 把手/legend 一律定位到當下真實 pane 座標,跨裝置不飄
    const redrawOverlay = () => { overlayRef.current?.redraw(); updateHandles(); updateLegends() }
    chart.subscribeAction('onScroll', redrawOverlay)
    chart.subscribeAction('onZoom', redrawOverlay)
    chart.subscribeAction('onVisibleRangeChange', redrawOverlay)

    // 捏合/Ctrl+滾輪等比縮放:klinecharts 原生 zoom 只縮 X(bar 間距),Y 靠自動貼合、不等比。
    // 包一層 store.zoom,X 實際縮放多少倍、Y 就用庫內建 _zoomYAxis 縮同倍
    // (_zoomYAxis 會完整更新 range 的 real/display 欄位並觸發 layout;只改 from/to 畫面不會動)。
    // _zoomYAxis 內的 setRange 會把 Y 軸切成手動模式(縮放後不再自動貼合,與主流看盤軟體一致);
    // 換股/換週期重建圖表時回到自動貼合。拖 X 軸的縮放(tag==='xAxis')維持只縮 X。
    const chartStore = chart._chartStore || chart.getChartStore()
    const chartEvent = chart._chartEvent
    const candleYAxis = () => chart._candlePane?.getYAxisComponents?.()[0]
    const originalZoom = chartStore.zoom.bind(chartStore)
    let zooming = false
    chartStore.zoom = (scale, coordinate, tag) => {
      if (zooming) return originalZoom(scale, coordinate, tag)
      const barSpaceBefore = chartStore.getBarSpace().bar
      zooming = true
      let result
      try { result = originalZoom(scale, coordinate, tag) } finally { zooming = false }
      const factor = chartStore.getBarSpace().bar / barSpaceBefore
      if (tag !== 'xAxis' && Number.isFinite(factor) && Math.abs(factor - 1) > 1e-4) {
        const yAxis = candleYAxis()
        if (yAxis && chartEvent?._zoomYAxis) chartEvent._zoomYAxis(yAxis, 1 / factor)
      }
      return result
    }

    // 畫線永遠黏住 K 棒的根本機制:一條常駐 rAF 迴圈,每幀檢查「圖表幾何簽章」(Y 範圍 + 繪圖區
    // 左右像素邊界),只要 Y 或 X(寬度/縮放/平移/面板 resize/動畫)任一改變就重繪 overlay。
    // klinecharts 的 K 棒渲染時機無法精準對接;改用「每幀盯著實際幾何、變了就跟」→ overlay 至多落後
    // 一幀(≈16ms,肉眼無感)、且絕不殘留偏移。取代之前想精準對接單次重繪的所有做法。
    let geoWatchId = 0
    let lastGeoKey = ''
    const geoSignature = () => {
      const y = candleYAxis()?.getRange?.()
      // 繪圖區左右邊界像素:用兩個固定資料索引的 convertToPixel.x 當 X 幾何簽章(寬度/平移/縮放都會變)
      let xa = 0, xb = 0
      try {
        const vr = chart.getVisibleRange()
        const pa = chart.convertToPixel({ dataIndex: vr.from }, { paneId: CANDLE_PANE, absolute: true })
        const pb = chart.convertToPixel({ dataIndex: vr.to }, { paneId: CANDLE_PANE, absolute: true })
        xa = Math.round((Array.isArray(pa) ? pa[0] : pa)?.x || 0)
        xb = Math.round((Array.isArray(pb) ? pb[0] : pb)?.x || 0)
      } catch (e) { /* noop */ }
      return `${y ? y.from.toFixed(3) + '_' + y.to.toFixed(3) : ''}|${xa}_${xb}`
    }
    const watchGeo = () => {
      const key = geoSignature()
      if (lastGeoKey && key !== lastGeoKey) redrawOverlay()
      lastGeoKey = key
      geoWatchId = requestAnimationFrame(watchGeo)
    }
    geoWatchId = requestAnimationFrame(watchGeo)

    // 尺寸變化管線:根治「resize 時 K 棒重排、畫線跟圖相對位置跑掉」。
    // klinecharts 預設 resize=固定 bar 間距、改變可見範圍(重排/換一批 K 棒顯示)→ 面板縮放時整張圖
    // 的 K 棒視窗會變、線雖黏在資料點但相對畫面跑掉。解法:resize 後按「寬度比例」縮放 bar 間距,
    // 使可見 K 棒數量不變 → 同一批 K 棒等比填滿新寬度(真等比縮放),線與 K 棒相對位置完全不動。
    // 重繪 overlay 排 microtask(FIFO 排在 chart _layout 之後),用更新後幾何換算,與 K 棒同幀對齊。
    const resizeStore = chart._chartStore || chart.getChartStore?.()
    let lastPlotW = hostRef.current?.clientWidth || 0
    const observer = new ResizeObserver(() => {
      const newW = hostRef.current?.clientWidth || 0
      chart.resize()   // 內部排入 _layout microtask
      Promise.resolve().then(() => {
        if (resizeStore && lastPlotW > 0 && newW > 0 && Math.abs(newW - lastPlotW) > 1) {
          try {
            const bs = resizeStore.getBarSpace().bar
            const next = bs * (newW / lastPlotW)   // 寬度變幾倍,bar 間距就變幾倍 → 可見範圍不變
            if (Number.isFinite(next) && next > 0) resizeStore.setBarSpace(next)
          } catch (e) { /* barSpace 超出上下限時 setBarSpace 自動忽略,不影響 */ }
        }
        lastPlotW = newW
        overlayRef.current?.resize()   // 幾何更新後才換算 → 同幀對齊
        updateHandles(); updateLegends()
      })
    })
    observer.observe(hostRef.current)
    loadDrawings(period)
    requestAnimationFrame(() => { updateHandles(); updateLegends() })   // 首次佈局完成後定位把手 + legend
    return () => {
      observer.disconnect()
      cancelAnimationFrame(geoWatchId)
      window.clearTimeout(zoomHintTimerRef.current)
      chart.unsubscribeAction('onCrosshairChange', onCrosshair)
      chart.unsubscribeAction('onScroll', redrawOverlay)
      chart.unsubscribeAction('onZoom', redrawOverlay)
      chart.unsubscribeAction('onVisibleRangeChange', redrawOverlay)
      overlayRef.current?.destroy()
      overlayRef.current = null
      dispose(chart)
      chartRef.current = null
    }
  // Chart lifecycle is intentionally tied to the selected stock/document only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, docVersion])

  useEffect(() => {
    const host = hostRef.current
    if (!host || loading || error) return undefined
    const onWheel = event => {
      const intent = wheelIntent({ focusMode, activeTool, ctrlKey: event.ctrlKey, metaKey: event.metaKey })
      if (intent === 'chart' || intent === 'drawing') return
      event.stopPropagation()
      if (intent === 'cooperative-zoom') {
        event.preventDefault()
        const bounds = host.getBoundingClientRect()
        const coordinate = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        chartRef.current?.zoomAtCoordinate(cooperativeZoomFactor(event.deltaY), coordinate)
        overlayRef.current?.redraw()
        return
      }
      if (!window.localStorage.getItem('signal-kline-cooperative-hint')) {
        setZoomHint(true)
        window.localStorage.setItem('signal-kline-cooperative-hint', 'shown')
        window.clearTimeout(zoomHintTimerRef.current)
        zoomHintTimerRef.current = window.setTimeout(() => setZoomHint(false), 2200)
      }
    }
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => host.removeEventListener('wheel', onWheel, { capture: true })
  }, [activeTool, error, focusMode, loading])

  const switchPeriod = async next => {
    if (next === period || !chartRef.current) return
    trackPeriodRef.current[track] = next   // 記住本軌使用者選的週期(切軌時沿用/恢復)
    await persistShapes(overlayRef.current?.getShapes() || [])
    setPeriod(next)
    periodRef.current = next
    setSelected(null)
    chartRef.current.setPeriod(PERIODS[next])
    setBar(documentRef.current?.periods[next]?.at(-1) || null)
    await loadDrawings(next)
    overlayRef.current?.redraw()
    requestAnimationFrame(updateLegends)
  }

  // 主圖疊加 均線/布林/無(互斥;無=移除疊加、只留 K 棒)
  const switchMain = next => {
    const chart = chartRef.current
    if (!chart || next === mainInd) return
    if (mainInd !== 'NONE') chart.removeIndicator({ paneId: CANDLE_PANE, name: mainInd })
    if (next === 'MA') chart.createIndicator({ name: 'MA', paneId: CANDLE_PANE, calcParams: [5, 20, 60] }, false)
    else if (next === 'BOLL') chart.createIndicator({ name: 'BOLL', paneId: CANDLE_PANE }, false)
    setMainInd(next)
    overlayRef.current?.resize()
    requestAnimationFrame(updateLegends)
  }

  // 切某個副圖的指標(只動該 pane;收合時只更新狀態,展開時套用)
  const switchSub = (paneId, current, setCurrent, next) => {
    const chart = chartRef.current
    if (!chart || next === current) return
    chart.removeIndicator({ paneId })   // 清掉整個副圖 pane(選「無」就此消失)
    if (next !== 'NONE') {
      chart.createIndicator({ name: next, paneId }, false)
      chart.setPaneOptions({ id: paneId, height: paneHeightsRef.current[paneId] || SUB_HEIGHT, dragEnabled: false, order: paneId === SUB_PANE ? 10 : 20 })
    }
    overlayRef.current?.resize()
    requestAnimationFrame(() => { updateHandles(); updateLegends() })
    setCurrent(next)
  }

  // ── 分割同步(規格 17)──
  // 週期/指標:lead 每次變更 publish,follow 用最新閉包 ref 套用(避免 switch* 非 useCallback 造成 effect 依賴翻攪)
  const syncApplyRef = useRef(null)
  syncApplyRef.current = s => {
    if (!s) return
    if (s.period !== periodRef.current && documentRef.current?.periods?.[s.period]?.length) switchPeriod(s.period)
    if (s.mainInd !== mainInd) switchMain(s.mainInd)
    if (s.sub1 !== sub1) switchSub(SUB_PANE, sub1, setSub1, s.sub1)
    if (s.sub2 !== sub2) switchSub(SUB_PANE_2, sub2, setSub2, s.sub2)
  }
  // v3:週期/指標的真相源在 App 全域帶(bus.publish),兩格一律訂閱套用(缺該週期的格守門跳過)
  useEffect(() => {
    if (!syncBus) return undefined
    return syncBus.subscribe(s => syncApplyRef.current?.(s))
  }, [syncBus, syncRole])
  // 十字線/時間窗:雙向鏡射;bus.lock + 已對齊即跳過,防 ping-pong
  useEffect(() => {
    const bus = syncBus
    const chart = chartRef.current
    if (!bus || !chart || loading || error) return undefined
    bus.peers[syncRole] = chart
    syncApplyRef.current?.(bus.state)   // 圖表就緒後補套用全域帶狀態(早前 publish 時本格可能還沒 ready)
    const peerChart = () => { const p = bus.peers[syncRole === 'lead' ? 'follow' : 'lead']; return p && p !== chart ? p : null }
    const peerStore = peer => peer._chartStore || peer.getChartStore?.()
    // 驅動者模型:只有滑鼠所在(進入/按下/滾輪)那張圖能發同步;對側被程式捲動的回彈事件一律忽略,
    // 否則兩張圖 timestamps 不完全對齊時會互相拉扯(左動右不動的打架現象)。
    const claim = () => { if (bus.driver !== syncRole) { bus.driver = syncRole; bus.notify?.() } }
    const isDriver = () => bus.driver === syncRole
    // ★payload 只有 {x,y,paneId} 沒 timestamp(klinecharts 回拋原始參數);timestamp 從自己 store 的
    //   enriched crosshair 拿。「移開」不會發 action(paneId undefined 被 isString 擋)→ 清除掛 pointerleave。
    const onCross = d => {
      if (bus.lock || !isDriver()) return
      const peer = peerChart(); if (!peer) return
      bus.lock = true
      try {
        const own = (chart._chartStore || chart.getChartStore?.())?.getCrosshair?.() || {}
        if (own.timestamp != null) {
          const px = peer.convertToPixel({ timestamp: own.timestamp }, { paneId: CANDLE_PANE })
          const x = Array.isArray(px) ? px[0]?.x : px?.x
          if (Number.isFinite(x)) peerStore(peer)?.setCrosshair({ x, y: own.y ?? d?.y ?? 1, paneId: own.paneId || CANDLE_PANE }, { notExecuteAction: true })
        }
      } catch { /* 對側未就緒 */ }
      bus.lock = false
    }
    const onLeave = () => {   // 滑鼠離開本圖 → 清對側鏡射十字線
      const peer = peerChart(); if (!peer) return
      try { peerStore(peer)?.setCrosshair(undefined, { notExecuteAction: true }) } catch { /* noop */ }
    }
    const hostEl = hostRef.current
    const lastTs = c => {   // 這張圖可視範圍右端的 timestamp(以自身資料換算)
      try {
        const vr = c.getVisibleRange?.(); if (!vr) return null
        const dl = c.getDataList?.() || []
        return dl[Math.max(0, Math.min((vr.realTo ?? vr.to) - 1, dl.length - 1))]?.timestamp ?? null
      } catch { return null }
    }
    const onRange = () => {
      if (bus.lock || !isDriver()) return
      const peer = peerChart(); if (!peer) return
      bus.lock = true
      try {
        const bs = chart.getBarSpace?.(); const pbs = peer.getBarSpace?.()
        const bsV = typeof bs === 'number' ? bs : bs?.bar
        const pbsV = typeof pbs === 'number' ? pbs : pbs?.bar
        if (Number.isFinite(bsV) && Number.isFinite(pbsV) && Math.abs(bsV - pbsV) > .01) peerStore(peer)?.setBarSpace?.(bsV)
        const ts = lastTs(chart)
        if (ts != null && lastTs(peer) !== ts) peer.scrollToTimestamp?.(ts, 0)
      } catch { /* 對側未就緒 */ }
      bus.lock = false
    }
    chart.subscribeAction('onCrosshairChange', onCross)
    chart.subscribeAction('onVisibleRangeChange', onRange)
    hostEl?.addEventListener('pointerenter', claim)
    hostEl?.addEventListener('pointerdown', claim)
    hostEl?.addEventListener('wheel', claim, { passive: true })
    hostEl?.addEventListener('touchstart', claim, { passive: true })
    hostEl?.addEventListener('pointerleave', onLeave)
    return () => {
      chart.unsubscribeAction('onCrosshairChange', onCross)
      chart.unsubscribeAction('onVisibleRangeChange', onRange)
      hostEl?.removeEventListener('pointerenter', claim)
      hostEl?.removeEventListener('pointerdown', claim)
      hostEl?.removeEventListener('wheel', claim)
      hostEl?.removeEventListener('touchstart', claim)
      hostEl?.removeEventListener('pointerleave', onLeave)
      if (bus.peers[syncRole] === chart) delete bus.peers[syncRole]
    }
  }, [syncBus, syncRole, loading, error, docVersion])   // eslint-disable-line react-hooks/exhaustive-deps

  // 自製副圖拖曳把手:定位到 pane 邊界,pointer 拖曳改 pane 高度(觸控保證可用,不靠 klinecharts 分隔線)
  const updateHandles = useCallback(() => {
    const chart = chartRef.current
    const host = hostRef.current
    if (!chart || !host) return
    const offset = host.offsetTop     // .kline-chart 在 .kline-stage 內的位移
    const s1 = chart.getSize(SUB_PANE, 'root')
    const s2 = chart.getSize(SUB_PANE_2, 'root')
    const on1 = s1 && Number.isFinite(s1.top) && s1.height > 0
    const on2 = s2 && Number.isFinite(s2.top) && s2.height > 0
    const place = (ref, top) => {     // top=null → 隱藏把手
      if (!ref.current) return
      ref.current.style.display = Number.isFinite(top) ? 'flex' : 'none'
      if (Number.isFinite(top)) ref.current.style.top = `${offset + top - 10}px`
    }
    place(h1Ref, on1 ? s1.top : (on2 ? s2.top : null))   // 主圖↔副圖區的總邊界=第一個存在副圖的頂
    place(h2Ref, (on1 && on2) ? s2.top : null)            // 兩副圖之間:僅兩者都在時
  }, [])

  // 抓取當前兩副圖高度(不存在=0)
  const subHeights = () => {
    const chart = chartRef.current
    return {
      h1: chart?.getSize(SUB_PANE, 'root')?.height || 0,
      h2: chart?.getSize(SUB_PANE_2, 'root')?.height || 0,
    }
  }

  // 自製指標 legend:數字留在各 pane 頂部原位、每個數字帶底色(klinecharts 內建無 per-number 背景)
  const updateLegends = useCallback(index => {
    const chart = chartRef.current
    const host = hostRef.current
    if (!chart || !host || !host.parentElement) return
    // 圖表在定位父層(.kline-stage)內的實際位移(用 getBoundingClientRect,跨裝置/佈局穩健)
    const offset = host.getBoundingClientRect().top - host.parentElement.getBoundingClientRect().top
    const bars = documentRef.current?.periods?.[periodRef.current] || []
    const raw = (index != null && index >= 0) ? index : bars.length - 1
    const idx = Math.max(0, Math.min(raw, bars.length - 1));   // 超出資料範圍(右側空白區)→ clamp 到最後一根
    [CANDLE_PANE, SUB_PANE, SUB_PANE_2].forEach((paneId, i) => {
      const el = legRefs[i].current
      if (!el) return
      const size = chart.getSize(paneId, 'root')
      const inds = size ? (chart.getIndicators({ paneId }) || []) : []
      if (!size || !inds.length) { el.style.display = 'none'; return }
      let html = ''
      for (const ind of inds) {
        const res = ind.result?.[idx]
        if (!res) continue
        let li = 0
        for (const fig of ind.figures || []) {
          const raw = res[fig.key]
          if (raw == null || !Number.isFinite(Number(raw))) continue
          const isLine = !fig.type || fig.type === 'line'
          const color = isLine ? LINE_COLORS[li++ % LINE_COLORS.length] : '#B7B9BF'
          const digits = Math.abs(Number(raw)) >= 1000 ? 0 : 2
          html += `<span class="klg-item" style="color:${color}">${(fig.title || fig.key).trim()} ${formatNumber(Number(raw), digits)}</span>`
        }
      }
      el.innerHTML = html
      el.style.display = html ? 'flex' : 'none'
      if (html) el.style.top = `${offset + size.top + 3}px`
    })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const startResize = (event, which) => {
    const chart = chartRef.current
    if (!chart) return
    event.preventDefault()
    event.stopPropagation()   // 別讓同一觸控同時被 klinecharts 當成圖表平移
    const startX = event.clientX
    const startY = event.clientY
    const { h1, h2 } = subHeights()   // 起始高(不存在=0)
    // ★H1(2026-08-21 本機驗證):拖曳中 live setPaneOptions=平滑縮放(原本就順);但 live 改 candle 畫布
    //   尺寸會讓 klinecharts Canvas 的 rAF 重繪與「之後的 scroll」race → candle 卡舊影格(滑主圖只 X 軸動)。
    //   故「放手後重建整張圖」(dispose+init,新畫布乾淨、race 清掉),並讀回實際套用高度存 ref
    //   (避免 klinecharts clamp 造成的「兩段跳」)。捲動位移一併還原。
    // 監聽掛 window(不掛把手,把手會被移位而漏收 up);不用 setPointerCapture(會卡)。
    let mode = null      // 未定 → 'resize'(垂直)/ 'pan'(水平,forward 給圖平移)
    let lastX = startX
    const liveResize = dy => {   // 拖曳中即時縮放(平滑)
      if (which === 'h1') {
        const total = h1 + h2
        if (total <= 0) return
        const r = Math.max(30 * ((h1 > 0) + (h2 > 0)), total - dy) / total   // 往下拖=副圖區縮小、主圖變大
        if (h1 > 0) chart.setPaneOptions({ id: SUB_PANE, height: Math.max(30, h1 * r) })
        if (h2 > 0) chart.setPaneOptions({ id: SUB_PANE_2, height: Math.max(30, h2 * r) })
      } else {
        chart.setPaneOptions({ id: SUB_PANE, height: Math.max(30, h1 + dy) })
        chart.setPaneOptions({ id: SUB_PANE_2, height: Math.max(30, h2 - dy) })
      }
      overlayRef.current?.resize()
      updateHandles()
      updateLegends()
    }
    const onMove = ev => {
      const dy = ev.clientY - startY
      if (!mode) {
        // 按在把手上=九成是要縮放:縮放偏權判定——水平位移要「明顯壓倒」垂直(2 倍+6px)才當平移。
        // 舊版 4px 內誰大聽誰的,拇指起手常帶水平分量 → 被誤判平移、整個手勢都不能縮放(使用者回報)。
        const dx = ev.clientX - startX
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        mode = Math.abs(dx) > Math.abs(dy) * 2 + 6 ? 'pan' : 'resize'
      }
      if (mode === 'pan') {
        chart.scrollByDistance(ev.clientX - lastX)   // 與原生拖曳同號(內容跟手指);取負會反向
        lastX = ev.clientX
        overlayRef.current?.redraw()
        return
      }
      liveResize(dy)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      // 純 live 縮放,放手不重建。捲動後 candle 重繪的根因(klinecharts Canvas.update 小數高度誤判)
      // 已用 patches/klinecharts+10.0.0.patch 從源頭修好(patch-package),不需要 app 端 recreate/offset hack。
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)   // 切背景/來電等中斷也一律收乾淨
  }

  // 專業看盤=均線值常駐(有空間);縮小檢視=hover 十字才顯示(不壓在 K 棒上)
  useEffect(() => {
    chartRef.current?.setStyles({ indicator: { tooltip: { showRule: focusMode ? 'always' : 'follow_cross' } } })
  }, [focusMode])

  // 進畫線/選取模式時隱藏 chart 十字線:overlay 接管滑鼠後 chart 收不到 mousemove,十字線會凍住(卡住)
  useEffect(() => {
    chartRef.current?.setStyles({ crosshair: { show: !activeTool } })
  }, [activeTool])

  // 工具切換：再按一次 = 回看盤模式（overlay pass-through）
  const handleTool = name => {
    const overlay = overlayRef.current
    if (!overlay) return
    tapEnteredSelectRef.current = false   // 工具列操作後,選取模式歸「工具列」管,點空白不再自動退出
    if (name === activeTool) {
      setActiveTool(null)
      setSelected(null)
      overlay.setTool('select')
      overlay.setActive(false)
      return
    }
    setActiveTool(name)
    setSelected(null)
    overlay.setTool(name)
    overlay.setActive(true)
  }
  // 絕對設定版(分割全域工具列用):設成指定工具/null,冪等——與 handleTool 的 toggle 語意區分
  const applyTool = name => {
    const overlay = overlayRef.current
    if (!overlay || name === activeTool) return
    tapEnteredSelectRef.current = false
    if (name == null) {
      setActiveTool(null); setSelected(null)
      overlay.setTool('select'); overlay.setActive(false)
      return
    }
    setActiveTool(name); setSelected(null)
    overlay.setTool(name); overlay.setActive(true)
  }

  // ── 分割全域工具列(規格 17 v3):把本格的動作與旗標註冊到 bus,由 App 的全域帶驅動 ──
  const splitApiRef = useRef(null)
  splitApiRef.current = {
    setTool: applyTool,
    setStyle: (c, w) => changeStyle(c, w),
    undo: () => restore('undo'),
    redo: () => restore('redo'),
    removeSelected: () => removeSelected(),
    clearAll: () => clearAll(),
    exportChart: () => exportChart(),
    syncDrawings: () => loadDrawings(periodRef.current),
    flags: () => ({
      activeTool, hasSelection: Boolean(selected), canUndo: historyState.canUndo, canRedo: historyState.canRedo,
      hasDrawings, syncing: storageState.kind === 'loading' || storageState.kind === 'syncing', color, lineWidth,
      periods: ['hour', 'day', 'week', 'month'].filter(k => documentRef.current?.periods?.[k]?.length),
    }),
  }
  useEffect(() => {
    if (!syncBus || !syncRole) return undefined
    syncBus.api[syncRole] = {
      call: (method, ...args) => splitApiRef.current?.[method]?.(...args),
      flags: () => splitApiRef.current?.flags?.() || {},
    }
    return () => { if (syncBus.api?.[syncRole]) delete syncBus.api[syncRole] }
  }, [syncBus, syncRole])
  // 面板內部工具狀態變化(Esc/畫完自動退出)→ 回報全域帶,兩格與工具列高亮保持一致
  useEffect(() => { if (syncBus && syncBus.tool !== activeTool) syncBus.reportTool?.(activeTool) }, [syncBus, activeTool])
  // 旗標變化 → 通知全域帶重繪(undo/redo/清除 等按鈕的啟用狀態)
  useEffect(() => { syncBus?.notify?.() }, [syncBus, historyState, hasDrawings, selected, activeTool, storageState.kind, color, lineWidth])

  useEffect(() => {
    if (!activeTool) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        tapEnteredSelectRef.current = false
        setActiveTool(null)
        setSelected(null)
        overlayRef.current?.setTool('select')
        overlayRef.current?.setActive(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTool])

  const changeStyle = (nextColor, nextWidth) => {
    setColor(nextColor)
    setLineWidth(nextWidth)
    overlayRef.current?.setStyle(nextColor, nextWidth)
    if (selected) setSelected(value => ({ ...value, color: nextColor, lineWidth: nextWidth }))
  }

  const restore = direction => {
    const next = direction === 'undo' ? historyRef.current.undo() : historyRef.current.redo()
    if (!next) return
    overlayRef.current?.setShapes(next)
    setSelected(null)
    persistShapes(next)
    updateHistoryState()
  }

  const removeSelected = () => {
    overlayRef.current?.deleteSelected()
    setSelected(null)
  }

  const clearAll = () => {
    if (!hasDrawings || !window.confirm('確定清除這檔股票在目前週期的全部畫線？此動作可以復原。')) return
    overlayRef.current?.clearAll()
    setSelected(null)
  }

  const exportChart = () => {
    const chart = chartRef.current
    if (!chart) return
    const base = chart.getConvertPictureUrl(true, 'png', '#131316')
    if (!base) return
    const overlayCanvas = overlayRef.current?.canvas
    const download = canvas => {
      const link = document.createElement('a')
      link.href = canvas.toDataURL('image/png')
      link.download = `${row.stkCode}-${period}-kline.png`
      link.click()
    }
    // 右上角浮水印:品牌字標
    const drawWatermark = (ctx, W, H, logo) => {
      const s = Math.round(Math.max(28, Math.min(W, H) * 0.05))     // 去背 logo 邊長
      const fs = Math.round(s * 0.62)
      const gap = Math.round(s * 0.3)
      const pad = Math.round(W * 0.014) + 8
      // 官方設計字體(font-display)+ 金色 ×(對齊左上角字標風格)
      const parts = [
        { t: 'ParityDesk ', c: 'rgba(236, 236, 238, .95)' },
        { t: '×', c: '#D8DBE0' },
        { t: '', c: 'rgba(236, 236, 238, .95)' },
      ]
      ctx.save()
      ctx.font = `600 ${fs}px "Cormorant Garamond", "Noto Serif TC", Georgia, serif`
      // 用 alphabetic 基線 + 各段實際 ink box 光學置中:CJK／×／Latin 的 em 中心不一致,
      // 靠 textBaseline='middle' 會各自偏移,逐段量 actualBoundingBox 才能真正對到同一條水平中線。
      ctx.textBaseline = 'alphabetic'
      const tw = parts.reduce((acc, p) => acc + ctx.measureText(p.t).width, 0)
      const x0 = W - pad - s - gap - tw
      const cy = pad + s / 2
      ctx.globalAlpha = 0.95
      if (logo) {
        // logo 去背 PNG 的不透明內容未必置中於畫布框(此資產內容中心比框中心略低),
        // 量一次不透明像素的垂直範圍,讓「內容中心」而非框中心精準落在 cy(與文字同一條中線)。
        let logoY = pad
        try {
          const oc = document.createElement('canvas')
          oc.width = logo.naturalWidth || logo.width
          oc.height = logo.naturalHeight || logo.height
          const octx = oc.getContext('2d')
          octx.drawImage(logo, 0, 0)
          const d = octx.getImageData(0, 0, oc.width, oc.height).data
          let top = oc.height, bot = 0
          for (let y = 0; y < oc.height; y++) {
            for (let x = 0; x < oc.width; x++) {
              if (d[(y * oc.width + x) * 4 + 3] > 12) { if (y < top) top = y; if (y > bot) bot = y; break }
            }
          }
          if (bot >= top) logoY = cy - ((top + bot) / 2 / oc.height) * s  // 內容中心對到 cy
        } catch { /* 量測失敗(理論上同源不會)→ 退回框置中 */ }
        ctx.drawImage(logo, x0, logoY, s, s)
      }
      let tx = x0 + s + gap
      for (const p of parts) {
        const m = ctx.measureText(p.t)
        const by = cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2  // 讓此段 ink box 中心落在 cy
        ctx.fillStyle = p.c
        ctx.fillText(p.t, tx, by)
        tx += m.width
      }
      ctx.restore()
    }
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0, image.width, image.height)
      const logo = new Image()
      logo.onload = () => { drawWatermark(ctx, canvas.width, canvas.height, logo); download(canvas) }
      logo.onerror = () => download(canvas)   // 沒 logo 也能匯出
      logo.src = brandMark
    }
    image.src = base
  }

  const displayedBar = useMemo(() => bar || documentRef.current?.periods[period]?.at(-1), [bar, period])
  const StorageIcon = storageState.kind === 'error' ? AlertCircle
    : storageState.kind === 'saving' || storageState.kind === 'loading' || storageState.kind === 'syncing' ? LoaderCircle
      : storageState.scope === 'cloud' ? Cloud : Database
  const drawingsBusy = storageState.kind === 'loading' || storageState.kind === 'syncing'

  return (
    <section className={`kline-panel${focusMode ? ' is-focus' : ''}`} aria-label={`${row.stk} K 線與畫線`}>
      {/* 規格 17 v3:分割時整條控制列不在格內(hideControls),改由 App 全域帶承載;格內只剩格頭(標籤+OHLC) */}
      {!hideControls && (
      <div className="kline-controls">
        {/* 1. 標的:現股 ⇄ 轉債(左右滑動 + 液化);分割模式=鎖定軌,改顯示靜態標籤 */}
        {fixedTrack ? (
          <span className={`kseg-fixed kseg-fixed--${fixedTrack}`}
            title={fixedTrack === 'cb' ? `可轉債 ${row.name} 自身走勢` : `現股 ${row.stk}=訊號來源`}>
            {fixedTrack === 'cb' ? `轉債 ${row.name}` : `現股 ${row.stk}`}
          </span>
        ) : (
          <SegToggle ariaLabel="K 線標的" value={track}
            onChange={next => { trackPeriodRef.current[track] = period; setTrack(next) }}
            options={[
              { value: 'stock', label: '現股', title: `現股 ${row.stk}=訊號來源(熱度、型態都讀現股);Signal 打法=現股給訊號、CB 下單` },
              ...(cbAvailable ? [{ value: 'cb', label: '轉債', title: `可轉債 ${row.name} 自身走勢:看它在價格帶的位置(貼債底=蹲點帶)` }] : []),
            ]} />
        )}
        {/* 分割開關:左=現股、右=轉債 同屏對照(需該檔有轉債 K 線) */}
        {splitControl && (
          <button type="button" className={`kpill-btn ksplit-btn${splitControl.active ? ' active' : ''}`}
            disabled={!splitControl.active && !(splitControl.available ?? cbAvailable)}
            title={splitControl.active ? '關閉分割,回單圖' : (splitControl.available ?? cbAvailable) ? '分割顯示:左=現股、右=轉債' : '此檔無轉債 K 線,無法分割'}
            aria-pressed={splitControl.active} onClick={splitControl.onToggle}>
            <Rows2 size={16} aria-hidden />
          </button>
        )}
        {(
          <>
            {/* 2. 週期下拉 */}
            <PillSelect plain ariaLabel="K 線週期" title={syncBus ? 'K 線週期(兩圖同步)' : 'K 線週期'} value={period} onChange={switchPeriod}
              options={Object.entries(PERIODS).map(([key, config]) => ({
                value: key,
                label: ({ hour: '時', day: '日', week: '週', month: '月' })[key] || config.label,
                // 60分K 只在有資料時可選(冷門標的/CB 常無);日週月維持原邏輯(CB 缺才 disable)
                disabled: key === 'hour'
                  ? !(documentRef.current?.periods?.hour?.length)
                  : track === 'cb' && !(documentRef.current?.periods?.[key]?.length),
              }))} />
            {/* 3. 主圖指標下拉 */}
            <PillSelect label="圖" ariaLabel="主圖指標" title="主圖疊加(均線 / 布林 / 無)"
              value={mainInd} onChange={switchMain}
              options={[{ value: 'MA', label: '均線' }, { value: 'BOLL', label: '布林' }, { value: 'NONE', label: '無' }]} />
            {/* 4. 副圖:一顆膠囊裝兩個下拉 ( 副 | ▾ | ▾ ) */}
            <div className="kpill kpill-multi">
              <span className="kpill-lbl">副</span>
              <PillSelect bare ariaLabel="副圖 1 指標" title="副圖 1 指標" value={sub1}
                onChange={next => switchSub(SUB_PANE, sub1, setSub1, next)} options={SUB_OPTS} />
              <span className="kpill-sep" aria-hidden="true" />
              <PillSelect bare ariaLabel="副圖 2 指標" title="副圖 2 指標" value={sub2}
                onChange={next => switchSub(SUB_PANE_2, sub2, setSub2, next)} options={SUB_OPTS} />
            </div>
          </>
        )}
      </div>
      )}

      {(displayedBar || hideControls) && (
        <div className="kline-ohlc" aria-live="polite">
          {/* 分割格頭:軌標籤內嵌 OHLC 列(單行);焦點格金邊提示=全域工具列動作的目標 */}
          {hideControls && fixedTrack && (
            <span className={`kseg-fixed kseg-fixed--sm${syncBus?.driver === syncRole ? ' focused' : ''}`}
              title={fixedTrack === 'cb' ? `可轉債 ${row.name} 自身走勢` : `現股 ${row.stk}=訊號來源`}>
              {fixedTrack === 'cb' ? `轉債 ${row.name}` : `現股 ${row.stk}`}
            </span>
          )}
          {displayedBar && <><b>{formatDate(displayedBar.timestamp)}</b>
          <span>開 <strong>{formatNumber(displayedBar.open)}</strong></span>
          <span>高 <strong className="up">{formatNumber(displayedBar.high)}</strong></span>
          <span>低 <strong className="down">{formatNumber(displayedBar.low)}</strong></span>
          <span>收 <strong>{formatNumber(displayedBar.close)}</strong></span>
          <span>量 <strong>{formatNumber(displayedBar.volume, 0)}</strong></span></>}
        </div>
      )}

      {!hideToolbar && (
      <KLineToolbar activeTool={activeTool} hasSelection={Boolean(selected)}
        color={color} lineWidth={lineWidth} canUndo={historyState.canUndo} canRedo={historyState.canRedo}
        hasDrawings={hasDrawings} onTool={handleTool} syncing={drawingsBusy}
        onColor={value => changeStyle(value, lineWidth)} onLineWidth={value => changeStyle(color, value)}
        onUndo={() => restore('undo')} onRedo={() => restore('redo')} onDelete={removeSelected}
        onClear={clearAll} onExport={exportChart} onSync={() => loadDrawings(periodRef.current)} />
      )}

      <div className="kline-stage">
        {loading && <div className="kline-state"><LoaderCircle className="spin" size={24} />載入真實 K 線…</div>}
        {error && <div className="kline-state error"><AlertCircle size={24} />{error}</div>}
        <div ref={hostRef} className="kline-chart" aria-label={`${row.stk} ${PERIODS[period].label}`} />
        {/* 自製副圖拖曳把手(比 klinecharts 分隔線好抓、觸控保證可用;兩條外觀一致)。
            muted 只在「畫線工具」啟用時(分隔線附近下筆不被把手吃掉);選取模式=穿透式看盤,把手照常可拖 */}
        <div ref={h1Ref} className={`kline-sep-handle${activeTool && activeTool !== 'select' ? ' muted' : ''}`} style={{ display: 'none' }}
          onPointerDown={event => startResize(event, 'h1')} role="separator" aria-label="拖曳整體縮放副圖" />
        <div ref={h2Ref} className={`kline-sep-handle${activeTool && activeTool !== 'select' ? ' muted' : ''}`} style={{ display: 'none' }}
          onPointerDown={event => startResize(event, 'h2')} role="separator" aria-label="拖曳調整兩副圖比例" />
        {/* 自製指標 legend:各 pane 頂部原位、每個數字帶底色(避免與線疊在一起看不清) */}
        <div ref={legRefs[0]} className="kline-legend" style={{ display: 'none' }} aria-hidden="true" />
        <div ref={legRefs[1]} className="kline-legend" style={{ display: 'none' }} aria-hidden="true" />
        <div ref={legRefs[2]} className="kline-legend" style={{ display: 'none' }} aria-hidden="true" />
        {/* 畫線載入/雲端同步中:legend 行最右側轉圈(圖已可操作,只是畫線還在到位) */}
        {!loading && !error && drawingsBusy && (
          <div className="kline-draw-sync" role="status" aria-label={storageState.message} title={storageState.message}>
            <LoaderCircle className="spin" size={13} />
          </div>
        )}
        {zoomHint && <div className="kline-zoom-hint" role="status">按 Ctrl／Cmd＋滾輪縮放；滾輪可繼續查看明細</div>}
        {activeTool && (
          <div className="kline-drawing-instruction" role="status">
            {activeTool === 'select' ? '拖曳圖形或端點編輯；其餘操作（平移／縮放／調軸）與看盤相同；Esc 回看盤'
              : activeTool === 'brush' ? '按住拖曳手繪；壓到既有圖形可直接編輯；Esc 回看盤'
                : activeTool === 'text' ? '點一下放置文字，雙擊文字可重新編輯；Esc 回看盤'
                  : activeTool === 'eraser' ? '點擊圖形即刪除；Esc 回看盤'
                    : (activeTool === 'hline' || activeTool === 'vline') ? '點一下放線，可連續放第二條；Esc 回看盤'
                      : '拖曳完成；壓到既有圖形可直接編輯；Esc 回看盤'}
          </div>
        )}
      </div>
    </section>
  )
}
