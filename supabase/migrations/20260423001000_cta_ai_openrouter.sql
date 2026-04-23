BEGIN;

CREATE TABLE IF NOT EXISTS public.cta_ai_tones (
  key text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT cta_ai_tones_key_chk
    CHECK (key ~ '^[a-z0-9_]{3,40}$'),
  CONSTRAINT cta_ai_tones_label_len_chk
    CHECK (char_length(trim(label)) BETWEEN 3 AND 80),
  CONSTRAINT cta_ai_tones_prompt_len_chk
    CHECK (char_length(trim(system_prompt)) BETWEEN 20 AND 4000)
);

CREATE INDEX IF NOT EXISTS cta_ai_tones_active_sort_idx
  ON public.cta_ai_tones (is_active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.user_template_cta_ai_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.templates(id) ON DELETE CASCADE,
  tone_key text NOT NULL REFERENCES public.cta_ai_tones(key) ON UPDATE CASCADE,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT user_template_cta_ai_config_tone_key_len_chk
    CHECK (char_length(trim(tone_key)) BETWEEN 3 AND 40),
  CONSTRAINT user_template_cta_ai_config_user_template_uq
    UNIQUE (user_id, template_id)
);

CREATE INDEX IF NOT EXISTS user_template_cta_ai_config_user_template_idx
  ON public.user_template_cta_ai_config (user_id, template_id);

CREATE INDEX IF NOT EXISTS user_template_cta_ai_config_user_tone_idx
  ON public.user_template_cta_ai_config (user_id, tone_key, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.cta_ai_generation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  template_id uuid REFERENCES public.templates(id) ON DELETE SET NULL,
  tone_key text NOT NULL,
  offer_title text NOT NULL DEFAULT '',
  generated_phrase text NOT NULL,
  provider text NOT NULL DEFAULT 'openrouter',
  model text NOT NULL,
  status text NOT NULL DEFAULT 'success',
  latency_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT cta_ai_generation_logs_tone_key_len_chk
    CHECK (char_length(trim(tone_key)) BETWEEN 3 AND 40),
  CONSTRAINT cta_ai_generation_logs_phrase_len_chk
    CHECK (char_length(trim(generated_phrase)) BETWEEN 3 AND 280),
  CONSTRAINT cta_ai_generation_logs_status_chk
    CHECK (status IN ('success', 'fallback', 'error'))
);

CREATE INDEX IF NOT EXISTS cta_ai_generation_logs_user_created_idx
  ON public.cta_ai_generation_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cta_ai_generation_logs_template_created_idx
  ON public.cta_ai_generation_logs (template_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cta_ai_generation_logs_tone_created_idx
  ON public.cta_ai_generation_logs (tone_key, created_at DESC);

ALTER TABLE public.cta_ai_tones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cta_ai_tones FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_cta_ai_tones_select_authenticated ON public.cta_ai_tones;
DROP POLICY IF EXISTS p_cta_ai_tones_manage_admin ON public.cta_ai_tones;

CREATE POLICY p_cta_ai_tones_select_authenticated
ON public.cta_ai_tones
FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY p_cta_ai_tones_manage_admin
ON public.cta_ai_tones
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

ALTER TABLE public.user_template_cta_ai_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_template_cta_ai_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_template_cta_ai_config_select_own_or_admin ON public.user_template_cta_ai_config;
DROP POLICY IF EXISTS p_user_template_cta_ai_config_insert_own_or_admin ON public.user_template_cta_ai_config;
DROP POLICY IF EXISTS p_user_template_cta_ai_config_update_own_or_admin ON public.user_template_cta_ai_config;
DROP POLICY IF EXISTS p_user_template_cta_ai_config_delete_own_or_admin ON public.user_template_cta_ai_config;

CREATE POLICY p_user_template_cta_ai_config_select_own_or_admin
ON public.user_template_cta_ai_config
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_template_cta_ai_config_insert_own_or_admin
ON public.user_template_cta_ai_config
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_template_cta_ai_config_update_own_or_admin
ON public.user_template_cta_ai_config
FOR UPDATE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin())
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_template_cta_ai_config_delete_own_or_admin
ON public.user_template_cta_ai_config
FOR DELETE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

ALTER TABLE public.cta_ai_generation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cta_ai_generation_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_cta_ai_generation_logs_select_own_or_admin ON public.cta_ai_generation_logs;
DROP POLICY IF EXISTS p_cta_ai_generation_logs_insert_own_or_admin ON public.cta_ai_generation_logs;
DROP POLICY IF EXISTS p_cta_ai_generation_logs_update_admin ON public.cta_ai_generation_logs;
DROP POLICY IF EXISTS p_cta_ai_generation_logs_delete_admin ON public.cta_ai_generation_logs;

CREATE POLICY p_cta_ai_generation_logs_select_own_or_admin
ON public.cta_ai_generation_logs
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_cta_ai_generation_logs_insert_own_or_admin
ON public.cta_ai_generation_logs
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_cta_ai_generation_logs_update_admin
ON public.cta_ai_generation_logs
FOR UPDATE
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

CREATE POLICY p_cta_ai_generation_logs_delete_admin
ON public.cta_ai_generation_logs
FOR DELETE
TO authenticated
USING (app_is_admin());

WITH seed(key, label, description, system_prompt, sort_order) AS (
  VALUES
    (
      'urgencia_escassez',
      'Urgencia e escassez',
      'Foco em decisao imediata sem promessas irreais.',
      'Voce e um copywriter brasileiro especialista em CTA curta para afiliados. Gere exatamente 1 frase em PT-BR, com no maximo 110 caracteres, sem aspas, sem hashtags, sem emoji e sem ponto final. Use urgencia e escassez com linguagem natural. Nao invente preco, cupom, estoque ou prazo se isso nao estiver no contexto.',
      1
    ),
    (
      'beneficio_direto',
      'Beneficio direto',
      'Enfatiza ganho pratico e clareza da oferta.',
      'Voce e um copywriter brasileiro especialista em CTA curta para afiliados. Gere exatamente 1 frase em PT-BR, com no maximo 110 caracteres, sem aspas, sem hashtags, sem emoji e sem ponto final. Destaque beneficio direto e objetivo para a pessoa clicar agora. Nao invente fatos nao informados.',
      2
    ),
    (
      'prova_social',
      'Prova social',
      'Valoriza confianca e adesao de outras pessoas.',
      'Voce e um copywriter brasileiro especialista em CTA curta para afiliados. Gere exatamente 1 frase em PT-BR, com no maximo 110 caracteres, sem aspas, sem hashtags, sem emoji e sem ponto final. Use gatilho de prova social em tom natural, sem afirmar numeros ou estatisticas nao fornecidas.',
      3
    ),
    (
      'curiosidade',
      'Curiosidade',
      'Abre lacuna de curiosidade para aumentar cliques.',
      'Voce e um copywriter brasileiro especialista em CTA curta para afiliados. Gere exatamente 1 frase em PT-BR, com no maximo 110 caracteres, sem aspas, sem hashtags, sem emoji e sem ponto final. Use curiosidade sem clickbait enganoso e sem promessas irreais.',
      4
    ),
    (
      'convite_conversa',
      'Convite para conversa',
      'Tom humano que chama para interacao rapida.',
      'Voce e um copywriter brasileiro especialista em CTA curta para afiliados. Gere exatamente 1 frase em PT-BR, com no maximo 110 caracteres, sem aspas, sem hashtags, sem emoji e sem ponto final. Convide para acao com tom proximo e natural. Nao use termos agressivos.',
      5
    )
)
INSERT INTO public.cta_ai_tones (key, label, description, system_prompt, sort_order, is_active)
SELECT seed.key, seed.label, seed.description, seed.system_prompt, seed.sort_order, TRUE
FROM seed
ON CONFLICT (key)
DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE,
  updated_at = NOW();

COMMIT;
