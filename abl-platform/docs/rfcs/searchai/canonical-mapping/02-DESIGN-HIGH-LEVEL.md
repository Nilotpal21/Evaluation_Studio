# Canonical Mapping & Vocabulary System: High-Level Design

**RFC:** RFC-CANONICAL-MAPPING-VOCABULARY (See: `01-REQUIREMENTS.md`)
**Status:** READY FOR REVIEW
**Created:** 2026-03-06
**Version:** 1.0

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Principles](#architecture-principles)
3. [Data Models](#data-models)
4. [Service Architecture](#service-architecture)
5. [Agent-SearchAI Protocol](#agent-searchai-protocol)
6. [Connector Workflow](#connector-workflow)
7. [Query Resolution Examples](#query-resolution-examples)
8. [Key Design Decisions](#key-design-decisions)
9. [Implementation Phases](#implementation-phases)
10. [Success Metrics](#success-metrics)

---

## Overview

### Design Goals

1. **Dynamic Resolution** - Same vocabulary entry resolves to filter/display/aggregate based on query context
2. **Auto-Generation** - LLM creates vocabulary from schema (10-20 hours → 30 minutes)
3. **Context-Aware Results** - Aggregations include meaningful context fields
4. **Production-Ready** - Complete with error handling, caching, monitoring

### What Problem Are We Solving?

**Current State:**

- Manual vocabulary creation takes 10-20 hours per knowledge base
- Users create 3 separate entries per concept (filter/display/aggregate)
- Aggregation queries lack context fields
- Query success rate: 60%

**Target State:**

- Auto-generation reduces setup to 30 minutes (97% reduction)
- Single vocabulary entry resolves dynamically based on query context
- Aggregations include 3-7 context fields for meaningful results
- Query success rate: 85%

### Critical Architecture Correction ⚠️

**Two databases, two different purposes:**

1. **Platform DB (MongoDB)** - Stores vocabulary entries, schemas, metadata
   - All CRUD operations on DomainVocabulary, CanonicalSchema, etc.

2. **Content DB (OpenSearch)** - Executes ALL search queries
   - Structured queries (filters)
   - Semantic queries (k-NN vector search)
   - Hybrid queries (filters + k-NN)
   - Aggregations

**See:** `appendices/DATABASE-ARCHITECTURE.md` for complete details

---

## Architecture Principles

### Schema Injection Pattern

**Inspired by:** SQLCoder approach (inject complete schema into LLM prompt)

**Application:**

- Critical fields detection: Inject full canonical schema
- Vocabulary generation: Inject field metadata (types, enum values)
- Query generation: Inject vocabulary + capabilities

**Benefits:**

- LLM has complete context for decisions
- Reduces hallucination (LLM sees actual field names)
- Enables validation (can check if suggested fields exist)

### Tool Use with Strict Schemas

**Inspired by:** Anthropic's tool use pattern

**Application:**

- All MCP tools use JSON Schema validation
- LLM-generated field names validated against schema
- Type-safe responses

**Benefits:**

- Guaranteed valid field names (no hallucination)
- Compile-time type safety (TypeScript)
- Self-documenting APIs

### Separation of Concerns

**Vocabulary (Naming)** separate from **Capabilities (Functions)**

**Rationale:**

- Vocabulary: What terms mean (language layer)
- Capabilities: What operations are supported (data layer)
- Inferred at runtime from CanonicalSchema (not stored redundantly)

**Example:**

```typescript
// Vocabulary: "priority" is a term users understand
{ term: "Priority", canonicalField: "priority", aliases: ["pri", "urgency"] }

// Capabilities: "priority" field supports these operations (inferred from schema)
{ canonicalField: "priority", capabilities: ["filter", "aggregate", "sort"] }
```

### Developer-Friendly Configs

**Pattern:** Developer provides examples → LLM adapts to specific project

**Application:**

- Critical fields: Developer provides Jira examples → LLM identifies critical fields for THIS project
- Vocabulary generation: Developer provides patterns → LLM generates for THIS schema

**Benefits:**

- One-time developer effort per connector type
- LLM dynamically adapts to each project's schema
- No per-project configuration needed

### LLM-Powered Flexibility

**When to use LLM:**

- Critical fields detection (varies per project)
- Vocabulary generation (aliases, descriptions, related fields)
- Query classification (structured vs semantic vs hybrid)

**When NOT to use LLM:**

- Capability inference (rule-based from schema)
- Field type validation (schema-based)
- Query execution (deterministic)

---

## Data Models

### 1. Enhanced DomainVocabulary Model

**Purpose:** Store vocabulary entries for critical fields only (10-20 per KB)

**Key Interfaces:**

```typescript
export interface IRelatedFields {
  /** Fields to show in detail view (10-30 fields) */
  displayWith: string[];

  /** Fields to show in aggregated view (3-7 fields, SQL GROUP BY compatible) */
  aggregateWith: string[];
}

export interface IVocabularyEntry {
  /** Primary term (from canonical field label, human-readable) */
  term: string;

  /** Reference to canonical field */
  canonicalField: string;

  /** Natural language aliases (3-5, LLM-generated) */
  aliases: string[];

  /** User-friendly description */
  description: string;

  /** Related fields for context */
  relatedFields?: IRelatedFields;

  /** Auto-generation metadata */
  autoGenerated: boolean;
  confidence: number; // 0.0-1.0

  /** Enable/disable for queries */
  enabled: boolean;

  /** Audit trail */
  createdBy: string; // 'llm' | userId
  lastModifiedBy?: string;
  lastModifiedAt?: Date;
}

export interface IDomainVocabulary {
  _id: string;
  tenantId: string;
  projectKnowledgeBaseId: string;

  /** Vocabulary entries (10-20 critical fields) */
  entries: IVocabularyEntry[];

  /** Version tracking */
  version: number;
  status: 'draft' | 'active' | 'archived';

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**MongoDB Schema Location:** `packages/database/src/models/domain-vocabulary.model.ts`

**Indexes:**

- `{ projectKnowledgeBaseId: 1, version: 1 }` (unique)
- `{ projectKnowledgeBaseId: 1, status: 1 }`
- `{ tenantId: 1 }`
- Text index on `entries.term` and `entries.aliases` for fuzzy search

**Key Design Choices:**

- ✅ One entry per canonical field (not 3 separate entries for filter/display/aggregate)
- ✅ `relatedFields` has separate `displayWith` and `aggregateWith` arrays
- ✅ `confidence` score for auto-generated entries (helps with ranking)
- ✅ `enabled` flag allows user to disable low-value entries without deletion
- ✅ Audit trail tracks who created/modified entries

---

### 2. Critical Fields Configuration (Code, Not Database)

**Purpose:** Developer provides examples per connector type → LLM adapts to specific project

**Key Interfaces:**

```typescript
export interface CriticalFieldExample {
  fieldName: string; // e.g., "summary" or "customfield_*_sprint"
  reasoning: string; // Why this field is critical
  category: 'identifier' | 'workflow' | 'dimension' | 'measure' | 'metadata';
  typicallyUsedFor: Array<'filter' | 'display' | 'aggregate' | 'sort'>;
}

export interface ConnectorCriticalFieldsConfig {
  connectorType: string; // e.g., "jira", "salesforce"
  domain: string; // e.g., "Project Management / Issue Tracking"
  exampleCriticalFields: CriticalFieldExample[];
  criticalFieldPatterns: CriticalFieldPattern[];
  nonCriticalPatterns: CriticalFieldPattern[];
}
```

**Example (Jira):**

```typescript
export const JIRA_CRITICAL_FIELDS: ConnectorCriticalFieldsConfig = {
  connectorType: 'jira',
  domain: 'Project Management / Issue Tracking',

  exampleCriticalFields: [
    {
      fieldName: 'summary',
      reasoning: 'Primary identifier - every query needs issue title for context',
      category: 'identifier',
      typicallyUsedFor: ['display', 'search'],
    },
    {
      fieldName: 'status',
      reasoning: 'Workflow state - most common filter (open, closed, in progress)',
      category: 'workflow',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'priority',
      reasoning: 'Urgency indicator - common for filtering and grouping',
      category: 'dimension',
      typicallyUsedFor: ['filter', 'aggregate', 'sort'],
    },
    // ... 6 more examples
  ],

  criticalFieldPatterns: [
    {
      category: 'identifier',
      patterns: ['title', 'name', 'summary', 'subject', 'key', 'id'],
      reasoning: 'Fields that identify individual records',
    },
    // ... more patterns
  ],

  nonCriticalPatterns: [
    {
      patterns: ['description', 'comment', 'notes', 'internal_note'],
      reasoning: 'Too detailed or verbose for structured queries',
    },
  ],
};
```

**Storage Location:** `apps/search-ai/src/config/connector-critical-fields/`

**Key Design Choices:**

- ✅ Code-based (not database) - easier for developers to maintain
- ✅ Patterns support wildcards (e.g., `customfield_*_sprint`)
- ✅ Separate critical vs non-critical patterns (helps LLM avoid bad fields)
- ✅ Category + reasoning provides LLM with domain knowledge

---

### 3. Capability Registry Model (Runtime, Not Stored)

**Purpose:** Queryable field capabilities per KB (inferred from CanonicalSchema)

**Key Interfaces:**

```typescript
export interface IAggregationFunction {
  name: string; // e.g., "count", "sum", "avg"
  description: string;
  supportedFieldTypes: string[]; // e.g., ["number", "integer"]
  triggerKeywords: string[]; // e.g., ["total", "sum", "add up"]
  examples: string[];
  requiresGroupBy?: boolean;
  requiresMeasure?: boolean;
}

export interface IOperator {
  name: string; // e.g., "equals", "greater_than", "contains"
  description: string;
  supportedFieldTypes: string[];
  triggerKeywords: string[];
  examples: string[];
}

export interface IQueryCapability {
  name: string; // e.g., "hybrid_search", "aggregation"
  description: string;
  enabled: boolean;
  configuration?: Record<string, any>;
}
```

**Storage:** MongoDB collection `capability_registries` (optional, can be fully runtime-computed)

**Key Design Choices:**

- ✅ Capabilities inferred from `CanonicalField.filterable`, `.aggregatable`, `.sortable`
- ✅ Not stored redundantly in DomainVocabulary
- ✅ Cached in-memory + Redis for performance
- ✅ Trigger keywords help Agent LLM classify query intent

---

### 4. Query Classifier Model (Static Patterns)

**Purpose:** Help Agent LLM classify queries as structured/semantic/hybrid/aggregation

**Key Interfaces:**

```typescript
export interface IQueryTypePattern {
  pattern: string; // Regex pattern
  keywords: string[];
  examples: string[];
  confidence: number; // 0-1 weight
}

export interface IQueryTypeDefinition {
  type: string; // 'list' | 'aggregation' | 'search' | 'hybrid'
  description: string;
  patterns: IQueryTypePattern[];

  expectedComponents: {
    hasSemanticSearch?: boolean;
    hasFilters?: boolean;
    hasAggregation?: boolean;
    hasGroupBy?: boolean;
    hasSorting?: boolean;
    hasLimit?: boolean;
  };

  defaultTopK?: number;
  defaultSort?: { field: string; order: 'asc' | 'desc' };
  enabled: boolean;
}
```

**Storage:** MongoDB collection `query_classifiers` (per-tenant defaults)

**Example:**

```typescript
{
  type: "hybrid",
  description: "Queries combining structured filters and semantic concepts",
  patterns: [
    {
      pattern: "(show|find|get).*(high|low|priority).*(about|regarding|related to)",
      keywords: ["high priority", "about", "regarding"],
      examples: ["Show high priority bugs about login issues"],
      confidence: 0.9
    }
  ],
  expectedComponents: {
    hasSemanticSearch: true,
    hasFilters: true,
    hasAggregation: false
  }
}
```

**Key Design Choices:**

- ✅ Pattern-based classification (faster than pure LLM)
- ✅ Fallback to LLM for ambiguous cases
- ✅ Examples provided to Agent LLM in prompt
- ✅ Domain-specific pattern overrides (per KB)

---

## Service Architecture

### Overview Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      CONNECTOR CONFIGURATION                      │
│  (User creates connector via UI/API)                             │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SCHEMA DISCOVERY                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Jira API     │───▶│ Schema Sync  │───▶│ Connector    │      │
│  │ (150 fields) │    │ Worker       │    │ Schema Doc   │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FIELD MAPPING                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Connector    │───▶│ Mapping LLM  │───▶│ 75 Field     │      │
│  │ Schema       │    │ Suggestion   │    │ Mappings     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│               CRITICAL FIELDS DETECTION (NEW)                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Developer    │───▶│ Adapter      │───▶│ LLM Analysis │      │
│  │ Examples     │    │ (Convert to  │    │ (Identify 12 │      │
│  │ (JIRA_CFG)   │    │ LLM prompt)  │    │ critical)    │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
└───────────────────────────────────────────────────┼─────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│               VOCABULARY GENERATION (NEW)                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ 12 Critical  │───▶│ Vocabulary   │───▶│ 12 Vocabulary│      │
│  │ Fields       │    │ Generator    │    │ Entries      │      │
│  │              │    │ Worker (LLM) │    │ (enabled)    │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
└───────────────────────────────────────────────────┼─────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FIELD VIEW UI (NEW)                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Show         │    │ User Edits   │───▶│ Publish to   │      │
│  │ Generated    │───▶│ Aliases,     │    │ Runtime      │      │
│  │ Vocabulary   │    │ Descriptions │    │ Cache        │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
└───────────────────────────────────────────────────┼─────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    QUERY RESOLUTION                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ User Query   │───▶│ Vocabulary   │───▶│ Query        │      │
│  │ "Show bugs"  │    │ Resolver V2  │    │ Classifier   │      │
│  └──────────────┘    └──────┬───────┘    └──────┬───────┘      │
│                             │                    │              │
│                             ▼                    ▼              │
│                      ┌──────────────┐    ┌──────────────┐      │
│                      │ Dynamic      │    │ Capability   │      │
│                      │ Resolution   │───▶│ Registry     │      │
│                      │ (filter/     │    │ (Check)      │      │
│                      │ display/agg) │    └──────┬───────┘      │
│                      └──────┬───────┘            │              │
│                             │                    │              │
│                             ▼                    ▼              │
│                      ┌──────────────────────────────┐           │
│                      │ LLM Query Generation         │           │
│                      │ (Schema injection + prompt)  │           │
│                      └──────────┬───────────────────┘           │
│                                 │                               │
│                                 ▼                               │
│                      ┌──────────────────────────┐               │
│                      │ OpenSearch Query         │               │
│                      │ Execution                │               │
│                      │ (filters/k-NN/aggs)      │               │
│                      └──────────┬───────────────┘               │
│                                 │                               │
│                                 ▼                               │
│                      ┌──────────────────────────┐               │
│                      │ Results with Context     │               │
│                      │ Fields + Semantic Scores │               │
│                      └──────────────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

---

### Core Services

#### 1. CriticalFieldsDetectorService

**Purpose:** Identify 10-20 critical fields from 100-500 discovered fields

**Location:** `apps/search-ai/src/services/vocabulary/critical-fields-detector.service.ts`

**Method:**

1. Load connector config (developer examples)
2. Build LLM prompt with examples + full canonical schema
3. Call LLM to identify critical fields
4. Validate response (check field names exist in schema)

**Output:**

```typescript
interface CriticalFieldResult {
  fieldPath: string; // Canonical field name
  reasoning: string;
  category: 'identifier' | 'workflow' | 'dimension' | 'measure' | 'metadata';
  typicalUsage: Array<'filter' | 'display' | 'aggregate' | 'sort'>;
  confidence: number; // 0.0-1.0
}
```

**Time:** ~2 minutes for 150 fields

**Key Features:**

- Schema injection (LLM sees full schema)
- Confidence filtering (only fields with >0.7 confidence)
- Validation (rejects hallucinated field names)

---

#### 2. VocabularyGeneratorWorker

**Purpose:** Auto-generate vocabulary entries from critical fields

**Location:** `apps/search-ai/src/workers/vocabulary-generator-worker.ts`

**Queue:** `QUEUE_VOCABULARY_GENERATION`

**Input:** 12 critical fields from detector

**LLM Task:** For each field, generate:

- 3-5 aliases (natural language alternatives)
- Human-readable description
- Related fields (displayWith: 10-30, aggregateWith: 3-7)

**Output:** 12 DomainVocabulary entries (auto-enabled)

**Time:** ~5 minutes for 12 fields

**Key Features:**

- Batch processing (all fields in one prompt)
- Confidence scores (helps with ranking)
- Auto-enabled (user can disable later)

---

#### 3. VocabularyResolverV2

**Purpose:** Dynamic resolution at query time

**Location:** `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver-v2.ts`

**Features:**

- Dynamic resolution: Same entry → filter/display/aggregate based on context
- Query classification: List vs aggregate vs search
- Cache: LRU (5 min TTL) + Redis pub/sub invalidation

**Performance:**

- <50ms (cached)
- <200ms (uncached)

**Example:**

```typescript
// Query: "Show high priority bugs"
const resolved = await resolver.resolve({
  query: "Show high priority bugs",
  knowledgeBaseId: "kb-jira",
  queryType: "list" // ← Determines which fields to use
});

// Result:
{
  filters: [
    { field: "priority", value: "High" },
    { field: "type", value: "Bug" }
  ],
  displayFields: [
    "summary", "status", "assignee", "created", // ← displayWith fields
    "updated", "description", "reporter", "labels", "type"
  ]
}
```

---

#### 4. CapabilityRegistryService

**Purpose:** Queryable field capabilities per KB

**Location:** `apps/search-ai-runtime/src/services/vocabulary/capability-registry.service.ts`

**Source:** Inferred from CanonicalSchema at runtime:

- `CanonicalField.filterable` → `capabilities: ["filter"]`
- `CanonicalField.aggregatable` → `capabilities: ["aggregate"]`
- `CanonicalField.sortable` → `capabilities: ["sort"]`

**Cache:** In-memory + Redis

**Example:**

```typescript
const capabilities = await registry.getCapabilities('kb-jira', ['priority', 'assignee']);

// Result:
[
  {
    canonicalField: 'priority',
    capabilities: ['filter', 'display', 'aggregate', 'sort'],
    dataType: 'string',
    indexed: true,
    enumValues: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
  },
  {
    canonicalField: 'assignee',
    capabilities: ['filter', 'display', 'aggregate'],
    dataType: 'string',
    indexed: true,
  },
];
```

---

#### 5. QueryClassifierService

**Purpose:** Classify query intent (list/aggregate/search/hybrid)

**Location:** `apps/search-ai-runtime/src/services/query/query-classifier.service.ts`

**Method:**

1. Pattern matching (fast path)
2. LLM classification (fallback for ambiguous)

**Output:**

```typescript
{
  queryType: "hybrid", // list | aggregation | search | hybrid
  detectedTerms: ["high priority", "bugs", "login issues"],
  structuredTerms: ["high priority", "bugs"],
  semanticTerms: ["login issues"],
  expectedOperations: ["filter", "semantic_search"]
}
```

**Time:** <100ms (pattern), <500ms (LLM)

---

## Agent-SearchAI Protocol

### Protocol Choice: MCP (Model Context Protocol)

**Why MCP and not A2A?**

| Aspect            | A2A (Agent-to-Agent)                | MCP (Model Context)            |
| ----------------- | ----------------------------------- | ------------------------------ |
| **Remote Entity** | Agent (reasons)                     | Tool/Service (executes)        |
| **Discovery**     | `/.well-known/agent.json`           | `tools/list`                   |
| **Message**       | Task (with history)                 | Tool call (with params)        |
| **Response**      | Artifacts + conversation            | Tool result (data)             |
| **Autonomy**      | Remote decides approach             | Service follows instructions   |
| **Example**       | "Analyze sentiment" → Agent reasons | "Search for X" → Tool searches |

**Verdict:** Use **MCP** for Agent ↔ SearchAI because:

- ✅ SearchAI is a **tool** (search operations), not an agent
- ✅ Agent decides WHAT to search, SearchAI executes HOW
- ✅ Deterministic operations: search_structured, search_semantic
- ✅ Tool discovery via `tools/list` (dynamic)
- ✅ Agent maintains control

---

### Two-Layer Intelligence

**Layer 1: Agent (Downloads + Understands)**

```
User: "who invented abl-platform design"
    ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1: AGENT (Downloads + Understands)                    │
│                                                              │
│  Step 1: Download vocabulary from SearchAI                  │
│      → Agent makes MCP call: get_vocabulary()               │
│      → Receives: Terms, aliases, field mappings             │
│      → Example: "author" → "createdBy" field                │
│                                                              │
│  Step 2: Semantic understanding (Agent LLM + Vocabulary)    │
│      → Agent thinks: "invented" ≈ "authored" ≈ "created by" │
│      → Agent checks vocabulary: "author" exists!            │
│      → Rephrases: "who is the author of abl-platform"       │
│                                                              │
│  Step 3: Map using vocabulary                               │
│      → "author" → "createdBy" (from downloaded vocabulary)  │
│                                                              │
│  Step 4: Decide and execute                                 │
│      → Classify: structured query                           │
│      → Execute: search_structured(...)                      │
└──────────────────────────┬───────────────────────────────────┘
                           ↓ MCP Protocol
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2: SEARCHAI (Provides + Executes)                     │
│                                                              │
│  Provides:                                                   │
│    - Vocabulary (via get_vocabulary tool)                   │
│    - Classification examples (via get_classification tool)  │
│    - Field capabilities (via get_capabilities tool)         │
│                                                              │
│  Executes:                                                   │
│    - Structured searches (via search_structured tool)       │
│    - Semantic searches (via search_semantic tool)           │
│    - Hybrid searches (via search_hybrid tool)               │
│    - Aggregations (via search_aggregate tool)               │
└─────────────────────────────────────────────────────────────┘
```

**Benefits:**

- ✅ Agent downloads capabilities once, caches for 5 min
- ✅ Agent has vocabulary context BEFORE rephrasing
- ✅ SearchAI focuses on data provision + execution
- ✅ Separation of concerns: Agent = intelligence, SearchAI = data + execution

---

#### Critical: Download-First Pattern ⚠️

**Common Mistake:** Implementing workflow in wrong order

**❌ WRONG Order (Breaks Semantic Understanding):**

```
User: "who invented abl-platform design"
    ↓
Step 1: Agent rephrases query first
    → Agent LLM: "invented" → "author"
    → Rephrased: "who is the author of abl-platform design"
    ↓
Step 2: Download vocabulary to map "author"
    → Gets: "author" → "createdBy" field
```

**Problem:** How can the agent intelligently rephrase "invented" to "author" without knowing what vocabulary terms exist?

- Agent might rephrase to "creator" but vocabulary only has "author"
- Agent might rephrase to "writer" but vocabulary doesn't have that term
- Result: Field resolution fails even though vocabulary exists

---

**✅ CORRECT Order (Enables Intelligent Rephrasing):**

```
User: "who invented abl-platform design"
    ↓
Step 1: Download vocabulary FIRST
    → Agent makes MCP call: get_vocabulary()
    → Receives all available terms:
       - "author" → "createdBy"
       - "priority" → "priority"
       - "status" → "status"
       - ... (all vocabulary entries)
    ↓
Step 2: Agent rephrases WITH vocabulary context
    → Agent LLM thinks: "invented" is similar to "authored", "created by", "written by"
    → Agent LLM checks downloaded vocabulary: "author" exists!
    → Agent LLM rephrases to: "who is the author of abl-platform design"
    ↓
Step 3: Map using downloaded vocabulary
    → "author" → "createdBy" (already in memory)
    ↓
Step 4: Execute
    → search_structured({ field: "createdBy", value: "abl-platform design" })
```

**Why This Matters:**

1. **Vocabulary Awareness**: Agent knows what terms are available BEFORE rephrasing
2. **Higher Success Rate**: Agent can choose terms that actually exist in vocabulary
3. **No Guessing**: Agent doesn't have to guess which synonym to use
4. **Caching**: Vocabulary is cached for 5 minutes, so download cost is amortized

**Implementation Guidance:**

```typescript
// ❌ WRONG: Rephrase first, then download
async function processQuery(userQuery: string) {
  // WRONG ORDER!
  const rephrased = await agentLLM.rephrase(userQuery); // Agent doesn't know vocabulary!
  const vocabulary = await mcp.callTool('get_vocabulary', { ... }); // Too late
  return mapWithVocabulary(rephrased, vocabulary);
}

// ✅ CORRECT: Download first, then rephrase
async function processQuery(userQuery: string) {
  // CORRECT ORDER!
  const vocabulary = await mcp.callTool('get_vocabulary', { ... }); // Download FIRST

  const rephrased = await agentLLM.rephrase({
    query: userQuery,
    availableTerms: vocabulary.vocabulary.map(v => ({
      term: v.term,
      aliases: v.aliases,
      field: v.canonicalField
    }))
  }); // Agent knows what vocabulary exists

  return mapWithVocabulary(rephrased, vocabulary);
}
```

**Analogy:**

Think of it like looking up words in a dictionary:

- ❌ WRONG: Translate sentence to another language, THEN check if those words exist in dictionary
- ✅ CORRECT: Read dictionary first, THEN translate using words you know exist

**This pattern is critical and must be followed in all agent implementations.**

---

### MCP Tool Catalog

#### Capability Discovery Tools

**1. get_vocabulary**

**Purpose:** Download vocabulary terms for query rephrasing

**Input:**

```typescript
{
  knowledgeBaseId: string;
  domain?: 'all' | 'identifier' | 'status' | 'measure' | 'dimension';
}
```

**Output:**

```typescript
{
  vocabulary: [
    {
      term: 'author',
      canonicalField: 'createdBy',
      aliases: ['creator', 'writer', 'created by'],
      description: 'Person who created the document',
      fieldType: 'string',
      capabilities: ['filter', 'display', 'aggregate'],
    },
    {
      term: 'priority',
      canonicalField: 'priority',
      aliases: ['pri', 'importance', 'urgency'],
      enumValues: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
      capabilities: ['filter', 'display', 'aggregate', 'sort'],
    },
  ];
}
```

---

**2. get_classification_examples**

**Purpose:** Download query classification examples for agent LLM

**Input:**

```typescript
{
  knowledgeBaseId: string;
}
```

**Output:**

```typescript
{
  queryTypes: {
    structured: {
      description: "Queries with field filters, no semantic concepts",
      examples: [
        {
          query: "Show high priority bugs",
          reasoning: "Clear field references (priority=High, type=Bug)",
          expectedFilters: ["priority", "type"]
        }
      ]
    },
    semantic: {
      description: "Queries about concepts, not specific fields",
      examples: [
        {
          query: "Find bugs about login issues",
          reasoning: "Semantic concept 'login issues' requires vector search",
          expectedConcepts: ["login issues"]
        }
      ]
    },
    hybrid: {
      description: "Queries combining structured filters and semantic concepts",
      examples: [
        {
          query: "Show high priority bugs about authentication",
          reasoning: "Structured (priority, type) + Semantic (authentication)",
          expectedFilters: ["priority", "type"],
          expectedConcepts: ["authentication"]
        }
      ]
    }
  }
}
```

---

**3. get_field_capabilities**

**Purpose:** Get available operations for each field

**Input:**

```typescript
{
  knowledgeBaseId: string;
  fields?: string[]; // Optional, returns all if omitted
}
```

**Output:**

```typescript
{
  fields: [
    {
      canonicalField: 'priority',
      capabilities: ['filter', 'display', 'aggregate', 'sort'],
      dataType: 'string',
      indexed: true,
      enumValues: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
    },
    {
      canonicalField: 'createdBy',
      capabilities: ['filter', 'display', 'aggregate'],
      dataType: 'string',
      indexed: true,
    },
  ];
}
```

---

#### Query Execution Tools

**4. search_structured**

**Purpose:** Execute structured queries (filters only)

**Input:**

```typescript
{
  knowledgeBaseId: string;
  filters: Array<{
    field: string;
    operator: 'equals' | 'in' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
    value: any;
  }>;
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  limit?: number; // default: 50, max: 100
}
```

---

**5. search_semantic**

**Purpose:** Execute semantic search (vector k-NN)

**Input:**

```typescript
{
  knowledgeBaseId: string;
  query: string; // Natural language query
  topK?: number; // default: 10, max: 100
  similarityThreshold?: number; // default: 0.7, range: 0-1
  filters?: Array<Filter>; // Optional structured filters to narrow results
}
```

---

**6. search_hybrid**

**Purpose:** Execute hybrid search (filters + vector)

**Input:**

```typescript
{
  knowledgeBaseId: string;
  query: string; // Semantic query component
  filters: Array<Filter>; // Structured filters
  topK?: number; // default: 10
  weights?: {
    semantic: number; // default: 0.7
    structured: number; // default: 0.3
  }; // Must sum to 1.0
}
```

---

**7. search_aggregate**

**Purpose:** Execute aggregation queries

**Input:**

```typescript
{
  knowledgeBaseId: string;
  filters?: Array<Filter>; // Optional filters before aggregation
  aggregations: Array<{
    field: string;
    operation: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'terms';
    groupBy?: string[]; // Fields to group by
  }>;
}
```

---

### Agent Workflow Pattern Example

**User Query:** "Show high priority bugs about login issues"

```typescript
// ========================================
// Step 1: Download capabilities FIRST
// ========================================
const vocabulary = await mcp.callTool('get_vocabulary', {
  knowledgeBaseId: 'kb-jira',
});
// Result: [{ term: "priority", ... }, { term: "bugs", ... }]

const examples = await mcp.callTool('get_classification_examples', {
  knowledgeBaseId: 'kb-jira',
});
// Result: { structured: [...], semantic: [...], hybrid: [...] }

// ========================================
// Step 2: Agent separates structured vs semantic
// ========================================
const agentAnalysis = await agentLLM.generate(`
Query: "Show high priority bugs about login issues"
Vocabulary: ${JSON.stringify(vocabulary)}

Identify:
1. Structured terms (can be mapped to vocabulary fields)
2. Semantic terms (concepts requiring vector search)

Output JSON: { structured: [...], semantic: [...] }
`);

// Result:
// {
//   structured: ["high priority", "bugs"],
//   semantic: ["login issues"]
// }

// ========================================
// Step 3: Map structured terms
// ========================================
const structuredFilters = [
  { field: 'priority', operator: 'equals', value: 'High' },
  { field: 'type', operator: 'equals', value: 'Bug' },
];

// ========================================
// Step 4: Classify (hybrid)
// ========================================
const classification = await agentLLM.generate(`
Query: "${query}"
Examples: ${JSON.stringify(examples.queryTypes)}

Classify this query as: structured, semantic, or hybrid
`);
// Result: "hybrid" (has both structured + semantic)

// ========================================
// Step 5: Execute hybrid search
// ========================================
const result = await mcp.callTool('search_hybrid', {
  knowledgeBaseId: 'kb-jira',
  query: 'login issues', // Semantic component
  filters: structuredFilters, // Structured component
  topK: 50,
});
```

---

### Agent Workflow Pattern: Aggregation Query

**User Query:** "Count bugs by assignee for the last sprint"

```typescript
// ========================================
// Step 1: Download vocabulary
// ========================================
const vocabulary = await mcp.callTool('get_vocabulary', {
  knowledgeBaseId: 'kb-jira',
});
// Result:
// [
//   { term: "bugs", canonicalField: "type", ... },
//   { term: "assignee", canonicalField: "assignee", ... },
//   { term: "sprint", canonicalField: "sprint", ... }
// ]

// ========================================
// Step 2: Extract filters and aggregation intent
// ========================================
const agentAnalysis = await agentLLM.generate(`
Query: "Count bugs by assignee for the last sprint"
Vocabulary: ${JSON.stringify(vocabulary)}

Extract:
1. Operation: (count, sum, avg, min, max, etc.)
2. Group by field (which field to aggregate by)
3. Filters (conditions to apply before aggregation)
4. Temporal terms (time ranges like "last sprint")

Output JSON with extracted information
`);

// Result:
// {
//   operation: "count",
//   groupBy: "assignee",
//   filters: [
//     { field: "type", value: "Bug" },
//     { field: "sprint", value: "Sprint 23" }  // "last sprint" resolved
//   ]
// }

// ========================================
// Step 3: Download classification examples
// ========================================
const examples = await mcp.callTool('get_classification_examples', {
  knowledgeBaseId: 'kb-jira',
});

// ========================================
// Step 4: Classify as aggregation query
// ========================================
const classification = await agentLLM.generate(`
Query: "Count bugs by assignee for the last sprint"
Examples: ${JSON.stringify(examples.queryTypes)}

Classify this query type
`);
// Result: "aggregation" (has grouping operation)

// ========================================
// Step 5: Resolve temporal term "last sprint"
// ========================================
const currentSprint = await mcp.callTool('get_current_context', {
  knowledgeBaseId: 'kb-jira',
  contextType: 'sprint',
});
// Result: { currentSprint: "Sprint 24", previousSprint: "Sprint 23" }

// Update filters with resolved value
agentAnalysis.filters.find((f) => f.field === 'sprint').value = currentSprint.previousSprint;

// ========================================
// Step 6: Execute aggregation
// ========================================
const result = await mcp.callTool('search_aggregate', {
  knowledgeBaseId: 'kb-jira',
  filters: [
    { field: 'type', operator: 'equals', value: 'Bug' },
    { field: 'sprint', operator: 'equals', value: 'Sprint 23' },
  ],
  aggregations: [
    {
      field: 'assignee',
      operation: 'terms', // Group by unique values
      groupBy: [], // No sub-grouping
    },
  ],
});

// Result:
// {
//   totalCount: 47,
//   aggregations: {
//     by_assignee: [
//       { key: "john.smith@acme.com", count: 12, subAggregations: {...} },
//       { key: "jane.doe@acme.com", count: 10, subAggregations: {...} },
//       { key: "bob.jones@acme.com", count: 8, subAggregations: {...} },
//       { key: "alice.wong@acme.com", count: 7, subAggregations: {...} },
//       { key: "charlie.brown@acme.com", count: 5, subAggregations: {...} },
//       { key: "diana.prince@acme.com", count: 5, subAggregations: {...} }
//     ]
//   }
// }
```

**Key Points:**

- **Step 1-2**: Download vocabulary first, then extract aggregation intent
- **Temporal Resolution**: "last sprint" → actual sprint name (Sprint 23)
- **Context Awareness**: Result includes sub-aggregations (status, priority) from `aggregateWith` fields
- **Operation Detection**: LLM identifies "count" operation from "Count bugs"
- **Group By Extraction**: LLM identifies "assignee" as grouping field from "by assignee"

**Pattern Differences:**

| Aspect             | List Query           | Aggregation Query                |
| ------------------ | -------------------- | -------------------------------- |
| **Operation**      | Fetch documents      | Group & compute statistics       |
| **Result Format**  | Array of documents   | Aggregation buckets + counts     |
| **Fields Used**    | `displayWith`        | `aggregateWith`                  |
| **Typical Tool**   | `search_structured`  | `search_aggregate`               |
| **Example Query**  | "Show bugs"          | "Count bugs by assignee"         |
| **LLM Task**       | Map terms to filters | Extract operation + group field  |
| **Context Fields** | 10-30 fields         | 3-7 fields (SQL GROUP BY compat) |

---

### Caching Strategy

**What to cache:**

- ✅ Vocabulary (per KB, TTL: 5 minutes)
- ✅ Classification examples (per KB, TTL: 10 minutes)
- ✅ Field capabilities (per KB, TTL: 5 minutes)

**Why cache:**

- Vocabulary rarely changes
- Classification examples are static
- Reduces latency (no MCP call per query)

**Implementation:**

```typescript
// Runtime vocabulary cache
const vocabularyCache = new LRUCache({
  max: 100, // 100 knowledge bases
  ttl: 5 * 60 * 1000, // 5 minutes
});

async function getVocabulary(kbId: string) {
  const cached = vocabularyCache.get(kbId);
  if (cached) return cached;

  const result = await mcp.callTool('get_vocabulary', { knowledgeBaseId: kbId });
  vocabularyCache.set(kbId, result);
  return result;
}
```

**Cache Invalidation:**

```typescript
// When vocabulary updated, SearchAI publishes event
await redis.publish('searchai:vocabulary:updated', {
  knowledgeBaseId: 'kb-jira-acme',
  timestamp: Date.now(),
});

// Runtime subscribes and invalidates
redis.subscribe('searchai:vocabulary:updated', (message) => {
  const { knowledgeBaseId } = JSON.parse(message);
  vocabularyCache.delete(knowledgeBaseId);
});
```

---

### Performance Latency Targets

**Per-Operation Targets:** Each MCP tool and query type has specific latency targets for optimal user experience.

#### MCP Tool Latency Targets

| Operation                        | Target Latency | Notes                                        |
| -------------------------------- | -------------- | -------------------------------------------- |
| `get_vocabulary`                 | **<50ms**      | Cached after first call (LRU + Redis)        |
| `get_classification_examples`    | **<30ms**      | Static data, highly cacheable                |
| `get_field_capabilities`         | **<40ms**      | Inferred from schema, cached                 |
| `search_structured` (simple)     | **<100ms**     | OpenSearch filter query, indexed fields      |
| `search_structured` (complex)    | **<150ms**     | Multiple filters + sorting                   |
| `search_semantic`                | **<200ms**     | k-NN vector search (embedding lookup + k-NN) |
| `search_hybrid`                  | **<250ms**     | Combined: filters + k-NN + score fusion      |
| `search_aggregate` (single)      | **<150ms**     | OpenSearch terms aggregation                 |
| `search_aggregate` (multi-level) | **<300ms**     | Nested aggregations with sub-grouping        |

#### Query Resolution Pipeline Latency

**End-to-End Target:** <500ms (from user query to results)

**Breakdown:**

| Stage                   | Target    | Details                           |
| ----------------------- | --------- | --------------------------------- |
| 1. Vocabulary Download  | <50ms     | First call or cache miss          |
| 2. Query Classification | <100ms    | LLM classifies query type         |
| 3. Field Extraction     | <80ms     | LLM maps terms to fields          |
| 4. Query Execution      | <200ms    | OpenSearch query (varies by type) |
| 5. Result Formatting    | <70ms     | Transform OpenSearch response     |
| **Total (Uncached)**    | **500ms** | First query for a KB              |
| **Total (Cached)**      | **450ms** | Vocabulary cached, saves 50ms     |

#### Cache Performance Targets

| Metric                   | Target   | How to Measure                      |
| ------------------------ | -------- | ----------------------------------- |
| **Cache Hit Rate**       | **>90%** | Vocabulary cache hits / total calls |
| **Cache Warming Time**   | <2s      | Load all vocabulary for a KB        |
| **Invalidation Latency** | <100ms   | Redis pub/sub propagation time      |
| **Cache Memory Usage**   | <500MB   | For 100 KBs with 20 entries each    |

#### LLM Operation Targets

| Operation                     | Target     | Model         | Notes                             |
| ----------------------------- | ---------- | ------------- | --------------------------------- |
| **Critical Fields Detection** | **<30s**   | Claude Sonnet | One-time per connector config     |
| **Vocabulary Generation**     | **<5min**  | Claude Sonnet | 10-20 fields, batch processing    |
| **Query Classification**      | **<100ms** | Claude Haiku  | Fast model for simple task        |
| **Field Extraction**          | **<80ms**  | Claude Haiku  | Pattern matching + LLM validation |
| **Query Generation**          | **<150ms** | Claude Sonnet | Complex schema injection          |

#### Optimization Strategies

**1. Cache Everything Possible**

```typescript
// Aggressive caching strategy
const cacheConfig = {
  vocabulary: { ttl: 300_000 }, // 5 min
  classificationExamples: { ttl: 600_000 }, // 10 min (rarely changes)
  capabilities: { ttl: 300_000 }, // 5 min
  queryTemplates: { ttl: 3600_000 }, // 1 hour (static)
};
```

**2. Parallel Operations**

```typescript
// Download vocabulary + examples in parallel (not sequential)
const [vocabulary, examples, capabilities] = await Promise.all([
  mcp.callTool('get_vocabulary', { knowledgeBaseId }),
  mcp.callTool('get_classification_examples', { knowledgeBaseId }),
  mcp.callTool('get_field_capabilities', { knowledgeBaseId }),
]);
// Saves ~100ms vs sequential calls
```

**3. Fast-Path for Common Queries**

```typescript
// Pattern-based classification before LLM (for simple queries)
if (query.match(/^show (high|low) priority/i)) {
  // Fast path: No LLM needed, direct pattern match
  return { queryType: 'structured', filters: [...] };
}
// Only call LLM for ambiguous queries
```

**4. Batch Vocabulary Generation**

```typescript
// Generate all vocabulary entries in ONE LLM call (not 12 separate calls)
const allVocabulary = await llm.generateVocabulary({
  fields: criticalFields, // All 12 fields
  batchSize: 12,
});
// Saves ~2-3 minutes vs sequential generation
```

#### Performance Monitoring

**Metrics to Track:**

```typescript
// Emit metrics for each operation
await metrics.recordTiming('mcp.get_vocabulary', duration, {
  knowledgeBaseId,
  cached: wasCached,
  tenantId,
});

await metrics.recordTiming('query.resolution.total', totalDuration, {
  queryType: classification,
  cached: vocabularyWasCached,
  success: true,
});
```

**SLO (Service Level Objectives):**

- **P50 (Median):** 90% of targets above
- **P95:** 2x targets above (e.g., get_vocabulary <100ms)
- **P99:** 3x targets above (e.g., get_vocabulary <150ms)

**Alerts:**

- P95 > 2x target → Warning
- P99 > 3x target → Critical
- Cache hit rate < 80% → Investigate

#### Load Testing Targets

**Concurrent Users:**

- 100 agents querying simultaneously
- 1000 queries per second across all KBs
- 50 vocabulary updates per minute

**Stress Test Scenarios:**

1. **Cold Cache:** All agents query after cache flush (worst case)
2. **Hot Cache:** All agents query cached data (best case)
3. **Mixed Load:** 70% cached, 30% cache miss (realistic)

**Expected Results:**

| Scenario   | P50 Latency | P95 Latency | P99 Latency |
| ---------- | ----------- | ----------- | ----------- |
| Cold Cache | 480ms       | 900ms       | 1200ms      |
| Hot Cache  | 420ms       | 750ms       | 950ms       |
| Mixed Load | 450ms       | 850ms       | 1100ms      |

---

### Security & Authorization

**Critical:** Multi-tenant system requires strict tenant isolation at every layer.

#### Authentication

**JWT Token Validation:**

All MCP tool calls require valid JWT authentication token.

```typescript
// SearchAI MCP server middleware
async function validateAuth(request) {
  const token = request.headers['authorization']?.replace('Bearer ', '');
  if (!token) {
    throw new Error('Unauthorized: Missing authentication token');
  }

  const decoded = await verifyJWT(token);

  return {
    tenantId: decoded.tenantId,
    projectId: decoded.projectId,
    userId: decoded.userId,
    permissions: decoded.permissions,
  };
}
```

---

#### Tenant Isolation

**Every tool call includes tenant context and validates ownership:**

```typescript
// Agent includes tenant context in MCP call
await mcp.callTool('get_vocabulary', {
  knowledgeBaseId: 'kb-jira-acme',
  tenantId: 'tenant-acme', // ← Validated against JWT
  projectId: 'proj-123',
});
```

**SearchAI MCP server validates ownership:**

```typescript
// MCP tool handler: get_vocabulary
async function getVocabulary(args, auth) {
  // Step 1: Validate tenant owns knowledge base
  const kb = await KnowledgeBase.findOne({
    _id: args.knowledgeBaseId,
    tenantId: auth.tenantId, // ← Must match JWT
    projectId: auth.projectId,
  });

  if (!kb) {
    // Return 404 (not 403) to avoid leaking existence
    throw new Error('Knowledge base not found');
  }

  // Step 2: Query vocabulary with tenant isolation
  const vocabulary = await DomainVocabulary.find({
    projectKnowledgeBaseId: kb._id,
    tenantId: auth.tenantId, // ← Double-check tenant isolation
  });

  return {
    vocabulary: vocabulary.entries.filter((e) => e.enabled),
  };
}
```

**Key Principles:**

1. **Every query includes tenantId** - Use `findOne({_id, tenantId})`, never `findById`
2. **Validate before data access** - Check KB ownership before querying vocabulary
3. **Return 404, not 403** - Don't leak existence of resources in other tenants
4. **Double-check isolation** - Even if KB is validated, vocabulary query still filters by tenant
5. **Audit all access** - Log tenantId, userId, and resource accessed

---

#### Resource-Level Permissions

**Project-Level Access:**

```typescript
// Validate user has access to project
await requireProjectPermission(auth, projectId, 'searchai:vocabulary:read');

// All routes under /api/projects/:projectId/...
router.get(
  '/api/projects/:projectId/knowledge-bases/:kbId/vocabulary',
  requireAuth,
  requireProjectPermission('searchai:vocabulary:read'),
  getVocabularyHandler,
);
```

**Knowledge Base-Level Access:**

```typescript
// Check if KB belongs to project
const kb = await KnowledgeBase.findOne({
  _id: kbId,
  projectId: req.params.projectId, // ← Validate resource belongs to project
  tenantId: req.auth.tenantId,
});

if (!kb) {
  return res.status(404).json({
    success: false,
    error: { code: 'KB_NOT_FOUND', message: 'Knowledge base not found' },
  });
}
```

---

#### Cross-Tenant Access Prevention

**Scenario:** Tenant A tries to access Tenant B's vocabulary

```typescript
// Tenant A agent calls (malicious or accidental):
await mcp.callTool('get_vocabulary', {
  knowledgeBaseId: 'kb-tenant-b', // ← Belongs to Tenant B
  tenantId: 'tenant-a', // ← Attacker's tenant
});

// SearchAI validation:
const kb = await KnowledgeBase.findOne({
  _id: 'kb-tenant-b',
  tenantId: 'tenant-a', // ← Mismatch!
});
// Result: null

// Response: 404 (not 403, doesn't leak existence)
throw new Error('Knowledge base not found');
```

**Why 404 instead of 403:**

- 403 "Forbidden" reveals resource exists but user lacks permission
- 404 "Not Found" doesn't leak existence
- Prevents enumeration attacks

---

#### Rate Limiting

**Per-Tenant Limits:**

```typescript
// SearchAI MCP server rate limiter
const rateLimiter = new RateLimiter({
  points: 100, // 100 requests
  duration: 60, // per minute
  keyPrefix: 'mcp-ratelimit',
});

async function handleToolCall(auth, tool, args) {
  // Rate limit by tenantId
  try {
    await rateLimiter.consume(auth.tenantId);
  } catch (error) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }

  return await executeTool(tool, args, auth);
}
```

**Per-User Limits (Stricter):**

```typescript
// Additional per-user limit for abuse prevention
const userRateLimiter = new RateLimiter({
  points: 20, // 20 requests
  duration: 60, // per minute
});

await userRateLimiter.consume(auth.userId);
```

---

#### Audit Logging

**Log All MCP Tool Calls:**

```typescript
// After authentication, before execution
await auditLog.log({
  timestamp: new Date(),
  tenantId: auth.tenantId,
  userId: auth.userId,
  projectId: auth.projectId,
  action: 'mcp.tool_call',
  resource: {
    type: 'vocabulary',
    id: args.knowledgeBaseId,
  },
  tool: toolName,
  success: true,
  duration: durationMs,
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});
```

**Use for:**

- Security incident investigation
- Compliance (SOC 2, GDPR)
- Usage analytics
- Abuse detection

---

#### Data Minimization

**Only Return Necessary Fields:**

```typescript
// Don't return internal IDs, creation dates, or metadata
return {
  vocabulary: vocabulary.entries
    .filter((e) => e.enabled)
    .map((e) => ({
      term: e.term,
      canonicalField: e.canonicalField,
      aliases: e.aliases,
      description: e.description,
      capabilities: inferCapabilities(e.canonicalField),
      // ❌ Don't include: _id, createdBy, createdAt, confidence, etc.
    })),
};
```

**Why:**

- Reduces response size
- Minimizes data exposure
- Prevents information leakage
- GDPR compliance (data minimization principle)

---

## Connector Workflow

### Complete Jira Example

**Scenario:** 150 fields → 75 canonical mappings → 12 critical fields → vocabulary entries

**Total Time:** 35 minutes (vs 10-20 hours manual) = **97% reduction**

---

### Step 1: Connector Configuration (2 min)

```bash
POST /api/connectors
{
  "connectorType": "jira",
  "config": {
    "url": "https://acme.atlassian.net",
    "email": "admin@acme.com",
    "apiToken": "..."
  }
}
```

---

### Step 2: Schema Discovery (30 sec)

**Action:** Discovers 150 fields from Jira API

**Output:** ConnectorSchema document

**Example Fields:**

- `customfield_10020` (Sprint)
- `customfield_10016` (Story Points)
- `summary` (Issue title)
- `status` (Workflow state)
- ... 146 more fields

---

### Step 3: Field Mapping (1 min)

**Action:** LLM suggests mappings: source → canonical

**Output:** 75 FieldMapping documents

**Example:**

- `customfield_10020` → `sprint`
- `customfield_10016` → `storyPoints`
- `summary` → `title`
- `status` → `status`

---

### Step 4: Critical Fields Detection (2 min)

**Input:** Developer examples from `JIRA_CRITICAL_FIELDS`

**Action:** LLM analyzes 75 canonical fields

**Output:** **12 critical fields** with reasoning:

```json
[
  {
    "fieldPath": "priority",
    "reasoning": "Urgency indicator with enum values. Commonly used for filtering.",
    "category": "dimension",
    "confidence": 0.96
  },
  {
    "fieldPath": "status",
    "reasoning": "Workflow state field. Most common filter (open, closed, in progress).",
    "category": "workflow",
    "confidence": 0.98
  },
  {
    "fieldPath": "assignee",
    "reasoning": "Ownership field. Users filter by person frequently.",
    "category": "dimension",
    "confidence": 0.92
  }
  // ... 9 more fields
]
```

---

### Step 5: Vocabulary Generation (2 min)

**Input:** 12 critical fields

**Action:** LLM generates for each:

- 3-5 aliases
- Human-readable description
- Related fields (displayWith: 10-30, aggregateWith: 3-7)

**Output:** 12 DomainVocabulary entries

**Example Entry:**

```json
{
  "term": "Priority",
  "canonicalField": "priority",
  "aliases": ["pri", "urgency", "importance", "priority level"],
  "description": "Urgency level indicating how quickly an issue should be addressed",
  "relatedFields": {
    "displayWith": [
      "summary",
      "status",
      "assignee",
      "created",
      "updated",
      "description",
      "reporter",
      "labels",
      "type"
    ],
    "aggregateWith": ["status", "assignee", "type"]
  },
  "autoGenerated": true,
  "confidence": 0.96,
  "enabled": true,
  "createdBy": "llm"
}
```

---

### Step 6: User Review (30 min)

**UI:** Field View shows generated vocabulary

**User Can:**

- ✅ Edit aliases, descriptions
- ✅ Add/remove related fields
- ✅ Disable low-value entries
- ✅ Add new manual entries

**Note:** This step is OPTIONAL - vocabulary is auto-enabled and ready to use immediately

---

### Step 7: Activation (instant)

**Action:**

- Vocabulary entries marked `enabled=true`
- Published to runtime cache
- Ready for query resolution

---

## Query Resolution Examples

### Example 1: Structured List Query

**User Query:** "Show me high priority bugs assigned to Sarah"

**Resolution Trace:**

1. **Query classification** → "list" (structured)

2. **Vocabulary matching:**
   - "high priority" → `priority` field, value "High"
   - "bugs" → `type` field, value "Bug"
   - "assigned to Sarah" → `assignee` field, value "sarah.johnson@acme.com"

3. **Dynamic resolution** → Use **displayWith** fields (9 fields)

4. **Capability check** → All fields filterable + indexed

5. **LLM query generation** → OpenSearch structured query with filters

6. **OpenSearch execution** → 8 results in 45ms

7. **Results include:** summary, status, priority, assignee, created, updated, description, reporter, type

**Key Point:** Used `displayWith` (9 fields) for detailed view, **OpenSearch filters only** (no vector search)

---

### Example 2: Top N Ranking Query

**User Query:** "What are the top 5 deals by revenue this quarter?"

**Resolution Trace:**

1. **Query classification** → "list" with ranking (structured)

2. **Vocabulary matching:**
   - "deals" → entity type "Opportunity"
   - "revenue" → `amount` field (measure)
   - "this quarter" → `closeDate` filter (Q1 2026)

3. **Dynamic resolution** → Use **displayWith** fields (6 fields)

4. **Temporal resolution** → "this quarter" = 2026-01-01 to 2026-03-31

5. **LLM query generation** → OpenSearch query with sort + limit

6. **OpenSearch execution** → Top 5 deals, total revenue $2.45M in 38ms

7. **Results include:** name, amount, stage, owner, accountName, closeDate

**Key Point:** Used `displayWith` (6 fields), **OpenSearch sorting** (not aggregation)

---

### Example 3: Grouping Aggregation

**User Query:** "Count bugs by assignee for the last sprint"

**Resolution Trace:**

1. **Query classification** → "aggregation" with grouping (structured)

2. **Vocabulary matching:**
   - "bugs" → `type=Bug`
   - "by assignee" → GROUP BY `assignee`
   - "last sprint" → `sprint=Sprint 23`

3. **Dynamic resolution** → Use **aggregateWith** fields (4 fields)

4. **LLM query generation** → OpenSearch terms aggregation with sub-aggs

5. **OpenSearch execution** → 47 bugs across 6 assignees in 52ms

6. **Results include breakdown by status and priority per assignee**

**Key Point:** Sub-grouping by `status` and `priority` (from aggregateWith), **OpenSearch aggregations**

---

### Example 4: Hybrid Query

**User Query:** "Show high priority bugs about login issues"

**Resolution Trace:**

1. **Query classification** → "hybrid" (structured + semantic)

2. **Vocabulary matching:**
   - **Structured:** "high priority" → `priority=High`, "bugs" → `type=Bug`
   - **Semantic:** "login issues" (no vocab match, pass to vector search)

3. **Dynamic resolution** → Use **displayWith** fields

4. **LLM query generation** → OpenSearch hybrid query:

   ```json
   {
     "query": {
       "bool": {
         "must": [
           { "knn": { "embedding": { "vector": [...], "k": 50 } } }
         ],
         "filter": [
           { "term": { "canonicalData.priority": "High" } },
           { "term": { "canonicalData.type": "Bug" } }
         ]
       }
     }
   }
   ```

5. **OpenSearch execution** → 12 results in 120ms

**Key Point:** Combines structured filters (fast) with semantic search (relevant)

---

## Key Design Decisions

### Decision 1: Dynamic Resolution ✅

**Problem:** Static resolution requires 3 separate entries per concept (filter/display/aggregate)

**Solution:** Single vocabulary entry resolves dynamically based on query context

**Example:**

```typescript
// ONE entry for "priority"
{
  term: "Priority",
  canonicalField: "priority",
  // ... other fields
}

// Resolves to:
// - Filter when query = "Show high priority bugs"
// - Display when query = "Show bug details"
// - Aggregate when query = "Count by priority"
// - Sort when query = "Sort by priority"
```

**Impact:**

- Before: 3 entries × 12 critical fields = 36 entries
- After: 12 entries
- **67% reduction in vocabulary entries**

---

### Decision 2: displayWith vs aggregateWith ✅

**Problem:** Aggregation queries fail with too many GROUP BY fields (SQL constraint)

**Solution:** Different field sets for display (10-30) vs aggregate (3-7)

**Rationale:**

- **List queries:** Need full context (user browsing details)
- **Aggregation queries:** Need concise dimensions (SQL GROUP BY compatible)

**Example:**

Priority field:

```typescript
{
  relatedFields: {
    displayWith: [
      "summary", "status", "assignee", "created",
      "updated", "description", "reporter", "labels", "type"
    ], // 9 fields - rich context for detail view

    aggregateWith: [
      "status", "assignee", "type"
    ] // 3 fields - SQL compatible for GROUP BY
  }
}
```

**Impact:**

- List queries: Show 9 fields (complete context)
- Aggregation queries: Group by 3 fields (SQL compatible)
- **No query failures due to too many GROUP BY fields**

---

### Decision 3: Critical Fields Detection ✅

**Problem:** How does LLM decide which fields are "critical"?

**Solution:** Developer provides examples → LLM dynamically identifies per project

**Approach:**

1. **Developer writes example critical fields** (one-time per connector):

   ```typescript
   // apps/search-ai/src/config/connector-critical-fields/jira.ts
   {
     fieldName: "summary",
     reasoning: "Primary identifier - every query needs issue title",
     category: "identifier"
   }
   ```

2. **Adapter converts to LLM-friendly prompt**:

   ```
   Based on these examples of critical fields for project management:
   - summary: Primary identifier
   - status: Workflow state
   - priority: Urgency level

   Analyze this project's schema and identify similar critical fields...
   ```

3. **LLM dynamically identifies for specific project**:
   - Project A (software dev): summary, status, priority, sprint, storyPoints
   - Project B (support): summary, status, priority, severity, customer

**Impact:**

- Developer provides domain knowledge (patterns)
- LLM adapts to actual project schema
- Different projects get different critical fields
- **No manual configuration per project**

---

### Decision 4: Vocabulary Auto-Activation ✅

**Problem:** When should vocabulary be enabled?

**Solution:** Generate → Auto-activate → User can edit later

**Workflow:**

1. Vocabulary generated with confidence scores
2. All entries auto-enabled (even low confidence)
3. Field View UI shows entries
4. User can disable/edit entries anytime
5. Changes propagate to runtime immediately

**Rationale:**

- Get value immediately (no blocking on user review)
- User reviews only when needed (not upfront)
- Low confidence entries still provide value (better than nothing)

**Impact:**

- Setup time: 5 min (generation) + 0 min (activation) = **5 min to get value**
- Optional review: +30 min for quality improvement
- Total: 35 min vs 10-20 hours manual = **97% reduction**

---

### Decision 5: Sample Values Strategy ✅

**Problem:** Should we fetch sample values from source data?

**Solution:** Enums only, no PII

**Rules:**

- ✅ Include enum values (status, priority, type) - from metadata
- ❌ No sample values from records (performance, privacy, cost)
- ❌ No PII fields (names, emails, addresses)

**Example:**

```typescript
{
  canonicalField: "priority",
  enumValues: ["Highest", "High", "Medium", "Low", "Lowest"],
  sampleValues: []  // Not populated
}

{
  canonicalField: "assignee",
  enumValues: null,
  sampleValues: []  // Not populated (PII)
}
```

**Impact:**

- No additional API calls to fetch records
- No privacy concerns
- Faster schema discovery
- LLM still has enum context for query generation

---

### Decision 6: Hybrid Search Support (OpenSearch) ✅ **CRITICAL**

**Problem:** Original design showed MongoDB queries, but system uses OpenSearch (vector database) with hybrid search capabilities.

**Solution:** All queries execute on OpenSearch, supporting structured, semantic, and hybrid search.

**Critical Correction:**

- ❌ **WRONG:** Queries execute on MongoDB
- ✅ **CORRECT:** Queries execute on OpenSearch (vector database)

**Search Type Decision:**

| User Query Pattern                    | Search Type | Components       | OpenSearch Query                  |
| ------------------------------------- | ----------- | ---------------- | --------------------------------- |
| "Show high priority bugs"             | Structured  | Filters only     | `bool.filter`                     |
| "Show bugs about login issues"        | Semantic    | Vector k-NN only | `knn`                             |
| "Show high priority bugs about login" | Hybrid      | Filters + Vector | `bool.must: [knn], filter: [...]` |
| "Count bugs by assignee"              | Aggregation | OpenSearch aggs  | `aggs: { terms }`                 |

**Impact:**

- ✅ Supports pure filter queries (fast, <50ms)
- ✅ Supports pure semantic queries (k-NN, ~100ms)
- ✅ Supports hybrid queries (most powerful, ~120ms)
- ✅ System automatically determines search type
- ✅ Aggregations work on OpenSearch (terms, stats, date_histogram)

**Why This is Critical:**

- Without hybrid search: Users cannot combine semantic + structured
- Wrong database (MongoDB) → Design would fail in production
- Missing 50% of use cases (semantic search)

---

## Implementation Phases

### Phase 1: Critical Fields Detection (2 weeks)

**Components:**

1. `CriticalFieldsDetectorService`
2. Connector configs (Jira, Salesforce, HubSpot)
3. LLM prompt templates
4. Unit tests

**Deliverables:**

- ✅ Service identifies 10-20 critical fields from schema
- ✅ Connector configs provide domain knowledge
- ✅ 90%+ accuracy vs manual selection

**Dependencies:** None (uses existing schema discovery)

---

### Phase 2: Vocabulary Generation (2 weeks)

**Components:**

1. `VocabularyGeneratorWorker`
2. LLM prompt templates for aliases/descriptions/relatedFields
3. Queue integration
4. API endpoints

**Deliverables:**

- ✅ Auto-generate vocabulary from critical fields
- ✅ 3-5 aliases per field (high confidence)
- ✅ Related fields (displayWith: 10-30, aggregateWith: 3-7)
- ✅ 5 min generation time

**Dependencies:** Phase 1 (critical fields detection)

---

### Phase 3: Dynamic Resolution (2 weeks)

**Components:**

1. `VocabularyResolverV2`
2. `CapabilityRegistryService`
3. `QueryClassifierService`
4. Cache + Redis pub/sub

**Deliverables:**

- ✅ Dynamic resolution (filter/display/aggregate/sort)
- ✅ Capability verification
- ✅ <50ms resolution (cached)
- ✅ Query classification (list/aggregate/search)

**Dependencies:** Phase 2 (vocabulary entries exist)

---

### Phase 4: Field View UI (2 weeks)

**Components:**

1. React components (Field View)
2. Vocabulary CRUD APIs
3. Real-time updates
4. Bulk operations

**Deliverables:**

- ✅ View generated vocabulary
- ✅ Edit aliases, descriptions, related fields
- ✅ Enable/disable entries
- ✅ Add manual entries

**Dependencies:** Phase 2 (vocabulary API)

---

### Phase 5: Agent-SearchAI Protocol (2 weeks)

**Components:**

1. SearchAI MCP server (`/apps/search-ai-mcp-server/`)
2. MCP tool implementations (8 tools)
3. Runtime integration (`RuntimeMcpClientProvider`)
4. Vocabulary caching

**Deliverables:**

- ✅ MCP server exposing 8 tools
- ✅ Agent workflow patterns documented
- ✅ Vocabulary caching (5 min TTL)
- ✅ Trace events for observability

**Dependencies:** Phase 3 (vocabulary resolver)

---

### Phase 6: Integration & Testing (2 weeks)

**Tasks:**

1. End-to-end testing (connector config → query resolution)
2. Performance testing (cache hit rates, query times)
3. LLM accuracy validation
4. Documentation

**Deliverables:**

- ✅ 85%+ query success rate
- ✅ <200ms query resolution
- ✅ 97% setup time reduction
- ✅ Developer docs

**Dependencies:** All phases

---

### Phase 7: Migration (2 weeks)

**Tasks:**

1. Migrate existing vocabulary entries to new schema
2. Generate vocabulary for existing KBs
3. Deprecate old vocabulary resolver
4. Rollout plan

**Deliverables:**

- ✅ All existing KBs have new vocabulary
- ✅ Zero downtime migration
- ✅ Rollback plan

**Dependencies:** Phase 6 (tested system)

---

**Total Timeline:** 14 weeks (~3.5 months)

---

## Success Metrics

| Metric                         | Current                      | Target      | Measured At    |
| ------------------------------ | ---------------------------- | ----------- | -------------- |
| Setup time per KB              | 10-20 hours                  | 30 minutes  | End of Phase 7 |
| Vocabulary entries per concept | 3 (filter/display/aggregate) | 1 (dynamic) | End of Phase 2 |
| Query success rate             | 60%                          | 85%         | End of Phase 6 |
| Aggregation context            | 0%                           | 95%         | End of Phase 3 |
| Resolution latency (cached)    | N/A                          | <50ms       | End of Phase 3 |
| Resolution latency (uncached)  | N/A                          | <200ms      | End of Phase 3 |
| Critical fields accuracy       | Manual baseline              | 90%+        | End of Phase 1 |

---

## Next Steps

1. **Review this high-level design** (1-2 hours)
2. **Provide feedback on design decisions**
3. **Approve or request changes**
4. **Proceed to detailed design** (if approved)
   - Finalize exact TypeScript schemas
   - Write complete LLM prompt templates
   - Create API specifications
   - Design UI mockups
   - Define database indexes
5. **Create implementation tickets**
6. **Start Phase 1 development**

---

## Supporting Documents

- **Requirements:** `01-REQUIREMENTS.md` - Full RFC with 9 functional requirements
- **Database Architecture:** `appendices/DATABASE-ARCHITECTURE.md` - Two-database explanation
- **Query Examples:** `appendices/QUERY-RESOLUTION-EXAMPLES.md` - 5 detailed examples
- **Workflow Example:** `examples/JIRA-CONNECTOR-WORKFLOW.md` - Complete Jira workflow
- **RFC Summary:** `appendices/RFC-SUMMARY.md` - Quick reference

---

**Design Status:** ✅ Complete - Ready for Review

**Last Updated:** 2026-03-07
