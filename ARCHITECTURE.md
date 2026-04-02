# Architecture - Auto Links

System architecture reference.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State | TanStack React Query + hooks |
| Routing | React Router v6 |
| Backend API | Node.js + Express (`services/api/`, porta 3116) |
| Database | Supabase PostgreSQL (mesmo banco para local + produção) |
| Auth | JWT (bcrypt + jsonwebtoken) |
| Integrations | HTTP RPC via `backend.functions.invoke` → `services/api/` |

## Main Flow

1. Frontend autentica via `POST /auth/sign-in` → sessão emitida pelo backend.
2. JWT de autenticação é transportado via cookie `HttpOnly` (não via `localStorage`).
3. Cliente mantém apenas estado de sessão em memória de runtime.
4. Todas as queries e mutations passam pelo Express API (`/api/rest/`, `/functions/v1/`).
5. Dados de negócio (sessões, grupos, rotas, automações, planos) são persistidos no Supabase PostgreSQL.
6. Microserviços (WhatsApp, Telegram, Shopee, MercadoLivre, Ops) rodam em portas separadas e comunicam via HTTP.

## Key Modules

- `src/integrations/backend/client.ts`: fachada HTTP usada por toda a app (dev + produção).
- `src/integrations/backend/local-core.ts`: helpers para admin config, sobrescreve cache via backend.
- `src/integrations/backend/_local-core-legacy.ts`: banco in-memory usado **exclusivamente em testes Vitest**.
- `services/api/src/index.ts`: servidor Express, auth JWT, REST, RPC.
- `supabase/migrations/*.sql`: schema + políticas de segurança (RLS/policies), versionadas.

## Modos de operação

| Modo | Backend | Banco |
| --- | --- | --- |
| `npm run test` | In-memory (legado, sem HTTP) | Nenhum (mock) |
| `npm run dev` | API HTTP (`localhost:3116`) | Supabase PostgreSQL remoto |
| Produção (Coolify) | API HTTP (domínio configurado) | Mesmo Supabase PostgreSQL remoto |

## Admin padrão (primeiro boot)

- Email: `robertokellercontato@gmail.com`
- Criado automaticamente por `seedAdminIfEmpty()` em `services/api/src/index.ts`
