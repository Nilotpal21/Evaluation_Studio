# Data-Flow & Dependency-Wiring Audit: Parallel Graph Execution + WS Real-Time Push

**Date**: 2026-05-07  
**Auditor**: Claude (automated, Phase A pr-review)  
**Round**: 1  
**Feature**: `docs/sdlc-logs/workflow-parallel-graph-execution/`  
**PR**: #891 — ABLP-155

---

## Sensitive Values Audited

- `triggerMetadata.accessToken` / `triggerMetadata.encryptedAccessToken` — DATA CLASS: CREDENTIAL
- `callbackSecret` (per async-webhook step) — DATA CLASS: CREDENTIAL
- `contextPatch` (workflow context variables) — DATA CLASS: INTERNAL
- `pathState` / `iterationPathState` — DATA CLASS: INTERNAL

---

## Round 1: Path Trace Findings

---

### VALUE: `triggerMetadata.accessToken` / `encryptedAccessToken`

**DATA CLASS:** CREDENTIAL  
**APPROVED CONSUMERS:** callback-delivery worker (reads encrypted form to sign outbound HTTP call); nothing else

#### 1. Source

`POST /api/projects/:projectId/workflows/:workflowId/executions`  
`apps/workflow-engine/src/routes/workflow-executions.ts:575–603`  
Entry type: HTTP request body (`triggerMetadata` field, `z.record(z.string(), z.unknown()).optional()`)  
Validation applied: schema parsing only (Zod), no value-level sanitization of individual triggerMetadata keys at entry.

Two paths:

- **Studio/browser-JWT trigger (`triggerType === 'studio'`)**: `callbackUrl` and `accessToken` deleted before any further use (`routes:586-587`). Safe.
- **Non-studio callers (API, webhook)**: plaintext `accessToken` encrypted to `encryptedAccessToken` via `deps.encryptSecret(plaintext, tenantId)` (`routes:601-603`). Plaintext deleted from working copy.

#### 2. Writes

| Store                         | Field                                  | Format                                          |
| ----------------------------- | -------------------------------------- | ----------------------------------------------- |
| MongoDB `workflow_executions` | `triggerMetadata.encryptedAccessToken` | AES-encrypted, tenant-scoped key                |
| Restate input payload         | `triggerMetadata.encryptedAccessToken` | same encrypted value, passed to Restate handler |

Plaintext `accessToken` never reaches MongoDB or Restate. ✓

#### 3. Serialization Boundaries

| Boundary                                      | Payload                                                                                  | Receiver                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| Route → Restate trigger                       | `triggerMetadata` (encrypted form)                                                       | workflow-handler via Restate input |
| workflow-handler → `deps.publisher.publish()` | NOT emitted (triggerMetadata not published in step/workflow events)                      | Redis pub/sub                      |
| WsBridge `findOne` → WS snapshot              | `triggerMetadata: 1` projection → `{ ...execDoc }` sent in `workflow_execution_snapshot` | Studio WS client                   |
| HTTP GET `/executions/:id` → Studio           | `cleanExecutionDoc` spreads `...rootFields` including `triggerMetadata`                  | Studio HTTP client                 |

#### 4. Read Paths

| Path                     | File:line                      | Audience           | Fields Included                                                      |
| ------------------------ | ------------------------------ | ------------------ | -------------------------------------------------------------------- |
| WsBridge findOne         | ws-bridge.ts:121-141           | Studio WS client   | `triggerMetadata: 1` (includes `encryptedAccessToken`)               |
| GET `/executions/:id`    | workflow-executions.ts:487-527 | Studio HTTP client | `triggerMetadata` via `...rootFields` in `cleanExecutionDoc`         |
| GET `/executions` list   | workflow-executions.ts:462-471 | Studio HTTP client | `triggerMetadata` via `...rootFields` in `cleanExecutionDoc`         |
| callback-delivery worker | callback-delivery routes       | Internal worker    | `encryptedAccessToken` (decrypts to sign outbound request) ← CORRECT |

#### 5. Policy Boundary

| Consumer                        | Should See                           | Actually Sees                               | Verdict  |
| ------------------------------- | ------------------------------------ | ------------------------------------------- | -------- |
| callback-delivery worker        | `encryptedAccessToken` (to decrypt)  | `encryptedAccessToken`                      | PASS     |
| Studio WS client                | nothing — no callback context needed | `encryptedAccessToken` via WS snapshot      | **FAIL** |
| Studio HTTP client (GET detail) | nothing                              | `encryptedAccessToken` in `triggerMetadata` | **FAIL** |

Both failures are encrypted-form exposure (not plaintext), reducing risk from CRITICAL to HIGH. But Studio has no use for this field and a future key compromise would expose all previously-captured encrypted tokens to any Studio client that received them.

#### 6. Consumers / Sinks

- Callback-delivery worker: decrypts and uses to sign outbound HTTP callback. CORRECT consumer.
- Studio WS client: receives but does not use. Should not receive.
- Studio HTTP client: receives but does not use. Should not receive.

#### 7. Wiring

```
DEPENDENCY: WsBridge.deps.executionModel.findOne
  Constructed at: index.ts:1699-1701
  WsBridge: WIRED ✓ (WorkflowExecution.findOne.lean() with projection passthrough)

DEPENDENCY: WsBridge.deps.checkProjectAccess
  Constructed at: index.ts:1703-1712
  WsBridge: WIRED ✓
  owner check: Project.exists({ _id: projectId, tenantId, ownerId: userId }) — tenantId scoped ✓
  member check: ProjectMember.exists({ tenantId, userId, projectId }) — tenantId scoped ✓

DEPENDENCY: WsBridge.deps.getRedisClient
  Constructed at: index.ts:1698
  WsBridge.getOrCreateSubscriber: WIRED ✓ (subscriber duplication on first subscribe)

DEPENDENCY: WsBridge → createWsServer
  index.ts:1715: createWsServer(server, wsBridge) — WIRED ✓

DEPENDENCY: wsBridge.start()
  index.ts:1714 — WIRED ✓ (sweep timer started)
```

All WsBridge wiring is correct. No NOT WIRED gaps.

#### 8. Parallel Paths

| Path                                            | Strips `encryptedAccessToken`       | Verdict |
| ----------------------------------------------- | ----------------------------------- | ------- |
| HTTP GET execution detail (`cleanExecutionDoc`) | No — `triggerMetadata` spread as-is | FAIL    |
| WS `workflow_execution_snapshot`                | No — raw `execDoc` spread           | FAIL    |
| callback-delivery worker                        | Reads and uses correctly            | PASS    |

The parity issue is that NEITHER the HTTP nor WS path strips `encryptedAccessToken` from `triggerMetadata` in outgoing responses. Both paths fail the same way. This is consistently wrong rather than asymmetrically wrong.

#### 9. Boundary Tests

- [ ] No test asserts that `GET /executions/:id` response does not contain `triggerMetadata.encryptedAccessToken`
- [ ] No test asserts that WS `workflow_execution_snapshot` does not contain `triggerMetadata.encryptedAccessToken`
- [ ] No test asserts that `triggerMetadata.accessToken` (plaintext) never persists to MongoDB

---

### VALUE: `callbackSecret` (async-webhook step HMAC secret)

**DATA CLASS:** CREDENTIAL  
**APPROVED CONSUMERS:** callback-ingestion route (reads encrypted form, decrypts, verifies HMAC of incoming callback payload). Nothing else.

#### 1. Source

Generated inside `executeWorkflowStep()` for `async-webhook` step type.  
`apps/workflow-engine/src/handlers/workflow-handler.ts:2681-2685`  
Entry type: internal side-effect (`restateCtx.run('gen-callback-secret', ...)` → `randomBytes(32).toString('hex')`)  
Validation: none needed (internally generated).

#### 2. Writes

| Store                                                               | Field            | Format                                    |
| ------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| `ctx.steps[stepKey].callbackSecret` (in-memory)                     | `callbackSecret` | AES-encrypted (`encryptedCallbackSecret`) |
| MongoDB `workflow_executions.context.steps[stepKey].callbackSecret` | `callbackSecret` | AES-encrypted                             |

Plaintext (`plainCallbackSecret`) is sent to the external webhook as `X-Callback-Secret` header and then discarded. It is never stored. ✓

#### 3. Serialization Boundaries

| Boundary                                        | Payload                                                                              | Receiver                | Policy                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------- |
| `executeWorkflowStep` → outbound webhook        | `X-Callback-Secret: <plaintext>`                                                     | External webhook system | CORRECT — external system needs plaintext to sign callbacks |
| `workflow-handler` → `deps.publisher.publish()` | `step.waiting_callback` event: `stepData: waitingCbData` (includes `callbackSecret`) | Redis pub/sub           | **GAP**                                                     |
| Redis pub/sub → `WsBridge.onRedisMessage`       | `workflow_step_status` event: `stepData: parsed.stepData`                            | Studio WS client        | **GAP**                                                     |
| WsBridge `findOne` → WS snapshot                | `context.steps[stepKey].callbackSecret` in `execDoc.context`                         | Studio WS client        | **GAP**                                                     |
| HTTP GET `/executions/:id` → Studio             | `cleanExecutionDoc` strips via `STEP_SENSITIVE_FIELDS`                               | Studio HTTP client      | PASS ✓                                                      |

#### 4. Read Paths

| Path                              | File:line                       | Audience           | `callbackSecret` Included?                 |
| --------------------------------- | ------------------------------- | ------------------ | ------------------------------------------ |
| `step.waiting_callback` publish   | wf-handler.ts:2746-2759         | Redis → WS clients | YES (in `waitingCbData`)                   |
| WS `workflow_step_status` forward | ws-bridge.ts:265                | Studio WS client   | YES (in `stepData`)                        |
| WS snapshot `findOne`             | ws-bridge.ts:126 (`context: 1`) | Studio WS client   | YES (in `execDoc.context.steps`)           |
| HTTP GET execution                | workflow-executions.ts:397-413  | Studio HTTP client | NO — stripped by `STEP_SENSITIVE_FIELDS` ✓ |
| callback-ingestion route          | callback-delivery routes        | Internal verifier  | YES (encrypted — CORRECT consumer) ✓       |

#### 5. Policy Boundary

| Consumer                      | Should See                                        | Actually Sees                                   | Verdict         |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------- | --------------- |
| Callback-ingestion verifier   | `callbackSecret` (encrypted, to decrypt + verify) | `callbackSecret` (encrypted)                    | PASS            |
| Studio HTTP client            | nothing                                           | nothing (stripped)                              | PASS            |
| Studio WS client (step event) | nothing                                           | `callbackSecret` (encrypted) in `stepData`      | **FAIL — HIGH** |
| Studio WS client (snapshot)   | nothing                                           | `callbackSecret` (encrypted) in `context.steps` | **FAIL — HIGH** |

**Root cause:** `stripControlFlow()` (workflow-handler.ts:689-694) only strips the `controlFlow` field. `STEP_SENSITIVE_FIELDS` is only applied in `cleanExecutionDoc` (HTTP path). No equivalent sanitization at the publish or WS-snapshot path.

#### 6. Consumers / Sinks

- Callback-ingestion: correct consumer.
- Studio WS client: incorrect consumer. Encrypted credential should not flow here.
- No LLM sinks, no external APIs, no Kafka.

#### 7. Wiring

Wiring of `deps.encryptSecret` in WsBridge is not applicable — WsBridge doesn't encrypt. The encryption wiring for workflow-handler is pre-existing and not changed by this PR.

No dependency wiring gaps for `callbackSecret`.

#### 8. Parallel Paths

| Path                                                               | Strips `callbackSecret`    | Verdict  |
| ------------------------------------------------------------------ | -------------------------- | -------- |
| HTTP GET execution (`cleanExecutionDoc` + `STEP_SENSITIVE_FIELDS`) | YES ✓                      | PASS     |
| `step.waiting_callback` Redis publish (`stripControlFlow`)         | NO                         | **FAIL** |
| WS `workflow_step_status` forward                                  | NO (passes stepData as-is) | **FAIL** |
| WS `workflow_execution_snapshot`                                   | NO (raw context)           | **FAIL** |

**Parity gap:** HTTP correctly strips; all WS paths do not. `STEP_SENSITIVE_FIELDS` is not applied at the publish boundary or in the WS snapshot path.

#### 9. Boundary Tests

- [ ] No test asserts that `workflow_step_status` WS message does not contain `callbackSecret` in `stepData`
- [ ] No test asserts that `workflow_execution_snapshot` WS message does not contain `callbackSecret` in `context.steps`
- [ ] No boundary test at the Redis publish call verifying `callbackSecret` is absent from the published JSON

---

### VALUE: `contextPatch` (workflow context variables)

**DATA CLASS:** INTERNAL  
**APPROVED CONSUMERS:** Studio debug panel — shows current workflow variable state.

#### Trace Summary

`contextPatch` is produced by `getContextVariables(ctx)` at workflow-handler.ts:1680/1919/2065. It returns all non-system-key context variables (everything except `trigger`, `workflow`, `tenant`, `steps`).

**Observation:** If a workflow author stores a credential in a context variable (e.g., `ctx.apiToken = <secret>`), it will flow into `contextPatch` published to Redis and then to Studio via WS. This is a **pre-existing risk** (pre-dates this PR) that is architecturally acceptable for the Studio debug use case where workflow authors are inspecting their own execution context. Not a new finding from this PR.

**Verdict:** PASS (no new risk introduced by this PR)

---

### VALUE: `pathState` / `iterationPathState`

**DATA CLASS:** INTERNAL  
**APPROVED CONSUMERS:** Studio canvas edge highlighting.

#### Trace Summary

`pathState: Record<string, 'running' | 'completed'>` — maps step IDs to run status. Injected by `pathAwarePublisher` at ws-bridge publish time.

Content: only step IDs (string keys) and status strings (`'running'` | `'completed'`). No credentials, no PII, no business data.

`iterationPathState`: same shape, one level deeper for loop iterations.

**Verdict:** PASS — no sensitive data.

---

## Findings Summary

| ID    | Severity | Dimension       | Finding                                                                                                                                                                                |
| ----- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DFA-1 | HIGH     | Policy Boundary | `callbackSecret` (encrypted) flows into `step.waiting_callback` Redis event and WS `workflow_step_status` message; Studio WS client receives it                                        |
| DFA-2 | HIGH     | Parallel Paths  | WS `workflow_execution_snapshot` sends raw `execDoc.context.steps` without `STEP_SENSITIVE_FIELDS` stripping — `callbackSecret` in async-webhook step states visible to WS subscribers |
| DFA-3 | HIGH     | Policy Boundary | `triggerMetadata.encryptedAccessToken` reaches Studio WS client via `workflow_execution_snapshot` (ws-bridge.ts:136,179)                                                               |
| DFA-4 | MEDIUM   | Policy Boundary | `triggerMetadata.encryptedAccessToken` returned in HTTP GET `/executions` and GET `/executions/:id` responses — `cleanExecutionDoc` does not strip sub-fields of `triggerMetadata`     |
| DFA-5 | LOW      | Boundary Tests  | No boundary tests verifying sensitive fields absent from WS messages; no test that plaintext `accessToken` never persists                                                              |

---

### Per-Finding Detail

```
FINDING: DFA-1
  SEVERITY: HIGH
  DIMENSION: Policy Boundary + Serialization
  PATH: async-webhook step → rebuildStepContext(callbackSecret=encryptedCallbackSecret)
        → getStepContext() → waitingCbData (controlFlow stripped, callbackSecret kept)
        → publisher.publish(step.waiting_callback, { stepData: waitingCbData })
        → Redis pub/sub
        → WsBridge.onRedisMessage() → toWsMessage() → workflow_step_status { stepData }
        → Studio WS client
  EVIDENCE: workflow-handler.ts:2746-2759 — stripControlFlow removes only controlFlow;
            ws-bridge.ts:265 — stepData forwarded as-is
  IMPACT: Encrypted callbackSecret visible to every Studio user watching the execution.
          Not plaintext but should not leave the service boundary.
  FIX: Add callbackSecret (and any future STEP_SENSITIVE_FIELDS entries) to a
       publishSensitiveFields set stripped at the publisher.publish() call site in
       workflow-handler before the step.waiting_callback emit.
       Simplest: extract a stripSensitiveStepData(stepData) helper that mirrors
       cleanExecutionDoc's STEP_SENSITIVE_FIELDS and apply it to stepData at every
       publish call (step.started, step.completed, step.failed, step.waiting_callback etc.)
  TEST: Unit test that publishes a step.waiting_callback for an async-webhook step and
        asserts parsed.stepData does not contain 'callbackSecret'.

FINDING: DFA-2
  SEVERITY: HIGH
  DIMENSION: Parallel Paths
  PATH: WsBridge.handleSubscribeExecution()
        → executionModel.findOne({...}, { context: 1, ... })  ← includes raw steps
        → this.send(ws, { type: 'workflow_execution_snapshot', execution: { ...execDoc } })
        → Studio WS client receives context.steps[stepKey].callbackSecret
  EVIDENCE: ws-bridge.ts:121-141,177-179 — no cleanExecutionDoc applied to snapshot
  IMPACT: Any Studio user subscribing to an async-webhook execution that has reached
          waiting_callback state will receive the encrypted callbackSecret in the snapshot.
  FIX: Apply cleanExecutionDoc (or an equivalent WS-path sanitizer that strips
       STEP_SENSITIVE_FIELDS from context.steps) to execDoc before sending the snapshot.
       Alternative: define a WS-specific projection that excludes callbackSecret at
       the MongoDB query level — but this is brittle as STEP_SENSITIVE_FIELDS grows.
  TEST: E2E-style test that subscribes via WS after an async-webhook step reaches
        waiting_callback and asserts the snapshot message does not contain callbackSecret.

FINDING: DFA-3
  SEVERITY: HIGH
  DIMENSION: Policy Boundary
  PATH: WsBridge.handleSubscribeExecution()
        → executionModel.findOne({...}, { triggerMetadata: 1, ... })
        → this.send(ws, { execution: { ...execDoc } })
        → Studio WS client receives triggerMetadata.encryptedAccessToken
  EVIDENCE: ws-bridge.ts:136,177-179
  IMPACT: Encrypted callback access token visible to Studio WS subscribers on
          externally-triggered (non-studio) executions.
  FIX: Strip encryptedAccessToken (and any other credential sub-fields) from
       triggerMetadata before sending the snapshot. Either:
       (a) Remove `triggerMetadata: 1` from the WsBridge findOne projection entirely
           (Studio only needs status/context/output in the snapshot), or
       (b) Pass execDoc through cleanExecutionDoc with a WS-variant that also strips
           triggerMetadata credential sub-keys.
  TEST: WS subscription test that seeds an externally-triggered execution and asserts
        the snapshot message does not contain triggerMetadata.encryptedAccessToken.

FINDING: DFA-4
  SEVERITY: MEDIUM
  DIMENSION: Policy Boundary
  PATH: GET /executions/:id → cleanExecutionDoc → { ...rootFields } → Studio HTTP client
        rootFields includes triggerMetadata which includes encryptedAccessToken
  EVIDENCE: workflow-executions.ts:360-413 — cleanExecutionDoc does not sanitize
            sub-fields of triggerMetadata; comment at line 354 explicitly lists
            triggerMetadata as a preserved root field
  IMPACT: Studio HTTP clients see encryptedAccessToken on execution detail/list views.
          Lower risk than DFA-3 (HTTP is shorter-lived than WS session), still a
          credential that has no client-side utility.
  FIX: Strip credential sub-keys from triggerMetadata inside cleanExecutionDoc:
       const { encryptedAccessToken: _eat, accessToken: _at, ...safeMeta } = triggerMetadata;
       return { ..., triggerMetadata: safeMeta };
  TEST: Assert that GET /executions/:id response does not include
        triggerMetadata.encryptedAccessToken or triggerMetadata.accessToken.

FINDING: DFA-5
  SEVERITY: LOW
  DIMENSION: Boundary Tests (Dimension 9)
  GAPS:
    - No test verifying that POST /executions with studio trigger strips callbackUrl and accessToken
    - No test verifying plaintext accessToken never appears in MongoDB after a non-studio POST
    - No WS-level test asserting callbackSecret absent from workflow_step_status.stepData
    - No WS-level test asserting encryptedAccessToken absent from workflow_execution_snapshot
```

---

## Round 1 Dependency Wiring Verdict

```
DEPENDENCY: WsBridge
  Constructed at: index.ts:1695-1713
  deps.getRedisClient: index.ts:1698 — WIRED ✓
  deps.executionModel.findOne: index.ts:1699-1701 — WIRED ✓ (WorkflowExecution.findOne.lean())
  deps.checkProjectAccess: index.ts:1703-1712 — WIRED ✓
    owner check: Project.exists({ _id, tenantId, ownerId }) — tenant-scoped ✓
    member check: ProjectMember.exists({ tenantId, userId, projectId }) — tenant-scoped ✓
  wsBridge.start(): index.ts:1714 — WIRED ✓
  createWsServer(server, wsBridge): index.ts:1715 — WIRED ✓

DEPENDENCY: pathAwarePublisher
  Constructed at: workflow-handler.ts:1285-1307
  Wraps deps.publisher (passthrough for non-step events) — WIRED ✓
  Injects pathState into step.* events — WIRED ✓
  Passed to executeDag via deps.publisher replacement — WIRED ✓

DEPENDENCY: executeDag
  Called at: workflow-handler.ts:3040 (inDegreeMap non-empty path)
  executeStepWithSuspension injected as executeStep param — WIRED ✓
  inDegreeMap from input.inDegreeMap — WIRED ✓ (stored in execution document at dispatch time)

DEPENDENCY: encryptSecret (workflow-engine routes)
  workflow-executions.ts:598-603: deps.encryptSecret used for accessToken
  index.ts: encryptSecret wiring — PRE-EXISTING, not in this PR scope
```

No NOT WIRED gaps found.

---

## Round 2: Fix Verification

Fixes applied in Phase B of pr-review on 2026-05-07.

| Finding | Fix Committed                                                                 | Boundary Test Added | Verified |
| ------- | ----------------------------------------------------------------------------- | ------------------- | -------- |
| DFA-1   | `7fb35acd` — sanitizePublishedStepData strips callbackSecret at every publish | no (DFA-5 open)     | ✓        |
| DFA-2   | `7fb35acd` — sanitizeSnapshotDoc strips callbackSecret from context.steps     | no (DFA-5 open)     | ✓        |
| DFA-3   | `7fb35acd` — sanitizeSnapshotDoc strips encryptedAccessToken from triggerMeta | no (DFA-5 open)     | ✓        |
| DFA-4   | `f082fca6` — cleanExecutionDoc strips encryptedAccessToken from triggerMeta   | no (DFA-5 open)     | ✓        |
| DFA-5   | boundary tests not yet added — tracked as follow-up                           | no                  | ✗        |

Build verification: `pnpm --filter=@agent-platform/workflow-engine build` — clean.
Test verification: 1079 pass / 2 pre-existing failures (unchanged).

---

## Final Verdict

- [x] Dependency wiring: no gaps
- [x] DFA-1: callbackSecret in WS step events — **FIXED** (`7fb35acd`)
- [x] DFA-2: callbackSecret in WS snapshot — **FIXED** (`7fb35acd`)
- [x] DFA-3: encryptedAccessToken in WS snapshot — **FIXED** (`7fb35acd`)
- [x] DFA-4: encryptedAccessToken in HTTP responses — **FIXED** (`f082fca6`)
- [ ] DFA-5: boundary tests — **OPEN** (follow-up ticket needed)
