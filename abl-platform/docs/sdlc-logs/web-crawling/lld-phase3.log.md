# SDLC Log: Web Crawling — LLD Phase 3

**Feature**: web-crawling (Crawler UX Phase 3 — Explainability, Extraction Preview, Iterative Discovery)
**Phase**: LLD
**Artifact**: `docs/plans/2026-04-27-crawler-ux-phase3-impl-plan.md`
**Date**: 2026-04-27

---

## Inputs

- **Design doc (canonical)**: `docs/searchai/design/DISCOVERY-PANEL-DESIGN.md` — §6.7, §6.8, §11, §16.2, §17
- **Previous LLDs**: Phase 1 (`docs/plans/2026-04-23-crawler-discovery-panel-impl-plan.md` — DONE), Phase 2 (`docs/plans/2026-04-26-crawler-ux-phase2-impl-plan.md` — APPROVED)
- **Test spec**: `docs/testing/web-crawling.md`
- **Memory**: `project_crawler_objectives.md` (29 objectives, 5 conflict resolutions, scope rules)
- **Gap analysis**: Cross-referenced all 18 UJ + 29 G objectives → identified 3 HIGH gaps (UJ-13, UJ-14/G10, G8/UJ-15)

## LLD Summary

5 implementation phases covering Explainability (reason strings), Extraction Preview (backend + frontend), and Iterative Discovery (backend context + frontend flow). ~800 lines. 16+ files touched across 4 packages (studio, search-ai, crawler-mcp-server, i18n).

## Audit Rounds

| Round | Focus                   | Auditor       | Verdict             | Critical | High | Medium | Low |
| ----- | ----------------------- | ------------- | ------------------- | -------- | ---- | ------ | --- |
| 1     | Architecture compliance | lld-reviewer  | NEEDS_CHANGES       | 3        | 5    | 5      | 2   |
| 2     | Pattern consistency     | lld-reviewer  | NEEDS_CHANGES       | 0        | 3    | 4      | 2   |
| 3     | Completeness            | lld-reviewer  | NEEDS_CHANGES       | 3        | 6    | 6      | 0   |
| 4     | Cross-phase consistency | phase-auditor | APPROVED WITH NOTES | 0        | 3    | 4      | 0   |
| 5     | Final sweep             | lld-reviewer  | APPROVED WITH NOTES | 0        | 0    | 1      | 2   |

### Key Findings Resolved

- **validateAndFetchURL returns string, not Response**: Handler uses it directly for HTML — no separate fetch needed. Redundant `isURLAllowed()` call removed.
- **discoveryState missing from updateDraftSchema**: Entire `discoveryState` Zod schema added to `crawl-drafts.ts` — without this, iteration history couldn't persist through the API.
- **connectToExplorer config type gap**: Full forwarding chain documented: frontend → search-ai → connectToExplorer → /api/explore-deep → depth-prober. Config type and ExploreDeepRequestSchema both need `resumeContext`.
- **reason-utils must return {key, params}**: Follows `generateContextualPrompt()` pattern from `decision-utils.ts`. No English prose in utility functions.
- **i18n keys must be flat**: `reason_auto_add` not `reasons.auto_add` — matches existing `console_found_links` convention.
- **previewExtraction two-step pattern**: `apiFetch` returns Response, `handleResponse` parses + unwraps `.data`.
- **Trigger enum deviation**: Design doc §16.2 uses `auto|explore-branch|objective|manual`, LLD uses more granular `initial|explore-branch|explore-all|add-sample|explore-all-nav`. Documented as D-8 with mapping.
- **3-layer sync for discoveryState + trigger**: Frontend type, API client inline type, backend Zod schema all explicitly listed.
- **Merge priority rules**: User-explicit states (skipped) take precedence over system-discovered states across iterations.
- **No in-memory concurrent limits**: Rate-limit middleware only (stateless-distributed compliance).

### Deferred Items

- §6.9.1 "Next Actions" queue display (deferred across all 3 LLD phases)
- TraceEvent emission for interventions (G26 audit trail)
- I-10 Edit Samples UI (dispatch wiring built, editor UI deferred)

## Learnings

- **discoveryState persistence was silently broken**: The updateDraftSchema had no discoveryState field — any frontend state saved via the update-draft API was being silently stripped by Zod. This is a data loss bug, not just a schema gap.
- **validateAndFetchURL returns HTML string directly**: Multiple rounds assumed it returned a Response. Always read the actual function signature before designing around it.
- **5th occurrence of 3-layer sync gap**: discoveryState/iterations/trigger. The crawl-flow LLD template should have a permanent checklist item for this.
- **Phase-auditor catches design doc enum drift**: Round 4 found the trigger enum mismatch that the lld-reviewer missed.
- **Flat i18n keys are the convention**: No nesting under `crawl_flow` — all keys are direct children.
