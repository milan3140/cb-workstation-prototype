# -*- coding: utf-8 -*-
"""資料集(表)設定 = 唯一真相源。換資料源只改這裡,其餘程式碼不動。

原型狀態:所有表 id 預設為空字串 = **未接資料源**。前端此時走 `web/public/` 的
demo 靜態檔(見 README「離線 demo 模式」),整站照常可操作;要接真資料時把
對應 id 填進環境變數即可,不需要改任何程式碼。

接你自己的資料源:
  1. 在你的資料平台建好/取得每張表的 id
  2. 設環境變數(部分覆蓋即可,不必整份):
       CBW_TABLES_JSON='{"cb_master":"<id>","cb_close":"<id>"}'
  3. 重啟服務 —— 完成

兩條從實戰換來的設計原則(照抄很值得):

  1. **正確值要當預設值,環境變數只負責臨時覆蓋。**
     反例:預設留著「借來的/暫時的」表 id,正確的只寫在正式環境的 env 裡。
     結果是任何新環境、本地開發、或忘了設 env 的地方都會**靜默退回**用錯的來源,
     而且跑得起來、數字看起來也對、完全看不出差別 —— 治理只在一個環境成立。

  2. **不可靠的來源要有台帳,並且默認擋掉。**
     RETIRED_TABLES 記錄「不該再用」的 id(例如別人維護的私有表:對方一改,
     你的數字會悄悄跟著變)。指到台帳裡的 id 會直接 raise,除非明示
     CBW_ALLOW_RETIRED_TABLES=1 —— 讓「用了不該用的來源」變成響亮的失敗。
"""
import json
import os

# 空字串 = 未設定。啟動時不會爆(前端有 demo 靜態退路),但 refresh 會回報缺哪張。
DEFAULT_TABLES = {
    # ── 總覽快照(raw.json)的來源 ──
    "cb_master": "",     # CB 主檔:條款/賣回/擔保/未轉換/轉換價/換股標的代號
    "cb_close": "",      # CB 收盤價
    "heat": "",          # 熱度訊號 + 現股收盤 + 資料日(逐股)
    "stock_names": "",   # 股票名稱 / 融券資訊
    "vol_flag": "",      # 成交量旗標 + 股價補缺
    # ── 走勢與現股 K 線 ──
    "trend60": "",       # 近 60 日收盤走勢(列上 sparkline)
    "kline_day": "",     # 日 K
    "kline_week": "",    # 週 K
    "kline_month": "",   # 月 K
    # ── 可轉債自身資料 ──
    "cb_kline_day": "",   # CB 日收盤(個股時序)
    "cb_kline_week": "",  # CB 週收盤
    "cb_kline_month": "", # CB 月收盤
    "cb_custody": "",     # 月集保庫存異動(庫存增減/佔發行比/持有人數)
    "cb_legal": "",       # 三大法人買賣明細(逐日)
    "cb_basic": "",       # CB 基本資料(含轉換期間起迄 = 停止轉換判定)
    # ── 明細補充 ──
    "exdiv": "",         # 除權息事件
    "borrow": "",        # 借券賣出餘額 / 可使用額度(借券難易度代理指標)
    # ── 型態訊號來源(每個型態一張表 / 一個訊號頻道;見 openspec/specs/patterns)──
    "pattern_a": "",
    "pattern_b": "",
    "pattern_c": "",
    "pattern_d": "",
    "pattern_e": "",
    "pattern_f": "",
}

# 不該再使用的來源台帳:{表 id: 為什麼退役}。指到這裡會 raise(除非明示允許)。
RETIRED_TABLES = {
    # "<某個 id>": "他人維護的私有表,對方一改我們的數字會跟著變 → 已改用自有表 <新 id>",
}


def load_tables():
    """DEFAULT_TABLES + 環境變數 CBW_TABLES_JSON 部分覆蓋。

    指向 RETIRED_TABLES 的 id 一律擋下(要用得設 CBW_ALLOW_RETIRED_TABLES=1 明示),
    理由見模組 docstring 原則 2:靜默用錯來源比壞掉更難查。
    """
    tables = dict(DEFAULT_TABLES)
    override = os.environ.get("CBW_TABLES_JSON")
    if override:
        tables.update(json.loads(override))
    if os.environ.get("CBW_ALLOW_RETIRED_TABLES") != "1":
        bad = [(k, v, RETIRED_TABLES[v]) for k, v in tables.items()
               if isinstance(v, str) and v in RETIRED_TABLES]
        if bad:
            detail = "; ".join(f"{k}={v}({why})" for k, v, why in bad)
            raise RuntimeError(
                "設定指向已退役的資料來源:" + detail
                + " —— 這不會報錯也不會壞,但來源方一改動,你的數字會悄悄跟著變。"
                " 請改 CBW_TABLES_JSON;確定要用請設 CBW_ALLOW_RETIRED_TABLES=1。")
    return tables


def missing_tables():
    """回報哪些表還沒設定(空字串)。啟動與 /api/meta 用來說實話,不靜默。"""
    return sorted(k for k, v in load_tables().items() if not str(v).strip())
