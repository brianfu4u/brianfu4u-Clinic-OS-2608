ALTER TABLE expectation_transition
  ADD COLUMN source text NOT NULL DEFAULT 'DETERMINISTIC'
    CHECK (source IN ('DETERMINISTIC', 'HUMAN'));

ALTER TABLE expectation_transition
  DROP CONSTRAINT expectation_transition_automatic_path;

ALTER TABLE expectation_transition
  ADD CONSTRAINT expectation_transition_source_path CHECK (
    (
      source = 'DETERMINISTIC' AND (
        from_state IS NULL OR
        (from_state = 'OPEN' AND to_state IN ('OPEN', 'UNMET', 'MET')) OR
        (from_state = 'UNMET' AND to_state IN ('UNMET', 'MET'))
      )
    ) OR (
      source = 'HUMAN' AND
      from_state IN ('OPEN', 'UNMET', 'MET') AND
      to_state = 'VOIDED'
    )
  );

DROP INDEX expectation_transition_one_evaluation_instant;
CREATE UNIQUE INDEX expectation_transition_one_deterministic_evaluation_instant
  ON expectation_transition (clinic_id, expectation_id, evaluated_at)
  WHERE source = 'DETERMINISTIC';
CREATE UNIQUE INDEX expectation_transition_one_human_evaluation_instant
  ON expectation_transition (clinic_id, expectation_id, evaluated_at)
  WHERE source = 'HUMAN';

ALTER TABLE expectation_transition
  ADD CONSTRAINT expectation_transition_manager_snapshot_identity
  UNIQUE (clinic_id, id, expectation_id, workflow_id, evaluated_at, to_state);

ALTER TABLE s2_verification
  ADD CONSTRAINT s2_verification_manager_snapshot_identity
  UNIQUE (
    clinic_id, id, workflow_id, expectation_id, status, reason_codes, evaluated_at,
    source_transition_id
  );

ALTER TABLE manager_decision
  ADD COLUMN verification_id text NOT NULL,
  ADD COLUMN verification_source_transition_id text NOT NULL,
  ADD COLUMN expectation_state text NOT NULL
    CHECK (expectation_state IN ('OPEN', 'MET', 'UNMET')),
  ADD COLUMN verification_evaluated_at timestamptz NOT NULL,
  ADD CONSTRAINT manager_decision_time_order
    CHECK (decided_at >= verification_evaluated_at),
  ADD CONSTRAINT manager_decision_unique_evidence
    CHECK (text_array_has_no_duplicates(evidence_artifact_ids)),
  ADD CONSTRAINT manager_decision_action_snapshot CHECK (
    (action = 'CLOSE_STANDARD' AND expectation_state = 'MET' AND verification_status = 'VERIFIED') OR
    (action = 'CLOSE_EXCEPTION' AND expectation_state = 'UNMET' AND reason_code IS NOT NULL) OR
    (action = 'KEEP_OPEN' AND expectation_state IN ('OPEN', 'UNMET') AND
      (expectation_state <> 'UNMET' OR reason_code IS NOT NULL)) OR
    (action = 'VOID' AND reason_code IS NOT NULL)
  ),
  ADD CONSTRAINT manager_decision_verification_snapshot_fk FOREIGN KEY (
    clinic_id, verification_id, workflow_id, expectation_id, verification_status,
    verification_reason_codes, verification_evaluated_at, verification_source_transition_id
  ) REFERENCES s2_verification (
    clinic_id, id, workflow_id, expectation_id, status, reason_codes, evaluated_at,
    source_transition_id
  ),
  ADD CONSTRAINT manager_decision_expectation_snapshot_fk FOREIGN KEY (
    clinic_id, verification_source_transition_id, expectation_id, workflow_id,
    verification_evaluated_at, expectation_state
  ) REFERENCES expectation_transition (
    clinic_id, id, expectation_id, workflow_id, evaluated_at, to_state
  );
