# Cloud-Only Supabase Plan (No Local Persistence)

## Goal
Move all app data persistence to Supabase and remove any browser-local data storage behavior for app/business data.

## Scope
Codebase audited:
- `budget-app.jsx`
- `supabase-setup.sql`

This plan covers:
- Required Supabase schemas/tables
- Required DB functions/triggers/policies/indexes
- App changes to remove local persistence paths
- Migration/rollout order

---

## 1. Current Data Audit (What persists today)

## 1.1 Already persisted in Supabase
- `transactions` table
  - Reads: app load (`select ... eq(user_id)`).
  - Writes: add, edit category, edit description, delete, CSV import.
- `tax_items` table
  - Reads: app load (`select * ... order(sort_order)`).
  - Writes: add, update, delete.
- `user_settings` table
  - Reads: app load (`select * ... maybeSingle()`).
  - Writes:
    - `saveSettings()` updates `budgets`, `income`, `keywords`, `envelope_category_ids`, `sub_budgets`.
    - `updateKids()` updates `kids_data`.

## 1.2 Local persistence still present
- Auth session token is stored in browser `localStorage` by custom client:
  - key: `sb-auth-token`
  - methods: `_readSession`, `_writeSession`
  - impact: session survives refresh without server cookies.

## 1.3 In-memory only (not persisted anywhere)
- `importPreview` (CSV staging/review before import).
- Active UI-only states (filters, selected tab, editor modes, etc.).

These are not local-storage persisted; they reset on reload.

---

## 2. Hard Requirement Clarification: “No local on anything”

In a pure Vite SPA (no backend), Supabase Auth session persistence normally uses local storage (or memory).

If you require strict “no local storage at all,” you need one of these models:
1. Server-managed auth cookies (HttpOnly) via a backend/BFF.
2. Non-persistent in-memory session only (user logs out on refresh).

Recommended: server-managed HttpOnly cookies if strict policy is required.

---

## 3. Supabase Schema Required for Full Cloud Data

Your current `supabase-setup.sql` is close. Keep these core tables:
- `transactions`
- `tax_items`
- `user_settings`

Add/ensure the following DB objects.

## 3.1 Tables
Already present and required:
- `transactions`
- `tax_items`
- `user_settings`

Optional normalization (future, not required now):
- Replace `user_settings.kids_data` JSONB with:
  - `kids_profiles`
  - `kids_chores`
  - `kids_history`
This improves queryability and integrity but is not mandatory for cloud-only persistence.

## 3.2 Indexes
Keep:
- `idx_tx_user_date` on `(user_id, date desc)`
- `idx_tax_user_order` on `(user_id, sort_order)`

Add recommended:
- `idx_tx_user_type_date` on `transactions(user_id, type, date desc)`
- `idx_tx_user_category_date` on `transactions(user_id, category, date desc)`

## 3.3 Constraints
Keep:
- `transactions.amount >= 0`
- `transactions.type in ('expense','income')`
- `tax_items.status in ('pending','ready','na')`
- `user_settings.income >= 0`

Recommended:
- `transactions.source in ('manual','csv')`
- `transactions.category` check against allowed category list if you want strict data hygiene.

## 3.4 Triggers & Functions
Already present:
- `touch_updated_at()` trigger function for `user_settings`.

Add required:
1. `ensure_user_settings_row()` function + trigger on `auth.users`
   - On user creation, auto-insert default row in `user_settings`.
   - Removes first-login race and client-side seeding responsibility.
2. `touch_updated_at` trigger for `transactions` and `tax_items` only if you add `updated_at` columns there.
3. Optional RPC for transactional operations:
   - e.g., `rpc_replace_keywords(jsonb)` or `rpc_upsert_settings(...)`
   - useful if you want server-side validation and one-call consistency.

## 3.5 RLS Policies
Keep current “owner only” policies on all three tables:
- `auth.uid() = user_id` for `USING` and `WITH CHECK`.

Add policy hygiene:
- Explicit `SELECT`, `INSERT`, `UPDATE`, `DELETE` policies (instead of one `FOR ALL`) if you want tighter auditing clarity.

---

## 4. App Functions That Must Stay Cloud-Backed

These app functions already write to Supabase and should remain authoritative:
- Settings:
  - `saveSettings(...)`
  - `updateKids(...)`
- Transactions:
  - `addTransactionDirect(...)`
  - `addTransaction(...)`
  - `confirmImport(...)`
  - `updateCategory(...)`
  - `updateTransactionDesc(...)`
  - `deleteTransaction(...)`
- Tax items:
  - `updateTaxItem(...)`
  - `addTaxItem(...)`
  - `deleteTaxItem(...)`

Load path that must remain source-of-truth:
- Startup `useEffect` that loads:
  - `user_settings`
  - `transactions`
  - `tax_items`

---

## 5. Changes Needed to Eliminate Local Persistence

## 5.1 Remove custom localStorage auth storage
Current custom client uses:
- `_readSession()` -> localStorage
- `_writeSession()` -> localStorage

Replace with one of:
1. **Recommended strict solution**: backend-managed HttpOnly cookie auth.
2. **No storage fallback**: in-memory session only (no refresh persistence).

## 5.2 Keep non-persistent UI state in memory
No change needed for:
- import preview
- selected filters/view mode
- transient form state

These are not local persistence.

## 5.3 Remove any future accidental local writes
Add lint rule/check:
- ban `localStorage`/`sessionStorage` usage outside explicitly approved auth adapter.

---

## 6. SQL/Infra Plan (Execution Order)

1. Run clean setup (`supabase-setup.sql`).
2. Add migration SQL for:
   - `ensure_user_settings_row()` function + trigger on `auth.users`.
   - optional indexes listed above.
   - optional stricter constraints.
3. Verify RLS with test user:
   - can only read/write own rows.
4. Backfill/seed:
   - if needed, insert `user_settings` rows for existing users missing one.

---

## 7. App Migration Plan (Execution Order)

1. Replace custom Supabase client auth persistence model:
   - remove localStorage token handling.
   - implement chosen auth strategy (cookie-backed or in-memory).
2. Remove first-login client insert of `user_settings` once DB trigger exists.
3. Keep all existing Supabase CRUD calls; add error handling/retries where missing.
4. Add smoke tests:
   - new user gets seeded settings automatically.
   - transaction create/update/delete reflected after reload.
   - kids ledger updates survive reload.
   - tax items survive reload.
5. Add “offline disabled” UX messaging:
   - if network unavailable, show save failure and keep unsaved badge.

---

## 8. Validation Checklist (Cloud-Only)

Pass criteria:
- Reload browser: all finance/tax/kids data restored from Supabase.
- New incognito session: no app data without login.
- No `localStorage` keys except those intentionally allowed for auth (or none if strict mode).
- Deleting local browser storage does not lose cloud data.
- RLS blocks cross-user reads/writes.

---

## 9. Recommended Next Deliverables

1. `supabase-migration-cloud-auth.sql`
   - `ensure_user_settings_row` trigger/function
   - optional indexes/constraints
2. `auth-refactor-plan.md`
   - choose cookie-based vs in-memory-only auth strategy
3. App PR
   - remove localStorage session code path
   - keep data CRUD cloud-only

