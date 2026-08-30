CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  neighborhood TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  menu_url TEXT NOT NULL,
  check_url TEXT,
  extraction_mode TEXT NOT NULL DEFAULT 'change_detection',
  verified_at TIMESTAMPTZ NOT NULL,
  coverage_status TEXT NOT NULL DEFAULT 'Needs review'
    CHECK (coverage_status IN ('Complete', 'Needs review')),
  coverage_scope TEXT NOT NULL,
  audited_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  source_hash TEXT,
  review_required BOOLEAN NOT NULL DEFAULT FALSE,
  check_error TEXT
);

CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price TEXT NOT NULL,
  dietary_status TEXT NOT NULL CHECK (
    dietary_status IN ('Vegan', 'Vegetarian', 'Can be made vegan', 'Can be made vegetarian')
  ),
  modification_note TEXT,
  source_evidence TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_verified_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS menu_items_restaurant
  ON menu_items(restaurant_id, active, sort_order);

CREATE TABLE IF NOT EXISTS menu_check_runs (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'changed', 'failed')),
  source_hash TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS menu_check_runs_restaurant
  ON menu_check_runs(restaurant_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS menu_source_snapshots (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  normalized_source TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  UNIQUE(restaurant_id, source_hash)
);

CREATE TABLE IF NOT EXISTS menu_item_versions (
  id UUID PRIMARY KEY,
  menu_item_id UUID NOT NULL,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_snapshot JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('published', 'updated', 'retired'))
);

CREATE INDEX IF NOT EXISTS menu_item_versions_item
  ON menu_item_versions(menu_item_id, recorded_at DESC);
