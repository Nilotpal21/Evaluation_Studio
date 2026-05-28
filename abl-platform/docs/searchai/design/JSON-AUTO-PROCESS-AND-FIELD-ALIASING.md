# JSON Auto-Process API & Field Alias Resolution

## Overview

JSON files uploaded via API are auto-processed without requiring UI field selection. Field mappings use `sourceConnectorField` for alias resolution, enabling users to filter by their original field names (e.g., `brand`, `rate`) even when mapped to canonical slots (`category`, `custom_string_2`).

## Quick Start — 3 Curls to Ingest with Custom Mappings

### 1. Preview fields (discover what's in your JSON)

```bash
curl -X POST "http://localhost:3005/api/indexes/<indexId>/json-schema-preview" -H "Content-Type: application/json" -H "x-tenant-id: <tenantId>" -d '{"sampleData":[{"productname":"Shirt","rate":"6200","color":"black","content":"description here"}]}'
```

Returns detected fields, types, sample values, auto-suggested canonical mappings, and all 78 available canonical fields you can map to.

### 2. Save mappings (decide what maps where)

```bash
curl -X PUT "http://localhost:3005/api/indexes/<indexId>/json-field-config" -H "Content-Type: application/json" -H "x-tenant-id: <tenantId>" -d '{"fields":[{"fieldPath":"productname","fieldType":"string","selected":true,"mappingOverride":"title"},{"fieldPath":"rate","fieldType":"string","selected":true,"mappingOverride":"custom_string_2"},{"fieldPath":"color","fieldType":"string","selected":true,"mappingOverride":"custom_string_1"},{"fieldPath":"content","fieldType":"string","selected":true,"canonicalMapping":"content_summary"}]}'
```

- `mappingOverride` — user explicitly chooses the canonical field
- `canonicalMapping` — accept the auto-suggestion
- `selected: false` — exclude field from indexing

### 3. Upload JSON (processes with mappings applied)

```bash
curl -X POST "http://localhost:3005/api/indexes/<indexId>/sources/<sourceId>/documents" -H "x-tenant-id: <tenantId>" -F "file=@data.json"
```

Config exists + fields match → processes immediately with canonical metadata on every chunk.

**All subsequent uploads of same-shaped JSON = just this 1 curl. Mappings reused automatically.**

### Bonus: Search with filter by original field name

```bash
curl -X POST "http://localhost:3005/api/search-ai-runtime/search/<indexId>/query" -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -H "X-Tenant-Id: <tenantId>" -d '{"query":"*","queryType":"hybrid","topK":10,"filters":[{"field":"rate","operator":"eq","value":"6200"}]}'
```

Filtering by `rate`, `Rate`, or `custom_string_2` all return the same results.

---

## Architecture

### Upload Flows

```
┌─────────────────────────────────────────────────────────────────────┐
│                        API Upload (Default)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  POST /documents ──► No field config? ──► Auto-detect all fields    │
│                      │                    Save jsonFieldConfig        │
│                      │                    Enqueue chunking            │
│                      │                                               │
│                      ► Config exists? ──► Fields match? ──► Process  │
│                                          │                 (with     │
│                                          │                 resolved  │
│                                          │                 mappings) │
│                                          │                           │
│                                          ► New fields? ──► Pause     │
│                                            (pending_field_selection)  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     UI Upload (?autoProcess=false)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  POST /documents?autoProcess=false                                   │
│       │                                                              │
│       ► No config? ──► pending_field_selection (show dialog)         │
│       ► Config exists + fields match? ──► Process immediately        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  Preview → Configure → Upload                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. POST /json-schema-preview   ──► Returns fields + suggestions     │
│     (sampleData or file)             + availableCanonicalFields       │
│                                                                      │
│  2. PUT /json-field-config      ──► User saves selections/overrides  │
│     (fields + mappingOverride)       Creates CanonicalSchema fields   │
│                                      Creates FieldMappings            │
│                                      Processes pending docs           │
│                                                                      │
│  3. POST /documents             ──► Auto-processes (config exists)    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Field Alias Resolution (Query Time)

```
User Query: filter by "rate" = 6200
                │
                ▼
┌──────────────────────────────┐
│     Alias Resolver           │
│     (search-ai-runtime)      │
├──────────────────────────────┤
│                              │
│  1. byAlias("rate")    miss  │
│  2. byStorageField("rate")   │
│     miss                     │
│  3. bySourceField("rate")    │
│     HIT → storageField:     │
│          "custom_string_2"   │
│                              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  OpenSearch filter:          │
│  metadata.canonical          │
│    .custom_string_2 = "6200" │
└──────────────────────────────┘
```

### CanonicalSchema Field Structure

```json
{
  "name": "Rate", // alias (source field humanized)
  "label": "Rate", // display label in UI
  "storageField": "custom_string_2", // actual OpenSearch field
  "sourceConnectorField": "rate", // original source field (alias resolver key)
  "filterable": true,
  "type": "keyword"
}
```

## API Reference

### 1. Create Knowledge Base

```bash
curl -X POST http://localhost:3005/api/knowledge-bases \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-dev-001" \
  -d '{
    "projectId": "019d2921-a270-79a4-871e-654c2ab0bffe",
    "name": "My KB",
    "description": "Test knowledge base"
  }'
```

### 2. Create Source

```bash
curl -X POST http://localhost:3005/api/indexes/<indexId>/sources \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-dev-001" \
  -d '{"name": "API Upload", "sourceType": "manual"}'
```

### 3. Upload JSON (Auto-Process)

```bash
curl -X POST "http://localhost:3005/api/indexes/<indexId>/sources/<sourceId>/documents" \
  -H "x-tenant-id: tenant-dev-001" \
  -F "file=@data.json"
```

Returns `status: "pending"` → auto-processes all fields immediately.

### 4. Upload JSON (UI Path — Field Selection)

```bash
curl -X POST "http://localhost:3005/api/indexes/<indexId>/sources/<sourceId>/documents?autoProcess=false" \
  -H "x-tenant-id: tenant-dev-001" \
  -F "file=@data.json"
```

Returns `status: "pending_field_selection"` → waits for user to configure fields.

### 5. Preview Schema (Discover Fields)

```bash
curl -X POST "http://localhost:3005/api/indexes/019dfa28-fd10-779c-9f74-4cd8c8b6d4b7/json-schema-preview" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-dev-001" \
  -d '{
    "sampleData": [
      {"name": "Widget", "brand": "Nike", "price": 99.99, "status": "active"},
      {"name": "Gadget", "brand": "Adidas", "price": 149.99, "status": "sold"}
    ]
  }'
```

Response includes:

- `fields[]` — detected fields with types, samples, and auto-suggested mappings
- `availableCanonicalFields[]` — all 78 canonical fields user can map to

### 6. Get Current Field Config

```bash
curl http://localhost:3005/api/indexes/019dfa28-fd10-779c-9f74-4cd8c8b6d4b7/json-field-config \
  -H "x-tenant-id: tenant-dev-001"
```

### 7. Save Field Config with User Mappings

```bash
curl -X PUT "http://localhost:3005/api/indexes/019dfa28-fd10-779c-9f74-4cd8c8b6d4b7/json-field-config" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-dev-001" \
  -d '{
    "fields": [
      {"fieldPath": "name", "fieldType": "string", "selected": true, "canonicalMapping": "title"},
      {"fieldPath": "brand", "fieldType": "string", "selected": true, "mappingOverride": "category"},
      {"fieldPath": "price", "fieldType": "number", "selected": true, "mappingOverride": "custom_number_1"},
      {"fieldPath": "status", "fieldType": "string", "selected": true, "canonicalMapping": "status"}
    ]
  }'
```

Key fields:

- `canonicalMapping` — accept auto-suggested mapping
- `mappingOverride` — user explicitly overrides the suggestion

### 8. Search with Filter by Source Field Name

```bash
# Filter by original field name "rate" (resolves via sourceConnectorField)
curl -X POST "http://localhost:5173/api/search-ai-runtime/search/019dfa28-fd10-779c-9f74-4cd8c8b6d4b7/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-Id: tenant-dev-001" \
  -d '{
    "query": "*",
    "queryType": "hybrid",
    "topK": 10,
    "filters": [{"field": "rate", "operator": "eq", "value": "6200"}]
  }'

# Same result with capitalized name
curl -X POST ".../query" -d '{"filters": [{"field": "Rate", "operator": "eq", "value": "6200"}]}'

# Same result with canonical storage field
curl -X POST ".../query" -d '{"filters": [{"field": "custom_string_2", "operator": "eq", "value": "6200"}]}'
```

All three resolve to the same result.

## Field Mapping Scenarios

### Scenario 1: First Upload (No Config)

```
Upload JSON → No jsonFieldConfig exists
  → autoProcess=true (default for API)
  → Auto-detect all fields, save config
  → Enqueue chunking immediately
  → Status: "pending" → "indexed"
```

### Scenario 2: Subsequent Upload (Config Exists, Same Fields)

```
Upload JSON → jsonFieldConfig exists, all fields match
  → Rebuild resolvedMappings from stored canonicalMapping values
  → Pass resolvedMappings to chunking worker
  → Canonical metadata populated on each chunk
  → Status: "pending" → "indexed"
```

### Scenario 3: Upload with New Fields

```
Upload JSON → jsonFieldConfig exists, but new fields detected
  → Status: "pending_field_selection"
  → User must review and save updated config
```

### Scenario 4: User Override Mapping

```
User data: {"priority_level": "high", "brand": "Nike"}

Preview suggests:
  priority_level → custom_string_2 (no match)
  brand → custom_string_1 (no match)

User overrides:
  priority_level → priority (mappingOverride)
  brand → category (mappingOverride)

Result in CanonicalSchema:
  name: "Priority Level", storageField: "priority", sourceConnectorField: "priority_level"
  name: "Brand", storageField: "category", sourceConnectorField: "brand"

Filtering works with:
  filter: {field: "priority_level"} ✓ (via sourceConnectorField)
  filter: {field: "priority"} ✓ (via storageField)
  filter: {field: "brand"} ✓ (via sourceConnectorField)
  filter: {field: "category"} ✓ (via storageField)
```

## Test Curls (Existing KB)

Using KB `019dfa28-fd57-78d7-b318-c36aa3534a1f` / Index `019dfa28-fd10-779c-9f74-4cd8c8b6d4b7`:

```bash
# Get a fresh token
TOKEN=$(curl -s -X POST http://localhost:5173/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@kore.ai","name":"Developer"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

INDEX="019dfa28-fd10-779c-9f74-4cd8c8b6d4b7"
TENANT="tenant-dev-001"

# 1. Check current field config
curl -s "http://localhost:3005/api/indexes/${INDEX}/json-field-config" \
  -H "x-tenant-id: ${TENANT}" | python3 -m json.tool

# 2. Preview with sample data
curl -s -X POST "http://localhost:3005/api/indexes/${INDEX}/json-schema-preview" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: ${TENANT}" \
  -d '{"sampleData": [{"name":"Test","brand":"Nike","price":100}]}' | python3 -m json.tool

# 3. Filter by source field "rate"
curl -s -X POST "http://localhost:5173/api/search-ai-runtime/search/${INDEX}/query" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: ${TENANT}" \
  -d '{"query":"*","queryType":"hybrid","topK":10,"filters":[{"field":"rate","operator":"eq","value":"6200"}]}' | python3 -m json.tool

# 4. Filter by canonical field "custom_string_2" (same result)
curl -s -X POST "http://localhost:5173/api/search-ai-runtime/search/${INDEX}/query" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: ${TENANT}" \
  -d '{"query":"*","queryType":"hybrid","topK":10,"filters":[{"field":"custom_string_2","operator":"eq","value":"6200"}]}' | python3 -m json.tool

# 5. Filter by source field "productname"
curl -s -X POST "http://localhost:5173/api/search-ai-runtime/search/${INDEX}/query" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: ${TENANT}" \
  -d '{"query":"*","queryType":"hybrid","topK":10,"filters":[{"field":"productname","operator":"contains","value":"T-Shirt"}]}' | python3 -m json.tool

# 6. Filter by canonical "title" (same result as productname)
curl -s -X POST "http://localhost:5173/api/search-ai-runtime/search/${INDEX}/query" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: ${TENANT}" \
  -d '{"query":"*","queryType":"hybrid","topK":10,"filters":[{"field":"title","operator":"contains","value":"T-Shirt"}]}' | python3 -m json.tool
```

## Files Changed

| File                                             | Change                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/document-upload.ts`   | Rebuild resolvedMappings from stored canonicalMapping on subsequent uploads; include alias + synonyms for vocabulary                                |
| `apps/search-ai/src/routes/json-field-config.ts` | Fix fsPromises crash on preview; update canonical schema with sourceConnectorField + source name as alias; build synonyms with canonical field name |

## Related

- PR #878: Alias resolver indexes by `sourceConnectorField` (already merged)
- `apps/search-ai-runtime/src/services/alias/alias-resolver.ts`: `bySourceField` map
