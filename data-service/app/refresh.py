# -*- coding: utf-8 -*-
"""CB 工作站 盤後資料建置(源自 webapp/build_raw.py,移植為服務內排程用):
base=cb_master(CB主檔) + cb_close(CB收盤) + heat 逐股(熱度+現股收盤) + stock_names
+ vol_flag(發債放量集) + patterns(型態訊號) + trend60(走勢) + kline 日/週/月。
衍生欄(derived,一律後端算):convVal/dev/putRet/statusWord/yrsToPut
  + 全補(對齊市場通用術語):parity 百元平價、prem 溢折價、nature 性質、
    putYtm 賣回殖利率、ytm 到期殖利率、prospectus 發行辦法 PDF(自有表 `cb_master` UDField)。
輸出 DATA_DIR/{raw.json, history.json, kline/*.json, meta.json}(原子寫)。

設計約束:
- 表號一律取自 tables.load_tables()——換表(自有表化)零程式碼變更。
- 無模組層副作用:token 在 run_refresh() 內取,失敗 raise、由呼叫端保留舊資料。
- fail-loud:關鍵欄非空率/覆蓋率異常直接炸,不讓壞資料流到前端。
"""
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import tables as tables_mod


def _required_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"缺少必要環境變數 {name};正式資料建置禁止使用硬編碼憑證")
    return value


def _request_json(request, timeout=30, retries=4):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == retries - 1:
                raise
            time.sleep((2 ** attempt) + secrets.randbelow(1000) / 1000)   # 退避抖動用密碼學安全隨機源


# ══════════════════════════════════════════════════════════════════
#  資料源 adapter —— 這一段(到 _dataset_get 為止)是**唯一**需要為你自己的
#  資料源改寫的地方。其餘 800 行都是與來源無關的正規化 / 衍生欄 / 組裝邏輯。
#
#  端點與認證方式一律走環境變數,沒設就明確失敗(不對著假網址打)。
# ══════════════════════════════════════════════════════════════════
資料集_API_URL = os.environ.get("PROVIDER_資料集_URL", "").strip()
SIGNAL_API_URL = os.environ.get("PROVIDER_SIGNAL_URL", "").strip()
KCHART_API_URL = os.environ.get("PROVIDER_KCHART_URL", "").strip()
CALC_API_URL = os.environ.get("PROVIDER_CALC_URL", "").strip()
TOKEN_URL = os.environ.get("PROVIDER_TOKEN_URL", "").strip()


def _dataset_token():
    """取得打資料源 API 用的 token。

    三種常見情形,選一種留下、其餘刪掉:
      1. **靜態 token / API key**:設 PROVIDER_API_TOKEN,直接回傳(最單純)。
      2. **client_credentials**:設 PROVIDER_TOKEN_URL + PROVIDER_CLIENT_ID/SECRET。
      3. **帳密登入**:某些內部資料平台只給 password grant。範例保留在下面註解裡,
         真要用時把帳密放環境變數,**永遠不要硬編碼進 repo**。

    原型狀態:什麼都沒設 → 直接 raise,由呼叫端記錄成「資料源未設定」。
    """
    static = os.environ.get("PROVIDER_API_TOKEN", "").strip()
    if static:
        return static
    if TOKEN_URL and os.environ.get("PROVIDER_CLIENT_ID"):
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": _required_env("PROVIDER_CLIENT_ID"),
            "client_secret": _required_env("PROVIDER_CLIENT_SECRET"),
        }).encode()
        request = urllib.request.Request(
            TOKEN_URL, data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        return _request_json(request, timeout=20)["access_token"]
    # 情形 3(帳密登入)範例——依你的平台合約調整欄位名後啟用:
    #   body = urllib.parse.urlencode({
    #       "grant_type": "password", "client_id": _required_env("PROVIDER_CLIENT_ID"),
    #       "account": _required_env("PROVIDER_資料集_ACC"),
    #       "password": _required_env("PROVIDER_資料集_PWD"),
    #   }).encode()
    #   注意:若對方要求先做雜湊再傳(例如 md5(password)),那是**傳輸協定要求**,
    #   不是你的安全雜湊選擇;照做但要在註解寫清楚,免得日後被誤判成弱雜湊。
    raise RuntimeError(
        "資料源認證未設定:請設 PROVIDER_API_TOKEN,或 PROVIDER_TOKEN_URL + "
        "PROVIDER_CLIENT_ID/SECRET。原型模式下前端走 web/public/ 的 demo 靜態資料。")


def _num(x):
    try:
        return float(str(x).replace(",", ""))
    except Exception:
        return None


def _idx(t, *ks):
    for k in ks:                        # 先精確比對(防「賣回日」撞到「距賣回日」)
        for i, c in enumerate(t):
            if c == k:
                return i
    for k in ks:
        for i, c in enumerate(t):
            if k in c:
                return i
    return None


def _require_cols(table_no, label, titles, needed):
    """欄位契約守門:缺欄就 fail loud,錯誤訊息自帶表號與實際欄位。

    為什麼需要:我們用的表有些是別人的(或產線共用帳號的),**擁有者改欄位不會通知我們**。
    `_idx()` 找不到欄位只會回 None → 該欄靜默變空 → 前端顯示「－」,沒人知道壞了。
    治理目標是「沒有一張表會被別人改壞」——知道擁有者不能防止它被改,**偵測到被改才能**。
    """
    missing = [k for k in needed if _idx(titles, k) is None]
    if missing:
        raise RuntimeError(
            f"表 {table_no}({label}) 欄位契約破損:缺 {missing};"
            f"實際欄位={list(titles)[:14]}。多半是該表擁有者改了欄位——"
            f"對照 app/tables.py 換表或修對應欄名,不要讓它靜默變空值。")


def _utc_millis(date_text):
    text = str(date_text).strip()
    date_format = "%Y%m" if len(text) == 6 else "%Y%m%d"
    parsed = dt.datetime.strptime(text, date_format).replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


def _validate_bar(bar):
    required = ("timestamp", "open", "high", "low", "close", "volume")
    if any(bar.get(key) is None for key in required):
        return False
    if min(bar["open"], bar["high"], bar["low"], bar["close"]) <= 0:
        return False
    if bar["high"] < max(bar["open"], bar["close"]):
        return False
    if bar["low"] > min(bar["open"], bar["close"]):
        return False
    return bar["volume"] >= 0


def _atomic_json(path, value, compact=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False,
                  separators=((",", ":") if compact else None))
    os.replace(temp, path)


def _fd(s):
    s = (s or "").strip()
    return (s[:4] + "/" + s[4:6] + "/" + s[6:8]) if len(s) == 8 and s.isdigit() else ""


KLINE_COUNTS = {"kline_day": ("day", 600), "kline_week": ("week", 260), "kline_month": ("month", 120)}

# CB 自身資料的三個 K 線週期(資料集原始報表)。第三欄=要回幾根。
# ★引數形狀是從客戶端組件撈出來的(AppViewer.exe 裡的 paramStr 字面值:AssignID / DTMode /
#   DTModeN / DTRange / DTOrder / MTPeriod / MajorTable / AssignDate),不是猜的。
#   正解 = `AssignID=<code>;DTMode=0;DTRange=<n>;`
#   ⚠ **不可帶 DTOrder** —— 帶了會靜默退回「全市場當日」模式(實測 503 根逐日 → 378 檔當日)。
#   先前以為「日表不吃 DTRange、只能 20 根」是錯的:少的是 DTMode=0。
CB_PARAM = "AssignID={code};DTMode=0;DTRange={n};"
CB_KLINE_PERIODS = (("day", "cb_kline_day", 600), ("week", "cb_kline_week", 300),
                    ("month", "cb_kline_month", 120))

# ⚠ 資料集 查詢管線(CreateQuery→QueryState→GetResultURL)有**結果快取競態**:同一張表用不同
# 引數並行查,會拿到對方的結果——同一個 ParamStr 對某檔回個股時序、對另一檔回全市場。
# K 線/法人表因為缺「日期」欄會自然被擋掉(fail-safe),但**基本資料表兩種形狀都有
# 「轉換日期起」欄**,若不守門就會把別檔的條款當成本檔的(已上線版本的真實缺陷)。
# 守門法:個股時序的第一欄一定是時間鍵;是「代號」就代表拿到多股結果 → 丟棄並重試。
def _is_single_stock(titles):
    return bool(titles) and str(titles[0]).strip() in ("日期", "年月")


def _rows_single(rows, table, code, count, retries=2):
    """取個股時序;拿到多股形狀就重試(快取競態)。回 (titles, data),失敗回 ([], [])。"""
    for _ in range(retries + 1):
        titles, data = rows(table, param_str=CB_PARAM.format(code=code, n=count))
        if _is_single_stock(titles):
            return titles, data
    return [], []


def _cb_bars(titles, data):
    """把 CB 收盤表(日/週/月共用欄位契約)轉成標準 bar 陣列。"""
    date_i = _idx(titles, "日期", "年月")
    cols = {k: _idx(titles, k) for k in ("開盤價", "最高價", "最低價", "收盤價", "成交張數")}
    if date_i is None or any(cols[k] is None for k in ("開盤價", "最高價", "最低價", "收盤價")):
        return []
    bars = {}
    for row in data:
        bar = {"timestamp": _utc_millis(row[date_i]),
               "open": _num(row[cols["開盤價"]]), "high": _num(row[cols["最高價"]]),
               "low": _num(row[cols["最低價"]]), "close": _num(row[cols["收盤價"]]),
               "volume": _num(row[cols["成交張數"]]) or 0}
        if _validate_bar(bar):
            bars[bar["timestamp"]] = bar
    return [v for _, v in sorted(bars.items())]


# RAW 15-tuple 的欄位位置(唯一定義處;衍生計算與前端契約都靠它)
RAW_IDX = {"code": 0, "name": 1, "stkCode": 2, "stk": 3, "stkPx": 4, "convPx": 5, "cbPx": 6,
           "vol": 7, "newHigh": 8, "putDate": 9, "putPx": 10, "guar": 11, "unconv": 12,
           "heat": 13, "pattern": 14}


def _derive(row, data_date):
    """治理 C1~C4:轉換價值 / 股債乖離 / 賣回報酬率 / 距賣回年,後端算一次。

    定義(與說明文件用語一致,前端 tooltip 同一套):
      convVal 轉換價值 = 100 / 轉換價 × 股價   ——這張 CB 現在換成股票值多少元
      dev     股債乖離率 = (CB價 − 轉換價值) / 轉換價值 × 100  ——正=CB 比股票貴
      putRet  賣回報酬率 = (賣回價 − CB價) / CB價 × 100        ——抱到賣回日的報酬
      yrsToPut 距賣回年 = (賣回日 − 資料日) / 365.25,下限 0
    回 None 表示這檔算不出任何一項(缺價/缺條款),前端就自己退回舊算法。
    """
    get = lambda k: row[RAW_IDX[k]]
    stk_px, conv_px, cb_px = _num(get("stkPx")), _num(get("convPx")), _num(get("cbPx"))
    out = {}
    if conv_px and stk_px is not None:
        conv_val = 100 / conv_px * stk_px
        out["convVal"] = round(conv_val, 4)
        if cb_px is not None and conv_val:
            out["dev"] = round((cb_px - conv_val) / conv_val * 100, 4)
    put_px = _num(get("putPx"))
    put_date = str(get("putDate") or "").strip().replace("/", "")
    if put_px and cb_px:
        out["putRet"] = round((put_px - cb_px) / cb_px * 100, 4)
    # C8 白話狀態(架構原則 明確點名要搬後端):判斷順序有意義,先命中先回,與前端逐條對齊。
    # 為什麼搬:同一檔在 App 與 web 上必須講**同一句話**;在前端算就會各自漂移。
    dev, put_ret = out.get("dev"), out.get("putRet")
    heat, pattern = _num(get("heat")), str(get("pattern") or "").strip()
    if dev is not None and dev < -3:
        out["statusWord"], out["statusTone"] = "折價,比股票便宜", "down"
    elif dev is not None and abs(dev) <= 3:
        out["statusWord"], out["statusTone"] = "發動,跟現股連動", "gold"
    elif cb_px is not None and cb_px <= 105 and put_ret is not None and put_ret >= 0:
        out["statusWord"], out["statusTone"] = "保底,等賣回", "down"
    elif dev is not None and dev <= 10 and ((heat is not None and heat >= 4) or pattern):
        out["statusWord"], out["statusTone"] = "進可攻退可守", "warm"
    else:
        out["statusWord"], out["statusTone"] = "先觀望", "dim"
    if len(put_date) == 8 and put_date.isdigit() and len(str(data_date)) == 8:
        d0 = dt.date(int(str(data_date)[:4]), int(str(data_date)[4:6]), int(str(data_date)[6:]))
        d1 = dt.date(int(put_date[:4]), int(put_date[4:6]), int(put_date[6:]))
        out["yrsToPut"] = round(max(0.0, (d1 - d0).days / 365.25), 4)
    # ── 全補(2026-08:對齊市場通用的 CB 篩選欄位;治理鐵律=一律後端算,不在前端算)──
    # 百元平價 / 溢折價 = 課程標準名詞,與轉換價值 / 乖離「同一條公式」(已與市場通用定義核對過),
    # 並列輸出讓前端可用標準名(百元平價=股價/轉換價×100;溢折價=(CB價−百元平價)/百元平價×100)。
    if "convVal" in out:
        out["parity"] = out["convVal"]              # 百元平價
    if "dev" in out:
        out["prem"] = out["dev"]                    # 溢 / 折價
    # 性質:依百元平價分界客觀分類(預設界 90 / 110,可調)——偏債性(價外)/ 股債平衡 / 偏股性(價內)。
    if out.get("parity") is not None:
        p = out["parity"]
        out["nature"] = "偏債性" if p < 90 else ("偏股性" if p > 110 else "股債平衡")
    # 賣回殖利率(年化):抱到賣回日、以賣回價贖回的年化報酬。零息 CB 用複利年化,可為負(偏股性溢價時);
    # 顯示要不要 floor 由前端決定,後端給真值。
    yrs = out.get("yrsToPut")
    if put_px and cb_px and cb_px > 0 and yrs and yrs > 0.05:
        out["putYtm"] = round(((put_px / cb_px) ** (1.0 / yrs) - 1) * 100, 4)
    return out or None


def fetch_cb_details(rows, tables, cb_codes, max_workers=6):
    """逐檔抓 CB 自身資料:K線(日/週/月)、月集保、停轉期間、法人買賣。

    回 (kline_docs, custody, terms, legal, failed_codes)。單檔失敗只記錄不中斷
    ——CB 有下櫃/停牌等正常缺料情形,整體覆蓋率由呼叫端 assert 把關。
    """
    kline_docs, custody, terms, legal, failed = {}, {}, {}, {}, []

    def one(code):
        periods = {}
        for name, key, depth in CB_KLINE_PERIODS:
            table = tables.get(key)
            if not table:
                continue
            titles, data = _rows_single(rows, table, code, depth)
            bars = _cb_bars(titles, data)
            if bars:
                periods[name] = bars
        result = {}
        if periods.get("day") or periods.get("week"):
            latest = max(b["timestamp"] for bars in periods.values() for b in bars)
            result["kline"] = {"schemaVersion": 1, "symbol": code, "isCb": True,
                              "updatedAt": latest, "periods": periods}
        # 月集保庫存異動:聰明錢下車偵測(庫存大減=有人把 CB 轉股或賣掉)
        titles, data = _rows_single(rows, tables["cb_custody"], code, 120)
        ym_i = _idx(titles, "年月")
        if ym_i is not None and data:
            keys = {"custodyLots": "集保庫存(張)", "changeLots": "庫存增減(張)",
                    "issuedLots": "發行張數", "custodyPct": "庫存佔發行張數比例",
                    "holders": "集保股東戶數"}
            idx = {k: _idx(titles, v) for k, v in keys.items()}
            seq = [{"ym": str(r[ym_i]).strip(),
                    **{k: (_num(r[i]) if i is not None else None) for k, i in idx.items()}}
                   for r in data]
            result["custody"] = list(reversed(seq))            # 舊→新
        # 基本資料:轉換日期起迄=停止轉換期間(D6 警示);取最新一筆(第一列)
        titles, data = _rows_single(rows, tables["cb_basic"], code, 12)
        if data:
            row0 = data[0]
            pick = {"convFrom": "轉換日期起", "convTo": "轉換日期迄", "coupon": "票面利率",
                    "listedOn": "掛牌日期", "delistedOn": "下櫃日期", "maturity": "到期日"}
            got = {k: (str(row0[i]).strip() if (i := _idx(titles, v)) is not None else "")
                   for k, v in pick.items()}
            if any(got.values()):
                result["terms"] = got
        # 三大法人買賣這檔 CB(逐日;近 20 筆足夠看有沒有法人在收)
        titles, data = _rows_single(rows, tables["cb_legal"], code, 120)
        d_i = _idx(titles, "日期")
        if d_i is not None and data:
            pick = {"foreign": "外資及陸資淨買", "trust": "投信淨買張數",
                    "dealer": "自營淨買張數", "total": "三大法人買賣超張數"}
            idx = {k: _idx(titles, v) for k, v in pick.items()}
            result["legal"] = [{"date": str(r[d_i]).strip(),
                                **{k: (_num(r[i]) if i is not None else None) for k, i in idx.items()}}
                               for r in data[:20]]
        return code, result

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(one, code): code for code in cb_codes}
        for fu in concurrent.futures.as_completed(futures):
            code = futures[fu]
            try:
                code, res = fu.result()
            except Exception:
                failed.append(code)
                continue
            if "kline" in res:
                kline_docs[code] = res["kline"]
            for bucket, key in ((custody, "custody"), (terms, "terms"), (legal, "legal")):
                if key in res:
                    bucket[code] = res[key]
    return kline_docs, custody, terms, legal, failed


# ── CB 基本資料全欄(`cb_basic`)→ 強贖/賣回/殖利率/重設/停轉/發行溢價率 ──
# 純加法:這批欄位放進 raw.json 的新 key `cbBasic`(以 CB 代號為鍵),
# **完全不動 15-tuple RAW、derived、也不動 fetch_cb_details 既有的 cb_terms**。
# 取數=全市場當期一次撈(ParamStr="" → 78 欄 384 檔),欄位用「欄名找 index」不寫死位置。
# 欄位語意/樣本見 1_Projects/Signal 可轉債/16_可轉債資料源_原始報表全欄位對照與缺口關閉.md。
def _cb_basic_full(rows, table_no):
    """回 {CB代號: {票面利率/殖利率/強贖/賣回/重設/停轉/發行溢價率…}};失敗回 {}(不拖垮既有流程)。"""
    try:
        titles, data = rows(table_no, param_str="")     # 空字串=全市場一列一檔(78 欄)
    except Exception:
        return {}
    if not titles or not data or str(titles[0]).strip() != "代號":
        return {}                                        # 形狀不對(拿到個股時序/空)→ 放棄,不污染
    ix = lambda *names: _idx(titles, *names)
    ci = ix("代號")
    if ci is None:
        return {}

    def _sched(row, groups):
        """把多段(1..n)的 日/價/殖利率 收成非空的 list。"""
        out = []
        for date_col, px_col, ytm_col in groups:
            di, pi, yi = ix(date_col), ix(px_col), ix(ytm_col)
            date = str(row[di]).strip() if di is not None else ""
            if not date:
                continue
            out.append({"date": date,
                        "price": _num(row[pi]) if pi is not None else None,
                        "ytm": _num(row[yi]) if yi is not None else None})
        return out

    out = {}
    for row in data:
        code = str(row[ci]).strip()
        if not code:
            continue

        def s(*names):                                   # 取字串欄(去空白)
            i = ix(*names)
            return str(row[i]).strip() if i is not None else ""

        def n(*names):                                   # 取數值欄
            i = ix(*names)
            return _num(row[i]) if i is not None else None

        out[code] = {
            # 發行條件 / 殖利率
            "coupon": n("票面利率"),
            "matPrice": n("到期價格"),
            "matYtm": n("到期殖利率"),
            "issuePrice": n("發行價格(元)"),
            "issuedAmt": n("實際發行總額(百萬)"),
            "latestBal": n("最新餘額(百萬)"),
            "issueConvPx": n("發行時轉換價格(元)"),
            "issuePremium": n("發行時轉換溢價率"),          # 發行時轉換溢價率
            "guar": s("債券擔保情形"),
            "rating": s("信用評等"),                        # ⚠ 現行台股 CB 多為空(見對照文件)
            "isin": s("國際編碼"),
            # 轉換期間
            "convStart": s("轉換日期起"),
            "convEnd": s("轉換日期迄"),
            # 賣回(holder put / 提前償還)
            "putCond": s("提前償還日"),                     # 文字條件,如「發行滿三年」
            "putSchedule": _sched(row, [
                ("提前償還日1", "提前償還價格1", "提前償還殖利率1"),
                ("提前償還日2", "提前償還價格2", "提前償還殖利率2"),
                ("提前償還日3", "提前償還價格3", "提前償還殖利率3"),
                ("提前償還日4", "提前償還價格4", "提前償還殖利率4")]),
            "putRecent": {"date": s("最近提前償還日"), "price": n("最近提前償還價格"),
                          "ytm": n("最近提前償還殖利率")},   # 最近提前償還殖利率 = 賣回殖利率
            # 強贖(issuer call / 提前贖回 + 強制贖回)
            "callTrigger1": n("贖回啟動比率1"),
            "callDays1": n("連續啟動天數1"),
            "callTrigger2": n("贖回啟動比率2"),
            "callSchedule": _sched(row, [
                ("提前贖回起日1", "提前贖回價格1", "提前贖回殖利率1"),
                ("提前贖回起日2", "提前贖回價格2", "提前贖回殖利率2")]),
            "callRecent": {"start": s("最近提前贖回起日"), "end": s("最近提前贖回迄日"),
                           "price": n("最近提前贖回價格"), "ytm": n("最近提前贖回殖利率")},
            "forceCallDate": s("強制贖回日"),
            # 轉換價重設條款
            "resetLockPeriod": s("重設轉換價格閉鎖期"),
            "resetStaticDate1": s("靜態重設基準日1"),
            "resetStaticDate2": s("靜態重設基準日2"),
            "resetDynamicDate": s("動態重設基準日"),
            "resetPremium": n("重設溢價率(%)"),
            "resetCap": n("重設上限(%)"),
            "resetFormula": s("重設轉換價格公式"),
            # 停止轉換期
            "stopConvStart": s("停止受理轉換登記日期起"),
            "stopConvEnd": s("停止受理轉換登記日期訖"),
            "stopConvReason": s("停止受理轉換事由"),
        }
    return out


# ── 信評 + 季財務比率(per 發行公司)→ raw.json 新 key `credit` ──
# 純加法:兩張 資料集「原始報表」(負編號)全市場一次撈,失敗回 {} 不拖垮既有流程;
# RAW / derived / cbBasic 完全不動。key = **CB 代號**(結果掛回 CB 代號,與 derived / cbBasic 一致)。
# ★內部查詢代號=「發行公司」:一般 CB 發行=標的,用 stkCode;交換債(EB)發行≠標的,
#   用代號前 4 碼(發行公司代號)。信用/償還能力屬發行公司,不是交換標的(見 credit_key)。
#   -1176087 資料來源方 信用評等:信用評分(1佳~9弱)、財務信評(1佳~9弱);ParamStr="" → 全市場一列一股,首欄=股票代號。
#   -1173353 季財務比率完整版:負債/流動/速動/利息保障倍數/Z–Score/財務信評。
#     ⚠ 引數陷阱:要帶 AssignID 才會翻成「全市場當期一列一股」的 136 欄模式(首欄=股票代號);
#       只帶 DTMode=0;DTRange=1;(無 AssignID)會退回「單股逐季」的 135 欄模式(首欄=年季)。
#       AssignID 的**值被忽略**(仍回全市場 ~1832 檔),只用它的有無切模式——實測確認。
#     ⚠ Z–Score 欄名的破折號是 EN DASH(U+2013,非 ASCII '-');且 "Z–Score" 是 "DPZ–Score"
#       的子字串,故不能用 _idx 的子字串退化,改用「以 Z 開頭且含 Score」精確定位。
def _credit(rows, cb):
    """回 {CB代號: {credScore, finRating, debtRatio, quickRatio, interestCover, zScore}};失敗回 {}。"""
    def _int(x):
        try:
            return int(float(str(x).replace(",", "").strip()))
        except Exception:
            return None

    # 1) 信評表(-1176087):股票代號 → {credScore, finRating}
    rating = {}
    try:
        t, d = rows("-1176087", param_str="")
        if t and str(t[0]).strip() == "股票代號":
            ic, ifr = _idx(t, "信用評分"), _idx(t, "財務信評")
            for r in d:
                code = str(r[0]).strip()
                if code:
                    rating[code] = {"credScore": _int(r[ic]) if ic is not None else None,
                                    "finRating": _int(r[ifr]) if ifr is not None else None}
    except Exception:
        pass

    # 2) 季財務比率(-1173353):空 ParamStr → 全市場一列一股(首欄=股票代號,136 欄);股票代號 → {debtRatio,...}
    #    ★勿帶 AssignID/DTMode/DTRange:帶了會鎖成單檔時序(首欄變「年季」),guard 不過 → 全空
    fin = {}
    try:
        t, d = rows("-1173353", param_str="")
        if t and str(t[0]).strip() == "股票代號":
            i_debt = _idx(t, "負債比率(%)")
            i_quick = _idx(t, "速動比率(%)")
            i_int = _idx(t, "利息保障倍數(倍)")
            i_fin = _idx(t, "財務信評")
            i_z = next((i for i, c in enumerate(t) if c.startswith("Z") and "Score" in c), None)
            for r in d:
                code = str(r[0]).strip()
                if not code:
                    continue
                fin[code] = {"debtRatio": _num(r[i_debt]) if i_debt is not None else None,
                             "quickRatio": _num(r[i_quick]) if i_quick is not None else None,
                             "interestCover": _num(r[i_int]) if i_int is not None else None,
                             "zScore": _num(r[i_z]) if i_z is not None else None,
                             "finRating": _int(r[i_fin]) if i_fin is not None else None}
    except Exception:
        pass

    if not rating and not fin:
        return {}

    # 3) 掛回 CB 代號(用現股/標的代號查);財務信評優先取財務比率表,退回信評表
    out = {}
    for code, v in cb.items():
        stk = str(v.get("stkCode") or "").strip()
        if not stk:
            continue
        # 交換公司債(EB):代號前 4 碼=發行公司代號,≠交換標的(如 140202 遠東新發行、換遠百 2903)。
        # 信用/償還能力屬「發行公司」(欠你賣回/償還的人),不是交換標的 → 用發行公司代號查。
        # 一般 CB 發行=標的(代號前綴=標的代號),key 仍為 stkCode,行為不變。
        credit_key = code[:4] if not code.startswith(stk) else stk
        rt, fn = rating.get(credit_key, {}), fin.get(credit_key, {})
        rec = {"credScore": rt.get("credScore"),
               "finRating": fn.get("finRating") if fn.get("finRating") is not None else rt.get("finRating"),
               "debtRatio": fn.get("debtRatio"), "quickRatio": fn.get("quickRatio"),
               "interestCover": fn.get("interestCover"), "zScore": fn.get("zScore")}
        if any(x is not None for x in rec.values()):
            out[code] = rec
    return out


# ── 除權息日(`exdiv` 日股利彙總)→ raw.json 新 key `exDiv` ──
# 純加法:仿 cbBasic/credit 的寫法。全市場當期一次撈(ParamStr="" → 首欄=股票代號),
# 只有近期有除權息事件的個股會回(季節性,多數日子僅數檔),用現股代號查、掛回 CB 代號。
# 資料源無「除權息交易日」欄,取「分派基準日」為除權/除息日代理(≈除權息基準日),另存最後回補日。
# 失敗回 {}(不拖垮既有流程);RAW/derived/cbBasic/credit 完全不動。
def _exdiv(rows, cb, table_no):
    """回 {CB代號: {exRightDate, exDivDate, recordDate, lastCover, reason}};失敗回 {}。"""
    try:
        t, d = rows(table_no, param_str="")
    except Exception:
        return {}
    if not t or str(t[0]).strip() != "股票代號":
        return {}
    i_reason, i_base = _idx(t, "原因"), _idx(t, "分派基準日")
    i_cover = _idx(t, "最後回補日")
    by_stk = {}
    for r in d:
        stk = str(r[0]).strip()
        if not stk:
            continue
        reason = str(r[i_reason]).strip() if i_reason is not None else ""
        base = str(r[i_base]).strip() if i_base is not None else ""
        cover = str(r[i_cover]).strip() if i_cover is not None else ""
        by_stk[stk] = {
            "reason": reason,
            # 分派基準日作為除權/除息日代理(資料源無「除權息交易日」欄)
            "exRightDate": base if "權" in reason else "",
            "exDivDate": base if "息" in reason else "",
            "recordDate": base, "lastCover": cover}
    out = {}
    for code, v in cb.items():
        stk = str(v.get("stkCode") or "").strip()
        if stk and stk in by_stk:
            out[code] = by_stk[stk]
    return out


# ── 融資券借券(`borrow` 日融資券)→ raw.json 新 key `borrow` ──
# 純加法:全市場一次撈(ParamStr="" 或 DTMode=0;DTRange=1; 皆回 1985 檔,首欄=股票代號)。
# 取「借券賣出餘額」「借券可使用額度」當「借券難易度」代理(餘額越高=市場借得到券機會通常越高)。
# 用現股代號查、掛回 CB 代號;失敗回 {}(不拖垮既有流程)。
def _borrow(rows, cb, table_no):
    """回 {CB代號: {borrowBal, borrowAvail}};失敗回 {}。"""
    try:
        # 空 ParamStr → 全市場一列一股(首欄=股票代號);勿帶 DTMode/DTRange(會鎖成大盤彙總單列,首欄=日期)
        t, d = rows(table_no, param_str="")
    except Exception:
        return {}
    if not t or str(t[0]).strip() != "股票代號":
        return {}
    i_bal, i_avail = _idx(t, "借券賣出餘額"), _idx(t, "借券可使用額度")
    by_stk = {}
    for r in d:
        stk = str(r[0]).strip()
        if not stk:
            continue
        by_stk[stk] = {"borrowBal": _num(r[i_bal]) if i_bal is not None else None,
                       "borrowAvail": _num(r[i_avail]) if i_avail is not None else None}
    out = {}
    for code, v in cb.items():
        stk = str(v.get("stkCode") or "").strip()
        if stk and stk in by_stk:
            rec = by_stk[stk]
            if rec.get("borrowBal") is not None or rec.get("borrowAvail") is not None:
                out[code] = rec
    return out


def run_refresh(data_dir):
    """完整抓數+驗證+原子輸出;回傳 meta dict;任何失敗 raise(舊資料不動)。"""
    started = time.time()
    T = tables_mod.load_tables()
    TOK = _dataset_token()

    def rows(no, sid="", param_str=None):
        p = {"action": "GetDtnoData", "DtNo": no,
             "ParamStr": param_str if param_str is not None else (("AssignID=%s;" % sid) if sid else ""),
             "FilterNo": "0"}
        r = urllib.request.Request(
            (資料集_API_URL or _required_env("PROVIDER_資料集_URL")) + "?" + urllib.parse.urlencode(p))
        r.add_header("Authorization", "Bearer " + TOK)
        r.add_header("providerapi-trace-context", '{"appId":6}')
        r.add_header("User-Agent", "okhttp/4.12.0")
        d = _request_json(r, timeout=35)
        return d.get("Title") or [], d.get("Data") or []

    # ── CB 主檔 ──
    t, d = rows(T["cb_master"])
    B = {k: _idx(t, *a) for k, a in {
        "code": ("代號",), "name": ("名稱",), "stkCode": ("標的代號",), "unconv": ("未轉換餘額",),
        "guar": ("是否擔保", "擔保"), "putPx": ("賣回價",), "putDate": ("賣回日",), "convPx": ("轉換價",),
        "matDate": ("到期日",),
    }.items()}
    assert None not in B.values(), f"CB主檔欄位契約異常: {B}"
    # 發行辦法 PDF 連結:自有表 `cb_master` 的 UDField(M108「發行辦法內容」)。可能尚未加欄→None-tolerant。
    _pi = _idx(t, "發行辦法內容", "發行辦法")
    cb = {}
    for r in d:
        code = str(r[B["code"]]).strip()
        cb[code] = {"code": code, "name": str(r[B["name"]]).strip(), "stkCode": str(r[B["stkCode"]]).strip(),
                    "convPx": _num(r[B["convPx"]]), "putPx": _num(r[B["putPx"]]),
                    "putDate": str(r[B["putDate"]]).strip(), "guar": str(r[B["guar"]]).strip(),
                    "unconv": _num(r[B["unconv"]]), "matDate": str(r[B["matDate"]]).strip(),
                    "prospectus": (str(r[_pi]).strip() if _pi is not None else "")}

    # ── CB 收盤 ──
    t2, d2 = rows(T["cb_close"])
    _require_cols(T["cb_close"], "CB 收盤價", t2, ("收盤",))
    ci = _idx(t2, "收盤")
    for r in d2:
        code = str(r[0]).strip()
        if code in cb:
            cb[code]["cbPx"] = _num(r[ci])

    # ── 股票名稱 ──
    t3, d3 = rows(T["stock_names"])
    _require_cols(T["stock_names"], "股票名稱", t3, ("股票名稱",))
    ni = _idx(t3, "股票名稱")
    sname = {str(r[0]).strip(): str(r[ni]).strip() for r in d3}

    # ── 型態訊號(先到先得) ──
    #
    # ★空表要吵(2026-08-07):原本這裡是 `if not dp: continue` + `except: pass`,
    # 兩層都在吞。結果型態A(訊號頻道 id)那張表回 0 欄 0 列已經很久,但設定裡有它、
    # refresh 也照跑,線上永遠不出現型態A而且**沒有任何訊息** —— 「以為有、其實沒有」
    # 比「明確沒做」更糟。
    #
    # 判別式(精確,不會誤報):
    #   有欄位、0 列  = 今天沒有標的命中這個型態  → 正常,不吵
    #   連欄位都沒有  = 這張表壞了/表號錯了        → 記進 patternIssues,meta 看得到
    #
    # 為什麼不直接 raise:型態是輔助訊號,為它讓整份資料建置失敗會把站台一起弄掉。
    # 治理要求的是「不得靜默」,不是「一定要炸」——所以做成 meta 裡的顯性台帳。
    pmap = {}
    pattern_stats, pattern_issues = [], []
    for no, name in T["patterns"]:
        try:
            tp, dp = rows(no)
        except Exception as exc:
            pattern_issues.append(f"{name}({no}): 取數例外 {type(exc).__name__}")
            pattern_stats.append({"name": name, "table": no, "cols": None, "rows": None})
            continue
        pattern_stats.append({"name": name, "table": no, "cols": len(tp or []), "rows": len(dp or [])})
        if not tp:
            pattern_issues.append(f"{name}({no}): 表回 0 欄 —— 表號錯或該表已失效,不是「今天沒命中」")
            continue
        if not dp:
            continue                      # 有欄無列 = 今天沒命中,正常
        pi = _idx(tp, "股票代號", "代號")
        for r in dp:
            pmap.setdefault(str(r[pi]).strip(), name)
    # ── 型態訊號「頻道」(附加資訊 Signal;型態A走這條,不是 資料集表) ──
    # 放在 資料集 patterns 之後,配合 setdefault = **課綱型態優先**,頻道只補沒被佔到的標的。
    for ch, name in T.get("signal_channels", []):
        try:
            req = urllib.request.Request(
                f"{SIGNAL_API_URL or _required_env('PROVIDER_SIGNAL_URL')}/{ch}",
                data=json.dumps({"AppId": 6, "Guid": ""}).encode(),
                headers={"Authorization": "Bearer " + TOK, "providerapi-trace-context": '{"appId":6}',
                         "Content-Type": "application/json", "User-Agent": "okhttp/4.12.0"})
            sig = json.loads(urllib.request.urlopen(req, timeout=30).read())
        except Exception as exc:
            pattern_issues.append(f"{name}(channel {ch}): 取數例外 {type(exc).__name__}")
            pattern_stats.append({"name": name, "channel": ch, "rows": None, "matched": None})
            continue
        # 回傳 [[股票代號, 訊號時間ms, 是否成立], …];只取成立的
        matched = [str(r[0]).strip() for r in sig if len(r) > 2 and str(r[2]).lower() == "true"]
        pattern_stats.append({"name": name, "channel": ch, "rows": len(sig), "matched": len(matched)})
        if not sig:
            pattern_issues.append(f"{name}(channel {ch}): 頻道回空 —— channel 錯或該訊號已停用")
        for code in matched:
            pmap.setdefault(code, name)
    if pattern_issues:
        print("[pattern] ⚠ " + " | ".join(pattern_issues), flush=True)

    # ── 逐股:熱度+現股收盤+資料日;近60日走勢 ──
    stks = sorted({v["stkCode"] for v in cb.values() if v["stkCode"]})
    hmap, cmap, hist, dates = {}, {}, {}, set()
    seen_titles = {}          # 迴圈內的例外會被吞掉,所以把 titles 留到迴圈後才驗契約
    for sid in stks:
        try:
            th, dh = rows(T["heat"], sid)
            if dh:
                seen_titles.setdefault("heat", th)
                hi = _idx(th, "熱度"); pi = _idx(th, "收盤"); di = _idx(th, "日期")
                hmap[sid] = _num(dh[0][hi]); cmap[sid] = _num(dh[0][pi])
                if di is not None and dh[0][di]:
                    dates.add(str(dh[0][di]).strip())
            tk, dk = rows(T["trend60"], sid)
            if dk:
                seen_titles.setdefault("trend60", tk)
                ci_ = _idx(tk, "收盤"); d_i = _idx(tk, "日期")
                seq = [(str(r[d_i]).strip(), _num(r[ci_])) for r in dk[:60]]
                seq = [x for x in reversed(seq) if x[1] is not None]
                if len(seq) >= 10:
                    hist[sid] = {"d0": seq[0][0], "d1": seq[-1][0], "c": [round(v, 2) for _, v in seq]}
        except Exception:
            pass
    # 逐股迴圈的例外被 except 吞掉,契約在這裡驗才會真的炸出來
    if "heat" in seen_titles:
        _require_cols(T["heat"], "熱度+現股收盤", seen_titles["heat"], ("熱度", "收盤", "日期"))
    if "trend60" in seen_titles:
        _require_cols(T["trend60"], "近60日走勢", seen_titles["trend60"], ("收盤", "日期"))
    assert seen_titles, "熱度/走勢兩張表對所有標的都沒回資料——來源異常,不是個別缺料"

    data_date = max(dates) if dates else time.strftime("%Y%m%d")

    # ── K 線(日/週/月,並行) ──
    def fetch_kline_period(sid, dtno_no, count):
        params = f"AssignID={sid};SPMode=0;CaptionMode=0;DTMode=0;DTRange={count};DTOrder=2;"
        titles, data = rows(dtno_no, param_str=params)
        indexes = {name: _idx(titles, name) for name in ["日期", "開盤價", "最高價", "最低價", "收盤價", "成交量", "成交金額(千)"]}
        indexes["日期"] = _idx(titles, "日期", "年月")
        if any(indexes[name] is None for name in ["日期", "開盤價", "最高價", "最低價", "收盤價", "成交量"]):
            raise ValueError(f"K線欄位契約異常 dtno={dtno_no}: {titles}")
        bars = []
        for row in data:
            bar = {"timestamp": _utc_millis(row[indexes["日期"]]),
                   "open": _num(row[indexes["開盤價"]]), "high": _num(row[indexes["最高價"]]),
                   "low": _num(row[indexes["最低價"]]), "close": _num(row[indexes["收盤價"]]),
                   "volume": _num(row[indexes["成交量"]])}
            ti = indexes.get("成交金額(千)")
            turnover = _num(row[ti]) if ti is not None else None
            if turnover is not None:
                bar["turnover"] = turnover * 1000
            if _validate_bar(bar):
                bars.append(bar)
        return [v for _, v in sorted({b["timestamp"]: b for b in bars}.items())]

    # 60分K:走資料源的分時 K 端點(PROVIDER_KCHART_URL)。
    # date=現在ms → 回此刻之前 240 根(≈48 交易日,含當日已收 60分K);冷門標的可能無→回空(週期選配)。
    KCHART_URL = KCHART_API_URL or _required_env("PROVIDER_KCHART_URL")
    def fetch_kline_60min(sid):
        body = json.dumps({"key": str(sid), "interval": 60, "count": 240,
                           "date": int(time.time() * 1000), "guid": str(uuid.uuid4()), "appId": 6}).encode()
        r = urllib.request.Request(KCHART_URL, data=body, method="POST",
            headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json",
                     "providerapi-trace-context": '{"appId":6}'})
        data = _request_json(r, timeout=30)
        if not isinstance(data, list):
            return []
        bars = []
        for row in data:
            bar = {"timestamp": int(row["KT"]), "open": _num(row.get("OP")), "high": _num(row.get("HP")),
                   "low": _num(row.get("LP")), "close": _num(row.get("CP")), "volume": _num(row.get("TQ"))}
            ta = row.get("TA")
            if ta is not None:
                bar["turnover"] = _num(ta)
            if _validate_bar(bar):
                bars.append(bar)
        return [v for _, v in sorted({b["timestamp"]: b for b in bars}.items())]

    def fetch_kline_symbol(sid):
        periods = {name: fetch_kline_period(sid, T[key], count)
                   for key, (name, count) in KLINE_COUNTS.items()}
        if len(periods["day"]) < 20 or len(periods["week"]) < 4 or len(periods["month"]) < 2:
            raise ValueError(f"{sid} K線筆數不足")
        try:
            hour = fetch_kline_60min(sid)
            if len(hour) >= 10:   # 太少不放(圖太空);hour 選配、失敗不擋日週月
                periods["hour"] = hour
        except Exception:
            pass
        latest = max(b["timestamp"] for b in periods["day"])
        return sid, {"schemaVersion": 1, "symbol": sid, "updatedAt": latest, "periods": periods}

    kline_docs, kline_errors = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(fetch_kline_symbol, sid): sid for sid in stks}
        for fu in concurrent.futures.as_completed(futures):
            sid = futures[fu]
            try:
                key, doc = fu.result()
                kline_docs[key] = doc
            except Exception as e:
                kline_errors.append((sid, str(e)[:120]))
    coverage = len(kline_docs) / max(1, len(stks))
    assert coverage >= 0.98, f"K線覆蓋率僅 {coverage:.1%};失敗樣本={kline_errors[:8]}"

    # ── 發債放量集 ──
    tv, dv = rows(T["vol_flag"])
    _require_cols(T["vol_flag"], "發債放量集", tv, ("股價",))
    vi = _idx(tv, "股價")
    volset, px134 = set(), {}
    for r in dv:
        code = str(r[0]).strip()
        volset.add(code)
        if vi is not None:
            px134[code] = _num(r[vi])

    # ── 組 15-tuple RAW ──
    RAW = []
    for code, v in cb.items():
        stk_px = cmap.get(v["stkCode"]) or px134.get(code)
        if stk_px is None or v.get("cbPx") is None or not v["convPx"]:
            continue
        h = hmap.get(v["stkCode"])
        h = round(h, 1) if h is not None else 0
        RAW.append([code, v["name"], v["stkCode"], sname.get(v["stkCode"], v["stkCode"]), stk_px,
                    v["convPx"], v["cbPx"], 1 if code in volset else 0, 0, _fd(v["putDate"]),
                    v["putPx"], v["guar"] or "無", v["unconv"] if v["unconv"] is not None else 100,
                    h, pmap.get(v["stkCode"])])
    RAW.sort(key=lambda x: x[0])
    assert all(len(r) == 15 for r in RAW), "Row 必須是 15-tuple"
    put_rate = sum(1 for r in RAW if r[9] and r[10]) / max(1, len(RAW))
    assert put_rate > 0.5, f"賣回日/賣回價非空率僅 {put_rate:.0%}(疑欄名撞衍生欄)"
    assert len(RAW) > 300, f"僅 {len(RAW)} 檔,疑似來源表異常"

    # ── 真實 CB 成交張數(附加資訊,失敗退回旗標) ──
    try:
        q = urllib.parse.urlencode({"columns": "標的,累計成交量", "keyNamePath": "Commodity,CommKey"})
        url = f"{CALC_API_URL or _required_env('PROVIDER_CALC_URL')}?{q}"
        body = json.dumps({"Json": json.dumps([r[0] for r in RAW]), "Processing": []}).encode()
        r = urllib.request.Request(url, data=body, headers={
            "Authorization": "Bearer " + TOK, "providerapi-trace-context": '{"appId":6}',
            "Content-Type": "application/json", "User-Agent": "okhttp/4.12.0"})
        vout = json.loads(urllib.request.urlopen(r, timeout=30).read())
        vmap = {row[0]: _num(row[1]) for row in vout}
        for row in RAW:
            row[7] = int(vmap.get(row[0]) or 0)
    except Exception:
        pass  # 退回精選集旗標(r[7] 已填)

    # ── 衍生欄後端化(治理 C1~C4;架構原則「能算的放後端」)──
    # 為什麼搬:前後端各算一次 → 公式會漂移 → 說明文件上講的數字跟畫面對不上。
    # 相容策略:**不動既有 15-tuple 契約**,把衍生值放在同一份 JSON 的另一個 key
    # (`derived`,以代號為鍵),舊版前端完全不受影響;新版前端優先用它、缺才自己算。
    derived = {row[0]: d for row in RAW if (d := _derive(row, data_date))}
    # ── 全補 PHASE2:到期(隱含)殖利率 + 發行辦法連結 ──
    # 需要 cb dict 的 matDate / prospectus(不在 15-tuple),故在 _derive 外用代號 merge 進 derived。
    # ytm 到期殖利率:抱到到期、以到期價 100 贖回的年化(台股 CB 幾乎零息→這就是實質到期殖利率;
    # 折價=正、溢價=負,與賣回殖利率 putYtm 同結構但換成到期日)。
    _td = str(data_date)
    for _code, _info in cb.items():
        _d = derived.get(_code)
        if not _d:
            continue
        _cb = _info.get("cbPx")
        _mat = _info.get("matDate", "").replace("/", "")
        if _cb and _cb > 0 and len(_mat) == 8 and _mat.isdigit() and len(_td) == 8:
            _d0 = dt.date(int(_td[:4]), int(_td[4:6]), int(_td[6:]))
            _d1 = dt.date(int(_mat[:4]), int(_mat[4:6]), int(_mat[6:]))
            _ym = (_d1 - _d0).days / 365.25
            if _ym > 0.05:
                _d["ytm"] = round(((100.0 / _cb) ** (1.0 / _ym) - 1) * 100, 4)
        if len(_mat) == 8 and _mat.isdigit():
            _d["matDate"] = _mat                    # 到期日(賣回/CBAS 頁「到期日」欄用;純加法)
        if _info.get("prospectus"):
            _d["prospectus"] = _info["prospectus"]  # 發行辦法官方說明書 PDF(可追溯)

    # ── CB 基本資料全欄(`cb_basic` 全市場一次撈;純加法,失敗不影響既有輸出)──
    # 放進 raw.json 的新 key `cbBasic`(代號→強贖/賣回/殖利率/重設/停轉/發行溢價率…),
    # 不動 RAW/derived。前端未用到時完全無影響;要用時多一個資料面。
    cb_basic_full = _cb_basic_full(rows, T["cb_basic"])
    print(f"[cbBasic] `cb_basic` 全欄 {len(cb_basic_full)} 檔", flush=True)

    # ── 信評 + 財務比率(-1176087 / -1173353;純加法,失敗回 {} 不影響既有輸出)──
    # 放進 raw.json 的新 key `credit`(CB 代號→{credScore, finRating, debtRatio, quickRatio,
    # interestCover, zScore}),供前端「信用狀態」燈綜合判讀。不動 RAW/derived/cbBasic。
    credit = _credit(rows, cb)
    print(f"[credit] 信評+財務比率 {len(credit)} 檔(CB 母體 {len(cb)})", flush=True)

    # ── 除權息日 + 融資券借券(折價頁用;純加法,失敗回 {} 不影響既有輸出)──
    # exDiv(`exdiv`)→ 代號→{exRightDate,exDivDate,recordDate,lastCover,reason}(近期有事件才有)
    # borrow(`borrow`)→ 代號→{borrowBal,borrowAvail}(借券難易度代理)。皆以現股代號查、掛回 CB 代號。
    exdiv = _exdiv(rows, cb, T["exdiv"])
    borrow = _borrow(rows, cb, T["borrow"])
    print(f"[exDiv] 除權息 {len(exdiv)} 檔  [borrow] 融資券借券 {len(borrow)} 檔", flush=True)

    # ── 原子輸出 ──
    data_dir = Path(data_dir)
    _atomic_json(data_dir / "raw.json",
                 {"today": data_date, "raw": RAW, "derived": derived,
                  "cbBasic": cb_basic_full, "credit": credit,
                  "exDiv": exdiv, "borrow": borrow})
    _atomic_json(data_dir / "history.json", hist, compact=True)
    for sid, doc in kline_docs.items():
        _atomic_json(data_dir / "kline" / f"{sid}.json", doc, compact=True)
    _atomic_json(data_dir / "kline" / "index.json", {
        "schemaVersion": 1, "generatedAt": int(time.time() * 1000),
        "symbols": sorted(kline_docs), "failedSymbols": [s for s, _ in kline_errors]}, compact=True)
    assert len(hist) >= len(stks) * 0.8, f"走勢覆蓋僅 {len(hist)}/{len(stks)}"

    # ── CB 自身資料(D3 K線 / D4 集保 / D6 停轉期間 / 法人買賣)──
    # 全部走 資料集「原始報表」(負數表號),不直連內網 SQL、不需要種子檔。
    # ⚠ 這些表只認 AssignID;多帶任何它不認識的引數會**靜默**退回全市場當日模式。
    cb_codes = [r[0] for r in RAW]
    cb_kline, cb_custody, cb_terms, cb_legal, cb_fail = fetch_cb_details(rows, T, cb_codes)
    for code, doc in cb_kline.items():
        _atomic_json(data_dir / "cb_kline" / f"{code}.json", doc, compact=True)
    for name, payload in (("cb_custody.json", cb_custody), ("cb_terms.json", cb_terms),
                          ("cb_legal.json", cb_legal)):
        if payload:
            _atomic_json(data_dir / name, payload, compact=True)
    cb_status = (f"ok: kline={len(cb_kline)} custody={len(cb_custody)} "
                 f"terms={len(cb_terms)} legal={len(cb_legal)} failed={len(cb_fail)}")
    print(f"[cb] {cb_status}", flush=True)
    assert len(cb_kline) >= len(cb_codes) * 0.9, f"CB K線覆蓋僅 {len(cb_kline)}/{len(cb_codes)}"

    meta = {"dataDate": data_date, "rows": len(RAW), "klineSymbols": len(kline_docs),
            "cbExtras": {"status": cb_status, "cbKline": len(cb_kline), "cbCustody": len(cb_custody),
                         "cbTerms": len(cb_terms), "cbLegal": len(cb_legal),
                         "failedCodes": cb_fail[:8]},
            "patterns": {"stats": pattern_stats, "issues": pattern_issues},
            "refreshedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "durationSec": round(time.time() - started, 1),
            # status 不再永遠是 "ok" —— 有型態表壞掉時要在最外層就看得到,
            # 否則得展開 patterns.issues 才知道,等於還是半靜默。
            "status": "ok" if not pattern_issues else f"ok(型態表異常 {len(pattern_issues)} 張)",
            "tables": {k: v for k, v in T.items() if k != "patterns"}}
    _atomic_json(data_dir / "meta.json", meta)
    return meta
