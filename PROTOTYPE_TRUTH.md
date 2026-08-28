# 原型真假逐項對照

這份文件把原型裡**每一處假的、模擬的、未接通的細節**列出來,並對每一項給三個答案:

- **假到什麼程度** —— 具體是哪個檔案的哪個欄位在造假,以及造假的方式
- **接真的怎麼做** —— 要換成真資料/真服務的最小步驟
- **不需要就怎麼移除** —— 你的產品不需要這功能時,拆掉要動哪裡

> 判準:**互動、版面、公式、資料契約、失敗處理都是真的**;假的只有資料本身、
> 訊號歸屬,以及三條對外連線(登入、雲端同步、即時報價)。

## 速查表

| # | 項目 | 狀態 |
|---|---|---|
| 1 | 市場資料(總覽/走勢/K線/籌碼) | 合成,可直接跑 |
| 2 | 標的宇宙(21 檔示範公司) | 合成 |
| 3 | 型態訊號 A~F | 佔位命名 + 隨機歸屬 |
| 4 | 熱度分數 | 合成數字 |
| 5 | 信用評分與財務比率 | 合成(綠/黃/紅各有) |
| 6 | 強制贖回條款 | 合成參數,1 檔刻意觸發中 |
| 7 | 停止轉換期間 | 合成,1 檔刻意在停轉中 |
| 8 | 除權息 / 借券餘額 | 合成 |
| 9 | 發行辦法連結 / ISIN | 假 URL、假 ISIN |
| 10 | 即時報價 | 未接(降級為收盤值) |
| 11 | 登入(OIDC) | 未接(guest 模式) |
| 12 | 關注清單雲端同步 | 未接(只存本機) |
| 13 | 畫線雲端同步 | 未接(只存本機) |
| 14 | CBAS 折現率 | 真公式 + 示範參數 |
| 15 | 資料日與「更新中斷」橫幅 | 真邏輯,demo 資料會過期 |
| 16 | 後端資料服務 | 真程式,未接資料源 |
| 17 | klinecharts 修補 | **真的,必要,別移除** |
| 18 | 部署(Docker/nginx) | 可用,無 CI/CD |

---

## 1. 市場資料(總覽、走勢、K 線、籌碼)

**假到什麼程度**:`web/public/` 底下六類檔案全部由
`data-service/scripts/make_demo_data.py` 以固定亂數種子(SEED=20260828)合成——
`raw.json`(總覽 15-tuple + 衍生欄 + 基本資料 + 信用 + 除權息 + 借券)、
`history.json`(近 60 日收盤)、`kline/<現股>.json`(60分/日/週/月)、
`cb_kline/<CB>.json`(日 20 根/週/月)、`cb_custody.json`、`cb_legal.json`、
`cb_terms.json`。價格是隨機漫步,**資料契約(欄位順序、型別、巢狀結構)是真的**,
前端的 schema 防呆(`logic.js` `assertRaw`:15-tuple、必要欄型別)會實際驗它。

**接真的怎麼做**:
1. `data-service/app/tables.py` 填入你的資料集 id(或設 `CBW_TABLES_JSON`);
   若你的資料源不是「表 id」模型,改寫 `refresh.py` 裡的取數 adapter,
   讓它最後產出同樣形狀的 `raw.json` 即可——前端一行都不用改。
2. 起後端:`cd data-service && pip install -r requirements.txt && uvicorn app.main:app`
3. 前端設 `VITE_DATA_API_URL=http://localhost:8000`,重啟 dev server。
   此時前端會改打 `/api/*`,不再讀 `public/`(見 `web/src/dataSource.js`)。

**不需要就怎麼移除**:刪 `web/public/*.json`、`web/public/kline`、`web/public/cb_kline`
與 `data-service/scripts/make_demo_data.py`,並拿掉 `dataSource.js` 裡的靜態退路
(`return fetch(\`${import.meta.env.BASE_URL}${path}\`)` 那段)。拿掉後未設 API 位址
就是白畫面——這也是正式部署該有的行為(正式映像不烤資料)。

## 2. 標的宇宙(21 檔示範公司)

**假到什麼程度**:12 家「示範 XX」公司(代號 9001–9012)、21 檔 CB(代號 = 現股代號 + 序號),
外加 1 檔交換公司債(EB)`90131`:代號前綴 9013 是發行人、換股標的卻是 9005,
用來走通「發行人 ≠ 標的股」的分支(`logic.js` 的 `isEB` / `issuerCode` / `issuerName`)。
名稱與代號都不對應任何真實公司。

**接真的怎麼做**:標的清單來自 `cb_master` 表,無需另外設定;接上 #1 就是真的宇宙。

**不需要就怎麼移除**:改 `make_demo_data.py` 的 `ISSUERS` 常數換成你的示範標的。
若你的商品沒有 EB 這種「發行人 ≠ 標的」概念,可刪掉該檔生成邏輯與
`logic.js` 中 `isEB` 相關三行(其餘欄位不依賴它)。

## 3. 型態訊號 A~F

**假到什麼程度**:兩層假。
(a) **命名是佔位**:`型態A`…`型態F` 沒有幾何定義,只是六個標籤;
(b) **歸屬是隨機的**:demo 資料把型態指派給前 8 家公司的第一檔 CB,並刻意讓
這些標的同時滿足「貼近轉換價 ±5%」與「未轉換 > 50%」,精選頁才有內容可看
(否則旗艦頁會是空的)。

原設計是**沿用 server-side 訊號、不在前端自算幾何**:每個型態對應一張訊號表
或一個訊號頻道,前端只讀「這檔今天有沒有命中」。這個架構決定保留了。

**接真的怎麼做**:
1. `tables.py` 的 `pattern_a`…`pattern_f` 填入各型態的資料源 id;
   若某型態來自事件型頻道而非表,在 `refresh.py` 的型態取數段加一個 adapter 分支。
2. 改 `web/src/logic.js` 的 `PICK_CHIPS`:把 `id`/`label` 換成你的型態真名
   (id 與 label 目前同字串,`patternQualify(name)` 直接比對 `r.pattern`)。
3. 型態表壞掉的處理已經是真的:0 欄 = 表壞(記進 `meta.patternIssues` 台帳),
   0 列 = 今天沒命中(正常不吵)。別把這條改成靜默。

**不需要就怎麼移除**:刪 `PICK_CHIPS` 中六個型態 chip(留 `firepick` 或全刪)、
`STRATS` 裡 `pick` 頁改成別的旗艦策略;`logic.js` 的 `patternQualify`
與 `firePickQualify` 一併移除,`COLS.pattern` / `COLS.signal`(兩個型態欄)也拿掉。

## 4. 熱度分數(heat)

**假到什麼程度**:`raw` 15-tuple 第 14 欄,合成值。有型態的標的給 4.5–9.5,
其餘隨機分佈在 -2–9.5。分級門檻(≥7 高 / ≥4 中高 / ≥0 中性 / <0 偏弱)
與配色(`--heat-*` token)是真的。

**接真的怎麼做**:接 `heat` 表(`tables.py`)。它在原設計裡是「技術分 + 籌碼分」
的複合分數,籌碼分較晚發布——所以刷新排程要跨越發布時點,見 #16。

**不需要就怎麼移除**:`logic.js` 移除 `heatLv`/`heatWord`/`HEAT`/`heatQualify`、
`COLS.heat`、`FILTERS` 的 `hot` 項與 `STRAT_FILTERS` 中所有 `'hot'`;
`tokens.css` 的 `--heat-*` 四個 token 可留(無害)或刪。

## 5. 信用評分與財務比率

**假到什麼程度**:`credit` 區塊每檔給 `credScore`/`finRating`(1–9,越小越好)、
`debtRatio`/`quickRatio`/`interestCover`(隨機)、`zScore`。刻意按 i%3 輪替成
綠(2/3/z3.4)、黃(5/6/z2.1)、紅(8/8/z1.2),讓信用燈三種狀態都看得到。
**判定邏輯是真的**:`CREDIT_LIGHT` 門檻(綠 ≤3.5、黃 ≤6.5、Altman z 安全 2.99 /
危險 1.81)、以及「評分綠但 z 進危險區 → 至多降一級」的交叉驗證規則。

**接真的怎麼做**:接你的信評/財務比率來源,填進 `raw.json` 的 `credit` 區塊
(鍵 = CB 代號)。刻度方向要對齊:本原型假設評分 1 佳 → 9 弱;若你的來源相反,
改 `logic.js` 的 `creditLight()` 比較方向,別改資料。

**不需要就怎麼移除**:移除 `creditLight()`、`COLS.credit`、`FILTERS.credG`、
明細的「信用體檢」區塊(`Drawer.jsx` 的 `DETAIL_SECTIONS` 對應項)。

## 6. 強制贖回條款

**假到什麼程度**:`cbBasic.callTrigger1=130`(啟動比率 %)、`callDays1=30`(連續天數)
全檔一致;第 6 檔(index 5)刻意把 trigger 改成 100,讓它變成「觸發中」狀態。
**狀態計算是真的**:觸價 = 轉換價 × 啟動比率%,現股 ≥ 觸價 → 觸發中、≥90% → 接近。

**接真的怎麼做**:接 `cb_basic` 表的贖回啟動比率與連續天數欄。
原設計刻意**不讀**「強制贖回日」那個空白率高的欄位,改用條款參數即時算——保留這個選擇。

**不需要就怎麼移除**:移除 `logic.js` 的 `forceCallStatus()` 與 `COLS.forceCall`。

## 7. 停止轉換期間

**假到什麼程度**:第 4 檔(index 3)的 `cbBasic.stopConvStart/End` 被設成
「今天前 5 天 ~ 今天後 25 天」,所以它一定顯示停轉中(`stopNow=true`)、
`statusWord` 為「停止轉換中」。其餘標的兩欄為空字串。
**判定是真的**:資料日落在 [起, 迄] 內即停轉,YYYYMMDD 字串直接比大小。

**接真的怎麼做**:接 `cb_basic`(轉換日期起迄)。

**不需要就怎麼移除**:移除 `enrich()` 中 `stopNow` 計算與 `FILTERS.open`
(「開放轉換」篩選)。

## 8. 除權息 / 借券餘額

**假到什麼程度**:`exDiv` 只有約 30% 標的有(隨機日期);`borrow.borrowBal` 隨機 0–12000。
兩者都只在明細與「借券容易」篩選出現。

**接真的怎麼做**:接 `exdiv` 與 `borrow` 兩張表。這兩張在原設計裡是
「全市場當期一次撈、以現股代號查、再掛回 CB」,不是逐檔查。

**不需要就怎麼移除**:移除 `FILTERS.borrowE`、明細中除權息/借券欄位,
`enrich()` 的 `exDiv`/`borrow` 兩行可留(值為 null 不影響)。

## 9. 發行辦法連結 / ISIN

**假到什麼程度**:`derived.prospectus` 一律
`https://docs.example.com/prospectus/<代號>.pdf`(不存在);
`cbBasic.isin` = `DEMO<代號>00`(格式不符真實 ISIN 規則)。

**接真的怎麼做**:改 `refresh.py` 產生 `prospectus` 的那段,指向你所在市場的
公開說明書查詢網址;ISIN 直接取自 `cb_master`。

**不需要就怎麼移除**:移除 `COLS.prospectus` 與明細的連結。

## 10. 即時報價

**假到什麼程度**:**完全沒接**。前端每輪去打 `VITE_QUOTES_URL || /api/quotes.json`,
在原型裡固定 404 → `quotes=null` → 清單顯示收盤快照值。降級路徑是真的
(不報錯、不閃爍、UI 標示資料時間)。

**接真的怎麼做**:提供一個回 `{asof: <epoch ms>, quotes: {"<現股代號>": <價>}}`
的端點,設 `VITE_QUOTES_URL` 指向它。疊加與重算(距轉換價/乖離)已實作
(`logic.js` 的 `applyLiveQuotes`)。注意原設計刻意**不做即時重排序/重篩選**,
避免列表在盤中跳動。

**不需要就怎麼移除**:移除 `App.jsx` 的 quotes 輪詢 effect(`quotes`/`quoteAsof`/
`quoteLive` 三個 state)與 `applyLiveQuotes` 呼叫,`rows` 直接用 `data.rows`。

## 11. 登入(OIDC)

**假到什麼程度**:**未接**。`web/src/auth/config.js` 現在完全由環境變數驅動,
`VITE_OIDC_AUTHORITY`/`VITE_OIDC_CLIENT_ID` 沒設 → `OIDC_CONFIGURED=false` →
不啟用登入牆,全站以 guest 運作。登入 UI 本身可預覽:網址加 `?gate=preview`。

**接真的怎麼做**:設 `VITE_OIDC_AUTHORITY`(IdP 根網址)、`VITE_OIDC_CLIENT_ID`,
需要擋未登入者再設 `VITE_REQUIRE_LOGIN=true`。後端對應設 `CBW_REQUIRE_AUTH=true`
+ `CBW_OIDC_ISS`/`CBW_OIDC_AUD`/`CBW_OIDC_JWKS_URL`。若 IdP 沒有
`.well-known/openid-configuration`,要在 `auth/oidc.js` 手配 metadata。

**不需要就怎麼移除**:`main.jsx` 拿掉 `<AuthGate>` 包裹,刪 `src/auth/` 整個目錄,
`dataSource.js` 移除 `getAccessToken()` 與 Authorization header,
後端設 `CBW_REQUIRE_AUTH=false`(或拆掉 `app/auth.py` 的 dependency)。

## 12. 關注清單雲端同步

**假到什麼程度**:前端未登入 → `apiFetch` 直接回 null → 只用 localStorage
(多份清單、上限 10、重命名/複製/刪除全部真的會動,只是不跨裝置)。
後端 `watchlist.py` 兩個 adapter 都是**真實作**,只是沒有憑證:
`sheet`(預設,Google Sheet 當 DB)沒設 Sheet id/SA → 回空清單;
`providergroup`(轉發外部自選股 API)沒設 URL → 明確失敗。

**接真的怎麼做**:二選一——
(a) **Sheet 當 DB**(不用架資料庫):建一張 Sheet、開一個服務帳號、把 Sheet 分享給它,
設 `CBW_WATCHLIST_SHEET_ID` + `CBW_GSHEET_SA_JSON`;
(b) **接既有自選股 API**:設 `CBW_WATCHLIST_BACKEND=providergroup` +
`CBW_CUSTOMGROUP_URL`,並依對方合約調整 `watchlist.py` 的請求組裝。
兩者都要先接 #11(要有會員身分才能隔離)。

**不需要就怎麼移除**:前端 `watchlists.js` 只留 `loadLocal`/`saveLocal`,
移除 `fetchRemote`/`pushRemote` 與 `App.jsx` 中的 debounce 推送;後端刪
`watchlist.py` 與 `main.py` 的兩個 `/api/watchlists` 路由。

## 13. 畫線雲端同步

**假到什麼程度**:畫線本身 100% 真的(錨點是「時間 × 價格」資料座標,縮放/平移
永不跑版;undo-redo 80 步;依「現股代號 × 週期」分開儲存)。
**只有雲端那一段沒接**:`VITE_DRAWINGS_API_URL` 空 → 只寫 IndexedDB,
狀態膠囊顯示「已儲存在此裝置」而不是「已同步雲端」。

**接真的怎麼做**:設 `VITE_DRAWINGS_API_URL`,後端設 `CBW_DRAWINGS_SHEET_ID` + SA。
後端 `drawings.py` 是完整實作:一列 = 一組(會員, 標的, 週期),shapes JSON 因單格
5 萬字上限而切成 4 塊(E~H 欄)存,讀取時串回。**保全規則是真的且重要**:
雲端回空而本地有畫線時,以本地為準反向推上雲,絕不讓空雲端清掉使用者的圖。

**不需要就怎麼移除**:`drawingRepository.js` 移除 `fetchCloudShapes`/`pushCloudShapes`
(呼叫端在 `KLinePanel.jsx`),後端刪 `drawings.py` 與兩個 `/api/drawings/*` 路由。

## 14. CBAS 折現率

**假到什麼程度**:**公式是真的且已用券商報價驗證過**(誤差 0.03);假的只有
`CBAS_DEFAULT_DISCOUNT = 3.25` 這個預設參數——折現率是券商的資金成本報價,
不在市場價裡、也**無法從市價反解**(債性區 CB 的市價含到期還本/賣回權/流動性
價值,硬解會得到 -11%~+23% 的發散值)。

**接真的怎麼做**:拿任一檔的券商百元報價,用 `cbasImpliedDiscount()` 反解出當下
折現率,再套用到全表——一個報價點就能校準所有標的。把校準值寫進
`CBAS_DEFAULT_DISCOUNT` 或做成使用者可調輸入。

**不需要就怎麼移除**:移除 `cbas()`/`cbasImpliedDiscount()`/`cbasQualify`、
`COLS.cbasPrem`/`COLS.cbasLev`、明細的 CBAS 區塊與 `STRAT_FILTERS.cbas`。

## 15. 資料日與「更新中斷」橫幅

**假到什麼程度**:邏輯全真——資料日超過 4 天(以資料日當天 16:00 起算)就顯示
更新中斷橫幅。假的是 demo 資料的資料日 = **產生當天**,所以你 clone 下來一週後
會看到那條橫幅。**這是正確行為,不是 bug**。

**接真的怎麼做**:接上 #1 後資料日由來源決定。

**不需要就怎麼移除**:重跑 `make_demo_data.py` 把資料日刷成今天;
或移除 `App.jsx` 的 `staleDays`/`staleEl`。

## 16. 後端資料服務

**假到什麼程度**:程式是真的(FastAPI、排程、fail-loud、JWT、Sheet 儲存),
但 `tables.py` 所有表 id 預設空字串 = 沒有資料源。此時服務起得來、
`/healthz` 會誠實回 `hasData:false`,`missing_tables()` 列出缺哪些。

排程預設 `15:40, 16:30, 17:30, 18:30, 19:30, 20:30, 21:30`(台北)。這組時間的理由
是真的設計考量:收盤價早就定案,但籌碼/法人資料傍晚才陸續發布且上游更新時點
不完全可控,所以收盤後每小時補刷一輪,讓最壞延遲 < 1 小時。

**接真的怎麼做**:見 #1。快照無持久化卷是刻意的(pod 重啟即重刷一輪)。

**不需要就怎麼移除**:如果你的資料源可以直接被前端安全讀取,可以整個刪掉
`data-service/`,前端把 `dataSource.js` 指向你的 API。但個人化功能
(#12、#13)會一起失去伺服器端。

## 17. klinecharts 修補(**真的,必要,別移除**)

**這一項不是假的**。`web/patches/klinecharts+10.0.0.patch` 修的是上游 4 個真實 bug,
`npm install` 的 postinstall 會自動套用:
1. `Canvas.update` 小數高度誤判 → 縮放面板後主圖捲動不重繪(K 棒凍住、只有軸在動)。
2. `_executeListener` 在 rAF pending 時丟棄 callback → 連續 resize 時 canvas bitmap
   卡在舊寬度、被瀏覽器拉伸 → K 棒與座標換算系統性偏移(畫線對不上的根因)。
   修法是把 callback 佇列化,永不丟。
3. 手勢錨點重置 → 修「主圖跳動」。
4. resize 時等比調整 barSpace → 面板縮放時保持可視範圍。

**升級 klinecharts 前必讀**:先確認上游是否已修,否則 patch 會套用失敗或行為回歸。
另外一條經驗:**本機合成觸控事件不可靠**,觸控類 bug 只能用真機真手指逐層追蹤;
canvas bitmap 類 bug 只在有頭瀏覽器重現(deviceScaleFactor 要對齊真實使用者)。

## 18. 部署(Docker / nginx)

**假到什麼程度**:`web/Dockerfile` + `web/nginx.conf` 與 `data-service/Dockerfile`
都可用(前端多階段 build → nginx 靜態服務)。原本的內部 CI/CD、環境變數注入、
密鑰管理與 GitOps 設定已全部移除,沒有替代品。

**接真的怎麼做**:`docker build` 後推到你的 registry,用你自己的編排。
一條踩過的坑值得帶走:**改了密鑰不能只看 image tag 或健康狀態**——外部密鑰
同步器可能沒同步、pod 可能沒重啟,要驗「密鑰的 key 集合 + 端點實際行為」。

**不需要就怎麼移除**:刪兩個 Dockerfile 與 nginx.conf,改用你的部署方式。

---

## 附:資料契約(接真資料時要對齊的形狀)

`raw.json` 的 `raw` 是 15 元組陣列,順序固定(前端 `assertRaw` 會驗):

```
[code, name, stkCode, stk, stkPx, convPx, cbPx, vol,
 newHigh, putDate, putPx, guar, unconv, heat, pattern]
```

- `code`/`name` = CB 代號與名稱;`stkCode`/`stk` = 換股標的代號與名稱
- `stkPx`/`convPx`/`cbPx` 必為 number(現股價 / 轉換價 / CB 收盤)
- `putDate` 為 `YYYY/MM/DD` 字串;`unconv` 為未轉換百分比;`pattern` 為型態名或 null

其餘區塊:`derived`(後端算好的衍生欄,缺欄前端才兜底)、`cbBasic`、`credit`、
`exDiv`、`borrow` 皆為 `{CB代號: {...}}`。完整欄位說明見 `web/DATA_SCHEMA.md`
與 `openspec/specs/*/spec.md` 的「資料來源」段。
