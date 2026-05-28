# Model Policy Portability and Cache Hardening Plan

**Status**: In Progress
**Date**: 2026-05-03
**Ticket**: ABLP-540

## Design

Project model policies must be portable across tenants. Source-tenant identifiers such as
`tenantModelId`, `credentialId`, and `authProfileId` are not portable and must never be replayed
directly into a destination tenant during import or Git pull.

The stable contract is:

- Export portable model identity (`provider`, `modelId`, `tier`, display/config metadata).
- Strip source-only bindings (`tenantModelId`, `credentialId`, `authProfileId`) from new exports.
- Accept legacy imports that still contain `tenantModelId`, but treat it as untrusted source metadata.
- During apply, resolve a destination `TenantModel` by active destination-tenant model identity.
- For voice-tier project models, require a destination model with `realtime_voice` capability.
- If no destination model matches, fail apply with a clear model-binding error.
- If multiple destination models match, fail apply and require explicit remapping.
- Runtime must fail closed if a persisted non-null `tenantModelId` cannot resolve.
- Every model-policy mutation path must invalidate runtime model-resolution caches.

## Implementation Slices

### Slice 1: Git Pull Cache Invalidation

Test lock:

- `apps/studio/src/__tests__/api-routes/api-git-pull-route.test.ts` asserts runtime invalidation when a Git pull applies model-policy mutations.

Implementation:

- Call `notifyRuntimeModelConfigChanged` after successful Git pull apply when `modelPoliciesUpserted` or `modelPoliciesDeleted` is non-zero.

### Slice 2: Cross-Tenant Project Model Binding

Test lock:

- Studio import adapter resolves destination tenant model IDs and does not persist source `tenantModelId`.
- Project export omits source-only project model binding IDs.

Implementation:

- Extend project-model policy sanitization to strip `tenantModelId`.
- Resolve destination tenant model by `tenantId + provider + modelId + active/inferenceEnabled`.
- For `tier: "voice"`, require `realtime_voice` capability.
- Fail ambiguous or missing bindings during apply with deterministic messages.

### Slice 3: Runtime Fail-Closed Binding

Test lock:

- Runtime resolution throws when a project model config has a non-null `tenantModelId` that cannot resolve.
- Existing bare model configs with `tenantModelId: null` continue to work.

Implementation:

- Treat unresolved explicit tenant-model bindings as configuration errors instead of falling back to bare model/provider credentials.

## Verification

- Build before tests, per repo rule.
- Scoped builds: `pnpm --filter @agent-platform/project-io build`, `pnpm --filter @agent-platform/studio build`, `pnpm --filter @agent-platform/runtime build`.
- Scoped tests:
  - Studio Git pull route test.
  - Studio project import support test.
  - Project-io core assembler/direct apply tests.
  - Runtime model-resolution comprehensive test.
