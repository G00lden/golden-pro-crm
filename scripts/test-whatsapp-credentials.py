"""Test WhatsApp Cloud API credentials end-to-end.

Reads WHATSAPP_CLOUD_API_TOKEN + WHATSAPP_CLOUD_PHONE_NUMBER_ID + version
from .env, sends a text message via the Meta Graph API, and reports
detailed status + the message_id returned by Meta. Exits non-zero on
any auth/credential/configuration failure so this can gate CI.

Usage:
    python scripts/test-whatsapp-credentials.py --to 966500000000
    python scripts/test-whatsapp-credentials.py --to 966500000000 --message "اختبار"
    python scripts/test-whatsapp-credentials.py --dry-run    # just validate token shape

The script never logs the full bearer token; only the last 6 chars + length.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from urllib import error, request

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
REPORT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "whatsapp-credentials-test.json")


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


def mask(token: str) -> str:
    if not token:
        return "(empty)"
    return f"len={len(token)} suffix=...{token[-6:]}"


def post(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, dict | str, dict]:
    req = request.Request(url, data=body, method="POST", headers=headers)
    try:
        with request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.getcode(), _parse(raw), dict(resp.headers.items())
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return exc.code, _parse(raw), dict(exc.headers.items()) if exc.headers else {}
    except error.URLError as exc:
        return 0, f"URLError: {exc.reason}", {}


def _parse(raw: str):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def normalize_phone(phone: str) -> str:
    digits = "".join(ch for ch in phone if ch.isdigit())
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0"):
        digits = "966" + digits[1:]
    if len(digits) == 9 and digits.startswith("5"):
        digits = "966" + digits
    return digits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=ENV_PATH)
    parser.add_argument("--to", help="Destination phone, e.g. 966500000000")
    parser.add_argument(
        "--message",
        default=f"اختبار قنوات Cloud API — {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
    )
    parser.add_argument("--dry-run", action="store_true", help="Skip the network call; just validate config.")
    parser.add_argument("--report", default=REPORT_PATH)
    args = parser.parse_args()

    env = read_env(args.env_file)
    provider = env.get("WHATSAPP_PROVIDER", "")
    token = env.get("WHATSAPP_CLOUD_API_TOKEN", "")
    phone_id = env.get("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "")
    version = env.get("WHATSAPP_CLOUD_API_VERSION", "v22.0")

    result: dict = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "config": {
            "provider": provider,
            "version": version,
            "phone_number_id_present": bool(phone_id),
            "token_present": bool(token),
            "token_info": mask(token),
        },
        "errors": [],
    }

    if provider != "cloud_api":
        result["errors"].append(
            f"WHATSAPP_PROVIDER must be cloud_api (currently '{provider or 'unset'}'). Update .env and restart the server."
        )
    if not token:
        result["errors"].append("WHATSAPP_CLOUD_API_TOKEN is missing in .env.")
    if not phone_id:
        result["errors"].append(
            "WHATSAPP_CLOUD_PHONE_NUMBER_ID is missing in .env — copy it from the Kapso dashboard (or Meta WhatsApp Business app)."
        )

    if result["errors"] and not args.dry_run:
        _save(args.report, result)
        for line in result["errors"]:
            print(f"FAIL: {line}")
        return 1

    if args.dry_run:
        result["dry_run"] = True
        result["ok"] = not result["errors"]
        _save(args.report, result)
        print("Dry-run complete.")
        for line in result["errors"]:
            print(f"WARN: {line}")
        return 0 if result["ok"] else 1

    if not args.to:
        result["errors"].append("--to <phone> is required for a real send.")
        _save(args.report, result)
        print("FAIL: --to <phone> is required for a real send. Use --dry-run to skip the network call.")
        return 1

    to_phone = normalize_phone(args.to)
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_phone,
        "type": "text",
        "text": {"preview_url": False, "body": args.message},
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    url = f"https://graph.facebook.com/{version}/{phone_id}/messages"

    status, response, hdrs = post(url, body, headers)
    result["call"] = {
        "url": url,
        "to": to_phone,
        "status_code": status,
        "response": response,
        "trace_id": hdrs.get("x-fb-trace-id") or hdrs.get("X-FB-Trace-ID") or None,
    }

    if status == 200 and isinstance(response, dict) and response.get("messages"):
        message_id = response["messages"][0].get("id")
        result["ok"] = True
        result["message_id"] = message_id
        print(f"PASS: message sent — id={message_id}")
    else:
        result["ok"] = False
        err_obj = response.get("error") if isinstance(response, dict) else None
        err_msg = (err_obj or {}).get("message") if isinstance(err_obj, dict) else None
        result["errors"].append(f"Cloud API returned status={status} message={err_msg or response}")
        print(f"FAIL: status={status} response={json.dumps(response, ensure_ascii=False)[:300]}")

    _save(args.report, result)
    return 0 if result.get("ok") else 1


def _save(report_path: str, data: dict) -> None:
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    sys.exit(main())
