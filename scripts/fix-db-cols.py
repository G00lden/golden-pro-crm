import sqlite3, os

db_path = r"C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2\data\golden-crm.db"
conn = sqlite3.connect(db_path)
c = conn.cursor()

# Check all columns
cols = [r[1] for r in c.execute("PRAGMA table_info(store_webhook_events)")]
print("Current columns:", cols)

# Add missing columns
missing = []
for col in ["received_at", "order_id", "order_number", "provider", "status", "imported"]:
    if col not in cols:
        missing.append(col)
        c.execute(f"ALTER TABLE store_webhook_events ADD COLUMN {col} TEXT")
        
if missing:
    print(f"Added columns: {missing}")
else:
    print("All columns already exist")

# Also check for order_id in store_orders
cols2 = [r[1] for r in c.execute("PRAGMA table_info(store_orders)")]
for col in ["store_order_id", "customer_name", "customer_phone", "product_name", "product_sku", "installation_status"]:
    if col not in cols2:
        print(f"store_orders missing: {col}")

cols3 = [r[1] for r in c.execute("PRAGMA table_info(store_webhook_events)")]
print(f"Final columns: {cols3}")

conn.commit()
conn.close()
print("Done")
