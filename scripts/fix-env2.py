import os

env_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\.env"
with open(env_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

# Fix ALLOW_LOCAL_AUTH line
lines = content.split('\n')
fixed = []
for line in lines:
    if line.startswith('ALLOW_LOCAL_AUTH=') and 'true' not in line:
        fixed.append('ALLOW_LOCAL_AUTH=true')
    elif line.startswith('VITE_LOCAL_AUTH=') and 'true' not in line:
        fixed.append('VITE_LOCAL_AUTH=true')
    else:
        fixed.append(line)

result = '\n'.join(fixed)
with open(env_path, 'w', encoding='utf-8') as f:
    f.write(result)

print("Fixed!")
# Confirm
for l in result.split('\n'):
    if 'LOCAL_AUTH' in l:
        print(l)
