# data-refresh — 後端資料建置與排程

## Purpose

每日把 資料集表群 + 即時資料端點 signal 建置成 `raw.json` 快照供前端整包吃;刷新時機貼合上游發布節奏,任何資料落地後最壞 1 小時內上站。

## Requirements

### R1: 排程(台北時間)
`CBW_REFRESH_AT` 預設 **15:40, 16:30, 17:30, 18:30, 19:30, 20:30, 21:30**。
理由:收盤價 13:30 定案、三大法人 16:00 起陸續發布且 資料集表更新時點不完全可控;全量刷一次 ~2min/約 1,500 次 資料集 呼叫(共用額度),小時級=最壞延遲 <1h 且成本可忽略。
#### Scenario: 熱度指標補正
- WHEN 15:40 刷新時籌碼分量未發布
- THEN 熱度先為技術分數版;16:30 起每小時補刷,籌碼落地的那一輪即自動補正為完整分數

### R2: 冷啟動
服務啟動且無資料 → 立即刷一輪。快照刻意不做持久化卷(ephemeral by design):
重啟就重建,不會讓舊快照與來源悄悄脫節。

### R3: 手動刷新
`POST /internal/refresh?token=<CBW_REFRESH_TOKEN>`(token 由部署環境注入,勿寫進 repo);
與排程共用互斥鎖,`refreshing` 旗標可觀察。

### R4: 可觀察性
`GET /healthz`(免驗):`ok/hasData/dataDate/refreshedAt/refreshing/lastError/lastErrorAt`。`GET /api/meta`:pattern_stats/patternIssues 台帳。
#### Scenario: fail-loud
- WHEN 必要表缺必要欄位
- THEN `_require_cols` 直接 raise(整輪失敗保留舊快照);型態表例外走 patternIssues 顯性台帳(輔助訊號不拖垮站台)

### R5: 表號治理
DEFAULT_TABLES=唯一真相源(**正確值必須是預設值**,env `CBW_TABLES_JSON` 僅臨時覆蓋);
`RETIRED_TABLES` 記錄不該再用的來源,指到即 raise。理由見 `openspec/project.md` 資料治理鐵則 1、2。
原型狀態:所有 id 預設空字串=未接資料源,`missing_tables()` 會誠實列出缺哪些。

## 端點總覽(供前端)

`/api/raw.json`(總覽快照)、`/api/history.json`(60日走勢)、`/api/kline/{sid}.json`、`/api/cb_kline/{sid}.json`、`/api/cb_custody.json`、`/api/cb_terms.json`、`/api/cb_legal.json`、`/api/watchlists`(GET/PUT)、`/api/drawings/{sid}/{period}`(GET/PUT)。

## 部署與驗收
單一服務自包含,`data-service/Dockerfile` 可直接 build;CI/CD 與密鑰管理由使用者自行接。

一條踩過的坑:**密鑰變更不能只看 image tag 或健康狀態**——外部密鑰同步器可能還沒同步、
pod 可能沒重啟。要驗的是「線上密鑰的 key 集合」+「端點實際行為」。

## Out of scope
- 盤中逐 tick 重算清單指標(見 realtime-quotes 的疊加模式)、歷史快照版本庫
