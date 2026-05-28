# ABLP-1060 Eval List Pagination Data-Flow Audit

Date: 2026-05-16

## Scope

Audit cursor pagination for Studio eval lists across database models, query parsing, repository paging, API routes, UI hooks, list surfaces, dialogs, and Arch testing tools.

## Layer Map

| Layer           | Files                                                    | Direction        |
| --------------- | -------------------------------------------------------- | ---------------- |
| Constants       | `packages/database/src/constants/eval-limits.ts`         | READ             |
| Database models | `packages/database/src/models/eval-*.model.ts`           | READ             |
| Query parser    | `apps/studio/src/lib/eval-list-query.ts`                 | READ             |
| Repository      | `apps/studio/src/repos/eval-repo.ts`                     | READ / TRANSFORM |
| API routes      | `apps/studio/src/app/api/projects/[id]/evals/*/route.ts` | PASS-THROUGH     |
| UI hook         | `apps/studio/src/hooks/useEvalData.ts`                   | READ / TRANSFORM |
| UI consumers    | `apps/studio/src/components/evals/**/*`                  | READ             |
| Tool consumer   | `apps/studio/src/lib/arch-ai/tools/testing-ops.ts`       | READ             |

## Propagation Matrix

| Field                   | Parser | Repo | API | Hook | UI  | Tool |
| ----------------------- | ------ | ---- | --- | ---- | --- | ---- |
| `limit`                 | Y      | Y    | Y   | Y    | Y   | Y    |
| `cursor`                | Y      | Y    | Y   | Y    | -   | Y    |
| `search`                | Y      | Y    | Y   | -    | -   | -    |
| `pagination.limit`      | -      | Y    | Y   | Y    | -   | -    |
| `pagination.nextCursor` | -      | Y    | Y   | Y    | -   | Y    |
| `pagination.hasMore`    | -      | Y    | Y   | Y    | Y   | Y    |
| `pagination.total`      | -      | Y    | Y   | Y    | Y   | Y    |

## Concrete Verification

`apps/studio/src/__tests__/eval-list-pagination-parity.test.ts` seeds 55 real `EvalScenario` documents in Mongo memory with the same `createdAt` value, then verifies:

- first page returns 50 items;
- `nextCursor` is emitted;
- second page returns the remaining 5 items;
- no IDs overlap across pages;
- total count remains 55.

Focused verification also covers Arch testing-op multi-page reads in `apps/studio/src/__tests__/arch-ai/testing-ops.test.ts`.

## Findings

### Fixed: Cursor Query Index Coverage

The repository sorts eval lists by `{ createdAt: -1, _id: -1 }` under `{ tenantId, projectId }`. Personas, scenarios, evaluators, sets, and runs did not all have a matching compound index. Added `{ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 }` to all eval list models.

### Fixed: Page-Size Constant Drift

`EVAL_LIST_MAX_PAGE_SIZE` was duplicated in Studio route parsing and repository paging. Moved it to `@agent-platform/database/constants/eval-limits` beside `EVAL_LIST_DEFAULT_PAGE_SIZE`.

### Fixed: Refresh Ordering

`usePaginatedEvalList.refresh()` previously fired `setSize(1)` and `mutate()` without waiting for the page count reset. It now awaits `setSize(1)` before revalidating.

## Verdict

No open data-flow gaps remain for ABLP-1060 eval list pagination. The current flow carries cursor, limit, and pagination metadata from API query to repository response, UI load-more controls, and the Arch testing tool consumer.
