# SDLC Log: Web Crawling — LLD Phase 2

**Feature**: web-crawling (Crawler UX Phase 2)
**Phase**: LLD
**Artifact**: `docs/plans/2026-04-26-crawler-ux-phase2-impl-plan.md`
**Commit**: `b25b980cd`
**Date**: 2026-04-26

---

## Inputs

- **Design doc (canonical)**: `docs/searchai/design/DISCOVERY-PANEL-DESIGN.md` — §6, §22, §23, §17.1b
- **Previous LLD**: `docs/plans/2026-04-23-crawler-discovery-panel-impl-plan.md` (Phase 1 — DONE)
- **Test spec**: `docs/testing/web-crawling.md`
- **Memory**: `project_crawler_objectives.md` (29 objectives, 5 conflict resolutions, scope rules)

## LLD Summary

6 implementation phases covering D7 Strategy Selection, Full Interventions, Scope Rules, Resume Flow, and Conflict Resolution Polish. ~900 lines. 15+ files touched across 4 packages (studio, search-ai, crawler-mcp-server, database, i18n).

## Audit Rounds

| Round | Focus                   | Auditor       | Verdict             | Critical | High | Medium | Low |
| ----- | ----------------------- | ------------- | ------------------- | -------- | ---- | ------ | --- |
| 1     | Architecture compliance | lld-reviewer  | NEEDS_CHANGES       | 3        | 4    | 4      | 0   |
| 2     | Pattern consistency     | lld-reviewer  | NEEDS_CHANGES       | 2        | 3    | 5      | 0   |
| 3     | Completeness            | lld-reviewer  | NEEDS_CHANGES       | 3        | 4    | 5      | 2   |
| 4     | Cross-phase consistency | phase-auditor | NEEDS_REVISION      | 2        | 5    | 5      | 0   |
| 5     | Final sweep             | lld-reviewer  | APPROVED WITH NOTES | 0        | 0    | 6      | 3   |

### Key Findings Resolved

- **3-layer sync** (recurring): `updateCrawlDraft` requires API client type + Zod schema + Mongoose schema. All 3 layers now explicitly listed in Task 1.4.
- **Strategy IDs**: Aligned to design doc (`crawl-sitemap`, `discover-all`, `guided-discovery`) — was `crawl-full-sitemap`.
- **explore-all cap**: Fixed to 20 URLs per design doc §6.6 (was 100 in open questions).
- **Backend/frontend command split**: Enforced at type level with `BackendInterventionType` in both Zod schema and command-queue.ts.
- **depth-prober refactor scope**: Clarified to Phase 2 breadcrumb climb only (not all 5 internal phases).
- **GuidedDiscoveryConfig**: Added from design doc §22.6 — `alwaysShowActions`, `selectionMode`, `earlyDecisionCards`.
- **Prop signatures**: Fixed `onProceedToConfigure` → `onContinue`, `ICrawlDraftProfile` → `ProfileResponse`.
- **URL normalization**: `skippedUrls` Set stores normalized URLs to prevent silent skip failures.

### Deferred Items

- I-10 Edit Samples UI (design doc P2 — dispatch wiring built, editor UI deferred)
- "Next Actions" queue display (§6.9.1 — requires backend progress event changes)
- TraceEvent emission for interventions (G26 audit trail)

## Learnings

- **3-layer sync is the #1 recurring issue** in crawl-flow LLDs. Recommend adding a permanent checklist item to the LLD template.
- **Design doc IDs must be canonical** — any deviation from the design doc's enum values creates draft persistence bugs.
- **depth-prober has 5 phases**, not 2 — the architecture note needed to scope the refactor precisely.
- **Phase-auditor catches design doc drift** that lld-reviewer misses (round 4 found GuidedDiscoveryConfig gap).
