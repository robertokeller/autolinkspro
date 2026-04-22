-- Migration 20260417000000 — Guard de segurança para contas seed de desenvolvimento
--
-- Problema: a migração 006_seed_users.sql insere admin@localhost.local com senha
-- fraca (abacate1 — 8 chars, abaixo do mínimo de produção). Se esse banco tiver
-- usuários reais, as contas seed representam um backdoor com credenciais fracas.
--
-- Esta migração remove as contas seed quando detecta que o banco tem usuários reais
-- (i.e., não é um ambiente fresh de desenvolvimento).
--
-- Regras:
--   - Se existem usuários além dos dois seeds → remover seeds (banco de produção ou real)
--   - Se admin@localhost.local é o ÚNICO admin → emitir WARNING em vez de remover
--     (evita deixar o banco sem admin; operador deve agir manualmente)
--   - Se só existem os dois seeds (DB fresh/dev) → manter sem alterações
--
-- Idempotente: seguro rodar múltiplas vezes.

DO $$
DECLARE
  v_admin_id         UUID;
  v_normal_id        UUID;
  v_real_user_count  BIGINT;
  v_other_admin_exists BOOLEAN;
BEGIN
  -- Localizar as contas seed (podem não existir se já foram removidas)
  SELECT id INTO v_admin_id  FROM users WHERE email = 'admin@localhost.local'  LIMIT 1;
  SELECT id INTO v_normal_id FROM users WHERE email = 'user@localhost.local'   LIMIT 1;

  -- Contar usuários que NÃO são as contas seed
  SELECT COUNT(*) INTO v_real_user_count
  FROM users
  WHERE email NOT IN ('admin@localhost.local', 'user@localhost.local');

  IF v_real_user_count = 0 THEN
    RAISE NOTICE '[seed-guard] Banco fresh ou apenas contas dev — nenhuma alteração necessária.';
    RETURN;
  END IF;

  -- Banco com usuários reais: remover conta normal seed
  IF v_normal_id IS NOT NULL THEN
    -- Limpar registros dependentes antes do DELETE (FK com ON DELETE CASCADE cuida
    -- da maioria, mas garantimos aqui para safety)
    DELETE FROM user_roles WHERE user_id = v_normal_id;
    DELETE FROM profiles   WHERE user_id = v_normal_id;
    DELETE FROM users      WHERE id = v_normal_id;
    RAISE NOTICE '[seed-guard] ✓ Removida conta dev: user@localhost.local';
  ELSE
    RAISE NOTICE '[seed-guard] user@localhost.local já não existe — nada a fazer.';
  END IF;

  -- Verificar se existe outro admin antes de remover o seed admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE role = 'admin'
      AND (v_admin_id IS NULL OR user_id != v_admin_id)
  ) INTO v_other_admin_exists;

  IF v_admin_id IS NOT NULL THEN
    IF v_other_admin_exists THEN
      DELETE FROM user_roles WHERE user_id = v_admin_id;
      DELETE FROM profiles   WHERE user_id = v_admin_id;
      DELETE FROM users      WHERE id = v_admin_id;
      RAISE NOTICE '[seed-guard] ✓ Removida conta dev: admin@localhost.local';
    ELSE
      RAISE WARNING
        '[seed-guard] ⚠ admin@localhost.local é o ÚNICO admin do sistema — NÃO foi removida. '
        'Crie outro admin com credenciais fortes, então re-execute esta migração (ou delete manualmente). '
        'Senha atual usa hash bcrypt de "abacate1" (8 chars — abaixo do mínimo de segurança).';
    END IF;
  ELSE
    RAISE NOTICE '[seed-guard] admin@localhost.local já não existe — nada a fazer.';
  END IF;

END $$;
