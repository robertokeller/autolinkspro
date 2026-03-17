# Setup do banco de dados local (desenvolvimento)

Este projeto usa PostgreSQL para todos os dados. Nenhum dado de negócio fica em localStorage.

## Requisitos

- Node.js 20+ e npm
- Docker Desktop (para subir o PostgreSQL local)

## Subindo o banco local

```sh
# 1. Sobe PostgreSQL local (porta 5432)
npm run db:dev

# 2. Instala dependências (primeira vez)
npm install
npm --prefix services/api install

# 3. Inicia tudo (OPS + API + Frontend)
npm run dev
```

URL: `http://localhost:5173`

## Credenciais de acesso (admin)

- E-mail: `robertokellercontato@gmail.com`
- Senha: `abacate1`

> Em ambiente local, o usuário é semeado pelas migrations/scripts SQL (`database/migrations/006_seed_users.sql` e `scripts/seed-users.mjs`) com senha `abacate1`.
> A função `seedAdminIfEmpty()` em `services/api/src/index.ts` só cria admin quando a tabela `users` está vazia e `ADMIN_PASSWORD` está definido.

## Variáveis de ambiente em dev

O script `svc:api:dev` já injeta as vars de Postgres local automaticamente. Não é necessário criar `.env` para dev.

## Parar o banco

```sh
npm run db:dev:stop
```

## Observações

- Dados persistem entre reinicializações via volume Docker `postgres_dev_data`.
- Para resetar o banco do zero: `docker volume rm autolinks-codex_postgres_dev_data`
- Testes rodam sem Docker (banco in-memory mock).
