# WO-017 — Tenant-Scoped Due Expectation Batch

**Status:** FROZEN
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Depends on:** WO-001 through WO-016 accepted locally through `7f7609c`

## 1. Outcome

Provide one explicit PostgreSQL command that advances due, open Expectations and records the matching S2 result without mutating state from a dashboard GET:

```text
manager ActorContext + explicit now + bounded page
  -> lock due OPEN Expectations
  -> re-evaluate each
  -> persist current S2 Verification
  -> return controlled per-item result
```

This is a callable batch primitive, not a scheduler, worker framework or background daemon.

## 2. Minimal files

```text
src/application/due-expectation-batch.ts
src/persistence/expectation-repository.ts
src/persistence/verification-repository.ts
test/due-expectation-batch.test.ts
README.md
```

Only the minimum extraction of client-scoped re-evaluation and verification cores is allowed. Existing public repository behavior must remain unchanged. No migration, dependency, queue, job table, HTTP GET mutation or generic batch framework.

## 3. Command

Expose an operation equivalent to:

```ts
processDueExpectations(context, {
  now,
  limit,
  cursor,
})
```

- Require a valid `MANAGER` ActorContext before acquisition. Do not add a SERVICE role in this ticket.
- `now` is a strict explicit zoned ISO instant; never read the system clock.
- `limit` is an integer from 1 through 100.
- Cursor is an opaque, validated encoding of the previous `(dueAt, expectationId)` keyset, or null.
- Clinic and authority never come from the command body.

Return detached `processed`, `succeeded`, `failed` entries and `nextCursor`. Failed entries expose only Expectation ID plus stable DomainError code. Do not claim `hasMore`: `SKIP LOCKED` makes that unknowable for the current pass.

## 4. Transaction and locking

Run one bounded tenant transaction for the page:

1. select `Expectation.state = OPEN`, `due_at <= now`, and open Workflow rows after the cursor;
2. order by `due_at, id`;
3. lock `FOR UPDATE OF expectation SKIP LOCKED LIMIT $n`;
4. for each row, create a SAVEPOINT named only from the trusted loop index;
5. re-evaluate and verify through extracted client-scoped cores inside that savepoint;
6. on a controlled per-item failure, roll back to the savepoint, record its stable code and continue;
7. commit the page once all selected rows finish.

Re-evaluation and Verification for one item either both commit or both roll back. Do not select IDs in one transaction and process them in later transactions; that releases locks and permits duplicate concurrent work. The established public repository methods remain thin tenant-transaction wrappers around the same cores.

## 5. Idempotency and failure semantics

- Same `now` replay creates no duplicate transition or Verification.
- Later runs select only projections still eligible as `OPEN`; MET, UNMET, VOIDED and terminal Workflows are excluded.
- One malformed/broken chain does not block a later candidate in the same page.
- Unexpected non-domain database failure may fail and roll back the entire page; never serialize raw SQL/database messages into the result.
- Page order and cursor progression are deterministic.

## 6. Required tests

1. due boundary OPEN becomes UNMET and receives current PENDING S2;
2. future OPEN is not selected;
3. MET, UNMET, VOIDED and terminal Workflow rows are not selected;
4. tenant isolation and employee/invalid authority fail closed before business work;
5. strict `now`, limit and cursor validation;
6. stable `(dueAt,id)` keyset paging without duplicates;
7. same-now replay creates no new transition or Verification;
8. one controlled broken chain rolls back only that item and the next item succeeds;
9. forced Verification failure rolls back that item's Expectation transition/projection;
10. SAVEPOINT names contain no caller/record content and SQL values remain bound;
11. returned objects are detached and error output contains no PHI/raw database detail;
12. all prior tests and both demos remain green.

PGlite proves SQL semantics and savepoint behavior only. Real PostgreSQL two-worker `SKIP LOCKED` interleaving remains a deployment acceptance test and must not be claimed complete here.

## 7. Honest boundary

No cron, scheduler, worker, queue, HTTP route, automatic retry, job history, SERVICE principal, real-server concurrency proof, backup/restore or production readiness.

## 8. Acceptance

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
git diff --check
```

Builder commits `feat(application): process due expectations` and does not push before Architecture Review.
