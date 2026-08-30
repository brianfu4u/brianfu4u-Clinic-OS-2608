import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext, Expectation, VerificationResult } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { DatabasePool, TenantQueryClient } from "../persistence/database-contracts.ts";
import { reevaluateExpectationInTransaction } from "../persistence/expectation-repository.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import { withTenantTransaction } from "../persistence/tenant-transaction.ts";
import { verifyCurrentExpectationInTransaction } from "../persistence/verification-repository.ts";

export interface DueExpectationBatchCommand {
  now: string;
  limit: number;
  cursor: string | null;
}

export interface DueExpectationBatchResult {
  processed: Array<{ expectationId: string }>;
  succeeded: Array<{
    expectationId: string;
    state: Expectation["state"];
    verificationStatus: VerificationResult["status"];
  }>;
  failed: Array<{ expectationId: string; code: string }>;
  nextCursor: string | null;
}

type DueRow = { id: string; due_at: Date | string };
type CursorKey = { dueAt: string; expectationId: string };

export class DueExpectationBatch {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async processDueExpectations(
    context: ActorContext,
    command: DueExpectationBatchCommand,
  ): Promise<DueExpectationBatchResult> {
    const captured = structuredClone({ context, command });
    const input = validateInput(captured.context, captured.command);

    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      const rows = await selectDueExpectations(
        client,
        captured.context.clinicId,
        input.now,
        input.limit,
        input.cursor,
      );
      const output: DueExpectationBatchResult = {
        processed: [],
        succeeded: [],
        failed: [],
        nextCursor: rows.length === 0 ? null : encodeCursor(rows.at(-1) as DueRow),
      };

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const savepoint = `due_expectation_${index}`;
        output.processed.push({ expectationId: row.id });
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const expectation = await reevaluateExpectationInTransaction(
            client,
            captured.context.clinicId,
            row.id,
            input.now,
          );
          const verification = await verifyCurrentExpectationInTransaction(
            client,
            captured.context.clinicId,
            row.id,
          );
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          output.succeeded.push({
            expectationId: row.id,
            state: expectation.expectation.state,
            verificationStatus: verification.result.status,
          });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          output.failed.push({ expectationId: row.id, code: error.code });
        }
      }
      return structuredClone(output);
    });
  }
}

function validateInput(
  context: ActorContext,
  command: DueExpectationBatchCommand,
): { now: string; limit: number; cursor: CursorKey | null } {
  assertActorContext(context);
  if (context.role !== "MANAGER") {
    throw new DomainError("ROLE_SCOPE_VIOLATION", "This operation requires the MANAGER role.");
  }
  if (!command || typeof command !== "object" || Array.isArray(command) ||
      Object.keys(command).sort().join("|") !== "cursor|limit|now") {
    throw new DomainError("INVALID_DUE_BATCH_COMMAND", "Due batch command has an invalid shape.");
  }
  const now = parseStrictIsoInstant(command.now);
  if (now === null) {
    throw new DomainError("INVALID_DUE_BATCH_TIME", "Batch time requires an explicit valid ISO-8601 timestamp.");
  }
  if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 100) {
    throw new DomainError("INVALID_DUE_BATCH_LIMIT", "Batch limit must be an integer from 1 through 100.");
  }
  return {
    now: new Date(now).toISOString(),
    limit: command.limit,
    cursor: command.cursor === null ? null : decodeCursor(command.cursor),
  };
}

async function selectDueExpectations(
  client: TenantQueryClient,
  clinicId: string,
  now: string,
  limit: number,
  cursor: CursorKey | null,
): Promise<DueRow[]> {
  const result = await client.query<DueRow>(
    `SELECT e.id, e.due_at
       FROM expectation e
       JOIN workflow w ON w.clinic_id = e.clinic_id AND w.id = e.workflow_id
      WHERE e.clinic_id = $1 AND e.state = 'OPEN' AND e.due_at <= $2
        AND w.status = 'OPEN'
        AND ($3::timestamptz IS NULL OR (e.due_at, e.id) > ($3::timestamptz, $4::text))
      ORDER BY e.due_at, e.id
      FOR UPDATE OF e SKIP LOCKED
      LIMIT $5`,
    [clinicId, now, cursor?.dueAt ?? null, cursor?.expectationId ?? null, limit],
  );
  return result.rows;
}

function encodeCursor(row: DueRow): string {
  const dueAt = row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at;
  const instant = parseStrictIsoInstant(dueAt);
  if (instant === null || typeof row.id !== "string" || row.id.trim() === "") {
    throw new DomainError("INVALID_STORED_DUE_EXPECTATION", "Selected due Expectation key is malformed.");
  }
  return Buffer.from(JSON.stringify([new Date(instant).toISOString(), row.id])).toString("base64url");
}

function decodeCursor(value: unknown): CursorKey {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DomainError("INVALID_DUE_BATCH_CURSOR", "Batch cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) throw new Error("non-canonical");
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || parsed[1].trim() === "") {
      throw new Error("shape");
    }
    const instant = parseStrictIsoInstant(parsed[0]);
    if (instant === null || new Date(instant).toISOString() !== parsed[0]) throw new Error("time");
    return { dueAt: parsed[0], expectationId: parsed[1] };
  } catch {
    throw new DomainError("INVALID_DUE_BATCH_CURSOR", "Batch cursor is invalid.");
  }
}
