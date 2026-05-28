# Test-Spec Phase Log — redis-dual-mode

**Slug**: `redis-dual-mode`
**Phase**: 2 of 6 (Test Spec)
**Owner**: Platform team
**Started**: 2026-05-04
**Worktree**: `.worktrees/redis-cluster-dual-mode`
**Branch**: `worktree-redis-cluster-dual-mode`
**Inputs**: Committed feature spec at `docs/features/redis-dual-mode.md` (commit `eac0b00fcf`)

---

## Oracle Decisions (Phase 2)

Oracle answered 18/18 clarifying questions. **Zero AMBIGUOUS items** — no escalations required.

Full Q&A persisted to `docs/sdlc-logs/redis-dual-mode/test-spec.log.md` (the oracle's own output file).

Key decisions:

- **Test isolation strategy** (D-2): `FLUSHALL` per master + `describe.sequential` (matches existing pattern in `redis-circuit-breaker.integration.test.ts`)
- **CI cadence** (D-1): Standalone parity on every PR; cluster suite nightly + opt-in PR via label `[run:cluster-tests]`
- **Failover simulation** (D-3): Graceful via programmatic `CLUSTER FAILOVER`; ungraceful via `docker stop` + `cluster-node-timeout` wait

## Audit Round 1 — phase-auditor (NEEDS_REVISION)

5 HIGH findings, 4 MEDIUM. All addressed:

- **HIGH TS-4**: E2E-3 step 5 + E2E-WIRE-1 steps 4-5 directly inspected Redis → moved to admin HTTP endpoints (E2E-3) and to INT-3 (E2E-WIRE-1)
- **HIGH TS-7**: GAP-003 (session-store pipeline race) had no scenario → added INT-11 (tight-loop `resolveTenantId`)
- **HIGH TS-7**: GAP-005 (`scanKeys` mid-failover dedupe) had no scenario → added INT-12 (`@chaos`-tagged, both graceful + ungraceful failover)
- **HIGH TS-3**: FR-6/FR-7 had only lint coverage → added INT-13 / INT-14 static-analysis tests for migration completeness
- **HIGH TS-9**: Studio E2E file used `.cluster.e2e.test.ts` (mismatched convention) → renamed to `trigger-form-errors-cluster.spec.ts`
- **MEDIUM**: FR-12 matrix Integration column corrected, metrics observation explicitly via `GET /metrics`, E2E-ERR-1 framing clarified, harness `forceFailover` wrapper referenced

## Audit Round 2 — phase-auditor (APPROVED)

All round-1 HIGH findings verified resolved. 3 remaining MEDIUM (non-blocking):

- **MEDIUM TS-4**: E2E expected results still contained slot-co-location assertions → reworded to point to integration-tier scenarios; HTTP-only assertions remain in E2E
- **MEDIUM TS-8**: Test scenarios assume admin endpoints (`/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/invalidate|keys`) and `GET /metrics` that do not exist today → flagged as **OQ-T-0** for the HLD phase to reconcile
- **MEDIUM TS-3**: FR-15 row Integration column inconsistency → updated to `✅(BullMQ via INT-3)`

## Counts (Quality Gates)

| Gate                                    | Required         | Actual         | Status |
| --------------------------------------- | ---------------- | -------------- | ------ |
| E2E scenarios                           | ≥ 5              | 7              | ✅     |
| Integration scenarios                   | ≥ 5              | 14             | ✅     |
| Coverage matrix FR rows                 | All 16           | 16             | ✅     |
| Failure-path rows in matrix             | ≥ 1 per mutation | 6              | ✅     |
| Form error path E2E                     | ≥ 1              | 1 (E2E-ERR-1)  | ✅     |
| Wiring verification E2E                 | ≥ 1              | 1 (E2E-WIRE-1) | ✅     |
| Auth context per E2E                    | All              | All 7          | ✅     |
| No `vi.mock` of platform components     | Required         | None           | ✅     |
| No direct DB/Redis access in E2E bodies | Required         | None           | ✅     |

## Files Created / Modified

- Modified: `docs/testing/redis-dual-mode.md` (rewritten from placeholder to full test spec — 14 INT scenarios, 7 E2E, 4 unit, 6 ERR rows in matrix)
- Created: `docs/sdlc-logs/redis-dual-mode/test-spec.log.md` (oracle Q&A — written by oracle agent)
- Created: `docs/sdlc-logs/redis-dual-mode/test-spec-phase.log.md` (this file — phase log + audit trail)

## Open Questions Persisting Beyond This Phase

1. **OQ-T-0** (HLD-bound): Reconcile assumed admin endpoints (`/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/invalidate|keys`) and `GET /metrics` exposure with the feature spec's "no new HTTP endpoints" stance.
2. **OQ-T-1**: Cluster reuse across files vs per-`describe` (HLD/LLD)
3. **OQ-T-2**: Programmatic vs shell-out failover for `@chaos` tests
4. **OQ-T-3**: BullMQ Worker stall (GAP-008) automated detection
5. **OQ-T-4**: E2E-WIRE-1 negative-case coverage
6. **OQ-T-5**: `defineCommand` migration audit pending

## Next Phase

Run `/hld redis-dual-mode` after this commit lands. The HLD must address OQ-T-0 (admin endpoints + `/metrics` exposure scope decision).
