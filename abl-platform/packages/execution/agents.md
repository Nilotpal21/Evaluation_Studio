# agents.md — packages / execution

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

## 2026-04-19 — ABL Contract Hardening Phase 3 (resume payload parity)

**Category**: architecture
**Learning**: `ResumeData.type` must stay aligned with `SuspendedContinuation.type` for any continuation that can be requeued through BullMQ. Async remote handoffs were already modeled as `remote_handoff_result` in suspension state, but `ResumeData` still lacked that union member, which broke timeout-worker and resumption-service type safety as soon as the runtime started enqueueing typed remote resumes.
**Files**: `src/types.ts`, `src/suspension.ts`
**Impact**: Whenever a new suspend/resume continuation becomes queue-driven, add it to both the suspension union and the queue resume payload union in the same change or downstream workers will drift from the true runtime contract.

## 2026-04-19 — ABL Contract Hardening Phase 4 (workflow memory continuity)

**Category**: testing
**Learning**: Execution-layer child-session fixtures now need an `executionTreeValues` store whenever runtime behavior depends on workflow-scoped memory continuity across handoffs. Without that hidden shared store in the fixture, child-session tests can look green while missing the real cross-agent memory contract the runtime now persists.
**Files**: `src/__tests__/child-session.test.ts`
**Impact**: Any future execution or queue-level tests that model cross-agent resume/handoff state should include `executionTreeValues` in the session fixture whenever the scenario cares about workflow-scoped shared memory.

## 2026-05-05 — Redis Dual-Mode (fan-out-barrier cluster-safe redesign)

**Category**: architecture
**Learning**: **`KEYS` inside Lua is forbidden in Redis Cluster** — it only scans the local node and returns partial results. `LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` previously called `redis.call('KEYS', 'barrier:' .. id .. ':result:*')`. Replaced with an explicit registry SET (`barrier:{<id>}:result-keys`) that tracks branch result keys as they are written via `LUA_COMPLETE_BRANCH` (KEYS[3]=registry, ARGV[4]=branchKey). Both `LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` now iterate this SET.
**Files**: `src/redis-fan-out-barrier.ts`, `src/__tests__/redis-fan-out-barrier.cluster.test.ts`
**Impact**: Any new Lua script in this package that needs to enumerate a dynamic key set must use an explicit registry SET rather than `KEYS`/`SCAN`. The `{barrierId}` hash tag ensures the barrier hash, registry SET, and all per-branch result keys land in the same slot.

**Category**: gotcha
**Learning**: **`LUA_CREATE_BARRIER` was a multi-key script** (`numberOfKeys: 2` for barrier hash + TTL propagation). Changed to `numberOfKeys: 1` with TTL passed as `ARGV` to avoid the CROSSSLOT error. The barrier hash key and TTL value were previously both in KEYS; now only the barrier hash is in KEYS.
**Files**: `src/redis-fan-out-barrier.ts`
**Impact**: Any future Lua script modifications: pass scalar values (numbers, strings) via ARGV, not KEYS. KEYS must only contain actual Redis key names that the script touches.
