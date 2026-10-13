# Application Development Instructions

## Application Identity

Name: coxwallet
Purpose: Personal finance transaction classification and envelope tracking
GitHub Repository: https://github.com/ccox0719/coxwallet
Supabase Project: svaozzitkajgqzacldur
Current Database Namespace: existing public prefixes/tables listed below; do not infer ownership from a generic name.

## Database Ownership

This application may modify only its own listed resources within the current task's authorization:

- `public.envelope_entries`
- `public.imports`
- `public.keyword_rules`
- `public.tax_items`
- `public.user_settings`
- `public.vendor_aliases`
- `public.vendors`

Shared or preserved resources require cross-application dependency review:

- `public.transactions`

## Database Restrictions

Do not modify resources belonging to other applications. Do not create new tables in `public` without explicit authorization. Do not rename, delete, consolidate or migrate tables merely because names look similar or record counts are zero. Preserve legacy tables until every live caller and deployment has been checked. Do not apply all existing migrations blindly: they may contain resources belonging to older applications.

## Development Rules

1. Inspect current architecture, source, migrations and production configuration before editing.
2. Confirm the exact project reference and table ownership before every database operation.
3. Preserve existing functionality and real user data; never replace it with sample data.
4. Use version-controlled migrations and keep verified scoped backups plus rollback scripts.
5. Never weaken RLS or expose service-role/secret keys in browser code.
6. Test actual API access, authorization and the affected app before declaring a deployment successful.
7. Shared resources need regression checks for every consuming app.
8. Document schema, RLS, trigger, function, publication and environment changes.
9. Distinguish local Supabase `config.toml` values from production API settings.
10. Source commit success is not production deployment success.

## Known Boundaries

`public.ingredients`, `public.recipes`, and `public.recipe_ingredients` belong to the Food Truck Business Planner. `public.meal_app_*` belongs to the legacy personal meal app. `public.family_table_*` belongs to Family Table. `public.household_members` is shared Home/Ledger identity; `public.family_members` belongs to Scholarship Planner. The financial `public.transactions` table is shared by CoxWallet and Ledger. None of these similarly named resources are interchangeable.
