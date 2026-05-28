# 04 — Canonical Schema: 75-Field Fixed Schema with Alias Layer

> Continuation of 01-REQUIREMENTS, 02-DESIGN-HIGH-LEVEL, 03-DESIGN-DETAILED.
> This document captures the design decisions from brainstorming on the canonical
> schema expansion, alias layer, ConnectorTypeSchema templates, and agent integration.

## 1. Problem Statement

The current OpenSearch mapping has **10 indexed canonical fields** out of the **75 designed** in ARCHITECTURE.md Section 5.1. The gap means:

- Connector-specific fields (Jira priority, Salesforce stage, HubSpot deal amount) land in `metadata.canonical.custom` (stored but **not searchable**)
- Type conflicts across connectors: `status = "open"` (string) vs `status = 1` (number) — first document wins the mapping, second fails silently
- No standard way for agents to discover what's filterable across different connector types in the same KB
- The CanonicalSchema model stores per-KB field definitions but doesn't map to fixed OpenSearch slots

## 2. Design Decisions

| Decision             | Choice                                                    | Rationale                                                              |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Schema scope         | Fixed 75-field OpenSearch schema                          | Predictable types, no runtime conflicts                                |
| Schema instance      | Per Knowledge Base (tenantId + indexId)                   | Same connector at different customers may have different custom fields |
| Alias layer          | Yes — MongoDB only, application layer                     | Decouples business names from OpenSearch internals                     |
| Enum normalization   | At ingestion time                                         | One-time cost, consistent at query time                                |
| ConnectorTypeSchema  | Templates for all 65 connectors grouped into 8 categories | Pre-built mappings reduce LLM work to custom fields only               |
| LLM role             | Match fields by PURPOSE (name + type + sample values)     | Custom fields may match existing canonical fields                      |
| Breaking change      | Acceptable for existing data                              | Re-index with correct schema; current data is dev/staging              |
| Migration            | Not needed for OpenSearch                                 | Expand mapping in place (`dynamic: false` accepts new fields)          |
| Custom field slots   | Typed: 20 string, 10 number, 5 date, 5 boolean            | Overflow → `custom` object (stored, not indexed)                       |
| Slot reuse           | Yes — deleted alias frees the slot for re-allocation      | Slot is nulled out, available for next "Add Field"                     |
| Unused common fields | Can be aliased for different purpose per KB               | Effective pool = all 75 fields, not just 35 custom                     |
| Dynamic fields       | **None** — all 75 fields pre-defined at index creation    | Zero runtime type conflicts, zero mapping surprises                    |
| "Add Field" in UI    | Allocates next available custom slot of matching type     | User never sees `custom_string_3`; they see their alias                |
| Migration            | Not needed — system not live yet                          | Direct local changes                                                   |
| Connector discovery  | Separate task — only 1 connector currently                | Generic template for undiscovered connectors                           |

## 3. The 75-Field Canonical Schema

### 3.1 OpenSearch Field Allocation

Fields are stored under `metadata.canonical.*` in OpenSearch. The mapping uses `dynamic: "false"` so any field can be stored, but only explicitly mapped fields are indexed and searchable.

**15 CORE fields** (always populated for every document):

| #   | Field             | OS Type | Purpose                                                              |
| --- | ----------------- | ------- | -------------------------------------------------------------------- |
| 1   | `id`              | keyword | Source document unique ID                                            |
| 2   | `tenant_id`       | keyword | Tenant isolation (redundant with sys.tenantId for canonical queries) |
| 3   | `document_id`     | keyword | Internal document reference                                          |
| 4   | `title`           | text    | Document title (analyzed for BM25)                                   |
| 5   | `content_summary` | text    | First 500 chars or LLM summary                                       |
| 6   | `source_type`     | keyword | Connector type: jira, salesforce, confluence, etc.                   |
| 7   | `source_url`      | keyword | Original URL/permalink                                               |
| 8   | `created_date`    | date    | When the source document was created                                 |
| 9   | `modified_date`   | date    | Last modification timestamp                                          |
| 10  | `author`          | keyword | Creator/owner                                                        |
| 11  | `access_level`    | keyword | public, internal, restricted, confidential                           |
| 12  | `language`        | keyword | ISO 639-1 code                                                       |
| 13  | `mime_type`       | keyword | Content type                                                         |
| 14  | `status`          | keyword | Normalized: open, in_progress, done, archived                        |
| 15  | `category`        | keyword | Content classification: bug, story, article, page, file, email, etc. |

**25 COMMON fields** (populated when available):

| #   | Field              | OS Type   | Purpose                                                          |
| --- | ------------------ | --------- | ---------------------------------------------------------------- |
| 16  | `description`      | text      | Extended description (analyzed)                                  |
| 17  | `tags`             | keyword[] | Array of tag values                                              |
| 18  | `priority`         | float     | Normalized 0.0–1.0 (critical=1.0, high=0.8, medium=0.5, low=0.2) |
| 19  | `assignee`         | keyword   | Assigned person                                                  |
| 20  | `reporter`         | keyword   | Who reported/requested                                           |
| 21  | `department`       | keyword   | Organizational unit                                              |
| 22  | `project`          | keyword   | Project name/key                                                 |
| 23  | `version`          | keyword   | Version or sprint                                                |
| 24  | `parent_id`        | keyword   | Parent document (for hierarchies)                                |
| 25  | `due_date`         | date      | Deadline                                                         |
| 26  | `resolved_date`    | date      | When closed/resolved                                             |
| 27  | `attachment_count` | integer   | Number of attachments                                            |
| 28  | `comment_count`    | integer   | Number of comments                                               |
| 29  | `is_archived`      | boolean   | Archived flag                                                    |
| 30  | `severity`         | keyword   | Distinct from priority: blocker, critical, major, minor, trivial |
| 31  | `resolution`       | keyword   | How resolved: fixed, wontfix, duplicate, etc.                    |
| 32  | `component`        | keyword   | Sub-component/module                                             |
| 33  | `label`            | keyword[] | Additional labels (distinct from tags)                           |
| 34  | `story_points`     | float     | Effort estimation                                                |
| 35  | `sprint`           | keyword   | Agile sprint name                                                |
| 36  | `epic`             | keyword   | Parent epic                                                      |
| 37  | `environment`      | keyword   | dev, staging, production                                         |
| 38  | `customer`         | keyword   | Customer/account name                                            |
| 39  | `deal_amount`      | float     | Monetary value                                                   |
| 40  | `stage`            | keyword   | Pipeline/workflow stage                                          |

**35 CUSTOM SLOTS** (tenant-specific, typed):

| Range    | Field Pattern                           | OS Type                | Count                     |
| -------- | --------------------------------------- | ---------------------- | ------------------------- |
| 41–60    | `custom_string_1` .. `custom_string_20` | keyword                | 20                        |
| 61–70    | `custom_number_1` .. `custom_number_10` | float                  | 10                        |
| 71–75    | `custom_date_1` .. `custom_date_5`      | date                   | 5                         |
| —        | `custom_bool_1` .. `custom_bool_5`      | boolean                | 5 (within the 75)         |
| overflow | `custom`                                | object (enabled:false) | unlimited, not searchable |

**Entities** (extracted by NER, nested under `canonical.entities`):

| Field                   | OS Type   |
| ----------------------- | --------- |
| `entities.person`       | keyword[] |
| `entities.organization` | keyword[] |
| `entities.location`     | keyword[] |
| `entities.date`         | keyword[] |
| `entities.money`        | keyword[] |

### 3.2 Fundamental Constraint: No Dynamic Fields

**All 75 fields exist in OpenSearch from index creation. Nothing is ever added at runtime.**

Every user action, LLM suggestion, or connector discovery results in mapping to an existing pre-defined field:

| Action                                    | Result                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| User adds "Team Code" (text) in UI        | System allocates `custom_string_1` — alias in MongoDB only |
| User adds "Risk Score" (number)           | System allocates `custom_number_1` — alias in MongoDB only |
| LLM maps Jira priority → "Priority Level" | Maps to existing `priority` (common field #18)             |
| LLM maps Jira assignee → "Assigned To"    | Maps to existing `assignee` (common field #19)             |
| Connector has more fields than slots      | Overflow → `custom` object (stored, not searchable)        |

The OpenSearch mapping **never changes** after index creation. All 75 fields exist from day one; most have `null` values until something maps to them.

The UI type selector determines which slot pool to allocate from:

- Text / List → `custom_string_N` (keyword)
- Number → `custom_number_N` (float)
- Date → `custom_date_N` (date)
- Boolean → `custom_bool_N` (boolean)

### 3.3 Slot Allocation Rules

1. **Core fields** are always mapped. If a connector doesn't have a field for it, it stays null.
2. **Common fields** are mapped when the connector has a semantically matching field. LLM matches by purpose, not name.
3. **Any unused Core/Common field can be aliased for a different purpose.** If a KB doesn't need `story_points` or `deal_amount`, those slots can be aliased to something else. This means the effective usable pool is all 75 fields, not just the 35 custom slots.
4. **Custom slots** are allocated per-KB by the FieldMapping process:
   - First custom field of type string gets `custom_string_1`, second gets `custom_string_2`, etc.
   - Allocation is tracked in the CanonicalSchema document (MongoDB)
   - **Slots are reusable**: when a field alias is deleted, the slot becomes available for re-allocation (value is nulled, same as any other empty field)
5. **Overflow** goes to `custom` object — stored in OpenSearch but not indexed. Available via `_source` for retrieval but not filterable/sortable/aggregatable. Acceptable for non-critical metadata.
6. **Schema grows with connectors**: as new connector types are built, new common fields may be added to the fixed schema. This is a code change to `opensearch-mappings.ts` + reindex.

## 4. The Alias Layer

### 4.1 Why Aliases

The 75-field schema uses generic names (`custom_string_3`, `priority`, `status`). Different teams need different business terms:

- An HR team's KB: `custom_string_1` = "Employee ID", `custom_string_2` = "Department Code"
- A DevOps team's KB: `custom_string_1` = "Service Name", `custom_string_2` = "Incident ID"
- Both use the same OpenSearch fields, but need different names for agents, vocabulary, and UI

The alias layer maps **business-friendly names** → **OpenSearch canonical paths**. It lives entirely in MongoDB (the CanonicalSchema model).

### 4.2 CanonicalSchema Model (Updated)

```typescript
interface ICanonicalField {
  name: string; // ALIAS: "employee_id", "service_name", "priority_level"
  label: string; // Display: "Employee ID", "Service Name", "Priority Level"
  type: string; // Data type: string, number, float, date, boolean
  storageField: string; // ACTUAL: "custom_string_1", "priority", "status"
  description?: string; // For LLM context
  indexed: boolean; // Is the underlying OS field indexed?
  filterable: boolean; // Exposed for filtering?
  aggregatable: boolean; // Exposed for aggregation?
  sortable: boolean; // Exposed for sorting?
  enumValues?: Record<string, unknown>; // Alias value → canonical value
  // e.g., { "critical": 1.0, "high": 0.8, "medium": 0.5, "low": 0.2 }
  // e.g., { "bug": "bug", "feature request": "story", "enhancement": "story" }
  sourceConnectorField?: string; // Original connector field path (for traceability)
}
```

Key changes from current model:

- Added `storageField` — the actual OpenSearch path under `metadata.canonical.*`
- Added `sortable`
- Changed `enumValues` from `string[]` to `Record<string, unknown>` for value coercion mapping
- Added `sourceConnectorField` for traceability

### 4.3 How Aliases Work at Each Layer

```
Layer 3: DomainVocabulary
  entry.fieldRef = "priority_level"        ← uses ALIAS name
  entry.capabilities.canFilter = true

Layer 2: CanonicalSchema (Alias Resolution)
  field.name = "priority_level"            ← ALIAS
  field.storageField = "priority"       ← ACTUAL storage field
  field.enumValues = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 }

Layer 1: OpenSearch
  metadata.canonical.priority = 0.8        ← stored as float
```

### 4.4 Runtime Query Flow with Alias (6+1 Stages)

**Example query:** `"Show me high priority bugs assigned to John"`

```
Stage 0: Permission Filter
  → Inject permissions.allowedUsers / allowedGroups into bool.filter
  → No alias involvement

Stage 1: Preprocessing
  → Spell correction, synonym expansion
  → "Show me high priority bugs assigned to John"
  → No alias involvement

Stage 2: Vocabulary Resolution (LLM or Static)
  → Load DomainVocabulary entries for this KB
  → LLM receives vocabulary with ALIAS names + enum maps:
      priority_level: { type: float, enum: { critical: 1.0, high: 0.8, ... } }
      issue_type:     { type: keyword, enum: [bug, story, task, epic] }
      assigned_to:    { type: keyword }
  → LLM output:
      [
        { field: "priority_level", operator: "gte", value: "high" },
        { field: "issue_type", operator: "equals", value: "bug" },
        { field: "assigned_to", operator: "contains", value: "john" }
      ]
      classifiedQueryType: "hybrid"

Stage 2.5: Alias Resolution (NEW)
  → Load CanonicalSchema for this KB (cached, LRU 5min + Redis pub/sub)
  → For each filter:
      "priority_level" → storageField: "priority", enum "high" → 0.8
      "issue_type"     → storageField: "category", value "bug" (direct)
      "assigned_to"    → storageField: "assignee", value "john" (direct)
  → Output:
      [
        { field: "metadata.canonical.priority", operator: "gte", value: 0.8 },
        { field: "metadata.canonical.category", operator: "equals", value: "bug" },
        { field: "metadata.canonical.assignee", operator: "contains", value: "john" }
      ]

Stage 3: Build + Execute Search
  → HybridSearchBuilder receives resolved OpenSearch paths
  → Builds DSL with k-NN + filters (hybrid query)
  → Executes against OpenSearch

Stage 4: Rerank (optional)
Stage 5: Metrics + Cost
```

### 4.5 Alias Resolution Service

A new lightweight service that sits between vocabulary resolution and query building:

```typescript
class AliasResolver {
  private cache: LRUCache<string, Map<string, ICanonicalField>>;
  // Cache key: `${tenantId}:${knowledgeBaseId}`

  async resolve(
    filters: Array<{ field: string; operator: string; value: unknown }>,
    knowledgeBaseId: string,
    tenantId: string,
  ): Promise<Array<{ field: string; operator: string; value: unknown }>> {
    const schema = await this.loadSchema(knowledgeBaseId, tenantId);

    return filters.map((f) => {
      const canonical = schema.get(f.field);
      if (!canonical) return f; // passthrough if no alias found

      let resolvedValue = f.value;

      // Enum coercion: if value matches an enum key, replace with mapped value
      if (canonical.enumValues && typeof f.value === 'string') {
        const enumVal = canonical.enumValues[f.value.toLowerCase()];
        if (enumVal !== undefined) resolvedValue = enumVal;
      }

      return {
        field: `metadata.canonical.${canonical.storageField}`,
        operator: f.operator,
        value: resolvedValue,
      };
    });
  }
}
```

Follows the same caching pattern as VocabularyResolver: LRU + Redis pub/sub invalidation.

### 4.6 Ingestion Flow with Alias

At ingestion time, the CanonicalMapperService uses FieldMapping (not aliases). Aliases are query-time only.

```
Source Document (Jira issue)
  fields.priority.name = "Highest"
  fields.issuetype.name = "Bug"
  fields.assignee.displayName = "John Doe"
        │
        ▼
FieldMapping (Layer 1 → Layer 2)
  sourcePath: "fields.priority.name"  → canonicalField: "priority"    transform: rename_value { "Highest": 1.0, "High": 0.8, ... }
  sourcePath: "fields.issuetype.name" → canonicalField: "category"    transform: lowercase
  sourcePath: "fields.assignee.displayName" → canonicalField: "assignee" transform: lowercase
        │
        ▼
OpenSearch Document
  metadata.canonical.priority = 1.0
  metadata.canonical.category = "bug"
  metadata.canonical.assignee = "john doe"
```

The alias layer (`CanonicalSchema.fields[].name = "priority_level"`) is not used during ingestion. It only provides the mapping from business names to storage fields at query time.

**FieldMapping.canonicalField** stores the storage field name (e.g., `priority`, `category`, `custom_string_1`), NOT the alias name.

### 4.7 Challenges with Decoupled Alias and FieldMapping

Since FieldMapping stores OS field names and CanonicalSchema stores aliases, there are four integration challenges:

**Challenge 1 — UI reverse lookup**: The Field Mappings review section shows suggestions targeting OS field names (e.g., `custom_string_1`), but the user needs to see the alias ("Team Code"). The backend mapping API must return the resolved alias alongside each mapping — don't make the UI do the lookup.

**Challenge 2 — Alias rename cascades to vocabulary**: If user renames alias "team_code" to "squad_id", FieldMappings (pointing at `custom_string_1`) are unaffected. But DomainVocabulary entries referencing `fieldRef: "team_code"` must be updated. Alias rename must cascade-update vocabulary entries.

**Challenge 3 — Suggestion flow must propose alias names**: When MappingSuggestionService suggests `customfield_10042 → custom_string_1`, the user sees a meaningless slot name. The LLM must also suggest a human-readable alias (e.g., "Team Code"). On accept, the FieldMapping AND the CanonicalSchema alias are created together atomically.

**Challenge 4 — Slot allocation must be atomic**: When accepting a mapping to a custom slot, the system must atomically allocate the slot AND create the alias. Use MongoDB `findOneAndUpdate` with a filter ensuring the slot isn't already allocated. This prevents two concurrent accepts from claiming the same slot.

## 5. ConnectorTypeSchema Templates

### 5.1 Template Categories

Instead of defining 65 individual schemas, we group connectors by the type of data they produce. Each template defines which of the 75 canonical fields are relevant.

| #   | Category          | Connectors                                                                                               | Core + Common Fields Used                                                                                                                                                 |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Issue/Ticket**  | Jira, Linear, Asana, Monday, ClickUp, Shortcut, Youtrack, Trello, Basecamp, Wrike, Teamwork, Notion (DB) | title, status, priority, assignee, reporter, category, tags, project, sprint, epic, story_points, component, severity, resolution, due_date, resolved_date, comment_count |
| 2   | **Document/Page** | Confluence, Notion (pages), SharePoint (pages), Google Docs, Dropbox Paper, Coda, Quip                   | title, author, content_summary, category, tags, department, version, parent_id, modified_date, comment_count, is_archived                                                 |
| 3   | **File/Storage**  | Google Drive, OneDrive, SharePoint (files), Dropbox, Box, S3                                             | title, author, mime_type, source_url, created_date, modified_date, access_level, parent_id, attachment_count, is_archived                                                 |
| 4   | **Code/DevOps**   | GitHub, GitLab, Bitbucket, Azure DevOps                                                                  | title, status, assignee, category (PR/issue/commit), tags (labels), project (repo), version (branch/tag), environment, component                                          |
| 5   | **Communication** | Slack, Teams, Discord, Gmail, Outlook, Intercom, Front, Zendesk (tickets)                                | title (subject), author (sender), content_summary, created_date, tags, category (channel/thread/DM), customer, status                                                     |
| 6   | **CRM/Sales**     | Salesforce, HubSpot, Pipedrive, Zoho CRM, Freshsales, Close                                              | title (name), status, stage, customer, deal_amount, assignee (owner), priority, tags, due_date, category (lead/opportunity/account)                                       |
| 7   | **Incident/ITSM** | ServiceNow, PagerDuty, OpsGenie, Statuspage, Freshservice                                                | title, status, priority, severity, assignee, reporter, category, resolution, environment, customer, due_date, resolved_date                                               |
| 8   | **Generic**       | All other connectors, REST API, webhooks, custom                                                         | title, author, content_summary, source_type, source_url, created_date, modified_date, tags, category, status                                                              |

### 5.2 How Templates Are Used

ConnectorTypeSchema templates are **not** stored in the database. They are code constants used by three services, all on the **search-ai (ingestion) side** — the runtime/query side does not use templates:

| Service                      | Location          | How it uses template                                                                                                                                    |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MappingSuggestionService`   | `apps/search-ai/` | LLM prompt includes template: "For Jira (Issue/Ticket type), these canonical fields are typically relevant..." — reduces LLM work to only custom fields |
| `BaseSchemaDiscoveryService` | `apps/search-ai/` | After discovering fields, template narrows which canonical fields to suggest mappings for                                                               |
| `VocabularyGenerationWorker` | `apps/search-ai/` | Auto-generates base DomainVocabulary terms for the connector category                                                                                   |

Runtime/query services (VocabularyResolver, HybridSearchBuilder, AliasResolver) read whatever is already in CanonicalSchema and DomainVocabulary — they don't need templates.

```typescript
// packages/search-ai-internal/src/canonical/connector-type-templates.ts

export const CONNECTOR_TYPE_TEMPLATES: Record<string, ConnectorTypeTemplate> = {
  'issue_ticket': {
    connectors: ['jira', 'linear', 'asana', 'monday', 'clickup', ...],
    coreFieldMappings: {
      // canonical field → typical source field patterns
      'title': ['summary', 'name', 'title', 'subject'],
      'status': ['status', 'state', 'stage'],
      'priority': ['priority', 'urgency', 'importance'],
      'assignee': ['assignee', 'assigned_to', 'owner'],
      'category': ['issuetype', 'issue_type', 'type', 'kind'],
      // ...
    },
    expectedCustomFields: 5, // typical number of custom fields
  },
  // ... other categories
};
```

### 5.3 LLM + Template Interaction

For a Jira connector with 150 discovered fields:

1. **Template narrows scope**: Issue/Ticket template says ~17 common fields are relevant
2. **Auto-map system fields**: `summary` → `title`, `status.name` → `status` (high confidence, direct)
3. **LLM handles custom fields**: The remaining ~130 fields (mostly `customfield_*`) are presented to LLM with sample values. LLM decides:
   - `customfield_10001` (name: "Story Points", type: number, samples: [1, 2, 3, 5, 8]) → `story_points` (match by purpose)
   - `customfield_10042` (name: "Team Code", type: string, samples: ["ALPHA", "BETA"]) → `custom_string_1` (no standard field matches)
   - `customfield_10099` (name: "Release Target", type: string, samples: ["v2.1", "v3.0"]) → `version` (match by purpose)
4. **CanonicalSchema created** with aliases:
   - `name: "story_points"` → `storageField: "story_points"` (standard common field)
   - `name: "team_code"` → `storageField: "custom_string_1"` (allocated custom slot)
   - `name: "release_target"` → `storageField: "version"` (mapped to standard field)

## 6. Agent Integration

### 6.1 How an Agent Discovers Canonical Fields

When an ABL agent has a `type: searchai` tool, the discovery flow exposes canonical fields through the alias layer:

```
Agent session starts
  ↓
LLM wiring detects searchai tool binding (indexId, tenantId)
  ↓
SearchAIKBToolExecutor created, binding registered
  ↓
First tool call triggers discovery:
  GET /api/search/:indexId/discover
  ↓
Discovery API loads:
  - SearchIndex (KB metadata, doc count)
  - DomainVocabulary (business terms with fieldRef = ALIAS names)
  - CanonicalSchema (alias → storageField mapping + enum values)
  ↓
Builds capability manifest:
  vocabulary.terms = [
    { term: "priority", aliases: ["urgency"], fieldRef: "priority_level",
      enumValues: { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 } },
    { term: "status", fieldRef: "ticket_status",
      enumValues: { open: "open", closed: "done", "in progress": "in_progress" } },
    ...
  ]
  filters.fields = [
    { name: "priority_level", type: "float", operators: ["eq","gt","lt","gte","lte"],
      enumValues: { critical: 1.0, high: 0.8, ... } },
    { name: "ticket_status", type: "keyword", operators: ["eq","in"],
      enumValues: ["open","in_progress","done","archived"] },
    { name: "assigned_to", type: "keyword", operators: ["eq","contains"] },
    ...
  ]
  ↓
description-builder.ts converts manifest to LLM-readable text
  ↓
Session tool description updated via callback
```

### 6.2 What the Agent Sees (Tool Description)

After discovery, the agent's tool description includes:

```
## Knowledge Base: Engineering Tracker
12,450 documents | Last updated: 2026-03-08

### Filters
Available filter fields:
- priority_level (float): critical=1.0, high=0.8, medium=0.5, low=0.2
  Operators: eq, gt, lt, gte, lte
- ticket_status (keyword): open, in_progress, done, archived
  Operators: eq, in
- assigned_to (keyword)
  Operators: eq, contains
- issue_type (keyword): bug, story, task, epic
  Operators: eq, in
- team_code (keyword): ALPHA, BETA, GAMMA
  Operators: eq, in

### Vocabulary
- "priority" / "urgency" → priority_level
- "status" → ticket_status
- "assigned to" / "owner" → assigned_to
- "bug" / "defect" → issue_type = bug
```

The agent uses **alias names** in its tool calls. The pipeline resolves them to OpenSearch paths.

### 6.3 Agent Tool Call → Search Execution

```
Agent LLM decides to search:
  search_kb_engineering({
    query: "high priority bugs assigned to John",
    queryType: "hybrid",
    filters: [
      { field: "priority_level", operator: "gte", value: "high" },
      { field: "issue_type", operator: "eq", value: "bug" }
    ]
  })
      │
      ▼
SearchAIKBToolExecutor.execute()
  → POST /api/search/:indexId/query
      │
      ▼
QueryPipeline.executeUnified()
  Stage 0: Permission filter injected
  Stage 1: Preprocessing (skipped if agent sends skipPreprocessing: true)
  Stage 2: Vocab resolution (skipped if agent sends explicit filters)
  Stage 2.5: Alias resolution
    "priority_level" gte "high" → metadata.canonical.priority gte 0.8
    "issue_type" eq "bug"       → metadata.canonical.category eq "bug"
  Stage 3: Build OpenSearch DSL + execute
  Stage 4: Rerank
  Stage 5: Metrics
      │
      ▼
Results returned to agent with canonical field names (aliases)
```

### 6.4 Agent Flow: Direct Filters vs Auto-Resolution

**Scenario A — Agent provides explicit filters (agent flow):**

```
Agent sends: { filters: [...], skipPreprocessing: true, skipVocabularyResolution: true }
Pipeline: Stage 0 → skip 1 → skip 2 → Stage 2.5 (alias) → Stage 3 → Stage 4 → Stage 5
```

The agent already knows the filter fields from the discovery manifest. It constructs filters using alias names. Only alias resolution runs to translate to OpenSearch paths.

**Scenario B — User direct query (no agent):**

```
User sends: { query: "high priority bugs for John", queryType: "hybrid" }
Pipeline: Stage 0 → Stage 1 → Stage 2 (LLM vocab) → Stage 2.5 (alias) → Stage 3 → Stage 4 → Stage 5
```

Full pipeline. LLM vocabulary resolution identifies structured terms, alias resolution converts to OpenSearch paths.

**Scenario C — Agent passes through user query (delegation):**

```
Agent sends: { query: "high priority bugs for John" }  // no filters, no skip flags
Pipeline: Stage 0 → Stage 1 → Stage 2 (LLM vocab) → Stage 2.5 (alias) → Stage 3 → Stage 4 → Stage 5
```

Agent decides the user query needs full pipeline processing. Same as Scenario B.

## 7. Type Coercion Pipeline

### 7.1 When Coercion Happens

Type coercion happens at **two points**:

1. **Ingestion time** (CanonicalMapperService) — Connector source values → canonical OpenSearch types
2. **Query time** (AliasResolver) — User/LLM filter values → canonical OpenSearch types

### 7.2 Ingestion Transforms (FieldMapping)

| Transform      | Example                                              |
| -------------- | ---------------------------------------------------- |
| `direct`       | Copy as-is                                           |
| `lowercase`    | "John Doe" → "john doe"                              |
| `split`        | "bug,feature" → ["bug", "feature"]                   |
| `date_format`  | "03/09/2026" → "2026-03-09T00:00:00Z"                |
| `rename_value` | Jira "Highest" → 1.0, "High" → 0.8                   |
| `extract`      | Regex: `PR-(\d+)` from "PR-1234 fix login" → "1234"  |
| `coalesce`     | Try assignee.displayName, then assignee.emailAddress |
| `compute`      | `attachment_count = attachments.length`              |

### 7.3 Query-Time Enum Coercion (AliasResolver)

When the LLM or user provides a human-readable value, the alias layer coerces it:

```
Input:  { field: "priority_level", operator: "gte", value: "high" }
Schema: enumValues = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 }
Output: { field: "metadata.canonical.priority", operator: "gte", value: 0.8 }
```

This works for:

- **Float enums**: priority "high" → 0.8
- **String normalization**: status "In Progress" → "in_progress"
- **Synonym mapping**: category "feature request" → "story"

If the value doesn't match any enum key, it passes through unchanged (the user may have provided the raw value directly).

## 8. Cross-Connector Field Sharing

### 8.1 Same KB, Multiple Connectors

A KB can have Jira + Confluence connected. Both connectors share the same CanonicalSchema:

```
CanonicalSchema for KB "Engineering"
├── title       → storageField: "title"      (Jira: summary, Confluence: title)
├── status      → storageField: "status"     (Jira: status.name, Confluence: status)
├── author      → storageField: "author"     (Jira: creator.displayName, Confluence: creator.publicName)
├── category    → storageField: "category"   (Jira: issuetype.name, Confluence: "page"|"blog")
├── team_code   → storageField: "custom_string_1" (Jira: customfield_10042, Confluence: space.key)
└── ...
```

Each connector has its own **FieldMapping** documents pointing to the same canonical fields. The alias is shared — `team_code` means the same thing regardless of source.

### 8.2 Custom Slot Conflicts

If Jira and Confluence both have custom fields that need `custom_string_1`, the first one registered gets it. The second gets `custom_string_2`. The allocation is tracked in CanonicalSchema and never changes.

### 8.3 Slot Exhaustion

If all 20 string slots are used:

- Field goes to `custom` object (stored, not searchable)
- Warning emitted during mapping suggestion
- Admin can review and consolidate (merge two aliased fields if they serve the same purpose)

## 9. Internal Canonical Field Mapping Service

For internal services that need to look up how a connector's fields map to canonical fields:

```typescript
interface CanonicalFieldMappingInfo {
  connectorId: string;
  connectorType: string;
  mappings: Array<{
    sourcePath: string; // e.g., "fields.priority.name"
    canonicalField: string; // e.g., "priority" (storage field)
    alias: string; // e.g., "priority_level" (business name)
    type: string; // e.g., "float"
    transform: IFieldTransform;
  }>;
}

class CanonicalFieldInfoService {
  // Used by: ingestion pipeline (to know what to map),
  //          vocabulary generation (to auto-create terms),
  //          discovery API (to expose filterable fields),
  //          admin UI (to show mapping status)

  async getFieldMappings(
    knowledgeBaseId: string,
    tenantId: string,
    connectorId?: string, // optional: filter to one connector
  ): Promise<CanonicalFieldMappingInfo[]>;

  async getAvailableSlots(
    knowledgeBaseId: string,
    tenantId: string,
  ): Promise<{ string: number; number: number; date: number; boolean: number }>;
}
```

## 10. Implementation Impact

### 10.1 Files to Change

| Area              | File                              | Change                                                   |
| ----------------- | --------------------------------- | -------------------------------------------------------- |
| **OpenSearch**    | `opensearch-mappings.ts`          | Expand `metadata.canonical` from 10 → 75 fields          |
| **Model**         | `canonical-schema.model.ts`       | Add `storageField`, `sortable`, update `enumValues` type |
| **New Service**   | `alias-resolver.ts`               | New service: alias → storage path + enum coercion        |
| **New Service**   | `canonical-field-info.service.ts` | Internal field mapping lookup                            |
| **New Constants** | `connector-type-templates.ts`     | 8 category templates with field mapping hints            |
| **Pipeline**      | `query-pipeline.ts`               | Add Stage 2.5 (alias resolution) after vocab resolution  |
| **Discovery**     | `discover.ts` route               | Include alias names + enum values in manifest            |
| **Description**   | `description-builder.ts`          | Use alias names in filter field descriptions             |
| **Ingestion**     | `canonical-mapper.service.ts`     | Use 75-field target set (currently 10)                   |
| **Mapping**       | `mapping-suggestion.service.ts`   | Include ConnectorTypeSchema templates in LLM prompt      |

### 10.2 What Does NOT Change

- **DomainVocabulary model** — already uses `fieldRef` (will store alias names)
- **FieldMapping model** — already maps sourcePath → canonicalField (storage field names)
- **VocabularyResolver** — already returns fieldRef (will naturally return alias names)
- **HybridSearchBuilder** — already receives resolved OpenSearch paths
- **SearchAIKBToolExecutor** — already delegates to /query endpoint
- **LLM wiring** — no change, discovery callback already works

### 10.3 Migration

**Not applicable.** The system is not live in production. Changes are applied directly to the local development environment. No data migration, no backward compatibility shims, no staged rollout needed.

### 10.4 Connector Status

Currently only **one connector** has schema discovery implemented. Additional connector discovery implementations are a separate task tracked outside this design. Until discovery is built for a connector, it uses the **Generic** template (Category 8: title, author, content_summary, source_type, tags, category, status).

## 11. Studio UI: Fields Tab

### 11.1 Design Principle

Users know their Knowledge Base and their fields. They do not know OpenSearch, canonical slots, or `metadata.canonical.custom_string_3`. The UI speaks the user's language:

| User concept  | System concept (hidden)                      |
| ------------- | -------------------------------------------- |
| Field name    | `CanonicalSchema.field.name` (alias)         |
| Display label | `CanonicalSchema.field.label`                |
| Type: Text    | `keyword` in OpenSearch                      |
| Type: Number  | `float` in OpenSearch                        |
| Type: Date    | `date` in OpenSearch                         |
| Type: Boolean | `boolean` in OpenSearch                      |
| Type: List    | `keyword` (array) in OpenSearch              |
| Can filter    | `filterable: true`                           |
| Can sort      | `sortable: true`                             |
| Can group by  | `aggregatable: true`                         |
| Values        | `enumValues: Record<string, unknown>`        |
| Sources       | `FieldMapping` joined with `ConnectorSchema` |

The current "Schema" tab is renamed to **"Fields"**.

### 11.2 Fields Tab Layout — Three Sections

#### Section 1: My Fields

The main view — all canonical fields the user has for this KB, displayed as expandable rows.

```
┌──────────────────────────────────────────────────────────────────┐
│  Fields                                                  [+ Add] │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ▸ Priority Level       number   ⊙ Filter  ⊙ Sort               │
│    critical · high · medium · low                                 │
│                                                                   │
│  ▸ Status               text     ⊙ Filter  ⊙ Sort  ⊙ Group     │
│    open · in_progress · done · archived                           │
│                                                                   │
│  ▸ Assigned To          text     ⊙ Filter  ⊙ Sort               │
│                                                                   │
│  ▸ Issue Type           text     ⊙ Filter  ⊙ Group              │
│    bug · story · task · epic                                      │
│                                                                   │
│  ▸ Team Code            text     ⊙ Filter  ⊙ Group              │
│    ALPHA · BETA · GAMMA                                           │
│                                                                   │
│  ▸ Story Points         number   ⊙ Sort    ⊙ Group              │
│                                                                   │
│  ▸ Created Date         date     ⊙ Filter  ⊙ Sort               │
│                                                                   │
│  ▸ Author               text     ⊙ Filter                        │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Each row:

- **Field name** — the alias (what user and agent use)
- **Type** — user-friendly badge (text, number, date, boolean, list)
- **Capabilities** — pills: Filter, Sort, Group
- **Values** — inline chips if enum values are defined
- **Expand arrow** (▸) — reveals connector sources

**Expanded row** shows where data comes from per connector:

```
▾ Priority Level       number   ⊙ Filter  ⊙ Sort
  critical · high · medium · low

  Sources
  ┌────────────────────────────────────────────────────────────┐
  │  🔷 Jira                                                    │
  │  fields.priority.name → Priority Level                      │
  │  Transform: Value mapping                                   │
  │    "Highest" → critical · "High" → high                     │
  │    "Medium" → medium · "Low" → low                          │
  │  Confidence: 95%  ✓ Confirmed                               │
  │                                                             │
  │  🔷 Confluence                                              │
  │  ⚠ No mapping — this connector doesn't have priority       │
  └────────────────────────────────────────────────────────────┘
```

Transform types shown in human language:

- `rename_value` → "Value mapping"
- `lowercase` → "Lowercase"
- `direct` → "Direct copy"
- `date_format` → "Date conversion"
- `split` → "Split into list"
- `coalesce` → "First available from multiple fields"

#### Section 2: Suggested Mappings (Review Queue)

Pending LLM-suggested mappings grouped by connector:

```
┌──────────────────────────────────────────────────────────────────┐
│  Suggested Mappings (3 pending)                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  🔷 Jira                                                          │
│                                                                   │
│  customfield_10042 ("Team Code")                                  │
│    → Team Code (text)                  78%    [Accept] [Reject]   │
│    Sample values: ALPHA, BETA, GAMMA                              │
│                                                                   │
│  customfield_10099 ("Release Target")                             │
│    → Version (text)                    72%    [Accept] [Reject]   │
│    Sample values: v2.1, v3.0, v2.5                                │
│                                                                   │
│  🔷 Confluence                                                    │
│                                                                   │
│  space.key                                                        │
│    → Team Code (text)                  65%    [Accept] [Reject]   │
│    Sample values: ENG, PRODUCT, DESIGN                            │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Shows source path, connector label from discovery, suggested target alias, confidence, sample values. Accept moves the mapping into Section 1; Reject removes it.

#### Section 3: Unmapped Fields

Connector fields not yet mapped to any canonical field:

```
┌──────────────────────────────────────────────────────────────────┐
│  Unmapped Fields                                       [Suggest] │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  🔷 Jira — 5 unmapped fields                                     │
│  customfield_10150  text    "Internal Review Notes"               │
│  customfield_10151  text    "QA Sign-off"                         │
│  customfield_10152  number  "Risk Score"                          │
│  customfield_10153  date    "SLA Target"                          │
│  customfield_10154  text    "Vendor Name"                         │
│                                                                   │
│  🔷 Confluence — 2 unmapped fields                                │
│  metadata.labels    list    (no label)                             │
│  restrictions.read  text    (no label)                             │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

User can click "Suggest" to re-run LLM mapping, or manually assign an unmapped field to an existing canonical field. Unmapped fields are stored but not searchable — the user doesn't need to know this mechanism.

### 11.3 Add Field Dialog

When user clicks "+ Add":

```
┌─────────────────────────────────────────────────┐
│  Add Field                                       │
│                                                  │
│  Field Name *         [priority_level        ]   │
│  Display Label *      [Priority Level        ]   │
│                                                  │
│  Type                 [▾ Text              ]     │
│                       Text · Number · Date ·     │
│                       Boolean · List             │
│                                                  │
│  Description          [Used for filtering     ]  │
│                       [issues by urgency      ]  │
│                       Helps the AI understand    │
│                       what this field means      │
│                                                  │
│  Capabilities                                    │
│  ☑ Can be used as filter                        │
│  ☑ Can be used for sorting                      │
│  ☐ Can be used for grouping                     │
│                                                  │
│  Values (optional)                               │
│  Define known values for this field              │
│  ┌──────────────────────────────────────────┐   │
│  │  Display Name    →    Stored Value       │   │
│  │  Critical        →    1.0                │   │
│  │  High            →    0.8                │   │
│  │  Medium          →    0.5                │   │
│  │  Low             →    0.2                │   │
│  │  [+ Add value]                           │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│              [Cancel]        [Add Field]         │
└─────────────────────────────────────────────────┘
```

- **No storage field selector** — system auto-allocates the next slot of matching type
- **Type** uses friendly labels: Text (not keyword), Number (not float)
- **Values** is a key-value editor: Display Name is what users/agents say, Stored Value is what gets indexed. For text fields both sides are the same. For number fields (priority), display is the word, stored is the number.
- **Description** helps the LLM understand the field's purpose
- If all slots of the selected type are exhausted, show: "No more [type] field slots available. The field will be stored but not searchable."

### 11.4 Relationship with Vocabulary Tab

The Vocabulary tab (`VocabularyTab.tsx`) already shows `fieldRef` which naturally uses alias names. Users see the same field names in both tabs:

- **Fields tab**: "Priority Level" — the field definition, sources, values
- **Vocabulary tab**: "priority" / "urgency" → `priority_level` — search terms that map to this field

No changes needed to VocabularyTab, VocabularyEntryForm, or VocabularyTestPanel.

### 11.5 UI File Changes

| File                          | Change                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SchemaTab.tsx`               | Rewrite as `FieldsTab.tsx`: expandable rows, three sections, human-friendly labels                        |
| `KnowledgeBaseDetailPage.tsx` | Rename tab "Schema" → "Fields"                                                                            |
| `search-ai.ts` (API types)    | Update `CanonicalField`: add `storageField`, `sortable`, change `enumValues` to `Record<string, unknown>` |
| `search-ai.ts` (API client)   | New: `getUnmappedFields(kbId, connectorId)`                                                               |
| Backend schemas route         | Return connector name/type alongside mappings (join with SearchSource)                                    |
| i18n messages                 | Rename `search_ai.schema.*` → `search_ai.fields.*`, add new strings                                       |

No changes: VocabularyTab, VocabularyEntryForm, VocabularyTestPanel, ConnectorsTab, ConnectorDetailPanel.

## 12. References

- [01-REQUIREMENTS.md](./01-REQUIREMENTS.md) — Functional and non-functional requirements
- [02-DESIGN-HIGH-LEVEL.md](./02-DESIGN-HIGH-LEVEL.md) — Three-layer architecture
- [03-DESIGN-DETAILED.md](./03-DESIGN-DETAILED.md) — Detailed technical specification
- [JIRA-CONNECTOR-WORKFLOW.md](./examples/JIRA-CONNECTOR-WORKFLOW.md) — End-to-end Jira example
- [ARCHITECTURE.md](../../ARCHITECTURE.md) Section 5.1 — Original 75-field design
- [CANONICAL-MAPPING-ACTION-ITEMS.md](../../plans/CANONICAL-MAPPING-ACTION-ITEMS.md) — HIGH-5 type conflict problem
- [QUERY-PIPELINE-DESIGN.md](../../design/QUERY-PIPELINE-DESIGN.md) — Query pipeline design
