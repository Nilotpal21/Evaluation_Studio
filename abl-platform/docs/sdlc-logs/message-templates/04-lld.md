# SDLC Log: message-templates — Phase 4 (LLD)

**Date**: 2026-03-23
**Phase**: LLD + Implementation Plan
**Artifact**: `docs/plans/2026-03-23-message-templates-impl-plan.md`

## Summary

Generated 6-phase implementation plan:

1. **Phase 1: Data Model + Repository** (P0) — Two MongoDB models (message_templates, message_template_versions), repository class with tenant/project isolation, Zod validation schemas
2. **Phase 2: API Routes** (P0) — 7 REST endpoints under `/api/projects/:projectId/message-templates`, following tags.ts route pattern
3. **Phase 3: Runtime Template Resolver** (P0) — In-memory cache (10K entries, 5min TTL, LRU), channel-variant mapping, Redis pub/sub invalidation
4. **Phase 4: Compiler Integration** (P1) — DSL-to-library sync via syncFromDSL, additive only, compile warnings for conflicts
5. **Phase 5: Studio UI** (P1) — Template Manager page, editor with variant tabs, version history, template picker, SWR hooks
6. **Phase 6: E2E + Integration Tests** (P0) — All 22 test scenarios from test spec

## Key Implementation Decisions

1. **Separate version collection** — Not embedded, avoiding 16 MB document limit
2. **Route ordering** — Static routes (/versions, /rollback) before /:templateId per Express rule
3. **Lazy model imports** — Follow tags.ts pattern for model imports to avoid circular deps
4. **Singleflight cache** — Prevent stampede on cold start with single fetch per template name
5. **Conditional DSL sync** — Only runs when projectContext available (deployment flow, not pure validation)

## Wiring Checklist

10-item checklist covering: model exports, route registration, resolver exports, cache invalidation wiring, compiler sync, Studio navigation, SWR hooks, Dockerfile updates.

## Dependency Graph

```
Phase 1 → Phase 2 → Phase 5
Phase 1 → Phase 3
Phase 1 → Phase 4
Phase 2 → Phase 6 (E2E)
Phase 3 → Phase 6 (Integration)
```

Phases 3/4 parallelizable after Phase 1. Phase 5 after Phase 2. Phase 6 tests can start incrementally.

---

# SDLC Log: message-templates — Post-Implementation Sync (ALPHA)

**Date**: 2026-03-26
**Phase**: Post-Implementation Sync
**Trigger**: Feature at ALPHA status; compile-time DSL template system implemented, project-scoped CRUD system not yet implemented

## What Was Updated

| Artifact            | File                                                   | Changes                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature Spec**    | `docs/features/message-templates.md`                   | Added "Current Implementation Status" section with detailed tables of implemented vs not-implemented components. Updated `Last Updated` to 2026-03-26. All file paths verified against codebase.                           |
| **Test Spec**       | `docs/testing/message-templates.md`                    | Status updated from PLANNED to ALPHA. Added "Existing Test Coverage" section documenting 27 compiler tests. Added coverage gap analysis mapping all 22 spec scenarios to implementation status. Added iteration log entry. |
| **HLD**             | `docs/specs/message-templates.hld.md`                  | Status updated to ALPHA (partially implemented). Added "Implementation Status" section with per-component status table (14 components, 6 done, 8 not started). Confirmed architecture remains valid for planned BETA.      |
| **LLD / Impl Plan** | `docs/plans/2026-03-23-message-templates-impl-plan.md` | Status updated. Added "Pre-existing Implementation" section documenting 8 components that were already done before this plan was written. All 6 phases marked as PLANNED (none started).                                   |
| **SDLC Log**        | `docs/sdlc-logs/message-templates/04-lld.md`           | This sync entry appended.                                                                                                                                                                                                  |

## Codebase Verification Results

### Confirmed Existing (file paths verified)

- `packages/core/src/parser/agent-based-parser.ts` -- DSL TEMPLATES: parsing
- `packages/compiler/src/platform/ir/compiler.ts` -- `compileTemplates()`, `resolveAllTemplateRefs()`
- `packages/compiler/src/platform/constructs/evaluator.ts` -- `interpolateMessage()` at line 1113
- `packages/compiler/src/__tests__/template-resolution.test.ts` -- 27 tests, 644 lines
- `apps/runtime/src/channels/adapters/whatsapp-providers/whatsapp-transform.ts` -- WhatsApp HSM pass-through
- `apps/studio/src/lib/template-catalog.ts` -- Static catalog data (301 lines)
- `apps/studio/src/components/templates/TemplateCatalogPage.tsx` -- Browse-only catalog page (149 lines)
- `apps/studio/src/components/templates/TemplateInsertPanel.tsx` -- Slide-over insert panel
- `apps/studio/src/components/abl/pickers/TemplatePickerModal.tsx` -- 5 hardcoded sample templates (360 lines)
- `packages/shared/src/prompts/template-engine.ts` -- `renderTemplate()` function
- `packages/shared/src/prompts/prompt-template-loader.ts` -- Platform prompt template loader (pattern reference)
- `packages/database/src/models/prompt-template.model.ts` -- Platform prompt template model (pattern reference)
- `apps/runtime/src/channels/types.ts` -- ChannelType definitions
- `packages/compiler/src/platform/ir/schema.ts` -- IR schema with templates field
- `packages/core/src/types/agent-based.ts` -- AST types with TemplateDefinition
- Related feature docs verified: `docs/features/sub-features/sdk-rich-content-templates.md`, `docs/features/sub-features/sdk-chat-ui-consolidation.md`, `docs/features/channels.md`, `docs/features/abl-language.md`, `docs/archive/plans-2026-02/2026-02-21-i18n-end-to-end-design.md`

### Confirmed NOT Existing (planned for BETA)

- `packages/database/src/models/message-template.model.ts` -- NOT FOUND
- `packages/database/src/models/message-template-version.model.ts` -- NOT FOUND
- `packages/database/src/repos/message-template.repo.ts` -- NOT FOUND
- `packages/database/src/schemas/message-template.schema.ts` -- NOT FOUND
- `apps/runtime/src/routes/message-templates.ts` -- NOT FOUND
- `packages/shared/src/templates/message-template-resolver.ts` -- NOT FOUND
- `apps/studio/src/app/[locale]/projects/[projectId]/templates/page.tsx` -- NOT FOUND
- `apps/studio/src/hooks/useMessageTemplates.ts` -- NOT FOUND

## Key Findings

1. **Test count discrepancy**: Original SDLC logs referenced "22 test scenarios" from the test spec. The actual compiler test file has 27 test cases. The 22 number likely referred to the spec's planned scenarios (10 E2E + 7 integration + 5 unit), not the existing compiler tests which were pre-existing.
2. **Studio components are static-only**: The TemplateCatalogPage, TemplateInsertPanel, and TemplatePickerModal all use hardcoded/static data. None connect to an API. The TemplatePickerModal has exactly 5 hardcoded sample templates (greeting_formal, greeting_casual, escalation_handoff, error_fallback, session_timeout).
3. **HLD decision on embedded vs separate version collection**: The original feature spec decision log says "embedded subdocuments with 50-version cap" but the HLD correctly chose a separate `message_template_versions` collection. The HLD supersedes the feature spec decision log on this point.
4. **All LLD phases are PLANNED**: Despite the feature being at ALPHA, none of the 6 LLD phases have been started. The ALPHA status comes entirely from the pre-existing compile-time layer that was built before this SDLC pipeline was run.
