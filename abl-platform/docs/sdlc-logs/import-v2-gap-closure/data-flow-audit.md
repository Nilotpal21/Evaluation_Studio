# Data Flow Audit: Import v2 Conflict Strategy

**Date**: 2026-05-06
**Ticket**: ABLP-869
**Status**: Phase 1 parity lock in progress

## Field Pipeline

Field under audit: `deleteUnmatched`

Derived field: `conflictStrategy`

| Layer           | File                                                            | Handling                                                                                                                    |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| UI/API request  | `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` | Reads optional `deleteUnmatched`; defaults to `false`.                                                                      |
| UI/API request  | `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`   | Reads optional `deleteUnmatched`; defaults to `false`.                                                                      |
| Route mapping   | preview/apply routes                                            | Maps `deleteUnmatched ? "replace" : "merge"`.                                                                               |
| Studio helper   | `apps/studio/src/lib/project-import/layered-import-support.ts`  | Passes `conflictStrategy` to `importProjectV2`; defaults to `"merge"` if absent.                                            |
| Project-io type | `packages/project-io/src/types.ts`                              | `ImportConflictStrategyV2 = "replace"                                                                                       | "skip" | "merge"`. |
| Orchestrator    | `packages/project-io/src/import/project-importer-v2.ts`         | Forwards `options.conflictStrategy` into disassembler context.                                                              |
| Disassemblers   | `packages/project-io/src/import/layer-disassemblers/*`          | `replace` supersedes full active layer; `merge` supersedes matching records only; `skip` preserves matching active records. |

## Propagation Matrix

| Field                         | Preview Route        | Apply Route          | Studio Helper                | Import v2 | Disassemblers |
| ----------------------------- | -------------------- | -------------------- | ---------------------------- | --------- | ------------- |
| `deleteUnmatched`             | Y                    | Y                    | N/A, mapped before helper    | N/A       | N/A           |
| `conflictStrategy: "merge"`   | Y, when absent/false | Y, when absent/false | Y                            | Y         | Y             |
| `conflictStrategy: "replace"` | Y, when true         | Y, when true         | Y                            | Y         | Y             |
| `conflictStrategy: "skip"`    | -                    | -                    | Supported for future callers | Y         | Y             |

## Boundary Risks

| Risk                                                   | Mitigation                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Route accepts `deleteUnmatched` but silently drops it. | Add route parity test asserting helper receives `replace`.                                        |
| Helper defaults drift from route defaults.             | Add helper/route test asserting default is `merge`.                                               |
| New disassembler only handles `replace`/`skip`.        | Type-level `ImportConflictStrategyV2` forces compile errors when context is narrowed incorrectly. |
| Merge key accidentally supersedes unrelated records.   | Per-layer merge tests verify preserve-unrelated behavior.                                         |

## Verdict

No current propagation gap found after the merge-strategy slice. Phase 1 adds route-level parity coverage to keep the request-to-v2 mapping locked.
