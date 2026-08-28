# realtime-quotes — 即時報價疊加

## Purpose

盤中讓清單的現股價與衍生欄(距轉換價/乖離)反映即時成交價,而不動 EOD 快照本體。

## Requirements

### R1: 輪詢與疊加
前端輪詢 `VITE_QUOTES_URL || /api/quotes.json`(quote_server 代理 即時資料閘道「即時成交價」欄,秒級);`applyLiveQuotes(rows, quotes)` 疊加重算距轉換價/乖離,UI 標示 asof 與 live 狀態。

#### Scenario: 斷線降級
- WHEN quotes 端點失敗或非盤中
- THEN 清單回退顯示 EOD 快照值,不報錯不閃爍(quotes=null 即純快照)

### R2: 來源契約
即時資料端點 即時端點(已實打驗證,詳 memory `reference_provider_air_realtime_endpoints`):即時成交價(秒級)、60分K(MinuteInterval)、型態A Signal(訊號頻道 id)。60分K 供 kline capability,Signal 供 patterns。

## Out of scope
- 即時重排序/重篩選(避免列表跳動)、WebSocket 推播(現為輪詢)、CB 自身即時價
