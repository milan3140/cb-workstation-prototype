/* 登入牆 + OIDC callback 路由(無 router 的 SPA:用 pathname 分流)
 *
 * REQUIRE_LOGIN=false(現況):完全不介入,site 照常公開。
 * REQUIRE_LOGIN=true(ClientId 核發後 flip):未登入者只看到登入牆;/login /refresh /logout 為 OIDC 回調頁。
 * ?gate=preview:純 UI 預覽(不打 IdP,登入鈕停用)。
 */
import React, { useEffect, useState } from 'react'
import { REQUIRE_LOGIN, GATE_PREVIEW } from './config.js'
import { userManager, login, logoutRedirect, hardResetAuth } from './oidc.js'
import { AuthContext } from './authContext.jsx'

const OIDC_ON = REQUIRE_LOGIN && !GATE_PREVIEW

/* ── 登入牆(品牌玻璃風,沿用 tokens.css) ── */
function GateWall ({ busy, onLogin }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--grad-body)', padding: 24,
    }}>
      <div style={{
        background: 'var(--glass)', border: '1px solid var(--line-strong)', borderRadius: 20,
        padding: '48px 40px', maxWidth: 420, width: '100%', textAlign: 'center',
        backdropFilter: 'blur(14px)', boxShadow: '0 18px 60px rgba(0,0,0,.45)',
      }}>
        <div style={{ fontSize: 13, letterSpacing: '.35em', color: 'var(--gold)', fontWeight: 700 }}>SIGNAL STOCK STUDIO</div>
        <h1 style={{ color: 'var(--ink-hi)', fontSize: 26, margin: '14px 0 6px' }}>CB 工作站原型</h1>
        <p style={{ color: 'var(--ink-mid)', fontSize: 14, lineHeight: 1.8, margin: '0 0 28px' }}>
          本工具為課程使用者專屬。<br />請以 資料來源方 帳號登入後使用。
        </p>
        <button
          onClick={onLogin}
          disabled={busy || GATE_PREVIEW}
          style={{
            width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid var(--gold)',
            background: 'linear-gradient(135deg, var(--gold), var(--gold-deep))',
            color: 'var(--ink-on-gold)', fontSize: 16, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
          }}>
          {GATE_PREVIEW ? '登入(預覽模式停用)' : busy ? '前往登入…' : '使用 資料來源方 帳號登入'}
        </button>
        <p style={{ color: 'var(--ink-low)', fontSize: 12, marginTop: 18 }}>
          資料每日盤後更新 · 教學參考,非投資建議
        </p>
      </div>
    </div>
  )
}

function CenterMsg ({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--grad-body)', color: 'var(--ink-mid)', fontSize: 15 }}>
      {children}
    </div>
  )
}

export default function AuthGate ({ children }) {
  const path = window.location.pathname
  const [state, setState] = useState(OIDC_ON ? 'checking' : 'open')  // checking|open|wall|busy|callback
  const [user, setUser] = useState(null)                              // { nickname } | null

  /* OIDC callback 頁(REQUIRE_LOGIN 開啟後才會有人走到;白名單路徑固定 /login /refresh /logout) */
  useEffect(() => {
    if (!OIDC_ON) return
    const mgr = userManager()

    if (path === '/login') {
      setState('callback')
      mgr.signinRedirectCallback()
        .then(() => window.location.replace('/'))
        .catch(() => hardResetAuth())   // 失敗路徑鐵則:endsession 清乾淨,不 retry
      return
    }
    if (path === '/refresh') { setState('callback'); mgr.signinSilentCallback().catch(() => {}); return }
    if (path === '/logout') {
      setState('callback')
      mgr.signoutRedirectCallback().catch(() => {}).finally(() => window.location.replace('/'))
      return
    }

    let alive = true
    mgr.getUser().then(u => {
      if (!alive) return
      const ok = u && !u.expired
      setUser(ok ? { nickname: u.profile?.nickname || u.profile?.name || '使用者' } : null)
      setState(ok ? 'open' : 'wall')
    }).catch(() => alive && setState('wall'))

    const onExpired = () => mgr.signinSilent().catch(() => hardResetAuth())
    mgr.events.addAccessTokenExpired(onExpired)
    return () => { alive = false; mgr.events.removeAccessTokenExpired(onExpired) }
  }, [path])

  if (GATE_PREVIEW) return <GateWall busy={false} onLogin={() => {}} />
  if (!OIDC_ON) {
    // 公開模式:預設不提供使用者(選單隱藏)。?menu=demo 注入假帳號,純供 lab 視覺驗證(deploy-safe)。
    const demo = new URLSearchParams(window.location.search).get('menu') === 'demo'
    return (
      <AuthContext.Provider value={{ user: demo ? { nickname: '使用者 Demo' } : null, logout: () => {}, switchAccount: () => {} }}>
        {children}
      </AuthContext.Provider>
    )
  }
  if (state === 'checking') return <CenterMsg>載入中…</CenterMsg>
  if (state === 'callback') return <CenterMsg>登入處理中…</CenterMsg>
  if (state === 'wall' || state === 'busy') {
    return <GateWall busy={state === 'busy'} onLogin={() => { setState('busy'); login().catch(() => setState('wall')) }} />
  }
  return (
    <AuthContext.Provider value={{ user, logout: logoutRedirect, switchAccount: login }}>
      {children}
    </AuthContext.Provider>
  )
}
