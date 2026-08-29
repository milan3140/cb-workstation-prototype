# 分帳號雲端同步後端(Apps Script + Google Sheet)

畫線與關注清單**分帳號儲存**:每個使用者用 **email + 密碼(自建帳號,不依賴 Google 登入)**
註冊 / 登入,後端簽發 HMAC token,之後每個請求帶 token,後端驗過取出 email 當 key 隔離資料,
互相看不到。後端是一支綁在 Google Sheet 上的 Apps Script Web App —— 免 Google OAuth、
免服務帳號金鑰、免租主機、免 GCP 專案。

> 為什麼不用 Google 登入:GitHub Pages 這種靜態站要跑 Google OAuth 得先驗證網域、過同意畫面審核,
> 未驗證 app 會被擋(error 400 origin_mismatch / 未驗證應用程式)。自建 email+密碼帳號讓任何人開連結就能用。

## 架構

```
瀏覽器(前端)
  └─ email+密碼 註冊/登入 → POST /exec {action:register|login} → 後端回 HMAC token(存 localStorage)
  └─ 畫線/關注同步 → fetch Apps Script /exec(GET 讀、POST 寫,帶 token)
Apps Script Web App(執行身分=Sheet 擁有者)
  └─ users 分頁存 email|salt|sha256(pw|salt);token=base64(email|exp).HMAC(密鑰在 Script Properties)
  └─ 每次請求 verifyToken_ 驗簽+檢查未過期 → 取 email
  └─ 用 email 當 key 讀寫 Sheet(drawings / watchlists 兩個分頁)
Google Sheet(DB)
```

## API(單一 /exec;GET / POST + text/plain 皆免 CORS preflight)

| 方法 | 內容 | 回應 |
|---|---|---|
| POST | `{action:'register', email, password}` | `{token, email}` 或 `{error}` |
| POST | `{action:'login', email, password}` | `{token, email}` 或 `{error}` |
| GET  | `?resource=drawings&sid=&period=&token=` | `{shapes, updatedAt}` |
| GET  | `?resource=watchlists&token=` | `{lists, updatedAt}` |
| POST | `{resource:'drawings', sid, period, shapes, token}` | `{ok:true}` |
| POST | `{resource:'watchlists', lists, token}` | `{ok:true}` |
| GET  | `?resource=health` | `{ok:true, service:'ParityDesk backend'}` |

## 部署步驟

### 1. 建 Google Sheet(當 DB)
1. 用要放資料的 Google 帳號建一份新的 Google 試算表(空的即可,分頁 users/drawings/watchlists 首次呼叫會自動建)。
2. 從網址列複製試算表 ID(`https://docs.google.com/spreadsheets/d/【這段】/edit`)。

### 2. 部署 Apps Script Web App
1. 開 Sheet → 擴充功能 → Apps Script
2. 把本目錄 `Code.gs` 內容貼進去,把頂端 `SHEET_ID` 換成步驟 1 的試算表 ID。
3. 部署 → 新增部署作業 → 類型「網頁應用程式」
   - **執行身分**:我(擁有者)
   - **具存取權者**:**任何人**(前端匿名 fetch;身分靠 token 驗,不是靠這個)
4. 首次部署會要求授權(讓 script 能讀寫 Sheet),同意。
5. 複製「網頁應用程式 URL」(結尾 `/exec`)。
6. token 密鑰(`TOKEN_SECRET`)會在第一次呼叫時自動生成並存進 Script Properties,不寫進原始碼。

> **改碼後更新**:部署 → **管理部署作業 → 編輯(鉛筆)→ 版本下拉「建立新版本」→ 部署**。
> 這樣會保留同一個 `/exec` 網址(前端不用改)。若走「新增部署作業」會拿到新網址,得回頭改前端 env。
> 驗證新碼已上線:`GET /exec?resource=health` 應回 `{"service":"ParityDesk backend"}`。

### 3. 接進前端
`web/.env.local`:
```
VITE_SHEET_API_URL=<步驟 2 的 /exec 網址>
```
設了才啟用同步(顯示「登入 / 註冊」);留空 → 畫線/關注退回本地(不同步)。重啟 `npm run dev`。

## 驗證(分帳號)
1. 註冊帳號 A → 畫幾條線、加幾檔關注 → 重整頁面,線與清單還在(從 Sheet 讀回)。
2. 登出、註冊/登入帳號 B → **看不到 A 的線與清單**(各自獨立)。
3. 打開 Sheet,`users` 分頁見帳號列;`drawings` / `watchlists` 分頁見以 `email|...` 為 key 的列。

## 安全備註(原型層級)
- 密碼存 `sha256(密碼|每人隨機 salt)`,不存明文。token=`base64(email|到期時間).HMAC-SHA256`,密鑰在 Script Properties(不進原始碼、不進 repo),TTL 30 天。
- Web app「任何人」可存取,但沒有有效 token 就回 `unauthorized`,碰不到任何人的資料。
- 這是原型級強度:沒有 email 驗證信 / 忘記密碼流程 / 登入速率限制 / 帳號鎖定。正式產品請改用有這些機制的身分服務(Auth0、Firebase Auth、Supabase Auth 等),或在後端加上上述控制。
