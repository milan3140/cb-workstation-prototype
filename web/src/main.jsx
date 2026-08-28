import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import AuthGate from './auth/AuthGate.jsx'
import './tokens.css'
import './app.css'

createRoot(document.getElementById('root')).render(
  <AuthGate><App /></AuthGate>
)
