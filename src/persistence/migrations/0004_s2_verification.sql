ALTER TABLE expectation_transition
  ADD CONSTRAINT expectation_transition_verification_identity
  UNIQUE (clinic_id, id, expectation_id, workflow_id, evaluated_at);

CREATE OR REPLACE FUNCTION text_array_has_no_duplicates(values_to_check text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  item text;
  seen text[] := ARRAY[]::text[];
BEGIN
  FOREACH item IN ARRAY values_to_check LOOP
    IF item = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := array_append(seen, item);
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE s2_verification (
  clinic_id text NOT NULL,
  id text NOT NULL,
  workflow_id text NOT NULL,
  expectation_id text NOT NULL,
  source_transition_id text NOT NULL,
  verifier_version text NOT NULL CHECK (btrim(verifier_version) <> ''),
  status text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'CONFLICT')),
  reason_codes text[] NOT NULL CHECK (
    array_position(reason_codes, NULL) IS NULL AND
    text_array_has_no_duplicates(reason_codes) AND
    reason_codes <@ ARRAY[
      'TRIGGER_NOT_FOUND',
      'CONSEQUENCE_NOT_FOUND',
      'IDENTITY_CONFLICT',
      'TIME_CONFLICT',
      'KIND_CONFLICT',
      'EXPECTATION_EVIDENCE_CONFLICT',
      'CHAIN_OPEN',
      'CHAIN_UNMET',
      'CHAIN_VOIDED'
    ]::text[]
  ),
  trigger_artifact_id text,
  consequence_artifact_id text,
  evidence_artifact_ids text[] NOT NULL CHECK (
    array_position(evidence_artifact_ids, NULL) IS NULL AND
    text_array_has_no_duplicates(evidence_artifact_ids) AND
    (trigger_artifact_id IS NULL OR trigger_artifact_id = ANY(evidence_artifact_ids)) AND
    (consequence_artifact_id IS NULL OR consequence_artifact_id = ANY(evidence_artifact_ids))
  ),
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, source_transition_id, verifier_version),
  FOREIGN KEY (clinic_id, workflow_id) REFERENCES workflow (clinic_id, id),
  FOREIGN KEY (clinic_id, expectation_id, workflow_id)
    REFERENCES expectation (clinic_id, id, workflow_id),
  FOREIGN KEY (clinic_id, source_transition_id, expectation_id, workflow_id, evaluated_at)
    REFERENCES expectation_transition
      (clinic_id, id, expectation_id, workflow_id, evaluated_at),
  FOREIGN KEY (clinic_id, trigger_artifact_id) REFERENCES artifact (clinic_id, id),
  FOREIGN KEY (clinic_id, consequence_artifact_id) REFERENCES artifact (clinic_id, id),
  CHECK (
    status <> 'VERIFIED' OR (
      cardinality(reason_codes) = 0 AND
      trigger_artifact_id IS NOT NULL AND
      consequence_artifact_id IS NOT NULL AND
      evidence_artifact_ids = ARRAY[trigger_artifact_id, consequence_artifact_id]
    )
  ),
  CHECK (status <> 'CONFLICT' OR cardinality(reason_codes) > 0)
);

CREATE TRIGGER s2_verification_append_only
BEFORE UPDATE OR DELETE ON s2_verification
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

ALTER TABLE s2_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE s2_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY s2_verification_clinic_scope ON s2_verification
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
