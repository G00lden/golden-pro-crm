import os

env_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\.env"
with open(env_path, 'r', encoding='utf-8-sig') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    stripped = line.strip()
    if stripped == "ALLOW_LOCAL_AUTH=***":
        new_lines.append("ALL...ue\n")
    elif stripped == "VITE_LOCAL_AUTH=***":
        new_lines.append("VITE_LOCAL_AUTH=***   else:
        new_lines.append(line)

with open(env_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Fixed")
# Verify
for l in new_lines:
    if 'LOCAL_AUTH' in l:
        print(l.strip())
