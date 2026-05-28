# HLD Phase Log — Arch Trace Explorer

**Skill**: `/hld`
**Ticket**: ABLP-162
**Feature**: arch-trace-explorer
**Feature Spec**: `docs/features/arch-trace-explorer.md` (committed c84400894)
**Test Spec**: `docs/testing/arch-trace-explorer.md` (committed c780af600)
**Date**: 2026-04-15
**Owner**: Platform team

---

## Oracle Decisions

The product-oracle was invoked with 17 clarifying questions (5 Architecture & Data Flow, 6 Integration & Dependencies, 6 Risk & Migration). All 17 answered — **0 AMBIGUOUS** — so no user escalation required.

### Summary by Classification

- **ANSWERED**: 13 (evidence in feature spec, existing code with exact file:line citations, or predecessor HLD precedent)
- **INFERRED**: 2 (AD-3 Next.js ALS caveats; RM-3 kill-switch semantics — both resolved with conservative recommendations)
- **DECIDED**: 2 (D-1 alternatives set + recommendation; D-2 risk ranking)
- **AMBIGUOUS**: 0

### Key DECIDED items (rationale captured)

| ID  | Decision                                                                          | Rationale                                                                                                                                                                                                             | Risk   |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-1 | Recommend Option C (new `packages/arch-ai/src/tracing/` module); reject A/B/D     | Only option that satisfies FR-2/FR-3/FR-7 and preserves pluggable-storage goal from feature spec §7; A re-entrenches duplicate-contract problem; B cross-couples Studio↔runtime; D requires collector out of v1 scope | Low    |
| D-2 | Highest risk is (d) AsyncLocalStorage propagation across SSE callbacks in Next.js | Two `streamText()` sites (L422, L6836) + Vercel AI SDK callback boundaries = highest-variance new failure surface; UI render is second; revision contention and regex CPU are architecturally mitigated               | Medium |

### Key INFERRED items

| ID         | Inference                                                                                                                                                                                                                                                                                                          | Source / Mitigation                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1 (AD-3) | Next.js App Router + Node runtime carries `AsyncLocalStorage` across awaits & promises; carries it into Vercel AI SDK callbacks (`onStepFinish`, tool `execute`). Breaks if: (a) `export const runtime = 'edge'` is added later; (b) buffered flush timer runs outside ALS scope (benign — flush doesn't need ALS) | Runtime pattern at `apps/runtime/src/services/tracing/tracer.ts:34,99-109`; `apps/studio/src/app/api/arch-ai/message/route.ts:14` already declares `force-dynamic`. HLD must assert "Arch trace routes run on Node, not Edge" to preempt drift. Optional experiment in §9 Open Questions. |
| I-2 (RM-3) | Kill-switch (`ARCH_TRACE_ENABLED=false`) applies at **both** construction time (factory returns no-op tracer) and per-emission guard (defensive check for config reloads). In-memory buffer at flip moment is dropped with a warning log                                                                           | Predecessor `ARCH_AUDIT_LOG_ENABLED` pattern at `apps/studio/src/app/api/arch-ai/sessions/route.ts:91`; defense-in-depth matches platform convention (both checks cheap; strict no-op is clearest operationally)                                                                          |

### Confirmed ANSWERED items (high-signal findings for HLD)

- **ID-3**: All required exports already present in `packages/shared-observability/src/tracing/index.ts:6-18` — `Tracer`, `Span`, `SpanContext`, `WritePipeline`, `generateTraceId`, `generateSpanId`. No pre-requisite export work.
- **ID-4**: `withRouteHandler({ requireProject, permissions })` already supported at `apps/studio/src/lib/route-handler.ts:77-98`; middleware ordering (project access before permission) at L174-205 is the exact mechanism that makes cross-project return **404 not 403** (per FR-12). Arch-trace-explorer introduces no new route-handler options.
- **ID-2**: `packages/observatory/` needs only additive widening of `TraceEventType` union at `trace-events.ts:241-268` plus appending new string values to `ALL_TRACE_EVENT_TYPES` array at L276-464. No new exports.
- **AD-2**: Single-writer-per-session invariant is enforced by the session state machine's `IDLE→ACTIVE` atomicity (VALID_STATE_TRANSITIONS at `session-state-machine.ts:19-30`) and the 409 SESSION_BUSY response at `message/route.ts:800`. No lock required.
- **AD-4**: Happy-path instrumentation points cite exact file:line — `sessions/route.ts:36-123` for root span; `message/route.ts:422, 6836` for both LLM call sites; `phase-machine.ts:95` for `transitionPhase` hook; `message/route.ts:547-582` for IDLE→ACTIVE (root-span name backfill).
- **RM-4**: Feature flag is a boolean env var (`.env.example:160-163` pattern; `CC-F04-feature-flag.md:13,35` idiom). No GrowthBook/LaunchDarkly. Per-tenant rollout is GAP-001.
- **RM-5**: Fire-and-forget isolation from `apps/runtime/src/services/tracing/write-pipeline.ts:30-106` is the canonical pattern to port. HLD must state the invariant: tracer exceptions never leak to coordinator execution; redaction failures fail **closed** ([REDACTION_FAILED] marker) per test spec INT-5b.
- **ID-1**: Legacy code (`packages/arch-ai/src/audit/`, `ArchAuditLogsTab.tsx`, 4 legacy routes) stays in place hidden behind flag per GAP-004; post-BETA cleanup PR.
- **ID-5**: No new third-party packages. `react-window` explicitly NOT introduced (virtualization deferred per GAP-T01).
- **ID-6**: Studio UI is the sole consumer. No OTel exporter, no ClickHouse bridge, no Admin Portal page in v1.
- **RM-2**: No data migration. New collections on first write. Per-session-era rollout (feature spec §7) — flag check at session creation pins store for session's lifetime. 90-day TTL on `arch_audit_logs` handles rollover naturally.
- **RM-6**: Feature is Studio-internal observability only. Zero cross-contamination with runtime agent execution; generated agents use runtime's separate `TracerImpl` + TraceStore.

### Cross-references

- Canonical tracing primitives: `packages/shared-observability/src/tracing/index.ts:6-18`
- Runtime reference implementation: `apps/runtime/src/services/tracing/` (`tracer.ts`, `span.ts`, `write-pipeline.ts`, `tracer-registry.ts`)
- Observatory read-side types: `packages/observatory/src/schema/spans.ts:18-60`, `trace-events.ts:241-268`
- Route handler + middleware ordering: `apps/studio/src/lib/route-handler.ts:77-98, 174-205`
- Permissions catalog: `apps/studio/src/lib/permissions.ts:15-63`
- Redaction utilities: `packages/compiler/src/platform/constructs/executors/{scrub-patterns.ts:22-41, trace-scrubber.ts:18-60}`, `packages/compiler/src/platform/security/pii-detector.ts`
- Model pricing: `packages/shared-kernel/src/model-pricing.ts:17-71`
- Coordinator phase machine: `packages/arch-ai/src/coordinator/phase-machine.ts:95`
- Session state machine: `packages/arch-ai/src/coordinator/session-state-machine.ts:19-30`
- Instrumentation targets: `apps/studio/src/app/api/arch-ai/message/route.ts:{14, 422, 547-582, 800, 6836}`; `sessions/route.ts:{36-123, 91-110}`
- Predecessor HLD (pattern for 12 concerns, alternatives structure): `docs/specs/arch-audit-logs.hld.md`
- Feature-flag idiom: `docs/arch/features/CC-F04-feature-flag.md:13, 35`; `apps/studio/.env.example:160-163`

---

## Phase Checkpoints

- [x] Phase 1: Feature + test specs read fresh from disk
- [x] Phase 1: Related HLDs (arch-audit-logs, arch-ai-assistant) scanned for patterns
- [x] Phase 1: Canonical tracing module inventoried (`shared-observability/src/tracing/`, `observatory/src/schema/`, runtime reference)
- [x] Phase 2: Oracle answered 17 questions, 0 escalated
- [x] Phase 2: Oracle decisions logged here
- [x] Phase 3: HLD generated — 4 alternatives (A/B/C/D) with Option C recommended; all 12 architectural concerns substantively addressed; system context + component + data-flow diagrams; data model matches feature spec §9; 9 new routes + 2 modified + 1 test-only seed
- [x] Phase 4: Design-lint validation (`tools/design-lint.sh`) — 95% completeness, 19 PASS, 0 MISS, 1 WARN (expected Open Questions count)
- [x] Phase 4b: Audit Round 1 — APPROVED with 0 CRITICAL, 2 HIGH, 5 MEDIUM, 5 LOW. HIGH items fixed inline (see §Audit Round 1 Fixes below)
- [x] Phase 4b: Audit Round 2 — APPROVED with 0 CRITICAL, 0 HIGH, 2 MEDIUM R2-NEW, 3 LOW R2-NEW. R2-NEW-M1 (Edge runtime prohibition) fixed inline as firm rule
- [x] Phase 4b: Audit Round 3 — APPROVED with 0 CRITICAL, 0 HIGH, 2 MEDIUM R3-NEW (HD-3 agentName, HD-4 estimateCost contract), 3 LOW R3-NEW — all forwarded as LLD carry-forward
- [ ] Phase 5: Committed with `[ABLP-162] docs(studio): add arch-trace-explorer HLD`

---

## Audit Round 1 Fixes (Applied)

| ID  | Level  | Finding                                                                                                                                              | Fix Applied                                                                                                                                                                         |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 | HIGH   | "4 legacy routes" ambiguity — audit-logs directory has 5 route files including `_seed`                                                               | §3 Component Diagram and §4 Concern 10 now enumerate the 4 production routes (`route.ts`, `summary/`, `sessions/[id]/timeline/`, `cost-breakdown/`) and explicitly exclude `_seed/` |
| H-2 | HIGH   | `arch_system_event` listed alongside normal-path events in §3; reader could assume it's emitted during normal execution                              | §3 arch-event-types now labels it "emitted ONLY for span-cap-exceeded & system conditions per FR-22, not normal execution"                                                          |
| M-2 | MEDIUM | HLD §4 Concern 12 said "11 unit scenarios"; test spec actually has 12 (UT-1..11 + UT-3b); "redaction-isolation" misplaced in unit list — it's INT-5b | Concern 12 rewritten to list all 12 UTs by ID and move INT-5b to integration tier; totals now 12/11/6                                                                               |
| M-4 | MEDIUM | `write-pipeline.ts:22-107` off-by-one; class starts at L23                                                                                           | §2 Option B updated to `:23-107`                                                                                                                                                    |
| M-5 | MEDIUM | §4 Concern 11 did not state that `NEXT_PUBLIC_*` is build-time-inlined (per CC-F04:38) and requires Studio rebuild to flip                           | Rewrote kill-switch (b) as "REQUIRES Studio rebuild + redeploy", citing `CC-F04-feature-flag.md:38`; kill-switch (a) marked "runtime-reloadable"                                    |

## Audit Round 2 Fixes (Applied)

| ID        | Level  | Finding                                                                                                             | Fix Applied                                                                                                                                                                     |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-NEW-M1 | MEDIUM | Oracle I-1 required HLD to assert "Arch trace routes run on Node, not Edge" — was only implicit via `force-dynamic` | §4 Concern 4 Security Surface now contains a FIRM rule: `export const runtime = 'edge'` is prohibited; every trace-affected route must run on Node. Open Q2 cross-references it |

## Audit Round 3 Findings (LLD Carry-Forward)

Per HLD playbook: "After round 3: proceed (log remaining findings)." No remaining CRITICAL or HIGH findings. The following items are carried forward for LLD to resolve:

| ID    | Level  | Finding                                                                                                                             | LLD Action                                                                                                                                                       |
| ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HD-3  | MEDIUM | Observatory `Span.agentName` is required at `packages/observatory/src/schema/spans.ts:49`; HLD `arch_trace_spans` document omits it | LLD decides: (a) `MongoTraceReader` projects `agentName: 'arch-ai'` at read time [recommended], (b) persist on every doc, (c) widen observatory type to optional |
| HD-4  | MEDIUM | UT-6 asserts `null` for unknown model; actual `estimateCost` at `shared-kernel/model-pricing.ts:65` falls back to `DEFAULT_PRICING` | LLD reconciles: either rewrite UT-6 or add strict-mode parameter to `estimateCost`. Addressable in LLD task 3.4                                                  |
| HD-10 | LOW    | IDLE→ACTIVE line range `547-582` is loosely inclusive; precise block is `L574-586` for transition + `L542-548` for busy guard       | LLD tightens line range in §3 sequence diagram or inherits the imprecision                                                                                       |
| HD-11 | LOW    | HLD §10 References omits brainstorm design doc that feature spec links                                                              | LLD adds `docs/superpowers/specs/2026-04-14-arch-trace-explorer-design.md` to References if desired                                                              |
| HD-12 | LOW    | Onboarding status-code matrix omits `403` (correctly — onboarding has no `permissions` wrapper), but asymmetry with project routes  | LLD adds a one-line note explaining intentional 403-absence on onboarding routes                                                                                 |

Additional non-blocking LLD notes from Round 1 + Round 2 (also to track):

1. `estimateCost` consumers list in `model-pricing.ts` header should add `packages/arch-ai/src/tracing/` when the first call site is wired (LLD task 3.4; original R1 M-3)
2. Both `streamText()` call sites (L422 + L6836) currently have NO `onStepFinish` callback; LLD must add (R1 L-1)
3. `ArchTraceSpanModel` should reuse the `uuidv7` import from `packages/database/src/mongo/base-document.ts` (pattern in `arch-audit-log.model.ts:14,77`) (R1 LLD note)
4. `ArchSpan.setAttribute(key, value)` stringification boundary needs documentation for numeric attrs (R2 non-blocking)
5. `stats` endpoint aggregation over `Map<string, string>` needs `$toInt`/`$toDouble` in pipelines (R2 non-blocking)
6. `arch_trace_spans` TTL on still-running spans (feature spec Open Q4 = HLD Open Q6) — confirm acceptable behavior during ALPHA
7. `arch:traces:read` default grant policy (feature spec Open Q1 = HLD Open Q1) — blocks BETA, not ALPHA
8. Observability log-line shape for flush success/failure/revision-claim/upsert-fallback should be defined in LLD so log-based alerting is possible at ALPHA (R1 non-blocking)

---

## Cumulative Audit Totals (3 rounds)

- **CRITICAL**: 0 (no critical issues at any round)
- **HIGH**: 2 (both Round 1, both resolved inline)
- **MEDIUM**: 9 (R1: 5 — 3 resolved inline, 2 non-blocking; R2-NEW: 2 — 1 resolved inline, 1 LLD; R3-NEW: 2 — both LLD)
- **LOW**: 13 (R1: 5 non-blocking; R2-NEW: 3 non-blocking; R3-NEW: 3 non-blocking; + 2 micro-nits)

**Net**: 0 HLD-blocking findings remain. 5 findings explicitly forwarded to LLD. HLD is production-ready; proceed to `/lld arch-trace-explorer`.

---
