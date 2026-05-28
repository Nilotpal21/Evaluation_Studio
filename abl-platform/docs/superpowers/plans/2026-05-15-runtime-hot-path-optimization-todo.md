# Runtime Hot Path Optimization — TODO

**Date:** 2026-05-15
**Priority:** Performance
**Status:** BACKLOG

Identified during live session analysis of the reusable modules feature. These are pre-existing inefficiencies in the runtime hot path — not module-specific.

---

## High Impact

### 1. Model Resolution: 6+ redundant DB queries per session

**Where:** `apps/runtime/src/services/` — model resolution service
**What:** `AgentModelConfig.findOne()` called for every LLM operation type (extraction, response_gen, tool_selection) AND every agent. With no per-agent config (the common case), it always returns null.
**Fix:** Cache the "not found" result per `(projectId, agentName)` with TTL. One query per agent per session, not 6+.
**Impact:** ~6 DB queries eliminated per session creation

### 2. DEK Decrypt: 3x for same credentials in one session

**Where:** `tenant-encryption-facade`
**What:** Same tenant DEK decrypted 3 times during model resolution for one session creation.
**Fix:** Cache decrypted DEK per tenant with TTL (already encrypted at rest, decrypted form is ephemeral).
**Impact:** 2 crypto operations eliminated per session

### 3. Rate Limiter: polling + per-request double queries

**Where:** `apps/runtime/src/` — rate limiter / `hybrid-rate-limiter`
**What:** Fires on 10s polling interval AND on every request. Same tenant/project, same result. Logs 2 lines every 10s even when idle.
**Fix:** Cache rate limit result per `(tenantId, projectId)` with 30s TTL. Only log on change, not every poll.
**Impact:** ~80% reduction in idle-loop DB/Redis queries

## Medium Impact

### 4. ToolBindingExecutor re-wired on handoff

**Where:** `apps/runtime/src/services/execution/llm-wiring.ts`
**What:** When agent A hands off to agent B, the executor is rebuilt with the same tool list. `_collectToolsCached` helps but the executor construction is repeated.
**Fix:** If the tool set hasn't changed (same hash), reuse the executor instance.
**Impact:** ~50ms CPU saved per handoff

### 5. Session double-write on creation

**Where:** `apps/runtime/src/services/session/` — tiered session store
**What:** Redis `create` immediately followed by `save` with version=1 — two Redis writes for one logical operation.
**Fix:** Combine create+save into a single Redis write.
**Impact:** 1 Redis round-trip eliminated per session

### 6. PII recognizers registered per-message

**Where:** `apps/runtime/src/` — PII recognizer registry
**What:** 5 core recognizers (email, ssn, credit_card, phone, ipv4) registered on every first message of every session.
**Fix:** Register once at startup, not per-session.
**Impact:** Minor CPU — 5 map insertions per session

## Low Impact

### 7. CEL parser runs on natural language strings

**Where:** `apps/runtime/src/` — dual evaluator
**What:** `when user asks about weather` is fed to the CEL parser which fails with a parse error, then falls back to legacy evaluation. The CEL parse is wasted CPU + produces 3-line error output.
**Fix:** Pre-check if the expression looks like CEL syntax (contains operators, function calls, `.` property access) before parsing. Skip CEL for plain natural language.
**Impact:** Minor CPU — one parse attempt saved per WHEN condition

### 8. EventStore logs unregistered event types

**Where:** `apps/runtime/src/` — eventstore resilient emitter
**What:** `Unregistered event type, skipping data validation` logged for every `system.runtime_trace` and `session.turn.started/ended` event. Expected behavior, not worth logging.
**Fix:** Remove or reduce to TRACE level.
**Impact:** Log noise reduction only

### 9. Pipeline filler fails with test API key

**Where:** `apps/runtime/src/` — pipeline filler
**What:** `Incorrect API key provided: sk-test-***` logged every message. The OpenAI test key is invalid.
**Fix:** Check API key validity at startup and disable pipeline filler if key is clearly a test/placeholder key.
**Impact:** One failed HTTP call + log noise per message
