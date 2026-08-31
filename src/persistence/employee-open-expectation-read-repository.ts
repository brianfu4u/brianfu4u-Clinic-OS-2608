import { assertActorAccess } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { isEyeExamFlowKind, type EyeExamFlowKind } from "../domain/eye-exam-flow-policy.ts";
import { DomainError } from "../domain/errors.ts";
import type { DatabasePool } from "./database-contracts.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

export type EmployeeOpenExpectationItem = {
  expectationId: string;
  workflowFamily: string;
  consequenceKind: EyeExamFlowKind;
  dueAt: string;
  state: "OPEN";
};

export type EmployeeOpenExpectationPage = {
  items: EmployeeOpenExpectationItem[];
  nextCursor: string | null;
};

export type EmployeeOpenExpectationQuery = {
  asOf: string;
  limit?: number;
  cursor?: string;
};

type Cursor = { dueAt: string; expectationId: string };
type Row = { id: string; workflow_family: string; due_at: Date | string };

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

/** Employee-safe selector.  This is deliberately not a general expectation reader. */
export class EmployeeOpenExpectationReadRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) { this.#pool = pool; }

  async listOpenExamReportExpectations(
    context: ActorContext,
    rawQuery: EmployeeOpenExpectationQuery,
  ): Promise<EmployeeOpenExpectationPage> {
    return this.listOpenFlowExpectations(context, rawQuery, "EXAM_REPORT");
  }

  async listOpenFlowExpectations(
    context: ActorContext,
    rawQuery: EmployeeOpenExpectationQuery,
    consequenceKind: EyeExamFlowKind,
  ): Promise<EmployeeOpenExpectationPage> {
    const captured = structuredClone({ context, query: rawQuery, consequenceKind });
    assertActorAccess(captured.context, captured.context.clinicId, "EMPLOYEE");
    if (!isEyeExamFlowKind(captured.consequenceKind)) {
      throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
    }
    const query = validateQuery(captured.query);
    const rows = await withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      const result = await client.query<Row>(`
        SELECT e.id, w.workflow_family, e.due_at
          FROM expectation e
          JOIN workflow w
            ON w.clinic_id = e.clinic_id AND w.id = e.workflow_id
          JOIN expectation_transition initial
            ON initial.clinic_id = e.clinic_id
           AND initial.expectation_id = e.id
           AND initial.workflow_id = e.workflow_id
           AND initial.from_state IS NULL
          JOIN workflow_artifact_link trigger_link
            ON trigger_link.clinic_id = initial.clinic_id
           AND trigger_link.workflow_id = initial.workflow_id
           AND trigger_link.artifact_id = initial.trigger_artifact_id
          JOIN artifact trigger_artifact
            ON trigger_artifact.clinic_id = trigger_link.clinic_id
           AND trigger_artifact.id = trigger_link.artifact_id
         WHERE e.clinic_id = $1
           AND w.clinic_id = $1
           AND initial.clinic_id = $1
           AND trigger_link.clinic_id = $1
           AND trigger_artifact.clinic_id = $1
           AND trigger_artifact.source_employee_id = $2
           AND e.state = 'OPEN'
           AND w.status = 'OPEN'
           AND e.consequence_kind = $7
           AND e.triggered_at <= $3::timestamptz
           AND $3::timestamptz < e.due_at
           AND ($4::timestamptz IS NULL OR e.due_at > $4::timestamptz
                OR (e.due_at = $4::timestamptz AND e.id > $5))
         ORDER BY e.due_at ASC, e.id ASC
         LIMIT $6`, [
        captured.context.clinicId, captured.context.actorId, query.asOf,
        query.cursor?.dueAt ?? null, query.cursor?.expectationId ?? "", query.limit + 1,
        captured.consequenceKind,
      ]);
      return result.rows;
    });
    const more = rows.length > query.limit;
    const visible = rows.slice(0, query.limit).map((row) => toItem(row, captured.consequenceKind));
    const last = visible.at(-1);
    return structuredClone({
      items: visible,
      nextCursor: more && last ? encodeCursor({ dueAt: last.dueAt, expectationId: last.expectationId }) : null,
    });
  }
}

function validateQuery(value: unknown): { asOf: string; limit: number; cursor: Cursor | undefined } {
  if (!isRecord(value) || !hasExactKeys(value, ["asOf", "cursor", "limit"], ["asOf"])) {
    throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  }
  if (typeof value.asOf !== "string" || parseStrictIsoInstant(value.asOf) === null) {
    throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  }
  const limit = value.limit === undefined ? DEFAULT_LIMIT : value.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  }
  return { asOf: value.asOf, limit, cursor: value.cursor === undefined ? undefined : decodeCursor(value.cursor) };
}

function toItem(row: Row, consequenceKind: EyeExamFlowKind): EmployeeOpenExpectationItem {
  let dueAt: string;
  try { dueAt = new Date(row.due_at).toISOString(); }
  catch { throw new DomainError("INCONSISTENT_EXPECTATION_LINEAGE", "Stored expectation lineage is inconsistent."); }
  if (!isOpaqueId(row.id) || typeof row.workflow_family !== "string" || !row.workflow_family || row.workflow_family.length > 128) {
    throw new DomainError("INCONSISTENT_EXPECTATION_LINEAGE", "Stored expectation lineage is inconsistent.");
  }
  return { expectationId: row.id, workflowFamily: row.workflow_family, consequenceKind, dueAt, state: "OPEN" };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid."); }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["dueAt", "expectationId"], ["dueAt", "expectationId"]) ||
      typeof parsed.dueAt !== "string" || parseStrictIsoInstant(parsed.dueAt) === null ||
      !isOpaqueId(parsed.expectationId) || encodeCursor({ dueAt: parsed.dueAt, expectationId: parsed.expectationId }) !== value) {
    throw new DomainError("INVALID_EXPECTATION_QUERY", "Expectation query is invalid.");
  }
  return { dueAt: parsed.dueAt, expectationId: parsed.expectationId };
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => key in value);
}
