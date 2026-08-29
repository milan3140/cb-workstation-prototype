# 分帳號雲端同步後端(Apps Script + Google Sheet)

畫線與關注清單**分帳號儲存**:每個使用者用 Google 登入,後端用其 email 當 key 隔離資料,
互相看不到。後端是一支綁在 Google Sheet 上的 Apps Script Web App —— 免服務帳號金鑰、
免租主機、免 GCP 專案。

## 架構

```
瀏覽器(前端)
  └─ Google 登入(GIS)→ 拿 ID token(JWT,含 email)
  └─ 畫線/關注同步 → fetch Apps Script /exec(GET 讀、POST 寫,帶 id_token)
Apps Script Web App(執行身分=Sheet 擁有者)
  └─ 用 Google tokeninfo 端點驗 id_token → 取 email
  └─ 用 email 當 key 讀寫 Sheet(drawings / watchlists 兩個分頁)
Google Sheet(DB)= CB-Workstation-Prototype-DB
```

## 部署步驟

### 1. 建 Google OAuth Client ID(給前端 GIS 用)
1. https://console.cloud.google.com/ → 建/選一個專案(用 Sheet 同一個 Google 帳號)
2. 「API 和服務 → OAuth 同意畫面」→ External、填 app 名稱、儲存(測試模式即可,把要用的帳號加進測試使用者)
3. 「API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID → 網頁應用程式」
   - **已授權的 JavaScript 來源**:`http://localhost:5199`(本機測試)、以及日後部署的網域
4. 複製「用戶端 ID」(`xxxx.apps.googleusercontent.com`)

### 2. 部署 Apps Script Web App
1. 開 Sheet → 擴充功能 → Apps Script
2. 把本目錄 `Code.gs` 內容貼進去
3. 把檔案頂端 `ALLOWED_CLIENT_ID` 填成步驟 1 的用戶端 ID(擋別的 client 拿 token 來用)
4. 部署 → 新增部署作業 → 類型「網頁應用程式」
   - **執行身分**:我(擁有者)
   - **具存取權者**:**任何人**(前端匿名 fetch;身分靠 id_token 驗,不是靠這個)
5. 首次部署會要求授權(讓 script 能讀寫 Sheet + 對外 fetch),同意
6. 複製「網頁應用程式 URL」(結尾 `/exec`)

### 3. 接進前端
`web/.env.local`:
```
VITE_GOOGLE_CLIENT_ID=<步驟 1 的用戶端 ID>
VITE_SHEET_API_URL=<步驟 2 的 /exec 網址>
```
兩個都設好才啟用同步;缺任一 → 畫線/關注退回本地(不同步)。重啟 `npm run dev`。

## 驗證(分帳號)
1. 用帳號 A 登入 → 畫幾條線、加幾檔關注 → 重整頁面,線與清單還在(從 Sheet 讀回)。
2. 登出、用帳號 B 登入 → **看不到 A 的線與清單**(各自獨立)。
3. 打開 Sheet,`drawings` / `watchlists` 分頁可見以 `email|...` 為 key 的列。

## 安全備註(原型層級)
- id_token 每次請求用 Google tokeninfo 驗(aud 必須等於你的 client id、email_verified)。
- Web app「任何人」可存取,但沒有有效 id_token 就回 `unauthorized`,碰不到任何人的資料。
- 這是原型級隔離;正式產品建議改用後端快取 JWKS 本地驗簽(少一次外部往返)、加速率限制。
