# SDLC Log: Workflow Integration Node — Feature Spec Phase

**Date**: 2026-04-11
**Phase**: FEATURE-SPEC (post-implementation update)
**Artifact**: `docs/features/workflow-integration-node.md`

## Context

Feature spec existed at PLANNED status (written 2026-04-09). Implementation completed on current branch `KI081/feat/workflows-integration-node`. This log covers the post-implementation sync of the feature spec to ALPHA status.

## Oracle Decisions

N/A — Feature spec already existed. No clarifying questions needed. Updates were driven by comparing spec against actual implementation code.

## Discrepancies Found (Spec vs Implementation)

| Area                 | Spec Claimed                      | Actual Implementation                                       | Resolution                        |
| -------------------- | --------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| Route file           | `connector-actions.ts` (new file) | Added to existing `connectors.ts`                           | Updated Section 10                |
| Test file name       | `integration-node.spec.ts`        | `workflow-integration-node.spec.ts`                         | Updated Section 10                |
| OAuth grant resolver | Not mentioned                     | 140 lines inline in `index.ts`                              | Added to Sections 7 + 10, GAP-005 |
| `coerceParams()`     | Not mentioned                     | Added to `context-translator.ts`                            | Added to Sections 7 + 10          |
| Catalog route        | Not mentioned                     | `apps/studio/src/app/api/projects/[id]/connectors/route.ts` | Added to Section 10               |
| Timeout units        | `60000` (ms) in example           | `60` (seconds) passed as-is                                 | Fixed example, added GAP-012      |
| Test coverage        | All NOT TESTED                    | 8 of 15 PASS                                                | Updated Section 17                |

## Audit Rounds

### Round 1: APPROVED

- No CRITICAL findings
- HIGH: Testing guide file doesn't exist (deferred — acceptable for ALPHA)
- MEDIUM: Doc type mismatch (fixed: SUB-FEATURE → MAJOR FEATURE), dead connections.md link (fixed), README indexes not updated (fixed)

### Round 2: APPROVED

- No CRITICAL findings
- MEDIUM: Timeout units mismatch (added GAP-012), delivery plan missing `array` type (fixed)

## Files Created/Modified

- `docs/features/workflow-integration-node.md` — Updated status PLANNED→ALPHA, Sections 7, 10, 16, 17
- `docs/features/README.md` — Added feature #91 to P3 table
- `docs/testing/README.md` — Added feature #91 row
- `docs/sdlc-logs/workflow-integration-node/feature-spec.log.md` — This file

## New Gaps Added

- GAP-005: OAuth grant resolver inline in index.ts (HIGH — blocks BETA)
- GAP-006: Swallowed catches in IntegrationNodeConfig.tsx (MEDIUM)
- GAP-007: Dead IntegrationConfig stub code (LOW)
- GAP-008: `(connection as any).userId` cast (LOW)
- GAP-009: No unit tests for coerceParams() (MEDIUM)
- GAP-010: Catalog route imports from source path (LOW)
- GAP-011: No timeout on UI fetch calls (LOW)
- GAP-012: Timeout units mismatch seconds vs milliseconds (MEDIUM)

## Next Steps

Run `/test-spec workflow-integration-node` to generate the test specification.
