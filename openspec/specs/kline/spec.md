# kline — K 線圖(現股/轉債雙軌)

## Purpose

一張圖看訊號來源(現股)與下單標的(CB 自身)的價格行為;支援週期切換、主圖/副圖指標、與畫線工具共存(見 drawings)。

## Requirements

### R1: 雙軌切換
`[現股|轉債]` seg toggle。現股=訊號來源(型態/熱度都讀現股);轉債=CB 自身 K 線(有資料才可切,`loadCbKLineDocument` 探測)。
#### Scenario: 各軌記住週期
- WHEN 使用者在現股看 60分K,切到轉債再切回
- THEN 現股恢復 60分K(`trackPeriodRef` 各軌記憶,不再一律跳走)

### R2: 週期
現股:**60分/日/週/月**(`PERIODS`);日/週/月必備(缺=fail-loud),60分選配(冷門標的可缺,缺了不拖垮其他週期)。轉債:日(資料集 深度僅 20 根)/週(~106)/月(~26)。

### R3: 指標
主圖:MA(5/20/60)或 BOLL 互斥二選一。副圖 ×2(預設 MACD+KDJ),各自可切 MACD/KDJ/量/RSI/無;副圖預設高 30px(K 棒區最大化),把手可拖。自製 HTML legend(每數字帶底色、留 pane 頂原位),關閉 klinecharts 內建 tooltip。

### R4: 副圖高度把手
兩條自製把手(主圖↔副圖區、副1↔副2),觸控 hit 區加大;**縮放偏權判定**:按在把手上時水平位移要壓倒垂直(2 倍+6px)才當平移,否則視為縮放。
#### Scenario: 選取模式可拖、畫線工具停用
- WHEN 選取模式(穿透式看盤)啟用
- THEN 把手照常可拖
- WHEN 趨勢線/筆刷/文字等畫線工具啟用
- THEN 把手 pointer-events 停用(避免分隔線附近下筆被吃)

### R5: 手勢與縮放
滾輪=查看明細(頁面捲動);Ctrl/Cmd+滾輪=圖表縮放;拖曳=平移。手機捏合=等比縮放 X。

## 資料來源

| 資料 | 端點 | 上游 |
|---|---|---|
| 現股 60分/日/週/月 | `GET /api/kline/{現股代號}.json` | 即時資料端點 MinuteInterval(60分)+ 自有表 `kline_day`/518/519(日/週/月) |
| 轉債 日/週/月 | `GET /api/cb_kline/{CB代號}.json` | 資料集原始報表 `cb_kline_day`/`cb_kline_week`/`cb_kline_month`(**只帶 AssignID**,多帶 token 會靜默退回全市場當日模式) |

## 已知缺口(klinecharts 10 patch,`patches/klinecharts+10.0.0.patch`)

上游 bug 以 patch-package 修補,**升版 klinecharts 前必讀**:
1. **Canvas.update 小數高度誤判**:縮放 pane 後主圖捲動不重繪 → 加容差+bitmapStale 自癒判定。
2. **`_executeListener` rAF pending 時丟 callback**(座標系分裂根因):連續 resize 時 bitmap-sync callback 被丟 → canvas bitmap 卡舊寬、瀏覽器拉伸 → K 棒與 convertToPixel 系統性偏移。修法=callback 佇列化(`_pendingFns`)永不丟。
3. 手勢錨點重置(touchStart/mouseDown 歸零 + `_processMainScrollingEvent` rebase):修「主圖跳動」。
4. resize 等比 barSpace:面板縮放時 `setBarSpace(bs × 新寬/舊寬)` 保持可視範圍,不改 visible range。

驗證鐵則:**本機合成觸控不可靠**(曾給出錯誤結論);觸控類 bug 唯一可靠=真機真手指逐層 CDP 追蹤;canvas bitmap bug 只在 headed Chrome 重現(deviceScaleFactor 對齊使用者=1.25)。

## Out of scope
- 逐筆/分時明細圖、多商品疊圖、自訂指標公式
