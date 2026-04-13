# Available Agents

## /security
Auditor de vulnerabilidades de segurança para aplicações web, APIs e infraestrutura.

Ativacao padrao recomendada:
- Em qualquer tarefa de banco de dados, logins, autenticacao/autorizacao, secrets, credenciais, API, webhooks, upload, deploy e cloud.
- Sempre de forma modular: carregar apenas os modulos necessarios para o escopo (com baseline obrigatorio).

**Exemplos de uso:**
```
@security revisar autenticação com JWT
@security SQL injection em database queries
@security checklist de segurança para produção
@security vulnerabilidades OWASP em services/api/src
```

**Cobertura:**
- ✅ Autenticação (senhas, JWT, OAuth, 2FA)
- ✅ SQL Injection e queries parametrizadas
- ✅ XSS, CSRF, headers de segurança
- ✅ Gestão de secrets e credenciais
- ✅ Dependências vulneráveis
- ✅ Segurança em Electron/Desktop
- ✅ Rate limiting e validação de input
- ✅ Selecao modular por tema (baseline + modulos relevantes)

## /scalability  
Otimização de performance, APIs, banco de dados e infraestrutura.

## /postgres
PostgreSQL e Supabase: queries, indexes, schema design e performance.
