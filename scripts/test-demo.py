import urllib.request, json

req = urllib.request.Request("http://localhost:3000/api/demo-data")
req.add_header("Authorization", "Bearer local-dev-owner")
req.add_header("Content-Type", "application/json")
req.data = json.dumps({"count": 5}).encode()

try:
    resp = urllib.request.urlopen(req)
    print(resp.status, resp.read().decode())
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode())
