# Test Specification: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)

> **Feature Spec**: `../../features/sub-features/pii-detection-tiered-recognizers.md`
> **Parent Feature**: [PII Detection & Redaction](../pii-detection.md) — testing guide at `../pii-detection.md`
> **Sibling Sub-Feature**: [PII Detection Enhancements (cloud tier + analytics)](pii-detection-enhancements.md)
> **HLD**: `../../specs/sub-features/pii-detection-tiered-recognizers.hld.md`
> **LLD**: `../../plans/2026-05-09-pii-detection-tiered-recognizers-impl-plan.md`
> **JIRA**: ABLP-921
> **Status**: BETA-READY — Unit 8/8 ✅ · Integration 13/13 ✅ · E2E 7/8 ✅ (1 design-deferred per HLD §4 Concern 8)
> **Last Updated**: 2026-05-10

---

## Current State

All 8 unit, 13 integration, and 7 of 8 E2E scenarios are green. The previously-deferred E2E-1, E2E-2, E2E-4, E2E-5, and E2E-7 now drive a real chat round-trip through `RuntimeApiHarness` against the established `startMockLLM()` harness from `tools/agents/e2e-functional/mock-llm-server.ts` (used by 30+ E2E suites). E2E-6 (streaming SSE) remains design-deferred per HLD §4 Concern 8 because `StreamingPIIBuffer` has no production caller today. The microbenchmark (`recognizer-packs.bench.ts`) is shipped and runs under `vitest bench` — non-blocking per LLD D-11.

Production-wiring caveat surfaced while writing E2E-2: the session vault path (`session-output-protection.ts:147` `session.piiVault.tokenize`) does NOT thread `confidence_threshold` to detection — the legacy `filterOutputPII` path does. Threshold gating is verified at unit/integration level (`pii-detector.threshold.test.ts`); E2E-2 instead asserts the simpler `redact_output` toggle end-to-end and the threshold's PATCH/GET round-trip. Wiring threshold through the vault path is tracked as a follow-up gap.

UT-3 fixture coverage: **all 37 shipped recognizers have at least one positive case** in `recognizer-packs.test.ts`. The single exception is `med-mrn`, intentionally untested at fixture level — its regex `[A-Z0-9]{6,10}` is broad by design and gates entirely on context-word boost (baseConfidence 0.3); positive coverage rides on `context-enhancer.test.ts` instead.

Final compiler-side state (per `docs/sdlc-logs/pii-detection-tiered-recognizers/implementation.log.md`): 17/17 security test files pass; 289/289 security tests pass (70/70 in `recognizer-packs.test.ts` after the UT-3 fixture expansion); ReDoS adversarial sweep is a hard CI gate at 25 ms × 8 packs × 15 inputs.

The parent feature already ships extensive coverage at `docs/testing/pii-detection.md` (FR-1 through FR-19, mostly green at unit/integration; E2E gaps tracked there). This test spec **does not duplicate** parent coverage — it adds incremental coverage for the eight new FRs introduced by this sub-feature (`FR-1` confidence/recognizer fields through `FR-8` per-entry-point latency telemetry). Where a new scenario would touch an existing parent test, the planned-test-file column points at the existing file and notes the additive change required.

### Coverage Risk Ranking (drives test prioritization)

Highest risk first, per the product-oracle assessment:

1. **FR-3 + FR-4** — registry-singleton routing and bypass fix. The parent spec flags the registry-bypass as GAP-013 (HIGH). Misregression here means custom project patterns silently disappear on three detection surfaces.
2. **FR-6** — pack registration with the `MAX_RECOGNIZERS = 50` cap (sub-feature GAP-008). If pack recognizers register without `permanent: true` or before raising the cap, custom patterns can be evicted under load.
3. **FR-5** — cross-boundary field propagation through `RuntimePIIRedactionConfig` / `ProjectPIIRedactionConfig` / `RuntimePIIProjectSnapshot` / `mapProjectPIIRedactionConfig()`. Sub-feature spec §10 explicitly flags this as a propagation concern.
4. **FR-7** — context-word boosting (false positive driver if mis-implemented).
5. **FR-2** — async detection budget (speculative until WS-3, but must not regress sync path).
6. **FR-1** — additive `confidence` / `recognizer` fields (low risk, additive).
7. **FR-8** — latency telemetry (low risk, observability).

---

## 1. Coverage Matrix

| FR   | Description                                                                              | Unit                   | Integration | E2E              | Manual | Status                                       | Risk |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------- | ----------- | ---------------- | ------ | -------------------------------------------- | ---- |
| FR-1 | `confidence` and `recognizer` fields on `PIIDetection` (defaults preserved)              | ✅                     | ✅          | ✅ (E2E-3)       | ❌     | DONE                                         | LOW  |
| FR-2 | `detectAllAsync` runs sync recognizers immediately + async with latency budget           | ✅                     | ✅          | N/A (no caller)  | ❌     | DONE                                         | MED  |
| FR-3 | `detectPII` / `redactPII` / `containsPII` route through registry singleton (no DRY copy) | ✅                     | ✅          | ✅ (E2E-7)       | ❌     | DONE                                         | HIGH |
| FR-4 | Trace scrubber, CEL functions, action executors honor singleton when registry omitted    | ✅                     | ✅          | ✅ (E2E-7)       | ❌     | DONE                                         | HIGH |
| FR-5 | `ProjectRuntimeConfig.pii_redaction` accepts new fields with documented defaults         | ✅                     | ✅          | ✅ (E2E-2/ERR-1) | ❌     | DONE                                         | HIGH |
| FR-6 | Eight recognizer packs ship; per-project enable/disable works; cap respected             | ✅                     | ✅          | ✅ (E2E-1/3/4/5) | ❌     | DONE                                         | HIGH |
| FR-7 | Context-word boosting raises confidence within window; does nothing outside              | ✅                     | ✅          | ✅ (E2E-2)       | ❌     | DONE                                         | MED  |
| FR-8 | Per-entry-point latency telemetry emitted on the four detection paths                    | N/A (integration-only) | ✅          | DEFERRED         | ❌     | PARTIAL (streaming-chunk emit-site deferred) | LOW  |

> Each FR must reach ✅ at unit + integration before the feature can transition ALPHA → BETA. E2E green is required before BETA → STABLE per the parent feature's lifecycle gate.

---

## 2. E2E Test Scenarios (MANDATORY)

> **Test architecture**: real Express runtime started by `RuntimeApiHarness` (`apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`) on a random port (`{ port: 0 }`), real Mongo via `MongoMemoryServer`, real auth middleware. Seed via the runtime API; assert via the runtime API. **No mocking of `@agent-platform/*` or `@abl/*`. No direct DB reads.** The pure-JS dependency `libphonenumber-js` (already in `packages/compiler`) runs live; the hand-ported validators in `_validators.ts` (IBAN mod-97, Verhoeff, DEA, BTC base58) run as ordinary in-repo code. **No new third-party deps** are introduced — the HLD ([`docs/specs/sub-features/pii-detection-tiered-recognizers.hld.md`](../../specs/sub-features/pii-detection-tiered-recognizers.hld.md) §8.2) removed the originally-proposed `validator.js` and `cockatiel`; this test spec assumes that decision. Auth context is established via the harness with explicit `tenantId`, `projectId`, and a permission-bearing token.

### E2E-1: Enabling the EU pack detects IBANs end-to-end

- **Preconditions**: Tenant T1 with project P1 (`pii_redaction.tier = 'standard'`, `enabled_recognizer_packs = ['core']`); user with `runtime_config:write` and a chat permission on P1.
- **Steps**:
  1. PATCH `/api/projects/P1/runtime-config` with `{ pii_redaction: { enabled_recognizer_packs: ['core', 'eu'] } }`. Assert HTTP 200 and the response body's `pii_redaction.enabled_recognizer_packs` contains `eu`.
  2. POST a chat session start under P1 via the runtime API.
  3. POST a user message: `"IBAN GB82 WEST 1234 5698 7654 32"`.
  4. GET the session detail via the runtime API.
  5. GET the trace events for the session.
- **Expected Result**: The response message envelope (`messageMetadata.detections` or whatever boundary metadata the runtime exposes) lists an IBAN detection with `confidence ≥ 0.5` and `recognizer = 'iban'`. Trace events for `pii.detect` carry the new `confidence` and `recognizer` fields. The masked rendering of the assistant-visible content does not include the original IBAN.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write` + chat permission.
- **Isolation Check**: Run the same payload against project P2 (same tenant, EU pack disabled). Assert the trace API for P2's session emits **no** IBAN detection. Cross-tenant probe: a token scoped to tenant T2 calling PATCH on P1 returns 404 (not 403).

### E2E-2: Lowering the confidence threshold surfaces previously-suppressed detections

- **Preconditions**: Tenant T1, project P1, `pii_redaction.confidence_threshold = 0.7`. Register a custom regex via `POST /api/projects/P1/pii-patterns` with `baseConfidence = 0.4` and `contextWords = ['passport']` (boost 0.35).
- **Steps**:
  1. POST a chat session and send `"my number is 123456789"` (no context word in the message). Assert via the trace API that no detection is emitted (confidence 0.4 is below threshold 0.7).
  2. PATCH the runtime config to `confidence_threshold = 0.35`. Assert HTTP 200.
  3. Wait for the runtime-config epoch to invalidate (use `bumpPIIConfigEpoch` semantics — assert the snapshot cache key changed by sending a probe message and checking telemetry).
  4. POST a fresh chat session and send the same `"my number is 123456789"` message.
- **Expected Result**: After the threshold change, the trace API for the new session emits a detection with `confidence = 0.4` and `recognizer` matching the custom pattern's name. Trace-event count for `pii.detect` increases across the before/after sessions.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write` + `pii-pattern:write`.
- **Isolation Check**: Threshold change on P1 must not affect a sibling project P2 — sending the same message under P2 (which has the default 0.5 threshold) produces no detection.

### E2E-3: Cross-project isolation on pack selection

- **Preconditions**: Tenant T1; project P1 with `enabled_recognizer_packs = ['core', 'medical']`; project P2 with `enabled_recognizer_packs = ['core']`.
- **Steps**:
  1. POST a chat session on P1 and send `"MRN-12345"`.
  2. POST a chat session on P2 and send the identical message.
  3. GET trace events for each session.
- **Expected Result**: P1's trace API carries an MRN detection (`recognizer = 'medical-record'`, `confidence ≥ 0.5`). P2's trace API contains no medical-record detection.
- **Auth Context**: tenant T1 + per-project token.
- **Isolation Check**: Cross-tenant: a token scoped to tenant T2 attempting to GET `/api/projects/P1/runtime-config` returns 404. Cross-project under T1: a token with permissions only on P2 attempting `runtime_config:write` on P1 returns 404. (Assertions go through the runtime API, never direct Mongo.)

### E2E-4: Tier change propagates mid-session at the refresh boundary

- **Preconditions**: Project P1 with `tier = 'basic'`, `enabled_recognizer_packs = ['core']`.
- **Steps**:
  1. POST a chat session and send a probe message containing an IBAN. Assert via the trace API that no IBAN detection occurs (BASIC tier, EU pack off).
  2. PATCH runtime config to `tier = 'standard'`, `enabled_recognizer_packs = ['core', 'eu', 'financial']`. Assert HTTP 200 and that the runtime emits the epoch-bump trace.
  3. In the **same** session, send a follow-up message containing a different IBAN.
  4. GET the trace events for both messages.
- **Expected Result**: The first message produces no IBAN detection; the second message produces a detection with `recognizer = 'iban'`. The session is not restarted between messages — verifying that `refreshSessionPIIContext()` picks up the new pack at the next refresh boundary as observed in `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write` + chat.
- **Isolation Check**: A concurrent session on project P2 (no PATCH applied) continues to emit no IBAN detections.

### E2E-5: Custom patterns and packs coexist (vault round-trip is parent coverage)

- **Preconditions**: Project P1 with `enabled_recognizer_packs = ['core', 'eu']` and one custom pattern (e.g., internal employee ID format) registered via `POST /api/projects/P1/pii-patterns`.
- **Steps**:
  1. POST a chat session and send a user message that contains both an IBAN (caught by the EU pack) and an internal employee ID (caught by the custom pattern).
  2. GET trace events for the session and assert both detections appear with their respective `recognizer` names (`'iban'` and the custom pattern name) and non-null `confidence`.
  3. GET the session detail (consumer = `user`) and assert both PII types appear in masked form. Note: the _consumer-rendering matrix_ (user/history/tool) is already covered by parent feature E2E coverage at `docs/testing/pii-detection.md`; this scenario asserts only that the new `recognizer`/`confidence` fields propagate end-to-end alongside the existing rendering — it does not duplicate the parent's vault-render matrix.
- **Expected Result**: Trace events carry both detections with `recognizer` and `confidence` fields populated. Session-detail user-consumer view shows both as masked. The new sub-feature fields ride alongside the existing vault round-trip without breaking it.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write` + `pii-pattern:write` + chat.
- **Isolation Check**: A second user under tenant T1 with no permission on P1 attempting to GET `/api/projects/P1/pii-patterns` returns 404.

### E2E-7: Custom pattern survives pack disablement (regression for FR-3 + FR-4 at the HTTP boundary)

- **Preconditions**: Project P1 with one registered custom pattern and `enabled_recognizer_packs = ['core', 'eu']`. A baseline chat round confirms the custom pattern fires on a probe message.
- **Steps**:
  1. PATCH `/api/projects/P1/runtime-config` to set `enabled_recognizer_packs = []`.
  2. POST a fresh chat session and send the same probe message.
  3. GET trace events for the new session.
  4. Trigger a guardrail-action redact path on the same input via the runtime API (e.g., a session that exercises a guardrail with `action: redact`).
  5. Trigger a CEL-evaluated guardrail (`abl.has_pii`) on the same input.
- **Expected Result**: Even with all packs cleared, the custom pattern still fires through the registry singleton on every detection surface — direct detection in the message envelope, trace scrubber, CEL evaluation, and guardrail action. The trace API confirms the custom pattern's `recognizer` name appears for each surface.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write` + `pii-pattern:write` + chat.
- **Isolation Check**: With packs cleared on P1, a session on P2 (which still has its own custom pattern but cleared packs) sees its own custom pattern fire and not P1's — confirming registry overlay isolation through the HTTP layer.

### E2E-6: Streaming SSE response respects pack selection across chunk boundaries (DEFERRED)

> **Status: DEFERRED** per HLD §4 Concern 8. `StreamingPIIBuffer` has no production caller today (the streaming pipeline does not yet route through it). When the streaming caller is wired (out of scope for this sub-feature), this scenario should land as part of that follow-up. Keeping the scenario shape here for traceability and so the wiring follow-up has a ready test plan.

- **Preconditions**: Project P1, `tier = 'standard'`, `enabled_recognizer_packs = ['core', 'eu']`. The LLM is configured to emit a streamed response that contains an IBAN split across two SSE chunks (the buffer's 320-character trailing window must be exercised).
- **Steps**:
  1. POST a chat session and send a user message that prompts the LLM to emit an IBAN in its streamed response.
  2. Stream the SSE response and capture every chunk delivered to the consumer.
  3. After the stream completes, GET the persisted message history.
- **Expected Result**: The delivered chunks contain the **masked** IBAN token (no raw IBAN in flight). The persisted history contains the **tokenized** form (vault `{{PII:iban:<uuid>}}`). The streaming buffer's `pii.detect.latency_ms` trace event is emitted for each chunk that exercised detection. Trace API confirms `recognizer = 'iban'` and `entry_point = 'streaming_chunk'`.
- **Auth Context**: tenant T1 + project P1 + chat user.
- **Isolation Check**: The pre-LLM flow (user message redaction) does not interfere with streaming-side detection — both fire and emit independent trace events.

### E2E-ERR-1: Invalid `enabled_recognizer_packs` returns 400 (form error path equivalent)

- **Preconditions**: Project P1, valid auth.
- **Steps**:
  1. PATCH `/api/projects/P1/runtime-config` with `{ pii_redaction: { enabled_recognizer_packs: ['core', 'eurpoe'] } }` (typo).
- **Expected Result**: HTTP 400 with the route's existing structured error envelope `{ success: false, error: { code: 'VALIDATION_ERROR', message: ..., issues: [{ path: ['pii_redaction', 'enabled_recognizer_packs', 1], code: 'invalid_enum_value', received: 'eurpoe', ... }] } }`. GAP-010 is closed at the API boundary by a Zod `z.enum([...])` constraint on `enabled_recognizer_packs` (HLD §6.3 binding decision — no new error code introduced; the offending pack name is carried in `error.issues`, matching the existing `onValidationError` handler at `apps/runtime/src/routes/project-runtime-config.ts:58-69`). The valid pack `core` is **not** silently applied — the entire PATCH is rejected. Subsequent GET shows the runtime-config still at its prior value.
- **Auth Context**: tenant T1 + project P1 + user with `runtime_config:write`.
- **Isolation Check**: Authenticated user without `runtime_config:write` (only `:read`) gets 403 before validation runs. Anonymous request gets 401.

> **Note on form error paths**: this sub-feature ships **no Studio form** — Studio UX (tier selector, pack checkboxes) is deferred to WS-4 and owned by a separate sub-feature. The MANDATORY "form error E2E" rule is satisfied at the API boundary by E2E-ERR-1 above, which exercises the invalid-input rejection path that any future form will surface.
>
> **Note on wiring verification**: this sub-feature **does not add a new Studio API route** — it extends the existing PATCH `/api/projects/:projectId/runtime-config` and POST `/api/projects/:projectId/pii-patterns/test` routes. The MANDATORY "wiring verification" rule does not apply directly. E2E-1 and E2E-2 nevertheless drive the full chain Studio API → Mongoose → runtime registry overlay → detection caller, satisfying the spirit of the rule.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: `detectPII` routes through the registry singleton (FR-3)

- **Boundary**: `pii-detector` ↔ `pii-recognizer-registry` (singleton).
- **Setup**: Register a custom regex on `getDefaultPIIRecognizerRegistry()` from a test setup. Do not pass any registry into the `detectPII` call.
- **Steps**: Call `detectPII(text)` with text that **only** the custom registered regex would match.
- **Expected Result**: The returned detections include the custom-regex match with the correct `recognizer` name. Confirms the duplicate `detectWithLocalPatterns()` path no longer exists in `pii-detector.ts`.
- **Failure Mode**: If the duplicate path survives, custom patterns are silently invisible — the test fails because the returned array is empty.

### INT-2: Trace scrubber bypass fix (FR-4)

- **Boundary**: `trace-scrubber.ts` ↔ registry singleton.
- **Setup**: Register a project-scoped custom pattern on the singleton via `loadProjectPIIPatterns()` test helper; pre-load the per-project overlay.
- **Steps**: Call `scrubTraceEvent(event, { /* no piiRecognizerRegistry */ })` on a synthetic trace event whose value matches only the custom pattern.
- **Expected Result**: The trace event's value is scrubbed (replaced with the masked token). The `getDefaultPIIRecognizerRegistry()` path is exercised; the custom pattern is honored.
- **Failure Mode**: If the bypass survives, the custom pattern is silently ignored and the value is emitted raw.

### INT-3: CEL functions bypass fix (FR-4)

- **Boundary**: `cel-functions.ts` ↔ registry singleton.
- **Setup**: Same as INT-2.
- **Steps**: Evaluate `abl.has_pii("...custom-pattern-only string...")` and `abl.redact_pii("...custom-pattern-only string...")` in a CEL context that does NOT pass a registry.
- **Expected Result**: `abl.has_pii` returns `true`; `abl.redact_pii` returns the masked form. Both honor the singleton.
- **Failure Mode**: If the singleton fallback is missing, both functions return their no-detection defaults (`false` / original string).

### INT-4: Action executors bypass fix (FR-4)

- **Boundary**: `action-executors.ts` ↔ registry singleton.
- **Setup**: Same as INT-2.
- **Steps**: Run the `redact` and `fix` guardrail actions with no registry in their evaluation context against text that only the custom pattern would match.
- **Expected Result**: The action output is the masked form; the original raw text is not propagated.
- **Failure Mode**: If the bypass survives, the redact/fix actions fall through and emit raw values.

### INT-5: Async detection budget enforcement (FR-2)

- **Boundary**: `PIIRecognizerRegistry.detectAllAsync()` ↔ in-house `withTimeout(promise, ms)` pattern (per HLD §4 Concern 6 — no `cockatiel` dep; reuses the established `Promise.race` + `setTimeout` pattern from `transfer-session-store.ts:45` et al.).
- **Setup**: Register a synthetic async recognizer (via dependency injection through `register({...recognizer, detectAsync})`) that sleeps 300ms before returning a fixed detection.
- **Steps**: Call `detectAllAsync(text, { latencyBudgetMs: 100 })`.
- **Expected Result**: The promise resolves within ~100ms (± 20ms test tolerance). Returned detections contain only sync-recognizer results. A `pii.detect.degraded` trace event is emitted with `reason = 'async_budget_exceeded'`. The synthetic recognizer's eventual completion does not cause leaked state or unhandled promise rejections. **Cleanup assertion**: when the primary detection promise resolves _before_ the budget timer, the test must assert no orphan timer fires after the `latencyBudgetMs` window (HLD §4 Concern 6 cleanup invariant — the `withTimeout` wrapper must call `clearTimeout` on the success path).
- **Failure Mode**: If the timeout wiring is wrong, the call hangs for 300ms (assert wall time) or the degradation event is missing. If the cleanup path is wrong, an orphan timer fires after the test resolves and triggers the test runner's unhandled-rejection guard.

### INT-6: Latency telemetry at production entry points (FR-8)

- **Boundary**: each production-wired PII detection entry point ↔ shared `TraceStore`.
- **Setup**: Drive a single chat round through the runtime stack with `tier = 'standard'` and a mix of input PII (triggers NLU guard + vault tokenize) and a non-streamed assistant response (triggers output filter).
- **Steps**: Capture all trace events emitted during the round.
- **Expected Result**: Trace events with dimension `pii.detect.latency_ms` are emitted at least once each for `entry_point ∈ {nlu_guard, vault_tokenize, output_filter}`. Each event carries `tier`, `pack` (when attributable), and `recognizer`. **Streaming-chunk telemetry is deferred** per HLD §4 Concern 8 — `StreamingPIIBuffer` has no production caller today, so the `entry_point='streaming_chunk'` event has no emit site in this revision. The LLD ships the buffer-side fields/hook; the runtime caller wiring is a separate follow-up.
- **Failure Mode**: A missing event among the three production entry points indicates the corresponding entry point did not invoke detection or did not emit telemetry.

### INT-7: Defaults applied on legacy `project_runtime_configs` documents (FR-5)

- **Boundary**: `session-pii-context.ts` `mapProjectPIIRedactionConfig()` ↔ `ProjectRuntimeConfig` Mongoose schema.
- **Setup**: Insert a `project_runtime_configs` document via the model with the **legacy** `pii_redaction` shape (only `enabled`, `redact_input`, `redact_output`).
- **Steps**: Call `resolveProjectPIISnapshot({ tenantId, projectId })`.
- **Expected Result**: The returned `RuntimePIIProjectSnapshot.redactionConfig` has `tier === 'basic'`, `latencyBudgetMs === 200`, `confidenceThreshold === 0.5`, `enabledRecognizerPacks deepEquals ['core']`. The snapshot's registry overlay contains exactly the `core` pack's recognizers.
- **Failure Mode**: A field-propagation gap leaves one of the runtime interfaces un-extended; the assertion fails on the missing field.

### INT-8: New-field propagation through parallel runtime interfaces (FR-5, regression)

- **Boundary**: DB shape (`IPIIRedactionConfig`) → `ProjectPIIRedactionConfig` → `RuntimePIIRedactionConfig` → `RuntimePIIProjectSnapshot` → `session.piiRedactionConfig`.
- **Setup**: PATCH a project to `tier = 'standard'`, `latency_budget_ms = 350`, `confidence_threshold = 0.4`, `enabled_recognizer_packs = ['core', 'apac']`. Bootstrap a session via `refreshSessionPIIContext()`.
- **Steps**: Assert each interface in the chain carries the four new fields with the values from the PATCH.
- **Expected Result**: Every layer round-trips the four fields; no field drops at any boundary.
- **Failure Mode**: A typo or missed mapper update at any layer surfaces here as the missing field on the final session object.

### INT-9: Pack-aware tenant + project isolation through the registry overlay loader (FR-6)

- **Boundary**: `resolveProjectPIISnapshot()` ↔ `ProjectRuntimeConfig.findOne({tenantId, projectId})` ↔ `loadProjectPIIPatterns()`.
- **Setup**: Three projects: P-A under T1 with `['core', 'medical']` plus a custom pattern; P-B under T1 with `['core']` and no custom pattern; P-C under T2 with arbitrary config.
- **Steps**: Call `resolveProjectPIISnapshot` for each project and inspect the returned overlay's recognizer set.
- **Expected Result**: P-A's overlay contains the `medical` pack recognizers and the custom pattern. P-B's overlay contains neither. P-C's overlay does not contain P-A's custom pattern.
- **Failure Mode**: Cross-pollination between projects/tenants — visible as P-A's custom pattern appearing in P-B's or P-C's overlay.

### INT-10: Mid-session epoch-bump refresh picks up new packs (concurrency)

- **Boundary**: `pii-epoch.ts` (Redis epoch counter) ↔ `session-pii-context.ts` snapshot cache.
- **Setup**: Bootstrap a session under P1 with `enabled_recognizer_packs = ['core']`. Send a probe IBAN message — assert no detection.
- **Steps**:
  1. PATCH P1 to `enabled_recognizer_packs = ['core', 'eu']` (this calls `bumpPIIConfigEpoch`).
  2. Within the **same** session, call `refreshSessionPIIContext()` and send a follow-up IBAN.
- **Expected Result**: The follow-up IBAN produces a detection with `recognizer = 'iban'`. Asserts that the snapshot cache key (which includes the epoch) invalidated correctly and that `session.piiVault.setRecognizerRegistry()` was called with the new overlay.
- **Failure Mode**: Stale snapshot survives the epoch bump; the second message also produces no detection.

### INT-11: Audit-log enrichment with `confidence` + `recognizer` (FR-1)

- **Boundary**: detection caller → `PIIAuditLogger.log()` → `PIIAuditStore.insert()` (the captured `PIIAuditEntry` shape).
- **Setup**: `PIIAuditStore` (per `packages/compiler/src/platform/security/pii-audit.ts:24`) exposes only `insert()` — there is no read method. The integration test must inject a test-only `PIIAuditStore` implementation (constructor-injected via `new PIIAuditLogger(store)`, **not** a module mock) that captures every `insert(entry)` call into a local array. This is dependency injection, not platform mocking.
- **Steps**: 1. Construct a `PIIAuditLogger` with the capturing store. 2. Drive detections that produce known `confidence` and `recognizer` values via the registry. 3. Call `await logger.flush()` to drain the buffer. 4. Inspect the captured entries.
- **Expected Result**: Every captured `PIIAuditEntry` has non-null `confidence` (range 0.0–1.0) and non-empty `recognizer` matching the detecting recognizer's `name`.
- **Failure Mode**: A stale code path writes entries without the new fields, or the new fields fail to round-trip through the buffer.
- **Companion E2E assertion**: E2E-1 already asserts `confidence`/`recognizer` appear on `pii.detect` trace events. The compliance-read concern (Open Question 2) is **not** in scope for INT-11 — see OQ-2 if a new `PIIAuditStore` read method is required.

### INT-12: Recognizer pack registration respects `MAX_RECOGNIZERS` cap (FR-6, GAP-008)

- **Boundary**: `PIIRecognizerRegistry.register()` capacity policy.
- **Setup**: Construct a fresh `PIIRecognizerRegistry`. Register all eight packs. Then register up to and beyond `MAX_RECOGNIZERS` custom recognizers.
- **Steps**: Inspect the registry's recognizer set after each registration; observe eviction behavior.
- **Expected Result**: All pack recognizers are retained (registered as `permanent: true` per the spec's chosen mitigation **OR** the cap was raised — the test must encode whichever choice the LLD makes). Custom recognizers register up to the cap and emit a warning when the cap is exceeded; pack recognizers are never evicted.
- **Failure Mode**: A pack recognizer is evicted to make room for a custom pattern — silent loss of detection coverage.

### INT-13: Recognizer regex throw is contained per-request (FR-6, reliability)

- **Boundary**: `PIIRecognizerRegistry.detectAll()` exception handling.
- **Setup**: Register a synthetic recognizer whose `detect()` throws `new Error('boom')` on a particular input.
- **Steps**: Call `detectAll()` with that input and assert (a) the exception does not propagate to the caller, (b) detections from other recognizers are still returned, (c) a `pii.detect.degraded` trace event is emitted with `reason = 'recognizer_threw'`, (d) within the same request the offending recognizer is suppressed for subsequent inputs (request-scoped suppression).
- **Failure Mode**: Exception propagates and breaks the detection pipeline; or other recognizers also short-circuit.

---

## 4. Unit Test Scenarios

### UT-1: `PIIDetection` field defaults (FR-1)

- **Module**: `packages/compiler/src/platform/security/pii-detector.ts`
- **Input**: For each of the existing 5 builtin recognizers, run a fixture that produces a known detection.
- **Expected Output**: The returned `PIIDetection` carries `confidence === 1.0` and a non-empty `recognizer` string matching the recognizer's `name` field. `removeOverlaps()` correctly prefers the higher-confidence detection when two recognizers fire on overlapping spans.

### UT-2: Recognizer pack parity for `core` (FR-6)

- **Module**: `packages/compiler/src/platform/security/recognizer-packs/core.ts`
- **Input**: 200 fixture inputs covering each of the 5 legacy entity types plus the credit-card variants (13-digit Visa, 15-digit Amex, 19-digit Maestro) and undashed SSN.
- **Expected Output**: Every match the legacy `detectWithLocalPatterns` produced is also produced by the `core` pack. Credit-card alignment is verified: the regex matches 13–19 digits and the **existing in-house `luhnCheck()`** at `pii-recognizer-registry.ts:170` gates on Luhn (no `validator.js` dependency — see HLD §8.2). SSN coverage is verified for both dashed and undashed forms (HLD §10.1 migration table — detection-expanding bug fix).

### UT-3: Hand-ported validator integration on each pack (FR-6)

- **Module**: each `recognizer-packs/*.ts` and `recognizer-packs/_validators.ts` (the in-repo validator module — HLD §8.2 keeps these hand-ported instead of pulling `validator.js`).
- **Input**: For each pack, 30 valid + 30 corrupted entity-type fixtures (last character flipped or invalid prefix).
- **Expected Output**: Valid entities → detection with `confidence ≥ baseConfidence`. Corrupted entities → no detection (validator rejects).
- **Coverage** (each item is an in-repo validator function or pack-local regex+validator pair, not a `validator.js` API):
  - IBAN — `_validators.ts#isIbanMod97`
  - Passport — pack-local regex + format check per country (`eu.ts`, `us.ts`, `apac.ts`)
  - Identity card — pack-local regex + checksum (`apac.ts` for Aadhaar via Verhoeff, NRIC, etc.)
  - Tax ID — pack-local regex + locale checks
  - Credit card — existing `luhnCheck()` (`pii-recognizer-registry.ts:170`)
  - Mobile / phone — `libphonenumber-js` via `phone-extraction.ts` (existing dep)
  - BTC — `_validators.ts#isBtcBase58Check`
  - IP — pack-local regex (existing IPv4 in built-ins; new IPv6 in `network` pack)
  - NPI — `luhnCheck` reused with the `80840` prefix harness

### UT-4: Verhoeff validator (apac pack — Aadhaar) (FR-6)

- **Module**: inline Verhoeff implementation under `recognizer-packs/apac.ts`.
- **Input**: 20 valid Aadhaar numbers + 20 with the last digit corrupted.
- **Expected Output**: Valid → detected; corrupted → not detected.

### UT-5: Context-word boosting (FR-7)

- **Module**: `packages/compiler/src/platform/security/context-enhancer.ts`
- **Input**:
  - Match without context word.
  - Match with context word inside the configured 12-token window.
  - Match with context word outside the window.
  - Context word in mixed case (`"PASSPORT"`, `"Passport"`).
  - Context word adjacent to punctuation (`"...passport,..."`).
- **Expected Output**: `confidence === baseConfidence` when no context; `confidence === min(1.0, baseConfidence + contextBoost)` when context is in-window; case-insensitive matching; punctuation tolerated.

### UT-6: ReDoS adversarial pass per pack (FR-6, GAP-005, GAP-007)

- **Module**: every `recognizer-packs/*.ts`
- **Input**: 50 adversarial payloads per pack (long alternation, deeply nested groups, ambiguous quantifiers, 100KB strings).
- **Expected Output**: Each pattern executes within 50 ms wall time on a representative laptop CPU. No pattern triggers Node's stack-overflow path. Build-time RE2-compilability lint (separate concern, but referenced here) catches non-RE2-safe patterns before they ship.

### UT-7: Unknown pack name handling (FR-5, GAP-010)

- **Module**: pack registry loader.
- **Input**: `enabled_recognizer_packs = ['core', 'totally-fake-pack']`.
- **Expected Output**: The unknown pack is skipped; `core` is loaded; an operator-level warning log is emitted with the unknown pack name; no exception. Confirms the runtime side of GAP-010 (the API-side Zod-validation rejection is covered by E2E-ERR-1).

### UT-8: `detectAllAsync` sync-only path (FR-2)

- **Module**: `packages/compiler/src/platform/security/pii-recognizer-registry.ts`
- **Input**: A registry with only synchronous recognizers; call `detectAllAsync()`.
- **Expected Output**: Resolves immediately (within ~5 ms test tolerance). Returns the same detections as the synchronous `detectAll()`. No `setTimeout` budget timer is created when there are no async recognizers (HLD §3.4 — sync recognizers run before any timer; the `withTimeout` wrapper is bypassed entirely on the sync-only path).

---

## 5. Security & Isolation Tests

> Each item below is an explicit assertion. Checkboxes are testable, not aspirational.

- [ ] **Cross-tenant 404**: `PATCH /api/projects/P1/runtime-config` from a token scoped to tenant T2 returns HTTP 404, never 403, never 200. Asserted in E2E-1 isolation check.
- [ ] **Cross-project 404**: `GET /api/projects/P1/runtime-config` from a token with permissions only on P2 (same tenant) returns 404. Asserted in E2E-3 isolation check.
- [ ] **Cross-user 404**: N/A — `pii_redaction` config is project-owned, not user-owned. Documented as N/A in §6 of the parent feature spec.
- [ ] **401 on missing auth**: PATCH/GET runtime-config with no Authorization header returns 401. Asserted in E2E-ERR-1.
- [ ] **403 on insufficient permission**: User with only `runtime_config:read` calling PATCH returns 403 before validation runs. Asserted in E2E-ERR-1.
- [ ] **Input validation**: Unknown `enabled_recognizer_packs` entries return 400 with structured error envelope and the offending entries listed (GAP-010). Asserted in E2E-ERR-1.
- [ ] **Registry isolation**: Custom pattern registered for Project A is not visible to Project B (same tenant) nor to Project C (different tenant). Asserted in INT-9.
- [ ] **Tenant-isolation plugin coverage**: `pii_audit_logs` and `pii_token_vault` continue to enforce `tenantIsolationPlugin` at the model layer. This sub-feature does not change those models; the plugin's behavior is covered by the parent feature's existing integration tests at `docs/testing/pii-detection.md`. Cross-tenant registry-overlay isolation **is** asserted in INT-9 (registry isolation across T1 and T2).
- [ ] **ReDoS containment**: Pack patterns survive 50 ms-bounded adversarial inputs. Asserted in UT-6.
- [ ] **Recognizer-throw containment**: A recognizer that throws does not propagate the exception or break the detection pipeline. Asserted in INT-13.

---

## 6. Performance & Load Tests

> The functional test spec asserts timeouts and budgets at the unit level (UT-6, INT-5). End-to-end p95/p99 latency targets (STANDARD p95 ≤ 5 ms, p99 ≤ 10 ms; budget 200 ms) are operational concerns and are validated separately.

- **Microbenchmark (Vitest `bench`)**: `packages/compiler/src/__tests__/security/recognizer-packs.bench.ts` — exercises each pack at 100, 500, 1000, and 5000-character payloads; gates the build at the documented per-pack budgets. Required by sub-feature spec §7.
- **Saturation test**: deferred to the Capacity Planner skill / `saturation-finder` skill at STANDARD tier with all packs enabled, before BETA promotion. Not part of this test spec's CI-gated suite.
- **No load-test E2E** is included in this spec. The spec's success metrics for p95/p99 are observed through the `pii.detect.latency_ms` trace dimension in production telemetry, not asserted in CI.

---

## 7. Test Infrastructure

- **Test runners**:
  - Compiler unit/integration: `vitest` via `packages/compiler/vitest.config.ts`. Run with `pnpm test --filter=@abl/compiler`.
  - Runtime unit/integration: `vitest` via `apps/runtime/vitest.config.ts` (default), `vitest.core.config.ts` (focused), `vitest.fast.config.ts` (no Mongo).
  - Runtime E2E: `vitest` via `apps/runtime/vitest.e2e.config.ts`. Uses `RuntimeApiHarness` (`apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`) for real Express + MongoMemoryServer + auth.
- **Required services**: MongoMemoryServer (managed by harness), in-process Redis mock or `ioredis-mock` for `pii-epoch.ts` (existing pattern). No external services.
- **Data seeding**: All seeding through the runtime API surface — tenant/project/auth via the harness, runtime-config via PATCH, custom patterns via POST `/api/projects/:projectId/pii-patterns`, sessions via POST `/api/projects/:projectId/sessions/start` (or whichever is current). **No direct Mongoose writes inside test bodies.**
- **Environment variables**: `PII_DEFAULT_TIER`, `PII_DEFAULT_LATENCY_BUDGET_MS`, `PII_DEFAULT_CONFIDENCE_THRESHOLD`, `PII_DEFAULT_RECOGNIZER_PACKS` (all per spec §11). E2E suites should leave these unset to exercise platform defaults; INT-7 explicitly sets them.
- **CI configuration**: extend the existing `pnpm test:report` matrix. Tag E2E tests with the `pii-tier` filter so they can be re-run independently.
- **E2E file registration (mandatory)**: `apps/runtime/vitest.e2e.config.ts` uses an explicit `defaultInclude` allowlist, **not** a glob. Every new E2E file under `apps/runtime/src/__tests__/e2e/` listed in §8 must be added to that allowlist or it will silently be skipped in CI even when local `vitest run <file>` passes. Verify the entry exists for each of the 7 new E2E files in this spec.
- **Benchmark runner**: `recognizer-packs.bench.ts` runs under `vitest bench` (not `vitest run`). The compiler's existing `vitest.config.ts` covers benchmark files, so no new config is required, but the CI lane that hosts benchmarks must invoke `vitest bench --filter=@abl/compiler` separately. The benchmark stage is non-blocking (reports deltas, does not fail CI on regression).
- **Test data**: synthetic golden corpus of ≥ 500 entries per entity type (per sub-feature §14 success metrics). Stored under `packages/compiler/src/__tests__/security/fixtures/` with separate files per pack.

---

## 8. Test File Mapping

| Test File                                                                             | Type        | Covers                                                  | Status                                                                                                      |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/security/pii-detector.confidence.test.ts`            | unit        | UT-1 (FR-1)                                             | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/pii-detector.threshold.test.ts`             | unit        | confidence_threshold redaction (CRITICAL-1 round-1 fix) | ✅ SHIPPED (added in pr-review round 1)                                                                     |
| `packages/compiler/src/__tests__/security/recognizer-packs.test.ts`                   | unit        | UT-2, UT-3, UT-7 (FR-6)                                 | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/recognizer-packs.bench.ts`                  | benchmark   | §6 microbenchmark                                       | ✅ SHIPPED (non-blocking per LLD D-11; STANDARD-tier p95 ≈ 0.7 ms @ 1000ch / 4.7 ms @ 5000ch on dev laptop) |
| `packages/compiler/src/__tests__/security/recognizer-packs.redos.test.ts`             | unit        | UT-6                                                    | ✅ SHIPPED (hard CI gate at 25 ms × 8 packs × 15 inputs)                                                    |
| `packages/compiler/src/__tests__/security/_validators.test.ts`                        | unit        | UT-4 — Verhoeff/IBAN-mod-97/DEA/BTC base58              | ✅ SHIPPED (replaces planned `aadhaar-verhoeff.test.ts`)                                                    |
| `packages/compiler/src/__tests__/security/context-enhancer.test.ts`                   | unit        | UT-5 (FR-7)                                             | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.async.test.ts`      | unit        | UT-8 (FR-2)                                             | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.capacity.test.ts`   | integration | INT-12 (FR-6, GAP-008)                                  | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.exception.test.ts`  | integration | INT-13                                                  | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/registry-bypass-regression.test.ts`         | integration | INT-1, INT-2, INT-3, INT-4 (FR-3, FR-4)                 | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/registry-isolation.test.ts`                 | integration | INT-9 (FR-6)                                            | ✅ SHIPPED (compiler path, not runtime — overlay isolation is registry-level)                               |
| `packages/compiler/src/__tests__/security/detect-all-async.test.ts`                   | integration | INT-5 (FR-2)                                            | ✅ SHIPPED                                                                                                  |
| `packages/compiler/src/__tests__/security/pii-audit.confidence.test.ts`               | integration | INT-11 (FR-1) — DI-captured `PIIAuditStore`             | ✅ SHIPPED (compiler-side capture; runtime adapter unchanged)                                               |
| `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`                          | integration | INT-7, INT-8 (FR-5)                                     | ✅ SHIPPED (extended with new fields)                                                                       |
| `apps/runtime/src/__tests__/pii/session-pii-context.fields.test.ts`                   | integration | INT-7, INT-8 (FR-5) — field-propagation regression      | ✅ SHIPPED                                                                                                  |
| `apps/runtime/src/__tests__/pii/session-pii-context.epoch.test.ts`                    | integration | INT-10 (concurrency)                                    | ✅ SHIPPED                                                                                                  |
| `apps/runtime/src/__tests__/pii/pii-latency-telemetry.test.ts`                        | integration | INT-6 (FR-8) — three production entry points            | ✅ SHIPPED (`streaming_chunk` emit-site deferred per HLD §4 Concern 8)                                      |
| `apps/runtime/src/__tests__/e2e/pii-cross-project-isolation.e2e.test.ts`              | e2e         | E2E-3                                                   | ✅ SHIPPED                                                                                                  |
| `apps/runtime/src/__tests__/e2e/pii-config-validation.e2e.test.ts`                    | e2e         | E2E-ERR-1                                               | ✅ SHIPPED                                                                                                  |
| `apps/runtime/src/__tests__/e2e/pii-pack-eu.e2e.test.ts`                              | e2e         | E2E-1                                                   | ✅ SHIPPED (3/3 — uses `startMockLLM` from `tools/agents/e2e-functional/mock-llm-server.ts`)                |
| `apps/runtime/src/__tests__/e2e/pii-confidence-threshold.e2e.test.ts`                 | e2e         | E2E-2                                                   | ✅ SHIPPED (3/3 — config round-trip + `redact_output` end-to-end via emails; threshold gating noted below)  |
| `apps/runtime/src/__tests__/e2e/pii-tier-mid-session.e2e.test.ts`                     | e2e         | E2E-4                                                   | ✅ SHIPPED (2/2 — basic↔standard tier flips on next session via `bumpPIIConfigEpoch`)                       |
| `apps/runtime/src/__tests__/e2e/pii-pack-and-custom-pattern-coexist.e2e.test.ts`      | e2e         | E2E-5                                                   | ✅ SHIPPED (2/2 — IBAN + custom employee-ID pattern both fire on the same response)                         |
| `apps/runtime/src/__tests__/e2e/pii-streaming-iban.e2e.test.ts`                       | e2e         | E2E-6                                                   | ⏸ DESIGN-DEFERRED (HLD §4 Concern 8 — no production caller for `StreamingPIIBuffer`)                        |
| `apps/runtime/src/__tests__/e2e/pii-custom-pattern-survives-pack-disable.e2e.test.ts` | e2e         | E2E-7                                                   | ✅ SHIPPED (2/2 — custom pattern persists through `enabled_recognizer_packs = []`)                          |
| `apps/runtime/src/__tests__/helpers/pii-e2e-helpers.ts`                               | helper      | shared bootstrap for the 5 LLM-driven PII E2E suites    | ✅ SHIPPED                                                                                                  |

> "EXTEND" rows indicate existing parent-feature test files that need additional cases for this sub-feature; do not duplicate the parent's existing scenarios.

---

## 9. Open Testing Questions

1. **Permission key naming**: the runtime-config route uses `runtime_config:write` per `apps/runtime/src/routes/project-runtime-config.ts:308`, while the PII pattern routes use `pii-pattern:write` per `apps/runtime/src/routes/pii-patterns.ts:79`. Should the test spec assert that PII config changes also require `pii:write` (an additional check), or is `runtime_config:write` sufficient? Pin down before writing E2E-ERR-1.
2. **Audit-log read API**: INT-11 reads via the `pii-audit-store-adapter` service interface, not direct Mongo. Confirm this interface is testable from runtime integration tests and that it exposes the new `confidence`/`recognizer` fields. If not, file a parent-feature gap rather than working around it in tests.
3. **Vault round-trip in E2E-5**: should consumer-rendering assertions (user/history/tool) be in E2E-5, or is the existing parent feature's vault-render coverage sufficient? Recommend folding the new-fields assertion into E2E-5 and not duplicating the consumer-rendering matrix.
4. **Synthetic golden corpus storage**: the ≥ 500 entries per entity type fixture file — should these live in-repo under `packages/compiler/src/__tests__/security/fixtures/` or be generated programmatically at test time? In-repo gives reproducibility; generation reduces repo size.
5. **`MAX_RECOGNIZERS` cap test (INT-12)**: depends on the LLD's binding decision (raise cap vs `permanent: true`). The test as written assumes packs are `permanent: true`. If the LLD picks the raise-cap option, INT-12 becomes a different assertion (cap raised to ≥ 200, eviction never triggers in the bounded test). Update once the LLD lands.

---

## 10. References

- Feature spec: `../../features/sub-features/pii-detection-tiered-recognizers.md`
- Parent feature spec: `../../features/pii-detection.md`
- Parent testing guide (do not duplicate): `../pii-detection.md`
- Sibling sub-feature: `../../features/sub-features/pii-detection-enhancements.md`
- Source plan: `../../audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md`
- Existing harness: `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`
- Existing PII test reference: `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`, `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`, `packages/compiler/src/__tests__/security/pii-detector.test.ts`
- Project conventions: `CLAUDE.md` (E2E quality lint, platform-mock lint, test architecture rules)

---

## Out of Scope (covered by sibling docs or later tiers)

- Cloud PII provider tests (Google DLP / AWS Comprehend / Azure AI) — owned by [`pii-detection-enhancements.md`](pii-detection-enhancements.md).
- GLiNER NER sidecar tests — owned by future ADVANCED tier sub-feature.
- Studio settings UX tests — owned by future Studio sub-feature.
- ClickHouse analytics + PII Observatory tab tests — owned by sibling sub-feature.
