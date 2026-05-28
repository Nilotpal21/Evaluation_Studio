# Unified Embedding Model Selection — High-Level Design

## What

Unify the embedding model selection flow so users manage embedding models through the same Admin → Models workspace catalog used for LLM models. The KB-level embedding section becomes a dropdown of available embedding-capable models from the workspace — not a hardcoded static list. Custom/self-hosted embedding models also go through Admin → Models (Custom Model tab) instead of a separate dialog.

## Problem

Today the embedding model selection is disconnected from the workspace model catalog:

1. User adds "Text Embedding 3 Large" in Admin → Models → it's stored as a TenantModel
2. But the KB embedding section shows a **static hardcoded list** from `EMBEDDING_PROVIDERS` registry
3. User sees the same models listed twice — once in the catalog, once in the embedding dropdown
4. Custom embedding models require a separate "Custom Model" tab in the embedding dialog
5. No way to tell which TenantModels are embedding-capable vs LLM-capable

## Architecture Approach

### Detection: How We Know a Model is an Embedding Model

The built-in model registry (`packages/compiler/src/platform/llm/model-registry.ts`) already tags embedding models:

```
capabilities: ['textToEmbedding']   ← already exists for all 6 embedding models
maxOutputTokens: 0                  ← secondary signal
supportsTools: false                ← secondary signal
```

When a user adds a model from the catalog in Admin → Models, the `AddModelDialog` calls `/api/model-capabilities/:modelId` which returns the catalog entry. If `capabilities` includes `'textToEmbedding'`, we auto-set on the TenantModel:

```
capabilities: ['embedding']   ← NEW value added to existing array field
tier: 'embedding'             ← NEW tier value (not routable for LLM use cases)
```

For Custom Models: user explicitly checks an "Embedding Model" checkbox in the Custom Model form.

### Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  Admin → Models → Add Model                                   │
│                                                               │
│  User adds "Text Embedding 3 Large" from catalog              │
│    → /api/model-capabilities/text-embedding-3-large           │
│    → capabilities: ['textToEmbedding'] detected               │
│    → TenantModel.create({                                     │
│        modelId: 'text-embedding-3-large',                     │
│        capabilities: ['embedding'],                           │
│        tier: 'embedding',                                     │
│        ...                                                    │
│      })                                                       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  GET /api/indexes/:id/embedding-providers (MODIFIED)          │
│                                                               │
│  Returns:                                                     │
│    - BGE-M3 (always, self-hosted, from static registry)       │
│    - TenantModels where capabilities includes 'embedding'     │
│      Each with: id, displayName, provider, modelId,           │
│      dimensions[], defaultDimensions, hasCredentials,          │
│      costPer1MTokens                                          │
│    - If no tenant embedding models: show "Add in Admin" link  │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  KB → LLM Models → Embedding Section (UI)                     │
│                                                               │
│  Dropdown shows:                                              │
│    ● BGE-M3         Self-hosted   1024d   (Current)           │
│    ○ Text Embed 3 Large  OpenAI   3072d   From workspace      │
│    ○ Text Embed 3 Small  OpenAI   1536d   From workspace      │
│    ○ Ada v2 (Azure)      Azure    1536d   From workspace      │
│                                                               │
│  Dimensions: [3072 ▼] (auto-default + override dropdown)      │
│                                                               │
│  ⚠ Changing requires re-indexing all documents                │
│  [ Cancel ]  [ Change & Re-index ]                            │
└──────────────────────────────────────────────────────────────┘
```

### Packages Changed

| Package             | Change                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database` | Add `'embedding'` to TenantModel capabilities enum, add `'embedding'` to tier enum                                                                                        |
| `apps/search-ai`    | Modify `GET /providers/embedding` to merge static BGE-M3 + tenant embedding models. Modify `PUT /:indexId/embedding-model-config` to resolve credentials from TenantModel |
| `apps/studio`       | Modify `EmbeddingModelDialog` to show dropdown from merged providers. Remove "Custom Model" tab. Modify `AddModelDialog` to auto-detect embedding models                  |
| `apps/runtime`      | Model catalog already returns `capabilities: ['textToEmbedding']` — no change needed                                                                                      |

### Key Integration Points

1. **Admin → Models (AddModelDialog)** — detect embedding on add, set capabilities/tier
2. **Search-AI embedding providers route** — merge static + tenant models
3. **EmbeddingModelDialog** — consume merged provider list as dropdown
4. **Embedding credential resolution** — use TenantModel connection (same as LLM features)
5. **Re-indexing flow** — unchanged, still triggers full re-embed

## Decisions & Tradeoffs

| Decision              | Chose                                                    | Over                                 | Because                                                            |
| --------------------- | -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Embedding identifier  | `capabilities: ['embedding']` on TenantModel             | Separate `isEmbedding` field         | Reuses existing capabilities array, no schema migration            |
| Custom embedding      | Via Admin → Models → Custom Model + checkbox             | Separate dialog in KB                | Unified flow — one place to manage all models                      |
| BGE-M3 handling       | Always shown in dropdown (static, no TenantModel needed) | Require user to add it               | Self-hosted default should always be available with zero config    |
| Dimension selection   | Auto-default from model metadata + dropdown override     | Force user to pick                   | Most users want the default; power users can override              |
| Credential resolution | Reuse TenantModel.connections (same as LLM)              | Separate embedding credential system | Already works — same API key, same encrypted storage               |
| Tier value            | New `'embedding'` tier                                   | Reuse 'fast'/'balanced'              | Prevents embedding models from appearing in LLM feature resolution |

## Task Decomposition

| Task                                                            | Package(s) | Independent? | Est. Files |
| --------------------------------------------------------------- | ---------- | ------------ | ---------- |
| T-1: Add embedding capability detection to AddModelDialog       | studio     | Yes          | 1-2        |
| T-2: Add 'embedding' tier + capability to TenantModel schema    | database   | Yes          | 1          |
| T-3: Modify embedding providers endpoint to merge tenant models | search-ai  | Depends T-2  | 2-3        |
| T-4: Redesign EmbeddingModelDialog with unified dropdown        | studio     | Depends T-3  | 2-3        |
| T-5: Credential resolution via TenantModel for cloud embeddings | search-ai  | Depends T-2  | 1-2        |
| T-6: Remove "Custom Model" tab from embedding dialog            | studio     | Depends T-4  | 1          |

## Out of Scope

- Embedding model fine-tuning or custom training
- Multi-embedding (using different models for different document types)
- Embedding model performance benchmarking in UI
- Migration from old credential resolution path (backward compat maintained)
- Changes to the re-indexing orchestrator (works as-is)
- Changes to vector store layer (dimensions handled at config level)

## Preserved Capabilities

- ✅ Re-indexing warning + confirmation flow
- ✅ Dimensions selection (auto-default + override)
- ✅ BGE-M3 always available (self-hosted, zero cost)
- ✅ Custom embedding support (via Admin → Models → Custom Model + embedding checkbox)
- ✅ Cost estimation display
- ✅ Migration status tracking
- ✅ Azure-specific config (resourceName, deploymentId, apiVersion) — from TenantModel.connections
- ✅ Credential validation (hasCredentials flag)
