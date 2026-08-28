# -*- coding: utf-8 -*-
"""OIDC Bearer token 驗證 — 資料 API 的身分閘門(後端側)。

前端登入後對 /api/* 帶 `Authorization: Bearer <access_token>`;此處驗:
①IdP 簽章(JWKS, RS256)②iss ③aud ④未過期 ⑤非 guest(若 IdP 提供該 claim)。
驗過才吐資料——對應治理原則「前端不烤資料」:資料不進前端映像(公開可抓),
改由後端驗身分後才供給。

原型預設:**沒設 OIDC 環境變數 = 不驗證**(整站可離線操作),啟動時會印警告。
設了 iss/aud/jwks 三者 → 自動開啟驗證。要強制開卻沒設完 → 啟動直接失敗,
不允許「以為有在驗、其實全放行」這種靜默狀態。

  CBW_OIDC_ISS / CBW_OIDC_AUD / CBW_OIDC_JWKS_URL   IdP 三要素
  CBW_REQUIRE_AUTH=true|false                        明確覆蓋自動判定
  CBW_OIDC_LEEWAY                                    時鐘容差秒數(預設 60)
"""
import os

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

ISSUER = os.environ.get("CBW_OIDC_ISS", "").strip()
AUDIENCE = os.environ.get("CBW_OIDC_AUD", "").strip()
JWKS_URL = os.environ.get("CBW_OIDC_JWKS_URL", "").strip()
LEEWAY = int(os.environ.get("CBW_OIDC_LEEWAY", "60"))

OIDC_CONFIGURED = bool(ISSUER and AUDIENCE and JWKS_URL)
_explicit = os.environ.get("CBW_REQUIRE_AUTH", "").strip().lower()
if _explicit in ("1", "true", "yes", "on"):
    REQUIRE_AUTH = True
elif _explicit in ("0", "false", "no", "off"):
    REQUIRE_AUTH = False
else:
    REQUIRE_AUTH = OIDC_CONFIGURED        # 沒明講 → 有設定就驗、沒設定就不驗

if REQUIRE_AUTH and not OIDC_CONFIGURED:
    raise RuntimeError(
        "CBW_REQUIRE_AUTH 要求驗證,但 CBW_OIDC_ISS / CBW_OIDC_AUD / CBW_OIDC_JWKS_URL "
        "沒有設齊 —— 寧可起不來,也不要讓服務看起來在驗、實際上全放行。")
if not REQUIRE_AUTH:
    print("[auth] 警告:未啟用 token 驗證,/api/* 全部開放。僅適合本機開發。", flush=True)

# 惰性建立:import 時不連網、不會拖慢/拖垮啟動;首次驗 token 才抓 JWKS(之後快取)。
_jwk_client = PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600) if REQUIRE_AUTH else None


def _verify(token):
    signing_key = _jwk_client.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=AUDIENCE,
        issuer=ISSUER,
        leeway=LEEWAY,
        options={"require": ["exp", "iss", "aud"]},
    )
    if claims.get("is_guest") is True:
        raise HTTPException(401, "guest not allowed")
    return claims


def require_auth(authorization: str = Header(default="")):
    """FastAPI 依賴:驗 Bearer token,失敗一律 401(不洩漏原因細節)。

    未啟用驗證 → 放行(本機)。JWKS 抓不到/驗不過 → fail-closed(401)。
    """
    if not REQUIRE_AUTH:
        return None
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "unauthorized")
    token = authorization[7:].strip()
    try:
        return _verify(token)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "unauthorized")
