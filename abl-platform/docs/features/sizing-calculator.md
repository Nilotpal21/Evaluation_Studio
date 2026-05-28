# Feature Spec: Sizing Calculator

**Feature ID:** #42
**Status:** ALPHA
**Author:** SDLC Pipeline
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Problem Statement

Deploying the ABL Platform to production Kubernetes environments requires careful infrastructure sizing across 11+ application services, 7 data stores, and multiple node pools. Today, platform operators must manually estimate CPU, memory, storage, replicas, sharding, and backup configurations based on scattered documentation and tribal knowledge. This leads to:

- **Over-provisioning** (wasted cloud spend, typically 40-60% of allocated resources unused)
- **Under-provisioning** (latency spikes, OOM kills, degraded user experience)
- **Inconsistent deployments** (different operators size differently for identical workloads)
- **No growth planning** (no visibility into disk growth trajectories or when capacity will be exhausted)

The Sizing Calculator solves this by providing a deterministic, questionnaire-driven engine that takes workload characteristics as input and produces a complete Kubernetes cluster topology with Helm values, node pool definitions, and operational recommendations.

---

## 2. Background & Context

### Existing Implementation

A `packages/sizing-calculator` package already exists with a functional core engine:

- **Questionnaire schema** (`questionnaire.schema.ts`): 8-section Zod schema covering deployment, LLM, agents, knowledge base, workflows, channels, observability, and retention
- **Tier classifier** (`tier-classifier.ts`): Classifies workloads into S/M/L/XL tiers based on 5 dimensions (agents, concurrent conversations, documents, messages/day, workflow executions/day)
- **Service sizer** (`service-sizer.ts`): Sizes 11 application services (runtime, studio, admin, search-ai, etc.) with workload-aware replica adjustment
- **Compute sizer** (`compute-sizer.ts`): Sizes compute-intensive services (BGE-M3, Docling) and self-hosted LLM with GPU requirements
- **Datastore sizer** (`datastore-sizer.ts`): Sizes 7 data stores (MongoDB, Redis, ClickHouse, OpenSearch, Neo4j, Qdrant, Restate) with sharding, replication, and TTL policies
- **Disk growth projector** (`disk-growth.ts`): Projects monthly/yearly disk growth per data store
- **Managed recommender** (`managed-recommender.ts`): Recommends managed vs self-hosted for each data store
- **Helm values generator** (`helm-values.ts`): Generates Helm YAML for all services and operators
- **CLI command** (`packages/kore-platform-cli/src/commands/sizing.ts`): CLI entry point for the calculator

### What's Missing

The existing engine is a pure computation library. It lacks:

1. **HTTP API** -- No REST endpoints to expose the calculator to Studio or external consumers
2. **Studio UI** -- No visual interface for the questionnaire or topology visualization
3. **Persistence** -- No ability to save, compare, or version sizing profiles
4. **Cost estimation** -- No cloud cost projections based on instance types and regions
5. **Validation feedback** -- No guided validation or contextual help during questionnaire completion
6. **Export formats** -- Only Helm YAML; no Terraform, Pulumi, or PDF report export
7. **Benchmark integration** -- No connection to actual k6 benchmark results for calibration
8. **Multi-region support** -- Tier classifier doesn't factor in region count for HA multipliers
9. **Tenant-scoped profiles** -- No multi-tenancy support for saved configurations

---

## 3. Goals

| ID  | Goal                                                                 | Success Metric                                                                            |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| G1  | Expose sizing calculator via REST API                                | API returns valid ClusterTopology for all 4 tiers within 200ms p99                        |
| G2  | Provide Studio UI for questionnaire input and topology visualization | Users complete questionnaire in under 5 minutes; topology renders correctly for all tiers |
| G3  | Enable persistence of sizing profiles per tenant/project             | Profiles CRUD operations work with tenant isolation                                       |
| G4  | Add cloud cost estimation                                            | Cost estimates within 20% of actual cloud billing for standard configurations             |
| G5  | Support multiple export formats                                      | Helm YAML, Terraform HCL, and PDF report exports functional                               |
| G6  | Integrate with benchmark results                                     | Sizing recommendations reference actual benchmark data when available                     |

---

## 4. Non-Goals

| ID  | Non-Goal                                               | Reason                                                                                    |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| NG1 | Auto-provisioning infrastructure                       | Out of scope -- calculator produces recommendations, not infrastructure-as-code execution |
| NG2 | Real-time monitoring integration                       | Observatory feature handles monitoring; calculator is a planning tool                     |
| NG3 | Custom data store support                              | Only the 7 platform data stores are sized; custom stores require manual sizing            |
| NG4 | Fine-grained per-tenant sizing within a shared cluster | Calculator sizes the cluster; per-tenant resource quotas are a separate concern           |
| NG5 | GPU model fine-tuning recommendations                  | Calculator sizes inference infrastructure; training/fine-tuning is out of scope           |

---

## 5. User Stories

### US-1: Platform Operator -- Initial Sizing

**As a** platform operator deploying ABL for the first time,
**I want to** answer a questionnaire about my expected workload,
**So that** I receive a complete K8s topology with Helm values I can directly apply.

**Acceptance Criteria:**

- Questionnaire covers all 8 sections (deployment, LLM, agents, KB, workflows, channels, observability, retention)
- Topology output includes services, data stores, node pools, disk growth, managed recommendations
- Helm values are syntactically valid YAML
- Output is downloadable as a ZIP archive

### US-2: Platform Operator -- Growth Planning

**As a** platform operator managing a running ABL deployment,
**I want to** see disk growth projections and scaling triggers,
**So that** I can plan capacity expansions before hitting limits.

**Acceptance Criteria:**

- Monthly and yearly growth projections per data store
- Visual chart showing growth over 12 months
- Alerts when projected growth exceeds current provisioned storage within 3 months

### US-3: Solutions Architect -- Cost Comparison

**As a** solutions architect evaluating ABL for a customer,
**I want to** compare sizing and costs across cloud providers and tiers,
**So that** I can present accurate infrastructure cost estimates.

**Acceptance Criteria:**

- Side-by-side comparison of 2+ configurations
- Cost breakdown by service category (compute, storage, network, managed services)
- Export to PDF for customer presentation

### US-4: Platform Operator -- Profile Management

**As a** platform operator,
**I want to** save and version my sizing profiles,
**So that** I can track how my sizing requirements evolve over time.

**Acceptance Criteria:**

- CRUD operations on sizing profiles with tenant isolation
- Version history with diff view between versions
- Ability to duplicate and modify existing profiles

### US-5: DevOps Engineer -- Helm Export

**As a** DevOps engineer,
**I want to** export sizing results as Helm values files,
**So that** I can directly use them in my GitOps deployment pipeline.

**Acceptance Criteria:**

- Separate YAML files per service/operator (app-services.yaml, mongodb-operator.yaml, etc.)
- Node pool configuration compatible with Karpenter and cluster-autoscaler
- Values compatible with the platform's Helm charts in abl-platform-deploy repo

### US-6: CLI User -- Headless Sizing

**As a** CI/CD pipeline operator,
**I want to** run the sizing calculator from the CLI with a JSON input file,
**So that** I can automate sizing as part of my deployment pipeline.

**Acceptance Criteria:**

- `pnpm cli sizing calculate --input questionnaire.json --output topology.json`
- `pnpm cli sizing export --input topology.json --format helm --output ./values/`
- Exit codes and JSON output for pipeline integration

---

## 6. Functional Requirements

| ID    | Requirement                                                                                  | Priority | User Story |
| ----- | -------------------------------------------------------------------------------------------- | -------- | ---------- |
| FR-01 | REST API: `POST /api/sizing/calculate` accepts Questionnaire, returns ClusterTopology        | P0       | US-1       |
| FR-02 | REST API: `GET /api/sizing/tiers` returns tier boundary definitions                          | P1       | US-3       |
| FR-03 | REST API: `POST /api/sizing/compare` accepts 2+ questionnaires, returns comparison           | P1       | US-3       |
| FR-04 | REST API: `POST /api/sizing/export` accepts ClusterTopology + format, returns exported files | P0       | US-5       |
| FR-05 | Profile CRUD: `POST/GET/PUT/DELETE /api/projects/:projectId/sizing-profiles`                 | P1       | US-4       |
| FR-06 | Profile versioning: Each save creates a new version; list versions, get specific version     | P2       | US-4       |
| FR-07 | Questionnaire validation with field-level error messages and contextual hints                | P0       | US-1       |
| FR-08 | Tier classification with breakdown showing which dimensions drove the tier selection         | P0       | US-1       |
| FR-09 | Disk growth projections with monthly granularity for 12 months                               | P0       | US-2       |
| FR-10 | Managed vs self-hosted recommendation with reasoning per data store                          | P0       | US-1       |
| FR-11 | Cloud cost estimation using instance type pricing data                                       | P1       | US-3       |
| FR-12 | Helm YAML export with per-service and per-operator value files                               | P0       | US-5       |
| FR-13 | Terraform HCL export for node pool and managed service provisioning                          | P2       | US-5       |
| FR-14 | PDF report export with topology summary, cost breakdown, growth charts                       | P2       | US-3       |
| FR-15 | Studio UI: Multi-step questionnaire form with section navigation                             | P0       | US-1       |
| FR-16 | Studio UI: Topology visualization showing services, data stores, node pools                  | P1       | US-1       |
| FR-17 | Studio UI: Disk growth chart (line chart, 12-month projection)                               | P1       | US-2       |
| FR-18 | Studio UI: Cost comparison table with provider/tier matrix                                   | P2       | US-3       |
| FR-19 | CLI: `sizing calculate` command with JSON input/output                                       | P0       | US-6       |
| FR-20 | CLI: `sizing export` command with format selection (helm, terraform, json)                   | P1       | US-6       |
| FR-21 | Tenant isolation: All profile operations scoped to tenantId                                  | P0       | US-4       |
| FR-22 | HA multiplier application: Maximum HA multiplies replica counts by 1.5x                      | P0       | US-1       |
| FR-23 | Multi-region awareness: Region count affects node pool sizing and data store replication     | P1       | US-1       |
| FR-24 | Compliance-driven defaults: HIPAA/PCI/FedRAMP set encryption, retention, backup minimums     | P1       | US-1       |

---

## 7. Non-Functional Requirements

| ID     | Requirement                                                                    | Target           |
| ------ | ------------------------------------------------------------------------------ | ---------------- |
| NFR-01 | API latency: Calculate endpoint p99 < 200ms                                    | 200ms            |
| NFR-02 | API latency: Export endpoint p99 < 500ms (Helm), < 2s (PDF)                    | 500ms / 2s       |
| NFR-03 | Availability: API available when admin service is healthy                      | 99.9%            |
| NFR-04 | Questionnaire schema validation < 10ms                                         | 10ms             |
| NFR-05 | No external service dependencies for core calculation (pure compute)           | 0 external calls |
| NFR-06 | Profile storage: Support up to 1000 profiles per tenant                        | 1000             |
| NFR-07 | Export file size: Helm bundle < 50KB, PDF < 5MB                                | 50KB / 5MB       |
| NFR-08 | Concurrent API requests: 100 concurrent calculate requests without degradation | 100 RPS          |

---

## 8. Technical Approach (High-Level)

### Architecture

```
Studio UI ─── REST API (Admin) ─── Sizing Calculator Engine (pure TS)
                  │
                  ├── Profile Store (MongoDB)
                  ├── Cost Data (static JSON, refreshed monthly)
                  └── Export Generators (Helm, Terraform, PDF)
```

### Key Design Decisions

1. **Engine stays pure** -- The `packages/sizing-calculator` package remains a pure TypeScript library with zero I/O dependencies. API/persistence/export are layered on top.
2. **Admin service hosts the API** -- Sizing is an admin operation; routes go under `apps/admin/src/routes/sizing/`.
3. **Profile model in MongoDB** -- SizingProfile with `tenantId`, `projectId`, `name`, `questionnaire`, `topology`, `versions[]`.
4. **Static cost data** -- Cloud pricing is stored as a static JSON file updated monthly via a script, not fetched at runtime.
5. **Helm export reuses existing generator** -- The `generateHelmValues()` function in the package is reused directly.

---

## 9. Data Model

### SizingProfile

```typescript
interface SizingProfile {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  questionnaire: Questionnaire;
  topology: ClusterTopology;
  costEstimate?: CostEstimate;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### CostEstimate

```typescript
interface CostEstimate {
  provider: string;
  region: string;
  monthlyTotal: number;
  breakdown: {
    compute: number;
    storage: number;
    network: number;
    managedServices: number;
  };
  currency: string;
}
```

---

## 10. API Design

| Method | Path                                           | Description                           |
| ------ | ---------------------------------------------- | ------------------------------------- |
| POST   | `/api/sizing/calculate`                        | Calculate topology from questionnaire |
| POST   | `/api/sizing/export`                           | Export topology in specified format   |
| POST   | `/api/sizing/compare`                          | Compare multiple configurations       |
| GET    | `/api/sizing/tiers`                            | Get tier boundary definitions         |
| POST   | `/api/projects/:projectId/sizing-profiles`     | Create sizing profile                 |
| GET    | `/api/projects/:projectId/sizing-profiles`     | List sizing profiles                  |
| GET    | `/api/projects/:projectId/sizing-profiles/:id` | Get sizing profile                    |
| PUT    | `/api/projects/:projectId/sizing-profiles/:id` | Update sizing profile                 |
| DELETE | `/api/projects/:projectId/sizing-profiles/:id` | Delete sizing profile                 |

---

## 11. Security Considerations

- **Authentication**: All endpoints require `requireAuth` middleware
- **Authorization**: Profile endpoints use `requireProjectPermission(req, res, 'sizing-profile:read/write')`
- **Tenant isolation**: All profile queries include `tenantId` in the filter; cross-tenant returns 404
- **Input validation**: Questionnaire validated via Zod schema before processing
- **No secrets in output**: Helm values contain resource specs only, never credentials
- **Rate limiting**: Calculate endpoint limited to 10 req/min per tenant (compute-intensive)

---

## 12. Observability

- **Structured logging**: `createLogger('sizing-calculator')` for all API handlers
- **Trace events**: `TraceEvent` emitted for each calculation with tier, provider, and timing
- **Metrics**: Calculation latency histogram, tier distribution counter, export format counter
- **Audit log**: Profile create/update/delete logged with userId and tenantId

---

## 13. Error Handling

| Error Case                | HTTP Status | Error Code              | Message                                                  |
| ------------------------- | ----------- | ----------------------- | -------------------------------------------------------- |
| Invalid questionnaire     | 400         | `INVALID_QUESTIONNAIRE` | Zod validation errors with field paths                   |
| Profile not found         | 404         | `PROFILE_NOT_FOUND`     | "Sizing profile not found"                               |
| Cross-tenant access       | 404         | `PROFILE_NOT_FOUND`     | Same as not found (no existence leak)                    |
| Unsupported export format | 400         | `UNSUPPORTED_FORMAT`    | "Export format '{format}' is not supported"              |
| Rate limited              | 429         | `RATE_LIMITED`          | "Too many sizing calculations. Try again in {n} seconds" |

---

## 14. Migration & Rollout

- **Phase 1 (ALPHA)**: API endpoints + CLI integration, no UI
- **Phase 2 (BETA)**: Studio UI questionnaire + topology display
- **Phase 3 (STABLE)**: Cost estimation, profile persistence, export formats

---

## 15. Dependencies

| Dependency                          | Type             | Impact                                  |
| ----------------------------------- | ---------------- | --------------------------------------- |
| `@agent-platform/sizing-calculator` | Internal package | Core engine -- already exists           |
| `apps/admin`                        | Internal app     | Hosts the REST API routes               |
| `packages/database`                 | Internal package | MongoDB models for profile persistence  |
| `zod`                               | External library | Questionnaire validation (already used) |
| `apps/studio`                       | Internal app     | UI for questionnaire and visualization  |

---

## 16. Testing Strategy

- **Unit tests**: Engine functions (tier classifier, service sizer, etc.) -- 9 test files already exist
- **Integration tests**: API endpoints with real Express middleware chain (auth, validation, tenant isolation)
- **E2E tests**: Full flow from questionnaire submission to topology retrieval to Helm export via HTTP
- **Property-based tests**: Verify monotonicity (larger workload -> larger topology) across random inputs
- **Snapshot tests**: Golden-file tests for Helm YAML output stability

---

## 17. Open Questions

| ID   | Question                                                                 | Status  | Resolution                                                               |
| ---- | ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------ |
| OQ-1 | Should cost data be fetched from cloud APIs or static files?             | DECIDED | Static files updated monthly -- avoids runtime API key management        |
| OQ-2 | Should the calculator support custom services beyond the 11+7 built-in?  | DECIDED | No -- custom services are out of scope for v1                            |
| OQ-3 | Where should the API live -- admin service or a standalone microservice? | DECIDED | Admin service -- sizing is an admin operation with low traffic           |
| OQ-4 | Should profiles be project-scoped or tenant-scoped?                      | DECIDED | Project-scoped with tenant isolation (consistent with platform patterns) |
| OQ-5 | Should the PDF export use server-side rendering or client-side?          | DECIDED | Server-side via a lightweight HTML-to-PDF library for consistency        |

---

## 18. References

- Existing engine: `packages/sizing-calculator/src/`
- CLI command: `packages/kore-platform-cli/src/commands/sizing.ts`
- Topology sizing runbook: `docs/setup/topology-sizing-runbook.md`
- Platform deploy repo: `abl-platform-deploy` (Helm charts)
- Infrastructure repo: `abl-platform-infra` (Terraform)
