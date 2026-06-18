import urllib.request, json, os

token = os.environ.get("CF_TOKEN", "cfat...")

# Get all zones
req = urllib.request.Request("https://api.cloudflare.com/client/v4/zones?name=breexe-pro.com")
req.add_header("Authorization", f"Bearer {token}")
try:
    resp = urllib.request.urlopen(req)
    data = json.load(resp)
    print(json.dumps(data, indent=2))
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode())
