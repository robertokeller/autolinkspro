BEGIN;

INSERT INTO public.cta_ai_tones (key, label, description, system_prompt, sort_order, is_active)
VALUES (
  'rotativo',
  'Rotativo',
  'Alterna automaticamente entre os tons ativos.',
  $prompt$
Voce e um gerador de CTAs curtas para ofertas de produtos em WhatsApp.

Sua tarefa e criar 1 unica CTA com base no titulo do produto informado.

Regras obrigatorias:
- Responda em portugues do Brasil.
- Retorne somente a CTA final.
- A saida deve ter apenas 1 linha.
- Nao use aspas.
- Nao use emojis.
- Nao use explicacoes.
- Nao use observacoes.
- Nao use prefixos como CTA:, Resposta: ou similares.
- Nao use listas.
- Nao use quebra de linha.
- Nao use ponto final no fim.
- Maximo de 6 palavras.
- A CTA deve ser curta, natural, chamativa e persuasiva.
- A CTA deve parecer uma frase real de oferta para WhatsApp.
- O tom deve alternar entre estilos ativos de CTA.
- Gere algo pronto para uso imediato no template.

Saida obrigatoria:
Somente a CTA final.

Titulo do produto: {{titulo}}
Crie a CTA agora.
$prompt$,
  11,
  TRUE
)
ON CONFLICT (key)
DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE,
  updated_at = NOW();

WITH templates_with_rotative AS (
  SELECT id, user_id
  FROM public.templates
  WHERE content ~* '\{\{?\s*cta[_ ]rotativa\s*\}\}?'
),
updated_templates AS (
  UPDATE public.templates AS t
  SET content = regexp_replace(
    t.content,
    '\{\{?\s*cta[_ ]rotativa\s*\}\}?',
    '{cta_gerada_por_ia}',
    'gi'
  )
  WHERE t.id IN (SELECT id FROM templates_with_rotative)
  RETURNING t.id, t.user_id
)
INSERT INTO public.user_template_cta_ai_config (user_id, template_id, tone_key, is_active)
SELECT ut.user_id, ut.id, 'rotativo', TRUE
FROM updated_templates AS ut
ON CONFLICT (user_id, template_id)
DO UPDATE
SET
  tone_key = 'rotativo',
  is_active = TRUE,
  updated_at = NOW();

COMMIT;
