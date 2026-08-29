# auth — 登入與分帳號身分

## Purpose

以 Google 登入取得使用者身分(email),作為畫線 / 關注清單「分帳號」隔離的 key —— 每個人各存各的,互相看不到。原型內建這條(見 [PROTOTYPE_TRUTH.md](../../../PROTOTYPE_TRUTH.md) #11/#12);另保留一條舊的 OIDC 資料 API 路徑供接自建後端時用。

## Requirements

### R1: Google 登入(自訂 UI)
用 GIS OAuth2 token client(`web/src/sync/googleAuth.js`):**我們自己的登入按鈕**(非 Google 制式 widget),點了才彈 Google 帳號選擇 → 取 access token → 打 userinfo 取 email。access token 隨每次同步請求送給後端驗證。需 `VITE_GOOGLE_CLIENT_ID`。

#### Scenario: 未設定
- WHEN `VITE_GOOGLE_CLIENT_ID` 未設 → 登入區不顯示,畫線/關注退回本地(不同步)

#### Scenario: 已登入顯示
- WHEN 登入成功 → 頁首右側顯示帳號膠囊(人像 icon + email),整顆可點 → 下拉選單「換帳號 / 登出」

### R2: 後端驗證(分帳號)
後端(Apps Script,見 `data-service/apps-script/`)用 Google tokeninfo 驗證 token(相容 access token / id token),檢查 `aud == VITE_GOOGLE_CLIENT_ID` 與 email_verified,取出 email 當 member key。token 無效 → `unauthorized`,碰不到任何人的資料。

### R3: 所有登入狀態都要正確
| 狀態 | 行為 |
|---|---|
| 未登入(訪客) | 畫線/關注只存本機;顯示登入按鈕 |
| 登入成功 | 抓「該帳號」雲端正本、取代目前清單;畫線改讀該帳號雲端(KLinePanel key 帶 email,換帳號自動重載) |
| 訪客→首次登入 | 訪客本地清單若非空且雲端空 → 帶上雲(不遺失);否則用雲端 |
| 換帳號(A→B) | **清掉 A 的資料**,載入 B 的雲端(不得殘留上一個帳號的清單/畫線) |
| 登出 | 清成全新訪客空清單(不留上一個帳號資料) |
| 點登入但取消 / 關掉彈窗 | 按鈕解除 busy、可再次點(不得卡死);靠 token client 的 error_callback + 安全逾時保證 Promise 必 resolve |

### R4: 舊 OIDC 路徑(選配)
設 `VITE_OIDC_*` 可改走標準 OIDC + 自建資料 API(`CBW_REQUIRE_AUTH` 後端驗 JWT)。與 Google 登入互斥擇一;原型預設走 Google。

## Out of scope
- 自建帳號體系、註冊、密碼管理(交給 Google)
- refresh token 長期輪替(access token 過期時靜默重取一張)

## 已知限制
- OAuth app 測試模式會顯示「未驗證」提示(自建 app 正常);要正式公開需送 Google 驗證或加測試使用者。
- access token 短命(~1hr),不落地儲存;localStorage 只留 email 提示,過期時靜默重取。
