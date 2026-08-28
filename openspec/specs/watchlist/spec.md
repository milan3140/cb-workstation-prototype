# watchlist — 我的關注(自選清單)

## Purpose

跨裝置同步的 CB 自選清單;點列上星號加入/移除,「我的關注」tab 只看自選。

## Requirements

### R1: 星號切換
#### Scenario: 加入/移除
- WHEN 點任一 CB 列的星號
- THEN 立即切換關注狀態(樂觀更新)並持久化;tab 徽章計數同步

### R2: 雲端同步(登入時)
- `GET /api/watchlists` 載入、`PUT /api/watchlists` 整包覆蓋;後端 per-member 隔離。
- 合併規則(與 drawings 同精神):**本地獨有項目併入雲端**,不讓空雲端吞掉本地自選。

### R3: 未登入 fallback
未登入=純本地(localStorage),功能照常;登入後首次載入觸發合併上傳。

## 資料來源(兩個可切換的儲存後端)

`CBW_WATCHLIST_BACKEND` 決定後端側怎麼存(前端合約不變):

| 後端 | 做法 | 需要什麼 | 適合 |
|---|---|---|---|
| `sheet`(預設) | Google Sheet 當 DB,一列一個會員的清單 | Sheet id + 服務帳號金鑰 | 原型、中小用量、不想架 DB |
| `providergroup` | 轉發到外部既有的「自選股」API,直接沿用對方的會員隔離 | 端點 URL(依對方合約調整請求組裝) | 使用者在別的平台已有自選清單、想共用同一份 |

`providergroup` 的關鍵性質:**你不持有任何使用者資料**——直接轉發前端帶來的
access_token,由對方自 JWT 取會員 id。清單以命名前綴(`CBW_CUSTOMGROUP_PREFIX`)
標記歸屬,讀取時只認此前綴,不動使用者在該平台的其他清單。

原型狀態:兩者都是完整實作但沒有憑證 → 前端走 localStorage。
接真步驟見 [PROTOTYPE_TRUTH.md](../../../PROTOTYPE_TRUTH.md) #12。

## 測試注意
驗收「跨裝置同步」與「清單是否乾淨」時,務必確認測試帳號真的能完成 OIDC 登入流程:
拿一個登不進去的帳號測,會把「同步沒生效」誤判成「清單是空的」。

## Out of scope
- 多清單分組、排序自訂、雲端分享
