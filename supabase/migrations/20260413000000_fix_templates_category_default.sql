-- Fix templates.category column default from legacy 'manual' to valid 'oferta'.
-- The category constraint already requires ('oferta','cupom','geral'). The old
-- default 'manual' would violate the constraint if category is ever omitted on insert.

ALTER TABLE templates ALTER COLUMN category SET DEFAULT 'oferta';
