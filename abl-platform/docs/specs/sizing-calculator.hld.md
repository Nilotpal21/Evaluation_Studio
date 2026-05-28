# High-Level Design: Sizing Calculator

**Feature:** sizing-calculator (#42)
**Status:** PLANNED
**Author:** SDLC Pipeline
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Overview

The Sizing Calculator provides infrastructure sizing recommendations for ABL Platform Kubernetes deployments. It takes workload characteristics as input (agent count, conversation volume, document count, etc.) and produces a complete cluster topology with per-service resource specs, data store configurations, node pool definitions, disk growth projections, and Helm values.

### Current State

A pure TypeScript engine exists in `packages/sizing-calculator/` with:

- Zod-validated questionnaire schema (8 sections)
- Tier classifier (S/M/L/XL based on 5 dimensions)
- Service sizer (11 application services), compute sizer (BGE-M3, Docling, self-hosted LLM), datastore sizer (7 stores)
- Disk growth projector, managed service recommender, Helm values generator
- 9 unit test files

### What This HLD Adds

This design introduces the HTTP API layer, profile persistence, export system, and Studio UI integration on top of the existing engine.

---

## 2. Architecture

### System Context

```
                    +------------------+
                    |    Studio UI     |
                    | (React, Next.js) |
                    +--------+---------+
                             |
                             | HTTP (REST)
                             v
+----------+     +---------------------------+     +------------------+
|  CLI     |---->|    Admin Service           |---->|  MongoDB         |
| (sizing) |     |  /api/sizing/*            |     |  (profiles)      |
+----------+     |  /api/projects/:pid/      |     +------------------+
                 |    sizing-profiles/*       |
                 +------------+---------------+
                              |
                              | imports
                              v
                 +---------------------------+
                 | @agent-platform/           |
                 |   sizing-calculator        |
                 | (pure TS engine, no I/O)   |
                 +---------------------------+
```

### Component Architecture

```
apps/admin/src/routes/sizing/
  ├── sizing.router.ts          # Route registration
  ├── sizing.controller.ts      # Request handling, validation
  ├── sizing.service.ts         # Business logic orchestration
  └── sizing-profile.repo.ts    # MongoDB data access

packages/sizing-calculator/
  ├── src/engine/               # Core calculation engine (existing)
  ├── src/schemas/              # Zod schemas (existing)
  ├── src/types/                # Type definitions (existing)
  ├── src/generators/           # Export generators (existing + new)
  │   ├── helm-values.ts        # Existing Helm generator
  │   └── terraform-hcl.ts      # NEW: Terraform export
  └── src/cost/                 # NEW: Cost estimation
      ├── pricing-data.ts       # Static pricing data
      └── cost-estimator.ts     # Cost calculation

apps/studio/src/
  ├── app/sizing/               # NEW: Sizing pages
  │   ├── page.tsx              # Main sizing page
  │   └── [profileId]/page.tsx  # Profile detail page
  ├── components/sizing/        # NEW: Sizing components
  │   ├── QuestionnaireForm.tsx  # Multi-step form
  │   ├── TopologyView.tsx       # Topology visualization
  │   ├── DiskGrowthChart.tsx    # Growth projection chart
  │   └── ExportPanel.tsx        # Export options
  └── store/sizing-store.ts     # NEW: Zustand store
```

---

## 3. Alternatives Considered

### Alternative 1: Standalone Sizing Microservice

**Description:** Deploy the sizing calculator as its own microservice with dedicated API and database.

**Pros:**

- Independent scaling and deployment
- Clear service boundary
- Could serve external consumers without admin auth

**Cons:**

- Operational overhead of another service (deploy pipeline, monitoring, Docker image)
- Low traffic doesn't justify dedicated infra (sizing is an occasional operation)
- Requires cross-service auth for profile access

**Decision:** REJECTED. The sizing calculator is a low-traffic admin operation. Hosting in the admin service avoids operational overhead while still maintaining clear code separation via the router/service/repo layering.

### Alternative 2: Client-Side-Only Calculation

**Description:** Run the sizing engine entirely in the browser (the package is pure TS with no I/O).

**Pros:**

- Zero server load for calculations
- Instant results, no network latency
- Works offline

**Cons:**

- Cannot persist profiles without an API
- Cannot enforce rate limiting or tenant isolation
- Bundle size increase (~50KB for the engine)
- CLI and external consumers need a different path

**Decision:** REJECTED for primary path, but NOTED for future enhancement. The engine could be bundled for offline/preview use while the API remains the source of truth for persistence and export.

### Alternative 3: GraphQL API Instead of REST

**Description:** Expose sizing operations via GraphQL for flexible querying.

**Pros:**

- Clients can request exactly the fields they need
- Single endpoint for all operations
- Built-in type system

**Cons:**

- Overkill for 5 operations -- REST is simpler and well-understood
- No existing GraphQL infrastructure in the platform
- Adds complexity without proportional benefit

**Decision:** REJECTED. REST is the platform standard. GraphQL introduces unnecessary complexity for a feature with a small, fixed API surface.

---

## 4. Architectural Concerns

### 4.1 Resource Isolation

**Tenant Isolation:**

- All sizing profile queries include `tenantId` in the MongoDB filter
- Use `findOne({ _id, tenantId, projectId })`, never `findById()`
- Cross-tenant access returns 404 (not 403) to prevent existence leaking
- The calculate/export/compare endpoints are tenant-scoped via auth middleware but don't persist data

**Project Isolation:**

- Profile CRUD routes are under `/api/projects/:projectId/sizing-profiles`
- `requireProjectPermission(req, res, 'sizing-profile:read')` enforced on all profile routes
- Every query includes `projectId` from the route parameter

**User Isolation:**

- Profile `createdBy` field tracks ownership
- List endpoint filters by `createdBy` unless user has admin permission

### 4.2 Authentication & Authorization

**Authentication:**

- All endpoints use `requireAuth` from `createUnifiedAuthMiddleware`
- No custom token verification
- JWT token provides `tenantId`, `userId`, and permissions

**Authorization:**

- Calculate/export/compare: Require `sizing:calculate` permission
- Profile CRUD: Require `sizing-profile:read` or `sizing-profile:write` per operation
- Tier info: Require basic auth (any authenticated user)

**Permission Matrix:**

| Endpoint                   | Permission           | Admin | Operator | Viewer |
| -------------------------- | -------------------- | ----- | -------- | ------ |
| POST /api/sizing/calculate | sizing:calculate     | Y     | Y        | N      |
| POST /api/sizing/export    | sizing:calculate     | Y     | Y        | N      |
| POST /api/sizing/compare   | sizing:calculate     | Y     | Y        | N      |
| GET /api/sizing/tiers      | (authenticated)      | Y     | Y        | Y      |
| POST profiles              | sizing-profile:write | Y     | Y        | N      |
| GET profiles               | sizing-profile:read  | Y     | Y        | Y      |
| PUT profiles               | sizing-profile:write | Y     | Y        | N      |
| DELETE profiles            | sizing-profile:write | Y     | N        | N      |

### 4.3 Stateless & Distributed

- **Engine is pure compute** -- no state, no I/O, no caching needed. Deterministic output for identical input.
- **Profile persistence via MongoDB** -- no pod-local state for profiles
- **No distributed locks needed** -- profile updates are low-contention (one user edits at a time; last-write-wins with optimistic concurrency via version field)
- **Rate limiting via Redis** -- tenant-level rate limit counters stored in Redis with TTL

### 4.4 Traceability

- **TraceEvent emission:**
  - `sizing.calculate` -- emitted on each calculation with `{ tier, cloudProvider, durationMs }`
  - `sizing.export` -- emitted with `{ format, fileCount, durationMs }`
  - `sizing.profile.create/update/delete` -- emitted with `{ profileId, projectId }`
- **Structured logging:**
  - `createLogger('sizing')` for all handlers
  - Log level: INFO for successful operations, WARN for validation failures, ERROR for unexpected errors
- **Audit logging:**
  - Profile mutations logged to audit log collection with `userId`, `tenantId`, `action`, `resourceId`

### 4.5 Compliance

- **No PII in questionnaire or topology** -- all inputs are numeric/enum workload characteristics
- **No secrets in output** -- Helm values contain resource specs and node labels, never credentials or connection strings
- **Encryption at rest** -- profiles stored in MongoDB which is encrypted at rest per platform standard
- **Encryption in transit** -- HTTPS for all API calls
- **Data retention** -- profiles follow tenant data retention policy; no independent TTL needed
- **Right to erasure** -- profile deletion is a hard delete; no cascade needed (profiles are self-contained documents)

### 4.6 Performance

- **Calculation is O(1) per tier** -- fixed number of services and data stores; no loops proportional to input values
- **p99 target: 200ms** for calculate endpoint (engine executes in <5ms; overhead is HTTP parsing, auth, and serialization)
- **Export is O(n)** where n = number of services (typically 18) -- trivially fast
- **No caching needed** -- computation is deterministic and fast; caching adds complexity without benefit
- **Rate limiting** -- 10 requests/minute per tenant prevents abuse of compute endpoint
- **Payload size** -- ClusterTopology JSON is ~15KB for XL tier; well within Express default limits

### 4.7 Scalability

- **Horizontal scaling** -- engine is stateless; admin service scales horizontally behind load balancer
- **Profile storage** -- 1000 profiles per tenant \* ~50KB/profile = ~50MB per tenant; trivial for MongoDB
- **No hot path** -- sizing is an occasional operation (once per deployment planning cycle), not on the request path of agent conversations
- **Multi-region** -- if admin service is deployed in multiple regions, profiles are replicated via MongoDB replica set

### 4.8 Reliability

- **Engine has zero external dependencies** -- calculation cannot fail due to network issues
- **Graceful degradation:**
  - If cost data file is missing, calculation succeeds without cost estimates (cost is optional P1 feature)
  - If MongoDB is down, calculate/export/compare still work (they don't need persistence); only profile CRUD fails
- **Input validation at boundary** -- Zod schema rejects invalid questionnaires before engine is invoked
- **Error envelope** -- all errors return `{ success: false, error: { code, message } }` per platform standard

### 4.9 Observability

- **Metrics (Prometheus):**
  - `sizing_calculate_duration_seconds` -- histogram
  - `sizing_calculate_tier_total` -- counter per tier (S/M/L/XL)
  - `sizing_export_format_total` -- counter per format (helm/terraform/json)
  - `sizing_profile_operations_total` -- counter per operation (create/read/update/delete)
- **Logging:**
  - `createLogger('sizing')` -- no `console.log`
  - Structured JSON logs with `tenantId`, `projectId`, `tier`, `durationMs`
- **Tracing:**
  - OpenTelemetry span for each API handler
  - Child spans for engine calculation and export generation

### 4.10 Data Model & Storage

**MongoDB Collection: `sizing_profiles`**

```typescript
{
  _id: ObjectId,
  tenantId: string,        // Indexed, required for isolation
  projectId: string,       // Indexed, required for project scoping
  name: string,            // User-provided name
  description: string,     // Optional description
  questionnaire: object,   // Full Questionnaire input
  topology: object,        // Full ClusterTopology output
  costEstimate: object?,   // Optional CostEstimate
  version: number,         // Optimistic concurrency control
  createdBy: string,       // userId
  createdAt: Date,
  updatedAt: Date
}

Indexes:
  - { tenantId: 1, projectId: 1 }           -- Primary query path
  - { tenantId: 1, projectId: 1, name: 1 }  -- Uniqueness constraint
  - { createdBy: 1 }                        -- User filtering
  - { createdAt: -1 }                       -- Ordering
```

**Storage Estimation:**

- Average profile size: ~50KB (questionnaire ~2KB + topology ~15KB + cost ~1KB + metadata ~2KB, with MongoDB overhead)
- 1000 profiles per tenant: ~50MB
- 100 tenants: ~5GB total -- negligible for MongoDB

### 4.11 API Design & Contracts

**Request/Response Contracts:**

```typescript
// POST /api/sizing/calculate
Request: { questionnaire: Questionnaire }
Response: { success: true, data: { topology: ClusterTopology, tierBreakdown: TierBreakdown } }

// POST /api/sizing/export
Request: { topology: ClusterTopology, format: 'helm' | 'terraform' | 'json' }
Response: { success: true, data: { files: Record<string, string> } }

// POST /api/sizing/compare
Request: { configurations: Questionnaire[] }  // 2-5 items
Response: { success: true, data: { results: ClusterTopology[] } }

// GET /api/sizing/tiers
Response: { success: true, data: { tiers: TierBoundary[] } }

// Profile CRUD follows standard REST conventions
// POST returns 201, GET/PUT returns 200, DELETE returns 200
// All responses wrapped in { success, data/error }
```

**TierBreakdown (new type):**

```typescript
interface TierBreakdown {
  tier: Tier;
  dimensions: {
    name: string;
    value: number;
    boundary: number;
    exceeds: boolean;
  }[];
  drivingDimension: string; // The dimension that caused the tier upgrade
}
```

### 4.12 Extensibility

- **New services:** Adding a service to `APPLICATION_SERVICES` or `COMPUTE_SERVICES` in constants.ts automatically includes it in topology output and Helm generation
- **New data stores:** Adding to `DATA_STORE_SPECS` and adding a `size*()` function follows the established pattern
- **New cloud providers:** Adding to `INSTANCE_TYPES` enables a new provider
- **New export formats:** Implement a new generator in `src/generators/` and register in the export controller
- **Custom tier boundaries:** The boundary thresholds are in `TIER_BOUNDARIES` -- configurable if moved to a config source
- **Plugin architecture (future):** The engine's pipeline pattern (classify -> size -> project -> recommend -> generate) allows inserting custom stages

---

## 5. Data Flow

### Calculate Flow

```
Client
  |
  | POST /api/sizing/calculate { questionnaire }
  v
Admin Router (sizing.router.ts)
  |
  | requireAuth, validate(QuestionnaireSchema)
  v
Sizing Controller
  |
  | Calls sizing.service.calculate()
  v
Sizing Service
  |
  | 1. classifyTier(questionnaire)          -> tier (S/M/L/XL)
  | 2. sizeApplicationServices(tier, q)      -> ServiceTopology[]
  | 3. sizeComputeServices(tier, q)          -> ServiceTopology[]
  | 4. sizeDataStores(tier, q)               -> DataStoreTopology[]
  | 5. calculateDiskGrowth(q)                -> DiskGrowthProjection[]
  | 6. recommendManagedServices(tier, q)     -> ManagedServiceRecommendation[]
  | 7. assembleNodePools(tier, provider, services, q) -> NodePool[]
  | 8. buildTierBreakdown(q)                 -> TierBreakdown
  v
Response: { topology: ClusterTopology, tierBreakdown: TierBreakdown }
```

### Export Flow

```
Client
  |
  | POST /api/sizing/export { topology, format: "helm" }
  v
Admin Router
  |
  | requireAuth, validate(ExportRequestSchema)
  v
Sizing Controller
  |
  | Dispatch to generator by format
  v
Generator
  |
  | helm -> generateHelmValues(topology) -> Record<string, string>
  | terraform -> generateTerraformHcl(topology) -> Record<string, string>
  | json -> JSON.stringify(topology) -> { "topology.json": string }
  v
Response: { files: Record<string, string> }
```

### Profile CRUD Flow

```
Client
  |
  | POST /api/projects/:projectId/sizing-profiles { name, questionnaire }
  v
Admin Router
  |
  | requireAuth, requireProjectPermission('sizing-profile:write')
  v
Sizing Controller
  |
  | 1. Validate questionnaire
  | 2. Calculate topology (reuse calculate logic)
  | 3. Save to MongoDB via sizing-profile.repo.ts
  v
MongoDB: sizing_profiles collection
  |
  | findOne({ _id, tenantId, projectId }) for reads
  | findOneAndUpdate({ _id, tenantId, projectId }) for updates
  | deleteOne({ _id, tenantId, projectId }) for deletes
  v
Response: { success: true, data: { profile } }
```

---

## 6. Error Handling Strategy

| Error Type               | Handler                   | Response                                            |
| ------------------------ | ------------------------- | --------------------------------------------------- |
| Zod validation failure   | Controller                | 400 `INVALID_QUESTIONNAIRE` with field-level errors |
| Unknown export format    | Controller                | 400 `UNSUPPORTED_FORMAT`                            |
| Profile not found        | Repo                      | 404 `PROFILE_NOT_FOUND`                             |
| Cross-tenant access      | Repo (query returns null) | 404 `PROFILE_NOT_FOUND`                             |
| Auth failure             | Middleware                | 401 `UNAUTHORIZED`                                  |
| Permission denied        | Middleware                | 403 `FORBIDDEN`                                     |
| Rate limit exceeded      | Middleware                | 429 `RATE_LIMITED`                                  |
| Unexpected engine error  | Service (try/catch)       | 500 `CALCULATION_ERROR`                             |
| MongoDB connection error | Repo (try/catch)          | 503 `SERVICE_UNAVAILABLE`                           |

All errors follow the platform envelope: `{ success: false, error: { code, message, details? } }`

---

## 7. Security Threat Model

| Threat                                      | Mitigation                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Malicious questionnaire with extreme values | Zod schema enforces min/max on all numeric fields                        |
| DoS via expensive calculations              | Rate limiting (10/min/tenant); engine is O(1) anyway                     |
| Cross-tenant data access                    | MongoDB queries always include tenantId; 404 on mismatch                 |
| Credential exposure in Helm output          | Engine never includes credentials; only resource specs                   |
| Information leakage via error messages      | Generic error messages; no stack traces in production                    |
| Profile enumeration                         | Profiles listed only within authenticated tenant/project scope           |
| Input injection in Helm YAML                | Values are numeric/string constants, not user-controlled strings in YAML |

---

## 8. Migration & Backward Compatibility

- **No breaking changes** -- this is a new feature, not a modification of existing code
- **Engine package is backward compatible** -- new exports are additive; existing `calculateTopology()` signature unchanged
- **Database migration** -- new `sizing_profiles` collection; no migration of existing data needed
- **API versioning** -- routes are new; no existing routes affected
- **CLI extension** -- new subcommands under `sizing`; existing CLI commands unchanged

---

## 9. Implementation Phases

| Phase                           | Scope                                                      | Exit Criteria                          |
| ------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| Phase 1: API Core               | Calculate endpoint, export endpoint (Helm), tiers endpoint | E2E-1, E2E-3, E2E-4, E2E-5, E2E-8 pass |
| Phase 2: Profile Persistence    | CRUD endpoints, MongoDB model, tenant/project isolation    | E2E-7 passes with cross-tenant 404     |
| Phase 3: Compare & Breakdown    | Compare endpoint, tier breakdown in calculate response     | E2E-2, E2E-6 pass                      |
| Phase 4: Studio UI              | Questionnaire form, topology view, growth chart            | Manual UI review                       |
| Phase 5: Cost & Advanced Export | Cost estimation, Terraform export                          | INT-8 + cost accuracy tests            |

---

## 10. Risk Register

| Risk                                                | Probability | Impact | Mitigation                                                      |
| --------------------------------------------------- | ----------- | ------ | --------------------------------------------------------------- |
| Cloud pricing data becomes stale                    | Medium      | Low    | Monthly refresh script; prices change <5%/month                 |
| Engine tier boundaries don't match real performance | Medium      | Medium | Calibrate against k6 benchmark data; document as approximations |
| Helm values incompatible with chart versions        | Low         | High   | Snapshot tests; validate against actual Helm charts in CI       |
| Profile storage grows unbounded                     | Low         | Low    | 1000 profile limit per tenant; cleanup policy in admin UI       |
| Engine calculation edge cases                       | Low         | Medium | Property-based tests for monotonicity and non-negativity        |

---

## 11. Decision Log

| ID  | Decision                    | Rationale                                                             | Date       |
| --- | --------------------------- | --------------------------------------------------------------------- | ---------- |
| D1  | Host API in admin service   | Low traffic; avoids new microservice overhead                         | 2026-03-22 |
| D2  | Profiles are project-scoped | Consistent with platform isolation patterns                           | 2026-03-22 |
| D3  | Static cost data (not API)  | Avoids cloud API keys at runtime; monthly refresh sufficient          | 2026-03-22 |
| D4  | REST API (not GraphQL)      | Platform standard; simpler for fixed API surface                      | 2026-03-22 |
| D5  | Engine stays pure TS        | No I/O in engine ensures testability and portability                  | 2026-03-22 |
| D6  | MongoDB for profiles        | Platform standard; profiles are documents; no relational joins needed | 2026-03-22 |
| D7  | Rate limiting via Redis     | Distributed rate limiting consistent with platform pattern            | 2026-03-22 |
