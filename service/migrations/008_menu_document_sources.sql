-- A menu published as a PDF or an image is a real, fetchable source: its bytes
-- fingerprint, so an edit to it is still caught. What cannot happen is reading
-- its dishes, so its items are transcribed by a person. That makes it the one
-- source that needs both checks - the fingerprint for changes, and the offline
-- clock so a human-transcribed record does not stand unexamined forever.
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_verification_method_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_verification_method_check
  CHECK (verification_method IN
    ('official_url', 'menu_document', 'menu_photo', 'phone', 'in_person'));
