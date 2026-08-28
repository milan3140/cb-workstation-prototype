import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, ChevronDown, Maximize2, Minimize2, Star, X } from 'lucide-react'
import {
  CBAS_DEFAULT_DISCOUNT, DISCOUNT, cbas, cbasApplicability, cbasImpliedDiscount, cls, fmt,
  creditLight, forceCallStatus, hasGuar, heatWord, netDiscount, stratVerdict, stratTagsFor, STRATS,
} from '../logic.js'
import { convWindow, custodyRead, fmtDate, legalRead, loadCbDetail } from '../cbDetail.js'
import { HeatPill } from './DataTable.jsx'
import { StratIcon } from '../icons.jsx'
import Info from './Info.jsx'

const KLinePanel = lazy(() => import('./kline/KLinePanel.jsx'))

const fmtD8 = s => { const d = String(s || '').replace(/\//g, ''); return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}` : '－' }

/* 一行 key-value(分隔線/留白語彙,非卡片):dt 左、dd 右,底線分列 */
function KV({ k, v, tone, tip, strong }) {
  return (
    <div className="kvrow">
      <dt>{k}{tip && <Info tip={tip} />}</dt>
      <dd className={`kvv${tone ? ` ${tone}` : ''}${strong ? ' strong' : ''}`}>{v}</dd>
    </div>
  )
}

/* ── 漸進揭露分段(mockup:sechead + chevron,secbody collapse)── */
function Section({ title, defaultOpen = false, children, onOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) onOpen?.()
  }
  return (
    <div className={`sec${open ? ' open' : ''}`}>
      <button type="button" className="sechead" onClick={toggle} aria-expanded={open}>
        {title}<ChevronDown size={15} aria-hidden />
      </button>
      <div className="secbody">{children}</div>
    </div>
  )
}

/* ── 第 2 段:本策略關鍵數(清單那格的展開,不與清單重複)── */
function KeyStats({ row: r, stratId, today }) {
  const c = creditLight(r)
  if (stratId === 'floor') {
    return (
      <dl className="kvlist">
        <KV k="賣回殖利率" v={r.putYtm != null ? `${fmt(r.putYtm)}%` : '－'} tone={cls(r.putYtm)}
          tip={{ text: '把可轉債當債券持有、抱到最近的賣回日、由公司按約定賣回價買回,換算成的年化報酬。正值代表以現價買進、放到賣回日就有保底價差可拿,數值越高保底空間越大;但這筆報酬能否實現,取決於公司屆時付不付得出錢,因此須搭配下方信用體質一起看。', formula: '(賣回價 − CB 市價) ÷ CB 市價,再年化' }} />
        <KV k="到期殖利率" v={r.ytm != null ? `${fmt(r.ytm)}%` : '－'} tone={cls(r.ytm)}
          tip="用現價買、抱到到期還本 100 的年化報酬(台灣 CB 多零息,常為負)" />
        <KV k="賣回價 / 現價" v={r.putPx ? `${fmt(r.putPx)} / ${fmt(r.cbPx, 1)}` : '－'} />
        <KV k="信用體檢" v={<span className={`clight cl-${c.level}`}><i />{c.word}</span>} />
        <p className="kvnote">殖利率異常偏高常反映市場對履約能力的疑慮,務必交叉看下方「信用體檢」——「契約下檔參考」不能替代信用判斷。</p>
      </dl>
    )
  }
  if (stratId === 'fire') {
    const f = forceCallStatus(r)
    return (
      <dl className="kvlist">
        <KV k="型態訊號" v={r.pattern ? <span className="tag tag-pat">{r.pattern}</span> : <span className="dim">未符合追蹤型態</span>} />
        <KV k="熱度" v={<HeatPill h={r.heat} />} />
        <KV k="強制贖回風險" v={<span className={`fcall fc-${f.level}`}>{f.word}</span>}
          tip="觸價=轉換價×贖回啟動比率%;現股達觸價→觸發中、≥90%→接近。強贖=可能提前贖回的監測,非保證" />
        {f.triggerPx != null && <KV k="強贖觸價 / 連續天數" v={`${fmt(f.triggerPx, 1)} 元 / ${f.days != null ? `${f.days} 天` : '－'}`} />}
      </dl>
    )
  }
  if (stratId === 'discount') {
    const nd = netDiscount(r, today)
    return (
      <dl className="kvlist">
        <KV k="折價毛額" v={nd ? `${fmt(nd.gross, 1)} 元` : '－'} tone={nd ? cls(nd.gross) : ''}
          tip="折價毛額 = 轉換價值 − CB 現價(每百元計);>0 才是折價" />
        <KV k="− 交易手續費" v={`${fmt(DISCOUNT.fee, 1)} 元`} />
        <KV k="− 近除息補償" v={<span className="dim">無現金股利資料源,僅標記未計入</span>} />
        <KV k="− 借券費率" v={<span className="dim">需券商/未接,未計入</span>} />
        <KV k="= 淨折價(上限估計)" v={nd ? <b className={cls(nd.net)}>{fmt(nd.net, 1)} 元</b> : '－'} />
        <KV k="停轉狀態" v={r.stopNow ? <span className="fcall fc-trig">停轉中</span> : <span className="fcall fc-far">開放轉換</span>} />
      </dl>
    )
  }
  if (stratId === 'heatcb') {
    return (
      <dl className="kvlist">
        <KV k="未轉換" v={r.unconv != null ? `${fmt(r.unconv, 0)}%` : '－'}
          tip="仍未換成股票的 CB 佔比;高=籌碼觀察值,非上漲保證" />
        <KV k="距轉換價" v={r.parity != null ? `${fmt(r.parity - 100, 1)}%` : '－'} tone={r.parity != null ? cls(r.parity - 100) : ''}
          tip="現股相對轉換價的 %;負=仍在轉換價下方(誘因仍在)" />
        <KV k="剩餘年期" v={r.yrsToPut != null ? `${fmt(r.yrsToPut, 1)} 年` : '－'} tip="距最近賣回日;越短、轉換壓力越高" />
        <KV k="型態訊號 / 熱度" v={<>{r.pattern ? <span className="tag tag-pat">{r.pattern}</span> : <span className="dim">未符合</span>} <HeatPill h={r.heat} /></>} />
      </dl>
    )
  }
  if (stratId === 'cbas') {
    const cc = cbas(r)
    const rel = (r.cbPx != null && r.putPx != null) ? r.cbPx - r.putPx : null
    return (
      <dl className="kvlist">
        <KV k="槓桿倍數" v={cc && cc.lev ? `${fmt(cc.lev, 1)} 倍` : '－'} tip="槓桿倍數 = 轉換價值 ÷ 權利金" />
        <KV k="所需權利金" v={cc ? (cc.atFloor ? '趨近於零' : `${fmt(cc.premium)} 元`) : '－'} tip="權利金 =(CB−100)＋百元報價;越小放大越多" />
        <KV k="相對賣回價" v={rel != null ? `${fmt(rel, 1)} 元` : '－'} tone={rel != null ? cls(rel) : ''}
          tip="CB 市價 − 賣回價;越接近下檔越有條款保護" />
        <p className="kvnote">以上為系統公式情境試算,非券商可成交報價;實際權利金以券商報價為準(見下方 CBAS 試算)。</p>
      </dl>
    )
  }
  if (stratId === 'pick' || stratId === 'all' || stratId === 'watch') {
    // 精選訊號 / 全市場 / 我的關注:到位度(距轉換價)為主角,配型態/熱度/籌碼/下檔
    const a = r.convDist != null ? Math.abs(r.convDist) : null
    return (
      <dl className="kvlist">
        <KV k="距轉換價(到位度)" v={r.convDist != null
          ? <b className={`cdist ${a <= 3 ? 'near' : a <= 5 ? 'approach' : ''}`}>{r.convDist > 0 ? '+' : ''}{fmt(r.convDist, 1)}%</b>
          : '－'}
          tip="現股相對換股價的距離;訊號「抓 3~5%」= 發動到位甜蜜點(≤3% 核心濃金、3~5% 區間淡金)" />
        <KV k="型態訊號" v={r.pattern ? <span className="tag tag-pat">{r.pattern}</span> : <span className="dim">未符合追蹤型態</span>} />
        <KV k="熱度" v={<HeatPill h={r.heat} />} />
        <KV k="未轉換" v={r.unconv != null ? `${fmt(r.unconv, 0)}%` : '－'} tip="仍未換成股票的 CB 佔比;高=籌碼未耗盡,上檔想像空間仍在" />
        <KV k="距賣回" v={r.yrsToPut != null ? `${fmt(r.yrsToPut, 1)} 年` : '－'} tip="距最近賣回日;越短越有下檔保護,但轉換壓力也越高" />
        <KV k="折/溢價" v={r.prem != null ? `${r.prem > 0 ? '+' : ''}${fmt(r.prem, 1)}%` : '－'}
          tip="CB 市價相對百元平價的溢/折;正=溢價(比換股貴)、負=折價(比換股便宜)" />
      </dl>
    )
  }
  // all / 搜尋 / 我的關注:中性總覽
  const tags = stratTagsFor(r)
  return (
    <dl className="kvlist">
      <KV k="較符合策略" v={tags.length
        ? <span className="stratcell">{tags.map(t => <span key={t.id} className="stag stag-static"><StratIcon id={t.id} size={12} />{t.label}</span>)}</span>
        : <span className="dim">目前未落入明確策略</span>} />
      <KV k="股債乖離" v={r.dev != null ? `${fmt(r.dev)}%` : '－'} tone={cls(r.dev)}
        tip={{ text: '衡量可轉債目前的價格,比它「立即換成股票的價值」貴或便宜。正值代表市場為其後續上漲多付了溢價;負值代表買可轉債比直接買現股還便宜(折價),當折價幅度足以覆蓋交易與借券成本時,可透過買債、放空現股、再轉換交割賺取價差。數值越接近零,可轉債與現股的漲跌連動越同步。', formula: '(CB 市價 − 轉換價值) ÷ 轉換價值' }} />
      <KV k="性質" v={r.nature || '－'} />
    </dl>
  )
}

/* ── 第 3 段:契約條款(以 raw.json 的 cbBasic 為主,cb_terms.json 有則補;強贖=觸發比率+連續天數+現況)── */
function TermsBlock({ row: r, terms, today }) {
  const b = r.cbBasic || {}
  const f = forceCallStatus(r)
  const conv = convWindow(terms, today)
  const putSched = Array.isArray(b.putSchedule) ? b.putSchedule : []
  const [more, setMore] = useState(false)
  return (
    <dl className="kvlist kvlist-flat">
      {r.isEB && <KV k="發行公司" v={`${r.issuerName || '－'}${r.issuerCode ? ` ${r.issuerCode}` : ''}`} strong />}
      <KV k="轉換價" v={r.convPx != null ? `${fmt(r.convPx, 1)} 元` : '－'} strong />
      <KV k="到期日 / 到期價" v={`${r.matDate ? fmtD8(r.matDate) : '－'} / ${b.matPrice != null ? fmt(b.matPrice) : '100'}`} strong />
      <KV k="擔保" v={String(r.guar || '').startsWith('有') ? '有擔保' : '無擔保'} strong />
      <KV k="強制贖回風險" v={<span className={`subwrap${f.level !== 'trig' ? ' dim' : ''}`}>
        <span className={`fcall fc-${f.level}`}>{f.word}</span>
        {f.trigger != null && <span className="schedchip">觸發 {f.trigger}%・連續 {f.days != null ? `${f.days} 天` : '－'}{f.triggerPx != null ? `・觸價 ${fmt(f.triggerPx, 1)}` : ''}</span>}
      </span>} tip={{ text: '發行公司在現股漲到約定門檻、並維持一段約定天數後,有權用約定價把可轉債強制買回。系統即時比對現股與觸發價:達門檻為「觸發中」、接近九成為「接近」。一旦觸發,可轉債的上漲空間會被鎖住,持有人須在短時間內選擇轉換或被贖回——這是可轉債深度價內時最需要留意的風險。', formula: '觸發價 = 轉換價 × 贖回啟動比率(%)' }} />
      {more && <>
        <KV k="賣回排程" v={putSched.length
          ? <span className="subwrap">{putSched.map((p, i) => <span key={i} className="schedchip">{fmtD8(p.date)} @ {fmt(p.price)}{p.ytm != null ? `（${fmt(p.ytm)}%）` : ''}</span>)}</span>
          : (r.putDate ? `${r.putDate} @ ${fmt(r.putPx)}` : <span className="dim">無(永續/未設)</span>)} />
        <KV k="轉換期" v={(b.convStart || b.convEnd) ? `${fmtD8(b.convStart)} ～ ${fmtD8(b.convEnd)}` : '－'} />
        {(b.stopConvStart || b.stopConvEnd) && (() => {
          const past = /^\d/.test(String(b.stopConvEnd || '')) && String(b.stopConvEnd).replace(/\//g, '') < String(today || '').replace(/\//g, '')
          if (past) return null   // 停止轉換期間已過去 → 乾脆不顯示
          return (
            <KV k="停止轉換期間" v={<span className="subwrap">{fmtD8(b.stopConvStart)} ～ {fmtD8(b.stopConvEnd)}{b.stopConvReason ? <span className="schedchip">{b.stopConvReason}</span> : ''}</span>}
              tone={r.stopNow ? 'warn' : ''} />
          )
        })()}
        {r.prospectus && <KV k="發行辦法" v={<a href={r.prospectus} target="_blank" rel="noopener noreferrer" className="prospectus-link">官方說明書 PDF <ArrowUpRight size={12} aria-hidden /></a>} />}
      </>}
      <button type="button" className={`kv-more${more ? ' open' : ''}`} onClick={() => setMore(m => !m)}>
        {more ? '收合' : '更多條款'}<ChevronDown size={14} className="kv-more-ic" aria-hidden />
      </button>
    </dl>
  )
}

/* ── 第 4 段:信用體檢(負債/速動/利保/Z/信評;credit)── */
function CreditBlock({ row: r }) {
  const c = r.credit
  const light = creditLight(r)
  if (!c) return <p className="kvnote dim">此檔尚無信用/財務資料。</p>
  const rankNum = v => Number.isFinite(v) ? String(v) : '－'
  return (
    <>
    {r.isEB && (
      <p className="kvnote eb-note">
        此為<b>交換公司債</b>:由 <b>{r.issuerName} {r.issuerCode}</b> 發行、可交換為 {r.stk} {r.stkCode} 股票。
        以下信用體檢評估的是<b>發行公司({r.issuerName})</b>——償還賣回/到期本金的一方,<b>非</b>交換標的({r.stk})。
      </p>
    )}
    <dl className="kvlist">
      <KV k="綜合體質" v={<span className={`clight cl-${light.level}`}><i />{light.word}</span>} />
      <KV k="負債比" v={Number.isFinite(c.debtRatio) ? `${fmt(c.debtRatio, 1)}%` : '－'} tip="總負債 ÷ 總資產;越高財務槓桿越大" />
      <KV k="速動比" v={Number.isFinite(c.quickRatio) ? `${fmt(c.quickRatio, 1)}%` : '－'} tip="速動資產 ÷ 流動負債;>100% 短期償債較穩" />
      <KV k="利息保障倍數" v={Number.isFinite(c.interestCover) ? `${fmt(c.interestCover, 1)} 倍` : '－'} tip="營業利益 ÷ 利息費用;越高付息能力越強" />
      <KV k="Z–Score" v={Number.isFinite(c.zScore) ? fmt(c.zScore) : '－'} tip="Altman Z:>2.99 安全區、1.81~2.99 灰色、<1.81 危險區" />
      <KV k="信用評分 信評 / 財務信評" v={`${rankNum(c.credScore)} / ${rankNum(c.finRating)}`}
        tip={{ text: '信用評分 信評=資料來源方 以財務與市場資料綜合評出的「信用風險」等級;財務信評=從季財務比率(獲利能力、負債結構、償債能力)綜合出的「財務體質」等級。兩者都是把全市場公司分成 9 級,判斷發行公司還不還得出錢——這關係到可轉債到期/賣回時能否拿回本金。', formula: '1 = 最佳(違約風險最低)、9 = 最弱;數字越小越安全。左為 信用評分、右為財務信評' }} />
    </dl>
    </>
  )
}

function CbasCalc({ row }) {
  const [discount, setDiscount] = useState(CBAS_DEFAULT_DISCOUNT)
  const [quote, setQuote] = useState('')
  useEffect(() => { setDiscount(CBAS_DEFAULT_DISCOUNT); setQuote('') }, [row])
  const c = cbas(row, discount)
  if (!c) return <p className="kvnote">此檔無賣回條款資料(永續/未設),暫不提供 CBAS 試算。</p>
  const implied = cbasImpliedDiscount(row, quote === '' ? null : Number(quote))
  return (
    <>
      <label className="slider">折現率
        <input type="range" min="0.5" max="5" step="0.05" value={discount}
          onChange={e => setDiscount(+e.target.value)} />
        <b>{discount.toFixed(2)}%</b>
      </label>
      <dl className="kvlist">
        <KV k="百元報價" v={fmt(c.par100)} />
        <KV k="所需權利金" v={<b>{c.atFloor ? '趨近於零' : fmt(c.premium)}</b>} />
        <KV k="槓桿倍數" v={c.lev ? `${fmt(c.lev, 1)} 倍` : '－'} />
      </dl>
      {c.atFloor && (
        <p className="kvnote">這檔 CB 貼在債底附近(市價低於面額),公式會算出負權利金——實務上券商不會倒付,只收最低費用,槓桿倍數不顯示。這種價位的意義是「下檔保護厚」,不是「免費槓桿」。</p>
      )}
      <label className="cbas-cal">用券商報價校準
        <input type="number" inputMode="decimal" step="0.01" placeholder="貼上百元報價"
          value={quote} onChange={e => setQuote(e.target.value)} />
        {implied != null && (
          <button type="button" onClick={() => setDiscount(Math.min(5, Math.max(0.5, implied)))}>
            = {fmt(implied)}% 套用
          </button>
        )}
      </label>
      <p className="kvnote dim">折現率是券商借款的資金成本報價,不是市場算得出來的數字。預設 {CBAS_DEFAULT_DISCOUNT}% 來自券商 App 實測(33621:公式算 2.61、券商報 2.64)。手上有任一檔的真實報價就貼進來校準,會套用到所有標的。</p>
    </>
  )
}

function CustodyTrend({ rows }) {
  const read = useMemo(() => custodyRead(rows), [rows])
  if (!read) return <p className="kvnote dim">此檔尚無足夠的月集保資料。</p>
  const { series, latest, dropPct, alert } = read
  const values = series.map(r => r.custodyPct)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const flat = hi - lo < 0.5
  const [top, bottom] = flat ? [hi + 1, lo - 1] : [hi + (hi - lo) * 0.12, lo - (hi - lo) * 0.12]
  const y = value => (100 - ((value - bottom) / (top - bottom)) * 100).toFixed(2)
  const points = series.map((r, i) => {
    const x = series.length === 1 ? 0 : (i / (series.length - 1)) * 100
    return `${x.toFixed(2)},${y(r.custodyPct)}`
  })
  return (
    <div className={`custody${alert ? ' custody-alert' : ''}`}>
      <svg className="custody-chart" viewBox="0 0 100 100" preserveAspectRatio="none"
        role="img" aria-label={`集保庫存佔發行比走勢,最新 ${fmt(latest.custodyPct)}%`}>
        <polygon points={`0,100 ${points.join(' ')} 100,100`} className="custody-fill" />
        <polyline points={points.join(' ')} className="custody-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="custody-foot">
        <span><b>{fmt(latest.custodyPct)}%</b> 仍在集保({latest.ym?.slice(0, 4)}/{latest.ym?.slice(4)})</span>
        <span className={cls(dropPct)}>
          {flat ? `${series.length} 個月都沒變動` : `近 3 月 ${dropPct > 0 ? '+' : ''}${fmt(dropPct)} 個百分點`}
        </span>
      </div>
      <p className="kvnote">
        {alert
          ? '庫存明顯退水=有人把 CB 轉成股票或賣掉了。這通常出現在股價衝上來之後,代表先進場的資金開始下車——追價要更小心。'
          : '庫存水位穩定,還沒出現大額轉換或賣出;籌碼還鎖著。'}
      </p>
    </div>
  )
}

function LegalFlow({ rows }) {
  const read = useMemo(() => legalRead(rows), [rows])
  if (!read) return <p className="kvnote dim">此檔近期沒有法人進出紀錄(CB 流動性低,屬常態)。</p>
  const items = [
    ['自營商', read.dealer, '券商做 CBAS 的部位——持續淨買代表有人在買這檔的選擇權'],
    ['外資', read.foreign, '偏長期持有'],
    ['投信', read.trust, '偏長期持有'],
  ]
  return (
    <>
      <dl className="kvlist">
        {items.map(([label, value, tip]) => (
          <KV key={label} k={label} tip={tip} v={<span className={cls(value)}>{value > 0 ? '+' : ''}{fmt(value, 0)} 張</span>} />
        ))}
      </dl>
      <p className="kvnote">
        近 {read.days} 個交易日合計{read.active ? `(其中 ${read.active} 天有進出)` : ''}:
        {read.net > 0
          ? `法人合計淨買 ${fmt(read.net, 0)} 張——有資金在收。`
          : read.net < 0
            ? `法人合計淨賣 ${fmt(-read.net, 0)} 張——有人在減碼。`
            : '法人進出互相抵銷,沒有明顯方向。'}
      </p>
    </>
  )
}

/* ── 第 6 段:CBAS(條件顯示)—— 只有適用時才顯示試算,不適用整段標明原因 ── */
function CbasSection({ row }) {
  const ap = cbasApplicability(row)
  if (!ap.ok) return <p className="kvnote">此檔不適用 CBAS——{ap.reason}</p>
  return <CbasCalc row={row} />
}

/* verdict level → 抽屜頂色塊短判(mockup verdictline:避開紅 / 可進場綠 / 觀察橘) */
const VERDICT_WORD = { go: '可進場', watch: '觀察', avoid: '避開' }
const VERDICT_TONE = { go: 'down', watch: 'warn', avoid: 'up' }

/* 明細分節定義(供桌面右欄上方 tab 導覽跳轉;key=錨點 id) */
export const DETAIL_SECTIONS = [
  { key: 'key', title: '關鍵指標' },
  { key: 'terms', title: '契約條款' },
  { key: 'credit', title: '信用體檢' },
  { key: 'chips', title: '籌碼' },
  { key: 'cbas', title: 'CBAS 試算' },
]

/* ── 明細五節(關鍵指標/契約條款/信用體檢/籌碼/CBAS):手機抽屜與桌面右欄共用 ──
   自載 cbDetail(terms/custody/legal);allOpen=五節全展開(桌面右欄);每節帶錨點 id 供 tab 跳轉 */
export function DetailSections({ row, today, stratId = 'all', allOpen = false }) {
  const [detail, setDetail] = useState(null)
  useEffect(() => { loadCbDetail().then(setDetail).catch(() => setDetail(null)) }, [])
  if (!row) return null
  const terms = detail?.terms?.[row.code]
  const anchor = key => `det-sec-${key}`
  return (
    <>
      <div id={anchor('key')}>
        <Section title="關鍵指標" defaultOpen>
          <dl className="kvlist"><KV k="CB 收盤 / 現股" v={`${row.cbPx != null ? fmt(row.cbPx, 1) : '－'} / ${row.stkPx != null ? fmt(row.stkPx, row.stkPx > 500 ? 0 : 1) : '－'}`} /></dl>
          <KeyStats row={row} stratId={stratId} today={today} />
        </Section>
      </div>
      <div id={anchor('terms')}>
        <Section title="契約條款" defaultOpen={allOpen}>
          <TermsBlock row={row} terms={terms} today={today} />
        </Section>
      </div>
      <div id={anchor('credit')}>
        <Section title="信用體檢" defaultOpen={allOpen}>
          <CreditBlock row={row} />
        </Section>
      </div>
      <div id={anchor('chips')}>
        <Section title="籌碼" defaultOpen={allOpen}>
          <p className="sec-sub">集保庫存 <Info tip="集保庫存=還沒被轉換也沒被領出的 CB 張數;佔發行比往下掉=有人把 CB 轉成股票或賣出。月頻資料。" /></p>
          <CustodyTrend rows={detail?.custody?.[row.code]} />
          <p className="sec-sub">三大法人 <Info tip="三大法人買賣這檔 CB(近 10 交易日淨買張數);自營商=券商做 CBAS 的部位。" /></p>
          <LegalFlow rows={detail?.legal?.[row.code]} />
        </Section>
      </div>
      <div id={anchor('cbas')}>
        <Section title="CBAS 試算" defaultOpen={allOpen}>
          <CbasSection row={row} />
        </Section>
      </div>
    </>
  )
}

export default function Drawer({ row, today, stratId = 'all', onClose, watched = false, onToggleWatch, hideChart = false }) {
  const [focusMode, setFocusMode] = useState(false)
  const [width, setWidth] = useState(null)   // 拖動側邊自訂寬度(null=CSS 預設)
  const startResize = e => {
    e.preventDefault()
    const onMove = ev => setWidth(Math.min(Math.max(window.innerWidth - ev.clientX, 380), Math.min(1280, window.innerWidth * 0.96)))
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }
  // K 線段:mockup 硬需求=置頂且預設展開 → 開抽屜即掛載真 K 線
  const [klMounted, setKlMounted] = useState(true)
  const [klOpen, setKlOpen] = useState(true)
  // 方向型策略(發動/熱度/CBAS/地圖)才以 K 線型態為主角;折價/賣回不賭方向,K 線只當參考
  const chartLed = ['fire', 'heatcb', 'cbas', 'all', 'pick', 'watch'].includes(stratId)   // 現行 3 nav(精選/全市場/關注)K 線一律置頂+展開
  useEffect(() => { setFocusMode(false); setWidth(null); setKlMounted(true); setKlOpen(chartLed) }, [row?.code, chartLed])

  const stratLabel = (STRATS.find(s => s.id === stratId) || STRATS[0]).label
  const v = row ? stratVerdict(row, stratId, today) : null

  // header:窄版=完整標頭在頂;寬版兩欄(focus/拖寬)=縮短成「名稱代號」移進右側明細欄上方,左半留給純 K 線
  const headTools = (
    <div className="dhead-tools">
      <button className={`dtool watch${watched ? ' on' : ''}`} onClick={onToggleWatch}
        aria-label={watched ? '移除關注' : '加入我的關注'} aria-pressed={watched}
        title={watched ? '已關注(點移除)' : '加入我的關注'}>
        <Star size={16} fill={watched ? 'currentColor' : 'none'} />
      </button>
      <button className={`dtool dtool-focus${focusMode ? ' on' : ''}`} onClick={() => { setFocusMode(f => !f); setWidth(null) }}
        aria-label={focusMode ? '縮小抽屜' : '放大抽屜(方便畫圖)'} aria-pressed={focusMode}
        title={focusMode ? '縮小' : '放大方便畫圖'}>
        {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button className="dclose" onClick={onClose} aria-label="關閉"><X size={16} /></button>
    </div>
  )
  const headEl = row && (
    <div className="dhead">
      <div className="dhead-top">
        <h2>{row.name}<span className="code">{row.code}</span>
          <span className="dstk-badge">{row.isEB ? <>換 {row.stk} {row.stkCode}</> : <>{row.stk} {row.stkCode}</>}</span>
          {row.isEB && <span className="eb-tag" title={`交換公司債:${row.issuerName} ${row.issuerCode} 發行,可交換為 ${row.stk} ${row.stkCode}`}>交換債</span>}
        </h2>
        {headTools}
      </div>
    </div>
  )
  const headShort = row && (
    <div className="dhead dhead-min">
      <div className="dhead-top">
        <h2>{row.name}<span className="code">{row.code}</span>{row.isEB && <span className="eb-tag">交換債</span>}</h2>
        {headTools}
      </div>
    </div>
  )
  const noticeEl = <div className="notice">數據為公開資料理論值、CBAS 為試算,非買賣建議。</div>
  // 寬版兩欄(focus 或拖寬 ≥820)且方向策略 → 乾淨版面:左半純圖、標頭移右上、免責移右
  // hideChart(平板兩欄工作區):中欄已有 K 線,抽屜只放明細,不進兩欄模式
  const wideChart = !hideChart && chartLed && (focusMode || (width != null && width >= 800))

  return (
    <>
      <div className={`scrim${row ? ' on' : ''}`} onClick={onClose} aria-hidden />
      <aside className={`drawer${row ? ' on' : ''}${focusMode ? ' focus-mode' : ''}${wideChart ? ' chart-clean' : ''}`} style={width ? { width } : undefined} aria-label="可轉債明細" aria-hidden={!row}>
        {row && <div className="drawer-resize" onMouseDown={startResize} role="separator" aria-label="拖動調整寬度" title="拖動調整寬度" />}
        {row && v && (
          <>
            {/* header:窄版在頂部;寬版兩欄(wideChart)移到右側明細欄,左半留給純 K 線 */}
            {!wideChart && headEl}

            {/* 漸進揭露分段(mockup 順序):現股 K 線置頂且預設展開 → 判讀 → 關鍵數 → 契約條款 → 信用體檢 → 籌碼 */}
            <div className={`dbody${chartLed && !hideChart ? ' chart-led' : ''}`}>
              {/* K 線直接滿版顯示(無 sechead 折疊、無卡片邊界、無提示);最優化畫圖空間 */}
              {!hideChart && (
              <div className="dchart">
                <div className="drawer-chart-column">
                  <Suspense fallback={<div className="kline-lazy">載入 K 線工具…</div>}>
                    <KLinePanel key={row.stkCode} row={row} focusMode={focusMode}
                      onFocusModeChange={setFocusMode} onShowDetails={() => {}} />
                  </Suspense>
                </div>
              </div>
              )}

              <div className="dsections">
              {wideChart && headShort}
              <DetailSections row={row} today={today} stratId={stratId} />
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
