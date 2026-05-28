# ABLP-734 Guardrail Studio DB DSL Runtime Contract Hardening Plan

**Status**: IN PROGRESS
**Date**: 2026-05-03
**Scope**: Studio provider/policy UX, Studio proxy routes, runtime CRUD routes, DB guardrail schemas, compiler guardrail provider adapters, runtime provider loading, Tier 2 execution.

## 1. Problem

ABLP-734 uncovered several end-to-end contract gaps in the guardrail path:

- Studio can collect raw provider API keys, but runtime does not persist or resolve that field. The request appears accepted while the secret is silently dropped.
- Runtime registers `openai_moderation` through the generic custom HTTP adapter, which turns `results.0.flagged` into `0` or `1` and ignores category scores and the stored model.
- Provider-level `circuitBreaker.failMode` is persisted, but provider registry evaluation still only uses policy-level fail mode.
- Policy provider overrides support runtime defaults in compiler contracts, but `defaultCategory` does not round-trip through DB, routes, resolver, and pipeline policy mapping.
- The provider test endpoint reports `reachable` without executing the same provider adapter path used by runtime evaluation.
- Policy credential override fields exist in some contracts but are intentionally rejected by runtime, creating a misleading future-use surface unless the types say so clearly.

Earlier ABLP-734 fixes already covered cache scope, cache payload typing, provider default threshold/category/retry/circuit-breaker loading, Studio resilience shape normalization, and dialog state rehydration. This plan continues from that baseline.

## 2. Design Decisions

| #   | Decision                                                                                                                  | Rationale                                                                                                              | Alternatives Rejected                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| D-1 | Reject raw `apiKey` on provider create/update until secure credential creation is wired.                                  | Avoid silent secret loss and avoid persisting secrets in the provider config document.                                 | Persist `apiKey` directly; silently drop field.            |
| D-2 | Runtime `openai_moderation` must instantiate `OpenAIModerationProvider`, not `CustomHTTPProvider`.                        | Reuses the compiler adapter that understands category scores and labels.                                               | Keep generic HTTP mapping with `flagged` boolean score.    |
| D-3 | OpenAI moderation model is optional runtime adapter metadata and must be sent when configured.                            | Studio/DB already collect `model`; runtime should not ignore it.                                                       | Remove model from Studio/DB for moderation providers.      |
| D-4 | Provider fail mode is provider-runtime metadata and policy fail mode remains the pipeline-wide fallback.                  | Provider config controls adapter failure semantics; policy can still control missing-provider and tier-level fallback. | Collapse provider fail mode into policy only.              |
| D-5 | `defaultCategory` is a first-class policy provider override field across DB, route, resolver, compiler, and Studio types. | It already exists in compiler policy contracts and Tier 2 evaluation; persistence must match.                          | Force every guardrail to repeat category.                  |
| D-6 | Provider test executes a real provider evaluation with sanitized response data.                                           | Admin testing should prove the same adapter/credentials/mapping that runtime execution uses.                           | Keep a config-only `reachable` response.                   |
| D-7 | Policy credential overrides stay rejected and are marked reserved in UI-facing types.                                     | Prevents users and API clients from assuming a runtime path exists.                                                    | Wire credential overrides now without auth-profile design. |

## 3. Slice Plan

### Slice 1: Raw Provider API Key Contract

**Goal**: A raw API key can no longer be submitted and silently dropped.

**Test lock**:

- Studio provider form does not include `apiKey` in submitted payloads.
- Studio provider proxy rejects raw `apiKey` before forwarding.
- Runtime provider route rejects raw `apiKey` on create/update.

**Implementation**:

- Remove the raw API key field from the provider form submit path.
- Add a boundary validation helper in Studio proxy and runtime route.
- Keep `authProfileId` as the supported credential path.

**Exit criteria**:

- Focused Studio form/proxy tests fail before code and pass after.
- Runtime provider route E2E tests fail before code and pass after.

### Slice 2: OpenAI Moderation Runtime Adapter

**Goal**: Runtime provider loading uses the real OpenAI moderation adapter, including category score semantics and configured model.

**Test lock**:

- Compiler OpenAI moderation provider sends `model` when configured and returns category-specific scores.
- Runtime provider loader registers `openai_moderation` as `OpenAIModerationProvider`.

**Implementation**:

- Extend `OpenAIModerationProviderConfig` with optional `model`.
- Pass model in request body when present.
- Use `OpenAIModerationProvider` in runtime `ensureTenantProvidersLoaded`.

**Exit criteria**:

- OpenAI moderation provider tests pass.
- Runtime factory tests prove `openai_moderation` no longer relies on `CustomHTTPProvider` boolean score mapping.

### Slice 3: Provider Fail Mode Propagation

**Goal**: `circuitBreaker.failMode` stored on a provider affects provider-level failures.

**Test lock**:

- Registered provider runtime config stores `failMode`.
- Failing provider registered with provider fail mode `closed` returns critical fallback even without policy fail mode.
- Runtime DB loader carries `circuitBreaker.failMode` into registry runtime config.

**Implementation**:

- Add `failMode` to provider runtime config circuit breaker metadata.
- Merge provider runtime fail mode with policy options in registry evaluation.
- Forward DB `circuitBreaker.failMode` in runtime factory.

**Exit criteria**:

- Compiler registry tests pass.
- Runtime factory tests pass.

### Slice 4: Policy Override Default Category Round-Trip

**Goal**: Policy provider override `defaultCategory` survives Studio -> runtime route -> DB -> resolver -> pipeline policy -> Tier 2 execution.

**Test lock**:

- Runtime policy route create/get preserves `providerOverrides[].defaultCategory`.
- Pipeline policy resolver maps DB override `defaultCategory`.
- Existing Tier 2 override test proves policy override category wins over provider defaults.
- Studio types and form preservation tests include `defaultCategory`.

**Implementation**:

- Add `defaultCategory` to database policy override interface/schema.
- Add it to Studio hook types.
- Include it in route sanitization/response normalization.
- Include it in policy resolver types and mappings.

**Exit criteria**:

- Runtime policy route and resolver tests pass.
- Studio policy form preservation test passes.

### Slice 5: Provider Test Endpoint Executes Runtime Path

**Goal**: `POST /guardrail-providers/:id/test` evaluates the configured adapter instead of returning a fake reachability status.

**Test lock**:

- Custom HTTP provider test endpoint calls a real local HTTP service and returns score/category/latency.
- Missing inactive provider or adapter failure returns sanitized `unhealthy`/`failed` response without raw secret or tenant leakage.

**Implementation**:

- Extract provider instantiation helper in runtime factory for DB provider records.
- Reuse it from tenant provider loading and provider test route.
- Resolve auth profiles for OpenAI moderation when configured.
- Return sanitized diagnostic payload only.

**Exit criteria**:

- Runtime provider route E2E test exercises real HTTP provider adapter with no mocks of codebase components.
- Existing CRUD tests continue to pass.

### Slice 6: Contract Cleanup And Verification

**Goal**: Contract comments, types, and verification reflect the implemented runtime behavior.

**Test lock**:

- Policy credential override tests continue rejecting `apiKeyCredentialId` and `authProfileId`.
- Studio type comments mark fields as reserved, not supported.

**Implementation**:

- Update comments/types to prevent UI/API consumers from treating policy credential overrides as live.
- Run prettier, package builds, and focused tests.

**Exit criteria**:

- `npx prettier --write` on all changed files.
- `pnpm --filter @abl/compiler build`.
- `pnpm --filter @agent-platform/runtime build`.
- `pnpm --filter @agent-platform/studio typecheck`.
- Focused compiler/runtime/studio guardrail tests pass.

## 4. Data Flow Matrix

| Field / Contract                   | Studio Form   | Studio Proxy            | Runtime Route | DB Schema         | Runtime Loader / Resolver      | Compiler Runtime          |
| ---------------------------------- | ------------- | ----------------------- | ------------- | ----------------- | ------------------------------ | ------------------------- |
| Raw provider `apiKey`              | Reject / omit | Reject                  | Reject        | N/A               | N/A                            | N/A                       |
| Provider `authProfileId`           | Supported     | Pass-through            | Persist       | `authProfileId`   | Resolve for provider load/test | Adapter API key           |
| OpenAI `model`                     | Submit        | Pass-through            | Persist       | `model`           | Adapter config                 | Request body              |
| Provider `circuitBreaker.failMode` | Preserve      | Pass-through            | Persist       | `failMode`        | Runtime config                 | Provider failure fallback |
| Policy override `defaultCategory`  | Preserve      | Pass-through            | Persist       | `defaultCategory` | Pipeline policy                | Tier 2 request category   |
| Policy credential overrides        | Reserved only | Pass-through if present | Reject        | Reserved          | Not consumed                   | Not consumed              |

## 5. Rollout And Rollback

- Raw key rejection is a fail-fast compatibility tightening. Existing auth-profile-backed providers are unaffected.
- OpenAI moderation switches to the dedicated adapter; if issues appear, rollback is localized to runtime provider instantiation.
- `defaultCategory` is additive in MongoDB and optional across contracts, so no migration is required.
- Provider test endpoint behavior changes from config-only to real evaluation. Admin callers should expect sanitized failure statuses when endpoints or credentials are invalid.

## 6. Acceptance Criteria

- All listed slices have tests that would fail against the pre-fix behavior.
- Provider and policy fields no longer disappear silently at layer boundaries.
- Runtime execution semantics match Studio-visible configuration.
- No direct secret persistence is introduced.
- Focused builds/tests pass, or blockers are documented with exact command output.
