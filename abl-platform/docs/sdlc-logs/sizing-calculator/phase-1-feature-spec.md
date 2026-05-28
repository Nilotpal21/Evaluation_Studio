# SDLC Log: Sizing Calculator -- Phase 1 Feature Spec

**Date:** 2026-03-22
**Phase:** Feature Spec
**Feature:** sizing-calculator (#42)

## Codebase Analysis

### Existing Code Found

- `packages/sizing-calculator/` -- Full engine package with 28 source files
- `packages/kore-platform-cli/src/commands/sizing.ts` -- CLI entry point
- `docs/setup/topology-sizing-runbook.md` -- Operational runbook with k6 benchmarks

### Engine Architecture

The existing engine follows a clean pipeline pattern:

1. **Questionnaire** (8 sections, Zod-validated) -> **Tier Classifier** (S/M/L/XL)
2. Tier -> **Service Sizer** (11 app services) + **Compute Sizer** (BGE-M3, Docling, self-hosted LLM)
3. Tier -> **Datastore Sizer** (7 stores: MongoDB, Redis, ClickHouse, OpenSearch, Neo4j, Qdrant, Restate)
4. Questionnaire -> **Disk Growth Projector** (monthly/yearly per store)
5. Tier + Provider -> **Managed Recommender** (managed vs self-hosted per store)
6. All services -> **Node Pool Assembler** (general, compute, data, gpu pools)
7. ClusterTopology -> **Helm Values Generator** (per-service YAML files)

### Key Constants

- 4 cloud providers: AWS, Azure, GCP, on-prem
- 4 tiers: S (<=10 agents), M (<=100), L (<=1000), XL (>1000)
- 11 application services with per-tier baselines
- 7 data stores with per-tier sharding/replication/backup configs
- GPU support for 6 model types (llama-3.1-8b/70b/405b, mistral, mixtral, custom)

### Gaps Identified

1. No HTTP API layer (pure library)
2. No persistence (stateless)
3. No cost estimation
4. No Studio UI
5. No multi-export formats (only Helm YAML)
6. No tenant/project scoping
7. HA multiplier defined in constants but not applied in service sizer
8. Region count captured but not used for replication adjustment

## Decisions Made

| ID  | Decision                        | Classification                               |
| --- | ------------------------------- | -------------------------------------------- |
| D1  | API hosted in admin service     | DECIDED -- low traffic, admin operation      |
| D2  | Profiles are project-scoped     | DECIDED -- consistent with platform patterns |
| D3  | Cost data is static JSON        | DECIDED -- avoids runtime API key management |
| D4  | No custom service support in v1 | DECIDED -- scope control                     |
| D5  | PDF export is server-side       | DECIDED -- consistency across environments   |

## Feature Spec Summary

- **24 functional requirements** (FR-01 through FR-24)
- **8 non-functional requirements** (NFR-01 through NFR-08)
- **6 user stories** (US-1 through US-6)
- **5 non-goals** identified
- **3-phase rollout**: ALPHA (API+CLI) -> BETA (Studio UI) -> STABLE (cost+profiles+exports)
