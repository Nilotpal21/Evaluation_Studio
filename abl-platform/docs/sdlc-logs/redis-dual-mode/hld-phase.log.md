# HLD Phase Log — redis-dual-mode

**Slug**: `redis-dual-mode`
**Phase**: 3 of 6 (HLD)
**Owner**: Platform team
**Started**: 2026-05-04
**Worktree**: `.worktrees/redis-cluster-dual-mode`
**Branch**: `worktree-redis-cluster-dual-mode`
**Inputs**:

- Committed feature spec at `docs/features/redis-dual-mode.md` (commit `eac0b00fcf`)
- Committed test spec at `docs/testing/redis-dual-mode.md` (commit `25b99f8bea`)

---

## Oracle Phase

The product-oracle agent timed out during the question batch (long codebase verification across `packages/redis`, `packages/circuit-breaker`, `packages/agent-transfer`, `packages/execution`, plus `package.json` version probe). To unblock, the HLD was generated directly using:

- The feature spec (16 FRs, 8 GAPs, integration matrix, ~30% foundation already in place)
- The test spec (14 INT, 7 E2E, OQ-T-0 reconciliation requirement)
- Direct code grounding via Read/Bash for ioredis (5.9.3) + bullmq (^5.0.0) versions and reference HLDs (`docs/specs/agent-transfer.hld.md`)

Open questions surfaced were promoted into HLD §9 (OQ-H-1 BullMQ #2964 watchdog spec, OQ-H-2 canary path, OQ-H-3 reconciliation tool scope) rather than blocking on a re-spawned oracle.

## Audit Round 1 — phase-auditor (APPROVED with HIGH findings)

3 HIGH + 4 MEDIUM findings:

- **HD-H1**: `.duplicate()` per-app counts imprecise. Updated §1 problem statement to actuals: runtime ~16, workflow-engine ~7, bullmq.ts 2 (verified by `grep -rn '\.duplicate(' apps packages --include='*.ts' | grep -v __tests__`).
- **HD-H2**: `readFileSync` in `packages/circuit-breaker/src/scripts.ts:24-27` was tracked only in delivery plan, not as a CLAUDE.md violation. Linked it to Concern #2 (Data Access Pattern) with explicit mention of CLAUDE.md "no sync I/O" rule and Phase 2 step 3.1 remediation.
- **HD-H3**: OQ-T-0 cascade — HLD resolved admin endpoints as out-of-scope, but test spec still referenced `/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/{invalidate,keys}`, `GET /metrics`. Restructured E2E-3 step 5 (in-process counter), E2E-6 (existing Studio definition-edit route + direct `scanKeys`), E2E-WIRE-1 (in-process counter). Marked OQ-T-0 RESOLVED in test spec §9.
- **HD-M1**: `redis.subscriber.reconnect` clarified as both structured log event (`eventType`) and Prometheus counter (`redis_subscriber_reconnect_total`).
- **HD-M3**: BullMQ #2964 watchdog behavior defined in OQ-H-1 (poll `Worker.isRunning()` every 5s; if stalled > 30s replace Worker with fresh Cluster connection).

## Audit Round 2 — phase-auditor (APPROVED with HIGH findings)

2 HIGH + 2 MEDIUM findings, all localized:

- **HD-H4**: Downstream consumer table (§8) carried old (~13, ~10) counts from an earlier draft. Updated to (~16, ~7).
- **HD-H5**: `packages/shared-auth` listed in KEYS migration but has zero Redis usage and `idp/idp-token-validator.ts` doesn't exist on disk. Removed from downstream table; added explanatory note.
- **HD-M4**: KEYS site count "12" inherited from feature spec; auditor verified actual count is 10 across 8 files (2 phantom paths in feature spec: `packages/shared-auth/src/idp/idp-token-validator.ts:407` and `apps/search-ai-runtime/src/routes/auth-oauth.ts:394` don't exist). Updated §1 problem statement with explicit phantom-path note. Updated Concern #10 to "10 sites".
- **HD-M5**: Test spec header still said "HLD: pending". Updated to live link `[../specs/redis-dual-mode.hld.md](../specs/redis-dual-mode.hld.md) (DRAFT)`.

## Audit Round 3 — phase-auditor (APPROVED, cosmetic only)

2 MEDIUM findings, both cosmetic:

- System context diagram listed `shared-auth` in package list — removed (no Redis I/O).
- Concern #10 still said "12 sites" while problem statement was already corrected to 10 — internal consistency fixed.

No CRITICAL / HIGH remaining. design-lint passes at 95%.

## Decisions Captured in HLD

- **Architecture (Option A)**: Mode-aware abstraction in `@agent-platform/redis`. Three alternatives evaluated: A (chosen), B (per-service Cluster usage — rejected; spreads `instanceof` checks across 30 files, regression risk), C (extend Sentinel to all tiers — rejected; forfeits horizontal write scaling, throws away helm-provisioned cluster topology).
- **OQ-T-0 RESOLVED**: Admin endpoints (`/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/invalidate|keys`) and `GET /metrics` Prometheus exposure are deferred to a follow-up feature. Tests use in-process counter assertions and direct package APIs.
- **Hash-tag scope choices**: circuit-breaker `{level:key}` (not `{tenantId}` — avoids tenant hot slot), agent-transfer `{tenantId:contactId:channel}` (per-conversation distribution), fan-out-barrier `{barrierId}` (per-barrier).
- **Recovery gap acceptance (FR-9)**: agent-transfer split-Lua leaves a window where session hash exists but `at_active_sessions` index doesn't. TTL self-cleans; operator-tool SCAN snippet covers incident response. Documented as acceptable because indexes are advisory.
- **Lint hook severity**: `block` (not `warn`) at end of Phase 1 (KEYS) and Phase 3 (duplicate). Recommended in OQ-4.
- **ioredis Cluster constructor**: `retryDelayOnFailover: 500ms`, `maxRedirections: 16` → 8000 ms retry budget vs 5000 ms `cluster-node-timeout`.
- **No dashboard JSON in HLD**: Dashboard ownership deferred to OQ-5 (Platform owns JSON, SRE owns alert routing — recommended).

## Files Created / Modified

- Created: `docs/specs/redis-dual-mode.hld.md` (full HLD — 12 concerns, 3 alternatives, 5 ASCII diagrams, library API, data model, 8 OQs)
- Modified: `docs/testing/redis-dual-mode.md` (E2E-3, E2E-6, E2E-WIRE-1 restructured per OQ-T-0; HLD link updated)
- Created: `docs/sdlc-logs/redis-dual-mode/hld-phase.log.md` (this file)

## Counts (Quality Gates)

| Gate                          | Required | Actual                                            | Status |
| ----------------------------- | -------- | ------------------------------------------------- | ------ |
| 12 architectural concerns     | All 12   | 12                                                | ✅     |
| Alternatives evaluated        | ≥ 2      | 3                                                 | ✅     |
| Architecture diagrams         | ≥ 1      | 5                                                 | ✅     |
| Data model section            | Required | Present (key reshape, no new collections)         | ✅     |
| API design section            | Required | Present (library API; HTTP N/A)                   | ✅     |
| Open questions                | ≥ 1      | 8                                                 | ✅     |
| design-lint completeness      | Pass     | 95%                                               | ✅     |
| FR traceability (FR-1..FR-16) | All 16   | 16                                                | ✅     |
| Test scenario coverage        | All      | All E2E + INT mapped                              | ✅     |
| OQ-T-0 resolution consistency | Required | Consistent across HLD §3 / §6 / §9 + test spec §9 | ✅     |

## Open Questions Persisting Beyond This Phase

1. **OQ-1**: Timeline confirmation (carried from feature spec)
2. **OQ-2**: Tier-S Sentinel direction (keep or migrate to Cluster)
3. **OQ-4**: Lint hook severity (recommend `block`; confirm with team)
4. **OQ-5**: Slot-distribution dashboard ownership (Platform owns JSON, SRE owns alerts)
5. **OQ-T-0**: RESOLVED in this HLD (admin endpoints deferred; tests use in-process counter / direct APIs)
6. **OQ-H-1** (NEW): BullMQ #2964 fix verification — validate during Phase 4 SIT; watchdog spec defined
7. **OQ-H-2** (NEW): Canary path — pre-prod env between SIT and tier-M? If yes, recommend 7d soak there
8. **OQ-H-3** (NEW): Operator reconciliation tool — SCAN snippet only, or proper CLI tool?

## Next Phase

Run `/lld redis-dual-mode` after this commit lands. The LLD must:

- Decompose Phase 0 helper implementation into concrete file-level tasks (subscriber.ts, lua.ts, keys.ts, type widening).
- Resolve OQ-H-1 (verify BullMQ version contains #2964 fix; specify watchdog implementation if not).
- Specify ESLint custom rules (`no-redis-duplicate`, `no-redis-keys-command`) at the AST-rule level.
- Map every FR (FR-1..FR-16) to one or more LLD tasks with line-level patches.
