# ABL-SearchAI Integration Architecture

**Status:** Production
**Last Updated:** 2026-03-16
**Owner:** Runtime + SearchAI teams

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Components](#architecture-components)
3. [Integration Patterns](#integration-patterns)
4. [Runtime Flow](#runtime-flow)
5. [Tool Execution Paths](#tool-execution-paths)
6. [Key Files Reference](#key-files-reference)
7. [Context-Aware Search](#context-aware-search)
8. [Enhancement Opportunities](#enhancement-opportunities)

---

## Overview

The ABL Runtime integrates with SearchAI to provide agents with knowledge base search capabilities through two patterns:

1. **Explicit Search Tools** — Direct search primitives (`search_vector`, `search_structured`, `search_aggregate`, `search_hybrid`, `vocabulary_resolve`)
2. **KB-as-Tool Pattern** — Knowledge bases exposed as autonomous tools with dynamic capability discovery

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ABL Runtime (3112)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         LLMWiringService (llm-wiring.ts)              │ │
│  │  • Session initialization                              │ │
│  │  • Tool executor composition                           │ │
│  │  • SearchAI integration wiring                         │ │
│  └────────────────┬───────────────────────────────────────┘ │
│                   │                                          │
│  ┌────────────────▼───────────────────────────────────────┐ │
│  │       SearchAIAwareToolExecutor (wrapper)             │ │
│  │  • Intercepts search tool calls                        │ │
│  │  • Routes to SearchAIToolHandler or SearchAIKBExecutor │ │
│  │  • Falls through to base ToolBindingExecutor           │ │
│  └────────────────┬───────────────────────────────────────┘ │
│                   │                                          │
│       ┌───────────┼───────────┐                             │
│       │           │           │                             │
│  ┌────▼─────┐ ┌──▼──────┐ ┌──▼──────────────────────────┐  │
│  │ Search   │ │ SearchAI│ │ ToolBindingExecutor         │  │
│  │ AI Tool  │ │ KB Tool │ │ (http/mcp/sandbox/connector)│  │
│  │ Handler  │ │ Executor│ │                             │  │
│  └────┬─────┘ └──┬──────┘ └─────────────────────────────┘  │
│       │          │                                          │
└───────┼──────────┼──────────────────────────────────────────┘
        │          │
        │          │ ┌─────────────────────────────────────┐
        │          │ │  @agent-platform/search-ai-sdk      │
        └──────────┴─┤  • SearchAIClient (HTTP client)     │
                     │  • Type definitions                  │
                     │  • Error handling                    │
                     └──────────────┬──────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
    ┌────▼─────────────────┐   ┌───▼───────────────────┐     │
    │ SearchAI Runtime     │   │ SearchAI Engine       │     │
    │ (3004)               │   │ (3005)                │     │
    │                      │   │                       │     │
    │ • /query (unified)   │   │ • /indexes (admin)    │     │
    │ • /discover          │   │ • /sources            │     │
    │ • /resolve           │   │ • /schemas            │     │
    │ • /structured        │   │ • /vocabulary         │     │
    │ • /aggregate         │   │ • /documents          │     │
    │ • /suggest           │   │                       │     │
    │ • /similar           │   │                       │     │
    └──────────────────────┘   └───────────────────────┘     │
                                                              │
         MongoDB (searchaicontent) + OpenSearch/Qdrant       │
         └──────────────────────────────────────────────────┘
```

---

## Architecture Components

### 1. **SearchAI SDK** (`packages/search-ai-sdk`)

**Purpose:** Type-safe HTTP client for SearchAI Runtime and Engine APIs

**Key Exports:**

- `SearchAIClient` — Main client class
- Query types: `VectorSearchQuery`, `StructuredSearchQuery`, `AggregationQuery`
- Response types: `SearchResponse`, `AggregationResponse`, `VocabularyResolutionResult`
- `SearchError` — Typed error handling

**Usage:**

```typescript
const client = new SearchAIClient({
  runtimeUrl: 'http://localhost:3004',
  engineUrl: 'http://localhost:3005',
  authToken: session.authToken,
  timeoutMs: 30000,
});

// Unified search (all query types)
const results = await client.unifiedSearch(indexId, {
  query: 'user query',
  queryType: 'hybrid',
  topK: 10,
  rerank: true,
});

// Discovery (KB capabilities)
const manifest = await client.discover(indexId);
```

---

### 2. **SearchAIToolHandler** (`apps/runtime/src/services/search-ai/search-ai-tool-handler.ts`)

**Purpose:** Translates explicit search tool calls into SearchAIClient API calls

**Supported Tools:**

- `search_vector` — Semantic search
- `search_structured` — Metadata-filtered search
- `search_aggregate` — Aggregation queries (count, sum, avg, etc.)
- `search_hybrid` — Combined semantic + keyword search with reranking
- `vocabulary_resolve` — Domain vocabulary resolution

**Flow:**

```typescript
agent → search_vector({query, index_id, top_k})
  → SearchAIToolHandler.execute('search_vector', params)
  → SearchAIClient.vectorSearch(query)
  → SearchAI Runtime /api/search/:indexId/query
  → Format results for LLM
  → Return to agent
```

**Key Logic:**

- Parameter normalization (snake_case → camelCase)
- Type coercion (strings to numbers, booleans)
- Filter validation
- Result formatting (strips internal fields, keeps `documentId`, `chunkId`, `score`, `content`, `metadata`)

---

### 3. **SearchAIKBToolExecutor** (`apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`)

**Purpose:** KB-as-Tool pattern — each knowledge base becomes a tool with dynamic capabilities

**Lifecycle:**

1. **Registration:** Tool bindings registered at session start via `registerBinding(toolName, indexId)`
2. **Discovery (deferred):** On first call, fetches `/discover` manifest
3. **Description Building:** `buildToolDescription()` converts manifest → LLM-readable tool description
4. **Caching:** Manifest cached for 5 minutes per indexId
5. **Callback:** `setDescriptionCallback()` updates `session._effectiveConfig.tools[].description` dynamically

**Discovery Manifest Structure:**

```typescript
{
  kb: {
    name: "HR Policies KB",
    documentCount: 1234,
    lastUpdated: "2026-03-15T10:00:00Z"
  },
  capabilities: {
    vocabulary: {
      available: true,
      terms: [
        { term: "PTO", field: "leave_type", aliases: ["paid time off", "vacation"] }
      ]
    },
    queryClassification: {
      available: true,
      types: { factual: "...", navigational: "...", procedural: "..." }
    },
    filters: {
      available: true,
      fields: [
        { name: "department", type: "string", sortable: true, values: ["HR", "IT", "Finance"] }
      ]
    },
    aggregation: { available: true, functions: ["count", "sum", "avg"] },
    reranking: { available: true },
    preprocessing: { available: true }
  }
}
```

**Execution:**

```typescript
agent → my_hr_kb({query: "PTO policy"})
  → SearchAIKBToolExecutor.execute('my_hr_kb', {query})
  → ensureDiscovery() (first call only)
  → SearchAIClient.unifiedSearch(indexId, {query, queryType: 'hybrid'})
  → SearchAI Runtime /api/search/:indexId/query
  → Format results
  → Return to agent
```

---

### 4. **SearchAIAwareToolExecutor** (`apps/runtime/src/services/search-ai/search-ai-tool-executor.ts`)

**Purpose:** Wrapper around base `ToolBindingExecutor` that intercepts search-related tools

**Routing Logic:**

```typescript
if (isSearchAITool(toolName)) {
  // search_vector, search_structured, etc.
  return searchHandler.execute(toolName, params);
} else if (isAttachmentTool(toolName)) {
  return attachmentExecutor.execute(toolName, params);
} else {
  // http, mcp, sandbox, connector tools
  return innerExecutor.execute(toolName, params, timeoutMs);
}
```

**Features:**

- Parallel execution support (`executeParallel`)
- Circuit breaker integration (`SearchAICircuitBreaker`)
- Timeout management
- Error formatting

**Circuit Breaker Integration:**

The `SearchAICircuitBreaker` (when `tenantId` is provided) protects against cascading failures:

- **Failure threshold:** 5 failures within 60 seconds
- **Open state:** All requests fail fast for 30 seconds (no calls to SearchAI)
- **Half-open state:** After 30s, allow 1 test request
- **Success:** Close circuit, resume normal operation
- **Failure:** Open again for another 30s

**File:** `apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts`

---

### 5. **LLMWiringService** (`apps/runtime/src/services/execution/llm-wiring.ts`)

**Purpose:** Orchestrates all tool executors at session initialization

**Key Method:** `wireToolExecutor(session, compilationOutput, authToken, tenantId, projectId, trace)`

**Wiring Sequence:**

1. **Tool Collection:** Extract all tools from compiled agent IR
2. **Deduplication:** First definition wins for duplicate tool names
3. **Type Filtering:** Group tools by type (http, mcp, sandbox, searchai, connector)
4. **Executor Creation:**
   - HTTP/MCP/Sandbox → `ToolBindingExecutor`
   - SearchAI → `SearchAIKBToolExecutor` (if type: 'searchai' tools exist)
   - Connector → `ConnectorToolExecutor` (lazy-init wrapper)
5. **Wrapping:** Wrap in `SearchAIAwareToolExecutor` if any search tools present
6. **Middleware:** Add logging, audit, secret scrubbing, secret validation
7. **Session Attachment:** `session.toolExecutor = executor`

**SearchAI Wiring (lines 584-618):**

```typescript
let searchaiToolExecutor: SearchAIKBToolExecutor | undefined;
const searchaiTools = allTools.filter((t) => t.tool_type === 'searchai');
if (searchaiTools.length > 0) {
  searchaiToolExecutor = new SearchAIKBToolExecutor({
    runtimeUrl: process.env.SEARCH_AI_RUNTIME_URL || '',
    authToken,
    searchTimeoutMs: 30000,
    discoveryTimeoutMs: 5000,
  });

  // Register bindings
  for (const tool of searchaiTools) {
    if (tool.searchai_binding) {
      searchaiToolExecutor.registerBinding(tool.name, tool.searchai_binding);
    }
  }

  // Set callback to update tool descriptions dynamically
  searchaiToolExecutor.setDescriptionCallback((toolName, description) => {
    const tool = session._effectiveConfig.tools.find((t) => t.name === toolName);
    if (tool) tool.description = description;
  });
}

// Pass to ToolBindingExecutor
const baseExecutor = new ToolBindingExecutor({
  tools: allTools,
  searchaiToolExecutor,
  // ... other executors
});
```

---

## Integration Patterns

### Pattern 1: Explicit Search Tools

**Use Case:** Developer explicitly adds search primitives to agent tools

**DSL Example:**

```typescript
tool search_vector(query: string, index_id: string, top_k?: number) -> SearchResult[]
  @http
  method: POST
  url: ${SEARCH_AI_RUNTIME_URL}/api/search/${index_id}/query
  auth: bearer ${AUTH_TOKEN}
```

**Agent Config:**

```typescript
agent CustomerSupportAgent {
  tools: [
    search_vector,
    search_structured,
    search_hybrid
  ]
}
```

**Runtime Behavior:**

- Tools are static — defined at compile time
- No discovery — agent must know exact parameters
- Low-level control — developer specifies queryType, filters, rerank flags

---

### Pattern 2: KB-as-Tool (Dynamic Discovery)

**Use Case:** Knowledge base exposed as autonomous tool with self-describing capabilities

**DSL Example:**

```typescript
tool hr_policies_kb(query: string, queryType?: string, filters?: Filter[], topK?: number) -> SearchResult[]
  @searchai
  indexId: 67f9a8b0c1d2e3f4a5b6c7d8
```

**Agent Config:**

```typescript
agent HRAssistant {
  tools: [hr_policies_kb, employee_handbook_kb]
}
```

**Runtime Behavior:**

1. **Session Start:** Tool registered with `searchai_binding.indexId`
2. **First Call:** Discovery fetches manifest, builds description
3. **Dynamic Description:** Tool description updated with:
   - Document count, last updated timestamp
   - Available vocabulary terms + aliases
   - Filter fields + types + enums
   - Query classification types
   - Aggregation functions
   - Reranking availability
4. **Autonomous Decisions:** Agent reads description and makes context-aware decisions:
   - Use vocabulary resolution for domain terms
   - Apply filters based on available fields
   - Choose queryType (hybrid, structured, aggregate) based on intent

**Example Generated Description:**

```
Search the "HR Policies KB" knowledge base (1,234 documents, updated 2h ago).
Comprehensive HR policies, procedures, and guidelines for all employees.

VOCABULARY (available, 15 terms):
- "PTO" (aliases: paid time off, vacation) → field: leave_type [Annual, Sick, Personal]
- "benefits enrollment" → field: topic [Health, Dental, 401k]
...

FILTERS (available, 8 fields):
- department (string, sortable): HR, IT, Finance, Sales, Marketing
- effective_date (date, sortable)
- policy_status (string): Active, Draft, Archived
...

AGGREGATION (available):
Count, sum, avg, min, max. Use for questions like "how many policies by department?"

RERANKING (available):
Cross-encoder reranking for improved relevance. Enabled by default for hybrid search.
```

---

## Runtime Flow

### Full Request Flow (KB-as-Tool)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. User Message: "What's the PTO policy for engineers?"             │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. RuntimeExecutor.handleMessage()                                   │
│    • session.llmClient.chat([...messages, userMessage])             │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. SessionLLMClient (via ModelResolutionService)                    │
│    • Resolve model credentials                                       │
│    • Build provider-specific client (Bedrock, Azure, OpenAI)        │
│    • Send request with tool definitions                              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. LLM Response                                                       │
│    {                                                                  │
│      "role": "assistant",                                            │
│      "tool_calls": [{                                                │
│        "name": "hr_policies_kb",                                     │
│        "arguments": {                                                │
│          "query": "PTO policy engineers",                            │
│          "filters": [{"field": "department", "operator": "eq",       │
│                      "value": "Engineering"}]                        │
│        }                                                             │
│      }]                                                              │
│    }                                                                  │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. RuntimeExecutor.executeTool()                                     │
│    • session.toolExecutor.execute('hr_policies_kb', params, timeout)│
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. SearchAIAwareToolExecutor                                         │
│    • NOT isSearchAITool('hr_policies_kb') → pass to inner           │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 7. ToolBindingExecutor                                               │
│    • Lookup tool by name → tool_type: 'searchai'                    │
│    • Delegate to searchaiToolExecutor                                │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 8. SearchAIKBToolExecutor.execute('hr_policies_kb', params)         │
│    • Lookup binding → indexId: 67f9a8b0c1d2e3f4a5b6c7d8             │
│    • ensureDiscovery(toolName, indexId)                              │
│      - Check cache (5min TTL)                                        │
│      - If miss: client.discover(indexId)                             │
│      - buildToolDescription(manifest)                                │
│      - Cache + callback to update session._effectiveConfig           │
│    • executeSearch(indexId, params)                                  │
│      - Build unified search request                                  │
│      - client.unifiedSearch(indexId, body)                           │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 9. SearchAIClient.unifiedSearch(indexId, body)                      │
│    • POST ${runtimeUrl}/api/search/${indexId}/query                 │
│    • Headers: { Authorization: Bearer ${authToken} }                │
│    • Body: { query, filters, queryType, topK, rerank }              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 10. SearchAI Runtime (apps/search-ai-runtime)                       │
│     • Query pipeline orchestration                                   │
│     • Vocabulary resolution (if not skipped)                         │
│     • Preprocessing (if enabled)                                     │
│     • Vector embedding (if semantic/hybrid)                          │
│     • OpenSearch query execution                                     │
│     • Reranking (if enabled)                                         │
│     • Permission filtering                                           │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 11. OpenSearch + MongoDB                                             │
│     • Vector similarity search (Qdrant/OpenSearch kNN)              │
│     • Metadata filtering                                             │
│     • Chunk retrieval                                                │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 12. SearchAI Response                                                │
│     {                                                                 │
│       "queryType": "hybrid",                                         │
│       "results": [                                                   │
│         {                                                            │
│           "documentId": "...",                                       │
│           "chunkId": "...",                                          │
│           "score": 0.92,                                             │
│           "content": "Engineers are entitled to 20 days PTO...",     │
│           "metadata": { "department": "Engineering", ... }           │
│         }                                                            │
│       ],                                                             │
│       "totalCount": 3                                                │
│     }                                                                 │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 13. SearchAIKBToolExecutor.formatResult()                           │
│     • Strip internal fields                                          │
│     • Return { queryType, results, totalCount }                      │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 14. Middleware Chain (reverse order)                                │
│     • Secret scrubber: Strip leaked tokens from results             │
│     • Audit logger: Log tool execution                               │
│     • Logging middleware: Emit trace events                          │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 15. RuntimeExecutor.handleMessage() (continued)                      │
│     • Append tool result to conversation                             │
│     • Call LLM again with tool results                               │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 16. LLM Final Response                                               │
│     {                                                                 │
│       "role": "assistant",                                           │
│       "content": "Engineers are entitled to 20 days of PTO per year. │
│                   This includes vacation, sick leave, and personal   │
│                   time. Details can be found in the Employee         │
│                   Handbook section 4.2."                             │
│     }                                                                 │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 17. Return to User                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Tool Execution Paths

### Path 1: Explicit Search Tool (search_vector)

```
Agent calls search_vector({query, index_id, top_k})
  ↓
SearchAIAwareToolExecutor.execute()
  ↓
isSearchAITool('search_vector') → true
  ↓
SearchAIToolHandler.execute('search_vector', params)
  ↓
searchVector(params)
  - Validate: indexId, query required
  - Build VectorSearchQuery object
  - client.vectorSearch(query)
  ↓
SearchAIClient.vectorSearch()
  - POST /api/search/${indexId}/query
  ↓
formatSearchResponse()
  - Strip internal fields
  - Return {results, totalCount, latencyMs}
  ↓
Return to agent
```

### Path 2: KB-as-Tool (my_kb)

```
Agent calls my_kb({query, filters})
  ↓
SearchAIAwareToolExecutor.execute()
  ↓
NOT isSearchAITool('my_kb') → pass to inner
  ↓
ToolBindingExecutor.execute()
  ↓
Lookup tool → tool_type: 'searchai'
  ↓
searchaiToolExecutor.execute('my_kb', params)
  ↓
SearchAIKBToolExecutor.execute()
  - Lookup binding → indexId
  - ensureDiscovery(toolName, indexId)
    • Check cache (5min TTL)
    • If miss: client.discover(indexId) → manifest
    • buildToolDescription(manifest)
    • Cache manifest + description
    • Callback: update session._effectiveConfig.tools[].description
  - executeSearch(indexId, params)
    • Translate params to unified search body
    • client.unifiedSearch(indexId, body)
  ↓
SearchAIClient.unifiedSearch()
  - POST /api/search/${indexId}/query
  ↓
formatResult()
  - Strip internal fields
  - Return {queryType, results, totalCount}
  ↓
Return to agent
```

---

## Key Files Reference

### Runtime (apps/runtime/src)

| File                                              | Purpose                     | Key Exports                                                       |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `services/search-ai/search-ai-tool-handler.ts`    | Explicit search tools       | `SearchAIToolHandler`, `SEARCH_AI_TOOL_NAMES`, `isSearchAITool()` |
| `services/search-ai/searchai-kb-tool-executor.ts` | KB-as-Tool executor         | `SearchAIKBToolExecutor`                                          |
| `services/search-ai/search-ai-tool-executor.ts`   | Wrapper executor            | `SearchAIAwareToolExecutor`                                       |
| `services/search-ai/description-builder.ts`       | Discovery → LLM description | `buildToolDescription()`                                          |
| `services/search-ai/search-ai-circuit-breaker.ts` | Resilience                  | `SearchAICircuitBreaker`                                          |
| `services/execution/llm-wiring.ts`                | Tool executor wiring        | `LLMWiringService.wireToolExecutor()`                             |
| `tools/load-project-tools-as-ir.ts`               | Tool loading                | `loadProjectToolsAsIR()`                                          |

### SearchAI SDK (packages/search-ai-sdk/src)

| File                    | Purpose        | Key Exports                                                           |
| ----------------------- | -------------- | --------------------------------------------------------------------- |
| `client.ts`             | HTTP client    | `SearchAIClient`, `SearchAIClientConfig`                              |
| `types/search-query.ts` | Query types    | `VectorSearchQuery`, `StructuredSearchQuery`, `AggregationQuery`      |
| `types/index.ts`        | Response types | `SearchResponse`, `AggregationResponse`, `VocabularyResolutionResult` |
| `errors.ts`             | Error handling | `SearchError`                                                         |

### SearchAI Runtime (apps/search-ai-runtime/src)

| Endpoint                               | Purpose                          | Handler                |
| -------------------------------------- | -------------------------------- | ---------------------- |
| `POST /api/search/:indexId/query`      | Unified search (all query types) | `routes/query.ts`      |
| `GET /api/search/:indexId/discover`    | KB capability manifest           | `routes/query.ts`      |
| `POST /api/search/:indexId/resolve`    | Vocabulary resolution            | `routes/resolve.ts`    |
| `POST /api/search/:indexId/structured` | Structured search                | `routes/structured.ts` |
| `POST /api/search/:indexId/aggregate`  | Aggregation queries              | `routes/aggregate.ts`  |
| `POST /api/search/:indexId/suggest`    | Autocomplete                     | `routes/suggest.ts`    |
| `POST /api/search/:indexId/similar`    | Find similar documents           | `routes/similar.ts`    |

### SearchAI Engine (apps/search-ai/src)

| Endpoint                  | Purpose               | Handler                |
| ------------------------- | --------------------- | ---------------------- |
| `GET /api/indexes`        | List indexes          | `routes/indexes.ts`    |
| `POST /api/indexes`       | Create index          | `routes/indexes.ts`    |
| `GET /api/indexes/:id`    | Get index details     | `routes/indexes.ts`    |
| `PATCH /api/indexes/:id`  | Update index          | `routes/indexes.ts`    |
| `DELETE /api/indexes/:id` | Delete index          | `routes/indexes.ts`    |
| `GET /api/sources`        | List sources          | `routes/sources.ts`    |
| `GET /api/schemas`        | List schemas          | `routes/schemas.ts`    |
| `GET /api/vocabulary`     | Vocabulary management | `routes/vocabulary.ts` |

---

## Context-Aware Search

SearchAI KB tools are context-aware by default — no agent configuration required.
Three mechanisms work together to ensure accurate multi-turn search interactions:

### 1. Multi-Turn Query Guidance (Description-Level)

Every SearchAI tool description includes `MULTI-TURN QUERY RULES` that instruct the agent LLM to:

- Carry forward filters from prior search calls in follow-up queries
- Never send queries that require context the search engine does not have
- Include conversation context when references are ambiguous

This is the **primary mechanism** — the agent LLM constructs both query text and filters
correctly because it has full conversation history and vocabulary terms from the discovery manifest.

### 2. Query + Filter Enrichment Safety Net (Executor-Level)

When the agent LLM loses context due to conversation compaction, a fallback enrichment
step runs inside `SearchAIKBToolExecutor.executeSearch()`. It triggers **only when the
LLM sent no filters** — a signal that context was lost:

```
LLM constructs tool call → Executor intercepts
  ├─ Filters present from step 1?
  │   YES → Skip enrichment (LLM had context, did its job)
  │   NO  → Call LLM with conversation context + vocabulary from discovery
  │         LLM returns JSON: { query: "...", filters: [...] }
  │         Set skipPreprocessing + skipVocabularyResolution (ABL owns it)
  ├─ Execute SearchAI search
  └─ Return results
```

- Only fires when filters are **empty** — avoids redundant LLM calls
- Uses vocabulary terms and filter fields from the cached discovery manifest
- Produces both rephrased query AND structured filters in one LLM call
- ABL controls the full search construction — SearchAI skips its own processing
- Non-fatal: enrichment failure falls back to the original query

### 3. Result Summarization (Platform-Level)

Tool result summarization applies to **all tool types** (not just SearchAI) via the
reasoning executor's `CompactionPolicy`. When a tool result exceeds the structured
threshold (~10K chars) and the session has an LLM client:

```
Tool returns result → Reasoning executor checks CompactionPolicy
  ├─ strategy: 'summarize' AND result > structured_threshold?
  │   YES → Call LLM to summarize into concise answer
  │         Returns: { _summarized: true, summary: "...", _originalSize: N }
  │   NO  → Apply structural compression (strip fields, truncate)
  └─ Result enters conversation history
```

- Default strategy is `'summarize'` — works for all tools out of the box
- Falls back to structural compression if LLM is unavailable or fails
- Non-fatal: summarization failure uses structured compression fallback

### Configuration

All features use **platform defaults** — zero agent configuration needed.
DSL overrides are available for customization:

| Setting                  | Default                      | Override via DSL                                  |
| ------------------------ | ---------------------------- | ------------------------------------------------- |
| Context-aware enrichment | ON for all SearchAI KB tools | Future: `context_aware: false` per tool           |
| Max conversation turns   | 3 (last 6 messages)          | Future: `context_turns: N` per tool               |
| Result summarization     | ON (`strategy: 'summarize'`) | `compaction.tool_results.strategy: 'structured'`  |
| Summarization prompt     | Platform default             | `compaction.tool_results.summarize_prompt: "..."` |
| Structural threshold     | 10,000 chars                 | `compaction.tool_results.structured_threshold: N` |

Configuration resolves via 3-tier merge: **Platform defaults → Project config → Agent IR**.

### Key Files

| File                           | Role                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `description-builder.ts`       | Adds MULTI-TURN QUERY RULES to tool descriptions                    |
| `searchai-kb-tool-executor.ts` | Query + filter enrichment using vocabulary from discovery           |
| `llm-wiring.ts`                | Wires conversation context and LLM function to executor             |
| `tool-result-compressor.ts`    | Exported `summarizeToolResult()` — LLM-powered result summarization |
| `reasoning-executor.ts`        | Calls summarization for all tools via CompactionPolicy              |
| `compaction-policy.ts`         | Default strategy `'summarize'`, 3-tier merge resolution             |
| `schema.ts` (IR)               | `summarize_prompt` field in `ToolResultCompactionConfig`            |

---

## Enhancement Opportunities

### 1. **Streaming Search Results**

**Current:** Search results returned as single batch after query completes

**Enhancement:** Stream chunks as they arrive from OpenSearch/Qdrant

**Benefits:**

- Lower time-to-first-token (TTFT) for agent responses
- Progressive refinement — agent can start reasoning with top results before full set arrives
- Better UX for large result sets

**Implementation:**

- SearchAI Runtime: Add SSE endpoint `/api/search/:indexId/stream`
- SearchAIClient: Add `streamUnifiedSearch()` with async iterator
- SearchAIKBToolExecutor: Add `executeStream()` method
- Agent DSL: Support `@streaming` annotation on searchai tools

---

### 2. **Query Optimization Feedback Loop**

**Current:** No visibility into which queries succeed/fail or performance bottlenecks

**Enhancement:** Agent-level search analytics

**Metrics to Track:**

- Query latency by queryType (vector, structured, hybrid, aggregate)
- Cache hit rates (vocabulary, preprocessing, embeddings)
- Reranking impact (score delta before/after)
- Zero-result queries (track for vocabulary improvement)
- Token usage (embedding API calls)

**Storage:** ClickHouse via AuditStore (already wired in middleware)

**UI:** Studio → Analytics → SearchAI tab showing:

- Top queries by agent/session
- Slow queries (>2s)
- Failed queries with error types
- Vocabulary coverage gaps

---

### 3. **Multi-Index Search**

**Current:** One tool per index — agent must call multiple tools to search across KBs

**Enhancement:** Federated search across multiple indexes

**Use Cases:**

- "Search both HR policies AND employee handbook"
- Cross-functional queries spanning multiple domains
- Multi-tenant searches (with proper isolation)

**Implementation:**

- Add `multi_index_search` tool type
- SearchAIKBToolExecutor: Support `indexIds: string[]` in binding
- SearchAI Runtime: Add `/api/search/multi` endpoint with parallel query execution
- Merge results with score normalization across indexes

---

### 4. **Semantic Caching**

**Current:** Every query hits OpenSearch/Qdrant even for similar queries

**Enhancement:** Cache semantically similar queries

**Pattern:**

1. Embed incoming query
2. Check Redis vector cache for similar embeddings (cosine > 0.95)
3. If hit: return cached results (update TTL)
4. If miss: execute query, cache result with embedding

**Benefits:**

- 10-50x latency reduction for repeated queries
- Cost savings on embedding + vector search

**Storage:** Redis with RediSearch vector index

---

### 5. **Query Rewriting with LLM**

**Current:** Query preprocessing is rule-based (vocabulary resolution)

**Enhancement:** LLM-based query expansion and intent detection

**Flow:**

```
User query: "pto for devs"
  ↓
LLM rewrite: "paid time off policy for software engineers"
  ↓
Vocabulary resolution: "paid time off" → leave_type:PTO
  ↓
Filter expansion: department:Engineering
  ↓
Execute hybrid search
```

**Benefits:**

- Better handling of colloquial language
- Intent detection (factual vs. procedural vs. navigational)
- Query expansion for better recall

**Implementation:**

- Add `queryLLMConfig` to SearchIndex model (already exists!)
- SearchAI Runtime: Call LLM before vocabulary resolution
- Model: Fast, cheap model (Claude Haiku, GPT-4o-mini)

---

### 6. **Tool Result Truncation Strategy**

**Current:** All search results returned to LLM (context window risk)

**Enhancement:** Smart truncation based on agent's task

**Strategies:**

- **Top-K only:** Return top 3-5 results (configurable)
- **Progressive disclosure:** Return summaries with "fetch more" tool
- **Score threshold:** Only return results above confidence threshold
- **Token budget:** Truncate content to fit within token limit

**Configuration:**

```typescript
tool my_kb(query: string) -> SearchResult[]
  @searchai
  indexId: ...
  maxResults: 5
  minScore: 0.7
  maxTokensPerResult: 500
```

---

### 7. **Hybrid Executor + Direct Tool Pattern**

**Current:** Either explicit tools OR KB-as-tool, not both

**Enhancement:** Allow agents to use both patterns simultaneously

**Use Case:**

- High-level: Use `my_kb` tool for autonomous search
- Low-level: Use `search_aggregate` for specific analytics queries

**Implementation:**

- SearchAIAwareToolExecutor already supports both via `isSearchAITool()` check
- Need to ensure explicit tools can target same indexId as KB-as-tool
- Avoid duplicate discovery calls (share cache between executors)

---

### 8. **Discovery Manifest Versioning**

**Current:** Discovery manifest cached for 5 minutes, no versioning

**Enhancement:** Versioned manifests with change notifications

**Pattern:**

- SearchIndex model: Add `manifestVersion` field (increment on vocab/schema changes)
- SearchAI Runtime: Include `ETag` header in `/discover` response
- SearchAIKBToolExecutor: Send `If-None-Match` on cache refresh
- 304 Not Modified → keep cached manifest, update TTL

**Benefits:**

- Reduce discovery traffic
- Consistent tool descriptions within session (no mid-session description changes)

---

### 9. **Error Recovery Strategies**

**Current:** Search failures bubble up as generic errors

**Enhancement:** Typed error handling with fallback strategies

**Error Types:**

- `IndexNotFoundError` → Suggest similar indexes
- `VocabularyResolutionError` → Retry with `skipVocabularyResolution: true`
- `EmbeddingTimeoutError` → Fall back to keyword-only search
- `PermissionDeniedError` → Return 404 (don't leak existence)

**Implementation:**

- SearchAIClient: Throw typed `SearchError` subclasses
- SearchAIKBToolExecutor: Catch + retry with fallback strategy
- Emit trace events for fallback usage (analytics)

---

### 10. **Agent-Driven Index Selection**

**Current:** Developer hard-codes indexId in tool binding

**Enhancement:** Agent autonomously selects best index for query

**Pattern:**

1. Define multiple KBs as tools
2. Agent reads all discovery manifests
3. LLM selects best KB based on:
   - Document count in relevant domain
   - Vocabulary coverage (term matches)
   - Last updated timestamp (freshness)
4. Tool routing: Agent calls selected KB

**Alternative (Meta-Tool):**

```typescript
tool search_knowledge(query: string, domain?: string) -> SearchResult[]
  @meta_searchai
  indexes: [hr_kb, it_kb, finance_kb]
  // Runtime resolves best index based on domain or content
```

**Benefits:**

- Simpler agent configs (no need to know all KBs upfront)
- Dynamic KB addition without agent recompilation

---

## Testing Strategy

### Unit Tests

- **SearchAIToolHandler:** Parameter normalization, error handling
- **SearchAIKBToolExecutor:** Discovery caching, description building, binding lookup
- **SearchAIAwareToolExecutor:** Routing logic, parallel execution
- **buildToolDescription:** Manifest → LLM description conversion

**Existing:**

- `apps/runtime/src/services/search-ai/__tests__/search-ai-tool-executor.test.ts`
- `apps/runtime/src/services/search-ai/__tests__/searchai-kb-tool-executor.test.ts`

### Integration Tests

- **Discovery API:** Manifest structure, vocabulary filtering, capability guidance
- **Unified Search:** All query types (vector, structured, hybrid, aggregate)
- **Vocabulary Resolution:** Exact, alias, fuzzy matching
- **Fresh KB Search:** End-to-end with real MongoDB + OpenSearch

**Existing:** `apps/runtime/src/__tests__/e2e/searchai/`

- `01-discovery-api.e2e.test.ts`
- `02-hybrid-search.e2e.test.ts`
- `03-structured-search.e2e.test.ts`
- `04-semantic-search.e2e.test.ts`
- `05-vocabulary-resolution.e2e.test.ts`
- `06-kb-tool-executor.e2e.test.ts`
- `07-fresh-kb-search.e2e.test.ts`
- `08-aggregation-search.e2e.test.ts`
- `09-agent-adaptive-search.e2e.test.ts`
- `10-developer-wiring.e2e.test.ts`

### E2E Tests

- **Agent + SearchAI:** Full agent conversation using KB-as-tool
- **Multi-Turn:** Agent uses search results to ask follow-up questions
- **Circuit Breaker:** Graceful degradation on SearchAI service failure

**Existing:** `apps/runtime/src/__tests__/searchai-kb-agent-e2e.test.ts`

---

## Configuration

### Environment Variables

```bash
# SearchAI Runtime URL (used by agents)
SEARCH_AI_RUNTIME_URL=http://localhost:3004

# SearchAI Engine URL (admin operations)
SEARCH_AI_ENGINE_URL=http://localhost:3005

# MongoDB connection (shared with platform)
MONGO_URI=mongodb://localhost:27017

# OpenSearch/Qdrant URLs (managed by SearchAI)
OPENSEARCH_URL=http://localhost:9200
QDRANT_URL=http://localhost:6333

# Redis (caching, BullMQ)
REDIS_URL=redis://localhost:6379
```

### SearchAI Client Config

```typescript
const client = new SearchAIClient({
  runtimeUrl: process.env.SEARCH_AI_RUNTIME_URL!,
  engineUrl: process.env.SEARCH_AI_ENGINE_URL!,
  authToken: session.authToken,
  timeoutMs: 30000, // 30s default
  headers: {
    'X-Tenant-ID': tenantId,
    'X-User-ID': userId,
  },
});
```

### Tool Executor Config

```typescript
const searchaiExecutor = new SearchAIKBToolExecutor({
  runtimeUrl: process.env.SEARCH_AI_RUNTIME_URL!,
  authToken: session.authToken,
  searchTimeoutMs: 30000, // Search query timeout
  discoveryTimeoutMs: 5000, // Discovery manifest timeout
});
```

### Authentication Flow

```
User Session (JWT)
  ↓
Runtime extracts authToken
  ↓
SearchAIClient({ authToken })
  ↓
HTTP Header: Authorization: Bearer ${authToken}
  ↓
SearchAI Runtime validates JWT
  ↓
Permission filter applied (Stage 0)
```

**Token Propagation:**

1. User authenticates with ABL platform (JWT issued)
2. Runtime session stores `authToken`
3. `LLMWiringService.wireToolExecutor()` passes `authToken` to `SearchAIKBToolExecutor`
4. `SearchAIClient` includes token in all HTTP requests
5. SearchAI Runtime validates token using shared secret
6. User's permissions enforced via permission filter (Neo4j + Redis cache)

**Security:**

- Tokens are not logged or cached by SearchAI SDK
- HTTPS required in production
- Token expiration handled by Runtime (refresh logic)

---

## Troubleshooting

### Common Issues

**1. Tool Not Found Error**

```
Error: SearchAI KB tool "my_kb" has no registered binding
```

**Cause:** Tool binding not registered in `wireToolExecutor()`

**Fix:** Ensure tool has `tool_type: 'searchai'` and `searchai_binding.indexId` in IR

---

**2. Discovery Timeout**

```
Error: Discovery API timeout after 5000ms
```

**Cause:** SearchAI Runtime slow/down, MongoDB query slow

**Fix:**

- Check SearchAI Runtime health: `curl http://localhost:3004/health`
- Check MongoDB connection: `mongo --eval "db.serverStatus()"`
- Increase `discoveryTimeoutMs` if network latency is high

---

**3. Empty Results from KB Search**

**Causes:**

- No documents in index (`documentCount: 0`)
- Query doesn't match any content
- Filters too restrictive
- Embedding model mismatch

**Debug:**

1. Check index status: `GET /api/indexes/:indexId`
2. Try direct OpenSearch query via SearchAI Runtime
3. Check vocabulary resolution: `POST /api/search/:indexId/resolve`
4. Inspect embedding dimensions (should match model)

---

**4. Circuit Breaker Open**

```
Error: Circuit breaker OPEN for tenant abc123 tool search_vector
```

**Cause:** Repeated failures triggered circuit breaker (5 failures in 60s)

**Fix:**

- Investigate root cause via SearchAI logs
- Wait for half-open state (30s) for automatic retry
- Reset manually: `SearchAICircuitBreaker.reset(tenantId)`

---

## Related Documentation

- [SearchAI Architecture](./design/QUERY-PIPELINE-DESIGN.md)
- [SearchAI Retrieval API](./RETRIEVAL-API.md)
- [SearchAI Discovery API](./ADMIN-API-REFERENCE.md)
- [BullMQ Flows Production Guide](./BULLMQ-FLOWS-PRODUCTION-GUIDE.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Tool DSL Reference](../guides/TOOL-DSL-GUIDE.md)

---

## How This Document Relates to Others

**If you want to understand:**

- **How agents get search capabilities** → Read this document (ABL-SEARCHAI-INTEGRATION.md)
- **What happens inside SearchAI during a query** → Read [QUERY-PIPELINE-DESIGN.md](./design/QUERY-PIPELINE-DESIGN.md)
- **How documents are ingested** → Read [INGESTION-PIPELINE-GUIDE.md](./design/INGESTION-PIPELINE-GUIDE.md)
- **How vocabulary resolution works** → Read [QUERY-PIPELINE-DESIGN.md](./design/QUERY-PIPELINE-DESIGN.md) Act III, Scene 11
- **SearchAI API reference** → Read [RETRIEVAL-API.md](./RETRIEVAL-API.md)

**Coverage map:**

```
User Query
  ↓
[Runtime wiring] ← **THIS DOCUMENT**
  ↓
[Tool execution] ← **THIS DOCUMENT**
  ↓
[SearchAI SDK] ← **THIS DOCUMENT**
  ↓
[Query pipeline] ← **QUERY-PIPELINE-DESIGN.md**
  ↓
Results
```

---

## Changelog

| Date       | Author   | Changes                                                            |
| ---------- | -------- | ------------------------------------------------------------------ |
| 2026-03-16 | ABL Team | Initial documentation                                              |
| 2026-03-16 | ABL Team | Add Context-Aware Search section (query enrichment, summarization) |
| 2026-03-16 | ABL Team | Enrichment now produces query + filters using discovery vocabulary |
| 2026-03-16 | ABL Team | Move result summarization to reasoning executor (all tool types)   |
| 2026-03-16 | ABL Team | Add DSL-customizable summarize_prompt in CompactionPolicy          |
