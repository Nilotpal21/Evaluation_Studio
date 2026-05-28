# Arch Trace Explorer v2 — UI Design Delta

**Status**: DRAFT
**Supersedes sections of**: [`arch-trace-explorer.md`](../features/arch-trace-explorer.md) §6 (Design Considerations), [`arch-trace-explorer.hld.md`](./arch-trace-explorer.hld.md) UI sections
**Last Updated**: 2026-04-17
**Owner**: Platform team

## 1. What's Changing vs v1

v1 shipped a single **Traces** tab: a 3-pane master-detail (session list → tree → span detail). It lists every session the user has access to as a flat, recency-sorted list.

v2 adds four capabilities the team now requires:

| #   | Requirement                            | Why                                                                                                                                                                                                                   |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Project filter** on the session list | Session list is noisy across projects; devs want to scope to the project they're debugging.                                                                                                                           |
| 2   | **Onboarding = 1 record per user**     | An onboarding conversation is a single artifact per user (there is no reason to show history here). Old onboarding rows collapse into a single "Your onboarding" entry showing the _current_ onboarding session.      |
| 3   | **Analytics tab**                      | Traces answer "what happened in this session"; teams need "what is happening across all Arch generations" — success rates, retry loops, validation-error topology, cost-by-phase, model mix.                          |
| 4   | **Data capture for future Specialist** | The Analytics data must also be a training substrate for a workspace-level Arch Specialist (separate feature, build later). v2 commits to the span-attribute additions needed so v2 data is already specialist-ready. |

v2 does **not** change any write-side contracts, storage schema indexes, or scoping rules from v1 — only the read side and the UI.

---

## 2. New Tab Structure (Arch Settings)

**Before (v1):** Settings · Audit Logs (legacy) · Traces (flag) · KMS

**After (v2):** Settings · **Traces** · **Analytics** · KMS
(The legacy "Audit Logs" tab is removed once `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` is permanently on; Analytics lives behind the same flag initially.)

---

## 3. Traces Tab — Wireframe

```
┌─ Arch Traces ─────────────────────────────────────────────────────────────────────┐
│ Project: [All projects ▼]   Scope: [● Workspace  ○ Mine]   Status: [Any ▼]        │
│ Phase: [Any ▼]  Time: [Last 24h ▼]  [🔍 Search session name…]          [⟲ Live]   │
├──────────────────┬─────────────────────────────────────────┬──────────────────────┤
│ SESSIONS  (48)   │ Session · "Build Acme CRM blueprint"    │ Span Detail          │
│                  │ project: Acme CRM · DONE · 3.4s · 12K   │ LLM Call · turn 3    │
│ ── Onboarding ── │ ─────────────────────────────────────── │ ─────────────────    │
│ ● Your onboard.  │ ▼ ● session                             │ Model   claude-4.7   │
│   ACTIVE · 2m    │   ▼ ● phase INTERVIEW        (done)     │ In tok  1,234        │
│                  │     ● turn 1 ✓                          │ Out tok 456          │
│ ── Acme CRM ──── │     ● turn 2 ✓                          │ Total   1,690        │
│ ● "Design auth"  │     ▼ ● turn 3                          │ Cost    $0.012       │
│   ERROR · 1h     │       ● llm_call ✓ 234ms                │ Finish  stop         │
│ ● "Export PDF"   │       ● tool file.write ✓               │ Dur     234 ms       │
│   DONE · 3h      │   ▼ ● phase BLUEPRINT        (done)     │                      │
│                  │   ▼ ● phase BUILD            (error)    │ [▼ Input messages]   │
│ ── Inventory ─── │     ● agent-gen Users ✓                 │ [▼ Output]           │
│ ● "Stock report" │     ● agent-gen Orders ✗                │ [▼ Tool calls made]  │
│   DONE · 2d      │       └ validation: schema_invalid      │                      │
│                  │       └ retry #1 ✗                      │ Breadcrumb:          │
│ [Show more…]     │     ● agent-gen Orders ✓ (retry #2)     │ llm · turn 3 ·       │
│                  │                                         │ INTERVIEW · session  │
│                  │ Filter tree: [● All  ○ Errors  ○ Slow] │                      │
└──────────────────┴─────────────────────────────────────────┴──────────────────────┘
```

### 3.1 Left-rail behavior

- **Project filter** (top toolbar) changes what groups appear in the list:
  - `All projects` — show grouped sections: `Onboarding` (always first, single row), then one section per project with sessions the user can access, ordered by most-recent-activity project first.
  - Specific project selected — only `Onboarding` + that project's sessions (onboarding always shown as a single row regardless of filter).
- **Scope** toggle:
  - `Workspace` — any session the user has read permission on (default for workspace admins).
  - `Mine` — only sessions where `createdBy == me` (default for regular members). Members cannot choose `Workspace` unless they have `arch:traces:read:workspace`.
- **Onboarding row rules (new invariant):**
  - One row per user, always.
  - If an onboarding session is `ACTIVE`, show it. Otherwise show the most recent `DONE`/`ERROR` onboarding session.
  - Older onboarding sessions are reachable via a secondary `[Show older onboarding…]` link inside the section (lazy-opened; not shown by default).
- **Status chips** on each row: `ACTIVE` (blue pulse) · `DONE` (green) · `ERROR` (red). Error chip overrides DONE when any descendant span has status `error`.
- **Metadata line per row**: relative time, token total, error count (if > 0).

### 3.2 Middle pane — tree

Unchanged semantics from v1 (Session → Phase → Turn → LLM → Tool). Three new visual affordances:

1. **Agent-gen and validation nodes** render as first-class rows under BUILD, not buried inside generic `tool_execution` nodes. Attribute `arch.buildStep ∈ {agent_gen, validation, compile, topology}` drives this grouping.
2. **Retry count** badge on any node with `tool.retryCount > 0`, colored amber.
3. **Loop marker** on nodes flagged `loop.detected = true` (red outline + icon).

### 3.3 Right pane — span detail

Unchanged type-specific cards from v1. Adds two blocks when applicable:

- **Validation errors** block (for `agent_gen` / `validation` nodes): shows the error category, stable signature hash, and up to 5 specific messages.
- **Retry history** block: table of attempts with cause (timeout / schema_invalid / llm_error) and duration.

---

## 4. Analytics Tab — Wireframe

```
┌─ Arch Analytics ──────────────────────────────────────────────────────────────────┐
│ Range: [Last 24h ▼]   Project: [All ▼]   Scope: [Workspace ▼]   Phase: [Any ▼]    │
├───────────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Summary ─────────────────────────┐ ┌─ Build health ─────────────────────────┐ │
│ │ Sessions             124          │ │ Build success          88%  (109/124)  │ │
│ │ Projects touched     32           │ │ Avg build duration     47s             │ │
│ │ Onboarding sessions  18           │ │ Validation errors      23 across 15    │ │
│ │ Tokens               2.3M         │ │ Agent-gen retries      47             │ │
│ │ Cost                 $12.40       │ │ Loops interrupted      3              │ │
│ │ Session error rate   12%          │ │ Avg retries per build  0.4            │ │
│ └───────────────────────────────────┘ └────────────────────────────────────────┘ │
│                                                                                   │
│ ┌─ Generation performance by phase ─────────────────────────────────────────────┐ │
│ │ Phase         Sessions   Avg       p95       Err rate   Retry rate            │ │
│ │ INTERVIEW     124        12.4s     34s       3%         0%                    │ │
│ │ BLUEPRINT     119        28.1s     68s       8%         12%                   │ │
│ │ BUILD         116        47.2s     132s      15%        22%                   │ │
│ │  └ agent-gen  412 calls  8.3s      24s       9%         18%                   │ │
│ │  └ validation 412 calls  2.1s      6.8s      47% err    n/a                   │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│ ┌─ Failure topology (top error signatures) ─────────────────────────────────────┐ │
│ │ 1. agent_gen_schema_invalid       23 sessions · Acme, Inv +6   [drill →]      │ │
│ │ 2. llm_tool_timeout                11 sessions · 3 projects     [drill →]      │ │
│ │ 3. validation_circular_ref          8 sessions · Acme           [drill →]      │ │
│ │ 4. loop_detected (phase=BUILD)      3 sessions · Inv            [drill →]      │ │
│ │ [Show all 12 signatures →]                                                    │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│ ┌─ Cost & tokens by model ──────────────────────────────────────────────────────┐ │
│ │ claude-opus-4-7       1.2M tok   $8.20   used for INTERVIEW, BLUEPRINT        │ │
│ │ claude-sonnet-4-6     890K tok   $3.10   used for BUILD agent-gen             │ │
│ │ claude-haiku-4-5      210K tok   $1.10   used for validation                  │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│ ┌─ Build topology (sankey) ─────────────────────────────────────────────────────┐ │
│ │ INTERVIEW 124 ─┬─► BLUEPRINT 119 ─┬─► BUILD 116 ─┬─► ✓ DONE 109               │ │
│ │                └─► gated/err 5    └─► err 3       └─► ✗ ERROR 7               │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│ [Export CSV]  [Copy summary for bug report]                                       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Sections (all read from the same `arch_trace_spans` collection)

1. **Summary** — simple aggregates over the selected range.
2. **Build health** — counts/ratios for the BUILD phase and its children only.
3. **Generation performance** — per-phase timing + error rates; BUILD expands to show `agent_gen` and `validation` sub-steps.
4. **Failure topology** — groups error spans by `error.signature` (see §5); click drills to a filtered sessions list in the Traces tab.
5. **Cost & tokens by model** — sums `llm.totalTokens` + `llm.estimatedCost` grouped by `llm.model`; right column shows which phases used each model.
6. **Build topology sankey** — phase flow counts. Simple SVG sankey; no third-party charting library required for v1 (stacked divs acceptable).
7. **Actions** — CSV export and a "Copy summary for bug report" button that produces a plaintext block (range, totals, top signatures) for pasting into tickets.

### 4.2 Data source contract

Analytics is **read-only** on top of existing span data plus the new attributes in §5. New HTTP routes:

- `GET /api/projects/[id]/arch-ai/analytics/summary?range=24h&phase=…`
- `GET /api/projects/[id]/arch-ai/analytics/topology?range=24h`
- `GET /api/projects/[id]/arch-ai/analytics/models?range=24h`
- Workspace-scope equivalents: `GET /api/arch-ai/analytics/summary?scope=workspace&range=…` — requires `arch:analytics:read:workspace` permission.

All routes honor the same auth + scoping rules as Traces routes: project-scoped includes `projectId` in filter, workspace-scoped includes `tenantId` only.

---

## 5. Span-Attribute Additions (specialist-ready data capture)

These are **additive** span attributes. No new span types, no index changes required beyond the ones v1 already created.

| Attribute                    | Span types                  | Purpose (today)                                   | Purpose (future specialist)                 |
| ---------------------------- | --------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `arch.buildStep`             | tool_execution under BUILD  | Render agent-gen / validation as first-class rows | Train on which build step failed            |
| `build.agentName`            | tool_execution (agent-gen)  | Show "generated Users agent"                      | Correlate agent complexity → failure mode   |
| `validation.errorCategory`   | tool_execution (validation) | Failure topology grouping                         | Train on recurring schema mistakes          |
| `validation.errorSignature`  | tool_execution (validation) | Stable hash for topology                          | Cluster failures across tenants             |
| `validation.errorMessages[]` | tool_execution (validation) | Detail drawer                                     | Training corpus                             |
| `loop.detected`              | turn, phase                 | Red outline in tree                               | Detect divergence patterns                  |
| `loop.iterationCount`        | phase                       | Retry analytics                                   | Detect "stuck" agents                       |
| `retry.cause`                | llm_call, tool_execution    | Retry topology                                    | Train on which prompt shape caused timeouts |
| `error.signature`            | any `error` status span     | Failure topology grouping                         | Cluster errors by root cause                |

**Signature generation** (§ appended to HLD): a deterministic hash over `(spanType, tool.name, error code class, first stack frame normalized)`. Same bug → same signature across sessions and tenants. Implementation lives next to the existing `redactSpanName` helper.

---

## 6. Delta to Existing SDLC Docs

These edits land _after_ this design is approved:

| Doc                                                      | Edit                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/arch-trace-explorer.md`                   | §2 add Analytics + project-filter goals; §3 add user stories for analytics-viewing admin + "onboarding shown once"; §4 add FR-24 (project filter), FR-25 (onboarding collapse), FR-26..30 (analytics routes + attrs); §6 replace layout diagrams with §3 and §4 wireframes from this doc. |
| `docs/specs/arch-trace-explorer.hld.md`                  | §4 Concern 2 (UI) — add Analytics section; §4 Concern 7 (observability) — document new span attributes; §5 (routes) — add analytics routes; §6 (data model) — document new attribute fields but **no** index changes.                                                                     |
| `docs/testing/arch-trace-explorer.md`                    | Add E2E scenarios: analytics-summary returns correct totals, onboarding-row shows single entry, project-filter-empty renders empty state, permission-denied on workspace scope for member. Add unit scenarios for `error.signature` determinism.                                          |
| `docs/plans/2026-04-15-arch-trace-explorer-impl-plan.md` | Add Phase 6 (Analytics routes + UI); Phase 7 (span-attribute emitters for build/validation/loop/retry) with exit criteria. Keep v1 phases unchanged — they're already shipped.                                                                                                            |

---

## 7. Non-Goals (v2)

- The workspace **Specialist** itself (training pipeline, model, guidance UI) — tracked separately.
- Per-user dashboards (user-scoped analytics view); workspace + project scopes only in v2.
- Real-time analytics streaming (polling at 30s; aggregation queries can be cached 15s).
- Historical backfill of `error.signature` or the new build/validation attributes on spans written by v1. New spans only.
- Cross-workspace benchmarks.

---

## 8. Open Questions for User

1. **Member default scope on Traces tab** — confirm `Mine`. Admins default to `Workspace`. OK?
2. **Analytics tab permission** — workspace-scope view requires `arch:analytics:read:workspace`. Project-scope requires `arch:traces:read` on that project. OK to reuse that permission or create `arch:analytics:read`?
3. **Onboarding "Show older" affordance** — should older onboarding sessions be visible at all, or fully hidden from the UI (still queryable via API for debugging)?
4. **Sankey complexity** — OK to ship as stacked-div SVG in v2, or must it use a real charting lib (e.g., `visx`) from day one?
5. **Analytics export** — CSV only, or also JSON? (CSV answers "paste into a bug"; JSON answers "feed to a notebook".)
