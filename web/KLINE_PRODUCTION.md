# Signal K 線畫圖正式版

## 架構與安全邊界

- 真 K 線來源：iOS `CMSwiftBackendAPI/GetKLine.swift` 同源 資料集，日／週／月分別為 `（已退役來源）`、`（已退役來源）`、`（已退役來源）`。
- 資料集 帳密只允許放在建置機的 `PROVIDER_資料集_ACC`、`PROVIDER_資料集_PWD` 環境變數。
- React runtime 只讀 `public/kline/{symbol}.json`；不包含帳密、Token、內網 URL 或 GitLab 資訊。
- `build_raw.py` 只輸出 `timestamp/open/high/low/close/volume/turnover` 白名單欄位，並驗證 OHLC、日期、筆數及市場覆蓋率。
- 文字標註只作為 Canvas 純文字，不插入 HTML。
- 預設畫線存在 IndexedDB。若設定 `VITE_DRAWINGS_API_URL`，只支援同源 Cookie session；前端不接受固定 Bearer Token。

## 資料更新

```powershell
$env:PROVIDER_資料集_ACC=[Environment]::GetEnvironmentVariable('PROVIDER_資料集_ACC','User')
$env:PROVIDER_資料集_PWD=[Environment]::GetEnvironmentVariable('PROVIDER_資料集_PWD','User')
python ..\webapp\build_raw.py
npm run data:sync
npm test
npm run build
```

批次失敗時不可部署舊新混合資料。成功條件：

- CB 主表超過 300 檔。
- K 線股票覆蓋率至少 98%；目前為 306/306。
- 每根 K 棒符合 `high >= max(open, close)`、`low <= min(open, close)`。
- 三週期皆有資料；新上市股票最低門檻為 20 日／4 週／2 月。

## 畫線同步 API 契約

若要跨裝置同步，後端提供：

```http
GET /v1/chart-drawings/{symbol}/{period}
PUT /v1/chart-drawings/{symbol}/{period}
```

- 使用 HttpOnly、Secure、SameSite Cookie 驗證使用者。
- PUT 必須驗證 CSRF、`schemaVersion`、股票代號與資料大小；每使用者／股票／週期最多 300 個圖形。
- 伺服器端以登入使用者 ID 分區，禁止採信 request body 裡的使用者 ID。
- 建議 optimistic concurrency（ETag/If-Match）及每日備份。

## 正式功能

- 日／週／月 K、MA5/10/20/60。
- 成交量、MACD、KDJ、RSI 副圖。
- 十字查價與 OHLCV header。
- 趨勢線、水平支撐壓力、矩形、文字、自由手繪。
- 選取／拖曳、鎖定、顏色、線寬、刪除、全部清除。
- Undo／Redo（80 次快照）、文字原地編輯、含畫線圖片匯出。
- 桌機側欄、平板全寬、手機全螢幕操作。

## 部署

`public/_headers` 提供 CSP、反 iframe、MIME sniffing 與權限限制；部署平台若不支援 `_headers`，需在 CDN／Web Server 設定等效 Header。若畫線 API 非同源，必須同步調整 CSP，但仍不得把長效 Token 放入 `VITE_*`。
