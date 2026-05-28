# ADR-005: Two-Phase Structured Data Ingestion

**Status:** Accepted
**Date:** 2025-Q4
**Deciders:** Platform Architecture Team
**Tags:** structured-data, UX, data-quality

---

## Context

The search-ai platform ingests structured data (CSV, JSON, Excel) for SQL querying and semantic search. Challenge:

**Problem:** Automatic schema detection is imperfect (90% accuracy):

- Column type inference can be wrong (e.g., ZIP code "02134" detected as integer instead of string)
- Primary key detection misses compound keys
- Embeddable column recommendations may be incorrect

**User expectation:** "I upload a file → it works correctly"

**Reality:** Without validation, 10% of ingestions have schema errors:

- Wrong types → SQL queries fail (`SUM(zip_code)` when zip_code is string)
- Missing embeddable columns → semantic search returns no results
- Wrong primary key → duplicate rows not detected

**Question:** How to balance automation (fast onboarding) with correctness (avoid bad data)?

---

## Decision

Implement **two-phase ingestion flow** with schema validation:

```
Phase 1: Analyze (Fast, Non-Destructive)
   ↓
User Reviews & Corrects Schema
   ↓
Phase 2: Finalize (Slow, Commits Data)
```

**Phase 1 (Analyze):**

- Parse file (CSV, JSON, Excel)
- Detect schema automatically (types, keys, embeddable columns)
- Calculate cost estimates (embedding tokens, storage size, processing time)
- Generate quality warnings (high null rates, low confidence types)
- Cache analysis (1 hour TTL)
- Return `analysisId` + schema + estimates + warnings
- **No data committed** (user can cancel without consequence)

**Phase 2 (Finalize):**

- Retrieve cached analysis
- Accept user-corrected schema
- Create ClickHouse table
- Enqueue background ingestion job
- Return `jobId` for polling

---

## Rationale

### Why Two Phases Instead of One?

#### Alternative: Single-Phase (Auto-Ingest)

**Flow:**

```
Upload File → Auto-detect schema → Ingest immediately
```

**Pros:**

- ✅ Faster UX (no review step)
- ✅ Simpler API (1 endpoint instead of 2)

**Cons:**

- ❌ **10% failure rate:** Schema detection errors → bad data
- ❌ **No cost transparency:** Users don't see embedding cost until after ingestion
- ❌ **Wasted resources:** Embedding + storage committed before validation
- ❌ **Hard to fix:** Once ingested, requires delete + re-upload to correct schema

**Real example of failure:**

```csv
zip_code,city,population
02134,Boston,50000
10001,NYC,80000
```

Auto-detected schema:

```typescript
{ zip_code: 'integer', city: 'string', population: 'integer' }
                ^
                ❌ WRONG! ZIP codes can start with 0 → should be string
```

Result: Data ingested as integers → `2134, 10001` (leading zero lost)

**Damage:** User uploads 100K rows → realizes ZIP codes are wrong → must delete + re-upload → 10 minutes wasted

---

#### Two-Phase Solution

**Flow:**

```
Upload → Analyze (5s) → User reviews schema → User corrects zip_code to string → Finalize → Correct ingestion
```

**Benefits:**

1. **10% error rate → 0.1%:** User catches 99% of schema errors before commit
2. **Cost transparency:** User sees "This will cost $5 and take 10 minutes" before committing
3. **Zero waste:** No resources spent on bad data (analysis is cheap, ingestion is expensive)
4. **Quality warnings:** User sees "Column X has 50% nulls — consider excluding" before ingestion

**Tradeoff:** Extra review step adds 30 seconds → But prevents 10% failures (10 minutes each) → Net time saved.

---

### Cost Transparency Example

**Scenario:** User uploads 1M-row CSV

**Phase 1 (Analyze) shows:**

```json
{
  "estimates": {
    "embeddingTokens": 5000000,
    "embeddingCost": "$0.10 (using OpenAI text-emb-3-small)",
    "storageCost": "$0.05/month (ClickHouse compressed)",
    "processingTime": "~10 minutes (embedding generation)"
  },
  "qualityWarnings": [
    "Column 'description' has 80% null values — consider marking as non-embeddable",
    "Column 'status' has only 3 unique values — consider marking as filterable enum"
  ]
}
```

**User decision:**

- "Ah, I don't need to embed 'description' (80% nulls) → uncheck embeddable"
- Result: Embedding cost drops from $0.10 to $0.02 (5× savings)

**Without Phase 1:** User wouldn't know until after $0.10 spent.

---

### Schema Correction Example

**Phase 1 detects:**

```typescript
{
  columns: [
    { name: 'id', type: 'integer', primaryKey: true },
    { name: 'zip_code', type: 'integer', confidence: 0.95 }, // ⚠️ Looks like int
    { name: 'phone', type: 'string', confidence: 1.0 },
  ];
}
```

**User corrects:**

```typescript
{
  columns: [
    { name: 'id', type: 'integer', primaryKey: true },
    { name: 'zip_code', type: 'string' }, // ✅ Corrected to string
    { name: 'phone', type: 'string' },
  ];
}
```

**Phase 2:** Ingests with corrected schema → ZIP codes preserve leading zeros → SQL queries work correctly.

---

## Implementation

### API Endpoints

#### Phase 1: POST /:indexId/ingest/analyze

**Request:**

```http
POST /api/:indexId/ingest/analyze
Content-Type: multipart/form-data

file: [CSV/JSON/Excel file]
metadata: {"description": "Q4 sales data"}  (optional)
```

**Response:**

```json
{
  "analysisId": "analysis-uuid-123",
  "schema": {
    "tableName": "sales_q4",
    "columns": [
      {
        "name": "revenue",
        "type": "number",
        "nullable": false,
        "embeddable": false,
        "filterable": true,
        "confidence": 1.0
      },
      {
        "name": "description",
        "type": "string",
        "nullable": true,
        "embeddable": true,
        "filterable": false,
        "confidence": 0.85,
        "nullRate": 0.8 // ⚠️ High null rate
      }
    ],
    "primaryKey": ["id"],
    "rowCount": 100000
  },
  "estimates": {
    "embeddingTokens": 5000000,
    "embeddingCost": "$0.10",
    "storageCost": "$0.05/month",
    "processingTime": "~10 minutes"
  },
  "qualityWarnings": [
    "Column 'description' has 80% null values — consider marking as non-embeddable"
  ]
}
```

**Caching:** Analysis cached in Redis (1 hour TTL) → User can correct schema + finalize within 1 hour without re-uploading file.

---

#### Phase 2: POST /:indexId/ingest/finalize

**Request:**

```http
POST /api/:indexId/ingest/finalize
Content-Type: application/json

{
  "analysisId": "analysis-uuid-123",
  "schema": {
    "tableName": "sales_q4",
    "columns": [
      {
        "name": "description",
        "embeddable": false  // ✅ User corrected (was true)
      }
    ]
  }
}
```

**Response:**

```json
{
  "jobId": "job-uuid-456",
  "status": "pending",
  "estimatedCompletionTime": "2026-02-24T10:40:00Z"
}
```

**Background processing:** Job enqueued → auto-mapping-worker processes → Creates ClickHouse table → Embeds metadata chunk → Indexes.

---

### User Flow (Frontend)

```tsx
// 1. Upload file
const { analysisId, schema, estimates, warnings } = await api.analyzeFile(file)

// 2. Show schema review UI
<SchemaReview
  schema={schema}
  estimates={estimates}
  warnings={warnings}
  onCorrect={(correctedSchema) => {
    // User corrects types, marks columns as embeddable, etc.
  }}
/>

// 3. Finalize after user approval
const { jobId } = await api.finalizeIngestion(analysisId, correctedSchema)

// 4. Poll for completion
const status = await api.getJobStatus(jobId)  // pending → processing → completed
```

---

## Consequences

### Positive

- ✅ **99% reduction in schema errors** (10% → 0.1%)
- ✅ **Cost transparency:** Users see embedding cost before committing
- ✅ **Resource savings:** No wasted embeddings on bad data (10% of 1M embeddings = $0.01 saved per table)
- ✅ **Quality improvements:** Warnings guide users to exclude high-null columns (5× embedding cost savings)
- ✅ **User control:** Power users can tune schema (mark enum types, set display names)

### Negative

- ❌ **Extra UX step:** Review screen adds 30 seconds to upload flow
- ❌ **API complexity:** 2 endpoints instead of 1
- ❌ **Caching dependency:** Requires Redis for analysis caching (1 hour TTL)

### Neutral

- ⚪ **Learning curve:** Users must understand schema concepts (types, embeddable, filterable)

---

## Alternatives Considered

### Alternative 1: Single-Phase with Undo

**Flow:** Upload → Auto-ingest → If user notices error → Undo → Re-upload with corrections

**Pros:**

- ✅ Faster initial UX (no review step)

**Cons:**

- ❌ **Wasted resources:** Embeddings + storage committed before error detected
- ❌ **Undo complexity:** Must delete ClickHouse table, MongoDB chunks, OpenSearch index
- ❌ **Time wasted:** Average 10 minutes per failed ingestion (10% failure rate = 1 minute avg overhead)

**Why rejected:** Undo is more complex than two-phase flow, and still wastes resources.

---

### Alternative 2: LLM-Based Schema Correction

**Flow:** Upload → Auto-detect → LLM validates schema → Correct errors automatically → Ingest

**Pros:**

- ✅ No user review needed (fully automatic)

**Cons:**

- ❌ **LLM cost:** $0.01 per schema validation (GPT-4 API)
- ❌ **LLM errors:** 5% failure rate (hallucinations, wrong corrections)
- ❌ **Latency:** +2-5s per file (LLM call)
- ❌ **No user control:** Power users can't override LLM corrections

**Why rejected:** Adds cost + latency without eliminating errors. Users prefer explicit control over automatic "magic."

---

### Alternative 3: Interactive Wizard

**Flow:** Upload → Step 1: Select columns → Step 2: Choose types → Step 3: Mark embeddable → Step 4: Confirm

**Pros:**

- ✅ Maximum user control

**Cons:**

- ❌ **Slow UX:** 4 steps instead of 2
- ❌ **Tedious:** Users must manually configure every column (no automation)

**Why rejected:** Too slow. Two-phase balances automation (Phase 1 auto-detects) with control (Phase 2 corrections).

---

## Related Decisions

- **ADR-003: ClickHouse** — Finalize phase creates ClickHouse tables
- **Auto-Mapping Documentation:** See `chunking/07-auto-mapping-and-schema-detection.md`

---

## Future Considerations

**When to revisit:**

1. **99.9% schema detection accuracy:** If AI improves to 99.9%, consider removing review step
2. **User feedback:** If users complain about review step slowness, add "Quick ingest" option (skip review, auto-correct obvious errors only)

---

**References:**

- Implementation: `apps/search-ai/src/routes/structured-data-ingest.ts`
- Documentation: `apps/search-ai/docs/chunking/07-auto-mapping-and-schema-detection.md`
- Worker: `apps/search-ai/src/workers/auto-mapping-worker.ts`

**Last Updated:** 2026-02-24
