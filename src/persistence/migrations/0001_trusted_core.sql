CREATE TABLE IF NOT EXISTS schema_migration (
  id text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION refuse_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % cannot be %', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TABLE artifact (
  clinic_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamptz,
  occurred_at_source text NOT NULL CHECK (occurred_at_source IN ('source', 'employee_confirmed', 'unknown')),
  source_employee_id text NOT NULL,
  identity_anchor text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  CHECK (
    (occurred_at IS NULL AND occurred_at_source = 'unknown') OR
    (occurred_at IS NOT NULL AND occurred_at_source <> 'unknown')
  )
);

CREATE TABLE evidence_fact_card (
  clinic_id text NOT NULL,
  id text NOT NULL,
  artifact_id text NOT NULL,
  subject_type text NOT NULL,
  identity_anchor text,
  workflow_family text NOT NULL,
  occurred_at timestamptz,
  fields jsonb NOT NULL,
  missing_fields text[] NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  parser_version text NOT NULL,
  lineage_artifact_ids text[] NOT NULL,
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, artifact_id) REFERENCES artifact (clinic_id, id)
);

CREATE TABLE workflow (
  clinic_id text NOT NULL,
  id text NOT NULL,
  subject_type text NOT NULL,
  identity_anchor text,
  workflow_family text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'VOIDED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  CHECK (subject_type <> 'patient' OR (identity_anchor IS NOT NULL AND btrim(identity_anchor) <> ''))
);

CREATE TABLE workflow_artifact_link (
  clinic_id text NOT NULL,
  id text NOT NULL,
  workflow_id text NOT NULL,
  artifact_id text NOT NULL,
  attached_at timestamptz NOT NULL,
  decision_source text NOT NULL CHECK (decision_source IN ('DETERMINISTIC', 'HUMAN')),
  reasoning_chain text[] NOT NULL CHECK (cardinality(reasoning_chain) > 0),
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, workflow_id, artifact_id),
  FOREIGN KEY (clinic_id, workflow_id) REFERENCES workflow (clinic_id, id),
  FOREIGN KEY (clinic_id, artifact_id) REFERENCES artifact (clinic_id, id)
);

CREATE TABLE expectation (
  clinic_id text NOT NULL,
  id text NOT NULL,
  workflow_id text NOT NULL,
  trigger_kind text NOT NULL,
  consequence_kind text NOT NULL,
  triggered_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN', 'MET', 'UNMET', 'VOIDED')),
  satisfied_by_artifact_id text,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, workflow_id) REFERENCES workflow (clinic_id, id),
  FOREIGN KEY (clinic_id, satisfied_by_artifact_id) REFERENCES artifact (clinic_id, id),
  CHECK (due_at >= triggered_at),
  CHECK (
    (state = 'MET' AND satisfied_by_artifact_id IS NOT NULL) OR
    (state <> 'MET' AND satisfied_by_artifact_id IS NULL)
  )
);

CREATE TABLE manager_decision (
  clinic_id text NOT NULL,
  id text NOT NULL,
  workflow_id text NOT NULL,
  expectation_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('CLOSE_STANDARD', 'CLOSE_EXCEPTION', 'KEEP_OPEN', 'VOID')),
  reason_code text CHECK (
    reason_code IS NULL OR reason_code IN (
      'LEGITIMATE_DEVIATION',
      'MISSING_EXTERNAL_RECORD',
      'DUPLICATE_WORKFLOW',
      'PATIENT_CANCELLED',
      'NEEDS_MORE_EVIDENCE'
    )
  ),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  actor_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role = 'MANAGER'),
  decided_at timestamptz NOT NULL,
  evidence_artifact_ids text[] NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('PENDING', 'VERIFIED', 'CONFLICT')),
  verification_reason_codes text[] NOT NULL CHECK (
    verification_reason_codes <@ ARRAY[
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
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, workflow_id) REFERENCES workflow (clinic_id, id),
  FOREIGN KEY (clinic_id, expectation_id) REFERENCES expectation (clinic_id, id),
  CHECK (action NOT IN ('CLOSE_EXCEPTION', 'VOID') OR reason_code IS NOT NULL)
);

CREATE TRIGGER artifact_append_only
BEFORE UPDATE OR DELETE ON artifact
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

CREATE TRIGGER workflow_artifact_link_append_only
BEFORE UPDATE OR DELETE ON workflow_artifact_link
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

CREATE TRIGGER manager_decision_append_only
BEFORE UPDATE OR DELETE ON manager_decision
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

ALTER TABLE artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_clinic_scope ON artifact
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE evidence_fact_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_fact_card FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_fact_card_clinic_scope ON evidence_fact_card
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_clinic_scope ON workflow
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE workflow_artifact_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_artifact_link FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_artifact_link_clinic_scope ON workflow_artifact_link
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE expectation ENABLE ROW LEVEL SECURITY;
ALTER TABLE expectation FORCE ROW LEVEL SECURITY;
CREATE POLICY expectation_clinic_scope ON expectation
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE manager_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY manager_decision_clinic_scope ON manager_decision
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
