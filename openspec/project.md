# CB 工作站原型 — Project Conventions

> OpenSpec 慣例:`specs/<capability>/spec.md` = 「現況真相」(這個原型實際上做了什麼);
> 任何變更先在 `changes/<id>/` 開 proposal + delta,實作完把 delta sync 回 `specs/`。
> 本套 specs 描述原型的**實際行為**,包含哪些路徑是降級/未接的——
> 逐項真假對照見根目錄 [PROTOTYPE_TRUTH.md](../PROTOTYPE_TRUTH.md)。

## 產品

可轉債(CB)看盤工作站:CB 清單(策略/型態篩選)× 現股/轉債 K 線畫線 ×
明細(契約/信用/籌碼/CBAS)。
訊號哲學:**現股給訊號、CB 下單**——型態與熱度都讀現股,CB 只是進場工具。

## 元件

| 元件 | 位置 | 技術 |
|---|---|---|
| 前端 | `web/` | React 18 + Vite 6 + klinecharts 10(patched)+ Lucide |
| 資料服務 | `data-service/` | FastAPI + 排程刷新 + JWT 驗證 |
| demo 資料 | `web/public/` | 由 `data-service/scripts/make_demo_data.py` 合成 |

- 前端 build:**Node 20**(Node 24 會在 render 階段靜默硬崩;repo 有 `.nvmrc`)。
- klinecharts 以 **patch-package** 修補(`web/patches/`,`postinstall` 生效);
  修的內容與升級注意見 `specs/kline/spec.md` 的已知缺口段。
- 部署:兩個 Dockerfile 可直接 build;CI/CD 與密鑰管理由使用者自行接。

## 資料治理鐵則(這四條是架構的一部分,別拆)

1. **資料源 id 是設定,不是程式碼**:集中在 `data-service/app/tables.py`
   `DEFAULT_TABLES`,env `CBW_TABLES_JSON` 只做臨時覆蓋。
   **正確值必須是預設值**——把正確值只放在某個環境的 env 裡,等於治理只在那個環境成立,
   其他環境會靜默用錯來源且看不出差別。
2. **不可靠來源要有台帳並默認擋掉**:`RETIRED_TABLES` 記錄不該再用的來源
   (例如他人維護的私有表:對方一改,你的數字悄悄跟著變),指到就 raise。
3. **不得靜默**:必要欄位缺 → fail-loud(整輪失敗、保留舊快照);
   型態訊號例外走顯性台帳(`meta.patternIssues`),因為它是輔助訊號不該拖垮站台。
   分辨清楚:0 欄 = 來源壞了;0 列 = 今天真的沒命中(正常)。
4. **Data source contract**:每個欄位/訊號都要標「來自哪個來源的哪個欄位」,
   寫在各 capability spec 的「資料來源」段——出錯時能立刻定位。

## Specs 目錄

| capability | 內容 |
|---|---|
| [cb-list](specs/cb-list/spec.md) | 清單三策略頁、欄位、排序/篩選/搜尋 |
| [patterns](specs/patterns/spec.md) | 六型態訊號來源與先到先得規則 |
| [kline](specs/kline/spec.md) | 現股/轉債 K 線、週期、指標、副圖 |
| [drawings](specs/drawings/spec.md) | 畫線工具、本地+雲端同步、資料保全 |
| [watchlist](specs/watchlist/spec.md) | 我的關注與跨裝置同步 |
| [detail](specs/detail/spec.md) | 明細五區塊 |
| [workspace-rwd](specs/workspace-rwd/spec.md) | 三欄工作區、斷點、面板互動 |
| [auth](specs/auth/spec.md) | OIDC JWT、auth-gate |
| [data-refresh](specs/data-refresh/spec.md) | 資料建置與排程 |
| [realtime-quotes](specs/realtime-quotes/spec.md) | 即時報價疊加 |
