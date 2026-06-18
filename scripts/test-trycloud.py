import urllib.request, json

req = urllib.request.Request("https://plenty-alien-constructed-firmware.trycloudflare.com/api/stats")
req.add_header("Authorization", "Bearer local-dev-owner")
try:
    resp = urllib.request.urlopen(req, timeout=15)
    print(f"Status: {resp.status}")
    print(resp.read().decode())
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode()[:300])
