# RFC: Dynamic Vocabulary Resolution & Auto-Generation

**RFC ID:** RFC-SEARCHAI-001
**Status:** DRAFT - Pending Review
**Created:** 2026-03-06
**Author:** Architecture Team
**Reviewers:** Bharat Rekha (Product/Architecture Lead)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Goals & Non-Goals](#goals--non-goals)
4. [Current State Analysis](#current-state-analysis)
5. [Requirements](#requirements)
6. [Proposed Solution](#proposed-solution)
7. [Success Criteria](#success-criteria)
8. [Open Questions](#open-questions)
9. [References](#references)

---

## Executive Summary

**Problem:** Current vocabulary system requires manual creation (10-20 hours per KB) and locks each term to a single resolution type (filter OR display OR aggregate), making it inflexible and high-maintenance.

**Proposed Solution:**

1. **Dynamic Resolution** - Same vocabulary entry resolves to different uses (filter/display/aggregate/sort) based on query context using LLM with schema injection
2. **Auto-Generation** - LLM automatically generates vocabulary from discovered schema, reducing setup time from 10-20 hours to 30 minutes
3. **Smart Aggregations** - System knows which context fields to include for meaningful results

**Impact:** 97% reduction in setup time, 3x fewer vocabulary entries needed, enables self-serve KB configuration.

---

## Problem Statement

### Current Issues (From Review Comments)

#### Issue 1: Static Resolution Pattern

**Problem:** Vocabulary entries are locked to ONE resolution type at creation time.

**Example:**

```typescript
// Current: Need 3 separate entries for same concept
{ term: "priority", resolution: { type: "filter" } }           // For "filter by priority"
{ term: "priority field", resolution: { type: "field" } }      // For "show priority"
{ term: "priority breakdown", resolution: { type: "aggregate" } } // For "count by priority"
```

**Impact:**

- 3x vocabulary entries needed
- Users must guess exact phrasing
- Maintenance nightmare (update 3 places for one field)

**User Experience:**

- ❌ "Show me priority field" → Applies filter instead (wrong)
- ❌ "Count bugs by priority" → No grouping (wrong)
- ✅ "Filter by high priority" → Works (only configured use case)

#### Issue 2: Manual Vocabulary Creation

**Problem:** Creating vocabulary takes 10-20 hours per knowledge base, all manual.

**Current Workflow:**

1. Configure connector (Jira/Salesforce)
2. Schema discovery finds 150 fields
3. Map 75 fields to canonical schema
4. **Manually create 75 vocabulary entries** (10-20 hours)
5. **Manually think of 3-5 aliases per field**
6. Hope you didn't miss important ones

**Impact:**

- Adoption barrier: Feature underutilized due to setup pain
- Incomplete coverage: Admins create 10 entries, give up on remaining 65
- Quality issues: Typos, missing aliases, inconsistent naming

#### Issue 3: Context-Less Aggregations

**Problem:** Aggregation results show only measure field, lacking context.

**Example:**

```typescript
// Query: "What are the top 5 deals?"
// Current response
{
  results: [
    { deal_value: 750000 }, // Which customer? Who owns it? What region?
    { deal_value: 680000 },
    { deal_value: 500000 },
  ];
}
// ❌ Results not actionable - missing context
```

**Expected:**

```typescript
{
  results: [
    { deal_value: 750000, customer_name: 'Acme Corp', sales_rep: 'John Doe', region: 'West' },
    { deal_value: 680000, customer_name: 'TechCo', sales_rep: 'Jane Smith', region: 'East' },
  ];
}
// ✅ Actionable results with context
```

#### Issue 4: Capabilities Hardcoded

**Problem:** System capabilities (SUM, COUNT, AVG, operators) exist only in TypeScript types, not discoverable at runtime.

**Impact:**

- LLM agents can't query "what can this system do?"
- Error messages unhelpful: "Invalid function" without listing valid ones
- Can't customize capabilities per tenant/project

#### Issue 5: Query Classification Implicit

**Problem:** Query types (list/aggregation/search) determined by hardcoded patterns in agent code.

**Impact:**

- Inconsistent classification across agents
- Can't customize per domain (Jira vs Salesforce queries differ)
- No sample queries to guide classification

---

## Goals & Non-Goals

### Goals

1. **Dynamic Resolution**
   - Single vocabulary entry supports multiple uses (filter, display, aggregate, sort)
   - Resolution determined at query time based on intent
   - Follows proven patterns: schema injection + LLM reasoning

2. **Automated Vocabulary Generation**
   - LLM auto-generates vocabulary from discovered schema
   - Reduce setup time from 10-20 hours → 30 minutes
   - Generate: aliases, descriptions, related fields, capabilities

3. **Smart Aggregations**
   - System knows which context fields to include
   - Different fields for display vs aggregation
   - Meaningful, actionable results

4. **Discoverable Capabilities**
   - Capabilities stored as queryable data
   - LLM agents can discover what system supports
   - Include trigger keywords and example queries

5. **Field Vocabulary Only (Phase 1)**
   - Focus on field names/aliases
   - Defer entity value recognition to Phase 2

### Non-Goals (Out of Scope)

#### 1. Entity Resolution (Phase 2)

**Problem:** Identifying entity values that aren't in fixed domain vocabulary

**Examples:**

```
Query: "Show me all bugs assigned to Bharat"
Challenge: How does system know "Bharat" is a person name → maps to assignee field?

Query: "Show me all bugs related to SearchAI"
Challenge: Is "SearchAI" a project name → maps to project field? Or semantic concept → vector search?

Query: "Show me all bugs related to custom embeddings"
Challenge: "custom embeddings" is a feature name → semantic search content (not a field)
```

**Current Approach (Phase 1):**

- Field-level vocabulary only: "assignee", "priority", "status"
- Entity values handled by:
  1. **Enum fields**: If "High" is enum value for priority → direct mapping
  2. **Semantic search**: Unknown terms → passed to vector search
  3. **Manual vocabulary**: User can add "Bharat" → assignee mapping manually

**Phase 2 Approach (Future):**

**This requirement needs to be discussed and designed separately.**

Entity resolution can be solved in multiple ways:

- Named Entity Recognition (NER) models
- Value lookup in indexed data
- Clarification loops with user
- LLM-based entity extraction
- Hybrid approaches combining multiple techniques

The specific approach will be determined based on:

- Accuracy requirements
- Performance constraints
- Infrastructure availability
- Cost considerations
- User experience goals

**Out of Scope for Phase 1** - No specific approach is prescribed at this time.

**Why Deferred to Phase 2:**

- Requires additional ML models (NER) or extensive value indexing
- Can be handled by semantic search in Phase 1 (good enough)
- Field-level vocabulary provides 80% of value
- No blocking use cases in Phase 1

**Impact if Not Implemented in Phase 1:**

- ✅ CAN: "Show high priority bugs" (field-level works)
- ✅ CAN: "Show bugs about login issues" (semantic search)
- ❌ CANNOT: "Show bugs assigned to Bharat" (needs entity resolution)
- **Workaround**: User says "Show bugs assigned to bharat.rekha@kore.com" (exact value)

#### 2. Multi-language Support (Phase 8)

Start English-only, expand to other languages later

#### 3. SharePoint Connector (Separate Effort)

Not implemented yet, independent project

#### 4. Tenant-Level Capability Customization (Phase 9)

Start with global capabilities, add per-tenant overrides later

---

## Current State Analysis

### Existing Implementation

**Schema Discovery** ✅ EXISTS

- File: `apps/search-ai/src/services/schema-discovery/`
- Connectors: Salesforce, Jira, HubSpot, GoogleDrive
- Worker: `schema-sync-worker.ts`
- Captures: field name, label, type, isCustom, enumValues

**Vocabulary Resolution** ✅ EXISTS (Needs Enhancement)

- File: `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts`
- Current: Static resolution (one type per entry)
- Needs: Dynamic resolution based on query context

**Canonical Mapping** ✅ EXISTS

- File: `apps/search-ai/src/services/canonical-mapping/canonical-mapper.service.ts`
- Applies field mappings at ingestion time

**Critical Fields Configuration** ❌ DOES NOT EXIST

- No storage for field importance/criticality
- Needs to be built

**Vocabulary Auto-Generation** ❌ DOES NOT EXIST

- No LLM-powered vocabulary creation
- Needs to be built

**Field View UI** ❌ DOES NOT EXIST

- No UI for editing vocabulary per KB
- Needs to be built

### Data Models

**ConnectorSchema** (Layer 1)

```typescript
{
  connectorId: string,
  fields: [{
    path: string,              // "customfield_10001"
    label: string,             // "Story Points"
    type: string,              // "number"
    isCustom: boolean,
    enumValues?: string[],
    sampleValues?: unknown[]   // Mostly empty today
  }]
}
```

**CanonicalSchema** (Layer 2)

```typescript
{
  knowledgeBaseId: string,
  fields: [{
    name: string,              // "story_points"
    label: string,             // "Story Points"
    type: string,
    indexed: boolean,
    filterable: boolean,
    aggregatable: boolean,
    enumValues?: string[]
  }]
}
```

**DomainVocabulary** (Layer 3 - Current, Needs Redesign)

```typescript
{
  projectKnowledgeBaseId: string,
  entries: [{
    term: string,
    aliases: string[],
    resolution: any            // ❌ Static, single type
  }]
}
```

---

## Requirements

### Functional Requirements

#### FR-1: Dynamic Vocabulary Resolution

**Priority:** P0 (Blocker)

**Requirement:** Single vocabulary entry must support multiple resolution modes based on query context.

**Acceptance Criteria:**

- ✅ Same term resolves to filter when query intent is filtering
- ✅ Same term resolves to display when query intent is showing fields
- ✅ Same term resolves to aggregate when query intent is grouping/summing
- ✅ Same term resolves to sort when query intent is ordering
- ✅ Resolution determined at query time using LLM + schema injection
- ✅ Follows proven pattern from SQLCoder (91.4% accuracy)

**Example:**

```typescript
// Query: "Show priority field"
resolve("priority", { queryIntent: "display" })
  → { type: "field", fields: ["priority"] }

// Query: "Filter by high priority"
resolve("priority", { queryIntent: "filter" })
  → { type: "filter", field: "priority", operator: "in", values: ["P0", "P1"] }

// Query: "Count bugs by priority"
resolve("priority", { queryIntent: "aggregate" })
  → { type: "aggregate", measure: "priority", function: "count", groupBy: ["priority"] }
```

**Technical Approach:**

- Vocabulary stores: field reference, capabilities (what's possible)
- Capabilities inferred from canonical field type (filterable, aggregatable, sortable)
- LLM receives complete schema in prompt
- LLM generates structured query with tool use (strict schema validation)

#### FR-2: Automated Vocabulary Generation

**Priority:** P0 (Blocker)

**Requirement:** LLM auto-generates vocabulary entries from discovered schema during connector configuration.

**Acceptance Criteria:**

- ✅ Triggered when connector configured (after schema discovery + field mapping)
- ✅ Generates for critical fields only (10-20 per KB, not all 150)
- ✅ LLM generates: 3-5 high-confidence aliases, description, related fields
- ✅ Auto-activates (user can edit later in field view UI)
- ✅ Generation completes in <5 minutes for 100-field schema
- ✅ Uses canonical field label as vocabulary term

**LLM Inputs:**

- Canonical field: name, label, type, description, capabilities
- Source field: path, label (from ConnectorSchema)
- Sample values: For enums only (status, priority, project names)
- Context: All fields in KB (for related field inference)
- Domain examples: Critical field patterns per connector type

**LLM Outputs:**

- Aliases: 3-5 natural language terms (empty if low confidence)
- Description: User-friendly explanation (if not in schema)
- Related fields:
  - `displayWith`: Fields for detail view (10-30 fields)
  - `aggregateWith`: Fields for aggregated view (3-7 fields)
- Confidence: 0.0-1.0

**Workflow:**

```
Connector Configured
  ↓
Schema Discovery (existing)
  ↓
Field Mapping (existing)
  ↓
Critical Fields Identification (NEW)
  ↓ LLM analyzes schema + example patterns
  ↓ Identifies 10-20 critical fields
  ↓
Vocabulary Generation (NEW)
  ↓ LLM generates entry per critical field
  ↓ Auto-activates
  ↓
User Reviews in Field View UI (NEW)
  ↓ Can edit, add more fields
```

#### FR-3: Critical Fields Detection

**Priority:** P0 (Blocker)

**Requirement:** System identifies which fields are "critical" for vocabulary generation per domain/project.

**Acceptance Criteria:**

- ✅ Developer provides example critical fields + reasoning per connector type
- ✅ LLM dynamically identifies critical fields for specific project/KB
- ✅ Different projects using same connector = different critical fields
- ✅ Configuration stored in developer-friendly format
- ✅ Adapter converts to LLM-friendly prompt

**Developer Configuration Example:**

```typescript
// apps/search-ai/src/config/connector-critical-fields.ts

export const JIRA_CRITICAL_FIELDS_EXAMPLES = {
  connectorType: 'jira',
  domain: 'Project Management / Issue Tracking',

  exampleCriticalFields: [
    {
      fieldName: 'summary',
      reasoning: 'Primary identifier - every query needs issue title',
      category: 'identifier',
      typicallyUsedFor: ['display', 'search'],
    },
    {
      fieldName: 'status',
      reasoning: 'Workflow state - most common filter',
      category: 'workflow',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    // ... more examples
  ],

  criticalFieldPatterns: [
    {
      category: 'identifier',
      patterns: ['title', 'name', 'summary', 'subject'],
      reasoning: 'Fields that identify individual records',
    },
    // ... more patterns
  ],
};
```

**LLM Process:**

1. Receives: discovered schema + example patterns
2. Analyzes: field names, types, patterns
3. Identifies: 10-20 critical fields for THIS project
4. Returns: Field paths + reasoning + confidence scores

#### FR-4: Context-Aware Aggregations

**Priority:** P0 (Blocker)

**Requirement:** Aggregation results must include context fields for meaningful interpretation.

**Acceptance Criteria:**

- ✅ Vocabulary entry specifies related fields
- ✅ Different fields for `displayWith` vs `aggregateWith`
- ✅ Aggregated views show 3-7 fields max (SQL GROUP BY constraint + UX best practice)
- ✅ Detail views show 10-30+ fields (all relevant context)

**Technical Requirement (SQL GROUP BY):**

```sql
-- Aggregated query can ONLY select:
SELECT
  customer_name,     -- ✅ In GROUP BY
  region,            -- ✅ In GROUP BY
  SUM(deal_value)    -- ✅ Aggregated
  -- ❌ CANNOT: notes, created_at, stage (not in GROUP BY)
FROM deals
GROUP BY customer_name, region
```

**UX Best Practice (BI Tools Pattern):**

- Aggregated: 3-7 fields (quick scanning, cognitive load optimization)
- Detail: 10-30+ fields (deep investigation)

**Implementation:**

```typescript
// Vocabulary entry
{
  term: "Deal Value",
  relatedFields: {
    displayWith: [
      "customer_name", "sales_rep", "region",
      "close_date", "stage", "probability", "notes"
    ],  // 7+ fields for detail view

    aggregateWith: [
      "customer_name", "sales_rep", "region"
    ]  // 3 fields for aggregated view
  }
}
```

**Concrete Example: Top Deals Query**

**User Query:** "What are the top 5 deals by revenue in the last quarter?"

**❌ Without Context (Current Problem):**

```json
{
  "results": [
    { "deal_value": 750000 },
    { "deal_value": 680000 },
    { "deal_value": 500000 },
    { "deal_value": 420000 },
    { "deal_value": 385000 }
  ]
}
```

**Problem:** Results not actionable - Which customer? Who owns it? What region? What stage?

---

**✅ With Context (Required Solution):**

```json
{
  "results": [
    {
      "deal_value": 750000,
      "customer_name": "Acme Corporation",
      "region": "West Coast",
      "sales_division": "Enterprise",
      "sales_person_name": "John Smith",
      "customer_success_name": "Sarah Johnson",
      "stage": "Negotiation"
    },
    {
      "deal_value": 680000,
      "customer_name": "TechCo Industries",
      "region": "East Coast",
      "sales_division": "Enterprise",
      "sales_person_name": "Jane Doe",
      "customer_success_name": "Mike Wilson",
      "stage": "Closed Won"
    },
    {
      "deal_value": 500000,
      "customer_name": "Global Systems Inc",
      "region": "Midwest",
      "sales_division": "Commercial",
      "sales_person_name": "Bob Chen",
      "customer_success_name": "Lisa Anderson",
      "stage": "Proposal"
    }
    // ... 2 more deals
  ],
  "totalRevenue": 2735000
}
```

**Result:** Now actionable - Can contact sales rep, understand regional performance, track stage distribution

**Context Fields Required (5-6 fields):**

1. **customer_name**: Who is the deal with? (identifier)
2. **region**: Geographic distribution analysis (dimension)
3. **sales_division**: Enterprise vs Commercial tracking (dimension)
4. **sales_person_name**: Individual performance attribution (dimension)
5. **customer_success_name**: Post-sale ownership (dimension)
6. **stage**: Pipeline stage distribution (workflow dimension)

**Vocabulary Entry for "deal_value":**

```typescript
{
  term: "Deal Value",
  canonicalField: "amount",
  relatedFields: {
    aggregateWith: [
      "customer_name",
      "region",
      "sales_division",
      "sales_person_name",
      "customer_success_name",
      "stage"
    ]  // 6 context fields for meaningful aggregation results
  }
}
```

**Why These Fields:**

- **customer_name**: Mandatory - can't take action without knowing customer
- **sales_person_name**: Attribution - who to reward/coach
- **region**: Performance by geography
- **sales_division**: Segment analysis (Enterprise vs Commercial)
- **customer_success_name**: Handoff tracking
- **stage**: Pipeline health indicator

**LLM Determines Related Fields Using:**

- Domain heuristics (financial fields → customer, rep, region)
- Field type analysis (number fields with string context fields)
- Example patterns from developer config

#### FR-5: Capability Registry

**Priority:** P1 (Important)

**Requirement:** System capabilities stored as queryable data, not hardcoded.

**Acceptance Criteria:**

- ✅ Separate data model for capabilities
- ✅ Includes: aggregation functions, operators, trigger keywords, examples
- ✅ API endpoint to retrieve capabilities
- ✅ Can be queried by LLM agents
- ✅ Start global (same for all tenants)

**Data Structure:**

```typescript
{
  aggregationFunctions: [
    {
      name: "sum",
      description: "Add up numeric values",
      supportedFieldTypes: ["number"],
      triggerKeywords: ["total", "sum", "add up"],
      examples: ["What is the total revenue?"]
    }
  ],
  operators: [
    {
      name: "in",
      description: "Match any value in list",
      supportedFieldTypes: ["string", "number"],
      triggerKeywords: ["in", "is", "equals"]
    }
  ]
}
```

#### FR-6: Query Type Classification

**Priority:** P1 (Important)

**Requirement:** Query type definitions stored as data with examples.

**Acceptance Criteria:**

- ✅ Query types: list, aggregation, search, hybrid
- ✅ Patterns and examples stored per type
- ✅ Can be customized per domain (Jira patterns vs Salesforce patterns)
- ✅ Used by agents for query classification

**Data Structure:**

```typescript
{
  type: "aggregation",
  description: "Aggregate data with functions",
  patterns: [
    {
      pattern: "^(how many|count|total)",
      keywords: ["how many", "count", "total"],
      examples: ["How many bugs are open?", "Total revenue by region"],
      confidence: 0.95
    }
  ]
}
```

#### FR-7: Field View UI

**Priority:** P0 (Blocker - Required for Launch)

**Requirement:** UI for viewing and editing vocabulary per knowledge base.

**Acceptance Criteria:**

- ✅ List all vocabulary entries for KB
- ✅ Show auto-generated entries (editable)
- ✅ Allow manual addition of fields
- ✅ Edit aliases, related fields, descriptions
- ✅ Enable/disable entries
- ✅ Preview: "Users can query this as: [aliases]"

**UI Sections:**

- Field list (all canonical fields)
- Vocabulary status (has entry? auto-generated? custom?)
- Edit modal (term, aliases, description, related fields)
- Preview panel (example queries)

#### FR-8: Unified Resolution Endpoint

**Priority:** P1 (Important)

**Requirement:** Single endpoint returns vocabulary + capabilities + query type examples.

**Acceptance Criteria:**

- ✅ One API call gets all data needed for query rephrasing
- ✅ Reduces agent round-trips
- ✅ Combines: vocabulary entries, capability definitions, query type patterns

**Endpoint:**

```typescript
GET /api/search-ai-runtime/projects/:projectId/kb/:kbId/query-schema

Response:
{
  vocabulary: { fields: [...] },
  capabilities: { aggregationFunctions: [...], operators: [...] },
  queryTypes: { list: {...}, aggregation: {...}, search: {...} }
}
```

#### FR-9: Hybrid Search Support (OpenSearch)

**Priority:** P0 (Blocker - Critical Gap)

**Requirement:** Vocabulary resolution must support hybrid search queries combining semantic (vector) search with structured filters on OpenSearch.

**Critical Context:**

- ❌ Search happens on **OpenSearch** (vector database), NOT MongoDB
- ✅ OpenSearch stores: embeddings (vector) + canonicalData (structured)
- ✅ Queries can be: structured only, semantic only, or hybrid (both)

**Acceptance Criteria:**

- ✅ Query classifier identifies search type:
  - **Structured**: Pure filters ("Show high priority bugs") → OpenSearch filters only
  - **Semantic**: Natural language ("Show bugs about login issues") → Vector k-NN search only
  - **Hybrid**: Both ("Show high priority bugs about login issues") → Filters + vector search
- ✅ Vocabulary resolver separates:
  - Structured terms → Map to canonical fields (filters)
  - Semantic terms → Pass to vector search (embeddings)
- ✅ LLM generates OpenSearch query format (not MongoDB)
- ✅ Supports OpenSearch aggregations (terms, stats, date_histogram)
- ✅ List queries use OpenSearch filters with displayWith fields
- ✅ Aggregation queries use OpenSearch aggregations with aggregateWith fields

**Query Type Determination:**

| User Query                            | Search Type              | Components            | OpenSearch Query                               |
| ------------------------------------- | ------------------------ | --------------------- | ---------------------------------------------- |
| "Show high priority bugs"             | Structured               | Filters only          | `bool.filter: [priority, type]`                |
| "Show bugs about login issues"        | Semantic                 | Vector only           | `knn: { embedding: [...], k: 50 }`             |
| "Show high priority bugs about login" | Hybrid                   | Filters + Vector      | `bool.must: [knn], filter: [priority, type]`   |
| "Count bugs by assignee"              | Aggregation (Structured) | Aggregation + Filters | `aggs: { by_assignee: {...} }, filter: [type]` |

**Example 1: Structured Query (Filters Only)**

```typescript
// Query: "Show high priority bugs in open status"
// Resolution:
{
  searchType: "structured",
  hasSemanticComponent: false,
  vocabulary: [
    { term: "high priority", field: "priority", value: "High" },
    { term: "bugs", field: "type", value: "Bug" },
    { term: "open status", field: "status", value: "Open" }
  ]
}

// LLM generates OpenSearch query:
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "canonicalData.priority": "High" } },
        { "term": { "canonicalData.type": "Bug" } },
        { "term": { "canonicalData.status": "Open" } }
      ]
    }
  },
  "_source": ["canonicalData.summary", "canonicalData.status", ...]
}
```

**Example 2: Semantic Query (Vector Only)**

```typescript
// Query: "Show bugs about login issues"
// Resolution:
{
  searchType: "semantic",
  hasSemanticComponent: true,
  structuredFilters: [
    { term: "bugs", field: "type", value: "Bug" }  // Structured component
  ],
  semanticQuery: "login issues"  // Semantic component
}

// LLM generates OpenSearch query:
{
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "embedding": {
              "vector": [0.123, -0.456, ...],  // "login issues" embedded
              "k": 50
            }
          }
        }
      ],
      "filter": [
        { "term": { "canonicalData.type": "Bug" } }
      ]
    }
  }
}
```

**Example 3: Hybrid Query (Filters + Vector)**

```typescript
// Query: "Show high priority bugs about login issues in open status"
// Resolution:
{
  searchType: "hybrid",
  hasSemanticComponent: true,
  structuredFilters: [
    { term: "high priority", field: "priority", value: "High" },
    { term: "bugs", field: "type", value: "Bug" },
    { term: "open status", field: "status", value: "Open" }
  ],
  semanticQuery: "login issues"
}

// LLM generates OpenSearch query:
{
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "embedding": {
              "vector": [0.123, -0.456, ...],
              "k": 50
            }
          }
        }
      ],
      "filter": [
        { "term": { "canonicalData.priority": "High" } },
        { "term": { "canonicalData.type": "Bug" } },
        { "term": { "canonicalData.status": "Open" } }
      ]
    }
  }
}
```

**Example 4: Aggregation Query (OpenSearch Aggregations)**

```typescript
// Query: "Count bugs by assignee for last sprint"
// Resolution:
{
  searchType: "aggregation",
  hasSemanticComponent: false,
  filters: [
    { field: "type", value: "Bug" },
    { field: "sprint", value: "Sprint 23" }
  ],
  aggregation: {
    groupBy: "assignee",
    subGroups: ["status", "priority"]  // From aggregateWith
  }
}

// LLM generates OpenSearch query:
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "canonicalData.type": "Bug" } },
        { "term": { "canonicalData.sprint": "Sprint 23" } }
      ]
    }
  },
  "aggs": {
    "by_assignee": {
      "terms": {
        "field": "canonicalData.assignee.keyword",
        "size": 100
      },
      "aggs": {
        "by_status": {
          "terms": { "field": "canonicalData.status.keyword" }
        },
        "by_priority": {
          "terms": { "field": "canonicalData.priority.keyword" }
        }
      }
    }
  },
  "size": 0
}
```

**Technical Requirements:**

1. **Query Classifier Enhancement:**
   - Add `searchType` field: "structured" | "semantic" | "hybrid"
   - Add `hasSemanticComponent` boolean
   - Identify semantic terms (not mapped to vocabulary)

2. **Vocabulary Resolver Enhancement:**
   - Return both: `structuredTerms` (mapped to fields) + `semanticQuery` (unmapped text)
   - Do NOT fail if some terms don't map to vocabulary (could be semantic)

3. **LLM Query Generator Enhancement:**
   - Generate OpenSearch DSL (not MongoDB)
   - Support `knn` queries for vector search
   - Support `bool.must` (semantic) + `bool.filter` (structured)
   - Support OpenSearch aggregations syntax

4. **Schema Injection Update:**
   - Include field types for OpenSearch mappings
   - Include vector search parameters (k, similarity)
   - Include aggregation field types (.keyword for text fields)

**Why This is Critical:**

- Without hybrid search: Users cannot combine semantic + structured queries
- Current design shows MongoDB queries → WRONG database
- List queries without semantic search → Missing 50% of use cases
- System must support: "Show [structured filters] about [semantic concept]"

#### FR-10: Agent Integration Endpoints

**Priority:** P0 (Blocker - Agent Support)

**Requirement:** SearchAI must expose endpoints that enable LLM agents to classify queries, rephrase with vocabulary context, and extract fields for execution.

**Context:**

This addresses the core agent-search integration workflow where agents need to:

1. **Download context** before processing queries
2. **Classify query type** with examples
3. **Rephrase query** using vocabulary awareness
4. **Extract fields** for execution

**Acceptance Criteria:**

✅ **Endpoint 1: Get Classification Examples**

- Returns example queries for each query type (list, aggregation, search, hybrid)
- Includes reasoning for classification
- Provides expected components (filters, semantic terms, aggregations)
- Enables agent LLM to classify new queries consistently

**Example Response:**

```json
{
  "queryTypes": {
    "structured": {
      "description": "Queries with field filters, no semantic concepts",
      "examples": [
        {
          "query": "Show high priority bugs",
          "reasoning": "Clear field references (priority=High, type=Bug)",
          "expectedFilters": ["priority", "type"]
        },
        {
          "query": "Find tickets assigned to John",
          "reasoning": "Direct field mapping (assignee=John)",
          "expectedFilters": ["assignee"]
        }
      ]
    },
    "semantic": {
      "description": "Queries about concepts, not specific fields",
      "examples": [
        {
          "query": "Find bugs about login issues",
          "reasoning": "Semantic concept 'login issues' requires vector search",
          "expectedConcepts": ["login issues"]
        }
      ]
    },
    "hybrid": {
      "description": "Queries combining structured filters and semantic concepts",
      "examples": [
        {
          "query": "Show high priority bugs about authentication",
          "reasoning": "Structured (priority, type) + Semantic (authentication)",
          "expectedFilters": ["priority", "type"],
          "expectedConcepts": ["authentication"]
        }
      ]
    },
    "aggregation": {
      "description": "Queries with grouping, counting, or statistical operations",
      "examples": [
        {
          "query": "Count bugs by assignee",
          "reasoning": "Aggregation operation (count) with grouping (by assignee)",
          "expectedAggregation": { "function": "count", "groupBy": "assignee" }
        }
      ]
    }
  }
}
```

✅ **Endpoint 2: Get Vocabulary for Rephrasing**

- Returns field terms, aliases, and descriptions
- Enables agent to rephrase query with vocabulary awareness
- Agent uses this BEFORE semantic rephrasing (download-first pattern)

**Example Response:**

```json
{
  "vocabulary": [
    {
      "term": "author",
      "canonicalField": "createdBy",
      "aliases": ["creator", "writer", "created by"],
      "description": "Person who created the document",
      "fieldType": "string",
      "capabilities": ["filter", "display", "aggregate"]
    },
    {
      "term": "priority",
      "canonicalField": "priority",
      "aliases": ["pri", "importance", "urgency"],
      "enumValues": ["Highest", "High", "Medium", "Low", "Lowest"],
      "capabilities": ["filter", "display", "aggregate", "sort"]
    }
  ]
}
```

✅ **Endpoint 3: Extract Fields from Rephrased Query**

- Takes rephrased query as input
- Returns structured field extraction
- Identifies filters, display fields, aggregations, sort operations
- Validates fields exist in vocabulary/schema

**Example Request:**

```json
{
  "query": "Show high priority bugs in open status",
  "queryType": "list",
  "knowledgeBaseId": "kb-jira"
}
```

**Example Response:**

```json
{
  "extractedFields": {
    "filters": [
      {
        "field": "priority",
        "operator": "equals",
        "value": "High",
        "source": "high priority"
      },
      {
        "field": "type",
        "operator": "equals",
        "value": "Bug",
        "source": "bugs"
      },
      {
        "field": "status",
        "operator": "equals",
        "value": "Open",
        "source": "open status"
      }
    ],
    "displayFields": [
      "summary",
      "status",
      "priority",
      "assignee",
      "created",
      "updated",
      "description",
      "reporter",
      "type"
    ],
    "sortBy": null,
    "limit": 50
  }
}
```

**Note:** This example uses field-level vocabulary only. Entity resolution (e.g., "assigned to Sarah" → "sarah.johnson@acme.com") requires Phase 2 implementation and is not shown here.

**Agent Workflow Pattern:**

```typescript
// Step 1: Download classification examples (for query type classification)
const examples = await searchAI.getClassificationExamples({
  knowledgeBaseId: 'kb-jira',
});

// Step 2: Download vocabulary (for query rephrasing)
const vocabulary = await searchAI.getVocabulary({
  knowledgeBaseId: 'kb-jira',
});

// Step 3: Agent LLM classifies query using examples
const classification = await agentLLM.classify({
  query: userQuery,
  examples: examples.queryTypes,
});
// Result: "structured"

// Step 4: Agent LLM rephrases query using vocabulary
const rephrased = await agentLLM.rephrase({
  query: userQuery,
  vocabulary: vocabulary.vocabulary,
});
// Result: "Show high priority bugs in open status"

// Step 5: Extract fields from rephrased query
const extraction = await searchAI.extractFields({
  query: rephrased,
  queryType: classification,
  knowledgeBaseId: 'kb-jira',
});

// Step 6: Execute search using extracted fields
const results = await searchAI.searchStructured({
  knowledgeBaseId: 'kb-jira',
  filters: extraction.extractedFields.filters,
  displayFields: extraction.extractedFields.displayFields,
  limit: extraction.extractedFields.limit,
});
```

**Why This is Critical:**

- **Download-First Pattern:** Agent needs vocabulary BEFORE rephrasing (not after)
- **Consistent Classification:** Examples ensure all agents classify queries the same way
- **Field Validation:** Extract endpoint validates fields exist before execution
- **Agent Autonomy:** Enables agents to understand and use SearchAI capabilities independently

**Related Requirements:**

- FR-1: Dynamic resolution (extract endpoint uses this)
- FR-6: Query type classification (endpoint 1 provides examples)
- FR-8: Unified resolution endpoint (these 3 endpoints may be combined into one)

### Non-Functional Requirements

#### NFR-1: Performance

- Vocabulary resolution: <50ms (cached)
- Vocabulary generation: <5 minutes for 100-field schema
- LLM critical fields detection: <30 seconds
- Cache hit rate: >90% for vocabulary lookups

#### NFR-2: Accuracy

- Critical field identification: >85% precision (LLM correctly identifies important fields)
- Alias generation: >80% usefulness (aliases actually used in queries)
- Query type classification: >85% confidence

#### NFR-3: Scalability

- Support 500+ fields per connector schema
- Support 100+ vocabulary entries per KB
- Support 1000+ KBs per tenant

#### NFR-4: Maintainability

- Developer can add new connector in <2 hours
- Critical field config: simple YAML/TS structure
- LLM prompts versioned and testable

#### NFR-5: Security & Privacy

- No PII in sample values (names, emails)
- Tenant isolation for vocabulary
- LLM calls rate-limited per tenant

---

## Proposed Solution

### Design Rationale & Research Basis

**Why This Approach:** Our design follows proven patterns from production systems at scale.

#### Pattern 1: Schema Injection (SQLCoder, Anthropic, OpenAI)

**Source:** SQLCoder research, Anthropic's tool use documentation, OpenAI best practices

**Pattern:**

- Provide complete schema in every LLM prompt (not RAG retrieval)
- Include field names, types, constraints, and 3-5 example values
- Better to inject in prompt than retrieve from embeddings

**Evidence:**

- SQLCoder achieves **91.4% accuracy** on complex SQL generation with schema injection
- Anthropic recommends: "Include relevant context directly in the prompt"
- OpenAI: "Provide complete function schemas in tools array"

**Application in Our Design:**

- Critical fields detection: Inject full canonical schema into LLM prompt
- Vocabulary generation: Inject field metadata (types, enum values, descriptions)
- Query generation: Inject vocabulary + capabilities for accurate field resolution

**Why It Works:**

- LLM has complete context for decisions (no missing information)
- Reduces hallucination (LLM sees actual field names, not guesses)
- Enables validation (can check if suggested fields exist in schema)

---

#### Pattern 2: Self-Query (LangChain, LlamaIndex)

**Source:** LangChain self-query retriever, LlamaIndex auto-retrieval

**Pattern:**

- Separate semantic search from structured filters at query time
- LLM explicitly decides: which terms are filters vs search content
- Prevents field resolution ambiguity

**Example:**

```
Query: "Show high priority bugs about login issues"

Self-Query Analysis:
- Structured filters: "high priority" (priority=High), "bugs" (type=Bug)
- Semantic content: "login issues" (vector search)

Result: Hybrid query with both components
```

**Application in Our Design:**

- Query classifier identifies structured vs semantic terms
- Vocabulary resolver maps structured terms to fields
- Semantic terms passed directly to vector search
- Enables hybrid search (structured + semantic)

**Why It Works:**

- Clear separation prevents "is this a filter or search term?" confusion
- LLM makes explicit decision instead of implicit guessing
- Supports pure structured, pure semantic, or hybrid queries

---

#### Pattern 3: Tool Use with Strict Schemas (Anthropic, OpenAI)

**Source:** Anthropic's tool use pattern, OpenAI function calling with `strict: true`

**Pattern:**

- Define query construction as "tool" with JSON schema
- Use `strict: true` to guarantee schema conformance
- Eliminates hallucinated field names
- Validation happens before execution

**Example:**

```typescript
{
  "name": "search_structured",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": {
      "filters": {
        "type": "array",
        "items": {
          "field": { "type": "string", "enum": ["priority", "type", "assignee"] },
          "operator": { "type": "string", "enum": ["equals", "in", "gt"] },
          "value": {}
        }
      }
    },
    "required": ["filters"]
  }
}
```

**Application in Our Design:**

- MCP tools use JSON Schema validation
- Field names validated against vocabulary
- Operators validated against supported list
- Type-safe responses

**Why It Works:**

- LLM cannot suggest invalid field names (schema enforcement)
- Compile-time type safety (TypeScript)
- Self-documenting APIs (schema is documentation)

---

#### Pattern 4: Clarification Loop (OpenAI)

**Source:** OpenAI assistant best practices: "Don't make assumptions about what values to plug into functions"

**Pattern:**

- When ambiguous, LLM asks user for clarification
- Don't pre-configure all possibilities
- Handle edge cases at query time, not design time

**Example:**

```
User: "Show bugs assigned to John"
Agent: "I found 3 users named John:
  1. John Smith (john.smith@acme.com)
  2. John Doe (john.doe@acme.com)
  3. John Williams (john.w@acme.com)
Which one did you mean?"
```

**Application in Our Design:**

- Agent asks for clarification when entity ambiguous
- No need to pre-configure all person names, project names, etc.
- Deferred entity resolution to Phase 2 (not blocking Phase 1)

**Why It Works:**

- Impossible to pre-configure all entity values
- Better UX: User clarifies once vs wrong results
- Reduces false positives

---

#### Pattern 5: Hybrid Search Architecture (Pinecone, Vespa)

**Source:** Pinecone hybrid search, Vespa ranking

**Pattern:**

- Separate indexes: dense vectors (semantic) + sparse vectors (keyword) + structured metadata
- Query determines which indexes to use
- Combine scores with RRF (Reciprocal Rank Fusion) or weighted combination

**Example:**

```
Query: "Show high priority bugs about login issues"

Index Selection:
- Structured metadata index: Filter priority=High, type=Bug
- Dense vector index: k-NN search for "login issues" embedding
- Combine: Filter results + vector similarity score

Result: Top 50 high-priority bugs, ranked by relevance to "login issues"
```

**Application in Our Design:**

- OpenSearch stores: canonicalData (structured) + embedding (vector)
- Query classifier determines search type (structured/semantic/hybrid)
- Hybrid queries use bool.must (vector) + bool.filter (structured)
- Aggregations work on structured fields

**Why It Works:**

- Best of both worlds: Precision (filters) + Recall (semantic)
- Users can ask: "Show [filters] about [concept]"
- Most powerful search capability

---

### Summary: Why These Patterns

| Pattern            | Benefit                              | Evidence                | Applied To                      |
| ------------------ | ------------------------------------ | ----------------------- | ------------------------------- |
| Schema Injection   | Reduces hallucination, complete ctx  | SQLCoder 91.4% accuracy | Critical fields, vocab gen      |
| Self-Query         | Separates filters from search        | LangChain, LlamaIndex   | Query classifier, hybrid search |
| Tool Use (strict)  | Prevents invalid field names         | Anthropic, OpenAI docs  | MCP tools, query validation     |
| Clarification Loop | Handles ambiguity gracefully         | OpenAI best practices   | Entity resolution (Phase 2)     |
| Hybrid Search      | Combines structured + semantic power | Pinecone, Vespa in prod | OpenSearch queries              |

**Result:** Our design is not experimental - it's based on proven patterns from production systems at companies like Anthropic, OpenAI, Pinecone, and successful open-source projects like LangChain and LlamaIndex.

---

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  1. CONNECTOR CONFIGURATION                                   │
│     User configures Jira/Salesforce connector                │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  2. SCHEMA DISCOVERY (Existing)                              │
│     Worker: schema-sync-worker                               │
│     Discovers 150 fields from source                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  3. FIELD MAPPING (Existing)                                 │
│     Maps 75 source fields → canonical fields                 │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  4. CRITICAL FIELDS DETECTION (NEW)                          │
│     Service: CriticalFieldsDetector                          │
│     Input: Discovered schema + domain examples               │
│     LLM identifies: 10-20 critical fields                    │
│     Output: Field paths + reasoning + confidence             │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  5. VOCABULARY GENERATION (NEW)                              │
│     Worker: vocabulary-generator-worker                      │
│     For each critical field:                                 │
│       - Generate 3-5 aliases                                 │
│       - Generate description                                 │
│       - Identify related fields (displayWith, aggregateWith) │
│     Auto-activate vocabulary                                 │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  6. FIELD VIEW UI (NEW)                                      │
│     User reviews auto-generated vocabulary                   │
│     Can edit, add more fields manually                       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  7. QUERY TIME: DYNAMIC RESOLUTION (Enhanced)                │
│     Service: VocabularyResolverV2                            │
│     Process:                                                 │
│       - Load vocabulary (cached)                             │
│       - Inject schema into LLM prompt                        │
│       - LLM generates structured query                       │
│       - Resolve dynamically based on query intent            │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Enhanced Vocabulary Model

```typescript
// packages/database/src/models/domain-vocabulary.model.ts

export interface IVocabularyEntry {
  term: string; // From canonical field label (human-readable)
  canonicalField: string; // Reference to canonical field
  aliases: string[]; // LLM-generated (3-5, or empty if low confidence)
  description: string; // User-friendly explanation

  // Related fields for context (FR-4)
  relatedFields?: {
    displayWith: string[]; // 10-30 fields for detail view
    aggregateWith: string[]; // 3-7 fields for aggregated view
  };

  // Auto-generation metadata
  autoGenerated: boolean;
  confidence: number; // 0.0-1.0

  enabled: boolean;
}
```

**Note:** Capabilities (filterable, aggregatable, sortable) NOT stored in vocabulary - inferred from CanonicalField at runtime.

#### 2. Critical Fields Configuration

```typescript
// apps/search-ai/src/config/connector-critical-fields.ts

export interface CriticalFieldExample {
  fieldName: string;
  reasoning: string;
  category: 'identifier' | 'workflow' | 'dimension' | 'measure' | 'metadata';
  typicallyUsedFor: ('filter' | 'display' | 'aggregate' | 'sort')[];
}

export interface CriticalFieldPattern {
  category: string;
  patterns: string[];
  reasoning: string;
}

export interface ConnectorCriticalFieldsConfig {
  connectorType: string;
  domain: string;
  exampleCriticalFields: CriticalFieldExample[];
  criticalFieldPatterns: CriticalFieldPattern[];
  nonCriticalPatterns: CriticalFieldPattern[];
}

// One config per connector type
export const JIRA_CRITICAL_FIELDS_EXAMPLES: ConnectorCriticalFieldsConfig = { ... };
export const SALESFORCE_CRITICAL_FIELDS_EXAMPLES: ConnectorCriticalFieldsConfig = { ... };
```

#### 3. Critical Fields Detector Service

```typescript
// apps/search-ai/src/services/vocabulary/critical-fields-detector.ts

export class CriticalFieldsDetector {
  async detectCriticalFields(
    connectorType: string,
    discoveredSchema: IConnectorSchemaField[],
    tenantId: string,
  ): Promise<CriticalFieldResult[]> {
    // 1. Load domain config
    const config = getCriticalFieldsConfig(connectorType);

    // 2. Build LLM prompt (developer-friendly → LLM-friendly)
    const prompt = buildCriticalFieldsPrompt(connectorType, discoveredSchema, config);

    // 3. Call LLM
    const llmResult = await callLLM(prompt, tenantId);

    // 4. Parse and validate
    return parseCriticalFieldsResult(llmResult, discoveredSchema);
  }
}
```

#### 4. Vocabulary Generator Worker

```typescript
// apps/search-ai/src/workers/vocabulary-generator-worker.ts

export interface VocabularyGenerationJobData {
  tenantId: string;
  projectKnowledgeBaseId: string;
  canonicalSchemaId: string;
  criticalFields: string[]; // From critical fields detector
}

export async function processVocabularyGeneration(
  job: Job<VocabularyGenerationJobData>,
): Promise<void> {
  // For each critical field:
  //   1. Load canonical field + source field metadata
  //   2. Build LLM prompt with examples
  //   3. LLM generates: aliases, description, relatedFields
  //   4. Create vocabulary entry (auto-activated)
  // Save vocabulary document
  // User can edit later in Field View UI
}
```

#### 5. Vocabulary Resolver V2 (Dynamic Resolution)

```typescript
// apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver-v2.ts

export class VocabularyResolverV2 {
  async resolve(
    query: string,
    queryIntent: 'display' | 'filter' | 'aggregate' | 'sort' | 'auto',
    tenantId: string,
    projectKbId: string,
  ): Promise<DynamicResolution> {
    // 1. Load vocabulary (cached)
    const vocabulary = await this.loadVocabulary(projectKbId, tenantId);

    // 2. Build schema for LLM (schema injection pattern)
    const schemaPrompt = buildSchemaPrompt(vocabulary);

    // 3. LLM generates structured query (tool use with strict schema)
    const structuredQuery = await llm.call({
      prompt: `Query: ${query}\n\nSchema:\n${schemaPrompt}`,
      tools: [searchDatabaseTool],
      strict: true, // Guarantees valid field names
    });

    // 4. Validate and return
    return validateAndResolve(structuredQuery, vocabulary);
  }
}
```

#### 6. Capability Registry Service

```typescript
// apps/search-ai-runtime/src/services/capability/capability-registry.service.ts

export class CapabilityRegistryService {
  async getCapabilities(projectKbId: string, tenantId: string): Promise<ICapabilityRegistry> {
    // Load from database (with cache)
    // Fallback to default if not customized
    return { aggregationFunctions, operators, capabilities };
  }
}
```

### Sample Values Strategy

Based on research findings:

| Field Type            | Provide Samples? | Format           | Example                             |
| --------------------- | ---------------- | ---------------- | ----------------------------------- |
| **Enum**              | ✅ YES           | All values       | `["open", "in_progress", "closed"]` |
| **Date**              | ⚠️ Format only   | In description   | `"ISO 8601 (e.g., 2025-01-15)"`     |
| **Numeric**           | ⚠️ Range only    | In description   | `"typically 100K-10M"`              |
| **Text (structured)** | ⚠️ Format only   | 1-2 examples     | `"e.g., BUG-123, PROJ-456"`         |
| **Text (free-form)**  | ❌ NO            | Description only | `"Free-form notes"`                 |
| **ID**                | ⚠️ Format only   | 1 example        | `"UUID: 550e8400..."`               |
| **Names (PII)**       | ❌ NO            | Description only | ✅ Per your guidance                |

---

## Success Criteria

### Quantitative Metrics

| Metric                  | Current       | Target        | Measurement                                |
| ----------------------- | ------------- | ------------- | ------------------------------------------ |
| **Setup Time**          | 10-20 hours   | 30 minutes    | Time to create vocabulary for new KB       |
| **Vocabulary Entries**  | 3 per concept | 1 per concept | Count of entries needed                    |
| **Query Success Rate**  | 60%           | 85%           | % of queries that resolve correctly        |
| **Aggregation Context** | 0%            | 95%           | % of aggregations with context fields      |
| **Resolution Latency**  | N/A           | <50ms         | P95 vocabulary lookup time                 |
| **Generation Time**     | N/A           | <5 min        | Time to generate vocabulary for 100 fields |

### Qualitative Criteria

- ✅ User can configure connector without vocabulary expertise
- ✅ Same term works for multiple query types (filter/display/aggregate)
- ✅ Aggregation results actionable (user can identify entities)
- ✅ LLM agents can discover system capabilities
- ✅ Developer can add new connector in <2 hours

### User Experience Validation

**Before:**

- User: "Show me priority" → System applies filter (wrong)
- Admin: Spends 15 hours creating vocabulary entries
- Aggregation: Shows only numbers (not actionable)

**After:**

- User: "Show me priority" → System displays priority field (correct)
- Admin: Reviews auto-generated vocabulary in 30 minutes
- Aggregation: Shows numbers + customer + rep + region (actionable)

---

## Open Questions

### Q1: Entity Resolution Timing

**Status:** DEFERRED to Phase 2

**Question:** Should vocabulary auto-generation handle entity values ("Bharat" → person name)?

**Decision:** Start with field vocabulary only (FR-5). Add entity resolution as separate Phase 2 feature.

**Rationale:**

- Different problem domain (field names vs entity values)
- Less coupling, faster initial delivery
- Can iterate independently

### Q2: SharePoint Connector

**Status:** OUT OF SCOPE

**Finding:** SharePoint connector schema discovery not implemented yet.

**Decision:** Separate effort. This RFC focuses on vocabulary system, not connector implementation.

### Q3: Field View UI Scope

**Status:** CLARIFIED - In Scope (P0)

**Question:** What functionality needed for MVP?

**Answer:** (Pending detailed UI requirements)

- List vocabulary entries
- Edit aliases and related fields
- Add manual entries
- Enable/disable entries

### Q4: LLM Model Selection

**Status:** OPEN

**Question:** Which LLM for vocabulary generation? Same as query resolution?

**Options:**

- GPT-4: Most capable, expensive
- Claude: Good balance
- Haiku: Fast, cheap, sufficient for schema analysis?

**Recommendation:** Test with multiple models, use cost-performance tradeoff analysis.

### Q5: Vocabulary Versioning

**Status:** OPEN

**Question:** How to handle vocabulary updates when schema changes?

**Options:**

- A) Auto-regenerate vocabulary (risky - loses manual edits)
- B) Mark for review (manual validation required)
- C) Merge: Keep manual edits, regenerate for new fields only ✅ **Recommended**

---

## References

### Research Documents

- `CANONICAL-MAPPING-RAW-REVIEW-COMMENTS.md` - Original problem analysis
- `CANONICAL-MAPPING-CONVERSATION-CONTEXT.md` - Full conversation history
- `RESEARCH-FINDINGS-SUMMARY.md` - Research answers to all questions
- `SCHEMA-DISCOVERY-FINDINGS.md` - Current implementation analysis
- `bi_field_selection_research.md` - BI patterns for context fields
- `ENTITY-NAME-MATCHING-RESEARCH.md` - Entity resolution patterns (Phase 2)

### Codebase References

- `apps/search-ai/src/services/schema-discovery/` - Schema discovery services
- `apps/search-ai/src/workers/schema-sync-worker.ts` - Schema sync worker
- `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts` - Current resolver
- `packages/database/src/models/domain-vocabulary.model.ts` - Vocabulary model
- `packages/database/src/models/canonical-schema.model.ts` - Canonical schema model

### External References

- SQLCoder: 91.4% accuracy with schema injection pattern
- Anthropic Tool Use: Strict schema validation
- OpenAI Function Calling: Format examples pattern
- Power BI Documentation: Aggregated vs detail field selection
- Vespa, Pinecone: Hybrid search patterns

---

## Approval

**Reviewer:** Bharat Rekha (Product/Architecture Lead)

**Status:** ⏳ PENDING REVIEW

**Review Questions:**

1. Are all requirements captured correctly?
2. Any missing functional requirements?
3. Is the proposed solution approach acceptable?
4. Any concerns about complexity or timeline?
5. Ready to proceed with detailed design?

---

**Next Steps After Approval:**

1. Create detailed design documents
2. Define data models (final schemas)
3. Design LLM prompt templates
4. Create implementation plan with phases
5. Estimate effort and timeline
