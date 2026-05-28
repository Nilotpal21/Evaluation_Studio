# Guardrail Policy Studio and Runtime Round-Trip Contract Hardening Plan

Date: 2026-05-02
Status: IMPLEMENTED

## Context

This plan extends:

- [2026-05-02-guardrail-policy-end-to-end-hardening-impl-plan.md](/Users/prasannaarikala/projects/f-2/abl-platform/docs/plans/2026-05-02-guardrail-policy-end-to-end-hardening-impl-plan.md)
- [2026-05-02-guardrail-policy-scope-contract-hardening-impl-plan.md](/Users/prasannaarikala/projects/f-2/abl-platform/docs/plans/2026-05-02-guardrail-policy-scope-contract-hardening-impl-plan.md)

The remaining gaps are no longer primarily CRUD or scope-activation bugs. They are contract drift bugs across the last mile:

Studio form/editor -> Studio admin proxy/hooks -> runtime policy document -> runtime resolver -> compiler pipeline execution.

## Problems To Close

1. Tier 2 exact-match cache hits skip evaluator work but also skip the cached behavioral outcome, so a previously warned or blocked payload can incorrectly pass.
2. Tier 2 cache entries are keyed per guardrail, but the pipeline currently writes the full aggregate Tier 2 result under every key. That is not future-safe for partial cache hits or mixed cached/uncached evaluations.
3. The Studio form only edits a narrow subset of the policy schema and silently drops richer persisted fields such as `providerOverrides`, `constitution`, `caching`, and `budget`.
4. The Studio form only understands `define` rules with `input | output | both` kinds, so DSL override rules and non-chat execution kinds are corrupted or dropped on edit/save.
5. The project guardrails page only shows project/agent policy data, even though runtime resolves tenant baselines first. Users can therefore see an incomplete effective policy stack.
6. Tenant-scoped policy payloads are still coerced back to project scope by the form/YAML round-trip path.

## Design Goals

- Make cached evaluation replay behaviorally correct, not just faster.
- Treat the Studio form as a partial editor over a full-fidelity policy document.
- Preserve unknown, runtime-managed, or not-yet-editable policy fields by default.
- Preserve unsupported rules and scopes byte-for-byte enough that opening and saving a policy does not mutate its meaning.
- Surface the effective runtime stack in Studio without forcing users into hidden-scope debugging.
- Keep the implementation future-ready for additional policy fields, rule overrides, and scope types.

## Canonical Decisions

### 1. Tier 2 cache is per-guard outcome cache, not aggregate-result cache

Each Tier 2 cache entry represents one guardrail evaluation outcome for one content hash.

The cache payload must be replayable on a future request without re-running the provider and without changing the final pipeline result. That means the cached record must capture the guard-level behavioral outcome, not just "a hit happened".

Compatibility rule:

- new writes use the per-guard outcome shape
- reads accept both the new per-guard shape and legacy cached shapes well enough to fail open safely

### 2. Studio form is a partial projection over a full policy payload

The structured form is not the canonical policy schema.

The canonical payload is the full policy document returned by the API. The form edits only the subset it understands:

- name
- description
- scope selection
- supported rule shapes
- fail mode
- execution timeouts
- streaming controls
- status

Everything else must be preserved unless the user edits it in YAML.

### 3. Unsupported rules are passthrough data, not disposable data

Rules that the structured editor does not fully understand remain part of the payload and must survive:

- override modes other than `define`
- execution kinds such as `tool_input`, `tool_output`, and `handoff`
- future rule shapes the form does not yet model

The form may edit the supported subset, but it must carry unsupported rules forward unchanged.

### 4. Scope support is broader than the current project page

The form and payload normalizer must understand:

- `tenant`
- `project`
- `agent`

The project page may still restrict which scopes users can create there, but it must not coerce a tenant-scoped payload into a project-scoped payload during read/write or YAML round-trips.

### 5. Project guardrails page shows the effective runtime stack, not only local edits

The project page remains the project guardrail management entry point, but it must also surface active tenant baselines that participate in runtime resolution for the current project.

This slice only requires visibility, not full tenant-scope CRUD from this page.

## Implementation Slices

### Slice 1: Tier 2 Cache Replay Correctness

Goal:
Make cached model-evaluation hits produce the same behavioral outcome as fresh evaluation.

Changes:

- Add compiler regression coverage for cache-hit warning/block replay.
- Change cache writes from aggregate Tier 2 result objects to per-guard cached outcomes.
- Add cache-read normalization so legacy cached payloads fail open safely.
- Merge cached outcomes back into the pipeline result with correct metrics and primary-violation behavior.

Tests first:

- `packages/compiler/src/__tests__/guardrails/pipeline-ports.test.ts`
  - cache hit replays a cached warning
  - cache hit replays a cached terminal violation
  - mixed cache-hit/cache-miss Tier 2 evaluation does not double-count or drop outcomes

Exit criteria:

- Cached warn/block behavior matches uncached behavior.
- Partial Tier 2 cache hits remain deterministic.

### Slice 2: Full-Fidelity Studio Payload Preservation

Goal:
Prevent Studio edit/save from stripping advanced policy data.

Changes:

- Broaden Studio guardrail policy types to include the real runtime-supported fields.
- Preserve a full raw policy payload in the form state.
- Build form submissions by overlaying edited fields on top of the preserved base payload.
- Preserve non-form-managed settings fields when structured fields are edited.

Tests first:

- `apps/studio/src/__tests__/components/guardrail-policy-form.test.tsx`
  - editing a policy preserves `providerOverrides`
  - editing a policy preserves `constitution`
  - editing a policy preserves `caching`
  - editing a policy preserves `budget`

Exit criteria:

- Opening and saving a rich policy from the structured form no longer drops advanced fields.

### Slice 3: Rule and Scope Round-Trip Preservation

Goal:
Make the form/YAML round-trip non-destructive for unsupported rule shapes and tenant scope.

Changes:

- Split rules into form-editable and passthrough subsets.
- Preserve unsupported rules unchanged during form submit and form <-> YAML transitions.
- Extend internal scope handling to support `tenant` in addition to `project` and `agent`.
- Keep project-page scope creation constrained by UI options instead of by lossy payload coercion.

Tests first:

- `apps/studio/src/__tests__/components/guardrail-policy-form.test.tsx`
  - `disable`/`threshold`/`action`/`severity_actions` rules survive edit/save
  - `tool_input`/`tool_output`/`handoff` rules survive edit/save
  - tenant-scoped YAML survives switching back to form and submitting

Exit criteria:

- Unsupported rules are preserved across form edits.
- Tenant-scoped payloads are no longer rewritten as project-scoped payloads.

### Slice 4: Tenant Baseline Visibility in the Project Page

Goal:
Show the runtime-effective baseline stack on the project guardrails page.

Changes:

- Extend the Studio policies hook to optionally fetch tenant-scoped policies through the existing admin proxy.
- Render active tenant baseline policies in the project guardrails page as a separate effective-stack section.
- Keep project policy CRUD behavior unchanged.

Tests first:

- `apps/studio/src/__tests__/components/guardrails-config-page.test.tsx`
  - project page renders active tenant baseline policies alongside project policies
  - tenant baseline section is read-only and clearly separate from project-local policies

Exit criteria:

- Users can see tenant baselines that still affect runtime execution for the current project.

## Verification Commands

Per compiler slice:

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @abl/compiler test -- src/__tests__/guardrails/pipeline-ports.test.ts`

Per Studio slice:

- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/guardrail-policy-form.test.tsx`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/guardrails-config-page.test.tsx`

If runtime cache adapters or shared types change:

- `pnpm --filter @agent-platform/runtime build`
- targeted runtime guardrail cache tests as needed

## Residual Follow-Ups

- If product wants tenant policies editable from Studio, add a tenant-scoped management surface instead of overloading the project page.
- If the structured form grows support for advanced policy fields later, move those fields from passthrough preservation into first-class editors without changing the base preservation contract.
