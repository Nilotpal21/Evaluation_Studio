# SDLC Log: message-templates — Phase 3 (HLD)

**Date**: 2026-03-23
**Phase**: HLD
**Artifact**: `docs/specs/message-templates.hld.md`

## Summary

Generated high-level design covering:

- Architecture overview with 7 components: Template Data Model, Repository, API Routes, Resolver (runtime), Channel Format Mapping, Compiler Integration, Studio UI
- Two MongoDB collections: `message_templates` (main) and `message_template_versions` (history)
- Separate version collection chosen over embedded subdocuments due to 16 MB document size limit risk
- 12 architectural concerns addressed (isolation, auth, consistency, caching, performance, error handling, observability, compliance, scalability, backward compatibility, migration, testing)
- 3 alternatives considered and rejected with rationale
- Security considerations for variable injection, prompt injection, rate limiting

## Key Architecture Decisions

1. **Separate version collection** (not embedded) — prevents 16 MB limit issues with multi-variant templates
2. **Repository pattern** per Sprint 3 conventions — all queries include tenantId/projectId
3. **L1 in-memory cache with Redis pub/sub invalidation** — matches PromptTemplateLoader pattern
4. **Channel-to-variant mapping** — maps ChannelType to variant keys, with channel family fallback (voice_twilio -> voice -> default)
5. **DSL sync is additive** — DSL compilation creates/updates templates with source: 'dsl', never overwrites source: 'api'
6. **OpenAPI-registered routes** — follows the createOpenAPIRouter pattern from tags.ts

## Codebase Grounding

- Route pattern: `apps/runtime/src/routes/tags.ts` (authMiddleware + requireProjectScope + tenantRateLimit)
- Repository pattern: Sprint 3 API verticalization (per architecture simplification plan)
- Cache pattern: `packages/shared/src/prompts/prompt-template-loader.ts`
- Template engine: `packages/shared/src/prompts/template-engine.ts` (renderTemplate)
- Channel types: `apps/runtime/src/channels/types.ts` (ChannelType union)
- Compiler: `packages/compiler/src/platform/ir/compiler.ts` (compileTemplates, resolveAllTemplateRefs)
- Data model pattern: `packages/database/src/models/prompt-template.model.ts`
