# workspace-rwd — 三欄工作區與響應式

## Purpose

桌面上「清單→K線→明細」零切頁工作流;三欄皆可調寬/收合,面板任何縮放都不影響 K 線畫線對位(靠 drawings R5 幾何監看)。設計規格正本=專案文件 `16_桌面版設計規格_三欄工作區_20260824.md`。

## Requirements

### R1: 斷點
| 斷點 | 佈局 |
|---|---|
| ≥1280 | 三欄:左清單 / 中 K 線 / 右明細(常駐全開+區塊 tabs) |
| 840–1279 | 兩欄:左清單 / 中 K 線;明細=抽屜(隱藏抽屜內 K 線) |
| ≤839 | **手機版凍結不動(絕對鐵則)**:列表+全螢幕抽屜,任何桌面改動不得外溢 |

### R2: 左欄兩寬度模型
`l`=收起寬(預設 **352px**=剛好到第三個型態 chip 右緣)、`lExpand`=展開寬(預設 **520px**=五指標滿版)。
#### Scenario: hover 自動展開
- WHEN 滑鼠進入左欄本體(排除右緣 22px GRAB 帶)且 autoExpand 開
- THEN 120ms 後真實縮放到 lExpand(grid-template-columns 過渡動畫);離開 200ms 後收回
#### Scenario: 拖邊界的語義
- WHEN 收起態拖左欄邊界 → 調**收起寬 l**;展開態(hover 後)拖 → 調**展開寬 lExpand**
- AND 邊界 GRAB 帶上 hover 不觸發展開/收合切換(可安穩抓到線)
#### Scenario: autoExpand 開關
- WHEN 使用者關閉自動展開 toggle(篩選左側)
- THEN hover 不再自動縮放(改用手動方式開合)

### R3: 三欄皆可完全收合
拖到 <90px 或收合操作 → 收成 16px rail(垂直線+chevron);點 rail/chevron 展開。中欄收合時 **KLinePanel 保持掛載**(CSS 縮線,不重建圖表不重載畫線),空間讓給右欄(右優先)。

### R4: 內容跟隨面板寬
左欄列=minmax+fr 彈性欄,面板拉寬內容攤開填滿(min 502px 內橫向捲);效能由 React.memo(DataTable)+content-visibility 承擔(383 列 hover 平均 ~15ms)。

### R5: 中欄控制列
膠囊控制列單行不換行:放得下=均分,放不下=橫向捲動;**間距封頂 max-width 690px 置中**(面板再寬群組不再拉散)。桌面膠囊寬度放大(字級/高度不變)。

### R6: 版面持久化
paneW/collapsed/autoExpand 存 localStorage(key `cbw_desktop_layout2`;預設值變更時升版 key 重置舊存值)。

## Out of scope
- 多視窗/分離視窗、拖拽重排欄位順序、佈局雲端同步

## 已知缺口
- 中欄仍不能由使用者一鍵收合(靠拖窄觸發);K 線分割畫面(現股+轉債同屏)在規劃中(changes 待開)
