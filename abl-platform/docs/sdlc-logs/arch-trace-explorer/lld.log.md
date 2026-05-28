# LLD Phase Log — Arch Trace Explorer

**Skill**: `/lld`
**Ticket**: ABLP-162
**Feature**: arch-trace-explorer
**Feature Spec**: `docs/features/arch-trace-explorer.md` (committed c84400894)
**Test Spec**: `docs/testing/arch-trace-explorer.md` (committed c780af600)
**HLD**: `docs/specs/arch-trace-explorer.hld.md` (committed e367c6298)
**Date**: 2026-04-15
**Owner**: Platform team

---

## Oracle Decisions

The product-oracle was invoked with 22 clarifying questions (5 Implementation Strategy, 7 Technical Details, 6 Risk & Dependencies, plus 4 follow-ups re-aggregated). All 22 answered — **0 AMBIGUOUS** — so no user escalation required.

### Summary by Classification

- **ANSWERED**: 8 (IS-3, IS-4, TD-6, RD-2, RD-3, RD-5, RD-6, plus evidence-pinned items)
- **DECIDED**: 11 (IS-1, IS-2, IS-5, TD-1, TD-2, TD-3, TD-4, TD-5, TD-7, RD-1, RD-4)
- **INFERRED**: 3 (lifecycle criteria derived from §14 + §16; sub-commit strategy from predecessor pattern; volatility mitigation from git log)
- **AMBIGUOUS**: 0

### Key DECIDED items

| ID    | Decision                                                                                                                                                                               | Rationale                                                                                                                                                                               | Risk   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-IS1 | **5-phase plan**: Data Layer → Tracing Core → Mongo Provider → Routes → Emission Wiring+UI                                                                                             | Extends predecessor 4-phase pattern; keeps each phase ≤40 files per CLAUDE.md commit scope guard; provider separation lets core land before storage                                     | Low    |
| D-IS5 | **Two-step UI replacement**: Phase 5 adds `TraceExplorer` behind flag (legacy tab remains); separate follow-up PR removes `ArchAuditLogsTab`                                           | CLAUDE.md deletion-ratio-guard blocks >30% deletion in feat commits; GAP-004 explicitly plans legacy cleanup as post-BETA PR                                                            | Low    |
| D-TD1 | **Instrument `transitionPhase()` at the single call site** in `message/route.ts:4940` — keep `packages/arch-ai/src/coordinator/phase-machine.ts` pure                                  | Only 1 production caller + 20 test callers; hook parameter would break signature; HOF pattern adds indirection for zero benefit                                                         | Low    |
| D-TD2 | **3-event lifecycle (`span_start`/`span_update`/`span_end`) implemented inside `ArchSpanImpl`** via existing `WritePipeline.write(event)` — NO shared-observability interface widening | `WritePipeline.write(event: Record<string, unknown>)` already accepts any shape; `MongoWritePipeline.write()` switches on `event.type`; runtime's 1-event pattern insufficient for FR-4 | Low    |
| D-TD3 | **`MongoTraceReader` projects `agentName: 'arch-ai'` at read time** — do NOT persist on docs; do NOT widen observatory type                                                            | HLD-recommended (HD-3); agentName is a constant, persisting wastes bytes × millions of docs; widening crosses packages                                                                  | Low    |
| D-TD4 | **Update UT-6 to match actual `estimateCost()` fallback behavior** — code stays; test asserts `DEFAULT_PRICING` for unknown models (not `null`)                                        | `estimateCost` returning `DEFAULT_PRICING` is the real contract at `shared-kernel/model-pricing.ts:51-71`; changing code breaks runtime/arch-ai-assistant/model-hub callers             | Low    |
| D-TD5 | **Per-request `MongoTraceReader` construction via DI** in route handlers; `MongoWritePipeline` cached once per session in `tracerRegistry` keyed by sessionId                          | Matches predecessor `AuditLogEmitter` pattern; enables tests without `vi.mock` (CLAUDE.md Test Architecture); Next.js has no reliable process-lifetime singleton                        | Low    |
| D-TD7 | **Implement all 4 `_seed` actions (`seedSpans`/`updateStatus`/`bubbleError`/`reset`) in one commit**                                                                                   | ~95% shared scaffolding (auth + guard + tracer construction); splitting adds commit round-trips without safety benefit                                                                  | Low    |
| D-RD1 | **Skip Phase-0 ALS experiment** — rely on INT-7 as regression guard with explicit `tracer.run(span, fn)` fallback if ALS fails                                                         | HLD §9 Q2 calls experiment "optional"; runtime pattern proven; fallback is <2h cost                                                                                                     | Low    |
| D-RD4 | **5 sub-commits for 5 instrumentation sites** in `message/route.ts`; no pre-extract refactor                                                                                           | Predecessor did this successfully; fire-and-forget semantics isolate failures; feat commits stay additive                                                                               | Medium |
| D-IS2 | **Predecessor 4-phase structure with one added phase** — NOT a fresh structure for tracing architecture                                                                                | Complexity drivers (ALS, 3-event lifecycle, revision counter, fail-closed redaction) fit inside tasks, not phases                                                                       | Low    |

### Key ANSWERED items (high-signal findings for LLD)

- **IS-3**: `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=false` default across all phases, build-time-inlined, flipped only at ALPHA. `ARCH_TRACE_ENABLED=true` default, runtime-reloadable. Independent lifecycle.
- **IS-4**: Per-session-era routing at `sessions/route.ts` creates the branch (`tracingStore: 'trace-spans' | 'audit-logs'`) pinned to each session for its lifetime. Required in Phase 5 even with flag default-off.
- **RD-2**: `message/route.ts` is **7,479 lines** (HLD cited 6,836 — file has grown). Line refs will drift. Use **semantic anchors** (function names, call patterns) in file-change map, not literal line numbers.
- **RD-3**: `mongodb-memory-server ^11.0.1` already declared in `packages/database/package.json:158` and `apps/studio/package.json:162`. Must be added to `packages/arch-ai/package.json` devDependencies.
- **RD-5**: Lifecycle criteria:
  - **ALPHA**: 12/12 unit + 11/11 integration + ≥5/6 E2E; flag default=false; `/post-impl-sync` run
  - **BETA**: flag default=true; Open Q1 resolved (arch:traces:read grants); 2 weeks ALPHA + zero incidents; E2E-5 passing
  - **STABLE**: 4 weeks BETA; GAP-004 cleanup PR shipped (delete legacy); `arch_audit_logs` collection dropped
- **RD-6**: Per-session-era rollout (flag check at session creation) prevents double emission. Missing `tracingStore` field → default to legacy path.
- **TD-6**: vitest process-level parallelism guarantees unique `MongoMemoryServer` ports across suites. Try/catch-and-skip in `beforeAll` handles binary download failures.

### Cross-references

- Runtime reference pattern: `apps/runtime/src/services/tracing/{tracer.ts:34-108, span.ts:26-104, write-pipeline.ts:23-107}`
- Canonical interface: `packages/shared-observability/src/tracing/{index.ts:6-18, write-pipeline.ts}` — single-method `write(event: Record<string, unknown>): void`
- Predecessor LLD (pattern source): `docs/plans/2026-04-12-arch-audit-logs-impl-plan.md`
- Predecessor audit emitter: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- Sole production call site of `transitionPhase()`: `apps/studio/src/app/api/arch-ai/message/route.ts:4940`
- Canonical pricing contract: `packages/shared-kernel/src/model-pricing.ts:51-71` (`DEFAULT_PRICING` fallback, never null)
- Observatory required `agentName` field: `packages/observatory/src/schema/spans.ts:49`
- Permissions catalog: `apps/studio/src/lib/permissions.ts:15-63`
- Route handler factory (middleware ordering): `apps/studio/src/lib/route-handler.ts:108-220`

---

## Phase Checkpoints

- [x] Phase 1: Feature spec + HLD + test spec read fresh from disk
- [x] Phase 1: Source inventory (runtime tracer, phase-machine, route-handler, predecessor patterns)
- [x] Phase 2: Oracle answered 22 questions, 0 escalated
- [x] Phase 2: Oracle decisions logged here
- [ ] Phase 3: LLD generated — 5 phases with measurable exit criteria, file-level change map, wiring checklist, cross-phase concerns, lifecycle criteria
- [ ] Phase 4: FR mapping validated (every FR-1..FR-23 traces to at least one task)
- [x] Phase 4b Round 1: lld-reviewer — **NEEDS_REVISION** with 1 CRITICAL, 4 HIGH, 7 MEDIUM, 3 LOW. **All fixed inline** (see "Audit Round 1 Fixes" below)
- [x] Phase 4b Round 2: lld-reviewer — **NEEDS_REVISION** with 2 CRITICAL, 3 HIGH, 5 MEDIUM, 2 LOW. **All fixed inline** (see "Audit Round 2 Fixes" below; added 4 new Decision Log entries D-16..D-19)
- [x] Phase 4b Round 3: lld-reviewer — **APPROVED**. 23/23 FRs, 29/29 test scenarios, 4/5 HLD carry-forwards covered. 2 LOW findings: HD-12 fixed inline; UT-6 test-spec stale language tracked as post-impl-sync reconciliation
- [x] Phase 4b Round 4: phase-auditor — **APPROVED**. 0 CRITICAL, 0 HIGH, 6 MEDIUM polish items all fixed inline (test-file count, GAP-T enumeration, HLD Open-Q traceability, E2E-3 stub, Phase 2/3 dependency phrasing, Phase DAG)
- [x] Phase 4b Round 5: lld-reviewer — **APPROVED**. 0 CRITICAL, 0 HIGH, 2 MEDIUM polish items fixed inline (permission default-grant location corrected to `packages/shared-auth/src/rbac/role-permissions.ts`; env var count 7 → 8)
- [ ] Phase 5: Committed with `[ABLP-162] docs(studio): add arch-trace-explorer LLD + implementation plan`

---

## Audit Round 5 Fixes (Applied)

| ID  | Level  | Finding                                                                                                                                                                                                                        | Fix Applied                                                                                                                                                                                                                                      |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-1 | MEDIUM | Permission default-grant arrays don't live in `apps/studio/src/lib/permissions.ts` (that's just the catalog constant). They live in `packages/shared-auth/src/rbac/role-permissions.ts:34-111` under `TENANT_ROLE_PERMISSIONS` | Phase 4.1 rewritten as two-file update: catalog constant stays in `permissions.ts`; default grants append to `TENANT_ROLE_PERMISSIONS.ADMIN` (OWNER already covered by `'*:*'` wildcard). Modified Files table updated; wiring checklist updated |
| M-2 | MEDIUM | Env var count drift — LLD said "7 env vars: ARCH*TRACE*_ (6)" but actual count is 7 ARCH*TRACE*_ + 1 flag = 8                                                                                                                  | Corrected to 8 across Modified Files table, Phase 5.12 task, and Phase 5 exit criterion                                                                                                                                                          |

**Net after Round 5**: both findings resolved inline. LLD ready for commit.

---

## Cumulative Audit Totals (5 rounds)

- **CRITICAL**: 3 total (R1: 1 cascade seam; R2: 2 API signature + raw auth divergence) — all resolved inline
- **HIGH**: 7 total (R1: 4; R2: 3) — all resolved inline
- **MEDIUM**: 22 total (R1: 7; R2: 5; R3: 0; R4: 6; R5: 2) — 22 resolved inline
- **LOW**: 9 total (R1: 3; R2: 2; R3: 2 — HD-12 resolved; R4: 2; R5: 0) — all resolved
- **New Decision Log entries added during audits**: 4 (D-16 through D-19)
- **Code verification agents run**: 5

**Net**: 0 blocking findings remain. LLD is production-ready. Proceed to commit.

---

## Per-Package agents.md Updates (Phase 5 commit)

- `packages/arch-ai/agents.md` — append "Tracing module landed at `src/tracing/` implementing shared `Tracer` + `WritePipeline` contracts; canonical pattern for future observability plugins"
- `packages/database/agents.md` — append "Tenant-delete cascade in `src/cascade/cascade-delete.ts:deleteTenant()` extended with `ArchTraceSpan` + `ArchTraceSession` (pre-existing ArchAuditLog/ArchSession/ArchJournal gap tracked separately)"
- `packages/observatory/agents.md` — append "`TraceEventType` union + `ALL_TRACE_EVENT_TYPES` array widened additively with 6 `arch_*` event types"
- `packages/shared-observability/agents.md` — append "No interface changes; `Tracer`/`Span`/`SpanContext`/`WritePipeline` exports at `src/tracing/index.ts:6-18` confirmed and used unchanged by arch-ai tracing module"
- `apps/studio/agents.md` — append "Arch trace explorer routes at `/api/projects/[id]/arch-ai/traces/*` (project-scoped, permission-gated) + `/api/arch-ai/traces/onboarding/*` (user-scoped); test-only `_seed` endpoint with 4-action discriminated union; TraceExplorer UI at `src/components/admin/` gated behind `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER`"
- `docs/sdlc-logs/agents.md` (cross-cutting) — append "LLD + 5 audit rounds (3 CRITICAL + 7 HIGH + 22 MEDIUM + 9 LOW findings, all resolved) demonstrates discipline of reading every cited file:line fresh; pattern: always verify the cascade/route-handler/API-helper signature BEFORE writing the LLD prescription"
- [ ] Phase 4b Round 3: lld-reviewer — completeness
- [ ] Phase 4b Round 4: phase-auditor — cross-phase consistency
- [ ] Phase 4b Round 5: lld-reviewer — final sweep
- [ ] Phase 5: Committed with `[ABLP-162] docs(studio): add arch-trace-explorer LLD + implementation plan`

---

## Audit Round 1 Fixes (Applied)

| ID  | Level    | Finding                                                                                                                                             | Fix Applied                                                                                                                                                                                                                                                                      |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | CRITICAL | LLD §Phase 1.5 claimed "predecessor wired identical hook" — verified FALSE. `packages/database/src/cascade/cascade-delete.ts` has zero `Arch*` refs | Phase 1.5 rewritten: exact file path `packages/database/src/cascade/cascade-delete.ts` + function `deleteTenant()` at L49; code snippet for the 2 `deleteMany` lines; documented pre-existing predecessor gap as out-of-scope + mandates a separate ticket before Phase 1 commit |
| H-1 | HIGH     | `tracerRegistry` per-pod cache — multi-pod Studio correctness not addressed                                                                         | New §5 "Deployment Topology Assumption" documents SSE-sticky LB requirement + graceful-shutdown plan; Phase 1 implementer confirms stickiness with deploy team before Phase 3                                                                                                    |
| H-2 | HIGH     | Response envelope hand-build risk — LLD didn't cite `api-response.ts` helpers                                                                       | Phase 4.2 task now specifies: every response uses `successJson` / `errorJson` from `apps/studio/src/lib/api-response.ts`; grep exit criterion blocks `NextResponse.json` direct usage in new trace routes                                                                        |
| H-3 | HIGH     | Globally-unique `spanId` cross-scope verification missing                                                                                           | INT-1 now has an explicit sub-case: `spanId` from tenant-B requested by tenant-A → 404; tests scope-in-query, not post-verify                                                                                                                                                    |
| H-4 | HIGH     | INT-5b only tested `scrubSecrets` throwing — `redactPII` + pathological inputs not covered                                                          | INT-5b expanded with three fail-closed sub-cases: (a) scrubSecrets throws; (b) redactPII throws on Map/circular/non-string; (c) attribute serialization throws — all yield `[REDACTION_FAILED]` marker                                                                           |
| M-1 | MEDIUM   | `force-dynamic` declaration not grep-verifiable from exit criteria                                                                                  | Phase 4 exit criteria: `grep -rn "export const dynamic = 'force-dynamic'" ... \| wc -l` equals 10                                                                                                                                                                                |
| M-2 | MEDIUM   | `runtime = 'edge'` absence not grep-verifiable                                                                                                      | Phase 4 exit criteria: `grep -rn "runtime = 'edge'" apps/studio/src/app/api/` returns 0 lines                                                                                                                                                                                    |
| M-3 | MEDIUM   | `ARCH_TRACE_ENABLED` runtime-reload needs per-emission re-read, not constructor-cache                                                               | Phase 3.1 pinned: `if (process.env.ARCH_TRACE_ENABLED === 'false') return` as first statement of `write()`; re-read every call                                                                                                                                                   |
| M-4 | MEDIUM   | `rawPayloads` mid-session flip behavior unspecified                                                                                                 | Phase 3.1 pinned: `rawPayloads` read ONCE at `tracerRegistry.getOrCreate()` construction time; frozen for session lifetime; new sessions pick up new value                                                                                                                       |
| M-5 | MEDIUM   | UT-11 ambiguous re: partial `bulkWrite` failure                                                                                                     | UT-11 expanded with explicit sub-case: ordered bulkWrite where ops 1-2 commit + ops 3-10 fail; assert no exception, buffer cleared, warn log, revision gaps harmless                                                                                                             |
| M-6 | MEDIUM   | `expiresAt` running-span TTL orphan case not called out in types                                                                                    | Inline comment added to `IArchTraceSpan.expiresAt` field documenting absolute pre-computed TTL + descendant-orphan behavior (ALPHA-acceptable per HLD Open Q6)                                                                                                                   |
| M-7 | MEDIUM   | `tracerRegistry.dispose()` call-site not pinned                                                                                                     | Wiring checklist now specifies: called from SSE stream's `finally` block in `message/route.ts` on session terminal (DONE/ERROR/ARCHIVED); `process.on('SIGTERM')` calls `flushAll()` for graceful shutdown                                                                       |
| L-1 | LOW      | `tenantIsolationPlugin` no-op behavior without ALS unverified                                                                                       | Phase 1 exit criteria: plugin applied to both new models AND verified to no-op when ALS not registered                                                                                                                                                                           |
| L-2 | LOW      | Logger namespace consistency                                                                                                                        | Phase 2.6 documents: use `'arch-ai:tracing'` across package + Studio; do NOT create `'api:arch-ai:tracing'`                                                                                                                                                                      |
| L-3 | LOW      | Observatory widening exhaustive-switch regression                                                                                                   | Phase 1 exit criteria: `pnpm build` at repo root succeeds with 0 errors                                                                                                                                                                                                          |

**Net after Round 1**: all 15 findings resolved inline. LLD ready for Round 2.

---

## Audit Round 2 Fixes (Applied)

| ID  | Level    | Finding                                                                                                                                                                                | Fix Applied                                                                                                                                                                                                                                                                                                                 |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | CRITICAL | `successJson(data, options?)` is wrong — real signature is `successJson(key: string, data, status?)` shape `{ success: true, [key]: data }`. LLD prescription would fail Phase 4 build | Added D-17 Decision; §4.2 now specifies correct helpers per response shape: `listJson(entries, { total, page, hasMore })` for lists; `successJson(key, data)` for single resources (e.g. `successJson('span', span)`); `actionJson({ spans, nextRevision })` for poll; verified exit grep that excludes `NextResponse.json` |
| C-2 | CRITICAL | Route handler pattern `withRouteHandler` diverges from predecessor's raw `requireTenantAuth`+`requireAdminRole` — silent divergence                                                    | Added D-16 Decision with explicit rationale (404-before-403 via `requireProject`; CLAUDE.md Centralized Auth); documented alternative rejected                                                                                                                                                                              |
| H-1 | HIGH     | `createLogger('arch-ai:tracing')` for Studio handlers contradicts Studio's `'api:arch-ai:*'` convention                                                                                | Package internals use `createLogger('arch-ai:tracing')`; Studio route handlers use `createLogger('api:arch-ai:traces:<sub-resource>')` (e.g. `api:arch-ai:traces:sessions`); Phase 2.6 note updated                                                                                                                         |
| H-2 | HIGH     | `_seed` body schema wider than predecessor — silent divergence                                                                                                                         | Phase 4.4 now documents: discriminated union is broader than predecessor's flat `{ entries[] }` shape; Zod schema is primary validation (no `Array.isArray(body.entries)` fallback)                                                                                                                                         |
| H-3 | HIGH     | Mongoose model export shape (`mongoose.models` guard) implicit — risk of `??` vs `                                                                                                     |                                                                                                                                                                                                                                                                                                                             | `        | Added explicit code snippet to §1 Key Interfaces showing exact ` |     | `form from`arch-journal.model.ts:86-88`; includes `{ timestamps: true, collection: '...' }`, `{ \_id: false }`on events sub-schema, and`Map<string, string>` for attributes |
| M-1 | MEDIUM   | UI components at `arch-settings/` — directory DOES NOT EXIST                                                                                                                           | Added D-18 Decision; all 11 component paths moved from `arch-settings/` to `admin/` (matches predecessor `ArchAuditLogsTab.tsx` location); tab registrar modified-files row now cites concrete `apps/studio/src/components/admin/ArchSettingsPage.tsx` (verified to exist)                                                  |
| M-2 | MEDIUM   | Polling in Zustand via `setInterval` — no Studio precedent                                                                                                                             | Added D-19 Decision; Phase 5.10 split into store (bare `create`) + SWR hook `useArchTraces.ts` wrapping `refreshInterval` (mirrors `useSessionTraces.ts:89`, `useHumanTasks.ts:69`, 10+ other hooks); added new `useArchTraces.ts` file to File-Level Change Map; removed `setInterval` language                            |
| M-3 | MEDIUM   | Zustand middleware (persist/devtools) unspecified                                                                                                                                      | Phase 5.10 pinned: bare `create(set, get)` — no `persist` (data TTL-expires), no `devtools` (matches `arch-audit-store.ts` precedent)                                                                                                                                                                                       |
| M-4 | MEDIUM   | `events` subschema `{ _id: false }` not called out                                                                                                                                     | Added to §1 Key Interfaces comment: `events` array sub-schema with `{ _id: false }` per `arch-audit-log.model.ts:65-73` pattern; `attributes: Map<string, string>` uses Mongoose native Map type                                                                                                                            |
| M-5 | MEDIUM   | `activeSpan()` implementation note — confirmed consistent                                                                                                                              | No action needed                                                                                                                                                                                                                                                                                                            |
| L-1 | LOW      | `mongoose.models` guard uses `                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                             | `not`??` | Covered by H-3 explicit code snippet                             |
| L-2 | LOW      | Schema `timestamps: true` option not stated                                                                                                                                            | Included in H-3 code snippet comment                                                                                                                                                                                                                                                                                        |

**Net after Round 2**: all 12 findings resolved inline. 4 new Decision Log entries (D-16, D-17, D-18, D-19) added to make previously-silent divergences from predecessor pattern explicit and reviewable. LLD ready for Round 3.
