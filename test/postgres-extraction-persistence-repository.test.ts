import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  EYE_EXAM_EXTRACTION_SPEC,
  type StoredEvidenceExtractionResult,
} from "../src/application/evidence-extraction.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { ExtractionPersistenceRepository } from "../src/persistence/extraction-persistence-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import type { StoredObjectRef } from "../src/storage/contracts.ts";

class PoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  failPattern: string | null = null;
  gate: Promise<void> | null = null;

  async migrate() { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    if (this.gate) await this.gate;
    return {
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<DatabaseQueryResult<Row>> => {
        if (this.failPattern && text.includes(this.failPattern)) throw new Error("forced database failure");
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        return { rows: result.rows };
      },
      release() {},
    };
  }
  async close() { await this.db.close(); }
}

const context = (clinicId = "clinic-a"): ActorContext => ({ clinicId, actorId: "employee-a", role: "EMPLOYEE" });
const ref = (clinicId = "clinic-a"): StoredObjectRef => ({
  clinicId, objectId: "object-a", contentSha256: "a".repeat(64), sizeBytes: 123, mediaType: "image/png",
});

function ready(clinicId = "clinic-a"): StoredEvidenceExtractionResult {
  const objectRef = ref(clinicId);
  return {
    status: "READY",
    artifact: {
      id: "artifact-a", clinicId, kind: "EXAM_REPORT", occurredAt: "2026-08-30T09:00:00.000Z",
      occurredAtSource: "source", sourceEmployeeId: "employee-a", identityAnchor: " PAT-001 ",
      payload: { storedObjectRef: objectRef }, createdAt: "2026-08-30T09:00:01.000Z",
    },
    factCard: {
      id: "fact-a", clinicId, artifactId: "artifact-a", subjectType: "PATIENT",
      identityAnchor: " PAT-001 ", workflowFamily: "EYE_EXAM", occurredAt: "2026-08-30T09:00:00.000Z",
      fields: { nested: { value: 1 }, reportType: "EYE_EXAM" }, missingFields: [], confidence: 0.95,
      parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion, lineageArtifactIds: ["artifact-a"],
    },
    candidate: {
      subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
      fields: { reportType: "EYE_EXAM", nested: { value: 1 } }, missingFields: [], confidence: 0.95,
    },
    reasonCodes: [],
    lineage: {
      requestId: "request-a", providerKind: "LOCAL_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId,
      modelManifestSha256: EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256,
      capability: EYE_EXAM_EXTRACTION_SPEC.capability, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
      policyVersion: EYE_EXAM_EXTRACTION_SPEC.policyVersion, parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion,
      completedAt: "2026-08-30T09:00:02.000Z", objectContentSha256: objectRef.contentSha256,
    },
  };
}

function review(clinicId = "clinic-a"): StoredEvidenceExtractionResult {
  const result = ready(clinicId) as StoredEvidenceExtractionResult & { factCard: unknown };
  return {
    ...result,
    status: "REVIEW_REQUIRED",
    factCard: null,
    candidate: { ...result.candidate, fields: {}, missingFields: ["reportType"], confidence: 0.7 },
    reasonCodes: ["LOW_CONFIDENCE", "REQUIRED_FIELDS_MISSING"],
  } as StoredEvidenceExtractionResult;
}

async function counts(pool: PoolShim) {
  const result = await pool.db.query<{ objects: number; artifacts: number; facts: number; attempts: number }>(
    `SELECT (SELECT count(*)::int FROM stored_object_ref) objects,
            (SELECT count(*)::int FROM artifact) artifacts,
            (SELECT count(*)::int FROM evidence_fact_card) facts,
            (SELECT count(*)::int FROM evidence_extraction_attempt) attempts`,
  );
  return result.rows[0];
}

test("READY atomically persists and traces Object, Artifact, FactCard and model lineage", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    const saved = await repository.saveExtraction(context(), ref(), ready());
    assert.deepEqual(saved, ready());
    assert.deepEqual(await counts(pool), { objects: 1, artifacts: 1, facts: 1, attempts: 1 });
    const trace = await pool.db.query(`SELECT f.id fact_id,a.request_id,a.object_id,a.model_id,a.model_manifest_sha256
      FROM evidence_fact_card f JOIN evidence_extraction_attempt a
      ON (a.clinic_id,a.fact_card_id)=(f.clinic_id,f.id)`);
    assert.deepEqual(trace.rows[0], {
      fact_id: "fact-a", request_id: "request-a", object_id: "object-a",
      model_id: EYE_EXAM_EXTRACTION_SPEC.modelId,
      model_manifest_sha256: EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256,
    });
  } finally { await pool.close(); }
});

test("REVIEW_REQUIRED persists no FactCard and retains candidate reasons and parser lineage", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const saved = await new ExtractionPersistenceRepository(pool).saveExtraction(context(), ref(), review());
    assert.deepEqual(saved, review());
    assert.deepEqual(await counts(pool), { objects: 1, artifacts: 1, facts: 0, attempts: 1 });
  } finally { await pool.close(); }
});

test("semantic replay is idempotent while changed object, outcome or lineage conflicts", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    await repository.saveExtraction(context(), ref(), ready());
    const equivalent = ready();
    equivalent.artifact.occurredAt = "2026-08-30T18:00:00.000+09:00";
    equivalent.artifact.createdAt = "2026-08-30T18:00:01.000+09:00";
    equivalent.factCard.occurredAt = equivalent.artifact.occurredAt;
    equivalent.lineage.completedAt = "2026-08-30T18:00:02.000+09:00";
    equivalent.candidate.fields = { nested: { value: 1 }, reportType: "EYE_EXAM" };
    equivalent.factCard.fields = { reportType: "EYE_EXAM", nested: { value: 1 } };
    assert.deepEqual((await repository.saveExtraction(context(), ref(), equivalent)).lineage, ready().lineage);
    const changed = ready(); changed.lineage.completedAt = "2026-08-30T09:00:03.000Z";
    await assert.rejects(repository.saveExtraction(context(), ref(), changed), code("EXTRACTION_REQUEST_CONFLICT"));
    assert.deepEqual(await counts(pool), { objects: 1, artifacts: 1, facts: 1, attempts: 1 });
  } finally { await pool.close(); }
});

test("tenant authority and same IDs in separate clinics remain isolated", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    await repository.saveExtraction(context(), ref(), ready());
    await repository.saveExtraction(context("clinic-b"), ref("clinic-b"), ready("clinic-b"));
    const attack = ready(); attack.artifact.clinicId = "clinic-b";
    await assert.rejects(repository.saveExtraction(context(), ref(), attack), code("TENANT_SCOPE_VIOLATION"));
    assert.deepEqual(await counts(pool), { objects: 2, artifacts: 2, facts: 2, attempts: 2 });
  } finally { await pool.close(); }
});

test("runtime shape, candidate authority, state contradictions and manifest hash fail before acquisition", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    const cases: StoredEvidenceExtractionResult[] = [];
    const injected = ready(); (injected.candidate.fields as Record<string, unknown>).workflowId = "forged"; cases.push(injected);
    const contradiction = ready() as unknown as { status: "REVIEW_REQUIRED" } & StoredEvidenceExtractionResult;
    contradiction.status = "REVIEW_REQUIRED"; cases.push(contradiction);
    const badHash = ready(); badHash.lineage.modelManifestSha256 = "bad"; cases.push(badHash);
    const badJson = ready(); (badJson.candidate.fields as Record<string, unknown>).bad = Number.NaN; cases.push(badJson);
    const extraLineage = ready(); extraLineage.factCard.lineageArtifactIds.push("forged-extra");
    const replacedLineage = ready(); replacedLineage.factCard.lineageArtifactIds = ["nonexistent"];
    const before = pool.acquisitions;
    for (const value of cases) await assert.rejects(repository.saveExtraction(context(), ref(), value));
    await assert.rejects(repository.saveExtraction(context(), ref(), extraLineage), code("FACT_CARD_LINEAGE_INVALID"));
    await assert.rejects(repository.saveExtraction(context(), ref(), replacedLineage), code("FACT_CARD_LINEAGE_INVALID"));
    assert.equal(pool.acquisitions, before);
  } finally { await pool.close(); }
});

test("top-level and nested accessors or proxies are rejected without trap execution or acquisition", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    let executions = 0;
    const topGetter = ready();
    const topCandidate = topGetter.candidate;
    Object.defineProperty(topGetter, "candidate", { get() { executions += 1; return topCandidate; } });
    const nestedGetter = ready();
    Object.defineProperty(nestedGetter.candidate.fields, "reportType", {
      get() { executions += 1; return "EYE_EXAM"; }, enumerable: true,
    });
    const nestedProxy = ready();
    nestedProxy.candidate.fields = new Proxy(nestedProxy.candidate.fields, {
      get(target, key, receiver) { executions += 1; return Reflect.get(target, key, receiver); },
      ownKeys(target) { executions += 1; return Reflect.ownKeys(target); },
    });
    const topProxy = new Proxy(ready(), {
      get(target, key, receiver) { executions += 1; return Reflect.get(target, key, receiver); },
      ownKeys(target) { executions += 1; return Reflect.ownKeys(target); },
    });
    const before = pool.acquisitions;
    for (const hostile of [topGetter, nestedGetter, nestedProxy, topProxy]) {
      await assert.rejects(
        repository.saveExtraction(context(), ref(), hostile),
        code("INVALID_EXTRACTION_PERSISTENCE_INPUT"),
      );
    }
    assert.equal(executions, 0);
    assert.equal(pool.acquisitions, before);
  } finally { await pool.close(); }
});

test("forced failure at every write stage rolls back the complete tenant unit", async () => {
  for (const pattern of [
    "INSERT INTO stored_object_ref", "INSERT INTO artifact", "INSERT INTO evidence_fact_card",
    "INSERT INTO evidence_extraction_attempt",
  ]) {
    const pool = new PoolShim(); await pool.migrate(); pool.failPattern = pattern;
    try {
      await assert.rejects(
        new ExtractionPersistenceRepository(pool).saveExtraction(context(), ref(), ready()),
        code("EXTRACTION_PERSISTENCE_FAILED"),
      );
      assert.deepEqual(await counts(pool), { objects: 0, artifacts: 0, facts: 0, attempts: 0 });
    } finally { await pool.close(); }
  }
});

test("caller and returned mutation cannot change captured or stored extraction", async () => {
  const pool = new PoolShim(); await pool.migrate();
  let resume!: () => void; pool.gate = new Promise<void>((resolve) => resume = resolve);
  try {
    const repository = new ExtractionPersistenceRepository(pool);
    const input = ready();
    const pending = repository.saveExtraction(context(), ref(), input);
    input.lineage.modelId = "mutated";
    input.candidate.fields.reportType = "mutated";
    resume();
    const saved = await pending;
    pool.gate = null;
    saved.lineage.modelId = "returned-mutation";
    saved.candidate.fields.reportType = "returned-mutation";
    const replay = await repository.saveExtraction(context(), ref(), ready());
    assert.equal(replay.lineage.modelId, EYE_EXAM_EXTRACTION_SPEC.modelId);
    assert.equal(replay.candidate.fields.reportType, "EYE_EXAM");
  } finally { await pool.close(); }
});

test("SQL rejects broken composite lineage and READY/REVIEW contradictions", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    await new ExtractionPersistenceRepository(pool).saveExtraction(context(), ref(), ready());
    await assert.rejects(pool.db.query(`INSERT INTO evidence_extraction_attempt
      (clinic_id,request_id,object_id,object_content_sha256,artifact_id,fact_card_id,status,candidate,
       reason_codes,provider_kind,model_id,model_manifest_sha256,capability,schema_version,policy_version,
       parser_version,completed_at)
      SELECT clinic_id,'broken','object-a',$1,artifact_id,NULL,'READY',candidate,'{}',provider_kind,
       model_id,model_manifest_sha256,capability,schema_version,policy_version,parser_version,completed_at
      FROM evidence_extraction_attempt WHERE request_id='request-a'`, ["b".repeat(64)]));
    await assert.rejects(pool.db.query(`INSERT INTO evidence_extraction_attempt
      (clinic_id,request_id,object_id,object_content_sha256,artifact_id,fact_card_id,status,candidate,
       reason_codes,provider_kind,model_id,model_manifest_sha256,capability,schema_version,policy_version,
       parser_version,completed_at)
      SELECT clinic_id,'contradiction',object_id,object_content_sha256,artifact_id,NULL,'READY',candidate,
       '{LOW_CONFIDENCE}',provider_kind,model_id,model_manifest_sha256,capability,schema_version,
       policy_version,parser_version,completed_at FROM evidence_extraction_attempt WHERE request_id='request-a'`));
    await pool.db.query(`INSERT INTO stored_object_ref
      (clinic_id,object_id,content_sha256,size_bytes,media_type)
      VALUES ('clinic-b','object-a',$1,123,'image/png')`, ["b".repeat(64)]);
    await assert.rejects(pool.db.query(`INSERT INTO evidence_extraction_attempt
      (clinic_id,request_id,object_id,object_content_sha256,artifact_id,fact_card_id,status,candidate,
       reason_codes,provider_kind,model_id,model_manifest_sha256,capability,schema_version,policy_version,
       parser_version,completed_at)
      SELECT 'clinic-b','cross-clinic','object-a',$1,artifact_id,NULL,'REVIEW_REQUIRED',candidate,
       '{LOW_CONFIDENCE}',provider_kind,model_id,model_manifest_sha256,capability,schema_version,
       policy_version,parser_version,completed_at FROM evidence_extraction_attempt WHERE request_id='request-a'`,
    ["b".repeat(64)]));
  } finally { await pool.close(); }
});

test("Object, Attempt and FactCard are append-only and new tables force exact RLS", async () => {
  const pool = new PoolShim(); await pool.migrate();
  try {
    await new ExtractionPersistenceRepository(pool).saveExtraction(context(), ref(), ready());
    for (const table of ["stored_object_ref", "evidence_extraction_attempt", "evidence_fact_card"]) {
      await assert.rejects(pool.db.query(`UPDATE ${table} SET clinic_id=clinic_id`));
      await assert.rejects(pool.db.query(`DELETE FROM ${table}`));
    }
    const tables = await pool.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE relname IN ('stored_object_ref','evidence_extraction_attempt') ORDER BY relname`,
    );
    assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    const policies = await pool.db.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename,qual,with_check FROM pg_policies
       WHERE tablename IN ('stored_object_ref','evidence_extraction_attempt')`,
    );
    assert.equal(policies.rows.length, 2);
    assert.ok(policies.rows.every((row) => row.qual === row.with_check && row.qual.includes("current_setting('app.clinic_id'")));
  } finally { await pool.close(); }
});

function code(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}
