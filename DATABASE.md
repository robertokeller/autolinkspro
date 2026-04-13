# Database Schema - Auto Links

Este projeto usa **Supabase PostgreSQL** como banco unico para local e producao.

## Persistence model

- Backend: Express API em `services/api/` (porta 3116).
- Migrations: `supabase/migrations/*.sql` (inclui RLS + policies).
- Seed: `scripts/seed-users.mjs`.
- Auth de aplicacao: JWT via cookie `HttpOnly` (backend proprio).

## Security model

- Todas as tabelas de negocio em `public` estao com `ROW LEVEL SECURITY` e `FORCE ROW LEVEL SECURITY`.
- Isolamento por usuario (`user_id`) + policies parent-scoped para tabelas de ligacao.
- Bloqueio de escalonamento de privilegio:
  - trigger `protect_user_roles_mutation()` impede alteracao de `user_roles` por usuario comum.
  - trigger `protect_profile_privileged_columns()` impede self-upgrade de plano/admin.
- Tabelas administrativas e de runtime possuem policies admin-only.

## Main tables

- `users`
- `profiles`
- `user_roles`
- `groups`
- `master_groups`
- `master_group_links`
- `routes`
- `route_destinations`
- `templates`
- `scheduled_posts`
- `scheduled_post_destinations`
- `history_entries`
- `link_hub_pages`
- `shopee_automations`
- `meli_sessions`
- `api_credentials`
- `admin_audit_logs`
- `system_announcements`
- `user_notifications`
- `app_runtime_flags`
- `system_settings`
- `runtime_rate_limits`
- `rpc_idempotency_keys`

## Seed users (dev)

- Admin: `robertokellercontato@gmail.com` / `SEED_ADMIN_PASSWORD`
- User: `aliancaslovely@gmail.com` / `SEED_USER_PASSWORD`

O seed e idempotente e roda via `npm run seed:dev`.
