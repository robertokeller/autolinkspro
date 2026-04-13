# Setup do banco local (modo Supabase)

Este projeto usa **Supabase PostgreSQL remoto** em desenvolvimento local e em producao.

## Requisitos

- Node.js 20+ e npm
- Supabase CLI instalado
- `DATABASE_URL` configurado no ambiente local

## Setup inicial

```sh
# 1) Instalar dependencias
npm install
npm --prefix services/api install

# 2) Inicializar e linkar Supabase (uma vez por maquina/projeto)
supabase login
supabase init --force --yes
supabase link --project-ref rwurwyuhxvlnykosfkdj --yes

# 3) Aplicar migrations e seed no mesmo banco do deploy
npm run db:migrate:dev
npm run seed:dev

# 4) Subir ambiente local (OPS + API + Frontend)
npm run dev
```

URL local: `http://localhost:5173`

## Credenciais de acesso (seed)

- Admin: `robertokellercontato@gmail.com` / `SEED_ADMIN_PASSWORD`
- User: `aliancaslovely@gmail.com` / `SEED_USER_PASSWORD`

## Variaveis de ambiente minimas

- `DATABASE_URL`
- `DB_SSL=true`
- `JWT_SECRET`
- `SERVICE_TOKEN`
- `WEBHOOK_SECRET`
- `OPS_CONTROL_TOKEN`
- `OPS_CONTROL_URL=http://127.0.0.1:3115`

## Observacoes

- Não existe mais banco Docker local (`db:dev` e `db:dev:stop` sao no-op).
- O banco e compartilhado entre local e deploy; tenha cuidado com seeds/dados reais.
- Testes continuam sem depender de banco Docker.
