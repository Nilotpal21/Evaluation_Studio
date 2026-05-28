# SDLC Log: Web Crawling — Discovery Panel LLD

> **Date:** 2026-04-23
> **Phase:** LLD + Implementation Plan
> **Artifact:** `docs/plans/2026-04-23-crawler-discovery-panel-impl-plan.md`
> **Design Doc:** `docs/searchai/design/DISCOVERY-PANEL-DESIGN.md`

## Summary

Generated 7-phase implementation plan for the complete Discovery Panel system (D1-D6 decisions). Covers: auto-collapsing tree, Discovery Console, Dynamic Decision Cards, action verbs, auto-add sections, crawl-as-you-discover, nav extraction, YieldTracker, POST-alongside-SSE interventions.

## Oracle Decisions

All 15 clarifying questions answered with 0 AMBIGUOUS — no user escalation needed. Key decisions:

- Follow 7-sprint order from design doc
- Replace existing LLD draft (pre-dates D1-D6)
- Refactor BrowserDiscoveryInline render to delegate to DiscoveryPanel
- Extend DepthProbeProgress with backward-compatible optional fields
- Extract YieldTracker as separate module
- No feature flag — enhancement to existing flow
- No DB migration — uses existing crawl draft schemaless document

## Audit Rounds

| Round | Focus                   | Auditor       | Verdict                | Findings                                                                                                                                                                                                                                                         |
| ----- | ----------------------- | ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Architecture compliance | lld-reviewer  | NEEDS_WORK → fixed     | C-1: Command queue cross-process transport, C-2: Missing Zod validation, H-1: State4Crawl already exists, H-2: DiscoveredUrlSet unbounded, H-3: Command queue unbounded, H-4: No structured logging                                                              |
| 2     | Pattern consistency     | lld-reviewer  | NEEDS_WORK → fixed     | H-1: Third copy of isLikelyVariable, H-2: DiscoveryTimeline/Console overlap, H-3: categorizeChildrenRobust vs UrlClusterer, M-1: 500-LOC mega-module split, M-2: Animation presets, M-3: formatDisplayName overlap, M-4: SSE passthrough, M-5: Hardcoded strings |
| 3     | Completeness            | lld-reviewer  | PASS                   | H-1: Missing barrel files in packages/crawler, H-2: Missing re-export chain, M-1: Missing index.ts in Files Touched, M-2: Multi-source scope decision, M-3: Phase 3 manual-only tests                                                                            |
| 4     | Cross-phase consistency | phase-auditor | NEEDS_REVISION → fixed | C-1: nav-extracted SSE event silently dropped by proxy, H-1/2: HLD deviations, H-3: WebSocket data source, H-4: navStructure null initialization                                                                                                                 |
| 5     | Final sweep             | lld-reviewer  | PASS                   | M-1: Path param validation (pre-existing), M-2: Command queue TTL (clarification)                                                                                                                                                                                |

## Key Findings

1. **Command queue architecture** (C-1 Round 1): search-ai and crawler-mcp-server are separate processes — in-memory queue can't span them. Fixed: HTTP POST forwarding from search-ai to crawler-mcp-server (same proxy pattern as exploration start).

2. **SSE proxy drops unknown events** (C-1 Round 4): `handleExplorerEvent()` has explicit if/else for progress/complete/error only. `nav-extracted` would be silently dropped. Fixed: must add explicit case.

3. **State4Crawl.tsx already exists**: LLD initially listed as NEW file. Fixed: moved to Modified Files.

4. **500-LOC utility mega-module**: Split into 6 focused files (tree-utils, console-utils, decision-utils, coverage-utils, url-set, crawl-queue-utils) with barrel index.

5. **DiscoveryTimeline vs DiscoveryConsole**: Different scopes — Timeline handles sitemap/pipeline phases, Console handles browser discovery. They coexist, no replacement.

## Remaining Medium Items (deferred)

- Intervention endpoint `:id` param not Zod-validated (pre-existing pattern across all 4 routes)
- Command queue TTL cleanup timing (implementer can resolve inline)
- Phase 3 has manual-only test strategy for UI components (Phase 2 tests all pure logic)
