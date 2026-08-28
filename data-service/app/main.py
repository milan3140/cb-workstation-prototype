# -*- coding: utf-8 -*-
"""cb-workstation-data — CB 工作站 資料後端(資料與網站部署解耦的第一步)。

職責:①每交易日盤後自動抓數(服務內排程,取代每日發版)②供前端資料 API。
資料檔存 DATA_DIR(pod 暫存即可:重啟後啟動即重抓,約 5 分鐘冷啟)。
未來擴充落點:畫線雲端同步 API(契約見 webapp-react-v4/KLINE_PRODUCTION.md)、
OIDC後 entitlement 判定、即時資料 proxy。
"""
import json
import os
import re
import threading
import time
import zoneinfo
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .auth import REQUIRE_AUTH, require_auth
from .refresh import run_refresh
from . import drawings, watchlist

DATA_DIR = Path(os.environ.get("CBW_DATA_DIR", "./data")).resolve()
# 台北時間,逗號分隔=每日多次。15:40 收盤價先出;之後每小時刷到 21:30——
# 三大法人/籌碼類資料 16:00 起陸續發布且 資料集表更新時點不完全可控,小時級輪詢讓
# 「資料落地→網站看到」最壞延遲 <1h(全量刷一次 ~2min/約 1500 次 資料集 呼叫,量可承受)。
REFRESH_AT = os.environ.get("CBW_REFRESH_AT", "15:40,16:30,17:30,18:30,19:30,20:30,21:30")
TZ = zoneinfo.ZoneInfo("Asia/Taipei")
_DEFAULT_ORIGINS = "https://workstation.example.com,https://api-stage.example.com,http://localhost:5173,http://localhost:4173"
CORS_ORIGINS = [o for o in os.environ.get("CBW_CORS_ORIGINS", _DEFAULT_ORIGINS).split(",") if o]
SID_RE = re.compile(r"^[0-9A-Za-z]{1,10}$")

app = FastAPI(title="cb-workstation-data", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "PUT"], allow_headers=["*"])

# 資料端點統一掛OIDC驗證(見 app/auth.py)。healthz/internal 不掛。
_AUTH = [Depends(require_auth)]
print(f"[auth] data API require_auth={REQUIRE_AUTH}", flush=True)

_refresh_lock = threading.Lock()
_last_error = {"error": None, "at": None}


def _meta():
    p = DATA_DIR / "meta.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    raw = DATA_DIR / "raw.json"
    if raw.exists():  # 有資料但無 meta(外部種入):以資料本身合成最小 meta
        return {"dataDate": json.loads(raw.read_text(encoding="utf-8")).get("today"),
                "refreshedAt": None, "status": "seeded"}
    return None


def _do_refresh(reason):
    if not _refresh_lock.acquire(blocking=False):
        return {"skipped": "refresh already running"}
    try:
        print(f"[refresh] start ({reason})", flush=True)
        meta = run_refresh(DATA_DIR)
        print(f"[refresh] ok dataDate={meta['dataDate']} rows={meta['rows']} {meta['durationSec']}s", flush=True)
        _last_error["error"] = None
        return meta
    except Exception as e:  # 失敗保留舊資料;錯誤記進 /healthz 可見
        _last_error["error"] = str(e)[:300]
        _last_error["at"] = datetime.now(TZ).isoformat(timespec="seconds")
        print(f"[refresh] FAILED: {e}", flush=True)
        return {"error": str(e)[:300]}
    finally:
        _refresh_lock.release()


def _scheduler():
    """每日台北 REFRESH_AT 各時點各跑一次(假日跑無害:資料日取自資料本身)。

    為何多次:熱度指標=籌碼分數+技術分數,三大法人買賣超 16:00 後才發布——15:40 只刷一次
    會把「缺籌碼分量」的熱度值(如 3037 快照 2.0 vs App 3.5,2026-08-25)掛一整天。
    15:40 先出收盤價版,18:30/21:30 籌碼落地後補正。"""
    times = sorted({(int(h), int(m)) for h, m in
                    (part.strip().split(":") for part in REFRESH_AT.split(",") if part.strip())})
    while True:
        now = datetime.now(TZ)
        nexts = []
        for hh, mm in times:
            target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            nexts.append(target)
        target = min(nexts)
        time.sleep(max(30, (target - now).total_seconds()))
        _do_refresh(f"scheduled {target.strftime('%H:%M')}")


@app.on_event("startup")
def _startup():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not (DATA_DIR / "raw.json").exists():
        threading.Thread(target=_do_refresh, args=("cold start",), daemon=True).start()
    threading.Thread(target=_scheduler, daemon=True).start()


@app.get("/healthz")
def healthz():
    meta = _meta()
    return {"ok": True, "hasData": meta is not None,
            "dataDate": (meta or {}).get("dataDate"),
            "refreshedAt": (meta or {}).get("refreshedAt"),
            "refreshing": _refresh_lock.locked(),
            "lastError": _last_error["error"], "lastErrorAt": _last_error["at"]}


@app.get("/api/meta", dependencies=_AUTH)
def api_meta():
    meta = _meta()
    if meta is None:
        raise HTTPException(503, "data not ready (cold start refresh in progress)")
    return JSONResponse(meta, headers={"Cache-Control": "no-store"})


def _serve(path, max_age):
    if not path.exists():
        raise HTTPException(503 if _refresh_lock.locked() else 404, "data not ready")
    return FileResponse(path, media_type="application/json",
                        headers={"Cache-Control": f"public, max-age={max_age}"})


@app.get("/api/raw.json", dependencies=_AUTH)
def api_raw():
    return _serve(DATA_DIR / "raw.json", 300)


@app.get("/api/history.json", dependencies=_AUTH)
def api_history():
    return _serve(DATA_DIR / "history.json", 300)


@app.get("/api/kline/{sid}.json", dependencies=_AUTH)
def api_kline(sid: str):
    if not SID_RE.match(sid):
        raise HTTPException(400, "bad symbol")
    return _serve(DATA_DIR / "kline" / f"{sid}.json", 600)


@app.get("/api/cb_kline/{sid}.json", dependencies=_AUTH)
def api_cb_kline(sid: str):
    """CB 自身日 K(治理 D3);未接通時 404,前端自動退回現股 K。"""
    if not SID_RE.match(sid):
        raise HTTPException(400, "bad symbol")
    return _serve(DATA_DIR / "cb_kline" / f"{sid}.json", 600)


@app.get("/api/cb_custody.json", dependencies=_AUTH)
def api_cb_custody():
    """CB 月集保庫存趨勢(治理 D4)=「聰明錢下車偵測」:庫存大減=有人轉股或賣掉。"""
    return _serve(DATA_DIR / "cb_custody.json", 3600)


@app.get("/api/cb_terms.json", dependencies=_AUTH)
def api_cb_terms():
    """CB 條款期間(治理 D6):轉換日期起迄=停止轉換期間警示、票面利率、掛牌/下櫃/到期。"""
    return _serve(DATA_DIR / "cb_terms.json", 3600)


@app.get("/api/cb_legal.json", dependencies=_AUTH)
def api_cb_legal():
    """三大法人買賣這檔 CB(近 20 日):外資/投信/自營淨買張數——法人有沒有在收。"""
    return _serve(DATA_DIR / "cb_legal.json", 1800)


# ── 會員關注清單(預設存 來源端自選股 ProviderGroup;見 app/watchlist.py)──────
# 身分取自OIDC token 的 sub(=member_id);會員只能讀寫自己的清單。dev(REQUIRE_AUTH=0)用固定 id。
# providergroup 後端另需原始 Bearer token 轉發給 資料來源方(來源端自 JWT 取 MemberId)。
def _member_id(claims):
    if claims and claims.get("sub"):
        return str(claims["sub"])
    return os.environ.get("CBW_DEV_MEMBER_ID", "dev-local")   # REQUIRE_AUTH=0 本機


def _bearer(authorization):
    return authorization[7:].strip() if authorization.startswith("Bearer ") else ""


@app.get("/api/watchlists", dependencies=_AUTH)
def api_get_watchlists(claims=Depends(require_auth), authorization: str = Header(default="")):
    if not watchlist.enabled():
        raise HTTPException(503, "watchlist not configured")
    try:
        return {"lists": watchlist.get_lists(_member_id(claims), _bearer(authorization))}
    except watchlist.WatchlistError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(502, "watchlist store error")


@app.put("/api/watchlists", dependencies=_AUTH)
def api_put_watchlists(payload: dict, claims=Depends(require_auth), authorization: str = Header(default="")):
    if not watchlist.enabled():
        raise HTTPException(503, "watchlist not configured")
    try:
        saved = watchlist.put_lists(_member_id(claims), payload.get("lists"), _bearer(authorization))
    except watchlist.WatchlistError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(502, "watchlist store error")
    return {"ok": True, "lists": saved}


# ── 會員畫線雲端同步(Google Sheet;見 app/drawings.py)─────────────────
# 身分同 watchlists(OIDC sub=member_id,會員只能讀寫自己的);symbol=現股代號、period=hour/day/week/month。
@app.get("/api/drawings/{sid}/{period}", dependencies=_AUTH)
def api_get_drawings(sid: str, period: str, claims=Depends(require_auth)):
    if not drawings.enabled():
        raise HTTPException(503, "drawings not configured")
    try:
        doc = drawings.get_doc(_member_id(claims), sid, period)
    except drawings.DrawingsError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(502, "drawings store error")
    return JSONResponse(doc, headers={"Cache-Control": "no-store"})


@app.put("/api/drawings/{sid}/{period}", dependencies=_AUTH)
def api_put_drawings(sid: str, period: str, payload: dict, claims=Depends(require_auth)):
    if not drawings.enabled():
        raise HTTPException(503, "drawings not configured")
    try:
        updated = drawings.put_doc(_member_id(claims), sid, period, payload.get("shapes"))
    except drawings.DrawingsError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(502, "drawings store error")
    return {"ok": True, "updatedAt": updated}


@app.post("/internal/refresh")
def internal_refresh(token: str = ""):
    expect = os.environ.get("CBW_REFRESH_TOKEN")
    if not expect or token != expect:
        raise HTTPException(403, "forbidden")
    result = _do_refresh("manual")
    return result
