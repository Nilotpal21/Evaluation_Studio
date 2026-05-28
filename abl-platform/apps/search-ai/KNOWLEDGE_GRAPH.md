# Knowledge Graph (ATLAS-KG Phase 3)

## Overview

The Knowledge Graph feature extracts entities and relationships from documents to build a cross-document knowledge graph stored in Neo4j. This enables relationship-based search, entity discovery, and cross-document navigation.

## Features

### 1. Entity Extraction

Extracts named entities using multiple methods:

**Regex Patterns** (deterministic, fast):

- Email addresses
- URLs (http/https)
- Dates (multiple formats: YYYY-MM-DD, MM/DD/YYYY, "March 15, 2024")
- Money amounts ($, €, £)
- Phone numbers (US formats)

**Compromise NLP** (semantic, JS-native):

- People (PERSON)
- Organizations (ORGANIZATION)
- Locations (LOCATION)
- Dates and times
- Money values
- Products and events

**Hybrid Mode** (default):

- Combines both methods
- Deduplicates overlapping entities
- Preserves highest-confidence results

### 2. Reference Extraction

Identifies explicit cross-document references:

- **Contracts**: "Contract #45821", "Agreement No. ABC-123"
- **Exhibits**: "Exhibit A", "Exhibit B-1"
- **Sections**: "Section 3.2", "§ 5.1.3"
- **Appendices**: "Appendix A", "App. 1"
- **Figures & Tables**: "Figure 5", "Table A-1"
- **Schedules**: "Schedule A"
- **Annexes**: "Annex 1"
- **Attachments**: "Attachment B"
- **Clauses**: "Clause 14(b)"
- **Articles**: "Article IV"

### 3. Co-Occurrence Analysis

Calculates IDF-weighted relationships between entities:

- **IDF (Inverse Document Frequency)**: `log(N / df)`
  - N = total chunks
  - df = chunks containing entity
- **Co-occurrence Weight**: `min(idf_entity1, idf_entity2) * frequency`
- Rare entities co-occurring get higher weights
- Common entities (stop-entities) filtered by min IDF threshold

### 4. Neo4j Graph Storage

Stores entities and relationships in Neo4j with:

- **Tenant Isolation**: All nodes/edges include `tenantId` property
- **Entity Nodes**: Type, text, occurrence count, IDF score
- **Relationship Types**:
  - `CO_OCCURS`: Entities in same chunk (IDF-weighted)
  - `REFERENCES`: Explicit references between documents
- **Constraints & Indexes**: Unique entities per (tenant, index, type, text)

## What You Can Use Today

The knowledge graph is **fully constructed** during ingestion. You can query it today via:

### ✅ Option 1: Neo4j Browser (Interactive Queries)

```bash
# Open Neo4j Browser
open http://localhost:7474

# Example: Find all entities for an index
MATCH (e:Entity {tenantId: 'tenant-123', indexId: 'index-456'})
RETURN e.type, e.text, e.occurrenceCount, e.idf
ORDER BY e.idf DESC
LIMIT 20;

# Example: Find co-occurring entities
MATCH (e1:Entity {tenantId: 'tenant-123'})-[r:CO_OCCURS]-(e2:Entity)
WHERE r.weight > 2.0
RETURN e1.text, e2.text, r.weight, r.count
ORDER BY r.weight DESC;

# Example: Find entities of a specific type
MATCH (e:Entity {tenantId: 'tenant-123', indexId: 'index-456', type: 'ORGANIZATION'})
RETURN e.text, e.occurrenceCount
ORDER BY e.occurrenceCount DESC;
```

### ✅ Option 2: Service Layer API (Programmatic)

```typescript
import { KnowledgeGraphService } from './services/knowledge-graph';

const service = new KnowledgeGraphService(config.knowledgeGraph);
await service.initialize();

// Get graph statistics
const stats = await service.getGraphStats('tenant-123', 'index-456');
console.log(stats);
// {
//   entityCount: 1234,
//   relationshipCount: 5678,
//   entityTypes: { PERSON: 100, ORGANIZATION: 200, ... }
// }

// Find related entities
const related = await service.findRelatedEntities(
  'tenant-123',
  'index-456',
  'Microsoft',
  'CO_OCCURS',
  20,
);

await service.close();
```

### ❌ What's NOT Available Yet

The following features are planned but not yet implemented:

- **REST API for graph queries** (`POST /api/search/:indexId/graph`)
- **Graph-augmented search results** (entities don't influence rankings yet)
- **Entity-centric search** ("find all docs mentioning Microsoft")
- **Relationship-based ranking** (boost results based on entity relationships)

See [../../docs/searchai/dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md](../../docs/searchai/dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md) for planned graph retrieval features.

---

## Configuration

### Environment Variables

```bash
# Enable knowledge graph
KNOWLEDGE_GRAPH_ENABLED=true

# Neo4j connection
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
NEO4J_DATABASE=neo4j

# Entity extraction method
KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD=hybrid  # regex | compromise | hybrid

# Co-occurrence analysis
KNOWLEDGE_GRAPH_ENABLE_COOCCURRENCE=true
KNOWLEDGE_GRAPH_COOCCURRENCE_WINDOW=5
KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD=1.5
```

### Config Schema

```typescript
{
  enabled: boolean; // Default: false
  uri: string; // Default: 'neo4j://localhost:7687'
  username: string; // Default: 'neo4j'
  password: string; // Default: 'password'
  database: string; // Default: 'neo4j'
  entityExtractionMethod: 'regex' | 'compromise' | 'hybrid'; // Default: 'hybrid'
  enableCoOccurrence: boolean; // Default: true
  coOccurrenceWindow: number; // Default: 5
  minIdfThreshold: number; // Default: 1.5
}
```

## Usage

### 1. Start Neo4j

Using Docker:

```bash
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5.29
```

Access Neo4j Browser at: http://localhost:7474

### 2. Enable in Config

Set `KNOWLEDGE_GRAPH_ENABLED=true` in `.env`

### 3. Ingest Documents

The knowledge graph worker runs automatically after enrichment:

```
ingest → extract → canonical-map → enrich → [knowledge-graph + embedding] → indexed
```

### 4. Query the Graph

#### Via Neo4j Browser

```cypher
// Find all entities for a tenant/index
MATCH (e:Entity {tenantId: 'tenant123', indexId: 'index456'})
RETURN e.type, e.text, e.occurrenceCount, e.idf
ORDER BY e.idf DESC
LIMIT 20;

// Find co-occurring entities
MATCH (e1:Entity {tenantId: 'tenant123'})-[r:CO_OCCURS]-(e2:Entity)
WHERE r.weight > 2.0
RETURN e1.text, e2.text, r.weight, r.count
ORDER BY r.weight DESC
LIMIT 20;

// Find entities of a specific type
MATCH (e:Entity {tenantId: 'tenant123', indexId: 'index456', type: 'ORGANIZATION'})
RETURN e.text, e.occurrenceCount
ORDER BY e.occurrenceCount DESC;

// Find related entities (graph traversal)
MATCH (e:Entity {text: 'Microsoft'})-[r:CO_OCCURS*1..2]-(related)
RETURN DISTINCT related.text, related.type
LIMIT 10;
```

#### Via Knowledge Graph Service

```typescript
import { KnowledgeGraphService } from './services/knowledge-graph';

const service = new KnowledgeGraphService(config.knowledgeGraph);
await service.initialize();

// Get graph statistics
const stats = await service.getGraphStats('tenant123', 'index456');
console.log(stats);
// {
//   entityCount: 1234,
//   relationshipCount: 5678,
//   entityTypes: { PERSON: 100, ORGANIZATION: 200, ... }
// }

// Find related entities
const related = await service.findRelatedEntities(
  'tenant123',
  'index456',
  'entity-id-123',
  'CO_OCCURS',
  20,
);

await service.close();
```

## Pipeline Integration

### Enrichment Worker

After enriching chunks, the enrichment worker enqueues a knowledge graph job:

```typescript
// In enrichment-worker.ts
if (config.knowledgeGraph.enabled) {
  const kgData: KnowledgeGraphJobData = {
    indexId,
    documentId,
    chunkIds,
    tenantId,
  };

  await kgQueue.add('kg:${documentId}', kgData, {
    jobId: `kg:${indexId}:${documentId}`,
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}
```

### Knowledge Graph Worker

Processes chunks in parallel:

1. Load chunks from MongoDB
2. Extract entities and references (per chunk)
3. Upsert entities to Neo4j (batch)
4. Run co-occurrence analysis (if enabled)
5. Create CO_OCCURS relationships
6. Update chunk metadata with entity/reference info

## Performance

### Cost

- **Entity Extraction**: ~$0.00002/chunk (compromise is free)
- **Neo4j Storage**: ~$0.10/GB/month (managed service)
- **Pipeline Latency**: +500-1000ms per document (parallel with embedding)

### Throughput

- **Entity Extraction**: ~200 chunks/sec (compromise)
- **Neo4j Writes**: ~1000 entities/sec (batched upserts)
- **Co-occurrence Analysis**: O(n²) per document (mitigated by chunking)

### Optimization

- **Batch Processing**: Process multiple chunks per job
- **Parallel Workers**: Run 3-5 knowledge graph workers concurrently
- **Neo4j Indexes**: Automatically created on initialization
- **Connection Pooling**: Reuse Neo4j driver connections

## Data Model

### Entity Node

```typescript
{
  id: string; // UUID
  text: string; // Entity text (e.g., "Microsoft")
  type: string; // Entity type (e.g., "ORGANIZATION")
  tenantId: string; // Tenant ID (isolation)
  indexId: string; // Index ID
  documentId: string; // First document where seen
  chunkId: string; // First chunk where seen
  firstSeenAt: Date; // First occurrence timestamp
  lastSeenAt: Date; // Last occurrence timestamp
  occurrenceCount: number; // Total occurrences
  idf: number; // IDF score
}
```

### Relationship Edge

```typescript
{
  type: 'CO_OCCURS' | 'REFERENCES';
  tenantId: string;        // Tenant ID
  indexId: string;         // Index ID
  weight: number;          // IDF-weighted score
  count: number;           // Number of co-occurrences
  metadata: {
    frequency: number;
    chunkIds: string[];
    entity1Idf: number;
    entity2Idf: number;
  };
}
```

### Constraints

```cypher
// Unique constraint on entity
CREATE CONSTRAINT entity_unique IF NOT EXISTS
FOR (e:Entity)
REQUIRE (e.tenantId, e.indexId, e.type, e.text) IS UNIQUE;

// Index on entity ID
CREATE INDEX entity_id_idx IF NOT EXISTS
FOR (e:Entity)
ON (e.id);

// Index on tenant/index for isolation
CREATE INDEX entity_tenant_idx IF NOT EXISTS
FOR (e:Entity)
ON (e.tenantId, e.indexId);

// Index on entity type
CREATE INDEX entity_type_idx IF NOT EXISTS
FOR (e:Entity)
ON (e.type);
```

## Testing

Run tests:

```bash
cd apps/search-ai
pnpm test knowledge-graph
```

Test coverage:

- Entity extraction (regex, compromise, hybrid)
- Reference extraction (contracts, exhibits, sections, etc.)
- Co-occurrence analysis (IDF calculation, weighting)
- Deduplication and filtering
- Type distribution and statistics

## Troubleshooting

### Neo4j Connection Errors

**Error**: `Neo4j driver not initialized`

**Solution**: Ensure Neo4j is running and `KNOWLEDGE_GRAPH_ENABLED=true`

```bash
docker ps | grep neo4j
```

### High Memory Usage

**Issue**: Co-occurrence analysis uses O(n²) memory

**Solution**: Process documents in smaller batches, reduce `KNOWLEDGE_GRAPH_COOCCURRENCE_WINDOW`

### Missing Entities

**Issue**: Entities not extracted

**Solution**: Check extraction method:

- `regex`: Only structured entities (email, URL, date, money)
- `compromise`: Semantic entities (person, org, location)
- `hybrid`: Both (recommended)

### Slow Ingestion

**Issue**: Knowledge graph worker slows pipeline

**Solution**:

- Increase `concurrency` for knowledge graph worker
- Disable co-occurrence analysis: `KNOWLEDGE_GRAPH_ENABLE_COOCCURRENCE=false`
- Run fewer workers if Neo4j connection limit reached

## Implementation Status

### ✅ Phase 1 Complete (February 2026)

- ✅ Entity extraction (regex + compromise)
- ✅ Reference extraction
- ✅ Co-occurrence analysis
- ✅ Neo4j storage
- ✅ Tenant isolation
- ✅ Service layer API (`findRelatedEntities()`, `getGraphStats()`)
- ✅ Queryable via Neo4j Browser (Cypher)

### 🚧 Phase 2 Planned (Q2 2026)

- LLM-based entity extraction (higher quality, more types)
- Relationship type classification (beyond CO_OCCURS)
- Entity resolution (merge duplicates: "Microsoft" = "Microsoft Corp")
- Cross-index entity linking

### 🚧 Phase 3 Planned (Q3 2026)

- **Graph-based retrieval API** (REST endpoint: `POST /api/search/:indexId/graph`)
- **Entity-centric search** ("find all documents mentioning Microsoft")
- **Relationship-based ranking** (boost results connected to query entities)
- **Temporal graph analysis** (entity evolution over time)

See [../../docs/searchai/dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md](../../docs/searchai/dev-inprogress/GRAPH-RETRIEVAL-API-PLAN.md) for Phase 3 design details.

## References

- **ATLAS-KG**: Adaptive Topology & LLM-Augmented Structuring with Knowledge Graph
- **Neo4j Cypher**: https://neo4j.com/docs/cypher-manual/
- **Compromise NLP**: https://github.com/spencermountain/compromise
- **IDF Weighting**: https://en.wikipedia.org/wiki/Tf%E2%80%93idf

## Support

For questions or issues, contact the SearchAI team or file an issue in the repository.
