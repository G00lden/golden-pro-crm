import json, os, sys, urllib.request, urllib.error

env_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\.env"
env = {}
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

url = env.get("SUPABASE_URL", "").strip()
key = env.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

print(f"URL from env: [{url[:40]}...]")
print(f"Key length: {len(key)}")

# Test basic connectivity
import socket
try:
    host = url.replace("https://", "").split("/")[0]
    ip = socket.gethostbyname(host)
    print(f"DNS resolved: {host} -> {ip}")
except Exception as e:
    print(f"DNS error: {e}")
    sys.exit(1)

# Try API
req = urllib.request.Request(f"{url}/rest/v1/")
req.add_header("apikey", key)
req.add_header("Authorization", f"Bearer {key}")
try:
    resp = urllib.request.urlopen(req, timeout=10)
    body = resp.read().decode()
    print(f"Status: {resp.status}, Body: {body[:200]}")
except urllib.error.HTTPError as e:
    print(f"HTTP Error: {e.code} - {e.read().decode()[:200]}")
except Exception as e:
    print(f"Error: {e}")
