# SDLC Log: message-templates — Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Phase**: Feature Spec
**Artifact**: `docs/features/message-templates.md`

## Summary

Generated feature spec for the "message-templates" feature, covering:

- Two existing template subsystems identified: DSL response templates (parser + compiler) and platform prompt templates (MongoDB + PromptTemplateLoader)
- Neither supports project-scoped CRUD, channel-adaptive resolution, or runtime interpolation
- 6 user stories covering agent developers, content editors, and runtime system
- 14 functional requirements (P0-P2) and 6 non-functional requirements
- 8 architecture decisions with classification (DECIDED/INFERRED)

## Codebase References

- DSL template parsing: `packages/core/src/parser/agent-based-parser.ts` (lines 3765-3970)
- Template compilation: `packages/compiler/src/platform/ir/compiler.ts` (lines 2426-2600)
- Template engine: `packages/shared/src/prompts/template-engine.ts`
- Platform prompt templates: `packages/database/src/models/prompt-template.model.ts`
- Prompt template loader: `packages/shared/src/prompts/prompt-template-loader.ts`
- Channel types: `apps/runtime/src/channels/types.ts`
- WhatsApp transform (template usage): `apps/runtime/src/channels/adapters/whatsapp-providers/whatsapp-transform.ts`
- IR schema (AgentMessages, templates field): `packages/compiler/src/platform/ir/schema.ts`
- AST types (TemplateDefinition): `packages/core/src/types/agent-based.ts`
- i18n design: `docs/archive/plans-2026-02/2026-02-21-i18n-end-to-end-design.md`

## Key Decisions

1. Project-scoped templates (not tenant-level) — matches existing isolation patterns
2. Reuse `renderTemplate()` engine for variable interpolation — avoids second template engine
3. Channel-format selection via `ChannelType` discriminated union mapping
4. DSL is authoritative at compile time; API-created templates are additive
5. Version storage: embedded subdocuments with 50-version cap
