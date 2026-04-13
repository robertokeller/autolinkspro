-- Rename "mais_amadas" tab to "melhor_avaliados" in amazon vitrine
-- Update all existing records

UPDATE amazon_vitrine_products
SET tab_key = 'melhor_avaliados'
WHERE tab_key = 'mais_amadas';
