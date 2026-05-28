# RFC: Schema Mapping & Retrieval Strategy Architecture

> Field mapping, canonical schemas, domain vocabularies, and retrieval strategy agents for Search AI
> Extends [RFC-FUTURE-ARCHITECTURE.md](./searchai/rfcs/RFC-FUTURE-ARCHITECTURE.md)

**Status:** Draft / RFC
**Authors:** Architecture Team
**Last Updated:** 2026-02-16

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Query Archetypes](#2-query-archetypes)
3. [Three-Layer Schema Architecture](#3-three-layer-schema-architecture)
4. [Layer 1: Source Schema Discovery](#4-layer-1-source-schema-discovery)
5. [Layer 2: Canonical Schema Mapping](#5-layer-2-canonical-schema-mapping)
6. [Layer 3: Domain Vocabulary](#6-layer-3-domain-vocabulary)
7. [Query Resolution Flow](#7-query-resolution-flow)
8. [Retrieval Strategy Agents](#8-retrieval-strategy-agents)
9. [Agent DSL Integration](#9-agent-dsl-integration)
10. [Curation Workflow](#10-curation-workflow)
11. [Data Model (Prisma Schema)](#11-data-model-prisma-schema)
12. [MCP Tool Surface](#12-mcp-tool-surface)
13. [Integration with Existing Architecture](#13-integration-with-existing-architecture)
14. [Phased Delivery](#14-phased-delivery)

---

## 1. Problem Statement

Search AI connects to heterogeneous source systems (Jira, Salesforce, HubSpot, Confluence, ServiceNow, etc.) where the same business concept maps to different field names, values, and structures across systems. An agent cannot reliably translate user intent into source-system queries without structured field mappings.

### The Field Mapping Problem

**"Author" in Jira** could refer to:

- `reporter` (who filed the issue)
- `assignee` (who is working on it)
- `creator` (API-level creator)
- A custom field `customfield_10042` (labeled "Document Author")

**"Closed deals" in HubSpot** could mean:

- `dealstage = closedwon` (deals won)
- `dealstage = closedlost` (deals lost)
- `dealstage IN (closedwon, closedlost)` (all closed deals)
- `hs_is_closed = true` (system flag)
- A pipeline-specific stage like `closedbypartner`

**"Revenue this quarter" in Salesforce** requires knowing:

- `Amount` vs `TotalPrice` vs `AnnualContractValue` (which field?)
- `CloseDate` vs `CreatedDate` (which date defines "this quarter"?)
- `StageName = 'Closed Won'` (what constitutes counted revenue?)
- Currency conversion fields if multi-currency is enabled

An LLM alone cannot resolve these ambiguities. The mappings are tenant-specific, connector-specific, and often require domain expertise to establish. They must be curated once, stored durably, and applied consistently at query time.

### Why Agents Can't Decide This Automatically

1. **Field names are arbitrary** — Custom fields have system IDs (`customfield_10042`), not semantic labels
2. **Business semantics are contextual** — "closed" means different things in sales vs support vs engineering
3. **Values are enumerated** — The LLM doesn't know that HubSpot's `closedwon` is a valid `dealstage` value
4. **Aggregation requires precision** — "Total revenue" must use the exact right field and filter, not a best-guess
5. **Cross-system joins require alignment** — "Same customer" across Jira and Salesforce requires knowing which fields represent customer identity in each

---

## 2. Query Archetypes

Search AI must support three fundamentally different query patterns, each with different field mapping requirements:

### Archetype 1: List/Filter Queries

> "Get me all 50-inch TVs under $500"
> "Show all open P1 bugs assigned to the platform team"

**Characteristics:**

- Structured filters on specific fields (size, price, status, priority, assignee)
- Results are entity lists, often paginated
- Maps to SQL-like `WHERE` clauses or GraphQL filters over structured metadata
- Requires exact field name resolution and valid value enumeration

**Field mapping needs:** Attribute names → source field paths, value normalization

### Archetype 2: Aggregation Queries

> "What's the total deal value for Q4 in North America?"
> "How many support tickets were resolved last month by category?"

**Characteristics:**

- Numeric aggregation (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`) over filtered datasets
- Requires precise field selection (aggregate the right column)
- Requires precise filter construction (the right date range, the right segment)
- Wrong field or wrong filter = silently wrong answer (worse than no answer)

**Field mapping needs:** Measure fields (what to aggregate), dimension fields (what to group by), filter value vocabularies

### Archetype 3: Semantic/Multi-Hop Knowledge Queries

> "How do I process a refund for an international order?"
> "What's our policy on data retention for EU customers?"

**Characteristics:**

- Unstructured natural language → vector/hybrid retrieval
- May require multi-hop reasoning (retrieve policy → retrieve exception rules → synthesize)
- May involve agentic pre-processing (classify query intent, expand query terms) or post-processing (validate citations, check recency)
- The "classic" RAG pattern, but field mappings still matter for metadata filtering and source attribution

**Field mapping needs:** Metadata field mapping for hybrid retrieval filters, source attribution fields

---

## 3. Three-Layer Schema Architecture

Field mapping is decomposed into three layers, each owned at a different scope and applied at a different time:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Layer 3: Domain Vocabulary              (ProjectKnowledgeBase) │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ "closed deals" → dealstage IN (closedwon, closedlost) │      │
│  │ "revenue"      → Amount WHERE StageName = Closed Won  │      │
│  │ "author"       → reporter (in this project's context) │      │
│  └───────────────────────────────────────────────────────┘      │
│          ↓ applied at: QUERY TIME (vocabulary lookup)           │
│                                                                 │
│  Layer 2: Canonical Schema Mapping             (KnowledgeBase)  │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ canonical.title    ← jira:summary | sf:Subject        │      │
│  │ canonical.status   ← jira:status  | sf:Status         │      │
│  │ canonical.assignee ← jira:assignee.displayName        │      │
│  │ canonical.amount   ← sf:Amount | hs:amount            │      │
│  └───────────────────────────────────────────────────────┘      │
│          ↓ applied at: INGESTION TIME (ETL normalization)       │
│                                                                 │
│  Layer 1: Source Schema Discovery                  (Connector)  │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ jira: summary, status, assignee, reporter, priority,  │      │
│  │       customfield_10042, customfield_10043, ...        │      │
│  │ sf:   Subject, Status, Amount, CloseDate, StageName,  │      │
│  │       Account.Name, ...                                │      │
│  │ hs:   dealname, dealstage, amount, closedate, ...      │      │
│  └───────────────────────────────────────────────────────┘      │
│          ↓ discovered at: CONNECTOR SYNC (auto-introspection)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer                 | Scope                    | When Applied   | Who Curates                                  | Purpose                                             |
| --------------------- | ------------------------ | -------------- | -------------------------------------------- | --------------------------------------------------- |
| **Source Schema**     | Per Connector            | Connector sync | Auto-discovered                              | Raw field inventory from source system              |
| **Canonical Schema**  | Per KnowledgeBase        | Ingestion time | Semi-automatic (LLM-assisted + human review) | Normalize heterogeneous sources into unified fields |
| **Domain Vocabulary** | Per ProjectKnowledgeBase | Query time     | Business users / agent developers            | Map business language to canonical fields + filters |

---

## 4. Layer 1: Source Schema Discovery

### What It Is

When a Connector syncs with a source system, it introspects the source's schema and persists it as a `ConnectorSchema`. This is a raw, uninterpreted inventory of every field the source exposes.

### Discovery Process

```
Connector.sync()
  → API introspection (e.g., Jira GET /rest/api/3/field, Salesforce DESCRIBE)
  → Extract: field name, field type, possible values (for enums), nested paths
  → Persist as ConnectorSchema
  → Flag new/changed/removed fields since last sync
```

### Schema Structure

```typescript
interface ConnectorSchema {
  connectorId: string;
  version: number; // Increments on schema changes
  discoveredAt: Date;
  fields: ConnectorSchemaField[];
}

interface ConnectorSchemaField {
  path: string; // Dot-notation: "assignee.displayName", "customfield_10042"
  type: FieldType; // 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'enum'
  label?: string; // Human-readable label from source (e.g., "Document Author")
  description?: string; // Source-provided description
  enumValues?: string[]; // For enum fields: ["To Do", "In Progress", "Done"]
  isCustom: boolean; // True for custom fields (Jira customfield_*, SF custom objects)
  isRequired: boolean;
  sampleValues?: string[]; // First N distinct values seen during sync
  cardinality?: 'low' | 'medium' | 'high'; // Estimated from sample
  lastSeenAt: Date;
  status: 'active' | 'deprecated'; // Deprecated = not seen in last sync
}

type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'array'
  | 'object'
  | 'enum'
  | 'email'
  | 'url'
  | 'currency';
```

### Built-in Connector Schema Extractors

| Connector Type | Discovery Method                                                            |
| -------------- | --------------------------------------------------------------------------- |
| **Jira**       | `GET /rest/api/3/field` + project-specific custom fields                    |
| **Salesforce** | `DESCRIBE` on each SObject                                                  |
| **HubSpot**    | `GET /crm/v3/properties/{objectType}`                                       |
| **Confluence** | Content properties + space metadata                                         |
| **ServiceNow** | `sys_dictionary` table introspection                                        |
| **Custom**     | Connector author declares schema in `ConnectorDefinition.schemaDiscovery()` |

### Change Detection

Each sync compares the discovered schema against the previous version:

- **New fields** → flagged for canonical mapping review
- **Removed fields** → canonical mappings marked stale
- **Type changes** → canonical mappings flagged for validation
- **New enum values** → vocabulary entries may need updating

---

## 5. Layer 2: Canonical Schema Mapping

### What It Is

A `CanonicalSchema` lives on a KnowledgeBase and defines a unified field namespace that normalizes fields from all connected source systems. Since a KB can receive content from multiple connectors (via ConnectorBindings), canonical mappings provide a single query surface.

### Mapping Structure

```typescript
interface CanonicalSchema {
  knowledgeBaseId: string;
  version: number;
  fields: CanonicalField[];
}

interface CanonicalField {
  name: string; // Canonical name: "title", "status", "assignee", "amount"
  type: FieldType;
  description: string; // What this field represents in the KB's domain
  required: boolean;
  searchable: boolean; // Include in full-text index
  filterable: boolean; // Include in structured filter index
  aggregatable: boolean; // Can be used in aggregation queries
  mappings: SourceFieldMapping[]; // How this maps from each source
}

interface SourceFieldMapping {
  connectorId: string;
  sourcePath: string; // Path in ConnectorSchema: "assignee.displayName"
  transform?: FieldTransform; // Optional value transformation
  confidence: number; // 0-1, from auto-mapping or human confirmation
  status: 'suggested' | 'confirmed' | 'rejected';
}

interface FieldTransform {
  type:
    | 'direct' // Use value as-is
    | 'rename_value' // Map enum values: { "closedwon": "Closed Won" }
    | 'extract' // JSONPath/regex extraction from nested value
    | 'coalesce' // First non-null from multiple source fields
    | 'compute' // Custom expression: "amount * exchangeRate"
    | 'date_format' // Normalize date formats
    | 'lowercase' // Normalize case
    | 'split'; // Split "First Last" into separate fields
  config: Record<string, unknown>; // Transform-specific config
}
```

### Application at Ingestion Time

Canonical mappings are applied during the ingestion pipeline, after extraction but before indexing:

```
Connector.sync()
  → Raw documents extracted
  → Extraction pipeline (parse, chunk)
  → CanonicalMapper stage (applies CanonicalSchema)    ← HERE
      For each chunk/document:
        Read source fields using mapping.sourcePath
        Apply mapping.transform
        Write to canonical field name in chunk.metadata
  → Enrichment pipeline
  → Indexing (vector + structured)
```

This means the canonical fields are **materialized at indexing time** — queries against the KB use canonical field names, never source field names.

### Auto-Mapping with LLM Assistance

When a new ConnectorBinding is created (or a ConnectorSchema changes), the system generates mapping suggestions:

```
ConnectorSchema fields           CanonicalSchema fields
─────────────────────           ──────────────────────
jira:summary          ──(0.95)──→  title
jira:status           ──(0.90)──→  status
jira:assignee.name    ──(0.85)──→  assignee
jira:reporter.name    ──(0.70)──→  author         (needs review)
jira:customfield_10042 ──(0.40)──→  ???            (unknown, needs curation)
```

The LLM examines field names, labels, descriptions, sample values, and types to propose mappings with confidence scores. High-confidence mappings (>0.8) can be auto-confirmed. Low-confidence or ambiguous mappings require human review.

---

## 6. Layer 3: Domain Vocabulary

### What It Is

A `DomainVocabulary` lives on a `ProjectKnowledgeBase` (the link between an agent's project and a KB) and maps business-specific language to canonical field queries. This is the layer that understands "closed deals" means `status IN (Closed Won, Closed Lost)`.

### Why It's Separate from Canonical Schema

The canonical schema is **system-level** — it normalizes "how Jira's `assignee.displayName` maps to canonical `assignee`". It's the same regardless of which agent project uses the KB.

The domain vocabulary is **project-level** — it captures how _this agent's users_ talk about data. A sales-focused agent's vocabulary for the same KB will differ from a support-focused agent's vocabulary.

```
Same KnowledgeBase "crm-data":

  Sales Agent Project:
    "closed deals"  → status IN (Closed Won, Closed Lost)
    "revenue"       → SUM(amount) WHERE status = Closed Won
    "pipeline"      → status NOT IN (Closed Won, Closed Lost)

  Support Agent Project:
    "closed tickets" → status IN (Resolved, Closed)
    "escalated"      → priority >= High AND status = Open
    "backlog"        → status = Open AND assignee IS NULL
```

### Vocabulary Structure

```typescript
interface DomainVocabulary {
  projectKnowledgeBaseId: string;
  version: number;
  entries: VocabularyEntry[];
}

interface VocabularyEntry {
  term: string; // Business term: "closed deals", "revenue", "author"
  aliases: string[]; // Synonyms: ["completed deals", "won deals", "finished deals"]
  resolution: VocabularyResolution;
  description?: string; // Human-readable explanation for documentation
  examples?: string[]; // Example user queries that trigger this entry
  status: 'active' | 'draft' | 'deprecated';
}

type VocabularyResolution =
  | FieldResolution // Maps to a canonical field
  | FilterResolution // Maps to a filter expression
  | AggregateResolution // Maps to an aggregation expression
  | CompositeResolution; // Combines multiple resolutions

interface FieldResolution {
  type: 'field';
  canonicalField: string; // "assignee", "status", "amount"
  description: string;
}

interface FilterResolution {
  type: 'filter';
  expression: FilterExpression; // { field: "status", op: "in", values: ["Closed Won", "Closed Lost"] }
}

interface AggregateResolution {
  type: 'aggregate';
  measure: {
    field: string; // Canonical field to aggregate
    function: 'sum' | 'count' | 'avg' | 'min' | 'max';
  };
  defaultFilters?: FilterExpression[]; // Default WHERE clause
  defaultGroupBy?: string[]; // Default dimensions
}

interface CompositeResolution {
  type: 'composite';
  steps: VocabularyResolution[]; // Applied in order
  description: string;
}

interface FilterExpression {
  field: string;
  operator:
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'starts_with'
    | 'between'
    | 'is_null'
    | 'is_not_null';
  value: unknown;
}
```

### Query-Time Application

Domain vocabulary is resolved at query time, before the query hits the retrieval pipeline:

```
User: "What's the total revenue for Q4 in North America?"

1. VocabularyResolver scans query for vocabulary terms:
   - "revenue" → AggregateResolution { measure: { field: "amount", function: "sum" },
                   defaultFilters: [{ field: "status", op: "eq", value: "Closed Won" }] }
   - "Q4"     → FilterResolution { field: "close_date", op: "between",
                   value: ["2025-10-01", "2025-12-31"] }
   - "North America" → FilterResolution { field: "region", op: "in",
                          value: ["US", "CA", "MX"] }

2. Compose into structured query:
   SELECT SUM(amount)
   FROM canonical_fields
   WHERE status = 'Closed Won'
     AND close_date BETWEEN '2025-10-01' AND '2025-12-31'
     AND region IN ('US', 'CA', 'MX')

3. Execute against KB's structured index
```

---

## 7. Query Resolution Flow

The complete flow from natural language to source-system execution:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     QUERY RESOLUTION PIPELINE                        │
│                                                                      │
│  User Query: "What are the closed deals worth over $50k?"            │
│                                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ 1. VOCABULARY LOOKUP            │  (Layer 3 — Domain Vocabulary)  │
│  │    "closed deals" →             │                                 │
│  │      filter: status IN          │                                 │
│  │        (Closed Won, Closed Lost)│                                 │
│  │    "worth" → field: amount      │                                 │
│  └────────────┬────────────────────┘                                 │
│               ↓                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ 2. CANONICAL FIELD RESOLUTION   │  (Layer 2 — Canonical Schema)   │
│  │    canonical.status →           │                                 │
│  │      jira:status | sf:StageName │                                 │
│  │    canonical.amount →           │                                 │
│  │      sf:Amount | hs:amount      │                                 │
│  └────────────┬────────────────────┘                                 │
│               ↓                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ 3. QUERY CONSTRUCTION           │                                 │
│  │    Structured query:            │                                 │
│  │      WHERE status IN (...)      │                                 │
│  │      AND amount > 50000         │                                 │
│  │    + Vector query for context   │                                 │
│  └────────────┬────────────────────┘                                 │
│               ↓                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ 4. RETRIEVAL EXECUTION          │  (Search Engine)                │
│  │    Metadata filter on structured│                                 │
│  │    index + vector retrieval     │                                 │
│  │    + reranking                  │                                 │
│  └────────────┬────────────────────┘                                 │
│               ↓                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ 5. RESULT FORMATTING            │                                 │
│  │    Map canonical fields back to │                                 │
│  │    business-friendly labels     │                                 │
│  │    using vocabulary entries     │                                 │
│  └─────────────────────────────────┘                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. Retrieval Strategy Agents

### Where Do Agentic Workflows Live?

The three query archetypes often require pre-retrieval and post-retrieval processing that goes beyond a simple pipeline. This processing involves:

- **Intent classification** — Is this a list query, aggregation, or knowledge query?
- **Query decomposition** — Break complex queries into sub-queries
- **Multi-hop retrieval** — First retrieval informs second retrieval
- **Result validation** — Check that aggregation results make sense
- **Cross-KB orchestration** — Query multiple KBs and synthesize

**Decision:** These agentic workflows live in the **Agent Platform** as composable **Retrieval Strategy Agents**, not inside Search AI.

### Why Agent Platform, Not Search AI

| Concern               | Search AI                               | Agent Platform                                           |
| --------------------- | --------------------------------------- | -------------------------------------------------------- |
| **Core competency**   | Indexing, storage, retrieval primitives | Agent orchestration, LLM reasoning, multi-step workflows |
| **Customizability**   | Per-pipeline stage configuration        | Per-project agent DSL, fully programmable                |
| **State management**  | Stateless request/response              | Sessions, threads, conversation history                  |
| **LLM orchestration** | Single-call LLM stages                  | Multi-turn reasoning, tool use, constraint checking      |
| **Composition**       | Linear pipeline stages                  | Supervisor delegation, fan-out, handoff                  |
| **Observability**     | Pipeline trace events                   | Full agent execution traces with decision explanations   |

Search AI provides the **retrieval primitives** — vector search, structured filter, aggregation, hybrid retrieval. The Agent Platform provides the **orchestration intelligence** — deciding which primitives to call, in what order, with what parameters, and how to combine results.

### Retrieval Strategy Agent Pattern

A Retrieval Strategy Agent is a small, focused agent that the main application agent delegates to for a specific retrieval task. It composes Search AI primitives using the tools available to it.

```
┌──────────────────────────────────────────────────────────────────┐
│                        AGENT PLATFORM                            │
│                                                                  │
│  Application Agent (e.g., "sales-advisor")                       │
│    │                                                             │
│    ├── DELEGATE to list-query-agent                              │
│    │     Tools: search_filter, search_list, vocabulary_resolve   │
│    │                                                             │
│    ├── DELEGATE to aggregation-agent                             │
│    │     Tools: search_aggregate, vocabulary_resolve,            │
│    │            validate_aggregation                             │
│    │                                                             │
│    └── DELEGATE to knowledge-agent                               │
│          Tools: search_vector, search_hybrid, search_rerank      │
│                                                                  │
│  Each strategy agent:                                            │
│    1. Resolves vocabulary terms                                  │
│    2. Constructs appropriate query                               │
│    3. Calls Search AI primitives                                 │
│    4. Validates/formats results                                  │
│    5. Returns structured response to parent                      │
│                                                                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ search-ai-sdk (REST)
                             ↓
┌──────────────────────────────────────────────────────────────────┐
│                          SEARCH AI                               │
│                                                                  │
│  Primitives (stateless, fast):                                   │
│    search_vector(kb, query, filters, top_k)                      │
│    search_structured(kb, filters, sort, limit)                   │
│    search_aggregate(kb, measure, groupBy, filters)               │
│    search_hybrid(kb, query, filters, strategy)                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Built-in Strategy Agents

The platform ships with pre-built retrieval strategy agents that cover the three query archetypes. These can be used as-is or customized per project.

**list-query-agent** — Handles structured list/filter queries:

```
AGENT list-query-agent
  MODEL: claude-sonnet-4-5-20250929

  TOOLS:
    - vocabulary_resolve    # Resolve business terms to canonical fields
    - search_structured     # Execute structured metadata queries
    - search_list           # Paginated entity listing

  INSTRUCTIONS: |
    You receive a natural language query that requests a list of entities.
    1. Resolve business terms using vocabulary_resolve
    2. Construct structured filters from resolved terms
    3. Execute search_structured or search_list
    4. Return formatted results with source attribution

  CONSTRAINTS:
    REQUIRE resolved_fields IS SET BEFORE calling search_structured
```

**aggregation-agent** — Handles numeric aggregation queries:

```
AGENT aggregation-agent
  MODEL: claude-sonnet-4-5-20250929

  TOOLS:
    - vocabulary_resolve     # Resolve measure + dimension terms
    - search_aggregate       # Execute aggregation query
    - validate_aggregation   # Sanity-check results (row count, null %, outliers)

  INSTRUCTIONS: |
    You receive a query requesting aggregated metrics.
    1. Resolve the measure (what to aggregate) and dimensions (what to group by)
    2. Resolve filter terms (time ranges, segments)
    3. Execute aggregation query
    4. Validate results (flag if row count is suspiciously low or values seem off)
    5. Return results with confidence indicator

  CONSTRAINTS:
    REQUIRE measure_field IS SET BEFORE calling search_aggregate
    REQUIRE aggregation_validated BEFORE returning results
```

**knowledge-retrieval-agent** — Handles semantic/multi-hop knowledge queries:

```
AGENT knowledge-retrieval-agent
  MODEL: claude-sonnet-4-5-20250929

  TOOLS:
    - vocabulary_resolve     # Resolve any domain terms for metadata filtering
    - search_hybrid          # Vector + keyword hybrid search
    - search_vector          # Pure vector search for follow-up hops

  INSTRUCTIONS: |
    You receive a knowledge question that requires semantic retrieval.
    1. Identify if the query contains domain vocabulary terms
    2. If metadata filters apply, resolve them via vocabulary
    3. Execute hybrid search with resolved filters
    4. If results are insufficient or query is multi-hop:
       a. Extract follow-up query from initial results
       b. Execute additional retrieval with refined query
    5. Return results with citations and confidence
```

### Supervisor Routing to Strategy Agents

The application agent (or a supervisor) routes to strategy agents based on query classification:

```
SUPERVISOR sales-advisor
  MODEL: claude-sonnet-4-5-20250929

  AGENTS:
    - list-query-agent
    - aggregation-agent
    - knowledge-retrieval-agent
    - general-response-agent

  ROUTING:
    - WHEN intent = "list_query" DELEGATE TO list-query-agent
    - WHEN intent = "aggregation" DELEGATE TO aggregation-agent
    - WHEN intent = "knowledge_query" DELEGATE TO knowledge-retrieval-agent
    - DEFAULT DELEGATE TO general-response-agent
```

---

## 9. Agent DSL Integration

### VOCABULARY Block

Agents declare which vocabulary to use alongside their knowledge base declarations:

```
AGENT sales-advisor
  MODEL: claude-sonnet-4-5-20250929

  KNOWLEDGE:
    - kb: crm-data
      strategy: hybrid
      top_k: 10
      vocabulary: sales-vocabulary    # References DomainVocabulary by name
    - kb: product-docs
      strategy: vector
      top_k: 5
```

### SEARCH Step with Vocabulary Resolution

The `SEARCH` step now supports vocabulary-aware queries:

```
  FLOW:
    1. SEARCH crm-data WITH {{user_query}}
       RESOLVE VOCABULARY              # Apply domain vocabulary before search
       STORE results AS search_results

    2. SEARCH crm-data AGGREGATE {{measure_query}}
       RESOLVE VOCABULARY
       STORE results AS metrics
```

### Compilation

At compile time:

- Compiler validates that `vocabulary` references exist in the project's `DomainVocabulary` entries for that `ProjectKnowledgeBase`
- The IR includes `vocabularyId` alongside `knowledgeBaseId`
- `RESOLVE VOCABULARY` compiles to a pre-search vocabulary resolution step in the IR

At runtime:

- The executor resolves vocabulary terms before constructing the search query
- Resolved terms are passed as structured filters to the Search API
- The search-ai-sdk handles vocabulary resolution via a dedicated endpoint or inline resolution

---

## 10. Curation Workflow

### Phase 1: Auto-Discovery (Connector Sync)

```
Connector syncs → Schema introspected → ConnectorSchema created/updated
                                          │
                                          ↓ Changes detected?
                                        ╔═══════════════════════════════╗
                                        ║ New fields → suggest mappings ║
                                        ║ Removed → flag stale          ║
                                        ║ Changed type → flag review    ║
                                        ╚═══════════════════════════════╝
```

### Phase 2: LLM-Assisted Canonical Mapping

When a ConnectorBinding is created or schema changes:

1. **Auto-suggest mappings** — LLM examines source field names, labels, types, and sample values against existing canonical fields
2. **Confidence scoring** — Each suggestion gets a 0-1 confidence score
3. **Auto-confirm high confidence** — Mappings with confidence > 0.85 and matching type are auto-confirmed (configurable threshold)
4. **Queue low confidence for review** — Admin sees pending mappings in Studio with LLM's reasoning
5. **Handle unmapped fields** — Admin can create new canonical fields or mark source fields as "ignored"

### Phase 3: Domain Vocabulary Curation

Vocabulary curation happens at the project level (by agent developers):

1. **Seed from canonical schema** — When a ProjectKnowledgeBase is linked, auto-generate vocabulary entries from canonical field names and descriptions
2. **LLM-assisted expansion** — LLM suggests synonyms, common business phrasings, and likely filter combinations
3. **Test with sample queries** — Developer inputs sample user queries, system shows which vocabulary terms would resolve and how
4. **Iterate and refine** — Developer adjusts terms, adds aliases, corrects resolutions
5. **Version and deploy** — Vocabulary is versioned; changes can be tested before activation

### Studio UI Integration

```
Search AI Studio:
  /search/connectors/:id/schema      → View discovered schema, map to canonical
  /search/knowledge-bases/:id/schema → Manage canonical schema, review mappings

Agent Studio:
  /projects/:id/knowledge/:alias/vocabulary → Manage domain vocabulary
  /projects/:id/knowledge/:alias/test       → Test queries against vocabulary
```

---

## 11. Data Model (Prisma Schema)

```prisma
// ═══════════════════════════════════════════════════════════════
// LAYER 1: SOURCE SCHEMA DISCOVERY
// ═══════════════════════════════════════════════════════════════

model ConnectorSchema {
  id              String   @id @default(cuid())
  connectorId     String
  version         Int      @default(1)
  fields          String   // JSON: ConnectorSchemaField[]
  discoveredAt    DateTime @default(now())
  fieldCount      Int      @default(0)
  customFieldCount Int     @default(0)
  status          String   @default("active")  // 'active' | 'stale'
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  connector       Connector @relation(fields: [connectorId], references: [id], onDelete: Cascade)

  @@unique([connectorId, version])
  @@index([connectorId])
}

model SchemaChangeLog {
  id              String   @id @default(cuid())
  connectorId     String
  schemaVersion   Int
  changeType      String   // 'field_added' | 'field_removed' | 'field_type_changed' | 'enum_values_changed'
  fieldPath       String
  previousValue   String?  // JSON: previous field definition
  newValue        String?  // JSON: new field definition
  reviewStatus    String   @default("pending")  // 'pending' | 'reviewed' | 'dismissed'
  createdAt       DateTime @default(now())

  @@index([connectorId])
  @@index([reviewStatus])
}

// ═══════════════════════════════════════════════════════════════
// LAYER 2: CANONICAL SCHEMA MAPPING
// ═══════════════════════════════════════════════════════════════

model CanonicalSchema {
  id              String   @id @default(cuid())
  knowledgeBaseId String
  version         Int      @default(1)
  fields          String   // JSON: CanonicalField[]
  status          String   @default("draft")  // 'draft' | 'active' | 'archived'
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)

  @@unique([knowledgeBaseId, version])
  @@index([knowledgeBaseId])
}

model FieldMapping {
  id                String   @id @default(cuid())
  canonicalSchemaId String
  canonicalField    String   // Name of the canonical field
  connectorId       String
  sourcePath        String   // Field path in ConnectorSchema
  transform         String?  // JSON: FieldTransform
  confidence        Float    @default(0)
  status            String   @default("suggested")  // 'suggested' | 'confirmed' | 'rejected'
  suggestedBy       String   @default("auto")       // 'auto' | 'llm' | 'human'
  reviewedBy        String?
  reviewedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  canonicalSchema   CanonicalSchema @relation(fields: [canonicalSchemaId], references: [id], onDelete: Cascade)

  @@unique([canonicalSchemaId, canonicalField, connectorId])
  @@index([canonicalSchemaId])
  @@index([connectorId])
  @@index([status])
}

// ═══════════════════════════════════════════════════════════════
// LAYER 3: DOMAIN VOCABULARY
// ═══════════════════════════════════════════════════════════════

model DomainVocabulary {
  id                       String   @id @default(cuid())
  projectKnowledgeBaseId   String
  version                  Int      @default(1)
  status                   String   @default("draft")  // 'draft' | 'active' | 'archived'
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt

  projectKnowledgeBase     ProjectKnowledgeBase @relation(fields: [projectKnowledgeBaseId], references: [id], onDelete: Cascade)
  entries                  VocabularyEntry[]

  @@unique([projectKnowledgeBaseId, version])
  @@index([projectKnowledgeBaseId])
}

model VocabularyEntry {
  id                  String   @id @default(cuid())
  domainVocabularyId  String
  term                String
  aliases             String?  // JSON: string[]
  resolution          String   // JSON: VocabularyResolution
  description         String?
  examples            String?  // JSON: string[]
  status              String   @default("active")  // 'active' | 'draft' | 'deprecated'
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  domainVocabulary    DomainVocabulary @relation(fields: [domainVocabularyId], references: [id], onDelete: Cascade)

  @@unique([domainVocabularyId, term])
  @@index([domainVocabularyId])
}
```

### Additions to Existing Models

```prisma
// Add to existing Connector model:
model Connector {
  // ... existing fields ...
  schemas         ConnectorSchema[]     // NEW: discovered schemas
}

// Add to existing KnowledgeBase model:
model KnowledgeBase {
  // ... existing fields ...
  canonicalSchemas CanonicalSchema[]    // NEW: canonical schema versions
}

// Add to existing ProjectKnowledgeBase model:
model ProjectKnowledgeBase {
  // ... existing fields ...
  vocabularies    DomainVocabulary[]    // NEW: domain vocabularies
}

// Add to existing CanonicalSchema model (relation):
model CanonicalSchema {
  // ... fields above ...
  fieldMappings   FieldMapping[]        // NEW: source-to-canonical mappings
}
```

---

## 12. MCP Tool Surface

### Schema Discovery Tools

| Tool                          | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `search_discover_schema`      | Trigger schema discovery for a connector (re-introspect source) |
| `search_get_connector_schema` | Get the current ConnectorSchema for a connector                 |
| `search_get_schema_changes`   | Get pending schema changes needing review                       |
| `search_review_schema_change` | Mark a schema change as reviewed/dismissed                      |

### Canonical Schema Tools

| Tool                            | Description                                                 |
| ------------------------------- | ----------------------------------------------------------- |
| `search_get_canonical_schema`   | Get the CanonicalSchema for a KB                            |
| `search_create_canonical_field` | Add a new canonical field                                   |
| `search_update_canonical_field` | Modify a canonical field's properties                       |
| `search_delete_canonical_field` | Remove a canonical field                                    |
| `search_suggest_mappings`       | LLM-assisted mapping suggestions for a connector→KB binding |
| `search_confirm_mapping`        | Confirm a suggested field mapping                           |
| `search_reject_mapping`         | Reject a suggested field mapping                            |
| `search_create_mapping`         | Manually create a field mapping                             |
| `search_test_mapping`           | Test a mapping against sample documents — show input→output |

### Domain Vocabulary Tools

| Tool                             | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `search_get_vocabulary`          | Get the DomainVocabulary for a ProjectKnowledgeBase                      |
| `search_create_vocabulary_entry` | Add a vocabulary term with resolution                                    |
| `search_update_vocabulary_entry` | Modify a vocabulary entry                                                |
| `search_delete_vocabulary_entry` | Remove a vocabulary entry                                                |
| `search_suggest_vocabulary`      | LLM-assisted vocabulary suggestions from canonical schema                |
| `search_test_vocabulary_query`   | Test a natural language query against vocabulary — show resolution trace |
| `search_activate_vocabulary`     | Promote a draft vocabulary version to active                             |

### Retrieval Strategy Tools (Agent Platform)

| Tool                          | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `search_resolve_vocabulary`   | Resolve business terms in a query to canonical filters (runtime API) |
| `search_structured`           | Execute structured metadata filter query against KB                  |
| `search_aggregate`            | Execute aggregation query against KB                                 |
| `search_validate_aggregation` | Validate aggregation results (row count, null %, outliers)           |

---

## 13. Integration with Existing Architecture

### Relationship to Existing Entities

This RFC adds three new entity layers to the existing Search AI entity model:

```
SearchProject
|
+-- Connector
|   +-- ConnectorSchema (NEW)          ← Layer 1: auto-discovered
|   +-- SchemaChangeLog (NEW)          ← Layer 1: change tracking
|
+-- KnowledgeBase
|   +-- CanonicalSchema (NEW)          ← Layer 2: normalized fields
|       +-- FieldMapping (NEW)         ← Layer 2: source → canonical
|
+-- ConnectorBinding                   ← (unchanged, still the glue)
|
Agent Platform:
|
+-- Project
    +-- ProjectKnowledgeBase           ← (extended with vocabulary relation)
        +-- DomainVocabulary (NEW)     ← Layer 3: business language
            +-- VocabularyEntry (NEW)  ← Layer 3: individual terms
```

### Pipeline Integration

The canonical schema mapping integrates as a new pipeline stage type:

```typescript
// New built-in stage: canonical-mapper
const canonicalMapperStage: StageHandler<EnrichedDocument, EnrichedDocument> = {
  name: 'canonical-mapper',
  version: '1.0.0',
  type: 'enrichment',

  async execute(input, context) {
    const schema = await context.services.getCanonicalSchema(context.knowledgeBaseId);
    const mappings = schema.getConfirmedMappings(input.connectorId);

    for (const mapping of mappings) {
      const sourceValue = getNestedValue(input.metadata, mapping.sourcePath);
      const canonicalValue = applyTransform(sourceValue, mapping.transform);
      input.canonicalMetadata[mapping.canonicalField] = canonicalValue;
    }

    return input;
  },
};
```

### SearchAI SDK Additions

The `@agent-platform/search-ai-sdk` gains new types and methods:

```typescript
// New search-ai-sdk types
export interface VocabularyResolveRequest {
  projectKnowledgeBaseId: string;
  query: string;
  resolveMode: 'all' | 'filters_only' | 'aggregates_only';
}

export interface VocabularyResolveResponse {
  resolvedTerms: ResolvedTerm[];
  unresolvedSegments: string[];
  structuredFilters: FilterExpression[];
  aggregation?: AggregationSpec;
}

export interface ResolvedTerm {
  term: string;
  matchedEntry: string;
  resolution: VocabularyResolution;
  confidence: number;
}

// New search-ai-sdk methods
export interface SearchAIClient {
  // ... existing methods ...

  resolveVocabulary(req: VocabularyResolveRequest): Promise<VocabularyResolveResponse>;
  searchStructured(
    kb: string,
    filters: FilterExpression[],
    options?: ListOptions,
  ): Promise<SearchResult>;
  searchAggregate(kb: string, spec: AggregationSpec): Promise<AggregationResult>;
}
```

---

## 14. Phased Delivery

| Phase                        | Scope                                                                                                                                | Depends On                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **S1: Schema Discovery**     | `ConnectorSchema` model, auto-discovery for Jira + Salesforce + HubSpot connectors, `SchemaChangeLog`, MCP tools for viewing schemas | P3 (First Connector)           |
| **S2: Canonical Schema**     | `CanonicalSchema` + `FieldMapping` models, manual mapping CRUD, `canonical-mapper` pipeline stage, MCP tools                         | S1                             |
| **S3: LLM-Assisted Mapping** | Auto-suggest mappings on binding creation, confidence scoring, batch review UI in Studio                                             | S2                             |
| **S4: Domain Vocabulary**    | `DomainVocabulary` + `VocabularyEntry` models, vocabulary CRUD, `vocabulary_resolve` API, MCP tools                                  | S2                             |
| **S5: Query Resolution**     | Vocabulary-aware query pipeline, structured query construction, metadata filter execution                                            | S4, P8 (Retrieval Quality)     |
| **S6: Aggregation Engine**   | `search_aggregate` API, aggregation query builder, result validation                                                                 | S5                             |
| **S7: Strategy Agents**      | Built-in list-query, aggregation, knowledge-retrieval agents, supervisor routing template                                            | S5, S6, P6 (Agent Integration) |
| **S8: DSL Integration**      | `VOCABULARY` block in DSL, `RESOLVE VOCABULARY` in SEARCH steps, compiler support                                                    | S7                             |
| **S9: Studio Curation**      | Schema mapping review UI, vocabulary editor, query testing playground                                                                | S4                             |

**Working end-to-end vocabulary resolution** achieved by **S5**. **Full agentic retrieval with strategy agents** by **S7**. **DSL-native vocabulary** by **S8**.

---

## Appendix A: Examples

### Example: Jira → KB Schema Flow

```
1. Jira Connector syncs → discovers ConnectorSchema:
   - summary (string)
   - status (enum: ["To Do", "In Progress", "Done", "Closed"])
   - assignee.displayName (string)
   - reporter.displayName (string)
   - priority (enum: ["Highest", "High", "Medium", "Low", "Lowest"])
   - customfield_10042 (string, label: "Document Author")
   - created (datetime)
   - updated (datetime)

2. ConnectorBinding created → LLM suggests canonical mappings:
   - summary → title (0.95, auto-confirmed)
   - status → status (0.92, auto-confirmed)
   - assignee.displayName → assignee (0.88, auto-confirmed)
   - reporter.displayName → reporter (0.85, auto-confirmed)
   - priority → priority (0.90, auto-confirmed)
   - customfield_10042 → author (0.45, needs review)
   - created → created_date (0.90, auto-confirmed)

3. Admin reviews:
   - Confirms customfield_10042 → author
   - Adds transform for status: rename_value { "To Do": "Open", "In Progress": "Active" }

4. Agent developer creates vocabulary for sales project:
   - "open issues" → filter: status IN (Open, Active)
   - "my tickets" → filter: assignee = {{current_user}}
   - "critical bugs" → filter: priority IN (Highest, High) AND type = Bug
   - "author" → field: author (not reporter, in this project's context)
```

### Example: Aggregation Query Resolution

```
User: "How many P1 bugs were closed last month?"

Vocabulary Resolution:
  - "P1" → filter: priority = "Highest"
  - "bugs" → filter: type = "Bug"
  - "closed" → filter: status = "Closed"
  - "last month" → filter: updated BETWEEN "2026-01-01" AND "2026-01-31"
  - implicit: COUNT aggregation

Structured Query:
  SELECT COUNT(*)
  FROM canonical_fields
  WHERE priority = 'Highest'
    AND type = 'Bug'
    AND status = 'Closed'
    AND updated BETWEEN '2026-01-01' AND '2026-01-31'

Result: { count: 42 }
```

---

## Appendix B: Open Questions

1. **Vocabulary conflict resolution** — When a term resolves differently across multiple KBs in the same project, how is disambiguation handled? Options: require explicit KB qualifier, use query context, prompt user.

2. **Vocabulary inheritance** — Should there be org-level vocabularies that all projects inherit? This would avoid re-defining "Q4" or "North America" in every project.

3. **Real-time schema sync** — Some source systems support webhooks for schema changes (Salesforce metadata events). Should ConnectorSchema updates be push-based in addition to sync-based?

4. **Canonical schema versioning** — When a canonical schema changes, how do we handle already-indexed documents? Options: lazy re-index on query, background re-index, dual-schema support during migration.

5. **Vocabulary testing corpus** — Should vocabulary quality be evaluated using eval sets (similar to retrieval eval)? A "vocabulary eval set" would be a set of natural language queries with expected resolutions.
