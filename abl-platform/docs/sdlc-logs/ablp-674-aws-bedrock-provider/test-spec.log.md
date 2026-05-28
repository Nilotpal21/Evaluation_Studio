# Test Spec Log — AWS Bedrock Provider Integration (ABLP-674)

**Phase**: Test Spec
**Date**: 2026-04-28
**Artifact**: `docs/testing/sub-features/aws-bedrock-provider.md`
**Commit**: `40409757b`

---

## Oracle Decisions

| #   | Question                                                        | Classification | Decision                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | HTTP interception approach for Bedrock (aws4fetch uses fetch()) | DECIDED        | `nock@^14` patches global `fetch` — already used in `apps/search-ai` and `packages/agent-transfer`. Add to `apps/runtime` devDeps. Not `msw` (no precedent). Not `AWS_ENDPOINT_URL_BEDROCK` (not honored by aws4fetch).                                        |
| Q2  | Existing helpers for seeding LLM credentials with authConfig    | ANSWERED       | `provisionTenantModel()` exists in `channel-e2e-bootstrap.ts:710-747` but does NOT support `authConfig`. Integration tests: use `LLMCredential.create()` directly. E2E tests: extend `provisionTenantModel` (prerequisite P-3).                                |
| Q3  | Observability of SessionLLMClient provider cache                | ANSWERED       | `provider-cache.ts` exports `getCachedProvider`, `setCachedProvider`, `clearProviderCache`. Cache key construction is in `session-llm-client.ts:836-843`. INT-3/INT-4 resolved by extracting `buildProviderCacheKey()` as pure function (LLD Phase C subtask). |
| Q4  | Env var injection in harness                                    | ANSWERED       | `MANAGED_ENV_KEYS` list controls snapshot/restore. AWS vars NOT in list — prerequisite P-2 adds them. Harness supports `envOverrides` before server startup.                                                                                                   |
| Q5  | Env var injection before server startup                         | ANSWERED       | Yes, via `prepareRuntimeHarnessEnvironment(envOverrides)`. But nock approach is more reliable for Bedrock HTTP.                                                                                                                                                |
| Q6  | Playwright tests for AddConnectionDialog                        | ANSWERED       | No existing AddConnectionDialog tests. Playwright infra exists at `apps/studio/e2e/helpers/`. New file: `bedrock-connection-dialog.spec.ts`.                                                                                                                   |
| Q7  | SessionLLMClient DI constructor                                 | ANSWERED       | Yes — first param is `ModelResolutionService`. Can inject test resolution for cache key tests.                                                                                                                                                                 |
| Q8  | Pipeline model-resolver entry point                             | ANSWERED       | `resolvePipelineModel()` at `model-resolver.ts:33`. Bug at line 142 (4 args only). Integration test: call directly with seeded DB.                                                                                                                             |

## Scenarios Summary

| Type                    | Count | Files                                                    |
| ----------------------- | ----- | -------------------------------------------------------- |
| Automated E2E           | 6     | `apps/runtime/src/__tests__/bedrock-e2e.test.ts`         |
| Integration             | 6     | `apps/runtime/src/__tests__/bedrock-integration.test.ts` |
| Unit                    | 6     | `packages/llm/src/__tests__/provider-factory.test.ts`    |
| Studio E2E (Playwright) | 5     | `apps/studio/e2e/bedrock-connection-dialog.spec.ts`      |

## Audit Round 1 — NEEDS_REVISION

Findings fixed:

- CRITICAL: Section 7 split into E2E vs integration sub-lists; raw DB access (encrypted blob check) placed in integration-only
- CRITICAL: E2E-2 step 3 — replaced decrypted DB assertion with API response assertion
- HIGH: Coverage matrix FR-7 phantom E2E checkmark removed
- HIGH: File mapping: FR-3/FR-7 removed from bedrock-e2e.test.ts row
- HIGH: INT-2 replaced with real integration test (createVercelProvider → generateText → nock-intercepted Bedrock)
- HIGH: FR-4 split into FR-4a (tool calling, covered) and FR-4b (streaming, deferred with §11 Q2 justification)
- HIGH: INT-3/INT-4 rewritten to use `buildProviderCacheKey()` pure function (Open Q4 resolved as LLD action)
- MEDIUM: `initRuntimeTestDB()` → `setupTestMongo()` (correct helper)
- MEDIUM: Testing README count 5→6 planned
- MEDIUM: Section 7 bullet 5 rewritten as credential injection attack scenario

## Audit Round 2 — APPROVED

Remaining HIGH findings fixed:

- HIGH: E2E-1 stale FR label (FR-4 removed) → `FR-1, FR-5`
- HIGH: E2E-2 stale FR label (FR-4a removed) → `FR-2`
- HIGH: E2E-5 trace assertion now specifies HTTP endpoint `GET /api/projects/:projectId/sessions/:sessionId/traces`
- MEDIUM: PLY auth context note added ("Auth Context: tenant admin (shared fixture)") to PLY-2 through PLY-5

## Implementation Prerequisites for LLD

| #   | Gap                                                                              | Delivery Phase |
| --- | -------------------------------------------------------------------------------- | -------------- |
| P-1 | Add `nock@^14` to `apps/runtime` devDeps                                         | Phase A        |
| P-2 | Extend `MANAGED_ENV_KEYS` with AWS vars                                          | Phase A        |
| P-3 | Extend `provisionTenantModel` helper + provisioning route to accept `authConfig` | Phase A or D   |
| P-4 | Implement `case 'bedrock'` in `provider-factory.ts`                              | Phases A+B     |
| P-5 | Export `buildProviderCacheKey()` from `provider-cache.ts`; extend `authSuffix`   | Phase C        |
| P-6 | Fix `model-resolver.ts:142` authConfig passthrough                               | Phase D        |
| P-7 | Add Studio IAM role toggle                                                       | Phase E        |
