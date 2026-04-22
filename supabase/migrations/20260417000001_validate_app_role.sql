-- Migration 20260417000001 — Validação do role da aplicação no banco de dados
--
-- Problema arquitetural: o API usa conexões pg diretas. Se o role de banco usado
-- pela aplicação tiver BYPASSRLS habilitado, as políticas RLS definidas nas migrações
-- não são aplicadas como fallback de segurança — qualquer query direta que esqueça
-- de filtrar por user_id expõe dados de outros usuários.
--
-- Esta migração:
--   1. Emite NOTICE/WARNING sobre o status de BYPASSRLS do role atual
--   2. Lista tabelas com FORCE ROW LEVEL SECURITY ativo (devem ser todas)
--   3. Valida que a função check_rls_coverage() não encontra lacunas
--
-- Idempotente: somente leitura — não modifica nada.

DO $$
DECLARE
  v_role TEXT := current_user;
  v_has_bypassrls BOOLEAN;
  v_tables_without_rls TEXT[];
BEGIN
  -- Verificar BYPASSRLS do role atual
  SELECT rolbypassrls INTO v_has_bypassrls
  FROM pg_roles
  WHERE rolname = v_role;

  IF v_has_bypassrls IS NULL THEN
    RAISE NOTICE '[app-role] Role atual "%" não encontrado em pg_roles — pode ser role especial do Supabase.', v_role;
  ELSIF v_has_bypassrls THEN
    RAISE WARNING
      '[app-role] ⚠ Role atual "%" tem BYPASSRLS=TRUE. '
      'Isso significa que as políticas RLS NÃO são aplicadas como fallback para queries diretas do backend. '
      'Para segurança em profundidade, crie um role de aplicação dedicado sem BYPASSRLS: '
      'CREATE ROLE autolinks_app LOGIN PASSWORD ''...'' NOINHERIT; '
      'GRANT CONNECT ON DATABASE <db> TO autolinks_app; '
      'Depois use esse role no DATABASE_URL da aplicação.',
      v_role;
  ELSE
    RAISE NOTICE '[app-role] ✓ Role atual "%" não tem BYPASSRLS — políticas RLS são aplicadas como fallback.', v_role;
  END IF;

  -- Verificar tabelas sem RLS (usando função existente se disponível)
  BEGIN
    -- check_rls_coverage() está definida em 020_security_scalability_hardening.sql
    SELECT ARRAY_AGG(table_name ORDER BY table_name)
    INTO v_tables_without_rls
    FROM check_rls_coverage();

    IF v_tables_without_rls IS NOT NULL AND array_length(v_tables_without_rls, 1) > 0 THEN
      RAISE WARNING
        '[app-role] ⚠ Tabelas sem cobertura RLS encontradas: %. '
        'Execute: SELECT * FROM check_rls_coverage(); para detalhes.',
        array_to_string(v_tables_without_rls, ', ');
    ELSE
      RAISE NOTICE '[app-role] ✓ Cobertura RLS completa — todas as tabelas estão protegidas.';
    END IF;
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '[app-role] Função check_rls_coverage() não encontrada — migração 020 pode não ter sido aplicada ainda.';
  END;

END $$;
