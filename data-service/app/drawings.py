# -*- coding: utf-8 -*-
"""會員 K 線手繪圖形雲端同步 — Google Sheet 儲存(沿用 watchlist sheet 後端的 SA 金鑰)。

畫線是自製 canvas overlay 的 shape 物件(資料座標:timestamp+價格,天生跨裝置),
不是股票清單、塞不進 ProviderGroup,故獨立走 Sheet。tab 自動建立。

Tab「drawings」列格式:
  A=member_id | B=symbol(現股代號) | C=period | D=updated_at(epoch 秒) | E..H=shapes JSON 分塊
JSON 分塊:Sheet 單格上限 5 萬字元,each 塊 40,000 字、最多 4 塊(16 萬字,遠大於 500 shapes 需求);
讀取時把 E..H 非空串回。單列=單(member,symbol,period),整包覆寫(前端持有正本、updated 新者勝)。
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from . import watchlist   # 共用 _load_sa/_access_token(SA 金鑰與 token 快取)

SHEET_ID = (os.environ.get("CBW_DRAWINGS_SHEET_ID", "").strip()
            or os.environ.get("CBW_WATCHLIST_SHEET_ID", "").strip())
TAB = os.environ.get("CBW_DRAWINGS_TAB", "drawings").strip() or "drawings"
_SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
_READ_TTL = float(os.environ.get("CBW_DRAWINGS_READ_TTL", "5"))

MAX_SHAPES = 500
_MAX_POINTS = 4000          # brush 單筆點數上限
_CHUNK = 40000              # 每格 JSON 字元數
_MAX_CHUNKS = 4             # E..H
_ALLOWED_TYPES = frozenset(
    ["line", "hline", "vline", "rect", "filledRect", "circle", "filledCircle", "brush", "text"])
_PERIOD_RE = re.compile(r"^[a-z0-9]{1,12}$")

_lock = threading.Lock()
_keys_cache = {"rows": None, "at": 0}
_tab_ready = False


class DrawingsError(Exception):
    pass


def enabled():
    try:
        return bool(SHEET_ID) and bool(watchlist._SA_JSON or watchlist._SA_FILE)
    except Exception:
        return False


def _sheets(path, data=None, method="GET"):
    req = urllib.request.Request(
        f"{_SHEETS}/{SHEET_ID}{path}",
        data=(json.dumps(data).encode() if data is not None else None),
        method=method,
        headers={"Authorization": "Bearer " + watchlist._access_token(),
                 "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=25).read())


def _ensure_tab():
    """tab 不存在就建(讀 A1 探測;Unable to parse range = 無此 tab)。只成功一次。"""
    global _tab_ready
    if _tab_ready:
        return
    try:
        _sheets(f"/values/{TAB}!A1:A1")
        _tab_ready = True
        return
    except urllib.error.HTTPError as e:
        if e.code != 400:
            raise
    _sheets(":batchUpdate", data={"requests": [{"addSheet": {"properties": {"title": TAB}}}]},
            method="POST")
    _sheets(f"/values/{TAB}!A1:H1?valueInputOption=RAW", method="PUT",
            data={"values": [["member_id", "symbol", "period", "updated_at",
                              "shapes_1", "shapes_2", "shapes_3", "shapes_4"]]})
    _tab_ready = True


def _num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise DrawingsError("座標必須是數字")
    f = float(v)
    if f != f or f in (float("inf"), float("-inf")):
        raise DrawingsError("座標必須是有限數")
    return f


def sanitize_shapes(shapes):
    """白名單淨化前端送來的 shapes;違規丟 DrawingsError。"""
    if not isinstance(shapes, list):
        raise DrawingsError("shapes 必須是陣列")
    if len(shapes) > MAX_SHAPES:
        raise DrawingsError(f"畫線數上限 {MAX_SHAPES}")
    out = []
    for s in shapes:
        if not isinstance(s, dict):
            raise DrawingsError("shape 格式錯誤")
        t = str(s.get("type") or "")
        if t not in _ALLOWED_TYPES:
            raise DrawingsError(f"不支援的圖形類型 {t[:20]}")
        item = {"id": str(s.get("id") or "")[:64], "type": t, "coordType": "data",
                "region": ("volume" if s.get("region") == "volume" else "price"),
                "color": str(s.get("color") or "#F2C94C")[:24],
                "lineWidth": max(1, min(12, int(s.get("lineWidth") or 2)))}
        if t == "brush":
            pts = s.get("points") or []
            if not isinstance(pts, list):
                raise DrawingsError("brush points 必須是陣列")
            item["points"] = [[_num(p[0]), _num(p[1])] for p in pts[:_MAX_POINTS]
                              if isinstance(p, (list, tuple)) and len(p) >= 2]
        else:
            for k in ("x1", "y1", "x2", "y2"):
                item[k] = _num(s.get(k, 0))
        if t == "text":
            item["text"] = str(s.get("text") or "")[:120]
            item["fontSize"] = max(8, min(48, int(s.get("fontSize") or 16)))
        out.append(item)
    return out


def _read_keys(fresh=False):
    """[[member_id, symbol, period], ...](資料區,不含表頭);短 TTL 快取。"""
    now = time.time()
    if not fresh and _keys_cache["rows"] is not None and now - _keys_cache["at"] < _READ_TTL:
        return _keys_cache["rows"]
    got = _sheets(f"/values/{TAB}!A2:C?majorDimension=ROWS")
    rows = got.get("values", []) or []
    _keys_cache["rows"] = rows
    _keys_cache["at"] = now
    return rows


def _find_row(member_id, symbol, period, rows):
    for i, r in enumerate(rows):
        if len(r) >= 3 and str(r[0]) == member_id and str(r[1]) == symbol and str(r[2]) == period:
            return i
    return None


def validate_key(symbol, period):
    if not re.match(r"^[0-9A-Za-z]{1,10}$", str(symbol)):
        raise DrawingsError("bad symbol")
    if not _PERIOD_RE.match(str(period)):
        raise DrawingsError("bad period")


def get_doc(member_id, symbol, period):
    """回 {"shapes": [...], "updatedAt": int|None};沒存過=空。"""
    validate_key(symbol, period)
    with _lock:
        _ensure_tab()
        rows = _read_keys()
        idx = _find_row(str(member_id), str(symbol), str(period), rows)
        if idx is None:
            return {"shapes": [], "updatedAt": None}
        row_no = idx + 2
        got = _sheets(f"/values/{TAB}!D{row_no}:H{row_no}?majorDimension=ROWS")
        vals = (got.get("values") or [[]])[0]
    updated = int(vals[0]) if vals and str(vals[0]).isdigit() else None
    raw = "".join(str(v) for v in vals[1:1 + _MAX_CHUNKS])
    if not raw:
        return {"shapes": [], "updatedAt": updated}
    try:
        return {"shapes": sanitize_shapes(json.loads(raw)), "updatedAt": updated}
    except DrawingsError:
        raise
    except Exception:
        return {"shapes": [], "updatedAt": updated}   # 壞資料視同空,別把整個功能卡死


def put_doc(member_id, symbol, period, shapes):
    """整包覆寫;回 updated_at(epoch 秒)。"""
    validate_key(symbol, period)
    clean = sanitize_shapes(shapes)
    payload = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
    if len(payload) > _CHUNK * _MAX_CHUNKS:
        raise DrawingsError("畫線資料過大")
    chunks = [payload[i:i + _CHUNK] for i in range(0, len(payload), _CHUNK)] or [""]
    chunks += [""] * (_MAX_CHUNKS - len(chunks))
    updated = int(time.time())
    row = [str(member_id), str(symbol), str(period), str(updated)] + chunks
    with _lock:
        _ensure_tab()
        rows = _read_keys(fresh=True)
        idx = _find_row(str(member_id), str(symbol), str(period), rows)
        if idx is None:
            _sheets(f"/values/{TAB}!A2:H2:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
                    data={"values": [row]}, method="POST")
        else:
            row_no = idx + 2
            _sheets(f"/values/{TAB}!A{row_no}:H{row_no}?valueInputOption=RAW",
                    data={"values": [row]}, method="PUT")
        _keys_cache["rows"] = None
    return updated
