import { createContext, useContext } from 'react'

/* 登入後的使用者資訊 + 帳號動作(由 AuthGate 提供給 App)
   user: { nickname } | null(未登入/公開模式)
   logout: 登出(清 session → 回登入牆)
   switchAccount: 切換帳號(帶 select_account 重新登入,顯示帳號選單) */
export const AuthContext = createContext({ user: null, logout: () => {}, switchAccount: () => {} })
export const useAuth = () => useContext(AuthContext)
