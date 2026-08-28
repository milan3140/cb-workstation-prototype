# CB 工作站原型(Convertible Bond Workstation Prototype)

**可轉債看盤工作站的功能原型** —— 不是空殼模板。clone 下來裝完依賴就能操作全站:
清單篩選、K 線畫線、明細分析全部真的會動,資料由內建的合成 demo 資料集供給
(零憑證、零後端、零外部連線)。

> 這類「市場資料工作站」網站的通用骨架:**清單 → 圖表 → 明細** 三欄工作流 +
> 訊號篩選 + 使用者標註持久化。標的類型換成股票/期貨/加密貨幣也適用,
> 換的是資料源與訊號定義,不是架構。

## 30 秒跑起來

```bash
cd web
npm install          # Node 20(repo 有 .nvmrc;Node 24 會在 build 階段靜默失敗)
npm run dev          # → http://localhost:5173
```

就這樣。沒有要設的環境變數、沒有要起的後端、沒有要申請的金鑰。

demo 資料已經在 `web/public/`。要重新產生(換一組隨機標的、把資料日刷成今天):

```bash
py data-service/scripts/make_demo_data.py     # 或 cd web && npm run demo:data
```

## 原型裡什麼是真的、什麼是假的

**互動、版面、計算公式、資料契約、失敗處理 —— 全是真的。**
**資料本身、訊號歸屬、外部連線(登入/雲端同步/即時報價)—— 是假的或未接。**

逐項對照(哪裡是假的、要接真的怎麼做、不需要就怎麼移除)寫在
**[PROTOTYPE_TRUTH.md](PROTOTYPE_TRUTH.md)** —— 開工前先看這份。

## 功能一覽

| 區塊 | 內容 |
|---|---|
| 清單 | 三個策略頁(精選訊號/全市場/我的關注)、型態 chip、疊加式快速篩選、欄位排序、搜尋 |
| K 線 | 現股/轉債雙軌、60分·日·週·月、MA/BOLL 主圖、兩個可拖高度的副圖(MACD/KDJ/量/RSI) |
| 畫線 | 趨勢線/水平/垂直/矩形/筆刷/文字/橡皮擦、undo-redo 80 步、匯出圖片、穿透式選取模式 |
| 明細 | 關鍵指標、契約條款、信用體檢、籌碼(集保/三大法人)、CBAS 試算 |
| 版面 | 桌面三欄(可拖寬/收合成 rail/hover 自動展開)、平板兩欄+抽屜、手機全螢幕抽屜 |

## 專案結構

```
web/                  前端(React + Vite + klinecharts 10)
  src/tokens.css        設計 token 唯一真相源(黑色系;換膚只改這裡)
  src/logic.js          資料契約 + 策略門檻 + 衍生欄計算 + 欄位目錄
  src/kline/            K 線服務、畫線 overlay、幾何監看、歷史
  patches/              klinecharts 上游 bug 修補(必要,勿刪 → 見 TRUTH #17)
  public/               demo 資料(合成)
data-service/         後端(FastAPI):資料建置、排程、JWT、個人化儲存
  app/tables.py         資料源設定唯一真相源(原型全空 = 未接)
  scripts/make_demo_data.py   合成 demo 資料產生器
openspec/             規格書(現況真相 + 變更提案慣例)
```

## 改成你自己的產品

1. **換資料源** —— 填 `data-service/app/tables.py` 的表 id(或改寫 `refresh.py` 的
   adapter 打你的 API),前端設 `VITE_DATA_API_URL`。詳見 TRUTH #1。
2. **換訊號定義** —— 型態 A~F 只是佔位。改 `web/src/logic.js` 的 `PICK_CHIPS`
   與門檻常數 `FIRE` / `HEAT` / `FLOOR` / `DISCOUNT`。詳見 TRUTH #3。
3. **換配色** —— 只改 `web/src/tokens.css` 的值,元件不動(token 名稱是契約)。
   現行為單色階黑系:顏色只留給語義(漲跌紅綠、熱度暖階)。
4. **換登入** —— 設 `VITE_OIDC_*`(任何標準 OIDC IdP)。不設就是 guest 模式。

## 規格書

`openspec/` 下有 10 份 capability 規格(清單/型態/K線/畫線/關注/明細/版面/認證/
資料刷新/即時報價),每份含 Purpose、Given-When-Then 驗收情境、資料來源契約、
fallback、已知缺口。變更流程慣例見 `openspec/changes/README.md`。

## 技術注意

- **Node 20**:Node 24 下 vite build 會在 render 階段靜默硬崩(EXIT 127、無例外)。
- **patch-package**:`npm install` 的 postinstall 會套用 klinecharts 修補,別跳過。
- **手機版(≤839px)在原設計中是凍結區**:改桌面版時不要讓變更外溢到手機版面。
- 前端不做重算:衍生欄以後端算好的為準,缺欄才用前端算法兜底(避免兩邊公式漂移)。

## 資料與內容聲明

本原型**不含任何真實市場資料、真實公司資訊或第三方專有內容**。所有標的名稱
(示範水泥、示範電子…)、代號(9xxx)、價格、訊號、信評數字皆由
`make_demo_data.py` 以固定亂數種子合成,僅供介面與流程示範,不構成任何投資建議。
