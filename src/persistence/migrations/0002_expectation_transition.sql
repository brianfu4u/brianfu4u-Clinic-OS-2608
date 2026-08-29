ALTER TABLE expectation
  ADD CONSTRAINT expectation_workflow_identity
  UNIQUE (clinic_id, id, workflow_id);

CREATE TABLE expectation_transition (
  clinic_id text NOT NULL,
  id text NOT NULL,
  expectation_id text NOT NULL,
  workflow_id text NOT NULL,
  from_state text CHECK (
    from_state IS NULL OR from_state IN ('OPEN', 'MET', 'UNMET', 'VOIDED')
  ),
  to_state text NOT NULL CHECK (to_state IN ('OPEN', 'MET', 'UNMET', 'VOIDED')),
  evaluated_at timestamptz NOT NULL,
  trigger_artifact_id text NOT NULL,
  satisfied_by_artifact_id text,
  evidence_artifact_ids text[] NOT NULL CHECK (
    cardinality(evidence_artifact_ids) > 0 AND
    array_position(evidence_artifact_ids, NULL) IS NULL AND
    trigger_artifact_id = ANY(evidence_artifact_ids) AND
    (to_state <> 'MET' OR satisfied_by_artifact_id = ANY(evidence_artifact_ids))
  ),
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, expectation_id, workflow_id)
    REFERENCES expectation (clinic_id, id, workflow_id),
  FOREIGN KEY (clinic_id, workflow_id) REFERENCES workflow (clinic_id, id),
  FOREIGN KEY (clinic_id, trigger_artifact_id) REFERENCES artifact (clinic_id, id),
  FOREIGN KEY (clinic_id, satisfied_by_artifact_id) REFERENCES artifact (clinic_id, id),
  CHECK (
    (to_state = 'MET' AND satisfied_by_artifact_id IS NOT NULL) OR
    (to_state <> 'MET' AND satisfied_by_artifact_id IS NULL)
  )
);

CREATE UNIQUE INDEX expectation_transition_one_initialization
ON expectation_transition (clinic_id, expectation_id)
WHERE from_state IS NULL;

CREATE TRIGGER expectation_transition_append_only
BEFORE UPDATE OR DELETE ON expectation_transition
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

ALTER TABLE expectation_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE expectation_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY expectation_transition_clinic_scope ON expectation_transition
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
