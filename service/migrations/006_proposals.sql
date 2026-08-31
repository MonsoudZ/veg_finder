-- Drafting and reviewing are separate acts, often days apart. Until now a draft
-- lived only in the HTTP response that produced it, so a reviewer who closed the
-- tab had to re-run extraction — which for the model tier means paying again.
CREATE TABLE IF NOT EXISTS menu_item_proposals (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  proposed_at TIMESTAMPTZ NOT NULL,
  tier TEXT NOT NULL,
  -- The drafted item exactly as extraction produced it, evidence included.
  -- Menu order, so a reviewer's list does not reshuffle between page loads.
  position INTEGER NOT NULL DEFAULT 0,
  item JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_at TIMESTAMPTZ,
  note TEXT
);

CREATE INDEX IF NOT EXISTS menu_item_proposals_restaurant
  ON menu_item_proposals (restaurant_id, status);
CREATE INDEX IF NOT EXISTS menu_item_proposals_pending
  ON menu_item_proposals (status, proposed_at);
