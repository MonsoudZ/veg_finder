-- An operator's assertion about a whole restaurant. 'fully_vegan' is the one
-- statement that makes every dish on a menu safe to transcribe automatically, so
-- it is recorded as a deliberate human decision rather than inferred each run.
-- 'manual' opts a restaurant out of automated extraction entirely.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_profile TEXT NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_menu_profile_check
    CHECK (menu_profile IN ('unknown', 'fully_vegan', 'manual'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
