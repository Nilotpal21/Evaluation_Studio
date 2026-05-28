# SearchAI Query Pipeline -- Diagrams

Companion to `QUERY-PIPELINE-DESIGN.md`. All diagrams are ASCII art for direct viewing.

---

## Table of Contents

- [1. Data Model Relationships](#1-data-model-relationships)
- [2. Service Architecture (Class Diagram)](#2-service-architecture-class-diagram)
- [3. Agent-Side Services (Class Diagram)](#3-agent-side-services-class-diagram)
- [4. Data Flow: Field Naming Layers](#4-data-flow-field-naming-layers)
- [5. Selection Funnel](#5-selection-funnel)
- [6. Sequence: Agent Wiring and Discovery](#6-sequence-agent-wiring-and-discovery)
- [7. Sequence: Direct User Query (Full Pipeline)](#7-sequence-direct-user-query-full-pipeline)
- [8. Sequence: Agent Query (Fast Path)](#8-sequence-agent-query-fast-path)
- [9. Sequence: Aggregation Query](#9-sequence-aggregation-query)
- [10. Sequence: Vocabulary Resolution -- LLM Path](#10-sequence-vocabulary-resolution----llm-path)
- [11. Sequence: Vocabulary Resolution -- Static Path](#11-sequence-vocabulary-resolution----static-path)
- [12. Sequence: Alias Resolution](#12-sequence-alias-resolution)
- [13. Stage Dependency Graph](#13-stage-dependency-graph)
- [14. Error Handling Flow](#14-error-handling-flow)
- [15. Cache Architecture](#15-cache-architecture)

---

## 1. Data Model Relationships

Shows how the three core MongoDB models connect to each other and to OpenSearch.

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                              MongoDB                                        │
 │                                                                             │
 │  ┌─────────────────────┐         ┌──────────────────────────────────────┐   │
 │  │     SearchIndex      │         │         DomainVocabulary             │   │
 │  ├─────────────────────┤         ├──────────────────────────────────────┤   │
 │  │ _id ────────────────┼────┬───>│ projectKnowledgeBaseId               │   │
 │  │ tenantId             │    │    │ tenantId                             │   │
 │  │ projectId            │    │    │ version                              │   │
 │  │ slug                 │    │    │ status                               │   │
 │  │ name                 │    │    │ entries[]:                           │   │
 │  │ status               │    │    │   ├─ term          ("priority")     │   │
 │  │ documentCount        │    │    │   ├─ aliases[]     ["urgency",...]  │   │
 │  └─────────────────────┘    │    │   ├─ fieldRef ─────────────────────┼───┐│
 │           │                  │    │   ├─ capabilities  {canFilter:T}   │   ││
 │           │ auto-registers   │    │   ├─ relatedFields                 │   ││
 │           ▼                  │    │   ├─ confidence    (0.95)          │   ││
 │  ┌─────────────────────┐    │    │   └─ generatedBy   ("auto")        │   ││
 │  │    ProjectTool       │    │    └──────────────────────────────────────┘   ││
 │  ├─────────────────────┤    │                                               ││
 │  │ tenantId             │    │    ┌──────────────────────────────────────┐   ││
 │  │ projectId            │    │    │         CanonicalSchema              │   ││
 │  │ name                 │    │    ├──────────────────────────────────────┤   ││
 │  │ toolType: "searchai" │    └───>│ knowledgeBaseId                      │   ││
 │  │ dslContent           │         │ tenantId                             │   ││
 │  └─────────────────────┘         │ version                              │   ││
 │                                   │ fields[]:    (~20 mapped, not 75)   │   ││
 │                                   │   ├─ name ◄─────────────────────────┼───┘│
 │                                   │   │         ("issue_priority")      │    │
 │                                   │   ├─ storageField ─────────────────┼──┐ │
 │                                   │   │         ("priority")            │  │ │
 │                                   │   ├─ type          ("string")      │  │ │
 │                                   │   ├─ filterable    (true)          │  │ │
 │                                   │   ├─ sortable      (true)          │  │ │
 │                                   │   ├─ enumValues    {high:2,...}    │  │ │
 │                                   │   └─ sourceConnectorField          │  │ │
 │                                   └──────────────────────────────────────┘  │ │
 └────────────────────────────────────────────────────────────────────────────┘ │
                                                                                │
 ┌─────────────────────────────────────────────────────────────────────────────┐│
 │                            OpenSearch                                        ││
 │                                                                              ││
 │  Index: kb_jira_engineering                                                  ││
 │  ┌────────────────────────────────────────────────────────────────────────┐  ││
 │  │ metadata.canonical.*   (75 pre-defined slots, dynamic: false)          │  ││
 │  │                                                                        │  ││
 │  │   .priority ◄─────────────────────────────────────────────────────────┼──┘│
 │  │   .assignee                                                            │   │
 │  │   .custom_string_1     (aliased as "status")                          │   │
 │  │   .custom_string_2     (unused)                                       │   │
 │  │   ...                                                                  │   │
 │  │   .custom_number_10    (unused)                                       │   │
 │  │                                                                        │   │
 │  │ embedding              (1024-dim dense vector, BGE-M3)                │   │
 │  │ content                (chunk text)                                    │   │
 │  │ permissions            (allowedUsers, allowedGroups, ...)             │   │
 │  └────────────────────────────────────────────────────────────────────────┘   │
 └──────────────────────────────────────────────────────────────────────────────┘

 Legend:
   ───>  foreign key reference
   ◄───  "points to" / "maps to"
```

---

## 2. Service Architecture (Class Diagram)

Services in `apps/search-ai-runtime/` and their dependencies.

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                        search-ai-runtime (port 3114)                         │
 │                                                                              │
 │  ┌──────────────────┐        ┌──────────────────────────────────────────┐   │
 │  │   Query Route     │───────>│             QueryPipeline                 │   │
 │  │ POST /query       │        ├──────────────────────────────────────────┤   │
 │  └──────────────────┘        │ + execute(query, options)                 │   │
 │                               │ + executeUnified(query, options)         │   │
 │  ┌──────────────────┐        │                                          │   │
 │  │  Discover Route   │        │ Dependencies:                            │   │
 │  │ GET /discover     │        │  ├─ PermissionFilterService              │   │
 │  └──────────────────┘        │  ├─ PreprocessingClient                  │   │
 │                               │  ├─ DynamicVocabularyResolver (optional) │   │
 │                               │  ├─ VocabularyResolver (fallback)       │   │
 │                               │  ├─ AliasResolver (optional)            │   │
 │                               │  ├─ HybridSearchBuilder                 │   │
 │                               │  ├─ BatchedRerankerFactory              │   │
 │                               │  └─ QueryMetrics                        │   │
 │                               └─────────────┬────────────────────────────┘   │
 │                                              │                               │
 │          ┌───────────────────────────────────┼──────────────────────┐        │
 │          │                │                  │           │          │        │
 │          ▼                ▼                  ▼           ▼          ▼        │
 │  ┌───────────────┐ ┌──────────────┐ ┌────────────┐ ┌────────┐ ┌────────┐  │
 │  │ Permission     │ │ Preprocessing│ │ Vocabulary  │ │ Alias  │ │ Hybrid │  │
 │  │ Filter Service │ │ Client       │ │ Resolution  │ │Resolver│ │ Search │  │
 │  ├───────────────┤ ├──────────────┤ │ (2 impls)   │ ├────────┤ │Builder │  │
 │  │ Neo4j query    │ │ HTTP to      │ ├─────────────┤ │ Schema │ ├────────┤  │
 │  │ Redis cache    │ │ Python:8003  │ │             │ │ lookup │ │ Build  │  │
 │  │ Auth mode      │ │ 100ms timeout│ │ ┌─────────┐ │ │ Enum   │ │ OS DSL │  │
 │  │ detection      │ │ Non-fatal    │ │ │Dynamic  │ │ │ coerce │ │ per    │  │
 │  └───────────────┘ └──────────────┘ │ │Vocabulary│ │ │ LRU    │ │ query  │  │
 │                                      │ │Resolver  │ │ │ cache  │ │ type   │  │
 │                                      │ ├─────────┤ │ │ Redis  │ └────┬───┘  │
 │  ┌──────────────────┐               │ │ LLM call │ │ │ pubsub │      │      │
 │  │  ServiceContainer │               │ │ JSON     │ │ └────────┘      │      │
 │  ├──────────────────┤               │ │ parse    │ │                  │      │
 │  │ Holds:            │               │ │ LRU      │ │                  ▼      │
 │  │  - DynamicVocab   │               │ │ cache    │ │          ┌────────────┐ │
 │  │    Resolver        │               │ └─────────┘ │          │ Vector     │ │
 │  │  - HybridSearch   │               │ ┌─────────┐ │          │ Store      │ │
 │  │    Builder         │               │ │Static   │ │          │ Provider   │ │
 │  │                    │               │ │Vocabulary│ │          ├────────────┤ │
 │  │ Created per-tenant │               │ │Resolver  │ │          │ executeQ() │ │
 │  │ on first query     │               │ ├─────────┤ │          │ search()   │ │
 │  └──────────────────┘               │ │ 3-pass   │ │          │ OpenSearch │ │
 │                                      │ │ cascade  │ │          │ client     │ │
 │  ┌──────────────────┐               │ │ exact →  │ │          └────────────┘ │
 │  │  BatchedReranker  │               │ │ alias →  │ │                         │
 │  │  Factory           │               │ │ fuzzy    │ │                         │
 │  ├──────────────────┤               │ └─────────┘ │                         │
 │  │ Provider cascade: │               └─────────────┘                         │
 │  │  1. Voyage AI     │                                                       │
 │  │  2. Cohere        │        ┌─────────────────────────────────────────┐    │
 │  │  3. Jina AI       │        │          EmbeddingProvider               │    │
 │  │ Batching: 50ms    │        ├─────────────────────────────────────────┤    │
 │  │ Circuit breaker   │        │ embed(text) -> vector[1024]             │    │
 │  │ per tenant        │        │ Provider: BGE-M3 (port 8000)            │    │
 │  └──────────────────┘        └─────────────────────────────────────────┘    │
 └──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Agent-Side Services (Class Diagram)

Services in `apps/runtime/` that wire SearchAI tools into agent sessions.

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                          runtime (port 3112)                                 │
 │                                                                             │
 │  ┌─────────────────────────────────────────────────────────────────────┐   │
 │  │                        LLM Wiring                                    │   │
 │  │                  (llm-wiring.ts)                                     │   │
 │  ├─────────────────────────────────────────────────────────────────────┤   │
 │  │ _wireExecutor(session, compiledTools):                               │   │
 │  │   1. Filter tools where tool_type === 'searchai'                     │   │
 │  │   2. Create SearchAIKBToolExecutor                                   │   │
 │  │   3. Register each KB binding (indexId, tenantId)                    │   │
 │  │   4. Register description-update callback on session                 │   │
 │  └──────────────────────────────┬──────────────────────────────────────┘   │
 │                                  │ creates                                  │
 │                                  ▼                                          │
 │  ┌─────────────────────────────────────────────────────────────────────┐   │
 │  │                  SearchAIKBToolExecutor                               │   │
 │  │            (searchai-kb-tool-executor.ts)                            │   │
 │  ├─────────────────────────────────────────────────────────────────────┤   │
 │  │ - bindings: Map<toolName, {indexId, tenantId}>                       │   │
 │  │ - discoveryCache: Map<indexId, manifest>                             │   │
 │  │ - client: SearchAIClient                                             │   │
 │  ├─────────────────────────────────────────────────────────────────────┤   │
 │  │ + registerBinding(toolName, config)                                   │   │
 │  │ + execute(toolName, params):                                         │   │
 │  │     1. ensureDiscovery(indexId) -- first call only                   │   │
 │  │     2. client.unifiedSearch(indexId, params)                         │   │
 │  │     3. Format results for LLM consumption                           │   │
 │  │ - ensureDiscovery(indexId):                                          │   │
 │  │     1. client.discover(indexId)                                      │   │
 │  │     2. buildToolDescription(manifest)                                │   │
 │  │     3. Fire callback -> update session tool description              │   │
 │  └──────────────────────┬────────────────────┬─────────────────────────┘   │
 │                          │ uses               │ uses                        │
 │                          ▼                    ▼                             │
 │  ┌───────────────────────────┐  ┌──────────────────────────────────────┐  │
 │  │     SearchAIClient         │  │       DescriptionBuilder             │  │
 │  │  (search-ai-sdk)           │  │    (description-builder.ts)          │  │
 │  ├───────────────────────────┤  ├──────────────────────────────────────┤  │
 │  │ + discover(indexId)        │  │ + buildToolDescription(manifest):    │  │
 │  │   -> GET /discover         │  │     Manifest JSON                    │  │
 │  │ + unifiedSearch(id, body)  │  │       -> LLM-readable prose          │  │
 │  │   -> POST /query           │  │                                      │  │
 │  │ + vectorSearch(id, body)   │  │   Budgets:                           │  │
 │  │   -> POST /vector-search   │  │     50 vocabulary terms max          │  │
 │  └───────────────────────────┘  │     30 filter fields max              │  │
 │                                  │                                      │  │
 │                                  │   Renders:                           │  │
 │                                  │     QUERY CLASSIFICATION section     │  │
 │                                  │     VOCABULARY section               │  │
 │                                  │     FILTERS section                  │  │
 │                                  │     AGGREGATION section              │  │
 │                                  │     RERANKING section                │  │
 │                                  │     PREPROCESSING section            │  │
 │                                  └──────────────────────────────────────┘  │
 │                                                                             │
 │  ┌─────────────────────────────────────────────────────────────────────┐   │
 │  │  Also involved but not SearchAI-specific:                            │   │
 │  │                                                                      │   │
 │  │  SearchAIAwareToolExecutor  -- wraps ToolBindingExecutor, intercepts │   │
 │  │                                search tool calls                     │   │
 │  │  SearchAIToolHandler        -- routes search_vector, search_text,    │   │
 │  │                                search_structured to SDK calls        │   │
 │  └─────────────────────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Flow: Field Naming Layers

Three naming layers and which system component uses each.

```
                  Source System                   MongoDB                    OpenSearch
                  (Jira, Salesforce)              (CanonicalSchema)          (Index)
                  ─────────────────               ─────────────────          ──────────

 Layer 1:         "fields.priority.name"
 Source Field      ─────────┬─────────
                            │
                   FieldMapping.sourcePath
                   transform: value_map
                            │
                            ▼
 Layer 2:                              "issue_priority"
 Alias Name                             ─────┬─────
                                              │
                               Used by:       │       Points to:
                               - Agents       │       - Vocabulary (fieldRef)
                               - Vocabulary   │       - Discovery manifest
                               - UI           │       - API callers
                               - Filters in   │
                                 API requests  │
                                              │
                              AliasResolver    │
                              (Stage 2.5)      │
                              translates       │
                                              │
                                              ▼
 Layer 3:                                                "metadata.canonical.priority"
 OpenSearch Path                                          ─────────┬──────────────
                                                                   │
                                                        Used by:   │
                                                        - OS DSL   │
                                                        - k-NN     │
                                                        - BM25     │
                                                        - Aggs     │
                                                                   │
                                                                   ▼
                                                          OpenSearch stores
                                                          and queries this


 Enum Value Coercion (happens at BOTH layers):

   Ingestion (Layer 1 -> 3):     "High"  ──value_map──>  2        (CanonicalMapperService)
   Query     (Layer 2 -> 3):     "high"  ──enumValues──> 2        (AliasResolver)
```

---

## 5. Selection Funnel

How 75 OpenSearch slots narrow to what the agent sees.

```
     ┌─────────────────────────────────────────────────────────────────────┐
     │                    OpenSearch Index: 75 slots                        │
     │                                                                     │
     │  15 core  +  25 common  +  20 custom_str  +  10 custom_num  + 5    │
     │                                                                     │
     │  Most are empty (null) for any given KB                             │
     └────────────────────────────────┬────────────────────────────────────┘
                                      │
                         User maps fields in Fields Tab
                      (MappingSuggestionService proposes,
                            user confirms/edits)
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────┐
     │                  CanonicalSchema: ~20 fields                        │
     │                                                                     │
     │  Only confirmed mappings stored in MongoDB                          │
     │  Each has: alias name, storage field, type, enumValues, capabilities│
     └────────────────────────────────┬────────────────────────────────────┘
                                      │
                      CriticalFieldDetectionService
                   picks 10-15 most important for search
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────┐
     │                  DomainVocabulary: ~12 entries                       │
     │                                                                     │
     │  Business terms + aliases + capabilities                            │
     │  LLM-generated or manually curated                                 │
     └────────────────────────────────┬────────────────────────────────────┘
                                      │
                         Discovery API budgets for
                           LLM context limits
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────┐
     │                Agent Manifest: context-limited                       │
     │                                                                     │
     │  Top 50 vocab terms  +  Top 30 filter fields                       │
     │  (in practice: all ~12 terms, all ~20 fields fit easily)           │
     └─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Sequence: Agent Wiring and Discovery

From session start to enriched tool description.

```
 Agent DSL       Compiler       LLM Wiring      KB Tool          SearchAI       SearchAI       Description
 (source)                       (llm-wiring)    Executor         Client         Runtime        Builder
    │                │               │               │               │              │              │
    │  TOOLS:        │               │               │               │              │              │
    │  search_bugs   │               │               │               │              │              │
    │  type:searchai │               │               │               │              │              │
    │  index_id:kb1  │               │               │               │              │              │
    │────compile────>│               │               │               │              │              │
    │                │               │               │               │              │              │
    │                │ SearchAIBindingIR              │               │              │              │
    │                │ {indexId,tenantId}             │               │              │              │
    │                │──────────────>│               │               │              │              │
    │                │               │               │               │              │              │
    │                │               │  create       │               │              │              │
    │                │               │──────────────>│               │              │              │
    │                │               │               │               │              │              │
    │                │               │  registerBinding("search_bugs", {indexId})   │              │
    │                │               │──────────────>│               │              │              │
    │                │               │               │               │              │              │
    │                │               │  register description-update callback        │              │
    │                │               │──────────────>│               │              │              │
    │                │               │               │               │              │              │
    │        SESSION READY -- tool has placeholder description                      │              │
    │        "Search the Jira Engineering Issues knowledge base"                    │              │
    │                │               │               │               │              │              │
    ·                ·               ·               ·               ·              ·              ·
    · (time passes, user sends first message)        ·               ·              ·              ·
    ·                ·               ·               ·               ·              ·              ·
    │                │               │               │               │              │              │
 Agent LLM decides to call search_bugs(query="...")  │               │              │              │
    │                │               │               │               │              │              │
    │────────────────────────────────────────────────>│               │              │              │
    │                │               │               │               │              │              │
    │                │               │               │ ensureDiscovery()            │              │
    │                │               │               │──────────────>│              │              │
    │                │               │               │               │ GET /discover│              │
    │                │               │               │               │─────────────>│              │
    │                │               │               │               │              │              │
    │                │               │               │               │   manifest   │              │
    │                │               │               │               │<─────────────│              │
    │                │               │               │<──────────────│              │              │
    │                │               │               │               │              │              │
    │                │               │               │  buildToolDescription(manifest)             │
    │                │               │               │────────────────────────────────────────────>│
    │                │               │               │                              │              │
    │                │               │               │              LLM-readable prose             │
    │                │               │               │<────────────────────────────────────────────│
    │                │               │               │               │              │              │
    │                │               │               │  fire callback: update session tool desc    │
    │                │               │               │──────>│       │              │              │
    │                │               │               │  (session._effectiveConfig.tools updated)   │
    │                │               │               │       │       │              │              │
    │                │               │               │ unifiedSearch()│              │              │
    │                │               │               │──────────────>│              │              │
    │                │               │               │               │ POST /query  │              │
    │                │               │               │               │─────────────>│              │
    │                │               │               │               │   results    │              │
    │                │               │               │               │<─────────────│              │
    │                │               │               │<──────────────│              │              │
    │   results      │               │               │               │              │              │
    │<───────────────────────────────────────────────│               │              │              │
    │                │               │               │               │              │              │
    │  NEXT TURN: Agent now sees enriched description with vocabulary,              │              │
    │  filters, classification guidance                              │              │              │
```

---

## 7. Sequence: Direct User Query (Full Pipeline)

User types: `"show me hgih priortiy bugs assigned to Alice"`
All 7 stages execute.

```
 Client          Query       Permission    Preprocessing   Vocabulary      Alias         Hybrid Search    Embedding   Reranker    Metrics
 (browser)       Pipeline    FilterSvc     Client          Resolver(LLM)   Resolver      Builder          Provider
    │               │            │              │               │              │              │              │            │          │
    │ POST /query   │            │              │               │              │              │              │            │          │
    │──────────────>│            │              │               │              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 0: Permission Filter (4ms) ─────────────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ getFilter()│              │               │              │              │              │            │          │
    │               │───────────>│              │               │              │              │              │            │          │
    │               │            │ query Neo4j  │               │              │              │              │            │          │
    │               │            │ build bool   │               │              │              │              │            │          │
    │               │  filter    │ filter       │               │              │              │              │            │          │
    │               │<───────────│              │               │              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 1: Preprocessing (38ms) ────────────────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ preprocess("hgih priortiy bugs...")       │              │              │              │            │          │
    │               │─────────────────────────>│               │              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ corrected: "high priority bugs assigned to Alice"       │              │              │            │          │
    │               │<─────────────────────────│               │              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 2: Vocabulary Resolution - LLM (62ms) ──────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ resolve("high priority bugs assigned to Alice")         │              │              │            │          │
    │               │──────────────────────────────────────────>│              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │            │              │               │ load vocab   │              │              │            │          │
    │               │            │              │               │ load schema  │              │              │            │          │
    │               │            │              │               │ build prompt │              │              │            │          │
    │               │            │              │               │ LLM call     │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ { resolutions: [{issue_priority,"high"}, {assignee_email,"alice@..."}] │              │            │          │
    │               │   classifiedQueryType: "hybrid"                         │              │              │            │          │
    │               │   unresolvedSegments: ["bugs"] }                        │              │              │            │          │
    │               │<──────────────────────────────────────────│              │              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 2.5: Alias Resolution (3ms) ────────────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ resolve([{field:"issue_priority", value:"high"}, ...])  │              │              │            │          │
    │               │────────────────────────────────────────────────────────>│              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │            │              │               │              │ load schema  │              │            │          │
    │               │            │              │               │              │ (cache hit)  │              │            │          │
    │               │            │              │               │              │ issue_priority -> priority  │            │          │
    │               │            │              │               │              │ "high" -> 2 (enum coerce)  │            │          │
    │               │            │              │               │              │ assignee_email -> assignee  │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ [{field:"metadata.canonical.priority", value:2},        │              │              │            │          │
    │               │  {field:"metadata.canonical.assignee", value:"alice@..."}]             │              │            │          │
    │               │<────────────────────────────────────────────────────────│              │              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 3: Build + Execute Search (112ms) ──────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ buildQueryFromResolution(vocabResult, "hybrid")         │              │              │            │          │
    │               │───────────────────────────────────────────────────────────────────────>│              │            │          │
    │               │            │              │               │              │              │ build DSL    │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ embed("bugs")            │               │              │              │              │            │          │
    │               │──────────────────────────────────────────────────────────────────────────────────────>│            │          │
    │               │            │              │               │              │              │              │ BGE-M3     │          │
    │               │ vector[1024]             │               │              │              │              │ (22ms)     │          │
    │               │<──────────────────────────────────────────────────────────────────────────────────────│            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ inject permission filter + metadata filters into DSL   │              │              │            │          │
    │               │ executeQuery(indexId, dslBody)            │              │              │              │            │          │
    │               │───────────────────────────────────────────────────────────────────────>│  OpenSearch  │            │          │
    │               │            │              │               │              │              │  (90ms)      │            │          │
    │               │ 23 hits    │              │               │              │              │              │            │          │
    │               │<───────────────────────────────────────────────────────────────────────│              │            │          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 4: Reranking (165ms) ───────────────────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ rerank(23 chunks, "bugs")│               │              │              │              │            │          │
    │               │──────────────────────────────────────────────────────────────────────────────────────────────────>│          │
    │               │            │              │               │              │              │              │  Voyage AI │          │
    │               │ reordered results        │               │              │              │              │            │          │
    │               │<──────────────────────────────────────────────────────────────────────────────────────────────────│          │
    │               │            │              │               │              │              │              │            │          │
    │               │ ── STAGE 5: Metrics (4ms) ───────────────────────────────────────────────────────────────────────────────── │
    │               │            │              │               │              │              │              │            │          │
    │               │ record latency, cost     │               │              │              │              │            │   record │
    │               │──────────────────────────────────────────────────────────────────────────────────────────────────────────── >│
    │               │            │              │               │              │              │              │            │          │
    │  JSON response│            │              │               │              │              │              │            │          │
    │  (383ms total)│            │              │               │              │              │              │            │          │
    │<──────────────│            │              │               │              │              │              │            │          │
```

---

## 8. Sequence: Agent Query (Fast Path)

Agent sends pre-resolved filters. Stages 1 and 2 are skipped.

```
 Agent          KB Tool        Query          Permission     Alias         Hybrid Search   Embedding    Metrics
 LLM            Executor       Pipeline       FilterSvc      Resolver      Builder         Provider
  │                │               │              │              │              │              │            │
  │ search_bugs(   │               │              │              │              │              │            │
  │   query: "auth errors",        │              │              │              │              │            │
  │   queryType: "hybrid",         │              │              │              │              │            │
  │   filters: [   │               │              │              │              │              │            │
  │     {field:"issue_priority",   │              │              │              │              │            │
  │      value:"critical"}],       │              │              │              │              │            │
  │   skipPreprocessing: true,     │              │              │              │              │            │
  │   skipVocabResolution: true,   │              │              │              │              │            │
  │   rerank: true)│               │              │              │              │              │            │
  │───────────────>│               │              │              │              │              │            │
  │                │               │              │              │              │              │            │
  │                │ POST /query   │              │              │              │              │            │
  │                │──────────────>│              │              │              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 0 (3ms)│              │              │              │            │
  │                │               │─────────────>│              │              │              │            │
  │                │               │  perm filter │              │              │              │            │
  │                │               │<─────────────│              │              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 1: ─── SKIPPED (skipPreprocessing: true) ───────────────────── │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 2: ─── SKIPPED (skipVocabularyResolution: true) ────────────── │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 2.5 (2ms)             │              │              │            │
  │                │               │ resolve([{issue_priority, "critical"}])    │              │            │
  │                │               │────────────────────────────>│              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │              │              │ issue_priority -> priority  │            │
  │                │               │              │              │ "critical" -> 1 (enum)     │            │
  │                │               │              │              │              │              │            │
  │                │               │ [{metadata.canonical.priority, 1}]        │              │            │
  │                │               │<────────────────────────────│              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 3 (88ms)              │              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │ embed("auth errors")        │              │              │            │
  │                │               │──────────────────────────────────────────────────────────>│            │
  │                │               │ vector[1024] │              │              │              │            │
  │                │               │<──────────────────────────────────────────────────────────│            │
  │                │               │              │              │              │              │            │
  │                │               │ buildQuery + inject filters │              │              │            │
  │                │               │─────────────────────────────────────────>│              │            │
  │                │               │              │              │              │ OpenSearch   │            │
  │                │               │ hits         │              │              │              │            │
  │                │               │<─────────────────────────────────────────│              │            │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 4: Reranking (145ms)  │              │              │            │
  │                │               │              │              │              │              │            │
  │                │               │ STAGE 5 (2ms)│              │              │              │            │
  │                │               │──────────────────────────────────────────────────────────────────────>│
  │                │               │              │              │              │              │            │
  │                │  results      │              │              │              │              │            │
  │                │<──────────────│              │              │              │              │            │
  │  results       │   (240ms)     │              │              │              │              │            │
  │<───────────────│               │              │              │              │              │            │
  │                │               │              │              │              │              │            │
  │ (37% faster than direct user -- skipped preprocessing + vocabulary resolution)           │            │
```

---

## 9. Sequence: Aggregation Query

User asks: `"how many tickets per status?"`

```
 Client      Query         Permission    Preprocessing    Vocabulary       Alias          Hybrid Search    Metrics
             Pipeline      FilterSvc     Client           Resolver(LLM)    Resolver       Builder
  │             │              │              │                │               │               │              │
  │ POST /query │              │              │                │               │               │              │
  │ {query:"how many tickets per status?"}   │                │               │               │              │
  │────────────>│              │              │                │               │               │              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 0      │              │                │               │               │              │
  │             │─────────────>│              │                │               │               │              │
  │             │ perm filter  │              │                │               │               │              │
  │             │<─────────────│              │                │               │               │              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 1 (35ms)              │                │               │               │              │
  │             │─────────────────────────── >│                │               │               │              │
  │             │ no corrections needed       │                │               │               │              │
  │             │<───────────────────────────│                │               │               │              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 2 (55ms)              │                │               │               │              │
  │             │────────────────────────────────────────────>│               │               │              │
  │             │              │              │                │               │               │              │
  │             │              │              │                │ LLM returns:  │               │              │
  │             │              │              │                │ resolvedAs:   │               │              │
  │             │              │              │                │  "aggregate"  │               │              │
  │             │              │              │                │ field:"status"│               │              │
  │             │              │              │                │ classifiedQT: │               │              │
  │             │              │              │                │ "aggregation" │               │              │
  │             │              │              │                │               │               │              │
  │             │ {resolutions, queryType:"aggregation"}      │               │               │              │
  │             │<────────────────────────────────────────────│               │               │              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 2.5 (2ms)             │                │               │               │              │
  │             │ resolve agg field "status"  │                │               │               │              │
  │             │────────────────────────────────────────────────────────────>│               │              │
  │             │              │              │                │               │               │              │
  │             │ "status" -> "metadata.canonical.custom_string_1"            │               │              │
  │             │<────────────────────────────────────────────────────────────│               │              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 3 (45ms)              │                │               │               │              │
  │             │              │              │                │               │               │              │
  │             │ buildQuery: queryType = "aggregation"        │               │               │              │
  │             │ DSL: { aggs: { by_status: { terms: ... } }, size: 0 }       │               │              │
  │             │──────────────────────────────────────────────────────────────────────────── >│              │
  │             │              │              │                │               │               │ OpenSearch   │
  │             │ { open:456, in_progress:233, closed:1089, on_hold:45 }      │               │              │
  │             │<────────────────────────────────────────────────────────────────────────────│              │
  │             │              │              │                │               │               │              │
  │             │ STAGE 4: ── SKIPPED (aggregation queries don't rerank) ────────────────────────────────── │
  │             │              │              │                │               │               │              │
  │             │ STAGE 5      │              │                │               │               │              │
  │             │──────────────────────────────────────────────────────────────────────────────────────────>│
  │             │              │              │                │               │               │              │
  │ { aggregations: [{key:"open",count:456}, ...], totalCount:1823 }          │               │              │
  │<────────────│              │              │                │               │               │              │
  │  (141ms)    │              │              │                │               │               │              │
  │             │              │   No embedding generated (aggregation = no vectors)          │              │
```

---

## 10. Sequence: Vocabulary Resolution -- LLM Path

Detailed view of what happens inside Stage 2 with DynamicVocabularyResolver.

```
 QueryPipeline        DynamicVocabulary       LRU Cache        LRU Cache       LLM             JSON
                      Resolver                (Vocabulary)     (Schema)        (Anthropic)     Parser
     │                     │                      │                │               │              │
     │ resolve(query,      │                      │                │               │              │
     │  indexId, tenantId) │                      │                │               │              │
     │────────────────────>│                      │                │               │              │
     │                     │                      │                │               │              │
     │                     │ get(tenant:kb)        │                │               │              │
     │                     │─────────────────────>│                │               │              │
     │                     │                      │                │               │              │
     │                     │  DomainVocabulary     │                │               │              │
     │                     │  (cache hit or        │                │               │              │
     │                     │   MongoDB fetch)      │                │               │              │
     │                     │<─────────────────────│                │               │              │
     │                     │                      │                │               │              │
     │                     │ get(tenant:kb)        │                │               │              │
     │                     │──────────────────────────────────────>│               │              │
     │                     │                      │                │               │              │
     │                     │  CanonicalSchema      │                │               │              │
     │                     │<──────────────────────────────────────│               │              │
     │                     │                      │                │               │              │
     │                     │ Build LLM prompt:     │                │               │              │
     │                     │  - SCHEMA FIELDS      │                │               │              │
     │                     │  - VOCABULARY TERMS   │                │               │              │
     │                     │  - RESOLUTION RULES   │                │               │              │
     │                     │  - CLASSIFICATION     │                │               │              │
     │                     │  + user query         │                │               │              │
     │                     │                      │                │               │              │
     │                     │ prompt + query        │                │               │              │
     │                     │─────────────────────────────────────────────────────>│              │
     │                     │                      │                │               │              │
     │                     │                      │                │               │ LLM thinks:  │
     │                     │                      │                │               │ "high priority│
     │                     │                      │                │               │  = filter on  │
     │                     │                      │                │               │  issue_priority│
     │                     │                      │                │               │  Alice = filter│
     │                     │                      │                │               │  on assignee  │
     │                     │                      │                │               │  bugs = concept│
     │                     │                      │                │               │  -> hybrid"   │
     │                     │                      │                │               │              │
     │                     │ JSON response (possibly in markdown code block)       │              │
     │                     │<─────────────────────────────────────────────────────│              │
     │                     │                      │                │               │              │
     │                     │ extractJSON(response) │                │               │              │
     │                     │──────────────────────────────────────────────────────────────────>│
     │                     │                      │                │               │              │
     │                     │ { resolutions: [...], classifiedQueryType: "hybrid" } │              │
     │                     │<──────────────────────────────────────────────────────────────────│
     │                     │                      │                │               │              │
     │                     │ Validate each resolution against vocabulary           │              │
     │                     │ Convert "filter" resolutions to MetadataFilter[]      │              │
     │                     │ Extract unresolved segments                           │              │
     │                     │                      │                │               │              │
     │  {                  │                      │                │               │              │
     │   filters: [...],   │                      │                │               │              │
     │   queryType:"hybrid"│                      │                │               │              │
     │   unresolvedSegments│                      │                │               │              │
     │  }                  │                      │                │               │              │
     │<────────────────────│                      │                │               │              │
```

---

## 11. Sequence: Vocabulary Resolution -- Static Path

Detailed view of Stage 2 with VocabularyResolver (no LLM, 3-pass cascade).

```
 QueryPipeline        VocabularyResolver      LRU Cache         MongoDB
                      (static)                (Vocabulary)
     │                     │                      │                │
     │ resolve(query,      │                      │                │
     │  indexId, tenantId) │                      │                │
     │────────────────────>│                      │                │
     │                     │                      │                │
     │                     │ get(tenant:kb)        │                │
     │                     │─────────────────────>│                │
     │                     │                      │ (miss)         │
     │                     │                      │───────────────>│
     │                     │                      │  vocabulary    │
     │                     │                      │<───────────────│
     │                     │  DomainVocabulary     │                │
     │                     │<─────────────────────│                │
     │                     │                      │                │
     │                     │                      │                │
     │                     │  PASS 1: EXACT MATCH (confidence 1.0) │
     │                     │  ┌──────────────────────────────────┐ │
     │                     │  │ For each entry:                   │ │
     │                     │  │  "priority" in query? YES → match │ │
     │                     │  │  "assignee" in query? NO          │ │
     │                     │  │  "status"   in query? NO          │ │
     │                     │  └──────────────────────────────────┘ │
     │                     │                      │                │
     │                     │  PASS 2: ALIAS MATCH (confidence 0.9) │
     │                     │  ┌──────────────────────────────────┐ │
     │                     │  │ For unmatched entries:            │ │
     │                     │  │  "assigned to" in query? YES     │ │
     │                     │  │  "state" in query? NO            │ │
     │                     │  └──────────────────────────────────┘ │
     │                     │                      │                │
     │                     │  PASS 3: FUZZY MATCH (confidence 0.6) │
     │                     │  ┌──────────────────────────────────┐ │
     │                     │  │ For still-unmatched entries:      │ │
     │                     │  │  words of "status" (len>=4)      │ │
     │                     │  │  "status" in query? NO           │ │
     │                     │  │  (no fuzzy matches)              │ │
     │                     │  └──────────────────────────────────┘ │
     │                     │                      │                │
     │                     │  Build filters from matches:          │
     │                     │  ┌──────────────────────────────────┐ │
     │                     │  │ "priority" canFilter:true         │ │
     │                     │  │  → {field:"issue_priority",      │ │
     │                     │  │     operator:"eq",               │ │
     │                     │  │     value:"priority"}            │ │
     │                     │  │                                   │ │
     │                     │  │ "assigned to" canFilter:true     │ │
     │                     │  │  → {field:"assignee_email",      │ │
     │                     │  │     operator:"eq",               │ │
     │                     │  │     value:"assigned to"}         │ │
     │                     │  └──────────────────────────────────┘ │
     │                     │                      │                │
     │                     │  Extract unresolved:  │                │
     │                     │  "show me high priority bugs assigned to alice"
     │                     │   remove "priority"   │                │
     │                     │   remove "assigned to"│                │
     │                     │   → ["show","me","high","bugs","alice"]│
     │                     │                      │                │
     │  {                  │                      │                │
     │   resolvedTerms:[   │                      │                │
     │    {exact,"priority",1.0},                 │                │
     │    {alias,"assigned to",0.9}               │                │
     │   ],                │                      │                │
     │   filters: [...],   │                      │                │
     │   queryType: null   │  ◄── cannot classify without LLM    │
     │  }                  │                      │                │
     │<────────────────────│                      │                │
```

---

## 12. Sequence: Alias Resolution

Detailed view of Stage 2.5 -- translating alias names to OpenSearch paths.

```
 QueryPipeline        AliasResolver           LRU Cache         MongoDB        Redis PubSub
                                               (Schema)
     │                     │                      │                │               │
     │ resolve(filters,    │                      │                │               │
     │  indexId, tenantId) │                      │                │               │
     │────────────────────>│                      │                │               │
     │                     │                      │                │               │
     │                     │ get(tenant:kb)        │                │               │
     │                     │─────────────────────>│                │               │
     │                     │                      │                │               │
     │                     │  CanonicalSchema      │                │               │
     │                     │  (cache hit, 5min TTL)│                │               │
     │                     │<─────────────────────│                │               │
     │                     │                      │                │               │
     │                     │ Build lookup map:     │                │               │
     │                     │ { "issue_priority" → {name, storageField:"priority",   │
     │                     │                        enumValues:{high:2,...}},       │
     │                     │   "assignee_email" → {name, storageField:"assignee"}, │
     │                     │   "status"         → {name, storageField:"custom_string_1",
     │                     │                        enumValues:{open:"open",...}} } │
     │                     │                      │                │               │
     │                     │                      │                │               │
     │                     │  For each filter:     │                │               │
     │                     │  ┌────────────────────────────────────────────────┐   │
     │                     │  │ Filter 1: {field:"issue_priority", value:"high"}   │
     │                     │  │                                                │   │
     │                     │  │ 1. lookup["issue_priority"] → FOUND            │   │
     │                     │  │ 2. storageField = "priority"                   │   │
     │                     │  │    → "metadata.canonical.priority"             │   │
     │                     │  │ 3. enumValues["high"] → 2                      │   │
     │                     │  │ 4. Output: {field:"metadata.canonical.priority",   │
     │                     │  │             value: 2}                          │   │
     │                     │  └────────────────────────────────────────────────┘   │
     │                     │  ┌────────────────────────────────────────────────┐   │
     │                     │  │ Filter 2: {field:"assignee_email",             │   │
     │                     │  │            value:"alice@acme.com"}             │   │
     │                     │  │                                                │   │
     │                     │  │ 1. lookup["assignee_email"] → FOUND            │   │
     │                     │  │ 2. storageField = "assignee"                   │   │
     │                     │  │    → "metadata.canonical.assignee"             │   │
     │                     │  │ 3. No enumValues → value unchanged             │   │
     │                     │  │ 4. Output: {field:"metadata.canonical.assignee",   │
     │                     │  │             value: "alice@acme.com"}           │   │
     │                     │  └────────────────────────────────────────────────┘   │
     │                     │                      │                │               │
     │ resolved filters    │                      │                │               │
     │<────────────────────│                      │                │               │
     │                     │                      │                │               │
     │                     │                      │                │               │
     ·  ── Cache Invalidation (separate flow) ──  ·                │               │
     ·                     ·                      ·                ·               ·
     │                     │                      │                │               │
     │                     │  (Schema updated in admin API)        │               │
     │                     │                      │                │  PUBLISH       │
     │                     │                      │                │  "alias-resolver│
     │                     │                      │                │   :invalidate" │
     │                     │                      │                │──────────────>│
     │                     │                      │                │               │
     │                     │  on message: evict cache entry        │               │
     │                     │<──────────────────────────────────────────────────────│
     │                     │  cache.delete(tenant:kb)              │               │
     │                     │─────────────────────>│                │               │
     │                     │                      │ (evicted)      │               │
     │                     │                      │                │               │
     │                     │  Next resolve() will fetch fresh from MongoDB         │
```

---

## 13. Stage Dependency Graph

Which stages feed into which, and what data flows between them.

```
                                   ┌─────────────────────┐
                                   │   Incoming Request    │
                                   │ {query, queryType?,   │
                                   │  filters?, rerank?,   │
                                   │  skipPreprocessing?,  │
                                   │  skipVocabResolution?}│
                                   └──────────┬──────────┘
                                              │
                                              ▼
                                ┌──────────────────────────┐
                                │   Stage 0: Permissions    │
                                │                          │
                                │  Input:  auth token       │
                                │  Output: permissionFilter │
                                │                          │
                                │  FATAL on failure        │
                                └──────────┬───────────────┘
                                           │ permissionFilter
                         ┌─────────────────┤
                         │                 │
              (if !skip) │      (if skip)  │
                         ▼                 │
              ┌───────────────────┐        │
              │ Stage 1: Preproc  │        │
              │                   │        │
              │ Input: raw query  │        │
              │ Output: corrected │        │
              │         query     │        │
              │                   │        │
              │ NON-FATAL         │        │
              └────────┬──────────┘        │
                       │ correctedQuery    │
                       ▼                   │
              ┌───────────────────┐        │
              │ Stage 2: Vocab    │        │
              │ Resolution        │        │
              │                   │        │
              │ Input: query      │        │
              │ Output:           │        │
              │  - filters[]      │        │
              │  - queryType      │        │
              │  - unresolved     │        │
              │    Segments       │        │
              │                   │        │
              │ NON-FATAL         │        │
              └────────┬──────────┘        │
                       │                   │
                       │ mergedFilters     │
                       │ (vocab + caller)  │
                       ├───────────────────┘
                       │
                       ▼
              ┌───────────────────┐
              │ Stage 2.5: Alias  │
              │ Resolution        │
              │                   │
              │ Input: filters    │
              │   with alias names│
              │ Output: filters   │
              │   with storage    │
              │   paths + coerced │
              │   values          │
              │                   │
              │ NON-FATAL         │
              └────────┬──────────┘
                       │ resolvedFilters
                       │
              ┌────────┴──────────────────────────────────┐
              │                                            │
              ▼                                            ▼
   ┌────────────────────┐                    ┌─────────────────────┐
   │ (semantic/hybrid)   │                    │ (structured/agg)     │
   │                     │                    │                     │
   │  Embed query text   │                    │  No embedding       │
   │  via BGE-M3         │                    │  needed             │
   └─────────┬───────────┘                    └──────────┬──────────┘
             │ vector                                    │
             └───────────────┬───────────────────────────┘
                             │
                             ▼
              ┌───────────────────────────┐
              │  Stage 3: Build + Execute  │
              │                           │
              │  Input:                    │
              │   - queryType              │
              │   - permissionFilter       │
              │   - resolvedFilters        │
              │   - vector (if applicable) │
              │   - unresolvedSegments     │
              │                           │
              │  Output: search results    │
              │                           │
              │  FATAL on failure          │
              └─────────────┬─────────────┘
                            │ results
                            │
              ┌─────────────┴──────────────┐
              │                            │
              ▼                            ▼
   ┌──────────────────┐        ┌──────────────────┐
   │ (semantic/hybrid  │        │ (structured/agg   │
   │  + rerank=true    │        │  OR rerank=false) │
   │  + results > 0)   │        │                   │
   │                   │        │  Skip reranking   │
   │  Stage 4: Rerank  │        │                   │
   │  NON-FATAL        │        │                   │
   └────────┬──────────┘        └─────────┬─────────┘
            │ rerankedResults             │ originalResults
            └──────────────┬──────────────┘
                           │
                           ▼
              ┌───────────────────────────┐
              │  Stage 5: Metrics +       │
              │  Response                  │
              │                           │
              │  Input: results + timings  │
              │  Output: JSON response     │
              │                           │
              │  NON-FATAL (metrics part) │
              └───────────────────────────┘
```

---

## 14. Error Handling Flow

What happens when each stage fails.

```
              Request arrives
                   │
                   ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 0:        │──X──>│  ABORT: 403 Forbidden             │
         │  Permissions     │ fail │  "Permission filter unavailable"  │
         │                  │      │  Never return unfiltered results  │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 1:        │──X──>│  DEGRADE: use original query      │
         │  Preprocessing   │ fail │  Log warning, continue            │
         │                  │      │  (Python service down? no problem)│
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 2:        │──X──>│  DEGRADE: no filters extracted    │
         │  Vocabulary      │ fail │  queryType defaults to "semantic" │
         │                  │      │  Log warning, continue            │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 2.5:      │──X──>│  DEGRADE: pass through filters    │
         │  Alias Resolution│ fail │  with "metadata.canonical." prefix│
         │                  │      │  (may not match, but won't crash) │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 3:        │──X──>│  ABORT: 500 Internal Error        │
         │  Search Execution│ fail │  "Search execution failed"        │
         │                  │      │  (OS unreachable, embedding fail) │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 4:        │──X──>│  DEGRADE: return original order   │
         │  Reranking       │ fail │  Circuit breaker opens for tenant │
         │                  │      │  Next request tries next provider │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
         ┌─────────────────┐      ┌──────────────────────────────────┐
         │  Stage 5:        │──X──>│  DEGRADE: return results without  │
         │  Metrics         │ fail │  latency/cost breakdown           │
         │                  │      │  Never block response for metrics │
         └────────┬─────────┘      └──────────────────────────────────┘
                  │ ok
                  ▼
            JSON Response


  Pattern:  Only Stage 0 (security) and Stage 3 (core search) are FATAL.
            Everything else degrades gracefully.
```

---

## 15. Cache Architecture

All caches in the query pipeline, their relationships, and invalidation flows.

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │                              In-Process LRU Caches (per pod)                              │
 │                                                                                          │
 │  ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────────┐ │
 │  │  DomainVocabulary       │  │  CanonicalSchema        │  │  CanonicalSchema            │ │
 │  │  Cache                  │  │  Cache (Vocab)           │  │  Cache (Alias)              │ │
 │  ├────────────────────────┤  ├────────────────────────┤  ├────────────────────────────┤ │
 │  │ Used by: Stage 2        │  │ Used by: Stage 2         │  │ Used by: Stage 2.5          │ │
 │  │ Max: 500 entries        │  │ Max: 200 entries          │  │ Max: 500 entries             │ │
 │  │ TTL: 5 min              │  │ TTL: 10 min               │  │ TTL: 5 min                   │ │
 │  │ Key: tenant:kb          │  │ Key: tenant:kb             │  │ Key: tenant:kb               │ │
 │  │                         │  │                            │  │                              │ │
 │  │ Invalidation:           │  │ Invalidation:              │  │ Invalidation:                │ │
 │  │  Redis pub/sub ◄────────┼──┼─ Redis pub/sub ◄──────────┼──┼─ Redis pub/sub               │ │
 │  │  "vocabulary:invalidate"│  │  "alias-resolver:          │  │  "alias-resolver:invalidate" │ │
 │  │                         │  │   invalidate"              │  │                              │ │
 │  └────────────────────────┘  └────────────────────────┘  └────────────────────────────┘ │
 │                                                                                          │
 │  ┌────────────────────────┐  ┌────────────────────────┐                                 │
 │  │  Discovery Manifest     │  │  Permission Groups      │                                 │
 │  │  Cache                  │  │  Cache                  │                                 │
 │  ├────────────────────────┤  ├────────────────────────┤                                 │
 │  │ Used by: Discovery API  │  │ Used by: Stage 0         │                                 │
 │  │ Max: 200 entries        │  │ Max: per-user             │                                 │
 │  │ TTL: 5 min              │  │ TTL: configurable         │                                 │
 │  │ Key: tenant:index       │  │ Key: userId               │                                 │
 │  │                         │  │                            │                                 │
 │  │ Invalidation:           │  │ Invalidation:              │                                 │
 │  │  TTL-based only         │  │  TTL-based only            │                                 │
 │  └────────────────────────┘  └────────────────────────┘                                 │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                         │                                     │
                         │  Subscribe                          │  Subscribe
                         ▼                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │                                     Redis                                                 │
 │                                                                                          │
 │  Channel: "vocabulary:invalidate"         Channel: "alias-resolver:invalidate"           │
 │                                                                                          │
 │  Published by:                            Published by:                                  │
 │   Admin API when vocabulary is            Admin API when schema is                       │
 │   created/updated/deleted                 created/updated/field added                    │
 │                                                                                          │
 │  Message: { tenantId, knowledgeBaseId }   Message: { tenantId, knowledgeBaseId }         │
 │                                                                                          │
 │  All pods subscribed → evict              All pods subscribed → evict                    │
 │  local LRU entry                          local LRU entries                              │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                         ▲                                     ▲
                         │  Publish                            │  Publish
                         │                                     │
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │                              Admin API (search-ai, port 3113)                             │
 │                                                                                          │
 │  PUT /vocabulary → save to MongoDB → PUBLISH "vocabulary:invalidate"                    │
 │  PUT /schema     → save to MongoDB → PUBLISH "alias-resolver:invalidate"                │
 │  PUT /field      → save to MongoDB → PUBLISH "alias-resolver:invalidate"                │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Related Documents

- `QUERY-PIPELINE-DESIGN.md` -- Full narrative design document
- `../QUERY-PIPELINE-NEXT-STEPS.md` -- Implementation gaps
