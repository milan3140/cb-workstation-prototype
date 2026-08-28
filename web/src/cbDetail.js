/* CB 自身明細:條款期間(停轉警示)、月集保庫存趨勢、法人買賣。
   來源=後端 /api/cb_terms.json、/api/cb_custody.json、/api/cb_legal.json
   (皆為 {CB代號: …} 的單一檔,一次載入全市場,之後查表零延遲)。
   後端未接通時三個檔都會 404 → 回空物件,畫面自動不顯示這些區塊。 */
import { fetchData } from './dataSource.js'

let bundle = null

async function loadOne(name) {
  try {
    const response = await fetchData(name, { cache: 'no-cache' })
    return response.ok ? await response.json() : {}
  } catch {
    return {}                                  // 缺資料是正常情形,不讓它炸掉抽屜
  }
}

export function loadCbDetail() {
  if (!bundle) {
    bundle = Promise.all([
      loadOne('cb_terms.json'), loadOne('cb_custody.json'), loadOne('cb_legal.json'),
    ]).then(([terms, custody, legal]) => ({ terms, custody, legal }))
  }
  return bundle
}

/* 停止轉換期間判定(卡點:發行後有一段不能轉、到期前也會停)。
   terms.convFrom / convTo = 轉換日期起 / 迄(yyyyMMdd)。
   回 {state, label, hint};state: 'before' | 'open' | 'closed' | 'unknown' */
export function convWindow(terms, todayText) {
  const from = (terms?.convFrom || '').trim()
  const to = (terms?.convTo || '').trim()
  const today = String(todayText || '').trim()
  if (!/^\d{8}$/.test(today) || (!/^\d{8}$/.test(from) && !/^\d{8}$/.test(to))) {
    return { state: 'unknown' }
  }
  if (/^\d{8}$/.test(from) && today < from) {
    return { state: 'before', label: '尚未開放轉換',
             hint: `${fmtDate(from)} 起才可轉換——在那之前只能買賣 CB 本身,不能換成股票。` }
  }
  if (/^\d{8}$/.test(to) && today > to) {
    return { state: 'closed', label: '已停止轉換',
             hint: `轉換期已於 ${fmtDate(to)} 截止,現在只剩到期還本/賣回這條路。` }
  }
  return { state: 'open', label: '可轉換中',
           hint: `轉換期間 ${fmtDate(from)}～${fmtDate(to)}。` }
}

export function fmtDate(text) {
  const s = String(text || '').trim()
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6)}` : (s || '－')
}

/* 三大法人買賣這檔 CB 的解讀(近 20 個交易日)。
   為什麼看它:CB 是法人做 CBAS 的原料——**自營商買 CB 常常就是有人來跟券商買了選擇權**,
   所以自營淨買持續為正,代表有資金在用槓桿押這檔的上漲。外資/投信買 CB 則偏長期持有。
   回 null 表示這檔近期沒有法人進出(常態,CB 流動性低)。 */
export function legalRead(rows) {
  const series = (rows || []).filter(r => r && Number.isFinite(r.total))
  if (!series.length) return null
  const recent = series.slice(0, 10)                       // 來源是新→舊
  const sum = key => recent.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
  const dealer = sum('dealer')
  const foreign = sum('foreign')
  const trust = sum('trust')
  const net = dealer + foreign + trust
  const active = recent.filter(r => (Number(r.total) || 0) !== 0).length
  return { days: recent.length, active, dealer, foreign, trust, net }
}

/* 集保庫存趨勢的解讀:庫存佔發行比大幅下滑=有人把 CB 轉成股票或賣出(「聰明錢下車」)。
   回 {series, latest, dropPct, alert};dropPct=近 3 個月佔比變化(百分點)。 */
export function custodyRead(rows) {
  const series = (rows || []).filter(r => r && Number.isFinite(r.custodyPct))
  if (series.length < 2) return null
  const latest = series[series.length - 1]
  const base = series[Math.max(0, series.length - 4)]        // 約 3 個月前
  const dropPct = latest.custodyPct - base.custodyPct
  return {
    series, latest, dropPct,
    alert: dropPct <= -5,                                    // 3 個月掉 5 個百分點以上才叫「明顯」
  }
}
