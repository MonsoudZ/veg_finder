-- Plenty of menus publish no price, and a missing price endangers nobody. It was
-- required because the extractor used it to prove a line was a real dish, which
-- is a job for the extractor's own structural evidence rather than for a column
-- the app renders. The two uses are now separated.
--
-- This matters most for a document menu. Hudson Hill's PDF has no usable text
-- layer, so a person transcribes it - and can read the dishes perfectly well
-- while most of the prices are unrecoverable. Requiring a price meant inventing
-- one or dropping the dish.
ALTER TABLE menu_items ALTER COLUMN price DROP NOT NULL;
