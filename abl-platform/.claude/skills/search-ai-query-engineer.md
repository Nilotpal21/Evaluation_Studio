---
name: search-ai-query-engineer
description: Use when working on SearchAI query pipeline, unified search endpoint, KB-as-tool integration, vocabulary resolution, query classification, HybridSearchBuilder, discovery API, alias resolution, canonical schema, agent-SearchAI integration, or any file in apps/search-ai-runtime/src/services/query/, apps/search-ai-runtime/src/services/hybrid-search/, apps/search-ai-runtime/src/services/vocabulary/, apps/search-ai-runtime/src/services/alias/, apps/search-ai-runtime/src/routes/query.ts, apps/search-ai-runtime/src/routes/discover.ts, apps/runtime/src/services/search-ai/, packages/search-ai-sdk/, or packages/search-ai-internal/src/canonical/. Also use when the user mentions query pipeline, vocabulary resolution, query classification, discovery API, KB tool, agent search integration, unified search, alias resolution, canonical schema, or connector templates.
---

# SearchAI Query Engineer

Expert guidance for the SearchAI query pipeline and agent integration layer.

> **Reference documents:** `docs/searchai/design/QUERY-PIPELINE-DESIGN.md` (narrative design), `docs/searchai/design/QUERY-PIPELINE-DIAGRAMS.md` (class/sequence diagrams)
> **When this skill is updated:** After any enhancement to the query pipeline, discovery API, KB tool executor, or agent integration, update the design documents and this skill to stay in sync.

## Unified Query Pipeline

All search goes through `POST /api/search/:indexId/query` with 7 conditional stages:

```
Stage 0: Permission Filter        (always first - security gate, fails closed)
Stage 1: Preprocessing            (conditional - skip for agent flow)
Stage 2: Vocab + Classification   (conditional - LLM or static fallback)
Stage 2.5: Alias Resolution       (always when filters exist)
Stage 3: Build + Execute Search   (HybridSearchBuilder → OpenSearch)
Stage 4: Rerank                   (optional - semantic/hybrid only)
Stage 5: Metrics & Cost           (always)
```

### Stage Conditions

| Stage                  | Runs When                               | Skips When                                            |
| ---------------------- | --------------------------------------- | ----------------------------------------------------- |
| Permission Filter      | Always                                  | Never (security)                                      |
| Preprocessing          | All direct flows                        | `skipPreprocessing=true` (agent flow)                 |
| Vocab + Classification | Direct flows without explicit queryType | `skipVocabularyResolution=true` or queryType provided |
| Alias Resolution       | Filters present (from vocab or agent)   | No filters to resolve                                 |
| Build + Execute        | Always                                  | Never                                                 |
| Rerank                 | `rerank=true` AND semantic/hybrid       | structured, aggregation, or rerank not set            |
| Metrics                | Always                                  | Never                                                 |

### Query Types

| Type          | OpenSearch Query                    | Embedding Needed | Description                                  |
| ------------- | ----------------------------------- | :--------------: | -------------------------------------------- |
| `structured`  | BM25 multi_match + metadata filters |        No        | Field-based filtering with text search       |
| `semantic`    | k-NN vector search                  |       Yes        | Pure concept/topic search                    |
| `hybrid`      | k-NN + metadata filters             |       Yes        | Combines filters and vector search (default) |
| `aggregation` | Terms aggregation + filters         |        No        | Group-by with count/sum/avg/min/max          |

### Key Files

| File                                                                            | Purpose                                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts`                   | Pipeline orchestrator with `execute()` and `executeUnified()` (7 stages)      |
| `apps/search-ai-runtime/src/services/alias/alias-resolver.ts`                   | Stage 2.5: alias→storage path resolution + enum coercion. LRU + Redis pub/sub |
| `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts`    | Builds OpenSearch DSL. `buildQuery()` or `buildQueryFromResolution()`         |
| `apps/search-ai-runtime/src/services/vocabulary/dynamic-vocabulary-resolver.ts` | LLM vocab resolution. Returns `classifiedQueryType` + resolutions             |
| `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts`         | Static fallback (exact/alias/fuzzy matching)                                  |
| `apps/search-ai-runtime/src/services/query/types.ts`                            | `UnifiedSearchQuery` and `UnifiedSearchResponse` interfaces                   |
| `apps/search-ai-runtime/src/routes/query.ts`                                    | Route handler - detects unified vs legacy, routes accordingly                 |
| `apps/search-ai-runtime/src/routes/discover.ts`                                 | Discovery API - returns capability manifest with alias names + enumMap        |
| `packages/search-ai-internal/src/canonical/connector-type-templates.ts`         | 8 connector category templates (Issue/Ticket, CRM, File, etc.)                |
| `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts`           | 75-field fixed canonical schema in OpenSearch                                 |
| `packages/database/src/models/canonical-schema.model.ts`                        | Alias layer model: `storageField`, `sortable`, `enumValues: Record`           |
| `apps/search-ai/src/services/canonical-mapping/canonical-field-info.service.ts` | Internal service: field mapping queries, slot allocation, alias lookups       |

## KB-as-Tool Integration

Each Knowledge Base auto-registers as a `searchai` tool type when created.

### End-to-End Flow

```
KB Created → registerSearchAITool() → project_tool record (type: searchai)
Agent DSL: type: searchai, index_id: "idx_123" → Compiler: SearchAIBindingIR
Session start → _wireExecutor() → SearchAIKBToolExecutor created
First tool call → discover(indexId) → manifest → buildToolDescription → enrich tool
Agent sees dynamic capabilities → calls tool → unifiedSearch() → results
```

### Key Files

| File                                                               | Purpose                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `apps/search-ai/src/services/searchai-tool-registration.ts`        | Auto-registers project_tool on KB creation                   |
| `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts` | Executor for searchai tools. Deferred discovery + SDK search |
| `apps/runtime/src/services/search-ai/description-builder.ts`       | Converts manifest to LLM-readable tool description           |
| `apps/runtime/src/services/execution/llm-wiring.ts`                | `_wireExecutor()` detects searchai tools, wires executor     |
| `packages/search-ai-sdk/src/client.ts`                             | `discover()` and `unifiedSearch()` methods                   |
| `packages/compiler/src/platform/ir/schema.ts`                      | `SearchAIBindingIR` + `tool_type: 'searchai'`                |

### Discovery API Contract

`GET /api/search/:indexId/discover` returns:

- `kb`: name, documentCount, lastUpdated
- `capabilities`: queryClassification, vocabulary, filters, aggregation, reranking, preprocessing
- Each capability has: `available`, `description`, `skipWhen`
- `_meta`: version, ttlSeconds (5min cache)

### Agent Decision Pattern

Agent reads discovery manifest in tool description and per query:

1. Checks vocabulary terms against user words → constructs filters
2. Classifies query type from context (or omits for auto-classify)
3. Rephrases query → sets `skipPreprocessing: true`
4. Calls tool with assembled params → pipeline executes → results

## Data Models

| Model            | Collection            | Key Lookup                                                        |
| ---------------- | --------------------- | ----------------------------------------------------------------- |
| SearchIndex      | `search_indexes`      | `{ _id: indexId, tenantId }`                                      |
| DomainVocabulary | `domain_vocabularies` | `{ projectKnowledgeBaseId: indexId, tenantId, status: 'active' }` |
| CanonicalSchema  | `canonical_schemas`   | `{ knowledgeBaseId: indexId, tenantId }`                          |
| ProjectTool      | `project_tools`       | `{ tenantId, projectId, name: 'search_kb_<slug>' }`               |

**Note:** `projectKnowledgeBaseId` and `knowledgeBaseId` both store `SearchIndex._id`.

## Common Patterns

### Adding a new pipeline stage

1. Add stage logic in `query-pipeline.ts` `executeUnified()` method
2. Add latency tracking field in `UnifiedSearchLatency` (types.ts)
3. Add conditional check (skip for agent flow if appropriate)
4. Update tests in `__tests__/query-pipeline.test.ts`
5. Update `docs/searchai/design/QUERY-PIPELINE-DESIGN.md`
6. Update this skill

### Adding a new capability to Discovery API

1. Add data source query in `routes/discover.ts`
2. Add capability section to response
3. Add rendering in `description-builder.ts`
4. Add test in `routes/__tests__/discover.test.ts`
5. Update the design document

### Adding a new query type

1. Add case in `HybridSearchBuilder.buildQuery()` and `buildQueryFromResolution()`
2. Add to `QueryType` union in `hybrid-search-builder.ts`
3. Add to `UnifiedQueryType` in `types.ts`
4. Add route validation in `query.ts`
5. Add tests

### Known Bugs (verified 2026-03-17)

| Bug                                      | File                                   | Severity | Detail                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug=true` is a NO-OP                  | `query-pipeline.ts` `executeUnified()` | HIGH     | Parameter accepted in request but never consumed. `vocabularyTrace` on response type is NEVER populated. `UnifiedSearchLatency` extended fields (`preprocessingMs`, `permissionFilterMs`, `classificationMs`, `queryBuildMs`, `searchExecutionMs`) exist in type but are NEVER set. |
| Double LLM call in vocabulary resolution | `query-pipeline.ts:970-988`            | MEDIUM   | `getResolutionsForBuilder()` re-calls vocabulary resolver for Stage 3 even though Stage 2 already resolved. TODO comment in code acknowledges this.                                                                                                                                 |
| No shared pipeline trace object          | `query-pipeline.ts`                    | LOW      | Each stage uses local variables. All intermediate data (preprocessing corrections, vocabulary resolutions, alias mappings, filter generation, original scores) is logged then discarded. Must be fixed for Resolution Chain feature.                                                |
| Original rerank score lost               | `query-pipeline.ts` Stage 4            | LOW      | Rerank replaces original score — no way to compare pre/post rerank.                                                                                                                                                                                                                 |

### Debugging query issues

- ⚠ **`debug: true` does NOT work** — it's accepted in the request but never consumed by `executeUnified()`. The `vocabularyTrace` field on the response is always empty. This must be fixed before Resolution Chain can ship.
- Check permission filter: valid token? user has access?
- Check BGE-M3 health: `curl http://bge-m3:8000/health`
- Check vocabulary exists: `db.domain_vocabularies.findOne({projectKnowledgeBaseId: indexId})`
- Check schema exists: `db.canonical_schemas.findOne({knowledgeBaseId: indexId})`

## Canonical Schema & Alias Layer

OpenSearch has a **75-field fixed canonical schema** — no dynamic fields. All pre-defined at index creation.

- 15 core + 25 common + 20 custom_string + 10 custom_number + 5 custom_date + 5 custom_bool + overflow
- `CanonicalSchema.fields[].name` = alias (business-friendly: `priority_level`)
- `CanonicalSchema.fields[].storageField` = actual storage field (`priority`, `custom_string_1`)
- `CanonicalSchema.fields[].enumValues` = `Record<string, unknown>` (display→stored: `{ "high": 0.8 }`)
- Unused common fields can be aliased for different purpose per KB
- Slots are reusable (deleted alias frees the slot)
- `AliasResolver` (Stage 2.5) resolves alias names to storage paths + enum coercion at query time
- `FieldMapping.canonicalField` stores storage field names (ingestion time), NOT alias names
- 8 ConnectorTypeSchema templates cover 65+ connectors — code constants in `connector-type-templates.ts`

**Design doc**: `docs/searchai/rfcs/canonical-mapping/04-CANONICAL-SCHEMA-ALIAS-DESIGN.md`

### Key Files

| File                                                                            | Purpose                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/database/src/models/canonical-schema.model.ts`                        | Alias layer model with `storageField`, `sortable`, `enumValues` |
| `apps/search-ai-runtime/src/services/alias/alias-resolver.ts`                   | Stage 2.5: resolves aliases to storage paths + enum coercion    |
| `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts`           | 75-field fixed OpenSearch mapping                               |
| `packages/search-ai-internal/src/canonical/connector-type-templates.ts`         | 8 connector category templates                                  |
| `apps/search-ai/src/services/canonical-mapping/canonical-field-info.service.ts` | Internal queries: mappings, slots, alias lookups                |
| `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts`  | LLM mapping with template injection + alias naming              |

## Studio UI: Fields Tab

The Studio KB detail page has a **"Fields"** tab (renamed from "Schema") with 3 sections:

1. **My Fields** — confirmed canonical fields as expandable rows. Shows alias name, type (Text/Number/Date/Boolean/List), capabilities (Filter/Sort/Group), enum values as chips. Expanded view shows per-connector sources with transform in human language.
2. **Suggested Mappings** — LLM suggestions grouped by connector. Shows source path, suggested alias, confidence, accept/reject.
3. **Unmapped Fields** — per-connector lazy-loaded list of connector fields without mappings.

**Add Field** dialog: name, label, type dropdown (user-friendly), description (AI context), capabilities checkboxes, key-value enum editor (display name → stored value). System auto-allocates OpenSearch slot.

Users never see OpenSearch internals (`custom_string_1`, `metadata.canonical.priority`). They see business names only.

### Key Files

| File                                                               | Purpose                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/studio/src/components/search-ai/FieldsTab.tsx`               | 3-section field management UI                               |
| `apps/studio/src/components/search-ai/KnowledgeBaseDetailPage.tsx` | Tab routing (fields tab)                                    |
| `apps/studio/src/api/search-ai.ts`                                 | `CanonicalField`, `FieldMappingData`, `getUnmappedFields()` |
| `apps/studio/src/hooks/useSearchAIMappings.ts`                     | SWR hook for field mappings                                 |
| `apps/search-ai/src/routes/schemas.ts`                             | Backend: GET schema, PATCH schema, GET unmapped fields      |
| `apps/search-ai/src/routes/mappings.ts`                            | Backend: list/confirm/reject mappings (enriched with alias) |

## Anti-Patterns

- Never call `vocabularyResolver.resolve()` twice for the same query (use `buildQueryFromResolution()`)
- Never strip resolved terms from the query - use full `originalQuery` for BM25 and embeddings
- Never skip permission filter (fails closed by design)
- Never use `SearchIndex._id` directly as `knowledgeBaseId` field name - the field names differ per model
- Never make LLM calls inside `_wireExecutor()` - it must be synchronous (use deferred pattern)
- Never expose OpenSearch field names (`custom_string_1`) to users or agents - always use alias names
- Never create dynamic OpenSearch fields at runtime - all 75 fields are pre-defined at index creation
- Never store alias names in `FieldMapping.canonicalField` - it stores storage field names only
- When renaming an alias, cascade-update DomainVocabulary entries that reference `fieldRef`
