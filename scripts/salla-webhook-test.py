"""Salla webhook end-to-end probe — signs a fake app.store.authorize event with
HMAC-SHA256 and POSTs it to the configured webhook URL (defaults to
https://crm.breexe-pro.com/api/integrations/salla/webhook), reporting the
response, latency, and headers.

Use to verify that the path from any external client (incl. Salla's webhook
delivery service) reaches the Express handler via Cloudflare → cloudflared →
localhost:3000.

Read the webhook secret from .env so we never hardcode it.

Usage:
    python scripts/salla-webhook-test.py
    python scripts/salla-webhook-test.py --base-url http://localhost:3000
    python scripts/salla-webhook-test.py --merchant 363562652 --token-suffix realtest
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
import time
from urllib import error, request

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def read_env(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    for line in open(path, "r", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def sign(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def post(url: str, body: bytes, signature: str, *, user_agent: str = "salla-webhook-probe/1.0") -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": user_agent,
        "x-salla-signature": signature,
    }
    req = request.Request(url, data=body, method="POST", headers=headers)
    started = time.time()
    try:
        with request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return {
                "status_code": resp.getcode(),
                "latency_ms": int((time.time() - started) * 1000),
                "headers": dict(resp.headers.items()),
                "body": _parse(raw),
                "transport_error": None,
            }
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return {
            "status_code": exc.code,
            "latency_ms": int((time.time() - started) * 1000),
            "headers": dict(exc.headers.items()) if exc.headers else {},
            "body": _parse(raw),
            "transport_error": None,
        }
    except error.URLError as exc:
        return {
            "status_code": 0,
            "latency_ms": int((time.time() - started) * 1000),
            "headers": {},
            "body": None,
            "transport_error": str(exc.reason),
        }


def _parse(raw: str):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("CRM_BASE_URL", "https://crm.breexe-pro.com"))
    parser.add_argument("--env-file", default=ENV_PATH)
    parser.add_argument("--merchant", type=int, default=363562652)
    parser.add_argument("--token-suffix", default="probe-token")
    parser.add_argument("--user-agent", default="salla-webhook-probe/1.0")
    parser.add_argument("--report", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "salla-webhook-test.json"))
    args = parser.parse_args()

    env = read_env(args.env_file)
    secret = env.get("SALLA_APP_WEBHOOK_SECRET") or env.get("SALLA_WEBHOOK_SECRET")
    if not secret:
        print("FAIL: SALLA_APP_WEBHOOK_SECRET / SALLA_WEBHOOK_SECRET missing from .env")
        return 1

    url = f"{args.base_url.rstrip('/')}/api/integrations/salla/webhook"
    expires_in = 90 * 24 * 3600

    payload = {
        "event": "app.store.authorize",
        "merchant": args.merchant,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "data": {
            "access_token": f"access-{args.token_suffix}",
            "refresh_token": f"refresh-{args.token_suffix}",
            "expires": expires_in,
            "scope": "offline_access orders.read products.read",
            "token_type": "bearer",
        },
    }
    body = json.dumps(payload).encode("utf-8")
    signature = sign(secret, body)

    # Scenario 1: signed event with the configured secret — expected 200.
    signed = post(url, body, signature, user_agent=args.user_agent)

    # Scenario 2: bad signature — expected 401 (proves verify gate works at all).
    bad = post(url, body, "deadbeef" * 8, user_agent=args.user_agent)

    # Scenario 3: spoof a Salla user-agent to detect WAF UA filtering.
    salla_ua = post(url, body, signature, user_agent="Salla-Webhooks/1.0 (+https://salla.dev)")

    # Scenario 4: empty data.access_token — reproduces what the partner UI sends
    # on retry of an old event (where the secret was already issued once).
    retry_payload = {**payload, "data": {**payload["data"], "access_token": ""}}
    retry_body = json.dumps(retry_payload).encode("utf-8")
    retry_sig = sign(secret, retry_body)
    retry = post(url, retry_body, retry_sig, user_agent=args.user_agent)

    summary = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "url": url,
        "secret_source": "SALLA_APP_WEBHOOK_SECRET" if env.get("SALLA_APP_WEBHOOK_SECRET") else "SALLA_WEBHOOK_SECRET",
        "scenarios": {
            "signed_event": {
                "expected": 200,
                "got": signed["status_code"],
                "ok": signed["status_code"] == 200,
                "latency_ms": signed["latency_ms"],
                "transport_error": signed["transport_error"],
                "body": signed["body"],
                "cf_ray": signed["headers"].get("CF-RAY") or signed["headers"].get("cf-ray"),
                "server": signed["headers"].get("Server") or signed["headers"].get("server"),
            },
            "bad_signature": {
                "expected": 401,
                "got": bad["status_code"],
                "ok": bad["status_code"] == 401,
                "body": bad["body"],
            },
            "salla_user_agent": {
                "expected": 200,
                "got": salla_ua["status_code"],
                "ok": salla_ua["status_code"] == 200,
                "transport_error": salla_ua["transport_error"],
                "body": salla_ua["body"],
            },
            "retry_without_token": {
                "expected_one_of": [500, 400, 422],
                "got": retry["status_code"],
                "ok": retry["status_code"] in (400, 422, 500),
                "note": "Reproduces 'access_token missing' — Salla's 'Retry' button sends old event metadata without re-issuing the access_token.",
                "body": retry["body"],
            },
        },
    }
    summary["ok"] = all(v.get("ok") for v in summary["scenarios"].values())

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    print(f"URL: {url}")
    for name, sc in summary["scenarios"].items():
        flag = "PASS" if sc.get("ok") else "FAIL"
        print(f"  [{flag}] {name}: got={sc.get('got')} expected={sc.get('expected') or sc.get('expected_one_of')}")
    print(f"\nReport saved: {args.report}")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
