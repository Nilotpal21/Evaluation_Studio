# LLM Models Page Redesign — High-Level Design

## What

Redesign the LLM Models settings page in Studio to match the approved wireframe (`docs/wireframes/llm-models-redesign-v2.html`), and add backend support to disable Query Intelligence at runtime so no LLM calls happen for vocabulary resolution when the feature is toggled off.

**Frontend**: Unified card layout with inline toggle + status badge, disabled state with tooltip on Change button, friendly suggestion text, info note on Query Intelligence ("not used when searching through Agent & Tools"), and new section ordering (Embedding → Enrichment → Advanced → Query Pipeline LLM).

**Backend**: Add `enabled` field to `queryLLMConfig` in SearchIndex schema. When Query Intelligence is disabled (`enabled: false`), the query pipeline in search-ai-runtime skips vocabulary resolution and LLM-based query classification — falling back to vector/hybrid search only.

## Architecture Approach

### Packages Changed

| Package                  | What Changes                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/studio`            | SettingsTab, FeatureCard, QueryPipelineLLMSection — new layout, toggle, disabled states, info note |
| `apps/search-ai`         | Zod schema + PUT endpoint — accept `enabled` field in queryLLMConfig                               |
| `apps/search-ai-runtime` | Query route — skip `buildPerTenantPipeline` LLM resolution when `enabled: false`                   |
| `packages/database`      | SearchIndex model — add `enabled` field to `queryLLMConfig` sub-schema                             |
| `packages/i18n`          | New/updated translation keys for redesigned UI                                                     |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  STUDIO (SettingsTab)                                               │
│                                                                     │
│  Section 1: LLM Features                                           │
│    ├── EmbeddingModelSection                                        │
│    ├── Enrichment Features (FeatureCards)                           │
│    │   └── ProgSum, QSynth, TreeBuilder, KG, Vocab, Scope, Mapping │
│    └── Advanced Features (FeatureCards)                             │
│        └── Vision, Multimodal                                       │
│                                                                     │
│  Section 2: Query Pipeline LLM                                      │
│    └── QueryPipelineLLMSection (redesigned)                         │
│        ├── "Query Intelligence" card with toggle                    │
│        ├── Info note: "Not used via Agent & Tools"                  │
│        └── Warning when disabled: "vector/hybrid only"              │
│                                                                     │
│  Toggle OFF → PUT /api/search-ai/indexes/:id/query-llm-config      │
│               { enabled: false }                                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SEARCH-AI (indexes route)                                           │
│                                                                      │
│  PUT /:indexId/query-llm-config                                      │
│    → validates { enabled?, modelId?, autoSelect?, preferredTier? }   │
│    → updates SearchIndex.queryLLMConfig.enabled                      │
│                                                                      │
│  GET /:indexId/query-llm-status                                      │
│    → returns enabled field in response                               │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SEARCH-AI-RUNTIME (query route)                                     │
│                                                                      │
│  POST /:indexId/query                                                │
│    → buildPerTenantPipeline()                                        │
│      → reads SearchIndex.queryLLMConfig                              │
│      → if enabled === false: returns pipeline WITHOUT LLM resolver   │
│      → QueryPipeline.executeUnified() skips vocab resolution         │
│      → Search falls back to vector/hybrid only                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **SearchIndex.queryLLMConfig.enabled** — new boolean field (default: `true` for backward compat)
2. **Query LLM status API** — returns `enabled` field so UI can render toggle state
3. **Query LLM config API** — accepts `enabled` field to persist toggle state
4. **buildPerTenantPipeline()** — checks `enabled` before resolving LLM stack
5. **Agent tool DSL** — agents already pass `skipVocabularyResolution: true`, so they're unaffected

## Decisions & Tradeoffs

1. **`enabled` on queryLLMConfig vs separate field**: Chose to add `enabled` inside the existing `queryLLMConfig` subdocument rather than a separate top-level field. This keeps all query LLM settings co-located and the API contract clean.

2. **Default `true` for backward compat**: Existing indexes don't have `enabled` set. Defaulting to `true` means no migration needed — all existing KBs continue working as before.

3. **Skip at pipeline build time, not execution time**: When disabled, we don't build the LLM resolver at all (no LLM client instantiation) rather than checking a flag at query time. This is more efficient — zero LLM overhead when disabled.

4. **Section reordering — wireframe-driven**: Moving Query Pipeline LLM to bottom and merging Core + Enrichment follows the approved wireframe. The `FEATURE_CATEGORY_KEYS` and `getFeaturesByCategory()` in SettingsTab will be updated.

5. **Info note as inline component**: The "not used via Agent & Tools" note is a static info pill on the Query Intelligence card, not a separate component. It's simple, visible, and doesn't require user interaction.

6. **Disabled state — CSS-only tooltip**: Using the existing Radix `<Tooltip>` component (already in the codebase) instead of CSS-only tooltips for accessibility and consistency.

## Task Decomposition

| Task                                                                      | Package(s)                        | Independent? | Est. Files |
| ------------------------------------------------------------------------- | --------------------------------- | ------------ | ---------- |
| T-1: Add `enabled` field to queryLLMConfig schema + validation            | packages/database, apps/search-ai | Yes          | 3          |
| T-2: Update query-llm-status/config API endpoints                         | apps/search-ai                    | No (T-1)     | 2          |
| T-3: Skip LLM in runtime when disabled                                    | apps/search-ai-runtime            | No (T-1)     | 1          |
| T-4: Redesign SettingsTab layout (section ordering)                       | apps/studio                       | Yes          | 2          |
| T-5: Redesign QueryPipelineLLMSection (toggle, disabled state, info note) | apps/studio                       | No (T-4)     | 2          |
| T-6: Update FeatureCard for new card layout pattern                       | apps/studio                       | No (T-4)     | 1          |
| T-7: Add/update i18n translation keys                                     | packages/i18n                     | Yes          | 1          |

**Wave 1 (parallel)**: T-1, T-4, T-7
**Wave 2 (depends on T-1)**: T-2, T-3
**Wave 3 (depends on T-4, T-7)**: T-5, T-6

## Out of Scope

- Per-feature model pinning (existing behavior preserved as-is)
- Cost estimates display changes
- Embedding model section redesign (already has its own component)
- Query pipeline performance monitoring
- Migration script for existing data (default `true` handles backward compat)
