-- Golden Pro CRM - Supabase Migration
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard/project/ebqlgtggsupsdmmeztfd/sql/new)

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- TABLE: settings (key-value per owner_uid)
-- ==========================================
CREATE TABLE IF NOT EXISTS settings (
  owner_uid TEXT PRIMARY KEY,
  created_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  techs INTEGER DEFAULT 3,
  jobs_per_tech INTEGER DEFAULT 4,
  response_rate INTEGER DEFAULT 50,
  max_daily INTEGER DEFAULT 24
);

-- ==========================================
-- TABLE: customers
-- ==========================================
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY DEFAULT 'cust_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  city TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: products
-- ==========================================
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY DEFAULT 'prod_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  interval_months INTEGER DEFAULT 1,
  category TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  remind_text TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  product_type TEXT DEFAULT 'install_maintenance',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: installations
-- ==========================================
CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY DEFAULT 'inst_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  product_id TEXT,
  product_name TEXT,
  product_sku TEXT,
  label TEXT DEFAULT '',
  install_date TEXT,
  next_maintenance TEXT,
  remind_count INTEGER DEFAULT 0,
  next_remind_type TEXT DEFAULT 'first',
  status TEXT DEFAULT 'active',
  completed_date TEXT,
  last_remind_at TIMESTAMPTZ,
  last_remind_attempt_at TIMESTAMPTZ,
  source TEXT DEFAULT 'manual',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: technicians
-- ==========================================
CREATE TABLE IF NOT EXISTS technicians (
  id TEXT PRIMARY KEY DEFAULT 'tech_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  specialty TEXT DEFAULT '',
  max_daily INTEGER DEFAULT 4,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: bookings
-- ==========================================
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY DEFAULT 'book_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  installation_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  product_id TEXT,
  product_name TEXT,
  technician_id TEXT,
  tech_name TEXT,
  date TEXT,
  scheduled_time TEXT,
  status TEXT DEFAULT 'confirmed',
  booking_type TEXT DEFAULT 'maintenance',
  source TEXT DEFAULT 'manual',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: reminders
-- ==========================================
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY DEFAULT 'rem_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  customer_id TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  installation_id TEXT,
  installation_label TEXT,
  product_name TEXT,
  remind_type TEXT,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: store_orders
-- ==========================================
CREATE TABLE IF NOT EXISTS store_orders (
  id TEXT PRIMARY KEY DEFAULT 'store_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT NOT NULL,
  store_order_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_city TEXT,
  product_name TEXT,
  product_sku TEXT,
  order_status TEXT,
  installation_status TEXT DEFAULT 'pending',
  technician_id TEXT,
  technician_name TEXT,
  booking_id TEXT,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: store_webhook_events
-- ==========================================
CREATE TABLE IF NOT EXISTS store_webhook_events (
  id TEXT PRIMARY KEY DEFAULT 'swe_' || replace(gen_random_uuid()::text, '-', ''),
  owner_uid TEXT,
  event_type TEXT,
  event_id TEXT,
  raw_body JSONB,
  processed BOOLEAN DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- TABLE: technician_notifications
-- ==========================================
CREATE TABLE IF NOT EXISTS technician_notifications (
  id TEXT PRIMARY KEY DEFAULT 'tn_' || replace(gen_random_uuid()::text, '-', ''),
  technician_id TEXT,
  technician_phone TEXT,
  booking_id TEXT,
  notification_type TEXT,
  channel TEXT DEFAULT 'whatsapp',
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- INDEXES (for performance)
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_uid);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(owner_uid);
CREATE INDEX IF NOT EXISTS idx_installations_owner ON installations(owner_uid);
CREATE INDEX IF NOT EXISTS idx_installations_next_maintenance ON installations(next_maintenance);
CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status);
CREATE INDEX IF NOT EXISTS idx_technicians_owner ON technicians(owner_uid);
CREATE INDEX IF NOT EXISTS idx_bookings_owner ON bookings(owner_uid);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_uid);
CREATE INDEX IF NOT EXISTS idx_reminders_sent_at ON reminders(sent_at);
CREATE INDEX IF NOT EXISTS idx_store_orders_owner ON store_orders(owner_uid);
CREATE INDEX IF NOT EXISTS idx_store_webhook_events_created ON store_webhook_events(created_at);
CREATE INDEX IF NOT EXISTS idx_technician_notifications_status ON technician_notifications(status);
