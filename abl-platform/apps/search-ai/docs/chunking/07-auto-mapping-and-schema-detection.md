# Auto-Mapping and Schema Detection

**Status:** ✅ Fully Implemented
**Last Updated:** 2026-02-24
**Applies To:** CSV, JSON (tabular), Excel files

---

## Table of Contents

1. [Overview](#overview)
2. [Two-Phase Ingestion Flow](#two-phase-ingestion-flow)
3. [Phase 1: Schema Detection](#phase-1-schema-detection)
4. [Phase 2: Schema Confirmation](#phase-2-schema-confirmation)
5. [Canonical Field Mapping System](#canonical-field-mapping-system)
6. [Transform Types](#transform-types)
7. [API Reference](#api-reference)
8. [Quality Assessment](#quality-assessment)
9. [Cost Estimation](#cost-estimation)
10. [Best Practices](#best-practices)

---

## Overview

The search-ai platform provides **automatic schema detection and field mapping** for structured data files (CSV, JSON, Excel). This eliminates manual schema definition and enables:

- **Automatic type inference** with confidence scoring
- **Smart recommendations** for embeddable and filterable columns
- **Two-phase ingestion** (analyze → confirm → ingest)
- **Canonical field mapping** for normalized metadata across data sources
- **Cost and quality estimation** before ingestion

**Key Benefits:**

- **Zero Configuration:** Upload → Auto-detect → Confirm → Done
- **Quality Validation:** Warnings for high null rates, low confidence types, missing embeddable columns
- **Cost Transparency:** Embedding token count, storage size, processing time estimated upfront
- **User Control:** Review and correct schema before committing to ingestion

---

## Two-Phase Ingestion Flow

```
┌──────────────┐
│ Upload File  │
│ (CSV/JSON/   │
│  Excel)      │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Phase 1: POST /:indexId/ingest/analyze         │
│                                                 │
│  - Parse file (CSV, JSON, Excel)                │
│  - Detect column types with confidence          │
│  - Identify primary/foreign keys                │
│  - Mark embeddable/filterable columns           │
│  - Calculate cost estimates                     │
│  - Generate quality warnings                    │
│  - Cache analysis (1 hour TTL)                  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
              ┌──────────────┐
              │ Return        │
              │ analysisId +  │
              │ schema +      │
              │ estimates +   │
              │ quality       │
              └──────┬────────┘
                     │
                     │ User reviews schema
                     │ Corrects types, labels, descriptions
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ Phase 2: POST /:indexId/ingest/finalize        │
│                                                 │
│  - Retrieve cached file + analysis              │
│  - Accept user-corrected schema                 │
│  - Create ClickHouse table                      │
│  - Enqueue async ingestion job                  │
│  - Return jobId for polling                     │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
              ┌──────────────┐
              │ Background   │
              │ Ingestion    │
              │ (Worker)     │
              └──────────────┘
```

**Why Two Phases?**

1. **User Validation:** Humans verify schema correctness before creating immutable data structures
2. **Cost Transparency:** Users see estimated cost/time before committing
3. **Error Prevention:** Catch type mismatches, missing keys, quality issues upfront
4. **Resource Efficiency:** Don't create chunks/embeddings for bad data

---

## Phase 1: Schema Detection

### Endpoint

```http
POST /api/:indexId/ingest/analyze
Content-Type: multipart/form-data

file: [CSV/JSON/Excel file]
metadata: {"description": "Q4 sales data"} (optional)
```

### Auto-Detection Capabilities

| Detection Type   | Supported Types                                   | Confidence Threshold | Fallback |
| ---------------- | ------------------------------------------------- | -------------------- | -------- |
| **Column Types** | integer, number, boolean, date, enum, string      | 90% match            | string   |
| **Primary Keys** | Columns named `id` or `*_id` with 100% uniqueness | N/A                  | null     |
| **Foreign Keys** | Naming convention: `user_id` → `users.id`         | 70%                  | (none)   |
| **Embeddable**   | Text columns with avg length > 10 chars           | N/A                  | false    |
| **Filterable**   | Enum, boolean, numeric, low-cardinality strings   | N/A                  | false    |

### Type Detection Algorithm

**Integer:**

- Pattern: `/^-?\d+$/` matches 90%+ of values
- Special case: Columns named `id` or `*_id` never marked as enum (even with low cardinality)
- Low cardinality check: If unique count < 50 AND < 50% unique, mark as `enum` instead

**Number (Decimal):**

- Pattern: `/^-?\d+\.\d+$/` OR `!isNaN(Number(value))` matches 90%+ of values
- Includes integers + decimals combined

**Boolean:**

- Pattern: `/^(true|false|yes|no|0|1)$/i` matches 90%+ of values

**Date:**

- ISO 8601: `/^\d{4}-\d{2}-\d{2}/`
- Common formats: `MM/DD/YYYY`, `DD-MM-YYYY`
- Date parsing: `!isNaN(new Date(str).getTime())`
- Requires 90%+ match

**Enum (Categorical):**

- Unique count < 50 AND unique ratio < 70%
- String or integer values with high repetition
- Example: `status` column with values [`active`, `inactive`, `pending`]

**String:**

- Default fallback for all non-matching values
- Confidence: 0.9 (always)

### Example Response

```json
{
  "analysisId": "a1b2c3d4-...",
  "schema": {
    "tableName": "sales_q4_2024",
    "rowCount": 100000,
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "nullable": false,
        "confidence": 1.0,
        "sampleValues": [1, 2, 3, 4, 5],
        "uniqueCount": 100000,
        "nullCount": 0,
        "isEmbeddable": false,
        "isFilterable": true
      },
      {
        "name": "product_name",
        "type": "string",
        "nullable": false,
        "confidence": 0.95,
        "sampleValues": ["Widget Pro", "Gadget Max", "..."],
        "uniqueCount": 5000,
        "nullCount": 0,
        "isEmbeddable": true,
        "isFilterable": false,
        "avgLength": 32
      },
      {
        "name": "category",
        "type": "enum",
        "nullable": false,
        "confidence": 0.92,
        "sampleValues": ["Electronics", "Furniture", "Clothing"],
        "uniqueCount": 12,
        "nullCount": 0,
        "isEmbeddable": false,
        "isFilterable": true,
        "enumValues": ["Electronics", "Furniture", "Clothing", "..."]
      },
      {
        "name": "description",
        "type": "string",
        "nullable": true,
        "confidence": 0.9,
        "sampleValues": ["High-performance widget with...", "..."],
        "uniqueCount": 98000,
        "nullCount": 2000,
        "isEmbeddable": true,
        "isFilterable": false,
        "avgLength": 156
      },
      {
        "name": "price",
        "type": "number",
        "nullable": false,
        "confidence": 1.0,
        "sampleValues": [29.99, 149.99, 89.5],
        "uniqueCount": 3000,
        "nullCount": 0,
        "isEmbeddable": false,
        "isFilterable": true
      },
      {
        "name": "sale_date",
        "type": "date",
        "nullable": false,
        "confidence": 0.98,
        "sampleValues": ["2024-10-01", "2024-10-02", "..."],
        "uniqueCount": 92,
        "nullCount": 0,
        "isEmbeddable": false,
        "isFilterable": true
      }
    ],
    "primaryKey": "id",
    "foreignKeys": [
      {
        "sourceField": "customer_id",
        "targetTable": "customers",
        "targetField": "id",
        "confidence": 0.7,
        "detectionMethod": "naming_convention"
      }
    ]
  },
  "estimates": {
    "embeddingTokens": 1250000,
    "embeddingCost": 0.025,
    "storageBytes": 45000000,
    "chunkCount": 100000,
    "processingTimeSeconds": 1000
  },
  "quality": {
    "overallConfidence": 0.95,
    "warnings": ["High null rate (>50%) in: optional_notes"],
    "recommendations": ["Review and correct column types before finalizing"]
  },
  "expiresAt": "2024-02-24T13:00:00.000Z"
}
```

### Embeddability Detection

**Marked as Embeddable:**

- Type: `string` or `enum`
- Average length > 10 characters
- Column name matches: `/(description|comment|note|text|content|summary)/i`
- NOT an ID column (`/^id$/i` or `/_id$/i`)

**Example Embeddable Columns:**

- `description` (avg length 156 chars)
- `product_name` (avg length 32 chars)
- `customer_notes` (avg length 85 chars)

**Example NON-Embeddable Columns:**

- `id` (integer, ID column)
- `status` (enum, avg length 6 chars)
- `sku` (string, avg length 8 chars)

**Why This Matters:**

- Only embeddable columns generate vector embeddings
- Reduces embedding cost by 70-90% compared to embedding all fields
- Semantic search only queries embeddable fields

### Filterability Detection

**Marked as Filterable:**

- Type: `integer`, `number`, `date` (always filterable)
- Type: `boolean`, `enum` (always filterable)
- Type: `string` with unique count < 100

**Example Filterable Columns:**

- `category` (enum: 12 unique values)
- `price` (number)
- `sale_date` (date)
- `in_stock` (boolean)
- `region` (string: 8 unique values)

**Why This Matters:**

- Filterable columns are indexed for faceted search
- Used in query filters: `WHERE category = 'Electronics' AND price < 100`
- High-cardinality strings (> 100 unique) are NOT indexed to save memory

---

## Phase 2: Schema Confirmation

### Endpoint

```http
POST /api/:indexId/ingest/finalize
Content-Type: application/json

{
  "analysisId": "a1b2c3d4-...",
  "schema": {
    "tableName": "sales_q4_2024",
    "displayName": "Q4 2024 Sales Data",
    "description": "Sales transactions for Q4 2024 with product details",
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "displayName": "Sale ID",
        "description": "Unique sale transaction identifier",
        "nullable": false,
        "isEmbeddable": false,
        "isFilterable": true
      },
      {
        "name": "description",
        "type": "string",
        "displayName": "Product Description",
        "description": "Detailed product description",
        "nullable": true,
        "isEmbeddable": true,
        "isFilterable": false
      }
    ],
    "primaryKey": "id"
  },
  "metadata": {
    "source": "ERP export",
    "exportedAt": "2024-02-24T12:00:00Z"
  }
}
```

### User Corrections

Users can correct the auto-detected schema:

**Type Corrections:**

```json
{
  "name": "zip_code",
  "type": "string", // Changed from "integer" to preserve leading zeros
  "nullable": false
}
```

**Embeddability Overrides:**

```json
{
  "name": "sku",
  "type": "string",
  "isEmbeddable": false // Override: SKUs shouldn't be embedded
}
```

**Display Labels:**

```json
{
  "name": "qty",
  "displayName": "Quantity",
  "description": "Number of units sold"
}
```

**Primary Key Selection:**

```json
{
  "primaryKey": "order_id" // Override: Use order_id instead of auto-detected id
}
```

### Response

```json
{
  "jobId": "structured-ingest:abc123",
  "status": "pending",
  "tableId": "abc123-def456",
  "createdAt": "2024-02-24T12:00:00Z",
  "estimatedCompletionSeconds": 1000
}
```

### Job Status Polling

```http
GET /api/:indexId/ingest/jobs/:jobId
```

```json
{
  "jobId": "structured-ingest:abc123",
  "status": "processing", // pending | processing | completed | failed
  "progress": 45, // 0-100
  "createdAt": "2024-02-24T12:00:00Z",
  "processedAt": "2024-02-24T12:00:05Z",
  "finishedAt": null,
  "failedReason": null
}
```

---

## Canonical Field Mapping System

The platform supports **3-layer schema normalization** for multi-source data integration:

### Architecture

```
┌─────────────────────────────────────────────────┐
│ Layer 1: ConnectorSchema                       │
│ - Raw schema from source connector              │
│ - Discovered via API introspection              │
│ - Version tracked (schema evolution)            │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ Layer 2: CanonicalSchema                       │
│ - Normalized field definitions                  │
│ - Knowledge base-scoped                         │
│ - Human-readable labels                         │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ Layer 3: FieldMapping                          │
│ - Source path → Canonical field mappings        │
│ - Transform definitions (lowercase, split, etc.)│
│ - Status: suggested → confirmed → applied       │
└─────────────────────────────────────────────────┘
```

### Use Case: Multi-Source Customer Data

**Scenario:** Ingest customer data from 3 sources (Salesforce, HubSpot, CSV export) into a unified knowledge base.

**Layer 1: ConnectorSchema (Raw Sources)**

| Source     | Field Path                 | Type   |
| ---------- | -------------------------- | ------ |
| Salesforce | `Contact.Email`            | string |
| HubSpot    | `contact.properties.email` | string |
| CSV Export | `customer_email`           | string |

**Layer 2: CanonicalSchema (Normalized)**

| Canonical Field | Type   | Label         | Description            |
| --------------- | ------ | ------------- | ---------------------- |
| `email`         | string | Email Address | Customer email address |

**Layer 3: FieldMapping (Mappings + Transforms)**

| Source     | Source Path                | Canonical Field | Transform | Status    |
| ---------- | -------------------------- | --------------- | --------- | --------- |
| Salesforce | `Contact.Email`            | `email`         | lowercase | confirmed |
| HubSpot    | `contact.properties.email` | `email`         | lowercase | confirmed |
| CSV Export | `customer_email`           | `email`         | lowercase | confirmed |

**Result:** All 3 sources materialized into `canonicalMetadata.email` on SearchChunk documents.

### Database Models

**ConnectorSchema:**

```typescript
{
  _id: string;
  tenantId: string;
  connectorId: string;
  version: number;
  fields: [
    {
      path: 'Contact.Email',
      label: 'Email',
      type: 'string',
      isCustom: false,
      isRequired: true,
      sampleValues: ['user@example.com'],
    },
  ];
  status: 'active';
}
```

**CanonicalSchema:**

```typescript
{
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  version: number;
  fields: [
    {
      name: 'email',
      label: 'Email Address',
      type: 'string',
      description: 'Customer email address',
      indexed: true,
      filterable: true,
      aggregatable: false,
    },
  ];
  status: 'active';
}
```

**FieldMapping:**

```typescript
{
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: "email",
  connectorId: "salesforce-123",
  sourcePath: "Contact.Email",
  transform: {
    type: "lowercase"
  },
  confidence: 0.95,
  status: "confirmed",
  suggestedBy: "llm",
  reviewedBy: "user@example.com",
  reviewedAt: "2024-02-24T12:00:00Z"
}
```

---

## Transform Types

FieldMapping transforms are applied at ingestion time to normalize source values.

### 1. Direct (Pass-Through)

**Usage:** Copy value as-is from source

```json
{
  "type": "direct"
}
```

**Example:**

- Source: `"John Doe"`
- Output: `"John Doe"`

---

### 2. Lowercase

**Usage:** Normalize text to lowercase for case-insensitive matching

```json
{
  "type": "lowercase"
}
```

**Example:**

- Source: `"Admin"`
- Output: `"admin"`

---

### 3. Split

**Usage:** Split delimited string into array

```json
{
  "type": "split",
  "delimiter": ";"
}
```

**Example:**

- Source: `"tag1;tag2;tag3"`
- Output: `["tag1", "tag2", "tag3"]`

---

### 4. Date Format

**Usage:** Parse and normalize dates to ISO 8601

```json
{
  "type": "date_format",
  "sourceFormat": "MM/DD/YYYY"
}
```

**Example:**

- Source: `"12/25/2024"`
- Output: `"2024-12-25T00:00:00.000Z"`

---

### 5. Rename Value

**Usage:** Map source values to canonical values (value normalization)

```json
{
  "type": "rename_value",
  "valueMap": {
    "active": "Active",
    "inactive": "Inactive",
    "pending": "Pending"
  }
}
```

**Example:**

- Source: `"active"`
- Output: `"Active"`

---

### 6. Extract (Regex)

**Usage:** Extract substring via regex pattern

```json
{
  "type": "extract",
  "expression": "\\d{5}"
}
```

**Example:**

- Source: `"Address: 12345 Main St"`
- Output: `"12345"` (first capture group or full match)

---

### 7. Coalesce

**Usage:** Try multiple source paths, return first non-null

```json
{
  "type": "coalesce",
  "sources": ["Contact.Email", "Contact.EmailAddress", "Contact.Mail"]
}
```

**Example:**

- Source: `{ Contact: { Email: null, EmailAddress: "user@example.com" } }`
- Output: `"user@example.com"`

---

### 8. Compute

**Usage:** Evaluate computed expression (future feature)

```json
{
  "type": "compute",
  "computeExpression": "price * quantity"
}
```

**Status:** Stub implementation (returns null)

---

## API Reference

### Schema Detection

#### Analyze File

```http
POST /api/:indexId/ingest/analyze
Content-Type: multipart/form-data
Authorization: Bearer {token}

file: [CSV/JSON/Excel file]
metadata: {"description": "..."}
```

**Response:** `200 OK` (see [Phase 1 Example Response](#example-response))

---

### Schema Confirmation

#### Finalize Ingestion

```http
POST /api/:indexId/ingest/finalize
Content-Type: application/json
Authorization: Bearer {token}

{
  "analysisId": "...",
  "schema": { ... },
  "metadata": { ... }
}
```

**Response:** `201 Created`

```json
{
  "jobId": "structured-ingest:abc123",
  "status": "pending",
  "tableId": "abc123",
  "createdAt": "...",
  "estimatedCompletionSeconds": 1000
}
```

---

#### Get Job Status

```http
GET /api/:indexId/ingest/jobs/:jobId
Authorization: Bearer {token}
```

**Response:** `200 OK`

```json
{
  "jobId": "...",
  "status": "processing",
  "progress": 45,
  "createdAt": "...",
  "processedAt": "...",
  "finishedAt": null,
  "failedReason": null
}
```

---

### Canonical Field Mapping

#### List Mappings

```http
GET /api/mappings?schemaId={id}&status=confirmed
Authorization: Bearer {token}
```

**Response:** `200 OK`

```json
{
  "mappings": [ ... ],
  "total": 42
}
```

---

#### Suggest Mappings (LLM-Based)

```http
POST /api/mappings/suggest
Content-Type: application/json
Authorization: Bearer {token}

{
  "canonicalSchemaId": "...",
  "connectorId": "..."
}
```

**Response:** `202 Accepted`

```json
{
  "message": "Auto-mapping suggestion queued",
  "canonicalSchemaId": "...",
  "connectorId": "...",
  "status": "processing"
}
```

**Status:** Implementation pending (stub returns 202)

---

#### Confirm Mapping

```http
POST /api/mappings/:mappingId/confirm
Content-Type: application/json
Authorization: Bearer {token}

{
  "reviewedBy": "user@example.com"
}
```

**Response:** `200 OK`

```json
{
  "mapping": {
    "status": "confirmed",
    "reviewedBy": "user@example.com",
    "reviewedAt": "2024-02-24T12:00:00Z"
  }
}
```

---

#### Reject Mapping

```http
POST /api/mappings/:mappingId/reject
Content-Type: application/json
Authorization: Bearer {token}

{
  "reviewedBy": "user@example.com"
}
```

**Response:** `200 OK`

```json
{
  "mapping": {
    "status": "rejected",
    "reviewedBy": "user@example.com",
    "reviewedAt": "2024-02-24T12:00:00Z"
  }
}
```

---

#### Test Mapping

```http
POST /api/mappings/:mappingId/test
Content-Type: application/json
Authorization: Bearer {token}

{
  "sampleData": {
    "Contact": {
      "Email": "USER@EXAMPLE.COM"
    }
  }
}
```

**Response:** `200 OK`

```json
{
  "mappingId": "...",
  "sourcePath": "Contact.Email",
  "canonicalField": "email",
  "transform": { "type": "lowercase" },
  "testResult": {
    "success": true,
    "inputSample": { ... },
    "outputSample": "user@example.com",
    "message": "Transform applied successfully"
  }
}
```

**Status:** Implementation pending (stub returns null outputSample)

---

### Schema Management

#### Get Connector Schema

```http
GET /api/schemas/connectors/:connectorId?version=2
Authorization: Bearer {token}
```

**Response:** `200 OK`

```json
{
  "schema": {
    "_id": "...",
    "connectorId": "salesforce-123",
    "version": 2,
    "fields": [ ... ]
  }
}
```

---

#### Get Canonical Schema

```http
GET /api/schemas/:knowledgeBaseId?version=3
Authorization: Bearer {token}
```

**Response:** `200 OK`

```json
{
  "schema": {
    "_id": "...",
    "knowledgeBaseId": "kb-123",
    "version": 3,
    "fields": [ ... ]
  }
}
```

---

#### Update Canonical Schema

```http
PATCH /api/schemas/:knowledgeBaseId
Content-Type: application/json
Authorization: Bearer {token}

{
  "fields": [ ... ],
  "status": "active"
}
```

**Response:** `200 OK`

```json
{
  "schema": {
    "version": 4,  // New version created
    "fields": [ ... ],
    "status": "active"
  }
}
```

---

## Quality Assessment

### Confidence Scoring

**Overall Confidence:** Average of all column type confidences

**Low Confidence Warnings:**

- Triggered when column confidence < 0.8
- Recommendation: "Review and correct column types before finalizing"

**Example:**

```json
{
  "overallConfidence": 0.72,
  "warnings": ["Low confidence type detection for: ambiguous_field, mixed_data_column"],
  "recommendations": ["Review and correct column types before finalizing"]
}
```

---

### High Null Rate Detection

**Threshold:** > 50% null values

**Example:**

```json
{
  "warnings": ["High null rate (>50%) in: optional_notes, rarely_used_field"]
}
```

**Implication:**

- High null rate reduces semantic search effectiveness
- Consider omitting high-null columns from embedding

---

### Embeddability Warnings

**Warning:** No embeddable columns detected

**Recommendation:** "Consider adding text descriptions or notes columns"

**Example:**

```json
{
  "warnings": ["No embeddable columns detected - semantic search may be limited"],
  "recommendations": ["Consider adding text descriptions or notes columns"]
}
```

**Impact:**

- Without embeddable columns, only text-to-SQL queries work
- Semantic search returns no results

---

### Wide Table Detection

**Threshold:** > 50 columns

**Recommendation:** "Consider splitting into multiple related tables"

**Example:**

```json
{
  "warnings": ["Large number of columns detected"],
  "recommendations": ["Consider splitting into multiple related tables"]
}
```

**Impact:**

- Wide tables increase storage cost
- Harder to understand and query
- Consider normalization (separate tables with foreign keys)

---

## Cost Estimation

### Embedding Tokens

**Formula:** Sum of (column length ÷ 4) for all embeddable columns and all rows

**Assumptions:**

- 1 token ≈ 4 characters (rough estimate)
- Only embeddable columns contribute

**Example:**

```json
{
  "embeddingTokens": 1250000,
  "embeddingCost": 0.025 // $0.02 per 1M tokens (text-embedding-3-small)
}
```

---

### Storage Size

**Formula:** `Buffer.byteLength(JSON.stringify(rows), 'utf-8')`

**Includes:** All columns, all rows serialized as JSON

**Example:**

```json
{
  "storageBytes": 45000000 // 45 MB raw JSON
}
```

**ClickHouse Compression:** 5:1 ratio (see [13-benchmarking-and-quality.md](./13-benchmarking-and-quality.md))

**Actual Storage:** ~9 MB after compression

---

### Chunk Count

**Formula:** `rowCount × embeddableColumnCount`

**Metadata-Only Strategy:** 1 chunk total (see [02-structured-csv.md](./02-structured-csv.md))

**Example:**

```json
{
  "chunkCount": 100000 // 100K rows × 1 embeddable column (WRONG for metadata-only)
}
```

**Note:** This estimate is incorrect for metadata-only chunking. Actual chunk count = 1.

---

### Processing Time

**Formula:** `Math.ceil(rowCount / 100)` seconds

**Assumption:** 100 rows/second throughput

**Example:**

```json
{
  "processingTimeSeconds": 1000 // 100K rows ÷ 100 = 1000 seconds (~17 minutes)
}
```

**Actual Throughput:** Depends on:

- Embeddable column count (more = slower)
- LLM API latency (if enrichment enabled)
- Worker concurrency

---

## Best Practices

### 1. Review Auto-Detected Schema

**Always review before finalizing:**

- Check type confidences < 0.9
- Verify primary key selection
- Confirm embeddable column selection

**Common Corrections:**

- ZIP codes: Change `integer` → `string` (preserve leading zeros)
- SKUs: Mark as non-embeddable (not meaningful text)
- Dates: Verify format detection (MM/DD vs DD/MM ambiguity)

---

### 2. Add Human-Readable Labels

**Auto-detected column names are technical:**

```json
{
  "name": "cust_email",
  "displayName": "Customer Email Address",
  "description": "Primary email address for customer communication"
}
```

**Benefits:**

- Better UI display
- Clearer search results
- Self-documenting schema

---

### 3. Optimize Embeddable Column Selection

**Enable embedding for:**

- `description`, `notes`, `comments` fields
- Product names, titles, summaries
- Free-text fields > 20 chars average

**Disable embedding for:**

- IDs, codes, enums
- Short text < 10 chars
- High-repetition fields

**Cost Impact:** Reducing embeddable columns from 5 → 2 saves 60% embedding cost

---

### 4. Use Enum for Low-Cardinality Strings

**Mark as enum if:**

- Unique count < 50
- Values repeat frequently
- Used for filtering/faceting

**Benefits:**

- Indexed for fast filtering
- Lower storage cost (category codes vs full strings)
- UI can show dropdown selectors

---

### 5. Validate Foreign Keys

**Auto-detected by naming convention:**

- `user_id` → `users.id`
- `product_id` → `products.id`

**Verify:**

- Target table exists in same knowledge base
- Join conditions are correct
- Cardinality is accurate (1:1, 1:N, N:M)

---

### 6. Handle High Null Rates

**Options for columns with > 50% nulls:**

1. **Exclude from schema** - Don't ingest if rarely populated
2. **Disable embedding** - Save cost on sparse data
3. **Set nullable: true** - Allow missing values in queries

**Example:**

```json
{
  "name": "optional_notes",
  "nullable": true,
  "isEmbeddable": false // Don't embed sparse data
}
```

---

### 7. Split Wide Tables

**If column count > 50:**

- Identify entity boundaries (customer fields vs order fields vs product fields)
- Create separate tables with foreign key relationships
- Join at query time

**Benefits:**

- Faster queries (scan fewer columns)
- Lower storage cost (avoid column bloat)
- Better normalization

---

### 8. Use Canonical Mappings for Multi-Source Data

**When ingesting from multiple sources:**

1. Define CanonicalSchema once per knowledge base
2. Create FieldMappings per source → canonical field
3. All sources normalized to same schema
4. Query once across all sources

**Example:**

- Salesforce: `Contact.Email` → `email`
- HubSpot: `contact.properties.email` → `email`
- CSV: `customer_email` → `email`
- **Query:** `WHERE canonicalMetadata.email = 'user@example.com'` (works across all 3 sources)

---

### 9. Test Transforms on Sample Data

**Before confirming mappings:**

```http
POST /api/mappings/:mappingId/test
{
  "sampleData": { "Contact": { "Email": "USER@EXAMPLE.COM" } }
}
```

**Verify:**

- Lowercase transform applied correctly
- Split delimiter produces expected array
- Regex extraction captures correct substring

---

### 10. Monitor Job Status

**Poll job endpoint every 5 seconds:**

```javascript
async function waitForIngestion(indexId, jobId) {
  while (true) {
    const { status, progress } = await fetch(`/api/${indexId}/ingest/jobs/${jobId}`).then((r) =>
      r.json(),
    );

    if (status === 'completed') return { success: true };
    if (status === 'failed') return { success: false };

    console.log(`Progress: ${progress}%`);
    await new Promise((r) => setTimeout(r, 5000)); // Wait 5 seconds
  }
}
```

---

## Related Documentation

- [Structured CSV Chunking](./02-structured-csv.md) - Metadata-only chunking strategy
- [JSON Nested](./03-structured-json-nested.md) - Path extraction for nested JSON
- [JSON Tabular](./04-structured-json-tabular.md) - Array-of-objects detection
- [Excel](./05-structured-excel.md) - Multi-sheet processing
- [JSON Storage Architecture](./06-json-storage-architecture.md) - MongoDB vs ClickHouse storage
- [Benchmarking and Quality](./13-benchmarking-and-quality.md) - Performance metrics

---

**Last Updated:** 2026-02-24
**Status:** ✅ Fully Documented
**Next:** Worker Pipeline Documentation (Task #38)
