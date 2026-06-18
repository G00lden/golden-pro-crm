import urllib.request, json

req = urllib.request.Request("http://localhost:3000/api/me")
req.add_header("Authorization", "Bearer local-dev-owner")
try:
    resp = urllib.request.urlopen(req, timeout=10)
    print(resp.read().decode()[:500])
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()[:300]}")
