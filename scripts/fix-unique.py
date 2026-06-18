import sqlite3

conn = sqlite3.connect(r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\data\golden-crm.db")
c = conn.cursor()

# Fix: make email non-unique by recreating table
c.executescript("""
CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    uid TEXT,
    name TEXT NOT NULL DEFAULT '',
    email TEXT,
    phone TEXT DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT DEFAULT 'user',
    permissions TEXT DEFAULT '{}',
    active INTEGER DEFAULT 1,
    provider TEXT DEFAULT 'firebase',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT
);

INSERT INTO users_new SELECT * FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL AND uid <> '';
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
""")

print("Migration complete")
for r in c.execute("SELECT id, uid, email, role FROM users"):
    print(f"  {r[0][:20]:20s} | {str(r[1] or '-')[:20]:20s} | {str(r[2] or '-')[:25]:25s} | {r[3]}")

conn.commit()
conn.close()
