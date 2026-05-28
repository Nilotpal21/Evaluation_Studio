# Session Scope Enforcement - Test Spec Log

## 2026-04-15

### Task

Refresh the testing specification to reflect the clarified identity architecture and expand it to real E2E/integration coverage expectations.

### Decisions Captured

- **DECIDED**: E2E coverage must treat guest humans, verified humans, and customer-known voice callers as human `contact` subjects, not as separate session-subject categories.
- **DECIDED**: Test coverage must include both human `contact` sessions and non-human `service_principal` sessions.
- **DECIDED**: Verification flows should be tested as evidence-strength upgrades, not as subject-type changes.
- **DECIDED**: Migration coverage must distinguish backfillable human contact subjects from ambiguous rows that require quarantine or expiry.

### Key Test Additions

- Added at least five real-surface E2E scenarios, including guest, voice, verification-promotion, SDK resume, and migrated-legacy coverage.
- Added at least five integration scenarios, including Redis reverse lookup expiry, cold restore scoping, queue enqueue enforcement, ALS mirroring, migration classification, and service-principal separation.
- Added unit-test guidance for scope builders and migration classifiers.
- Added explicit security/isolation, infrastructure, and exit-criteria sections.

## 2026-04-15 (Client + Analytics Guidance Update)

### Task

Refresh the testing spec to capture the SDK identity deprecation guidance and the reporting/analytics assertions needed for canonical scope rollout.

### Decisions Captured

- **DECIDED**: Tests must assert that SDK `userContext.userId` does not become the authoritative human identity for production sessions.
- **DECIDED**: Reporting/admin/trace validation must distinguish canonical human `contact` sessions from `service_principal` sessions during and after migration.
- **DECIDED**: Analytics validation needs a canonical assertion surface for `subjectKind`, `actorKind`, and compatibility-path dimensions, not just raw trace payload inspection.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

## 2026-04-15 (Future-Ready Architecture Decisions Confirmed)

### Task

Align the test spec with the newly confirmed architecture decisions so testing guidance no longer treats settled assertion surfaces as open questions.

### Decisions Captured

- **DECIDED**: Canonical subject/actor/evidence assertions anchor on session-detail responses backed by the dedicated runtime diagnostics/read-model payload.
- **DECIDED**: Actor-owned auth-profile behavior should be asserted through both auth-preflight summaries and tool-auth resolution traces where available.
- **DECIDED**: Contact-backed human memory should be asserted through both contact-context APIs and REMEMBER/RECALL behavior during the compatibility window.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

### Open Testing Questions

1. Which public/admin diagnostics surface should become the canonical assertion point for `subject`, `actor`, and `identityEvidence` in E2E tests?
2. Do voice E2E tests run reliably enough in CI today, or should the first voice coverage land as high-fidelity integration tests and graduate to full E2E after harness hardening?
3. Which reporting or analytics validation surface should become the canonical assertion point for canonical `subjectKind`, `actorKind`, and compatibility-path dimensions during rollout?

## 2026-04-15 (Cross-Cutting + Studio Impact Review)

### Task

Expand the test spec so the newly reviewed impact areas and Studio surfaces have explicit coverage expectations.

### Decisions Captured

- **DECIDED**: Testing must cover retention/GDPR subject resolution and compatibility telemetry, not just session-create/session-resume paths.
- **DECIDED**: Shared-auth/session ownership tests must move from legacy identity-tier assumptions to canonical subject/actor assertions.
- **DECIDED**: Agent-transfer tests must assert that provider aliases never replace canonical `contactId` semantics.
- **DECIDED**: Eventstore/audit tests must verify privacy-safe canonical scope summaries, not just raw `actor_id` anonymization.
- **DECIDED**: Studio proxy, session detail, historical traces, debug chat, preview, and transfer-monitoring surfaces need explicit coverage so Studio stays aligned with runtime scope semantics.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

### Open Testing Questions

1. Which Studio response shape should become the canonical assertion point for `scopeSummary`, `migrationStatus`, and `compatibilityPathUsed`: session detail, traces, or a dedicated diagnostics payload?

## 2026-04-15 (Encryption + DEK Impact Review)

### Task

Expand the testing specification so encryption/DEK scope alignment becomes an explicit rollout target rather than an implicit implementation detail.

### Decisions Captured

- **DECIDED**: Tests must verify that project-scoped production session artifacts stop relying on tenant-scoped DEK convenience wrappers.
- **DECIDED**: Tests must preserve tenant-scoped contact identity crypto as an explicit exception rather than accidentally “fixing” it into project scope.
- **DECIDED**: Migration coverage must classify legacy tenant-scoped session ciphertext into re-encrypt, compatibility-tracked, or quarantine buckets.
- **DECIDED**: KMS audit validation should be part of rollout safety for encrypted session artifacts, not a separate ops concern.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

### Open Testing Questions

1. Which assertion surface should be treated as the source of truth for DEK scope rollout health: `kms_audit_log`, `dek_registry`, compatibility counters, or a combination?

## 2026-04-15 (Auth Profile + Model Resolution + Memory Impact Review)

### Task

Expand the test spec so auth-profile ownership, model-resolution contract preservation, and memory ownership semantics are first-class rollout targets.

### Decisions Captured

- **DECIDED**: Tests must assert that auth-profile resolution follows canonical actor/session-principal semantics and does not fall back to human subject identity or overloaded `userId`.
- **DECIDED**: Tests must protect the existing model-resolution contract: actor-scoped full resolve may vary with credential policy, but reasoning-settings caches must remain free of human-subject dimensions.
- **DECIDED**: Memory coverage must distinguish contact-backed human continuity from actor-owned/debug memory, project memory, and per-session working state.
- **DECIDED**: The `userId` ambiguity needs direct regression coverage because current runtime bootstrap and memory wiring still reuse customer/contact surrogates as the effective memory owner in some paths.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`

### Open Testing Questions

1. Which public/runtime assertion surface should be treated as the source of truth for actor-owned auth-profile behavior: tool-auth resolution traces, auth-preflight summaries, or both?
2. Should contact-backed human memory be asserted primarily through contact-context APIs, REMEMBER/RECALL behavior, or both during the compatibility window?

## 2026-04-15 (Pre-HLD Review Incorporation)

### Task

Update the test plan to reflect reviewer feedback before HLD, especially around missing debug/rollback coverage and test-file type clarity.

### Decisions Captured

- **DECIDED**: The test spec should distinguish `Current Type` from `Target Type` in the file-mapping table so current unit tests are not mislabeled as already-integrated coverage.
- **DECIDED**: Explicit E2E coverage is required for wrong-scope-kind rejection on debug/system discriminants.
- **DECIDED**: Explicit rollback coverage is required for `enforce` -> `warn`, both as integration coverage and as a production-readiness drill.
- **DECIDED**: Manual validation links should explicitly call out FR-15 and FR-16 so contact lifecycle and transfer/handoff are not left as implied coverage only.
- **DECIDED**: Security tests should assert the documented fail-closed response contract and map back to the feature threat model.

### Files Updated

- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/test-spec.log.md`
