-- Where a restaurant declares that its whole menu is vegan or vegetarian, when
-- that declaration lives somewhere other than the menu page. A fully vegan
-- bakery typically says so on its home or about page and lets the menu just
-- list food, so reading only the menu misses the highest-confidence claim on
-- the site. Read for that claim and nothing else.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS claim_url TEXT;
