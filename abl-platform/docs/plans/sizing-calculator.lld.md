# Sizing Calculator — Low-Level Design

## Implementation Structure

The sizing calculator is a pure TypeScript package organized into 3 layers: schemas (input validation), engine (computation), and generators (output formatting). All functions are stateless and deterministic. The package exports 5 public functions and 2 types.

## Key Files

| File                                                             | Purpose                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sizing-calculator/src/schemas/questionnaire.schema.ts` | Zod schema with 8 sections: deployment, LLM, agents, knowledge base, workflows, channels, observability, retention                                                        |
| `packages/sizing-calculator/src/engine/tier-classifier.ts`       | `classifyTier()`: highest-tier-wins across 5 dimensions. Tier boundaries: S (10 agents/1K conv), M (100/50K), L (1K/500K), XL (above L)                                   |
| `packages/sizing-calculator/src/engine/service-sizer.ts`         | `sizeApplicationServices()`: iterates `APPLICATION_SERVICES` constant, applies tier baselines, adjusts replicas for workload, configures HPA                              |
| `packages/sizing-calculator/src/engine/compute-sizer.ts`         | `sizeComputeServices()`: BGE-M3 embedding, Docling OCR, Preprocessing, Crawlers, GPU services with self-hosted model scaling                                              |
| `packages/sizing-calculator/src/engine/datastore-sizer.ts`       | `sizeDataStores()`: 7 individual sizer functions (MongoDB, Redis, ClickHouse, OpenSearch, Neo4j, Qdrant, Restate) with sharding, replication, TTL, backup                 |
| `packages/sizing-calculator/src/engine/disk-growth.ts`           | `calculateDiskGrowth()`: per-store monthly/yearly GB projections based on retention settings and message/document volumes                                                 |
| `packages/sizing-calculator/src/engine/managed-recommender.ts`   | `recommendManagedServices()`: static rules per store/provider/tier. Air-gapped=self-hosted, Restate=always self-hosted                                                    |
| `packages/sizing-calculator/src/engine/constants.ts`             | `INSTANCE_TYPES` (4 providers x pool types x tiers), `NODE_POOL_SIZING` (min/max nodes per tier), `APPLICATION_SERVICES` (per-service specs per tier), `DATA_STORE_SPECS` |
| `packages/sizing-calculator/src/engine/calculator.ts`            | `calculateTopology()`: orchestrates all sizers + node pool assembly                                                                                                       |
| `packages/sizing-calculator/src/generators/helm-values.ts`       | `generateHelmValues()`: produces YAML strings for app-services, per-store operators, node-pools                                                                           |
| `packages/sizing-calculator/src/index.ts`                        | Public exports: QuestionnaireSchema, classifyTier, calculateTopology, generateHelmValues, recommendManagedServices                                                        |

## Key Tier Boundaries

| Dimension                | S (max) | M (max) | L (max)   | XL     |
| ------------------------ | ------- | ------- | --------- | ------ |
| Agents                   | 10      | 100     | 1,000     | >1,000 |
| Concurrent conversations | 1,000   | 50,000  | 500,000   | >500K  |
| Documents                | 10,000  | 500,000 | 5,000,000 | >5M    |
| Messages/day             | 10,000  | 500,000 | 5,000,000 | >5M    |
| Workflow executions/day  | 1,000   | 100,000 | 1,000,000 | >1M    |

## Test Files

| File                                         | Scenarios                                      |
| -------------------------------------------- | ---------------------------------------------- |
| `src/__tests__/tier-classifier.test.ts`      | S/M/L/XL classification, boundary conditions   |
| `src/__tests__/calculator.test.ts`           | Full topology, node pool assembly, total nodes |
| `src/__tests__/service-sizer.test.ts`        | Baseline + workload adjustments, HPA           |
| `src/__tests__/compute-sizer.test.ts`        | BGE-M3, Docling, GPU sizing                    |
| `src/__tests__/datastore-sizer.test.ts`      | 7 stores, sharding, replication                |
| `src/__tests__/disk-growth.test.ts`          | Monthly/yearly projections                     |
| `src/__tests__/managed-recommender.test.ts`  | Air-gapped, provider-specific, Restate         |
| `src/__tests__/helm-values.test.ts`          | YAML output structure                          |
| `src/__tests__/questionnaire.schema.test.ts` | Valid/invalid input                            |
| `src/__tests__/topology.types.test.ts`       | Type structure                                 |

## Known Gaps

| ID      | Gap                                                     | Severity | Notes                          |
| ------- | ------------------------------------------------------- | -------- | ------------------------------ |
| GAP-001 | No UI for questionnaire input                           | Medium   | Package is programmatic-only   |
| GAP-002 | On-prem instance types are generic (e.g., "4vCPU-16Gi") | Low      | Not mapped to real hardware    |
| GAP-003 | No cost estimation layer                                | Medium   | Topology output has no pricing |
