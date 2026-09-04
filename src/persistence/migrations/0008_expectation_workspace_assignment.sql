CREATE TABLE expectation_workspace_assignment (
  clinic_id text NOT NULL,
  expectation_id text NOT NULL,
  workspace text NOT NULL CHECK (workspace IN ('DOCTOR', 'EXAM', 'CASHIER')),
  PRIMARY KEY (clinic_id, expectation_id),
  FOREIGN KEY (clinic_id, expectation_id) REFERENCES expectation (clinic_id, id)
);

INSERT INTO expectation_workspace_assignment (clinic_id, expectation_id, workspace)
SELECT clinic_id, id,
  CASE consequence_kind
    WHEN 'PRESCRIPTION' THEN 'DOCTOR'
    WHEN 'EXAM_REPORT' THEN 'EXAM'
    WHEN 'PAYMENT' THEN 'CASHIER'
  END
FROM expectation
WHERE consequence_kind IN ('PRESCRIPTION', 'EXAM_REPORT', 'PAYMENT');

CREATE TRIGGER expectation_workspace_assignment_append_only
BEFORE UPDATE OR DELETE ON expectation_workspace_assignment
FOR EACH ROW EXECUTE FUNCTION refuse_append_only_change();

ALTER TABLE expectation_workspace_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE expectation_workspace_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY expectation_workspace_assignment_clinic_scope ON expectation_workspace_assignment
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
