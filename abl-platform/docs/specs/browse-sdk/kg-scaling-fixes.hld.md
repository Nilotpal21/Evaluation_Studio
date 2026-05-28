# Knowledge Graph Scaling Fixes — High-Level Design

## What

The KG enrichment pipeline has four scaling bottlenecks that make it unusable beyond ~10K documents per index. This HLD addresses all four:

1. **N+1 Neo4j sessions** — `upsertEntityInstance()` opens a new session per entity (5,000 sessions per 50-doc batch)
2. **Unbounded `Promise.all`** — 50 concurrent LLM calls + thousands of Neo4j sessions with no concurrency limiter
3. **Serial taxonomy creation** — `createTaxonomyGraph()` loops categories/products/attributes as individual Cypher round-trips
4. **Cartesian stats query** — `getTaxonomyStats()` uses unconnected OPTIONAL MATCHes that explode at scale

Additionally, we fix the `previousVersions` unbounded array (BSON 16MB limit risk) since it's a one-line fix in the same model file.

## Architecture Approach

### Packages Changed

| Package             | Files                               | Change Type                                           |
| ------------------- | ----------------------------------- | ----------------------------------------------------- |
| `apps/search-ai`    | `taxonomy-graph.service.ts`         | Refactor: UNWIND batching, session reuse, stats query |
| `apps/search-ai`    | `kg-enrichment-worker.ts`           | Refactor: p-limit concurrency, batch entity upserts   |
| `packages/database` | `knowledge-graph-taxonomy.model.ts` | Fix: cap previousVersions array                       |

### Data Flow (Before vs After)

```
BEFORE (per 50-doc batch):
  Promise.all(50 docs) ──► 50 concurrent LLM calls
                        ──► 50 × linkDocumentToProduct (50 sessions)
                        ──► 50 × 20 chunks × extractEntities (1000 LLM calls)
                        ──► 50 × 20 × 5 entities × upsertEntityInstance (5000 sessions!)
  Total: ~5100 Neo4j sessions, 1050 LLM calls, ZERO concurrency control

AFTER (per 50-doc batch):
  p-limit(5)(50 docs)  ──► 5 concurrent LLM calls at a time
                        ──► 5 × linkDocumentToProduct (reuse session)
                        ──► 5 × 20 chunks × extractEntities (100 concurrent LLM max)
                        ──► per-document: 1 × batchUpsertEntityInstances (UNWIND, 1 session)
  Total: ~55 Neo4j sessions, same LLM calls but rate-limited
```

### Key Integration Points

- `TaxonomyGraphService` is used by both `kg-enrichment-worker` and `taxonomy-setup-worker`
- The UNWIND batching changes are internal to the service — no API/route changes needed
- The `p-limit` addition is internal to the worker — no job data schema changes

## Decisions & Tradeoffs

| Decision             | Chose                                                   | Over                                        | Because                                                                                                                                   |
| -------------------- | ------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency limiter  | `p-limit(5)` in worker                                  | Reducing batchSize                          | batchSize controls cursor reads which is fine; the problem is concurrent processing. p-limit caps active work without reducing throughput |
| Entity batching      | New `batchUpsertEntityInstances()` with UNWIND          | Keeping per-entity `upsertEntityInstance()` | UNWIND sends all entities in one Cypher query per document. 1 session vs N sessions. Keep old method for single-entity callers            |
| Taxonomy creation    | UNWIND per node type (categories, products, attributes) | Single mega-query                           | Separate UNWINDs per type are simpler and maintain the MATCH→MERGE dependency chain. Still within one transaction                         |
| Stats query fix      | Separate CALL subqueries                                | Separate HTTP calls                         | Neo4j 4.1+ supports CALL { } subqueries. Keeps it as one round-trip but avoids Cartesian product                                          |
| previousVersions cap | Mongoose pre-save hook, keep last 10                    | Application-level rotation                  | Pre-save hook is transparent — no caller changes needed. 10 matches RFC-001's stated limit                                                |

## Task Decomposition

| Task                                          | File(s)                             | Independent?                                  | Est. Lines Changed |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------- | ------------------ |
| T-1: UNWIND batching in TaxonomyGraphService  | `taxonomy-graph.service.ts`         | Yes                                           | ~150               |
| T-2: p-limit + batch entity upserts in worker | `kg-enrichment-worker.ts`           | No (needs T-1's `batchUpsertEntityInstances`) | ~60                |
| T-3: Cap previousVersions in model            | `knowledge-graph-taxonomy.model.ts` | Yes                                           | ~10                |

T-1 and T-3 are independent and can run in parallel. T-2 depends on T-1.

## Out of Scope

- Query-time integration (Tier 2 — separate HLD)
- Document deletion → graph cleanup wiring (Tier 3)
- `console.log` → `createLogger` migration in routes (Tier 4)
- `graph-store.ts` cleanup (old Gen 1 in-memory store — separate cleanup)
- `batchLinkChunksToProducts` fragile `chunkId.split('_')[0]` (not on the hot path)
