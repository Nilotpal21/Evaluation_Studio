# LLD: Agent Governance Dashboard

**Feature Spec**: `docs/features/governance.md`
**HLD**: `docs/specs/governance.hld.md`
**Test Spec**: `docs/testing/governance.md`
**Status**: DONE
**Date**: 2026-04-29

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Alternatives Rejected                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D-1  | Extract `buildSummaryQuery` from `pipeline-analytics.ts` as Phase 0                             | `GovernanceStatusService` needs per-pipelineType SQL; duplicating the 11-branch switch is fragile and couples governance to pipeline internals                                                                                                                                                                                                                                                                                                                                                 | Copy-paste into governance service — rejected: drift risk if analytics queries change                                 |
| D-2  | `governance-contracts.ts` — single Zod schema source of truth                                   | User requirement: "contracts in the code at every layer". Route validators (Zod `validateBody`) AND Studio SWR hooks both import from this file                                                                                                                                                                                                                                                                                                                                                | Separate schema files per layer — rejected: schemas diverge silently                                                  |
| D-3  | `GovernanceCache` in `apps/runtime/src/services/cache/`                                         | Mirrors `embedding-cache.ts` location; service layer owns its own cache, not the route file. Deliberately diverges from `AnalyticsCache` pattern in two ways: (1) static `GovernanceCache.create()` factory instead of module-scoped singleton for testability; (2) uses Redis `SCAN` + `DEL` for invalidation instead of `redis.KEYS()` — `KEYS` is a known antipattern blocked in production Redis. Note: `AnalyticsCache.invalidate()` should be updated to use `SCAN` in a follow-up task. | Inline cache in route handler (like AnalyticsCache pattern in analytics.ts) — rejected: harder to unit test           |
| D-4  | `requireGovernanceReadAccess()` — OR logic using `evaluateProjectPermission` twice              | `requireProjectPermission` only takes a single scope; OR(analytics:read, governance:audit-read) requires two `evaluateProjectPermission` calls with fallback                                                                                                                                                                                                                                                                                                                                   | Modify `requireProjectPermission` to accept array — rejected: cross-cutting change, out of scope                      |
| D-5  | Policy version snapshot: sequential writes, compensating restore on failure                     | Atomicity without a MongoDB transaction; sequential: `findOneAndUpdate` policy (version+1) → `GovernancePolicyVersion.create(snapshot)`; if snapshot create fails: restore policy via `findOneAndUpdate` back to original version+rules; if restore also fails: log error + 500 (manual cleanup needed)                                                                                                                                                                                        | MongoDB session transactions — rejected: require `rs.initiate()` on dev; not guaranteed in all environments           |
| D-6  | E2E cache busting: `GOVERNANCE_STATUS_CACHE_TTL_SECONDS=5`                                      | No test-only code paths; short TTL in test env avoids stale-cache failures without `?nocache=true` param                                                                                                                                                                                                                                                                                                                                                                                       | `?nocache=true` — rejected: adds test-only code path in production route                                              |
| D-7  | pdfkit for PDF generation                                                                       | Pure Node.js, no browser dependency, streams to `res` directly, minimal memory footprint                                                                                                                                                                                                                                                                                                                                                                                                       | puppeteer — rejected: headless Chrome in container, high memory; pdf-lib — rejected: build-your-own layout complexity |
| D-8  | Contract tests live in `apps/runtime/src/__tests__/contracts/`                                  | One file per endpoint group (`governance-policies.contract.test.ts`, `governance-status.contract.test.ts`, etc.); each test starts a real server and parses every HTTP response through Zod contract schemas                                                                                                                                                                                                                                                                                   | Inline contract assertions in E2E tests — rejected: E2E tests are already scoped to user flows, not schema compliance |
| D-9  | Override teardown in E2E-13: fresh project per test case                                        | CLAUDE.md E2E standards require API-only interaction; no DELETE endpoint for overrides in MVP; fresh project means no prior overrides — no teardown needed                                                                                                                                                                                                                                                                                                                                     | DELETE override endpoint — rejected: premature scope addition for test convenience                                    |
| D-10 | `pipeline-analytics-summary.service.ts` — export `buildSummaryQuery` + `executePipelineSummary` | `buildSummaryQuery` is a pure function (no I/O) → testable with zero mocks; `executePipelineSummary` wraps the ClickHouse call with 5s timeout                                                                                                                                                                                                                                                                                                                                                 | Export only raw query strings — rejected: callers would have to re-implement the ClickHouse call boilerplate          |

### Key Interfaces & Types

All Zod schemas live in `apps/runtime/src/routes/governance-contracts.ts`. TypeScript types are inferred from schemas using `z.infer<>`. Studio imports the same types from `apps/studio/src/lib/governance-contracts.ts` (a re-export thin wrapper).

```typescript
// governance-contracts.ts — canonical source of truth for all governance shapes

export const GovernanceRuleSchema = z.object({
  pipelineType: z.enum([...VALID_PIPELINE_TYPES] as [string, ...string[]]),
  metric: z.string().min(1),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']), // 5 operators
  threshold: z.number().finite(),
  severity: z.enum(['critical', 'warning', 'info']),
});
export type GovernanceRule = z.infer<typeof GovernanceRuleSchema>;

export const CreatePolicyBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  rules: z.array(GovernanceRuleSchema).min(1).max(20),
  status: z.enum(['enabled', 'disabled']).default('enabled'),
});
export type CreatePolicyBody = z.infer<typeof CreatePolicyBodySchema>;

export const UpdatePolicyBodySchema = CreatePolicyBodySchema; // full-replace
export type UpdatePolicyBody = z.infer<typeof UpdatePolicyBodySchema>;

export const CreateOverrideBodySchema = z.object({
  justification: z.string().min(1).max(500),
  originalSeverity: z.enum(['critical', 'warning', 'info']),
  policyVersion: z.number().int().positive(),
});
export type CreateOverrideBody = z.infer<typeof CreateOverrideBodySchema>;

// Response contracts (for contract testing + Studio SWR hooks)
export const GovernanceRuleStatusSchema = z.object({
  pipelineType: z.string(),
  metric: z.string(),
  status: z.enum(['PASS', 'WARN', 'FAIL', 'NOT_EVALUATED']),
  metricValue: z.number().nullable(),
  threshold: z.number(),
  severity: z.enum(['critical', 'warning', 'info']),
});

export const GovernanceAgentStatusSchema = z.object({
  agentName: z.string(),
  overallStatus: z.enum(['PASS', 'WARN', 'FAIL', 'NOT_EVALUATED']),
  rules: z.array(GovernanceRuleStatusSchema),
});

export const GovernanceStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    period: z.string(),
    policies: z.array(z.object({ _id: z.string(), name: z.string(), status: z.string() })),
    agents: z.array(GovernanceAgentStatusSchema),
    summary: z.object({
      pass: z.number(),
      warn: z.number(),
      fail: z.number(),
      unavailable: z.number(),
    }),
  }),
});

export const GovernanceAuditEventSchema = z.object({
  eventRef: z.string(),
  timestamp: z.string(),
  pipelineType: z.string(),
  metric: z.string(),
  agentName: z.string(),
  agentVersion: z.string().optional(),
  threshold: z.number(),
  thresholdAtTime: z.number(),
  actualValue: z.number(),
  severity: z.enum(['critical', 'warning', 'info']),
  eventType: z.enum(['breach', 'recovery']),
  overrideId: z.string().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const GovernanceAuditResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    events: z.array(GovernanceAuditEventSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  }),
});

export const FrameworkControlSchema = z.object({
  controlId: z.string(),
  requirement: z.string(),
  status: z.enum(['PASS', 'FAIL', 'WARN', 'NOT_EVALUATED']),
  evidence: z.string(),
});

export const GovernanceFrameworksResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    frameworks: z.array(
      z.object({
        id: z.enum(['SOC2', 'GDPR', 'EU_AI_ACT']),
        label: z.string(),
        controls: z.array(FrameworkControlSchema),
      }),
    ),
  }),
});
```

### Module Boundaries

| Module                                  | Responsibility                                                        | Depends On                                                               |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `governance-contracts.ts`               | All Zod schemas + inferred TS types for governance API                | `zod`, `pipeline-analytics-helpers.ts` (for pipeline type enum)          |
| `pipeline-analytics-summary.service.ts` | Pure `buildSummaryQuery` + `executePipelineSummary`                   | `pipeline-analytics-helpers.ts`, `@clickhouse/client`                    |
| `governance-policy.model.ts`            | Mongoose model + `METRIC_REGISTRY` + `METRIC_SUMMARY_ALIAS` constants | `packages/database` tenantIsolationPlugin                                |
| `governance-override.model.ts`          | Mongoose model for human attestations                                 | `packages/database` tenantIsolationPlugin                                |
| `governance-policy-version.model.ts`    | Append-only snapshot Mongoose model                                   | `packages/database` tenantIsolationPlugin                                |
| `governance-cache.ts`                   | Redis wrapper with `governance:` namespace, fail-open                 | `redis-client.ts`, `createLogger`                                        |
| `governance-status.service.ts`          | Fan-out to ClickHouse, rule evaluation, cache                         | `pipeline-analytics-summary.service.ts`, `governance-cache.ts`, models   |
| `governance-audit.service.ts`           | Breach query builder, override merge, pagination                      | `pipeline-analytics-helpers.ts`, models, `@clickhouse/client`            |
| `governance-report.service.ts`          | CSV stream + PDF via pdfkit                                           | `governance-audit.service.ts`, `governance-status.service.ts`, `pdfkit`  |
| `governance-frameworks.service.ts`      | Pure SOC2/GDPR/EU AI Act control evaluation functions                 | `governance-contracts.ts` (FrameworkControlSchema type)                  |
| `governance.ts` (router)                | Policy CRUD + status + audit + override + report routes               | All services above, `governance-contracts.ts`, `rbac.ts`, `auth-repo.ts` |
| `governance-frameworks.ts` (sub-router) | GET /frameworks route                                                 | `governance-frameworks.service.ts`, `governance-status.service.ts`       |
| Studio hooks/components                 | SWR data fetching + tabs UI                                           | `governance-contracts.ts` re-export, `useTranslations('governance')`     |
| Contract tests                          | Parse every API response through Zod contracts                        | `governance-contracts.ts`, real Express server                           |

---

## 2. File-Level Change Map

### New Files

| File                                                                              | Purpose                                                                                                                                                                                                                                                                    | LOC Estimate |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/routes/governance-contracts.ts`                                 | All Zod request/response schemas + inferred types                                                                                                                                                                                                                          | ~150         |
| `apps/runtime/src/services/pipeline-analytics-summary.service.ts`                 | Extracted summary query builder + executor (pure + ClickHouse)                                                                                                                                                                                                             | ~220         |
| `packages/database/src/models/governance-policy.model.ts`                         | GovernancePolicy Mongoose model + METRIC_REGISTRY + METRIC_SUMMARY_ALIAS                                                                                                                                                                                                   | ~130         |
| `packages/database/src/models/governance-override.model.ts`                       | GovernanceOverride Mongoose model                                                                                                                                                                                                                                          | ~70          |
| `packages/database/src/models/governance-policy-version.model.ts`                 | GovernancePolicyVersion append-only snapshot model                                                                                                                                                                                                                         | ~70          |
| `apps/runtime/src/services/cache/governance-cache.ts`                             | Redis GovernanceCache wrapper (`governance:` namespace, fail-open)                                                                                                                                                                                                         | ~80          |
| `apps/runtime/src/services/governance-status.service.ts`                          | Status fan-out, rule evaluation, caching                                                                                                                                                                                                                                   | ~200         |
| `apps/runtime/src/services/governance-audit.service.ts`                           | Breach query builder, override merge, pagination                                                                                                                                                                                                                           | ~180         |
| `apps/runtime/src/services/governance-report.service.ts`                          | CSV streaming + PDF generation via pdfkit                                                                                                                                                                                                                                  | ~200         |
| `apps/runtime/src/services/governance-frameworks.service.ts`                      | Pure SOC2/GDPR/EU AI Act control evaluators                                                                                                                                                                                                                                | ~180         |
| `apps/runtime/src/routes/governance.ts`                                           | Main governance Express router (10 endpoints)                                                                                                                                                                                                                              | ~350         |
| `apps/runtime/src/routes/governance-frameworks.ts`                                | Sub-router for GET /frameworks endpoint                                                                                                                                                                                                                                    | ~60          |
| `apps/runtime/src/__tests__/contracts/governance-policies.contract.test.ts`       | **Consolidated** contract tests for all endpoints (policy CRUD + status + audit + frameworks + cross-tenant isolation). The planned separate files for status/audit/frameworks were consolidated here during implementation — all 12 contract tests live in this one file. | ~350         |
| ~~`apps/runtime/src/__tests__/contracts/governance-status.contract.test.ts`~~     | ~~Consolidated into governance-policies.contract.test.ts~~                                                                                                                                                                                                                 | n/a          |
| ~~`apps/runtime/src/__tests__/contracts/governance-audit.contract.test.ts`~~      | ~~Consolidated into governance-policies.contract.test.ts~~                                                                                                                                                                                                                 | n/a          |
| ~~`apps/runtime/src/__tests__/contracts/governance-frameworks.contract.test.ts`~~ | ~~Consolidated into governance-policies.contract.test.ts~~                                                                                                                                                                                                                 | n/a          |
| `apps/studio/src/lib/governance-contracts.ts`                                     | Re-export of governance-contracts for Studio SWR hooks                                                                                                                                                                                                                     | ~10          |
| `apps/studio/src/hooks/useGovernancePolicies.ts`                                  | SWR hook for policy CRUD                                                                                                                                                                                                                                                   | ~60          |
| `apps/studio/src/hooks/useGovernanceStatus.ts`                                    | SWR hook for status aggregation                                                                                                                                                                                                                                            | ~50          |
| `apps/studio/src/hooks/useGovernanceAudit.ts`                                     | SWR hook for audit trail                                                                                                                                                                                                                                                   | ~60          |
| `apps/studio/src/hooks/useGovernanceFrameworks.ts`                                | SWR hook for frameworks checklist                                                                                                                                                                                                                                          | ~50          |
| `apps/studio/src/components/governance/AgentComplianceTable.tsx`                  | Agent registry table with status indicators                                                                                                                                                                                                                                | ~120         |
| `apps/studio/src/components/governance/AgentComplianceDetailPanel.tsx`            | Slide-over panel for per-agent rule breakdown                                                                                                                                                                                                                              | ~80          |
| `apps/studio/src/components/governance/ComplianceCardGrid.tsx`                    | Grid of compliance metric cards                                                                                                                                                                                                                                            | ~60          |
| `apps/studio/src/components/governance/ComplianceCard.tsx`                        | Individual compliance metric card                                                                                                                                                                                                                                          | ~50          |
| `apps/studio/src/components/governance/GovernancePolicyEditor.tsx`                | Slide-over form for create/edit policy                                                                                                                                                                                                                                     | ~180         |
| `apps/studio/src/components/governance/AuditEventTimeline.tsx`                    | Paginated breach/recovery event list with pagination controls                                                                                                                                                                                                              | ~120         |
| `apps/studio/src/components/governance/AuditFilters.tsx`                          | Multi-select filter bar (pipelineType, agentName, severity, eventType)                                                                                                                                                                                                     | ~80          |
| `apps/studio/src/components/governance/OverrideModal.tsx`                         | Modal for creating human override attestation                                                                                                                                                                                                                              | ~80          |
| `apps/studio/src/components/governance/ExportBar.tsx`                             | CSV + PDF export buttons with loading states                                                                                                                                                                                                                               | ~60          |
| `apps/studio/src/components/governance/FrameworksTab.tsx`                         | Frameworks tab container                                                                                                                                                                                                                                                   | ~60          |
| `apps/studio/src/components/governance/FrameworkChecklist.tsx`                    | Per-framework control checklist accordion                                                                                                                                                                                                                                  | ~100         |
| `docs/sdlc-logs/governance/lld.log.md`                                            | LLD audit log                                                                                                                                                                                                                                                              | ~80          |

### Modified Files

| File                                                       | Change Description                                                                                            | Risk   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/routes/pipeline-analytics.ts`            | Replace inline summary query builder (lines ~85-318) with call to `executePipelineSummary()` from new service | Medium |
| `packages/database/src/models/index.ts`                    | Export 3 new governance models                                                                                | Low    |
| `packages/database/src/cascade/cascade-delete.ts`          | Add 3 governance model cleanup to `deleteProject()` + `deleteTenant()` (deepest-first order)                  | Low    |
| `packages/shared-auth/src/rbac/role-permissions.ts`        | Add `governance:write` + `governance:audit-read` to PERMISSION_REGISTRY + PROJECT_ROLE_PERMISSIONS            | Low    |
| `apps/runtime/src/middleware/rbac.ts`                      | Add exported `requireGovernanceReadAccess()` function (OR logic for analytics:read \| governance:audit-read)  | Low    |
| `apps/runtime/src/server.ts`                               | Mount `governanceRouter` at `/api/projects/:projectId/governance`                                             | Low    |
| `apps/runtime/src/routes/pipeline-analytics-helpers.ts`    | Export `PIPELINE_MV_TABLES` for use in `pipeline-analytics-summary.service.ts`                                | Low    |
| `apps/studio/src/components/governance/GovernancePage.tsx` | Replace stub with real 4-tab implementation using new hooks + components                                      | Medium |

### Deleted Files

None. GovernancePage stub is replaced in-place (not deleted then created).

---

## 3. Implementation Phases

### Phase 0: Prerequisites — Extract + Wire Foundation (independently deployable, no governance routes yet)

**Goal**: Extract the pipeline summary query logic into a shared service, add pdfkit, and add RBAC scopes — without any governance endpoints yet. This phase ensures no risk of circular dependencies or late-discovered coupling.

**Tasks**:

0.1. Create `apps/runtime/src/routes/governance-contracts.ts` with all Zod schemas and inferred types defined in Section 1. Import `VALID_PIPELINE_TYPES` (a `Set`) from `./pipeline-analytics-helpers.js`. Use `z.enum([...VALID_PIPELINE_TYPES] as [string, ...string[]])` — the type assertion is required because `Set` spread produces `string[]` which is not assignable to `z.enum()`'s `[string, ...string[]]` tuple type.

0.2. Extract summary query builder from `pipeline-analytics.ts`:

- Create `apps/runtime/src/services/pipeline-analytics-summary.service.ts`
- Export pure function `buildSummaryQuery(pipelineType: string, table: string, dateCol: string): string` containing the 11-branch switch (lines ~127-310 of `pipeline-analytics.ts`)
- Export `executePipelineSummary(ch: ClickHouseClient, tenantId: string, projectId: string, pipelineType: string, period: string): Promise<Record<string, unknown>>` — builds query, adds `SETTINGS max_execution_time = 15`, runs `ch.query()`, parses with `parseClickHouseRows`, returns `rows[0] ?? {}`
- In `pipeline-analytics.ts`: import `executePipelineSummary` and replace the 11-branch switch + `ch.query()` call with a single call to `executePipelineSummary(ch, tenantId, projectId, pipelineType, period)`
- Verify pipeline-analytics summary route still works (same response shape)

  0.3. Add `governance:write` and `governance:audit-read` to `packages/shared-auth/src/rbac/role-permissions.ts`:

- Add `governance` category to `PERMISSION_REGISTRY` with both permissions
- Add `'governance:write'` AND `'analytics:read'` to `developer` role in `PROJECT_ROLE_PERMISSIONS` (developer currently lacks `analytics:read`; without it developers can create policies but cannot view status, audit, or reports — a dead-end UX)
- Add `'analytics:read'` AND `'governance:audit-read'` to `viewer` role — `viewer` currently lacks `analytics:read`, so GET /governance/status (and all read endpoints gated by `requireProjectWideAnalyticsAccess`) would return 403 for viewers. Viewers are expected to have read-only governance dashboard access.
- Add `'governance:audit-read'` to `tester` role in `PROJECT_ROLE_PERMISSIONS`

  0.4. Install pdfkit and papaparse in `apps/runtime/`:

- `pnpm add pdfkit papaparse` and `pnpm add -D @types/pdfkit @types/papaparse` in `apps/runtime/`
- papaparse is already in the monorepo lockfile (from `apps/search-ai`) — zero new lockfile entries
- Verify `apps/runtime/package.json` contains all four entries

**Files Touched**:

- `apps/runtime/src/routes/governance-contracts.ts` (new)
- `apps/runtime/src/services/pipeline-analytics-summary.service.ts` (new)
- `apps/runtime/src/routes/pipeline-analytics.ts` (modified: replace inline query with service call)
- `packages/shared-auth/src/rbac/role-permissions.ts` (modified: add governance perms)
- `apps/runtime/package.json` (modified: add pdfkit)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors
- [ ] `pnpm build --filter=@abl/shared-auth` succeeds with 0 errors
- [ ] Existing `pipeline-analytics` route tests pass (`pnpm test --filter=@abl/runtime -- pipeline-analytics`)
- [ ] `governance-contracts.ts` imports without error; `VALID_PIPELINE_TYPES_ARRAY` has 11 entries
- [ ] `pnpm list pdfkit --filter=@abl/runtime` shows the installed version

**Test Strategy**:

- Unit: `buildSummaryQuery('quality_evaluation', table, dateCol)` → assert SQL contains `avg(overall_score)`, `FROM abl_platform.quality_evaluations`; run for all 11 types
- Unit: `buildSummaryQuery('nonexistent', ...)` → falls through to drift_detection else branch (acceptable since callers validate before calling)
- Integration: none needed for this phase (refactor only, existing tests cover the route)

**Rollback**: Revert `pipeline-analytics.ts` to its original inline query. Remove `governance-contracts.ts`. Remove RBAC additions. Uninstall pdfkit.

---

### Phase 1: Data Models + Cascade Delete

**Goal**: Three new Mongoose models wired into the database package, with cascade-delete registered for both `deleteProject` and `deleteTenant`. No routes yet.

**Tasks**:

1.1. Create `packages/database/src/models/governance-policy.model.ts`:

- Define `GovernancePolicySchema` with all fields from HLD Section 5
- Apply `tenantIsolationPlugin` (import from `'../mongo/plugins/tenant-isolation.plugin.js'` — verified against `alert-config.model.ts` and `guardrail-policy.model.ts`)
- Define indexes: `{ tenantId: 1, projectId: 1, name: 1 } unique`, `{ tenantId: 1, projectId: 1, status: 1 }`, `{ tenantId: 1 }`
- Export `GovernancePolicy` model + `IGovernancePolicy` interface + `METRIC_REGISTRY` + `METRIC_SUMMARY_ALIAS` constants (move from contracts file to model, import into contracts file)
- `version` field: type `Number`, default `1`, min `1`
- `rules` array: `_id: false` to suppress sub-document IDs

  1.2. Create `packages/database/src/models/governance-override.model.ts`:

- Define `GovernanceOverrideSchema` with all fields from HLD Section 5
- Apply `tenantIsolationPlugin` (same import path as task 1.1)
- Define indexes: `{ tenantId: 1, projectId: 1, eventRef: 1 } unique`, `{ tenantId: 1, projectId: 1, createdAt: -1 }`
- Export `GovernanceOverride` model + `IGovernanceOverride` interface

  1.3. Create `packages/database/src/models/governance-policy-version.model.ts`:

- Define `GovernancePolicyVersionSchema` with all fields from HLD Section 5
- Apply `tenantIsolationPlugin` (same import path as task 1.1)
- Define indexes: `{ tenantId: 1, policyId: 1, version: 1 } unique`, `{ tenantId: 1, policyId: 1, createdAt: -1 }`
- `rules` array: `_id: false`
- Export `GovernancePolicyVersion` model + `IGovernancePolicyVersion` interface

  1.4. Add all three models to `packages/database/src/models/index.ts` exports.

  1.5. Register governance models in `packages/database/src/cascade/cascade-delete.ts`:

- In both `deleteProject()` and `deleteTenant()`: add dynamic import for `GovernancePolicyVersion`, `GovernanceOverride`, `GovernancePolicy` inside the existing `await import('../models/index.js')` destructure
- Delete order (deepest-first): `GovernancePolicyVersion.deleteMany({ tenantId: projectTenantId, projectId })`, then `GovernanceOverride.deleteMany(...)`, then `GovernancePolicy.deleteMany(...)`
- Add result counts to `counts` record: `counts.GovernancePolicyVersion = r1.deletedCount`, etc.
- Note: Governance models are **configuration data** (policy thresholds, human override attestations) — NOT audit records. `deleteMany` is correct; no anonymization is needed. The `anonymized` record in `CascadeDeleteResult` is not updated for governance models.

**Files Touched**:

- `packages/database/src/models/governance-policy.model.ts` (new)
- `packages/database/src/models/governance-override.model.ts` (new)
- `packages/database/src/models/governance-policy-version.model.ts` (new)
- `packages/database/src/models/index.ts` (modified: add 3 exports)
- `packages/database/src/cascade/cascade-delete.ts` (modified: add 3 model cleanup blocks)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/database` succeeds with 0 errors
- [ ] `GovernancePolicy`, `GovernanceOverride`, `GovernancePolicyVersion` are exported from `@abl/database`
- [ ] `tenantIsolationPlugin` is applied to all three models (verified by reading each model file)
- [ ] Cascade-delete unit tests pass: `pnpm test --filter=@abl/database -- cascade`
- [ ] Both `deleteProject` and `deleteTenant` handle governance model cleanup (grep for `GovernancePolicyVersion` in cascade-delete.ts)

**Test Strategy**:

- Integration: `GovernancePolicy.create({ tenantId, projectId, name, rules, ... })` → `GovernancePolicy.findOne({ _id, tenantId })` returns document; `GovernancePolicy.findOne({ _id })` (no tenantId) throws isolation plugin error
- Integration: `GovernancePolicy.create(...)` with duplicate `{ tenantId, projectId, name }` → throws duplicate key error (MongoServerError code 11000)
- Integration: `GovernancePolicyVersion.findOne({ policyId, createdAt: { $lte: date } }, { sort: { createdAt: -1 } })` returns correct snapshot (verify index is used)

**Rollback**: Remove the three model files. Remove exports from `models/index.ts`. Remove cascade-delete additions.

---

### Phase 2: Governance Status Service + Cache + Policy CRUD Backend

**Goal**: Policy CRUD endpoints + status aggregation endpoint fully functional. Contracts layer in place. No Studio UI yet.

**Tasks**:

2.0. Add env var documentation to `apps/runtime/.env.example`:

```
# Governance Dashboard
GOVERNANCE_ENABLED=true                    # Set false to disable governance routes without redeploy
GOVERNANCE_STATUS_CACHE_TTL_SECONDS=300   # Redis TTL for /status responses (5 minutes)
GOVERNANCE_REPORT_MAX_ROWS=10000          # Maximum audit events in CSV/PDF export
```

2.1. Create `apps/runtime/src/services/cache/governance-cache.ts`:

- Class `GovernanceCache` with constructor `(private redis: Redis | null)`
- `get(tenantId: string, projectId: string, period: string): Promise<unknown | null>` — key: `governance:status:${tenantId}:${projectId}:${period}`; fail-open if `this.redis` is null
- `set(tenantId: string, projectId: string, period: string, value: unknown, ttlSeconds: number): Promise<void>` — `SETEX` with TTL; fail-open
- `invalidate(tenantId: string, projectId: string): Promise<void>` — **copy the guardrails cache SCAN+DEL pattern from `apps/runtime/src/services/guardrails/cache.ts` lines 156-185**: cursor loop with `COUNT 100`, batch DEL, fail-open on error (warn + return). Pattern: `let cursor = '0'; do { const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100); cursor = next; if (keys.length) await this.redis.del(...keys); } while (cursor !== '0')`. Note: SCAN+DEL is non-atomic (a concurrent SET between SCAN and DEL deletes a freshly-written value). This race is bounded by the 5-minute TTL — accept the trade-off for MVP.
- Static factory: `GovernanceCache.create(): Promise<GovernanceCache>` — calls `getRedisClient()` with try/catch, falls back to `new GovernanceCache(null)` if Redis unavailable

  2.2. Create `apps/runtime/src/services/governance-status.service.ts`:

- Use `createLogger('governance')` at module top — no `console.log`
- Class `GovernanceStatusService` with constructor `(private cache: GovernanceCache)`
- `getStatus(tenantId: string, projectId: string, period: string): Promise<GovernanceStatusData>`:
  1.  Check cache first — return cached if HIT (log DEBUG `governance.status.cache_hit`)
  2.  `GovernancePolicy.find({ tenantId, projectId, status: 'enabled' }).lean()`
  3.  Group rules by `pipelineType` — collect unique pipeline types (up to 11)
  4.  **Concurrency-limited fan-out** using the existing `Semaphore` class from `apps/runtime/src/services/llm/local-semaphore.ts` (max 4 concurrent ClickHouse queries — prevents `max_concurrent_queries` exhaustion): `const sem = new Semaphore(4); Promise.allSettled(pipelineTypes.map(async pt => { await sem.acquire(); try { return await fetchWithTimeout(pt); } finally { sem.release(); } }))`
  5.  `evaluateAllRules(policies, summaryByType)` → per-agent status array
  6.  Cache result with TTL from `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` env var (default 300)
  7.  **Emit TraceEvent**: `recordSyntheticTraceEvent({ tenantId, projectId, event: { type: 'governance.status.computed', data: { policyCount, agentCount, passCount, warnCount, failCount, unavailableCount, durationMs, cacheHit: false } } })` — import `recordSyntheticTraceEvent` from `@agent-platform/trace-store` (same import as `channel-genesys.ts`)
  8.  Return status response
- `private async fetchPipelineSummaryWithTimeout(...)` — calls `executePipelineSummary` with `Promise.race([call, timeoutPromise(5000)])`
- Pure static method: `GovernanceStatusService.evaluateRule(metricValue: number, operator: string, threshold: number): 'PASS' | 'FAIL'`
- Pure static method: `GovernanceStatusService.computeAgentStatus(ruleResults: RuleResult[]): 'PASS' | 'WARN' | 'FAIL'` — FAIL > WARN > PASS by severity mapping

  2.3. Create `apps/runtime/src/services/governance-audit.service.ts`:

- `buildBreachQuery(pipelineType: string, table: string, dateCol: string, rules: GovernanceRule[], period: string): string` — pure function; generates `SELECT agent_name, agent_version, ${metric} as actual_value, session_started_at as timestamp FROM ${table} WHERE tenant_id={...} AND project_id={...} AND (${ruleConditions})` with OR-joined conditions
- `getAuditEvents(tenantId: string, projectId: string, period: string, page: number, limit: number): Promise<AuditPage>`:
  1.  Fetch enabled policies from MongoDB
  2.  Fan-out breach queries (same Promise.allSettled + 5s timeout pattern)
  3.  Collect all breach events, sort by timestamp DESC
  4.  Fetch `governance_policy_versions` for `thresholdAtTime` resolution (batched by policyId)
  5.  Fetch `GovernanceOverride.find({ tenantId, projectId, eventRef: { $in: breachEventRefs } })` — merge overrideId + reviewStatus
  6.  Paginate and return

  2.4. Add `requireGovernanceReadAccess()` as an exported function to `apps/runtime/src/middleware/rbac.ts` (NOT in the route file — `sendRuntimeAccessDenied` is private to `rbac.ts` and cannot be imported elsewhere):

```typescript
export async function requireGovernanceReadAccess(
  req: Request<any>,
  res: Response,
  explicitProjectId?: string,
): Promise<boolean> {
  const analyticsResult = await evaluateProjectPermission(
    req,
    'analytics:read',
    explicitProjectId,
    { concealNotMember: true },
  );
  if (analyticsResult.allowed) return true;
  const auditResult = await evaluateProjectPermission(
    req,
    'governance:audit-read',
    explicitProjectId,
    { concealNotMember: true },
  );
  if (auditResult.allowed) return true;
  // Fall back to the analytics:read denial (conceals non-members as 404)
  return sendRuntimeAccessDenied(req, res, analyticsResult, 'analytics:read');
}
```

- Import `requireGovernanceReadAccess` in `governance.ts` alongside `requireProjectPermission`
- Add `apps/runtime/src/middleware/rbac.ts` to the modified files list for Phase 2

  2.5. Create `apps/runtime/src/routes/governance.ts` — routes in **this exact registration order** (static before parameterized to prevent Express match-shadowing):

- Body validation uses inline `schema.safeParse(req.body)` — there is no shared `validateBody` helper in the runtime codebase. Pattern (from `identity-verification.ts`):
  ```typescript
  const parsed = CreatePolicyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'GOVERNANCE_VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }
  ```
- Register routes in this order:
  1.  `router.get('/status', ...)` — `requireProjectWideAnalyticsAccess` → parse `period` → `GovernanceStatusService.getStatus(...)`
  2.  `router.get('/audit', ...)` — `requireGovernanceReadAccess` → parse `period, page, limit` → `GovernanceAuditService.getAuditEvents(...)`
  3.  `router.post('/audit/:eventRef/override', ...)` — `requireProjectPermission('governance:write')` → `CreateOverrideBodySchema.safeParse(req.body)` → `GovernanceOverride.create(...)` → `writeAuditLog(...)` → 201
  4.  `router.get('/report.csv', ...)` — `requireGovernanceReadAccess` → `GovernanceReportService.streamCsvReport(...)`
  5.  `router.get('/report.pdf', ...)` — `requireGovernanceReadAccess` → `GovernanceReportService.streamPdfReport(...)`
  6.  `router.use('/frameworks', governanceFrameworksRouter)` — registered here, before any `/:policyId` parameterized route
  7.  `router.get('/policies', ...)` — `requireProjectWideAnalyticsAccess` → `GovernancePolicy.find({ tenantId, projectId }).lean()`
  8.  `router.post('/policies', ...)` — `requireProjectPermission('governance:write')` → `CreatePolicyBodySchema.safeParse(req.body)` (400 on failure) → validate metric in `METRIC_REGISTRY[rule.pipelineType]` → `GovernancePolicy.create(...)` → `writeAuditLog(...)` → 201
  9.  `router.get('/policies/:policyId', ...)` — `requireProjectWideAnalyticsAccess` → `GovernancePolicy.findOne({ _id, tenantId, projectId }).lean()` → 404 if not found
  10. `router.put('/policies/:policyId', ...)` — `requireProjectPermission('governance:write')` → `UpdatePolicyBodySchema.safeParse(req.body)` (400 on failure) → validate metrics → read current policy (`.lean()`) to capture `original.version` → **version-check atomic update**: `findOneAndUpdate({ _id, tenantId, projectId, version: original.version }, { ...body, $inc: { version: 1 } }, { new: true })` — if `null` returned, respond 409 `GOVERNANCE_CONFLICT` (concurrent edit) → `GovernancePolicyVersion.create({ policyId, tenantId, projectId, version: updated.version, rules: updated.rules, createdAt: new Date() })` — if snapshot create fails: compensating restore via `findOneAndUpdate({ _id, tenantId, projectId }, { rules: original.rules, version: original.version })` → invalidate cache → `writeAuditLog(...)` → 200
  11. `router.delete('/policies/:policyId', ...)` — `requireProjectPermission('governance:write')` → `GovernancePolicy.deleteOne({ _id, tenantId, projectId })` → `GovernancePolicyVersion.deleteMany({ policyId, tenantId })` → invalidate cache → `writeAuditLog(...)` → 204

  2.6. (Absorbed into 2.5 above — GET /status and GET /audit are now in the ordered list.)

**Files Touched**:

- `apps/runtime/.env.example` (modified: add GOVERNANCE_STATUS_CACHE_TTL_SECONDS, GOVERNANCE_REPORT_MAX_ROWS)
- `apps/runtime/src/middleware/rbac.ts` (modified: add `requireGovernanceReadAccess` exported function)
- `apps/runtime/src/services/cache/governance-cache.ts` (new)
- `apps/runtime/src/services/governance-status.service.ts` (new)
- `apps/runtime/src/services/governance-audit.service.ts` (new — `buildBreachQuery` + stub `getAuditEvents` sufficient for this phase; full `getAuditEvents` in Phase 3)
- `apps/runtime/src/routes/governance.ts` (new)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors
- [ ] `GovernanceStatusService.evaluateRule(3.2, 'gte', 3.5)` returns `'FAIL'`
- [ ] `GovernanceStatusService.evaluateRule(3.6, 'gte', 3.5)` returns `'PASS'`
- [ ] `GovernanceStatusService.computeAgentStatus([{ status: 'PASS', severity: 'critical' }, { status: 'FAIL', severity: 'warning' }])` returns `'WARN'`
- [ ] POST /governance/policies returns 201 with valid body
- [ ] POST /governance/policies with duplicate name returns 409 `GOVERNANCE_POLICY_EXISTS`
- [ ] POST /governance/policies with invalid pipelineType returns 400 `GOVERNANCE_VALIDATION_ERROR`
- [ ] POST /governance/policies with metric not in METRIC_REGISTRY[pipelineType] returns 400 `GOVERNANCE_VALIDATION_ERROR`
- [ ] GET /governance/status returns `{ success: true, data: { period, policies, agents, summary } }`
- [ ] GET /governance/status without auth returns 401
- [ ] GET /governance/status for non-member project returns 404

**Test Strategy**:

- Unit: `evaluateRule` (5 operators × 2 outcomes = 10 cases), `computeAgentStatus` (3 severity ordering cases), `buildBreachQuery` (verify SQL shape for 3 pipeline types)
- Unit: `GovernanceCache` — test get/set/invalidate with mock Redis, and fail-open (null redis)
- Integration: POST policy → GET policy by ID → PUT policy (version increments) → `GovernancePolicyVersion.findOne` returns snapshot → DELETE policy → GET returns 404
- Contract test: `governance-policies.contract.test.ts` — start real server, POST policy, parse response through `z.object({ success: z.literal(true), data: z.object({ _id: z.string() }) })`; GET /policies response through list schema

**Rollback**: Remove `governance.ts`, `governance-cache.ts`, `governance-status.service.ts`, `governance-audit.service.ts`. RBAC additions from Phase 0 remain (harmless if no routes use them).

---

### Phase 3: Audit Trail + Override Endpoint

**Goal**: GET /audit and POST /audit/:eventRef/override endpoints working end-to-end.

**Tasks**:

3.1. Complete `getAuditEvents()` in `governance-audit.service.ts`:

- Full signature: `getAuditEvents(tenantId: string, projectId: string, period: string, page: number, limit: number, filters?: { pipelineTypes?: string[], agentNames?: string[], severities?: string[], eventTypes?: ('breach'|'recovery')[] }): Promise<AuditPage>`
- Build per-pipelineType breach queries using `buildBreachQuery`; if `filters.pipelineTypes` is provided, only query those types (reduces fan-out)
- `Promise.allSettled` with 5s timeout per query
- For each breach event row: compute `eventRef = "${pipelineType}:${agentName}:${metric}:${timestamp}"`
- Resolve `thresholdAtTime`: `GovernancePolicyVersion.findOne({ tenantId, policyId, createdAt: { $lte: eventTimestamp } }).sort({ createdAt: -1 }).lean()` → `policyVersion.rules.find(r => r.metric === event.metric)?.threshold ?? event.threshold`
- Fetch override records: `GovernanceOverride.find({ tenantId, projectId, eventRef: { $in: allEventRefs } }).lean()` (`.lean()` required — read-only query)
- Merge: attach `overrideId` and `reviewStatus` to matching breach events
- Sort all events DESC by timestamp, apply pagination

  3.2. Add **GET /audit** route to `governance.ts`:

- `requireGovernanceReadAccess` → parse query params:
  - `period` (string, default '7d')
  - `page` (number, default 1)
  - `limit` (number, default 50, max 100)
  - `pipelineType` (string CSV → split to array), `agentName` (string CSV), `severity` (string CSV), `eventType` (enum: 'breach'|'recovery')
- Call `GovernanceAuditService.getAuditEvents(tenantId, projectId, period, page, limit, filters)` → return `{ success: true, data: { events, total, page, limit } }`

  3.3. Add **POST /audit/:eventRef/override** route to `governance.ts`:

- `requireProjectPermission('governance:write')` → `CreateOverrideBodySchema.safeParse(req.body)` (400 on failure) → `GovernanceOverride.create({ tenantId, projectId, eventRef: decodeURIComponent(req.params.eventRef), reviewedBy: req.user.id, ...body })` → catch duplicate key (11000) → 409 `GOVERNANCE_OVERRIDE_EXISTS` → `writeAuditLog(...)` → 201
- Note: `eventRef` contains colons — must URL-encode when constructing audit event rows so the param can be decoded here

  3.4. Write contract test `governance-audit.contract.test.ts`:

- Start real server with test MongoDB (no ClickHouse mock — test against real ClickHouse; if ClickHouse unavailable, assert 503 `GOVERNANCE_DATA_UNAVAILABLE`)
- GET /audit with no policies → `{ events: [], total: 0, page: 1 }`; parse through `GovernanceAuditResponseSchema`
- POST /override → parse response through `z.object({ success: z.literal(true), data: z.object({ _id: z.string() }) })`
- POST /override duplicate → 409

**Files Touched**:

- `apps/runtime/src/services/governance-audit.service.ts` (modified: complete `getAuditEvents`)
- `apps/runtime/src/routes/governance.ts` (modified: add GET /audit + POST /override)
- `apps/runtime/src/__tests__/contracts/governance-audit.contract.test.ts` (new)

**Exit Criteria**:

- [ ] GET /audit returns 200 with `{ events: [], total: 0, page: 1, limit: 50 }` for project with no policies
- [ ] GET /audit with `governance:audit-read` scope (no `analytics:read`) returns 200
- [ ] GET /audit with no auth returns 401
- [ ] POST /audit/:eventRef/override returns 201 with override `_id`
- [ ] POST /audit/:eventRef/override duplicate returns 409 `GOVERNANCE_OVERRIDE_EXISTS`
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: `buildBreachQuery` for quality_evaluation + hallucination_detection — verify WHERE clause includes both rule conditions with correct operators
- Unit: `thresholdAtTime` resolution — mock policyVersions array, verify correct version returned for given timestamp
- Contract: GET /audit → `GovernanceAuditResponseSchema.parse(body)` (no throw)
- E2E-covered in Phase 8 full sweep

**Rollback**: Remove GET /audit and POST /override from route. Keep `buildBreachQuery` (pure function, no state).

---

### Phase 4: Reports (CSV + PDF) + Frameworks Backend

**Goal**: CSV/PDF export endpoints and GET /frameworks endpoint fully functional.

**Tasks**:

4.1. Create `apps/runtime/src/services/governance-report.service.ts`:

- `streamCsvReport(res: Response, tenantId: string, projectId: string, period: string): Promise<void>`:
  - Set `res.setHeader('Content-Type', 'text/csv')` + `Content-Disposition`
  - **Use `papaparse`'s `Papa.unparse()` instead of manual line writing** — papaparse is already in the monorepo lockfile (from `apps/search-ai`); add `papaparse` + `@types/papaparse` to `apps/runtime/package.json`. Manual `\n`-writing silently corrupts rows with embedded commas, quotes, or newlines in agent names or justification text.
  - Call `GovernanceAuditService.getAuditEvents(...)` with `limit = GOVERNANCE_REPORT_MAX_ROWS` (env var, default 10000)
  - Write CSV via `res.write(Papa.unparse([headerRow]))` + `Papa.unparse(rows, { header: false })` chunk-by-chunk
- `streamPdfReport(res: Response, tenantId: string, projectId: string, period: string): Promise<void>`:
  - **Buffer-first approach** (avoids streaming race with 30s timeout): generate the full PDF into a Node.js `Buffer` in memory before sending any headers. This ensures the timeout can fire a clean 503 before headers are committed:
    ```typescript
    const buf = await Promise.race([
      generatePdfBuffer(tenantId, projectId, period),
      timeoutPromise(30000),
    ]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="governance-report-*.pdf"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
    ```
  - `generatePdfBuffer()` — internal helper:
    - `const PDFDocument = (await import('pdfkit')).default` (dynamic import)
    - `const doc = new PDFDocument({ autoFirstPage: true, margins: { top: 50, bottom: 50, left: 72, right: 72 } })`
    - Pipe to a `PassThrough` stream, collect chunks, return `Buffer.concat(chunks)` on `finish`
    - Content: cover page, policy summary, agent posture, audit events (last 500), frameworks checklist
    - **After buffer ready**: check `buf.length > 50_000_000` (50MB) → return 413 `{ code: 'GOVERNANCE_REPORT_TOO_LARGE' }` before sending headers (prevents OOM on tenants with dense data)
  - On timeout (before `generatePdfBuffer` resolves): `res.status(503).json({ success: false, error: { code: 'GOVERNANCE_REPORT_TIMEOUT', message: '...' } })`
  - Row limit enforced at `GOVERNANCE_REPORT_MAX_ROWS` (env var, default 10000) — applied to audit events before PDF generation

    4.2. Create `apps/runtime/src/services/governance-frameworks.service.ts`:

- Pure functions only (no I/O, no async)
- `evaluateSOC2Controls(status: GovernanceStatusData, overrideCount: number, enabledPolicies: IGovernancePolicy[]): FrameworkControl[]`
  - CC9.1: `enabledPolicies.length > 0` → PASS, else FAIL
  - CC6.1: guardrail_analysis rule in status with all agents PASS → PASS; any FAIL → FAIL; no guardrail rule → NOT_EVALUATED
  - CC7.1: drift_detection rule exists and PASS → PASS; any FAIL → FAIL; none → NOT_EVALUATED
  - CC7.2: anomaly_detection rule exists and PASS → PASS; any FAIL → FAIL; none → NOT_EVALUATED
  - CC8.1: at least one governance_policy_versions document exists → PASS (pass `versionCount` as param)
- `evaluateGDPRControls(status: GovernanceStatusData, overrideCount: number, enabledPolicies: IGovernancePolicy[]): FrameworkControl[]`
  - Art.5: quality_evaluation rule PASS → PASS; FAIL → FAIL; none → NOT_EVALUATED
  - Art.22: `overrideCount > 0` → PASS (override records present), else WARN
  - Art.25: guardrail_analysis PASS → PASS; FAIL → FAIL; none → NOT_EVALUATED
  - Art.30: at least one event in audit trail → PASS (pass `hasAuditEvents: boolean` as param)
  - Art.13: status endpoint available (always PASS when frameworks endpoint is reached)
- `evaluateEUAIActControls(status: GovernanceStatusData, overrideCount: number, enabledPolicies: IGovernancePolicy[]): FrameworkControl[]`
  - Art.9: `enabledPolicies.length > 0` → PASS
  - Art.11: report generated in period → PASS (pass `reportExists: boolean` — for MVP always PASS since the endpoint itself is the report)
  - Art.12: audit trail completeness — `hasAuditEvents` → PASS
  - Art.13: governance status accessible → always PASS
  - Art.14: `overrideCount > 0` for any FAIL events → PASS; FAIL events with no overrides → WARN
  - Art.15: quality + hallucination PASS → PASS; either FAIL → FAIL; neither configured → NOT_EVALUATED
- `evaluateAll(params: FrameworkEvalParams): GovernanceFrameworksData` — calls all three evaluators, returns array

  4.3. Create `apps/runtime/src/routes/governance-frameworks.ts`:

- GET route handler only
- `requireProjectWideAnalyticsAccess` → `GovernanceStatusService.getStatus(...)` → `GovernanceOverride.countDocuments({ tenantId, projectId, createdAt: { $gte: periodStart } })` → `GovernancePolicyVersion.countDocuments({ tenantId, projectId })` → `GovernanceFrameworksService.evaluateAll(...)` → `{ success: true, data: { frameworks } }`

  4.4. Import and register `governance-frameworks.ts` sub-router inside `governance.ts`:

- `import governanceFrameworksRouter from './governance-frameworks.js'`
- `router.use('/frameworks', governanceFrameworksRouter)` — registered BEFORE any parameterized `/:policyId` routes (already enforced by the Phase 2 registration order — `/frameworks` mount goes between the static GET routes and the `/policies` block)
- The sub-router defines `GET '/'` internally: `router.get('/', requireProjectWideAnalyticsAccess, handler)`
- Do NOT use `router.use('/', ...)` — this mounts at root and creates catch-all shadowing risk

  4.5. Add **GET /report.csv** and **GET /report.pdf** routes to `governance.ts`:

- Both: `requireGovernanceReadAccess` → parse period → delegate to `GovernanceReportService`

  4.6. Write contract test `governance-frameworks.contract.test.ts`:

- Start real server, GET /frameworks → parse through `GovernanceFrameworksResponseSchema`
- Verify all 3 frameworks present, each has ≥4 controls

**Files Touched**:

- `apps/runtime/src/services/governance-report.service.ts` (new)
- `apps/runtime/src/services/governance-frameworks.service.ts` (new)
- `apps/runtime/src/routes/governance-frameworks.ts` (new)
- `apps/runtime/src/routes/governance.ts` (modified: add report routes, import frameworks sub-router)
- `apps/runtime/src/__tests__/contracts/governance-frameworks.contract.test.ts` (new)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors
- [ ] GET /report.csv returns `Content-Type: text/csv` with CSV header row
- [ ] GET /report.pdf returns `Content-Type: application/pdf` with non-empty body
- [ ] GET /frameworks returns `{ success: true, data: { frameworks: [{ id: 'SOC2', ... }, { id: 'GDPR', ... }, { id: 'EU_AI_ACT', ... }] } }`
- [ ] `GovernanceFrameworksResponseSchema.parse(frameworksResponse)` does not throw
- [ ] `evaluateSOC2Controls` with 0 enabled policies → CC9.1 = FAIL
- [ ] `evaluateSOC2Controls` with enabled policies → CC9.1 = PASS

**Test Strategy**:

- Unit: `evaluateSOC2Controls`, `evaluateGDPRControls`, `evaluateEUAIActControls` — pure functions, zero mocks, cover all control evaluation paths
- Unit: `GovernanceFrameworksService.evaluateAll` — verify all three frameworks in output
- Contract: GET /frameworks → `GovernanceFrameworksResponseSchema.parse(body)` (no throw)
- Integration: GET /report.pdf — check response headers and that body is non-empty bytes

**Rollback**: Remove report service, frameworks service, frameworks router. Remove report + frameworks routes from main router.

---

### Phase 5: Mount Routes + Wire Runtime

**Goal**: All governance endpoints reachable at their production paths via the runtime server. No Studio yet.

**Tasks**:

5.1. Mount governance router in `apps/runtime/src/server.ts` behind a `GOVERNANCE_ENABLED` env-var gate:

```typescript
if (process.env.GOVERNANCE_ENABLED !== 'false') {
  const { default: governanceRouter } = await import('./routes/governance.js');
  app.use('/api/projects/:projectId/governance', governanceRouter);
}
```

- Default: enabled (gate is opt-out, not opt-in — governance is production-ready on deploy)
- Kill switch: set `GOVERNANCE_ENABLED=false` on a pod to disable without a code deploy
- Place after `pipelineAnalyticsRouter` line (~L1118)

  5.2. Verify RBAC by running all contract tests against the now-mounted routes:

- `governance-policies.contract.test.ts` — all 5 policy CRUD endpoints reachable
- `governance-status.contract.test.ts` — GET /status reachable, response parses through schema
- `governance-audit.contract.test.ts` — GET /audit + POST /override reachable
- `governance-frameworks.contract.test.ts` — GET /frameworks reachable

  5.3. Run security smoke tests:

- GET /governance/status with no Authorization header → 401
- GET /governance/status with valid auth but `viewer` role → 200 (viewer has analytics:read)
- POST /governance/policies with `viewer` role → 403
- POST /governance/policies with `developer` role → 201
- GET /governance/audit with `governance:audit-read` role → 200
- Cross-tenant: GET /governance/status for projectId belonging to tenantB while authenticated as tenantA → 404

**Files Touched**:

- `apps/runtime/src/server.ts` (modified: 2 lines — import + mount)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors
- [ ] All 4 contract test files pass
- [ ] `curl -X POST http://localhost:3112/api/projects/test-project/governance/policies` with valid auth + developer role returns 201 (not 404)
- [ ] All 6 security smoke tests pass

**Test Strategy**:

- Contract tests (already written in Phases 2-4) re-run to verify mount
- Security smoke: `requireProjectPermission` handles 403 for write routes with read-only roles

**Rollback**: Remove import + mount line from `server.ts`.

---

### Phase 6: Studio — Agent Registry Tab + Policy Editor

**Goal**: Registry tab shows per-agent compliance status. Policy editor allows creating/editing policies. useGovernancePolicies and useGovernanceStatus SWR hooks in place.

**Tasks**:

6.1. Create `apps/studio/src/lib/governance-contracts.ts`:

- Re-export all schemas and types from `apps/runtime/src/routes/governance-contracts.ts`
- Note: This requires a cross-app import or the contracts file to be extracted to a shared package. For Phase 1, use a local copy of the types (not the Zod schemas, since the runtime schemas import VALID_PIPELINE_TYPES which is runtime-only). The Studio file manually defines `GovernanceStatusResponseType` using `z.infer<>` from a re-declared schema that mirrors runtime's exact shape. LLD leaves the exact sharing mechanism to the implementer with note: if a `packages/governance-contracts` shared package is created, update Phase 6 task.

  6.2. Create `apps/studio/src/hooks/useGovernancePolicies.ts`:

- SWR hook: `useSWR('/api/projects/${projectId}/governance/policies', fetcher)` with standard error handling
- `createPolicy(body: CreatePolicyBody)`: POST to `/governance/policies`
- `updatePolicy(id: string, body: UpdatePolicyBody)`: PUT to `/governance/policies/${id}`
- `deletePolicy(id: string)`: DELETE to `/governance/policies/${id}`
- Each mutation calls `mutate()` to revalidate

  6.3. Create `apps/studio/src/hooks/useGovernanceStatus.ts`:

- `useSWR('/api/projects/${projectId}/governance/status?period=${period}', fetcher)`
- Accepts `period` param (default '7d')

  6.4. Create `apps/studio/src/components/governance/AgentComplianceTable.tsx`:

- Renders table: agent name, overall status badge (PASS/WARN/FAIL), rule count
- Click row → opens `AgentComplianceDetailPanel`
- Loading state: skeleton rows using design system `Skeleton` component
- Empty state: "No governance policies configured" with CTA to Registry tab

  6.5. Create `apps/studio/src/components/governance/AgentComplianceDetailPanel.tsx`:

- Slide-over panel showing per-rule breakdown for selected agent
- Rule rows: pipelineType chip, metric name, actual value, threshold, status badge

  6.6. Create `apps/studio/src/components/governance/GovernancePolicyEditor.tsx`:

- Slide-over form with: name, description, status toggle, rules array (add/remove rules)
- Rule row: pipelineType select (11 options) → metric select (populated from METRIC_REGISTRY for selected type) → operator select → threshold number input → severity select
- Submit: calls `createPolicy` or `updatePolicy` from hook; shows inline validation errors

  6.7. Replace `GovernancePage.tsx` stub with real 4-tab implementation:

- Tab 1 (Registry): `<AgentComplianceTable>` + `<GovernancePolicyEditor>` trigger
- Tab 2 (Compliance): stub — `<ComplianceCardGrid>` placeholder in this phase
- Tab 3 (Audit Trail): stub — placeholder in this phase
- Tab 4 (Frameworks): stub — placeholder in this phase
- Period selector (7d, 30d, 90d) shared across all tabs — **persisted to URL query params** (FR-27): read initial value from `useSearchParams().get('period') ?? '7d'`; on change, call `router.push({ query: { ...params, period: newValue } })` to keep the period in the URL and survive page reload. This matches the persistent-insights-analytics-filters pattern.

**Files Touched**:

- `apps/studio/src/lib/governance-contracts.ts` (new)
- `apps/studio/src/hooks/useGovernancePolicies.ts` (new)
- `apps/studio/src/hooks/useGovernanceStatus.ts` (new)
- `apps/studio/src/components/governance/AgentComplianceTable.tsx` (new)
- `apps/studio/src/components/governance/AgentComplianceDetailPanel.tsx` (new)
- `apps/studio/src/components/governance/GovernancePolicyEditor.tsx` (new)
- `apps/studio/src/components/governance/GovernancePage.tsx` (modified: real implementation)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` succeeds with 0 errors
- [ ] Navigating to the Governance page in Studio renders the 4-tab layout without JS errors
- [ ] Registry tab shows agent compliance table (or empty state if no policies)
- [ ] Click "New Policy" opens the policy editor slide-over
- [ ] Creating a policy in the editor sends POST to /governance/policies and revalidates the table

**Test Strategy**:

- No unit tests for UI components in this phase (covered by E2E in Phase 8)
- Build verification as primary gate

**Rollback**: Revert `GovernancePage.tsx` to stub. Delete new hooks and components.

---

### Phase 7: Studio — Compliance + Audit Trail + Frameworks Tabs + Export

**Goal**: All 4 tabs fully implemented. Export buttons working. i18n complete.

**Tasks**:

7.1. Create `apps/studio/src/hooks/useGovernanceAudit.ts`:

- `useSWR('/api/projects/${projectId}/governance/audit?period=${period}&page=${page}&limit=${limit}', fetcher)`
- `createOverride(eventRef: string, body: CreateOverrideBody)`: POST to `/governance/audit/${encodeURIComponent(eventRef)}/override`

  7.2. Create `apps/studio/src/hooks/useGovernanceFrameworks.ts`:

- `useSWR('/api/projects/${projectId}/governance/frameworks?period=${period}', fetcher)`

  7.3. Create `apps/studio/src/components/governance/ComplianceCard.tsx` and `ComplianceCardGrid.tsx`:

- `ComplianceCard`: shows pipeline type name, metric, current value, threshold, trend indicator, PASS/WARN/FAIL badge
- `ComplianceCardGrid`: 3-column responsive grid of `ComplianceCard` items, grouped by severity (FAIL first)

  7.4. Create `apps/studio/src/components/governance/AuditEventTimeline.tsx` and `AuditFilters.tsx`:

- `AuditFilters.tsx`: filter bar with multi-select controls for: pipeline type (11 options), agent name, severity (critical/warning/info), event type (breach/recovery). Filter state is held in component state and serialized to URL query params `?pipelineType=...&agentName=...&severity=...&eventType=...` for deep-linking. On filter change: update URL params + trigger SWR revalidation by passing new query string to `useGovernanceAudit`.
- `AuditEventTimeline.tsx`: renders `<AuditFilters>` above a paginated list; each row shows event type chip (breach/recovery), agent name, metric, actual vs threshold, timestamp, override badge. "Override" button per breach event → opens `OverrideModal`. Pagination controls (prev/next, current page).

  7.5. Create `apps/studio/src/components/governance/OverrideModal.tsx`:

- Modal with justification textarea (required), original severity display, confirm/cancel
- Submit calls `createOverride(eventRef, body)` → shows success toast → revalidates audit data

  7.6. Create `apps/studio/src/components/governance/ExportBar.tsx`:

- "Export CSV" button: `window.open('/api/projects/${projectId}/governance/report.csv?period=${period}')` with auth header injection via fetch + blob URL
- "Export PDF" button: same pattern
- Loading state while fetching

  7.7. Create `apps/studio/src/components/governance/FrameworksTab.tsx` and `FrameworkChecklist.tsx`:

- `FrameworkChecklist`: accordion per framework (SOC2 / GDPR / EU AI Act) with per-control rows showing status badge + evidence text
- `FrameworksTab`: wraps 3 `FrameworkChecklist` components

  7.8. Wire all tabs in `GovernancePage.tsx`:

- Tab 2 (Compliance): `<ComplianceCardGrid>` using `useGovernanceStatus`
- Tab 3 (Audit Trail): `<AuditEventTimeline>` + `<ExportBar>` using `useGovernanceAudit`
- Tab 4 (Frameworks): `<FrameworksTab>` using `useGovernanceFrameworks`

  7.9. i18n: add all user-facing string keys to `packages/i18n/locales/en/studio.json` under the existing `"governance"` key (line ~12596). Cover: all tab labels, card labels, table headers, empty states, error banners, framework control labels, export button labels.

**Files Touched**:

- `apps/studio/src/hooks/useGovernanceAudit.ts` (new)
- `apps/studio/src/hooks/useGovernanceFrameworks.ts` (new)
- `apps/studio/src/components/governance/ComplianceCard.tsx` (new)
- `apps/studio/src/components/governance/ComplianceCardGrid.tsx` (new)
- `apps/studio/src/components/governance/AuditEventTimeline.tsx` (new)
- `apps/studio/src/components/governance/AuditFilters.tsx` (new)
- `apps/studio/src/components/governance/OverrideModal.tsx` (new)
- `apps/studio/src/components/governance/ExportBar.tsx` (new)
- `apps/studio/src/components/governance/FrameworksTab.tsx` (new)
- `apps/studio/src/components/governance/FrameworkChecklist.tsx` (new)
- `apps/studio/src/components/governance/GovernancePage.tsx` (modified: wire Tabs 2-4)
- `packages/i18n/locales/en/studio.json` (modified: add `governance.*` keys under existing "governance" key)

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` succeeds with 0 errors
- [ ] All 4 tabs render without JS errors (verified in browser)
- [ ] Compliance tab shows cards when policies + pipeline data exist
- [ ] Audit Trail tab shows paginated events; Override modal opens and submits
- [ ] Frameworks tab shows 3 framework accordions with control rows
- [ ] Export CSV button triggers a CSV download; Export PDF button triggers a PDF download
- [ ] No hardcoded English strings in component JSX (all strings via `useTranslations('governance')`)

**Test Strategy**:

- Build verification
- Manual smoke test in browser (dev server)
- E2E test sweep in Phase 8

**Rollback**: Revert GovernancePage to Phase 6 state (only Registry + Compliance stub). Delete new hooks and components.

---

### Phase 8: Contract Verification Sweep + E2E Test Harness + Full Integration

**Goal**: All 4 contract test files complete and passing. E2E test infrastructure in place for test-spec scenarios. Full regression baseline established.

**Tasks**:

8.1. Complete `governance-policies.contract.test.ts`:

- Start real Express server on port 0 with full middleware chain (auth + tenant isolation)
- Test each endpoint response shape parses through its Zod contract schema without throwing
- Cover: `{ success: true }` + `{ success: false, error: { code, message } }` shapes
- Verify: POST /policies 201 response → schema; GET /policies 200 response → list schema; PUT /policies 200 → schema; DELETE 204 → no body; GET /policies/:id 404 → error schema

  8.2. Complete `governance-status.contract.test.ts`:

- Start real server, create policy, GET /status → `GovernanceStatusResponseSchema.parse(body)` — no throw
- Verify `summary` object has `pass`, `warn`, `fail`, `unavailable` keys with numeric values
- Verify `agents` array each item parses through `GovernanceAgentStatusSchema`
- Test cache hit: call GET /status twice with 5s TTL env var; second call returns same `summary` (cache hit logged but not tested directly)

  8.3. Complete `governance-audit.contract.test.ts` (already started in Phase 3 — finalize):

- Test all edge cases: empty events, override merge, pagination boundary

  8.4. Complete `governance-frameworks.contract.test.ts` (already started in Phase 4 — finalize):

- With 0 policies: CC9.1 = FAIL; Art.9 = FAIL; Art.11 = PASS
- All controls have non-empty `evidence` string
- All 3 frameworks present in response

  8.5. Write E2E test infrastructure and all 15 scenarios from the test spec:

- E2E-1: Create policy → GET /status → verify FAIL when metric below threshold
- E2E-2: GET /frameworks → all 3 frameworks → verify SOC2 CC9.1 PASS (policy exists)
- E2E-3: GET /status after seeding hallucination_detection data with faithfulness_score below threshold → agent status FAIL
- E2E-4: GET /audit → events sorted by timestamp DESC
- E2E-5: POST /audit/:eventRef/override → re-GET /audit → event has overrideId + reviewStatus
- E2E-6: GET /report.pdf → Content-Type: application/pdf, body > 0 bytes
- E2E-7: Viewer role — GET /policies (200), POST /policies (403)
- E2E-8: POST /policies with duplicate name → 409 GOVERNANCE_POLICY_EXISTS
- E2E-9: Cross-tenant — GET /status for another tenant's project → 404
- E2E-10: PUT policy (threshold change) → seed breach events → GET /audit → `thresholdAtTime` reflects pre-update threshold for pre-update events; new threshold for post-update events (FR-30 validation)
- E2E-11: Create user with `governance:audit-read` scope → GET /audit (200) → POST /policies (403)
- E2E-12 through E2E-15: Framework checklist scenarios (see test spec Section 2 for exact steps)

  8.6. Write `docs/testing/governance-contract-coverage.md` — a brief coverage matrix mapping each API response shape to its contract test and schema validator.

**Files Touched**:

- `apps/runtime/src/__tests__/contracts/governance-policies.contract.test.ts` (completed)
- `apps/runtime/src/__tests__/contracts/governance-status.contract.test.ts` (completed)
- `apps/runtime/src/__tests__/contracts/governance-audit.contract.test.ts` (completed)
- `apps/runtime/src/__tests__/contracts/governance-frameworks.contract.test.ts` (completed)
- E2E test files in appropriate `apps/runtime/src/__tests__/e2e/` location

**Exit Criteria**:

- [ ] All 4 contract test files pass: `pnpm test --filter=@abl/runtime -- contracts/governance`
- [ ] Every API response shape in the governance API has a corresponding `z.parse()` call in contract tests
- [ ] E2E-1 scenario passes end-to-end
- [ ] E2E-9 cross-tenant isolation scenario passes
- [ ] `pnpm build && pnpm test --filter=@abl/runtime --filter=@abl/database --filter=@abl/shared-auth --filter=@abl/studio` all pass with 0 failures

**Test Strategy**:

- Contract tests: real Express + real MongoDB + real Redis; ClickHouse mocked at module boundary (DI) for non-ClickHouse contract shapes; real ClickHouse for audit/status contracts
- E2E: real stack (MongoDB + Redis + ClickHouse); auth via real JWT; tenant isolation via `tenantContext`

**Rollback**: N/A — test-only phase.

---

## 4. Wiring Checklist

- [ ] `governance-contracts.ts` — imported by `governance.ts` for `CreatePolicyBodySchema.safeParse(req.body)`, `UpdatePolicyBodySchema.safeParse`, `CreateOverrideBodySchema.safeParse`, and response typing
- [ ] `GovernancePolicy`, `GovernanceOverride`, `GovernancePolicyVersion` models exported from `packages/database/src/models/index.ts`
- [ ] All three models added to `deleteProject()` + `deleteTenant()` in `cascade-delete.ts`
- [ ] `governance:write` + `governance:audit-read` in `PERMISSION_REGISTRY` and `PROJECT_ROLE_PERMISSIONS`
- [ ] `GovernanceCache` imported and instantiated in `GovernanceStatusService`
- [ ] `GovernanceStatusService` imported and called from GET /status route handler
- [ ] `GovernanceAuditService` imported and called from GET /audit + POST /override route handlers
- [ ] `GovernanceReportService` imported and called from GET /report.csv + GET /report.pdf route handlers
- [ ] `GovernanceFrameworksService` imported and called from GET /frameworks route handler
- [ ] `governance-frameworks.ts` sub-router imported and registered inside `governance.ts` as `router.use('/frameworks', governanceFrameworksRouter)` — registered BEFORE any `/:policyId` parameterized route (position 6 in the Phase 2.5 registration order)
- [ ] `governanceRouter` imported and mounted in `apps/runtime/src/server.ts`
- [ ] `executePipelineSummary` imported by `GovernanceStatusService` (not by route handler)
- [ ] `buildSummaryQuery` called from `executePipelineSummary` (not from route)
- [ ] `requireGovernanceReadAccess` added as exported function to `apps/runtime/src/middleware/rbac.ts` and imported in `governance.ts`
- [ ] `writeAuditLog` called on all 4 mutations (policy create/update/delete, override create)
- [ ] `createLogger('governance')` used in `governance.ts`, `governance-status.service.ts`, `governance-audit.service.ts`, `governance-report.service.ts`, `governance-frameworks.ts` — no `console.log`
- [ ] `recordSyntheticTraceEvent` called in `GovernanceStatusService.getStatus()` with `governance.status.computed` event
- [ ] `Semaphore(4)` from `local-semaphore.ts` applied to ClickHouse fan-out in `GovernanceStatusService`
- [ ] `GOVERNANCE_ENABLED` env var checked before mounting router in `server.ts`
- [ ] `useGovernancePolicies`, `useGovernanceStatus`, `useGovernanceAudit`, `useGovernanceFrameworks` imported in `GovernancePage.tsx`
- [ ] All 4 Studio hooks use correct API base path `/api/projects/${projectId}/governance/...`
- [ ] `pdfkit` in `apps/runtime/package.json` dependencies (not devDependencies)
- [ ] New routes registered BEFORE any parameterized wildcard routes in `governance.ts` (e.g., `/status`, `/audit`, `/report.csv`, `/report.pdf` registered before `/:policyId`)
- [ ] `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` env var documented in deployment runbook / `.env.example`
- [ ] `GOVERNANCE_REPORT_MAX_ROWS` env var documented

---

## 5. Cross-Phase Concerns

### Database Migrations

No migrations. All three collections are created empty by MongoDB on first write. Index creation is handled by Mongoose's `{ autoIndex: true }` setting (default in dev; migrations should be run explicitly in production via `Model.createIndexes()` in a startup script or deployment job).

Add to deployment runbook:

```
pnpm exec tsx scripts/create-governance-indexes.ts
```

Script calls `GovernancePolicy.createIndexes()`, `GovernanceOverride.createIndexes()`, `GovernancePolicyVersion.createIndexes()`.

### Feature Flags

None. The governance router is always-on once mounted. Rollback path is to unmount it from `server.ts` and revert `GovernancePage.tsx` to stub.

### Configuration Changes

| Env Var                               | Default | Description                                                                    |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `GOVERNANCE_ENABLED`                  | `true`  | Kill switch — set to `false` to disable all governance routes without a deploy |
| `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` | `300`   | Redis cache TTL for /status responses (5 minutes)                              |
| `GOVERNANCE_REPORT_MAX_ROWS`          | `10000` | Maximum audit events in CSV/PDF export                                         |

Both vars should be added to `apps/runtime/.env.example`.

### pdfkit Dockerfile Sync

Per CLAUDE.md: when adding a new `packages/<name>/` workspace package, add its `COPY` line to all Dockerfiles. pdfkit is an npm package (not a workspace package), so no Dockerfile change is needed — it will be installed via `pnpm install --frozen-lockfile` once `package.json` is updated.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with phase-level exit criteria met
- [ ] All 36 FRs implemented (see HLD FR Traceability table)
- [ ] All 4 contract test files pass
- [ ] E2E-1 through E2E-5 pass (core governance flow)
- [ ] E2E-6 (PDF export Content-Type + body bytes) passes
- [ ] E2E-7 (read-only isolation — viewer cannot create policy) passes
- [ ] E2E-8 (duplicate policy name returns 409) passes
- [ ] E2E-9 (cross-tenant isolation) passes
- [ ] E2E-10 (thresholdAtTime — policy updated mid-period; breach events show correct historical threshold) passes
- [ ] E2E-11 (governance:audit-read external auditor can access audit endpoint) passes
- [ ] E2E-12 through E2E-15 (frameworks scenarios) pass
- [ ] No regressions: `pnpm build && pnpm test --filter=@abl/runtime --filter=@abl/database --filter=@abl/shared-auth --filter=@abl/studio`
- [ ] Pipeline-analytics existing tests still pass (Phase 0 refactor regression check)
- [ ] `GovernanceStatusService.evaluateRule` covered by unit tests for all 5 operators (gt, gte, lt, lte, eq)
- [ ] `GovernanceFrameworksService` pure-function tests cover all 3 frameworks × all control paths
- [ ] Every API response shape has a Zod contract schema in `governance-contracts.ts` and a corresponding `z.parse()` call in a contract test
- [ ] `writeAuditLog` called on: policy.create, policy.update, policy.delete, override.create
- [ ] Redis fail-open verified: `GovernanceCache` test with null Redis client
- [ ] Cascade-delete verified: deleting a project removes governance_policies, governance_overrides, governance_policy_versions
- [ ] PDF export returns valid PDF bytes (Content-Type: application/pdf)
- [ ] CSV export returns valid CSV with header row
- [ ] No hardcoded English strings in Studio governance components

---

## 7. Open Questions

1. **Contract type sharing between runtime + Studio**: `governance-contracts.ts` in runtime imports `VALID_PIPELINE_TYPES` from `pipeline-analytics-helpers.ts`. Studio cannot import from `apps/runtime/`. Phase 6 uses a manual type-mirror in `apps/studio/src/lib/governance-contracts.ts`. If a `packages/governance-contracts` shared package is created later, update Phase 6 task to import from it.

2. **External auditor invitation UI**: FR-31 adds `governance:audit-read` scope and the permission check is implemented. The UI flow for an admin to provision this scope to an external user not yet in the workspace is Phase 2. The RBAC check is in place; only the invitation flow is deferred.

3. **Materialized view usage for status fan-out**: The 4 pipeline types with MVs (`sentiment_analysis`, `intent_classification`, `quality_evaluation`, `llm_evaluate`) could use `PIPELINE_MV_TABLES` for faster status queries. Phase 1 implementation uses raw tables for simplicity. An optimization task can switch to MV tables for the summary query in `executePipelineSummary` based on whether the caller requests 'summary' vs 'breakdown'. This is a performance optimization, not a correctness issue.

4. **Override `reviewStatus` lifecycle**: Currently `GovernanceOverride` has no status field (it's the creation of an override that counts). The `reviewStatus` field in the audit response is a future field for a 3-party approval workflow. Phase 1: `reviewStatus` is always `'approved'` on creation (the act of creating an override implies review). Phase 2: add `status: 'pending' | 'approved' | 'rejected'` with a separate approval endpoint.

---

## Post-Implementation Notes (2026-04-29)

### Implementation Status: DONE

All planned phases (1-8) implemented and committed on 2026-04-29.

### Deviations from Plan

| Deviation                                                      | Impact   | Notes                                                                                                                                                                |
| -------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract tests consolidated: 4 separate contract files → 1     | Low      | `governance-policies.contract.test.ts` covers all 12 contract tests. Separate per-concern files were planned but consolidation reduces test infrastructure overhead. |
| `GOVERNANCE_ENABLED` is opt-out, not opt-in                    | Medium   | Implementation uses `!== 'false'` — governance routes are active by default. Feature spec originally said default = `false`. Corrected in §11 of feature spec.       |
| `governance-policy-version.model.ts` added (not in data model) | Low      | Open Question #4 resolved as lightweight snapshot. Append-only collection snapshots policy rules on every PUT.                                                       |
| `apps/runtime/src/routes/governance-contracts.ts` (Zod) added  | Low      | Not planned explicitly; added to share contract schemas between route handlers and contract tests.                                                                   |
| Studio `GOVERNANCE_METRICS` metric names were wrong at commit  | Resolved | Data-flow audit caught misaligned metric names (Studio had invented names, not actual ClickHouse columns). Fixed in data-flow audit commit.                          |

### Known Gaps Remaining (BETA prerequisites)

- GAP-011: External auditor provisioning UI (FR-31) — auth RBAC check implemented, invitation flow deferred
- GAP-012: ClickHouse-backed integration tests — breach detection, CSV/PDF export, Redis caching all untested
- GAP-012 addendum: Explicit 401 test for policy CRUD (no-auth path not covered by contract tests)
- GAP-012 addendum: Cross-tenant isolation tests for policy CRUD endpoints (only GET /status covered)
