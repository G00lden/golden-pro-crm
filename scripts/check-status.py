import urllib.request, json

# Test multiple ways
base = "http://localhost:3000"

# 1. Salla status
req = urllib.request.Request(f"{base}/api/integrations/salla/status")
req.add_header("Authorization", "Bearer local-dev-owner")
try:
    resp = urllib.request.urlopen(req, timeout=10)
    print("SALLA STATUS:", resp.read().decode()[:500])
except urllib.error.HTTPError as e:
    print(f"SALLA STATUS HTTP {e.code}: {e.read().decode()[:200]}")

# 2. Health (no auth needed)
req2 = urllib.request.Request(f"{base}/api/health")
try:
    resp2 = urllib.request.urlopen(req2, timeout=10)
    print("HEALTH:", resp2.read().decode()[:500])
except Exception as e:
    print(f"HEALTH Error: {e}")
