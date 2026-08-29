# ParityDesk — 從零重建指南(架構 · 流程 · knowhow)

這份文件讓你能**從零重建整個系統**,或把它改成自己的產品。內容:架構總覽 → 從零建置的流程順序 → 每一塊的 knowhow 與踩過的坑 → 如何調整 → 部署。

搭配閱讀:
- [README.md](README.md) — 30 秒跑起來、專案結構
- [PROTOTYPE_TRUTH.md](PROTOTYPE_TRUTH.md) — 18 項「哪裡是假的 / 怎麼接真 / 怎麼移除」
- [openspec/](openspec/) — 10 份 capability 規格(每份含 Given-When-Then 驗收情境)
- [data-service/apps-script/README.md](data-service/apps-script/README.md) — 分帳號同步後端部署步驟

---

## 1. 這是什麼

可轉債(CB)看盤工作站的**可運作原型**:清單 → K 線畫線 → 明細 三欄工作流,加上**分帳號雲端同步**(每個使用者用自建 email+密碼帳號登入,畫線/關注各存各的)。定位為「這類市場資料工作站」的教學/起手範本 —— 換資料源與訊號定義就能變成股票/期貨/加密貨幣的看盤站。

- **展示站(免安裝直接看)**:https://milan3140.github.io/parity-desk/
- **本機開發**:見 README「30 秒跑起來」

---

## 2. 架構總覽

```
┌─────────────────────────── 瀏覽器(前端 SPA) ───────────────────────────┐
│ React + Vite + klinecharts(patched)                                      │
│  · 市場資料:讀 web/public/*.json(合成 demo)或後端 /api/*(接真資料時)   │
│  · 身分:自建帳號 email+密碼(authClient.js)→ 後端簽發 HMAC token         │
│  · 分帳號同步:sheetSync.js 帶 token 打 Apps Script                        │
└──────────────┬───────────────────────────────────┬───────────────────────┘
      畫線/關注 │ GET 讀 / POST 寫(帶 token)         │ (選配)市場資料 API
               ▼                                    ▼
   ┌──────────────────────────┐         ┌──────────────────────────────┐
   │ Apps Script Web App(/exec)│         │ data-service(FastAPI,選配)  │
   │  · register/login 簽 HMAC token       │  · 拉資料源 → raw.json 快照   │
   │  · 驗 token 取 email、分帳號讀寫        │  · JWT 驗證、排程刷新          │
   │  · 綁 Google Sheet(DB)               │  原型未接(表 id 全空)         │
   └──────────────┬───────────┘         └──────────────────────────────┘
                  ▼
        ┌───────────────────┐
        │ Google Sheet(DB)  │  分頁 drawings / watchlists,列 key = email|...
        └───────────────────┘

部署:前端 = GitHub Pages(公開 repo 只放 build);後端 = Apps Script(綁 Sheet 的擁有者帳號)
```

**為什麼這樣選**(關鍵設計決策):
- **Apps Script 當後端**:Sheet 掛個人 Google 帳號,用 Apps Script 綁它就能讀寫,**免服務帳號金鑰、免租主機、免 GCP 專案**。個人專案最省的 per-account 後端。
- **Google Sheet 當 DB**:一張表就有持久化,不用架資料庫。單格 5 萬字上限 → JSON 切塊存。
- **前端內建合成 demo 資料**:零憑證、零後端就能跑起來;要接真資料只改設定不改前端。
- **分帳號用 email**:自建 email+密碼帳號,後端簽 HMAC token、驗過取 email 當 key。真隔離、且靜態站免第三方 OAuth 審核就能對外開放。

---

## 3. 從零重建的流程順序

**照這個順序做**(每步都能獨立驗證再進下一步,避免一次錯全盤):

1. **前端骨架先跑起來(用假資料)**
   - React+Vite,三欄工作區(清單/K線/明細),klinecharts 畫 K 線。
   - 寫一支 `make_demo_data.py` 產生**合成資料**(固定亂數種子=可重現),放 `web/public/`。
   - 定好**資料契約**(見 `web/DATA_SCHEMA.md`:15-tuple + derived/cbBasic/credit…),前端加 schema 防呆(壞資料 fail-loud 不靜默進 UI)。
   - 里程碑:`npm run dev` 零憑證看到完整站。

2. **設計 token 化 + 主題**
   - 所有顏色/間距/字階集中 `src/tokens.css`,元件只引用 token(禁 magic number)。換膚只改 token。

3. **畫線引擎 + 本地持久化**
   - 自製 canvas overlay(錨點=時間×價格資料座標,縮放/平移永不跑版;rAF 幾何監看)。
   - 先存 IndexedDB(本地、離線保底)。

4. **決定同步架構 → 建 DB**
   - 建一張 Google Sheet 當 DB(掛你要當後端擁有者的 Google 帳號)。

5. **建 Google Sheet(當 DB)+ 寫/部署 Apps Script 後端**(見 apps-script/README)
   - 用要放資料的 Google 帳號建一份空試算表,複製其 ID。
   - `Code.gs`:doGet/doPost;`register`/`login` 簽發 HMAC token,其餘請求驗 token 取 email,email 當 key 讀寫 Sheet(users/drawings/watchlists 三分頁,首呼自動建)。頂端 `SHEET_ID` 填試算表 ID。
   - 部署成 Web App(執行身分=擁有者、任何人可存取、身分靠 token)。拿 `/exec` 網址。
   - 里程碑:`?resource=health` 回 `{"service":"ParityDesk backend"}`、沒帶 token 打資料回 `unauthorized`。

6. **前端接登入 + 同步**(不需要任何 Google OAuth)
   - `authClient.js`:email+密碼 → `POST /exec {action:register|login}` → 後端回 HMAC token,存 localStorage(`cbw_auth`)。
   - `AuthWidget.jsx`:自訂「登入 / 註冊」按鈕 + 彈窗 + 已登入帳號膠囊(人像+email+下拉登出)。
   - `sheetSync.js`:帶 token 打 Apps Script(GET 讀 / POST text-plain 寫,免 CORS preflight)。
   - 畫線/關注 repository:設了 `VITE_SHEET_API_URL` 時走 sheetSync,否則本地。
   - 里程碑:註冊 → 加關注 → Sheet `watchlists` 出現以 email 為 key 的列(往返成功)。

7. **分帳號狀態設計(容易漏,務必做全)**
   - 登出→清空;換帳號→**先清空再載入**(+ loading 遮罩,別讓下一個看到上一個);
     訪客→首登→帶本地清單上雲;點登入取消/關窗→按鈕不卡、可再點;
     畫線隨帳號重載(元件 key 帶 email)。詳見 `openspec/specs/auth/spec.md` 狀態表。

8. **去識別化(若源自既有專案)**
   - 剝除委託方/資料商/講師名、內網 host、表號、憑證;改成環境變數驅動、沒設就明確失敗。
   - 全文掃描確認殘留=0(含 build 產物、index.html title、canvas 浮水印)。

9. **部署前端**
    - `npm run build`(env 值會 baked 進 bundle)→ 靜態站。
    - GitHub Pages(**私有 repo 免費方案不支援 → 另開公開 repo 只放 build 產物**)。

10. **驗證分帳號**:註冊帳號 A 畫線/加關注 → 登出/註冊 B → B 看不到 A 的;Sheet 分頁見 email key 列。

---

## 4. 每一塊的 knowhow / 踩過的坑

- **Node 版本**:build 用 **Node 20**。Node 24 下 vite build 會在 render 階段**靜默硬崩(EXIT 127、無例外)**。repo 有 `.nvmrc`。
- **klinecharts patch**:`web/patches/klinecharts+10.0.0.patch` 修上游 4 個真實 bug(Canvas.update 小數高度誤判、callback 佇列化、手勢錨點、resize barSpace)。`npm install` 的 postinstall 自動套用,**別跳過**;升級 klinecharts 前必讀 patch。
- **觸控/canvas bug 驗證**:本機合成觸控不可靠(會給錯結論);唯一可靠=真機真手指逐層追蹤。
- **為何自建帳號、不用 Google 登入**:靜態站(GitHub Pages)跑 Google OAuth 需先驗證網域、過同意畫面審核,未驗證 app 會被擋(**error 400 origin_mismatch / 未驗證應用程式**——本專案原本走 Google 登入就是卡在這)。改成 email+密碼自建帳號後,任何人開連結即可註冊使用。身分 token 自己簽(HMAC),不依賴第三方。
- **Apps Script CORS**:/exec 只吃「簡單請求」——GET(讀)、POST + `text/plain`(寫)都免 preflight;別用會觸發 preflight 的 header/method。
- **Apps Script 單格 5 萬字上限**:JSON 切成 ≤4 塊存(C~F 欄)。
- **Apps Script 重新部署要保留網址**:改 Code.gs 後走「管理部署作業 → 編輯 → 新版本 → 部署」= 同一個 `/exec` 網址;開「新增部署作業」會給**新網址**(前端 baked 的會失效)。
- **GitHub Pages + 私有 repo**:免費方案不支援 → 開一個**公開 repo 只放 build 產物**當 Pages 來源,原始碼 repo 維持私有。前端 build 用 `base: './'`(相對路徑)才能在子路徑正常載入。
- **自建帳號的密碼/ token 存法**:密碼存 `sha256(密碼|每人隨機 salt)`(不存明文);token=`base64(email|到期).HMAC-SHA256`,HMAC 密鑰放 Script Properties(首呼自動生成、不進原始碼/repo),TTL 30 天存 localStorage。原型級強度:無 email 驗證信/忘記密碼/速率限制——正式產品請換 Auth0/Firebase/Supabase Auth 或補齊這些控制。
- **治理鐵則**(資料源設定):正確值當**預設值**、env 只做臨時覆蓋(別把正確值只放某環境 env,否則其他環境會靜默用錯來源);不可靠來源要有台帳並默認擋掉;必要欄缺 → fail-loud,輔助訊號壞 → 顯性台帳不拖垮站。

---

## 5. 如何調整(改成你的產品)

| 想改 | 改哪裡 |
|---|---|
| 換資料源(接真資料) | `data-service/app/tables.py` 填來源 id,或改 `refresh.py` adapter;前端設 `VITE_DATA_API_URL`。見 PROTOTYPE_TRUTH #1 |
| 換訊號定義 | `web/src/logic.js` 的 `PICK_CHIPS` + 門檻常數 `FIRE/HEAT/FLOOR/DISCOUNT`;後端型態表 id。PROTOTYPE_TRUTH #3 |
| 換配色/主題 | 只改 `web/src/tokens.css` 的值(token 名是契約,元件不動) |
| 換產品名 | `index.html` title、`App.jsx` brand-word、`KLinePanel.jsx` 浮水印 |
| 換登入機制 | 現為自建 email+密碼(`authClient.js` + 後端 register/login)。要換第三方登入 → 改這兩處、後端改驗對應 token |
| 換同步後端 | 改 `sheetSync.js` 端點;或不用 Apps Script,自建 API 對齊契約(GET/POST drawings、watchlists) |
| 關掉同步 | 不設 `VITE_SHEET_API_URL` → 自動退回純本地 |

---

## 6. 部署

- **前端(dev)**:`cd web && npm install && npm run dev`(Node 20)
- **前端(公開站)**:`npm run build` → 把 `web/dist/` 推到公開 repo 的 `gh-pages` 分支 → 開 Pages。更新站台=重 build 再推。
- **後端(Apps Script)**:見 `data-service/apps-script/README.md`。改碼後「管理部署作業→編輯→新版本」保留網址。
- **環境變數**(`web/.env.local`,gitignored):`VITE_SHEET_API_URL`(啟用分帳號同步;其餘見 `.env.example`)。不需要 Google OAuth。

---

## 7. 已知限制 / 安全

- 自建帳號為原型級強度:無 email 驗證信 / 忘記密碼 / 登入速率限制 / 帳號鎖定。正式產品請改用成熟身分服務(Auth0 / Firebase Auth / Supabase Auth)或補齊這些控制。
- Apps Script 後端「任何人可存取」但沒有效 token 就 `unauthorized`;密碼存 salted SHA-256、token 為 HMAC 簽章。
- token TTL 30 天存 localStorage(`cbw_auth`);過期或清掉 → 需重新登入。
- 展示站是公開的(僅編譯後前端 + 合成假資料,無原始碼);若對外公開權利未定,可把公開 repo 設私有/刪除,連結即失效。
