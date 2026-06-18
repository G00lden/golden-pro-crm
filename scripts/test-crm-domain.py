import urllib.request, json

req = urllib.request.Request("https://crm.breexe-pro.com/api/stats")
req.add_header("Authorization", "Bearer local-dev-owner")
try:
    resp = urllib.request.urlopen(req, timeout=20)
    print(resp.status, resp.read().decode()[:200])
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode()[:200])
