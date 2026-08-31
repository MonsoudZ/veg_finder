-- Not every restaurant publishes a menu online. Paper-only menus, chalkboards,
-- and phone-confirmed substitutions are real coverage, and requiring a URL
-- excluded them from the catalog entirely.
ALTER TABLE restaurants ALTER COLUMN menu_url DROP NOT NULL;

-- How this restaurant's dietary data was established. Only 'official_url' can be
-- fingerprinted by the automated checker; the rest are human observations, so
-- they are re-queued on an age clock instead (see checker.js).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS verification_method TEXT NOT NULL
  DEFAULT 'official_url';

DO $$
BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_verification_method_check
    CHECK (verification_method IN ('official_url', 'menu_photo', 'phone', 'in_person'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
