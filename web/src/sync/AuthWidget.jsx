/* 頁首帳號區(自建帳號,不依賴 Google)。
   未登入:「登入 / 註冊」按鈕 → 彈窗(email+密碼,登入/註冊切換)。
   已登入:帳號膠囊(人像 + email)可點 → 下拉(登出)。
   沒設 VITE_SHEET_API_URL 時整個不顯示。 */
import { useState, useEffect, useRef } from 'react'
import { LogOut, UserRound, ChevronDown, X } from 'lucide-react'
import { authEnabled, login, register, logout } from './authClient.js'

export default function AuthWidget({ user }) {
  const [open, setOpen] = useState(false)      // 帳號下拉
  const [modal, setModal] = useState(false)    // 登入/註冊彈窗
  const [mode, setMode] = useState('login')    // 'login' | 'register'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!authEnabled()) return null

  const submit = async e => {
    e?.preventDefault?.()
    if (busy) return
    setErr(''); setBusy(true)
    const r = await (mode === 'register' ? register(email.trim(), pw) : login(email.trim(), pw))
    setBusy(false)
    if (r?.error) { setErr(r.error); return }
    if (r?.token) { setModal(false); setEmail(''); setPw('') }
  }

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
            <button role="menuitem" className="acct-menu-out" onClick={() => { setOpen(false); logout() }}><LogOut size={15} aria-hidden />登出</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <button className="login-btn" onClick={() => { setErr(''); setModal(true) }}>
        <UserRound size={16} aria-hidden />
        <span>登入 / 註冊</span>
      </button>
      {modal && (
        <div className="auth-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setModal(false) }}>
          <form className="auth-modal" onSubmit={submit}>
            <button type="button" className="auth-close" onClick={() => setModal(false)} aria-label="關閉"><X size={18} /></button>
            <h2 className="auth-title">{mode === 'login' ? '登入' : '建立帳號'}</h2>
            <p className="auth-sub">登入後你的畫線與關注清單會存進你的帳號(跨裝置、與他人隔離)。</p>
            <div className="auth-tabs">
              <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr('') }}>登入</button>
              <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr('') }}>註冊</button>
            </div>
            <label className="auth-field"><span>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
            </label>
            <label className="auth-field"><span>密碼{mode === 'register' ? '(至少 6 碼)' : ''}</span>
              <input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••" required minLength={6} />
            </label>
            {err && <div className="auth-err">{err}</div>}
            <button type="submit" className="auth-submit" disabled={busy}>{busy ? '處理中…' : (mode === 'login' ? '登入' : '註冊並登入')}</button>
          </form>
        </div>
      )}
    </>
  )
}
