-- Migration: Remove Stripe Integration
-- Drops Stripe billing/connect schema objects after integration sunset.

drop table if exists stripe_webhooks_log cascade;
drop table if exists stripe_transactions cascade;
drop table if exists stripe_subscriptions cascade;
drop table if exists stripe_customers cascade;
drop table if exists stripe_plan_mappings cascade;
drop table if exists stripe_connected_accounts cascade;
drop table if exists stripe_config cascade;
