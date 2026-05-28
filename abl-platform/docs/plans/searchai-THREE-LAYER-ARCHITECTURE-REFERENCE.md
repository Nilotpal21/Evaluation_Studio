# Three-Layer Architecture: Quick Reference Card

**Created:** 2026-03-03
**See Also:** [RFC_SCHEMA_MAPPING_AND_RETRIEVAL_STRATEGIES.md](../RFC_SCHEMA_MAPPING_AND_RETRIEVAL_STRATEGIES.md)

---

## The Three Layers Explained

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│  LAYER 3: Domain Vocabulary (Business Language → Canonical)       │
│  ────────────────────────────────────────────────────────────     │
│  Scope:      Per Project + KnowledgeBase                           │
│  When:       Query Time                                            │
│  Who:        Business Users / Agent Developers                     │
│  Purpose:    "closed deals" → status IN (Closed Won, Closed Lost) │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Examples:                                                     │ │
│  │  - "open issues"   → status IN (To Do, In Progress)          │ │
│  │  - "P1 bugs"       → priority = Highest AND type = Bug       │ │
│  │  - "revenue"       → SUM(amount) WHERE status = Closed Won   │ │
│  │  - "my tickets"    → assignee = {{current_user}}             │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              ↓ Applied at Query Time
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│  LAYER 2: Canonical Schema Mapping (Source → Canonical)           │
│  ────────────────────────────────────────────────────────         │
│  Scope:      Per KnowledgeBase                                     │
│  When:       Ingestion Time                                        │
│  Who:        Semi-automatic (LLM + Human Review)                   │
│  Purpose:    Normalize heterogeneous sources into unified fields   │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Examples:                                                     │ │
│  │  - jira:summary           → canonical.title                   │ │
│  │  - salesforce:Subject     → canonical.title                   │ │
│  │  - jira:status            → canonical.status (lowercase)      │ │
│  │  - jira:assignee.name     → canonical.assignee                │ │
│  │  - salesforce:Amount      → canonical.amount                  │ │
│  │  - hubspot:dealstage      → canonical.status (value rename)   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              ↓ Applied at Ingestion Time
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│  LAYER 1: Source Schema Discovery (Raw Inventory)                 │
│  ────────────────────────────────────────────────────────         │
│  Scope:      Per Connector                                         │
│  When:       Connector Sync                                        │
│  Who:        Auto-discovered via API introspection                 │
│  Purpose:    Raw field inventory from source system                │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Jira Fields:                                                  │ │
│  │  - summary (string)                                           │ │
│  │  - status (enum: To Do, In Progress, Done)                    │ │
│  │  - assignee.displayName (string)                              │ │
│  │  - reporter.displayName (string)                              │ │
│  │  - priority (enum: Highest, High, Medium, Low, Lowest)        │ │
│  │  - customfield_10042 (string, label: "Document Author")       │ │
│  │  - created (datetime)                                         │ │
│  │  - ... 50+ more fields                                        │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Data Model Reference

### Layer 1: ConnectorSchema

```typescript
{
  _id: "schema-123",
  tenantId: "tenant-456",
  connectorId: "jira-connector-789",
  version: 3,
  fields: [
    {
      path: "summary",
      label: "Summary",
      type: "string",
      isCustom: false,
      isRequired: true,
      sampleValues: ["Bug in login", "Feature request", ...]
    },
    {
      path: "customfield_10042",
      label: "Document Author",
      type: "string",
      isCustom: true,
      isRequired: false,
      sampleValues: ["John Doe", "Jane Smith", ...]
    }
  ],
  fieldCount: 87,
  customFieldCount: 12,
  status: "active",
  discoveredAt: "2026-03-03T10:00:00Z"
}
```

**Discovery Method:**

- **Jira:** `GET /rest/api/3/field`
- **Salesforce:** `DESCRIBE` API on SObjects
- **HubSpot:** `GET /crm/v3/properties/{objectType}`

### Layer 2: CanonicalSchema + FieldMapping

```typescript
// CanonicalSchema
{
  _id: "canonical-schema-456",
  tenantId: "tenant-456",
  knowledgeBaseId: "kb-789",
  version: 1,
  fields: [
    {
      name: "title",
      label: "Title",
      type: "string",
      description: "Document or issue title",
      indexed: true,
      filterable: true,
      aggregatable: false
    },
    {
      name: "status",
      label: "Status",
      type: "enum",
      description: "Current status",
      indexed: true,
      filterable: true,
      aggregatable: true,
      enumValues: ["Open", "Active", "Closed"]
    }
  ],
  status: "active"
}

// FieldMapping (one per canonical field per connector)
{
  _id: "mapping-001",
  tenantId: "tenant-456",
  canonicalSchemaId: "canonical-schema-456",
  canonicalField: "title",
  connectorId: "jira-connector-789",
  sourcePath: "summary",
  transform: {
    type: "direct"  // Copy value as-is
  },
  confidence: 0.95,
  status: "confirmed",
  suggestedBy: "llm",
  reviewedBy: "user-123",
  reviewedAt: "2026-03-03T11:00:00Z"
}

{
  _id: "mapping-002",
  canonicalSchemaId: "canonical-schema-456",
  canonicalField: "status",
  connectorId: "jira-connector-789",
  sourcePath: "status",
  transform: {
    type: "rename_value",
    valueMap: {
      "To Do": "Open",
      "In Progress": "Active",
      "Done": "Closed"
    }
  },
  confidence: 0.90,
  status: "confirmed"
}
```

**Transform Types:**

- `direct`: Copy value as-is
- `lowercase`: Convert to lowercase
- `split`: Split by delimiter into array
- `date_format`: Parse and normalize dates
- `rename_value`: Map enum values (e.g., "To Do" → "Open")
- `extract`: Regex extraction
- `coalesce`: First non-null from multiple source paths
- `compute`: Expression evaluation (stub)

### Layer 3: DomainVocabulary

```typescript
{
  _id: "vocab-123",
  tenantId: "tenant-456",
  projectKnowledgeBaseId: "pkb-789",
  version: 1,
  status: "active",
  entries: [
    {
      term: "open issues",
      aliases: ["active issues", "pending issues"],
      description: "Issues that are not yet completed",
      resolution: {
        type: "filter",
        expression: {
          field: "status",
          op: "in",
          value: ["Open", "Active"]
        }
      },
      enabled: true
    },
    {
      term: "P1 bugs",
      aliases: ["critical bugs", "high priority bugs"],
      description: "Highest priority bug reports",
      resolution: {
        type: "composite",
        steps: [
          {
            type: "filter",
            expression: { field: "priority", op: "eq", value: "Highest" }
          },
          {
            type: "filter",
            expression: { field: "type", op: "eq", value: "Bug" }
          }
        ]
      },
      enabled: true
    },
    {
      term: "revenue",
      aliases: ["total revenue", "sales revenue"],
      description: "Sum of closed won deal amounts",
      resolution: {
        type: "aggregate",
        measure: {
          field: "amount",
          function: "sum"
        },
        defaultFilters: [
          { field: "status", op: "eq", value: "Closed Won" }
        ]
      },
      enabled: true
    }
  ]
}
```

**Resolution Types:**

- `field`: Direct field reference (no filter)
- `filter`: Single filter expression
- `aggregate`: Aggregation with measure function (SUM, COUNT, AVG, MIN, MAX)
- `composite`: Multiple filters/resolutions applied in sequence

---

## Ingestion Pipeline Flow

```
┌─────────────────────┐
│ Document Upload     │
└──────┬──────────────┘
       │
       ↓
┌─────────────────────┐
│ Extraction Worker   │  ← Extracts text/metadata from PDF, DOCX, etc.
└──────┬──────────────┘
       │
       ↓
┌─────────────────────┐
│ Page Processing     │  ← Chunks documents into SearchChunks
│ Worker              │     Applies progressive summarization (LLM)
└──────┬──────────────┘     Generates questions per chunk (LLM)
       │
       ↓
┌─────────────────────────────────────────────────────────────────┐
│ Canonical Mapper Worker                                         │
│ ───────────────────────────────────────────────────────────     │
│                                                                 │
│  1. Load SearchDocument + connectorId                           │
│  2. Load confirmed FieldMappings for connectorId                │
│  3. For each mapping:                                           │
│     a. Read source value from document.sourceMetadata           │
│     b. Apply transform (direct, lowercase, rename_value, etc.)  │
│     c. Write to canonicalMetadata[canonicalField]               │
│  4. Update chunks with canonicalMetadata                        │
│                                                                 │
│  Example:                                                       │
│    sourceMetadata:     { summary: "Bug #123", status: "To Do" } │
│    mappings:           summary → title (direct)                 │
│                        status → status (rename_value)           │
│    canonicalMetadata:  { title: "Bug #123", status: "open" }    │
│                                                                 │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────┐
│ Enrichment Worker   │  ← Entity extraction, language detection
└──────┬──────────────┘
       │
       ↓
┌─────────────────────┐
│ Embedding Worker    │  ← Generates BGE-M3 embeddings
└──────┬──────────────┘     Upserts to OpenSearch (vector + metadata)
       │
       ↓
┌─────────────────────────────────────────────────────────────────┐
│ OpenSearch Index                                                │
│ ───────────────────────────────────────────────────────────     │
│                                                                 │
│  {                                                              │
│    content: "...",                                              │
│    embedding: [0.1, 0.2, ...],                                  │
│    canonicalMetadata: {  // ✅ Materialized at ingestion time   │
│      title: "Bug #123",                                         │
│      status: "open",                                            │
│      assignee: "John Doe",                                      │
│      priority: "highest"                                        │
│    }                                                            │
│  }                                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Query Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User Query: "show me open P1 bugs assigned to John"            │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────────┐
│ Vocabulary Resolution Service (Layer 3)                         │
│ ───────────────────────────────────────────────────────────     │
│                                                                 │
│  1. Load DomainVocabulary for ProjectKnowledgeBase              │
│  2. Match terms in query (longest match first):                 │
│     - "open" → { field: "status", op: "in", value: ["Open", "Active"] } │
│     - "P1" → { field: "priority", op: "eq", value: "Highest" } │
│     - "bugs" → { field: "type", op: "eq", value: "Bug" }       │
│     - "assigned to John" → { field: "assignee", op: "eq", value: "John" } │
│  3. Return:                                                     │
│     - resolvedTerms: ["open", "P1", "bugs", "assigned to John"] │
│     - structuredFilters: [<4 filter expressions>]               │
│     - unresolvedSegments: []                                    │
│                                                                 │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────────┐
│ Query Pipeline (Search-AI Runtime)                              │
│ ───────────────────────────────────────────────────────────     │
│                                                                 │
│  1. Query Preprocessing (spell check, entity extraction)        │
│  2. Query Embedding (BGE-M3)                                    │
│  3. Vector Search + Canonical Filters:                          │
│                                                                 │
│     POST /search_chunks_kb-789/_search                          │
│     {                                                           │
│       "query": {                                                │
│         "bool": {                                               │
│           "must": [                                             │
│             {                                                   │
│               "knn": {                                          │
│                 "embedding": {                                  │
│                   "vector": [0.1, 0.2, ...],                    │
│                   "k": 20                                       │
│                 }                                               │
│               }                                                 │
│             }                                                   │
│           ],                                                    │
│           "filter": [  // ✅ Canonical field filters            │
│             { "terms": { "canonicalMetadata.status.keyword": ["Open", "Active"] } }, │
│             { "term": { "canonicalMetadata.priority.keyword": "Highest" } }, │
│             { "term": { "canonicalMetadata.type.keyword": "Bug" } }, │
│             { "term": { "canonicalMetadata.assignee.keyword": "John" } } │
│           ]                                                     │
│         }                                                       │
│       }                                                         │
│     }                                                           │
│                                                                 │
│  4. Reranking (batched reranker)                                │
│  5. Format & Return                                             │
│                                                                 │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────────┐
│ Results: Only chunks matching ALL filters                       │
│  - status IN (Open, Active)                                     │
│  - priority = Highest                                           │
│  - type = Bug                                                   │
│  - assignee = John                                              │
│                                                                 │
│  Vector similarity ensures relevance to "bugs"                  │
│  Filters ensure exact match on structured criteria              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key APIs

### Layer 1: Schema Discovery

```bash
# Trigger schema discovery
POST /api/schemas/connectors/:connectorId/sync-schema
→ Creates ConnectorSchema with auto-discovered fields

# Get schema
GET /api/schemas/connectors/:connectorId/schemas?version=3
→ Returns ConnectorSchema version 3

# Get latest schema
GET /api/schemas/connectors/:connectorId/schemas
→ Returns latest ConnectorSchema
```

### Layer 2: Canonical Mapping

```bash
# Auto-suggest mappings
POST /api/mappings/suggest
{
  "canonicalSchemaId": "canonical-schema-456",
  "connectorId": "jira-connector-789"
}
→ LLM suggests field mappings with confidence scores

# List mappings
GET /api/mappings?connectorId=jira-connector-789&status=suggested
→ Returns suggested mappings needing review

# Confirm mapping
POST /api/mappings/:mappingId/confirm
{ "reviewedBy": "user-123" }
→ Marks mapping as confirmed

# Reject mapping
POST /api/mappings/:mappingId/reject
{ "reviewedBy": "user-123" }
→ Marks mapping as rejected

# Batch confirm
POST /api/mappings/batch-confirm
{ "mappingIds": ["mapping-001", "mapping-002"], "reviewedBy": "user-123" }
→ Confirms multiple mappings at once
```

### Layer 3: Domain Vocabulary

```bash
# Resolve vocabulary
POST /api/vocabulary/resolve
{
  "projectKnowledgeBaseId": "pkb-789",
  "query": "show me open P1 bugs"
}
→ Returns:
{
  "resolvedTerms": [
    { "term": "open", "matchedEntry": "open issues", "resolution": {...} },
    { "term": "p1", "matchedEntry": "P1 bugs", "resolution": {...} }
  ],
  "structuredFilters": [
    { "field": "status", "op": "in", "value": ["Open", "Active"] },
    { "field": "priority", "op": "eq", "value": "Highest" },
    { "field": "type", "op": "eq", "value": "Bug" }
  ],
  "unresolvedSegments": ["show me"]
}

# Create vocabulary entry
POST /api/vocabulary
{
  "projectKnowledgeBaseId": "pkb-789",
  "term": "closed deals",
  "aliases": ["completed deals", "won deals"],
  "resolution": {
    "type": "filter",
    "expression": { "field": "status", "op": "in", "value": ["Closed Won", "Closed Lost"] }
  }
}

# Suggest vocabulary from canonical schema
POST /api/vocabulary/suggest
{ "canonicalSchemaId": "canonical-schema-456" }
→ LLM suggests common vocabulary entries
```

### Integration: Search with Filters

```bash
# Search with vocabulary-resolved filters
POST /api/search
{
  "indexId": "kb-789",
  "query": "show me open P1 bugs",
  "k": 20
}
→ Middleware resolves vocabulary → applies filters → returns results

# Aggregation query
POST /api/aggregate
{
  "indexId": "kb-789",
  "spec": {
    "measure": { "field": "amount", "function": "sum" },
    "filters": [{ "field": "status", "op": "eq", "value": "Closed Won" }],
    "groupBy": ["region"]
  }
}
→ Returns:
{
  "groups": [
    { "key": "North America", "value": 1250000, "docCount": 42 },
    { "key": "EMEA", "value": 890000, "docCount": 31 }
  ]
}
```

---

## Common Use Cases

### Use Case 1: Jira Issues Search

```typescript
// 1. Discover Jira schema
POST /api/schemas/connectors/jira-conn-123/sync-schema
// → 87 fields discovered (12 custom)

// 2. Auto-suggest mappings
POST /api/mappings/suggest
{
  "canonicalSchemaId": "canonical-schema-456",
  "connectorId": "jira-conn-123"
}
// → 15 mappings suggested, 12 auto-confirmed

// 3. Create vocabulary
POST /api/vocabulary
{
  "projectKnowledgeBaseId": "pkb-789",
  "term": "open bugs",
  "resolution": {
    "type": "composite",
    "steps": [
      { "type": "filter", "expression": { "field": "status", "op": "in", "value": ["To Do", "In Progress"] } },
      { "type": "filter", "expression": { "field": "type", "op": "eq", "value": "Bug" } }
    ]
  }
}

// 4. Query with business language
POST /api/search
{
  "indexId": "jira-kb",
  "query": "show me open bugs assigned to platform team"
}
// → Returns filtered results: status IN (To Do, In Progress) AND type = Bug AND team = Platform
```

### Use Case 2: Salesforce Revenue Aggregation

```typescript
// 1. Discover Salesforce schema
POST /api/schemas/connectors/sf-conn-456/sync-schema

// 2. Map Opportunity fields to canonical schema
POST /api/mappings/suggest
{
  "canonicalSchemaId": "canonical-schema-789",
  "connectorId": "sf-conn-456"
}

// 3. Create revenue vocabulary
POST /api/vocabulary
{
  "projectKnowledgeBaseId": "pkb-sales",
  "term": "revenue",
  "resolution": {
    "type": "aggregate",
    "measure": { "field": "amount", "function": "sum" },
    "defaultFilters": [{ "field": "status", "op": "eq", "value": "Closed Won" }]
  }
}

// 4. Query revenue by region
POST /api/aggregate
{
  "indexId": "sf-kb",
  "spec": {
    "measure": { "field": "amount", "function": "sum" },
    "filters": [
      { "field": "status", "op": "eq", "value": "Closed Won" },
      { "field": "close_date", "op": "gte", "value": "2024-10-01" },
      { "field": "close_date", "op": "lte", "value": "2024-12-31" }
    ],
    "groupBy": ["region"]
  }
}
// → Returns: { "North America": $1.2M, "EMEA": $890K, "APAC": $650K }
```

### Use Case 3: Multi-Source Knowledge Base

```typescript
// Scenario: KB includes both Jira issues and Confluence docs

// 1. Discover schemas for both connectors
POST /api/schemas/connectors/jira-conn-123/sync-schema
POST /api/schemas/connectors/confluence-conn-456/sync-schema

// 2. Create unified canonical schema
POST /api/canonical-schemas
{
  "knowledgeBaseId": "unified-kb",
  "fields": [
    { "name": "title", "type": "string", "filterable": true },
    { "name": "status", "type": "enum", "filterable": true },
    { "name": "author", "type": "string", "filterable": true },
    { "name": "created_date", "type": "datetime", "filterable": true }
  ]
}

// 3. Map both sources to canonical schema
POST /api/mappings/suggest { ... jira ... }
POST /api/mappings/suggest { ... confluence ... }

// 4. Now both Jira and Confluence documents have consistent canonical metadata
// - Jira issue: canonical.title = "Bug #123", canonical.author = "John Doe"
// - Confluence: canonical.title = "API Guide", canonical.author = "Jane Smith"

// 5. Query across both sources
POST /api/search
{
  "indexId": "unified-kb",
  "query": "authentication",
  "filters": [{ "field": "author", "op": "eq", "value": "John Doe" }]
}
// → Returns Jira issues AND Confluence docs authored by John Doe
```

---

## Troubleshooting

### Problem: Canonical metadata is empty

**Symptoms:** `SearchChunk.canonicalMetadata = null` or `{}`

**Causes:**

1. ❌ Canonical-mapper worker stub not replaced with service call
2. ❌ No confirmed `FieldMapping` records exist for the connector
3. ❌ `SearchDocument.connectorId` is null (can't load mappings)

**Fix:**

```bash
# Check if mappings exist
GET /api/mappings?connectorId=jira-conn-123&status=confirmed
# If empty, create or confirm mappings

# Check if worker is using service
# Look for logs: "Applied N field mappings" (not "Pass-through")

# Check document has connectorId
db.search_documents.findOne({ _id: "doc-123" })
# If connectorId is null, backfill from SearchSource
```

### Problem: Filters return zero results

**Symptoms:** Query with canonical field filters returns no chunks

**Causes:**

1. ❌ OpenSearch index doesn't include `canonicalMetadata` field
2. ❌ Embedding worker doesn't sync `canonicalMetadata` to OpenSearch
3. ❌ Filter field path is wrong (use `.keyword` for exact match)

**Fix:**

```bash
# Check OpenSearch mapping
GET /search_chunks_kb-789/_mapping
# Should have: canonicalMetadata: { type: "object", dynamic: true }

# Check if documents have canonical metadata
GET /search_chunks_kb-789/_search
{
  "query": { "exists": { "field": "canonicalMetadata" } },
  "size": 1
}

# Reindex if needed
node apps/search-ai/scripts/reindex-canonical-metadata.ts
```

### Problem: Vocabulary doesn't resolve

**Symptoms:** `POST /vocabulary/resolve` returns empty `resolvedTerms`

**Causes:**

1. ❌ No active `DomainVocabulary` exists for ProjectKnowledgeBase
2. ❌ Vocabulary terms don't match query (case-sensitive)
3. ❌ Vocabulary entries are disabled (`enabled: false`)

**Fix:**

```bash
# Check if vocabulary exists
db.domain_vocabularies.findOne({
  projectKnowledgeBaseId: "pkb-789",
  status: "active"
})

# Check if terms are enabled
# terms should have `enabled: true`

# Vocabulary matching is case-insensitive and uses longest-match-first
# "closed deals in Q4" matches "closed deals" before "deals"
```

---

## Performance Benchmarks

| Operation                         | Target             | Notes                                       |
| --------------------------------- | ------------------ | ------------------------------------------- |
| Schema discovery (Jira)           | <30s               | 50-100 fields, includes enum value sampling |
| LLM mapping suggestion            | <10s               | 15-20 field mappings                        |
| Canonical mapping application     | <50ms per document | In-memory cache after first load            |
| Vocabulary resolution             | <10ms per query    | Regex matching, no LLM                      |
| Filter query (vector + 3 filters) | <200ms             | 10k chunks, OpenSearch                      |
| Aggregation query (SUM over 100k) | <500ms             | Single measure, no grouping                 |
| OpenSearch reindex                | <1 hour            | 1M chunks, bulk update                      |

---

## Next Steps

1. **Read full implementation plan:** [CANONICAL-MAPPING-IMPLEMENTATION-PLAN.md](./CANONICAL-MAPPING-IMPLEMENTATION-PLAN.md)
2. **Review gap analysis:** [CANONICAL-MAPPING-GAPS-SUMMARY.md](./CANONICAL-MAPPING-GAPS-SUMMARY.md)
3. **Start with Phase 1:** Fix canonical-mapper-worker stub (2 days)
4. **Test end-to-end:** Run integration test after Phase 1
5. **Continue phases 2-7:** 6 weeks to full completion
