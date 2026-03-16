-- Wipe app data only (keeps tables, policies, and auth users)
-- Run in Supabase SQL Editor

BEGIN;

-- Clear existing app data
TRUNCATE TABLE transactions, tax_items, user_settings;

COMMIT;

-- Optional sanity check
SELECT 'transactions' AS table_name, COUNT(*) AS row_count FROM transactions
UNION ALL
SELECT 'tax_items' AS table_name, COUNT(*) AS row_count FROM tax_items
UNION ALL
SELECT 'user_settings' AS table_name, COUNT(*) AS row_count FROM user_settings;
