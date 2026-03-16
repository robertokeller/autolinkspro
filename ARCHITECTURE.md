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
| Database | PostgreSQL 16 (Docker em dev, Coolify em produção) |
| Auth | JWT (bcrypt + jsonwebtoken) |
| Integrations | HTTP RPC via `backend.functions.invoke` → `services/api/` |

## Main Flow

1. Frontend autentica via `POST /auth/sign-in` → sessão emitida pelo backend.
2. JWT de autenticação é transportado via cookie `HttpOnly` (não via `localStorage`).
3. Cliente mantém apenas estado de sessão em memória de runtime.
4. Todas as queries e mutations passam pelo Express API (`/api/rest/`, `/functions/v1/`).
5. Dados de negócio (sessões, grupos, rotas, automações, planos) são persistidos no PostgreSQL.
6. Microserviços (WhatsApp, Telegram, Shopee, MercadoLivre, Ops) rodam em portas separadas e comunicam via HTTP.

## Key Modules

- `src/integrations/backend/client.ts`: fachada HTTP usada por toda a app (dev + produção).
- `src/integrations/backend/local-core.ts`: helpers para admin config, sobrescreve cache via PostgreSQL.
- `src/integrations/backend/_local-core-legacy.ts`: banco in-memory usado **exclusivamente em testes Vitest**.
- `services/api/src/index.ts`: servidor Express, auth JWT, REST, RPC.
- `database/init.sql`: schema PostgreSQL completo, idempotente.

## Modos de operação

| Modo | Backend | Banco |
| --- | --- | --- |
| `npm run test` | In-memory (legado, sem HTTP) | Nenhum (mock) |
| `npm run dev` | API HTTP (`localhost:3116`) | PostgreSQL local (Docker) |
| Produção (Coolify) | API HTTP (domínio configurado) | PostgreSQL gerenciado |

## Admin padrão (primeiro boot)

- Email: `robertokellercontato@gmail.com`
- Criado automaticamente por `seedAdminIfEmpty()` em `services/api/src/index.ts`
