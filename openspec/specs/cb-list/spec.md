# cb-list — CB 清單與策略頁

## Purpose

讓使用者從 ~384 檔 CB 中,依本原型的策略視角(型態精選/全市場/自選)快速鎖定候選標的,每檔以「一組現股+旗下各 CB」的巢狀列呈現五個決策指標。

## Requirements

### R1: 三個策略頁(tabs)
清單頂部三個 tab:**精選訊號**(旗艦,預設)/**全市場**/**我的關注**,各自帶計數徽章。

#### Scenario: 精選訊號
- WHEN 使用者在精選訊號頁
- THEN 顯示型態 chips 列:`型態學精選`(現股逼近轉換價+有型態訊號,`firePickQualify`)與六個型態 chip(型態A/型態B/型態C/型態D/型態E/型態F),每個 chip 帶當日命中數
- AND 排序=距轉換價升冪(`byNearConv`,越貼近越前)

#### Scenario: 全市場
- WHEN 切到全市場
- THEN 顯示全部有 CB 的標的,依代碼排序(`byCode`)

#### Scenario: 我的關注
- WHEN 切到我的關注
- THEN 只顯示 watchlist 內標的(見 `specs/watchlist/spec.md`),排序=距轉換價

### R2: 巢狀列結構與欄位
列=現股群組(名稱/代號/型態 tag/現股價/60日 sparkline)+ 旗下每檔 CB 一列。桌面左欄五指標欄:**價格(CB收盤)/距轉(vs換股價)/未轉(籌碼)/賣回(剩餘年)/折溢(比平價)**;欄位目錄共 28+ 欄(`logic.js` COLS),各策略頁用 `LIST_COLS` 子集。

#### Scenario: 排序
- WHEN 點欄位標題
- THEN 依該欄排序;乖離類欄(distConv/dev)首點**升冪**(貼近=優先),其餘首點降冪;再點反向

### R3: 快速篩選(faceted)
`＋篩選` 開啟與當前策略疊加的快速篩選;每頁只出現該策略在乎的條件(`STRAT_FILTERS`)。全目錄:有擔保/信用穩健/殖利率>3%/未轉換>70%/熱度大橘≥7/有型態訊號/開放轉換/借券容易/貼近面額(≤103)。

### R4: 搜尋
搜尋框輸入代號或名稱 → 跨全市場過濾(不受當前 tab 限制),清空恢復。

### R5: 空頁保底
#### Scenario: 當日精選 0 檔
- WHEN 精選訊號當日型態學精選 0 檔
- THEN 自動選第一個可用標的(`list[0] ?? rows[0]`)顯示 K 線,不得空白落地

## 資料來源(data source contract)

| 欄位 | 來源 |
|---|---|
| CB 主檔(條款/未轉換/轉換價/標的代號) | 自有表 `cb_master` |
| CB 收盤價 | 自有表 `cb_close` |
| 現股收盤+熱度+資料日 | 自有表 `heat` |
| 股票名稱/融券 | 自有表 `stock_names` |
| 60日走勢 sparkline | 自有表 `trend60` |
| 型態 tag | 見 `specs/patterns/spec.md` |
| 除權息/借券 | 資料集原始報表 `exdiv` / `borrow` |

前端一律吃後端 `/api/raw.json` 快照(元組陣列,index 對照見後端 build_raw),不直打 資料集。

## Out of scope
- 盤中即時重排序(即時價只疊加顯示,見 realtime-quotes)
- 自訂欄位配置

## 已知缺口
- 全市場 383 列在低階機首次渲染較重(已用 React.memo + content-visibility 緩解,hover 平均 15ms)
