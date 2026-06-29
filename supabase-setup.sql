-- ═══════════════════════════════════════════════════════════════════════════════
-- THE LEDGER — Complete Supabase Setup SQL (DESTRUCTIVE)
-- Run this only for first-time setup or intentional full reset.
-- It drops app tables and deletes cloud data.
--
-- For normal schema updates without data loss, use:
--   supabase-migrations-safe.sql
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── CLEAN SLATE (safe to re-run) ─────────────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_new_user_settings      ON auth.users;
DROP TRIGGER  IF EXISTS trg_user_settings_updated_at ON user_settings;
DROP FUNCTION IF EXISTS ensure_user_settings_row();
DROP FUNCTION IF EXISTS touch_updated_at();
DROP TABLE    IF EXISTS transactions  CASCADE;
DROP TABLE    IF EXISTS tax_items     CASCADE;
DROP TABLE    IF EXISTS user_settings CASCADE;


-- ─── 1. TRANSACTIONS ──────────────────────────────────────────────────────────
CREATE TABLE transactions (
  id          TEXT            NOT NULL,
  user_id     UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        TEXT            NOT NULL,
  description TEXT            NOT NULL DEFAULT '',
  amount      NUMERIC(12, 2)  NOT NULL DEFAULT 0 CHECK (amount >= 0),
  type        TEXT            NOT NULL DEFAULT 'expense'
                              CHECK (type IN ('expense', 'income')),
  category    TEXT            NOT NULL DEFAULT 'other',
  source         TEXT            NOT NULL DEFAULT 'manual'
                               CHECK (source IN ('manual', 'csv')),
  split_group_id TEXT,
  vendor_split_vendor_key TEXT,
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, user_id)
);

-- Index: fast date-sorted queries per user (most common access pattern)
CREATE INDEX idx_tx_user_date
  ON transactions (user_id, date DESC);

-- Index: filter by type within a user (income vs expense summaries)
CREATE INDEX idx_tx_user_type_date
  ON transactions (user_id, type, date DESC);

-- Index: filter by category within a user (category breakdowns)
CREATE INDEX idx_tx_user_category_date
  ON transactions (user_id, category, date DESC);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tx_select"  ON transactions FOR SELECT  USING     (auth.uid() = user_id);
CREATE POLICY "tx_insert"  ON transactions FOR INSERT  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tx_update"  ON transactions FOR UPDATE  USING     (auth.uid() = user_id)
                                                       WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tx_delete"  ON transactions FOR DELETE  USING     (auth.uid() = user_id);


-- ─── 2. TAX ITEMS ─────────────────────────────────────────────────────────────
-- NOTE: "group" is a reserved word in PostgreSQL, so we use "grp".
--       The app maps grp <-> group transparently on every read/write.

CREATE TABLE envelope_entries (
  id          TEXT            NOT NULL,
  user_id     UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        TEXT            NOT NULL,
  category    TEXT            NOT NULL DEFAULT 'other',
  description TEXT            NOT NULL DEFAULT '',
  amount      NUMERIC(12, 2)  NOT NULL DEFAULT 0 CHECK (amount >= 0),
  type        TEXT            NOT NULL DEFAULT 'expense'
                              CHECK (type IN ('expense', 'income')),
  source      TEXT            NOT NULL DEFAULT 'envelope',
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, user_id)
);

CREATE INDEX idx_envelope_user_date
  ON envelope_entries (user_id, date DESC);

ALTER TABLE envelope_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "envelope_select" ON envelope_entries FOR SELECT  USING     (auth.uid() = user_id);
CREATE POLICY "envelope_insert" ON envelope_entries FOR INSERT  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "envelope_update" ON envelope_entries FOR UPDATE  USING     (auth.uid() = user_id)
                                                            WITH CHECK (auth.uid() = user_id);
CREATE POLICY "envelope_delete" ON envelope_entries FOR DELETE  USING     (auth.uid() = user_id);


CREATE TABLE tax_items (
  id          TEXT        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grp         TEXT        NOT NULL DEFAULT 'Other',
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'ready', 'na')),
  notes       TEXT        NOT NULL DEFAULT '',
  source      TEXT        NOT NULL DEFAULT 'Records',
  custom      BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, user_id)
);

-- Index: ordered queries per user
CREATE INDEX idx_tax_user_order
  ON tax_items (user_id, sort_order);

ALTER TABLE tax_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tax_select" ON tax_items FOR SELECT  USING     (auth.uid() = user_id);
CREATE POLICY "tax_insert" ON tax_items FOR INSERT  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tax_update" ON tax_items FOR UPDATE  USING     (auth.uid() = user_id)
                                                    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tax_delete" ON tax_items FOR DELETE  USING     (auth.uid() = user_id);


-- ─── 3. USER SETTINGS ─────────────────────────────────────────────────────────
-- One row per user. Budgets, keywords, envelope config, and kids are JSONB.
-- Transactions and tax items live in their own tables for proper queryability.

CREATE TABLE user_settings (
  user_id               UUID           PRIMARY KEY
                                        REFERENCES auth.users(id) ON DELETE CASCADE,
  income                NUMERIC(12, 2) NOT NULL DEFAULT 9664 CHECK (income >= 0),
  budgets               JSONB          NOT NULL DEFAULT '{}',
  keywords              JSONB          NOT NULL DEFAULT '{}',
  manual_review_keywords JSONB         NOT NULL DEFAULT '[]',
  envelope_category_ids JSONB          NOT NULL DEFAULT '[]',
  envelope_entries      JSONB          NOT NULL DEFAULT '[]',
  sub_budgets           JSONB          NOT NULL DEFAULT '{}',
  kids_data             JSONB          NOT NULL DEFAULT '[]',
  vendor_matrix         JSONB          NOT NULL DEFAULT '{}',
  travel_days           JSONB          NOT NULL DEFAULT '[]',
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "settings_select" ON user_settings FOR SELECT  USING     (auth.uid() = user_id);
CREATE POLICY "settings_insert" ON user_settings FOR INSERT  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "settings_update" ON user_settings FOR UPDATE  USING     (auth.uid() = user_id)
                                                             WITH CHECK (auth.uid() = user_id);
CREATE POLICY "settings_delete" ON user_settings FOR DELETE  USING     (auth.uid() = user_id);


-- ─── 4. TRIGGERS ──────────────────────────────────────────────────────────────

-- Auto-update updated_at whenever user_settings row changes
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- Auto-create a user_settings row the moment a new auth user signs up.
-- SECURITY DEFINER runs as the function owner (postgres), bypassing RLS,
-- so the insert succeeds even before the user has a JWT session.
-- ON CONFLICT DO NOTHING makes this safe to re-fire (e.g. email confirmation).
CREATE OR REPLACE FUNCTION ensure_user_settings_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_new_user_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION ensure_user_settings_row();


-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. After running this SQL, follow the dashboard checklist below.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- DASHBOARD CHECKLIST (do these once in the Supabase UI)
-- ─────────────────────────────────────────────────────
--
-- 1. PROJECT SETTINGS → API
--    Copy "Project URL" and "anon public" key into budget-app.jsx lines 6-7.
--
-- 2. AUTHENTICATION → URL CONFIGURATION
--    Set "Site URL" to where your app is hosted.
--    Examples:
--      Dev:  http://localhost:5173
--      Prod: https://yourdomain.com
--    Also add that URL to "Redirect URLs" in the same section.
--    (Required for magic links to redirect back to the app.)
--
-- 3. AUTHENTICATION → PROVIDERS → EMAIL
--    - "Enable Email provider": ON  (should be on by default)
--    - "Confirm email": turn OFF for quick setup, or leave ON for security.
--      If ON, new sign-ups receive a confirmation email before they can log in.
--    - "Secure email change": ON (good default)
--
-- 4. AUTHENTICATION → USERS (optional manual setup)
--    Click "Add user → Create new user" to manually create your account.
--    This skips the email confirmation flow entirely.
--
-- 5. NO EDGE FUNCTIONS NEEDED.
--    The app talks directly to the database via the REST API.
--    All security is enforced by the RLS policies above.
--
-- 6. NO REALTIME NEEDED.
--    The app is fully pull-based (queries on load/action).
--    No live subscriptions are used.
--
-- ─── WHAT THE ensure_user_settings_row TRIGGER DOES ──────────────────────────
-- When a new user signs up (via password or magic link), Supabase inserts a row
-- into auth.users. This trigger fires immediately after that insert and creates
-- a corresponding user_settings row with all defaults. This means:
--   • The client-side upsert on first load always hits ON CONFLICT DO NOTHING
--     rather than needing to race to create the row.
--   • No edge function or server-side code needed — it's all in the database.
