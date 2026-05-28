# Feature-Spec Phase Log — redis-dual-mode

**Slug**: `redis-dual-mode`
**Phase**: 1 of 6 (Feature Spec)
**Owner**: Platform team
**Started**: 2026-05-04
**Worktree**: `.worktrees/redis-cluster-dual-mode`
**Branch**: `worktree-redis-cluster-dual-mode`

---

## Inputs

- User request: "Validate Redis cluster compatibility claim from Sai Kumar Shetty's analysis; codebase claimed not yet compatible. Required for SIT setup and tier-M/L/XL prod readiness."
- Original Slack message context: SIT setup blocked; common stack uses cluster mode; SaaS prod must support both.
- Related code already in tree: `packages/redis/` (factory has cluster path), `packages/config/` (cluster flag), `deploy/helm-values/tier-{m,l,xl}/values.yaml` (cluster topology provisioned).

## Oracle Decisions

Oracle answered 19/20 clarifying questions as ANSWERED / INFERRED / DECIDED. One AMBIGUOUS:

| ID  | Question                 | Resolution                                                                                      |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| A-3 | Priority/timeline driver | DECIDED in auto mode: 6–8 week standard SDLC schedule (Option B). Logged as Open Question OQ-1. |

All decisions captured in `feature-spec.oracle.md` (separate companion file in this directory) — refer there for full Q&A.

## Audit Round 1 — phase-auditor

**Verdict**: NEEDS_REVISION

**Findings addressed:**

- **CRITICAL FS-2 (path correction for idp-token-validator)** — Auditor was partially incorrect. `packages/shared-auth/src/idp/idp-token-validator.ts:407` does exist (verified via `find`). However, an additional copy at `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332` was missing from the spec. → Added the search-ai-runtime path.
- **CRITICAL FS-2 (`.duplicate()` count)** — Auditor claimed "~9", but `grep -rn '\.duplicate('` excluding `__tests__` and `packages/redis/` returns ~25 production sites. The original "27+" was approximately correct. → Updated to "~25 production call sites" with a verifiable grep command in the spec.
- **CRITICAL FS-2 (missing KEYS sites)** — Auditor correctly identified omissions. Production `KEYS` sites are 10 files / 12 call sites. → Updated section 1, section 5 integration matrix, section 10 implementation files, and section 13 delivery plan with the full enumeration.
- **HIGH FS-3 (FR-9 too prescriptive)** — Reworded to a testable observable contract; moved implementation approach to sections 7 & 13.
- **HIGH FS-5 (integration matrix gaps)** — Added rows for IDP Token Validator (search-ai-runtime), SearchAI Intelligence, SearchAI-Runtime Group Membership Cache, SearchAI-Runtime Query Cache, SearchAI-Runtime OAuth Routes.
- **HIGH FS-8 (vague Phase 1 subtask)** — Replaced "search-ai workers if any remaining" with explicit subtasks 2.5–2.9 covering each file.
- **MEDIUM FS-9 (testing standards reference)** — Added explicit reference to CLAUDE.md "Test Architecture" and "E2E Test Standards" in section 17.
- **MEDIUM FS-9 (index updates)** — Added entries to `docs/features/README.md` (Infrastructure & Operations table, row #86) and `docs/testing/README.md` (row #102).

**Findings deferred / noted only:**

- HIGH FS-10 (Phases 4-5 are operational scope) — Acknowledged but kept in delivery plan; SIT validation and tier rollout are critical exit criteria for the feature, not separate runbook work.
- Test-spec note about explicit auth context in E2E scenarios — Will be picked up in `/test-spec` phase.

## Files Created / Modified

- Created: `docs/features/redis-dual-mode.md`
- Created: `docs/testing/redis-dual-mode.md`
- Modified: `docs/features/README.md` (added row #86)
- Modified: `docs/testing/README.md` (added row #102)
- Created: `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md` (this file)

## Open Questions Persisting Beyond This Phase

1. **OQ-1 (timeline)** — User confirmation needed on 6–8 week schedule (auto-mode assumption).
2. **OQ-2** — Long-term direction for tier-S Sentinel (keep vs. migrate to cluster).
3. **OQ-3** — `runLuaScript` SHA1 caching strategy (default: rely on ioredis).
4. **OQ-4** — Lint hook severity (block vs. warn) initial setting.
5. **OQ-5** — Slot-distribution dashboard ownership split (Platform vs. SRE).

## Audit Round 2 — phase-auditor (fresh-eyes)

**Verdict**: APPROVED with 3 MEDIUM (non-blocking).

- MEDIUM: Two `idp-token-validator-compat` adapter sites cascade through `redis-client.ts` migration → noted in Phase 3.4.5
- MEDIUM: Line numbers updated to `lua-scripts.ts:105,114` (precise)
- MEDIUM: `.duplicate()` per-app breakdown refined to `apps/runtime` (~13), `apps/workflow-engine` (~10), `packages/redis/bullmq.ts` (1)

## Audit Pass 3 — Platform Audit (general-purpose)

**Verdict**: NEEDS_REVISION (4 HIGH, 7 MEDIUM, 2 LOW)

**Findings addressed:**

- HIGH-1: `isReady()` and `disconnect()` also have `as Redis` casts → FR-1 extended; Phase 0.1 now lists all three (`duplicate`, `isReady`, `disconnect`)
- HIGH-2: `LUA_END_SESSION` description imprecise (uses SREM/DEL not SADD) → FR-9 fully rewritten with per-script breakdown (CREATE/END/CLAIM/EXTEND)
- HIGH-3: `LUA_CLAIM_SESSION` 3-keys cross-slot not addressed → added to FR-9 and Phase 2.2
- HIGH-4: `LUA_DELETE_BARRIER` also uses in-Lua KEYS → FR-10 reworded to cover **both** Lua scripts
- MEDIUM (5/12): scanKeys mid-failover, evalsha cache, ghost session, pipeline race, BullMQConnectionPair type widening, constructor types — all addressed in updated FRs and delivery plan
- MEDIUM (commit-scope): Phase 1 + Phase 3 split into sub-commits respecting max-3-packages-per-commit rule
- LOW (sync I/O): `scripts.ts:24-27` `readFileSync` migration to `fs.promises.readFile` added to Phase 2.1
- LOW (`resolveBullMQConnectionFromEnv`): added to FR-12 / Phase 0.7

## Audit Pass 4 — Industry Research (general-purpose, web)

**Verdict**: 2 HIGH RISK, 2 MEDIUM RISK, 4 GAP, 4 IMPROVEMENT

**Findings addressed:**

- HIGH RISK-1: `retryDelayOnFailover * maxRedirections > cluster-node-timeout` requirement → FR-14 + Phase 0.8
- HIGH RISK-2: Multi-key `DEL`/`MGET` semantics — verified ioredis Cluster auto-splits these (does NOT throw CROSSSLOT for these specific commands). MULTI/EXEC transactions DO throw — added GAP-002 reclassification with audit follow-up
- MEDIUM RISK (pub/sub O(N) broadcast): GAP-007 added; sharded pub/sub flagged for future
- MEDIUM RISK (BullMQ #2964 stall-after-reconnect): GAP-008 added; verification step in Phase 4 SIT
- GAP (BullMQ queue hot-slot at tier-XL): GAP-006 added; queue sharding flagged for follow-up feature (Langfuse pattern referenced)
- GAP (scanKeys ioredis bugs): GAP-005 expanded with dedupe + per-node error handling
- GAP (missing SLO metrics): added p50 dual-threshold, write-throughput-during-resharding, slot-cache refresh — Section 14
- IMPROVEMENT (natMap, scaleReads): noted but deferred — non-blocking
- IMPROVEMENT (Sidekiq phased adoption): Phase 2 reworded "each script family ships and validates independently"
- IMPROVEMENT (rationale for client-side over proxy): integrated into Section 7 implicitly via NG-2

## Audit Pass 5 — OSS Library Audit (general-purpose, web)

**Verdict**: APPROVED — no library adoption recommended.

- All 5 helpers are 3–25 line wrappers over ioredis primitives; no OSS abstraction exists at this layer
- Scan libraries (`redis-scan`, `shimo-redis-scan`) are abandoned (5–9 years stale)
- `cluster-key-slot` is already a transitive dep of ioredis — no new install
- Existing `DistributedLockManager` is already cluster-safe (single-key `SET NX PX`); `redlock`/`redlock-universal` solve a different problem (multi-instance quorum)
- No GPL/AGPL incompatibilities detected
- Total custom code: ~75 lines

## Open Questions Resolved

- **OQ-3** RESOLVED: `runLuaScript` uses `client.eval()` (ioredis handles `EVALSHA` + `NOSCRIPT` fallback transparently). Removed from open questions.

## Next Phase

Run `/test-spec redis-dual-mode` after this commit lands.
