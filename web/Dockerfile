# ── build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# 先裝依賴(利用 layer cache;package-lock 可能不存在故用 glob + 容錯)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
# 再帶原始碼 build(.dockerignore 已排除 node_modules/dist/.git)
COPY . .
RUN npm run build

# ── runtime stage ────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
