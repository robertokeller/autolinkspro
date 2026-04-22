#!/usr/bin/env bash
# scripts/ci/check-direct-queries.sh
#
# Segurança: garante que queries SQL diretas ao banco (pool.query / execute / queryOne)
# que aparecem FORA dos arquivos autorizados estejam anotadas com @security-review-required.
#
# Contexto arquitetural:
#   - services/api/src/rest.ts  → handler CRUD com ownership enforcement automático
#   - services/api/src/rpc.ts   → handlers RPC com verificação de ownership explícita
#   - services/api/src/db.ts    → funções de utilidade do pool (query, queryOne, execute)
#   - services/api/src/auth.ts  → queries de auth (validadas internamente)
#   - services/api/src/kiwify/  → webhooks de pagamento (validados internamente)
#   - services/api/src/audit.ts → log imutável (sem leitura de dados do usuário)
#
# Qualquer outro arquivo que use pool.query / execute / queryOne deve documentar
# explicitamente como garante o isolamento de dados por usuário, via comentário:
#   // @security-review-required: <explicação de como ownership é verificado>
#
# Uso: scripts/ci/check-direct-queries.sh [--fix-hint]

set -euo pipefail

API_SRC="services/api/src"

# Arquivos autorizados a usar queries diretas sem anotação
AUTHORIZED_FILES="db\.ts|rest\.ts|rpc\.ts|auth\.ts|kiwify/|audit\.ts|rate-limit-store\.ts|credential-cipher\.ts|amazon-vitrine\.ts"

# Procura por chamadas de query direta em arquivos não autorizados
violations=$(grep -rn "pool\.query\|queryOne\|\.execute(" "$API_SRC" --include="*.ts" \
  | grep -Ev "$AUTHORIZED_FILES" \
  | grep -v "@security-review-required" \
  | grep -v "^Binary" \
  || true)

if [ -n "$violations" ]; then
  echo ""
  echo "❌ FALHA DE SEGURANÇA: queries diretas ao DB sem anotação @security-review-required"
  echo ""
  echo "Os seguintes arquivos usam queries diretas fora dos handlers autorizados:"
  echo ""
  echo "$violations"
  echo ""
  echo "AÇÃO NECESSÁRIA:"
  echo "  Para cada ocorrência, adicione um comentário documentando como o isolamento"
  echo "  de dados por usuário é garantido:"
  echo ""
  echo "  // @security-review-required: dados filtrados por user_id via JWT (req.user.id)"
  echo "  const result = await queryOne(\"SELECT ... WHERE user_id = \$1\", [userId]);"
  echo ""
  echo "  OU mova a lógica para usar o handler rest.ts / rpc.ts existente."
  echo ""
  exit 1
fi

echo "✓ Todas as queries diretas estão em arquivos autorizados ou anotadas com @security-review-required."
exit 0
