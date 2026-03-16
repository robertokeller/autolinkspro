# Database Schema - Auto Links

Este projeto usa **PostgreSQL 16** como banco de dados. Não há dados de negócio em localStorage.

## Persistence model

- Backend: Express API em `services/api/` (porta 3116).
- Schema: `database/init.sql` — idempotente, aplicado automaticamente no primeiro boot via Docker.
- Auth: JWT (bcryptjs + jsonwebtoken) via cookie `HttpOnly`; o cliente mantém somente estado de sessão em memória (sem persistir dados de negócio em `localStorage`).
- Em testes (Vitest): banco in-memory via `_local-core-legacy.ts` (somente `MODE === "test"`).

## Main tables

- `profiles`
- `user_roles`
- `whatsapp_sessions`
- `telegram_sessions`
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

## Access model

- User isolation by `user_id` is applied in the local query layer.
- Linking tables (`master_group_links`, `route_destinations`, `scheduled_post_destinations`) are scoped by parent ownership.
- Admin can read/manage all data through admin routes/functions.

## Seed users

### Admin
- Email: `robertokellercontato@gmail.com` (override: `VITE_DEMO_ADMIN_EMAIL`)
- Password: `abacate1`
- Role: `admin` · Plan: `plan-pro`

### User
- Email: `aliancaslovely@gmail.com` (override: `VITE_DEMO_USER_EMAIL`)
- Password: `abacate1`
- Role: `user` · Plan: `plan-starter`

> Fonte local dos seeds: `database/migrations/006_seed_users.sql` e `scripts/seed-users.mjs`.

> Emails legados (`admin@autolinks.local`, `cliente@autolinks.local`, `admin@demo.autolinks.local`,
> `usuario@demo.autolinks.local`) estão em `LEGACY_REMOVED_EMAILS`; no primeiro `loadDb()` qualquer
> dado de admin legado é **re-parented para o admin atual** antes da exclusão (sem perda de dados).
