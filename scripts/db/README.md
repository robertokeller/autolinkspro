Scripts para inventário, backup e remoção segura de tabelas

Recomendação: sempre revisar FK e fazer backup antes de dropar tabelas.

Files:
- inventory_tables.sql: lista tabelas com estimativa de linhas e tamanho.
- find_fk_references.sql: procura FKs que referenciam ou são referenciadas por uma tabela (use psql -v tbl='stripe').
- backup_and_prepare_drop.sh: faz pg_dump da tabela e gera um arquivo drop_*.sql com o DROP comentado.
- drop_table_safe.sql: template para executar o DROP após revisão.

Exemplos:

1) Inventário das tabelas
```bash
psql "postgresql://user:pass@host:5432/dbname" -f scripts/db/inventory_tables.sql
```

2) Verificar referências à tabela `stripe`
```bash
psql -v tbl='stripe' -f scripts/db/find_fk_references.sql
```

3) Gerar backup e drop preparado
```bash
DB_URL="postgresql://user:pass@host:5432/dbname" ./scripts/db/backup_and_prepare_drop.sh stripe
# revise drop_stripe.sql e somente depois execute (após confirmar backup)
```

Procedimento seguro sugerido:
1. Rodar `inventory_tables.sql` para identificar candidates com 0 linhas ou pequenas filas.
2. Para cada candidate, rodar `find_fk_references.sql` e revisar dependências.
3. Fazer backup com `backup_and_prepare_drop.sh`.
4. Revisar `drop_*.sql` e proceder com `psql "${DB_URL}" -f drop_<table>.sql` quando for seguro.

Se quiser, posso: gerar uma lista automática de candidatos (linhas=0), ou tentar executar os backups/drops diretamente caso você forneça `DB_URL`.

Automação adicional:

- `auto_process_stripe_candidates.sh`: identifica tabelas com `stripe` no nome, faz `pg_dump` das que têm 0 linhas, executa `find_fk_references.sql` e gera `drop_<table>.sql` com o `DROP` comentado. Use com:

```bash
DB_URL="postgresql://user:pass@host:5432/dbname" ./scripts/db/auto_process_stripe_candidates.sh
```

Observação: o script NÃO executa `DROP`. Ele gera backups e arquivos de revisão para você aprovar e executar manualmente.
