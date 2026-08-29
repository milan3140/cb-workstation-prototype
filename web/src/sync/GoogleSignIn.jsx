/* 頁首的 Google 登入區:未登入渲染「Sign in with Google」按鈕;
   登入後顯示 email + 登出。這是這個 app 的「分帳號」入口——登入後畫線/關注才會分帳號雲端同步。
   沒設 VITE_GOOGLE_CLIENT_ID(googleEnabled=false)時整個元件不顯示。 */
import { useEffect, useRef, useState } from 'react'
import { googleEnabled, renderButton, currentUser, signOut } from './googleAuth.js'

export default function GoogleSignIn({ user }) {
  const btnRef = useRef(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!googleEnabled() || user) return
    let alive = true
    renderButton(btnRef.current).then(() => alive && setReady(true)).catch(() => {})
    return () => { alive = false }
  }, [user])

  if (!googleEnabled()) return null
  if (user) {
    return (
      <div className="gsi-signed" title={user.email}>
        <span className="gsi-email">{user.email}</span>
        <button className="gsi-out" onClick={signOut}>登出</button>
      </div>
    )
  }
  return <div className="gsi-btn" ref={btnRef} data-ready={ready} />
}
