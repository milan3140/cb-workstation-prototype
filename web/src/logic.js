/* 資料層:沿用前代版本的同一份資料契約(build_raw.py 15-tuple)
   tuple: code,name,stkCode,stk,stkPx,convPx,cbPx,vol,newHigh,putDate,putPx,guar,unconv,heat,pattern */

/* schema 防呆(契約=DATA_SCHEMA.md):壞列剔除+fail-loud,不靜默進 UI */
function assertRaw(raw) {
  const bad = []
  const ok = raw.filter((r, i) => {
    const good = Array.isArray(r) && r.length === 15 && r[0] && typeof r[4] === 'number' && typeof r[6] === 'number'
    if (!good) bad.push(i)
    return good
  })
  if (bad.length) console.error(`[schema] raw.json 有 ${bad.length} 列不符 15-tuple 契約,已剔除:index`, bad.slice(0, 10))
  return ok
}

/* 衍生欄(轉換價值/股債乖離/賣回報酬率/距賣回年)以**後端算好的為準**(治理 C1~C4:
   架構原則「能算的放後端」——前後端各算一次公式會漂移,文件上的數字會跟畫面對不上)。
   `derived` 缺該檔或缺該欄時才用下面的前端算法兜底,所以後端未部署時行為與過去完全相同。 */
export function enrich(raw, todayStr, derived, credit, cbBasic, exDiv, borrow) {
  const TODAY_D = new Date(+todayStr.slice(0, 4), +todayStr.slice(4, 6) - 1, +todayStr.slice(6, 8))
  return assertRaw(raw).map(r => {
    const [code, name, stkCode, stk, stkPx, convPx, cbPx, vol, newHigh, putDate, putPx, guar, unconv, heat, pattern] = r
    const back = derived?.[code] || {}
    const cbB = cbBasic?.[code] || null
    // 停轉狀態(即時,不讀空白率高的欄位):資料日落在 [停轉起, 停轉迄] 內=停轉中。YYYYMMDD 字串直接比大小。
    const stopNow = !!(cbB?.stopConvStart && cbB?.stopConvEnd
      && cbB.stopConvStart <= todayStr && todayStr <= cbB.stopConvEnd)
    const pick = (key, fallback) => (Number.isFinite(back[key]) ? back[key] : fallback)
    const convVal = pick('convVal', convPx ? 100 / convPx * stkPx : null)
    const dev = pick('dev', convVal ? (cbPx - convVal) / convVal * 100 : null)
    let putRet = null, yrsToPut = null
    if (putDate && putPx) {
      const d = new Date(putDate)
      yrsToPut = Math.max(0, (d - TODAY_D) / 31557600000)
      putRet = (putPx - cbPx) / cbPx * 100
    }
    // 交換公司債(EB)判定:一般 CB 代號前綴=標的代號(發行公司=標的);EB 代號前 4 碼=發行公司代號,
    // ≠交換標的(如 140202=遠東新 1402 發行、換遠百 2903)。發行公司=欠你賣回/償還的人=信用該看的對象;
    // 標的股=交換後拿到的股票=型態/熱度/轉換價值該看的對象。issuerName 由 CB 名稱前綴取("遠東新E2永"→"遠東新")。
    const isEB = !String(code).startsWith(String(stkCode))
    const issuerCode = isEB ? String(code).slice(0, 4) : stkCode
    const issuerName = isEB ? (name.match(/^(.+?)[Ｅe]\d/i)?.[1]?.trim() || issuerCode) : stk
    return { code, name, stkCode, stk, stkPx, convPx, cbPx, vol, newHigh, putDate, putPx, guar, unconv, heat, pattern,
      isEB, issuerCode, issuerName,
      convVal, dev, putRet: pick('putRet', putRet), yrsToPut: pick('yrsToPut', yrsToPut),
      // 全補(2026-08,對齊市場通用欄位;一律拿後端算好的,前端不重算)
      // 百元平價=convVal、溢/折價=dev(同一數字換術語),後端另給 parity/prem 就以它為準
      parity: pick('parity', convVal), prem: pick('prem', dev),
      // 距轉換價 %(訊號「發動」的核心指標):parity−100;0=剛好在轉換價、負=現股仍在轉換價下方、正=已過。
      // |convDist| 越小 = 現股越逼近轉換價 = 越可能發動(主力集結拉抬)。
      convDist: (() => { const p = pick('parity', convVal); return Number.isFinite(p) ? p - 100 : null })(),
      nature: back.nature ?? null,            // 性質:偏股/股債平衡/偏債
      ytm: pick('ytm', null),                 // 到期(隱含)殖利率 %
      putYtm: pick('putYtm', null),           // 賣回(隱含)殖利率 %
      prospectus: back.prospectus || '',      // 發行辦法官方說明書 PDF
      statusWord: back.statusWord, statusTone: back.statusTone,
      // 發動頁新增(純加法,缺資料時為 null 不影響既有頁):
      // credit=Part A 信評+財務比率(以 CB 代號為鍵);cbBasic=強贖啟動比率/連續天數(即時算強贖狀態用)
      credit: credit?.[code] || null,
      cbBasic: cbB,
      // 折價頁補資料(純加法,缺則 null):除權息日 / 借券難易度;stopNow=停轉即時判斷
      exDiv: exDiv?.[code] || null,
      borrow: borrow?.[code] || null,
      stopNow,
      // 到期日(後端 derived 補;缺則 null)—— 賣回/CBAS 頁「到期日」欄用
      matDate: back.matDate ?? null,
      // 發行時轉換溢價率(cbBasic)—— 熱度頁「發行轉換溢價」欄
      issuePrem: cbB && Number.isFinite(cbB.issuePremium) ? cbB.issuePremium : null,
      derivedFrom: Object.keys(back).length ? 'backend' : 'client' }
  })
}

/* ── 信用狀態燈(發動頁「信用狀態」欄;綜合 信用評分 / 財務信評 / Z–Score → 綠/黃/紅)──
   誠實用語:賣回價=契約下檔參考,不能替代信用判斷;此燈才是體質評估。
   刻度事實(實測):信用評分 與財務信評皆 1(佳)~9(弱);Z–Score 越高越安全(Altman:>2.99 安全區)。
   門檻集中在此(CREDIT_LIGHT),之後要調只改這一處。 */
export const CREDIT_LIGHT = { greenRank: 3.5, yellowRank: 6.5, zSafe: 2.99, zRisk: 1.81 }
export function creditLight(r) {
  const c = r.credit
  const ranks = c ? [c.credScore, c.finRating].filter(v => Number.isFinite(v)) : []
  const z = c && Number.isFinite(c.zScore) ? c.zScore : null
  if (!ranks.length && z == null) return { level: 'unknown', word: '無資料', tone: 'dim' }
  let level
  if (ranks.length) {
    const rank = ranks.reduce((a, b) => a + b, 0) / ranks.length
    level = rank <= CREDIT_LIGHT.greenRank ? 'green' : rank <= CREDIT_LIGHT.yellowRank ? 'yellow' : 'red'
    // Altman 進入危險區時,體質「穩健」至多降一級提示(財務比率交叉驗證,不硬翻紅)
    if (level === 'green' && z != null && z < CREDIT_LIGHT.zRisk) level = 'yellow'
  } else {
    level = z >= CREDIT_LIGHT.zSafe ? 'green' : z >= CREDIT_LIGHT.zRisk ? 'yellow' : 'red'
  }
  const word = level === 'green' ? '體質穩健' : level === 'yellow' ? '中性' : '偏弱留意'
  return { level, word, tone: level }
}

/* ── 強贖條款狀態(發動頁「強贖條款狀態」欄;即時算,不讀那個大多空白的強制贖回日欄)──
   用 cbBasic 的 callTrigger1(贖回啟動比率,如 130%)+ callDays1(連續天數)+ 現股是否已達觸價。
   觸價 = 轉換價 × 啟動比率%;現股 ≥ 觸價 → 觸發中、≥90% → 接近、其餘 → 未接近。
   語意=條款觸發監測(強贖不是保證,只是「發行公司可能提前贖回」的監測)。 */
export function forceCallStatus(r) {
  const b = r.cbBasic
  const trig = b && Number.isFinite(b.callTrigger1) ? b.callTrigger1 : null
  if (trig == null || !r.convPx || !Number.isFinite(r.stkPx)) return { level: 'na', word: '無條款', tone: 'dim' }
  const triggerPx = r.convPx * trig / 100
  const ratio = triggerPx ? r.stkPx / triggerPx : null
  const days = Number.isFinite(b.callDays1) ? b.callDays1 : null
  let level, word
  if (ratio != null && ratio >= 1) { level = 'trig'; word = '觸發中' }
  else if (ratio != null && ratio >= 0.9) { level = 'near'; word = '接近' }
  else { level = 'far'; word = '未接近' }
  return { level, word, tone: level, triggerPx, ratio, days, trigger: trig }
}

/* CBAS 試算。
   ★公式已用券商真值驗證過(2026-08-06):33621 在折現率 3.25% 下算出百元報價 2.61,
   券商 App 實際報 2.64 —— 差 0.03,**公式是對的**。要準,關鍵只在折現率給多少。

   折現率是「券商借你這筆錢的資金成本報價」,是券商端參數,**不在市場價裡**——
   我試過從債性區 CB 反解它,證實不可行:轉換價值 < 70(換股完全不划算)的 82 檔裡
   仍有 49% 市價在 100 以上(到期還本+賣回權+重設條款+流動性都有價值),
   把市價當債底會解出 -11%~+23% 的發散值。所以只能取券商報價,不能從市場推。

   實務校準法=拿任一檔的券商百元報價反解折現率(cbasImpliedDiscount),
   再套用到全表——一個報價點就能校準所有標的。 */
export const CBAS_DEFAULT_DISCOUNT = 3.25   // 券商 App 實測值(33621, 2026-08);舊預設 1.5 是猜的

export function cbas(row, discount = CBAS_DEFAULT_DISCOUNT, fee = 0.3) {
  if (row.yrsToPut == null) return null
  const par100 = discount * row.yrsToPut - (row.putPx - 100) + fee
  const premium = (row.cbPx - 100) + par100
  // CB 貼在債底以下時 premium 會算成負數(公式假設以面額 100 建立部位,而 CB 現價低於面額)。
  // 負權利金在實務上不存在——券商不會倒付你,只會收最低費用。標成 atFloor 讓畫面說實話。
  const atFloor = premium <= 0.5
  return { par100, premium, atFloor, lev: atFloor ? null : row.convVal / premium }
}

/* 反解:已知某檔的券商百元報價 → 當下的折現率(%)。
   par100 = r × T − (putPx − 100) + fee  ⇒  r = (par100 + (putPx − 100) − fee) / T */
export function cbasImpliedDiscount(row, par100, fee = 0.3) {
  if (row?.yrsToPut == null || row.yrsToPut <= 0 || par100 == null || isNaN(par100)) return null
  return (Number(par100) + (row.putPx - 100) - fee) / row.yrsToPut
}

export const fmt = (v, d = 2) => (v == null || isNaN(v)) ? '－' : Number(v).toFixed(d)
export const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat'
export const heatLv = h => h >= 7 ? 'hot' : h >= 4 ? 'warm' : h >= 0 ? 'mid' : 'cool'
export const heatWord = h => h >= 7 ? '大橘,優先關注' : h >= 4 ? '淺橘' : h >= 0 ? '中性' : '偏弱'

/* 欄位 meta:label=術語(術語表一致)、sub=白話副標(2C 親民)、tip=hover ⓘ 公式說明、align、num */
export const COLS = {
  name:     { label: 'CB / 現股',   sub: '',              align: 'left'  },
  cbPx:     { label: 'CB 收盤',     sub: '可轉債價格',     align: 'right', num: true },
  stkPx:    { label: '股價',        sub: '現股收盤',       align: 'right', num: true },
  convVal:  { label: '轉換價值',    sub: '換成股票值多少', align: 'right', num: true,
    tip: '轉換價值 = 100 ÷ 轉換價 × 股價——這張 CB 現在換成股票值多少元' },
  dev:      { label: '股債乖離率',  sub: 'CB 比現股貴幾 %', align: 'right', num: true,
    tip: '股債乖離率 = (CB價 − 轉換價值) ÷ 轉換價值——正=CB 比股票貴(溢價)、負=比股票便宜(折價);進 ±3% 內=高連動「發動」' },
  heat:    { label: '熱度',        sub: '進場溫度計',     align: 'center', num: true,
    tip: '熱度指標 −10~10:<0 偏弱、0–3 中性、4–6 淺橘、7–10 大橘(優先關注大橘)' },
  pattern:  { label: '型態',        sub: '老師追蹤中',     align: 'center' },
  // 誠實用語(硬性):賣回價=「契約下檔參考」,不得寫「保底」——契約價不替代信用判斷
  putPx:    { label: '賣回價',      sub: '契約下檔參考',   align: 'right', num: true,
    tip: '賣回價=發行辦法約定的提前償還價格,是「契約下檔參考」,非保底保證;能否兌現仍取決於發行公司信用' },
  putRet:   { label: '賣回報酬率',  sub: '抱到期穩拿',     align: 'right', num: true,
    tip: '賣回報酬率 = (賣回價 − CB價) ÷ CB價——抱到賣回日、公司照約定價買回,穩拿的保底報酬' },
  putDate:  { label: '賣回日',      sub: '保底到期日',     align: 'right' },
  cbasPrem: { label: '所需權利金',  sub: '入場成本',       align: 'right', num: true,
    tip: 'CBAS 權利金 = (CB − 100) ＋ 百元報價(折現率預設 1.5%、手續費 0.3%,點進明細可調)' },
  cbasLev:  { label: '槓桿倍數',    sub: '資金放大',       align: 'right', num: true,
    tip: '槓桿倍數 = 轉換價值 ÷ 權利金——用小額權利金撬動整張 CB,權利金越小放大越多' },
  vol:      { label: '成交張',      sub: '最新交易日',     align: 'right', num: true },
  // ── 全補新欄(對齊市場通用的 CB 篩選術語;值一律後端算)──
  parity:   { label: '百元平價',    sub: '每 100 元換股值', align: 'right', num: true,
    tip: '百元平價 = 股價 ÷ 轉換價 × 100——把 CB 標準化成每 100 元面額換成股票值多少(等同轉換價值)' },
  prem:     { label: '溢/折價',     sub: 'CB 比平價貴幾 %', align: 'right', num: true,
    tip: '溢/折價 =(CB 市價 − 百元平價)÷ 百元平價——正=溢價(比換股貴)、負=折價(比換股便宜);等同股債乖離率' },
  nature:   { label: '性質',        sub: '偏股/平衡/偏債',  align: 'center',
    tip: '依百元平價分類:>110 偏股性、90~110 股債平衡、<90 偏債性——越偏股跟漲越強、越偏債債底保護越厚' },
  ytm:      { label: '到期殖利率',  sub: '抱到到期年化',   align: 'right', num: true,
    tip: '到期(隱含)殖利率:用現價買、抱到到期還本 100 的年化報酬(台灣 CB 多為零息,故常為負=買貴了)' },
  putYtm:   { label: '賣回殖利率',  sub: '抱到賣回年化',   align: 'right', num: true,
    tip: '賣回(隱含)殖利率:用現價買、抱到最近賣回日領回賣回價的年化報酬——債性保底的年化口徑' },
  prospectus: { label: '發行辦法',  sub: '官方說明書',     align: 'center' },
  // ── 發動頁專用欄(純加法)──
  unconv:   { label: '未轉換',      sub: '籌碼觀察值',     align: 'right', num: true,
    tip: '未轉換餘額比例:仍未換成股票的 CB 佔比。高=籌碼觀察值,不宜單獨解讀為上漲保證' },
  signal:     { label: '型態訊號',    sub: '老師追蹤中',     align: 'center',
    tip: '型態訊號:現股符合的既有訊號型態(型態E/型態C/型態D/型態F/型態B/型態A/下樓梯)' },
  credit:   { label: '信用狀態',    sub: '發行公司體質',   align: 'center',
    tip: '綜合 信用評分 信用評等、財務信評(皆 1 佳~9 弱)與 Z–Score(越高越安全):綠=體質穩健、黃=中性、紅=偏弱留意。這才是下檔風險的體質判斷,賣回價只是契約參考' },
  forceCall: { label: '強制贖回風險', sub: '會不會被公司買回', align: 'center',
    tip: '即時比對:觸價=轉換價×贖回啟動比率%,現股達觸價→觸發中、≥90%→接近、其餘→未接近。強贖=發行公司可能提前贖回的監測,非保證' },
  // ── 其餘策略頁新增欄(純加法)──
  convPx:   { label: '轉換價',      sub: '每股換股價',     align: 'right', num: true,
    tip: '轉換價=每一單位可轉債可換成現股的約定價格;現股走近或突破它,轉換誘因升高' },
  toConv:   { label: '距轉換價',    sub: '現股距換股價',   align: 'right', num: true,
    tip: '距轉換價 =(百元平價 − 100)= 現股相對轉換價的 %;負=現股仍在轉換價下方(尚未突破,轉換誘因仍在)、正=已突破' },
  yrsPut:   { label: '距賣回',      sub: '賣回日剩餘年',   align: 'right', num: true,
    tip: '距賣回=最近賣回日距資料日的年數;越短、契約現金流實現越近' },
  remYrs:   { label: '剩餘年期',    sub: '距賣回日',       align: 'right', num: true,
    tip: '剩餘年期(以最近賣回日計):越短、轉換或償還的時間壓力越高' },
  issuePrem:{ label: '發行轉換溢價', sub: '發行時條件',    align: 'right', num: true,
    tip: '發行時轉換溢價率=發行當下 CB 轉換價相對現股的溢價;反映發行條件,非現值' },
  matDate:  { label: '到期日',      sub: '本金償還日',     align: 'right',
    tip: '到期日=可轉債約定的本金償還日;賣回/到期兩情境比較年化報酬時用' },
  strat:    { label: '策略',        sub: '點 icon 進策略頁', align: 'center',
    tip: '對每檔跑五個策略條件,標出目前較符合的角度(發動/熱度/賣回/折價/CBAS);同一檔可同時具備多種特徵。點 icon 直接進對應策略頁的已篩清單。非買賣建議' },
  heatState:{ label: '熱度狀態',   sub: '進場溫度',       align: 'center',
    tip: '依熱度指標分級:大橘(≥7,優先關注)/淺橘(4~6)/中性(0~3)/偏弱(<0)' },
  risk:     { label: '風險提示',    sub: '體質＋強贖綜合', align: 'center',
    tip: '綜合信用燈(體質)與強贖條款監測、停轉狀態的一句短語;僅為風險提示,非買賣建議' },
  guar:     { label: '擔保',        sub: '是否有擔保',     align: 'center',
    tip: '債券擔保情形:有擔保時履約由擔保機構加強,下檔保護較厚' },
  // 賣回頁
  fin:      { label: '財務體質',    sub: '負債/速動/利保/Z＋信評', align: 'center',
    tip: '綜合負債比、速動比、利息保障倍數、Z–Score 與信評(皆 1 佳~9 弱)的體質燈;殖利率異常高常反映履約疑慮,需交叉看體質' },
  // 折價頁
  netDisc:  { label: '淨折價',      sub: '扣成本後',       align: 'right', num: true,
    tip: '淨折價=折價毛額 − 手續費 − 近除息補償;借券費率無資料來源未計入(需券商/未接),故為未含借券成本的上限估計' },
  borrowDiff:{ label: '借券難易度', sub: '借券餘額代理',   align: 'right', num: true,
    tip: '以借券賣出餘額為代理:餘額越高、市場借得到券的機會通常越高。非實際可借數量報價' },
  borrowFee:{ label: '借券費率',    sub: '需券商報價',     align: 'center',
    tip: '借券費率無公開資料源,需向券商詢價;此欄未接,淨折價未計入此成本' },
  stopConv: { label: '停轉狀態',    sub: '是否開放轉換',   align: 'center',
    tip: '停止受理轉換登記期間:停轉中無法執行轉換交割,折價套利暫不可行' },
  exDiv:    { label: '除權息日',    sub: '股利補償參考',   align: 'right',
    tip: '現股除權/除息日;放空現股跨越除息日需補償股利,近除息時應納入損益試算' },
  // CBAS 頁(多為試算)
  cbasQuote:{ label: '報價性質',    sub: '試算/實際',      align: 'center',
    tip: '系統公式僅為情境試算,非券商實際可成交報價;實際權利金以券商報價為準' },
  parDev:   { label: '相對面額偏離', sub: 'CB 距 100',     align: 'right', num: true,
    tip: '相對面額偏離=CB 市價 − 100;越貼近或低於面額,權利金越便宜、時間價值成本越低' },
  relPut:   { label: '相對賣回價',   sub: 'CB 距賣回價',   align: 'right', num: true,
    tip: '相對賣回價=CB 市價 − 賣回價;顯示債券條款支撐位置,越接近下檔越有條款保護' },
  lastTrade:{ label: '最後交易日',   sub: '需券商',        align: 'right',
    tip: 'CBAS 最後交易日以券商合約為準,無公開資料源,需向券商確認' },
}

/* 性質色調:偏債=保底色(down)、偏股=跟漲色(up)、平衡=中性 */
export const natureTone = n => n === '偏股性' ? 'up' : n === '偏債性' ? 'down' : 'flat'

/* ── 發動策略篩選門檻(集中在此一處,之後要調只改這裡)──
   合理起始版:現股型態到位(有 signal 型態)或熱度轉強;且 CB 相對賣回價下檔近;且未轉換仍有水位。 */
/* 發動重定義(2026-08 訊號審查會定調):可轉債「發動」= 現股逼近轉換價(parity 近 100),
   主力此時集結拉抬現股、CB 隨轉換價值起漲。不再以「股債乖離下檔近」為主。
   型態學精選 = 發動(近轉換價)+ 現股型態訊號(型態A等)= 精華中的精華。 */
export const FIRE = {
  convBand: 5,       // 距轉換價 ±5%(訊號:抓 3~5%);|parity−100| ≤ 5 = 逼近轉換價=發動到位
  unconvMin: 50,     // 未轉換仍有水位(%)——籌碼觀察值,非上漲保證
  heatStrong: 4,    // 熱度轉強(淺橘以上),供型態學精選的次要加分
}
// 發動:現股逼近轉換價(±convBand%)且未轉換仍有水位
export function fireQualify(r) {
  const nearConv = r.convDist != null && Math.abs(r.convDist) <= FIRE.convBand
  const waterLevel = r.unconv != null && r.unconv > FIRE.unconvMin
  return nearConv && waterLevel
}
// 型態學精選:發動(近轉換價)+ 現股有型態訊號(型態A/型態B/型態C/型態D/型態E…)
export function firePickQualify(r) {
  return fireQualify(r) && !!r.pattern
}
// 依單一型態篩選(chip 用):現股 pattern == 指定型態名
export const patternQualify = name => r => r.pattern === name

/* 發動頁說明區逐字文案(產品負責人定稿,一字不改)。標題統一「這是什麼／賺甚麼」,可收合。 */
export const FIRE_DESC = [
  { tag: '這是什麼／賺甚麼', body: '發動策略尋找現股尚在型態訊號的起漲階段、但可轉債價格仍保有債券條款支撐的標的。投資人預期現股走強將帶動轉換價值與 CB 價格上升，同時利用賣回條款、到期償還條件與信用資料評估下檔風險。它不是「跌有限、一定能漲」的策略，而是在方向判斷成立時，以可轉債參與行情並管理下行風險。進場時，應同時確認型態訊號與熱度轉強、未轉換仍具一定水位、CB 價格相對賣回條款或到期現金流沒有過度偏離，以及發行公司的財務體質可接受。賣回價可以列入此頁，但應作為「契約下檔參考」，不能替代信用判斷。' },
  { tag: '研究與進場', body: '先看 CB 價相對賣回價、到期償還價與轉換價值的位置，判斷風險報酬是否合理；再以型態訊號與熱度確認是否進入可操作的發動階段。未轉換高是籌碼觀察值，不宜單獨解讀為上漲保證。' },
  { tag: '持有監控', body: '追蹤現股、轉換價值、型態訊號、熱度、成交量、未轉換及信用事件。若 CB 上漲主要來自溢價擴大而非轉換價值改善，風險會提高。' },
  { tag: '出場情境', body: '型態訊號失守、熱度轉弱、現股與轉換價值不再支持價格，或強贖條款接近觸發時，均應檢討出場。型態失效應優先於「尚有債券條款支撐」的期待。' },
]

/* ══════════════════════════════════════════════════════════════════════
   其餘策略頁(沿用發動頁模式:集中門檻常數 + qualify 函式 + 逐字說明區 + 欄位清單)
   ══════════════════════════════════════════════════════════════════════ */

/* ── 熱度 ♥:研究「發行公司是否仍有推動現股走強的誘因」──
   篩選起始版:未轉換高 + 現股在轉換價下方一定範圍(走近轉換價)+ 剩餘年期有壓力 + (型態訊號 或 熱度轉強)。 */
export const HEAT = {
  unconvMin: 50,     // 未轉換仍有水位(%)——籌碼觀察值,非上漲保證
  parityFloor: 80,   // 現股在轉換價下方一定範圍:百元平價(=轉換價值)≥80(距轉換價 20% 內)
  parityCeil: 100,   // 且 <100(仍在轉換價下方=尚未突破,誘因仍在)
  yrsMax: 3,         // 剩餘年期(距賣回)有轉換壓力
  heatStrong: 4,    // 熱度轉強(淺橘以上)
}
export function heatQualify(r) {
  const water = r.unconv != null && r.unconv > HEAT.unconvMin
  const nearBelow = r.parity != null && r.parity >= HEAT.parityFloor && r.parity < HEAT.parityCeil
  const pressure = r.yrsToPut != null && r.yrsToPut <= HEAT.yrsMax
  const momentum = !!r.pattern || r.heat >= HEAT.heatStrong
  return water && nearBelow && pressure && momentum
}
export const HEAT_DESC = [
  { tag: '這是什麼／賺甚麼', body: '熱度策略用來研究發行公司是否仍有推動現股走強的條件，並以訊號既有的型態與熱度訊號確認市場是否開始反應。當現股走近或突破轉換價，債券持有人較可能轉換為股票，發行公司可降低現金償債壓力；未轉換比例、轉換價位置、剩餘期間與發行條件，能協助判斷這項誘因是否仍存在。但公司具備誘因不代表股價必然上漲。進場判斷必須同時看到型態訊號成立、熱度訊號轉強與量能支持；策略報酬來自現股行情帶動轉換價值上升，因此屬於方向性交易。' },
  { tag: '研究與進場', body: '先用未轉換、現股與轉換價的相對位置、剩餘年期、發行轉換溢價建立研究優先順序；再確認型態訊號、熱度與量能是否一致。這一頁的任務是把「值得研究」與「適合進場」分開，而不是以動機本身直接下單。' },
  { tag: '持有監控', body: '追蹤未轉換變化、成交量、型態訊號是否延續、熱度強弱，以及可取得的籌碼資料。若未轉換快速下降，需進一步判斷市場供給與轉換壓力是否上升。' },
  { tag: '出場情境', body: '型態破壞、熱度轉弱、量能無法延續，或公司啟動／接近強制贖回條件時，都應重新評估持有理由。強贖資訊應呈現為「條款觸發監測」，不可只讀取空白率高的強制贖回日期欄位。' },
]

/* ── 賣回 ⌁:研究具賣回條款或接近到期、以契約現金流取得價差與時間報酬的標的 ──
   篩選起始版:賣回或到期殖利率為正 + 財務體質過關(信用燈非偏弱/非無資料)。 */
export const SELL = {
  ytmMin: 0,         // 賣回或到期殖利率為正
}
export function financeOk(r) {
  const c = creditLight(r)
  return c.level === 'green' || c.level === 'yellow'   // 過關=體質穩健或中性;偏弱/無資料不過
}
export function floorQualify(r) {
  const yieldOk = (r.putYtm != null && r.putYtm > SELL.ytmMin) || (r.ytm != null && r.ytm > SELL.ytmMin)
  return yieldOk && financeOk(r)
}
export const SELL_DESC = [
  { tag: '這是什麼／賺甚麼', body: '賣回策略研究具有賣回條款或接近到期的可轉債。若投資人以低於未來賣回價或到期償還價的成本買進，且發行公司具備履約能力，持有至可行使日可取得價差與時間報酬。這項策略關注的是契約現金流與信用風險，而不是短期股價走勢。進場時應同時比較賣回殖利率與到期殖利率，確認可行使期間、賣回通知規則與最低持有條件，並檢視公司的財務結構、流動性、利息保障與擔保狀況。殖利率異常偏高不必然代表機會，也可能反映市場對履約能力的疑慮。' },
  { tag: '研究與進場', body: '先比較賣回與到期兩種情境下的年化報酬，再檢查賣回條款與信用資料。賣回價應列為主欄位，因為它是契約條款；但不應稱為「保底」，因為是否能實現仍取決於發行公司履約能力與行使資格。' },
  { tag: '持有監控', body: '每季更新財務指標，留意現金流、短債壓力、擔保變動與重大事件；同時追蹤賣回申請期間，避免錯過權利行使。' },
  { tag: '出場情境', body: '可在市場價格已反映大部分價差時提前賣出，或依條款行使賣回。若信用狀況明顯惡化，應優先重新檢視部位，不宜只因尚未到賣回日而被動持有。' },
]

/* ── 折價 ⇄:市價低於轉換價值,買 CB＋放空現股鎖定價差 ──
   篩選起始版:股債乖離為負(折價)+ 開放轉換(非停轉)。 */
export const DISCOUNT = {
  fee: 0.5,          // 交易手續費(常數,百元計)——買 CB＋放空的來回成本粗估
  divCompDays: 30,   // 「近除息」判定:距除息日 ≤30 天才把股利補償計入淨折價
}
export function discountQualify(r) {
  const disc = r.dev != null && r.dev < 0
  return disc && !r.stopNow
}
/* 淨折價=折價毛額 − 手續費 −(近除息才計)除息補償;借券費率未接→未計入(誠實)。
   折價毛額以百元計:CB 比轉換價值便宜多少元 = convVal − cbPx(>0 才是折價)。 */
export function netDiscount(r, todayStr) {
  if (r.dev == null || r.convVal == null || r.cbPx == null) return null
  const gross = r.convVal - r.cbPx                 // 折價毛額(元/百元)
  let divComp = 0
  const ex = r.exDiv?.exDivDate || r.exDiv?.exRightDate
  if (ex && todayStr) {
    const d = String(ex).replace(/\//g, '')
    if (d.length === 8 && d >= todayStr) {
      const days = (Date.UTC(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8)) -
        Date.UTC(+todayStr.slice(0,4), +todayStr.slice(4,6)-1, +todayStr.slice(6,8))) / 86400000
      if (days >= 0 && days <= DISCOUNT.divCompDays) divComp = 0   // 補償金額無現金股利資料源→僅標記,不臆造金額
    }
  }
  return { gross, net: gross - DISCOUNT.fee - divComp, feeIncluded: true, borrowFeeIncluded: false }
}
export const DISCOUNT_DESC = [
  { tag: '這是什麼／賺甚麼', body: '折價策略尋找市價低於轉換價值的可轉債。當可轉債可立即轉換為股票，而轉得的股票市值高於買進可轉債的成本時，投資人可買進 CB、建立相對應的現股放空部位，再以轉換取得的股票回補空單，鎖定兩者之間的價差。策略的報酬來源是折價收斂與轉換交割，而非判斷股價漲跌。進場前，除了折價幅度，必須一併確認借券供給、借券費率、停止轉換期間、除權息補償成本、交易與轉換作業時間，以及扣除全部成本後的淨折價。若無法借券、正處停轉，或淨折價不足以覆蓋成本，帳面折價不應視為可執行機會。' },
  { tag: '研究與進場', body: '先看「淨折價」是否仍具空間，再確認借券難易度、借券費率、可借數量與是否開放轉換；除權息日前後則應將股利補償納入損益試算。' },
  { tag: '持有監控', body: '追蹤借券費率、可借券源、停轉公告與折價變化。任何一項改變，都可能影響原先的交割安排與實際報酬。' },
  { tag: '出場情境', body: '完成轉換並以取得股票回補空單，或在折價已收斂且交易成本合理時同步平倉。若借券條件惡化、轉換受限或淨折價消失，應重新評估是否繼續持有。' },
]

/* ── CBAS △:以 CB 為標的的資產交換,付權利金參與上漲(多為試算)──
   篩選:承接發動的方向判斷(型態/熱度) + CB 貼近地板(權利金便宜) + 有擔保。 */
export const CBAS_FILTER = {
  premCheap: 15,     // 權利金便宜(百元計)——貼近地板
  heatStrong: 4,
}
const NO_GUAR = new Set(['', '無', '無擔保', '－', '-'])
export const hasGuar = r => {
  const g = String(r.guar || r.cbBasic?.guar || '').trim()
  return !!g && !NO_GUAR.has(g)
}
export function cbasQualify(r) {
  const direction = !!r.pattern || r.heat >= CBAS_FILTER.heatStrong
  const c = cbas(r)
  const cheap = !!c && (c.atFloor || (c.premium != null && c.premium < CBAS_FILTER.premCheap))
  return direction && cheap && hasGuar(r)
}
export const CBAS_DESC = [
  { tag: '這是什麼／賺甚麼', body: 'CBAS 是以可轉債為標的的資產交換交易。投資人支付權利金，取得約定期間內參與可轉債上漲的經濟效果；券商保留固定收益等債券部位。由於投入資金通常低於直接買進可轉債，當標的上漲時，權利金相對報酬可能放大；反之，若標的未在權利期間內朝預期方向移動，時間價值與交易成本會侵蝕權利金。CBAS 本質上是方向性策略，不能只看熱度。它應承接發動策略的完整判斷：型態訊號成立、熱度轉強、量能支持、可轉債本身價格與條款結構合理，並進一步確認實際報價、到期日、最後交易日、流動性與券商條件。系統公式只能作為情境試算，不能視為可成交報價。' },
  { tag: '研究與進場', body: '先確認標的 CB 是否具備方向性上漲條件，再比較不同到期日、權利金、參與率與槓桿試算。欄名用「相對面額偏離」，若要表達債券條款支撐，直接顯示「相對賣回價」與「相對到期償還價」。' },
  { tag: '持有監控', body: '追蹤標的 CB、現股、型態訊號、熱度、剩餘期間與時間成本；同時留意券商報價、流動性及提前終止條件。' },
  { tag: '出場情境', body: '當標的行情達成原先目標、型態或熱度轉弱、剩餘期間不足以支持原先預期，或流動性惡化時，應評估平倉。到期前未形成預期行情時，權利金的時間價值通常會加速下降。' },
]

/* ── 全市場地圖 ◎:總覽/分流器 ── */
export const MAP_DESC = [
  { tag: '這是什麼', body: '全市場地圖將所有可轉債依目前較符合的策略歸類，協助使用者先判斷「這一檔現在適合用什麼角度研究」，再進入對應策略頁深入判讀。它不是買賣建議，也不以單一訊號替代研究；同一檔可同時具備多種特徵，例如兼具發動條件與 CBAS 槓桿條件。' },
]
/* 分流器:對每檔跑五個 qualify,回符合的策略清單(供地圖「策略」欄的 icon+跳頁)。 */
/* icon 一律由 icons.jsx 的 StratIcon(id) 渲染 inline SVG(禁 glyph/emoji);此處只留 id/label/test */
export const STRAT_TAGS = [
  { id: 'fire', label: '發動', test: fireQualify },
  { id: 'heatcb', label: '熱度', test: heatQualify },
  { id: 'floor', label: '賣回', test: floorQualify },
  { id: 'discount', label: '折價', test: discountQualify },
  { id: 'cbas', label: 'CBAS', test: cbasQualify },
]
export function stratTagsFor(r) {
  return STRAT_TAGS.filter(t => { try { return t.test(r) } catch { return false } })
}
/* 風險提示:綜合信用燈 + 強贖狀態 + 停轉 的一句短語(cls∈up/warn/down/dim)。 */
export function riskNote(r) {
  const c = creditLight(r), f = forceCallStatus(r)
  const parts = []
  if (c.level === 'red') parts.push('體質偏弱')
  if (f.level === 'trig') parts.push('強贖觸發中')
  else if (f.level === 'near') parts.push('近強贖')
  if (r.stopNow) parts.push('停轉中')
  if (parts.length) {
    const severe = parts.some(p => p.includes('偏弱') || p.includes('觸發'))
    return { word: parts.join('・'), cls: severe ? 'up' : 'warn' }
  }
  if (c.level === 'green') return { word: '體質穩健', cls: 'down' }
  if (c.level === 'yellow') return { word: '中性', cls: 'flat' }
  return { word: '無資料', cls: 'dim' }
}

/* 策略(濾網):導覽列鎖定名稱+icon。全數頁面同一模式(qualify + 欄位 + 逐字說明區)。 */
/* ── 新 IA(2026-08 訊號審查會定調)──────────────────────────────
   底部 3 導覽(mode):精選訊號 / 全市場 / 我的關注。型態/策略不當導覽軸,
   當「精選訊號頁內的 chip」。欄位序照訊號:現貨價+CB價 → 距轉換價% →
   未轉換 → 距賣回 → 折/溢價(信用等次要往後/移除)。列表本體+CB 成組。 */

// 統一欄位序(所有 tab 共用;訊號指定的優先序)
export const LIST_COLS = ['priceHero', 'convDist', 'unconv', 'yrsPut', 'prem']
// 依「現股距轉換價」由近到遠排(|convDist| 小=逼近轉換價=最該看)
const byNearConv = (a, b) => Math.abs(a.convDist ?? 999) - Math.abs(b.convDist ?? 999)
const byCode = (a, b) => a.code.localeCompare(b.code)

/* 以現股為組別(訊號:現股是本體,CB 掛在它底下)。
   把已排序的 flat CB 清單依「換股標的代號」歸組:
   - 組的先後 = 該組「最靠前那檔 CB」在排序後清單的位置(所以近轉換價的組會浮上來)
   - 組內 CB 維持排序順序
   - multi = 同一檔現股有 ≥2 檔 CB(康舒一二 / 台灣大四五 / 勤誠二三…)→ 顯示現股表頭 + CB 子列
   - 單檔 CB 的現股不另立表頭(避免 380 檔各多一列),但 CB 列本身仍以現股身分為主
   回 [{ key, stk, stkCode, stkPx, isEB, rows:[...cb], multi }] */
export function groupByUnderlying(list) {
  const map = new Map()
  for (const r of list) {
    const key = r.stkCode || r.code
    if (!map.has(key)) map.set(key, { key, stk: r.stk, stkCode: r.stkCode, isEB: r.isEB, rows: [] })
    map.get(key).rows.push(r)
  }
  return [...map.values()].map(g => ({ ...g, multi: g.rows.length > 1, stkPx: g.rows[0].stkPx }))
}

/* 即時現股報價套用:用即時 stkPx 重算轉換價值/百元平價/距轉換價/股債乖離(公式與 enrich 一致)。
   quotes = { <現股代號>: { px, chg, t } }(來源=即時資料閘道 即時成交價,見 quote_server)。
   convVal = 100/convPx × stkPx;parity=convVal;convDist=parity−100;dev=(cbPx−convVal)/convVal×100。
   標的以 stkCode 為鍵(EB 的換股標的即 stkCode,正是轉換價值該看的股票)。無報價的檔原樣返回。 */
export function applyLiveQuotes(rows, quotes) {
  if (!quotes) return rows
  return rows.map(r => {
    const q = quotes[r.stkCode]
    if (!q || !Number.isFinite(q.px)) return r
    const stkPx = q.px
    const convVal = r.convPx ? 100 / r.convPx * stkPx : r.convVal
    const parity = Number.isFinite(convVal) ? convVal : r.parity
    const convDist = Number.isFinite(parity) ? parity - 100 : r.convDist
    const dev = (Number.isFinite(convVal) && convVal && r.cbPx != null) ? (r.cbPx - convVal) / convVal * 100 : r.dev
    return { ...r, stkPx, convVal, parity, convDist, dev, prem: dev, live: true, stkChg: q.chg, stkAsof: q.t }
  })
}

// 精選訊號頁內 chip:型態學精選 + 5 個型態(訊號定的)
export const PICK_CHIPS = [
  { id: 'firepick', label: '型態學精選', filter: firePickQualify, sort: byNearConv,
    hint: '現股逼近轉換價 + 有型態訊號 = 精華中的精華' },
  { id: '型態A', label: '型態A', filter: patternQualify('型態A'), sort: byNearConv },
  { id: '型態B', label: '型態B', filter: patternQualify('型態B'), sort: byNearConv },
  { id: '型態C', label: '型態C', filter: patternQualify('型態C'), sort: byNearConv },
  { id: '型態D', label: '型態D', filter: patternQualify('型態D'), sort: byNearConv },
  { id: '型態E', label: '型態E', filter: patternQualify('型態E'), sort: byNearConv },
  { id: '型態F', label: '型態F', filter: patternQualify('型態F'), sort: byNearConv },   // 後端 signal 表會產出,補齊 chip(見 build_raw PATTERNS)
]

export const STRATS = [
  {
    id: 'pick', label: '精選訊號', flagship: true,
    cond: '型態學精選(近轉換價+型態)＋ 各型態訊號',
    text: '本原型的型態雷達:現股逼近轉換價、且走出型態訊號(型態A/型態B/型態C/型態D/型態E)的 CB。點型態 chip 切換。',
    desc: FIRE_DESC,
    chips: PICK_CHIPS,
    cols: LIST_COLS,
    filter: r => PICK_CHIPS.some(c => { try { return c.filter(r) } catch { return false } }),
    sort: byNearConv,
  },
  {
    id: 'all', label: '全市場',
    cond: '全部有 CB 的標的(依代碼)',
    text: '全部 200 多檔可轉債,依代碼排列。想看特定檔或全貌時用。',
    desc: MAP_DESC,
    cols: LIST_COLS,
    filter: () => true,
    sort: byCode,
  },
  {
    id: 'watch', label: '我的關注',
    cond: '你自選追蹤的標的',
    text: '你加入關注的 CB。點標的右上的星號加入/移除。',
    desc: MAP_DESC,
    cols: LIST_COLS,
    filter: () => true,   // 實際由 App 依 watchlist 過濾
    sort: byNearConv,
  },
]

const CREDIT_RANK = { green: 0, yellow: 1, red: 2, unknown: 3 }
export function sortVal(r, k) {
  if (k === 'cbasPrem') { const c = cbas(r); return c ? c.premium : null }
  if (k === 'cbasLev') { const c = cbas(r); return c ? c.lev : null }
  if (k === 'strat') return stratTagsFor(r).length            // 策略欄:符合策略數(多→前)
  if (k === 'dev' || k === 'devHero') return r.dev != null ? Math.abs(r.dev) : null  // 乖離依「差距」:|偏離|小→前(高連動優先)
  if (k === 'convDist') return r.convDist != null ? Math.abs(r.convDist) : null       // 距轉換價依「差距大小」(乖離法):|距離|小=最貼近轉換價→前
  if (k === 'id') return r.dev
  if (k === 'heatHero') return r.heat
  if (k === 'putYtmHero') return r.putYtm
  if (k === 'cbPx') return r.cbPx
  if (k === 'credit') return CREDIT_RANK[creditLight(r).level]
  if (k === 'safety') return hasGuar(r) ? -1 : CREDIT_RANK[creditLight(r).level]
  if (k === 'guar') return hasGuar(r) ? 1 : 0
  if (k === 'yrsPut' || k === 'remYrs') return r.yrsToPut
  if (k === 'netDisc') { const n = netDiscount(r); return n ? n.net : null }
  if (k === 'borrowDiff') return r.borrow?.borrowBal ?? null
  if (k === 'issuePrem') return r.issuePrem
  if (k === 'toConv') return r.parity != null ? r.parity - 100 : null
  if (k === 'parDev') return r.cbPx != null ? r.cbPx - 100 : null
  if (k === 'relPut') return (r.cbPx != null && r.putPx != null) ? r.cbPx - r.putPx : null
  return r[k]
}

export function listRows(rows, strat, sortKey, sortDir) {
  let list = rows.filter(strat.filter)
  if (sortKey) {
    list = [...list].sort((a, b) => {
      const av = sortVal(a, sortKey), bv = sortVal(b, sortKey)
      if (typeof av === 'string' || typeof bv === 'string') return sortDir * String(av ?? '').localeCompare(String(bv ?? ''))
      return sortDir * ((av ?? -1e9) - (bv ?? -1e9))
    })
  } else list = [...list].sort(strat.sort)
  return list
}

/* 白話狀態(競品調研:訊號翻譯欄=最大差異化;行動版兩行摘要列用)。
   ★治理 C8:**後端算好的優先**(架構原則 明確點名)——同一檔在 App 與 web 上必須講同一句話,
   在前端算就會各自漂移。後端未給時走下面的前端規則(判斷順序與後端逐條對齊)。 */
export function statusWord(r) {
  if (r.statusWord) return { word: r.statusWord, tone: r.statusTone || 'dim' }
  if (r.dev != null && r.dev < -3) return { word: '折價,比股票便宜', tone: 'down' }
  if (r.dev != null && Math.abs(r.dev) <= 3) return { word: '發動,跟現股連動', tone: 'gold' }
  if (r.cbPx <= 105 && r.putRet != null && r.putRet >= 0) return { word: '保底,等賣回', tone: 'down' }
  if (r.dev != null && r.dev <= 10 && (r.heat >= 4 || r.pattern)) return { word: '進可攻退可守', tone: 'warm' }
  return { word: '先觀望', tone: 'dim' }
}

/* ── CBAS 適用性(抽屜第 6 段「條件顯示」用)──
   只有「有擔保 + 貼近債底(權利金便宜) + 方向(型態/熱度)成立」才顯示試算。
   回 {ok, reason, guar, cheap, direction};不適用時 reason 明說原因(無賣回資料/無擔保/溢價過高)。 */
export function cbasApplicability(r) {
  const guar = hasGuar(r)
  const c = cbas(r)
  const direction = !!r.pattern || r.heat >= CBAS_FILTER.heatStrong
  const cheap = !!c && (c.atFloor || (c.premium != null && c.premium < CBAS_FILTER.premCheap))
  if (!c) return { ok: false, reason: '此檔無賣回條款資料(永續/未設),無法試算 CBAS。', guar, cheap: false, direction }
  if (!guar) return { ok: false, reason: '此檔無擔保——CBAS 下檔仰賴發行公司信用,不宜在無擔保檔上槓桿。', guar, cheap, direction }
  if (!cheap) return { ok: false, reason: `此檔權利金偏貴(溢價過高,約 ${fmt(c.premium)} 元/百元)——CBAS 時間價值成本高,不划算。`, guar, cheap, direction }
  return { ok: true, reason: '', guar, cheap, direction }
}

/* ── 策略感知判讀(抽屜第 1 段「本策略判讀」,擺最頂)──
   依「從哪一頁點進來(stratId)」換內容:一句結論(go 可進場/watch 觀察/avoid 避開)
   + 為什麼 + 下一步驗證什麼。語氣=研究假說,非買賣建議(免責由 footer 承接)。
   命名對齊(硬性):股債乖離 / 契約下檔參考 / 型態訊號 / 條款觸發監測。 */
export function stratVerdict(r, stratId, todayStr) {
  const c = creditLight(r)
  const f = forceCallStatus(r)
  const heatStr = r.heat >= 7 ? `現股大橘(熱度 +${r.heat})` : r.heat >= 4 ? `現股淺橘(熱度 +${r.heat})` : null
  const pat = r.pattern ? `「${r.pattern}」型態訊號` : null
  const dir = [pat, heatStr].filter(Boolean).join('＋')

  switch (stratId) {
    case 'fire': {
      const direction = !!r.pattern || r.heat >= FIRE.heatStrong
      const downClose = r.putPx > 0 && (r.cbPx - r.putPx) / r.putPx * 100 <= FIRE.putDevMax
      const water = r.unconv != null && r.unconv > FIRE.unconvMin
      if (f.level === 'trig') return { level: 'avoid', title: '避開:強贖已觸發', why: '現股已達強贖觸價,發行公司可能提前贖回、上檔被鎖——發動賴以跟漲的空間受限。', next: '看「條款觸發監測」的連續天數與現況,確認是否已進入贖回公告期。' }
      if (c.level === 'red') return { level: 'avoid', title: '避開:體質偏弱', why: '信用體檢偏弱留意——發動雖靠現股方向,但下檔仰賴契約與履約,體質先擋掉。', next: '到「信用體檢」看負債/速動/利保/Z 是哪一項拖累。' }
      if (direction && downClose && water) return { level: 'go', title: '可進場:訊號到位、下檔近', why: `${dir || '方向訊號'}成立,CB 相對「契約下檔參考」偏離低(下檔近),未轉換仍有水位。`, next: '到 K 線確認型態未破、量能是否延續。' }
      return { level: 'watch', title: '觀察:條件未齊', why: `${direction ? '方向成立,但' : '方向尚未成立;'}${downClose ? '' : 'CB 距契約下檔參考偏遠(下檔不近);'}${water ? '' : '未轉換水位不足。'}`, next: '等型態訊號/熱度轉強且 CB 貼近契約下檔參考再看。' }
    }
    case 'heatcb': {
      const water = r.unconv != null && r.unconv > HEAT.unconvMin
      const nearBelow = r.parity != null && r.parity >= HEAT.parityFloor && r.parity < HEAT.parityCeil
      const pressure = r.yrsToPut != null && r.yrsToPut <= HEAT.yrsMax
      const momentum = !!r.pattern || r.heat >= HEAT.heatStrong
      if (f.level === 'trig') return { level: 'avoid', title: '避開:強贖觸發中', why: '強贖會壓縮現股上行空間,推動現股走強的誘因邏輯被截斷。', next: '看「條款觸發監測」的連續天數與現況。' }
      if (water && nearBelow && pressure && momentum) return { level: 'go', title: '可進場:動機齊、訊號轉強', why: `未轉換高、現股在轉換價下方(距轉換價 ${fmt(r.parity - 100, 1)}%)、剩餘年期有壓力,且${dir || '訊號'}轉強。`, next: '到 K 線看量能是否配合型態訊號。' }
      return { level: 'watch', title: '觀察:動機在、訊號未確認', why: `${momentum ? '' : '型態訊號/熱度尚未轉強;'}${nearBelow ? '' : '現股離轉換價的位置不在誘因區;'}${water ? '' : '未轉換水位不足;'}${pressure ? '' : '剩餘年期壓力不足。'}`.trim() || '動機指標齊,待訊號確認。', next: '等型態訊號成立且熱度轉強再進。' }
    }
    case 'floor': {
      const y = r.putYtm ?? r.ytm
      const yieldOk = (r.putYtm != null && r.putYtm > SELL.ytmMin) || (r.ytm != null && r.ytm > SELL.ytmMin)
      if (!yieldOk) return { level: 'avoid', title: '避開:殖利率不具吸引力', why: '賣回與到期殖利率皆非正,契約現金流沒有超額報酬空間。', next: '看「契約條款」的賣回排程與到期日是否還有時間價值。' }
      if (c.level === 'red') return { level: 'avoid', title: '避開:高殖利率但體質偏弱', why: `殖利率 ${fmt(y)}% 偏高常反映市場對履約能力的疑慮——體質偏弱時,「契約下檔參考」不能替代信用判斷。`, next: '到「信用體檢」確認負債/利保/Z 是否惡化。' }
      if (c.level === 'green') return { level: 'go', title: '可進場:殖利率為正、體質穩健', why: `賣回殖利率 ${fmt(r.putYtm)}% / 到期 ${fmt(r.ytm)}%,體質穩健——以低於契約價的成本抱到可行使日取時間報酬。`, next: '確認賣回排程與最低持有/通知期,別錯過行使窗口。' }
      return { level: 'watch', title: '觀察:殖利率為正、體質中性', why: '殖利率為正但體質僅中性,需交叉看財務結構才敢抱。', next: '到「信用體檢」與「契約條款」確認履約能力與賣回排程。' }
    }
    case 'discount': {
      const disc = r.dev != null && r.dev < 0
      const nd = netDiscount(r, todayStr)
      if (!disc) return { level: 'avoid', title: '避開:目前非折價', why: '股債乖離非負(未折價),沒有可收斂的價差。', next: '回全市場地圖換折價以外的研究角度。' }
      if (r.stopNow) return { level: 'avoid', title: '避開:停轉中', why: '停止受理轉換期間無法完成轉換交割,折價套利暫不可行。', next: '看「契約條款」的停轉起迄,等開放轉換再評估。' }
      if (nd && nd.net > 0) return { level: 'go', title: '可進場:淨折價仍有空間', why: `扣手續費後淨折價約 ${fmt(nd.net, 1)} 元/百元(借券費無資料源、未計入)。`, next: '先確認借券可借與費率,把借券成本算進去再下手。' }
      return { level: 'watch', title: '觀察:折價不足以覆蓋成本', why: '帳面折價存在,但扣掉手續費後淨折價偏薄。', next: '等折價擴大或借券成本下降。' }
    }
    case 'cbas': {
      const ap = cbasApplicability(r)
      const cc = cbas(r)
      if (!ap.ok) return { level: 'avoid', title: '避開:此檔不適用 CBAS', why: ap.reason, next: 'CBAS 是方向性槓桿,前提=有擔保、貼近債底、方向成立。' }
      if (ap.direction) return { level: 'go', title: '可進場:方向成立、權利金便宜', why: `有擔保、CB 貼近債底(權利金 ${cc?.atFloor ? '趨近於零' : fmt(cc?.premium)}),且${dir || '方向訊號'}成立。`, next: '以券商實際報價校準折現率,對照槓桿倍數。' }
      return { level: 'watch', title: '觀察:便宜但方向偏弱', why: '權利金便宜、有擔保,但型態訊號/熱度方向尚未轉強——CBAS 不能只看便宜。', next: '等發動/熱度方向成立再上槓桿。' }
    }
    case 'all':
    default: {
      const tags = stratTagsFor(r)
      const nature = r.parity == null ? '' : r.parity > 110 ? '偏股性' : r.parity < 90 ? '偏債性' : '股債平衡'
      if (!tags.length) return { level: 'watch', title: '目前沒有明確策略角度', why: `這檔現在沒有同時滿足任何一個策略的進場門檻${nature ? `,性質${nature}` : ''}。`, next: '先用股債乖離與性質判斷它偏股還偏債,再挑合適的研究角度。' }
      return { level: 'watch', title: `可從這些角度研究:${tags.map(t => t.label).join('、')}`, why: `這是一檔${nature || ''}可轉債,同時符合上列策略的進場門檻——每個標籤是一種不同的獲利邏輯(方向、保底、套利或槓桿),同一檔可同時具備多種。點標籤直接用該角度打開這檔做深入判讀。`, next: '依你的目的選角度:賭方向看發動/熱度、要保底看賣回、做套利看折價、要槓桿看 CBAS。' }
    }
  }
}

/* CB 進場判讀(白話結論,語氣=假說/觀察+免責由 footer 承接) */
export function verdict(r) {
  const a = Math.abs(r.dev)
  const sig = r.heat >= 7 ? `現股大橘(+${r.heat})` : r.heat >= 4 ? `現股淺橘(+${r.heat})` : null
  const pat = r.pattern ? `「${r.pattern}」型態` : null
  const trigger = [sig, pat].filter(Boolean).join('＋') || '現股訊號中性'
  const floor = (r.cbPx <= 105 && r.putRet != null && r.putRet >= 0)
    ? `價位貼債底(賣回報酬 +${fmt(r.putRet, 1)}%),下檔有保護。` : ''
  if (r.dev < -3) return `CB 折價 ${fmt(a)}%——買 CB 比買現股便宜,跟漲之外還賺收斂價差。${trigger}。${floor}`
  if (a <= 3) return `股債乖離 ${fmt(r.dev)}%,CB 與現股幾乎 1:1 連動——${trigger},此時買 CB 等於買現股＋債底保險;想放大就用下方 CBAS。${floor}`
  if (r.dev <= 10) return `CB 溢價 ${fmt(a)}%,跟漲會先打折——${trigger},可等乖離收斂再進,或改用 CBAS 降低占用資金。${floor}`
  return `CB 溢價 ${fmt(a)}% 過高,與現股連動弱,操作 CB 不划算——除非看重債底收益,否則先觀望。${floor}`
}
