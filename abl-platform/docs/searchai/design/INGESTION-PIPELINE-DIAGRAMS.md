# SearchAI Ingestion Pipeline — Class & Sequence Diagrams

Companion to [INGESTION-PIPELINE-GUIDE.md](./INGESTION-PIPELINE-GUIDE.md). All diagrams are ASCII art for direct rendering in any markdown viewer.

---

## 1. Class Diagram: Pipeline Data Model

Corresponds to **Scene 2–4** (pipeline structure, flows, stages).

```
 +---------------------------------------------+
 |        SearchPipelineDefinition              |
 +---------------------------------------------+
 | _id: ObjectId                                |
 | tenantId: string                             |
 | knowledgeBaseId: string                      |
 | name: string                                 |
 | description?: string                         |
 | version: number          (auto-increments)   |
 | status: draft | active | archived            |
 | validationStatus: valid | invalid | pending  |
 | createdBy: string                            |
 | providerDefaults?: Map<string, any>          |
 | validationErrors?: ValidationError[]         |
 +---------------------------------------------+
 | activeEmbeddingConfig: ActiveEmbeddingConfig |----+
 | flows: Flow[1..50]                           |-+  |
 | sharedStages?: SharedStages                  |    |
 +---------------------------------------------+    |
   |                                                 |
   | 1..*                                            |
   v                                                 |
 +---------------------------------------------+    |
 |                   Flow                       |    |
 +---------------------------------------------+    |
 | id: string                                   |    |
 | name: string                                 |    |
 | description?: string                         |    |
 | enabled: boolean                             |    |
 | priority: number          (1-100)            |    |
 | providerDefaults?: Map<string, any>          |    |
 +---------------------------------------------+    |
 | selectionRules?: RuleCondition[]             |-+  |
 | stages: Stage[1..*]                          |-+  |
 +---------------------------------------------+ |  |
   |                                              |  |
   | 1..*                                         |  |
   v                                              |  |
 +---------------------------------------------+ |  |
 |                   Stage                      | |  |
 +---------------------------------------------+ |  |
 | id: string                                   | |  |
 | name: string                                 | |  |
 | type: extraction | chunking | enrichment     | |  |
 |       | embedding | multimodal               | |  |
 | provider: string                             | |  |
 | providerConfig: any                          | |  |
 | onError: fail | continue                     | |  |
 | fallbackProvider?: string                    | |  |
 | fallbackConfig?: any                         | |  |
 | executionCondition?: string                  | |  |
 | description?: string                         | |  |
 | estimatedDuration?: number                   | |  |
 | estimatedCost?: number                       | |  |
 +---------------------------------------------+ |  |
                                                  |  |
   +----------------------------------------------+  |
   |                                                  |
   v                                                  |
 +---------------------------------------------+     |
 |             RuleCondition                    |     |
 +---------------------------------------------+     |
 | type: simple | compound | cel                |     |
 |                                              |     |
 | --- simple ---                               |     |
 | field: string                                |     |
 | operator: eq | neq | in | contains | ...    |     |
 | value: any                                   |     |
 |                                              |     |
 | --- compound ---                             |     |
 | logic: AND | OR                              |     |
 | conditions: RuleCondition[]   (recursive)    |     |
 |                                              |     |
 | --- cel ---                                  |     |
 | celExpression: string                        |     |
 +---------------------------------------------+     |
                                                      |
   +--------------------------------------------------+
   |
   v
 +---------------------------------------------+
 |          ActiveEmbeddingConfig               |
 +---------------------------------------------+
 | provider: bge-m3 | openai | cohere | custom  |
 | model: string                                |
 | dimensions: number  (min: 1)                 |
 | providerConfig?: any                         |
 +---------------------------------------------+
   |
   | shared by ALL flows (pipeline-level)
   |
   v
   (Every embedding stage in every flow
    must match this configuration)
```

---

## 2. Class Diagram: Provider Registry & Circuit Breaker

Corresponds to **Scene 5** (provider registry) and **Scene 8** (circuit breakers).

```
 +----------------------------------------------+
 |             ProviderRegistry                  |
 |               (singleton)                     |
 +----------------------------------------------+
 | - providers: Map<StageType,                   |
 |              Map<ProviderId, Provider>>        |
 +----------------------------------------------+
 | + register(provider: PipelineStageProvider)   |
 | + get(type, id): PipelineStageProvider | null |
 | + list(type): PipelineStageProvider[]         |
 | + getInstance(): ProviderRegistry             |
 +----------------------------------------------+
            |
            | wraps
            v
 +----------------------------------------------+
 |  ProviderRegistryWithCircuitBreaker           |
 +----------------------------------------------+
 | - registry: ProviderRegistry                  |
 | - redis: Redis                                |
 | - breakers: Map<key, RedisCircuitBreaker>     |
 |             (max 500, LRU eviction)           |
 +----------------------------------------------+
 | + executeWithProtection(params):              |
 |     ProtectedExecutionResult                  |
 | + getCircuitState(tenantId, providerId):      |
 |     CLOSED | OPEN | HALF_OPEN                 |
 | + resetCircuit(tenantId, providerId): void    |
 +----------------------------------------------+
            |
            | uses
            v
 +----------------------------------------------+
 |         RedisCircuitBreaker                   |
 +----------------------------------------------+
 | - redis: Redis                                |
 | - config: CircuitBreakerConfig                |
 +----------------------------------------------+
 | + execute(key, fn): Promise<T>                |
 | + getState(key): CLOSED | OPEN | HALF_OPEN   |
 | + forceReset(key, state): void                |
 +----------------------------------------------+
 | failureThreshold: number                      |
 | successThreshold: number                      |
 | resetTimeout: number (ms)                     |
 +----------------------------------------------+

            implements
               ^
               |
 +----------------------------------------------+
 |    <<interface>> PipelineStageProvider        |
 +----------------------------------------------+
 | id: string                                    |
 | name: string                                  |
 | type: SearchPipelineStageType                 |
 | version: string                               |
 +----------------------------------------------+
 | + execute(input, config): Promise<output>     |
 | + validateConfig(config): config is TConfig   |
 | + getSchema(): JSONSchema                     |
 +----------------------------------------------+
        ^          ^          ^          ^
        |          |          |          |
   +--------+ +--------+ +--------+ +--------+
   |Docling | |TreeBldr| |LLM Enr.| |BGE-M3  |
   |Extract.| |Chunking| |Enrichmt| |Embeddin|
   +--------+ +--------+ +--------+ +--------+
    (port     (in-proc)  (LLM call) (port
     8080)                            8000)
```

---

## 3. Sequence Diagram: Document Ingestion (Happy Path)

Corresponds to **Scene 2–4** (how a document flows through the pipeline).

```
 User/Connector          Pipeline            Flow Selection        BullMQ          Workers
      |                  Orchestrator         Service               Queues
      |                      |                    |                   |               |
      |  upload document     |                    |                   |               |
      |--------------------->|                    |                   |               |
      |                      |                    |                   |               |
      |                      |  evaluate(doc,     |                   |               |
      |                      |    pipeline.flows) |                   |               |
      |                      |------------------->|                   |               |
      |                      |                    |                   |               |
      |                      |                    | sort by priority  |               |
      |                      |                    | evaluate rules    |               |
      |                      |                    | return first match|               |
      |                      |                    |                   |               |
      |                      |  matched: "PDF     |                   |               |
      |                      |  Contract Flow"    |                   |               |
      |                      |<-------------------|                   |               |
      |                      |                    |                   |               |
      |                      |  create BullMQ Flow (4 child jobs)    |               |
      |                      |---------------------------------------->|              |
      |                      |                    |                   |               |
      |                      |                    |          extraction job           |
      |                      |                    |                   |-------------->|
      |                      |                    |                   |   Docling     |
      |                      |                    |                   |   extract     |
      |                      |                    |                   |<- - - - - - - |
      |                      |                    |                   |               |
      |                      |                    |          chunking job             |
      |                      |                    |                   |-------------->|
      |                      |                    |                   |  tree-builder |
      |                      |                    |                   |  chunk        |
      |                      |                    |                   |<- - - - - - - |
      |                      |                    |                   |               |
      |                      |                    |          enrichment job           |
      |                      |                    |                   |-------------->|
      |                      |                    |                   |  LLM enrich   |
      |                      |                    |                   |  (onError:    |
      |                      |                    |                   |   continue)   |
      |                      |                    |                   |<- - - - - - - |
      |                      |                    |                   |               |
      |                      |                    |          embedding job            |
      |                      |                    |                   |-------------->|
      |                      |                    |                   |  BGE-M3       |
      |                      |                    |                   |  embed        |
      |                      |                    |                   |<- - - - - - - |
      |                      |                    |                   |               |
      |                      |  all jobs complete  |                  |               |
      |                      |<----------------------------------------|              |
      |                      |                    |                   |               |
      |  document indexed    |                    |                   |               |
      |<---------------------|                    |                   |               |
      |                      |                    |                   |               |
```

---

## 4. Sequence Diagram: Flow Selection

Corresponds to **Scene 3** (priority-based flow matching).

```
 Orchestrator            FlowSelectionService
      |                         |
      |  selectFlow(document,   |
      |    pipeline.flows)      |
      |------------------------>|
      |                         |
      |                         |  1. Filter: remove disabled flows
      |                         |     [PDF Flow: enabled]
      |                         |     [Word Flow: enabled]
      |                         |     [HTML Flow: enabled]
      |                         |     [Default: enabled]
      |                         |
      |                         |  2. Sort by priority (desc)
      |                         |     90: PDF Contract Flow
      |                         |     70: Word Memo Flow
      |                         |     50: HTML Regulatory Flow
      |                         |      0: Default Flow
      |                         |
      |                         |  3. Evaluate rules
      |                         |
      |                         |  PDF Flow rules:
      |                         |    doc.mimeType == "application/pdf"  --> true
      |                         |    AND source.connector == "contracts" --> true
      |                         |    COMPOUND result: true
      |                         |    ==> MATCH (stop here)
      |                         |
      |  return: {              |
      |    flowId: "flow-pdf",  |
      |    flowName: "PDF       |
      |      Contract Flow"     |
      |  }                      |
      |<------------------------|
      |                         |

 --- If no rules matched: ---

      |                         |  Word Flow: doc.mimeType != "application/msword"
      |                         |    ==> NO MATCH
      |                         |
      |                         |  HTML Flow: doc.mimeType != "text/html"
      |                         |    ==> NO MATCH
      |                         |
      |                         |  Default Flow: NO rules defined
      |                         |    ==> MATCH (catch-all)
      |                         |
      |  return: {              |
      |    flowId: "flow-default"|
      |  }                      |
      |<------------------------|
```

---

## 5. Sequence Diagram: Publish & Reindex (4-Checkpoint)

Corresponds to **Scene 7** (draft-to-active lifecycle, checkpoint-based reindexing).

```
 Studio UI             API Server           ChangeIdentifier       ReindexRouter        ReindexOrchestrator
     |                     |                      |                     |                      |
     |  POST /publish      |                      |                     |                      |
     |-------------------->|                      |                     |                      |
     |                     |                      |                     |                      |
     |                     |  diff(v2, v1)        |                     |                      |
     |                     |--------------------->|                     |                      |
     |                     |                      |                     |                      |
     |                     |                      | compare flows,      |                      |
     |                     |                      | stages, rules,      |                      |
     |                     |                      | embedding config    |                      |
     |                     |                      |                     |                      |
     |                     |  changeSet:          |                     |                      |
     |                     |  {                   |                     |                      |
     |                     |    routingChanged:   |                     |                      |
     |                     |      false,          |                     |                      |
     |                     |    extractionChanged:|                     |                      |
     |                     |      false,          |                     |                      |
     |                     |    enrichmentChanged:|                     |                      |
     |                     |      true,  <--------|--- only enrichment  |                      |
     |                     |    embeddingChanged: |    changed           |                      |
     |                     |      false           |                     |                      |
     |                     |  }                   |                     |                      |
     |                     |<---------------------|                     |                      |
     |                     |                      |                     |                      |
     |                     |  route(changeSet)    |                     |                      |
     |                     |------------------------------------------------>|                 |
     |                     |                      |                     |                      |
     |                     |                      |       Checkpoint 1: SKIP (routing same)    |
     |                     |                      |       Checkpoint 2: SKIP (extraction same) |
     |                     |                      |       Checkpoint 3: RUN  (enrichment diff) |
     |                     |                      |       Checkpoint 4: SKIP (embedding same)  |
     |                     |                      |                     |                      |
     |                     |  reindexPlan:        |                     |                      |
     |                     |  {                   |                     |                      |
     |                     |   startCheckpoint: 3 |                     |                      |
     |                     |   affectedChunks: N  |                     |                      |
     |                     |   estimatedDuration  |                     |                      |
     |                     |  }                   |                     |                      |
     |                     |<------------------------------------------------|                 |
     |                     |                      |                     |                      |
     |  confirm reindex?   |                      |                     |                      |
     |<--------------------|                      |                     |                      |
     |                     |                      |                     |                      |
     |  YES                |                      |                     |                      |
     |-------------------->|                      |                     |                      |
     |                     |                      |                     |                      |
     |                     |  execute(plan)       |                     |                      |
     |                     |------------------------------------------------------------->|    |
     |                     |                      |                     |                      |
     |                     |                      |                     |     run checkpoint 3 |
     |                     |                      |                     |     (re-enrich only) |
     |                     |                      |                     |     skip 1, 2, 4     |
     |                     |                      |                     |                      |
     |  reindex started    |                      |                     |                      |
     |  (batchId: xxx)     |                      |                     |                      |
     |<--------------------|                      |                     |                      |
     |                     |                      |                     |                      |
```

---

## 6. Sequence Diagram: Circuit Breaker with Fallback

Corresponds to **Scene 8** (circuit breaker states and automatic fallback).

```
 Worker                CircuitBreakerRegistry    Docling (primary)     LlamaIndex (fallback)
   |                          |                       |                       |
   |  executeWithProtection(  |                       |                       |
   |    provider: "docling",  |                       |                       |
   |    fallback: "llamaindex"|                       |                       |
   |  )                       |                       |                       |
   |------------------------->|                       |                       |
   |                          |                       |                       |
   |                          |  check breaker state  |                       |
   |                          |  key: "tenant:docling" |                       |
   |                          |  state: CLOSED         |                       |
   |                          |                       |                       |
   |                          |  execute via breaker  |                       |
   |                          |---------------------->|                       |
   |                          |                       |                       |
   |                          |        ERROR          |                       |
   |                          |<----------------------|                       |
   |                          |                       |                       |
   |                          |  failure count: 9/10  |                       |
   |                          |  state: still CLOSED  |                       |
   |                          |                       |                       |
   |  (next request)          |                       |                       |
   |------------------------->|                       |                       |
   |                          |  execute via breaker  |                       |
   |                          |---------------------->|                       |
   |                          |        ERROR          |                       |
   |                          |<----------------------|                       |
   |                          |                       |                       |
   |                          |  failure count: 10/10 |                       |
   |                          |  CIRCUIT OPENS        |                       |
   |                          |                       |                       |
   |  (next request)          |                       |                       |
   |------------------------->|                       |                       |
   |                          |                       |                       |
   |                          |  breaker state: OPEN  |                       |
   |                          |  --> skip docling     |                       |
   |                          |  --> try fallback     |                       |
   |                          |                       |                       |
   |                          |  execute llamaindex   |                       |
   |                          |---------------------------------------------->|
   |                          |                       |                       |
   |                          |        SUCCESS (lower quality, but works)     |
   |                          |<----------------------------------------------|
   |                          |                       |                       |
   |  result: {               |                       |                       |
   |    success: true,        |                       |                       |
   |    providerId:           |                       |                       |
   |      "llamaindex",       |                       |                       |
   |    usedFallback: true,   |                       |                       |
   |    circuitOpen: true     |                       |                       |
   |  }                       |                       |                       |
   |<-------------------------|                       |                       |
   |                          |                       |                       |
   |                          |                       |                       |
   |   --- 120 seconds later (Docling cooldown) ---   |                       |
   |                          |                       |                       |
   |  (next request)          |                       |                       |
   |------------------------->|                       |                       |
   |                          |                       |                       |
   |                          |  state: HALF_OPEN     |                       |
   |                          |  (allow 1 probe)      |                       |
   |                          |                       |                       |
   |                          |  probe docling        |                       |
   |                          |---------------------->|                       |
   |                          |                       |                       |
   |                          |        SUCCESS        |                       |
   |                          |<----------------------|                       |
   |                          |                       |                       |
   |                          |  success count: 1/5   |                       |
   |                          |  ... (4 more probes)  |                       |
   |                          |  success count: 5/5   |                       |
   |                          |  CIRCUIT CLOSES       |                       |
   |                          |                       |                       |
   |  result: {               |                       |                       |
   |    success: true,        |                       |                       |
   |    providerId: "docling",|                       |                       |
   |    usedFallback: false,  |                       |                       |
   |    circuitOpen: false    |                       |                       |
   |  }                       |                       |                       |
   |<-------------------------|                       |                       |
```

---

## 7. Class Diagram: Reindexing System

Corresponds to **Scene 7** (4-checkpoint reindex architecture).

```
 +----------------------------------+     +----------------------------------+
 |         ChangeIdentifier         |     |          ChangeStore             |
 +----------------------------------+     +----------------------------------+
 | + identifyChanges(               |     | + save(tenantId, kbId,           |
 |     oldPipeline,                 |     |     changeSet): void             |
 |     newPipeline                  |     | + get(tenantId, kbId):           |
 |   ): ChangeSet                   |     |     ChangeSet | null             |
 +----------------------------------+     +----------------------------------+
            |                                          |
            v                                          v
 +-----------------------------------------------------------+
 |                       ChangeSet                            |
 +-----------------------------------------------------------+
 | routingChanged: boolean                                    |
 | extractionChanged: Map<flowId, boolean>                    |
 | chunkingChanged: Map<flowId, boolean>                      |
 | enrichmentChanged: Map<flowId, boolean>                    |
 | embeddingChanged: boolean                                  |
 | flowsAdded: string[]                                       |
 | flowsRemoved: string[]                                     |
 | flowsModified: string[]                                    |
 +-----------------------------------------------------------+
            |
            | input to
            v
 +-----------------------------------------------------------+
 |                     ReindexRouter                          |
 +-----------------------------------------------------------+
 | + route(changeSet): ReindexPlan                            |
 +-----------------------------------------------------------+
 | Determines which checkpoints to run:                       |
 |                                                            |
 |   routingChanged?      --> Checkpoint 1 (re-route all)     |
 |   extraction/chunking? --> Checkpoint 2 (re-extract)       |
 |   enrichmentChanged?   --> Checkpoint 3 (re-enrich)        |
 |   embeddingChanged?    --> Checkpoint 4 (re-embed)         |
 |                                                            |
 |   Start from EARLIEST affected checkpoint.                 |
 |   Later checkpoints cascade automatically.                 |
 +-----------------------------------------------------------+
            |
            | produces
            v
 +-----------------------------------------------------------+
 |                     ReindexPlan                            |
 +-----------------------------------------------------------+
 | startCheckpoint: 1 | 2 | 3 | 4                            |
 | affectedFlows: string[]                                    |
 | affectedDocumentCount: number                              |
 | affectedChunkCount: number                                 |
 | estimatedDurationMin: number                               |
 | estimatedCostUsd: number                                   |
 +-----------------------------------------------------------+
            |
            | executed by
            v
 +-----------------------------------------------------------+
 |                  ReindexOrchestrator                       |
 +-----------------------------------------------------------+
 | + execute(plan): Promise<ReindexResult>                    |
 +-----------------------------------------------------------+
 | Creates BullMQ jobs for each checkpoint:                   |
 |                                                            |
 |   Checkpoint 1 --> routing handler (re-evaluate flows)     |
 |   Checkpoint 2 --> pre-chunk handler (re-extract + chunk)  |
 |   Checkpoint 3 --> post-chunk handler (re-enrich)          |
 |   Checkpoint 4 --> embedding handler (re-embed)            |
 |                                                            |
 |   If checkpoint 2 runs, 3 and 4 run automatically.         |
 |   If checkpoint 3 runs, 4 does NOT run (unless changed).   |
 +-----------------------------------------------------------+
```

---

## 8. State Diagram: Pipeline Lifecycle

Corresponds to **Scene 7** (draft-to-active transitions).

```
                       create
                         |
                         v
                   +-----------+
                   |   DRAFT   |
                   |  (v1)     |
                   +-----------+
                     |       ^
            publish  |       |  edit
                     v       |
                   +-----------+
                   |  ACTIVE   |
                   |  (v1)     |
                   +-----------+
                     |       ^
              edit   |       |  publish
           (creates  |       |  (increments
            draft)   v       |   version)
                   +-----------+
                   |   DRAFT   |
                   |  (v2)     |
                   +-----------+
                     |       ^
            publish  |       |  edit
                     v       |
                   +-----------+
                   |  ACTIVE   |------- archive ------> +-----------+
                   |  (v2)     |                        | ARCHIVED  |
                   +-----------+                        +-----------+


  Version increments on every save (not just publish).
  Only one pipeline per tenantId + knowledgeBaseId.
  Publish triggers reindex analysis (changeSet diff).
```

---

## 9. State Diagram: Circuit Breaker

Corresponds to **Scene 8** (three-state circuit breaker).

```
                          start
                            |
                            v
  +----------------+   failures >= threshold   +----------------+
  |                |-------------------------->|                |
  |    CLOSED      |                           |     OPEN       |
  |   (passing     |                           |   (failing     |
  |    requests)   |   success after           |    fast,       |
  |                |   successThreshold        |    no calls)   |
  |                |<---------+                |                |
  +----------------+          |                +----------------+
                              |                       |
                              |    cooldown elapsed    |
                              |    (resetTimeout ms)   |
                              |                       v
                              |                +----------------+
                              |                |                |
                              +----------------|  HALF_OPEN     |
                                  success      |  (probe: allow |
                                               |   1 request)   |
                               failure         |                |
                              +--------------->+----------------+
                              |                       |
                              |                       |
                              v                       |
                        +----------------+            |
                        |     OPEN       |<-----------+
                        |  (re-opened)   |   failure on probe
                        +----------------+


  Thresholds (from circuit-breaker-registry.ts):

  Provider     Fail  Success  Cooldown
  ---------    ----  -------  --------
  Docling       10       5    120s
  OpenAI         3       2     60s
  BGE-M3         5       3     90s
  Default        5       2     60s

  Key format: "tenantId:providerId"
  State stored in Redis (per-tenant isolation)
  Max 500 breaker instances (LRU eviction)
```

---

## 10. Component Diagram: System Architecture

Shows how all components from the guide connect at the infrastructure level.

```
  +------------------------------------------------------------------+
  |                         Studio (UI)                               |
  |  +------------------+  +------------------+  +-----------------+ |
  |  | Pipeline Editor  |  | Flow Config      |  | Publish Dialog  | |
  |  | (Scene 4)        |  | (Scene 3-4)      |  | (Scene 7)       | |
  |  +--------+---------+  +--------+---------+  +--------+--------+ |
  +-----------|----------------------|----------------------|---------+
              |                      |                      |
              v                      v                      v
  +------------------------------------------------------------------+
  |                     search-ai API Server                         |
  |                                                                  |
  |  +------------------+  +------------------+  +-----------------+ |
  |  | Pipeline CRUD    |  | Flow Selection   |  | Publish +       | |
  |  | Routes           |  | Service          |  | Reindex Routes  | |
  |  +--------+---------+  +--------+---------+  +--------+--------+ |
  +-----------|----------------------|----------------------|---------+
              |                      |                      |
              v                      v                      v
  +-------------------+  +-------------------+  +-------------------+
  |    MongoDB        |  |     Redis         |  |    BullMQ         |
  |                   |  |                   |  |    Queues          |
  |  search_pipeline_ |  |  circuit breaker  |  |                   |
  |  definitions      |  |  state            |  |  extraction       |
  |                   |  |                   |  |  chunking         |
  |  search_documents |  |  backpressure     |  |  enrichment       |
  |  search_chunks    |  |  counters         |  |  visual-enrichment|
  |  document_pages   |  |                   |  |  multimodal       |
  |                   |  |                   |  |  embedding        |
  +-------------------+  +-------------------+  +--------+----------+
                                                         |
                                                         | jobs
                                                         v
  +------------------------------------------------------------------+
  |                        Workers                                   |
  |                                                                  |
  |  +----------+ +----------+ +--------+ +--------+ +------+ +----+ |
  |  |Extraction| | Chunking | |Enrichmt| | Vision | |Multi | |Embd| |
  |  | Worker   | | Worker   | | Worker | | Worker | |modal | |Wrkr| |
  |  +----+-----+ +----+-----+ +---+----+ +---+----+ +--+---+ +-+--+ |
  +-------|-------------|-----------|-----------|---------|-------|----+
          |             |           |           |         |       |
          v             v           v           v         v       v
  +---------------+  (in-proc)  +------------+  +------------+ +--------+
  |   Docling     |             | LLM APIs   |  | Vision LLM | | BGE-M3 |
  |   (port 8080) |             | (OpenAI,   |  | APIs (GPT-4| | (port  |
  |               |             |  etc.)     |  | Claude,    | |  8000) |
  +---------------+             +------------+  | Gemini)    | +--------+
                                                +------------+
```
