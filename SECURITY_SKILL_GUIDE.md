# Como usar /security

## Ativação rápida

Use diretamente no chat do Copilot:

```
/security revisar autenticação em services/api/src/auth.ts
```

## Exemplos práticos

### 1. Revisar autenticação
```
/security A função signin usa bcrypt com custo >= 12?
/security JWT está usando RS256 ou HS256?
/security Há blacklist de tokens invalidados?
```

### 2. SQL Injection
```
/security SQL injection em services/api/src/database/
/security Queries são parametrizadas ou concatenadas?
```

### 3. Segurança de produção
```
/security checklist completo de segurança para produção
/security headers de segurança estão configurados? (CSP, HSTS, etc)
```

### 4. Dependências
```
/security vulnerabilidades em dependências do package.json
/security npm audit - quais vulnerabilidades críticas?
```

### 5. Secrets e credenciais
```
/security Como estamos armazenando secrets em produção?
/security .env está no .gitignore?
```

### 6. OWASP Top 10
```
/security auditoria OWASP Top 10 em services/api/
/security CSRF protection está implementada?
/security Rate limiting em endpoints de login?
```

## O que a skill cobre

✅ **Autenticação**  
- Senhas (bcrypt, Argon2, custo)
- JWT (RS256, exp, refresh tokens)
- OAuth/SSO
- 2FA/TOTP

✅ **Database**  
- SQL Injection
- Parametrização de queries
- Princípio do menor privilégio
- Criptografia de dados sensíveis

✅ **Web Security**  
- OWASP Top 10
- XSS, CSRF
- Headers de segurança
- Rate limiting

✅ **Dependências**  
- Vulnerabilidades em pacotes
- Supply chain attacks
- Audit de dependências

✅ **Desktop (Electron)**
- Context isolation
- IPC seguro
- Code signing
- Auto-updates

## Se não funcionar

1. **Feche VS Code completamente**
2. **Reabra a pasta do projeto**
3. **Tente novamente**

Se ainda não aparecer como autocomplete, use:
```
revise vulnerabilidades de segurança em [arquivo]
```

A skill será ativada automaticamente pelo contexto.
