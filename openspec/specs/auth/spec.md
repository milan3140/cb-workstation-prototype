# auth — 登入與分帳號身分

## Purpose

以**自建帳號(email + 密碼)**取得使用者身分(email),作為畫線 / 關注清單「分帳號」隔離的 key —— 每個人各存各的,互相看不到。不依賴 Google 登入,任何人開連結即可註冊使用。原型內建這條(見 [PROTOTYPE_TRUTH.md](../../../PROTOTYPE_TRUTH.md) #11/#12);另保留一條舊的 OIDC 資料 API 路徑供接自建後端時用。

> **為何不用 Google 登入**:靜態託管站(GitHub Pages 等)跑 Google OAuth 需先驗證網域、過同意畫面審核,未驗證 app 會被擋(error 400 origin_mismatch / 未驗證應用程式)。改自建 email+密碼後,展示站對任何人可直接註冊登入。

## Requirements

### R1: 自建帳號登入 / 註冊(自訂 UI)
前端 `web/src/sync/authClient.js` + `AuthWidget.jsx`:**我們自己的登入按鈕**,點了彈出 email+密碼彈窗(登入 / 註冊分頁切換)。送到後端 `POST /exec {action:'register'|'login', email, password}`,成功回一張 HMAC token,存 localStorage(key `cbw_auth`)。之後每次同步請求帶這張 token。需 `VITE_SHEET_API_URL`。

#### Scenario: 未設定
- WHEN `VITE_SHEET_API_URL` 未設 → 登入區不顯示,畫線/關注退回本地(不同步)

#### Scenario: 已登入顯示
- WHEN 登入 / 註冊成功 → 頁首右側顯示帳號膠囊(人像 icon + email),整顆可點 → 下拉選單「登出」

#### Scenario: 錯誤處理
- WHEN email 格式錯 / 密碼 < 6 碼 / email 已註冊 / 密碼錯 → 彈窗內顯示對應中文錯誤,不關閉,可修正重送

### R2: 後端簽發與驗證(分帳號)
後端(Apps Script,見 `data-service/apps-script/`):`users` 分頁存 `email | salt | sha256(密碼|salt) | createdAt`;token = `base64(email|到期時間) . HMAC-SHA256`,HMAC 密鑰存 Script Properties(首次呼叫自動生成,不進原始碼)。每個資料請求 `verifyToken_` 驗簽 + 檢查未過期,取出 email 當 member key。token 無效或過期 → `unauthorized`,碰不到任何人的資料。

### R3: 所有登入狀態都要正確
| 狀態 | 行為 |
|---|---|
| 未登入(訪客) | 畫線/關注只存本機;顯示「登入 / 註冊」按鈕 |
| 登入成功 | 抓「該帳號」雲端正本、取代目前清單;畫線改讀該帳號雲端(KLinePanel key 帶 email,換帳號自動重載) |
| 訪客→首次登入 | 訪客本地清單若非空且雲端空 → 帶上雲(不遺失);否則用雲端 |
| 換帳號(A→B) | **先清掉 A 的資料**、蓋上 loading,再載入 B 的雲端(不得殘留、也不得先讓 B 看到 A 的清單/畫線) |
| 登出 | 清成全新訪客空清單(不留上一個帳號資料) |
| 點登入但取消 / 關掉彈窗 | 彈窗關閉、按鈕可再次點(不得卡死);送出中 disabled、回應後解除 |

### R4: 舊 OIDC 路徑(選配)
設 `VITE_OIDC_*` 可改走標準 OIDC + 自建資料 API(`CBW_REQUIRE_AUTH` 後端驗 JWT)。與自建帳號登入互斥擇一;原型預設走自建帳號。

## Out of scope
- email 驗證信 / 忘記密碼 / 密碼重設流程
- 登入速率限制、帳號鎖定、多裝置 session 撤銷
- OAuth 第三方登入(Google / Apple 等)

## 已知限制
- 原型級身分強度:密碼有 salt+SHA-256,但無上述 out-of-scope 的防護。正式產品請改用成熟身分服務(Auth0 / Firebase Auth / Supabase Auth)或在後端補齊這些控制。
- token TTL 30 天,存 localStorage;過期或清掉 → 需重新登入。
