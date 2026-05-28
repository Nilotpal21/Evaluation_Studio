# Guardrail Policy Scope and Contract Hardening Plan

Date: 2026-05-02
Status: IMPLEMENTED

## Context

This plan extends [2026-05-02-guardrail-policy-end-to-end-hardening-impl-plan.md](/Users/prasannaarikala/projects/f-2/abl-platform/docs/plans/2026-05-02-guardrail-policy-end-to-end-hardening-impl-plan.md) with the remaining control-plane and runtime-contract gaps found after the first lifecycle fixes.

The path under hardening is:

Studio/admin API -> runtime policy CRUD/model -> resolved policy contract -> runtime execution ports.

## Problems To Close

1. Policy activation still behaves like "one active policy per project", which breaks the intended project + agent layering model.
2. DB-backed scope precedence is not explicit enough; project and agent policies currently share one merge bucket.
3. Nested `settings`, `caching`, and `budget` updates still use replacement semantics on `PUT`.
4. `budget.currentSpendUsd` is persisted as if it were authoritative, but live enforcement reads from Redis.
5. Policy operational controls (`caching`, `budget`, webhook settings) are ambiguous on non-project scopes because runtime cache/cost ports are project-scoped.
6. Guardrail policy name uniqueness is broader than the scope model and incorrectly collides across projects/agents.
7. Tenant-scoped policies exist in the model/resolver contract but do not have a first-class CRUD surface.

## Design Goals

- Preserve the layered policy model: tenant baseline, project baseline, then agent refinement.
- Make runtime contract boundaries honest: fields either affect execution or are rejected.
- Avoid silent data loss on partial nested updates.
- Keep existing active project behavior stable while allowing narrower agent overrides to coexist.
- Future-proof operational controls so scope coexistence does not introduce cache or budget bleed.

## Canonical Decisions

### 1. Activation is cohort-based, not project-wide

Each active policy belongs to one activation cohort:

- `tenant`
- `project:<projectId>`
- `agent:<projectId>:<agentDefId>`

Only one active policy may exist in a cohort at a time. Activating an agent-scoped policy must not deactivate the project baseline or other agents' active overrides.

### 2. Runtime precedence is explicit

Runtime policy resolution remains:

- tenant
- project
- agent

The DB loader must preserve that order deterministically before the resolver sees policies. Project and agent policies may still share the resolver's project-level bucket, but the loader must always enqueue project policies before agent policies and apply a deterministic tie-breaker for legacy duplicates.

### 3. `PUT` uses normalized patch semantics for nested policy config

Nested policy objects are patched, not replaced:

- `settings`
- `settings.timeouts`
- `settings.streaming`
- `caching`
- `budget`

Updates are resolved as:

- read current policy
- merge incoming nested fields over stored values
- normalize and validate the merged shape
- write the merged result with validators enabled

### 4. `budget.currentSpendUsd` is runtime-managed

Clients cannot write `budget.currentSpendUsd`.

The persisted document keeps the field for backward compatibility, but API responses hydrate the live value from the Redis-backed cost tracker for project-scoped policies. That makes the read contract honest without forcing a DB write on every evaluation.

### 5. Operational controls are project-scoped in v1

To avoid cross-agent cache/budget bleed while project and agent policies can coexist:

- `caching`
- `budget`
- `settings.webhookUrl`
- `settings.webhookSecret`

are accepted only on project-scoped policies in this slice.

Agent and tenant policies may still control:

- rules
- provider overrides
- constitution
- fail mode
- execution timeouts
- streaming settings

This preserves useful layering while avoiding misleading scope-specific operational controls until scoped cache/cost namespaces are designed.

### 6. Name uniqueness follows the real scope identity

Unique policy identity is:

- `tenantId`
- `name`
- `scope.type`
- `scope.projectId`
- `scope.agentDefId`

That allows the same policy name to exist in different projects, and different agent-scoped policies with the same name to coexist for different agents.

### 7. Tenant scope gets a first-class admin API surface

The runtime route will support both:

- `/api/projects/:projectId/guardrail-policies` for project + agent scopes
- `/api/guardrail-policies` for tenant scope

The Studio admin proxy will forward to either path depending on whether `projectId` is present.

This slice does not require a new tenant-level Studio page; it ensures the admin API surface can manage tenant policies cleanly now.

## Implementation Slices

### Slice 1: Scope Cohorts and Deterministic Precedence

Goal:
Allow layered active policies without cross-scope deactivation.

Changes:

- Add activation cohort helper keyed by scope identity.
- Deactivate only sibling policies in the same cohort.
- Make DB loading deterministic: project policies always load before agent policies.
- Keep current project-vs-project single-active semantics intact.

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - active project baseline and active agent policy can coexist
  - active agent policy only deactivates siblings for the same `agentDefId`
  - project activation still deactivates other project-scoped actives
- `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`
  - project policy settings apply before agent policy overrides in DB-backed order

Exit criteria:

- Agent overrides no longer collapse the project baseline.
- Two different agent-scoped policies can be active simultaneously when they target different agents.

### Slice 2: Honest Patch Semantics

Goal:
Eliminate nested replacement writes and under-validated policy blobs.

Changes:

- Add normalizers for `settings`, `caching`, and `budget` that support patch merge semantics.
- Ignore client writes to `budget.currentSpendUsd`.
- Enable validators on update writes.
- Reject malformed nested policy payloads before they hit Mongo.

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - partial settings update preserves timeouts and streaming fields
  - partial caching update preserves TTL and match flags
  - partial budget update preserves overspend action and ignores client `currentSpendUsd`

Exit criteria:

- `PUT` no longer wipes sibling nested fields.
- Client writes cannot forge budget spend.

### Slice 3: Project-Scoped Operational Controls

Goal:
Keep operational controls honest while scope coexistence is enabled.

Changes:

- Reject `caching`, `budget`, and webhook settings on tenant- or agent-scoped policy writes.
- Drop legacy non-project operational controls from the DB loader before runtime resolution.
- Hydrate `budget.currentSpendUsd` from the live cost tracker in response normalization for project policies.

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - agent-scoped policy rejects budget/caching/webhook controls
  - tenant-scoped policy rejects budget/caching/webhook controls
  - GET returns live `budget.currentSpendUsd`, not the client-supplied value

Exit criteria:

- Operational controls either affect execution honestly or are rejected.
- API responses no longer present stale budget spend as authoritative.

### Slice 4: Scope-Accurate Identity and Tenant CRUD

Goal:
Align persistence identity with actual scope semantics and expose tenant CRUD.

Changes:

- Update the unique index to include scope identity fields.
- Mount tenant-scoped CRUD at `/api/guardrail-policies`.
- Extend the Studio admin proxy to forward tenant-scoped operations when `projectId` is omitted.

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - same policy name can exist in different projects
  - same agent-scoped name can exist for different agents
  - tenant route creates and lists tenant-scoped policies
- `apps/studio/src/__tests__/api-routes/api-model-config-routes.test.ts` or a new focused proxy test if needed
  - admin proxy forwards tenant-scoped guardrail requests without `projectId`

Exit criteria:

- Duplicate-name collisions only happen inside the same real scope target.
- Tenant policies have a supported CRUD path.

## Verification Commands

Per slice:

- `pnpm --filter @agent-platform/database build`
- `pnpm --filter @agent-platform/runtime build`
- focused `vitest` suites for touched runtime tests
- if Studio admin proxy changes: `pnpm --filter @agent-platform/studio build`

Final verification:

- `pnpm --filter @agent-platform/database build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- focused guardrail route/resolver/pipeline suites

## Residual Follow-Ups

- If product wants tenant policies visible/editable from a dedicated Studio surface, add a tenant-level guardrail management page later instead of overloading the project page.
- If agent-scoped operational controls become a product requirement, introduce scope-aware cache/cost namespaces rather than widening write acceptance prematurely.
