CREATE TABLE stored_object_ref (
  clinic_id text NOT NULL CHECK (btrim(clinic_id) <> ''),
  object_id text NOT NULL CHECK (object_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  PRIMARY KEY (clinic_id, object_id),
  UNIQUE (clinic_id, object_id, content_sha256)
);

ALTER TABLE evidence_fact_card
  ADD CONSTRAINT evidence_fact_card_attempt_lineage_unique UNIQUE (clinic_id, id, artifact_id);

CREATE TABLE evidence_extraction_attempt (
  clinic_id text NOT NULL CHECK (btrim(clinic_id) <> ''),
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  object_id text NOT NULL,
  object_content_sha256 text NOT NULL,
  artifact_id text NOT NULL CHECK (btrim(artifact_id) <> ''),
  fact_card_id text,
  status text NOT NULL CHECK (status IN ('READY', 'REVIEW_REQUIRED')),
  candidate jsonb NOT NULL CHECK (
    jsonb_typeof(candidate) = 'object' AND octet_length(candidate::text) <= 65536
  ),
  reason_codes text[] NOT NULL CHECK (
    array_position(reason_codes, NULL) IS NULL AND
    reason_codes <@ ARRAY['LOW_CONFIDENCE', 'REQUIRED_FIELDS_MISSING']::text[] AND
    cardinality(reason_codes) <= 2 AND
    (cardinality(reason_codes) <> 2 OR reason_codes @> ARRAY['LOW_CONFIDENCE', 'REQUIRED_FIELDS_MISSING']::text[])
  ),
  provider_kind text NOT NULL CHECK (provider_kind IN ('LOCAL_MODEL', 'PRIVATE_CLOUD_MODEL')),
  model_id text NOT NULL CHECK (btrim(model_id) <> ''),
  model_manifest_sha256 text NOT NULL CHECK (model_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  capability text NOT NULL CHECK (btrim(capability) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  policy_version text NOT NULL CHECK (btrim(policy_version) <> ''),
  parser_version text NOT NULL CHECK (btrim(parser_version) <> ''),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (clinic_id, request_id),
  FOREIGN KEY (clinic_id, object_id, object_content_sha256)
    REFERENCES stored_object_ref (clinic_id, object_id, content_sha256),
  FOREIGN KEY (clinic_id, artifact_id) REFERENCES artifact (clinic_id, id),
  FOREIGN KEY (clinic_id, fact_card_id, artifact_id)
    REFERENCES evidence_fact_card (clinic_id, id, artifact_id),
  CHECK (
    (status = 'READY' AND fact_card_id IS NOT NULL AND cardinality(reason_codes) = 0) OR
    (status = 'REVIEW_REQUIRED' AND fact_card_id IS NULL AND cardinality(reason_codes) > 0)
  )
);

CREATE TRIGGER stored_object_ref_append_only
BEFORE UPDATE OR DELETE ON stored_object_ref
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

CREATE TRIGGER evidence_fact_card_append_only
BEFORE UPDATE OR DELETE ON evidence_fact_card
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

CREATE TRIGGER evidence_extraction_attempt_append_only
BEFORE UPDATE OR DELETE ON evidence_extraction_attempt
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

ALTER TABLE stored_object_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_object_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY stored_object_ref_clinic_scope ON stored_object_ref
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

ALTER TABLE evidence_extraction_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_extraction_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_extraction_attempt_clinic_scope ON evidence_extraction_attempt
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
