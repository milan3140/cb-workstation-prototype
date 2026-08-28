/* oidc-client-ts UserManager — 照 KB02 §7 手配(資料來源方 無 .well-known discovery) */
import { UserManager, WebStorageStateStore } from 'oidc-client-ts'
import { CLIENT_ID, IDENTITY_DOMAIN, IDENTITY_SERVICE } from './config.js'

const BASE = typeof window !== 'undefined' ? window.location.origin : ''

let _mgr = null
export function userManager () {
  if (_mgr) return _mgr
  _mgr = new UserManager({
    authority: IDENTITY_DOMAIN,
    client_id: CLIENT_ID,
    redirect_uri: `${BASE}/login`,
    response_type: 'code',                       // Authorization Code + PKCE
    scope: 'openid nickname',
    post_logout_redirect_uri: `${BASE}/logout`,
    silent_redirect_uri: `${BASE}/refresh`,
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 10,
    monitorSession: false,                       // KB:iframe session monitor 在三方 cookie 被擋環境會誤登出+silentRenew loop
    filterProtocolClaims: false,
    loadUserInfo: false,
    metadata: {                                  // 手配;issuer 固定寫死、不分環境(勿改)
      issuer: 'https://provider.example.com',
      authorization_endpoint: `${IDENTITY_SERVICE}/authorize`,
      token_endpoint: `${IDENTITY_SERVICE}/token`,
      end_session_endpoint: `${IDENTITY_SERVICE}/endsession`,
      jwks_uri: `${IDENTITY_SERVICE}/keys/jwks`,
      check_session_iframe: `${IDENTITY_SERVICE}/checksession`,
    },
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  })
  return _mgr
}

/* 資料 API 用:取當前 access_token(給後端OIDC驗證);未登入/過期回 null。
   後端(cb-workstation-data)對 /api/* 驗 Bearer,驗過才吐資料——資料不再烤進前端映像。 */
export async function getAccessToken () {
  try {
    const u = await userManager().getUser()
    return (u && !u.expired && u.access_token) ? u.access_token : null
  } catch { return null }
}

export function login () {
  // 強制帳號選擇:已登入使用者常多帳號,登出再登入不帶 prompt 會自動用舊帳號
  return userManager().signinRedirect({ prompt: 'select_account' })
}

export async function logoutRedirect () {
  try { await userManager().signoutRedirect() }
  catch { window.localStorage.clear(); window.location.assign('/') }
}

/* 失敗路徑鐵則(KB):callback fail / silent renew fail → 一律 endsession 清乾淨重來,不 retry-counter */
export async function hardResetAuth () {
  try { await userManager().signoutRedirect() }
  catch {
    Object.keys(window.localStorage)
      .filter(k => k.startsWith('oidc.'))
      .forEach(k => window.localStorage.removeItem(k))
    window.location.assign('/')
  }
}
