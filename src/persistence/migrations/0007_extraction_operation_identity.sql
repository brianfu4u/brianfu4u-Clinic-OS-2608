ALTER TABLE evidence_extraction_attempt
  ADD COLUMN consequence_expectation_id text NOT NULL
    CHECK (btrim(consequence_expectation_id) <> '' AND char_length(consequence_expectation_id) <= 256),
  ADD COLUMN requested_fact_card_id text NOT NULL
    CHECK (btrim(requested_fact_card_id) <> '' AND char_length(requested_fact_card_id) <= 256);

-- These are request identities, not claims that the consequence already exists.
-- The tenant column and forced RLS keep both opaque IDs inside one clinic scope;
-- the existing golden-path repository remains authoritative for expectation lookup.
