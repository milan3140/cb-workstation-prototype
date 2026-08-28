/* OIDC 登入設定 — 單一真相源(全部由環境變數驅動)
 *
 * 原型預設:**沒設 = 不啟用登入**。整站以 guest 身分運作,個人化資料(關注清單、
 * 畫線)只存在瀏覽器本機。這是刻意的:原型要能零憑證跑起來。
 *
 * 要接你自己的 IdP(任何標準 OIDC 都行:Auth0 / Keycloak / Entra ID / 自建):
 *   web/.env.local:
 *     VITE_OIDC_AUTHORITY=https://your-idp.example.com     ← IdP 根網址
 *     VITE_OIDC_CLIENT_ID=your-client-id
 *     VITE_OIDC_SERVICE_PATH=/identity                     ← 選填,授權端點前綴
 *     VITE_REQUIRE_LOGIN=true                              ← 開登入牆(擋未登入者)
 *
 * 若 IdP 沒有 .well-known/openid-configuration,需在 oidc.js 手配 metadata。
 */

const env = import.meta.env

export const AUTHORITY = (env.VITE_OIDC_AUTHORITY || '').replace(/\/$/, '')
export const CLIENT_ID = env.VITE_OIDC_CLIENT_ID || ''

// 是否具備啟用登入的最小條件(authority + client_id 都有)
export const OIDC_CONFIGURED = !!(AUTHORITY && CLIENT_ID)

/* 登入牆:只有在 OIDC 設好、且明確要求時才擋人。
   未設定 → 一律 guest 模式,不會出現「登入才能看」的死路。 */
export const REQUIRE_LOGIN = OIDC_CONFIGURED && String(env.VITE_REQUIRE_LOGIN) === 'true'

// 登入牆 UI 預覽(不觸發真 OIDC):網址加 ?gate=preview
export const GATE_PREVIEW = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('gate') === 'preview'

export const IDENTITY_DOMAIN = AUTHORITY
export const IDENTITY_SERVICE = `${AUTHORITY}${env.VITE_OIDC_SERVICE_PATH || ''}`
