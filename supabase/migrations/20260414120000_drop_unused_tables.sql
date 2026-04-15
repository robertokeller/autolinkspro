-- Migration: Drop unused tables
-- WARNING: This is destructive and irreversibly deletes data.
-- Only add tables here after confirming they are not used anywhere in the app.

-- Stripe integration was sunset; keep this redundant drop as a safety net for
-- environments that may have drifted or missed earlier cleanup.
DROP TABLE IF EXISTS stripe_webhooks_log CASCADE;
DROP TABLE IF EXISTS stripe_transactions CASCADE;
DROP TABLE IF EXISTS stripe_subscriptions CASCADE;
DROP TABLE IF EXISTS stripe_customers CASCADE;
DROP TABLE IF EXISTS stripe_plan_mappings CASCADE;
DROP TABLE IF EXISTS stripe_connected_accounts CASCADE;
DROP TABLE IF EXISTS stripe_config CASCADE;

-- Not referenced by API/frontend code; created as a future-proof idempotency
-- store, but currently unused. Dropping reduces schema surface area.
DROP TABLE IF EXISTS rpc_idempotency_keys CASCADE;

