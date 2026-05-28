# Security Hardening — Complete Test Manifest

This companion document to the main implementation plan details:

1. **Every new test case** to be added (organized by new test file)
2. **Every existing test case** that breaks and how to fix it

---

## Part A: New Test Files & Cases

### A1. `apps/runtime/src/__tests__/session-repo-isolation.test.ts`

**Tests the fix for:** CRIT-4 (conditional tenantId in session-repo)

| #   | Test Case                                                       | Asserts                                                             |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `findSessionById rejects empty-string tenantId`                 | Throws `'tenantId is required'`                                     |
| 2   | `findSessionById rejects undefined tenantId`                    | TypeScript compile error (param is `string`) — runtime guard throws |
| 3   | `findSessionById includes tenantId in MongoDB filter`           | `Session.findOne` called with `{ _id, tenantId }`                   |
| 4   | `findSessionById returns null for valid id with wrong tenantId` | Returns `null` (not the doc from another tenant)                    |
| 5   | `findSessionByRuntimeId rejects empty-string tenantId`          | Throws                                                              |
| 6   | `findSessionByRuntimeId includes tenantId in filter`            | `Session.findOne` called with `{ runtimeSessionId, tenantId }`      |
| 7   | `updateSession rejects empty-string tenantId`                   | Throws                                                              |
| 8   | `updateSession scopes update by tenantId`                       | `findOneAndUpdate` filter includes `tenantId`                       |
| 9   | `updateSessionActivity rejects empty-string tenantId`           | Throws                                                              |
| 10  | `incrementSessionTokens rejects empty-string tenantId`          | Throws                                                              |
| 11  | `incrementSessionMetrics rejects empty-string tenantId`         | Throws                                                              |
| 12  | `unlinkContactFromSessions rejects empty-string tenantId`       | Throws                                                              |
| 13  | `deleteSessionsByIds rejects empty-string tenantId`             | Throws                                                              |
| 14  | `deleteSessionsByIdsSystem works without tenantId (system job)` | Succeeds (unscoped variant for cleanup)                             |

---

### A2. `apps/runtime/src/__tests__/contacts-tenant-isolation.test.ts`

**Tests the fix for:** H-1 (contact CRUD without tenantId)

| #   | Test Case                                                          | Asserts                          |
| --- | ------------------------------------------------------------------ | -------------------------------- |
| 1   | `GET /:id returns 404 when contact belongs to different tenant`    | Status 404, not the contact data |
| 2   | `GET /:id returns 200 when contact belongs to same tenant`         | Status 200 with contact data     |
| 3   | `PUT /:id returns 404 when contact belongs to different tenant`    | Status 404                       |
| 4   | `PUT /:id updates contact when same tenant`                        | Status 200                       |
| 5   | `DELETE /:id returns 404 when contact belongs to different tenant` | Status 404                       |
| 6   | `DELETE /:id soft-deletes when same tenant`                        | Status 200                       |
| 7   | `GET / rejects invalid contact type (NoSQL injection)`             | Status 400 for `type={"$gt":""}` |
| 8   | `GET / rejects non-numeric limit`                                  | Status 400 for `limit=abc`       |
| 9   | `GET / rejects limit > 1000`                                       | Status 400                       |
| 10  | `GET / accepts valid type enum`                                    | Status 200 for `type=customer`   |

---

### A3. `apps/runtime/src/__tests__/contacts-cursor-validation.test.ts`

**Tests the fix for:** CRIT-6 (unvalidated cursor)

| #   | Test Case                                            | Asserts                                                        |
| --- | ---------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `returns 400 for completely invalid cursor string`   | Status 400, error code `INVALID_CURSOR`                        |
| 2   | `returns 400 for cursor that is a JS prototype key`  | Status 400 for `cursor=__proto__`                              |
| 3   | `returns 400 for cursor with huge number string`     | Status 400 for `cursor=999999999999999999999`                  |
| 4   | `accepts valid ISO 8601 cursor with timezone`        | Status 200 for `cursor=2026-01-01T00:00:00.000Z`               |
| 5   | `accepts valid ISO 8601 cursor without milliseconds` | Status 200 for `cursor=2026-01-01T00:00:00Z`                   |
| 6   | `filter uses validated Date in $lt query`            | MongoDB filter contains `{ timestamp: { $lt: <valid Date> } }` |

---

### A4. `apps/runtime/src/__tests__/connection-resolver-isolation.test.ts`

**Tests the fix for:** H-2 (connection-resolver findById without tenant)

| #   | Test Case                                                                         | Asserts                                              |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | `resolveConnectionById with tenantId scopes query`                                | `findOne` called with `{ _id, tenantId }`            |
| 2   | `resolveConnectionById returns null for wrong tenant`                             | Returns `null`                                       |
| 3   | `resolveConnectionById returns connection for correct tenant`                     | Returns the connection                               |
| 4   | `resolveConnectionById without tenantId falls back to unscoped (backward compat)` | Returns connection (for callback paths with no auth) |

---

### A5. `apps/runtime/src/__tests__/tenant-model-repo-isolation.test.ts`

**Tests the fix for:** H-3 (tenant-model-repo unscoped queries)

| #   | Test Case                                                  | Asserts                                       |
| --- | ---------------------------------------------------------- | --------------------------------------------- |
| 1   | `findTenantModelConnections rejects empty tenantId`        | Throws                                        |
| 2   | `findTenantModelConnections scopes by tenantId`            | `findOne` filter includes `tenantId`          |
| 3   | `findTenantModelConnections returns null for wrong tenant` | Returns `null`                                |
| 4   | `createTenantModelConnection rejects missing tenantId`     | Throws                                        |
| 5   | `createTenantModelConnection scopes update by tenantId`    | `findOneAndUpdate` filter includes `tenantId` |
| 6   | `findTenantModel rejects empty tenantId`                   | Throws                                        |
| 7   | `findTenantModel scopes by tenantId`                       | `findOne({ _id, tenantId })` called           |
| 8   | `updateTenantModel rejects empty tenantId`                 | Throws                                        |

---

### A6. `apps/runtime/src/__tests__/mongo-message-store-isolation.test.ts`

**Tests the fix for:** H-9 (getMessages without tenantId — `QueryMessagesParams` has NO tenantId field; must be added)

| #   | Test Case                                                              | Asserts                                                               |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `getMessages throws when tenantId is missing`                          | Throws `'tenantId is required'`                                       |
| 2   | `getMessages throws when tenantId is empty string`                     | Throws                                                                |
| 3   | `getMessages includes tenantId in MongoDB filter`                      | `MessageModel.find` called with `{ sessionId, tenantId }`             |
| 4   | `getMessages returns empty array for wrong tenant`                     | Returns `[]` (no cross-tenant messages)                               |
| 5   | `getMessageCount also enforces tenantId`                               | Throws without tenantId                                               |
| 6   | `deleteBySession also enforces tenantId`                               | Throws without tenantId                                               |
| 7   | `InMemoryMessageStore.getMessages accepts tenantId param`              | No error when called with `{ sessionId, tenantId }`                   |
| 8   | `InMemoryMessageStore.getMessages works without filtering by tenantId` | Returns messages regardless of tenantId value (dev store)             |
| 9   | `ClickHouseMessageStore.getMessages accepts tenantId in params`        | No error; optionally cross-checks `params.tenantId === this.tenantId` |

---

### A7. `apps/runtime/src/__tests__/sessions-regex-injection.test.ts`

**Tests the fix for:** CRIT-5 ($regex injection)

| #   | Test Case                                                     | Asserts                                                      |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `escapes regex metacharacters in agentName`                   | `$regex` value has metacharacters escaped (`\^`, `\(`, etc.) |
| 2   | `rejects agentName exceeding 200 characters`                  | Status 400                                                   |
| 3   | `accepts normal agentName with no special chars`              | Status 200, query uses escaped value                         |
| 4   | `does not cause ReDoS with catastrophic backtracking pattern` | Completes within 100ms (not 30s+)                            |
| 5   | `treats agentName as case-insensitive substring match`        | `$options: 'i'` preserved                                    |

---

### A8. `apps/runtime/src/__tests__/ws-twilio-auth.test.ts`

**Tests the fix for:** CRIT-3 (Twilio WS no auth)

| #   | Test Case                                                        | Asserts                                                    |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `rejects start event without tenantId`                           | WS closed with code 1008                                   |
| 2   | `rejects start event without projectId`                          | WS closed with code 1008                                   |
| 3   | `rejects start event with tenantId that has no matching session` | WS closed with code 1008                                   |
| 4   | `accepts start event with valid pre-existing session`            | WS remains open, media session created                     |
| 5   | `rejects start event with tenantId mismatched to session`        | WS closed (session exists but belongs to different tenant) |

---

### A9. `apps/runtime/src/__tests__/pii-sandbox-escape.test.ts`

**Tests the fix for:** CRIT-7 (vm sandbox escape)

| #   | Test Case                                      | Asserts                                                |
| --- | ---------------------------------------------- | ------------------------------------------------------ |
| 1   | `rejects constructor chain escape expression`  | Throws `'must be a valid regex pattern'`               |
| 2   | `rejects globalThis access expression`         | Throws                                                 |
| 3   | `rejects require() call expression`            | Throws                                                 |
| 4   | `rejects process.env access expression`        | Throws                                                 |
| 5   | `rejects arbitrary function body`              | Throws                                                 |
| 6   | `accepts valid simple regex`                   | Returns validator function                             |
| 7   | `accepts regex with character classes`         | Returns validator, `validator('ABC')` returns expected |
| 8   | `accepts regex with quantifiers`               | Validator works correctly                              |
| 9   | `rejects regex with catastrophic backtracking` | Throws `'catastrophic backtracking'`                   |
| 10  | `validator function returns boolean`           | `typeof validator('test') === 'boolean'`               |

**Note:** These tests verify the regex-only allowlist approach. They do NOT test vm escape chains (which are removed). The test validates that non-regex expressions are rejected at the parsing stage, not at the execution stage.

---

### A10. `apps/runtime/src/__tests__/pii-testpattern-redos.test.ts`

**Tests the fix for:** CRIT-8 (testPattern ReDoS)

| #   | Test Case                                                       | Asserts                                                                                 |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `rejects validate expression with catastrophic backtracking`    | `buildSandboxedValidator` throws `'catastrophic backtracking'` before regex is executed |
| 2   | `completes within timeout for benign validator`                 | Returns without error (no timing assertion — correctness only)                          |
| 3   | `uses buildSandboxedValidator instead of raw RegExp`            | Validation goes through the safe path                                                   |
| 4   | `returns unfiltered detections when validator is invalid regex` | Catches error, returns all detections                                                   |
| 5   | `filters detections correctly with valid validator`             | Only matching detections returned                                                       |

---

### A11. `apps/runtime/src/__tests__/alert-config-ssrf.test.ts`

**Tests the fix for:** H-6 (alert webhook SSRF)

| #   | Test Case                                                  | Asserts                             |
| --- | ---------------------------------------------------------- | ----------------------------------- |
| 1   | `rejects webhook target pointing to AWS metadata endpoint` | Status 400, code `INVALID_URL`      |
| 2   | `rejects webhook target pointing to 10.x.x.x`              | Status 400                          |
| 3   | `rejects webhook target pointing to 192.168.x.x`           | Status 400                          |
| 4   | `rejects webhook target pointing to 127.0.0.1`             | Status 400                          |
| 5   | `rejects webhook target pointing to localhost`             | Status 400                          |
| 6   | `accepts webhook target pointing to public HTTPS URL`      | Status 200/201                      |
| 7   | `PATCH also validates updated webhook target`              | Status 400 for private IP on update |
| 8   | `email channel target is not SSRF-checked`                 | Status 200 for email target         |

---

### A12. `apps/runtime/src/__tests__/callback-hmac-enforcement.test.ts`

**Tests the fix for:** H-8 (HMAC bypass)

| #   | Test Case                                                                    | Asserts                                        |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `rejects callback when secret is configured but signature header is missing` | Status 401                                     |
| 2   | `rejects callback when signature is present but incorrect`                   | Status 401                                     |
| 3   | `accepts callback when signature is valid HMAC-SHA256`                       | Status 200                                     |
| 4   | `returns 503 when secret decryption fails (DB error)`                        | Status 503, not 200                            |
| 5   | `allows callback when no secret is configured (unsigned callbacks)`          | Status 200                                     |
| 6   | `uses timing-safe comparison for signature verification`                     | No timing side channel                         |
| 7   | `accepts signature with sha256= prefix format`                               | Status 200 when header is `sha256=<valid-hex>` |

---

### A13. `apps/runtime/src/__tests__/ws-max-payload.test.ts`

**Tests the fix for:** M-3 (no maxPayload)

| #   | Test Case                                           | Asserts                    |
| --- | --------------------------------------------------- | -------------------------- |
| 1   | `SDK WS disconnects client sending > 512KB frame`   | WS close event received    |
| 2   | `SDK WS accepts frame under 512KB`                  | Message processed normally |
| 3   | `Twilio WS disconnects client sending > 64KB frame` | WS close event received    |
| 4   | `Debug WS disconnects client sending > 512KB frame` | WS close event received    |

---

### A14. `apps/runtime/src/__tests__/trace-store-limits.test.ts`

**Tests the fix for:** M-4 (TraceStore no max cap)

| #   | Test Case                                          | Asserts                                       |
| --- | -------------------------------------------------- | --------------------------------------------- |
| 1   | `evicts oldest session when max cap is reached`    | `sessions.size <= maxSessions` after overflow |
| 2   | `evicted session is the one with oldest insertion` | First-inserted session is gone                |
| 3   | `new session is successfully added after eviction` | Latest session is retrievable                 |
| 4   | `cleanup still works after eviction`               | Time-based cleanup runs without error         |
| 5   | `default maxSessions is 50000`                     | Constructor defaults correctly                |

---

### A15. `apps/runtime/src/__tests__/otel-trace-bridge-cleanup.test.ts`

**Tests the fix for:** M-5 (activeSpans leak)

| #   | Test Case                                     | Asserts                                         |
| --- | --------------------------------------------- | ----------------------------------------------- |
| 1   | `ends orphaned spans during cleanup`          | `span.end()` called for spans without a session |
| 2   | `removes orphaned spans from activeSpans map` | `activeSpans.size === 0` after cleanup          |
| 3   | `does not end spans for active sessions`      | Active session spans are preserved              |
| 4   | `handles span.end() throwing gracefully`      | No error propagation                            |

---

### A16. `apps/runtime/src/__tests__/contacts-link-session-isolation.test.ts`

**Tests the fix for:** G1 (POST /:id/link-session without tenantId)

| #   | Test Case                                                                     | Asserts                          |
| --- | ----------------------------------------------------------------------------- | -------------------------------- |
| 1   | `POST /:id/link-session returns 404 when contact belongs to different tenant` | Status 404                       |
| 2   | `POST /:id/link-session succeeds when contact belongs to same tenant`         | Status 200                       |
| 3   | `POST /:id/link-session requires valid sessionId`                             | Status 400 for missing sessionId |

---

### A17. `apps/runtime/src/__tests__/mongo-conversation-store-isolation.test.ts`

**Tests the fix for:** G2 (conversation store tenant isolation)

| #   | Test Case                                                             | Asserts                                 |
| --- | --------------------------------------------------------------------- | --------------------------------------- |
| 1   | `getConversation rejects empty tenantId`                              | Throws `'tenantId is required'`         |
| 2   | `getConversation scopes query by tenantId`                            | MongoDB filter includes `tenantId`      |
| 3   | `linkContact rejects empty tenantId`                                  | Throws                                  |
| 4   | `deleteBySession rejects empty tenantId`                              | Throws                                  |
| 5   | `endSession rejects when ALS tenant context mismatches session owner` | Returns null or throws                  |
| 6   | `updateSessionContext scopes by tenant`                               | Only updates for matching tenant        |
| 7   | `getConversation returns null for cross-tenant access`                | Tenant-A cannot read tenant-B's session |

---

### A18. `apps/runtime/src/__tests__/ws-subscribe-session-isolation.test.ts`

**Tests the fix for:** H-4 (subscribe_session no tenant check)

| #   | Test Case                                               | Asserts                                       |
| --- | ------------------------------------------------------- | --------------------------------------------- |
| 1   | `rejects subscription to session from different tenant` | Error response sent, not trace events         |
| 2   | `accepts subscription to session from same tenant`      | Trace events dispatched                       |
| 3   | `rejects subscription when client has no tenantId`      | Error response `'Authentication required'`    |
| 4   | `falls back to DB when session not in memory`           | `findSessionByRuntimeId` called with tenantId |

---

### A19. `apps/runtime/src/__tests__/ws-resume-session-isolation.test.ts`

**Tests the fix for:** H-5 (resume_session no tenant check)

| #   | Test Case                                         | Asserts                                     |
| --- | ------------------------------------------------- | ------------------------------------------- |
| 1   | `rejects resume of session from different tenant` | `session_expired` message sent              |
| 2   | `accepts resume of session from same tenant`      | Session resumed successfully                |
| 3   | `checks tenant on Redis-rehydrated session`       | Tenant mismatch after Redis lookup rejected |

---

### A20. `apps/runtime/src/__tests__/workflow-zod-validation.test.ts`

**Tests the fix for:** M-6 (raw req.body spread in workflow create)

| #   | Test Case                              | Asserts                                     |
| --- | -------------------------------------- | ------------------------------------------- |
| 1   | `ignores extra fields in request body` | `_id` not injected from request             |
| 2   | `ignores createdAt override attempt`   | `createdAt` is server-generated             |
| 3   | `accepts valid workflow fields`        | Workflow created with only validated fields |

---

### A21. `apps/runtime/src/__tests__/config-redaction.test.ts`

**Tests the fix for:** H-10 (Redis URL with password in startup logs)

| #   | Test Case                                        | Asserts                                   |
| --- | ------------------------------------------------ | ----------------------------------------- |
| 1   | `redacts password from Redis URL in startup log` | Output contains `***` not actual password |
| 2   | `preserves host and port in redacted URL`        | Output contains `redis-host:6380`         |
| 3   | `handles Redis URL without credentials`          | No crash, URL logged as-is                |

---

### A22. `apps/runtime/src/__tests__/metrics-buffer-cap.test.ts`

**Tests the fix for:** M-2 (metricsBuffer unbounded growth)

| #   | Test Case                                           | Asserts                                    |
| --- | --------------------------------------------------- | ------------------------------------------ |
| 1   | `drops oldest entries when buffer exceeds max size` | `metricsBuffer.size <= MAX_METRICS_BUFFER` |
| 2   | `evicts ~10% of entries on overflow`                | Size reduced by expected amount            |
| 3   | `newest entries preserved after eviction`           | Latest entry is retrievable                |
| 4   | `logs warning on eviction`                          | Logger called with eviction message        |

---

### A23. `packages/compiler/src/__tests__/constructs/mcp-tool-result-cap.test.ts`

**Tests the fix for:** M-8 (MCP tool result no size cap)

| #   | Test Case                               | Asserts                                                        |
| --- | --------------------------------------- | -------------------------------------------------------------- |
| 1   | `truncates result exceeding 100K chars` | Result length <= MAX_MCP_RESULT_CHARS + truncation suffix      |
| 2   | `appends truncation notice`             | Result ends with `'[truncated -- result exceeded size limit]'` |
| 3   | `does not truncate result under limit`  | Full result preserved                                          |

---

### A24. Tests added to existing files (not new files)

These tasks add test cases to existing test files rather than creating new files:

| Task       | Finding                     | Target Test File                 | New Test Cases                                                                                                                                                                                                                   |
| ---------- | --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.4 (M-1)  | X-Forwarded-For spoofing    | `ws-sdk-handler.test.ts`         | 1. `uses socket remoteAddress when X-Forwarded-For is spoofed` — verifies rate limiter uses rightmost IP, not client-controlled header<br>2. `extracts rightmost IP from multi-value XFF header` — verifies `a, b, c` yields `c` |
| 5.2 (H-7)  | DNS-resolving validator     | `tenant-model-routes.test.ts`    | 1. `rejects endpoint URL that DNS-rebinds to private IP` — assertUrlSafeForSSRF called<br>2. `accepts valid public endpoint URL` — passes validation                                                                             |
| 5.3 (M-9)  | stdio MCP allowlist         | `inline-mcp-provider.test.ts`    | 1. `rejects stdio transport with disallowed command` — returns undefined for `/bin/bash`<br>2. `allows stdio transport with node command` — returns client for `node`                                                            |
| 5.4 (M-11) | SSRF dev options            | `ssrf-validator.test.ts`         | 1. `does NOT allow private ranges in staging` — returns `{}`<br>2. `allows private ranges when ALLOW_SSRF_PRIVATE_RANGES=true` — returns permissive                                                                              |
| 6.3 (H-11) | SSE error sanitization      | `chat-routes.test.ts`            | 1. `SSE error event contains generic message, not raw error` — verifies `'An error occurred...'`                                                                                                                                 |
| 6.4 (M-12) | Error response sanitization | `project-settings-route.test.ts` | 1. `4xx response contains generic error, not internal details` — verifies generic message                                                                                                                                        |
| 7.5 (M-10) | Guardrail fail-closed       | `custom-http.test.ts`            | 1. `fails closed when failMode is "closed"` — severity is `critical`<br>2. `fails open by default` — backward compat, severity is `safe`                                                                                         |

---

## Part B: Existing Test Cases That Break

**Total: ~90 breaking tests across 17 files (out of ~400+ total). 15 files have zero breakage.**

---

### B1. `apps/runtime/src/__tests__/repos-session.test.ts` — 16 tests need update (after Task 1.1)

| #   | Test Name                                                  | Line | Why It Breaks                                                        | Fix                                                   |
| --- | ---------------------------------------------------------- | ---- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | `returns session with normalized id when found`            | ~115 | `findSessionById(session._id)` — missing tenantId                    | Add `'tenant-1'` as 2nd arg                           |
| 2   | `returns null when session does not exist`                 | ~126 | `findSessionById('nonexistent-id')` — missing tenantId               | Add `'tenant-1'` as 2nd arg                           |
| 3   | `excludes context and metadata fields from projection`     | ~131 | `findSessionById(session._id)` — missing tenantId                    | Add `'tenant-1'` as 2nd arg                           |
| 4   | `returns null when runtimeSessionId does not match`        | ~177 | `findSessionByRuntimeId('rt-nonexistent')` — missing tenantId        | Add `'tenant-1'` as 2nd arg                           |
| 5   | `updates lastActivityAt and increments messageCount`       | ~349 | `updateSessionActivity(session._id, 3)` — missing tenantId           | Add `'tenant-1'` as 3rd arg                           |
| 6   | `atomically increments tokenCount and estimatedCost`       | ~370 | `incrementSessionTokens(session._id, 250, 0.005)` — missing tenantId | Add `'tenant-1'` as 4th arg                           |
| 7   | `increments traceEventCount`                               | ~386 | `incrementSessionMetrics(session._id, ...)` — missing tenantId       | Add `'tenant-1'` as last arg                          |
| 8   | `increments errorCount and handoffCount together`          | ~395 | Same                                                                 | Add tenantId                                          |
| 9   | `no-ops when all increments are zero or undefined`         | ~405 | Same                                                                 | Add tenantId                                          |
| 10  | `updates and returns the modified session`                 | ~318 | `updateSession(session._id, {...})` — missing tenantId               | Add `'tenant-1'` as 3rd arg                           |
| 11  | `returns null when session does not exist` (updateSession) | ~327 | `updateSession('nonexistent-id', {...})` — missing tenantId          | Add `'tenant-1'` as 3rd arg                           |
| 12  | `only updates specified fields without overwriting others` | ~332 | `updateSession(session._id, {...})` — missing tenantId               | Add `'tenant-1'` as 3rd arg                           |
| 13  | `unlinkContactFromSessions removes contact`                | ~425 | `unlinkContactFromSessions('contact-1')` — missing tenantId          | Add `'tenant-1'` as 2nd arg                           |
| 14  | `deleteSessionsByIds removes sessions`                     | ~781 | `deleteSessionsByIds([...])` — missing tenantId                      | Switch to `deleteSessionsByIdsSystem` or add tenantId |
| 15  | `deleteSessionsByIds handles empty array`                  | ~789 | `deleteSessionsByIds([])` — missing tenantId                         | Switch to `deleteSessionsByIdsSystem` or add tenantId |
| 16  | `returns session when found by runtimeSessionId`           | ~170 | `findSessionByRuntimeId('rt-abc-123')` — missing tenantId            | Add `'tenant-1'` as 2nd arg                           |

**16 other tests unaffected** (already pass tenantId or test different functions).

---

### B2. `apps/runtime/src/__tests__/session-routes.test.ts` — 0 breaks

All session-repo mocks use `(...args: any[])` spread signatures and the test setup provides `tenantContext` with a valid `tenantId`. Route handlers pass tenantId from `req.tenantContext.tenantId` which is present in all tests. Mocks accept any arguments regardless of the new required parameter.

**~30+ tests unaffected.**

---

### B3. `apps/runtime/src/__tests__/contact-routes.test.ts` — 0 breaks

Tests call inline mock `contactStore` directly (closure-scoped `vi.fn().mockResolvedValue(...)`), not through the Express router. The mock accepts any number of arguments regardless of signature changes. 0 tests break.

**~21 tests unaffected.**

---

### B4. `apps/runtime/src/__tests__/contacts-authz.test.ts` — 0 breaks

All mocks use `vi.fn().mockResolvedValue(...)` which accepts any arguments. No `toHaveBeenCalledWith` assertions on `getById` or `softDelete` exist. Route handler changes don't affect these tests since they test through the Express router but the mock store ignores argument counts.

**~20 tests unaffected.**

---

### B5. `apps/runtime/src/__tests__/tenant-models.test.ts` — 0 breaks

Tests only mock LLM resolution repo functions. No signature changes to the functions tested here.

---

### B6. `apps/runtime/src/__tests__/tenant-model-routes.test.ts` — 0 breaks

Mocks use flexible signatures (`...args`). Route handlers already pass tenantId from `req.tenantContext.tenantId`.

---

### B7. `apps/runtime/src/__tests__/tenant-models-authz.test.ts` — 0 breaks

Same pattern as B6 — mocks accept any args.

---

### B8. `apps/runtime/src/__tests__/websocket-handler.test.ts` — 1 break

| #   | Test Name                          | Why It Breaks                                          | Fix                                              |
| --- | ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| 1   | `subscribe_session dispatch` tests | Handler now checks tenant ownership before subscribing | Ensure mock client state has matching `tenantId` |

**~30 other tests unaffected.**

---

### B9. `apps/runtime/src/__tests__/ws-sdk-handler.test.ts` — 0 breaks

No X-Forwarded-For test exists in this file. The rate limit test at line 903 uses `socket.remoteAddress` directly, not the `X-Forwarded-For` header. No existing tests are affected by the IP extraction change in Task 3.4.

**~40+ tests unaffected.**

---

### B10. `apps/runtime/src/__tests__/ws-twilio-handler.test.ts` — 1-2 breaks

| #   | Test Name                                    | Line    | Why It Breaks                                        | Fix                                                     |
| --- | -------------------------------------------- | ------- | ---------------------------------------------------- | ------------------------------------------------------- |
| 1   | `handles start event without error`          | ~263    | `handleStreamStart` now validates session pre-exists | Mock `findSessionByRuntimeId` to return a valid session |
| 2   | Any test sending `customParameters.tenantId` | Various | Tenant ownership validation is now enforced          | Ensure mock session matches the claimed tenantId        |

**~20 other tests unaffected** (focus on audio forwarding, not session init).

---

### B11. `apps/runtime/src/__tests__/pii-pattern-loader.test.ts` — 6 breaks

| #   | Test Name                                                                           | Line | Why It Breaks                                                                    | Fix                                                                 |
| --- | ----------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `registers recognizer with sandboxed validator when validate expression is present` | ~159 | `buildSandboxedValidator` now rejects JS expressions like `'value.length >= 10'` | Change test to use regex: `'.{10,}'`                                |
| 2   | `expression cannot access process`                                                  | ~218 | `vm` module removed; constructor chain no longer tested this way                 | Remove test (replaced by new `pii-sandbox-escape.test.ts` A9 tests) |
| 3   | `expression cannot access require`                                                  | ~225 | `vm` module removed                                                              | Remove test (replaced by A9)                                        |
| 4   | `expression with timeout is caught`                                                 | ~232 | `vm` timeout logic removed                                                       | Remove test (backtracking detection replaces this)                  |
| 5   | `valid expression works`                                                            | ~204 | Uses JS expression `'value.length > 5'` — not a valid regex pattern              | Rewrite to use regex: `'.{6,}'`                                     |
| 6   | `expression can use RegExp`                                                         | ~211 | Uses JS expression `'/^\d+$/.test(value)'` — not a valid regex pattern           | Rewrite to use regex: `'^\d+$'`                                     |

**~10 other tests unaffected.**

---

### B12. `apps/runtime/src/__tests__/inline-mcp-provider.test.ts` — 0 breaks

The default stdio command in tests is `/usr/bin/node`. The allowlist check uses `path.basename(config.command)`, so `basename('/usr/bin/node')` = `'node'` which IS in the allowlist. No existing tests are affected.

**~25 other tests unaffected.**

---

### B13. `apps/runtime/src/__tests__/chat-routes.test.ts` — 0 breaks

No SSE error event assertions exist in `chat-routes.test.ts`. The only error assertions check REST JSON responses (e.g., status codes and `body.success`), not the SSE streaming error path modified by Task 6.3.

**~25+ tests unaffected.**

---

### B14. `apps/runtime/src/__tests__/project-settings-route.test.ts` — 0 breaks

Tests only assert on status codes and `body.success` / `body.settings.*`. No assertions on specific error message text strings in 4xx responses exist.

**~20+ tests unaffected.**

---

### B15. `apps/runtime/src/__tests__/message-persistence-queue.test.ts` — 0 breaks

Tests check ordering and parallelism, not buffer capacity.

---

### B16. `apps/runtime/src/__tests__/dual-write-message-store.test.ts` — 1 break

| #   | Test Name                        | Line | Why It Breaks                                                                                                                      | Fix                                                                                                      |
| --- | -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `getMessages delegates to Mongo` | ~215 | `store.getMessages({ sessionId: 'sess-1' })` — `QueryMessagesParams` now requires `tenantId`, causing TypeScript compilation error | Add `tenantId: 'tenant-1'` to params: `store.getMessages({ sessionId: 'sess-1', tenantId: 'tenant-1' })` |

**Note:** The underlying `mongoStore.getMessages` is a `vi.fn()` mock that accepts any args, but the outer `DualWriteMessageStore.getMessages` method signature enforces the typed `QueryMessagesParams` interface at compile time.

**~20 other tests unaffected.**

---

### B17. `apps/runtime/src/__tests__/mongo-message-store-scrub.test.ts` — 0 breaks

Tests use `scrubMessages` / `scrubMessagesBySession`, not `getMessages`.

---

### B18. `packages/shared-kernel/src/security/__tests__/ssrf-validator.test.ts` — 0 breaks

No existing tests for `getDevSSRFOptions` exist in this file. The behavior change (only permissive for `development` and `test`, not all non-production) has no test breakage.

**~50 other tests unaffected.**

---

### B19. `packages/compiler/src/__tests__/guardrails/providers/custom-http.test.ts` — 0 breaks

No existing test checks `failMode`. New option is additive.

---

### B20. `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts` — 0-1 breaks

Only breaks if an existing test sends a result > 100K chars and asserts on the full untruncated output. Current tests use small payloads — likely 0 breaks.

---

### B21. `apps/runtime/src/__tests__/ws-handler.test.ts` — 3-5 breaks

**Note:** This is a SEPARATE file from `websocket-handler.test.ts`.

| #   | Test Name                                             | Line  | Why It Breaks                                           | Fix                                              |
| --- | ----------------------------------------------------- | ----- | ------------------------------------------------------- | ------------------------------------------------ |
| 1   | `subscribe_session dispatches trace events`           | ~943  | Task 3.2 adds tenant check; mock client has no tenantId | Add tenantId to mock client state                |
| 2   | `subscribe_session returns error for invalid session` | ~960  | Tenant check runs before session lookup                 | Ensure mock client has tenantId                  |
| 3   | `resume_session restores from memory`                 | ~1038 | Task 3.3 adds tenant check on in-memory session         | Add matching tenantId to mock session and client |
| 4   | `resume_session restores from Redis`                  | ~1060 | Same tenant check on Redis-rehydrated session           | Add matching tenantId                            |
| 5   | `resume_session returns expired for unknown session`  | ~1080 | Tenant check may run before session lookup              | Ensure mock client has tenantId                  |

---

### B22. `apps/runtime/src/__tests__/stores.test.ts` — ~4 breaks

| #   | Test Name               | Line     | Why It Breaks                                                                            | Fix                                                          |
| --- | ----------------------- | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1-4 | All `getMessages` tests | ~322-352 | `QueryMessagesParams` now requires `tenantId` — calls without it fail TypeScript/runtime | Add `tenantId: 'tenant-1'` to all `getMessages({...})` calls |

---

### B23. `apps/runtime/src/__tests__/store-factory.test.ts` — ~12 breaks

| #    | Test Name                                                       | Line       | Why It Breaks                                 | Fix                                                          |
| ---- | --------------------------------------------------------------- | ---------- | --------------------------------------------- | ------------------------------------------------------------ |
| 1-12 | All `store.getMessages({...})` calls in MongoMessageStore tests | ~1152-1384 | `QueryMessagesParams` now requires `tenantId` | Add `tenantId: 'tenant-1'` to all `getMessages({...})` calls |

---

### B24. `apps/runtime/src/__tests__/clickhouse-stores.test.ts` — ~7 breaks

| #   | Test Name                            | Line    | Why It Breaks                                 | Fix                                                          |
| --- | ------------------------------------ | ------- | --------------------------------------------- | ------------------------------------------------------------ |
| 1-7 | All `store.getMessages({...})` calls | Various | `QueryMessagesParams` now requires `tenantId` | Add `tenantId: 'tenant-1'` to all `getMessages({...})` calls |

---

### B25. `apps/runtime/src/__tests__/clickhouse-enterprise.test.ts` — ~4 breaks

| #   | Test Name                            | Line    | Why It Breaks                                 | Fix                                                          |
| --- | ------------------------------------ | ------- | --------------------------------------------- | ------------------------------------------------------------ |
| 1-4 | All `store.getMessages({...})` calls | Various | `QueryMessagesParams` now requires `tenantId` | Add `tenantId: 'tenant-1'` to all `getMessages({...})` calls |

---

### B26. `apps/runtime/src/__tests__/repos.test.ts` — 7 breaks

| #   | Test Name                                      | Line                         | Why It Breaks                                                   | Fix                                                 |
| --- | ---------------------------------------------- | ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `findSessionById returns session`              | ~324                         | Calls `findSessionById('sess-1')` without tenantId              | Add `'tenant-1'` as 2nd arg                         |
| 2   | `findSessionById returns null`                 | ~344                         | Same                                                            | Add tenantId                                        |
| 3   | `findSessionByRuntimeId returns session`       | ~354                         | `findSessionByRuntimeId('rt-123')` without tenantId             | Add tenantId                                        |
| 4   | `updateSession updates fields`                 | ~453                         | `updateSession('sess-1', {...})` without tenantId               | Add tenantId                                        |
| 5   | `updateSessionActivity increments`             | ~483                         | `updateSessionActivity('sess-1', 3)` without tenantId           | Add tenantId                                        |
| 6   | `incrementSessionTokens atomically increments` | ~497                         | `incrementSessionTokens('sess-1', 150, 0.003)` without tenantId | Add tenantId                                        |
| 7   | `toHaveBeenCalledWith assertions on filter`    | ~330, ~360, ~459, ~486, ~500 | Assertions check `{ _id: 'sess-1' }` without tenantId in filter | Update to `{ _id: 'sess-1', tenantId: 'tenant-1' }` |

**Note:** This is a SEPARATE file from `repos-session.test.ts` (B1). Both files test session-repo functions.

---

### B27. `apps/runtime/src/__tests__/integrated.e2e.test.ts` — 4 breaks

| #   | Test Name               | Line    | Why It Breaks                                                  | Fix                                  |
| --- | ----------------------- | ------- | -------------------------------------------------------------- | ------------------------------------ |
| 1-4 | All `getMessages` calls | Various | `store.getMessages({ sessionId })` without required `tenantId` | Add `tenantId: 'tenant-1'` to params |

---

### B28. `apps/runtime/src/__tests__/platform.e2e.test.ts` — 5 breaks

| #   | Test Name           | Line    | Why It Breaks                                                   | Fix                        |
| --- | ------------------- | ------- | --------------------------------------------------------------- | -------------------------- |
| 1-2 | `getMessages` calls | Various | `messageStore.getMessages({ sessionId, ... })` without tenantId | Add `tenantId: 'tenant-1'` |
| 3-5 | `softDelete` calls  | Various | `contactStore.softDelete(contact.id)` without tenantId          | Add tenantId as 2nd arg    |

---

### B29. `apps/runtime/src/__tests__/session-redis.e2e.test.ts` — 12 breaks

| #    | Test Name               | Line    | Why It Breaks                                                                                                 | Fix                                      |
| ---- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1-12 | All `getMessages` calls | Various | `store.getMessages({ sessionId })` and `msgStore.getMessages({ sessionId, ... })` — 12 calls without tenantId | Add `tenantId: 'tenant-1'` to all params |

---

### B30. `packages/compiler/src/__tests__/compiler-stores-extended.test.ts` — 6 breaks

| #   | Test Name                                       | Line    | Why It Breaks                                                                          | Fix                                                          |
| --- | ----------------------------------------------- | ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1-6 | All `getMessages` calls on InMemoryMessageStore | Various | `QueryMessagesParams` interface now requires `tenantId` — TypeScript compilation error | Add `tenantId: 'tenant-1'` to all `getMessages({...})` calls |

---

### B31. `apps/runtime/src/__tests__/stress/runtime-channel-stress.test.ts` — 1 break

| #   | Test Name           | Line | Why It Breaks                          | Fix                                |
| --- | ------------------- | ---- | -------------------------------------- | ---------------------------------- |
| 1   | Session lookup call | ~337 | `findSessionById(id)` without tenantId | Add tenantId or use system variant |

**Note:** Stress tests are typically excluded from CI but will fail if run.

---

### B32. `apps/runtime/src/__tests__/stress/runtime-e2e-persistence.test.ts` — 1 break

| #   | Test Name                        | Line | Why It Breaks                                      | Fix                                |
| --- | -------------------------------- | ---- | -------------------------------------------------- | ---------------------------------- |
| 1   | Session persistence verification | ~654 | `findSessionById(record.mongoId)` without tenantId | Add tenantId or use system variant |

**Note:** Stress tests are typically excluded from CI but will fail if run.

---

## Summary Counts

| Category                                   | Count                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New test files**                         | **23**                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **New test cases (total)**                 | **144** (132 in new files + 12 added to existing files via A24)                                                                                                                                                                                                                                                                                                                                                          |
| **Existing test files needing updates**    | **24** (17 with breakage fixes + 7 receiving new tests via A24; out of 32 audited; 15 have zero breakage)                                                                                                                                                                                                                                                                                                                |
| **Existing test cases that break**         | **~90**                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Existing test files with zero breakage** | **15** (session-routes.test.ts, contact-routes.test.ts, contacts-authz.test.ts, tenant-models.test.ts, tenant-model-routes.test.ts, tenant-models-authz.test.ts, ws-sdk-handler.test.ts, inline-mcp-provider.test.ts, chat-routes.test.ts, project-settings-route.test.ts, message-persistence-queue.test.ts, mongo-message-store-scrub.test.ts, ssrf-validator.test.ts, custom-http.test.ts, mcp-tool-executor.test.ts) |

### Breakage by Fix Category

| Fix Pattern                                     | Affected Tests | Effort                                           |
| ----------------------------------------------- | -------------- | ------------------------------------------------ |
| Add tenantId argument to function calls         | ~59 tests      | Low — mechanical (add `'tenant-1'` to each call) |
| Update mock store signatures                    | ~8 tests       | Low — add tenantId param to mock factory         |
| Update `toHaveBeenCalledWith` filter assertions | ~7 tests       | Low — add tenantId to expected filter objects    |
| Update error message assertions                 | ~4 tests       | Low — change expected string                     |
| Remove vm-related tests (replaced by new tests) | 3 tests        | Low — delete + verify new tests cover            |
| ~~Update X-Forwarded-For assertion~~            | 0 tests        | N/A — no existing test affected                  |
| Add session mock for Twilio start               | 1-2 tests      | Medium — need mock session factory               |
| Add tenant context to WS test setup             | 1-2 tests      | Medium — need client state mock                  |
