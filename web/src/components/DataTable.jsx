import React from 'react'
import { createPortal } from 'react-dom'
import { Flame, Shield, Star, TrendingUp } from 'lucide-react'
import { cls, fmt, heatLv, statusWord, creditLight, hasGuar, cbas, stratTagsFor, netDiscount, groupByUnderlying } from '../logic.js'
import { StratIcon } from '../icons.jsx'

/* 現股價格式:高價股(>500)不帶小數,其餘 2 位 */
const fmtStk = v => v == null ? '－' : Number(v).toFixed(v > 500 ? 0 : 2)
/* 剩餘年期:不到 ~44 天(0.12 年)就換單位顯示「天」,避免沒意義的「0.0 y」;已到/過=到期 */
const remLabel = y => {
  if (y == null) return '－'
  if (y < 0.12) { const d = Math.round(y * 365.25); return d <= 0 ? '到期' : `${d} 天` }
  return `${y.toFixed(1)} 年`
}
/* 帶正號數字 */
const fmtSig = (v, d = 1) => v == null ? '－' : (v > 0 ? '+' : '') + Number(v).toFixed(d)

/* 現股走勢迷你 sparkline(近 N 日收盤;台股紅漲綠跌:末值≥首值→紅,否則綠)。無資料回 null。 */
function Sparkline({ data, w = 66, h = 18 }) {
  if (!Array.isArray(data) || data.length < 2) return null
  const min = Math.min(...data), max = Math.max(...data), rng = (max - min) || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1) * w).toFixed(1)},${(h - (v - min) / rng * h).toFixed(1)}`).join(' ')
  const up = data[data.length - 1] >= data[0]
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/* 發動訊號:|股債乖離| ≤ 3.5 = CB 與現股高連動(mockup isFiring) */
const isFiring = r => r.dev != null && Math.abs(r.dev) <= 3.5

/* 關注星號:表格/卡片列上直接加入或移除「我的關注」,不需開抽屜 */
function StarBtn({ on, onClick }) {
  return (
    <button type="button" className={`starbtn${on ? ' on' : ''}`} onClick={onClick}
      aria-label={on ? '從我的關注移除' : '加入我的關注'} title={on ? '從我的關注移除' : '加入我的關注'}>
      <Star size={15} strokeWidth={2.2} fill={on ? 'currentColor' : 'none'} aria-hidden />
    </button>
  )
}

/* HeatPill:抽屜關鍵數/大數區沿用的熱度膠囊(表格內用雙向量表,見 heatCell) */
export function HeatPill({ h }) {
  return (
    <span className={`heat heat-${heatLv(h)}`}>
      <Flame size={11} strokeWidth={2.5} fill={h >= 4 ? 'currentColor' : 'none'} aria-hidden />
      {h > 0 ? `+${h}` : h}
    </span>
  )
}

/* ── mockup 台股語義:紅正綠負;fmtPct 帶正號 ── */
const fmtPct = v => v == null ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'
const signCls = v => v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : ''
const Dim = () => <span className="dim">–</span>

function signSpan(v, hero) {
  if (v == null) return <Dim />
  return <span className={`${hero ? 'hero ' : ''}${signCls(v)}`}>{fmtPct(v)}</span>
}

/* ── 折價套利執行面:淨折價(hero)/ 借券難易度 / 轉換狀態 / 除權息日 ── */
function netDiscCell(r) {
  const n = netDiscount(r)
  if (!n) return <Dim />
  const v = n.net
  return <span className={`hero ${v > 0 ? 'down' : 'up'}`}>{(v > 0 ? '+' : '') + v.toFixed(2)}</span>
}
function borrowCell(r) {
  const b = r.borrow?.borrowBal
  if (b == null) return <span className="dim">無資料</span>
  const [w, c] = b > 2000 ? ['易', 'down'] : b > 200 ? ['中', 'warn'] : ['難', 'up']
  return <span className={c}>{w}</span>
}
function stopConvCell(r) {
  return r.stopNow ? <span className="up">停轉中</span> : <span className="down">開放</span>
}
function exDivCell(r) {
  const d = r.exDiv?.exDivDate || r.exDiv?.exRightDate
  return d ? <span className="warn">{`${d.slice(4, 6)}/${d.slice(6, 8)}`}</span> : <span className="dim">近期無</span>
}

/* 熱度雙向量表:0 中線,正橘向右 / 負綠向左,右側數字著色分級 */
function heatCell(v) {
  if (v == null) return <Dim />
  const pos = v >= 0
  const p = Math.min(Math.abs(v) / 10, 1) * 50
  const col = pos ? 'var(--heat-warm)' : 'var(--heat-cool)'
  const fillStyle = pos
    ? { left: '50%', width: `${p}%`, background: col }
    : { right: '50%', width: `${p}%`, background: col }
  const tc = v === 0 ? 'var(--heat-mid)' : pos ? (v >= 7 ? 'var(--heat-hot)' : 'var(--heat-warm)') : 'var(--heat-cool)'
  return (
    <span className="heatcell">
      <span className="hbar"><span className="mid" /><span className="fill" style={fillStyle} /></span>
      <span className="hval" style={{ color: tc }}>{v > 0 ? '+' : ''}{Number(v).toFixed(1)}</span>
    </span>
  )
}

/* 信用色點+字(mockup:穩健綠 / 中性橘 / 偏弱紅 / 無評等灰) */
const CREDIT_MAP = { green: ['cd-g', '穩健'], yellow: ['cd-a', '中性'], red: ['cd-r', '偏弱'], unknown: ['cd-n', '無評等'] }
function creditCell(r) {
  const [dot, word] = CREDIT_MAP[creditLight(r).level] || CREDIT_MAP.unknown
  return <span className="tcredit"><i className={`tdot ${dot}`} />{word}</span>
}

/* 安全度(賣回頁):有擔保→綠盾優先,否則落回信用 */
function safetyCell(r) {
  if (hasGuar(r)) return <span className="tsafe"><Shield size={14} aria-hidden />有擔保</span>
  return creditCell(r)
}

/* 擔保欄:有擔保→綠盾,否則淡破折號 */
function guarCell(r) {
  return hasGuar(r) ? <span className="tguar"><Shield size={15} aria-hidden /></span> : <Dim />
}

/* 距賣回:即將 / x.x 年,近賣回(<0.12 年)轉琥珀 */
function putDays(r) {
  const y = r.yrsToPut
  if (y == null) return <Dim />
  const amber = y < 0.12
  return <span className={amber ? 'warn' : ''}>{remLabel(y)}</span>
}

/* CBAS 槓桿倍數(hero,金)/ 權利金(試算)——公式在 logic.cbas,貼在債底時權利金趨近零 */
function cbasLevCell(r) {
  const c = cbas(r)
  if (!c || !c.lev) return <Dim />
  return <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{c.lev.toFixed(1)}×</span>
}
function cbasPremCell(r) {
  const c = cbas(r)
  if (!c) return <Dim />
  return c.atFloor ? <span className="dim">趨近0</span> : c.premium.toFixed(2)
}

/* 策略標籤(全市場地圖分流欄):inline SVG icon + 標籤,禁 emoji */
function stratCell(r, onStrat) {
  const tags = stratTagsFor(r)
  if (!tags.length) return <Dim />
  return (
    <span className="stratcell">
      {tags.map(t => (
        <button key={t.id} type="button" className="stag"
          onClick={e => { e.stopPropagation(); onStrat?.(t.id, r.code) }} title={`用 ${t.label} 角度看這檔`}>
          <StratIcon id={t.id} size={15} />{t.label}
        </button>
      ))}
    </span>
  )
}

const MCOL = {
  dev: { label: '股債乖離', sub: 'CB 比股票貴幾 %', sk: 'dev', render: r => signSpan(r.dev) },
  devHero: { label: '股債乖離', sub: 'CB 比股票貴幾 %', sk: 'devHero', render: r => signSpan(r.dev, true) },
  heat: { label: '熱度', sub: '−10 ~ +10', sk: 'heat', render: r => <HeatPill h={r.heat} /> },
  heatHero: { label: '熱度', sub: '進場溫度計', sk: 'heatHero', render: r => <HeatPill h={r.heat} /> },
  putYtmHero: { label: '賣回殖利率', sub: '抱到賣回年化', sk: 'putYtmHero', render: r => signSpan(r.putYtm, true) },
  ytm: { label: '到期殖利率', sub: '抱到到期年化', sk: 'ytm', render: r => signSpan(r.ytm) },
  yrsPut: { label: '距賣回', sub: '剩餘年', sk: 'yrsPut', render: putDays },
  unconv: { label: '未轉換', sub: '籌碼觀察值', sk: 'unconv', render: r => r.unconv != null ? `${Math.round(r.unconv)}%` : <Dim /> },
  credit: { label: '信用狀態', sub: '發行公司體質', sk: 'credit', render: creditCell },
  safety: { label: '安全度', sub: '擔保＋信用', sk: 'safety', render: safetyCell },
  guar: { label: '擔保', sub: '', sk: 'guar', render: guarCell, cls: 'guarcol' },
  cb: { label: 'CB 價', sub: '', sk: 'cbPx', render: r => r.cbPx != null ? Number(r.cbPx).toFixed(2) : <Dim /> },
  pat: { label: '型態訊號', sub: '老師追蹤中', sk: 'pattern', render: r => r.pattern ? r.pattern : <Dim /> },
  cbasLev: { label: '槓桿倍數', sub: '轉換價值÷權利金', sk: 'cbasLev', render: cbasLevCell },
  cbasPrem: { label: '權利金', sub: '試算·非券商報價', sk: 'cbasPrem', render: cbasPremCell },
  strat: { label: '策略', sub: '較符合角度', sk: 'strat', render: stratCell, cls: 'stratcol' },
  netDisc: { label: '淨折價', sub: '扣手續費/除息', sk: 'netDisc', render: netDiscCell },
  borrowDiff: { label: '借券難易度', sub: '可否放空現股', sk: 'borrowDiff', render: borrowCell },
  stopConv: { label: '轉換狀態', sub: '開放才可套利', render: stopConvCell },
  exDiv: { label: '除權息日', sub: '股利補償參考', render: exDivCell },
  // 新 IA(訊號)欄位:
  priceHero: { label: 'CB 價', sub: '收盤', sk: 'cbPx',
    render: r => <b className="px-cb">{r.cbPx != null ? Number(r.cbPx).toFixed(1) : '－'}</b> },
  convDist: { label: '距轉換價', sub: '現股 vs 換股價', sk: 'convDist',
    render: r => {
      if (r.convDist == null) return <Dim />
      const a = Math.abs(r.convDist)
      // 訊號「距轉換價抓 3~5%」(2026-08 訊號審查會定調):≤3 核心濃金、3~5 區間淡金、>5 中性
      const tier = a <= 3 ? 'near' : a <= 5 ? 'approach' : ''
      return <span className={`cdist ${tier}`}>{r.convDist > 0 ? '+' : ''}{r.convDist.toFixed(1)}%</span>
    } },
  prem: { label: '折/溢價', sub: 'CB 比平價', sk: 'prem',
    render: r => r.prem == null ? <Dim /> : signSpan(r.prem) },
}

/* 行動版:兩行摘要列(桌面表格窄螢幕陣亡;重排才是正解) */
/* 手機卡片指標=該策略在乎的欄(排除熱度:已在右上 pill、排除純圖示欄);取前 3 個 */
/* 手機版型 ⑦(定版):無卡片、欄化對齊。欄=標的/CB · 價 · 距轉 · 未轉 · 賣回 · 折溢。
   現股列=本體(現股價入「價」欄 + 走勢 sparkline 占右側空欄);CB 列=純 5 指標(無 sparkline)。
   髮絲線分列、群組間大留白、發動 ▎琥珀色條、數字等寬右對齊、紅漲綠跌、到位度(≤3~5%)琥珀。 */
function MobileList({ list, onOpen, watch, onWatch, history, sort, onSort, stratId, current }) {
  const groups = groupByUnderlying(list)
  // 可排序表頭:點一下依該欄排序,當前排序欄轉金 + ▼/▲
  const MHead = ({ label, sub, sk }) => (
    <span className={`m7-h${sort?.key === sk ? ' sorted' : ''}`} role="button" tabIndex={0}
      onClick={() => onSort?.(sk)}>
      {label}{sort?.key === sk ? (sort.dir < 0 ? ' ▼' : ' ▲') : ''}<i>{sub}</i>
    </span>
  )
  return (
    <div className="mlist">
      <div className="m7 m7-head">
        <span className="c-name">標的 / CB</span>
        <MHead label="價格" sub="收盤" sk="cbPx" />
        <MHead label="距轉" sub="vs換股價" sk="convDist" />
        <MHead label="未轉" sub="籌碼" sk="unconv" />
        <MHead label="賣回" sub="剩餘年" sk="yrsPut" />
        <MHead label="折溢" sub="比平價" sk="prem" />
      </div>
      {list.length ? groups.map(g => {
        // 型態掛在現股(同股各 CB 共用):放現股列 sparkline 旁
        const gPat = g.rows.find(r => r.pattern)?.pattern
        return (
        <div className="m7grp" key={g.key}>
          <div className="m7 m7-stk" role="button" tabIndex={0}
            onClick={() => onOpen(g.rows[0].code)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(g.rows[0].code) } }}>
            <span className="c-name"><b>{g.stk || g.rows[0].name}</b><i>{g.stkCode || ''}</i>{g.isEB && <em className="eb">交換</em>}{gPat && <em className="gpat-badge">{gPat}</em>}</span>
            <b className="c-px">{g.stkPx != null ? '$' + fmtStk(g.stkPx) : '－'}</b>
            <span className="c-spark"><Sparkline data={history?.[g.stkCode]?.c} /></span>
          </div>
          {g.rows.map(r => {
            const fire = r.convDist != null && Math.abs(r.convDist) <= 3
            return (
              <div className={`m7 m7-cb${fire ? ' fire' : ''}${current === r.code ? ' cur' : ''}`} key={r.code} role="button" tabIndex={0}
                onClick={() => onOpen(r.code)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r.code) } }}>
                <span className="c-name">
                  {onWatch && <StarBtn on={watch?.has(r.code)} onClick={e => { e.stopPropagation(); onWatch(r.code) }} />}
                  {r.pattern && <i className="pat-dot" title={`型態訊號:${r.pattern}`} />}
                  <span className="nm">{r.name}</span><i>{r.code}</i>
                </span>
                <b className="c-px">{r.cbPx != null ? '$' + Number(r.cbPx).toFixed(1) : '－'}</b>
                <span className="sig">{r.convDist != null ? fmtSig(r.convDist) + '%' : '－'}</span>
                <span className="dimv">{r.unconv != null ? Math.round(r.unconv) + '%' : '－'}</span>
                <span className="dimv">{remLabel(r.yrsToPut)}</span>
                <span>{r.prem != null ? fmtSig(r.prem) + '%' : '－'}</span>
              </div>
            )
          })}
        </div>
      )}) : null}
      {!list.length && createPortal(
        <div className="empty-portal">{stratId === 'watch'
          ? <>點任一檔的 <span className="empty-star">☆</span>,加入你想追蹤的可轉債</>
          : '今天沒有符合這個策略的可轉債,換個策略看看吧'}</div>,
        document.body,
      )}
    </div>
  )
}

/* 表頭欄:可排序(有 sk)→ 點擊 onSort;當前排序欄顯示金色 ▼/▲ */
function HeadCell({ label, sub, cls: c, sk, sort, onSort }) {
  const on = sk && sort?.key === sk
  return (
    <th className={`${c || ''}${on ? ' sorted' : ''}`}
      onClick={sk ? () => onSort(sk) : undefined}
      style={sk ? undefined : { cursor: 'default' }}>
      {label}{on && <span className="sar">{sort.dir < 0 ? '▼' : '▲'}</span>}
      {sub && <span className="sub">{sub}</span>}
    </th>
  )
}

function DataTable({ list, cols, onOpen, onStrat, sort, onSort, stratId, watch, onWatch, history, current }) {
  // 發動 icon(高連動)只在「發動」與「全市場地圖」頁出現;其餘頁各看自己的標誌,不放跨策略的發動記號
  const showFire = stratId === 'fire' || stratId === 'all'
  const shown = cols.filter(k => MCOL[k])
  return (
    <>
      <MobileList list={list} onOpen={onOpen} watch={watch} onWatch={onWatch} history={history} sort={sort} onSort={onSort} stratId={stratId} current={current} />
      <table>
        <thead>
          <tr>
            <HeadCell label="CB / 現股" cls="idc l" sk="id" sort={sort} onSort={onSort} />
            {shown.map(k => (
              <HeadCell key={k} label={MCOL[k].label} sub={MCOL[k].sub} cls={MCOL[k].cls}
                sk={MCOL[k].sk} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {list.length ? groupByUnderlying(list).map(g => (
            <React.Fragment key={g.key}>
              {/* 現股表頭列(本體):現股名/代號在身分欄、現股價對齊 CB 價欄、其餘欄位橫幅顯示檔數 */}
              <tr className={`ghead${g.multi ? ' multi' : ''}`} onClick={() => onOpen(g.rows[0].code)}>
                <td className="idc ghead-id">
                  <span className="gh-nm">{g.stk || g.rows[0].name}</span>
                  <span className="gh-cd">{g.stkCode || ''}</span>
                  {g.isEB && <span className="eb-tag">交換標的</span>}
                </td>
                <td className="ghead-px">現股 <b>{fmtStk(g.stkPx)}</b></td>
                <td className="ghead-meta" colSpan={Math.max(shown.length - 1, 1)}>
                  {g.multi ? `${g.rows.length} 檔可轉債` : ''}
                </td>
              </tr>
              {g.rows.map(r => (
                <tr key={r.code} className="grow" onClick={() => onOpen(r.code)}>
                  <td className="idc">
                    <div className="idcell">
                      {onWatch && <StarBtn on={watch?.has(r.code)} onClick={e => { e.stopPropagation(); onWatch(r.code) }} />}
                      <div className="idmeta">
                        <div className="idname">{r.name}
                          <span className="code">{r.code}</span>
                          {r.isEB && <span className="eb-tag" title={`交換公司債:${r.issuerName} ${r.issuerCode} 發行,可交換為 ${r.stk} ${r.stkCode} 股票`}>交換債</span>}
                        </div>
                        {(r.pattern || r.isEB) && (
                          <div className="idsub">
                            {r.pattern && <span className="pat-tag">{r.pattern}</span>}
                            {r.isEB && <span className="eb-issuer">發行 {r.issuerName} {r.issuerCode}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  {shown.map(k => (
                    <td key={k} className={MCOL[k].cls || ''}>{MCOL[k].render(r, onStrat)}</td>
                  ))}
                </tr>
              ))}
            </React.Fragment>
          )) : (
            <tr><td colSpan={shown.length + 1} className="empty">{stratId === 'watch'
              ? '還沒有關注任何可轉債。在精選訊號或全市場點 ☆ 就能加進來,建立你自己的觀察清單。'
              : '今天沒有符合這個策略的可轉債,換個策略看看吧'}</td></tr>
          )}
        </tbody>
      </table>
    </>
  )
}

// memo:hover 動畫時 App 因 tab 底線逐幀量測而每幀重渲染,383 列清單若無 memo 會跟著每幀重建
// (profiler 實測=全市場 hover 卡的主因)。props 由 App 端 useCallback/useMemo 穩定化。
export default React.memo(DataTable)
