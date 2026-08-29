ALTER TABLE expectation_transition
  ADD CONSTRAINT expectation_transition_automatic_path CHECK (
    from_state IS NULL OR
    (from_state = 'OPEN' AND to_state IN ('OPEN', 'UNMET', 'MET')) OR
    (from_state = 'UNMET' AND to_state IN ('UNMET', 'MET'))
  );

CREATE UNIQUE INDEX expectation_transition_one_evaluation_instant
ON expectation_transition (clinic_id, expectation_id, evaluated_at);
