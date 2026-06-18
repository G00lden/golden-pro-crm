import urllib.request, json

token = "TOKEN_HERE"
req = urllib.request.Request("https://api.cloudflare.com/client/v4/zones?name=breexe-pro.com")
req.add_header("Authorization", f"Bearer {token}")

resp = urllib.request.urlopen(req)
data = json.load(resp)
print(json.dumps(data, indent=2, ensure_ascii=False))
