# Search AI Retrieval API Reference

**Service:** search-ai-runtime
**Port:** 3004 (default)
**Base URL:** `http://localhost:3004/api/search`

---

## Overview

The retrieval API provides multiple query types for searching indexed documents. All endpoints require tenant authentication.

| Query Type     | Endpoint                    | Use Case              | Status         |
| -------------- | --------------------------- | --------------------- | -------------- |
| **Vector**     | `POST /:indexId/query`      | Semantic search       | ✅ Implemented |
| **Structured** | `POST /:indexId/structured` | Metadata filtering    | ✅ Implemented |
| **Aggregate**  | `POST /:indexId/aggregate`  | Analytics             | ✅ Implemented |
| **Similar**    | `POST /:indexId/similar`    | Similar documents     | ✅ Implemented |
| **Suggest**    | `POST /:indexId/suggest`    | Autocomplete          | ✅ Implemented |
| **Resolve**    | `POST /:indexId/resolve`    | Vocabulary resolution | ✅ Implemented |

---

## 1. Vector Search

**Endpoint:** `POST /api/search/:indexId/query`

**Description:** Semantic search using embeddings.

**Request:**

```json
{
  "query": "What are the key features of the product?",
  "queryType": "vector",
  "topK": 10,
  "similarityThreshold": 0.7,
  "filters": [{ "field": "doc.documentType", "operator": "eq", "value": "manual" }],
  "includeMetadata": true,
  "includeContent": true
}
```

**Response:**

```json
{
  "results": [
    {
      "chunkId": "chunk-uuid-123",
      "documentId": "doc-uuid-456",
      "content": "The product features include...",
      "score": 0.89,
      "metadata": {
        "chunkIndex": 5,
        "tokenCount": 256
      },
      "canonicalMetadata": {
        "doc.title": "Product Manual",
        "doc.documentType": "manual"
      }
    }
  ],
  "total": 42,
  "latency": {
    "vectorSearchMs": 45,
    "totalMs": 57
  }
}
```

**Example (curl):**

```bash
curl -X POST http://localhost:3004/api/search/index-123/query \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What are the key features?",
    "topK": 5
  }'
```

---

## 2. Structured Query

**Endpoint:** `POST /api/search/:indexId/structured`

**Description:** Filter-based search on metadata fields (no semantic search).

**Request:**

```json
{
  "filters": [
    { "field": "doc.documentType", "operator": "eq", "value": "invoice" },
    { "field": "doc.amount", "operator": "gte", "value": 1000 }
  ],
  "sort": [{ "field": "doc.createdDate", "order": "desc" }],
  "limit": 20,
  "offset": 0
}
```

**Filter Operators:**

- `eq` (equals)
- `ne` (not equals)
- `gt`, `gte`, `lt`, `lte` (comparisons)
- `in`, `nin` (array membership)

---

## 3. Aggregation Query

**Endpoint:** `POST /api/search/:indexId/aggregate`

**Description:** Compute aggregations on metadata fields.

**Request:**

```json
{
  "function": "sum",
  "field": "doc.amount",
  "filters": [{ "field": "doc.documentType", "operator": "eq", "value": "invoice" }],
  "groupBy": ["doc.customerId"],
  "orderBy": { "field": "_result", "order": "desc" },
  "limit": 10
}
```

**Functions:** `sum`, `avg`, `count`, `min`, `max`, `count_distinct`

---

## 4. Similar Documents

**Endpoint:** `POST /api/search/:indexId/similar`

**Description:** Find documents similar to a given document.

**Request:**

```json
{
  "documentId": "doc-uuid-123",
  "topK": 10
}
```

---

## 5. Autocomplete/Suggest

**Endpoint:** `POST /api/search/:indexId/suggest`

**Description:** Prefix-based autocomplete.

**Request:**

```json
{
  "prefix": "product feat",
  "limit": 10
}
```

---

## 6. Vocabulary Resolution

**Endpoint:** `POST /api/search/:indexId/resolve`

**Description:** Map natural language terms to structured filters.

**Request:**

```json
{
  "query": "recent high-value invoices",
  "mode": "fuzzy"
}
```

**Response:**

```json
{
  "resolvedFilters": [
    { "field": "doc.documentType", "operator": "eq", "value": "invoice" },
    { "field": "doc.amount", "operator": "gte", "value": 5000 },
    { "field": "doc.createdDate", "operator": "gte", "value": "2026-01-01" }
  ]
}
```

---

## Error Responses

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "Query text is required"
  }
}
```

**Error Codes:**

- `INVALID_QUERY` — Malformed request
- `INDEX_NOT_FOUND` — Index ID not found
- `UNAUTHORIZED` — Auth failure
- `INTERNAL_ERROR` — Server error

---

## Latency Benchmarks

```
Vector search: ~75ms (typical), ~150ms (p95)
Structured query: ~10ms
Aggregation: ~50ms (100K docs)
```

---

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design
- [EMBEDDING-GUIDE.md](./EMBEDDING-GUIDE.md) — Embedding configuration
- [OPENSEARCH-FIELD-SCHEMA-REFERENCE.md](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) — Field mappings
