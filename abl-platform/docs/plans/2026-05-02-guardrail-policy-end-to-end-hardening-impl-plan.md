# Guardrail Policy End-to-End Hardening Plan

Date: 2026-05-02

## Scope

Harden the guardrail policy path across:

Studio authoring -> runtime policy CRUD/model -> resolved policy contract -> runtime execution.

This plan addresses the remaining hidden gaps after the first ABLP-734 lifecycle fix:

1. Hot sessions can keep stale in-memory guardrail policy after policy edits/activation.
2. Studio exposes streaming controls (`token`, `maxLatencyMs`) that runtime does not honor.
3. Archived policies are not round-trippable through Studio.
4. Agent-scoped policies are not usable from Studio because the form has no project agent options.
5. Policy `providerOverrides` are only partially consumed at execution time.
6. Policy operational controls (`caching`, `budget`, `webhook`) are stored but mostly not honored.

## Design Goals

- Make the stored policy contract honest: Studio should only promise behavior runtime actually honors.
- Make runtime policy application refresh-safe for long-lived in-memory sessions.
- Preserve backward compatibility for already-stored valid policy data where feasible.
- Prefer explicit rejection over silent no-op when a field has no runtime consumer.
- Lock every fix with a targeted regression first, then implement the slice.

## Canonical Decisions

### 1. Policy freshness is epoch-based

- Introduce a project-scoped guardrail policy epoch.
- Every policy mutation bumps the epoch.
- Session policy cache entries are valid only when their cached epoch matches the latest project epoch.
- Redis is the source of truth when available; a process-local fallback keeps same-pod behavior correct when Redis is absent.

Why:

- Fixes stale hot-session behavior without forcing DB re-resolution on every turn.
- Works for multi-pod runtime once the mutation pod and execution pod share Redis.

### 2. Streaming config semantics are explicit

- `sentence`: evaluate on sentence boundaries.
- `chunk_size`: evaluate when unevaluated buffered text reaches `chunkSize`.
- `token`: evaluate on every stream callback chunk.
- `maxLatencyMs`: upper bound on how long newly streamed, unevaluated text may sit before the next chunk forces an evaluation.

Why:

- Preserves Studio’s current authoring surface.
- Leaves room for a future tokenizer-aware implementation without changing the saved API.

### 3. Archived is a first-class policy status

- Studio form state preserves `draft | active | archived`.
- Editing an archived policy must not silently downgrade it to `draft`.
- Guardrail list surfaces real lifecycle state instead of flattening everything non-active into one generic bucket.

### 4. Agent-scoped policy authoring is project-scoped and self-contained

- The policy form loads project agents when it does not receive explicit agent options.
- Agent scope stores the runtime-resolved agent identifier currently used by policy resolution (`agent.name`).
- The authoring surface must not present an empty agent selector for a valid project.

### 5. Provider overrides use a narrow, executable contract

Supported at runtime:

- `providerName`
- `endpoint`
- `defaultThreshold`
- `costPerEvalUsd`
- `isActive`
- `circuitBreaker`
- `retry`

Rejected at write boundary until a consumer exists:

- `apiKeyCredentialId`
- `authProfileId`

Why:

- `endpoint`, `defaultThreshold`, `costPerEvalUsd`, and `retry` can be honored today.
- Credential-routing overrides need a separate secure resolution design; storing them now is a silent lie.

### 6. Operational controls have an honest v1 contract

Supported now:

- `caching.enabled`
- `caching.exactMatch`
- `caching.defaultTtlSeconds`
- `budget.monthlyLimitUsd`
- `budget.overspendAction`
- `settings.webhookUrl`
- `settings.webhookSecret`

Rejected until implemented:

- `caching.semanticMatch = true`

Notes:

- Runtime exact-match caching is the only implemented cache strategy in this slice.
- Semantic caching remains reserved and must fail closed at write time instead of silently degrading.

## Implementation Slices

### Slice 1: Studio Lifecycle Parity

Problems fixed:

- Archived round-trip bug.
- Empty agent selector for agent-scoped policies.

Changes:

- Expand form status type to include `archived`.
- Preserve archived status when hydrating from stored policy and YAML payload.
- Add archived option to the lifecycle control.
- Load project agents in `GuardrailPolicyForm` when agent options are not supplied.
- Surface real status labels in the guardrails list.

Tests first:

- `apps/studio/src/__tests__/components/guardrail-policy-form.test.tsx`
  - preserves archived status on edit submit
  - fetches project agents and submits selected agent-scoped policy

Exit criteria:

- Editing an archived policy submits `status: 'archived'`.
- Agent-scoped policy creation no longer depends on the parent manually supplying options.

### Slice 2: Streaming Contract Parity

Problems fixed:

- `token` behaves like `sentence`.
- `maxLatencyMs` is write-only.

Changes:

- Extend `StreamingEvalConfig` and `toStreamingEvalConfig()` to preserve `token` and `maxLatencyMs`.
- Update `StreamingGuardrailEvaluator` to:
  - evaluate every chunk in `token` mode
  - force evaluation when `maxLatencyMs` elapses with unevaluated content

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/streaming-evaluator.test.ts`
  - token mode evaluates on every chunk
  - sentence mode falls back to max-latency-triggered evaluation
- `apps/runtime/src/services/execution/__tests__/session-policy.test.ts`
  - `toStreamingEvalConfig()` preserves token interval and max latency

Exit criteria:

- Stored streaming settings now map to observable runtime behavior.

### Slice 3: Session Policy Freshness

Problems fixed:

- Long-lived hot sessions can keep stale policy after CRUD/activate operations.

Changes:

- Add a guardrail policy epoch service with Redis-backed + local fallback storage.
- Store the resolved epoch on the session cache.
- Re-resolve session policy when the project epoch changes.
- Bump the epoch on create, update, activate, and delete routes.

Tests first:

- `apps/runtime/src/services/execution/__tests__/session-policy-cache.test.ts`
  - cached policy is reused when epoch is unchanged
  - cached policy is re-resolved when epoch advances
  - null sentinel is invalidated when epoch advances

Exit criteria:

- Policy activation/update affects subsequent turns in already-hot sessions without requiring an agent switch.

### Slice 4: Provider Override Runtime Parity

Problems fixed:

- `endpoint`, `defaultThreshold`, `costPerEvalUsd`, and `retry` are partially or fully ignored.
- Unsupported credential override fields can be stored even though runtime cannot use them.

Changes:

- Preserve executable provider override fields in the resolved `PipelinePolicy`.
- Add a runtime-overrideable provider contract for HTTP-backed providers.
- Support per-policy endpoint override and retry in provider dispatch.
- Use provider override default threshold and cost when executing Tier 2.
- Reject unsupported credential override fields on policy writes.

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`
  - resolved policy preserves executable provider override fields
- `packages/compiler/src/__tests__/guardrails/provider-registry.test.ts`
  - retry override retries provider evaluation
  - endpoint override dispatches to the overridden URL for HTTP-capable providers
- `packages/compiler/src/__tests__/guardrails/tier2-evaluator.test.ts`
  - default threshold override is honored
  - cost override is reflected in metrics
- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - unsupported provider credential overrides are rejected

Exit criteria:

- A stored provider override either changes execution or is rejected at write time.

### Slice 5: Operational Controls Runtime Parity

Problems fixed:

- Policy caching/budget/webhook controls are mostly dead config.

Changes:

- Extend resolved `PipelinePolicy` to carry caching, budget, and webhook settings.
- Wire `createGuardrailPipeline()` so policy config controls cache, cost checker budget, and webhook delivery ports.
- Support exact-match cache enable/disable and policy TTL override.
- Reject semantic caching until a semantic cache implementation exists.
- Validate webhook configuration as all-or-nothing (`url` + `secret`).

Tests first:

- `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`
  - resolved policy preserves caching/budget/webhook controls
- `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-ports.test.ts`
  - budget config skips higher tiers when exceeded
  - webhook config triggers delivery on warning result
  - caching disabled prevents cache calls
  - policy TTL override is used for exact-match cache entries
- `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`
  - semantic caching is rejected
  - incomplete webhook config is rejected

Exit criteria:

- Policy operational controls have direct runtime effects or fail closed at the write boundary.

## Verification Loop

For each slice:

1. Add or extend focused tests so the gap is locked first.
2. Implement the narrowest production change that makes those tests pass.
3. Run `pnpm build` for affected packages before focused tests.
4. Run focused test suites only for the slice.

Final verification:

1. `npx prettier --write <changed files>`
2. `pnpm --filter @agent-platform/studio build`
3. `pnpm --filter @agent-platform/runtime build`
4. `pnpm --filter @abl/compiler build`
5. Focused Studio, runtime, and compiler test suites for all touched slices

## Risks And Mitigations

- Policy epoch lookups could add hot-path overhead.
  - Mitigation: short-lived local read cache and Redis fallback.
- Runtime override support could accidentally broaden provider attack surface.
  - Mitigation: only HTTP-capable providers can accept endpoint overrides; URL validation remains enforced.
- Webhook wiring could accidentally block execution on delivery failure.
  - Mitigation: keep webhook delivery fire-and-forget and best-effort.
- Semantic caching is not ready.
  - Mitigation: reject it explicitly instead of silently downgrading.

## Deliverable

After these slices, the guardrail path becomes honest and refresh-safe:

- Studio authoring round-trips all supported lifecycle states.
- Project policy mutations refresh hot-session behavior.
- Stored streaming and operational controls map to observable runtime execution.
- Unsupported future fields are blocked instead of quietly disappearing between DB and runtime.
