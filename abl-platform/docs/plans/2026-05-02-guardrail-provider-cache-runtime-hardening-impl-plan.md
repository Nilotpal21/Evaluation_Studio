# ABLP-734 Guardrail Provider And Cache Runtime Hardening Plan

## Problem

ABLP-734 exposed an end-to-end contract drift across Studio, runtime storage, DSL evaluation, and runtime execution:

- Exact-match guardrail cache entries are scoped by tenant, project, guardrail name, and content only. Same-named guardrails in different agents can replay each other's Tier 2 outcomes, and DSL changes can keep stale outcomes alive until TTL or coarse tenant invalidation.
- Tenant provider defaults are persisted but not applied at runtime. `defaultCategory`, `defaultThreshold`, circuit breaker, retry, and cost semantics must affect Tier 2 evaluation without requiring every guardrail or policy to duplicate them.
- Studio writes a legacy resilience shape while the runtime DB schema expects canonical keys, making direct clients and future Studio paths easy to regress.
- The provider form keeps local state from the first `initial` prop and can submit stale provider values when the dialog instance is reused.
- Runtime cache typings still document a flat action/message/score payload even though the compiler now caches per-guard Tier 2 outcomes.

## Target Contract

- Cache identity is `tenantId + projectId + executionScope + tier + guardrailName + contentHash`.
- `executionScope` is the stable runtime identity for the compiled guardrail contract. Callers should pass agent/revision/config hash when available; the fallback is explicit `global`, never implicit key omission.
- Tier 2 cached payloads use `{ passed, outcome, violation?, cachedAt? }`. Legacy flat payloads remain readable only as compatibility input to the compiler replay path.
- Tenant provider records are runtime defaults. Registered providers carry runtime config metadata, and policy overrides can still override provider defaults at evaluation time.
- Provider resilience uses canonical schema keys everywhere new code writes data: `failureThreshold`, `resetTimeoutMs`, `maxRetries`, `backoffBaseMs`.
- Studio form state rehydrates whenever the dialog opens for a different provider or switches to create mode.

## Slice Plan

1. Cache scope and payload contract
   - Add tests proving same tenant/project/name/content does not collide across `scopeKey` or tier.
   - Update runtime cache key format and adapter options.
   - Propagate cache scope from runtime session call sites when available.

2. Provider defaults and resilience at execution
   - Add tests proving registered provider defaults set category, threshold, cost, circuit breaker, and retry unless a policy override wins.
   - Extend compiler provider registry entries with runtime config metadata.
   - Load DB provider defaults into registry registration in runtime factory.

3. Studio/runtime provider write contract
   - Add tests proving the Studio provider form emits canonical resilience shape and rehydrates on provider changes.
   - Keep Studio route and runtime route compatibility normalizers for legacy clients.
   - Update hook types to canonical runtime shape.

4. Verification
   - Format changed files with `npx prettier --write`.
   - Run package builds before targeted tests per repo policy.
   - Run focused runtime/compiler/studio guardrail tests and document any unrelated build blockers.

## Rollout Notes

- Existing cached entries naturally expire; no migration is required because the new key namespace simply misses old unscoped keys.
- Runtime route compatibility accepts the legacy Studio shape so older clients do not break during rollout.
- Provider policy overrides remain highest precedence, preserving current administrative override behavior.
