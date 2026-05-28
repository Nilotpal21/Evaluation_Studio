# Test Spec Log — Prompt Library

**Feature slug:** `prompt-library`
**Phase:** 2 (Test Spec)
**Started:** 2026-04-27
**Author:** prasanna@kore.com (driven by Claude Code SDLC pipeline)

---

## Inputs

- Feature spec: `docs/features/prompt-library.md` (committed at `5b79c84e9`)
- Existing testing placeholder: `docs/testing/prompt-library.md` (7 E2E + 10 INT scenario stubs, written during feature-spec phase)
- Phase-1 log: `docs/sdlc-logs/prompt-library/feature-spec.log.md`
- Deferred MEDIUM finding from feature-spec round 2: FR-10 reverse-reference endpoint needed dedicated test scenario for response shape

## Product oracle decisions (Phase 2 clarifying questions)

Oracle agent (separate spawn) was given 15 clarifying questions across Test Scope (5), E2E (5), Integration (5).

### Outcomes by classification

| Classification | Count | Notes                                                                |
| -------------- | ----- | -------------------------------------------------------------------- |
| ANSWERED       | 11    | Grounded in existing test infrastructure code — file/line cited      |
| DECIDED        | 4     | Oracle made judgment calls within established patterns; logged below |
| INFERRED       | 0     | All inferences confirmed by direct code evidence                     |
| AMBIGUOUS      | 0     | No escalations needed                                                |

### DECIDED items (oracle judgment calls)

1. **D-1 (Coverage depth)** — FR-3 (atomic promote) > FR-6 (compiler libraryRef) > FR-15 (missing-ref runtime error) > FR-5 (compare-mode partial failure) get 3+ scenario depth. Reason: FR-3 race can silently leave two active versions; FR-6 wrong resolve = wrong system prompt with no symptom; FR-15 silent failure mode; FR-5 partial failure is a distinct code path from success.
2. **D-2 (Auth combinations)** — JWT developer + tester + viewer sufficient for v1 E2E. Defer API-key / platform-key auth coverage. Reason: feature has no API-key surface, `requireProjectPermission` already battle-tested in other route tests.
3. **D-3 (FR-10 reverse-reference)** — Stays as INT scenario (INT-11), not promoted to E2E-8. Reason: query-response-shape testing doesn't need full HTTP E2E overhead; saves E2E bandwidth for higher-risk flows.
4. **D-4 (Studio proxy)** — Separate INT scenario (INT-12), not folded into runtime route E2E. Reason: distinct harness (Next.js Route Handler), distinct boundary (auth context forwarding, error envelope passthrough). Feature-spec subtask 4.7 explicitly calls this out.

### Key code references discovered (cited in test spec)

| Concern                                 | Reference                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime E2E harness                     | `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` (`startRuntimeServerHarness()`)                    |
| Auth + project + tenant model bootstrap | `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` (`bootstrapProject()`, `provisionTenantModel()`) |
| MongoMemoryServer setup                 | `apps/runtime/src/__tests__/helpers/setup-mongo.ts`                                                            |
| RBAC test context                       | `apps/runtime/src/__tests__/helpers/auth-context.ts` (`PROJECT_ROLE_PERMISSIONS`)                              |
| LLM DI (executor level)                 | `apps/runtime/src/__tests__/execution/pre-refactor/helpers/mock-llm-client.ts` (`injectMockClient()`)          |
| LLM DI (HTTP E2E level)                 | `provisionTenantModel()` with stub `endpointUrl` to local mock HTTP server                                     |
| Promote-pattern to mirror               | `apps/runtime/src/services/version-service.ts:618-631` (findOneAndUpdate + count guard)                        |
| Audit query pattern                     | `apps/runtime/src/__tests__/mongo-audit-store.test.ts:28-46`                                                   |
| `buildSystemPrompt()` in-process        | `apps/runtime/src/__tests__/profile-integration.test.ts:311-378`                                               |
| Studio Playwright auth                  | `apps/studio/e2e/helpers/auth.ts` (`loginViaDevApi`)                                                           |

## Files created / modified

### Modified

- `docs/testing/prompt-library.md` — replaced placeholder with full test spec (15 FR coverage matrix, 7 E2E + 12 INT scenarios with concrete steps, security & isolation, perf, infrastructure, test-file mapping)
- `docs/testing/README.md` — refreshed row 15a (`7 E2E + 12 INT`)
- `docs/features/prompt-library.md` — refreshed §17 reference table to reflect new INT-11 / INT-12

### Created

- `docs/sdlc-logs/prompt-library/test-spec.log.md` — this log

## Audit findings

### Round 1 — APPROVED with HIGH/MEDIUM fixes

- **TS-10/XP-4 (HIGH)** — Feature spec §10 Tests table had 8 stale entries. Test spec produced a granular 23-file split. FIXED — updated feature spec §10 to list all 23 test files with type + coverage columns.
- **TS-4/M2 (MEDIUM)** — INT-12 Setup used the word "Mock" which could imply `vi.mock`. FIXED — rephrased to "Inject a stub HTTP transport (via DI)".
- **TS-4/M1 (MEDIUM, no change)** — INT-9 uses `(executor as any)` pattern. Mirrors existing `profile-integration.test.ts:329`. No change needed.

### Round 2 — APPROVED, no blockers

- HIGH/CRITICAL: None.
- All R1 fixes verified correct.
- **XP-4 (MEDIUM)** — Feature spec §17 "Required Test Coverage" table rows 2/4/5/6/7/9 still referenced stale paths (`prompt-library.e2e.test.ts`, `library-ref-runtime.e2e.test.ts`). FIXED inline before commit — updated to canonical paths from §10.
- Cross-phase consistency: All 15 FRs traceable to test spec coverage matrix. Test file paths consistent across feature spec §10, feature spec §17, and test spec §10.

## Next phase

`/hld prompt-library` to generate the High-Level Design with 12 architectural concerns.

## Open items carried forward

- One performance concern still open from feature-spec: reverse-reference query latency when projects exceed ~1000 agents (GAP-003) — surfaced as performance test in §7
- Cost estimation in compare panes — deferred to v1.5; not in test spec
- Streaming responses in compare mode — deferred to v2; not in test spec
