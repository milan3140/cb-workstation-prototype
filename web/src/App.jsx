import React, { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsLeftRight, ChevronsRight, LogOut, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Rows2, Search, Star, UserRound, X } from 'lucide-react'
import { useAuth } from './auth/authContext.jsx'
import { fetchData } from './dataSource.js'
import { enrich, STRATS, PICK_CHIPS, listRows, hasGuar, creditLight, applyLiveQuotes } from './logic.js'
import { StratIcon } from './icons.jsx'
import brandDiamond from './assets/brand_diamond.svg'
import DataTable from './components/DataTable.jsx'
import KLineToolbar from './components/kline/KLineToolbar.jsx'
import PillSelect from './components/kline/PillSelect.jsx'
import Drawer, { DetailSections, DETAIL_SECTIONS } from './components/Drawer.jsx'
import WatchlistBar from './components/WatchlistBar.jsx'

const KLinePanel = lazy(() => import('./components/kline/KLinePanel.jsx'))
// 工作區斷點(規格 16):≥1280 三欄;840–1279 平板兩欄(明細=抽屜);≤839 手機版面(凍結)
const DESKTOP_MQ = '(min-width: 1280px)'
const TABLET_MQ = '(min-width: 840px) and (max-width: 1279.98px)'
const LAYOUT_KEY = 'cbw_desktop_layout2'  // v2:收起寬預設改窄(到第三個型態 chip 右緣);換 key 讓舊存值重置
// 乖離類指標(距轉換價/股債乖離)差距小=更貼近=更該看 → 首點升冪;其餘首點降冪
const ASC_FIRST = new Set(['convDist', 'dev', 'devHero'])
import { loadLocal, saveLocal, fetchRemote, pushRemote, makeList, MAX_LISTS } from './watchlists.js'
import { restore as restoreGoogle, onAuthChange as onGoogleAuth, googleEnabled } from './sync/googleAuth.js'
import GoogleSignIn from './sync/GoogleSignIn.jsx'

const fmtDate = s => `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`
// 資料日落後天數(以資料日當天台北 16:00 起算);>4 天=超過正常週末間隔,視為更新中斷
const staleDays = s => Math.floor((Date.now() - new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T16:00:00+08:00`).getTime()) / 86400000)
// epoch ms → HH:MM:SS(台北)
const fmtClock = ms => { try { return new Date(ms).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) } catch { return '' } }

// 快速篩選(faceted filter):與當前策略疊加
const FILTERS = [
  { id: 'guar', label: '有擔保', test: r => hasGuar(r) },
  { id: 'credG', label: '信用穩健', test: r => creditLight(r).level === 'g' },
  { id: 'yld3', label: '殖利率 > 3%', test: r => (r.putYtm > 3 || r.ytm > 3) },
  { id: 'unconv70', label: '未轉換 > 70%', test: r => r.unconv > 70 },
  { id: 'hot', label: '熱度大橘(≥7)', test: r => r.heat >= 7 },
  { id: 'pat', label: '有型態訊號', test: r => !!r.pattern },
  { id: 'open', label: '開放轉換(非停轉)', test: r => !r.stopNow },
  { id: 'borrowE', label: '借券容易', test: r => (r.borrow?.borrowBal ?? 0) > 2000 },
  { id: 'nearPar', label: '貼近面額', test: r => r.cbPx != null && r.cbPx <= 103 },
]
// 每頁依「該策略真正在乎的條件」給不同篩選
const STRAT_FILTERS = {
  all: ['guar', 'credG', 'hot'],
  fire: ['credG', 'guar', 'unconv70'],       // 發動:體質過關、下檔、籌碼未耗
  heatcb: ['hot', 'pat', 'unconv70'],        // 熱度:動能強、型態、籌碼
  floor: ['guar', 'credG', 'yld3'],           // 賣回:擔保、信用、殖利率
  discount: ['open', 'borrowE'],              // 折價:能轉換、借得到券
  cbas: ['guar', 'nearPar'],                  // CBAS:有擔保、權利金便宜
}

export default function App() {
  const auth = useAuth()                           // { user, logout, switchAccount }
  const [gUser, setGUser] = useState(null)         // Google 登入者(分帳號雲端同步的身分)
  useEffect(() => {                                // 還原上次 Google 登入 + 訂閱變化
    if (!googleEnabled()) return undefined
    const off = onGoogleAuth(setGUser)
    restoreGoogle().then(setGUser).catch(() => {})
    return off
  }, [])
  const syncUser = auth.user || gUser              // 任一身分在 = 可雲端同步
  const [userMenu, setUserMenu] = useState(false)  // 右上使用者選單開合
  const [data, setData] = useState(null)          // {today, rows}
  const [stratId, setStratId] = useState('pick')  // 底部導覽:精選訊號(預設)/全市場/我的關注
  const [chipId, setChipId] = useState('firepick')// 精選訊號頁內 chip(型態學精選/各型態)
  const tabRefs = useRef({})                      // 策略 tab 底線滑動指示器用
  const [tabInd, setTabInd] = useState({ x: 0, w: 0, on: false })
  // 我的關注:多份自訂清單(最多 10)。登入=後端 Sheet 正本+本地快取;guest=只本地。
  const [lists, setLists] = useState(loadLocal)
  const [activeListId, setActiveListId] = useState(() => lists[0]?.id)
  const activeList = useMemo(() => lists.find(l => l.id === activeListId) || lists[0], [lists, activeListId])
  const activeCodes = useMemo(() => new Set(activeList?.codes || []), [activeList])
  const pushTimer = useRef()
  const commitLists = next => {   // 本地即存;debounce 整包推後端(未登入時 pushRemote 自己 no-op,不必在這裡 gate)
    setLists(next); saveLocal(next)
    clearTimeout(pushTimer.current); pushTimer.current = setTimeout(() => pushRemote(next), 600)
  }
  const toggleWatch = useCallback(code => {   // 加/移到「目前這份」清單(useCallback:DataTable memo 依賴穩定 props)
    const cur = lists.find(l => l.id === activeListId) || lists[0]
    if (!cur) return
    const has = cur.codes.includes(code)
    commitLists(lists.map(l => l.id === cur.id
      ? { ...l, codes: has ? l.codes.filter(c => c !== code) : [...l.codes, code] } : l))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, activeListId, auth.user])
  const addBlankList = () => {
    if (lists.length >= MAX_LISTS) return
    const nl = makeList(`清單 ${lists.length + 1}`); commitLists([...lists, nl]); setActiveListId(nl.id)
  }
  const copyActiveList = () => {
    if (lists.length >= MAX_LISTS || !activeList) return
    const nl = makeList(`${activeList.name} 複本`, activeList.codes); commitLists([...lists, nl]); setActiveListId(nl.id)
  }
  const renameList = (id, name) => commitLists(lists.map(l => l.id === id ? { ...l, name: (name || '').slice(0, 40) || l.name } : l))
  const removeList = id => {
    const next = lists.filter(l => l.id !== id)
    if (next.length === 0) {                       // 刪掉最後一份 → 保留一份全新空清單(不進零狀態)
      const fresh = makeList('我的關注'); commitLists([fresh]); setActiveListId(fresh.id); return
    }
    commitLists(next)
    if (activeListId === id) setActiveListId(next[0].id)
  }
  const [curCode, setCurCode] = useState(() => new URLSearchParams(window.location.search).get('cb'))
  const [q, setQ] = useState('')
  // ── 桌面三欄工作區(規格 16):≥1280 三欄;欄寬可拖(VS Code 式)、localStorage 記憶 ──
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_MQ).matches)
  const [isTablet, setIsTablet] = useState(() => window.matchMedia(TABLET_MQ).matches)
  const [detailOpen, setDetailOpen] = useState(false)   // 平板兩欄:明細抽屜開合
  const [detSpy, setDetSpy] = useState('key')           // 右欄明細:目前捲到的區塊(tab 高亮)
  const detScrollRef = useRef(null)
  useEffect(() => {
    const mqD = window.matchMedia(DESKTOP_MQ)
    const mqT = window.matchMedia(TABLET_MQ)
    const onD = e => setIsDesktop(e.matches)
    const onT = e => setIsTablet(e.matches)
    mqD.addEventListener('change', onD)
    mqT.addEventListener('change', onT)
    return () => { mqD.removeEventListener('change', onD); mqT.removeEventListener('change', onT) }
  }, [])
  // ── 面板互動(全面重構,規格 16)──
  //   兩個寬度:l=「收起寬」(未 hover 時)、lExpand=「展開寬」(hover 時);r=右欄寬。
  //   hover 是「真的縮放」中間 K 線(不是浮層)——因為畫線已用常駐 rAF 幾何監看死盯 K 棒,縮放時畫線
  //   每幀跟著重繪、永不跑版。展開/收合走 grid-template-columns 過渡動畫(滑順);拖曳中關動畫即時跟手。
  //   拖邊界:hover 前(收起態)拖=調『收起寬 l』;hover 後(展開態)拖=調『展開寬 lExpand』。
  const CJ = { railW: 16, collapseAt: 90, minL: 200, minR: 300, maxL: 760, maxR: 640 }
  const [paneW, setPaneW] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); const l = s.l || 352; return { l, lExpand: Math.max(s.lExpand || 0, l + 4, 520), r: s.r || 400 } }
    catch { return { l: 352, lExpand: 520, r: 400 } }
  })
  const [collapsed, setCollapsed] = useState(() => {
    try { return { l: false, c: false, r: false, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}').collapsed || {}) } }
    catch { return { l: false, c: false, r: false } }
  })
  const [autoExpand, setAutoExpand] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}').autoExpand !== false } catch { return true }
  })
  const [lHover, setLHover] = useState(false)       // 左欄 hover 展開態(真的把面板/圖表縮放到 lExpand)
  const [drag, setDrag] = useState(null)            // { side, w } 拖曳中即時寬
  const hoverTimer = useRef()
  const leaveTimer = useRef()
  // K 線分割:左=現股、右=轉債 同屏對照(僅桌面/平板;persist 與其他版面偏好同存)
  // splitBus=同步匯流排(規格 17):十字線/時間窗雙向、週期/指標 lead→follow
  const splitBusRef = useRef(null)
  const getSplitBus = () => {
    if (!splitBusRef.current) {
      splitBusRef.current = {
        peers: {}, api: {}, lock: false, driver: null, tool: null, state: null, subs: new Set(),
        publish(s) { this.state = s; this.subs.forEach(fn => fn(s)) },
        subscribe(fn) { this.subs.add(fn); if (this.state) fn(this.state); return () => this.subs.delete(fn) },
      }
      window.__splitBus = splitBusRef.current   // 除錯鉤子(僅記憶體引用,無資料外洩)
    }
    return splitBusRef.current
  }
  // 全域帶狀態(規格 17 v3):週期/指標真相源在 App;工具=兩格同進同出;動作目標=焦點格(bus.driver)
  const [splitTick, setSplitTick] = useState(0)                   // bus.notify → 重繪全域帶(按鈕啟用態/焦點)
  const [splitCtl, setSplitCtl] = useState({ period: 'day', mainInd: 'MA', sub1: 'MACD', sub2: 'KDJ' })
  const [splitTool, setSplitTool] = useState(null)
  const [splitRatio, setSplitRatio] = useState(() => {
    try { const r = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}').splitRatio; return r >= .25 && r <= .75 ? r : .5 } catch { return .5 }
  })
  {
    const bus = getSplitBus()
    bus.notify = () => setSplitTick(t => (t + 1) % 1e9)
    bus.reportTool = t => setSplitTool(t)
    bus.tool = splitTool
  }
  useEffect(() => { getSplitBus().publish(splitCtl) }, [splitCtl])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // 工具變更 → 兩格同套(冪等);在哪格點就畫哪格
    const bus = getSplitBus()
    Object.values(bus.api).forEach(a => a.call('setTool', splitTool))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTool])
  const splitFocus = () => getSplitBus().driver || 'lead'
  const splitApi = (method, ...args) => getSplitBus().api[splitFocus()]?.call(method, ...args)
  // 可拖分隔線:調兩格比例(25%~75%,persist 同倉)
  const dragSplitSep = event => {
    event.preventDefault()
    const wrap = event.currentTarget.parentElement
    const rect = wrap.getBoundingClientRect()
    let ratio = splitRatio
    const onMove = ev => { ratio = Math.min(.75, Math.max(.25, (ev.clientX - rect.left) / rect.width)); setSplitRatio(ratio) }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      try { const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...s, splitRatio: ratio })) } catch { /* noop */ }
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }
  const [split, setSplit] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}').split === true } catch { return false }
  })
  const persist = (pw, col, ae = autoExpand, sp = split) => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...pw, collapsed: col, autoExpand: ae, split: sp })) } catch { /* noop */ }
  }
  const toggleAutoExpand = () => setAutoExpand(v => { const nv = !v; persist(paneW, collapsed, nv); if (!nv) setLHover(false); return nv })
  const toggleSplit = () => setSplit(v => { const nv = !v; persist(paneW, collapsed, autoExpand, nv); return nv })
  const setCol = (side, v) => setCollapsed(c => {
    const n = { ...c, [side]: v }
    setPaneW(p => {
      let np = p
      if (side === 'c' && !v) {   // 展開中欄:兩側若被拖到吃光空間,縮回讓中欄至少 360 可視(否則展開=看起來沒反應)
        let l = Math.min(p.l, CJ.maxL), r = Math.min(p.r, CJ.maxR)
        const avail = window.innerWidth - 360 - 12
        if (l + r > avail) { r = Math.max(CJ.minR, avail - l); if (l + r > avail) l = Math.max(CJ.minL, avail - r) }
        np = { ...p, l, r, lExpand: Math.max(p.lExpand, l + 4) }
      }
      persist(np, n); return np
    })
    return n
  })
  // hover 展開/收合,分三區(解「邊界太容易觸發 hover 切換、抓不到邊界」):
  //   本體(排除右緣 GRAB 帶)→ 展開到 lExpand(真的縮放);
  //   右緣 GRAB 帶(含分隔線)→ 維持現狀(不展不收)→ 讓「收起態」與「展開態」的邊界都抓得到、不會一靠近就切換;
  //   面板外 → 收回到 l。
  useEffect(() => {
    if (!isDesktop || !autoExpand) return undefined
    const GRAB = 22   // 右緣抓取帶寬(加大,好抓邊界)
    const onMove = e => {
      if (drag || collapsed.l) return
      const panel = document.querySelector('.dws-left'); if (!panel) return
      const pr = panel.getBoundingClientRect()
      const withinY = e.clientY >= pr.top && e.clientY <= pr.bottom
      const inBody = withinY && e.clientX >= pr.left && e.clientX <= pr.right - GRAB
      const inGrab = withinY && e.clientX > pr.right - GRAB && e.clientX <= pr.right + 10
      if (inBody) {
        clearTimeout(leaveTimer.current); leaveTimer.current = null
        if (!lHover && !hoverTimer.current && paneW.lExpand > paneW.l + 4) {
          hoverTimer.current = setTimeout(() => { hoverTimer.current = null; setLHover(true) }, 120)
        }
      } else if (inGrab) {
        // 邊界抓取帶:清掉展開/收合排程,維持現狀 → 邊界穩定可抓,拖它=調當前狀態的寬
        if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
        clearTimeout(leaveTimer.current); leaveTimer.current = null
      } else {
        if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
        if (lHover && !leaveTimer.current) leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setLHover(false) }, 200)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [isDesktop, autoExpand, lHover, collapsed.l, drag, paneW.l, paneW.lExpand])
  // 拖邊界:即時縮放(chart 跟著,畫線靠 rAF 幾何監看跟繪不跑)。放手時:hover 前拖→調 l,hover 後拖→調 lExpand。
  const dragPane = side => event => {
    event.preventDefault(); event.stopPropagation()
    const startX = event.clientX
    const grabExpanded = side === 'l' && lHover   // 拖前處於展開態 → 調展開寬;否則調收起寬
    const sel = side === 'l' ? '.dws-left, .dws-rail--l' : '.dws-right, .dws-rail--r'
    const start = collapsed[side] ? CJ.railW : Math.round(document.querySelector(sel)?.getBoundingClientRect().width || paneW[side])
    clearTimeout(hoverTimer.current); hoverTimer.current = null; clearTimeout(leaveTimer.current); leaveTimer.current = null
    setDrag({ side, w: start })
    let finalW = start, moved = false
    // 上限=可用空間(對側欄+中欄軌+分隔線),不設固定 max——照 VS Code:拖過中欄=把中欄壓到收合
    const otherNow = side === 'l' ? (collapsed.r ? CJ.railW : paneW.r) : (collapsed.l ? CJ.railW : paneW.l)
    const cap = Math.max(CJ.minL, window.innerWidth - otherNow - CJ.railW - 12)
    const onMove = ev => {
      const d = ev.clientX - startX
      if (Math.abs(d) > 3) moved = true
      finalW = Math.min(cap, Math.max(0, side === 'l' ? start + d : start - d))
      setDrag({ side, w: finalW })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      setDrag(null)
      if (!moved) { if (collapsed[side]) setCol(side, false); return }
      const otherW = side === 'l' ? (collapsed.r ? CJ.railW : paneW.r) : (collapsed.l ? CJ.railW : paneW.l)
      const cCollapse = isDesktop && (window.innerWidth - finalW - otherW - 12) < CJ.collapseAt
      if (finalW < CJ.collapseAt) { setCol(side, true); setLHover(false); return }   // 拉很窄 → 收成一條線
      if (side === 'l') {
        const w = Math.max(finalW, CJ.minL)
        setPaneW(p => {
          // 展開態拖 → 只調 lExpand;收起態拖 → 調 l(並確保 lExpand 不小於 l)
          const np = grabExpanded ? { ...p, lExpand: Math.max(w, p.l + 4) } : { ...p, l: w, lExpand: Math.max(p.lExpand, w + 4) }
          persist(np, { ...collapsed, l: false, c: cCollapse }); return np
        })
        setCollapsed(c => ({ ...c, l: false, c: cCollapse }))
        setLHover(grabExpanded)   // 調完展開寬→停在展開;調完收起寬→回收起
      } else {
        const w = Math.max(finalW, CJ.minR)
        setPaneW(p => { const np = { ...p, r: w }; persist(np, { ...collapsed, r: false, c: cCollapse }); return np })
        setCollapsed(c => ({ ...c, r: false, c: cCollapse }))
      }
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // 點欄位標題排序:{key, dir};key=null → 用各策略預設排序(mockup 行為)
  const [sort, setSort] = useState({ key: null, dir: -1 })
  const [filters, setFilters] = useState([])        // 已套用的快速篩選 id
  const [filterMenu, setFilterMenu] = useState(false)

  // 即時現股報價(每秒 poll,重算距轉換價/乖離);來源=quote_server 代理 即時資料閘道 即時成交價
  const [quotes, setQuotes] = useState(null)
  const [quoteAsof, setQuoteAsof] = useState(null)
  const [quoteLive, setQuoteLive] = useState(false)

  const [history, setHistory] = useState(null)   // 現股近 60 日收盤序列(sparkline 用)

  useEffect(() => {
    fetchData('raw.json')
      .then(r => r.json())
      .then(d => setData({ today: d.today, rows: enrich(d.raw, d.today, d.derived, d.credit, d.cbBasic, d.exDiv, d.borrow) }))
    fetchData('history.json').then(r => r.json()).then(setHistory).catch(() => setHistory(null))
  }, [])

  // 帳號身分變更 → 清單分帳號正確切換(避免看到上一個帳號的資料)
  const prevAcctRef = useRef(undefined)
  useEffect(() => {
    const email = gUser?.email || auth.user?.nickname || null
    if (prevAcctRef.current === email) return undefined
    const wasSignedIn = !!prevAcctRef.current   // 之前是否有登入身分(用來分辨 訪客→登入 vs 換帳號)
    prevAcctRef.current = email

    if (!email) {   // 登出 → 清成全新訪客空清單,不留上一個帳號的資料
      const fresh = [makeList('我的關注')]
      setLists(fresh); saveLocal(fresh); setActiveListId(fresh[0].id)
      return undefined
    }
    // 登入 / 換帳號 → 抓「這個帳號」的雲端正本
    const ac = new AbortController()
    fetchRemote(ac.signal).then(remote => {
      let next
      if (remote && remote.length) {
        next = remote                                   // 該帳號雲端有 → 用它
      } else if (!wasSignedIn && lists.some(l => l.codes.length)) {
        next = lists                                    // 訪客→首次登入且雲端空 → 帶訪客清單上雲
        pushRemote(next)
      } else {
        next = [makeList('我的關注')]                     // 換帳號到空帳號 → 全新空清單(不留舊帳號)
      }
      setLists(next); saveLocal(next)
      setActiveListId(a => next.some(l => l.id === a) ? a : next[0].id)
    }).catch(() => {})
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gUser, auth.user])

  useEffect(() => {
    const URL = import.meta.env.VITE_QUOTES_URL || '/api/quotes.json'
    let stop = false, timer
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await fetch(URL, { cache: 'no-store' })
          if (r.ok) {
            const d = await r.json()
            if (!stop) { setQuotes(d.quotes || null); setQuoteAsof(d.asof || null); setQuoteLive(!!d.quotes) }
          } else if (!stop) setQuoteLive(false)
        } catch { if (!stop) setQuoteLive(false) }
      }
      if (!stop) timer = setTimeout(tick, 1000)   // 每秒一輪(鏈式 setTimeout 避免重疊),隱藏分頁暫停
    }
    tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [])

  // 即時報價套進 rows(重算距轉換價等);無報價時 = 盤後原值
  const rows = useMemo(() => data ? applyLiveQuotes(data.rows, quotes) : [], [data, quotes])

  const strat = STRATS.find(s => s.id === stratId)
  const chip = stratId === 'pick' ? PICK_CHIPS.find(c => c.id === chipId) : null
  // 搜尋模式:全市場比對代號/名稱(CB 與現股皆可),不受策略篩選
  const qNorm = q.trim().toLowerCase()
  const effStrat = useMemo(() => {
    const tests = FILTERS.filter(f => filters.includes(f.id)).map(f => f.test)
    // 精選訊號 → 用選中 chip 的篩選/排序;我的關注 → 用 watchlist;其餘用 strat 本身
    let base = strat
    if (stratId === 'pick' && chip) base = { ...strat, filter: chip.filter, sort: chip.sort || strat.sort }
    else if (stratId === 'watch') base = { ...strat, filter: r => activeCodes.has(r.code) }
    if (qNorm) base = { ...base, filter: r => [r.code, r.name, r.stkCode, r.stk].some(v => String(v ?? '').toLowerCase().includes(qNorm)) }
    if (!tests.length) return base
    return { ...base, filter: r => base.filter(r) && tests.every(t => t(r)) }
  }, [qNorm, strat, chip, stratId, activeCodes, filters])
  const list = useMemo(
    () => data ? listRows(rows, effStrat, sort.key, sort.dir) : [],
    [data, rows, effStrat, sort],
  )
  const counts = useMemo(() => {
    if (!data) return {}
    const c = Object.fromEntries(STRATS.map(s => [s.id, rows.filter(s.filter).length]))
    c.watch = rows.filter(r => activeCodes.has(r.code)).length   // 我的關注(目前清單)即時計數
    return c
  }, [data, rows, activeCodes])
  // 各 chip 的計數(精選訊號頁 chip 上顯示)
  const chipCounts = useMemo(() => {
    if (!data) return {}
    return Object.fromEntries(PICK_CHIPS.map(c => [c.id, rows.filter(r => { try { return c.filter(r) } catch { return false } }).length]))
  }, [data, rows])
  const curRow = curCode ? rows.find(r => r.code === curCode) : null

  // 右欄明細 scroll-spy:捲到哪節→對應 tab 高亮。取「頂端線之上的最後一節」;近底時強制最後一節
  // (最後一節內容短、捲不到頂端,用 IntersectionObserver 會選不到 → 改捲動計算)。
  useEffect(() => {
    const root = detScrollRef.current
    if (!isDesktop || !root || !curRow) return undefined
    const onScroll = () => {
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 6) {
        setDetSpy(DETAIL_SECTIONS[DETAIL_SECTIONS.length - 1].key); return   // 近底=最後一節
      }
      const rootTop = root.getBoundingClientRect().top + 12
      let active = DETAIL_SECTIONS[0].key
      for (const s of DETAIL_SECTIONS) {
        const el = document.getElementById(`det-sec-${s.key}`)
        if (el && el.getBoundingClientRect().top <= rootTop) active = s.key
      }
      setDetSpy(active)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [isDesktop, curRow])

  // 桌面:開頁一定要有圖(看盤軟體慣例)。優先選當前清單第一檔;當前清單今天可能是空的
  // (例如型態學精選 0 檔)→ 退而選全市場任一檔,避免落地整片空白「跑不出來」。URL ?cb= 優先。
  useEffect(() => {
    if (!(isDesktop || isTablet) || curCode) return
    const first = list[0]?.code || rows[0]?.code
    if (first) setCurCode(first)
  }, [isDesktop, isTablet, curCode, list, rows])

  // 切底部導覽 → 重置排序/篩選;進精選訊號預設回型態學精選
  // useCallback 穩定化(DataTable memo 依賴):全部只用 setter/常數,identity 恆定
  const pick = useCallback(id => { setStratId(id); setSort({ key: null, dir: -1 }); setFilters([]); if (id === 'pick') setChipId('firepick') }, [])
  const pageFilterIds = STRAT_FILTERS[stratId] || []
  // 乖離類指標(距轉換價/股債乖離)差距小=更貼近=更該看 → 首點升冪(小→前);其餘首點降冪
  const onSort = useCallback(key => setSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: ASC_FIRST.has(key) ? 1 : -1 }), [])
  const openDetail = useCallback(code => {
    setCurCode(code)
    const url = new URL(window.location.href)
    url.searchParams.set('cb', code)
    window.history.replaceState(null, '', url)
  }, [])
  const onStratNav = useCallback((id, code) => { pick(id); if (code) openDetail(code) }, [pick, openDetail])
  const closeDetail = () => {
    setCurCode(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('cb')
    window.history.replaceState(null, '', url)
  }

  useEffect(() => {
    // Esc:桌面三欄=明細常駐不關;平板兩欄=關明細抽屜(保留選中);手機=關抽屜(清選中)
    const onKey = e => {
      if (e.key !== 'Escape') return
      if (isDesktop) return
      if (isTablet) { setDetailOpen(false); return }
      closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isDesktop, isTablet])

  // 點篩選選單外面 → 收合
  useEffect(() => {
    if (!filterMenu) return
    const h = e => { if (!e.target.closest('.filter-wrap')) setFilterMenu(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [filterMenu])

  // 點使用者選單外面 / Esc → 收合
  useEffect(() => {
    if (!userMenu) return
    const h = e => { if (!e.target.closest('.usermenu')) setUserMenu(false) }
    const esc = e => { if (e.key === 'Escape') setUserMenu(false) }
    document.addEventListener('click', h)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('click', h); document.removeEventListener('keydown', esc) }
  }, [userMenu])

  const crit = qNorm
    ? `「${q.trim()}」全市場比對代號 / 名稱`
    : (strat.cond || strat.text || '')

  // 左右滑動方向:換策略頁(往右頁 index 大=從右滑入)＋精選訊號頁內換型態 chip 都算。
  const curIdx = STRATS.findIndex(s => s.id === stratId)
  const chipIdx = stratId === 'pick' ? PICK_CHIPS.findIndex(c => c.id === chipId) : 0
  const navIdx = curIdx * 100 + (chipIdx < 0 ? 0 : chipIdx)   // 綜合位置:策略為主、pick 頁內用 chip 細分
  const prevIdxRef = useRef(navIdx)
  const slideDir = navIdx < prevIdxRef.current ? 'slide-l' : 'slide-r'
  useEffect(() => { prevIdxRef.current = navIdx }, [navIdx])

  // 策略 tab 金色底線:滑到 active(搜尋時無 active → 隱藏)
  const activeTabId = qNorm ? null : stratId
  const tabsNavRef = useRef(null)
  const measureTabInd = useCallback(() => {
    const el = tabRefs.current[activeTabId]
    const nav = tabsNavRef.current
    if (!el || !nav) { setTabInd(p => ({ ...p, on: false })); return }
    // 相對 nav 的實際位置(offsetLeft 受 scroll/padding 影響 → 用 rect 差,穩健);底線=tab 寬置中內縮 12px
    const er = el.getBoundingClientRect(), nr = nav.getBoundingClientRect()
    const x = er.left - nr.left + nav.scrollLeft
    setTabInd({ x, w: er.width, on: true })
  }, [activeTabId])
  useLayoutEffect(() => { measureTabInd() }, [measureTabInd, counts, isDesktop, isTablet])
  // 逐幀量測:收合/拖欄是動畫,nav 每幀重排 → ResizeObserver 對 nav 觀察,底線即時跟著縮放不亂跳
  useEffect(() => {
    const nav = tabsNavRef.current
    if (!nav) return undefined
    const ro = new ResizeObserver(() => measureTabInd())
    ro.observe(nav)
    for (const c of nav.children) ro.observe(c)
    window.addEventListener('resize', measureTabInd)
    return () => { ro.disconnect(); window.removeEventListener('resize', measureTabInd) }
  }, [measureTabInd, isDesktop, isTablet, qNorm, stratId])

  // 型態 chips 滑動金框指示器(與「我的關注」wl-ind 同款設計)
  const chipRefs = useRef({})
  const [chipInd, setChipInd] = useState({ x: 0, w: 0, on: false })
  const measureChipInd = useCallback(() => {
    const el = chipRefs.current[chipId]
    if (!el || stratId !== 'pick' || qNorm) { setChipInd(p => ({ ...p, on: false })); return }
    setChipInd({ x: el.offsetLeft, w: el.offsetWidth, on: true })
  }, [chipId, stratId, qNorm])
  useLayoutEffect(() => { measureChipInd() }, [measureChipInd, chipCounts, paneW, lHover, drag, collapsed, isDesktop, isTablet])
  useEffect(() => {
    window.addEventListener('resize', measureChipInd)
    return () => window.removeEventListener('resize', measureChipInd)
  }, [measureChipInd])

  // ── 共用 UI 片段:手機(現行版面,凍結)與桌面三欄共用同一份內容,只換排列 ──
  const userMenuEl = auth.user && (
    <div className="usermenu">
      <button className="usermenu-btn" onClick={() => setUserMenu(m => !m)} aria-expanded={userMenu} aria-haspopup="menu">
        <UserRound size={17} aria-hidden />
        <span className="um-nick">{auth.user.nickname}</span>
        <ChevronDown size={14} className="um-caret" aria-hidden />
      </button>
      {userMenu && (
        <div className="usermenu-drop" role="menu">
          <div className="um-head"><UserRound size={15} aria-hidden />{auth.user.nickname}</div>
          <button role="menuitem" onClick={() => { setUserMenu(false); auth.switchAccount() }}><RefreshCw size={15} aria-hidden />切換帳號</button>
          <button role="menuitem" className="um-logout" onClick={() => { setUserMenu(false); auth.logout() }}><LogOut size={15} aria-hidden />登出</button>
        </div>
      )}
    </div>
  )
  // 頁首帳號區(靠右):Google 登入(分帳號雲端同步入口)+ 既有 OIDC 選單
  const accountEl = (
    <div className="account-area">
      {googleEnabled() && <GoogleSignIn user={gUser} />}
      {userMenuEl}
    </div>
  )
  const indW = Math.max(16, tabInd.w - 24)   // 底線=tab 寬置中內縮 12px 兩側
  const tabsNav = (
    <nav className="tabs" role="tablist" aria-label="策略切換" ref={tabsNavRef}>
      {STRATS.map(s => (
        <button key={s.id} ref={el => { tabRefs.current[s.id] = el }} role="tab" aria-selected={s.id === stratId && !qNorm}
          className={`tab${s.id === stratId && !qNorm ? ' on' : ''}`} onClick={() => pick(s.id)}>
          <StratIcon id={s.id} size={18} /><span className="tlbl">{s.label}</span><span className="ct">{counts[s.id] ?? '–'}</span>
        </button>
      ))}
      <span className="tab-ind" aria-hidden="true"
        style={{ transform: `translateX(${tabInd.x + (tabInd.w - indW) / 2}px)`, width: indW, opacity: tabInd.on ? 1 : 0 }} />
    </nav>
  )
  const searchEl = (
    <div className="search">
      <Search size={17} aria-hidden />
      <input value={q} onChange={e => setQ(e.target.value)}
        placeholder="搜尋代號 / 名稱" aria-label="搜尋可轉債或現股" />
      {q && <button className="sx" onClick={() => setQ('')} aria-label="清除搜尋"><X size={16} /></button>}
    </div>
  )
  const chipRowEl = stratId === 'pick' && !qNorm && (
    <div className="chiprow" role="tablist" aria-label="型態篩選">
      <span className="pc-ind" aria-hidden="true"
        style={{ transform: `translateX(${chipInd.x}px)`, width: chipInd.w, opacity: chipInd.on ? 1 : 0 }} />
      {PICK_CHIPS.map(c => (
        <button key={c.id} role="tab" aria-selected={c.id === chipId}
          ref={el => { chipRefs.current[c.id] = el }}
          className={`pchip${c.id === chipId ? ' on' : ''}`}
          onClick={() => { setChipId(c.id); setSort({ key: null, dir: -1 }) }}>
          {c.label}<span className="pc-ct">{chipCounts[c.id] ?? '–'}</span>
        </button>
      ))}
    </div>
  )
  const watchBarEl = stratId === 'watch' && !qNorm && (
    <WatchlistBar lists={lists} activeId={activeListId} max={MAX_LISTS}
      onPick={setActiveListId} onAddBlank={addBlankList} onCopy={copyActiveList}
      onRename={renameList} onRemove={removeList} />
  )
  const bar3El = (
    <div className="bar3">
      {/* 手動展開/收合(常駐):點擊=切換面板展開態,同時關掉 hover 自動展開(使用者選了手動就別再自動) */}
      {isDesktop && (
        <button className={`aexp-toggle${lHover ? ' on' : ''}`}
          onClick={() => { if (autoExpand) { setAutoExpand(false); persist(paneW, collapsed, false) } setLHover(v => !v) }}
          aria-pressed={lHover} title={lHover ? '收合清單面板(回收起寬);點擊同時關閉 AUTO' : '展開清單面板(到展開寬);點擊同時關閉 AUTO'}>
          {lHover ? <ChevronsLeft size={15} aria-hidden /> : <ChevronsRight size={15} aria-hidden />}
        </button>
      )}
      {/* AUTO:hover 自動展開開關(字樣鈕) */}
      {isDesktop && (
        <button className={`aexp-toggle aexp-auto${autoExpand ? ' on' : ''}`} onClick={toggleAutoExpand}
          aria-pressed={autoExpand} title={autoExpand ? 'AUTO 開:滑入清單自動展開、移開自動收合(點擊關閉)' : 'AUTO 關:面板只聽手動鈕/拖邊界(點擊開啟)'}>
          AUTO
        </button>
      )}
      <div className="filter-wrap">
        <button className="addf" onClick={() => setFilterMenu(m => !m)} aria-expanded={filterMenu}>
          <Plus size={13} aria-hidden />篩選
        </button>
        {filterMenu && (
          <div className="filter-menu" role="menu">
            {pageFilterIds.filter(id => !filters.includes(id)).map(id => {
              const f = FILTERS.find(x => x.id === id)
              return f && (
                <button key={id} role="menuitem"
                  onClick={() => { setFilters(a => [...a, id]); setFilterMenu(false) }}>{f.label}</button>
              )
            })}
            {pageFilterIds.every(id => filters.includes(id)) && <div className="fm-empty">已全部套用</div>}
          </div>
        )}
      </div>
      {filters.map(id => {
        const f = FILTERS.find(x => x.id === id)
        return (
          <span key={id} className="chip">{f.label}
            <button className="x" onClick={() => setFilters(a => a.filter(i => i !== id))} aria-label={`移除 ${f.label}`}><X size={14} /></button>
          </span>
        )
      })}
      {qNorm && (
        <span className="chip">搜尋「{q.trim()}」
          <button className="x" onClick={() => setQ('')} aria-label="清除搜尋"><X size={14} /></button>
        </span>
      )}
      <span className="crit">{crit}　符合 {list.length} 檔</span>
      {quoteLive
        ? <span className="livepill on" title={quoteAsof ? `現股即時報價,更新於 ${fmtClock(quoteAsof)}` : '現股即時報價'}><i />即時</span>
        : <span className="livepill" title="尚未連上即時報價,顯示盤後資料">盤後</span>}
    </div>
  )
  const staleEl = data && staleDays(data.today) > 4 && (
    <div className="stale-banner" role="alert">
      <AlertTriangle size={15} aria-hidden />
      <span>資料更新暫停中——目前顯示 {fmtDate(data.today)} 盤後資料,非最新行情,判讀請留意。</span>
    </div>
  )
  // 383 檔清單改用 deferred:切策略時 tab 高亮/底線立即反應,重表在背景非阻塞渲染(不再卡一秒)
  const deferredList = useDeferredValue(list)
  const deferredKey = useDeferredValue(qNorm ? '_q' : `${stratId}:${chipId}`)
  const tableEl = data
    ? <DataTable key={deferredKey} list={deferredList} cols={strat.cols} onOpen={openDetail} onStrat={onStratNav} sort={sort} onSort={onSort} stratId={qNorm ? 'all' : stratId} watch={activeCodes} onWatch={toggleWatch} history={history} current={curCode} />
    : <div className="skeleton" aria-label="載入中">{Array.from({ length: 10 }, (_, i) => <div key={i} />)}</div>

  // ── 工作區:≥1280 三欄(左清單/中K線/右明細);840–1279 平板兩欄(明細=抽屜)──
  if (isDesktop || isTablet) {
    const watched = curRow ? activeCodes.has(curRow.code) : false
    // 中間 K 線的縮放,只在 'live' 拖曳(拖分隔線)時即時發生;hover peek 與 'overlay' 拖曳(拖 peek 邊)
    // 都不動 grid 左欄軌 → 中間 K 線不縮放、畫線不跑。
    // 真實縮放:拖曳中=即時寬;hover=展開寬 lExpand;平時=收起寬 l。畫線靠 rAF 幾何監看跟繪不跑。
    const lDrag = drag?.side === 'l', rDrag = drag?.side === 'r'
    const leftW = lDrag ? drag.w : (collapsed.l ? CJ.railW : (lHover ? paneW.lExpand : paneW.l))
    const rightW = rDrag ? drag.w : (collapsed.r ? CJ.railW : paneW.r)
    // 三欄皆可完全收合;中欄(1fr 主角)收合後,fluid 讓給未收合的一側(右優先),確保填滿不留縫
    const railFor = px => `${CJ.railW}px`
    const cCol = collapsed.c ? railFor() : 'minmax(0,1fr)'
    let lCol, rCol
    if (!collapsed.c) {
      lCol = !lDrag && collapsed.l ? railFor() : `${leftW}px`
      rCol = !rDrag && collapsed.r ? railFor() : `${rightW}px`
    } else if (!collapsed.r) {   // 中收→右吃剩餘
      lCol = collapsed.l ? railFor() : `${leftW}px`; rCol = 'minmax(0,1fr)'
    } else if (!collapsed.l) {   // 中右都收→左吃剩餘
      lCol = 'minmax(0,1fr)'; rCol = railFor()
    } else {                      // 三欄都收(退化)→中欄回主角
      lCol = railFor(); rCol = railFor()
    }
    const gridCols = isDesktop ? `${lCol} 6px ${cCol} 6px ${rCol}` : `${lCol} 6px ${cCol}`
    // 收合條:一條垂直線 + 中央側向 chevron(點擊或拖動皆可展開;中欄用雙向展開圖示)
    const Rail = ({ side }) => (
      <div className={`dws-rail dws-rail--${side}`} role="button" tabIndex={0}
        aria-label={side === 'l' ? '展開清單欄' : side === 'r' ? '展開明細欄' : '展開 K 線'}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCol(side, false) } }}
        onClick={() => { if (side === 'c') setCol('c', false) }}
        onPointerDown={side === 'c' ? undefined : dragPane(side)}>
        <span className="dws-rail-chev">{side === 'l' ? <ChevronRight size={15} /> : side === 'r' ? <ChevronLeft size={15} /> : <ChevronsLeftRight size={15} />}</span>
      </div>
    )
    return (
      <div className={`app dws${isTablet ? ' dws--two' : ''}`}>
        <div className="dws-top">
          <div className="brand">
            <span className="brand-badge" aria-hidden><img src={brandDiamond} alt="" /></span>
            <span className="brand-word">Parity<i>·</i>Desk</span>
          </div>
          {accountEl}
        </div>
        {staleEl}
        <div className={`dws-cols${drag ? ' dragging' : ''}`} style={{ gridTemplateColumns: gridCols }}>
          {collapsed.l && !lDrag ? <Rail side="l" /> : (
            <aside className="dws-left" aria-label="CB 清單">
              <div className="dws-ltabs">{tabsNav}</div>
              {chipRowEl}
              {watchBarEl}
              <div className="dws-lsearch">{searchEl}</div>
              {bar3El}
              <div className={`tablewrap ${slideDir}`}>{tableEl}</div>
            </aside>
          )}
          <div className="dws-sep dws-sep--l" role="separator" aria-orientation="vertical" aria-label="拖動調整清單欄寬"
            onPointerDown={dragPane('l')} />
          {/* 中欄:收合時保留 KLinePanel 掛載(避免圖表重建/畫線重載),只以 CSS 縮成一條線 + 展開 chevron */}
          <main className={`dws-center${collapsed.c && isDesktop ? ' is-collapsed' : ''}`} aria-label="K 線工作區">
            {collapsed.c && isDesktop && (
              <button className="dws-rail-chev dws-center-expand" onClick={() => setCol('c', false)} aria-label="展開 K 線">
                <ChevronsLeftRight size={15} />
              </button>
            )}
            {isTablet && curRow && (
              <button className="dws-detbtn" onClick={() => setDetailOpen(true)} aria-haspopup="dialog">
                明細
              </button>
            )}
            {curRow ? (
              <Suspense fallback={<div className="dws-empty">載入 K 線工具…</div>}>
                {split ? (
                  /* 分割 v3(規格 17):全域控制帶(一份,橫跨兩格)+ 兩個精簡格頭;
                     十字線/時間窗雙向同步;工具兩格同進同出、動作作用於焦點格;畫線資料各自獨立 */
                  (() => {
                    const bus = getSplitBus()
                    const fl = bus.api[splitFocus()]?.flags() || {}
                    const leadPeriods = bus.api.lead?.flags()?.periods || ['day', 'week', 'month']
                    void splitTick   // 依賴 tick 重繪(焦點/旗標變化)
                    return (
                      <div className="dws-split-wrap">
                        <div className="dws-splitbar">
                          <button type="button" className="kpill-btn ksplit-btn active" title="關閉分割,回單圖"
                            aria-pressed onClick={toggleSplit}><Rows2 size={16} aria-hidden /></button>
                          <PillSelect plain ariaLabel="K 線週期(兩圖同步)" title="K 線週期(兩圖同步)" value={splitCtl.period}
                            onChange={p => setSplitCtl(c => ({ ...c, period: p }))}
                            options={['hour', 'day', 'week', 'month'].map(k => ({
                              value: k, label: ({ hour: '時', day: '日', week: '週', month: '月' })[k],
                              disabled: k === 'hour' && !leadPeriods.includes('hour'),
                            }))} />
                          <PillSelect label="圖" ariaLabel="主圖指標" title="主圖疊加(兩圖同步)" value={splitCtl.mainInd}
                            onChange={v => setSplitCtl(c => ({ ...c, mainInd: v }))}
                            options={[{ value: 'MA', label: '均線' }, { value: 'BOLL', label: '布林' }, { value: 'NONE', label: '無' }]} />
                          <div className="kpill kpill-multi">
                            <span className="kpill-lbl">副</span>
                            <PillSelect bare ariaLabel="副圖 1 指標" title="副圖 1(兩圖同步)" value={splitCtl.sub1}
                              onChange={v => setSplitCtl(c => ({ ...c, sub1: v }))}
                              options={[{ value: 'MACD', label: 'MACD' }, { value: 'KDJ', label: 'KDJ' }, { value: 'VOL', label: '量' }, { value: 'RSI', label: 'RSI' }, { value: 'NONE', label: '無' }]} />
                            <span className="kpill-sep" aria-hidden="true" />
                            <PillSelect bare ariaLabel="副圖 2 指標" title="副圖 2(兩圖同步)" value={splitCtl.sub2}
                              onChange={v => setSplitCtl(c => ({ ...c, sub2: v }))}
                              options={[{ value: 'MACD', label: 'MACD' }, { value: 'KDJ', label: 'KDJ' }, { value: 'VOL', label: '量' }, { value: 'RSI', label: 'RSI' }, { value: 'NONE', label: '無' }]} />
                          </div>
                          <KLineToolbar activeTool={splitTool} hasSelection={Boolean(fl.hasSelection)}
                            color={fl.color || '#D8DBE0'} lineWidth={fl.lineWidth || 2}
                            canUndo={Boolean(fl.canUndo)} canRedo={Boolean(fl.canRedo)}
                            hasDrawings={Boolean(fl.hasDrawings)} syncing={Boolean(fl.syncing)}
                            onTool={name => setSplitTool(cur => (cur === name ? null : name))}
                            onColor={c => Object.values(bus.api).forEach(a => a.call('setStyle', c, fl.lineWidth || 2))}
                            onLineWidth={w => Object.values(bus.api).forEach(a => a.call('setStyle', fl.color || '#D8DBE0', w))}
                            onUndo={() => splitApi('undo')} onRedo={() => splitApi('redo')}
                            onDelete={() => splitApi('removeSelected')} onClear={() => splitApi('clearAll')}
                            onExport={() => splitApi('exportChart')} onSync={() => splitApi('syncDrawings')} />
                        </div>
                        <div className="dws-split">
                          <div className="dws-split-pane" style={{ flex: `0 0 calc(${(splitRatio * 100).toFixed(2)}% - 4px)` }}>
                            <KLinePanel key={`${gUser?.email||auth.user?.nickname||'guest'}:${curRow.stkCode}:s`} row={curRow} focusMode={false} fixedTrack="stock"
                              syncBus={bus} syncRole="lead" hideControls hideToolbar axisSide="left"
                              onFocusModeChange={() => {}} onShowDetails={() => {}} />
                          </div>
                          <div className="dws-split-sep" role="separator" aria-orientation="vertical"
                            aria-label="拖動調整兩圖比例" onPointerDown={dragSplitSep} />
                          <div className="dws-split-pane">
                            <KLinePanel key={`${gUser?.email||auth.user?.nickname||'guest'}:${curRow.code}:c`} row={curRow} focusMode={false} fixedTrack="cb"
                              syncBus={bus} syncRole="follow" hideControls hideToolbar
                              onFocusModeChange={() => {}} onShowDetails={() => {}} />
                          </div>
                        </div>
                      </div>
                    )
                  })()
                ) : (
                  <KLinePanel key={`${gUser?.email||auth.user?.nickname||'guest'}:${curRow.stkCode}`} row={curRow} focusMode={false}
                    splitControl={{ active: false, onToggle: toggleSplit }}
                    onFocusModeChange={() => {}} onShowDetails={() => {}} />
                )}
              </Suspense>
            ) : <div className="dws-empty">左側點選 CB 即可看圖</div>}
          </main>
          {isDesktop && <div className="dws-sep dws-sep--r" role="separator" aria-orientation="vertical" aria-label="拖動調整明細欄寬"
            onPointerDown={dragPane('r')} />}
          {isDesktop && (collapsed.r && !rDrag ? <Rail side="r" /> : <aside className="dws-right" aria-label="可轉債明細">
            {curRow ? (
              <>
                <div className="dws-dethead">
                  <h2>{curRow.name}<span className="code">{curRow.code}</span>
                    <span className="dstk-badge">{curRow.isEB ? <>換 {curRow.stk} {curRow.stkCode}</> : <>{curRow.stk} {curRow.stkCode}</>}</span>
                    {curRow.isEB && <span className="eb-tag">交換債</span>}
                  </h2>
                  <button className={`dtool watch${watched ? ' on' : ''}`} onClick={() => toggleWatch(curRow.code)}
                    aria-label={watched ? '移除關注' : '加入我的關注'} aria-pressed={watched}
                    title={watched ? '已關注(點移除)' : '加入我的關注'}>
                    <Star size={15} fill={watched ? 'currentColor' : 'none'} />
                  </button>
                </div>
                {/* 區塊 tab:點/移到即捲到該節,免逐一點開 */}
                <nav className="det-tabs" aria-label="明細區塊">
                  {DETAIL_SECTIONS.map(s => (
                    <button key={s.key} className={`det-tab${detSpy === s.key ? ' on' : ''}`}
                      onClick={() => {
                        const el = document.getElementById(`det-sec-${s.key}`)
                        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}>{s.title}</button>
                  ))}
                </nav>
                <div className="dsections dws-dsections" ref={detScrollRef}>
                  <DetailSections row={curRow} today={data?.today} stratId={qNorm ? 'all' : stratId} allOpen />
                </div>
              </>
            ) : <div className="dws-empty">點選左側 CB 查看明細</div>}
          </aside>)}
        </div>
        {isTablet && (
          <Drawer row={detailOpen ? curRow : null} today={data?.today} stratId={qNorm ? 'all' : stratId}
            hideChart onClose={() => setDetailOpen(false)}
            watched={watched} onToggleWatch={() => curRow && toggleWatch(curRow.code)} />
        )}
      </div>
    )
  }

  // ── 手機/窄版:現行版面(凍結不動)──
  return (
    <div className="app">
      {/* ── 第 1 列:品牌字標 ── */}
      <div className="bar1">
        <div className="brand">
          <span className="brand-badge" aria-hidden><img src={brandDiamond} alt="" /></span>
          <span className="brand-word">Parity<i>·</i>Desk</span>
        </div>
        {accountEl}
      </div>

      {/* ── 第 2 列:策略頁籤 + 搜尋(同一行) ── */}
      <div className="bar2">
        {tabsNav}
        {searchEl}
      </div>

      {chipRowEl}
      {watchBarEl}
      {bar3El}
      {staleEl}

      <div className={`tablewrap ${slideDir}`}>{tableEl}</div>

      <div className="pagenotice">
        數據為公開資料理論值、CBAS 為試算,非買賣建議。資料每日盤後更新(資料日 {data ? fmtDate(data.today) : '–'})·來源 資料來源方。
      </div>

      <Drawer row={curRow} today={data?.today} stratId={qNorm ? 'all' : stratId} onClose={closeDetail}
        watched={curCode ? activeCodes.has(curCode) : false} onToggleWatch={() => curCode && toggleWatch(curCode)} />
    </div>
  )
}
