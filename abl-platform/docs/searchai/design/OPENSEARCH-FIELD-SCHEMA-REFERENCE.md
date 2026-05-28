# OpenSearch Field Schema - Quick Reference

**ATLAS-KG v2 Vector Index Schema**
**Last Updated:** 2026-02-20

---

## Complete Field Hierarchy

```
search-vectors-v1                                    (Index Name)
├── vector [knn_vector]                              (1024d, cosinesimil)
├── content [text]                                   (Full-text, analyzed)
└── metadata [object, dynamic: strict]
    ├── sys [object, dynamic: strict]                ← SYSTEM METADATA
    │   ├── tenantId [keyword]                       Multi-tenancy isolation
    │   ├── appId [keyword]                          App/index identifier
    │   ├── connectorId [keyword]                    Connector/source identifier
    │   ├── documentId [keyword]                     Document identifier
    │   ├── chunkId [keyword]                        Chunk identifier
    │   └── chunkIndex [integer]                     Chunk position (0-based)
    │
    ├── doc [object, dynamic: strict]                ← DOCUMENT METADATA
    │   ├── name [keyword]                           Filename or URL
    │   ├── contentType [keyword]                    MIME type
    │   ├── contentHash [keyword, index: false]      SHA-256 hash
    │   ├── language [keyword]                       Language code (en, es, fr)
    │   └── summary [text, index: false]             Document-level summary
    │
    └── canonical [object, dynamic: false]           ← 75-FIELD FIXED CANONICAL SCHEMA
        │                                            (alias names in MongoDB CanonicalSchema,
        │                                             OpenSearch stores actual field names)
        │
        ├── 15 CORE fields (always populated)
        │   ├── id [keyword]                         Source document unique ID
        │   ├── tenant_id [keyword]                  Tenant isolation
        │   ├── document_id [keyword]                Internal document reference
        │   ├── title [text]                         Document title (analyzed for BM25)
        │   ├── content_summary [text]               First 500 chars or LLM summary
        │   ├── source_type [keyword]                Connector type (jira, salesforce, etc.)
        │   ├── source_url [keyword, index: false]   Original URL/permalink
        │   ├── created_date [date]                  Source creation timestamp
        │   ├── modified_date [date]                 Last modification timestamp
        │   ├── author [keyword]                     Creator/owner
        │   ├── access_level [keyword]               public, internal, restricted
        │   ├── language [keyword]                   ISO 639-1 code
        │   ├── mime_type [keyword]                  Content type
        │   ├── status [keyword]                     open, in_progress, done, archived
        │   └── category [keyword]                   bug, story, article, page, etc.
        │
        ├── 25 COMMON fields (populated when available)
        │   ├── description [text]                   Extended description
        │   ├── tags [keyword[]]                     Array of tag values
        │   ├── priority [float]                     Normalized 0.0-1.0
        │   ├── assignee [keyword]                   Assigned person
        │   ├── reporter [keyword]                   Who reported/requested
        │   ├── department [keyword]                 Organizational unit
        │   ├── project [keyword]                    Project name/key
        │   ├── version [keyword]                    Version or sprint
        │   ├── parent_id [keyword]                  Parent document (hierarchies)
        │   ├── due_date [date]                      Deadline
        │   ├── resolved_date [date]                 When closed/resolved
        │   ├── attachment_count [integer]            Attachments
        │   ├── comment_count [integer]              Comments
        │   ├── is_archived [boolean]                Archived flag
        │   ├── severity [keyword]                   blocker, critical, major, minor
        │   ├── resolution [keyword]                 fixed, wontfix, duplicate
        │   ├── component [keyword]                  Sub-component/module
        │   ├── label [keyword[]]                    Additional labels
        │   ├── story_points [float]                 Effort estimation
        │   ├── sprint [keyword]                     Agile sprint name
        │   ├── epic [keyword]                       Parent epic
        │   ├── environment [keyword]                dev, staging, production
        │   ├── customer [keyword]                   Customer/account
        │   ├── deal_amount [float]                  Monetary value
        │   └── stage [keyword]                      Pipeline/workflow stage
        │
        ├── entities [object, dynamic: false]        NER-extracted entities
        │   ├── person [keyword[]]
        │   ├── organization [keyword[]]
        │   ├── location [keyword[]]
        │   ├── date [keyword[]]
        │   └── money [keyword[]]
        │
        ├── 20 custom_string slots [keyword]         custom_string_1..20
        ├── 10 custom_number slots [float]           custom_number_1..10
        ├── 5 custom_date slots [date]               custom_date_1..5
        ├── 5 custom_bool slots [boolean]            custom_bool_1..5
        └── custom [object, enabled: false]          Overflow (stored, not indexed)
```

---

## Field Type Quick Reference

| Type         | Use Case               | Indexed   | Analyzed | Sortable | Examples                    |
| ------------ | ---------------------- | --------- | -------- | -------- | --------------------------- |
| `keyword`    | IDs, exact match, tags | ✅        | ❌       | ✅       | tenantId, category, tags    |
| `text`       | Full-text search       | ✅        | ✅       | ❌       | content, title, summary     |
| `integer`    | Numeric values         | ✅        | ❌       | ✅       | chunkIndex, count           |
| `long`       | Large integers         | ✅        | ❌       | ✅       | timestamp (epoch)           |
| `float`      | Decimals               | ✅        | ❌       | ✅       | priority, score             |
| `double`     | High-precision         | ✅        | ❌       | ✅       | coordinates                 |
| `date`       | Timestamps             | ✅        | ❌       | ✅       | publishedDate, modifiedDate |
| `boolean`    | True/false             | ✅        | ❌       | ✅       | isPublic, isArchived        |
| `object`     | Nested structure       | -         | -        | -        | metadata, entities          |
| `knn_vector` | Dense vectors          | ✅ (k-NN) | ❌       | ❌       | embeddings                  |

---

## Common Query Patterns

### Tenant Isolation (Always Required)

```json
{
  "query": {
    "bool": {
      "filter": [{ "term": { "metadata.sys.tenantId": "tenant-a" } }]
    }
  }
}
```

### App-Scoped Search

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "metadata.sys.tenantId": "tenant-a" } },
        { "term": { "metadata.sys.appId": "kb-1" } }
      ]
    }
  }
}
```

### Connector-Scoped Search

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "metadata.sys.appId": "kb-1" } },
        { "term": { "metadata.sys.connectorId": "logs-s3-1" } }
      ]
    }
  }
}
```

### Filter by Content Type

```json
{
  "query": {
    "bool": {
      "filter": [{ "term": { "metadata.doc.contentType": "application/pdf" } }]
    }
  }
}
```

### Filter by Language

```json
{
  "query": {
    "bool": {
      "filter": [{ "terms": { "metadata.doc.language": ["en", "es", "fr"] } }]
    }
  }
}
```

### Date Range Query

```json
{
  "query": {
    "bool": {
      "filter": [
        {
          "range": {
            "metadata.canonical.publishedDate": {
              "gte": "2024-01-01",
              "lte": "2024-12-31"
            }
          }
        }
      ]
    }
  }
}
```

### Filter by Category

```json
{
  "query": {
    "bool": {
      "filter": [{ "term": { "metadata.canonical.category": "technical" } }]
    }
  }
}
```

### Filter by Tags (Any Match)

```json
{
  "query": {
    "bool": {
      "filter": [{ "terms": { "metadata.canonical.tags": ["ml", "ai", "nlp"] } }]
    }
  }
}
```

### Entity-Based Search

```json
{
  "query": {
    "bool": {
      "filter": [{ "term": { "metadata.canonical.entities.person": "Jane Smith" } }]
    }
  }
}
```

### Priority Range

```json
{
  "query": {
    "bool": {
      "filter": [
        {
          "range": {
            "metadata.canonical.priority": { "gte": 0.7 }
          }
        }
      ]
    }
  }
}
```

### Chunk Range (Within Document)

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "metadata.sys.documentId": "doc-123" } },
        {
          "range": {
            "metadata.sys.chunkIndex": { "gte": 0, "lte": 10 }
          }
        }
      ]
    }
  }
}
```

---

## Vector Search with Filters

### Semantic Search + Tenant Isolation

```json
{
  "size": 10,
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "vector": {
              "vector": [0.1, 0.2, ...],  // 1024 dimensions
              "k": 10
            }
          }
        }
      ],
      "filter": [
        { "term": { "metadata.sys.tenantId": "tenant-a" } },
        { "term": { "metadata.sys.appId": "kb-1" } }
      ]
    }
  }
}
```

### Vector Search + Content Type Filter

```json
{
  "size": 10,
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "vector": {
              "vector": [0.1, 0.2, ...],
              "k": 10
            }
          }
        }
      ],
      "filter": [
        { "term": { "metadata.sys.tenantId": "tenant-a" } },
        { "term": { "metadata.doc.contentType": "application/pdf" } }
      ]
    }
  }
}
```

### Vector Search + Date Range

```json
{
  "size": 10,
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "vector": {
              "vector": [0.1, 0.2, ...],
              "k": 10
            }
          }
        }
      ],
      "filter": [
        { "term": { "metadata.sys.tenantId": "tenant-a" } },
        {
          "range": {
            "metadata.canonical.publishedDate": {
              "gte": "2024-01-01"
            }
          }
        }
      ]
    }
  }
}
```

### Vector Search + Multiple Filters

```json
{
  "size": 10,
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "vector": {
              "vector": [0.1, 0.2, ...],
              "k": 10
            }
          }
        }
      ],
      "filter": [
        { "term": { "metadata.sys.tenantId": "tenant-a" } },
        { "term": { "metadata.sys.appId": "kb-1" } },
        { "term": { "metadata.doc.language": "en" } },
        { "term": { "metadata.canonical.category": "technical" } },
        {
          "range": {
            "metadata.canonical.priority": { "gte": 0.5 }
          }
        }
      ]
    }
  }
}
```

---

## Aggregations (Faceted Search)

### Count by Content Type

```json
{
  "size": 0,
  "aggs": {
    "by_content_type": {
      "terms": {
        "field": "metadata.doc.contentType",
        "size": 10
      }
    }
  }
}
```

### Count by Category

```json
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": {
        "field": "metadata.canonical.category",
        "size": 20
      }
    }
  }
}
```

### Date Histogram (Documents per Month)

```json
{
  "size": 0,
  "aggs": {
    "docs_over_time": {
      "date_histogram": {
        "field": "metadata.canonical.publishedDate",
        "calendar_interval": "month"
      }
    }
  }
}
```

### Tag Cloud (Most Common Tags)

```json
{
  "size": 0,
  "aggs": {
    "popular_tags": {
      "terms": {
        "field": "metadata.canonical.tags",
        "size": 50
      }
    }
  }
}
```

---

## Index Settings Reference

### HNSW Parameters

| Parameter         | Default | Small Index | Large Index | Ultra-Large |
| ----------------- | ------- | ----------- | ----------- | ----------- |
| `ef_construction` | 128     | 64          | 128         | 256         |
| `m`               | 16      | 8           | 16          | 32          |
| `ef_search`       | 100     | 50          | 100         | 200         |

**Formula:**

- **`ef_construction`** = 2 × target recall × `m`
- **`m`** = sqrt(index_size) / 1000, clipped to 8-32
- **`ef_search`** = target_recall × 200

### Shard Configuration

| Index Size   | Shards | Replicas | Notes                           |
| ------------ | ------ | -------- | ------------------------------- |
| < 1M vectors | 1      | 1        | Single shard sufficient         |
| 1M-10M       | 1-2    | 1        | Consider 2 shards if heavy load |
| 10M-50M      | 2-3    | 1-2      | Distribute load                 |
| > 50M        | 3-5    | 2        | High availability               |

**Formula:** `1 shard per 10-20M vectors`

### Refresh Interval

| Use Case  | Interval | Latency | Use When              |
| --------- | -------- | ------- | --------------------- |
| Real-time | 1s       | ~1s     | User-facing search    |
| Balanced  | 5s       | ~5s     | Default (recommended) |
| Batch     | 30s      | ~30s    | Bulk indexing         |
| Disabled  | -1       | Manual  | Initial load          |

---

## Storage Estimation

### Per Vector

- **Vector size:** 1024 floats × 4 bytes = 4KB
- **Metadata:** ~0.5KB (structured)
- **Content:** 0KB (not stored)
- **Total:** ~4.5KB per vector

### Per Index

| Vectors | Raw Size | Compressed | With Replica |
| ------- | -------- | ---------- | ------------ |
| 1M      | 4.5 GB   | 2.7 GB     | 5.4 GB       |
| 10M     | 45 GB    | 27 GB      | 54 GB        |
| 50M     | 225 GB   | 135 GB     | 270 GB       |

**Compression:** `best_compression` codec reduces by ~40%

---

## Dynamic Settings

### `dynamic: "strict"`

- **Used for:** `metadata.sys`, `metadata.doc`
- **Behavior:** Reject documents with unknown fields
- **Error:** 400 Bad Request (`strict_dynamic_mapping_exception`)
- **Use case:** Fixed schema, prevent bloat

### `dynamic: "false"`

- **Used for:** `metadata.canonical`
- **Behavior:** Store but don't index unknown fields
- **Error:** None (field stored)
- **Use case:** Flexible enrichment fields

### `dynamic: "true"`

- **NOT USED** - Leads to schema bloat
- **Behavior:** Auto-create mappings for unknown fields
- **Risk:** Inconsistent types, performance issues

### `enabled: false`

- **Used for:** `metadata.canonical.custom`
- **Behavior:** Store JSON as-is, no indexing
- **Use case:** Arbitrary metadata blob

---

## Field Index Settings

### `index: true` (Default)

- Field is indexed for search, filters, aggregations
- Use for: IDs, categories, dates, numeric values

### `index: false`

- Field is stored but NOT searchable
- Use for: contentHash (no search), summary (display only)
- **Benefit:** Saves index space, faster indexing

---

## Best Practices

✅ **DO:**

- Always filter by `metadata.sys.tenantId` (tenant isolation)
- Use `keyword` for exact match (IDs, categories, tags)
- Use `text` for full-text search (content, titles)
- Use `date` for timestamps (ISO 8601 format)
- Set `index: false` for display-only fields
- Use aggregations for faceted search

❌ **DON'T:**

- Search by `contentHash` (use MongoDB lookup instead)
- Store redundant data (content already in MongoDB)
- Use `text` for IDs (use `keyword`)
- Use `keyword` for long text (use `text`)
- Mix string types (ISO date vs epoch_millis)

---

## Migration Checklist

When updating existing indices:

1. ✅ Check current mapping: `GET /index/_mapping`
2. ✅ Create new index with strict mappings
3. ✅ Reindex from old to new: `POST /_reindex`
4. ✅ Verify document count: `GET /index/_count`
5. ✅ Test queries on new index
6. ✅ Update IndexRegistry to point to new index
7. ✅ Monitor for errors (24 hours)
8. ✅ Delete old index

---

## Troubleshooting

### Error: `strict_dynamic_mapping_exception`

**Cause:** Tried to index unknown field in strict section
**Fix:** Add field to mapping or remove from document

### Error: `illegal_argument_exception: field [X] is not indexed`

**Cause:** Tried to search/filter on field with `index: false`
**Fix:** Remove filter or change mapping to `index: true`

### Slow queries

**Cause:** Too many filters, large result set, low `ef_search`
**Fix:** Add more filters, reduce `size`, increase `ef_search`

### High memory usage

**Cause:** High `m` parameter, too many replicas
**Fix:** Reduce `m`, reduce replicas, add more nodes

---

## See Also

- [PHASE3-STRICT-OPENSEARCH-MAPPINGS.md](PHASE3-STRICT-OPENSEARCH-MAPPINGS.md) - Full documentation
- [RFC-002-OpenSearch-Index-Strategy.md](docs/rfcs/RFC-002-OpenSearch-Index-Strategy.md) - Index strategy
- OpenSearch k-NN docs: https://opensearch.org/docs/latest/search-plugins/knn/
