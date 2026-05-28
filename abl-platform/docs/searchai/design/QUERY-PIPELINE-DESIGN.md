# SearchAI Query Pipeline Design

> **Service:** Search-AI Runtime (`apps/search-ai-runtime`, port 3114)
> **Entry Point:** `POST /api/search/:indexId/query`
> **Latency Target:** < 500ms end-to-end

This document reads like a movie -- scene by scene, from the moment a knowledge base is created to the moment search results reach the user. By the end you will understand every layer, every data transformation, and every decision point in the query pipeline.

---

## Table of Contents

- [Act I: The Setup](#act-i-the-setup) -- What exists before any query runs
  - [Scene 1: A Knowledge Base is Born](#scene-1-a-knowledge-base-is-born)
  - [Scene 2: The Vocabulary -- Teaching the System Your Language](#scene-2-the-vocabulary----teaching-the-system-your-language)
  - [Scene 3: The Schema -- The 75-Field Contract with the Vector Store](#scene-3-the-schema----the-75-field-contract-with-the-vector-store)
  - [Scene 4: How Vocabulary and Schema Connect](#scene-4-how-vocabulary-and-schema-connect)
- [Act II: The Agent Discovers the Knowledge Base](#act-ii-the-agent-discovers-the-knowledge-base) -- How an agent learns what it can search
  - [Scene 5: Wiring -- The Agent Gets Its Tools](#scene-5-wiring----the-agent-gets-its-tools)
  - [Scene 6: Discovery -- The Agent Reads the Manifest](#scene-6-discovery----the-agent-reads-the-manifest)
  - [Scene 7: The Description Builder -- Manifest Becomes Instructions](#scene-7-the-description-builder----manifest-becomes-instructions)
  - [Scene 8: The Agent Decides How to Search](#scene-8-the-agent-decides-how-to-search)
- [Act III: The Query Pipeline](#act-iii-the-query-pipeline) -- What happens when a query arrives
  - [Scene 9: Stage 0 -- The Security Gate](#scene-9-stage-0----the-security-gate)
  - [Scene 10: Stage 1 -- Cleaning Up the Query](#scene-10-stage-1----cleaning-up-the-query)
  - [Scene 11: Stage 2 -- Vocabulary Resolution (The Brain)](#scene-11-stage-2----vocabulary-resolution-the-brain)
  - [Scene 12: Stage 2.5 -- Alias Resolution (The Translator)](#scene-12-stage-25----alias-resolution-the-translator)
  - [Scene 13: Stage 3 -- Building and Executing the Search](#scene-13-stage-3----building-and-executing-the-search)
  - [Scene 14: Stage 4 -- Reranking (The Quality Pass)](#scene-14-stage-4----reranking-the-quality-pass)
  - [Scene 15: Stage 5 -- Metrics and Response](#scene-15-stage-5----metrics-and-response)
- [Act IV: Putting It All Together](#act-iv-putting-it-all-together) -- Full traced examples
  - [Scene 16: Full Trace -- Direct User Hybrid Query](#scene-16-full-trace----direct-user-hybrid-query)
  - [Scene 17: Full Trace -- Agent with Pre-Resolved Filters](#scene-17-full-trace----agent-with-pre-resolved-filters)
  - [Scene 18: Full Trace -- Aggregation Query](#scene-18-full-trace----aggregation-query)
- [Appendix](#appendix) -- Reference tables

---

# Act I: The Setup

Before any query can run, three things must exist in the database: a SearchIndex, a DomainVocabulary, and a CanonicalSchema. These are the foundation. Understanding their shape and how they connect is essential to understanding everything that follows.

## Scene 1: A Knowledge Base is Born

When someone creates a knowledge base (SearchIndex) in the UI, several things happen:

1. A `SearchIndex` document is saved to MongoDB
2. A `CanonicalSchema` is created with the 75-field fixed OpenSearch mapping
3. Documents are ingested -- crawled, chunked, enriched, embedded, and indexed into OpenSearch
4. A `DomainVocabulary` is generated (by LLM or manually) from the ingested content
5. A `ProjectTool` is auto-registered so agents can use this KB as a tool

After this setup, the knowledge base has:

- **Documents** in OpenSearch (searchable content with embeddings)
- **A schema** that defines what fields exist and how they're named (CanonicalSchema)
- **A vocabulary** that maps business language to those fields (DomainVocabulary)

These three things feed different stages of the query pipeline.

---

## Scene 2: The Vocabulary -- Teaching the System Your Language

The DomainVocabulary is the bridge between how humans talk and how data is stored. Without it, the system can't understand that when a user says "high priority", they mean `priority_level = high`.

### What a Vocabulary Looks Like

Here is a real vocabulary for a Jira-connected knowledge base:

```json
{
  "_id": "vocab_001",
  "tenantId": "tenant_acme",
  "projectKnowledgeBaseId": "kb_jira_engineering",
  "version": 3,
  "status": "active",
  "entries": [
    {
      "id": "entry_001",
      "term": "priority",
      "aliases": ["issue priority", "ticket priority", "urgency", "p-level"],
      "description": "The priority level assigned to a Jira issue",
      "fieldRef": "issue_priority",
      "capabilities": {
        "canFilter": true,
        "canDisplay": true,
        "canAggregate": true,
        "canSort": true
      },
      "relatedFields": {
        "displayWith": ["status", "assignee", "summary", "created_date"],
        "aggregateWith": ["status", "assignee"]
      },
      "enabled": true,
      "confidence": 0.95,
      "generatedBy": "auto",
      "usageCount": 142,
      "lastUsed": "2026-03-09T14:30:00Z"
    },
    {
      "id": "entry_002",
      "term": "assignee",
      "aliases": ["assigned to", "owner", "responsible", "who is working on"],
      "description": "The person assigned to the Jira issue",
      "fieldRef": "assignee_email",
      "capabilities": {
        "canFilter": true,
        "canDisplay": true,
        "canAggregate": true,
        "canSort": false
      },
      "relatedFields": {
        "displayWith": ["priority", "status", "summary", "created_date"],
        "aggregateWith": ["priority", "status"]
      },
      "enabled": true,
      "confidence": 0.92,
      "generatedBy": "auto"
    },
    {
      "id": "entry_003",
      "term": "status",
      "aliases": ["state", "ticket status", "issue state", "workflow state"],
      "description": "Current workflow status of the issue",
      "fieldRef": "status",
      "capabilities": {
        "canFilter": true,
        "canDisplay": true,
        "canAggregate": true,
        "canSort": true
      },
      "relatedFields": {
        "displayWith": ["priority", "assignee", "summary"],
        "aggregateWith": ["priority", "assignee"]
      },
      "enabled": true,
      "confidence": 0.98,
      "generatedBy": "auto"
    }
  ]
}
```

### Why Each Field Exists

| Field                         | Purpose                                                  | Example                                                         |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `term`                        | The canonical name the system knows this concept by      | `"priority"`                                                    |
| `aliases`                     | Other ways humans might say the same thing               | `["urgency", "p-level"]`                                        |
| `fieldRef`                    | Points to a CanonicalSchema field by its alias name      | `"issue_priority"` -- links to `CanonicalSchema.fields[].name`  |
| `capabilities`                | What operations this term supports                       | `canFilter: true` means "priority = high" is valid              |
| `relatedFields.displayWith`   | When showing this field, what other fields add context   | Priority makes more sense when you also see status and assignee |
| `relatedFields.aggregateWith` | When grouping by this field, what to cross-tabulate with | "Count by priority" is more useful with "per status" breakdown  |
| `confidence`                  | How sure the LLM was when auto-generating this entry     | `0.95` = very confident this mapping is correct                 |
| `generatedBy`                 | Was this created by LLM or by a human admin              | `"auto"` = LLM-generated during ingestion                       |
| `usageCount`                  | How often this term has been matched in queries          | Useful for vocabulary optimization                              |

### The Vocabulary is Not Generated from All 75 Fields

A KB might have 20 mapped fields, but the vocabulary doesn't cover all 20 either. The `CriticalFieldDetectionService` identifies the 10-15 most important fields for search (based on field type, usage patterns, and connector template hints), and the vocabulary is generated from those.

So the funnel is: **75 storage slots → 20 mapped fields → 12 vocabulary entries**. Each layer gets more selective.

### The Key Insight About `fieldRef`

`fieldRef` does NOT point to a storage field. It points to the **alias name** in the CanonicalSchema. This is the link between vocabulary and schema:

```
DomainVocabulary.entry.fieldRef = "issue_priority"
                                        │
                                        ▼
CanonicalSchema.fields[].name = "issue_priority"  (alias)
CanonicalSchema.fields[].storageField = "priority"  (actual storage field)
```

This indirection exists because vocabulary is about business language, while the schema is about storage. They need to evolve independently.

---

## Scene 3: The Schema -- The 75-Field Contract with the Vector Store

The CanonicalSchema is the alias layer that sits between human-readable field names and the actual vector store index. Understanding it requires understanding two distinct layers:

### Two Layers: OpenSearch Slots vs MongoDB Alias Layer

**Layer 1: OpenSearch Index (all 75 slots, pre-defined)**

Every KB's OpenSearch index has 75 field slots pre-defined at index creation with `dynamic: false`. These slots exist whether or not they're used:

| Category           | Fields                      | Examples                                                         |
| ------------------ | --------------------------- | ---------------------------------------------------------------- |
| 15 Core            | Always meaningful           | `title`, `content_summary`, `author`, `created_date`, `status`   |
| 25 Common          | Domain-specific, often used | `priority`, `assignee`, `reporter`, `tags`, `severity`, `sprint` |
| 20 Custom String   | Generic typed slots         | `custom_string_1` through `custom_string_20`                     |
| 10 Custom Number   | Generic typed slots         | `custom_number_1` through `custom_number_10`                     |
| 5 Custom Date/Bool | Generic typed slots         | `custom_date_1`-`5`, `custom_bool_1`-`5`                         |

A Jira KB might use 20 of these. A Confluence KB might use 12. The rest sit empty (`null`). This fixed-slot design means we never need to update OpenSearch mappings dynamically -- all fields are known at index creation time.

**Layer 2: CanonicalSchema in MongoDB (only mapped fields)**

The CanonicalSchema document in MongoDB does **not** contain all 75 fields. It only contains the fields that have been actively mapped for this specific KB. A Jira KB with 20 mapped fields has a CanonicalSchema with 20 entries, not 75.

### How Fields Get Mapped (The User's Journey)

Fields don't appear in the schema by magic. Here's the actual flow:

```
1. Connector added to KB (e.g., Jira)
   │
   ▼
2. MappingSuggestionService runs:
   ├── Loads ConnectorTypeSchema template for Jira
   │   (code constant: "Jira fields.priority → OS priority, Jira fields.status → OS custom_string_1")
   ├── LLM suggests mappings for fields not covered by template
   └── Creates FieldMapping records with status: "suggested"
   │
   ▼
3. User opens Fields Tab in Studio UI
   ├── Section 1: "My Fields" — confirmed mappings (actively used)
   ├── Section 2: "Suggested Mappings" — LLM suggestions awaiting review
   └── Section 3: "Unmapped Fields" — available OS slots not yet assigned
   │
   ▼
4. User confirms or edits suggestions
   ├── FieldMapping.status → "confirmed"
   ├── User can rename the alias (e.g., "priority" → "issue_priority")
   ├── User can set enum values (e.g., critical=1, high=2)
   └── User can toggle filterable, sortable, aggregatable
   │
   ▼
5. CanonicalSchema created/updated in MongoDB
   └── Contains ONLY the confirmed fields with their aliases
```

So to answer directly: **the user doesn't manually add aliases from scratch**. The system suggests mappings based on the connector type, and the user confirms, edits, or rejects them in the Fields Tab.

### What a Schema Looks Like

This is the MongoDB document -- notice it has only 3 fields, not 75:

```json
{
  "_id": "schema_001",
  "tenantId": "tenant_acme",
  "knowledgeBaseId": "kb_jira_engineering",
  "version": 2,
  "status": "active",
  "fields": [
    {
      "name": "issue_priority",
      "label": "Priority Level",
      "type": "string",
      "storageField": "priority",
      "indexed": true,
      "filterable": true,
      "aggregatable": true,
      "sortable": true,
      "enumValues": {
        "critical": 1,
        "high": 2,
        "medium": 3,
        "low": 4,
        "trivial": 5
      },
      "description": "Jira issue priority (P0-P4)",
      "sourceConnectorField": "issue.fields.priority.name"
    },
    {
      "name": "assignee_email",
      "label": "Assignee",
      "type": "string",
      "storageField": "assignee",
      "indexed": true,
      "filterable": true,
      "aggregatable": true,
      "sortable": false,
      "description": "Email of the person assigned to the issue",
      "sourceConnectorField": "issue.fields.assignee.emailAddress"
    },
    {
      "name": "status",
      "label": "Issue Status",
      "type": "string",
      "storageField": "custom_string_1",
      "indexed": true,
      "filterable": true,
      "aggregatable": true,
      "sortable": true,
      "enumValues": {
        "open": "open",
        "in_progress": "in_progress",
        "closed": "closed",
        "on_hold": "on_hold"
      },
      "description": "Current workflow state",
      "sourceConnectorField": "issue.fields.status.name"
    }
  ]
}
```

The 72 unused OpenSearch slots (`custom_string_2` through `custom_string_20`, `custom_number_1` through `custom_number_10`, etc.) exist in OpenSearch but have no CanonicalSchema entry. They're available for future mappings.

### The Two Identities of Every Field

Every mapped field has two names. The distinction matters because different parts of the system use different names:

| Identity          | Field          | Example            | Who Uses It                                                            |
| ----------------- | -------------- | ------------------ | ---------------------------------------------------------------------- |
| **Alias name**    | `name`         | `"issue_priority"` | Agents, vocabulary, UI, API callers                                    |
| **Storage field** | `storageField` | `"priority"`       | The actual vector store field, stored as `metadata.canonical.priority` |

The alias is the human-facing name. The storage field is the machine-facing name. Stage 2.5 (Alias Resolution) translates between them at query time. Code that talks to agents or vocabulary uses aliases. Code that builds OpenSearch DSL uses the storage field path.

### Where Enum Values Come From

Enum values don't appear by magic. They are discovered from **three sources**:

**Source 1: Connector API introspection** -- When a connector (Jira, Salesforce, HubSpot) is first connected, the discovery service calls the connector's API to introspect its schema. Fields with known enums (Salesforce picklists, HubSpot option sets) have their values extracted automatically.

```
Jira API → field "priority" has values: ["Highest", "High", "Medium", "Low", "Lowest"]
Salesforce API → field "Stage" has picklist: ["Prospecting", "Negotiation", "Closed Won", "Closed Lost"]
```

These are stored on `ConnectorSchema` (Layer 1) -- the raw source field definitions.

**Source 2: Structured data analysis** -- When CSV/JSON/Excel files are uploaded, the `SchemaAnalyzer` scans each column. If a column has fewer than 50 unique values AND a uniqueness ratio below 70%, it's classified as an enum. All unique values are extracted.

```
CSV column "status" → 4 unique values out of 10,000 rows → enum: ["open", "closed", "pending", "resolved"]
```

**Source 3: LLM mapping suggestion** -- When the `MappingSuggestionService` asks the LLM to suggest field mappings, the LLM can propose a `value_map` transform that maps source values to canonical values. This is how display-to-stored coercion maps are born.

```
LLM suggests: transform: { type: "value_map", valueMap: { "To Do": "open", "In Progress": "in_progress", "Done": "closed" } }
```

The `enumValues` on the CanonicalSchema field are then populated from these sources -- either directly from connector introspection, or derived from the LLM-suggested value maps during mapping confirmation.

**What does NOT exist yet:** Post-ingestion analysis that scans actual indexed chunks to discover new enum values. The infrastructure supports it (OpenSearch terms aggregation), but no worker does this today.

### How Field Mapping Works at Ingestion Time

Once a mapping is confirmed, the `CanonicalMapperService` applies it every time a document is ingested. This is where source data gets transformed into the canonical form that OpenSearch stores.

**Supported transform types:**

| Transform     | What It Does                        | Example                                   |
| ------------- | ----------------------------------- | ----------------------------------------- |
| `direct`      | Pass-through, no change             | `"alice@acme.com"` → `"alice@acme.com"`   |
| `lowercase`   | Convert to lowercase                | `"HIGH"` → `"high"`                       |
| `uppercase`   | Convert to uppercase                | `"open"` → `"OPEN"`                       |
| `value_map`   | Map display values to stored values | `"To Do"` → `"open"`                      |
| `split`       | Split string by delimiter           | `"bug,feature"` → `["bug", "feature"]`    |
| `join`        | Join array by delimiter             | `["bug", "feature"]` → `"bug,feature"`    |
| `date_format` | Parse and normalize dates           | `"03/10/2026"` → `"2026-03-10T00:00:00Z"` |

**Example of ingestion-time mapping applied:**

```
Source document from Jira:
  { fields: { priority: { name: "High" }, status: { name: "To Do" }, assignee: { emailAddress: "alice@acme.com" } } }

FieldMapping records (confirmed):
  1. sourcePath: "fields.priority.name"   → canonicalField: "priority"        transform: { type: "value_map", valueMap: {"High": 2, "Medium": 3} }
  2. sourcePath: "fields.status.name"     → canonicalField: "custom_string_1" transform: { type: "value_map", valueMap: {"To Do": "open"} }
  3. sourcePath: "fields.assignee.email"  → canonicalField: "assignee"        transform: { type: "direct" }

CanonicalMapperService applies each mapping:
  1. Extract "fields.priority.name" → "High" → value_map → 2
  2. Extract "fields.status.name" → "To Do" → value_map → "open"
  3. Extract "fields.assignee.emailAddress" → "alice@acme.com" → direct → "alice@acme.com"

Stored in OpenSearch chunk:
  metadata.canonical.priority = 2
  metadata.canonical.custom_string_1 = "open"
  metadata.canonical.assignee = "alice@acme.com"
```

This is the ingestion side. At **query time**, the same coercion happens in reverse via Stage 2.5 (Alias Resolution): the user says `"high"`, the AliasResolver looks up `enumValues: {"high": 2}` on the CanonicalSchema, and replaces `"high"` with `2` before the OpenSearch query is built.

**Key files:** `apps/search-ai/src/services/canonical-mapping/canonical-mapper.service.ts`, `apps/search-ai/src/services/mapping-suggestion/mapping-suggestion.service.ts`

---

## Scene 4: How Vocabulary and Schema Connect

Here is the complete picture of how the three data models connect:

```
SearchIndex._id = "kb_jira_engineering"
    │
    │  ┌─ DomainVocabulary ─────────────────────────────────────────────┐
    ├──│ projectKnowledgeBaseId = "kb_jira_engineering"                  │
    │  │                                                                 │
    │  │ entry: { term: "priority", fieldRef: "issue_priority" }  ──────┼──┐
    │  │ entry: { term: "assignee", fieldRef: "assignee_email" }  ──────┼──┤
    │  │ entry: { term: "status",   fieldRef: "status" }          ──────┼──┤
    │  └─────────────────────────────────────────────────────────────────┘  │
    │                                                                       │
    │  ┌─ CanonicalSchema ──────────────────────────────────────────────┐  │
    └──│ knowledgeBaseId = "kb_jira_engineering"                         │  │
       │                                                                 │  │
       │ field: { name: "issue_priority", storageField: "priority" }      ◄──┘
       │ field: { name: "assignee_email", storageField: "assignee" }    ◄──
       │ field: { name: "status", storageField: "custom_string_1" }     ◄──
       │                            │
       └────────────────────────────┼───────────────────────────────────┘
                                    │
                                    ▼
                         OpenSearch Index
                         metadata.canonical.priority
                         metadata.canonical.assignee
                         metadata.canonical.custom_string_1
```

Notice `status` maps to `custom_string_1` -- not all fields have intuitive OpenSearch names. The 15 core + 25 common fields have meaningful names, but the 35 custom slots are generic (`custom_string_1`, `custom_number_3`). The alias layer hides this complexity from everyone except the search engine itself.

### The Selection Funnel

```
OpenSearch Index:     75 pre-defined slots (all exist, most empty)
                        │
                        │  User maps fields in Fields Tab
                        ▼
CanonicalSchema:      ~20 mapped fields (with aliases, enums, capabilities)
                        │
                        │  CriticalFieldDetectionService selects the most important
                        ▼
DomainVocabulary:     ~12 vocabulary entries (with terms, aliases, usage patterns)
                        │
                        │  Discovery API budgets for LLM context
                        ▼
Agent Manifest:       Top 50 vocab terms + 30 filter fields (context-limited)
```

Each layer is more selective than the last. The agent never sees 75 fields -- it sees the curated subset that matters for search.

---

# Act II: The Agent Discovers the Knowledge Base

An important clarification before we begin: **the agent LLM never calls the discovery API**. It doesn't know the API exists. The ABL runtime infrastructure handles discovery automatically, behind the scenes, for any agent that has a `type: searchai` tool. The agent just sees a tool with a rich description and calls it.

This act explains how that automatic wiring works, what the discovery manifest contains, and how the agent uses the resulting tool description to make search decisions.

## Scene 5: Wiring -- The Runtime Prepares the Tools

When an agent session starts, the **runtime code** (not the agent LLM) wires up all tools. For SearchAI tools, this includes setting up automatic discovery.

**The sequence:**

1. **Agent DSL declares a KB tool:**

   ```abl
   TOOLS:
     search_bugs(query, queryType?, filters?) -> SearchResult
       type: searchai
       index_id: "kb_jira_engineering"
       tenant_id: "tenant_acme"
   ```

2. **Compiler produces `SearchAIBindingIR`** with `indexId` and `tenantId`

3. **Session start** -- `_wireExecutor()` in `llm-wiring.ts` runs:
   - Scans all compiled tools, finds any with `tool_type === 'searchai'`
   - Creates a `SearchAIKBToolExecutor` (runtime infrastructure, not the agent)
   - Registers each KB binding: `executor.registerBinding("search_bugs", { indexId: "kb_jira_engineering" })`
   - Registers a callback: "when discovery completes, update the tool description on the session"

4. **At this point, the tool exists but has a placeholder description.**
   The placeholder was set when the KB was created -- `searchai-tool-registration.ts` stores it in the ProjectTool record:

   ```
   Tool: search_bugs
   Description: "Search the "Jira Engineering Issues" knowledge base"   <-- generic, no vocabulary or filter info
   ```

   This is all the agent LLM sees until the first tool call.

5. **On first tool call** (not session start -- discovery is deferred):
   When the agent LLM calls `search_bugs(query="...")`, the runtime executor intercepts it:
   - `SearchAIKBToolExecutor.execute()` calls `ensureDiscovery()` **before** executing the search
   - `ensureDiscovery()` calls `GET /api/search/:indexId/discover` to fetch the capability manifest
   - `buildToolDescription(manifest)` converts the manifest into LLM-readable prose
   - The registered callback fires, updating `session._effectiveConfig.tools[].description` with the enriched version
   - The search then executes normally and returns results to the agent
   - On subsequent turns, the agent LLM now sees the full enriched description (vocabulary, filters, classification guidance)

**This is automatic for every ABL agent.** Any agent that declares a `type: searchai` tool in its DSL gets this behavior. The detection is a simple filter in `llm-wiring.ts`:

```typescript
const searchaiTools = allTools.filter((t) => t.tool_type === 'searchai');
if (searchaiTools.length > 0) {
  // wire up executor + discovery automatically
}
```

**Why deferred?** Discovery requires an HTTP call to the SearchAI Runtime. Doing it at session creation for every KB tool would add latency, even if the agent never uses that tool. By deferring to first call, we only pay the cost when the tool is actually used. The manifest is then cached (5min TTL) for subsequent calls.

**The flow visualized:**

```
Agent LLM                          Runtime Code                        SearchAI Runtime
    |                                   |                                    |
    |  "I want to search for bugs"      |                                    |
    |---- search_bugs(query="bugs") --->|                                    |
    |                                   |-- GET /discover ------------------>|
    |                                   |<-- manifest (vocab, filters...) ---|
    |                                   |                                    |
    |                                   |  [builds enriched description]     |
    |                                   |  [updates session tool desc]       |
    |                                   |                                    |
    |                                   |-- POST /query {query: "bugs"} --->|
    |                                   |<-- search results ----------------|
    |<-- results -----------------------|                                    |
    |                                   |                                    |
    |  [next turn: agent now sees       |                                    |
    |   enriched description with       |                                    |
    |   vocabulary, filters, etc.]      |                                    |
```

**Key files:** `apps/runtime/src/services/execution/llm-wiring.ts` (wiring + callback), `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts` (discovery + execution), `apps/search-ai/src/services/searchai-tool-registration.ts` (placeholder description)

---

## Scene 6: Discovery -- The Manifest

The discovery endpoint builds a self-describing capability manifest for a knowledge base. It is called by the **runtime infrastructure** (not the agent LLM) and its output is transformed into a tool description that the agent reads.

**Endpoint:** `GET /api/search/:indexId/discover`

**How the manifest is built:**

1. Load three data sources in parallel:
   - `SearchIndex` (KB metadata: name, doc count, last updated)
   - `DomainVocabulary` (business terms, latest active version)
   - `CanonicalSchema` (field definitions with aliases and enums)

2. Assemble capabilities based on what data exists:
   - If vocabulary has entries -> `vocabulary.available = true`
   - If schema has filterable fields -> `filters.available = true`
   - If schema has aggregatable fields -> `aggregation.available = true`
   - Reranking and preprocessing are always available (service-level capabilities)

3. **Budget the data for LLM context** -- vocabulary is sliced to first 50 terms, filter fields to first 30 (LLMs have context limits)

**The manifest JSON** (simplified for readability):

```json
{
  "kb": {
    "name": "Jira Engineering Issues",
    "documentCount": 12847,
    "lastUpdated": "2026-03-09T14:30:00Z"
  },

  "capabilities": {
    "queryClassification": {
      "available": true,
      "types": {
        "structured": "Use when query only needs field filters, no semantic search",
        "semantic": "Use when query is about concepts, no specific field constraints",
        "hybrid": "Use when query has both filters and concepts",
        "aggregation": "Use when query asks for counts, totals, or grouping"
      },
      "examples": [
        {
          "query": "show open P0 bugs",
          "type": "structured",
          "reasoning": "Only field filters, no concepts"
        },
        { "query": "how does auth work", "type": "semantic", "reasoning": "Conceptual question" },
        { "query": "high priority auth bugs", "type": "hybrid", "reasoning": "Filters + concept" },
        { "query": "bugs per assignee", "type": "aggregation", "reasoning": "Counting/grouping" }
      ],
      "skipWhen": "You already know the query intent from conversation context"
    },

    "vocabulary": {
      "available": true,
      "version": 3,
      "terms": [
        {
          "term": "priority",
          "aliases": ["urgency", "p-level"],
          "field": "issue_priority",
          "values": ["critical", "high", "medium", "low", "trivial"],
          "enumMap": { "critical": 1, "high": 2, "medium": 3, "low": 4, "trivial": 5 },
          "canFilter": true,
          "canAggregate": true,
          "usage": "When user mentions priority, urgency, or P-level, use as filter: {field: 'issue_priority', operator: 'eq', value: '<level>'}"
        },
        {
          "term": "assignee",
          "aliases": ["assigned to", "owner"],
          "field": "assignee_email",
          "canFilter": true,
          "canAggregate": true,
          "usage": "When user mentions who is working on something, use as filter: {field: 'assignee_email', operator: 'eq', value: '<email>'}"
        },
        {
          "term": "status",
          "aliases": ["state", "workflow state"],
          "field": "status",
          "values": ["open", "in_progress", "closed", "on_hold"],
          "enumMap": {
            "open": "open",
            "in_progress": "in_progress",
            "closed": "closed",
            "on_hold": "on_hold"
          },
          "canFilter": true,
          "canAggregate": true,
          "usage": "When user mentions status or state, use as filter: {field: 'status', operator: 'eq', value: '<status>'}"
        }
      ],
      "skipWhen": "The user's query is purely conceptual with no field constraints"
    },

    "filters": {
      "available": true,
      "fields": [
        {
          "name": "issue_priority",
          "type": "string",
          "values": ["critical", "high", "medium", "low", "trivial"],
          "enumMap": { "critical": 1, "high": 2, "medium": 3, "low": 4, "trivial": 5 },
          "sortable": true
        },
        { "name": "assignee_email", "type": "string", "sortable": false },
        {
          "name": "status",
          "type": "string",
          "values": ["open", "in_progress", "closed", "on_hold"],
          "enumMap": {
            "open": "open",
            "in_progress": "in_progress",
            "closed": "closed",
            "on_hold": "on_hold"
          },
          "sortable": true
        }
      ],
      "operators": ["equals", "in", "contains", "greater_than", "less_than"]
    },

    "aggregation": {
      "available": true,
      "functions": ["count", "sum", "avg", "min", "max"],
      "skipWhen": "The user wants documents, not statistics"
    },

    "reranking": {
      "available": true,
      "skipWhen": "The query is structured-only or aggregation"
    },

    "preprocessing": {
      "available": true,
      "skipWhen": "You have already rephrased the query for the user"
    }
  }
}
```

**Cached:** LRU 200 entries, 5min TTL per `{tenantId}:{indexId}`.

**Key file:** `apps/search-ai-runtime/src/routes/discover.ts`

---

## Scene 7: The Description Builder -- Manifest Becomes Instructions

The raw manifest JSON is not what the agent LLM sees. The description builder transforms it into plain-text prose that fits naturally in a tool description. This is critical because LLMs understand prose better than JSON structures.

**What the agent LLM actually sees** (injected into the tool's `description` field):

```
Search the "Jira Engineering Issues" knowledge base (12,847 documents, updated 5h ago).

SEARCH CONTRACT:
  POST /api/search/{indexId}/query
  All parameters optional except query.

QUERY CLASSIFICATION (available):
  Choose the right query type:
  - "structured": Only field filters, no semantic search. Example: "show open P0 bugs"
  - "semantic": Conceptual question. Example: "how does authentication work"
  - "hybrid": Filters + concepts. Example: "high priority auth bugs"
  - "aggregation": Counts, totals, grouping. Example: "bugs per assignee"

VOCABULARY (available, 3 terms):
  Map business language to search filters.

  - "priority" (aliases: urgency, p-level) -> field: issue_priority
    Values: critical=1, high=2, medium=3, low=4, trivial=5
    Usage: When user mentions priority, use filter {field: "issue_priority", operator: "eq", value: "<level>"}

  - "assignee" (aliases: assigned to, owner) -> field: assignee_email
    Usage: When user mentions who owns/works on something, use filter {field: "assignee_email", operator: "eq", value: "<email>"}

  - "status" (aliases: state, workflow state) -> field: status
    Values: open, in_progress, closed, on_hold
    Usage: When user mentions status, use filter {field: "status", operator: "eq", value: "<status>"}

FILTERS (available):
  Fields: issue_priority (string, sortable), assignee_email (string), status (string, sortable)
  Operators: equals, in, contains, greater_than, less_than

AGGREGATION (available):
  Functions: count, sum, avg, min, max
  Skip when: User wants documents, not statistics.

RERANKING (available):
  Improves result quality for semantic/hybrid queries.
  Skip when: Query is structured or aggregation.

PREPROCESSING (available):
  Corrects typos and expands synonyms.
  Skip when: You have already rephrased the query.
```

**Key design decisions:**

- Max 50 vocabulary terms, 30 filter fields -- context budget for the LLM
- Enum mappings shown as `display_name=stored_value` so the agent knows both
- Each section has `skipWhen` guidance -- the agent knows when NOT to use a capability
- Pure prose, no nested JSON -- LLMs parse this more reliably

**Key file:** `apps/runtime/src/services/search-ai/description-builder.ts`

---

## Scene 8: The Agent Decides How to Search

Now the agent has the full tool description. When a user asks something, the agent uses this information to construct a precise search call. The agent is not following a fixed algorithm -- it's an LLM reading the description and making decisions. But the description is structured to guide those decisions.

### Decision Flow

```
User: "Show me the critical bugs assigned to Alice"
  │
  ├── Agent reads VOCABULARY section:
  │   ├── "critical" matches "priority" term (alias: urgency, p-level)
  │   │   → filter: { field: "issue_priority", operator: "eq", value: "critical" }
  │   ├── "Alice" matches "assignee" term (alias: assigned to, owner)
  │   │   → filter: { field: "assignee_email", operator: "eq", value: "alice@acme.com" }
  │   └── "bugs" → no vocabulary match → semantic concept
  │
  ├── Agent reads CLASSIFICATION section:
  │   ├── Has filters (priority, assignee) AND semantic concept (bugs)
  │   └── → queryType: "hybrid"
  │
  ├── Agent reads PREPROCESSING section:
  │   ├── "I already understand the query, no typos"
  │   └── → skipPreprocessing: true
  │
  └── Agent constructs the tool call:
      {
        "query": "critical bugs",
        "queryType": "hybrid",
        "filters": [
          { "field": "issue_priority", "operator": "eq", "value": "critical" },
          { "field": "assignee_email", "operator": "eq", "value": "alice@acme.com" }
        ],
        "skipPreprocessing": true,
        "skipVocabularyResolution": true,
        "rerank": true,
        "topK": 10
      }
```

**Notice:** The agent uses alias names (`issue_priority`, `assignee_email`) and display values (`"critical"`), not OpenSearch paths or stored values. Stage 2.5 will handle the translation.

**Notice:** The agent sets `skipVocabularyResolution: true` because it already did the vocabulary work. The pipeline will skip Stages 1 and 2 entirely.

### What Happens Next

The `SearchAIKBToolExecutor` receives this tool call and:

1. Translates the parameters to a `POST /api/search/:indexId/query` request body
2. Calls `SearchAIClient.unifiedSearch(indexId, body)` with the inherited auth token
3. Receives the search results
4. Formats them for LLM consumption (strips internal metadata, keeps documentId, score, content)
5. Returns to the agent, which presents results to the user

**Key file:** `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`

---

# Act III: The Query Pipeline

Now we're inside the pipeline. A query has arrived -- either from a direct user or from an agent. This act walks through each stage in detail.

### Which Stages Run

```
                          Direct User    Agent
Stage 0: Permission        [always]     [always]
Stage 1: Preprocessing     [runs]       [skipped]
Stage 2: Vocabulary + LLM  [runs]       [skipped]
Stage 2.5: Alias Resolution [runs]      [runs]
Stage 3: Search Execution   [always]    [always]
Stage 4: Reranking          [optional]  [optional]
Stage 5: Metrics            [always]    [always]
```

The agent flow is a fast path -- it skips the expensive NLP and LLM stages because the agent already did that work using the discovery manifest.

---

## Scene 9: Stage 0 -- The Security Gate

**Purpose:** Ensure every query is scoped to what the caller is allowed to see.

**Why it exists:** SearchAI indexes contain documents with different visibility levels. A user should only see documents they have permission to access. This stage builds an OpenSearch filter clause that is injected into every query in Stage 3.

**How it works:**

1. Determine auth mode:
   - `user` mode: caller has an IdP token (email, domain, groups)
   - `public` mode: caller sees only publicly shared documents

2. For `user` mode:
   - Resolve user's groups from Neo4j (cached in Redis)
   - Build OpenSearch `bool` filter matching documents where:
     - `publicEverywhere = true`, OR
     - user's email is in `allowedUsers`, OR
     - user's group is in `allowedGroups`, OR
     - user's domain is in `allowedDomains`

3. **Fails closed:** If the filter cannot be built (missing token, Neo4j unreachable), the query is aborted. Never return unfiltered results.

**Output:** An OpenSearch `bool` filter clause.

**Key file:** `services/query/permission-filter-service.ts`

---

## Scene 10: Stage 1 -- Cleaning Up the Query

**Purpose:** Fix typos, expand synonyms, detect language.

**Why it exists:** Users make spelling mistakes. Without preprocessing, `"revanue for Q4"` won't match `"revenue"`.

**When it runs:** Only for direct user queries. Agents set `skipPreprocessing: true`.

**How it works:**

1. Send the raw query to the Python preprocessing service (port 8003, timeout: 100ms)
2. Get back:
   - `correctedQuery`: `"show me high priority bugs"` (was `"show me hgih priortiy bugs"`)
   - `language`: `"en"`
   - `synonyms`: `{ "priority": ["urgency", "importance"] }`
   - `entities`: dates, numbers, emails extracted

**Error handling:** Non-fatal. If the service is down, use the original query and continue.

**Key file:** `services/preprocessing/preprocessing-client.ts`

---

## Scene 11: Stage 2 -- Vocabulary Resolution (The Brain)

**Purpose:** Extract structured meaning from natural language. Turn `"high priority bugs"` into a filter `{issue_priority = high}` and determine whether this needs vector search, text search, or both.

**Why it exists:** Natural language queries contain two kinds of intent mixed together:

- **Structured intent:** "high priority" = a filter on a known field
- **Semantic intent:** "bugs" = a concept to search for in document content

This stage separates them. Filters go to OpenSearch's `filter` clause (exact match, fast). Semantic concepts go to the embedding model (vector similarity, slower but understands meaning). Getting this split right is the difference between good and bad search results.

**When it runs:** Only for direct user queries. Agents set `skipVocabularyResolution: true`.

### Path A: LLM-Based Resolution (DynamicVocabularyResolver)

This is the preferred path when an LLM is configured for the knowledge base.

**Step 1: Load the data (cached)**

- Load `DomainVocabulary` from MongoDB (LRU cache, 500 entries, 5min TTL)
- Load `CanonicalSchema` for field metadata (LRU cache, 200 entries, 10min TTL)

**Step 2: Build the LLM prompt**

The prompt includes three sections injected from the loaded data:

```
SCHEMA FIELDS:
  - issue_priority: string (filter, display, aggregate, sort)
    Description: Jira issue priority (P0-P4)
    Enum values: [critical, high, medium, low, trivial]
  - assignee_email: string (filter, display, aggregate)
    Description: Email of the person assigned to the issue
  - status: string (filter, display, aggregate, sort)
    Enum values: [open, in_progress, closed, on_hold]

VOCABULARY TERMS:
  - "priority" (aliases: urgency, p-level)
    Field: issue_priority
    Can resolve as: filter, display, aggregate, sort
  - "assignee" (aliases: assigned to, owner)
    Field: assignee_email
    Can resolve as: filter, display, aggregate

RESOLUTION RULES:
  - FILTER: keywords like "filter", "where", "with", "only", "show me"
  - DISPLAY: keywords like "show", "what is", "list"
  - AGGREGATE: keywords like "count", "total", "how many", "per", "group by"
  - SORT: keywords like "sort", "order", "top", "highest", "lowest"

QUERY TYPE CLASSIFICATION:
  - structured: only filters, no semantic search
  - semantic: concepts only, no filters
  - hybrid: filters + concepts
  - aggregation: counting, grouping, statistics
```

**Step 3: Single LLM call**

The LLM receives the prompt + the user's query and returns structured JSON:

```json
{
  "resolutions": [
    {
      "term": "high priority",
      "resolvedAs": "filter",
      "reasoning": "User wants to filter by priority level",
      "field": "issue_priority",
      "operator": "equals",
      "value": "high"
    },
    {
      "term": "Alice",
      "resolvedAs": "filter",
      "reasoning": "User wants issues assigned to a specific person",
      "field": "assignee_email",
      "operator": "equals",
      "value": "alice@acme.com"
    }
  ],
  "classifiedQueryType": "hybrid",
  "classificationConfidence": 0.92
}
```

**Step 4: Parse and validate**

- Extract JSON from the LLM response (handles markdown code blocks)
- Validate each resolution against the vocabulary -- skip any that don't match a known entry
- Convert resolutions with `resolvedAs: "filter"` into `MetadataFilter[]` objects
- Merge with any caller-provided filters

**Step 5: Extract unresolved segments**

The query was `"show me high priority bugs assigned to Alice"`. After removing resolved terms:

- Remove `"high priority"` -> matched
- Remove `"Alice"` -> matched
- Remaining: `["show", "me", "bugs", "assigned", "to"]`
- After stopword filtering: `["bugs"]`

These unresolved segments become the text used for semantic embedding in Stage 3. This is critical: the embedding should encode `"bugs"` (the semantic concept), not `"high priority bugs assigned to Alice"` (which includes filter terms that add noise).

### Path B: Static Resolution (VocabularyResolver)

Used when no LLM is configured. Cheaper but less intelligent.

**The matching algorithm runs three passes in cascade:**

```
Query: "show me high priority bugs assigned to Alice"
       (normalized to lowercase for matching)

PASS 1 - EXACT MATCH (confidence: 1.0):
  For each vocabulary entry, check if query.includes(entry.term):
    "priority" → query.includes("priority") → YES
      → ResolvedTerm { matchType: "exact", confidence: 1.0, fieldRef: "issue_priority" }
    "assignee" → query.includes("assignee") → NO
    "status" → query.includes("status") → NO

PASS 2 - ALIAS MATCH (confidence: 0.9):
  For each vocabulary entry, check if query.includes(any alias):
    "assignee" aliases: ["assigned to", "owner", "responsible"]
      → query.includes("assigned to") → YES
      → ResolvedTerm { matchType: "alias", confidence: 0.9, fieldRef: "assignee_email" }

PASS 3 - FUZZY MATCH (confidence: 0.6):
  For each unmatched entry, check if query.includes(any word from term, min 4 chars):
    "status" → words: ["status"] → query.includes("status") → NO
    (no fuzzy matches in this example)

RESULT:
  resolvedTerms: [
    { inputTerm: "priority", matchType: "exact", confidence: 1.0, fieldRef: "issue_priority" },
    { inputTerm: "assigned to", matchType: "alias", confidence: 0.9, fieldRef: "assignee_email" }
  ]
```

**Filter extraction from matched terms:**

```
For each resolved term:
  if term.capabilities.canFilter:
    → MetadataFilter { field: term.fieldRef, operator: "eq", value: term.inputTerm }

  if term.capabilities.canAggregate (and no filter):
    → AggregationSpec { measure: term.fieldRef, function: "count" }
```

**Unresolved segment extraction:**

```
Start:    "show me high priority bugs assigned to alice"
Remove:   "priority"     → "show me high  bugs assigned to alice"
Remove:   "assigned to"  → "show me high  bugs  alice"
Split on spaces, filter empties → ["show", "me", "high", "bugs", "alice"]
```

**Key limitation:** The static resolver cannot classify query type. If the caller doesn't specify `queryType`, the pipeline defaults to `semantic`.

**Key files:** `services/vocabulary/dynamic-vocabulary-resolver.ts`, `services/vocabulary/vocabulary-resolver.ts`

---

## Scene 12: Stage 2.5 -- Alias Resolution (The Translator)

**Purpose:** Translate human-readable alias names into storage field paths, and coerce display values into stored values.

**Why it exists:** There are three naming layers in the system:

```
What the user/agent says:    "issue_priority" = "high"       (alias name + display value)
What the vector store holds: metadata.canonical.priority = 2  (storage path + stored value)
```

Everyone upstream (agents, vocabulary resolution, UI) works with alias names and display values. The vector store needs actual field paths and stored values. Stage 2.5 is the translation layer.

**When it runs:** Always, whenever filters are present. This is the critical stage for agent queries -- agents skip vocabulary resolution but still need alias resolution.

**The algorithm:**

```
Input: [
  { field: "issue_priority", operator: "eq", value: "high" },
  { field: "assignee_email", operator: "eq", value: "alice@acme.com" }
]

Step 1: Load CanonicalSchema (LRU cached, 500 entries, 5min TTL)
        Build lookup map: alias name → field definition

Step 2: For each filter:
  ┌─────────────────────────────────────────────────────────────────┐
  │ Filter: { field: "issue_priority", operator: "eq", value: "high" }
  │
  │ 2a. Lookup: schema.byAlias["issue_priority"]
  │     Found: { name: "issue_priority", storageField: "priority",
  │              enumValues: { critical: 1, high: 2, medium: 3, low: 4 } }
  │
  │ 2b. Resolve field: "issue_priority" → "metadata.canonical.priority"
  │
  │ 2c. Coerce value: enumValues["high"] → 2
  │
  │ 2d. Output: { field: "metadata.canonical.priority", operator: "eq",
  │              value: 2, originalAlias: "issue_priority" }
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Filter: { field: "assignee_email", operator: "eq", value: "alice@acme.com" }
  │
  │ 2a. Lookup: schema.byAlias["assignee_email"]
  │     Found: { name: "assignee_email", storageField: "assignee",
  │              enumValues: undefined }
  │
  │ 2b. Resolve field: "assignee_email" → "metadata.canonical.assignee"
  │
  │ 2c. No enum → value stays as "alice@acme.com"
  │
  │ 2d. Output: { field: "metadata.canonical.assignee", operator: "eq",
  │              value: "alice@acme.com", originalAlias: "assignee_email" }
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Unknown field example: { field: "unknown_field", operator: "eq", value: "x" }
  │
  │ 2a. Lookup: schema.byAlias["unknown_field"]
  │     Not found
  │
  │ 2b. Passthrough: "unknown_field" → "metadata.canonical.unknown_field"
  │     (best-effort prefix, may or may not match anything in OS)
  │
  │ 2c. Value unchanged
  └─────────────────────────────────────────────────────────────────┘

Output: [
  { field: "metadata.canonical.priority", operator: "eq", value: 2 },
  { field: "metadata.canonical.assignee", operator: "eq", value: "alice@acme.com" }
]
```

**Cache invalidation:** When a CanonicalSchema is updated (field added, enum changed, alias renamed), the admin API broadcasts a Redis pub/sub message on channel `alias-resolver:invalidate`. All pods receive it and evict the relevant cache entry.

**Error handling:** Non-fatal. On error, pass through original filters with `metadata.canonical.` prefix.

**Key file:** `services/alias/alias-resolver.ts`

---

## Scene 13: Stage 3 -- Building and Executing the Search

**Purpose:** Construct the OpenSearch DSL, generate embeddings if needed, inject all filters, and execute.

**Why it exists:** Everything before this stage was preparation. This stage is where the query hits the search engine.

### Step 3a: Build OpenSearch DSL

The `HybridSearchBuilder` routes to different builders based on `queryType`:

**Structured** -- pure text search + filters, no vectors:

```json
{
  "query": {
    "bool": {
      "must": [{ "multi_match": { "query": "bugs", "fields": ["content", "title"] } }],
      "filter": [
        { "term": { "metadata.canonical.priority": 2 } },
        { "term": { "metadata.canonical.assignee.keyword": "alice@acme.com" } },
        { "bool": { "should": ["...permissionFilter..."] } }
      ]
    }
  },
  "size": 20
}
```

**Semantic** -- pure vector search, no text matching:

```json
{
  "query": {
    "knn": {
      "embedding": { "vector": [0.12, -0.34, ...1024 dims...], "k": 50 }
    }
  },
  "size": 20
}
```

**Hybrid** -- vector search + metadata filters:

```json
{
  "query": {
    "bool": {
      "must": [
        { "knn": { "embedding": { "vector": [0.12, -0.34, ...], "k": 100 } } }
      ],
      "filter": [
        { "term": { "metadata.canonical.priority": 2 } },
        { "term": { "metadata.canonical.assignee.keyword": "alice@acme.com" } },
        { "bool": { "should": ["...permissionFilter..."] } }
      ]
    }
  },
  "size": 20
}
```

**Aggregation** -- group-by, no documents returned:

```json
{
  "query": { "bool": { "filter": ["...permissionFilter..."] } },
  "aggs": {
    "by_status": { "terms": { "field": "metadata.canonical.custom_string_1", "size": 50 } }
  },
  "size": 0
}
```

### Step 3b: Generate Query Embedding (semantic/hybrid only)

Send the query text to the embedding provider and get back a dense vector.

**Critical detail:** The text sent for embedding is the **unresolved segments** from Stage 2, not the full original query. If the query was `"high priority authentication bugs"` and vocabulary resolution extracted `"high priority"` as a filter, only `"authentication bugs"` is embedded. This prevents filter terms from polluting the semantic signal.

### Step 3c: Inject Filters and Execute

1. Inject the permission filter from Stage 0 into `query.bool.filter[]`
2. Inject resolved metadata filters from Stage 2.5 into `query.bool.filter[]`
3. Execute: `vectorStore.executeQuery(indexId, dslBody)`
4. Map OpenSearch hits to `SearchResult[]`:
   - Document queries: `{ documentId, chunkId, score, content, metadata }`
   - Aggregation queries: `{ key, count, metrics }`

**Error handling:** Fatal. If OpenSearch is unreachable, return an error response.

**Key files:** `services/hybrid-search/hybrid-search-builder.ts`, `services/query/query-pipeline.ts`

---

## Scene 14: Stage 4 -- Reranking (The Quality Pass)

**Purpose:** Re-score the top candidates using a more expensive but more accurate model.

**Why it exists:** Vector search uses bi-encoder embeddings -- the query and document are encoded separately, then similarity is computed. This is fast (comparing pre-computed vectors) but approximate. Cross-encoder models look at the (query, document) pair together and produce more accurate relevance scores. Reranking the top-N with a cross-encoder improves top-3 precision by 15-25%.

**When it runs:** Only when ALL conditions are true:

- `rerank: true` in the request
- `queryType` is `semantic` or `hybrid`
- Search returned > 0 results

**Provider cascade:**

1. Voyage AI (`rerank-1`) -- fastest, cheapest
2. Cohere (`rerank-3.5`) -- industry standard fallback
3. Jina AI -- multilingual fallback

**Batching:** Under load, the `BatchedRerankerFactory` aggregates up to 16 concurrent rerank requests within a 50ms window into a single API call (60% cost reduction).

**Circuit breaker:** Per-tenant. If a provider fails repeatedly, the circuit opens and the system moves to the next provider.

**Error handling:** Non-fatal. If all providers fail, return the original results in their original order.

**Key file:** `services/rerank/batched-reranker-factory.ts`

---

## Scene 15: Stage 5 -- Metrics and Response

**Purpose:** Record cost/latency data and format the final response.

**Records:**

- Per-stage latency breakdown (permissionMs, preprocessingMs, vocabularyMs, aliasResolutionMs, embeddingMs, searchMs, rerankMs)
- Cost per provider (embedding tokens x rate, reranking documents x rate)
- Query correlation ID (`queryId` UUID) for distributed tracing
- Error details with stage identification

**Response:**

```json
{
  "queryId": "550e8400-e29b-41d4-a716-446655440000",
  "queryType": "hybrid",
  "results": [
    {
      "documentId": "doc_jira_ENG-4521",
      "chunkId": "chunk_7f3a2b",
      "score": 0.91,
      "content": "The authentication module throws a NullPointerException when...",
      "metadata": {
        "canonical": { "priority": 2, "assignee": "alice@acme.com", "custom_string_1": "open" }
      }
    }
  ],
  "totalCount": 23,
  "latency": {
    "permissionMs": 4,
    "preprocessingMs": 0,
    "vocabularyMs": 0,
    "aliasResolutionMs": 3,
    "embeddingMs": 22,
    "searchMs": 89,
    "rerankMs": 165,
    "totalMs": 283
  },
  "cost": {
    "embedding": { "provider": "bge-m3", "cost": 0.0 },
    "reranking": { "provider": "voyage", "cost": 0.01 }
  },
  "vocabularyTrace": {
    "inputQuery": "show me high priority bugs assigned to Alice",
    "resolvedTerms": ["issue_priority=high", "assignee_email=alice@acme.com"],
    "unresolvedSegments": ["bugs"],
    "appliedFilters": [
      { "field": "metadata.canonical.priority", "operator": "eq", "value": 2 },
      { "field": "metadata.canonical.assignee", "operator": "eq", "value": "alice@acme.com" }
    ]
  }
}
```

**Key files:** `services/metrics/query-metrics.ts`, `services/cost/cost-calculator.ts`

---

# Act IV: Putting It All Together

These full traces follow a single query from the moment a user speaks to the moment they see results. Every data transformation is shown.

## Scene 16: Full Trace -- Direct User Hybrid Query

**User types:** `"show me hgih priortiy bugs assigned to Alice"`

```
STAGE 0: Permission Filter (4ms)
  Input:  IdP token for alice@acme.com, groups: [engineering, devops]
  Action: Query Neo4j for group memberships, build OS bool filter
  Output: { bool: { should: [
    { term: { publicEverywhere: true } },
    { term: { "allowedUsers.keyword": "alice@acme.com" } },
    { terms: { "allowedGroups.keyword": ["engineering", "devops"] } },
    { term: { "allowedDomains.keyword": "acme.com" } }
  ]}}

STAGE 1: Preprocessing (38ms)
  Input:  "show me hgih priortiy bugs assigned to Alice"
  Action: Python service corrects spelling
  Output: "show me high priority bugs assigned to Alice"  (language: "en")

STAGE 2: Vocabulary Resolution -- LLM Path (62ms)
  Input:  "show me high priority bugs assigned to Alice"
  Action: Build prompt with vocabulary (3 terms) + schema (3 fields)
          Single LLM call returns:
          {
            resolutions: [
              { term: "high priority", resolvedAs: "filter",
                field: "issue_priority", operator: "equals", value: "high" },
              { term: "Alice", resolvedAs: "filter",
                field: "assignee_email", operator: "equals", value: "alice@acme.com" }
            ],
            classifiedQueryType: "hybrid",
            classificationConfidence: 0.94
          }
  Output: filters = [
            { field: "issue_priority", operator: "eq", value: "high" },
            { field: "assignee_email", operator: "eq", value: "alice@acme.com" }
          ]
          queryType = "hybrid"
          unresolvedSegments = ["bugs"]

STAGE 2.5: Alias Resolution (3ms)
  Input:  [
    { field: "issue_priority", operator: "eq", value: "high" },
    { field: "assignee_email", operator: "eq", value: "alice@acme.com" }
  ]
  Action: Load CanonicalSchema (cache hit)
          issue_priority → storageField: "priority", enumValues: {high: 2}
          assignee_email → storageField: "assignee", no enum
  Output: [
    { field: "metadata.canonical.priority", operator: "eq", value: 2 },
    { field: "metadata.canonical.assignee", operator: "eq", value: "alice@acme.com" }
  ]

STAGE 3: Build + Execute Search (112ms)
  3a. Build DSL: queryType = "hybrid"
      → k-NN in must + filters in filter
  3b. Embed "bugs" via BGE-M3 → vector [0.12, -0.34, ...] (22ms)
  3c. Inject permission filter + metadata filters
  3d. Final DSL:
      {
        query: { bool: {
          must: [{ knn: { embedding: { vector: [...], k: 100 } } }],
          filter: [
            { term: { "metadata.canonical.priority": 2 } },
            { term: { "metadata.canonical.assignee.keyword": "alice@acme.com" } },
            { bool: { should: [...permissionFilter...] } }
          ]
        }},
        size: 20
      }
  3e. Execute against OpenSearch (90ms)
  Output: 23 hits, top score 0.91

STAGE 4: Reranking (165ms)
  Input:  23 chunks + query "bugs"
  Action: Voyage AI rerank-1 re-scores each (query, chunk) pair
  Output: Reordered, top score 0.94 (different chunk now #1)

STAGE 5: Metrics (4ms)
  Record: totalMs=383, embeddingProvider=bge-m3, rerankerProvider=voyage
  Output: Final JSON response with 20 results + latency breakdown
```

---

## Scene 17: Full Trace -- Agent with Pre-Resolved Filters

**Agent has already read the discovery manifest and constructed:**

```json
{
  "query": "authentication error handling",
  "queryType": "semantic",
  "filters": [],
  "skipPreprocessing": true,
  "skipVocabularyResolution": true,
  "rerank": true,
  "topK": 10
}
```

```
STAGE 0: Permission Filter (3ms)
  Action: Build filter from agent's inherited auth token
  Output: Permission filter clause

STAGE 1: SKIPPED (skipPreprocessing: true)

STAGE 2: SKIPPED (skipVocabularyResolution: true)

STAGE 2.5: Alias Resolution
  Action: No filters to resolve (empty array) → no-op

STAGE 3: Build + Execute (95ms)
  3a. Build DSL: queryType = "semantic" → pure k-NN
  3b. Embed "authentication error handling" via BGE-M3 → vector
  3c. Inject permission filter (no metadata filters)
  3d. Execute against OpenSearch
  Output: 10 hits

STAGE 4: Reranking (140ms)
  Action: Rerank 10 results
  Output: Reordered results

STAGE 5: Metrics (3ms)
  Total: 241ms (fast -- no preprocessing, no vocabulary resolution)
```

---

## Scene 18: Full Trace -- Aggregation Query

**User asks:** `"how many tickets are there per status?"`

```
STAGE 0: Permission Filter (4ms)

STAGE 1: Preprocessing (35ms)
  Output: "how many tickets are there per status?" (no corrections needed)

STAGE 2: Vocabulary Resolution -- LLM Path (55ms)
  LLM returns:
    resolutions: [
      { term: "status", resolvedAs: "aggregate",
        field: "status", metric: "count", groupBy: ["status"] }
    ]
    classifiedQueryType: "aggregation"
    classificationConfidence: 0.97

STAGE 2.5: Alias Resolution (2ms)
  Action: Resolve aggregation field "status" → "metadata.canonical.custom_string_1"

STAGE 3: Build + Execute (45ms)
  DSL:
    {
      query: { bool: { filter: [...permissionFilter...] } },
      aggs: {
        by_status: { terms: { field: "metadata.canonical.custom_string_1.keyword", size: 50 } }
      },
      size: 0
    }
  Output: { open: 456, in_progress: 233, closed: 1089, on_hold: 45 }

STAGE 4: SKIPPED (aggregation queries don't rerank)

STAGE 5: Response (3ms)
  {
    queryType: "aggregation",
    aggregations: [
      { key: "open", count: 456 },
      { key: "in_progress", count: 233 },
      { key: "closed", count: 1089 },
      { key: "on_hold", count: 45 }
    ],
    totalCount: 1823
  }
```

---

# Appendix

## A. Error Handling Philosophy

| Stage                  | On Error                             | Rationale                                                |
| ---------------------- | ------------------------------------ | -------------------------------------------------------- |
| Stage 0: Permissions   | **ABORT**                            | Security gate. Never return unfiltered results.          |
| Stage 1: Preprocessing | Continue with original query         | Quality enhancement, not a requirement.                  |
| Stage 2: Vocabulary    | Continue with no filters             | Missing filters reduce precision but don't break search. |
| Stage 2.5: Alias       | Pass through with best-effort prefix | Unknown fields get `metadata.canonical.` prefix.         |
| Stage 3: Search        | **ABORT**                            | Core operation. If search fails, nothing to return.      |
| Stage 4: Reranking     | Return un-reranked results           | Quality improvement, not required.                       |
| Stage 5: Metrics       | Return results without metrics       | Never block response for metrics.                        |

**Pattern:** Security (0) and core execution (3) are fatal. Everything else degrades gracefully.

## B. Caching Strategy

| Cache                                  | Max Size | TTL          | Invalidation                              | Used By       |
| -------------------------------------- | -------- | ------------ | ----------------------------------------- | ------------- |
| DomainVocabulary                       | 500      | 5 min        | Redis pub/sub `vocabulary:invalidate`     | Stage 2       |
| CanonicalSchema (for LLM prompt)       | 200      | 10 min       | Redis pub/sub `alias-resolver:invalidate` | Stage 2       |
| CanonicalSchema (for alias resolution) | 500      | 5 min        | Redis pub/sub `alias-resolver:invalidate` | Stage 2.5     |
| Discovery manifest                     | 200      | 5 min        | Rebuilt on cache miss                     | Discovery API |
| Permission groups                      | per-user | configurable | TTL-based                                 | Stage 0       |

Cache key pattern: `${tenantId}:${knowledgeBaseId}`

## C. Key Files Reference

All paths relative to `apps/search-ai-runtime/src/`:

| File                                                 | Stage     | Purpose                                 |
| ---------------------------------------------------- | --------- | --------------------------------------- |
| `routes/query.ts`                                    | Entry     | HTTP handler, per-tenant LLM resolution |
| `routes/discover.ts`                                 | Discovery | Capability manifest endpoint            |
| `services/query/query-pipeline.ts`                   | All       | Pipeline orchestrator                   |
| `services/query/permission-filter-service.ts`        | 0         | Permission filter construction          |
| `services/preprocessing/preprocessing-client.ts`     | 1         | Python service client                   |
| `services/vocabulary/dynamic-vocabulary-resolver.ts` | 2         | LLM-based vocabulary resolution         |
| `services/vocabulary/vocabulary-resolver.ts`         | 2         | Static vocabulary matching              |
| `services/alias/alias-resolver.ts`                   | 2.5       | Alias-to-OS-path translation            |
| `services/hybrid-search/hybrid-search-builder.ts`    | 3         | OpenSearch DSL builder                  |
| `services/rerank/batched-reranker-factory.ts`        | 4         | Multi-provider reranking                |
| `services/metrics/query-metrics.ts`                  | 5         | Latency/cost recording                  |

Agent-side files in `apps/runtime/src/services/search-ai/`:

| File                           | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `searchai-kb-tool-executor.ts` | Executes KB tool calls, manages discovery         |
| `description-builder.ts`       | Converts manifest JSON to LLM-readable text       |
| `search-ai-tool-executor.ts`   | Wraps executor, intercepts low-level search calls |
| `search-ai-tool-handler.ts`    | Routes search_vector, search_structured to SDK    |

Wiring: `apps/runtime/src/services/execution/llm-wiring.ts` -- `_wireExecutor()` detects `tool_type: 'searchai'`

## D. Configuration

| Variable                    | Default                 | Used By                          |
| --------------------------- | ----------------------- | -------------------------------- |
| `EMBEDDING_PROVIDER`        | `bge-m3`                | Stage 3: embedding model         |
| `EMBEDDING_API_URL`         | `http://bge-m3:8000`    | Stage 3: embedding service       |
| `PREPROCESSING_SERVICE_URL` | `http://localhost:8003` | Stage 1: Python service          |
| `ANTHROPIC_API_KEY`         | (none)                  | Stage 2: enables LLM resolution  |
| `MONGODB_URL`               | (required)              | Stages 2, 2.5: vocabulary/schema |
| `OPENSEARCH_URL`            | (required)              | Stage 3: search execution        |
| `REDIS_URL`                 | (required)              | Cache invalidation, permissions  |

## E. Known Limitations

1. **Hybrid search is k-NN + filter, not true RRF fusion.** The current implementation applies metadata filters to k-NN results. True hybrid would run BM25 and k-NN separately, then fuse with Reciprocal Rank Fusion. Tracked in RFC-007.

2. **No BM25 scoring in hybrid mode.** The `hybridAlpha` parameter is accepted but has no effect.

3. **Static vocabulary resolver cannot classify query type.** Without LLM, caller must specify `queryType` or it defaults to `semantic`.

4. **Reranker batching window is fixed at 50ms.** Adds unnecessary latency under low traffic.
