# JSON Field Selection — High-Level Design

## What

When a user uploads a JSON file to a knowledge base, the system currently processes ALL fields blindly — embedding everything (including noise like IDs, URLs, timestamps) and relying on the LLM to guess which fields matter for filtering. This produces noisy embeddings and unreliable vocabulary.

This feature adds a **field selection step** after JSON upload: the system extracts the JSON schema, presents it to the user, and the user marks fields as "Important." Important fields drive both vocabulary (filtering/aggregation) and embedding (semantic search). The LLM still enriches selected fields with aliases/descriptions, but the user controls WHAT gets processed.

## Current Flow (Before)

```
JSON Upload → Parse → LLM guesses fields → Embed ALL fields → Vocab from LLM guesses
                              ↓
                    User has zero control
```

## New Flow (After)

```
JSON Upload → Parse first record → Extract schema
                                       ↓
                            ┌─────────────────────┐
                            │  Field Selection UI  │
                            │                      │
                            │  ☑ name      string  │
                            │  ☑ category  string  │
                            │  ☑ price     number  │
                            │  ☐ sku       string  │
                            │  ☐ url       string  │
                            │                      │
                            │  [Auto-suggest ON]   │
                            │  [Continue]           │
                            └─────────────────────┘
                                       ↓
              Store selections on SearchIndex.jsonFieldConfig
                                       ↓
              ┌────────────────────────┴────────────────────────┐
              ↓                                                 ↓
    Embedding: only selected                         Vocabulary: only selected
    string fields in chunk text                      fields get entries + LLM
    (numbers stored as metadata,                     enriches with aliases
    not embedded)
```

## Architecture Approach

### Packages Changed

| Package             | Change                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `apps/search-ai`    | New endpoint: `POST /indexes/:indexId/json-schema-preview` — parses JSON, returns schema |
| `apps/search-ai`    | Modified: `json-record-chunking-worker.ts` — respects field selections                   |
| `apps/studio`       | New component: `JsonFieldSelectionDialog.tsx` — field selection UI                       |
| `apps/studio`       | Modified: `FileUploadDialog.tsx` — intercepts JSON uploads, shows field selection        |
| `packages/database` | Modified: `search-index.model.ts` — add `jsonFieldConfig` schema                         |
| `packages/i18n`     | New i18n keys for field selection UI                                                     |

### Data Flow

```
                        Studio                              SearchAI
                          │                                    │
  1. User drops JSON ─────┤                                    │
                          │── POST /json-schema-preview ──────→│
                          │       (file in body)               │
                          │                                    │── Parse JSON
                          │                                    │── Extract keys from first 3 records
                          │                                    │── Infer types + sample values
                          │                                    │── Auto-suggest important fields
                          │←── { fields: [...], suggestions }──│
                          │                                    │
  2. User sees field      │                                    │
     selection dialog     │                                    │
     (pre-checked by      │                                    │
     auto-suggest)        │                                    │
                          │                                    │
  3. User confirms ───────┤                                    │
                          │── PUT /indexes/:id/json-field-config│
                          │       { selectedFields: [...] }    │
                          │                                    │── Save to SearchIndex.jsonFieldConfig
                          │←── 200 OK ─────────────────────────│
                          │                                    │
  4. Upload proceeds ─────┤                                    │
                          │── POST /upload (normal flow) ─────→│
                          │                                    │── json-record-chunking-worker
                          │                                    │   reads jsonFieldConfig
                          │                                    │   embeds only selected fields
                          │                                    │   creates vocab for selected fields
                          │                                    │   LLM enriches selected fields only
```

### Key Design Decisions

**1. LLM still enriches vocab — but only for selected fields**

- User selects `category` → LLM generates aliases like "product type", "classification"
- This gives best of both worlds: user control + LLM intelligence
- If no LLM available, vocabulary entries use raw field names (graceful degradation)

**2. Flat field list (no nested tree)**

- Nested paths shown as dot notation: `specifications.weight`, `dimensions.height`
- Max depth: 2 levels (deeper nesting flattened to `parent.child`)
- Keeps the UI simple — no tree widget needed

**3. Auto-suggest pre-checks likely important fields**

- Strings with short values (< 100 chars) + low apparent cardinality → pre-check
- Numbers → pre-check (good for filtering/sorting)
- Skip: fields named `id`, `_id`, `url`, `href`, `sku`, `uuid` (internal)
- Skip: long text fields (> 200 chars avg) — these are for full-text, not filtering
- User can override any suggestion

**4. Re-processing on field change**

- If user changes selections after initial upload → re-chunk + re-embed
- Implemented as: delete existing chunks for the document → re-run json-record-chunking
- Simple and correct, avoids partial update complexity

**5. Smart embedding based on field type**

- Selected **string** fields → included in chunk text for embedding
- Selected **number/date** fields → stored as `canonicalMetadata` for filtering, NOT embedded (numbers don't embed well semantically)
- This is automatic — user just checks "Important", system handles the rest

**6. Field config stored on SearchIndex (not per-document)**

- All JSON documents in the same KB share the same field config
- New uploads auto-use the existing config (no re-selection needed)
- User can update config from KB settings → triggers re-processing

### SearchIndex Schema Addition

```typescript
jsonFieldConfig?: {
  version: number;           // Increment on change (triggers re-processing)
  fields: Array<{
    fieldPath: string;       // "name", "price", "specs.weight"
    fieldType: string;       // "string", "number", "boolean", "date", "array"
    selected: boolean;       // User marked as important
    sampleValues: string[];  // For display in UI (from initial analysis)
  }>;
  autoSuggestApplied: boolean;  // Whether auto-suggest was used
  updatedAt: Date;
}
```

## Task Decomposition

| Task                                           | Package(s)          | Independent? | Est. Files |
| ---------------------------------------------- | ------------------- | ------------ | ---------- |
| T-1: Schema preview endpoint                   | search-ai           | Yes          | 2-3        |
| T-2: SearchIndex model + field config endpoint | search-ai, database | Yes          | 2-3        |
| T-3: Field selection UI component              | studio, i18n        | Yes          | 3-4        |
| T-4: Integrate into upload flow                | studio              | No (T-3)     | 2          |
| T-5: Worker uses field selections              | search-ai           | No (T-2)     | 2-3        |
| T-6: Re-processing on config change            | search-ai           | No (T-5)     | 1-2        |

## Out of Scope

- Nested JSON tree editor (flattened dot notation only)
- Per-document field overrides (config is per-KB)
- CSV/Excel field selection (future — same pattern but different parser)
- Custom embedding weights per field
- Field selection for connector-backed KBs (connectors have their own schema discovery)
