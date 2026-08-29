/* 頁首帳號區(我們自己的 UI)。
   未登入:玻璃「使用 Google 登入」按鈕。
   已登入:整顆膠囊可點 → 下拉選單(換帳號 / 登出)。人像 icon + email。
   沒設 VITE_GOOGLE_CLIENT_ID 時整個不顯示。 */
import { useState, useEffect, useRef } from 'react'
import { LogOut, UserRound, ChevronDown, RefreshCw } from 'lucide-react'
import { googleEnabled, signIn, signOut } from './googleAuth.js'

export default function GoogleSignIn({ user }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!googleEnabled()) return null

  if (user) {
    return (
      <div className="acct-wrap" ref={wrapRef}>
        <button className="acct" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={user.email}>
          <span className="acct-badge" aria-hidden><UserRound size={15} /></span>
          <span className="acct-email">{user.email}</span>
          <ChevronDown size={14} className="acct-caret" aria-hidden />
        </button>
        {open && (
          <div className="acct-menu" role="menu">
            <div className="acct-menu-head"><span className="acct-badge sm" aria-hidden><UserRound size={13} /></span><span>{user.email}</span></div>
            <button role="menuitem" onClick={() => { setOpen(false); signIn(false) }}><RefreshCw size={15} aria-hidden />換帳號</button>
            <button role="menuitem" className="acct-menu-out" onClick={() => { setOpen(false); signOut() }}><LogOut size={15} aria-hidden />登出</button>
          </div>
        )}
      </div>
    )
  }

  const doLogin = async () => {
    if (busy) return
    setBusy(true)
    try { await signIn(false) } finally { setBusy(false) }
  }
  return (
    <button className="login-btn" onClick={doLogin} disabled={busy}>
      <svg className="login-g" viewBox="0 0 18 18" width="16" height="16" aria-hidden>
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
        <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1z"/>
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
      </svg>
      <span>{busy ? '登入中…' : '使用 Google 登入'}</span>
    </button>
  )
}
