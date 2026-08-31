-- The checker already notices that a source changed, and demotes the restaurant
-- when it does. What it cannot say is *what* changed, so a reviewer met with
-- "Needs review" had to re-read the whole menu to find the one new dish.
--
-- These two tables hold that answer: a proposal is one reading of one changed
-- source, and its operations are the differences from what is currently
-- published. Nothing here is live data. Applying a proposal is a separate,
-- deliberate act by a person, which is the point — a changed webpage must never
-- by itself become a changed dietary claim.
--
-- This is distinct from menu_item_proposals (006), which holds *drafts* of a
-- menu that has none published yet. That one answers "what should this
-- restaurant's menu be?"; this one answers "what changed since we last agreed?".
CREATE TABLE IF NOT EXISTS menu_change_proposals (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The snapshot this reading was taken from, and the one it was compared
  -- against. Keeping both is what lets a reviewer see the old and new source
  -- side by side rather than trusting the diff blindly.
  source_snapshot_id UUID REFERENCES menu_source_snapshots(id) ON DELETE SET NULL,
  previous_snapshot_id UUID REFERENCES menu_source_snapshots(id) ON DELETE SET NULL,
  -- Which extraction tier read the new source. A diff is only ever as trustworthy
  -- as the reading that produced it.
  tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  -- Everything the diff could not settle on its own, as an array of strings.
  -- Deliberately surfaced rather than resolved: version one over-proposes and
  -- says so, because a false positive costs a reviewer a minute and a false
  -- vegan claim costs somebody their trust.
  ambiguities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS menu_change_proposals_pending
  ON menu_change_proposals (status, created_at);
CREATE INDEX IF NOT EXISTS menu_change_proposals_restaurant
  ON menu_change_proposals (restaurant_id, status);

CREATE TABLE IF NOT EXISTS menu_change_operations (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES menu_change_proposals(id) ON DELETE CASCADE,
  -- Menu order, so a reviewer's list does not reshuffle between page loads.
  position INTEGER NOT NULL DEFAULT 0,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'update', 'retire')),
  -- Item identity is derived from the restaurant and the dish name, so it is
  -- known before the item exists. Nullable because an operation about a dish we
  -- cannot identify is still worth showing a person.
  menu_item_id UUID,
  -- Null for a retirement: that operation proposes no new values, only that a
  -- published item stop being published.
  proposed_name TEXT,
  proposed_description TEXT,
  proposed_price TEXT,
  proposed_dietary_status TEXT,
  proposed_modification_note TEXT,
  -- The verbatim line from the new source that this operation rests on.
  evidence TEXT NOT NULL DEFAULT '',
  -- What is published right now, for an update or a retirement. Stored rather
  -- than joined so the review page can show old → new even after the live item
  -- has moved on.
  current_item JSONB,
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  -- Per-operation outcome. A reviewer accepts a proposal by choosing which of
  -- its operations to apply, so 'skipped' is a real decision worth recording and
  -- not the same as a rejected proposal.
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'applied', 'skipped'))
);

CREATE INDEX IF NOT EXISTS menu_change_operations_proposal
  ON menu_change_operations (proposal_id, position);
