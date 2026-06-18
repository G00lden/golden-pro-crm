import re

env_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\.env"

with open(env_path, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("ALLOW_LOCAL_AUTH=*** "ALLOW_LOCAL_AUTH=*** = content.replace("VITE_LOCAL_AUTH=*** "VITE_LOCAL_AUTH=*** = content.replace("DATA_PROVIDER=supabase", "DATA_PROVIDER=sqlite")
content = content.replace("DB_PROVIDER=supabase", "DB_PROVIDER=sqlite")

with open(env_path, 'w', encoding='utf-8') as f:
    f.write(content)

for line in content.split('\n'):
    if 'LOCAL_AUTH' in line or line.startswith('DATA_PROV') or line.startswith('DB_PROV'):
        print(repr(line))
