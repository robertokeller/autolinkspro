-- Normalize master group distribution to app-supported modes.
-- Legacy databases may still store "sequential" from old defaults.

ALTER TABLE master_groups
  ALTER COLUMN distribution SET DEFAULT 'balanced';

UPDATE master_groups
SET distribution = 'balanced'
WHERE distribution IS NULL
   OR btrim(distribution) = ''
   OR lower(distribution) = 'sequential';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'master_groups_distribution_valid'
  ) THEN
    ALTER TABLE master_groups
      ADD CONSTRAINT master_groups_distribution_valid
      CHECK (distribution IN ('balanced', 'random'));
  END IF;
END $$;
