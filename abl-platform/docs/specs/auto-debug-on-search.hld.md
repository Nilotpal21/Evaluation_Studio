# Auto Debug on Search — High-Level Design

## What

When a user runs a search query in the Search Playground, automatically fire a parallel debug query alongside it. The search results appear immediately (fast path, no debug overhead), and the debug pipeline trace streams in independently when ready. This eliminates the manual "Run Debug" button click and ensures every query gets full diagnostic visibility.

## Architecture Approach

### Packages Changed

| Package         | Change                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| `apps/studio`   | UI changes — QueryPlaygroundTab, SearchTestSection, search-tab-store                   |
| `packages/i18n` | Minor i18n key updates (remove "run_debug" button label, add auto-debug status labels) |

**No backend changes required** — the search-ai-runtime already supports `debug: true` on the query endpoint.

### Data Flow

```
User clicks "Search"
       │
       ├──────────────────────────────────┐
       │                                  │
  [Search Call]                     [Debug Call]
  executeQuery(indexId, {           executeQuery(indexId, {
    query, queryType,                 query,
    topK, debug: false              debug: true
  })                                })
       │                                  │
       ▼                                  ▼
  Results render                   Debug trace renders
  IMMEDIATELY                      WHEN READY (non-blocking)
       │                                  │
       └──── Both visible in UI ──────────┘
```

### Key Integration Points

1. **QueryPlaygroundTab.handleSearch** — currently fires one API call; will fire two in parallel
2. **search-tab-store** — already stores `debugTrace` and `results`; needs `isAutoDebugging` flag
3. **SearchTestSection** — debug section already reads from store; remove manual "Run Debug" button, show auto-loading state

## Decisions & Tradeoffs

### Decision 1: Two parallel API calls vs. single call with `debug: true`

**Chose: Two parallel calls** because:

- Search call without `debug: true` is the fast path — zero instrumentation overhead
- Debug call runs independently — if it's slower or fails, search results are unaffected
- Matches user's explicit requirement: "don't wait till both completes"
- Better perceived performance — results appear as fast as possible

_Alternative rejected_: Single call with `debug: true` returns both in one response, but ties search latency to debug instrumentation overhead. User explicitly wants non-blocking behavior.

### Decision 2: Fire from QueryPlaygroundTab vs. from SearchTestSection parent

**Chose: Fire from QueryPlaygroundTab** because:

- It already owns the search trigger (`handleSearch`)
- It already has access to the Zustand store
- Adding a second parallel call is minimal code change
- No prop-drilling or callback plumbing needed

### Decision 3: Keep the "Run Debug" button as manual re-run

**Chose: Keep the "Run Debug" button** alongside auto-debug because:

- Auto-debug fires on every search, but users may want to re-run debug independently
- Useful when tweaking debug-specific scenarios without re-running the full search
- The debug toggle in the playground controls is removed (debug always auto-fires)
- The "Run Debug" button remains in the debug section as a manual re-trigger

## Task Decomposition

| Task                                                     | Package(s)                 | Independent? | Est. Files |
| -------------------------------------------------------- | -------------------------- | ------------ | ---------- |
| T-1: Store + parallel query logic                        | apps/studio                | Yes          | 3          |
| T-2: UI updates — remove debug button, show auto-loading | apps/studio, packages/i18n | No (T-1)     | 3          |

Since T-2 depends on T-1, these will be done sequentially.

### T-1: Store + Parallel Query Logic

- Update `search-tab-store.ts` — add `isAutoDebugging` and `autoDebugError` state
- Update `QueryPlaygroundTab.tsx` — fire parallel debug call in `handleSearch`, write debugTrace/results to store

### T-2: UI Updates

- Update `SearchTestSection.tsx` — remove "Run Debug" button, read `isAutoDebugging` from store for loading state
- Update `packages/i18n/locales/en/studio.json` — add/update i18n keys for auto-debug status

## Out of Scope

- Backend changes to the query pipeline
- New debug endpoints or trace formats
- Layout redesign (keeping current stacked layout: search results above, debug below)
- Query History changes
- QueryDiagnosticCard changes
