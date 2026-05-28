# Session Model Index Audit

**Date**: 2026-03-13
**Model**: `packages/database/src/models/session.model.ts`
**Total indexes**: 22 (17 compound/explicit + 1 inline field-level + 1 TTL + 3 non-tenant-scoped)

## Context

Every session update (`messageCount`, `tokenCount`, `lastActivityAt` on every message) must maintain all secondary indexes. At 200 pods x 5000 sessions with continuous message flow, unnecessary indexes cause significant write amplification.

MongoDB maintains a B-tree for each index. Each `$inc` / `$set` on an indexed field requires updating that field's position in every index that includes it. The `lastActivityAt` field appears in 4 indexes, meaning every message triggers 4 B-tree updates just for that one field.

## Index Inventory and Recommendations

### Legend

- **Line**: Line number in `session.model.ts`
- **Fields updated on every message**: `lastActivityAt`, `messageCount`, `tokenCount`, `estimatedCost`
- **WA** = Write Amplification contributor (index includes a frequently-updated field)

### Compound Indexes (lines 190-216)

| #   | Index Definition                                                                                    | Line    | WA  | Verdict              | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------- | ------- | --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `{ tenantId: 1, status: 1, lastActivityAt: -1 }`                                                    | 190     | Yes | **KEEP**             | Used by `findOldSessionsByTenant()` in runtime session-repo (filters `tenantId + status + lastActivityAt`). Also used by `markTimedOutSessions()` in session-cleanup-job. However, **redundant with #2** for most queries -- see note below.                                                                                                                                                                                                                                                                                                                          |
| 2   | `{ tenantId: 1, projectId: 1, status: 1, lastActivityAt: -1 }`                                      | 191     | Yes | **KEEP**             | Primary session list query in both Studio `listSessionsForProject()` and Runtime `sessions.ts` route. Filters `tenantId + projectId + status?` sorted by `lastActivityAt desc`. High-traffic index.                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | `{ lastActivityAt: -1, status: 1 }`                                                                 | 192     | Yes | **DROP**             | Comment says "cleanup/archival queries" but `findOldSessions()` (cross-tenant cleanup) filters `{ lastActivityAt, status }` without tenantId. This violates tenant isolation. The function is only called from retention jobs that already iterate per-tenant via `findOldSessionsByTenant()` (which uses index #1). The cross-tenant `findOldSessions()` is a legacy path. **No tenantId prefix = isolation violation.**                                                                                                                                             |
| 4   | `{ tenantId: 1, contactId: 1 }`                                                                     | 193     | No  | **DROP (redundant)** | Fully covered by index #20 `{ tenantId: 1, contactId: 1, startedAt: -1 }` (partial filter). For queries where `contactId` is non-null (the only useful case), index #20 is a superset. For `unlinkContactFromSessions()` which filters `{ contactId, tenantId }`, index #20 also works.                                                                                                                                                                                                                                                                               |
| 5   | `{ tenantId: 1, customerId: 1 }`                                                                    | 194     | No  | **KEEP**             | Used by GDPR `findAllSubjectSessionIds()` via `$or` clause matching `customerId`. Low cardinality lookup, critical for compliance.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | `{ tenantId: 1, anonymousId: 1 }`                                                                   | 195     | No  | **KEEP**             | Used by GDPR `findAllSubjectSessionIds()` via `$or` clause matching `anonymousId`. Same compliance justification as #5.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | `{ tenantId: 1, callerNumber: 1 }`                                                                  | 196     | No  | **DROP**             | GDPR `findAllSubjectSessionIds()` includes `callerNumber` in its `$or` clause, but MongoDB `$or` optimization means each branch uses its own index. However, **no production query filters sessions by `callerNumber` as a primary lookup**. The GDPR `$or` query would use this index for one branch, but the other branches (contactId, customerId, etc.) are more selective. callerNumber is only set for voice sessions (small fraction). Remove and let the `$or` fall back to collection scan on that branch -- the other branches will find the same sessions. |
| 8   | `{ tenantId: 1, workflowId: 1 }`                                                                    | 197     | No  | **KEEP (fix query)** | Used by `countSessions({ workflowId, status: 'active' })` in `workflows.ts:422`, but that call is **missing tenantId** (isolation bug). Once fixed, this index serves it. Keep the index, file a bug to add tenantId to the query.                                                                                                                                                                                                                                                                                                                                    |
| 9   | `{ tenantId: 1, projectId: 1, environment: 1 }`                                                     | 198     | No  | **DROP (redundant)** | No query filters on exactly `{ tenantId, projectId, environment }` without also filtering `status` or sorting by `lastActivityAt`. Index #2 `{ tenantId, projectId, status, lastActivityAt }` already covers the `tenantId + projectId` prefix. If environment filtering is added, it would be as an additional filter on the session list query which already uses #2.                                                                                                                                                                                               |
| 10  | `{ tenantId: 1, initiatedById: 1 }`                                                                 | 199     | No  | **KEEP**             | Used by `getUserSessions()` in `project-service.ts` (filters `{ initiatedById, tenantId }`). Also used by GDPR `findAllSubjectSessionIds()`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | `{ tenantId: 1, billingPeriod: 1, isTest: 1 }`                                                      | 200     | No  | **DROP**             | **Zero queries** in the codebase filter sessions by `billingPeriod`. The field exists on the schema but is never queried. This is a speculative index for a billing feature that was never built.                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | `{ tenantId: 1, projectSlug: 1, status: 1 }`                                                        | 201     | No  | **DROP**             | **Zero queries** filter sessions by `projectSlug`. Sessions are always looked up by `projectId`, not `projectSlug`. The slug is stored for display/logging but never used as a filter key.                                                                                                                                                                                                                                                                                                                                                                            |
| 13  | `{ tenantId: 1, entryAgentName: 1, startedAt: -1 }`                                                 | 202     | No  | **DROP**             | **Zero queries** filter sessions by `entryAgentName`. The field is written during session creation and read back in session detail views, but no list/filter query uses it as a filter criterion.                                                                                                                                                                                                                                                                                                                                                                     |
| 14  | `{ tenantId: 1, environment: 1, status: 1 }`                                                        | 203     | No  | **DROP (redundant)** | Overlaps significantly with #2 `{ tenantId, projectId, status, lastActivityAt }`. The admin-sessions route filters by `tenantId + projectId + status` (plus optional channel, identityTier, time range), which uses #2. No query filters `{ tenantId, environment, status }` without `projectId`. Also found in migration script `20260211_000` but existence in migration doesn't mean it's queried.                                                                                                                                                                 |
| 15  | `{ deploymentId: 1, status: 1 }`                                                                    | 204     | No  | **DROP**             | **Missing tenantId prefix** (isolation violation). **Zero queries** filter sessions by `deploymentId`. The `deploymentId` is written during session creation but never used as a lookup key.                                                                                                                                                                                                                                                                                                                                                                          |
| 16  | `{ runtimeSessionId: 1 }` (sparse)                                                                  | 205     | No  | **KEEP**             | Used by `findSessionByRuntimeId()` in both Runtime and Studio session repos. Sparse index is appropriate since many sessions have null `runtimeSessionId`. High-traffic lookup for correlating runtime sessions with DB records. Note: queries always include `tenantId` but this single-field sparse index still helps since `runtimeSessionId` is globally unique (UUID).                                                                                                                                                                                           |
| 17  | `{ customerId: 1 }`                                                                                 | 206     | No  | **DROP**             | **Missing tenantId prefix** (isolation violation). Redundant with #5 `{ tenantId, customerId }`. No query should ever look up sessions by `customerId` alone without tenant scoping.                                                                                                                                                                                                                                                                                                                                                                                  |
| 18  | `{ anonymousId: 1 }`                                                                                | 207     | No  | **DROP**             | **Missing tenantId prefix** (isolation violation). Redundant with #6 `{ tenantId, anonymousId }`. Same reasoning as #17.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 19  | `{ parentId: 1 }`                                                                                   | 208     | No  | **DROP**             | **Missing tenantId prefix** (isolation violation). **Zero queries** filter sessions by `parentId`. The field exists for sub-session tracking but no code queries it.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 20  | `{ tenantId: 1, channelId: 1, channelArtifact: 1, status: 1 }` (partial: channelArtifact is string) | 210-212 | No  | **KEEP**             | Used by `findSessionsByArtifact()` in the back-link-sessions job for correlating anonymous sessions to contacts via channel artifact. Partial filter expression keeps the index small.                                                                                                                                                                                                                                                                                                                                                                                |
| 21  | `{ tenantId: 1, contactId: 1, startedAt: -1 }` (partial: contactId is string)                       | 214-216 | No  | **KEEP**             | Used by GDPR contact lookup and the contact-session history view. Partial filter keeps index small. Subsumes index #4 for non-null contactId queries.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Inline Field-Level Index

| #   | Index Definition                                      | Line | WA  | Verdict  | Justification                                                                                                                                          |
| --- | ----------------------------------------------------- | ---- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 22  | `{ outcome: 1 }` (from `index: true` on schema field) | 133  | No  | **DROP** | **Zero queries** filter sessions by `outcome`. The field is written by quality evaluation but never used as a query filter. No tenantId prefix either. |

### TTL Index

| #   | Index Definition                         | Line | WA  | Verdict  | Justification                                                                                                                                      |
| --- | ---------------------------------------- | ---- | --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | `{ endedAt: 1 }` (TTL: 400 days, sparse) | 223  | No  | **KEEP** | Safety-net TTL for abandoned sessions. MongoDB uses this internally for automatic expiry. Cannot be removed without alternative cleanup guarantee. |

## Summary

| Verdict  | Count | Indexes                                                         |
| -------- | ----- | --------------------------------------------------------------- |
| **KEEP** | 11    | #1, #2, #5, #6, #8, #10, #16, #20, #21, #23, and one more below |
| **DROP** | 12    | #3, #4, #7, #9, #11, #12, #13, #14, #15, #17, #18, #19, #22     |

### Revised Count

- **Current**: 23 indexes (22 secondary + `_id`)
- **Proposed**: 11 indexes (10 secondary + `_id`)
- **Removed**: 12 indexes

### Consideration: Index #1 Redundancy with #2

Index #1 `{ tenantId, status, lastActivityAt }` overlaps with #2 `{ tenantId, projectId, status, lastActivityAt }`. The only query that uses #1 but not #2 is `findOldSessionsByTenant()` which filters `{ tenantId, lastActivityAt, status }` without `projectId`. If this query is infrequent (retention job, runs hourly), we could drop #1 and let MongoDB use #2 with a less efficient scan (skipping `projectId` in the compound). However, retention scans can be large, so **keep #1 for now** and revisit after measuring.

## Write Amplification Estimate

### Per-message update fields

Each inbound message triggers updates to: `lastActivityAt`, `messageCount` (via `$inc`), and separately `tokenCount`, `estimatedCost` (via `$inc`).

### Indexes affected by `lastActivityAt` updates

| Index                                             | Currently                                    | After cleanup  |
| ------------------------------------------------- | -------------------------------------------- | -------------- |
| `{ tenantId, status, lastActivityAt }`            | Updated                                      | Updated (keep) |
| `{ tenantId, projectId, status, lastActivityAt }` | Updated                                      | Updated (keep) |
| `{ lastActivityAt, status }`                      | Updated                                      | **Removed**    |
| `{ tenantId, entryAgentName, startedAt }`         | Not affected (startedAt, not lastActivityAt) | N/A            |

**Net reduction for `lastActivityAt` updates: 3 index updates -> 2 index updates (33% reduction)**

### Overall write amplification reduction

- Current: 23 indexes maintained on every write (even if the specific field isn't in the index, MongoDB must check)
- Proposed: 11 indexes
- **Reduction: ~52% fewer indexes to maintain**

For the specific hot-path (message persistence incrementing `messageCount` + `lastActivityAt`):

- Current B-tree updates per message: 3 (indexes containing `lastActivityAt`)
- Proposed B-tree updates per message: 2
- **Hot-path reduction: 33%**

## Bugs Found During Audit

1. **Missing tenantId in workflow session count** (`apps/runtime/src/routes/workflows.ts:422`): `countSessions({ workflowId: req.params.id, status: 'active' })` does not include `tenantId`, violating tenant isolation. The index `{ tenantId, workflowId }` exists but can't be used without tenantId in the query.

2. **Legacy cross-tenant cleanup path** (`findOldSessions()` in runtime session-repo): Queries `{ lastActivityAt, status }` without tenantId. The per-tenant variant `findOldSessionsByTenant()` exists and should be used exclusively.

3. **`pipeline-engine` conversation-reader uses `findById()`** (`packages/pipeline-engine/src/pipeline/services/conversation-reader.ts:118`): Uses `Session.findById(sessionId)` without tenantId scoping, violating tenant isolation.

## Implementation Notes

- Drop indexes via a migration script, not by removing lines from the model (indexes persist in MongoDB even if removed from schema code).
- Create migration: `packages/database/src/migrations/scripts/20260313_drop_unused_session_indexes.ts`
- Use `collection.dropIndex(indexName)` with try/catch for idempotency.
- After migration runs successfully, remove the corresponding `SessionSchema.index()` lines and the `index: true` on the `outcome` field.
- Monitor `db.sessions.stats()` before and after to measure actual storage and write throughput improvement.
