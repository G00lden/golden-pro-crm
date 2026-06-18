import urllib.request, json

token = "cfat...CC"
req = urllib.request.Request("https://api.cloudflare.com/client/v4/zones")
req.add_header("Authorization", f"Bearer {token}")
req.add_header("Content-Type", "application/json")

resp = urllib.request.urlopen(req)
data = json.load(resp)
print(f"Success: {data['success']}")
for z in data.get('result', []):
    print(f"  {z['name']}  --  {z['id']}")
if not data['result']:
    print("No zones found in this account")
