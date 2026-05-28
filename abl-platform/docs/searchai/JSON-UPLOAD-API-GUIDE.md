# JSON Upload API — Field Config, Mappings & Vocabulary

## Overview

When a user uploads a JSON file to a Knowledge Base, the system automatically:

1. **Detects fields** — parses the JSON, extracts all field paths and types
2. **Creates mappings** — maps source fields to canonical slots (title, category, custom_string_1, etc.)
3. **Generates vocabulary** — 1 entry per mapped field for filter resolution
4. **Populates canonical metadata** — chunks get structured metadata for filtering

All of this happens **automatically** on upload. No manual steps required.

---

## Authentication

All APIs support two auth methods:

| Method        | Header                            | Use Case                            |
| ------------- | --------------------------------- | ----------------------------------- |
| **JWT Token** | `Authorization: Bearer <jwt>`     | Interactive users (Studio, Postman) |
| **API Key**   | `Authorization: Bearer abl_<key>` | Scripts, automation, bulk uploads   |

API key requires `search.ingest` scope (grants `knowledge_base:read` + `document:write`).

---

## Three Usage Scenarios

### Scenario 1: Fully Automatic (recommended for scripts/bulk)

Upload JSON directly — fields, mappings, vocabulary all auto-created on first upload.

```
┌─────────────────────────────────────────────────────────┐
│  POST /documents (file=sample.json)                     │
│    → Detect fields (34 fields)                          │
│    → Run mapping pipeline (rule-based + LLM)            │
│    → Create CanonicalSchema + FieldMappings             │
│    → Generate DomainVocabulary (1 entry per field)      │
│    → Queue for chunking with canonical metadata         │
└─────────────────────────────────────────────────────────┘
```

**Curl:**

```bash
curl -X POST http://localhost:3005/api/indexes/{indexId}/documents \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/data.json"
```

**Behavior on subsequent uploads:**

| Condition                      | Action                                |
| ------------------------------ | ------------------------------------- |
| Same fields as existing config | Skip auto-config, use existing (fast) |
| New fields detected            | Extend config with only new fields    |
| Config already exists          | Never recreates, never overwrites     |

---

### Scenario 2: Auto then Modify

Upload first (auto-config created), then modify mappings, then upload more files.

```
┌──────────────────────────────────────┐
│  Step 1: POST /documents             │  ← auto-creates config
│  Step 2: PUT /json-field-config      │  ← user modifies mappings
│  Step 3: POST /documents             │  ← uses modified config
└──────────────────────────────────────┘
```

**Step 1 — Upload (auto-config created):**

```bash
curl -X POST http://localhost:3005/api/indexes/{indexId}/documents \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/data.json"
```

**Step 2 — Modify config:**

```bash
curl -X PUT http://localhost:3005/api/indexes/{indexId}/json-field-config \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": [
      {"fieldPath": "brand", "fieldType": "string", "selected": true, "canonicalMapping": "category"},
      {"fieldPath": "matCode", "fieldType": "string", "selected": false},
      {"fieldPath": "model", "fieldType": "string", "selected": true},
      {"fieldPath": "basePrice", "fieldType": "number", "selected": true},
      ... (include ALL fields, not just changed ones)
    ]
  }'
```

> **IMPORTANT:** PUT replaces the entire config. Send ALL fields — not just the ones you changed. Fields you don't include will be removed from the config.

**Step 3 — Upload more files (uses modified config):**

```bash
curl -X POST http://localhost:3005/api/indexes/{indexId}/documents \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/more-data.json"
```

---

### Scenario 3: Preview then Upload

User reviews fields before any data processing. Maximum control.

```
┌──────────────────────────────────────────────┐
│  Step 1: POST /json-schema-preview           │  ← see detected fields (nothing saved)
│  Step 2: POST /json-schema-preview?autoSave  │  ← save config + mappings + vocab
│  Step 3: POST /documents                     │  ← upload files (uses saved config)
└──────────────────────────────────────────────┘
```

**Step 1 — Preview fields (read-only, nothing saved):**

```bash
curl -X POST http://localhost:3005/api/indexes/{indexId}/json-schema-preview \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/sample.json"
```

Response shows detected fields with types, sample values, and suggested mappings.

**Step 2 — Save config (accept auto-suggestions):**

```bash
curl -X POST "http://localhost:3005/api/indexes/{indexId}/json-schema-preview?autoSave=true" \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/sample.json"
```

Creates: jsonFieldConfig + CanonicalSchema + FieldMappings + DomainVocabulary.

**Step 3 — Upload actual files:**

```bash
curl -X POST http://localhost:3005/api/indexes/{indexId}/documents \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/data.json"
```

**Variant — Preview + Manual Modify + Upload:**

If user wants to review AND change mappings before uploading:

```bash
# Preview
POST /json-schema-preview → see fields

# Modify and save
PUT /json-field-config → save with custom mappings

# Upload
POST /documents → upload files
```

---

## Comparison: When to Use Each Scenario

| Scenario                    | Best For                          | User Control      | Steps |
| --------------------------- | --------------------------------- | ----------------- | ----- |
| **1 — Fully Automatic**     | Scripts, bulk uploads, automation | None (trust auto) | 1     |
| **2 — Auto then Modify**    | Upload first, tweak later         | Medium            | 3     |
| **3 — Preview then Upload** | Review before any processing      | Maximum           | 3     |

---

## How Filters Work After Upload

Once canonical metadata is on chunks, you can filter in search queries:

**Filter by alias name (resolved via vocabulary):**

```bash
curl -X POST http://localhost:3005/api/search/{indexId}/query \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "phone",
    "queryType": "hybrid",
    "topK": 10,
    "filters": [{"field": "brand", "operator": "eq", "value": "VIVO"}]
  }'
```

**Filter by canonical field name directly:**

```bash
{
  "query": "phone",
  "filters": [{"field": "custom_string_2", "operator": "eq", "value": "VIVO"}]
}
```

**Supported operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`

---

## Bulk Upload Behavior

For 400 files with same schema:

```
File 1:   No config → auto-creates (slight delay ~1-2s)
File 2:   Config exists, same fields → SKIP auto-config → chunk directly
File 3:   SKIP → chunk directly
...
File 400: SKIP → chunk directly
```

For files with different/evolving schemas:

```
File 1:   {brand, model, price}     → Creates config (3 fields)
File 50:  {brand, model, price}     → Same fields → SKIP
File 51:  {brand, model, discount}  → NEW field "discount" → EXTEND (adds only "discount")
File 100: {brand, model, discount}  → All known → SKIP
```

Key guarantees:

- **Idempotent** — same fields = no work done
- **Additive only** — extend never removes or overwrites existing mappings
- **Non-blocking** — auto-config failure is non-fatal (logged, upload continues)
- **No duplicate slots** — new fields assigned to next available custom_string_N

---

## API Reference

### POST /api/indexes/:indexId/documents

Upload a file to the knowledge base.

| Parameter | Type               | Required | Description                                                |
| --------- | ------------------ | -------- | ---------------------------------------------------------- |
| file      | File (form-data)   | Yes      | JSON file to upload                                        |
| force     | string (form-data) | No       | "true" to replace existing document with same content hash |

### POST /api/indexes/:indexId/json-schema-preview

Preview fields from a sample JSON file without saving.

| Parameter | Type             | Required | Description                                     |
| --------- | ---------------- | -------- | ----------------------------------------------- |
| file      | File (form-data) | Yes      | Sample JSON file                                |
| autoSave  | query param      | No       | "true" to save config + create mappings + vocab |

### PUT /api/indexes/:indexId/json-field-config

Modify the field configuration. Replaces entire config.

| Field                     | Type    | Description                                            |
| ------------------------- | ------- | ------------------------------------------------------ |
| fields[].fieldPath        | string  | Dot-notation path (e.g., "brand", "specs.battery")     |
| fields[].fieldType        | string  | "string", "number", "boolean", "date", "array"         |
| fields[].selected         | boolean | Whether to include this field in mappings              |
| fields[].canonicalMapping | string  | Override mapping (e.g., "category", "custom_string_5") |

---

## Architecture

```
Upload JSON
    │
    ▼
┌─────────────────────────────────┐
│  document-upload.ts             │
│  (auto-detect + auto-extend)   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  json-field-config-auto.ts      │
│  saveFieldConfigFromUpload()    │
│  extendFieldConfig()            │
└──────────────┬──────────────────┘
               │ delegates to
               ▼
┌─────────────────────────────────┐
│  json-field-config.ts           │
│  saveFieldConfigInternal()      │
│  - Saves jsonFieldConfig        │
│  - Creates CanonicalSchema      │
│  - Creates FieldMappings        │
│  - Generates DomainVocabulary   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  json-record-chunking worker    │
│  - Reads resolvedMappings       │
│  - Writes canonicalMetadata     │
│  - Indexes to OpenSearch        │
└─────────────────────────────────┘
```

---

## File Types

| File Type | Auto-config? | Filters?                 | What happens                                  |
| --------- | ------------ | ------------------------ | --------------------------------------------- |
| **JSON**  | Yes          | Yes (canonical metadata) | Fields → mappings → vocab → filterable chunks |
| **PDF**   | No           | No (unstructured text)   | Text extraction → chunking → embedding        |
| **DOCX**  | No           | No (unstructured text)   | Text extraction → chunking → embedding        |
| **HTML**  | No           | No (unstructured text)   | Text extraction → chunking → embedding        |

Only JSON files have structured fields that can be detected and mapped.
