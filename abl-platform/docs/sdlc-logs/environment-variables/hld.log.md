# SDLC Log: Environment Variables — HLD

**Date:** 2026-03-23 (updated from 2026-03-22)
**Phase:** HLD (Phase 3)
**Artifact:** `docs/specs/environment-variables.hld.md`

## Process

### Sources Read

1. `docs/features/environment-variables.md` — feature spec (Phase 1 output, updated 2026-03-23)
2. `docs/testing/environment-variables.md` — test spec (Phase 2 output, 14 E2E + 11 integration)
3. `docs/specs/environment-variables.hld.md` — previous HLD (2026-03-22)
4. `apps/runtime/src/services/execution/llm-wiring.ts:250-296` — EnvVarStore bug location
5. `apps/runtime/src/services/secrets-provider.ts:232-270` — cache sentinel bug location
6. `apps/runtime/src/routes/environment-variables.ts:115-130` — create route bug location

### Update Scope

Rewrote HLD from documenting-existing to designing-fixes-and-features. Scope:

- 4 bug fixes with specific code change designs
- 3 new endpoints (diff, export, import)
- Studio UI base tab
- 3 alternatives considered with recommendation

### Oracle Questions (self-resolved)

| #   | Question                                     | Classification | Resolution                                                         |
| --- | -------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| 1   | Architecture pattern for bug fixes           | DECIDED        | Modify in-place — surgical fixes, not refactoring                  |
| 2   | Base fallback location (EnvVarStore vs repo) | DECIDED        | EnvVarStore (llm-wiring.ts) — matches tool-test-service reference  |
| 3   | Namespace pagination fix approach            | DECIDED        | Aggregation pipeline in security-repo.ts when namespaceId provided |
| 4   | Diff endpoint: live vs snapshot              | ANSWERED       | Live variables — feature spec Q1                                   |
| 5   | Import reuse bulkUpsert                      | ANSWERED       | Yes — existing repo function                                       |
| 6   | New dependencies                             | ANSWERED       | None                                                               |
| 7   | Base fallback vs snapshot path conflict      | ANSWERED       | No conflict — snapshot already correct                             |
| 8   | Cache sentinel vs SecretsProvider interface  | ANSWERED       | No interface change — internal Map fix only                        |
| 9   | Breaking API changes                         | ANSWERED       | None — all additive                                                |
| 10  | Namespace pagination risk                    | DECIDED        | Aggregation correctness — INT-9 validates                          |
| 11  | Existing null-environment data               | INFERRED       | Unlikely but handled correctly by fix                              |
| 12  | Rollback strategy                            | DECIDED        | Revert individual changes — each fix is independent                |
| 13  | Feature flag for new endpoints               | DECIDED        | No — additive endpoints, YAGNI for flags                           |

### 12 Concerns Addressed

| #   | Concern            | Section | Key Decision                                                             |
| --- | ------------------ | ------- | ------------------------------------------------------------------------ |
| 1   | Tenant Isolation   | 4.1     | New endpoints inherit existing middleware chain                          |
| 2   | Data Access        | 4.2     | Aggregation pipeline for namespace pagination, existing repo for import  |
| 3   | API Contract       | 4.3     | Non-breaking: null env additive, new endpoints follow existing patterns  |
| 4   | Security Surface   | 4.4     | Export requires env_var:read, import validates all inputs                |
| 5   | Error Model        | 4.5     | Null vs undefined distinction, cache sentinel, aggregation errors        |
| 6   | Failure Modes      | 4.6     | Base fallback adds 1 query on miss (~25ms), acceptable                   |
| 7   | Idempotency        | 4.7     | Create idempotent by unique index, import idempotent with overwrite flag |
| 8   | Observability      | 4.8     | New log layers: envVarStore-base, cached-not-found                       |
| 9   | Performance Budget | 4.9     | All within test spec targets (<50ms cold, <1ms cached)                   |
| 10  | Migration Path     | 4.10    | No data migration — all backward-compatible                              |
| 11  | Rollback Plan      | 4.11    | Each fix independently revertable                                        |
| 12  | Test Strategy      | 4.12    | 14 E2E + 11 integration, real servers, no mocks                          |

## Audit Results

### Round 1

| #   | Severity | Finding                                            | Resolution                          |
| --- | -------- | -------------------------------------------------- | ----------------------------------- |
| F1  | MEDIUM   | Ciphertext vs decrypt contradiction in diff design | Fixed — removed incorrect statement |
| F2  | LOW      | Import loop vs bulk clarification                  | Already explained in text           |

### Round 2 (data model & API deep dive)

No findings. Aggregation pipeline, API contracts, cache sentinel all validated.

### Round 3 (cross-phase consistency)

All 11 FRs traceable. Test spec referenced. Non-goals respected. APPROVED.
