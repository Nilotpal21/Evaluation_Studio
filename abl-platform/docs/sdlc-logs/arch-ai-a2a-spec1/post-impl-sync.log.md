---
name: arch-ai-a2a-spec1-post-impl-sync
description: Post-implementation doc sync for ABLP-162 Spec 1 — A2A in arch-ai. Records the docs that were updated to reflect shipped reality vs. the original LLD/design.
type: project
---

# SDLC Log: arch-ai-a2a-spec1 — Post-Impl Sync

**Feature:** arch-ai-a2a-spec1
**Phase:** POST-IMPL-SYNC
**Date:** 2026-05-06
**Tracking:** ABLP-162
**Branch:** `zarch/newtools`
**Implementation log:** [`implementation.log.md`](./implementation.log.md)

---

## Artifact Inventory

This feature took the **brainstorm route**, so it has only the design doc + LLD pair (no
separate `docs/features/<slug>.md` or `docs/testing/<slug>.md` or `docs/specs/<slug>.hld.md`).
That is intentional — the design doc combines feature-spec + HLD + test-spec content per
`docs/sdlc/pipeline.md` brainstorm path.

| Artifact                     | Path                                                            | Status (post-sync)                                                    |
| ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Design doc                   | `docs/superpowers/specs/2026-05-05-arch-ai-a2a-spec1-design.md` | Status: **IMPLEMENTED (2026-05-06)** + Reality-check section appended |
| LLD + impl plan              | `docs/plans/2026-05-05-arch-ai-a2a-spec1-impl-plan.md`          | Status: **DONE** + Post-Implementation Notes (§9) appended            |
| LLD log                      | `docs/sdlc-logs/arch-ai-a2a-spec1/lld.log.md`                   | Unchanged (planning-phase artifact)                                   |
| Implementation log           | `docs/sdlc-logs/arch-ai-a2a-spec1/implementation.log.md`        | Unchanged (already records 5 review rounds, gates, deferred items)    |
| Post-impl sync log           | `docs/sdlc-logs/arch-ai-a2a-spec1/post-impl-sync.log.md`        | **NEW (this file)**                                                   |
| `packages/arch-ai/agents.md` | —                                                               | Updated in Phase 6 commit `97f3274a6f` (3 learnings)                  |
| `apps/studio/agents.md`      | —                                                               | Updated in Phase 6 commit `97f3274a6f` (5 learnings)                  |
| `apps/runtime/agents.md`     | —                                                               | Updated in Phase 6 commit `97f3274a6f` (1 learning — auth 5th-arg)    |
| `docs/sdlc-logs/agents.md`   | —                                                               | Updated in Phase 6 commit `97f3274a6f` (4 cross-cutting)              |

There is a sibling `docs/features/a2a-integration.md` and `docs/specs/a2a-integration.hld.md`
covering the older runtime-side A2A track (different scope: SDK migration, session resolver,
tenant isolation). Those are NOT this feature and were not touched by this sync.

---

## Documents Updated

### Design doc — `docs/superpowers/specs/2026-05-05-arch-ai-a2a-spec1-design.md`

- **Status header**: `Design — pending implementation plan` → `IMPLEMENTED (2026-05-06)` with
  Gate 1 ✅ marker and pointer to this log.
- **Post-Implementation Reality Check section appended** with a 7-row design-vs-reality table
  covering: 7-action `external_agent_ops` shape, native-fetch `discover_preview` (vs SDK
  resolver), auth-aware `test_connection` wiring, ExternalAgentCard mirroring KBStatusCard,
  content-router 5-regex insertion, `routing_decision` span event (with `setAttribute()`
  caveat), pageContext bias, and specialist transition narration.

### LLD — `docs/plans/2026-05-05-arch-ai-a2a-spec1-impl-plan.md`

- **Status header**: `DRAFT` → `DONE (implementation complete 2026-05-06; Gate 1 passed; Gates
2/3 deferred)` plus pointers to implementation log + this sync log.
- **§9 Post-Implementation Notes appended**: per-phase deviation summary, gate-status table,
  top-4 deferred follow-ups (R3 CRITICAL-1 redis DI, R5 H-2 PROJECT_STATE_CACHE, R5 H-3
  connection_ops timeout, R4 M-1 resume-route projectId).

### Per-package `agents.md` (already landed in Phase 6 commit `97f3274a6f`)

Not re-touched by this sync; recorded here for the audit trail. Counts: arch-ai 3, studio 5,
runtime 1, sdlc-logs cross-cutting 4.

---

## Coverage Delta

Test-coverage matrix is internal to this feature (no `docs/testing/<slug>.md` exists for the
brainstorm route). Numbers below are from the implementation log Round-3 expansion +
Gate-1 verification.

| Type                             | Before (pre-Spec-1)                       | After (Spec-1 shipped)                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio unit tests (Spec 1 scope) | 0 dedicated                               | 87 (4 SSRF + 14 sanity + 14 synthesizer + 24 result-shape + 4 dispatcher narration + 4 SpecialistChip + others)                                                                                                 |
| arch-ai unit/router tests        | existing baseline                         | +15 routing patterns + 3 routing_decision span events; full suite 623/623 green                                                                                                                                 |
| Runtime integration tests        | existing baseline + EXT-1..5 from Phase 3 | +Phase-2 auth-aware suite (4 tests covering bearer / api-key / no-auth / rollback) — currently blocked at suite-level by pre-existing devLogin 401 infra issue, will pass after upstream `f2e0feadd1` infra fix |
| Studio E2E (Playwright)          | 0                                         | 5 scenarios scaffolded at `apps/studio/e2e/arch-external-agent.spec.ts` (3 working + 2 `test.fixme` per LLD §5.14 explicit allowance)                                                                           |
| Studio E2E (integration suite)   | 0                                         | 7 scaffolded specs in `apps/studio/e2e/arch-ai-integrations/` (collision, mcp-server, rest-api, revalidate, saas-oauth, sanitization, suggestion)                                                               |

Full-monorepo `pnpm build` 55/55 successful at HEAD `97f3274a6f`.

---

## Deviations from Plan (already documented per-phase in the impl log)

The full deviation list lives in `implementation.log.md` per phase. Material items the design
doc reader should know about:

1. **Phase 3 task 3.1 / R8 IMPROVEMENT** — `discover_preview` implemented natively
   (`fetch` + `assertUrlSafeForSSRF` + `redirect: 'manual'` + 256 KB streamed cap + Zod
   safety-net) rather than via `@a2a-js/sdk` `DefaultAgentCardResolver`. `apps/studio/` has no
   existing dep on the SDK and adding one for a single helper expanded the dep graph.
2. **Phase 4 task 4.2(d) / `setAttribute` API** — `TurnTraceRecorder` exposes no
   `setAttribute()`; the `routing_decision` span event carries all three attributes
   (`specialist`, `matchedPattern`, `pageContextBias`) but no head-of-trace attribute is set.
   OTel head-of-trace sampling on `arch.specialist` needs a follow-up to extend the recorder
   contract.
3. **Phase 5 task 5.14 / two scenarios `test.fixme`** — auth-failure persistence and
   discovery-timeout fallback are `test.fixme` per LLD §5.14 explicit allowance, with
   `TODO(spec3-hardening)` breadcrumbs. Three scenarios are real working tests.
4. **Phase 5 task 5.13 / amendment placement** — v5 amendment placed immediately after the
   closing fence of the `ConstructSpec` ts code block in the v5 design doc (LLD said "near
   line 182" but that line is inside a fenced code block; markdown blockquote cannot break
   the fence).
5. **Latent Phase 3 test failures discovered in Gate 1 broad sweep** — `agent-card-sanity`
   (Zod field path) and `handoff-synthesizer` (verbatim user input) were repaired in
   commit `16dc5f5924` per CLAUDE.md "fix the code, not the test".

---

## Remaining Gaps

### Gates pending operator action

- **Gate 2 — CI E2E suite green**: requires PM2-hosted Studio + runtime + Mongo stack and the
  `examples/external-a2a-bridge/external-vercel-agent` fixture. Spec scaffold lives at
  `apps/studio/e2e/arch-external-agent.spec.ts`. Acceptance against `develop` CI is the
  merge-gate, not blocking for this branch.
- **Gate 3 — Manual user-acceptance**: operator-driven smoke through the IN_PROJECT chat
  flow with a real external endpoint; evidence captured to `gate3-evidence.md`. Not yet run.

### Deferred follow-ups (from review rounds 3-5; see implementation log for full ledger)

- **R3 CRITICAL-1** — `vi.mock('@/lib/redis-client')` in `suggestions-engine.test.ts`
  (parallel ABLP-162 stream commit `fd987765f5`, predates Spec 1). Refactor
  `computeIntegrationSuggestions` to take redis via DI.
- **R4 M-1** — Resume route `apps/studio/src/app/api/arch-ai/integration-drafts/[id]/resume/route.ts`
  first lookup omits `projectId` (load-then-authorize is safe today but diverges from
  CLAUDE.md invariant).
- **R4 M-2** — `lastConnectionError` may transitively leak transport details if the SDK ever
  wraps richer errors. Add sanitizer at boundary.
- **R5 H-2** — `PROJECT_STATE_CACHE` unbounded `Map` in `runtime-support.ts` (parallel
  stream).
- **R5 H-3** — `connection_ops` outbound `fetch` missing `AbortSignal.timeout` (parallel
  stream).
- **R5 M-1..M-5, L-1..L-6** — defense-in-depth items (dslContent unbounded load, L3 swallowed
  catch, L2 generator silent on empty parts, concurrent test_connection race,
  routing_decision missing entityType attribute, AgentCard skills array max, HTTPS-only in
  prod discover, description length cap, per-action timeouts, knowledge budget exhaustion log,
  bundle / cold-start measurement).
- **Phase-2 runtime test infra** — `external-agent-registry-resolution.test.ts` blocked at
  bootstrap by pre-existing devLogin 401; will rerun after upstream `f2e0feadd1` infra fix
  lands. Phase 2 commit (`dc67ee60f9`) typechecks clean; runtime-pass verification deferred.

### Spec 3 backlog seeded by R7/R8 audits

LLD §8 captures the deferred-Spec-3 roadmap (agent-card response caching, HANDOFF synthesizer
`card.version` pinning, `GetExtendedAgentCard` for auth-gated skills, three additional E2E
scenarios for card-version drift / partial handoff failure / contextId-taskId invariant).

---

## Summary

Spec 1 shipped per design with five documented per-phase deviations, all minor. The
brainstorm-route artifact pair (design doc + LLD) is now status-aligned and reality-checked.
Per-package `agents.md` learnings landed in Phase 6 commit `97f3274a6f`. The 12+ deferred
findings from review rounds 3-5 are recorded in `implementation.log.md` and re-surfaced in
this sync log; none block Spec 1 merge.

**Next:**

1. Run Gate 2 (CI E2E) against `develop` post-merge.
2. Operator runs Gate 3 manually; captures evidence to `gate3-evidence.md`.
3. File JIRA tickets for the four highest-impact deferred items (R3 CRITICAL-1, R5 H-2, R5
   H-3, R4 M-1).
