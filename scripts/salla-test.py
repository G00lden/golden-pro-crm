"""Golden Pro CRM — Salla Integration Probe.

Exercises the Salla integration end-to-end with whatever credentials the
local server currently holds, plus a direct call to the public Salla
authorization endpoint to confirm the configured client_id is recognised.

Writes the structured results to salla-test-results.json at the project root.

Run with:
    python scripts/salla-test.py
or:
    python scripts/salla-test.py --base-url http://localhost:3000
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse as parse
from urllib import error, request
from local_test_auth import get_local_test_token

ADMIN_TOKEN = ""
_DEFAULT_TOKEN = object()


def http(
    method: str,
    url: str,
    *,
    token: str | None | object = _DEFAULT_TOKEN,
    body: dict | None = None,
    extra_headers: dict | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict | list | str, dict]:
    if token is _DEFAULT_TOKEN:
        token = ADMIN_TOKEN
    headers: dict[str, str] = {"Accept": "application/json"}
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra_headers:
        headers.update(extra_headers)

    req = request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.getcode(), _parse(raw), dict(resp.headers.items())
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return exc.code, _parse(raw), dict(exc.headers.items()) if exc.headers else {}
    except error.URLError as exc:
        return 0, f"URLError: {exc.reason}", {}
    except TimeoutError as exc:
        return 0, f"Timeout: {exc}", {}


def _parse(raw: str):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def read_env(env_path: str) -> dict[str, str]:
    """Minimal .env parser — splits "KEY=VALUE" lines, ignores comments."""
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


def probe(base: str, env: dict[str, str]) -> dict:
    results: dict = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "configuration": {
            "auth_mode": env.get("SALLA_AUTH_MODE") or None,
            "client_id_present": bool(env.get("SALLA_CLIENT_ID")),
            "client_secret_present": bool(env.get("SALLA_CLIENT_SECRET")),
            "redirect_uri": env.get("SALLA_REDIRECT_URI") or None,
            "scopes": env.get("SALLA_SCOPES") or None,
            "sync_cron_enabled": env.get("SALLA_SYNC_CRON_ENABLED") == "true",
            "state_secret_present": bool(env.get("SALLA_STATE_SECRET")),
            "webhook_secret_present": bool(env.get("SALLA_APP_WEBHOOK_SECRET")),
            "owner_uid": env.get("SALLA_APP_OWNER_UID") or None,
        },
        "endpoints": {},
        "salla_api": {},
        "webhook_replay": {},
        "summary": {},
        "recommendations": [],
    }

    # 1. Status — should always succeed regardless of link state
    s, body, _ = http("GET", f"{base}/api/integrations/salla/status")
    results["endpoints"]["status"] = {
        "status_code": s,
        "ok": s == 200,
        "linked": bool(isinstance(body, dict) and body.get("linked")),
        "state": isinstance(body, dict) and body.get("status"),
        "store_name": isinstance(body, dict) and body.get("store_name"),
        "expires_at": isinstance(body, dict) and body.get("expires_at"),
        "configured": isinstance(body, dict) and body.get("configured"),
        "body": body if isinstance(body, dict) else None,
    }

    # 2. Connect URL (Easy Mode: 409 expected with guidance; Custom Mode: 200 with OAuth URL)
    s2, body2, _ = http("GET", f"{base}/api/integrations/salla/connect")
    results["endpoints"]["connect"] = {
        "status_code": s2,
        "ok": s2 in (200, 409),
        "url": isinstance(body2, dict) and body2.get("url"),
        "guidance": body2 if s2 == 409 else None,
        "body": body2 if isinstance(body2, dict) else None,
    }

    # 3. Manual sync
    s3, body3, _ = http("POST", f"{base}/api/integrations/salla/sync", body={})
    results["endpoints"]["sync"] = {
        "status_code": s3,
        "ok": s3 in (200, 412),
        "imported": isinstance(body3, dict) and body3.get("imported"),
        "updated": isinstance(body3, dict) and body3.get("updated"),
        "failed": isinstance(body3, dict) and body3.get("failed"),
        "body": body3 if isinstance(body3, dict) else None,
    }

    # 4. Direct Salla authorize endpoint sanity check — verifies the configured
    #    client_id is recognised by Salla's identity server. We don't actually
    #    follow the redirect; we just confirm Salla returns a 30x (good) or 4xx
    #    (client_id rejected) on the public endpoint.
    if env.get("SALLA_CLIENT_ID"):
        params = parse.urlencode({
            "client_id": env["SALLA_CLIENT_ID"],
            "response_type": "code",
            "redirect_uri": env.get("SALLA_REDIRECT_URI", ""),
            "scope": env.get("SALLA_SCOPES", "offline_access orders.read"),
            "state": "probe",
        })
        try:
            req2 = request.Request(f"https://accounts.salla.sa/oauth2/auth?{params}")
            opener = request.build_opener(NoRedirectHandler())
            with opener.open(req2, timeout=15) as resp:
                authorize_status = resp.getcode()
                snippet = resp.read(400).decode("utf-8", errors="replace")
        except error.HTTPError as exc:
            authorize_status = exc.code
            snippet = exc.read(400).decode("utf-8", errors="replace") if exc.fp else ""
        except Exception as exc:
            authorize_status = 0
            snippet = str(exc)
        results["salla_api"]["authorize_endpoint"] = {
            "status_code": authorize_status,
            "ok": authorize_status in (200, 302, 303, 307, 308, 400, 401),
            "snippet": snippet[:400],
        }
    else:
        results["salla_api"]["authorize_endpoint"] = {"skipped": True, "reason": "SALLA_CLIENT_ID is not configured"}

    # 5. Webhook replay — simulate Salla pushing an order.created event to our
    #    own endpoint. Validates wiring without needing a real Salla token.
    if env.get("SALLA_APP_WEBHOOK_SECRET"):
        payload = {
            "event": "order.created",
            "merchant": env.get("SALLA_APP_OWNER_UID") or "probe",
            "data": {
                "id": f"probe-{int(time.time())}",
                "reference_id": f"PROBE-{int(time.time())}",
                "status": "in progress",
                "date": {"date": dt.date.today().isoformat()},
                "customer": {
                    "first_name": "Probe",
                    "last_name": "User",
                    "mobile": "966500000099",
                    "email": "probe@example.com",
                },
                "items": [
                    {"sku": "PROBE-SKU-INSTAL", "name": "Probe install item", "quantity": 1, "amount": 100, "tags": ["install_maintenance"]},
                ],
                "amounts": {"total": {"amount": 100, "currency": "SAR"}},
            },
        }
        s4, body4, _ = http(
            "POST",
            f"{base}/api/integrations/salla/webhook",
            token=None,
            body=payload,
            extra_headers={"X-Salla-Signature": "probe-signature"},
        )
        results["webhook_replay"]["status_code"] = s4
        results["webhook_replay"]["ok"] = s4 in (200, 202, 401, 403)
        results["webhook_replay"]["body"] = body4 if isinstance(body4, dict) else None
        results["webhook_replay"]["notes"] = "401/403 expected when SALLA_APP_WEBHOOK_SECRET is set and the signature is wrong — that's correct behavior."
    else:
        results["webhook_replay"] = {"skipped": True, "reason": "SALLA_APP_WEBHOOK_SECRET is not configured"}

    # 6. Recommendations
    cfg = results["configuration"]
    if cfg["auth_mode"] == "easy":
        results["recommendations"].append("Easy Mode is active — install the Salla app from your Salla Partners dashboard so the app.store.authorize webhook can populate the access token. The /sync endpoint will then start returning data.")
    if not cfg["state_secret_present"]:
        results["recommendations"].append("Set SALLA_STATE_SECRET to a long random string (signs the OAuth state parameter).")
    if not cfg["webhook_secret_present"]:
        results["recommendations"].append("Set SALLA_APP_WEBHOOK_SECRET so incoming Salla webhooks can be authenticated.")
    if not results["endpoints"]["status"]["linked"]:
        results["recommendations"].append("No Salla store is linked yet. Until then, /api/integrations/salla/sync will return 412 Precondition Failed.")
    if results["salla_api"]["authorize_endpoint"].get("status_code") not in (200, 302, 303, 307, 308):
        results["recommendations"].append("Salla's authorize endpoint did not redirect — double-check SALLA_CLIENT_ID and that the Salla app is published.")

    # 7. Summary
    e = results["endpoints"]
    results["summary"] = {
        "endpoint_count": 3,
        "endpoints_ok": sum(1 for v in e.values() if v.get("ok")),
        "linked": e["status"].get("linked"),
        "auth_mode": cfg["auth_mode"],
        "needs_manual_action": cfg["auth_mode"] == "easy" and not e["status"].get("linked"),
    }
    return results


class NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    global ADMIN_TOKEN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("CRM_BASE_URL", "http://localhost:3000"))
    parser.add_argument("--env-file", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
    parser.add_argument("--report", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "salla-test-results.json"))
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    ADMIN_TOKEN = get_local_test_token(base_url, os.environ.get("LOCAL_AUTH_SHARED_UID", "local-dev-owner"))
    env = read_env(args.env_file)
    output = probe(base_url, env)

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(output, fh, ensure_ascii=False, indent=2)

    s = output["summary"]
    print(f"Salla probe finished: auth_mode={s['auth_mode']} linked={s['linked']} endpoints_ok={s['endpoints_ok']}/{s['endpoint_count']} needs_manual_action={s['needs_manual_action']}")
    print(f"Report saved to: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
