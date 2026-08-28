# -*- coding: utf-8 -*-
"""會員關注清單儲存 — 後端側。兩種儲存後端,以 CBW_WATCHLIST_BACKEND 切換:

  sheet(預設):**Google Sheet 當 DB**。一個服務帳號 + 一張表就有 per-member 持久化,
    不用架資料庫、不用管遷移備份。需 CBW_WATCHLIST_SHEET_ID + SA 金鑰
    (CBW_GSHEET_SA_JSON 或 CBW_GSHEET_SA_FILE)。沒設 → 回空清單,前端自動退回
    localStorage(離線 demo 就是走這條)。適合原型與中小用量。

  providergroup:**轉發到外部既有的「自選股」API**(adapter 範例)。適用情境:你的
    使用者在某個平台已經有自選股清單,你想共用同一份而不是另開一套。每份清單 =
    一個 DocName 以 PG_PREFIX 開頭的群組;讀取只認此前綴,無視使用者其他清單;
    代碼存進群組 ItemList(以 ; 串接)。認證 = 直接轉發前端帶來的 access_token,
    對方自 JWT 取會員 id → 天然 per-member 隔離,你不持有任何使用者資料。
    需 CBW_CUSTOMGROUP_URL 指向你的端點,並依對方合約調整本檔的請求組裝。

get_lists/put_lists 對外合約不變(回 [{"id","name","codes"}]);main.py 傳入會員 id 與 bearer。
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request

import jwt

BACKEND = os.environ.get("CBW_WATCHLIST_BACKEND", "sheet").strip().lower()
MAX_LISTS = int(os.environ.get("CBW_WATCHLIST_MAX", "10"))

# ── providergroup adapter(轉發到外部自選股 API)──
# 預設留空:沒設 URL 卻選了這個後端 → 明確失敗,不對著假網址打(靜默壞掉最難查)。
PG_URL = os.environ.get("CBW_CUSTOMGROUP_URL", "").strip()
PG_PREFIX = os.environ.get("CBW_CUSTOMGROUP_PREFIX", "CBW-")   # CB 專屬群組命名前綴;讀取只認此前綴
PG_DOCTYPE = os.environ.get("CBW_CUSTOMGROUP_DOCTYPE", "stock")
_PG_MAX_NAME = 40   # DocName(含前綴)長度上限

# ── Sheet(舊版回退)後端 ──────────────────────────────────────────
SHEET_ID = os.environ.get("CBW_WATCHLIST_SHEET_ID", "").strip()
_SA_JSON = os.environ.get("CBW_GSHEET_SA_JSON", "").strip()
_SA_FILE = os.environ.get("CBW_GSHEET_SA_FILE", "").strip()
_SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
_READ_TTL = float(os.environ.get("CBW_WATCHLIST_READ_TTL", "5"))   # 全表讀取快取秒數

_lock = threading.Lock()
_sa = None            # 解析後的 SA 金鑰 dict
_tok = {"v": None, "exp": 0}
_cache = {"rows": None, "at": 0}


class WatchlistError(Exception):
    pass


def enabled():
    if BACKEND == "providergroup":
        return True   # 認證即會員身分,無須額外設定
    return bool(SHEET_ID and (_SA_JSON or _SA_FILE))


def _sanitize(lists):
    """驗證+正規化前端送來的 lists;違規丟 WatchlistError。"""
    if not isinstance(lists, list):
        raise WatchlistError("lists 必須是陣列")
    if len(lists) > MAX_LISTS:
        raise WatchlistError(f"清單數上限 {MAX_LISTS}")
    out = []
    for it in lists:
        if not isinstance(it, dict):
            raise WatchlistError("清單格式錯誤")
        lid = str(it.get("id") or "").strip()[:64]
        name = str(it.get("name") or "").strip()[:40]
        codes = it.get("codes") or []
        if not isinstance(codes, list):
            raise WatchlistError("codes 必須是陣列")
        # code 去重、限長、只留合理字元(CB/現股代號)
        seen, clean = set(), []
        for c in codes:
            c = str(c).strip()[:12]
            if c and c not in seen and c.replace(".", "").isalnum():
                seen.add(c)
                clean.append(c)
            if len(clean) >= 500:
                break
        if not lid:
            raise WatchlistError("清單缺 id")
        out.append({"id": lid, "name": name, "codes": clean})
    return out


# ══════════════════ ProviderGroup(來源端自選股)後端 ══════════════════
def _cg_call(bearer, params):
    """打 ProviderGroup.ashx(GET + 帶使用者OIDC Bearer);回 JSON dict。"""
    if not bearer:
        raise WatchlistError("缺少使用者 token")
    url = PG_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + bearer})
    raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except Exception:
        raise WatchlistError("ProviderGroup 回應非 JSON")


def _cg_groups(bearer):
    """本會員全部自選股群組(含內容)。"""
    res = _cg_call(bearer, {"action": "getprovidergroupandlist", "docType": PG_DOCTYPE})
    return res.get("Group", []) or []


def _cg_get_lists(bearer):
    out = []
    for g in _cg_groups(bearer):
        dn = str(g.get("DocName", ""))
        if dn.startswith(PG_PREFIX):
            out.append({
                "id": str(g.get("DocNo")),
                "name": dn[len(PG_PREFIX):],
                "codes": [str(c) for c in (g.get("ItemList") or [])],
            })
    return out


def _cg_delete(bearer, docno):
    _cg_call(bearer, {"action": "deleteprovidergroup", "docNo": int(docno), "docType": PG_DOCTYPE})


def _cg_put_lists(bearer, lists):
    """把整份 lists 同步進 CB 專屬群組。規則:
       ① 只有「有股票」的清單才建/留 資料來源方 群組(空清單只留本機、不污染使用者自選股)。
       ② 凡不在本次 desired 的訊號前綴群組(含變空的、被刪的)、以及任何同名重複殘留,一律刪除
          → 在這邊建立/刪除都會正確反映到 資料來源方、不累積殭屍。"""
    clean = _sanitize(lists)
    # 現有全部訊號前綴群組(以 list 保留重複;失敗重試等可能產生同名多顆)
    prefixed = [g for g in _cg_groups(bearer) if str(g.get("DocName", "")).startswith(PG_PREFIX)]
    canon, dup_trash = {}, []               # DocName -> 唯一 canonical 群組;其餘同名 = 垃圾
    for g in prefixed:
        dn = str(g.get("DocName", ""))
        if dn in canon:
            dup_trash.append(g)
        else:
            canon[dn] = g
    desired, order = {}, []                  # DocName -> codes(同名最後者勝,保序)
    for it in clean:
        if not it["codes"]:                  # 空清單不建 資料來源方 群組
            continue
        dn = (PG_PREFIX + (it["name"] or "未命名"))[:_PG_MAX_NAME]
        if dn not in desired:
            order.append(dn)
        desired[dn] = it["codes"]
    result = []
    for dn in order:
        codes = desired[dn]
        g = canon.get(dn)
        if g:
            docno = int(g.get("DocNo"))
        else:
            add = _cg_call(bearer, {"action": "addprovidergroup", "docName": dn, "docType": PG_DOCTYPE})
            docno = int(add.get("DocNo") or 0)
            if not docno:
                raise WatchlistError("建立自選股群組失敗")
        _cg_call(bearer, {"action": "updatecustomlist", "docNo": docno,
                          "docName": dn, "docType": PG_DOCTYPE, "list": ";".join(codes)})
        result.append({"id": str(docno), "name": dn[len(PG_PREFIX):], "codes": codes})
    # 清垃圾:①不在本次 desired 的訊號群組 ②所有同名重複殘留
    for dn, g in canon.items():
        if dn not in desired:
            _cg_delete(bearer, g.get("DocNo"))
    for g in dup_trash:
        _cg_delete(bearer, g.get("DocNo"))
    return result


# ══════════════════ Sheet(舊版,保留回退)後端 ══════════════════
def _load_sa():
    global _sa
    if _sa is not None:
        return _sa
    raw = _SA_JSON or (open(_SA_FILE, encoding="utf-8").read() if _SA_FILE else "")
    if not raw:
        raise WatchlistError("service account 金鑰未設定")
    _sa = json.loads(raw)
    return _sa


def _access_token():
    """本地簽 SA JWT → 換 Google access_token;快取到過期前 60s。"""
    now = int(time.time())
    if _tok["v"] and now < _tok["exp"] - 60:
        return _tok["v"]
    sa = _load_sa()
    assertion = jwt.encode(
        {"iss": sa["client_email"], "scope": _SCOPE, "aud": sa["token_uri"], "iat": now, "exp": now + 3600},
        sa["private_key"], algorithm="RS256",
    )
    data = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}
    ).encode()
    req = urllib.request.Request(sa["token_uri"], data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    res = json.loads(urllib.request.urlopen(req, timeout=20).read())
    _tok["v"] = res["access_token"]
    _tok["exp"] = now + int(res.get("expires_in", 3600))
    return _tok["v"]


def _sheets(path, data=None, method="GET"):
    req = urllib.request.Request(
        f"{_SHEETS}/{SHEET_ID}{path}",
        data=(json.dumps(data).encode() if data is not None else None),
        method=method,
        headers={"Authorization": "Bearer " + _access_token(), "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=25).read())


def _read_rows(fresh=False):
    """回傳 [[member_id, lists_json, updated_at], ...](不含表頭);短 TTL 快取。"""
    now = time.time()
    if not fresh and _cache["rows"] is not None and now - _cache["at"] < _READ_TTL:
        return _cache["rows"]
    got = _sheets("/values/A2:C?majorDimension=ROWS")
    rows = got.get("values", []) or []
    _cache["rows"] = rows
    _cache["at"] = now
    return rows


def _find_row_index(member_id, rows):
    """回傳該會員在資料區的 0-based 索引;找不到=None。"""
    for i, r in enumerate(rows):
        if r and str(r[0]) == member_id:
            return i
    return None


def _sheet_get_lists(member_id):
    with _lock:
        rows = _read_rows()
        idx = _find_row_index(member_id, rows)
        if idx is None:
            return []
        try:
            return json.loads(rows[idx][1]) if len(rows[idx]) > 1 and rows[idx][1] else []
        except Exception:
            return []


def _sheet_put_lists(member_id, lists):
    clean = _sanitize(lists)
    payload = json.dumps(clean, ensure_ascii=False)
    updated = str(int(time.time()))
    with _lock:
        rows = _read_rows(fresh=True)
        idx = _find_row_index(member_id, rows)
        if idx is None:
            _sheets("/values/A2:C2:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
                    data={"values": [[member_id, payload, updated]]}, method="POST")
        else:
            row_no = idx + 2   # +1 表頭 +1 轉 1-based
            _sheets(f"/values/A{row_no}:C{row_no}?valueInputOption=RAW",
                    data={"values": [[member_id, payload, updated]]}, method="PUT")
        _cache["rows"] = None
    return clean


# ══════════════════ 對外合約(依 backend 路由)══════════════════
def get_lists(member_id, bearer=None):
    if not enabled():
        raise WatchlistError("watchlist 未啟用")
    if BACKEND == "providergroup":
        return _cg_get_lists(bearer)
    return _sheet_get_lists(str(member_id))


def put_lists(member_id, lists, bearer=None):
    if not enabled():
        raise WatchlistError("watchlist 未啟用")
    if BACKEND == "providergroup":
        return _cg_put_lists(bearer, lists)
    return _sheet_put_lists(str(member_id), lists)
