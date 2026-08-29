# ParityDesk — Data Schema(資料契約真相源)

> 維護鏈:**資料集 + 附加資訊(AddInfo/author-api StockCalculation)→ `webapp/build_raw.py` → `_fresh_raw.json`(=本站 `public/raw.json`)→ 前端 `enrich()` 衍生 → UI 欄位**。
> 改任何一環先對照本檔;改欄位=同步改 build_raw.py、logic.js `enrich()`、本檔三處。
> 前端載入時有 schema 防呆(`assertRaw()`,壞列 fail-loud 進 console 不靜默)。

## 1. raw.json 頂層

| key | 型別 | 說明 |
|---|---|---|
| `today` | string `YYYYMMDD` | 資料日=**資料本身日期**(`heat` 日期欄最大值,非跑批時鐘;假日跑批不標錯) |
| `raw` | `Row[]` | 一列=一檔 CB;**15 元素定長 tuple**(省 60% 體積 vs 物件陣列) |

## 2. Row 15-tuple(index 定義,順序不可動)

| idx | 欄位 | 型別 | 單位/格式 | 來源 資料集 | 可空 | 備註 |
|---|---|---|---|---|---|---|
| 0 | `code` | string | CB 代號(5-6 碼) | （已退役來源）「代號」 | ✕ | 主鍵 |
| 1 | `name` | string | CB 名稱 | （已退役來源）「名稱」 | ✕ | 標的名+序數+永/KY |
| 2 | `stkCode` | string | 現股代號 | （已退役來源）「標的代號」 | ✕ | |
| 3 | `stk` | string | 現股名稱 | （已退役來源）「股票名稱」 | ✕ | 查無時=stkCode |
| 4 | `stkPx` | number | 元 | `heat`「收盤」(逐股) | ✕ | 缺值列在 build 期被剔除 |
| 5 | `convPx` | number | 元(轉換價) | （已退役來源）「轉換價」 | ✕ | =0 的列被剔除 |
| 6 | `cbPx` | number | 元(CB 收盤) | （已退役來源）「收盤」 | ✕ | 缺值列被剔除 |
| 7 | `vol` | number | 張(最新交易日累計) | **附加資訊 StockCalculation**(author-api AIR,批次打全部 CB 代號) | ✕ | 真實成交張數;未回=當日無成交=0;盤後跑批=全日量 |
| 8 | `newHigh` | number | 日數 | 無 資料集 源 | 0 | UI 已移除顯示;保留欄位待源 |
| 9 | `putDate` | string | `YYYY/MM/DD` 或 `""` | （已退役來源）「賣回日」 | 空字串 | ★欄名定位必精確比對,防撞「距賣回日」(踩過:全空→CBAS 整塊壞) |
| 10 | `putPx` | number\|null | 元(賣回價) | （已退役來源）「賣回價」 | ✓ | |
| 11 | `guar` | string | 「無」/「有,○○銀行」 | （已退役來源）「是否擔保」 | ✕ | 前端判擔保用 `startsWith('有')` |
| 12 | `unconv` | number | %(未轉換比率) | （已退役來源）「未轉換餘額(%)」 | ✕ | 缺值時=100 |
| 13 | `heat` | number | −10~10(0.5 刻度) | `heat`「熱度」(逐股) | ✕ | 缺值時=0;=籌碼分數+技術分數 |
| 14 | `pattern` | string\|null | 型態名 | signal 表 `pattern_c` 型態C/`pattern_d` 型態D/`pattern_e` 型態E/`pattern_f` 型態F/`pattern_b` 型態B(先到先得;訊號頻道 id 型態A盤中常空) | ✓ | 已接真;null=未符合追蹤型態 |

## 3. 前端衍生欄(`logic.js enrich()`,不進 raw.json)

| 欄位 | 公式 | 空值條件 |
|---|---|---|
| `convVal` 轉換價值 | `100 ÷ convPx × stkPx` | convPx 空 |
| `dev` 股債乖離率 % | `(cbPx − convVal) ÷ convVal × 100` | convVal 空 |
| `putRet` 賣回報酬率 % | `(putPx − cbPx) ÷ cbPx × 100` | putDate/putPx 空(永續/未設) |
| `yrsToPut` 距賣回年 | `(putDate − today) ÷ 1年`,下限 0 | 同上 |
| CBAS(`cbas()`) | 百元報價=`折現率×yrsToPut−(putPx−100)+0.3`;權利金=`(cbPx−100)+百元報價`;槓桿=`convVal÷權利金`(權利金>0.5 才給) | yrsToPut 空→整組 null→UI 顯「永續/未設」 |

## 3.4 交換公司債(EB)判定與歸屬(發行公司 ≠ 交換標的)

資料集 **無「發行公司」欄**(（已退役來源） 只有標的代號)。用代號結構判定,規則同時在**前端 `enrich()`** 與**後端 `refresh._credit`** 實作(改一處要同步另一處):

| | 判定 | 發行公司 | 交換/轉換標的 |
|---|---|---|---|
| 一般可轉債 | `code` 以 `stkCode` 開頭 | = 標的股 | `stkCode` |
| 交換公司債 EB | `code` **不以** `stkCode` 開頭 | `code[:4]`(前 4 碼) | `stkCode` |

- 前端 `enrich()` 產出 `isEB` / `issuerCode` / `issuerName`(名稱取自 CB 名前綴,如「遠東新E2永」→「遠東新」)。
- **歸屬原則**:型態/熱度/轉換價值/parity/dev → 看**標的股**(交換後拿到的股票);**信用/賣回償還能力 → 看發行公司**(欠你錢的一方)。因此 `refresh._credit` 的查詢鍵 = EB 用 `code[:4]`、一般 CB 用 `stkCode`(見 `credit_key`)。借券/除權息仍用標的股(套利放空的是標的)。
- 現況全市場 **2 檔 EB**:`140201` 遠東新E1永(換亞泥 1102)、`140202` 遠東新E2永(換遠百 2903),皆遠東新世紀 **1402** 發行。

## 3.5 history.json（舊版相容資料）

| key | 型別 | 說明 |
|---|---|---|
| `{stkCode}` | object | `{d0:"YYYYMMDD"起日, d1:"YYYYMMDD"迄日, c:[number×≤60]}` 收盤序列舊→新 |

來源=資料集 （已退役來源）。正式版 K 線已不使用此檔，僅保留給舊版收盤折線相容。

## 3.6 kline/{stkCode}.json（正式 OHLCV）

```json
{
  "schemaVersion": 1,
  "symbol": "1101",
  "updatedAt": 1784160000000,
  "periods": {
    "day": [{"timestamp":1784160000000,"open":23.5,"high":24.1,"low":23.45,"close":23.95,"volume":27846,"turnover":662502000}],
    "week": [],
    "month": []
  }
}
```

來源與 iOS `CMSwiftBackendAPI/GetKLine.swift` 相同：日／週／月 資料集 `（已退役來源）/（已退役來源）/（已退役來源）`。輸出前驗證價格、日期順序、重複日期及覆蓋率。前端逐股懶載入，不會一次下載全市場約 32 MB。

## 4. 更新流程(資料換血,前端零改動)

```
py webapp/build_raw.py          # 打 資料集 五表,產 webapp/_fresh_raw.json(含非空率 fail-loud)
copy webapp/_fresh_raw.json webapp-react/public/raw.json(+webapp-react-v4)
copy webapp/_history.json  webapp-react/public/history.json(+webapp-react-v4)
npm --prefix webapp-react-v4 run data:sync # 同步 raw/history/kline
```

## 5. 待接資料源(效果樹 X12;2026-07-16 盤點後殘餘)

| 項 | 現況 | 缺口 |
|---|---|---|
| ~~CB 成交張數~~ | ✅已接:附加資訊 StockCalculation(author-api AIR)批次打 CB 代號拿「累計成交量」,vol 改真值 | 完成 |
| 現股真 K 線 | ✅日／週／月 OHLCV 已接，306/306 檔 | 完成；來源 （已退役來源）/（已退役來源）/（已退役來源） |
| CB 自身價格走勢 | 詳情主圖依教學邏輯使用標的現股真 K 線 | 若未來需要 CB 自身 K 線仍須另找來源 |
| CBAS 券商實際報價 | 公式試算器(折現率可調,已標公式) | 券商無公開 API;維持試算定位或接券商源=業務決策 |
| `newHigh` 現股創新高 | UI 已移除 | 待源 |
| 型態A型態(訊號頻道 id) | iOS 走 `.signal(channels:)` 非 GetDtnoData;打 資料集 與猜測 signal 端點皆空/404 | signal channel HTTP 端點需 mitmproxy 抓手機實際封包確定(同 AddInfo host 取得方式);其餘 5 型態走 資料集 signal 表已接 |
