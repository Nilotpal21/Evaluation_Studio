# agents.md — packages/agent-transfer

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-24 — Five9 Adapter Phase 5 (Tests)

**Category**: gotcha
**Learning**: The `express` package is NOT a dependency of `@agent-platform/agent-transfer`. Integration tests that need an HTTP server must use raw `node:http` with `http.createServer()` — not express. Use `parseBody()` helper for JSON parsing and `sendJson()` for responses.
**Files**: `src/adapters/five9/__tests__/five9-client.integration.test.ts`
**Impact**: All future integration tests in this package must avoid express.

**Category**: gotcha
**Learning**: The SSRF guard (`assertAllowedUrl`) is called inside `Five9Client` methods before `fetchFn`. Integration tests cannot use `127.0.0.1` directly as the Five9 host — the guard will block it. Instead, use a public-looking host (e.g., `app.five9.com`) in credentials and inject a `fetchFn` that rewrites URLs to point at the local mock server.
**Files**: `src/adapters/five9/__tests__/five9-client.integration.test.ts`
**Impact**: Any test using Five9Client against a local server needs this URL-rewriting fetchFn pattern.

**Category**: pattern
**Learning**: In-memory `TransferSessionStoreHandle` implementations are used across multiple test files. They maintain `_sessions` (Map), `_providerIndex` (Map), and `_ended` (array) for inspection. `providerData` and `metadata` are stored as JSON strings (matching the real Redis-backed store).
**Files**: `src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`
**Impact**: Future tests can copy this pattern. Consider extracting to a shared test helper if used in more places.

**Category**: pattern
**Learning**: Five9Client errors are thrown as plain `{ code, message }` objects (not Error instances). Tests should use `rejects.toEqual(expect.objectContaining({ code: '...' }))` not `rejects.toThrow()`.
**Files**: `src/adapters/five9/__tests__/five9-client.integration.test.ts`
**Impact**: Any test asserting Five9Client errors needs objectContaining pattern, not toThrow.

## 2026-03-30 — Kore Adapter LLD

**Category**: gotcha
**Learning**: `mock-smartassist.ts` in `src/__tests__/helpers/` has 6 of 9 SmartAssistClient methods. Missing: `getAccountIdByBotId`, `createSyntheticUser`, `sendEvent`. The existing file should be extended, not duplicated.
**Files**: `src/__tests__/helpers/mock-smartassist.ts`
**Impact**: Always check existing mock helpers before creating new ones.

**Category**: gotcha
**Learning**: `kore-transfer-flow.test.ts` already exists (134 lines, 5 tests) testing TransferToAgentTool → AdapterRegistry orchestration. New tests for SmartAssistClient retry behavior must use a different filename (e.g., `kore-smartassist-retry.test.ts`).
**Files**: `src/__tests__/integration/kore-transfer-flow.test.ts`
**Impact**: Always check for existing test files before creating new ones with similar names.

**Category**: pattern
**Learning**: In-memory `TransferSessionStoreHandle` is duplicated across 3+ test files (Five9 cleanup, adapter wiring, etc.). LLD D-8 calls for extracting to shared `src/__tests__/helpers/mock-session-store.ts`. The `extendTTL` must match the concrete signature `(key, ttl?, channel?): Promise<boolean>`, not the narrower interface.
**Files**: `src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`
**Impact**: Use the shared helper after extraction. Include `agentId` in `create()` params.

**Category**: gotcha
**Learning**: SSRF guard also applies to SmartAssistClient (uses `undici.Pool`). Integration tests against localhost need the same URL-rewriting `fetchFn` pattern established for Five9Client.
**Files**: `src/adapters/kore/smartassist-client.ts`
**Impact**: Kore integration tests must use the URL-rewriting pattern.

**Category**: architecture
**Learning**: SmartAssistClient has 9 public methods (not 8 — `close()` is easily missed). The dual transport pattern (undici Pool for SmartAssist, native fetch for KoreServer) means retry behavior differs by transport.
**Files**: `src/adapters/kore/smartassist-client.ts`
**Impact**: Tests observing retry behavior should count Pool.request calls, not spy on private methods.

**Category**: architecture
**Learning**: `KoreAdapter.execute()` GAP-008 fix captures `const config = { ...this.smartAssistConfig }` at method entry. This protects execute() but NOT `sendUserMessage()` or `endSession()` — those access `this.smartAssistConfig` directly. The stale-config window for mid-transfer methods is negligible (called during active transfer, not at re-initialization boundary).
**Files**: `src/adapters/kore/index.ts`
**Impact**: Full isolation (Option B per-execution clone) deferred to multi-tenant concurrent scenario.

## 2026-04-05 — Agent-transfer security hardening reproduction

**Category**: testing
**Learning**: `log-redactor` regression coverage needs to assert mixed-case header keys and sensitive objects nested inside arrays. A lowercase-only exact-key test will miss `Authorization` and `X-API-Key` variants and preserve secrets in array payloads.
**Files**: `src/security/log-redactor.ts`, `src/__tests__/unit/log-redactor.test.ts`
**Impact**: Future redaction changes should keep array recursion and case-normalized key matching under focused unit coverage.

**Category**: security
**Learning**: `TenantScopedSessionEncryptor.encryptField()` currently downgrades to plaintext when the encryption backend throws. A focused unit test under `src/__tests__/unit/` is the right place to lock in fail-closed behavior for session metadata/providerData encryption.
**Files**: `src/security/session-field-encryption.ts`, `src/__tests__/unit/session-field-encryption.test.ts`
**Impact**: Session-field encryption changes should be validated with direct unit tests before relying on store-level coverage.

## 2026-04-05 — Agent-transfer security hardening implementation

**Category**: pattern
**Learning**: `log-redactor` should normalize the exported sensitive-key set once at module load and compare incoming keys with `key.toLowerCase()`. Array payloads need element-wise recursion with the same object redaction path, or mixed-case headers inside batched/nested payloads bypass masking.
**Files**: `src/security/log-redactor.ts`, `src/__tests__/unit/log-redactor.test.ts`
**Impact**: Future secret-key additions should only add the canonical field name once; tests should cover nested arrays whenever redaction traversal changes.

**Category**: security
**Learning**: `TransferSessionStore.create()` must finish encrypting `metadata` and `providerData` before building Redis `ARGV`, and it needs a dedicated `{ code: 'ENCRYPTION_ERROR' }` failure path when the encryptor rejects. This keeps KMS failures fail-closed and prevents a Redis write attempt after encryption failure.
**Files**: `src/session/transfer-session-store.ts`, `src/security/session-field-encryption.ts`, `src/__tests__/unit/error-resilience.test.ts`
**Impact**: Any future create-path refactor that touches field serialization/encryption should preserve the pre-Redis error boundary and retain a regression test asserting `redis.eval()` is skipped on encryption failure.

## 2026-04-20 — Voice transfer session stuck at pending (ABLP-142)

**Category**: gotcha
**Learning**: SmartAssist's `assign_kore_agent_for_user` payload does NOT always include `agentSipURI`. The old voice `agent:connected` handler required both `agentSipURI` and `voiceData.callSid` before advancing the session state, leaving voice sessions permanently stuck at `pending` when `agentSipURI` was absent. The correct guard is `session.state !== 'active'` only — capture `agentSipURI` opportunistically when present.
**Files**: `src/adapters/kore/event-handler.ts`
**Impact**: Any future voice event handler that gates state transitions on payload fields should treat those fields as optional enhancements, not required preconditions.

**Category**: gotcha
**Learning**: `active_call_status` is a SmartAssist voice control event that signals the agent has accepted the call. It is a more reliable connected signal for voice transfers than `assign_kore_agent_for_user` (which may not always arrive). Map it to `agent:connected` as a secondary safety net in `XO_EVENT_MAP`.
**Files**: `src/adapters/kore/event-handler.ts`
**Impact**: When adding new SmartAssist voice event types, prefer mapping them to an ABL event type over adding to `XO_ACKNOWLEDGED_NOOP` unless they are truly internal control signals with no state effect.

**Category**: gotcha
**Learning**: KoreAdapter credential resolution: when `SMARTASSIST_API_URL` is absent from `.env`, the entire `smartAssistConfig` env block fails to load, breaking `apiKey` and `koreApiKey` resolution even when `SMARTASSIST_API_KEY` is set. Add direct `process.env` fallbacks as the last resort in the merged config to handle this case.
**Files**: `src/adapters/kore/index.ts`
**Impact**: Credential resolution chains must account for partial env config — never assume that if one env var is set, the whole block loaded.

**Category**: pattern
**Learning**: SmartAssist contact name fallbacks in `createConversation()` payload used `'ABL'` / `'Platform'` as hardcoded defaults. Changed to `'Anonymous'` / `'User'` for a neutral display name when no contact info is provided by the agent transfer tool.
**Files**: `src/adapters/kore/smartassist-client.ts`
**Impact**: Future adapters should use neutral, non-product-branded fallback names for contact metadata.

## 2026-04-20 — Voice CSAT session-end race and disconnect event coverage (ABLP-142)

**Category**: gotcha
**Learning**: `execute()` stored `postAgentAction` from the payload without considering `result.csatSurveyRequired`. When SmartAssist signaled CSAT was required, the session metadata still had `postAgentAction: 'end'`, causing `handleInboundEvent` to call `sessionStore.end()` while the voice CSAT runner was still collecting DTMF. The fix: set `postAgentAction: 'csat'` when `result.csatSurveyRequired` is true.
**Files**: `src/adapters/kore/index.ts`
**Impact**: Any post-agent action that depends on async processing (CSAT, surveys, wrap-up) must store the appropriate `postAgentAction` value at transfer initiation time, not rely on the caller to set it.

**Category**: gotcha
**Learning**: CSAT data injection in `handleInboundEvent` was gated on `xoEvent.type === 'remove_id_to_acc_identity'` only. SmartAssist fires 5 different event types that all map to `agent:disconnected` — whichever arrives first triggers the disconnect flow. The fix: use a shared `DISCONNECT_EVENT_TYPES` Set for both CSAT injection and post-agent action handling.
**Files**: `src/adapters/kore/index.ts`, `src/adapters/kore/event-handler.ts`
**Impact**: When adding behavior that triggers on agent disconnect, always check ALL disconnect event types from the `XO_EVENT_MAP`, not just the most common one. The canonical list is in `event-handler.ts`.

---

## Redis Dual-Mode (Standalone + Cluster) — 2026-05-05

**Category**: architecture
**Learning**: **All session Lua scripts must be single-key.** The `LUA_CREATE_SESSION`, `LUA_END_SESSION`, `LUA_CLAIM_SESSION`, `LUA_EXTEND_TTL` scripts were redesigned to operate on exactly 1 key each (the session hash). Cross-slot writes (provider-index SET, `at_active_sessions` SET, per-pod `at_pod:{hostname}` SET) were moved to caller-side `client.pipeline()` after the Lua returns.
**Files**: `src/session/lua-scripts.ts`, `src/session/transfer-session-store.ts`
**Impact**: Atomicity at the cross-slot boundary is intentionally abandoned. Partial pipeline failures leave the advisory indexes stale; TTL on session keys guarantees cleanup. If you are adding a new Lua script here, keep it strictly single-key.

**Category**: gotcha
**Learning**: **Provider-index key kept un-tagged.** `at_by_provider:{provider}:{tenantId}:{providerSessionId}` is not hash-tagged because `getByProvider(provider, tenantId, providerSessionId)` lookups have no `contactId`/`channel` available to construct the hash tag. The key lands in a random slot; cross-slot writes to it are in the pipeline, not in Lua. This is intentional and cluster-safe.
**Files**: `src/session/lua-scripts.ts`
**Impact**: Do not try to hash-tag the provider-index key. It will break `getByProvider` lookups.

**Category**: testing
**Learning**: **Session-key shape is unchanged** (`agent_transfer:${tenantId}:${contactId}:${channel}` without braces). ~20 test fixtures hard-code session-key literals; hash-tagging the keys would have broken all of them. Since all Lua scripts are now single-key, there is no cluster-safety reason to reshape the keys. Keep the existing format.
**Files**: `src/__tests__/session-lua-fixes.test.ts`, `src/__tests__/unit/edge-cases.test.ts`
**Impact**: If you add new session test fixtures, use the un-tagged format.

**Category**: architecture
**Learning**: **DispositionHandler and SessionRecoveryService accept `RedisClient` (= `Redis | Cluster`).** Both classes use only single-key Redis commands (GET, SET, DEL, pipeline, sscan, SET NX EX) and single-key Lua scripts — all cluster-safe. The `import type { Redis } from 'ioredis'` was replaced with `import type { RedisClient } from '@agent-platform/redis'` to accept cluster clients without `as Redis` casts at call sites.
**Files**: `src/post-agent/disposition-handler.ts`, `src/session/session-recovery-service.ts`
**Impact**: When adding new Redis-consuming classes in this package, use `RedisClient` from `@agent-platform/redis`, not `Redis` from `ioredis`.

### 2026-05-10 — `recoverOrphanedSessions` HGETALL/EXISTS must run as `Promise.all`, not pipelines

**Category**: cluster-safety
**Learning**: An earlier optimization batched HGETALL across all session keys in one `redis.pipeline()` and EXISTS across all heartbeat keys in another. Those batches span tenant IDs (different slots) and pod hostnames (different slots) — cluster-mode CROSSSLOT. Fix: replace each pipeline with `Promise.all(keys.map(k => redis.hgetall(k).then(hash => [null, hash], err => [err, {}])))` so the resolved tuples match `[null, value]` / `[err, fallback]` and the existing index-based readers keep working. The SREM pipeline is preserved because every `srem` call targets the single set `at_active_sessions` (one slot).
**Files**: `src/session/session-recovery-service.ts`, `src/__tests__/unit/recovery-sscan-pipeline.test.ts`
**Impact**: When a planned pipeline batches across N tenant/pod-keyed keys in this package, audit the slot shape first. If the keys span slots, switch to `Promise.all` and reshape the tuples. The unit-test mock must expose `hgetall`/`exists` at the top level — they used to live only on the pipeline mock.
