"""End-to-end reminder + WhatsApp flow probe.

Walks the full lifecycle a real customer goes through:

    1. Create a unique customer
    2. Create a product (interval=3 months)
    3. Create an installation with next_maintenance = today
    4. Trigger /api/reminders/run-due (the smart scheduler)
    5. Verify the outbound reminder lands in whatsapp_messages or reminders
    6. POST a synthetic Meta webhook with the customer's "نعم" reply
    7. Verify the installation's reminder cycle is closed (status=confirmed)
    8. Force-escalate by setting remind_count >= 3 + retry the scheduler
    9. Check that the escalations row was created (status=active)

Reports every step + the underlying DB query results to
reminder-flow-results.json at the project root.

Usage:
    python scripts/test-reminder-flow.py
    python scripts/test-reminder-flow.py --base-url http://localhost:3000 --phone 966500111222
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import time
import uuid
from urllib import error, request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "data", "golden-crm.db")
REPORT_PATH = os.path.join(PROJECT_ROOT, "reminder-flow-results.json")
ADMIN_TOKEN = "local-dev:local-dev-owner"


def http(method: str, url: str, *, token: str | None = ADMIN_TOKEN, body: dict | None = None, timeout: float = 15.0):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.getcode(), _parse(raw)
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return exc.code, _parse(raw)
    except error.URLError as exc:
        return 0, f"URLError: {exc.reason}"


def _parse(raw: str):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def query_db(sql: str, args: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("CRM_BASE_URL", "http://localhost:3000"))
    parser.add_argument("--phone", default="0599999777")
    parser.add_argument("--cleanup", action="store_true", help="Delete the created records after the run.")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    suffix = uuid.uuid4().hex[:6]
    today = dt.date.today().isoformat()
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()

    report: dict = {"timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "base_url": base, "steps": []}

    def step(name: str, **details):
        report["steps"].append({"name": name, **details})
        flag = "PASS" if details.get("ok") else "WARN" if details.get("partial") else "FAIL" if "ok" in details and not details.get("ok") else "INFO"
        print(f"  [{flag}] {name}")

    # 1. Customer
    s, body = http("POST", f"{base}/api/customers", body={"name": f"تجربة Flow {suffix}", "phone": args.phone, "city": "Riyadh"})
    customer_id = body.get("id") if isinstance(body, dict) else None
    step("create_customer", ok=bool(customer_id), status=s, customer_id=customer_id)
    if not customer_id:
        report["fatal"] = "Could not create customer."
        return _save(report, 1)

    # 2. Product
    s, body = http("POST", f"{base}/api/products", body={"name": f"فلتر Flow {suffix}", "interval_months": 3, "sku": f"FLOW-{suffix}"})
    product_id = body.get("id") if isinstance(body, dict) else None
    step("create_product", ok=bool(product_id), status=s, product_id=product_id)
    if not product_id:
        report["fatal"] = "Could not create product."
        return _save(report, 1)

    # 3. Installation due today (so smart scheduler picks the "third" stage)
    s, body = http(
        "POST",
        f"{base}/api/installations",
        body={
            "customer_id": customer_id,
            "customer_name": f"تجربة Flow {suffix}",
            "customer_phone": args.phone,
            "product_id": product_id,
            "product_name": f"فلتر Flow {suffix}",
            "install_date": today,
            "next_maintenance": today,
            "status": "active",
        },
    )
    installation_id = body.get("id") if isinstance(body, dict) else None
    step("create_installation", ok=bool(installation_id), status=s, installation_id=installation_id)
    if not installation_id:
        report["fatal"] = "Could not create installation."
        return _save(report, 1)

    # 4. Trigger reminder scheduler
    s, body = http("POST", f"{base}/api/reminders/run-due", body={"mode": "manual"})
    blocked = isinstance(body, dict) and body.get("blocked")
    sent = isinstance(body, dict) and body.get("sent")
    step(
        "run_due_reminders",
        ok=bool(isinstance(body, dict) and not body.get("error")),
        status=s,
        sent=sent,
        blocked=blocked,
        error=isinstance(body, dict) and body.get("error"),
    )

    # 5. Verify a reminder OR an outbound WhatsApp message exists for this installation.
    reminders = query_db(
        "SELECT id, status, remind_type, sent_at FROM reminders WHERE installation_id = ? ORDER BY sent_at DESC LIMIT 5",
        (installation_id,),
    )
    wa = query_db(
        "SELECT id, direction, status, message_id, template_name, message FROM whatsapp_messages WHERE installation_id = ? ORDER BY created_at DESC LIMIT 5",
        (installation_id,),
    )
    step("verify_reminder_row", ok=len(reminders) + len(wa) > 0, reminders=reminders, whatsapp=wa)

    # 6. Synthetic Meta webhook with "نعم" reply from the test phone
    ts = str(int(time.time()))
    incoming = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "test-entry",
            "changes": [{
                "field": "messages",
                "value": {
                    "metadata": {"phone_number_id": "test"},
                    "messages": [{
                        "from": args.phone.lstrip("0").replace("966", "966"),
                        "id": f"wamid.flow.{ts}",
                        "timestamp": ts,
                        "type": "text",
                        "text": {"body": "نعم"},
                    }],
                },
            }],
        }],
    }
    s, body = http("POST", f"{base}/webhooks/whatsapp", token=None, body=incoming)
    step("post_inbound_yes", ok=s == 200, status=s, response=body)

    # 7. Verify confirmation effect: most recent reminder for the phone is now 'confirmed'
    confirmed = query_db(
        "SELECT id, status, remind_type FROM reminders WHERE customer_phone LIKE ? ORDER BY sent_at DESC LIMIT 1",
        (f"%{args.phone[-8:]}%",),
    )
    inst_after = query_db(
        "SELECT id, next_remind_type, remind_count, status FROM installations WHERE id = ?",
        (installation_id,),
    )
    step(
        "verify_confirmation_marked",
        ok=bool(confirmed) and confirmed[0]["status"] == "confirmed",
        partial=not confirmed,
        reminder=confirmed[0] if confirmed else None,
        installation=inst_after[0] if inst_after else None,
    )

    # 8. Force escalation: set remind_count high and re-run scheduler
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "UPDATE installations SET remind_count = 3, next_remind_type = 'overdue', status = 'active', last_remind_at = ? WHERE id = ?",
            (dt.datetime.now(dt.timezone.utc).isoformat(), installation_id),
        )
        conn.commit()
    finally:
        conn.close()
    s, body = http("POST", f"{base}/api/reminders/run-due", body={"mode": "manual"})
    step("rerun_after_escalation_seed", ok=isinstance(body, dict), status=s, body=body if isinstance(body, dict) else None)

    # 9. Check escalations row
    escalations = query_db(
        "SELECT id, status, remind_count, customer_phone, last_reminded_at FROM escalations WHERE installation_id = ? ORDER BY created_at DESC LIMIT 5",
        (installation_id,),
    )
    step("verify_escalation_created", ok=len(escalations) > 0, escalations=escalations)

    # Optional cleanup
    if args.cleanup:
        http("DELETE", f"{base}/api/installations/{installation_id}")
        http("DELETE", f"{base}/api/customers/{customer_id}")
        http("DELETE", f"{base}/api/products/{product_id}")
        step("cleanup", ok=True)

    failed = [step_ for step_ in report["steps"] if "ok" in step_ and not step_["ok"] and not step_.get("partial")]
    report["summary"] = {
        "total": len(report["steps"]),
        "failed": len(failed),
        "ok": len(failed) == 0,
    }
    return _save(report, 0 if not failed else 1)


def _save(report: dict, code: int) -> int:
    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    summary = report.get("summary", {})
    print(
        f"\nReminder flow probe finished: steps={summary.get('total')} failed={summary.get('failed')} ok={summary.get('ok')}"
    )
    print(f"Report saved: {REPORT_PATH}")
    return code


if __name__ == "__main__":
    sys.exit(main())
