import os

env_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\.env"
with open(env_path, 'r') as f:
    content = f.read()

content = content.replace("ALLOW_LOCAL_AUTH=***", "ALLOW_LOCAL_AUTH=true")
content = content.replace("VITE_LOCAL_AUTH=***", "VITE_LOCAL_AUTH=true")
content = content.replace("VITE_DATA_PROVIDER=supabase", "VITE_DATA_PROVIDER=sqlite")
content = content.replace("VITE_DB_PROVIDER=supabase", "VITE_DB_PROVIDER=sqlite")

with open(env_path, 'w') as f:
    f.write(content)

print("DONE")
# Verify
for line in content.split('\n'):
    if any(x in line for x in ['DATA_PROVIDER', 'ALLOW_LOCAL', 'VITE_LOCAL']):
        print(line)
