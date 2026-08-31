-- The catalog moves from a hand-edited seed file to the database as source of
-- truth, and clients stop pulling the whole catalog on every request.

-- The restaurant is the unit of synchronisation: any change to it or to its menu
-- items bumps this column, so a client can ask for whole restaurant records that
-- changed since its last sync.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Delta sync and the paged listing both walk a (sort key, id) pair so a cursor
-- can resume exactly where the previous page stopped.
CREATE INDEX IF NOT EXISTS restaurants_updated_at ON restaurants (updated_at, id);
CREATE INDEX IF NOT EXISTS restaurants_name_id ON restaurants (name, id);
CREATE INDEX IF NOT EXISTS menu_items_updated_at ON menu_items (updated_at, id);

-- Bounding-box prefilter for nearby queries. Exact distance is computed after.
CREATE INDEX IF NOT EXISTS restaurants_location ON restaurants (latitude, longitude);
