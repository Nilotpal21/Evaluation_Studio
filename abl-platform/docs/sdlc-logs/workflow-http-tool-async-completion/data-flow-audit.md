# Data-Flow & Dependency-Wiring Audit: Workflow HTTP Tool Async Completion

**Date**: 2026-05-13
**Auditor**: claude-sonnet-4-6 (data-flow-audit skill)
**Round**: 1
**Feature**: `docs/features/workflow-as-tool.md` (sub-feature: `docs/specs/workflow-http-tool-async-completion.hld.md`)
**Ticket**: ABLP-155

---

## Sensitive Values Audited

- **`callbackSecret`** — DATA CLASS: CREDENTIAL (per-step HMAC secret; 32-byte random hex; used to sign and verify async callbacks)
- **`callbackUrl`** — DATA CLASS: INTERNAL (callback routing URL; deterministic from executionId + stepId; not a secret but reveals callback topology)
- **`callbackConfig`** — DATA CLASS: INTERNAL (routing metadata: injection location, key names; no credentials)

---

## Round 1: Path Trace Findings

---

### VALUE: `callbackSecret`

```
VALUE: callbackSecret
  DATA CLASS: CREDENTIAL
  APPROVED CONSUMERS:
    - External target system (receives it injected into body/header/query so it can sign the callback)
    - Workflow engine callback route (decrypts + verifies HMAC on inbound callback)
    - Callback delivery worker (decrypts + uses as HMAC signing secret for outbound delivery)
```

#### 1. Source

| Path                                 | File                                                           | Lines      | Entry Type                                        | Generation                               |
| ------------------------------------ | -------------------------------------------------------------- | ---------- | ------------------------------------------------- | ---------------------------------------- |
| tool_call async_wait (ABLP-155)      | `apps/workflow-engine/src/handlers/workflow-handler.ts`        | 2927–2928  | Restate ctx.run() side-effect                     | `randomBytes(32).toString('hex')`        |
| async_webhook (pre-existing)         | `apps/workflow-engine/src/handlers/workflow-handler.ts`        | 2776–2778  | Restate ctx.run() side-effect                     | `randomBytes(32).toString('hex')`        |
| Runtime A2A (pre-existing, parallel) | `apps/runtime/src/services/execution/routing-executor.ts`      | 2435, 3139 | In-memory                                         | `crypto.randomBytes(32).toString('hex')` |
| Caller-supplied (external trigger)   | `apps/runtime/src/services/workflow/workflow-tool-executor.ts` | 346        | Inbound from Runtime to workflow-engine POST body | `completionCallback.secret`              |

Entry validation: no schema validation on generation (internally generated). External caller-supplied secret for workflow tool completionCallback passes through unvalidated at `workflow-tool-executor.ts:346`.

#### 2. Writes

| Storage                                           | File                                                               | Field                             | Format                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------- |
| MongoDB `context.steps[stepKey].callbackSecret`   | `workflow-handler.ts:2997`                                         | `callbackSecret`                  | **Encrypted** (`encryptForTenantAuto`)                   |
| MongoDB `triggerMetadata.encryptedCallbackSecret` | `workflow-executions.ts:631–632`                                   | `encryptedCallbackSecret`         | **Encrypted** (plaintext field deleted after encryption) |
| MongoDB suspension store (A2A path only)          | `apps/runtime/src/services/execution/mongo-suspension-store.ts:56` | `callbackSecret`                  | **PLAINTEXT** ⚠️                                         |
| BullMQ callback delivery job                      | `apps/workflow-engine/src/services/callback-delivery-worker.ts:46` | `encryptedCallbackSecret`         | **Encrypted**                                            |
| Restate journal (side-effect return)              | `workflow-handler.ts:2927–2928`                                    | (journaled by Restate internally) | **PLAINTEXT** ⚠️                                         |

#### 3. Serialization Boundaries

| Boundary                                                 | File                                                         | Lines                            | What is Sent                                                                  | Receiving System                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Workflow engine → External HTTP target                   | `workflow-handler.ts:2960` + `http-tool-executor.ts:672–771` | —                                | `callback.secret` (plaintext) injected via callbackConfig (body/header/query) | External service (by design — needed to sign callbacks)                     |
| Workflow engine → Runtime POST `/internal/tools/execute` | `workflow-handler.ts:2958–2963`                              | —                                | `callback: { url, secret: plainCallbackSecret }`                              | Runtime internal-tools.ts — encrypted at workflow-executions route boundary |
| Runtime → Workflow engine POST `/execute`                | `workflow-tool-executor.ts:346`                              | —                                | `triggerMetadata.callbackSecret` (plaintext) over internal network            | Workflow engine ingress: encrypted at `workflow-executions.ts:631–632`      |
| Redis pub/sub                                            | `workflow-handler.ts:711`                                    | `sanitizePublishedStepData()`    | `callbackSecret` **STRIPPED**                                                 | Internal Redis subscribers                                                  |
| WebSocket snapshot to Studio                             | `apps/runtime/src/websocket/wf-bridge.ts:24`                 | `SNAPSHOT_STEP_SENSITIVE_FIELDS` | `callbackSecret` **STRIPPED**                                                 | Studio frontend                                                             |
| REST API response (step)                                 | `workflow-executions.ts:344`                                 | `STEP_SENSITIVE_FIELDS`          | `callbackSecret` **STRIPPED**                                                 | API consumers                                                               |
| REST API response (triggerMeta)                          | `workflow-executions.ts:416–419`                             | `cleanExecutionDoc()`            | `callbackSecret`, `encryptedCallbackSecret` **STRIPPED**                      | API consumers                                                               |

#### 4. Read Paths

| Consumer                            | File                                                                    | Lines | Audience                                             | Format                           |
| ----------------------------------- | ----------------------------------------------------------------------- | ----- | ---------------------------------------------------- | -------------------------------- |
| Callback verification (inbound)     | `apps/workflow-engine/src/routes/workflow-callbacks.ts:118–131`         | —     | Callback route middleware — decrypts + verifies HMAC | Decrypted at the policy boundary |
| Callback delivery worker (outbound) | `apps/workflow-engine/src/services/callback-delivery-worker.ts:132–138` | —     | BullMQ worker — decrypts + signs outbound webhook    | Decrypted at the policy boundary |
| Restate internal replay             | (Restate framework)                                                     | —     | Restate journal (replayed on retries)                | PLAINTEXT in Restate storage     |

#### 5. Policy Boundary

| Consumer                     | Class              | Allowed?            | Gate Applied                                                                                                              |
| ---------------------------- | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| External target system       | External tool/HTTP | Allowed (by design) | Secret injected by `http-tool-executor` only when `executionMode === 'async_wait'` and `callbackConfig.enabled !== false` |
| Callback route HMAC verifier | Internal policy    | Allowed             | Decrypt → `verifyWebhookSignature()` with `timingSafeEqual`                                                               |
| Callback delivery worker     | Internal policy    | Allowed             | Decrypt → `buildSignatureHeaders()`                                                                                       |
| Studio (WebSocket snapshot)  | UI client          | BLOCKED             | `SNAPSHOT_STEP_SENSITIVE_FIELDS` strips it                                                                                |
| Studio (REST API response)   | UI client          | BLOCKED             | `cleanExecutionDoc()` strips it                                                                                           |
| Redis pub/sub subscribers    | Internal           | BLOCKED             | `sanitizePublishedStepData()` strips it                                                                                   |
| LLM nodes                    | LLM                | BLOCKED             | No code path routes step context to LLM prompt                                                                            |
| Logs                         | Log aggregator     | BLOCKED             | Not present in any `log.*()` call (verified)                                                                              |

#### 6. Consumers / Sinks

- External HTTP target service: receives plaintext secret in configured location (body/header/query). **This is the approved sink** — the external service needs it to sign callbacks.
- BullMQ (for completion callback delivery): encrypted form only.
- No LLM path. No email/Slack path. No analytics path.

#### 7. Dependency Wiring

```
DEPENDENCY: callbackConfig (injection metadata, not the secret itself)
  Constructed at: apps/workflow-engine/src/handlers/canvas-to-steps.ts:1070–1077 (from canvas node config)
  Consumer 1: ToolCallStep (tool-call-executor.ts:33) via type field — WIRED ✓
  Consumer 2: step-dispatcher.ts:238 spreads into AsyncToolDispatchRequest — WIRED ✓
  Consumer 3: workflow-handler.ts:2962 forwards to toolClient.executeTool() — WIRED ✓
  Consumer 4: internal-tools.ts:166 receives + normalizeHttpCallbackConfig() — WIRED ✓
  Consumer 5: ToolBindingExecutor.execute():481 receives callbackConfig — WIRED ✓
  Consumer 6: http-tool-executor.ts:672 reads callbackConfig for injection placement — WIRED ✓
  Null-handling: normalizeHttpCallbackConfig() applies safe defaults when callbackConfig absent (enabled:true, location:'body')

DEPENDENCY: plainCallbackSecret (plaintext secret in workflow handler)
  Constructed at: workflow-handler.ts:2927 (Restate ctx.run side-effect)
  Consumer 1: workflow-handler.ts:2960 — sent to runtime via callback object — WIRED ✓
  Consumer 2: workflow-handler.ts:2987–2997 — encrypted and written to step context — WIRED ✓
  Null-handling: plainCallbackSecret is always generated before use; no null path

DEPENDENCY: encryptSecret / decryptSecret (tenant-scoped encryption functions)
  Constructed at: apps/workflow-engine/src/index.ts:722–727 (composition root)
  Consumer 1: workflow-handler.ts via deps.encryptSecret — WIRED ✓
  Consumer 2: workflow-executions.ts via deps.encryptSecret — WIRED ✓
  Consumer 3: workflow-callbacks.ts via deps.decryptSecret — WIRED ✓
  Consumer 4: callback-delivery-worker.ts — decrypts encryptedCallbackSecret directly — WIRED ✓
  Null-handling: no null path — always injected at composition root
```

#### 8. Parallel Paths

| Path                                             | Secret Handling                                                                                                                                                                                                          | Consistent?                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| HTTP tool (`async_wait`)                         | Generated in workflow-engine → sent plaintext to Runtime's internal-tools API → injected into external HTTP via `callbackConfig` placement → encrypted and stored in step context                                        | ✓                                                                                        |
| Workflow tool (`async_wait` or `async_continue`) | Generated by caller (workflow-tool-executor) → sent plaintext from Runtime to workflow-engine POST `/execute` → encrypted at workflow-executions route boundary → stored as `encryptedCallbackSecret` in triggerMetadata | ✓ (functionally same: encrypt-at-ingress pattern)                                        |
| Async webhook (pre-existing)                     | Generated in workflow-engine → injected as `x-callback-secret` header → encrypted and stored in step context                                                                                                             | ✓ (same pattern as HTTP tool path)                                                       |
| A2A suspension (runtime)                         | Generated in routing-executor → stored **PLAINTEXT** in MongoDB suspension store                                                                                                                                         | ✗ (inconsistent with workflow-engine paths — pre-existing issue, outside ABLP-155 scope) |

#### 9. Boundary Tests

- [x] `callbackSecret` stripped from WS snapshots — `apps/runtime/src/__tests__/wf-bridge.test.ts:564–592`
- [x] Callback HMAC verification with wrong secret → 401 — `apps/workflow-engine/src/__tests__/workflow-callbacks.test.ts`
- [x] `callbackSecret` not in API response — `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts:344`
- [x] `callbackSecret` stripped from pub/sub — implicit in Redis sanitization test
- [x] Timing-safe HMAC comparison — `packages/shared-kernel/src/security/webhook-signature.ts` (`timingSafeEqual`)
- [ ] **MISSING**: Boundary test asserting `callbackSecret` never appears in structured log output (no grep-style assertion)
- [ ] **MISSING**: Boundary test asserting `callbackSecret` is absent from execution doc REST response for ALL role types (current test covers only the step-level strip, not the full `triggerMetadata` strip)

---

### VALUE: `callbackUrl`

```
VALUE: callbackUrl
  DATA CLASS: INTERNAL
  APPROVED CONSUMERS: external target system (receives injected URL to POST back to), Studio (not sensitive), log aggregators (low-risk)
```

#### 1. Source

| Path                    | File                                                              | Lines | Construction                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| tool_call async_wait    | `apps/workflow-engine/src/handlers/step-dispatcher.ts:233–235`    | —     | `callbackUrlBuilder.buildCallbackUrl(executionId, stepId)` → `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}` |
| async_webhook           | `apps/workflow-engine/src/executors/async-webhook-executor.ts:53` | —     | Same builder                                                                                                                     |
| External trigger / cron | `apps/workflow-engine/src/routes/workflow-executions.ts:602–608`  | —     | Caller-supplied in `triggerMetadata.callbackUrl`; stripped for JWT/Studio callers                                                |

#### 2. Writes

- MongoDB `triggerMetadata.callbackUrl` — plaintext (not a secret)
- BullMQ callback delivery job — plaintext

SSRF protection: `assertUrlSafeForFetch(callbackUrl)` called before use at `workflow-handler.ts:1371` and `callback-delivery-worker.ts:118`.

#### 3. Serialization Boundaries

- Injected into external HTTP request (body/header/query) via `http-tool-executor.ts:672–771` — approved
- Sent from workflow-engine to Runtime in `AsyncToolDispatchRequest` — internal
- WebSocket snapshot (triggerMeta) — NOT stripped by `SNAPSHOT_TRIGGER_META_REDACT` (wf-bridge.ts:18)
- REST API response (triggerMeta) — NOT stripped by `cleanExecutionDoc()` (workflow-executions.ts:416–419)
- Log output at info level — `routing-executor.ts:2446`, `callback-delivery-worker.ts:121,164,185`

#### Policy Verdict

`callbackUrl` is not a credential — it is a routing URL. Exposing it to authorized Studio users is acceptable. However:

- It reveals callback endpoint topology to anyone with Studio/API access to execution documents
- It could enable replay attacks if an attacker can observe the URL AND forge a valid HMAC — mitigated by the HMAC secret requirement

No CRITICAL or HIGH findings for `callbackUrl`. See F-3 (MEDIUM).

---

## Findings Summary

| ID  | Severity | Dimension              | Finding                                                                                        |
| --- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| F-1 | HIGH     | Writes                 | Restate journal stores plaintext `callbackSecret`                                              |
| F-2 | HIGH     | Writes (parallel path) | MongoDB suspension store holds plaintext `callbackSecret` for A2A runtime path                 |
| F-3 | MEDIUM   | Read Paths             | `callbackUrl` present in WebSocket snapshots and REST API execution docs — not stripped        |
| F-4 | MEDIUM   | Read Paths             | `callbackUrl` logged at info level in routing-executor and callback-delivery-worker            |
| F-5 | LOW      | Regression Tests       | No boundary test asserting `callbackSecret` absent from REST execution doc (triggerMeta level) |
| F-6 | LOW      | Regression Tests       | No boundary test for `callbackSecret` absence in structured log output                         |

---

## Detailed Findings

### FINDING: F-1

```
FINDING: F-1
  SEVERITY: HIGH
  DIMENSION: 2. Writes
  PATH: workflow-handler.ts ctx.run() → Restate journal → Restate storage (PostgreSQL/RocksDB)
  EVIDENCE: workflow-handler.ts:2927–2928
    const plainCallbackSecret = await ctx.run('gen-tool-callback-secret:${step.id}',
      () => Promise.resolve(randomBytes(32).toString('hex')));
    // Restate journals the return value of ctx.run() — the plaintext hex string
    // Encryption happens 60+ lines later at line 2987
  IMPACT: Any operator with read access to Restate's backing storage (PostgreSQL journal table or
          RocksDB in-process) can read the plaintext 32-byte callback HMAC secret for active steps.
          Steps complete and journals are pruned by Restate, so exposure window = step duration.
  FIX: Generate the secret outside ctx.run() (randomBytes is not a Restate side-effect; it does
       not need durability since a new secret on replay is equally valid). Move randomBytes() call
       to a plain `const plainCallbackSecret = randomBytes(32).toString('hex')` before the Restate
       side-effect, or wrap only the encryption step inside ctx.run().
       Alternative (if secret must survive replay): store only the encrypted form in the journal
       by encrypting inside the ctx.run() lambda before returning.
  TEST: Integration test that calls the execution detail API (or reads Restate state) and asserts
        the callbackSecret field is not a 64-char lowercase hex string (only encrypted ciphertext
        should appear outside the Restate lambda).
```

### FINDING: F-2

```
FINDING: F-2
  SEVERITY: HIGH
  DIMENSION: 2. Writes (parallel path — pre-existing, outside ABLP-155 scope)
  PATH: routing-executor.ts → mongo-suspension-store.ts:56 → MongoDB
  EVIDENCE: apps/runtime/src/services/execution/mongo-suspension-store.ts:56
    { callbackSecret: suspensionData.callbackSecret } — no encryption applied
  IMPACT: Any operator with MongoDB read access to the suspension store collection can read
          plaintext A2A callback secrets. The workflow-engine path encrypts; the runtime path does not.
          Inconsistent encryption policy across parallel paths.
  FIX: Apply the same encrypt-at-ingress pattern: call encryptForTenantAuto() before writing
       callbackSecret to the suspension document; decrypt on read in the A2A callback handler.
  TEST: Unit test for mongo-suspension-store that asserts the stored callbackSecret field is not
        the plaintext value passed in (i.e., it is a ciphertext string, not the original hex).
  NOTE: Pre-existing issue — not introduced by ABLP-155. Flagged here for remediation in a follow-on ticket.
```

### FINDING: F-3

```
FINDING: F-3
  SEVERITY: MEDIUM
  DIMENSION: 4. Read Paths
  PATH: workflow-executions.ts triggerMetadata → MongoDB → REST response / WebSocket snapshot → Studio client
  EVIDENCE: apps/runtime/src/websocket/wf-bridge.ts:18 SNAPSHOT_TRIGGER_META_REDACT contains only
            ['encryptedAccessToken', 'accessToken'] — callbackUrl not included.
            apps/workflow-engine/src/routes/workflow-executions.ts:416–419 cleanExecutionDoc()
            strips callbackSecret/encryptedCallbackSecret/accessToken — callbackUrl not stripped.
  IMPACT: callbackUrl is not a credential. However, it exposes callback endpoint topology to
          Studio users and API consumers with execution-read access. An attacker who can both
          observe the callbackUrl AND forge a valid HMAC could replay or inject false completions
          — but HMAC forgery requires the 32-byte secret, so the practical risk is low.
  FIX (optional): Add 'callbackUrl' to SNAPSHOT_TRIGGER_META_REDACT and to cleanExecutionDoc()
                  triggerMeta strip list. Low priority given callbackUrl is not a credential.
  TEST: WS snapshot test asserting callbackUrl absent from triggerMetadata in the snapshot.
```

### FINDING: F-4

```
FINDING: F-4
  SEVERITY: MEDIUM
  DIMENSION: 4. Read Paths
  PATH: routing-executor.ts:2446, callback-delivery-worker.ts:121,164,185 → log aggregator
  EVIDENCE: log.info('Initiating async A2A handoff', { callbackUrl, ... }) — callbackUrl in log
  IMPACT: Log aggregators (e.g., Coroot, Elasticsearch) store callbackUrls. Callback URLs contain
          executionId + stepId, which could allow a log reader with callback route access to
          construct valid callback POSTs (if they also had the HMAC secret — mitigated).
  FIX: Replace callbackUrl in log with a truncated or hashed form:
         log.info('Initiating async A2A handoff', { callbackUrlHash: sha256(callbackUrl), ... })
  TEST: Verify log output for these code paths does not contain a full callback URL (regex check).
```

### FINDING: F-5

```
FINDING: F-5
  SEVERITY: LOW
  DIMENSION: 9. Regression Tests
  EVIDENCE: workflow-executions-routes.test.ts covers STEP_SENSITIVE_FIELDS strip at line 344,
            but no test asserts callbackSecret absent from the full execution document REST response
            at the triggerMetadata level for all consumer roles.
  FIX: Add test: GET /api/v1/workflows/executions/:id → assert response.triggerMetadata does not
       contain 'callbackSecret' or 'encryptedCallbackSecret' keys.
  TEST: Already the fix.
```

### FINDING: F-6

```
FINDING: F-6
  SEVERITY: LOW
  DIMENSION: 9. Regression Tests
  EVIDENCE: No test asserts that callbackSecret never appears in structured log output.
            callbackSecret is absent from logs today (verified by grep), but no regression guard exists.
  FIX: Add a lint-style grep check (or unit test) that asserts no log call in workflow-handler.ts,
       workflow-callbacks.ts, or internal-tools.ts passes a field named callbackSecret or
       callbackSecretKey with a non-redacted value.
  TEST: Already the fix — a CI check or test using `grep -r "callbackSecret"` filtered to log calls.
```

---

## Dependency Wiring: PASS

All dependencies in the ABLP-155 execution chain are correctly wired:

| Dependency                        | Constructed At             | All Consumers Wired?                                    |
| --------------------------------- | -------------------------- | ------------------------------------------------------- |
| `callbackConfig`                  | `canvas-to-steps.ts:1070`  | ✓ — 6-hop chain verified                                |
| `plainCallbackSecret`             | `workflow-handler.ts:2927` | ✓ — sent to runtime + encrypted to step context         |
| `encryptSecret` / `decryptSecret` | `index.ts:722–727`         | ✓ — injected at composition root, all consumers wired   |
| `callbackUrlBuilder`              | `index.ts:906–909`         | ✓ — injected at composition root, step-dispatcher wired |
| `normalizeHttpCallbackConfig`     | `internal-tools.ts:71–90`  | ✓ — safe defaults when callbackConfig absent            |

---

## Parallel Path Parity

| Aspect                     | HTTP Tool Path                        | Workflow Tool Path                                        | Async Webhook Path                    | Parity            |
| -------------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------------- | ----------------- |
| Secret generation          | Restate ctx.run() in workflow-handler | Caller-supplied, encrypted at workflow-executions ingress | Restate ctx.run() in workflow-handler | ✓                 |
| Secret encrypted at rest   | ✓ (MongoDB)                           | ✓ (MongoDB)                                               | ✓ (MongoDB)                           | ✓                 |
| Secret in Restate journal  | Plaintext (F-1)                       | N/A (not Restate-generated)                               | Plaintext (F-1, pre-existing)         | Same risk         |
| Strip from API response    | ✓                                     | ✓                                                         | ✓                                     | ✓                 |
| Strip from WS snapshot     | ✓                                     | ✓                                                         | ✓                                     | ✓                 |
| Strip from Redis pub/sub   | ✓                                     | ✓                                                         | ✓                                     | ✓                 |
| Not in logs                | ✓                                     | ✓                                                         | ✓                                     | ✓                 |
| A2A MongoDB (pre-existing) | N/A                                   | N/A                                                       | N/A                                   | ✗ plaintext (F-2) |

---

## Round 2: Fix Verification (2026-05-13)

| Finding | Fix Committed                                                                                             | Boundary Test Added                                                                             | Verified |
| ------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| F-1     | Yes — encrypt inside ctx.run lambda (both async_webhook and tool_call paths)                              | Partial — decryptSecret mock added to two existing tests; no new assertion on ciphertext format | ✓ CLOSED |
| F-2     | Yes — encryptForTenantAuto at both suspension creation sites; decryptSecret wired to createCallbackRouter | No new test — pre-existing HMAC tests exercise the decrypt path                                 | ✓ CLOSED |
| F-4     | Yes — callbackUrl removed from all 4 log calls                                                            | No log assertion test (low priority)                                                            | ✓ CLOSED |

### Round 2 new findings

**NEW-1 (HIGH — fixed)**: Two `async_wait` tests in `workflow-handler.test.ts` (lines ~677, ~786) omitted `decryptSecret` from their deps — the production code unconditionally calls `deps.decryptSecret()` after the fix. Fixed by adding `decryptSecret: vi.fn(async (ciphertext) => ciphertext.replace('cipher:', ''))` to both test dep objects.

**NEW-2 (LOW — fixed)**: Asymmetric defensive coding — async_webhook path had `&&` guard, tool_call path used `!` non-null assertion. Fixed by adding an explicit pre-flight guard: `if (!deps.decryptSecret) { throw new Error(...) }` matching the existing `encryptSecret` guard pattern.

### Remaining open gaps (deferred — LOW)

- F-3: `callbackUrl` not stripped from WebSocket snapshots or REST execution docs — optional, low impact
- F-5: No test asserting `callbackSecret` absent from triggerMetadata REST response
- F-6: No CI grep guard preventing callbackSecret from being re-added to logs

---

## Round 2 Checklist

| Finding | Scope                    | Fix Applied                                                                                  | Status     |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------- | ---------- |
| F-1     | ABLP-155 + async_webhook | Encrypt inside ctx.run lambda; decrypt outside                                               | CLOSED ✓   |
| F-2     | A2A runtime path         | encryptForTenantAuto before suspensionStore.create(); decryptSecret wired to callback router | CLOSED ✓   |
| F-3     | callbackUrl strip        | Deferred (optional, low impact)                                                              | OPEN — LOW |
| F-4     | Log callbackUrl          | Removed from all log calls                                                                   | CLOSED ✓   |
| F-5     | Test gap                 | Deferred                                                                                     | OPEN — LOW |
| F-6     | Test gap                 | Deferred                                                                                     | OPEN — LOW |

---

## Final Verdict

- [x] No CRITICAL findings
- [x] F-1 CLOSED — Restate journal now stores only ciphertext
- [x] F-2 CLOSED — MongoDB suspension store now stores encrypted callbackSecret
- [x] F-4 CLOSED — callbackUrl removed from all log emissions
- [x] NEW-1 FIXED — test deps updated with decryptSecret mock
- [x] NEW-2 FIXED — explicit guard added before decryptSecret call
- [x] ABLP-155 HMAC policy boundary: `callbackSecret` correctly stripped from all API/WS/pub-sub consumers
- [x] Dependency wiring complete — all 6-hop callbackConfig chain verified; decryptSecret now threaded end-to-end
- [x] Timing-safe HMAC comparison in place (`timingSafeEqual`)
- [x] Parallel path parity — all four suspension paths (HTTP tool, async_webhook, A2A single, A2A fan-out) now store only ciphertext at rest
- [ ] F-3, F-5, F-6 remain LOW — deferred to next test pass

---

## Supplemental Audit — 2026-05-14 (PR #1008 Review)

**Auditor**: claude-sonnet-4-6 (pr-review + data-flow-audit skill, 2 rounds)
**Scope**: New findings discovered during PR #1008 code review. The prior Round 2 marked F-2 CLOSED (suspension store now encrypts), but the fix introduced a regression at the `pushNotificationToken` assignment.

### New CRITICAL Findings

#### NEW-F-1 (CRITICAL) — A2A single handoff: encrypted token sent as `pushNotificationToken`

```
FINDING: NEW-F-1
  SEVERITY: CRITICAL
  DIMENSION: Policy Boundary / Serialization / Parallel Paths
  PATH: routing-executor.ts:2480 (callbackSecretPlain = randomBytes(32).hex)
        → routing-executor.ts:2483 (callbackSecret = encryptSecret(callbackSecretPlain))
        → routing-executor.ts:2534 (stored callbackSecret — encrypted ✓)
        → routing-executor.ts:2580 (pushNotificationToken: callbackSecret — ENCRYPTED CIPHERTEXT ✗)
        → remote A2A agent signs callback with ciphertext
        → callbacks.ts:83-84 (decryptSecret(suspension.callbackSecret) → plaintext)
        → crypto.createHmac('sha256', plaintext) — MISMATCH with ciphertext-signed request → 401
  EVIDENCE: apps/runtime/src/services/execution/routing-executor.ts:2580
    pushNotificationToken: callbackSecret,  // should be callbackSecretPlain
  IMPACT: All async A2A single-agent handoffs silently fail HMAC authentication.
          The suspended session hangs until timeout. No metric or alert fires.
  FIX: routing-executor.ts:2580 — change `callbackSecret` to `callbackSecretPlain`
  TEST: Unit test asserting sendTaskAsync receives pushNotificationToken === callbackSecretPlain
        (not callbackSecret). Integration round-trip: sign with plaintext, store encrypted,
        decrypt, verify — PASS.
  ROOT CAUSE: F-2 fix correctly encrypted storage but missed updating pushNotificationToken
              to use the plaintext variable (callbackSecretPlain) at the same scope.
```

#### NEW-F-2 (CRITICAL) — A2A fan-out: same regression at line 3307

```
FINDING: NEW-F-2
  SEVERITY: CRITICAL
  DIMENSION: Policy Boundary / Serialization / Parallel Paths
  PATH: routing-executor.ts:3228 (callbackSecretPlainFanOut = randomBytes(32).hex)
        → routing-executor.ts:3231 (callbackSecret = encryptSecretFanOut(callbackSecretPlainFanOut))
        → routing-executor.ts:3268 (stored callbackSecret — encrypted ✓)
        → routing-executor.ts:3307 (pushNotificationToken: callbackSecret — ENCRYPTED CIPHERTEXT ✗)
  EVIDENCE: apps/runtime/src/services/execution/routing-executor.ts:3307
    pushNotificationToken: callbackSecret,  // should be callbackSecretPlainFanOut
  IMPACT: All async A2A fan-out branches fail HMAC authentication. Every fan-out parallel
          dispatch hangs until timeout. Silent production failure.
  FIX: routing-executor.ts:3307 — change `callbackSecret` to `callbackSecretPlainFanOut`
  TEST: Same pattern as NEW-F-1 applied to fan-out sendTaskAsync call.
```

### New HIGH Findings

#### NEW-F-3 (HIGH) — `dumpHttpTrace` logs plaintext callback secret to disk

```
FINDING: NEW-F-3
  SEVERITY: HIGH
  DIMENSION: Consumers/Sinks
  PATH: http-tool-executor.ts:buildRequest → asyncCallbackEntries (contains callback.secret plaintext)
        → dumpHttpTrace({ headers, body }) at lines 2033, 2091, 2199
        → appendFileSync(http-traces/YYYY-MM-DD.jsonl) when MCP_TRACE=true
  EVIDENCE: http-tool-executor.ts:2033–2043 — headers logged unredacted; body includes
            asyncCallbackEntries when callbackConfig.location='body'|'header'
  IMPACT: In debug mode (MCP_TRACE=true), plaintext callback signing secret written to disk.
          Anyone with filesystem read access can retrieve the secret and forge callbacks.
  FIX: Redact asyncCallbackEntries keys in the trace log entry before calling dumpHttpTrace.
       Specifically, after buildRequest, produce a redacted copy of the body/headers that
       replaces callbackConfig.callbackSecretKey values with '[REDACTED]'.
  TEST: Test that when MCP_TRACE=true, http-traces output does not contain callback.secret value.
```

#### NEW-F-4 (HIGH) — `actorUserId` not propagated to `ToolBindingExecutor.sessionContext`

```
FINDING: NEW-F-4
  SEVERITY: HIGH
  DIMENSION: Dependency Wiring / Audit-log
  PATH: internal-tools.ts:164 (actorUserId extracted from req.body)
        → internal-tools.ts:391 (actorUserId used in workflow JWT sub ✓)
        → internal-tools.ts:462 (ToolBindingExecutor constructed without sessionContext) ✗
        → tool-binding-executor.ts:469 (log.info('tool.execution', { userId: undefined }))
  EVIDENCE: internal-tools.ts:462–471 — no sessionContext field in ToolBindingExecutor config
  IMPACT: All workflow-triggered tool execution audit logs record userId: undefined even
          when the actor's identity is known. Compliance and security audit gap.
  FIX: Add sessionContext: { userId: actorUserId, tenantId, sessionId: `internal-tool-${toolName}` }
       to ToolBindingExecutor constructor in internal-tools.ts.
  TEST: Assert that tool-binding-executor audit log userId equals actorUserId from request
        when actorUserId is set.
```

### New MEDIUM Findings

#### NEW-F-5 (MEDIUM) — Query-location injects callback secret into URL

```
FINDING: NEW-F-5
  SEVERITY: MEDIUM
  DIMENSION: Serialization / Policy Boundary
  PATH: http-tool-executor.ts:765–772 — callbackConfig.location='query' appends
        callbackSecretKey=<plaintext_secret> to the URL query string.
        URL is logged by all infrastructure layers (nginx, ALB, CloudTrail).
  EVIDENCE: http-tool-executor.ts:765–772 — searchParams.append(key, value) with no mitigation
  IMPACT: Callback signing secret appears in infrastructure access logs in plaintext.
          Attacker with access to logs can forge callbacks for any step using query-location injection.
  FIX: Document that 'query' location is intended only for non-sensitive callback identifiers,
       not the HMAC signing secret. Or: require 'body'|'header' for callbackSecretKey injection.
       At minimum, add a warning when callbackConfig.location === 'query'.
  TEST: Test that callbackConfig.location='query' produces a URL without the secret key
        when the tool call completes (regression guard for this behavior).
```

### Supplemental Round 2 Checklist

| Finding                                                                | Status                  |
| ---------------------------------------------------------------------- | ----------------------- |
| NEW-F-1 (CRITICAL): Fix routing-executor.ts:2580                       | **OPEN — BLOCKS MERGE** |
| NEW-F-2 (CRITICAL): Fix routing-executor.ts:3307                       | **OPEN — BLOCKS MERGE** |
| NEW-F-3 (HIGH): Redact dumpHttpTrace callback secret                   | OPEN                    |
| NEW-F-4 (HIGH): Wire actorUserId to ToolBindingExecutor sessionContext | OPEN                    |
| NEW-F-5 (MEDIUM): Document/guard query-location secret injection       | OPEN                    |
| Boundary test: HMAC sign-with-plain / store-encrypted / decrypt-verify | OPEN                    |

**Supplemental Verdict: NOT READY — 2 CRITICAL findings block merge.**
