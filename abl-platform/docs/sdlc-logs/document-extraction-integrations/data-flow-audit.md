# Data-flow-audit Round 1 -- callbackSecret

Sensitive value: `callbackSecret` (per-step 32-byte HMAC secret used to authenticate
extraction-worker callbacks back to the workflow engine).

## Round 1

### Encrypted path trace

#### 1. Connector body -- secret generation + encryption

**PASS** `packages/connectors/src/native/docling/connector.ts:203-204`

`randomBytes(32).toString('hex')` produces the plaintext. `callbackContext.encryptSecret(plaintext, tenantId)` produces the ciphertext. The plaintext is never assigned to any field that leaves the connector except via the two controlled paths (BullMQ enqueue at L216-234, sentinel at L237-243). The outbound POST to Docling (`streamUrlToDocling`) does NOT receive the secret -- confirmed: `streaming-url-to-docling.ts` has zero references to `callbackSecret` or `secret`.

#### 2. AsyncParkingSentinel shape

**PASS** `packages/connectors/src/types.ts:221-237`

`encryptedCallbackSecret` is typed as `string | undefined`. The fail-safe JSDoc at L229-236 documents the 401-rejection behavior when omitted. `isAsyncParkingSentinel` type guard at L239-245 checks `__asyncParking === true`.

#### 3. connector-action-executor -> step-dispatcher conversion

**PASS** `apps/workflow-engine/src/handlers/step-dispatcher.ts:229-242`

Sentinel is detected via `isAsyncParkingSentinel(output)`. `encryptedCallbackSecret` is conditionally spread into `StepDispatchResult.callbackRequest` (L237-239). When absent, the field is omitted -- the callback route will reject with 401 (fail-safe).

#### 4. step-dispatcher result shape

**PASS** `apps/workflow-engine/src/handlers/step-dispatcher.ts:134-142`

`StepDispatchResult.callbackRequest.encryptedCallbackSecret` is typed as `string | undefined`. JSDoc at L139-141 correctly labels it as "per-step HMAC ciphertext".

#### 5. workflow-handler suspension block -- persist to step record

**PASS** `apps/workflow-engine/src/handlers/workflow-handler.ts:3234-3253`

The suspension block reads `callbackReq.encryptedCallbackSecret` and stores it as `callbackSecret` on the step context via `rebuildStepContext()` (L3239-3243). `rebuildStepContext` at L962-965 preserves `callbackSecret` across rebuilds (sticky field). `updateStepStatus` writes the full step context to MongoDB at `context.steps[stepKey]` (execution-store.ts:228-232).

#### 6. Callback route -- decrypt + HMAC verify

**PASS** `apps/workflow-engine/src/routes/workflow-callbacks.ts:63-141`

Reads `step.callbackSecret` from the execution document (L89). If absent, rejects with 401 (L89-95). Decrypts via `deps.decryptSecret(step.callbackSecret, execution.tenantId)` (L116). Verifies HMAC via `verifyWebhookSignature(secret, rawBodyText, normalizedSignature, timestamp, toleranceSec)` (L118-125). Replay protection is enforced via mandatory `x-callback-timestamp` header (L110-114).

### Plaintext path trace (BullMQ job)

#### 1. Connector body -- plaintext to BullMQ

**PASS** `packages/connectors/src/native/docling/connector.ts:216-234`

`callbackSecret: plaintext` is passed into `enqueueWorkflowDoclingJob()`. The plaintext is the raw 64-char hex string.

#### 2. BullMQ job data -- Redis at-rest

**FAIL** -- `callbackSecret` stored as plaintext in Redis

`packages/shared-encryption/src/encryption-manifest.ts:35` registers the `workflow-docling-extraction` queue with `fieldsToEncrypt: []`. The `callbackSecret` field in the BullMQ job payload is therefore stored unencrypted in Redis.

Redis is intra-cluster and not externally accessible in production, but CLAUDE.md Invariant 6 (Compliance: encryption at rest) and the platform's own encryption-manifest pattern expect secrets to be encrypted. Every other credential-bearing queue (`llm-requests`, `message-persistence`) encrypts its sensitive fields.

**Recommendation:** Add `callbackSecret` to `fieldsToEncrypt` for `workflow-docling-extraction` in `encryption-manifest.ts`. Verify the BullMQ producer (the workflow-engine `enqueueWorkflowDoclingJob` implementation) and consumer (`extraction-only.ts`) go through the envelope encryption layer, or document the explicit opt-out rationale.

#### 3. Worker -- reads plaintext from job.data

**PASS** `apps/search-ai/src/workers/branches/extraction-only.ts:54`

Destructures `callbackSecret` from `job.data`. Never logged -- the `workerLog` calls at L56-61 and L169-175 include only `jobId`, `tenantId`, `projectId`, `stepId`, `status`, `durationMs`. No trace events emitted with the secret.

#### 4. callback-poster -- HMAC signing

**PASS** `apps/search-ai/src/workers/callback-poster.ts:69-81`

`input.secret` (the plaintext) is passed to `buildSignatureHeaders(input.secret, input.body)` which produces `x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id` headers. The plaintext is never included in the POST body, URL, or any header value -- only used as the HMAC key.

### Publish boundary -- sanitization

#### sanitizePublishedStepData (Redis pub/sub to Studio)

**PASS** `apps/workflow-engine/src/handlers/workflow-handler.ts:733,740-750`

`PUBLISH_SENSITIVE_STEP_FIELDS = new Set(['callbackSecret'])` -- the field is stripped before publishing step data to the Redis status channel at L3255-3270.

#### sanitizeSnapshotDoc (wf-bridge WebSocket to Studio)

**PASS** `apps/runtime/src/websocket/wf-bridge.ts:25,464-489`

`SNAPSHOT_STEP_SENSITIVE_FIELDS = new Set(['callbackSecret'])` -- stripped from step contexts in execution snapshots sent to Studio clients.

#### cleanExecutionDoc (REST API to Studio)

**PASS** `apps/workflow-engine/src/routes/workflow-executions.ts:350,415-428`

`STEP_SENSITIVE_FIELDS = new Set(['callbackSecret'])` strips the field from every step in `context.steps` before returning the execution document. Additionally, `triggerMetadata.callbackSecret` and `triggerMetadata.encryptedCallbackSecret` are explicitly filtered at L421-425.

### Logging and trace emissions

**PASS** -- No leaks found.

`grep` across the codebase for `callbackSecret` in log/trace/emit contexts returned only:

- `workflow-callbacks.ts:90` -- warns about a missing `callbackSecret` (no value logged).
- `step-context-schema.ts:291` -- JSDoc comment referencing the stripping policy.
  The raw secret value is never logged, traced, or emitted.

### Key symmetry -- encrypt key == decrypt key

**PASS** -- Both paths use tenant-keyed encryption.

Encrypt: `callbackContext.encryptSecret(plaintext, tenantId)` -- wired to `encryptForTenantAuto` in production.
Decrypt: `deps.decryptSecret(step.callbackSecret, execution.tenantId)` -- wired to the corresponding tenant decryption facade.
The `tenantId` is the same value in both paths (connector body has `requireWorkflowContext(ctx).tenantId`; callback route reads `execution.tenantId`).

### Test coverage

#### Encrypt -> persist -> decrypt -> verify cycle

**PASS** `apps/workflow-engine/src/__tests__/workflow-docling-callback-roundtrip.test.ts`

Covers: valid HMAC (200), missing signature (401), wrong signature (401), late callback (409), unknown execution (404), stale timestamp (401), platform header naming. Uses stubbed `decryptSecret` with `enc::` prefix passthrough. 7 test cases.

#### Sentinel -> callbackRequest conversion

**PASS** `apps/workflow-engine/src/__tests__/connector-async-parking.test.ts:58,81,85`

Covers: sentinel with `encryptedCallbackSecret` maps to `callbackRequest.encryptedCallbackSecret`. Sentinel without it omits the field (fail-safe branch).

#### BullMQ enqueue -> worker -> HMAC cycle

**NOTE** -- No integrated round-trip test exists for this path. `extraction-only.ts` has unit tests (`apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`), and `callback-poster.ts` is tested via its callers, but there is no single test that validates plaintext-secret-in-job -> worker-reads-it -> HMAC-signs -> callback-route-verifies end-to-end.

#### Null/undefined callbackSecret on callback arrival

**PASS** -- Covered by `workflow-docling-callback-roundtrip.test.ts` implicitly (no test seeds a step without `callbackSecret` in `waiting_callback` status, but the route code at L89-95 rejects unconditionally). The `connector-async-parking.test.ts:85` confirms the sentinel-without-secret path. However, a dedicated test seeding a step in `waiting_callback` with `callbackSecret: undefined` and asserting 401 would strengthen confidence.

## Critical findings

1. **CRITICAL -- BullMQ plaintext secret at rest in Redis.** The `workflow-docling-extraction` queue has `fieldsToEncrypt: []` in `packages/shared-encryption/src/encryption-manifest.ts:35`. The `callbackSecret` field in the job payload is stored as plaintext in Redis. Fix: add `'callbackSecret'` to the `fieldsToEncrypt` array and verify the producer/consumer paths handle the encryption envelope. (`encryption-manifest.ts:35`)

2. **MEDIUM -- No end-to-end test for the BullMQ plaintext path.** There is no integrated test validating the chain: connector-enqueue(plaintext) -> BullMQ-job -> worker-reads(plaintext) -> HMAC-sign -> callback-route-decrypt-verify. The encrypted path has good coverage (roundtrip test), but the plaintext path relies on separate unit tests that don't exercise the full chain.

3. **LOW -- No explicit test for null callbackSecret + waiting_callback status.** The code correctly rejects (401) when `step.callbackSecret` is falsy, but no test seeds this exact state (`waiting_callback` + no secret). The existing roundtrip test always seeds a secret; the fail-safe branch is tested only via the sentinel-omission test in `connector-async-parking.test.ts`.

## Round 2

Re-verification of the Round 1 CRITICAL fix and regression check of Round 1 PASS cases.

### Check 1 -- Manifest fix landed

**PASS** `packages/shared-encryption/src/encryption-manifest.ts:35`

Line 35 now reads `'workflow-docling-extraction': { fieldsToEncrypt: ['callbackSecret'] }`. The field is registered. `getRedisQueueManifest('workflow-docling-extraction')` will return a config with a non-empty `fieldsToEncrypt` array, causing both `wrapJobDataForEncrypt` and `unwrapJobDataForDecrypt` to enter the encrypt/decrypt path instead of the early-return bypass.

### Check 2 -- Enqueue wrap is correct

**PASS** `apps/workflow-engine/src/index.ts:1024-1036`

(a) `wrapJobDataForEncrypt('workflow-docling-extraction', payload, tenantEncryption)` is called at L1029-1031 BEFORE `workflowDoclingQueue.add('extraction', encryptedPayload, ...)` at L1034. The encrypted payload is what gets persisted to Redis.
(b) `tenantEncryption` (L738-743) exposes both `encryptForTenant` and `decryptForTenant`, both wired to `encryptForTenantAuto`/`decryptForTenantAuto`. This satisfies the `TenantFieldEncryptionService` interface required by `encryptFields`.
(c) `encryptFields` sets `result._enc = 'v3'` (field-interceptor.ts:40) and prefixes the ciphertext with `ENC:v3:` (L37). The encrypted payload persisted to Redis carries the `_enc: 'v3'` flag.

### Check 3 -- Dequeue unwrap is correct

**PASS** `apps/search-ai/src/workers/branches/extraction-only.ts:58-73`

(a) `unwrapJobDataForDecrypt('workflow-docling-extraction', job.data, ...)` is called at L63-70, BEFORE the destructuring of `callbackSecret` at L72-73. Correct ordering.
(b) `unwrapJobDataForDecrypt` (secure-queue.ts:28-37) reads `tenantId` from `data.tenantId` and passes it to `decryptFields`. The same `tenantId` field is present in the job payload at enqueue time (it is part of `WorkflowDoclingExtractionJobData`), so encrypt and decrypt use the same tenant key.
(c) After decrypt, `decryptedData` is destructured and `callbackSecret` is in plaintext scope for `postCallback` at L163: `secret: callbackSecret`. Correct.

### Check 4 -- Round-trip integration test (encrypt-at-enqueue -> decrypt-at-dequeue -> HMAC -> callback verify)

**MISSING** -- The existing worker test (`apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`) calls `processExtractionOnly(job)` directly with plaintext job data. It does NOT exercise `wrapJobDataForEncrypt` before invocation and does NOT exercise `unwrapJobDataForDecrypt` inside the function with real encrypted payloads (the test feeds unencrypted data, so `unwrapJobDataForDecrypt` hits the `if (!row._enc) return row` early-return). The HMAC-sign + callback-verify half of the chain IS tested. The encrypt/decrypt half is not integrated.

This is the same gap flagged as MEDIUM in Round 1. The `secure-queue.test.ts` in `packages/shared/src/encryption/__tests__/` covers the generic wrap/unwrap logic with mock encryption services, and the `field-interceptor.ts` unit tests cover `encryptFields`/`decryptFields` with the `_enc` flag. But no test exercises the specific `workflow-docling-extraction` queue with a real `callbackSecret` field flowing through `wrapJobDataForEncrypt` -> Redis-shaped payload -> `unwrapJobDataForDecrypt` -> `postCallback` end-to-end. Severity remains MEDIUM (the pieces are individually tested; the integration seam is untested).

### Check 5 -- Old plaintext fallback (pre-fix jobs)

**PASS** `packages/shared-encryption/src/field-interceptor.ts:50`

`decryptFields` returns `row` unchanged when `row._enc` is falsy (L50: `if (!row._enc) return row`). This means older jobs enqueued before the fix (no `_enc` flag, plaintext `callbackSecret`) will dequeue without error. The `unwrapJobDataForDecrypt` wrapper calls `decryptFields` which triggers this early return. The comment in `extraction-only.ts:60-62` explicitly documents this backward-compatibility path.

### Check 6 -- No double-encrypt risk

**PASS** `packages/shared-encryption/src/field-interceptor.ts:19-20`

`encryptFields` throws `Row already encrypted (_enc=${row._enc})` if `row._enc` is already set. Additionally, L31-34 checks each individual field for the `ENC:v3:` prefix and throws `double encryption detected` if found. In the workflow-engine path, `wrapJobDataForEncrypt` is called exactly once (L1029-1031 in `index.ts`), and the result is immediately passed to `workflowDoclingQueue.add`. There is no second encrypt call on the same payload. The `wrapJobDataForEncrypt` import appears only at L25 in the engine, and is invoked only at L1029. No double-encrypt risk.

### Check 7 -- Round 1 PASS cases regression check

| Boundary                                         | Status                   | Notes                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector body -- secret generation + encryption | **PASS (no regression)** | `connector.ts` unchanged by these fixes.                                                                                                                                                                                              |
| AsyncParkingSentinel shape                       | **PASS (no regression)** | `types.ts` unchanged.                                                                                                                                                                                                                 |
| step-dispatcher conversion                       | **PASS (no regression)** | `step-dispatcher.ts` unchanged.                                                                                                                                                                                                       |
| workflow-handler suspension block                | **PASS (no regression)** | `workflow-handler.ts` unchanged.                                                                                                                                                                                                      |
| Callback route decrypt + HMAC verify             | **PASS (no regression)** | `workflow-callbacks.ts` unchanged.                                                                                                                                                                                                    |
| callback-poster HMAC signing                     | **PASS (no regression)** | `callback-poster.ts` unchanged.                                                                                                                                                                                                       |
| sanitizePublishedStepData (Redis pub/sub)        | **PASS (no regression)** | `PUBLISH_SENSITIVE_STEP_FIELDS` still includes `callbackSecret` (L745).                                                                                                                                                               |
| sanitizeSnapshotDoc (WebSocket)                  | **PASS (no regression)** | `SNAPSHOT_STEP_SENSITIVE_FIELDS` still includes `callbackSecret` (wf-bridge.ts:25).                                                                                                                                                   |
| cleanExecutionDoc (REST API)                     | **PASS (no regression)** | `STEP_SENSITIVE_FIELDS` still includes `callbackSecret` (workflow-executions.ts:350). `triggerMetadata.callbackSecret` also explicitly deleted at L611, L637.                                                                         |
| Key symmetry (encrypt key == decrypt key)        | **PASS (no regression)** | Both sides use `encryptForTenantAuto`/`decryptForTenantAuto` with tenant-scoped keys. Enqueue side: `tenantEncryption` (index.ts:738-743). Dequeue side: inline service object (extraction-only.ts:67-68). Same underlying functions. |

### Check 8 -- Plaintext leak search

**PASS** -- No new leaks.

Searched all `.ts` files for `callbackSecret` in logging, console, trace, emit, and publish contexts (excluding sanitize/strip/redact/test/type files). The only match is `workflow-callbacks.ts:90` which logs a warning message ("step has no callbackSecret configured") with no value included. The raw secret value is never logged, traced, or published anywhere.

### Round 2 findings

| #    | Severity | Finding                                                     | Status                                                                                               |
| ---- | -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R1-1 | CRITICAL | BullMQ plaintext `callbackSecret` at rest in Redis          | **CLOSED** -- manifest updated, enqueue wraps, dequeue unwraps.                                      |
| R1-2 | MEDIUM   | No end-to-end test for BullMQ encrypt->decrypt->HMAC chain  | **OPEN** -- worker test still feeds plaintext data; `unwrapJobDataForDecrypt` hits the no-op branch. |
| R1-3 | LOW      | No explicit test for null callbackSecret + waiting_callback | **OPEN** -- unchanged from Round 1.                                                                  |

No new findings introduced by the fixes.

## Final verdict

**PASS** -- The Round 1 CRITICAL (plaintext `callbackSecret` at rest in Redis) is fully resolved. The manifest declares the field, the producer encrypts before `queue.add`, the consumer decrypts before reading, backward compatibility with pre-fix plaintext jobs is preserved via the `_enc` flag check, and double-encrypt is guarded against. All Round 1 PASS boundaries remain intact with no regressions. The MEDIUM and LOW findings from Round 1 remain open but are not blocking -- they represent test coverage gaps, not security vulnerabilities. The data-flow is secure.

---

# Audit — Inactivity-Timeout Patch + ADI/Docling/Studio Cleanup (Rounds R3/R4/R5)

**Date**: 2026-05-17
**Auditor**: claude-opus-4-7
**Scope**: 3 commits on top of rebased branch

- `b43e98599` — workflow-engine 1h inactivity_timeout patch + runtime WfBridge getRedisHandle
- `a1c12c84e` — connectors: sentinel resolver + ADI pages query string + error hardening
- `fd2d8a0c9` — studio: auth-profile UX + block-save validation + execute body tolerance

**Sensitive values traced this audit**:

- V1: **Azure DI `apiKey`** — CREDENTIAL
- V2: **Azure DI `endpoint` URL** — BUSINESS (SSRF surface, tenant-supplied)
- V3: **AuthProfile `decryptedSecrets`** during live-validate — CREDENTIAL
- V4: **Workflow `/execute` request body** — USER_INPUT
- V5: **Connection sentinel `system-<connector>-none`** — INTERNAL (tenant-isolation surface)
- V6: **Restate admin `inactivity_timeout` PATCH** — CONFIG (privileged ingress call)

---

## Round R3 (round 1 of this audit) — Path trace

### VALUE V1 — Azure DI apiKey

DATA CLASS: CREDENTIAL
APPROVED CONSUMERS: Azure Document Intelligence REST API (header `Ocp-Apim-Subscription-Key`); studio caller error response (NEVER the key — only Azure's textual error).

| Dim                | Trace                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` (POST `body.secrets.apiKey`) + `[profileId]/route.ts` (PATCH `body.secrets.apiKey`). Zod-validated upstream by `_piece-auth-validator`.                                                                                                                                                                                                                           |
| 2. Writes          | `auth_profiles.encryptedSecrets` (already encrypted by prior layer — confirmed via `parseAuthProfileSecrets` which decrypts only on read).                                                                                                                                                                                                                                                                                       |
| 3. Serialization   | (a) `runPieceAuthValidate({decryptedSecrets})` → validate hook receives plaintext for the duration of the call. (b) `safeFetch` POSTs `Ocp-Apim-Subscription-Key: apiKey` header to Azure DI `/documentintelligence/info?api-version=...` (probe) and `/documentmodels/{model}:analyze?...&pages=...` (extract).                                                                                                                 |
| 4. Read paths      | Decrypted only inside `runPieceAuthValidate` and inside `extract_document.ts.parseAuth(ctx.auth)`. Never logged.                                                                                                                                                                                                                                                                                                                 |
| 5. Policy boundary | (a) HTTP header to Azure — APPROVED. (b) Error response body to studio caller — Azure's textual error message captured via `safeReadText`/`resp.text()`, capped at 500 chars. Verified Azure never echoes the bad apiKey in its 401 response (`"Access denied due to invalid subscription key or wrong API endpoint"`). (c) `log.warn`/`log.error` lines — verified NO `apiKey` reference in `auth.ts` or `extract-document.ts`. |
| 6. Sinks           | Azure REST API only.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7. Wiring          | `runPieceAuthValidate` is invoked from BOTH the POST (`route.ts:475-505`) and the PATCH (`[profileId]/route.ts:356-387`) paths. Symmetry: ✓ both wired.                                                                                                                                                                                                                                                                          |
| 8. Parallel paths  | POST and PATCH validators are independent code paths but call the same `runPieceAuthValidate` helper and apply the same skip rules (`authType !== 'none' / 'oauth2_*'`). Verified identical conditional logic.                                                                                                                                                                                                                   |
| 9. Boundary tests  | Existing AP framework tests cover `safeFetch` SSRF guard; existing auth-profile tests cover validate hook invocation. **GAP**: no test asserts that on validate-fail, the FRESH row is `deleteOne`'d (POST path) AND the bridge ConnectorConnection is also deleted.                                                                                                                                                             |

**FINDINGS V1**:

- F-V1-1 (MEDIUM, Dim 9): Missing boundary regression test for POST live-validate failure cleanup. If a future change moves the validation block above the `AuthProfile.deleteOne` call or splits encryptedSecrets storage, a failed-validate row could persist with valid creds-in-name only. _Test recommendation_: integration test that POSTs with invalid Azure DI key, asserts 400, asserts `db.auth_profiles.countDocuments({connector:'azure-document-intelligence'})` unchanged from pre-call, asserts `db.connector_connections.countDocuments` unchanged.

### VALUE V2 — Azure DI endpoint URL

DATA CLASS: BUSINESS (tenant-supplied URL — SSRF surface)
APPROVED CONSUMERS: Azure DI itself (after SSRF pass); error messages to user (echoes their own input).

| Dim                | Trace                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Source          | Same as V1 (`body.config.endpoint` or via `secrets`).                                                                                                                                                                          |
| 2. Writes          | `auth_profiles.config` (cleartext — endpoint is tenant input, not secret).                                                                                                                                                     |
| 3. Serialization   | `safeFetch(url, ...)` where url is built from user-supplied endpoint string.                                                                                                                                                   |
| 4. Read paths      | Logged in `log.warn` for SSRFError / DNS failure / connect refused — endpoint is user's own data so echoing is acceptable.                                                                                                     |
| 5. Policy boundary | `auth.ts:53-67` validates via `new URL(endpoint)` with protocol allowlist (http/https only); `safeFetch` applies SSRF guard + DNS-pinning. On SSRFError, `auth.ts:116-121` returns a friendly error including the SSRF reason. |
| 6. Sinks           | Azure DI endpoint after SSRF clearance.                                                                                                                                                                                        |
| 7. Wiring          | safeFetch is the only outbound call site in `auth.ts` and `extract-document.ts`. ✓                                                                                                                                             |
| 8. Parallel paths  | Both `validate` hook (`auth.ts:75`) and `extract_document.postAnalyze` (`extract-document.ts:420`) use the same `safeFetch`. ✓                                                                                                 |
| 9. Boundary tests  | Existing `safe-fetch.test.ts` covers SSRF guard. No regression risk.                                                                                                                                                           |

**FINDINGS V2**: none.

### VALUE V3 — AuthProfile decryptedSecrets during live-validate

DATA CLASS: CREDENTIAL
APPROVED CONSUMERS: connector's `validate` hook only.

| Dim                | Trace                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | `route.ts:480` (POST: `body.secrets`) and `[profileId]/route.ts:366` (PATCH: `parseAuthProfileSecrets(doc)`).                                                                                                                                            |
| 2. Writes          | Not written anywhere from the validation path — plaintext lives only in the validate hook's call stack.                                                                                                                                                  |
| 3. Serialization   | Passed into `runPieceAuthValidate({profile, decryptedSecrets})` → `buildAuthPayload(profile, decryptedSecrets)` → `normalizeAuthForPieceValidate(connectorName, payload)` → connector's `validateAuth({auth})`.                                          |
| 4. Read paths      | Connector validate hook ONLY. Verified no `log` / `console` / `trace` references plaintext secrets.                                                                                                                                                      |
| 5. Policy boundary | Validate hook returns `{valid, error?}` — error is a string from the hook. Verified in `auth.ts` (ADI) that error strings never include `apiKey`. Verified `_piece-auth-validator.ts:1090-1093` catches hook exceptions and surfaces `err.message` only. |
| 6. Sinks           | None.                                                                                                                                                                                                                                                    |
| 7. Wiring          | ✓                                                                                                                                                                                                                                                        |
| 8. Parallel paths  | POST live-validate ↔ PATCH live-validate use IDENTICAL skip rules (`authType !== 'none' / 'oauth2_*'`). ✓                                                                                                                                                |
| 9. Boundary tests  | `_piece-auth-validator.test.ts` exists in repo. ✓                                                                                                                                                                                                        |

**FINDINGS V3**: none.

### VALUE V4 — Workflow `/execute` request body

DATA CLASS: USER_INPUT
APPROVED CONSUMERS: workflow-engine `/api/projects/:projectId/workflows/:workflowId/executions/execute` (Zod-validated downstream).

| Dim                | Trace                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts:19-26`. Reads body via `request.clone().text()`, parses if non-empty, defaults to `{}`.                                                        |
| 2. Writes          | None (proxied).                                                                                                                                                                                                               |
| 3. Serialization   | `proxyToRuntime(request, '...execute?mode=async', { body, tenantId })` — tenantId is bound from the route handler's tenant context.                                                                                           |
| 4. Read paths      | Downstream workflow-engine route handler.                                                                                                                                                                                     |
| 5. Policy boundary | Downstream Zod schema (`executeBodySchema` in `workflow-executions.ts:147`) validates `triggerType`, `workflowVersion`, `payload`, etc. Empty `{}` is acceptable for studio-triggered runs (defaults applied at engine side). |
| 6. Sinks           | Workflow-engine Restate dispatch.                                                                                                                                                                                             |
| 7. Wiring          | tenantId injected by `withRouteHandler({requireProject: true, permissions: 'workflow:execute'})` middleware. ✓                                                                                                                |
| 8. Parallel paths  | Studio Run button (empty body) vs webhook trigger (signed body) — different routes, different middleware. The /execute route only handles studio-driven runs (`triggerType: studio` enforced downstream).                     |
| 9. Boundary tests  | **GAP**: no test asserts that an empty-body POST is accepted and proxies cleanly. Trivial regression risk if a future change tightens validation.                                                                             |

**FINDINGS V4**:

- F-V4-1 (LOW, Dim 9): Add a Studio-Run-with-empty-body integration test. Pattern: `POST /api/projects/X/workflows/Y/execute` with empty body, assert 202 + executionId returned.

### VALUE V5 — Connection sentinel `system-<connector>-none`

DATA CLASS: INTERNAL
APPROVED CONSUMERS: Mongo query inside `connection-resolver.resolve()` — filtered by tenantId + projectId.

| Dim                | Trace                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Source          | Studio integration node config auto-binds via `IntegrationNodeConfig.tsx:158` (`connectionId: isNoAuth ? \`system-${selectedConnector}-none\` : ''`). Persisted to `workflow_versions.definition.nodes[].config.connectionId`. |
| 2. Writes          | Workflow definition Mongo doc (already tenant/project-scoped via `workflow_versions.tenantId/projectId`).                                                                                                                      |
| 3. Serialization   | Flows through `WorkflowExecutionInput.steps[].connectionId` → `ConnectorToolExecutor` → `connectionResolver.resolve({connectionId: 'system-X-none', tenantId, projectId})`.                                                    |
| 4. Read paths      | `connection-resolver.ts:105-120`.                                                                                                                                                                                              |
| 5. Policy boundary | Regex `/^system-(.+)-none$/` matches; query is `findOne({authProfileId, connectorName, tenantId: opts.tenantId, projectId: opts.projectId, status: 'active'})`. **Tenant + project isolation explicitly preserved.**           |
| 6. Sinks           | None.                                                                                                                                                                                                                          |
| 7. Wiring          | Single resolver, single call site. ✓                                                                                                                                                                                           |
| 8. Parallel paths  | Sentinel path (new) ↔ legacy `_id` lookup (existing) ↔ AuthProfile fallback (existing). All three queries are tenant+project-scoped. ✓                                                                                         |
| 9. Boundary tests  | **GAP**: no unit test specifically for the sentinel path.                                                                                                                                                                      |

**FINDINGS V5**:

- F-V5-1 (MEDIUM, Dim 9): Add `connection-resolver.test.ts` cases:
  - sentinel matches a connection with same tenant+project → returns it
  - sentinel matches a connection but DIFFERENT tenant → returns null/throws (tenant isolation)
  - sentinel matches a connection but DIFFERENT project → returns null/throws (project isolation)
  - sentinel pattern with regex injection (e.g. `system-x.*-none`) — confirms `connectorName` is used as a literal string in the Mongo query (not as a regex)
- F-V5-2 (LOW, Dim 5): The regex `/^system-(.+)-none$/` allows ANY chars in the connector name. If a future bug somewhere accepts a workflow definition with an attacker-controlled `connectionId`, they could match arbitrary `connectorName` field values. Currently mitigated by: (a) tenant+project scope on the resolver, (b) studio-side auto-bind only generates known connector names. _Defensive recommendation_: tighten regex to `/^system-([a-z0-9-]+)-none$/` to match the actual connector name charset.

### VALUE V6 — Restate admin `inactivity_timeout` PATCH

DATA CLASS: CONFIG
APPROVED CONSUMERS: Restate admin API only.

| Dim                | Trace                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Source          | `process.env.RESTATE_WORKFLOW_RUNNER_INACTIVITY_TIMEOUT ?? '1h'`. Operator-controlled.                                                                                                                                                   |
| 2. Writes          | None (in-memory Restate runtime state).                                                                                                                                                                                                  |
| 3. Serialization   | HTTP PATCH `{RESTATE_ADMIN_URL}/services/workflow-runner` with `{inactivity_timeout: <value>}` body. Auth: `restateAuthHeader()` (bearer if `RESTATE_INGRESS_AUTH_TOKEN` set).                                                           |
| 4. Read paths      | Restate admin API only.                                                                                                                                                                                                                  |
| 5. Policy boundary | RESTATE_ADMIN_URL is internal (`http://abl-restate:9070`). In production deployments, Restate ingress auth token MUST be set (`workflow-engine` already warns on missing token via existing `RESTATE_INGRESS_AUTH_TOKEN` startup check). |
| 6. Sinks           | Restate admin only.                                                                                                                                                                                                                      |
| 7. Wiring          | Patch fires inside `registerWithRestate()` post-registration; re-runs on every successful registration (deployment recreate, Restate state wipe). ✓                                                                                      |
| 8. Parallel paths  | No sibling path.                                                                                                                                                                                                                         |
| 9. Boundary tests  | None — but this is operator-config, not user-driven; minimal test risk.                                                                                                                                                                  |

**FINDINGS V6**:

- F-V6-1 (LOW, Dim 5): If `RESTATE_INGRESS_AUTH_TOKEN` is unset in prod (current dev-only behaviour), any cluster peer that can reach RESTATE_ADMIN_URL can also patch service config. This is pre-existing — already flagged at startup by the `Accepting requests without validating request signatures` warning. The new PATCH inherits the same guarantee as the existing registration POST.
- F-V6-2 (LOW, Dim 2): No metric for failed patches. `log.warn` only. _Recommendation_: emit a counter so ops can alert on persistent patch failure (e.g. if Restate version upgrade drops the field name).

---

## Round R3 Summary

| ID     | Severity | Dimension     | Finding                                                    | Status                          |
| ------ | -------- | ------------- | ---------------------------------------------------------- | ------------------------------- |
| F-V1-1 | MEDIUM   | Tests         | Missing regression for POST live-validate failure cleanup  | OPEN — test gap, no code change |
| F-V4-1 | LOW      | Tests         | Missing integration test for empty-body /execute           | OPEN                            |
| F-V5-1 | MEDIUM   | Tests         | Missing sentinel resolver tests (tenant/project isolation) | OPEN                            |
| F-V5-2 | LOW      | Policy        | Sentinel regex permits any chars in connector name         | OPEN — defensive tightening     |
| F-V6-1 | LOW      | Policy        | Restate admin PATCH inherits existing ingress-auth gap     | INHERITED                       |
| F-V6-2 | LOW      | Observability | No metric for patch failure                                | OPEN                            |

**No CRITICAL findings.** No new sensitive-value leak paths introduced. All persistence layers honor tenant + project isolation. The three commits do not weaken any existing policy boundary.

---

## Round R4 (round 2 of this audit) — Fix verification + parallel-path sweep

Round R3 produced no CRITICAL findings, so this round verifies (a) no regressions in already-PASSED boundaries from prior audits, (b) parallel-path symmetry between POST and PATCH validators, (c) tenant isolation across all three commits.

### Check 1 — callbackSecret policy boundary (regression check)

The prior callbackSecret audit (R1/R2 above) passed. Verify the new commits don't regress:

- `b43e98599` adds an error log in `workflow-callbacks.ts:163-167` — logs `executionId`, `stepId`, `err.message`. Does NOT log `step.callbackSecret` or any decrypted value. **PASS**.
- The 1h inactivity_timeout patch does not touch callbackSecret persistence, decryption, or HMAC flow. **PASS**.
- The connector_action suspension block in `workflow-handler.ts` got only a comment rewording. **PASS**.

### Check 2 — POST ↔ PATCH live-validate symmetry

Both routes:

- Apply identical skip rules: `authType !== 'none' && !== 'oauth2_*'`.
- Use identical `runPieceAuthValidate` invocation shape.
- On `outcome.valid === false`, return 400 `VALIDATION_ERROR`.
- POST: deletes the new row + bridge ConnectorConnection. PATCH: reverts encryptedSecrets/config/linkedAppProfileId from `existingProfile` snapshot, re-saves.

**Asymmetry** (acceptable): POST cleanup deletes the record; PATCH cleanup reverts in-place. Different mechanisms because POST creates a new row whereas PATCH mutates an existing one. Both leave the system in a consistent state.

**PASS**.

### Check 3 — Tenant isolation across the three commits

| Surface                                    | Filter                                                                                                                          | Verdict       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Connection resolver sentinel path          | `{authProfileId, connectorName, tenantId, projectId, status: 'active'}`                                                         | ✓             |
| Connection resolver legacy `_id` path      | `{_id, tenantId, projectId, status: 'active'}`                                                                                  | ✓ (unchanged) |
| Connection resolver AuthProfile fallback   | `{_id, tenantId, $or: [{projectId}, {projectId: null, scope: 'tenant'}], status: 'active'}`                                     | ✓ (unchanged) |
| Auth-profile POST live-validate cleanup    | `AuthProfile.deleteOne({_id, tenantId})` + `ConnectorConnection.deleteOne({tenantId, projectId, connectorName, authProfileId})` | ✓             |
| Auth-profile PATCH live-validate cleanup   | mutates `doc` (already tenant+project scoped via `withRouteHandler`)                                                            | ✓             |
| Workflow `/execute` proxy                  | tenantId bound from `withRouteHandler({requireProject: true})`                                                                  | ✓             |
| Studio integration node sentinel auto-bind | Persists into project-scoped `workflow_versions.definition`                                                                     | ✓             |
| Restate `/services/workflow-runner` PATCH  | Restate admin endpoint; no tenant context (single service per Restate cluster)                                                  | ✓             |

### Check 4 — Replay / idempotency safety

- The inactivity_timeout PATCH is idempotent (Restate admin API is PUT-semantics; same body, same result).
- Connection-resolver sentinel: read-only, idempotent.
- Auth-profile POST live-validate cleanup: deletes by `_id` + `tenantId` — idempotent (no-op if already deleted by retry).
- PATCH live-validate cleanup: rewrites `doc` in-place — idempotent.
- `/execute` empty body tolerance: input parsing only, no side effect.

All paths idempotent. **PASS**.

### Check 5 — Studio UI input → backend trust boundary

Studio's `IntegrationNodeConfig.tsx:152-153` reads `catalog.find(...)?.authType` from a freshly-fetched API response. The catalog API is the source of truth — UI cannot inject arbitrary authType. **PASS**.

### Round R4 findings

| #   | Severity | Finding           | Status |
| --- | -------- | ----------------- | ------ |
| —   | —        | (no new findings) | —      |

No regressions. All R3 findings (test gaps + defensive tightenings) remain open but unchanged.

---

## Round R5 (round 3 of this audit) — Coverage assessment + final sign-off

### Recommended additions before BETA gate

| Finding | Action                                                                                                                                               | Owner | Effort |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| F-V1-1  | Add integration test: POST auth-profile with invalid ADI key → assert 400 + no rows persisted                                                        | TBD   | 1 hr   |
| F-V4-1  | Add integration test: POST /execute with empty body → assert 202 + executionId                                                                       | TBD   | 30 min |
| F-V5-1  | Add unit test suite for `connection-resolver` sentinel path: 4 scenarios (same tenant/project ✓, cross-tenant ✗, cross-project ✗, regex injection ✗) | TBD   | 1 hr   |
| F-V5-2  | Tighten regex to `/^system-([a-z0-9-]+)-none$/`                                                                                                      | TBD   | 15 min |
| F-V6-2  | Add OTel counter for patch failure                                                                                                                   | TBD   | 30 min |

### Existing test coverage (preserves correctness)

- `apps/workflow-engine/src/__tests__/workflow-callbacks.test.ts` — HMAC + status semantics. Covers the Round R1 callbackSecret boundary.
- `apps/studio/src/app/api/auth-profiles/_piece-auth-validator.test.ts` — validate hook invocation (live + built-in checks).
- Existing AP framework + safeFetch tests cover SSRF.
- Existing `parseAuthProfileSecrets` decryption tests.

### Final verdict

| Criterion                                                               | Status                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| No CRITICAL findings                                                    | ✓                                              |
| No HIGH findings                                                        | ✓                                              |
| MEDIUM findings                                                         | 2 (test gaps, no code defect)                  |
| LOW findings                                                            | 4 (defensive recommendations + inherited gaps) |
| Tenant + project isolation preserved on all new code paths              | ✓                                              |
| No new sensitive-value sink unaccounted for                             | ✓                                              |
| Parallel POST/PATCH validator symmetry                                  | ✓                                              |
| Replay/idempotency safe                                                 | ✓                                              |
| Restate admin PATCH inherits existing ingress auth gap (not regression) | ✓                                              |

**Sign-off: PASS.** The three commits are safe to ship for `auth.type='none'` connectors and async waits <1h. Multi-day async waits (e.g. multi-day approval steps) remain blocked by the Restate suspended-state re-dispatch issue documented elsewhere — that requires the architectural fix tracked separately, not gated by this audit.

The five MEDIUM/LOW findings are test-coverage and defensive-tightening improvements; none block shipping. Recommend addressing F-V5-2 (regex tightening) as a one-line follow-up; the test gaps belong in the BETA-ready hardening pass.

---

# Audit — Re-run after F-V5-2 fix (Rounds R6/R7/R8)

**Date**: 2026-05-17
**Auditor**: claude-opus-4-7
**Scope**: 1 follow-up commit

- `82367ef4e` — `fix(connectors): tighten sentinel resolver regex to connector-name charset`

**Trigger**: User requested re-audit after applying the F-V5-2 defensive tightening.

**Sensitive values re-traced**:

- V5 (re-trace): Connection sentinel `system-<connector>-none`

---

## Round R6 — Verify F-V5-2 closes the gap

### Before

```ts
const sentinelMatch = /^system-(.+)-none$/.exec(opts.connectionId);
```

### After

```ts
const sentinelMatch = /^system-([a-z0-9-]+)-none$/.exec(opts.connectionId);
```

### Behavioral consequence

| Input                                     | Old regex match[1]            | New regex match[1]            | Outcome                                      |
| ----------------------------------------- | ----------------------------- | ----------------------------- | -------------------------------------------- |
| `system-docling-none`                     | `docling`                     | `docling`                     | ✓ same                                       |
| `system-azure-document-intelligence-none` | `azure-document-intelligence` | `azure-document-intelligence` | ✓ same                                       |
| `system-Foo-none`                         | `Foo` (uppercase)             | no match                      | ✓ tightened — registry uses lowercase        |
| `system-x/../y-none`                      | `x/../y`                      | no match                      | ✓ removed injection-shaped substring         |
| `system-x.*-none`                         | `x.*`                         | no match                      | ✓ removed regex-meta substring               |
| `system--none`                            | `` (empty)                    | no match                      | ✓ improved — empty connector name is illegal |
| `system-_-none`                           | `_`                           | no match                      | ✓ tightened — registry doesn't use `_`       |

The new charset `[a-z0-9-]+` is a strict superset of all currently-registered connector names (per `packages/connectors/catalog/json` — verified via grep). No legitimate connectionId rejected; injection-shaped substrings now rejected at the regex layer instead of relying solely on the downstream Mongo filter.

### Existing tenant+project scope still in place

`apps/workflow-engine/.../connection-resolver.ts:106-119` — query unchanged:

```ts
this.connectionModel.findOne({
  authProfileId: opts.connectionId,
  connectorName: sentinelMatch[1],
  tenantId: opts.tenantId,
  projectId: opts.projectId,
  status: 'active',
});
```

Defense-in-depth: even if a future change loosens the regex again, tenant+project scope on the Mongo filter still bounds blast radius to the same tenant+project.

### Verdict R6

**PASS** — F-V5-2 closed. The sentinel resolver now has two independent guards (regex charset + Mongo tenant/project filter); a single layer failure does not yield cross-scope access.

---

## Round R7 — Side-effects sweep on the regex change

### Did the regex change affect any other code path?

`grep -rn "system-.*-none\|/\^system-" packages apps --include='*.ts'`:

- `packages/connectors/src/auth/connection-resolver.ts:114` — the regex itself (this change).
- `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx:158` — generates `system-${selectedConnector}-none` from catalog connector names. Catalog names are lowercase + digits + hyphen by convention. **PASS** — generator output matches new regex charset.
- `apps/studio/src/components/workflows/canvas/config/TestActionModal.tsx:93` — same sentinel pattern check using literal `/^system-.+-none$/`. **GAP — inconsistency**.

### F-V7-1 (NEW, MEDIUM): Studio TestActionModal sentinel-detection regex is looser than resolver

`apps/studio/src/components/workflows/canvas/config/TestActionModal.tsx` line 93:

```ts
const isNoAuthConnector =
  nodeConnectionId === `system-${connectorId}-none` || /^system-.+-none$/.test(nodeConnectionId);
```

This client-side regex is used only to hide the picker / skip a UI gate — it has no security consequence (the actual resolution runs server-side in `connection-resolver`). But the inconsistency is a maintenance risk: someone reading TestActionModal might assume the regex matches the resolver. Tighten for consistency.

**Fix recommended** but not required for security.

### Anything else changed?

- No imports added/removed.
- No new persistence sites.
- No new HTTP calls.
- No new logs.

**Verdict R7**: F-V7-1 NEW MEDIUM (consistency); no security regression.

---

## Round R8 — Final coverage + sign-off

### Findings reconciliation across all 5 audit rounds

| ID         | Severity   | Status                      | Notes                                      |
| ---------- | ---------- | --------------------------- | ------------------------------------------ |
| F-V1-1     | MEDIUM     | OPEN — test gap             | Track in BETA hardening                    |
| F-V4-1     | LOW        | OPEN — test gap             | Track in BETA hardening                    |
| F-V5-1     | MEDIUM     | OPEN — test gap (4 cases)   | Track in BETA hardening                    |
| F-V5-2     | LOW        | **CLOSED** in `82367ef4e` ✓ | Verified R6                                |
| F-V6-1     | LOW        | INHERITED                   | Pre-existing                               |
| F-V6-2     | LOW        | OPEN — observability gap    | Track in BETA hardening                    |
| **F-V7-1** | **MEDIUM** | **NEW**                     | Studio TestActionModal regex inconsistency |

### Verdict R8

| Criterion                                 | Status                  |
| ----------------------------------------- | ----------------------- |
| All CRITICAL closed                       | ✓ (none existed)        |
| All HIGH closed                           | ✓ (none existed)        |
| F-V5-2 (defensive regex tightening)       | ✓ closed in `82367ef4e` |
| New finding F-V7-1 (cosmetic consistency) | OPEN — not blocking     |
| Tenant + project isolation preserved      | ✓                       |
| Replay/idempotency safe                   | ✓                       |
| No new sinks                              | ✓                       |

**Sign-off: PASS.** The follow-up commit closes F-V5-2 without introducing any regressions. The new F-V7-1 is a consistency issue in client-side UI code with no security impact — recommended for a future cleanup pass, not blocking.

**Net state of the 4 commits (`b43e98599`, `a1c12c84e`, `fd2d8a0c9`, `82367ef4e`)**: production-ready for the in-scope flows (Docling/ADI/auth.type=none + async waits <1h). Multi-day async waits remain outside this audit's scope (requires the BullMQ-driven workflow resumption refactor tracked separately).
