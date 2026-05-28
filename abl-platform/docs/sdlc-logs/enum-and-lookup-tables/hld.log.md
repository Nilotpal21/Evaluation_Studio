# HLD — Oracle Log: enum-and-lookup-tables

**Date:** 2026-03-24
**Phase:** HLD
**Oracle:** Inline (agent model unavailable)

## Architecture & Data Flow

1. **Architecture pattern?** — ANSWERED. Extends existing pipeline: Parser→Compiler→IR→Runtime. No new services. Enum adds a compiler code path; lookup adds a runtime resolver service.
2. **Data flow?** — ANSWERED. Request path: DSL text → parser AST → compiler IR → runtime extraction (LLM tool schema) → post-extraction validation (lookup resolver). Event: none.
3. **Expected scale?** — INFERRED. Same as current gather field processing. Lookup adds ~1 async hop per field (inline: O(1), collection: 1 MongoDB query, API: 1 HTTP call). Caches mitigate repeat lookups.
4. **Existing patterns?** — ANSWERED. Follows existing validation pipeline (pattern/range/custom). Adds enum as 4th validation type. Lookup resolver follows circuit breaker + TTL cache pattern from existing code.
5. **Deployment topology?** — ANSWERED. Single runtime service. No new workers or services.

## Integration & Dependencies

1. **Dependencies?** — ANSWERED. @abl/core (parser), @abl/compiler (IR), @agent-platform/database (LookupEntry model), apps/runtime (execution).
2. **External deps?** — ANSWERED. None new. API lookup source uses fetch (already available). MongoDB (already available).
3. **API contract?** — ANSWERED. No new API endpoints. Existing REST API for lookup data CRUD unchanged. IR schema extended (backward compatible: new optional fields).
4. **Breaking changes?** — DECIDED. None. New `options` on GatherField is optional. New `headers` on LookupTableIR is optional. New `enum_values` on IR GatherField is optional.
5. **Compile→deploy→execute lifecycle?** — ANSWERED. Enum options parsed at compile time → embedded in IR. Lookup tables compiled at deploy time → resolved at execute time.

## Risk & Migration

1. **Biggest risk?** — DECIDED. Token budget for LLM prompt injection. Large inline tables (>100 values) could blow token limits. Mitigated by description-only hint fallback.
2. **Data migration?** — ANSWERED. None. New fields are optional additions to existing IR schema.
3. **Rollback strategy?** — DECIDED. Revert branch. No data migration to undo.
4. **Feature flags?** — DECIDED. Not needed. Enum/lookup are opt-in DSL features — no impact on existing agents.
5. **Blast radius?** — INFERRED. Limited to agents that use `type: enum` or `LOOKUP_TABLES:`. Existing agents unaffected.

## Classification Summary

- ANSWERED: 10, INFERRED: 3, DECIDED: 5, AMBIGUOUS: 0
