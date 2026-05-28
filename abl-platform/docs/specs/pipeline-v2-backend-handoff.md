# Pipeline Editor V2 — Backend Handoff Notes

> **Date:** 2026-04-15
> **Ticket:** ABLP-131
> **Branch:** `develop`
> **Author:** Architect agent (from UX review sessions with Bharat)

---

## 1. What the V2 UX Shows Today

The Pipeline Editor V2 is a multi-flow DAG canvas that shows ALL pipeline flows
simultaneously in a left-to-right swim-lane layout. Here is exactly what the
user sees and interacts with:

### Canvas Layout (left → right)

```
Documents ─→ [Flow 1: Extraction → Chunking → Content Intelligence → Visual Analysis] ─→ Embedding Fields → Embedding → OpenSearch
Content      [Flow 2: Extraction → Chunking → Content Intelligence → Visual Analysis] ─↗
Router
```

### Stage Types Visible on Canvas

| Stage Type             | Provider                              | Config Panel                                                     | Notes                      |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| `extraction`           | `docling` or `llamaindex`             | Provider dropdown + DoclingConfig / LlamaIndexConfig             | User can switch provider   |
| `chunking`             | `recursive-character` or `fixed-size` | Provider dropdown + ChunkingConfig                               | User can switch provider   |
| `content-intelligence` | `content-intelligence` (fixed)        | ContentIntelligenceConfig — dedicated form, no provider dropdown | 8 config fields (see §3.1) |
| `visual-analysis`      | `visual-analysis` (fixed)             | VisualAnalysisConfig — dedicated form, no provider dropdown      | 7 config fields (see §3.2) |

### Stages NOT Shown on Canvas

| Stage        | Why Hidden                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrichment` | **Filtered out in `graph-builder.ts` line 108.** The old enrichment stage is replaced in the UX by content-intelligence + visual-analysis. The normalization layer in `pipeline-store.ts` preserves it in the data for backward compat, but users never see it. |
| `embedding`  | Shown as shared node in output zone (Embedding Fields → Embedding → OpenSearch), not as an inline stage.                                                                                                                                                        |

### Stage Insertion (the "+" button)

Users hover over an edge between two stages to see a "+" button (`InsertableEdge`).
Clicking opens `AddStagePopover` which lists valid stage types for that position.

The insertion rules in `stage-insertion-rules.ts` enforce this order:

```
STAGE_ORDER = ['extraction', 'chunking', 'content-intelligence', 'visual-analysis', 'enrichment']
```

**Problem:** `enrichment` is still listed in `STAGE_ORDER` and appears in the
add-stage popover. It also appears in `ADD_STAGE_TYPES` in `DetailPanel.tsx`
line 735. This should be removed once the backend no longer requires it.

### Utility Stages (order-free, in add-stage picker)

| Stage           | Provider        | Config Panel                  |
| --------------- | --------------- | ----------------------------- |
| `custom-script` | `custom-script` | Opens ScriptSidePanel overlay |
| `field-mapping` | `field-mapping` | FieldMappingConfig inline     |
| `api-webhook`   | `api-webhook`   | ApiStageConfig inline         |
| `llm-stage`     | `llm-stage`     | LlmStageConfig inline         |

### Stage Context Menu (right-click)

Each stage node has a right-click context menu (`StageContextMenu`) with:
Configure, Move Left, Move Right, Duplicate, Remove.

### Shared Output Zone

Visible on every pipeline (not per-flow):

- **Embedding Fields** node → opens embedding-fields config panel
- **Embedding** node → shows provider/model, opens embedding-config panel
- **OpenSearch** node → locked terminal node, non-interactive

---

## 2. Frontend Workarounds That Need Backend Resolution

### 2.1 Stage Injection Normalization (`pipeline-store.ts` lines 217-305)

On every pipeline load, `normalizePipelineFlows()` runs:

1. **Migrates `tree-builder` → `recursive-character`** (tree-builder is not fully wired)
2. **Injects `content-intelligence` stage** if missing — with these defaults:
   ```json
   {
     "generateSummary": true,
     "generateQuestions": true,
     "documentSummary": true,
     "documentQuestions": true,
     "questionsPerChunk": 3,
     "summaryMaxTokens": 300,
     "modelTier": "fast"
   }
   ```
3. **Injects `visual-analysis` stage** if missing — with these defaults:
   ```json
   {
     "analyzeImages": true,
     "analyzeScreenshots": true,
     "summarizeTables": true,
     "analyzeCharts": true,
     "enhanceTableContinuations": true,
     "modelTier": "balanced"
   }
   ```
4. **Reorders all stages** by canonical type rank:
   `extraction(0) → chunking(1) → content-intelligence(2) → visual-analysis(3) → enrichment(4)`

### 2.2 Canvas Filtering (`graph-builder.ts` line 108)

```typescript
.filter((s) => s.type !== 'embedding' && s.type !== 'enrichment')
```

The graph-builder hides `enrichment` and `embedding` from the canvas. Users see
CI and VA instead.

### 2.3 Save/Deploy Concern

When the user saves, the store sends back the full `flows[]` including the
injected CI and VA stages. The backend validation (`VALID_STAGE_TYPES` in
`apps/search-ai/src/services/pipeline-validation/types.ts` line 118) only accepts:

```
'extraction' | 'chunking' | 'enrichment' | 'embedding' | 'multimodal'
```

`content-intelligence` and `visual-analysis` **will be rejected** by the backend.
This is the primary blocker.

---

## 3. Exact Config Fields the UX Exposes (Backend Must Support)

### 3.1 Content Intelligence Config

**Frontend component:** `providers/ContentIntelligenceConfig.tsx`
**Stage type:** `content-intelligence`
**Provider:** `content-intelligence`

The user configures these via toggles, sliders, and a dropdown:

| Field                      | Type    | Default  | UI Control                              | Purpose                       |
| -------------------------- | ------- | -------- | --------------------------------------- | ----------------------------- |
| `generateSummary`          | boolean | true     | Toggle                                  | Per-chunk summarization       |
| `summaryMaxTokens`         | number  | 300      | Slider (100-1000, step 50)              | Max tokens per chunk summary  |
| `documentSummary`          | boolean | true     | Toggle (nested under generateSummary)   | Whole-document summary        |
| `documentSummaryMaxTokens` | number  | 500      | Slider (200-2000, step 100)             | Max tokens for doc summary    |
| `generateQuestions`        | boolean | true     | Toggle                                  | Per-chunk question synthesis  |
| `questionsPerChunk`        | number  | 3        | Slider (1-10, step 1)                   | Questions generated per chunk |
| `documentQuestions`        | boolean | true     | Toggle (nested under generateQuestions) | Whole-document questions      |
| `documentQuestionsCount`   | number  | 5        | Slider (1-20, step 1)                   | Questions for whole doc       |
| `modelTier`                | string  | `'fast'` | Select: fast / balanced / powerful      | LLM model selection tier      |

**Backend mapping:** This replaces the text-enrichment portion of the old
`enrichment` stage. The backend's `enrichment-worker.ts` currently handles
summaries and enqueues question-synthesis. These config fields must be read
from `stage.providerConfig` when processing a `content-intelligence` stage.

### 3.2 Visual Analysis Config

**Frontend component:** `providers/VisualAnalysisConfig.tsx`
**Stage type:** `visual-analysis`
**Provider:** `visual-analysis`

| Field                       | Type    | Default      | UI Control                  | Purpose                        |
| --------------------------- | ------- | ------------ | --------------------------- | ------------------------------ |
| `analyzeImages`             | boolean | true         | Toggle                      | Analyze embedded images        |
| `analyzeScreenshots`        | boolean | true         | Toggle                      | Detect and analyze screenshots |
| `analyzeCharts`             | boolean | true         | Toggle                      | Analyze charts/graphs          |
| `summarizeTables`           | boolean | true         | Toggle                      | Generate table summaries       |
| `enhanceTableContinuations` | boolean | true         | Toggle                      | Merge multi-page tables        |
| `modelTier`                 | string  | `'balanced'` | Select: balanced / powerful | Vision model tier              |
| `maxTokens`                 | number  | 500          | Slider (200-2000, step 100) | Max tokens for descriptions    |

**Backend mapping:** This replaces the visual/multimodal portion of the old
`enrichment` stage. The backend's `visual-enrichment-worker.ts` currently
processes images and tables. These config fields must be read from
`stage.providerConfig` when processing a `visual-analysis` stage.

### 3.3 Extraction Configs (existing, verify unchanged)

**Docling** (`DoclingConfig.tsx`): Provider dropdown → `docling`
**LlamaIndex** (`LlamaIndexConfig.tsx`): Provider dropdown → `llamaindex`

These have existing config forms. Verify backend reads the same field names.

### 3.4 Chunking Configs (existing, verify unchanged)

**Recursive Character / Fixed Size** (`ChunkingConfig.tsx`): Provider dropdown

These have existing config forms. Verify backend reads the same field names.

### 3.5 Enrichment Config (LEGACY — to be removed)

**EnrichmentConfig.tsx** still exists for `llm-enrichment` and `question-synthesis`
providers. Once CI + VA replace enrichment in the backend, this component and
the `enrichment` provider list in `DetailPanel.tsx` lines 80-85 should be removed.

---

## 4. Backend Objectives

### Objective 1: Accept `content-intelligence` and `visual-analysis` as Valid Stage Types

| File                                                                       | Change                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/database/src/models/search-pipeline-definition.model.ts` line 25 | Add `'content-intelligence' \| 'visual-analysis'` to `SearchPipelineStageType` union |
| Same file, line 226                                                        | Add to Mongoose schema enum array                                                    |
| `apps/search-ai/src/services/pipeline-validation/types.ts` line 118        | Add to `VALID_STAGE_TYPES` array                                                     |

### Objective 2: Map New Stage Types to Existing Worker Queues

| File                                                                         | Change                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts` line 90 | Add queue mappings: `'content-intelligence' → 'search-enrichment'`, `'visual-analysis' → 'search-visual-enrichment'` |

### Objective 3: Register Providers for New Stage Types

| File                                                                            | Change                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/search-ai/src/services/provider-registry/providers/register-providers.ts` | Register `content-intelligence` provider (stage type `content-intelligence`) and `visual-analysis` provider (stage type `visual-analysis`) |

The providers need to read `providerConfig` fields listed in §3.1 and §3.2 above
and pass them to the respective workers.

### Objective 4: Update Workers to Read New Config Fields

**`enrichment-worker.ts`** — When triggered by a `content-intelligence` stage, read:

- `generateSummary`, `summaryMaxTokens` → chunk-level summaries
- `documentSummary`, `documentSummaryMaxTokens` → document-level summary
- `generateQuestions`, `questionsPerChunk` → chunk question synthesis
- `documentQuestions`, `documentQuestionsCount` → document-level questions
- `modelTier` → LLM model selection

**`visual-enrichment-worker.ts`** — When triggered by a `visual-analysis` stage, read:

- `analyzeImages`, `analyzeScreenshots`, `analyzeCharts` → what to process
- `summarizeTables`, `enhanceTableContinuations` → table handling
- `modelTier` → vision model selection
- `maxTokens` → description length

**Review needed:** Compare these field names against what the workers currently
read from `providerConfig`. If the current enrichment worker reads different
field names (e.g., `config.multiModal.enabled` vs `analyzeImages`), a mapping
layer is needed.

### Objective 5: Update Default Pipeline Template

**File:** `apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts`

Current "Rich Documents" flow (line 79-110):

```
extraction (docling) → chunking (tree-builder) → enrichment (llm-enrichment)
```

Should become:

```
extraction (docling) → chunking (recursive-character) → content-intelligence (content-intelligence) → visual-analysis (visual-analysis)
```

Current "Text Documents" flow (line 135-150):

```
extraction (llamaindex) → chunking (recursive-character)
```

Should become:

```
extraction (llamaindex) → chunking (recursive-character) → content-intelligence (content-intelligence)
```

Note: Text documents likely don't need visual-analysis by default (no images).
**Decide:** Should text flow get a VA stage with `analyzeImages: false` or no VA stage?

### Objective 6: Deprecate `enrichment` Stage Type

Once Objectives 1-5 are complete:

1. **Remove `enrichment` from the model enum** — old pipelines need migration first
2. **MongoDB migration:** For each pipeline with `type: 'enrichment'`, replace with
   CI + VA stages. Map `providerConfig` fields:
   - Text enrichment fields → CI stage `providerConfig`
   - Visual/multimodal fields → VA stage `providerConfig`
3. **Remove `tree-builder` migration** from frontend normalization

---

## 5. Migration Strategy

### Phase 1: Non-Breaking — Accept New Types (do first)

- Add CI + VA to `SearchPipelineStageType`, validation, queue mapping, providers
- Keep `enrichment` as valid (backward compat)
- New pipelines still create with old template
- **Result:** Frontend can save CI + VA stages without rejection

### Phase 2: New Default Template

- Update `default-pipeline-template.ts` per Objective 5
- New KBs get CI + VA stages
- Existing KBs keep old pipelines (still work)

### Phase 3: Data Migration

- MongoDB migration script: split `enrichment` → CI + VA per pipeline
- Test with production data snapshot first
- Run migration during maintenance window

### Phase 4: Frontend + Backend Cleanup

- Remove frontend normalization (`normalizePipelineFlows`)
- Remove `enrichment` filter from `graph-builder.ts`
- Remove `enrichment` from `STAGE_ORDER`, `ADD_STAGE_TYPES`, `PROVIDERS_BY_TYPE`
- Remove `EnrichmentConfig.tsx`, `TreeBuilderConfig.tsx`
- Remove `enrichment` from backend `SearchPipelineStageType`

---

## 6. Files Reference

### Frontend (current state on `develop`)

| File                                                                                        | What It Does                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/pipelines/v2/graph-builder.ts`                        | Builds React Flow nodes/edges from pipeline data. Filters out `enrichment` + `embedding` from canvas. |
| `apps/studio/src/components/search-ai/pipelines/v2/PipelineCanvasV2.tsx`                    | Canvas rendering, viewport positioning (starts from first node).                                      |
| `apps/studio/src/components/search-ai/pipelines/v2/nodes/StageNode.tsx`                     | Stage node component — colored left bar, type label, provider name, context menu.                     |
| `apps/studio/src/components/search-ai/pipelines/v2/edges/InsertableEdge.tsx`                | Edge with hover "+" button for stage insertion.                                                       |
| `apps/studio/src/components/search-ai/pipelines/v2/stage-insertion-rules.ts`                | Position-aware rules for which stages can be inserted where.                                          |
| `apps/studio/src/components/search-ai/pipelines/v2/AddStagePopover.tsx`                     | Stage picker popover (from "+" button).                                                               |
| `apps/studio/src/components/search-ai/pipelines/v2/DetailPanel.tsx`                         | Right sidebar — stage config, flow config, add stage picker.                                          |
| `apps/studio/src/components/search-ai/pipelines/v2/providers/ContentIntelligenceConfig.tsx` | CI config form (8 fields).                                                                            |
| `apps/studio/src/components/search-ai/pipelines/v2/providers/VisualAnalysisConfig.tsx`      | VA config form (7 fields).                                                                            |
| `apps/studio/src/components/search-ai/pipelines/v2/providers/EnrichmentConfig.tsx`          | Legacy enrichment config (to be removed).                                                             |
| `apps/studio/src/store/pipeline-store.ts`                                                   | Zustand store with normalization layer (lines 217-305).                                               |
| `apps/studio/src/api/pipelines.ts`                                                          | API client + frontend types.                                                                          |

### Backend (needs changes)

| File                                                                                 | What It Does                                                         |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/database/src/models/search-pipeline-definition.model.ts`                   | `SearchPipelineStageType` union (line 25), Mongoose enum (line 226). |
| `apps/search-ai/src/services/pipeline-validation/types.ts`                           | `VALID_STAGE_TYPES` array (line 118).                                |
| `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`                 | `getQueueName()` stage→queue mapping (line 90).                      |
| `apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts`    | Default pipeline creation — Rich Docs + Text Docs flows.             |
| `apps/search-ai/src/services/provider-registry/providers/register-providers.ts`      | Provider registration (line 49).                                     |
| `apps/search-ai/src/workers/enrichment-worker.ts`                                    | Text enrichment worker — summaries, stats, custom stages.            |
| `apps/search-ai/src/workers/visual-enrichment-worker.ts`                             | Visual enrichment worker — images, tables, charts via VisionService. |
| `apps/search-ai/src/services/provider-registry/providers/llm-enrichment.provider.ts` | LLM enrichment provider definition.                                  |
