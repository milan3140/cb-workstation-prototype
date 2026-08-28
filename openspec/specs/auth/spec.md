# auth — OIDC 登入與 auth-gate

## Purpose

以標準 OIDC 取得會員身分:一是決定誰能取用資料 API,二是當 watchlist / drawings
的隔離鍵(每個會員只看得到自己的清單與畫線)。

## Requirements

### R1: 登入流程
前端走標準 OIDC(authorization code + PKCE,`oidc-client-ts`),取得 access_token(JWT)。
設定全部由環境變數驅動(`web/src/auth/config.js`):`VITE_OIDC_AUTHORITY`、
`VITE_OIDC_CLIENT_ID`、選填 `VITE_OIDC_SERVICE_PATH`。

#### Scenario: 未設定 OIDC(原型預設)
- WHEN `VITE_OIDC_AUTHORITY` 或 `VITE_OIDC_CLIENT_ID` 任一未設
- THEN `OIDC_CONFIGURED=false`,不啟用登入牆,全站以 guest 運作
- AND 個人化功能退回本地儲存,UI 標示「已儲存在此裝置」(不是靜默失敗)

#### Scenario: 登入牆
- WHEN OIDC 設定完成且 `VITE_REQUIRE_LOGIN=true`
- THEN 未登入者被 `AuthGate` 擋在登入頁
- AND 網址加 `?gate=preview` 可預覽登入牆 UI 而不觸發真實 OIDC 流程

### R2: 後端驗證
`CBW_REQUIRE_AUTH=true` 時,所有 `/api/*` 掛 JWT 驗證(PyJWT + JWKS 快取):
驗 iss(`CBW_OIDC_ISS`)/ aud(`CBW_OIDC_AUD`)/ exp(容差 `CBW_OIDC_LEEWAY`)。
`/healthz` 一律免驗(監控要打得到)。

#### Scenario: 不驗證模式(本機開發)
- WHEN `CBW_REQUIRE_AUTH=false`
- THEN `/api/*` 直接開放,個人化資料掛在 `CBW_DEV_MEMBER_ID` 這個假會員底下
- AND 此模式**僅適合本機**:沒有身分隔離

### R3: guest 與登入的行為差異
| | 未登入(guest) | 已登入 |
|---|---|---|
| 瀏覽清單/K線/明細 | 可(依部署設定) | 可 |
| 關注清單 | localStorage,單裝置 | 後端儲存,跨裝置 |
| 畫線 | IndexedDB,單裝置 | 後端儲存,跨裝置 |

## Out of scope
- 自建帳號體系、註冊流程、密碼管理(交給 IdP)
- refresh token 輪替策略(依所選 IdP 的既有機制)

## 已知缺口
- IdP 若未提供 `.well-known/openid-configuration`,需在 `auth/oidc.js` 手動配置 metadata。
- 原型未內建測試用的取 token 腳本(不同 IdP 的直取流程差異大);
  請用你的 IdP 官方方式取測試 token,勿把憑證寫進 repo 或 CI 設定。
