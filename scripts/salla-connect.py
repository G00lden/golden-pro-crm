"""Golden Pro CRM — Salla OAuth Connect Probe.

Generates the Salla OAuth authorization URL from the client_id/redirect_uri in
.env, prints it for the merchant to open in a browser, optionally exchanges a
callback code for tokens, then exercises Salla's orders + products APIs and
the local webhook endpoint.

Usage:
    python scripts/salla-connect.py                     # just print the auth URL
    python scripts/salla-connect.py --code <auth_code>  # finish the OAuth flow
    python scripts/salla-connect.py --token <access_token>  # skip OAuth, test only

Writes a structured report to salla-integration-results.json at the project root.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse as parse
from urllib import error, request

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
REPORT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "salla-integration-results.json")

SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth"
SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token"
SALLA_USERINFO_URL = "https://accounts.salla.sa/oauth2/user/info"
SALLA_API_BASE = "https://api.salla.dev/admin/v2"


def read_env(env_path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(env_path):
        return out
    for line in open(env_path, "r", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def http(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, str, dict]:
    """Low-level HTTP helper — returns (status, raw_body, headers)."""
    req = request.Request(url, data=body, method=method.upper(), headers=headers or {})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read().decode("utf-8", errors="replace"), dict(resp.headers.items())
    except error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace"), dict(exc.headers.items()) if exc.headers else {}
    except error.URLError as exc:
        return 0, f"URLError: {exc.reason}", {}


def json_or_raw(raw: str):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def build_authorize_url(env: dict[str, str]) -> str:
    params = {
        "client_id": env["SALLA_CLIENT_ID"],
        "response_type": "code",
        "redirect_uri": env.get("SALLA_REDIRECT_URI", ""),
        "scope": env.get("SALLA_SCOPES", "offline_access orders.read products.read"),
        "state": f"probe-{int(time.time())}",
    }
    return f"{SALLA_AUTHORIZE_URL}?{parse.urlencode(params)}"


def exchange_code(env: dict[str, str], code: str) -> dict:
    """Exchange an OAuth `code` for access/refresh tokens (Custom Mode flow)."""
    body = parse.urlencode({
        "client_id": env["SALLA_CLIENT_ID"],
        "client_secret": env["SALLA_CLIENT_SECRET"],
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": env.get("SALLA_REDIRECT_URI", ""),
    }).encode()
    status, raw, _ = http(
        "POST",
        SALLA_TOKEN_URL,
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        body=body,
    )
    return {"status_code": status, "body": json_or_raw(raw)}


def call_salla_api(token: str, path: str, *, query: dict | None = None) -> dict:
    url = f"{SALLA_API_BASE}{path}"
    if query:
        url = f"{url}?{parse.urlencode(query)}"
    status, raw, headers = http(
        "GET",
        url,
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    return {"status_code": status, "body": json_or_raw(raw), "rate_limit": headers.get("X-RateLimit-Remaining")}


def webhook_ping(base_url: str) -> dict:
    """POSTs a synthetic order.created event to our own webhook endpoint.

    We deliberately omit the SALLA signature header to verify rejection by
    `verifySallaAppWebhook` when SALLA_APP_WEBHOOK_SECRET is set; a 4xx is the
    desired outcome and confirms the signature gate is wired up.
    """
    body = json.dumps({
        "event": "order.created",
        "merchant": 0,
        "data": {
            "id": f"ping-{int(time.time())}",
            "reference_id": f"PING-{int(time.time())}",
            "status": "in progress",
            "customer": {"first_name": "Ping", "mobile": "966500000088"},
            "items": [{"sku": "PING-SKU", "name": "Ping item", "quantity": 1, "amount": 1, "tags": []}],
            "amounts": {"total": {"amount": 1, "currency": "SAR"}},
        },
    }).encode()
    status, raw, _ = http(
        "POST",
        f"{base_url}/api/integrations/salla/webhook",
        headers={"Content-Type": "application/json"},
        body=body,
    )
    return {"status_code": status, "body": json_or_raw(raw)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=ENV_PATH)
    parser.add_argument("--report", default=REPORT_PATH)
    parser.add_argument("--code", help="OAuth authorization code returned by Salla after consent.")
    parser.add_argument("--token", help="Existing access_token (skip OAuth, jump straight to API calls).")
    parser.add_argument("--base-url", default=os.environ.get("CRM_BASE_URL", "http://localhost:3000"))
    args = parser.parse_args()

    env = read_env(args.env_file)
    missing = [k for k in ("SALLA_CLIENT_ID", "SALLA_CLIENT_SECRET", "SALLA_REDIRECT_URI") if not env.get(k)]
    result: dict = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "auth_mode": env.get("SALLA_AUTH_MODE") or "unknown",
        "missing_env": missing,
        "authorize_url": None,
        "token_exchange": None,
        "orders_api": None,
        "products_api": None,
        "categories_api": None,
        "webhook_ping": None,
        "summary": {},
    }

    if missing:
        result["summary"] = {"ok": False, "reason": f"Missing env vars: {', '.join(missing)}"}
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        print(f"FAIL: missing env vars: {', '.join(missing)}")
        return 1

    authorize_url = build_authorize_url(env)
    result["authorize_url"] = authorize_url
    print(f"Salla OAuth authorize URL:\n  {authorize_url}\n")
    print(f"Mode: {env.get('SALLA_AUTH_MODE')}")
    print(f"Redirect URI: {env.get('SALLA_REDIRECT_URI')}")

    token = args.token
    if args.code and not token:
        print("Exchanging code for tokens...")
        exchange = exchange_code(env, args.code)
        result["token_exchange"] = {"status_code": exchange["status_code"], "ok": exchange["status_code"] == 200, "body_keys": list(exchange["body"].keys()) if isinstance(exchange["body"], dict) else None}
        if exchange["status_code"] == 200 and isinstance(exchange["body"], dict):
            token = str(exchange["body"].get("access_token", ""))
            result["token_exchange"]["expires_in"] = exchange["body"].get("expires_in")
            result["token_exchange"]["scope"] = exchange["body"].get("scope")
            result["token_exchange"]["has_refresh_token"] = bool(exchange["body"].get("refresh_token"))
        else:
            print(f"Token exchange failed: status={exchange['status_code']} body={exchange['body']!r}")
            result["summary"] = {"ok": False, "reason": "Token exchange failed"}
            with open(args.report, "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False, indent=2)
            return 1

    if token:
        print("Calling Salla orders + products...")
        orders = call_salla_api(token, "/orders", query={"per_page": 5})
        result["orders_api"] = {
            "status_code": orders["status_code"],
            "ok": orders["status_code"] == 200,
            "count": len(orders["body"].get("data", [])) if isinstance(orders["body"], dict) else 0,
            "rate_limit_remaining": orders["rate_limit"],
            "first_order_id": (orders["body"].get("data") or [{}])[0].get("id") if isinstance(orders["body"], dict) and isinstance(orders["body"].get("data"), list) and orders["body"]["data"] else None,
        }
        products = call_salla_api(token, "/products", query={"per_page": 5})
        result["products_api"] = {
            "status_code": products["status_code"],
            "ok": products["status_code"] == 200,
            "count": len(products["body"].get("data", [])) if isinstance(products["body"], dict) else 0,
        }
        categories = call_salla_api(token, "/categories")
        result["categories_api"] = {
            "status_code": categories["status_code"],
            "ok": categories["status_code"] == 200,
            "count": len(categories["body"].get("data", [])) if isinstance(categories["body"], dict) else 0,
        }
    else:
        print("No access token yet — open the authorize URL above, complete consent, then re-run with --code <returned code>.")

    print("Pinging local webhook endpoint (expect signature rejection)...")
    result["webhook_ping"] = webhook_ping(args.base_url.rstrip("/"))

    # Summary
    ok_signals = []
    if result["token_exchange"]:
        ok_signals.append(("token_exchange", result["token_exchange"].get("ok")))
    if result["orders_api"]:
        ok_signals.append(("orders_api", result["orders_api"].get("ok")))
    if result["products_api"]:
        ok_signals.append(("products_api", result["products_api"].get("ok")))
    if result["webhook_ping"]:
        ok_signals.append(("webhook_ping", result["webhook_ping"]["status_code"] in (200, 202, 400, 401, 403)))
    all_ok = all(v for _, v in ok_signals) if ok_signals else False

    result["summary"] = {
        "ok": all_ok,
        "checks": dict(ok_signals),
        "needs_user_action": not bool(token),
    }

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(f"\nReport saved to: {args.report}")
    return 0 if all_ok or not token else 1


if __name__ == "__main__":
    sys.exit(main())
