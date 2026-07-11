"""Obtain a short-lived local token for loopback-only test scripts."""

from __future__ import annotations

import json
import os
from urllib import request


def get_local_test_token(base_url: str, uid: str) -> str:
    supplied = os.environ.get("CRM_BEARER_TOKEN", "").strip()
    if supplied:
        return supplied

    payload = json.dumps({"uid": uid}).encode("utf-8")
    req = request.Request(
        f"{base_url.rstrip('/')}/api/dev/local-token",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with request.urlopen(req, timeout=10) as response:
            token = json.loads(response.read().decode("utf-8")).get("token", "")
    except Exception as exc:
        raise RuntimeError(
            "Could not obtain a signed local test token. Run a non-production "
            "loopback server with ALLOW_LOCAL_AUTH=true and a 32+ character LOCAL_AUTH_TOKEN."
        ) from exc
    if not token:
        raise RuntimeError("The local test-token endpoint returned no token.")
    return str(token)
