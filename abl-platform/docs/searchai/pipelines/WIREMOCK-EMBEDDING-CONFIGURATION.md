# Wiremock: Embedding Configuration UI

**Status:** Draft - Pending Review
**Date:** 2026-03-09
**Related:** `04-CONFIGURABLE-EMBEDDING-PROVIDERS.md`

---

## Where It Lives

The embedding configuration section is part of the **Pipeline Editor** (`PipelineEditor.tsx`). It renders in the **PipelineHeader** area as a clearly visible section since embedding model is a pipeline-level setting (not per-flow).

```
PipelineEditor
  +-- PipelineHeader (name, status, publish)
  +-- EmbeddingConfigSection  <-- NEW (below header, above flows)
  +-- FlowsList (25% sidebar)
  +-- FlowDetail (75% content)
```

---

## Wiremock 1: Embedding Config Section (Default State)

```
+------------------------------------------------------------------------+
|  Embedding Model                                                        |
|                                                                         |
|  [BGE-M3 icon]  BGE-M3                                    [Change]     |
|                  bge-m3 | 1024 dimensions | Self-hosted                |
|                                                                         |
+------------------------------------------------------------------------+
```

**Design Notes:**

- Single row, compact, always visible in pipeline editor
- Shows: provider name, model ID, dimensions, hosted type
- `[Change]` button opens the change dialog
- Uses `Card` component with `px-6 py-3` padding (same as PipelineHeader)
- Provider icon: colored dot (green = self-hosted, blue = cloud)

---

## Wiremock 2: Change Embedding Model Dialog

Triggered by clicking `[Change]` button. Full-screen modal or slide-over.

```
+------------------------------------------------------------------------+
|  Change Embedding Model                                          [X]   |
|                                                                         |
|  Current: BGE-M3 (bge-m3, 1024 dim)                                   |
|                                                                         |
|  Select Provider                                                        |
|  +------------------------------------------------------------------+  |
|  |  (*) BGE-M3                          Self-hosted | Free          |  |
|  |      Default. Multilingual. No API key needed.                   |  |
|  |                                                                   |  |
|  |  ( ) OpenAI Embeddings               Cloud | $0.02/1M tokens    |  |
|  |      High quality English embeddings.                             |  |
|  |      [!] Requires API key (configured)                           |  |
|  |                                                                   |  |
|  |  ( ) Cohere Embeddings               Cloud | $0.10/1M tokens    |  |
|  |      Multilingual with search optimization.                       |  |
|  |      [X] Requires API key (not configured)                       |  |
|  |          -> Configure in Settings > LLM Providers                |  |
|  |                                                                   |  |
|  |  ( ) Custom Endpoint                  Self-hosted | Free         |  |
|  |      OpenAI-compatible custom endpoint.                           |  |
|  +------------------------------------------------------------------+  |
|                                                                         |
|  Model                                                                  |
|  [  text-embedding-3-small          v ]                                |
|                                                                         |
|  Dimensions                                                             |
|  [  1536                             v ]                                |
|                                                                         |
+------------------------------------------------------------------------+
|                                                                         |
|  [!] Warning: Changing the embedding model requires reindexing          |
|      all 10,000 documents in this knowledge base.                      |
|                                                                         |
|  Estimated time: ~2 hours                                               |
|  Estimated cost: ~$4.00 (OpenAI API)                                   |
|                                                                         |
|                           [Cancel]  [Change and Reindex]                |
|                                                                         |
+------------------------------------------------------------------------+
```

**Design Notes:**

- Provider list uses radio buttons with full descriptions
- Providers without credentials are selectable but show warning inline
- Providers without credentials: radio still clickable, but "Change and Reindex" disabled with tooltip "Configure API key first"
- Model dropdown only shows when provider is selected (conditional)
- Dimensions dropdown only shows models that support multiple dimensions
- Warning section at bottom uses `Alert` variant="warning"
- "Change and Reindex" is primary button, destructive action styling (red/orange)
- Cost estimate: `$0.00` for self-hosted, calculated for cloud providers

---

## Wiremock 3: Custom Endpoint Configuration

When "Custom Endpoint" is selected, show additional fields:

```
|  Model                                                                  |
|  [  my-embedding-model               ]                                 |
|                                                                         |
|  Dimensions                                                             |
|  [  768                               ]                                |
|                                                                         |
|  Endpoint URL                                                           |
|  [  http://my-service:8000            ]                                |
|  Must be OpenAI-compatible (/v1/embeddings)                            |
|                                                                         |
|  API Key (optional)                                                     |
|  [  ****                              ]                                |
```

---

## Wiremock 4: Reindexing In Progress

After changing embedding model and confirming:

```
+------------------------------------------------------------------------+
|  Embedding Model                                                        |
|                                                                         |
|  [OpenAI icon]  OpenAI text-embedding-3-small              [Changing]  |
|                 1536 dimensions | Cloud                                 |
|                                                                         |
|  [============================        ] 72% Reindexing                 |
|  7,200 / 10,000 documents | ~28 min remaining                         |
|                                                                         |
+------------------------------------------------------------------------+
```

**Design Notes:**

- Progress bar replaces the `[Change]` button during reindex
- Shows document count and ETA
- `[Changing]` badge replaces static info, uses amber/yellow styling
- Cannot change embedding model again while reindexing

---

## Component Hierarchy

```
EmbeddingConfigSection (new)
  +-- EmbeddingConfigDisplay          (compact row showing current config)
  +-- ChangeEmbeddingDialog (new)     (modal/dialog)
       +-- ProviderSelector           (radio list with descriptions)
       +-- ModelSelector              (conditional dropdown)
       +-- DimensionSelector          (conditional dropdown)
       +-- CustomEndpointFields       (conditional text inputs)
       +-- ReindexWarning             (alert with cost/time estimate)
       +-- ConfirmButton              (destructive action)
```

---

## State Management

Extends `pipeline-store.ts`:

```typescript
// New state
embeddingProviders: EmbeddingProviderInfo[] | null;
embeddingConfigDialogOpen: boolean;
embeddingConfigSaving: boolean;

// New actions
loadEmbeddingProviders: (projectId: string) => Promise<void>;
openEmbeddingConfigDialog: () => void;
closeEmbeddingConfigDialog: () => void;
updateEmbeddingConfig: (
  projectId: string,
  kbId: string,
  pipelineId: string,
  config: { provider: string; model: string; dimensions: number; confirm: true },
) => Promise<void>;
```

---

## API Calls

| Action                                         | API                                     | Method         |
| ---------------------------------------------- | --------------------------------------- | -------------- |
| Load providers                                 | `GET /pipelines/providers/embedding`    | On dialog open |
| Change config                                  | `PATCH /pipelines/:id/embedding-config` | On confirm     |
| Load pipeline (includes activeEmbeddingConfig) | `GET /pipelines`                        | On page load   |

---

## Interaction Flow

```
1. User opens Pipeline Editor
   -> Pipeline loads with activeEmbeddingConfig
   -> EmbeddingConfigSection shows current config

2. User clicks [Change]
   -> Dialog opens
   -> GET /pipelines/providers/embedding (with hasCredentials)
   -> Provider list renders

3. User selects provider
   -> Model dropdown updates
   -> Dimensions dropdown updates
   -> Cost estimate updates

4. User clicks [Change and Reindex]
   -> PATCH /pipelines/:id/embedding-config { ..., confirm: true }
   -> On success: dialog closes, section updates
   -> On CONFIRMATION_REQUIRED: should not happen (confirm: true sent)
   -> On EMBEDDING_CREDENTIALS_UNAVAILABLE: show error inline

5. Reindexing starts
   -> Section shows progress bar
   -> KB status -> 'rebuilding'
```

---

## Edge Cases

| Case                                 | Behavior                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| No credentials for selected provider | Radio selectable, but confirm button disabled with tooltip  |
| Same config selected as current      | Confirm button disabled, "Already using this configuration" |
| Reindex in progress                  | [Change] button disabled, progress bar shown                |
| Pipeline in draft status             | [Change] works normally                                     |
| Custom endpoint with invalid URL     | Inline validation on URL field                              |
| Network error during change          | Error toast, dialog stays open                              |
