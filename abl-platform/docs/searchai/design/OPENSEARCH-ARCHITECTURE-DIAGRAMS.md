# OpenSearch Index Architecture — Diagrams

**Companion to:** [OPENSEARCH-INDEX-STRATEGY.md](./OPENSEARCH-INDEX-STRATEGY.md)

---

## Class Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MongoDB Models                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────┐   1:N    ┌──────────────────────┐                     │
│  │ SearchIndex          │────────▶│ SearchSource          │                     │
│  │─────────────────────│          │──────────────────────│                     │
│  │ _id: string          │          │ _id: string           │                     │
│  │ tenantId             │          │ tenantId              │                     │
│  │ projectId            │          │ indexId → SearchIndex │                     │
│  │ slug, name           │          │ connectorType         │                     │
│  │ embeddingModel       │          │ status                │                     │
│  │ embeddingDimensions  │          └──────────┬───────────┘                     │
│  │ vectorStore          │                     │ 1:N                              │
│  │ searchDefaults       │                     ▼                                  │
│  │ llmConfig            │          ┌──────────────────────┐                     │
│  │ queryLLMConfig       │          │ SearchDocument        │                     │
│  │ status               │          │──────────────────────│                     │
│  │ documentCount        │          │ _id, tenantId         │                     │
│  └──────────┬──────────┘          │ sourceId → Source     │                     │
│             │                      │ status                │                     │
│             │ 1:N                  └──────────┬───────────┘                     │
│             │ (appId = SearchIndex._id)       │ 1:N                              │
│             ▼                                  ▼                                  │
│  ┌─────────────────────┐          ┌──────────────────────┐                     │
│  │ IndexRegistry        │          │ SearchChunk           │                     │
│  │─────────────────────│          │──────────────────────│                     │
│  │ tenantId             │          │ _id, tenantId         │                     │
│  │ appId                │          │ documentId → Document │                     │
│  │ connectorId (null=   │          │ content: string       │                     │
│  │   default)           │          │ vector: number[1024]  │                     │
│  │ indexName ─┼──┐      └──────────────────────┘                     │
│  │ strategy: shared |   │  │                                                     │
│  │   per-app |          │  │                                                     │
│  │   per-connector      │  │                                                     │
│  │ status: active |     │  │                                                     │
│  │   migrating |        │  │                                                     │
│  │   deleting           │  │                                                     │
│  │ vectorCount          │  │                                                     │
│  └─────────────────────┘  │                                                     │
│                            │                                                     │
│  ┌─────────────────────┐  │      ┌──────────────────────────────────────────┐  │
│  │ SharedIndexTracker   │  │      │              OpenSearch                    │  │
│  │─────────────────────│  │      │──────────────────────────────────────────│  │
│  │ indexName ───────────┼──┼─────▶│ search-vectors-v1        (full, 6M)      │  │
│  │ version: 1           │  │      │ search-vectors-v2        (active, 1M)    │  │
│  │ status: full         │  └─────▶│ search-tenant-a-kb-1-logs (dedicated)    │  │
│  │ vectorCount: 6M      │         │                                           │  │
│  │ capacityPercent: 0.6 │         │ Each index has:                           │  │
│  │ maxVectors: 10M      │         │  - vector: knn_vector[1024]              │  │
│  │ appCount: 150        │         │  - content: text (BM25)                  │  │
│  │ lastSyncedAt         │         │  - permissions: { users, groups }        │  │
│  └─────────────────────┘         │  - metadata.sys: { tenantId, appId }     │  │
│                                   │  - metadata.doc: { name, type }          │  │
│                                   │  - metadata.canonical: 75 fixed fields   │  │
│                                   └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Sequence 1: Write Path — Document Ingestion

```
 BullMQ          EmbeddingWorker       IndexRegistryService      IndexRegistry    SharedIndexTracker    OpenSearch
   │                   │                       │                      (MongoDB)         (MongoDB)          │
   │  Job: embed doc   │                       │                         │                 │               │
   │──────────────────▶│                       │                         │                 │               │
   │                   │                       │                         │                 │               │
   │                   │ Load chunks + embed   │                         │                 │               │
   │                   │ (BGE-M3 vectors)      │                         │                 │               │
   │                   │                       │                         │                 │               │
   │                   │ resolveIndexForWrite() │                         │                 │               │
   │                   │──────────────────────▶│                         │                 │               │
   │                   │                       │                         │                 │               │
   │                   │                       │ Step 1: connector       │                 │               │
   │                   │                       │ override?               │                 │               │
   │                   │                       │────────────────────────▶│                 │               │
   │                   │                       │         null            │                 │               │
   │                   │                       │◀────────────────────────│                 │               │
   │                   │                       │                         │                 │               │
   │                   │                       │ Step 2: app default?    │                 │               │
   │                   │                       │────────────────────────▶│                 │               │
   │                   │                       │         null            │                 │               │
   │                   │                       │◀────────────────────────│                 │               │
   │                   │                       │                         │                 │               │
   │                   │                       │ Step 3: get active      │                 │               │
   │                   │                       │ shared index            │                 │               │
   │                   │                       │────────────────────────────────────────▶  │               │
   │                   │                       │                         │   tracker v1    │               │
   │                   │                       │◀────────────────────────────────────────  │               │
   │                   │                       │                         │                 │               │
   │                   │                       │ Sync stats from OS      │                 │       stats   │
   │                   │                       │────────────────────────────────────────────────────────▶  │
   │                   │                       │                         │                 │  vectorCount  │
   │                   │                       │◀────────────────────────────────────────────────────────  │
   │                   │                       │                         │                 │               │
   │                   │                       │ capacity < 60%?         │                 │               │
   │                   │                       │ YES → return v1         │                 │               │
   │                   │                       │ NO  → ROTATE (see Seq 3)│                 │               │
   │                   │                       │                         │                 │               │
   │                   │                       │ Create registry entry   │                 │               │
   │                   │                       │────────────────────────▶│                 │               │
   │                   │                       │        saved            │                 │               │
   │                   │                       │◀────────────────────────│                 │               │
   │                   │                       │                         │                 │               │
   │                   │   "search-vectors-v1" │                         │                 │               │
   │                   │◀──────────────────────│                         │                 │               │
   │                   │                       │                         │                 │               │
   │                   │ upsert(indexName, vectors)                      │                 │               │
   │                   │────────────────────────────────────────────────────────────────────────────────▶  │
   │                   │                       │                         │                 │    stored     │
   │                   │◀────────────────────────────────────────────────────────────────────────────────  │
   │                   │                       │                         │                 │               │
   │   done            │                       │                         │                 │               │
   │◀──────────────────│                       │                         │                 │               │
```

---

## Sequence 2: Read Path — Search Query

```
 Client          QueryRoute           QueryPipeline        IndexRegistryService    OpenSearch
   │                 │                      │                       │                  │
   │ POST /query     │                      │                       │                  │
   │────────────────▶│                      │                       │                  │
   │                 │                      │                       │                  │
   │                 │ Auth + tenant check  │                       │                  │
   │                 │                      │                       │                  │
   │                 │ executeUnified()     │                       │                  │
   │                 │─────────────────────▶│                       │                  │
   │                 │                      │                       │                  │
   │                 │                      │ Stage 0: Permissions  │                  │
   │                 │                      │ Stage 1: Preprocess   │                  │
   │                 │                      │ Stage 2: Vocabulary   │                  │
   │                 │                      │          + LLM class. │                  │
   │                 │                      │ Stage 2.5: Aliases    │                  │
   │                 │                      │                       │                  │
   │                 │                      │ Stage 3: Build search │                  │
   │                 │                      │ getAppIndices()       │                  │
   │                 │                      │──────────────────────▶│                  │
   │                 │                      │ ["search-vectors-v1", │                  │
   │                 │                      │  "search-...-logs"]   │                  │
   │                 │                      │◀──────────────────────│                  │
   │                 │                      │                       │                  │
   │                 │                      │ Parallel search:      │                  │
   │                 │                      │ ┌─ search v1 ─────────────────────────▶  │
   │                 │                      │ │  results A          │                  │
   │                 │                      │ │◀─────────────────────────────────────  │
   │                 │                      │ │                     │                  │
   │                 │                      │ └─ search logs ───────────────────────▶  │
   │                 │                      │    results B          │                  │
   │                 │                      │  ◀─────────────────────────────────────  │
   │                 │                      │                       │                  │
   │                 │                      │ Merge by score → top K│                  │
   │                 │                      │ Stage 4: Rerank       │                  │
   │                 │                      │ Stage 5: Metrics      │                  │
   │                 │                      │                       │                  │
   │                 │    response          │                       │                  │
   │                 │◀─────────────────────│                       │                  │
   │  results        │                      │                       │                  │
   │◀────────────────│                      │                       │                  │
```

---

## Sequence 3: Shared Index Rotation (at 60% capacity)

```
 EmbeddingWorker     IndexRegistryService     SharedIndexTracker      OpenSearch
       │                      │                     (MongoDB)             │
       │ resolveIndexForWrite │                        │                  │
       │─────────────────────▶│                        │                  │
       │ (new app, no entry)  │                        │                  │
       │                      │                        │                  │
       │                      │ Find active tracker    │                  │
       │                      │───────────────────────▶│                  │
       │                      │  v1: active, 0 count   │                  │
       │                      │◀───────────────────────│                  │
       │                      │                        │                  │
       │                      │ Sync stats from OS     │                  │
       │                      │───────────────────────────────────────▶   │
       │                      │  vectorCount: 6.2M     │                  │
       │                      │◀───────────────────────────────────────   │
       │                      │                        │                  │
       │                      │ Save: 6.2M/10M = 62%   │                  │
       │                      │───────────────────────▶│                  │
       │                      │                        │                  │
       │                      │                        │                  │
       │                      │ ┌──────────────────────────────────────┐ │
       │                      │ │  62% >= 60% threshold → ROTATE       │ │
       │                      │ └──────────────────────────────────────┘ │
       │                      │                        │                  │
       │                      │ Mark v1 as "full"      │                  │
       │                      │───────────────────────▶│                  │
       │                      │                        │                  │
       │                      │ Create search-vectors-v2                  │
       │                      │───────────────────────────────────────▶   │
       │                      │          created       │                  │
       │                      │◀───────────────────────────────────────   │
       │                      │                        │                  │
       │                      │ Create tracker v2      │                  │
       │                      │───────────────────────▶│                  │
       │                      │                        │                  │
       │                      │                        │                  │
       │                      │ Result:                │                  │
       │                      │ v1: full (6.2M, 150 apps) — keeps serving│
       │                      │ v2: active (0, 0 apps)    — new apps here│
       │                      │                        │                  │
       │   "search-vectors-v2"│                        │                  │
       │◀─────────────────────│                        │                  │
```

---

## Sequence 4: Cascade Deletion — App Deleted

```
 KB Delete API     IndexRegistryService     IndexRegistry      SharedIndexTracker    OpenSearch
       │                    │                  (MongoDB)            (MongoDB)            │
       │ deleteAppIndices() │                     │                    │                 │
       │───────────────────▶│                     │                    │                 │
       │                    │                     │                    │                 │
       │                    │ Find all entries     │                    │                 │
       │                    │────────────────────▶ │                    │                 │
       │                    │ [shared, dedicated]  │                    │                 │
       │                    │◀──────────────────── │                    │                 │
       │                    │                     │                    │                 │
       │                    │ ── For shared entry ─────────────────────────────────────  │
       │                    │ │                   │                    │                 │
       │                    │ │ Delete VECTORS    │                    │                 │
       │                    │ │ only (not index)  │                    │                 │
       │                    │ │────────────────────────────────────────────────────────▶ │
       │                    │ │ deleteByFilter(   │                    │                 │
       │                    │ │  "search-vectors-v1",                  │                 │
       │                    │ │  sys.appId=appId) │                    │                 │
       │                    │ │◀──────────────────────────────────────────────────────── │
       │                    │ │                   │                    │                 │
       │                    │ │ Decrement appCount│                    │                 │
       │                    │ │───────────────────────────────────────▶│                 │
       │                    │ │                   │                    │                 │
       │                    │ │ Delete registry   │                    │                 │
       │                    │ │───────────────────▶│                    │                 │
       │                    │ └────────────────────│                    │                 │
       │                    │                     │                    │                 │
       │                    │ ── For dedicated entry ──────────────────────────────────  │
       │                    │ │                   │                    │                 │
       │                    │ │ Delete ENTIRE     │                    │                 │
       │                    │ │ index             │                    │                 │
       │                    │ │────────────────────────────────────────────────────────▶ │
       │                    │ │ deleteCollection( │                    │                 │
       │                    │ │  "search-t-a-..") │                    │                 │
       │                    │ │◀──────────────────────────────────────────────────────── │
       │                    │ │                   │                    │                 │
       │                    │ │ Delete registry   │                    │                 │
       │                    │ │───────────────────▶│                    │                 │
       │                    │ └────────────────────│                    │                 │
       │                    │                     │                    │                 │
       │     done           │                     │                    │                 │
       │◀───────────────────│                     │                    │                 │
```

---

## Component Overview

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              ABL Platform                                         │
│                                                                                   │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────────────────┐  │
│  │   Studio      │    │   Search-AI       │    │   Search-AI-Runtime            │  │
│  │   (Next.js)   │    │   (Express)       │    │   (Express)                    │  │
│  │              │    │                  │    │                                │  │
│  │  KB Settings  │    │  Index Routes     │    │  Query Route                  │  │
│  │  └─ Query    ─┼───▶│  └─ query-llm-*  │    │  └─ buildPerTenantPipeline()  │  │
│  │     Pipeline  │    │                  │    │     └─ QueryLLMResolver        │  │
│  │     LLM      │    │  Admin Routes     │    │        └─ LRU Cache (5min)    │  │
│  │     Section  │    │  └─ rotate-shared │    │                                │  │
│  │  └─ Model    │    │  └─ status        │    │  QueryPipeline (6 stages)     │  │
│  │     Selector │    │  └─ archive       │    │  └─ DynamicVocabResolver      │  │
│  │     Dialog   │    │                  │    │  └─ HybridSearchBuilder       │  │
│  └──────────────┘    │  LLM Config       │    │                                │  │
│                       │  └─ resolver      │    │  ServiceContainer (singleton) │  │
│                       │  └─ adapter       │    │  └─ embeddingProvider         │  │
│                       │  └─ defaults      │    │  └─ fallback LLM client      │  │
│                       └──────────────────┘    └──────────┬─────────────────────┘  │
│                                                          │                         │
│  ┌──────────────────────────────────────────────────────┐│                         │
│  │   BullMQ Workers                                      ││                         │
│  │                                                       ││                         │
│  │  EmbeddingWorker ─── resolveIndexForWrite() ──────────┼┘                         │
│  │  └─ generates vectors (BGE-M3)                        │                          │
│  │  └─ upserts to resolved OpenSearch index              │                          │
│  └──────────────────────────────────────────────────────┘│                          │
│                                                          │                          │
│  ┌──────────────────────────────────────────────────────┐│                          │
│  │   search-ai-internal (shared package)                 ││                          │
│  │                                                       ││                          │
│  │  IndexRegistryService                                 ││                          │
│  │  ├─ resolveIndexForWrite()  ◀─── EmbeddingWorker     ││                          │
│  │  ├─ getAppIndices()         ◀─── QueryPipeline       ││                          │
│  │  ├─ getActiveSharedIndex()  (lazy init + rotation)    ││                          │
│  │  ├─ ensureIndexExists()     (per-app/per-connector)   ││                          │
│  │  ├─ deleteAppIndices()      (cascade)                 ││                          │
│  │  └─ forceRotateSharedIndex()(admin)                   ││                          │
│  │                                                       ││                          │
│  │  OpenSearchVectorStore                                ││                          │
│  │  ├─ createCollection()                                ││                          │
│  │  ├─ upsert() / search() / hybridSearch()             ││                          │
│  │  ├─ deleteByFilter() / deleteCollection()             ││                          │
│  │  └─ executeQuery()                                    ││                          │
│  └──────────────────────────────────────────────────────┘│                          │
│                                                          │                          │
├──────────────────────────────────────────────────────────┴──────────────────────────┤
│                                                                                     │
│  ┌──────────────────────────┐    ┌──────────────────────────────────────────────┐  │
│  │   MongoDB                 │    │   OpenSearch                                  │  │
│  │                          │    │                                               │  │
│  │  search_indexes          │    │   search-vectors-v1  (shared, FULL, 6M)       │  │
│  │  index_registry          │    │   search-vectors-v2  (shared, ACTIVE, 1M)     │  │
│  │  shared_index_tracker    │    │   search-tenant-a-kb-1  (per-app)             │  │
│  │  search_sources          │    │   search-t-a-kb-1-logs  (per-connector)       │  │
│  │  search_documents        │    │                                               │  │
│  │  search_chunks           │    │   Each index mapping:                         │  │
│  │  tenant_models           │    │   ├─ vector: knn_vector[1024] (HNSW)         │  │
│  │  llm_credentials         │    │   ├─ content: text (BM25 analyzed)           │  │
│  │                          │    │   ├─ permissions: { users, groups, domains }  │  │
│  │                          │    │   ├─ metadata.sys: { tenantId, appId, ... }   │  │
│  │                          │    │   ├─ metadata.doc: { name, type, language }   │  │
│  │                          │    │   └─ metadata.canonical: 75 fixed fields      │  │
│  │                          │    │       (15 core + 25 common + 35 custom)       │  │
│  └──────────────────────────┘    └──────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Index Resolution Decision Tree

```
resolveIndexForWrite(tenantId, appId, connectorId)
│
├─ 1. Connector override?
│     IndexRegistry.findOne({ appId, connectorId, status: active })
│     │
│     ├─ FOUND → return indexName          (per-connector index)
│     │
│     └─ NOT FOUND → continue
│
├─ 2. App default?
│     IndexRegistry.findOne({ appId, connectorId: null, status: active })
│     │
│     ├─ FOUND → return indexName          (per-app or shared)
│     │
│     └─ NOT FOUND → continue
│
└─ 3. No entry → ensureSharedIndex()
      │
      ├─ getActiveSharedIndex()
      │   │
      │   ├─ SharedIndexTracker.findOne({ status: active })
      │   │   │
      │   │   ├─ NOT FOUND → createSharedIndex(v1)    (first ever)
      │   │   │   └─ Create OS index "search-vectors-v1"
      │   │   │   └─ Create tracker { version: 1, status: active }
      │   │   │   └─ return "search-vectors-v1"
      │   │   │
      │   │   └─ FOUND → sync stats from OpenSearch
      │   │       │
      │   │       ├─ capacityPercent < 60% → return current index
      │   │       │
      │   │       └─ capacityPercent >= 60% → ROTATE
      │   │           └─ Mark current as "full"
      │   │           └─ Create "search-vectors-v{N+1}"
      │   │           └─ Create tracker { version: N+1, status: active }
      │   │           └─ return new index
      │   │
      │   └─ return active index name
      │
      ├─ Create IndexRegistry entry { appId → sharedIndex, strategy: shared }
      ├─ Increment SharedIndexTracker.appCount
      └─ return index name
```

---

## Deletion Decision Tree

```
deleteAppIndices(tenantId, appId)
│
├─ Find all IndexRegistry entries for this app
│
└─ For each entry:
    │
    ├─ strategy = "shared"
    │   ├─ Delete VECTORS only: deleteByFilter(indexName, sys.appId = appId)
    │   ├─ Decrement SharedIndexTracker.appCount
    │   └─ Delete IndexRegistry entry
    │
    └─ strategy = "per-app" or "per-connector"
        ├─ Delete ENTIRE INDEX: deleteCollection(indexName)
        └─ Delete IndexRegistry entry
```
