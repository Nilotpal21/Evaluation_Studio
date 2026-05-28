# Query Pipeline -- Next Steps & Gaps

Findings identified during the query pipeline design review. Each item describes a gap in the current implementation, why it matters, and a rough approach.

---

## 1. Post-Ingestion Enum Discovery

**Status:** Not implemented

**Gap:** Enum values on `CanonicalSchema.fields[].enumValues` are populated only at schema discovery time (connector API introspection, structured data analysis, or LLM mapping suggestion). There is no mechanism that scans actual indexed chunks to discover or enrich enum values after ingestion.

**Why it matters:** Connector APIs don't always expose enum metadata. Free-text fields that behave like enums (low cardinality in practice) are never detected. Over time, new values may appear in source systems that the existing enum map doesn't cover. The result: alias resolution silently passes through unrecognized values, queries return no results, and the user has no idea why.

**Approach:**

- A background worker (or on-demand job) runs an OpenSearch `terms` aggregation on `metadata.canonical.*` fields for a given KB
- For each field, if unique value count < configurable threshold (e.g., 50), classify as enum-eligible
- Compare discovered values against existing `CanonicalSchema.fields[].enumValues`
- Surface new/missing values in the Fields Tab UI for user review (not auto-apply -- enum mappings may need display-to-stored coercion that only a human can define)
- Optionally trigger on ingestion completion (after a connector sync finishes) or on a schedule

**Infrastructure available:** OpenSearch terms aggregation API, BullMQ workers, CanonicalSchema versioning, Redis pub/sub for cache invalidation. The pieces exist -- the worker and UI surface do not.

**Related files:**

- `packages/database/src/models/canonical-schema.model.ts` -- `enumValues` field
- `apps/search-ai/src/services/canonical-mapping/canonical-mapper.service.ts` -- ingestion-time mapping
- `apps/search-ai-runtime/src/services/alias/alias-resolver.ts` -- query-time enum coercion

---

## 2. Hybrid Search: True RRF Fusion

**Status:** Not implemented (tracked in RFC-007)

**Gap:** Current hybrid search runs k-NN with metadata filters in a `bool` query. It does not run a separate BM25 leg or fuse scores with Reciprocal Rank Fusion. The `hybridAlpha` parameter is accepted but has no effect.

**Why it matters:** Without BM25 scoring, hybrid queries miss keyword-exact matches that vector search ranks poorly. RRF fusion would combine the strengths of both retrieval methods.

---

## 3. Static Vocabulary Resolver: No Query Type Classification

**Status:** Not implemented

**Gap:** When LLM is not configured, the static `VocabularyResolver` cannot classify query type. The pipeline defaults to `semantic`, which may not be optimal for structured or aggregation queries.

**Why it matters:** Cost-sensitive deployments that skip LLM resolution get suboptimal query routing.

**Approach:** Heuristic classification based on resolved vocabulary capabilities -- if all resolved terms have `canAggregate` and the query contains keywords like "count", "how many", "per", classify as `aggregation`. If all resolved terms have `canFilter` and no unresolved segments, classify as `structured`.

---

## 4. Reranker Adaptive Batching Window

**Status:** Not implemented

**Gap:** The `BatchedRerankerFactory` uses a fixed 50ms batching window. Under low traffic this adds unnecessary latency. Under high traffic batches may overflow.

**Why it matters:** P99 latency spikes under low traffic; cost savings plateau under high traffic.

**Approach:** Adaptive window that shrinks when batch is full and grows when idle.
