# Connector → Vocabulary Pipeline Design

> RFC: Dynamic Connector-Aware Field Mapping & Vocabulary Generation
>
> **Status:** Draft
> **Author:** Search-AI team
> **Date:** 2026-03-11
> **Related:** `04-CANONICAL-SCHEMA-ALIAS-DESIGN.md`, `QUERY-PIPELINE-DESIGN.md`, `search-ai-connectors-framework.md`

---

## 1. Problem Statement

The platform has a well-designed 7-stage query pipeline with vocabulary resolution (Stage 2) and alias resolution (Stage 2.5). It also has a 75-field canonical schema with an alias layer, field mapping infrastructure, and a vocabulary generation worker.

**However, these pieces are not wired together end-to-end for any connector.** The result:

- Canonical fields are never populated during SharePoint ingestion
- Vocabulary is never generated (worker exists but is never triggered)
- LLM prompts use generic/Jira examples regardless of connector type
- Template lookup fails for SharePoint (`'sharepoint'` not in any template list)
- Query-time vocabulary resolution has nothing to resolve against

This design addresses: **How does a connector's metadata flow from sync → canonical schema → vocabulary → query pipeline, dynamically adapting LLM behavior per connector type?**

---

## 2. Current State vs Target State

```
CURRENT STATE                           TARGET STATE

Connector syncs documents               Connector syncs documents
    │                                       │
    ▼                                       ▼
sourceMetadata.sharepoint.*             sourceMetadata.sharepoint.*
stored in SearchDocument                stored in SearchDocument
    │                                       │
    ▼                                       ▼
CanonicalMapperWorker runs              CanonicalMapperWorker runs
but no FieldMappings exist              FieldMappings exist (auto + user)
    │                                       │
    ▼                                       ▼
canonicalMetadata = {}  ← EMPTY         canonicalMetadata = {
                                          title: "quarterly-report.pdf",
                                          author: "Alice Smith",
                                          created_date: "2024-01-01",
                                          folder_path: "/sites/sales/docs",
                                          source_url: "https://..."
                                        }
                                            │
                                            ▼
DomainVocabulary = null ← MISSING       DomainVocabulary has 12 entries:
                                          "author", "site", "library",
                                          "document type", "folder", ...
                                            │
                                            ▼
Query Stage 2: vocabulary               Query Stage 2: vocabulary
resolution finds nothing                resolution extracts structured
                                        filters from natural language
    │                                       │
    ▼                                       ▼
Stage 2.5: alias resolver               Stage 2.5: alias resolver
has no schema to resolve                translates aliases → storage fields
    │                                       │
    ▼                                       ▼
Query returns: semantic only            Query returns: semantic + filters
(no structured filtering)               (full hybrid search)
```

---

## 3. Architecture: 5-Phase Connector Setup Pipeline

The connector setup is a **one-time pipeline** that runs when a connector is first configured (and re-runs on schema changes). It produces the artifacts needed by the query pipeline.

```
Phase 1          Phase 2           Phase 3          Phase 4          Phase 5
Schema           Field Mapping     Canonical        Vocabulary       Query-Time
Discovery        (auto + LLM)     Schema Build     Generation       Ready

┌──────────┐    ┌──────────────┐  ┌─────────────┐  ┌────────────┐  ┌──────────┐
│ Discover  │    │ Auto-map     │  │ Build       │  │ Detect     │  │ Cache    │
│ source    │───▶│ deterministic│─▶│ canonical   │─▶│ critical   │─▶│ warm     │
│ schema    │    │ fields       │  │ schema from │  │ fields     │  │ alias +  │
│ from API  │    │              │  │ confirmed   │  │            │  │ vocab    │
│           │    │ LLM suggest  │  │ mappings    │  │ Generate   │  │ caches   │
│           │    │ custom fields│  │             │  │ vocabulary │  │          │
│           │    │              │  │ User review │  │ entries    │  │ Emit     │
│           │    │ User review  │  │ in Studio   │  │ with LLM   │  │ pub/sub  │
└──────────┘    └──────────────┘  └─────────────┘  └────────────┘  └──────────┘
     │                │                 │                │               │
     ▼                ▼                 ▼                ▼               ▼
ConnectorSchema  FieldMapping      CanonicalSchema  DomainVocab     Redis pub/sub
(raw fields)     (source→canon)    (alias+storage)  (terms+caps)    invalidation
```

### What's implemented today

| Phase                           | Status                                                                               | Notes                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Phase 1: Schema Discovery       | Implemented for Jira/Salesforce/HubSpot/GDrive                                       | **Missing for SharePoint**                                                         |
| Phase 2: Field Mapping          | Auto-map: **not implemented**. LLM suggest: implemented. User review UI: implemented | No deterministic mappings                                                          |
| Phase 3: Canonical Schema Build | Model exists, FieldInfoService exists                                                | Not triggered from setup flow                                                      |
| Phase 4: Vocabulary Generation  | Worker exists, CriticalFieldDetection exists                                         | **Worker never triggered** (orphaned). `loadDiscoveredSchema()` returns empty stub |
| Phase 5: Cache Warm             | AliasResolver has LRU+Redis. VocabularyResolver has LRU+Redis                        | Works once data exists                                                             |

---

## 4. Design: Dynamic Connector-Aware LLM Prompts

The core design change: **every LLM interaction in the pipeline receives connector-specific context**, not generic/hardcoded examples.

### 4.1 ConnectorTypeProfile (replaces scattered templates)

Today, connector awareness is split across:

- `connector-type-templates.ts` — field patterns (used only by MappingSuggestionService)
- `vocabulary-generation-worker.ts` — hardcoded Jira/Salesforce/ServiceNow examples
- `critical-field-detection.service.ts` — hardcoded Jira/Salesforce/ServiceNow examples

**Proposed: Unify into a single `ConnectorTypeProfile`** per connector category:

```typescript
interface ConnectorTypeProfile {
  // --- Identity ---
  category: string; // 'file_storage', 'issue_ticket', etc.
  label: string; // 'File / Storage'
  connectors: string[]; // ['sharepoint', 'google_drive', 'onedrive', ...]

  // --- Phase 2: Field Mapping Hints ---
  fieldPatterns: Record<string, string[]>; // canonical → source patterns
  relevantFields: string[]; // which canonical fields matter
  expectedCustomFields: number; // typical custom field count

  // --- Phase 2: Deterministic Mappings ---
  // Fields that map 1:1 for ALL connectors in this category
  // Applied BEFORE LLM, no user review needed
  deterministicMappings: DeterministicMapping[];

  // --- Phase 4: Vocabulary Hints ---
  // Few-shot examples for vocabulary generation LLM
  vocabularyExamples: VocabularyExample[];

  // --- Phase 4: Critical Field Hints ---
  // Fields that are ALWAYS critical for this category
  alwaysCriticalFields: string[];

  // --- LLM Prompt Context ---
  // Domain description injected into all LLM prompts
  domainDescription: string;
}

interface DeterministicMapping {
  canonicalField: string; // e.g., 'title'
  sourcePaths: string[]; // e.g., ['itemName', 'name'] — first match wins
  transform: { type: string }; // e.g., { type: 'direct' }
  confidence: 1.0; // always 1.0 for deterministic
}

interface VocabularyExample {
  term: string;
  aliases: string[];
  fieldRef: string;
  description: string;
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
}
```

### 4.2 SharePoint Profile (Example)

```typescript
const SHAREPOINT_PROFILE: ConnectorTypeProfile = {
  category: 'file_storage',
  label: 'SharePoint',
  connectors: ['sharepoint'], // FIX: register actual connectorType slug

  fieldPatterns: {
    title: ['sharepoint.itemName', 'name', 'title'],
    author: ['sharepoint.createdBy', 'createdBy', 'creator'],
    modified_by: ['sharepoint.lastModifiedBy', 'lastModifiedBy'],
    source_url: ['sharepoint.itemWebUrl', 'webUrl', 'url'],
    created_date: ['createdAt', 'createdDateTime'],
    modified_date: ['modifiedAt', 'lastModifiedDateTime'],
    mime_type: ['contentType', 'file.mimeType'],
    parent_id: ['sharepoint.driveId'],
    folder_path: ['folderPath', 'sharepoint.parentPath'],
    department: ['sharepoint.siteName'],
    category: ['sharepoint.driveName'],
    access_level: ['sharepoint.siteUrl'],
  },
  relevantFields: [
    'title',
    'author',
    'modified_by',
    'source_url',
    'created_date',
    'modified_date',
    'mime_type',
    'parent_id',
    'folder_path',
    'department',
    'category',
  ],
  expectedCustomFields: 2,

  deterministicMappings: [
    // These are always correct for SharePoint — no LLM needed
    {
      canonicalField: 'title',
      sourcePaths: ['sharepoint.itemName'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'author',
      sourcePaths: ['sharepoint.createdBy'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'source_url',
      sourcePaths: ['sharepoint.itemWebUrl'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'folder_path',
      sourcePaths: ['folderPath'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'mime_type',
      sourcePaths: ['contentType'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'department',
      sourcePaths: ['sharepoint.siteName'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
    {
      canonicalField: 'category',
      sourcePaths: ['sharepoint.driveName'],
      transform: { type: 'direct' },
      confidence: 1.0,
    },
  ],

  vocabularyExamples: [
    {
      term: 'site',
      aliases: ['sharepoint site', 'team site', 'site collection'],
      fieldRef: 'department',
      description: 'The SharePoint site where the document is stored',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: true },
    },
    {
      term: 'library',
      aliases: ['document library', 'drive', 'folder'],
      fieldRef: 'category',
      description: 'The document library containing the file',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: true },
    },
    {
      term: 'author',
      aliases: ['created by', 'creator', 'uploader', 'owner'],
      fieldRef: 'author',
      description: 'Person who created or uploaded the document',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: true },
    },
    {
      term: 'document type',
      aliases: ['file type', 'format', 'extension', 'mime type'],
      fieldRef: 'mime_type',
      description: 'File format (PDF, Word, Excel, etc.)',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: false },
    },
  ],

  alwaysCriticalFields: [
    'title',
    'author',
    'mime_type',
    'department',
    'category',
    'created_date',
    'modified_date',
    'folder_path',
  ],

  domainDescription: `SharePoint is a document management platform. Documents are organized
    into Sites (team sites, communication sites) → Libraries (document libraries) → Folders → Files.
    Key dimensions: site name, library name, file type, author, folder path, dates.
    Users typically search by: "documents in the Engineering site", "PDFs uploaded by Alice",
    "files modified this week in Shared Documents library".`,
};
```

### 4.3 How LLM Prompts Adapt Per Connector

Every LLM call in the pipeline receives the profile's `domainDescription` and connector-specific examples:

| Phase                             | LLM Call                  | What Profile Provides                                                |
| --------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| Phase 2: MappingSuggestionService | Suggest field mappings    | `fieldPatterns` (narrow search space), `domainDescription` (context) |
| Phase 4: CriticalFieldDetection   | Identify important fields | `alwaysCriticalFields` (seed list), `domainDescription` (context)    |
| Phase 4: VocabularyGeneration     | Generate terms + aliases  | `vocabularyExamples` (few-shot), `domainDescription` (context)       |
| Query Stage 2: VocabularyResolver | Extract intent from NL    | `domainDescription` injected into system prompt via DomainVocabulary |

---

## 5. Design: Missing Wiring

### 5.1 Phase 1 Gap: SharePoint Schema Discovery

**Current:** Schema discovery exists for Jira/Salesforce/HubSpot/GDrive but NOT SharePoint.

**Design:** SharePoint doesn't need API introspection — its metadata schema is fixed and known at connector registration time. Add a `StaticSchemaPublisher` that publishes the known SharePoint fields to `ConnectorSchema` from the profile:

```
Connector Registration
    │
    ▼
Is schema static? ──yes──▶ StaticSchemaPublisher
(file_storage,             publishes profile fields
 document_page)            to ConnectorSchema
    │
    no
    │
    ▼
Dynamic Schema Discovery
(Jira, Salesforce, etc.)
```

**SharePoint fields to publish:**

| Source Path                 | Type   | Sample Values                                      |
| --------------------------- | ------ | -------------------------------------------------- |
| `sharepoint.siteName`       | string | "Engineering", "Sales", "HR"                       |
| `sharepoint.siteUrl`        | string | "https://contoso.sharepoint.com/sites/engineering" |
| `sharepoint.driveName`      | string | "Documents", "Shared Documents"                    |
| `sharepoint.itemName`       | string | "quarterly-report.pdf"                             |
| `sharepoint.itemWebUrl`     | string | "https://..."                                      |
| `sharepoint.createdBy`      | string | "Alice Smith"                                      |
| `sharepoint.lastModifiedBy` | string | "Bob Johnson"                                      |
| `sharepoint.parentPath`     | string | "/drive/root:/reports"                             |
| `contentType`               | string | "application/pdf", "text/html"                     |
| `sizeBytes`                 | number | 1024, 2048000                                      |

### 5.2 Phase 2 Gap: Deterministic Auto-Mapping

**Current:** All field mappings go through LLM suggestion → user review. Even obvious mappings like `sharepoint.itemName → title`.

**Design:** Split field mapping into two tiers:

```
Tier 1: Deterministic (from profile.deterministicMappings)
  - Applied automatically during connector setup
  - FieldMapping created with status: 'confirmed', confidence: 1.0
  - No LLM call, no user review needed
  - Covers 7-10 obvious fields per connector

Tier 2: LLM-Suggested (existing MappingSuggestionService)
  - Runs AFTER deterministic mappings
  - Only for fields NOT already mapped
  - LLM gets profile.fieldPatterns + domainDescription
  - FieldMapping created with status: 'suggested'
  - User reviews in Studio Fields Tab
```

### 5.3 Phase 4 Gap: Vocabulary Generation Trigger

**Current:** VocabularyGenerationWorker exists but is never enqueued.

**Design:** Wire vocabulary generation into the connector setup flow:

```
User confirms field mappings in Studio
    │
    ▼
POST /api/connectors/:id/mappings/confirm
    │
    ▼
Build CanonicalSchema from confirmed FieldMappings
    │
    ▼
Enqueue vocabulary-generation job with:
  { connectorId, projectKbId, tenantId, connectorType, indexId }
    │
    ▼
VocabularyGenerationWorker runs:
  1. Load profile for connectorType
  2. Use profile.alwaysCriticalFields as seed
     (skip CriticalFieldDetection LLM call for seeded fields)
  3. Run CriticalFieldDetection only for remaining custom fields
  4. Generate vocabulary using profile.vocabularyExamples as few-shot
  5. Save DomainVocabulary
    │
    ▼
Emit Redis pub/sub: vocabulary-updated:{indexId}
    │
    ▼
AliasResolver + VocabularyResolver invalidate caches
```

### 5.4 Phase 4 Gap: `loadDiscoveredSchema()` Stub

**Current:** `CriticalFieldDetectionService.loadDiscoveredSchema()` returns empty array.

**Design:** Connect it to the `ConnectorSchema` collection:

```typescript
async loadDiscoveredSchema(projectKbId: string, tenantId: string): Promise<DiscoveredField[]> {
  // Load confirmed FieldMappings for this KB
  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId: projectKbId, tenantId, status: 'active'
  });
  if (!schema) return [];

  // Return mapped fields with their alias names and types
  return schema.fields.map(f => ({
    fieldName: f.name,          // alias
    storageField: f.storageField,
    type: f.type,
    enumValues: f.enumValues,
    filterable: f.filterable,
    sortable: f.sortable,
  }));
}
```

---

## 6. Design: Enum Discovery for File-Based Connectors

Issue/ticket connectors (Jira, ServiceNow) have well-defined enums from their APIs (status values, priority levels). File-based connectors like SharePoint don't — their "enums" emerge from the data.

### 6.1 Known Enums (from connector profile)

Some SharePoint enums are universally known:

| Field                     | Known Values                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contentType` (mime_type) | `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `text/html`, `image/jpeg`, `image/png` |
| Content category          | `files`, `pages`                                                                                                                                                 |

These should be populated in `CanonicalSchema.fields[].enumValues` at schema build time from the profile.

### 6.2 Discovered Enums (post-ingestion)

After initial sync completes, scan indexed data to discover actual enum distributions:

```
After first full sync completes
    │
    ▼
Enqueue enum-discovery job
    │
    ▼
For each canonical field with type 'string':
  Run aggregation on OpenSearch:
    GET /{index}/_search { aggs: { field_values: { terms: { field: "canonical.{field}", size: 50 } } } }
    │
    ▼
  If cardinality < 30:
    → Field is enum-like
    → Update CanonicalSchema.fields[].enumValues
    → Update DomainVocabulary entry with discovered values
    │
    ▼
Emit Redis pub/sub for cache invalidation
```

This makes vocabulary resolution rich for queries like:

- "documents from the Engineering site" → `department = "Engineering"` (discovered enum)
- "PDF files" → `mime_type = "application/pdf"` (known enum)

---

## 7. End-to-End Flow: SharePoint Connector Setup → First Query

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. CONNECTOR REGISTRATION                                           │
│                                                                      │
│  User adds SharePoint connector in Studio                           │
│  → ConnectorConfig created (tenantId, sourceId, oauthTokenId)       │
│  → getProfile('sharepoint') returns SHAREPOINT_PROFILE              │
│  → StaticSchemaPublisher writes 10 fields to ConnectorSchema        │
│  → DeterministicMapper creates 7 confirmed FieldMappings            │
│  → MappingSuggestionService suggests 2-3 custom field mappings      │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. USER REVIEW (Studio Fields Tab)                                  │
│                                                                      │
│  My Fields (7): title, author, source_url, folder_path,             │
│                 mime_type, department (site), category (library)     │
│  Suggested (2): modified_by, parent_id (from LLM)                   │
│  Unmapped: custom_string_1..20 available                            │
│                                                                      │
│  User confirms/edits → all 9 FieldMappings now status: 'confirmed' │
│  User can rename aliases: "department" → "site name"                │
│  User can add enum values for mime_type                             │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. CANONICAL SCHEMA BUILD                                            │
│                                                                      │
│  Build CanonicalSchema from confirmed FieldMappings:                │
│  fields: [                                                           │
│    { name: "title",     storageField: "title",     type: "string" } │
│    { name: "author",    storageField: "author",    type: "string" } │
│    { name: "site name", storageField: "department", type: "string" }│
│    { name: "library",   storageField: "category",  type: "string" } │
│    { name: "file type", storageField: "mime_type",  type: "string", │
│      enumValues: { "PDF": "application/pdf", ... } }                │
│    ...                                                               │
│  ]                                                                   │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. VOCABULARY GENERATION                                             │
│                                                                      │
│  Enqueue vocabulary-generation job                                   │
│  Worker loads SHAREPOINT_PROFILE:                                    │
│    - Seeds critical fields from profile.alwaysCriticalFields        │
│    - Uses profile.vocabularyExamples as few-shot for LLM            │
│    - Uses profile.domainDescription as system prompt context         │
│  Generates 10-12 DomainVocabulary entries:                          │
│    { term: "site", aliases: ["team site"], fieldRef: "site name",   │
│      capabilities: { canFilter: true, canAggregate: true, ... } }   │
│    { term: "author", aliases: ["creator", "uploaded by"], ... }     │
│    { term: "file type", aliases: ["format", "extension"], ... }     │
│                                                                      │
│  Emit Redis pub/sub: vocabulary-updated:{indexId}                   │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. FIRST SYNC                                                        │
│                                                                      │
│  SharePoint connector syncs 500 documents                           │
│  Each document → CanonicalMapperWorker applies FieldMappings:       │
│    sourceMetadata.sharepoint.itemName → canonical.title             │
│    sourceMetadata.sharepoint.createdBy → canonical.author           │
│    sourceMetadata.sharepoint.siteName → canonical.department        │
│    ...                                                               │
│  SearchChunks indexed with canonicalMetadata populated              │
│                                                                      │
│  After sync: Enqueue enum-discovery job                             │
│    Discovers: department has 5 unique sites                         │
│    Discovers: category has 12 unique libraries                      │
│    Updates CanonicalSchema.enumValues + DomainVocabulary             │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. FIRST QUERY                                                       │
│                                                                      │
│  User: "PDF documents from Engineering site uploaded by Alice"       │
│                                                                      │
│  Stage 0: Permission filter (pass)                                  │
│  Stage 1: Preprocessing (spelling OK)                               │
│  Stage 2: Vocabulary Resolution (LLM)                               │
│    DomainVocabulary loaded → LLM prompt includes:                   │
│      - "site" (aliases: team site) → field: "site name"             │
│      - "file type" (aliases: format) → field: "file type"           │
│      - "author" (aliases: creator) → field: "author"               │
│    LLM extracts:                                                     │
│      semantic: "documents"                                           │
│      filters: [                                                      │
│        { field: "file type", op: "eq", value: "PDF" },              │
│        { field: "site name", op: "eq", value: "Engineering" },      │
│        { field: "author", op: "eq", value: "Alice" }                │
│      ]                                                               │
│      queryType: "hybrid"                                             │
│                                                                      │
│  Stage 2.5: Alias Resolution                                        │
│    "file type" → storageField: "mime_type"                          │
│      enumCoerce: "PDF" → "application/pdf"                          │
│    "site name" → storageField: "department"                         │
│      value: "Engineering" (pass-through, matches discovered enum)   │
│    "author" → storageField: "author"                                │
│      value: "Alice" (partial match → prefix query)                  │
│    Resolved filters:                                                 │
│      { field: "metadata.canonical.mime_type", value: "application/pdf" } │
│      { field: "metadata.canonical.department", value: "Engineering" }│
│      { field: "metadata.canonical.author", value: "Alice*" }        │
│                                                                      │
│  Stage 3: Build hybrid query (semantic "documents" + 3 filters)     │
│  Stage 4: Rerank results                                            │
│  Stage 5: Return 10 results                                         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. Implementation Plan

### Phase A: Fix Template Lookup + Add SharePoint Profile (Small, unblocks everything)

| Task                                               | Effort | Files                                 |
| -------------------------------------------------- | ------ | ------------------------------------- |
| Add `'sharepoint'` to FILE_STORAGE connectors list | XS     | `connector-type-templates.ts`         |
| Add SharePoint vocabulary examples to worker       | S      | `vocabulary-generation-worker.ts`     |
| Add SharePoint critical field hints                | S      | `critical-field-detection.service.ts` |
| Extend template interface with new profile fields  | M      | `connector-type-templates.ts`         |

### Phase B: Wire Vocabulary Generation (Medium, completes the pipeline)

| Task                                                         | Effort | Files                                    |
| ------------------------------------------------------------ | ------ | ---------------------------------------- |
| Trigger vocabulary generation on mapping confirmation        | M      | `connector.service.ts` or mapping routes |
| Implement `loadDiscoveredSchema()` in CriticalFieldDetection | S      | `critical-field-detection.service.ts`    |
| Add Redis pub/sub emit after vocabulary save                 | S      | `vocabulary-generation-worker.ts`        |

### Phase C: Deterministic Auto-Mapping (Medium, reduces LLM dependency)

| Task                                                    | Effort | Files                               |
| ------------------------------------------------------- | ------ | ----------------------------------- |
| Add `deterministicMappings` to profile interface        | S      | `connector-type-templates.ts`       |
| Create `DeterministicMapper` service                    | M      | New service in `canonical-mapping/` |
| Wire into connector setup flow (before LLM suggestions) | M      | `connector.service.ts`              |
| SharePoint deterministic mappings (7 fields)            | S      | Profile definition                  |

### Phase D: Enum Discovery (Medium, improves query quality)

| Task                                                | Effort | Files                      |
| --------------------------------------------------- | ------ | -------------------------- |
| Create `EnumDiscoveryWorker`                        | M      | New worker                 |
| Trigger after first full sync                       | S      | `connector-sync-worker.ts` |
| Update CanonicalSchema.enumValues from aggregations | M      | Service + worker           |
| Update DomainVocabulary with discovered values      | S      | Worker                     |

### Phase E: Profiles for Other Connectors (Ongoing)

| Connector    | Category      | Deterministic Fields | Custom Fields |
| ------------ | ------------- | -------------------- | ------------- |
| SharePoint   | file_storage  | 7                    | 2-3           |
| Google Drive | file_storage  | 6                    | 1-2           |
| Jira         | issue_ticket  | 10                   | 3-5           |
| Confluence   | document_page | 6                    | 2-3           |
| Salesforce   | crm           | 8                    | 5-10          |
| ServiceNow   | incident      | 8                    | 3-5           |

---

## 9. Design Decisions

| Decision                                                    | Rationale                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unified profile, not scattered templates**                | Single source of truth per connector category eliminates inconsistency between mapping, vocabulary, and critical field services                                                          |
| **Deterministic before LLM**                                | 70% of field mappings are obvious. Don't waste LLM tokens and user review time on `itemName → title`                                                                                     |
| **Profile is code, not DB**                                 | Profiles are engineering artifacts (versioned, reviewed). They don't change per-tenant. Only the resulting FieldMappings/CanonicalSchema/Vocabulary are per-tenant in DB                 |
| **Vocabulary generation triggered by mapping confirmation** | This is the natural point: user has reviewed fields, schema is known, vocabulary can be generated accurately                                                                             |
| **Enum discovery post-ingestion**                           | File-based connectors don't have API-enumerable values. We discover them from actual data after first sync                                                                               |
| **domainDescription in LLM prompts**                        | Every LLM call gets connector context. SharePoint LLM knows about sites/libraries/folders. Jira LLM knows about sprints/epics/story points. No more Jira examples for SharePoint queries |

---

## 10. Non-Goals

- **Dynamic schema expansion** — The 75-field fixed schema is a hard design constraint. This design works within it.
- **Real-time enum updates** — Enum discovery runs after full sync, not per-document. TTL-based cache handles staleness.
- **Automatic vocabulary for all connectors** — Focus on connectors with profiles first. Generic fallback (LLM-only) remains for uncategorized connectors.
- **UI changes** — Studio Fields Tab already supports the review workflow. No UI changes needed for Phase A-C.
