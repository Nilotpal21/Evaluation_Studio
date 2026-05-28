# Vocabulary System Design - Part 2: Connector Configuration Workflow

**Part of:** DESIGN-VOCABULARY-SYSTEM.md
**Section:** Connector Configuration Workflow with Example Data

---

## Connector Configuration Workflow

This section shows the complete end-to-end workflow with **real example data** from configuring a Jira connector.

### Scenario: Configure Jira Connector for Bug Tracking Project

**User Goal:** Set up Jira connector for "Bug Tracker" project with auto-generated vocabulary.

---

### Step 1: Connector Configuration

**User Action:** Configure Jira connector in UI

**API Call:**

```http
POST /api/search-ai/connectors
Content-Type: application/json

{
  "tenantId": "tenant_acme",
  "name": "Jira Bug Tracker",
  "type": "jira",
  "knowledgeBaseId": "kb_bug_tracking",
  "projectKnowledgeBaseId": "pkb_bug_tracking_main",
  "config": {
    "baseUrl": "https://acme.atlassian.net",
    "email": "admin@acme.com",
    "apiToken": "••••••••"
  }
}
```

**Response:**

```json
{
  "connectorId": "conn_jira_001",
  "status": "pending_schema_discovery",
  "message": "Connector created. Schema discovery initiated."
}
```

**Behind the Scenes:**

- Connector created in database
- Job enqueued: `QUEUE_SCHEMA_SYNC`

---

### Step 2: Schema Discovery

**Worker:** `schema-sync-worker`
**Input:** Job from `QUEUE_SCHEMA_SYNC`

```typescript
{
  connectorId: "conn_jira_001",
  tenantId: "tenant_acme",
  connectorType: "jira",
  connectorConfigId: "connfg_001",
  trigger: "on_connect"
}
```

**Discovery Process:**

1. **Fetch Jira Fields:**

```http
GET https://acme.atlassian.net/rest/api/3/field
Authorization: Basic YWRtaW5AYWNtZS5jb206••••••
```

2. **Response (150 fields discovered):**

```json
[
  {
    "id": "summary",
    "name": "Summary",
    "custom": false,
    "schema": { "type": "string", "system": "summary" }
  },
  {
    "id": "status",
    "name": "Status",
    "custom": false,
    "schema": { "type": "status" }
  },
  {
    "id": "priority",
    "name": "Priority",
    "custom": false,
    "schema": { "type": "priority" }
  },
  {
    "id": "assignee",
    "name": "Assignee",
    "custom": false,
    "schema": { "type": "user" }
  },
  {
    "id": "reporter",
    "name": "Reporter",
    "custom": false,
    "schema": { "type": "user" }
  },
  {
    "id": "customfield_10020",
    "name": "Sprint",
    "custom": true,
    "schema": { "type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint" }
  },
  {
    "id": "customfield_10016",
    "name": "Story Points",
    "custom": true,
    "schema": {
      "type": "number",
      "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float"
    }
  },
  {
    "id": "created",
    "name": "Created",
    "custom": false,
    "schema": { "type": "datetime" }
  },
  {
    "id": "updated",
    "name": "Last Updated",
    "custom": false,
    "schema": { "type": "datetime" }
  },
  {
    "id": "description",
    "name": "Description",
    "custom": false,
    "schema": { "type": "string" }
  }
  // ... 140 more fields
]
```

3. **Create ConnectorSchema Document:**

```typescript
{
  _id: "cs_jira_001",
  tenantId: "tenant_acme",
  connectorId: "conn_jira_001",
  version: 1,
  fields: [
    {
      path: "summary",
      label: "Summary",
      type: "string",
      isCustom: false,
      isRequired: true,
      sampleValues: []
    },
    {
      path: "status",
      label: "Status",
      type: "string",
      isCustom: false,
      isRequired: false,
      sampleValues: []
    },
    {
      path: "priority",
      label: "Priority",
      type: "string",
      isCustom: false,
      isRequired: false,
      enumValues: ["Highest", "High", "Medium", "Low", "Lowest"],
      sampleValues: []
    },
    {
      path: "assignee",
      label: "Assignee",
      type: "string",
      isCustom: false,
      isRequired: false,
      sampleValues: []
    },
    {
      path: "customfield_10020",
      label: "Sprint",
      type: "array",
      isCustom: true,
      isRequired: false,
      sampleValues: []
    },
    {
      path: "customfield_10016",
      label: "Story Points",
      type: "number",
      isCustom: true,
      isRequired: false,
      sampleValues: []
    }
    // ... 144 more fields
  ],
  fieldCount: 150,
  customFieldCount: 45,
  status: "active",
  discoveredAt: "2026-03-06T10:00:00Z"
}
```

---

### Step 3: Field Mapping

**Service:** `mapping-suggestion.service`
**Goal:** Map 150 Jira fields → 75 canonical fields

**Canonical Schema (Pre-defined for bug tracking domain):**

```typescript
{
  _id: "cschema_bug_tracking",
  tenantId: "tenant_acme",
  knowledgeBaseId: "kb_bug_tracking",
  version: 1,
  fields: [
    {
      name: "bug_title",
      label: "Bug Title",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: false
    },
    {
      name: "status",
      label: "Status",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: true,
      enumValues: ["Open", "In Progress", "Resolved", "Closed"]
    },
    {
      name: "priority",
      label: "Priority",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: true,
      enumValues: ["Critical", "High", "Medium", "Low"]
    },
    {
      name: "assignee",
      label: "Assignee",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: true
    },
    {
      name: "reporter",
      label: "Reporter",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: true
    },
    {
      name: "sprint",
      label: "Sprint",
      type: "string",
      indexed: true,
      filterable: true,
      aggregatable: true
    },
    {
      name: "story_points",
      label: "Story Points",
      type: "number",
      indexed: true,
      filterable: true,
      aggregatable: true
    },
    {
      name: "created_date",
      label: "Created Date",
      type: "date",
      indexed: true,
      filterable: true,
      aggregatable: false
    },
    {
      name: "updated_date",
      label: "Updated Date",
      type: "date",
      indexed: true,
      filterable: true,
      aggregatable: false
    }
    // ... 66 more canonical fields
  ],
  fieldCount: 75
}
```

**Field Mappings Created:**

```typescript
[
  {
    canonicalField: 'bug_title',
    sourcePath: 'summary',
    transform: { type: 'direct' },
  },
  {
    canonicalField: 'status',
    sourcePath: 'status',
    transform: { type: 'direct' },
  },
  {
    canonicalField: 'priority',
    sourcePath: 'priority',
    transform: { type: 'direct' },
  },
  {
    canonicalField: 'assignee',
    sourcePath: 'assignee',
    transform: { type: 'direct' },
  },
  {
    canonicalField: 'sprint',
    sourcePath: 'customfield_10020',
    transform: { type: 'direct' },
  },
  {
    canonicalField: 'story_points',
    sourcePath: 'customfield_10016',
    transform: { type: 'direct' },
  },
  // ... 69 more mappings
];
```

---

### Step 4: Critical Fields Detection

**Service:** `CriticalFieldsDetectorService`
**Input:** 75 canonical fields
**Goal:** Identify 10-20 critical fields for vocabulary generation

**LLM Analysis:**

```
Input to LLM:
- Connector type: jira
- Domain: Project Management / Issue Tracking
- Example patterns from JIRA_CRITICAL_FIELDS config
- All 75 canonical fields with metadata

LLM identifies:
```

**Critical Fields Identified (12 fields):**

```json
[
  {
    "fieldPath": "bug_title",
    "reasoning": "Primary identifier matching 'summary' pattern. Essential for all queries to identify specific bugs.",
    "category": "identifier",
    "typicalUsage": ["display", "search"],
    "confidence": 0.98
  },
  {
    "fieldPath": "status",
    "reasoning": "Workflow state field. Critical for filtering (show open bugs) and aggregating (count by status).",
    "category": "workflow",
    "typicalUsage": ["filter", "aggregate", "display"],
    "confidence": 0.97
  },
  {
    "fieldPath": "priority",
    "reasoning": "Urgency indicator with enum values. Commonly used for filtering and grouping in bug tracking.",
    "category": "dimension",
    "typicalUsage": ["filter", "aggregate", "sort"],
    "confidence": 0.96
  },
  {
    "fieldPath": "assignee",
    "reasoning": "Ownership field. Users frequently filter by assignee ('show bugs assigned to me').",
    "category": "dimension",
    "typicalUsage": ["filter", "aggregate", "display"],
    "confidence": 0.95
  },
  {
    "fieldPath": "reporter",
    "reasoning": "Bug creator field. Useful for tracking who reported issues.",
    "category": "dimension",
    "typicalUsage": ["filter", "display"],
    "confidence": 0.88
  },
  {
    "fieldPath": "sprint",
    "reasoning": "Sprint assignment. Critical for agile workflows, matches custom field pattern for sprints.",
    "category": "dimension",
    "typicalUsage": ["filter", "aggregate"],
    "confidence": 0.93
  },
  {
    "fieldPath": "story_points",
    "reasoning": "Effort estimation measure. Commonly aggregated for sprint planning (sum of points).",
    "category": "measure",
    "typicalUsage": ["aggregate", "display"],
    "confidence": 0.91
  },
  {
    "fieldPath": "created_date",
    "reasoning": "Creation timestamp. Used for temporal filtering (bugs created this week).",
    "category": "metadata",
    "typicalUsage": ["filter", "sort"],
    "confidence": 0.87
  },
  {
    "fieldPath": "updated_date",
    "reasoning": "Last modified timestamp. Helps track recent activity.",
    "category": "metadata",
    "typicalUsage": ["filter", "sort"],
    "confidence": 0.84
  },
  {
    "fieldPath": "bug_type",
    "reasoning": "Bug classification (bug, task, story). Common filter dimension.",
    "category": "dimension",
    "typicalUsage": ["filter", "aggregate"],
    "confidence": 0.89
  },
  {
    "fieldPath": "resolution",
    "reasoning": "How bug was resolved. Important for closed bugs analysis.",
    "category": "workflow",
    "typicalUsage": ["filter", "display"],
    "confidence": 0.82
  },
  {
    "fieldPath": "labels",
    "reasoning": "Tags for categorization. Useful for filtering by topic/team.",
    "category": "dimension",
    "typicalUsage": ["filter"],
    "confidence": 0.79
  }
]
```

**Result:** 12 critical fields identified (10-20 target range ✓)

---

### Step 5: Vocabulary Generation

**Worker:** `vocabulary-generator-worker`
**Input:** 12 critical fields from Step 4
**Process:** For each critical field, generate vocabulary entry

#### Example 1: Generate Vocabulary for "priority" Field

**LLM Input:**

```
Canonical Field: priority
Label: Priority
Type: string
Enum Values: Critical, High, Medium, Low
Capabilities: filterable=true, aggregatable=true

Source Field: priority (from Jira)

Context: All 75 canonical fields available for related field inference

Task: Generate vocabulary entry with:
1. Aliases (3-5 natural language terms)
2. Description
3. Related fields (displayWith, aggregateWith)
```

**LLM Output:**

```json
{
  "aliases": ["importance", "urgency", "severity", "criticality"],
  "description": "Bug priority level indicating urgency of resolution",
  "relatedFields": {
    "displayWith": ["bug_title", "status", "assignee", "created_date", "reporter"],
    "aggregateWith": ["bug_title", "assignee", "status"]
  },
  "confidence": 0.94
}
```

**Vocabulary Entry Created:**

```typescript
{
  term: "Priority",                    // From canonical field label
  canonicalField: "priority",
  aliases: ["importance", "urgency", "severity", "criticality"],
  description: "Bug priority level indicating urgency of resolution",
  relatedFields: {
    displayWith: ["bug_title", "status", "assignee", "created_date", "reporter"],
    aggregateWith: ["bug_title", "assignee", "status"]
  },
  autoGenerated: true,
  confidence: 0.94,
  enabled: true,
  createdBy: "llm"
}
```

#### Example 2: Generate Vocabulary for "story_points" Field

**LLM Output:**

```json
{
  "aliases": ["points", "estimate", "effort", "sp"],
  "description": "Numeric estimate of effort required to complete the bug or task",
  "relatedFields": {
    "displayWith": ["bug_title", "assignee", "sprint", "status"],
    "aggregateWith": ["sprint", "assignee", "bug_type"]
  },
  "confidence": 0.92
}
```

**Vocabulary Entry Created:**

```typescript
{
  term: "Story Points",
  canonicalField: "story_points",
  aliases: ["points", "estimate", "effort", "sp"],
  description: "Numeric estimate of effort required to complete the bug or task",
  relatedFields: {
    "displayWith": ["bug_title", "assignee", "sprint", "status"],
    "aggregateWith": ["sprint", "assignee", "bug_type"]
  },
  autoGenerated: true,
  confidence: 0.92,
  enabled: true,
  createdBy: "llm"
}
```

#### Complete Vocabulary Document

**After processing all 12 critical fields:**

```typescript
{
  _id: "vocab_bug_tracking_001",
  tenantId: "tenant_acme",
  projectKnowledgeBaseId: "pkb_bug_tracking_main",
  version: 1,
  status: "active",
  entries: [
    {
      term: "Bug Title",
      canonicalField: "bug_title",
      aliases: ["title", "summary", "issue title", "bug name"],
      description: "Short summary describing the bug or issue",
      relatedFields: {
        displayWith: ["status", "priority", "assignee", "created_date"],
        aggregateWith: ["status", "priority", "assignee"]
      },
      autoGenerated: true,
      confidence: 0.96,
      enabled: true,
      createdBy: "llm"
    },
    {
      term: "Status",
      canonicalField: "status",
      aliases: ["state", "workflow status", "issue status"],
      description: "Current state of the bug in the workflow",
      relatedFields: {
        displayWith: ["bug_title", "assignee", "updated_date"],
        aggregateWith: ["bug_title", "priority"]
      },
      autoGenerated: true,
      confidence: 0.95,
      enabled: true,
      createdBy: "llm"
    },
    {
      term: "Priority",
      canonicalField: "priority",
      aliases: ["importance", "urgency", "severity", "criticality"],
      description: "Bug priority level indicating urgency of resolution",
      relatedFields: {
        displayWith: ["bug_title", "status", "assignee", "created_date", "reporter"],
        aggregateWith: ["bug_title", "assignee", "status"]
      },
      autoGenerated: true,
      confidence: 0.94,
      enabled: true,
      createdBy: "llm"
    }
    // ... 9 more entries for the remaining critical fields
  ],
  createdAt: "2026-03-06T10:05:00Z",
  updatedAt: "2026-03-06T10:05:00Z"
}
```

**Total Time:** ~5 minutes for 12 fields (vs 10-20 hours manual!)

---

### Step 6: User Review (Field View UI)

**UI Display:**

```
┌────────────────────────────────────────────────────────────────┐
│  Bug Tracker - Field Vocabulary                                 │
│  12 fields configured (auto-generated)                          │
└────────────────────────────────────────────────────────────────┘

┌─ Priority ──────────────────────────────────────────────────────┐
│ ✓ Auto-generated | Confidence: 94% | Enabled                   │
│                                                                  │
│ Term: Priority                                                   │
│ Aliases: importance, urgency, severity, criticality             │
│ Description: Bug priority level indicating urgency of resolution│
│                                                                  │
│ Related Fields:                                                  │
│   Display: bug_title, status, assignee, created_date, reporter  │
│   Aggregate: bug_title, assignee, status                        │
│                                                                  │
│ Users can query as:                                              │
│   - "Show high priority bugs"                                   │
│   - "Filter by urgency level"                                   │
│   - "Count bugs by importance"                                  │
│                                                                  │
│ [Edit] [Disable] [Delete]                                       │
└──────────────────────────────────────────────────────────────────┘

┌─ Story Points ──────────────────────────────────────────────────┐
│ ✓ Auto-generated | Confidence: 92% | Enabled                   │
│                                                                  │
│ Term: Story Points                                               │
│ Aliases: points, estimate, effort, sp                           │
│ Description: Numeric estimate of effort required                │
│                                                                  │
│ Related Fields:                                                  │
│   Display: bug_title, assignee, sprint, status                  │
│   Aggregate: sprint, assignee, bug_type                         │
│                                                                  │
│ [Edit] [Disable] [Delete]                                       │
└──────────────────────────────────────────────────────────────────┘

[+ Add Field Manually]  [Generate More Fields]  [Save All]
```

**User Actions:**

1. Review auto-generated entries
2. Edit aliases if needed (e.g., add domain-specific terms)
3. Add more fields manually (e.g., "component", "fix_version")
4. Save and activate

---

### Step 7: Vocabulary Active

**Status:** ✅ Vocabulary ready for queries

**System State:**

- ✅ Connector configured and syncing
- ✅ Schema discovered (150 fields)
- ✅ Canonical mapping active (75 fields)
- ✅ Vocabulary generated (12 critical fields)
- ✅ User reviewed and activated

**User can now query:**

- "Show me high priority bugs"
- "Count bugs by assignee"
- "What's the total story points for Sprint 5?"

---

## Workflow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  USER: Configure Jira Connector                                   │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 1: Create Connector                                         │
│  - POST /api/connectors                                           │
│  - Connector stored: conn_jira_001                                │
│  - Status: pending_schema_discovery                               │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 2: Schema Discovery (schema-sync-worker)                    │
│  - Call Jira API: /rest/api/3/field                              │
│  - Discover 150 fields                                            │
│  - Create ConnectorSchema: cs_jira_001                            │
│  - Field count: 150 (45 custom)                                   │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 3: Field Mapping (mapping-suggestion-service)               │
│  - Load CanonicalSchema: cschema_bug_tracking (75 fields)        │
│  - Create FieldMappings: 75 mappings                              │
│  - summary → bug_title, status → status, etc.                    │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 4: Critical Fields Detection (NEW)                          │
│  - Service: CriticalFieldsDetectorService                         │
│  - Input: 75 canonical fields + JIRA domain config               │
│  - LLM analyzes and identifies 12 critical fields                │
│  - Confidence scores: 0.79-0.98                                   │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 5: Vocabulary Generation (vocabulary-generator-worker)     │
│  - For each of 12 critical fields:                               │
│    - LLM generates aliases (3-5 per field)                       │
│    - LLM generates description                                   │
│    - LLM identifies related fields                               │
│  - Create DomainVocabulary: vocab_bug_tracking_001               │
│  - Auto-activate (status: active)                                │
│  - Time: ~5 minutes                                               │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 6: User Review (Field View UI)                              │
│  - User sees 12 auto-generated entries                            │
│  - Can edit aliases, related fields                               │
│  - Can add more fields manually                                   │
│  - Saves changes                                                  │
└────────────────┬─────────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────────┐
│  ✅ READY: Vocabulary Active for Queries                          │
│  - Users can now query using natural language                     │
│  - Vocabulary resolves terms dynamically                          │
└──────────────────────────────────────────────────────────────────┘
```

**Timeline:**

- Manual (Before): 10-20 hours of admin work
- Automated (After): 5 min (generation) + 30 min (review) = **35 minutes total**

**Savings:** 97% time reduction ✅

---

## Summary

This workflow shows:

1. **Real data** from Jira connector (150 discovered fields)
2. **Critical fields detection** (12 fields identified via LLM)
3. **Vocabulary auto-generation** (aliases, descriptions, related fields)
4. **User review flow** (Field View UI)
5. **End-to-end timeline** (35 minutes vs 10-20 hours)

The system successfully:

- ✅ Reduces manual work by 97%
- ✅ Generates high-quality vocabulary entries (confidence >0.79)
- ✅ Adapts to project-specific schema (different Jira setups → different critical fields)
- ✅ Provides review UI for admin control

**Next:** Query Resolution Examples showing how these vocabulary entries are used at query time.
