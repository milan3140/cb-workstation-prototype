import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' 讓 build 產物可直接丟 github.io 子路徑(同 prototype 部署模式)
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 8795,
    // 即時報價:dev 代理 /api/quotes.json → 本機 quote_server(py scripts/quote_server.py 8848)
    // 正式站改設 VITE_QUOTES_URL 指向部署的報價服務
    proxy: { '/api': { target: 'http://localhost:8848', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } },
  },
})
