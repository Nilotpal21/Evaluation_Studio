# Merge Audit Pass 1 — Studio Package

**Date:** 2026-03-14
**Merge:** `feature/trace-platform-infrastructure-v2` into `develop`
**Auditor:** Claude Opus 4.6

---

## File 1: `apps/studio/src/types/index.ts`

**Verdict: WARN — Duplicate `DecisionKind` type definition**

### What was checked

- `TraceEventType` union includes `'decision'` (line 94) — PASS
- `ExtendedTraceEventType` includes `'decision'` (line 220) and `'span_end'` (line 222) — PASS
- `'tool_thought'` from develop preserved (line 218) — PASS
- Union is syntactically valid — PASS
- `DecisionKind` exported — PASS (line 9: `export type { DecisionKind }`)

### Issue found

`DecisionKind` is defined **twice** in this file:

1. **Line 8-9:** Re-exported from `../../lib/event-types` (the canonical source).
2. **Lines 227-238:** A second inline definition of the same type.

Both definitions have identical members so this is not a build-breaking error — TypeScript treats structurally identical types as compatible. However, the duplicate is confusing and a maintenance trap: if someone updates one definition but not the other, they will silently diverge.

**Recommendation:** Remove the inline `DecisionKind` definition at lines 227-238. The re-export from `lib/event-types` at line 9 is sufficient and is the definition that `DecisionCard.tsx` actually imports.

### Consumers verified

- `DecisionCard.tsx` imports `DecisionKind` from `../../lib/event-types` directly (not from `types/index.ts`) — no breakage.
- `TraceEvent.decisionKind` (line 251) references `DecisionKind` — resolves to the re-export, which is fine.

---

## File 2: `apps/studio/src/store/observatory-store.ts`

**Verdict: FAIL — `spanVersion` was NOT removed; develop's optimization is preserved but branch's "removal" goal was not achieved**

### What was checked

The audit description states: "Branch removed [spanVersion and activeSpanStack]. Resolution: accepted branch removal." However, the actual file state contradicts this:

- **`spanVersion`** — Still present at:
  - Line 86: `spanVersion: number;` in the interface
  - Line 258: `spanVersion: 0,` in initial state
  - Line 770: `spanVersion: state.spanVersion + 1` in `addEventToSpan`
- **`activeSpanStack`** — Successfully removed. No references found anywhere in the codebase.

### Impact assessment

`spanVersion` remaining is actually **not a bug** in the current codebase because `DebugTabs.tsx` (lines 389-404) actively consumes it for its force-rerender pattern. If `spanVersion` had been removed, `DebugTabs.tsx` would break at runtime.

**Two possible interpretations:**

1. The merge resolution correctly kept `spanVersion` because `DebugTabs.tsx` depends on it, and the "accepted branch removal" note is inaccurate.
2. The branch intended to remove `spanVersion` AND update `DebugTabs.tsx` to use the simpler `useMemo` pattern (as `SpanTree.tsx` does), but the `DebugTabs.tsx` update was lost during conflict resolution.

**`DebugTabs.tsx` references:**

- Line 391: `const spanVersion = useObservatoryStore((s) => s.spanVersion);`
- Lines 394-404: Manual subscription to `spanVersion` changes as "safety net"

**Recommendation:** Clarify the intended resolution. If the branch goal was to simplify span tracking, `DebugTabs.tsx` should be migrated to the same `useMemo` + destructured store pattern used in `SpanTree.tsx`, and then `spanVersion` can be removed from the store. If develop's optimization is intentionally preserved, update the merge notes.

---

## File 3: `apps/studio/src/components/observatory/SpanTree.tsx`

**Verdict: WARN — Unused `EVENT_TYPE_COLORS` constant (dead code)**

### What was checked

- **Imports:** `useState`, `useCallback`, `useMemo`, `useEffect`, `useRef`, `memo` all imported (line 11). `useState` used in `SpanNode`, `TokenTooltip`, `CopyableId`. `useEffect` used in `CopyableId`. `useCallback` used in multiple places. `useRef` used in `CopyableId`. All imports are actively used — **PASS**.
- **Branch's simpler `useMemo` pattern:** Line 109 uses `useMemo(() => getSpanTree(), ...)` — **PASS**.
- **Develop's `spanVersion` subscription removed from SpanTree:** Confirmed not present — **PASS**.
- **`hasLegacyEvents`:** Defined at line 110, used in JSX at line 170 — **PASS**.
- **`DecisionCard` imported and used:** Line 31 import, line 387 and 496 usage — **PASS**.
- **`EVENT_DOT_COLORS` imported from `./event-colors`:** Line 32 import, line 599 usage — **PASS**.

### Issue found

**`EVENT_TYPE_COLORS`** (lines 581-594) is defined locally but **never used**. The `EventTypeIndicator` component at line 599 uses `EVENT_DOT_COLORS` (imported from `./event-colors`) instead. This constant is dead code from the branch that was superseded by the centralized `event-colors.ts` module.

Additionally, `EVENT_DOT_COLORS` in `event-colors.ts` does **not** include `span_end`, while the dead `EVENT_TYPE_COLORS` does. If `span_end` events are rendered in the SpanTree event list, they will fall back to `'bg-background-muted'` (the default). This is minor — `span_end` events are lifecycle markers and muted coloring is arguably correct.

**Recommendation:** Remove the unused `EVENT_TYPE_COLORS` constant (lines 581-594). Optionally add `span_end: 'bg-success'` to `EVENT_DOT_COLORS` in `event-colors.ts` for consistent coloring.

---

## File 4: `apps/studio/src/components/observatory/DecisionCard.tsx`

**Verdict: PASS**

### What was checked

- Imports `DECISION_KIND_META` and `DecisionKind` from `../../lib/event-types` (line 14) — **correct path**.
- `lib/event-types.ts` exports both `DecisionKind` type and `DECISION_KIND_META` constant — verified.
- All 11 decision kinds in the meta map match the `DecisionKind` type definition.
- Component handles missing/unknown kinds gracefully via fallback: `meta?.color ?? 'text-purple'`, `meta?.label ?? rawKind` (lines 28-30).
- Compact mode and full mode both render correctly.
- No type errors anticipated.

---

## File 5: `apps/studio/src/components/analytics/TracesExplorerTab.tsx`

**Verdict: PASS**

### What was checked

- Imports `EVENT_CARD_COLORS`, `DEFAULT_EVENT_COLORS`, and `EventColorConfig` from `../observatory/event-colors` — consistent with the centralized color system.
- Uses standard hooks (`useState`, `useMemo`, `useCallback`, `memo`).
- No references to removed `spanVersion` or `activeSpanStack`.
- No direct dependency on `DecisionKind` or decision-specific rendering (appropriate — this is the analytics explorer, not the observatory).

---

## File 6: `apps/studio/src/utils/replay-trace-events.ts`

**Verdict: PASS**

### What was checked

- **`decision` handling:** The replay utility normalizes legacy decision field names (`kind`, `decisionType`, `decision_type`) to canonical `decisionKind` at lines 140-145. Events are fed through `obs.addEvent()` which handles all types generically — no type-specific switch needed.
- **`span_end` handling:** `span_end` events are replayed through `obs.addEvent()` (line 170), which has explicit handling at observatory-store lines 337-344: it calls `endSpan()` on the target span with the correct status. The post-replay sweep at lines 179-193 also closes any remaining running spans.
- **`tool_thought` in `formatTraceEventLog`:** Present at lines 97-103 — develop's addition preserved.
- **`decision` in `formatTraceEventLog`:** Not present (falls through to `default: return null`) — minor gap, but decision events still replay correctly into the observatory store; they just don't generate a log line. This is acceptable since decisions are rendered via `DecisionCard` in the span tree, not via logs.

---

## Summary

| File                     | Verdict  | Issue                                                                                                                                                                                                                                                     |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types/index.ts`         | **WARN** | Duplicate `DecisionKind` type (lines 227-238 duplicate the re-export from `lib/event-types`). Not breaking, but maintenance trap.                                                                                                                         |
| `observatory-store.ts`   | **FAIL** | `spanVersion` NOT removed — still in interface, initial state, and `addEventToSpan`. `DebugTabs.tsx` depends on it. Either the "branch removal" was not applied, or it was intentionally kept due to the `DebugTabs.tsx` dependency. Needs clarification. |
| `SpanTree.tsx`           | **WARN** | Dead `EVENT_TYPE_COLORS` constant (lines 581-594) — never referenced; `EventTypeIndicator` uses `EVENT_DOT_COLORS` from `event-colors.ts`. Also, `span_end` missing from centralized `EVENT_DOT_COLORS`.                                                  |
| `DecisionCard.tsx`       | **PASS** | Correct imports, graceful fallbacks, no issues.                                                                                                                                                                                                           |
| `TracesExplorerTab.tsx`  | **PASS** | Consistent with centralized color system, no stale references.                                                                                                                                                                                            |
| `replay-trace-events.ts` | **PASS** | Both `decision` and `span_end` properly handled via `addEvent()` pipeline.                                                                                                                                                                                |

### Action items

1. **P1 — Resolve `spanVersion` ambiguity:** Either (a) migrate `DebugTabs.tsx` to the simpler `useMemo` pattern and remove `spanVersion` from the store, or (b) document that `spanVersion` is intentionally preserved and update merge notes.
2. **P2 — Remove duplicate `DecisionKind`:** Delete lines 227-238 in `types/index.ts`. The re-export at line 9 is canonical.
3. **P3 — Remove dead `EVENT_TYPE_COLORS`:** Delete lines 581-594 in `SpanTree.tsx`.
4. **P3 — Add `span_end` to `EVENT_DOT_COLORS`:** Add `span_end: 'bg-success'` to `event-colors.ts` for consistent dot coloring.
