BEGIN;

CREATE TABLE IF NOT EXISTS public.cta_random_phrases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cta_random_phrases_phrase_uq
  ON public.cta_random_phrases (phrase);

CREATE INDEX IF NOT EXISTS cta_random_phrases_active_order_idx
  ON public.cta_random_phrases (is_active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.user_cta_random_state (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  last_phrase_id uuid REFERENCES public.cta_random_phrases(id) ON DELETE SET NULL,
  recent_phrase_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_cta_random_state_updated_idx
  ON public.user_cta_random_state (updated_at DESC);

ALTER TABLE public.cta_random_phrases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cta_random_phrases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_cta_random_phrases_select_authenticated ON public.cta_random_phrases;
DROP POLICY IF EXISTS p_cta_random_phrases_manage_admin ON public.cta_random_phrases;

CREATE POLICY p_cta_random_phrases_select_authenticated
ON public.cta_random_phrases
FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY p_cta_random_phrases_manage_admin
ON public.cta_random_phrases
FOR ALL
TO authenticated
USING (app_is_admin())
WITH CHECK (app_is_admin());

ALTER TABLE public.user_cta_random_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_cta_random_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_cta_random_state_select_own_or_admin ON public.user_cta_random_state;
DROP POLICY IF EXISTS p_user_cta_random_state_insert_own_or_admin ON public.user_cta_random_state;
DROP POLICY IF EXISTS p_user_cta_random_state_update_own_or_admin ON public.user_cta_random_state;
DROP POLICY IF EXISTS p_user_cta_random_state_delete_own_or_admin ON public.user_cta_random_state;

CREATE POLICY p_user_cta_random_state_select_own_or_admin
ON public.user_cta_random_state
FOR SELECT
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_cta_random_state_insert_own_or_admin
ON public.user_cta_random_state
FOR INSERT
TO authenticated
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_cta_random_state_update_own_or_admin
ON public.user_cta_random_state
FOR UPDATE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin())
WITH CHECK (user_id = app_current_user_id() OR app_is_admin());

CREATE POLICY p_user_cta_random_state_delete_own_or_admin
ON public.user_cta_random_state
FOR DELETE
TO authenticated
USING (user_id = app_current_user_id() OR app_is_admin());

WITH seed(phrase, sort_order) AS (
  VALUES
    ('Clique no link e garanta o seu agora', 1),
    ('Aproveite agora antes que acabe', 2),
    ('Oferta por tempo limitado aproveite ja', 3),
    ('Corre que o estoque e limitado', 4),
    ('Garanta o seu com desconto de hoje', 5),
    ('Nao deixa para depois aproveite ja', 6),
    ('Ultimas unidades disponiveis no link', 7),
    ('So hoje com esse preco especial', 8),
    ('Aproveita essa chance agora mesmo', 9),
    ('Link liberado para compra rapida', 10),
    ('Comenta QUERO e pega o seu', 11),
    ('Chama no link e fecha agora', 12),
    ('Vai perder essa oferta nao ne', 13),
    ('Esse valor pode subir a qualquer momento', 14),
    ('Clique e confira o desconto ativo', 15),
    ('A oportunidade esta no link agora', 16),
    ('Promo ativa por pouco tempo', 17),
    ('Aproveite enquanto esta disponivel', 18),
    ('Garanta antes que vire preco cheio', 19),
    ('So os rapidos vao aproveitar', 20),
    ('Chegou a hora de garantir o seu', 21),
    ('Nao fique de fora dessa promocao', 22),
    ('Corre no link e economize hoje', 23),
    ('Oferta quente valida por pouco tempo', 24),
    ('So hoje com condicoes especiais', 25),
    ('Quem clicar primeiro leva melhor', 26),
    ('Valor promocional por tempo curto', 27),
    ('Aproveite a janela de desconto', 28),
    ('Garanta o seu sem enrolacao', 29),
    ('Clique agora e economize de verdade', 30),
    ('Melhor custo beneficio do momento', 31),
    ('Oferta relampago ativa no link', 32),
    ('Nao dorme nessa promocao', 33),
    ('Chama no link e aproveita', 34),
    ('Preco especial para quem agir agora', 35),
    ('Aproveite antes que esgote', 36),
    ('Esta oferta nao vai durar', 37),
    ('Garanta com desconto imediato', 38),
    ('So enquanto durar o estoque', 39),
    ('Oferta valida ate acabar', 40),
    ('Clique e veja o valor final agora', 41),
    ('Aproveite para comprar pagando menos', 42),
    ('Hoje vale muito a pena', 43),
    ('Se interessou aproveita agora', 44),
    ('Nao perde essa chance de economizar', 45),
    ('Hora certa para fechar essa compra', 46),
    ('Quem chega primeiro aproveita mais', 47),
    ('Link pronto para garantir o seu', 48),
    ('Desconto ativo por poucos minutos', 49),
    ('Oferta imperdivel para agir agora', 50),
    ('Corre no link sem pensar duas vezes', 51),
    ('Economize hoje com esse link', 52),
    ('Aproveite o melhor preco agora', 53),
    ('Clique e finalize enquanto esta barato', 54),
    ('So agora com condicao especial', 55),
    ('Ultima chamada para aproveitar', 56),
    ('Garanta seu pedido com desconto', 57),
    ('Oferta exclusiva para quem agir rapido', 58),
    ('Link aberto aproveite ja', 59),
    ('Desconto real para compra imediata', 60),
    ('Nao deixa esse preco escapar', 61),
    ('Hora de clicar e garantir', 62),
    ('Aproveite essa oferta sem demora', 63),
    ('Preco de oportunidade no link', 64),
    ('Oferta liberada por tempo curto', 65),
    ('So hoje para quem quer economizar', 66),
    ('Chama no link e aproveita agora', 67),
    ('Garanta o seu no preco promocional', 68),
    ('Corre porque esta acabando rapido', 69),
    ('Oferta especial ativa neste momento', 70),
    ('Clique e pegue antes que acabe', 71),
    ('Aproveite essa condicao limitada', 72),
    ('Melhor momento para comprar e agora', 73),
    ('Nao deixa para amanha essa economia', 74),
    ('So por hoje com desconto forte', 75),
    ('Garanta o seu antes da virada', 76),
    ('Essa oferta esta voando', 77),
    ('Link com desconto pronto para voce', 78),
    ('Promo de verdade para agir agora', 79),
    ('Aproveite sem perder tempo', 80),
    ('Garanta o seu com poucos cliques', 81),
    ('Economize agora e agradeca depois', 82),
    ('Oferta curta aproveite enquanto da', 83),
    ('Valor reduzido por tempo limitado', 84),
    ('Clique e aproveite essa janela', 85),
    ('Hora da decisao aproveite agora', 86),
    ('Link direto para garantir seu desconto', 87),
    ('Oferta ativa para poucos', 88),
    ('Nao pisca que acaba', 89),
    ('Garanta agora e evite preco cheio', 90),
    ('Oportunidade boa nao espera', 91),
    ('Clique no link e aproveite o momento', 92),
    ('So quem agir agora leva vantagem', 93),
    ('Aproveite a promocao ainda hoje', 94),
    ('Garanta antes que encerre', 95),
    ('Oferta especial para compra imediata', 96),
    ('Economize sem complicacao clique agora', 97),
    ('Condicao unica aproveite ja', 98),
    ('Desconto temporario corre no link', 99),
    ('Ultima oportunidade aproveite agora', 100)
)
INSERT INTO public.cta_random_phrases (phrase, sort_order, is_active)
SELECT seed.phrase, seed.sort_order, TRUE
FROM seed
ON CONFLICT (phrase)
DO UPDATE
SET
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE,
  updated_at = NOW();

COMMIT;
