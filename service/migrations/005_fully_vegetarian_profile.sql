-- A restaurant can be entirely vegetarian without being vegan. City, O' City is
-- the obvious case: the whole menu is meat-free, but the cheese is dairy. Without
-- this value there was no way for an operator to say so, and every dish stayed
-- unreachable to the cheap tiers.
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_menu_profile_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_menu_profile_check
  CHECK (menu_profile IN ('unknown', 'fully_vegan', 'fully_vegetarian', 'manual'));
