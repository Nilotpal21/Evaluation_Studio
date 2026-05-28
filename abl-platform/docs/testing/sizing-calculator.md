# Test Spec: Sizing Calculator

**Feature:** sizing-calculator (#42)
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Status:** PLANNED

---

## 1. Test Scope

This test spec covers the sizing calculator feature end-to-end:

- **Engine** (`packages/sizing-calculator`): Tier classification, service sizing, datastore sizing, disk growth, managed recommendations, Helm generation
- **API** (`apps/admin`): REST endpoints for calculate, export, compare, tiers, and profile CRUD
- **CLI** (`packages/kore-platform-cli`): `sizing calculate` and `sizing export` commands
- **Isolation**: Tenant and project isolation for profile operations

### Out of Scope

- Studio UI (covered by separate UI test spec when BETA phase begins)
- Cost estimation (P1 feature, tested when implemented)
- Terraform/PDF export (P2 features)

---

## 2. Test Categories

| Category             | Count              | Coverage Target                      |
| -------------------- | ------------------ | ------------------------------------ |
| E2E Tests            | 8                  | All P0 API flows                     |
| Integration Tests    | 8                  | Service boundaries, middleware chain |
| Unit Tests           | Existing (9 files) | Engine functions                     |
| Property-Based Tests | 3                  | Monotonicity invariants              |
| Snapshot Tests       | 2                  | Helm YAML stability                  |

---

## 3. E2E Test Scenarios

All E2E tests interact via HTTP only. No mocking of codebase components. Real Express servers started on random ports with full middleware chain.

### E2E-1: Calculate Topology -- Full Flow (Tier S)

**Description:** Submit a small-workload questionnaire via POST, receive a complete ClusterTopology.

**Preconditions:**

- Admin service running on random port with auth middleware
- Valid auth token for test tenant

**Steps:**

1. POST `/api/sizing/calculate` with a valid Tier-S questionnaire (5 agents, 100 concurrent conversations, 1000 docs)
2. Assert response status 200
3. Assert response body contains `tier: "S"`
4. Assert `services` array has >= 8 entries (runtime, studio, admin, search-ai, etc.)
5. Assert `dataStores` array has exactly 7 entries
6. Assert `nodePools` array has >= 3 entries (general, compute, data)
7. Assert `diskGrowth` array has 7 entries with `monthlyGB > 0` for non-Redis stores
8. Assert `managedRecommendations` array has 7 entries

**Expected Result:** Complete ClusterTopology with all sections populated for Tier S.

---

### E2E-2: Calculate Topology -- Full Flow (Tier XL with GPU)

**Description:** Submit an enterprise-scale questionnaire with self-hosted LLM, verify XL tier and GPU infrastructure.

**Preconditions:**

- Admin service running with auth middleware
- Valid auth token

**Steps:**

1. POST `/api/sizing/calculate` with XL questionnaire: 5000 agents, 500000 concurrent conversations, 10M documents, self-hosted llama-3.1-70b
2. Assert response status 200
3. Assert `tier: "XL"`
4. Assert `nodePools` includes a `gpu` pool with nvidia taints
5. Assert `services` includes a `self-hosted-llm-llama-3.1-70b` entry with `resources.gpu` set
6. Assert `dataStores` MongoDB has `shardCount >= 5` and `replicationFactor: 3`
7. Assert `totalNodes.min >= 30`
8. Assert `managedRecommendations` for mongodb is `"managed"` (not air-gapped)

**Expected Result:** XL topology with GPU pool, self-hosted LLM, sharded MongoDB, high node counts.

---

### E2E-3: Export Helm Values

**Description:** Calculate a topology then export as Helm values, verify YAML structure.

**Steps:**

1. POST `/api/sizing/calculate` with Tier-M questionnaire
2. Extract `topology` from response
3. POST `/api/sizing/export` with `{ topology, format: "helm" }`
4. Assert response status 200
5. Assert response body contains `files` object with keys including `app-services.yaml`, `mongodb-operator.yaml`, `redis-operator.yaml`
6. Assert each YAML file is non-empty string
7. Assert `app-services.yaml` contains `runtime:` section with `replicas:` and `resources:`
8. Assert `node-pools.yaml` contains `nodePools:` with instance types

**Expected Result:** Valid Helm YAML files covering all services and data stores.

---

### E2E-4: Questionnaire Validation -- Invalid Input

**Description:** Submit an invalid questionnaire and verify structured error response.

**Steps:**

1. POST `/api/sizing/calculate` with invalid questionnaire: `agentCount: -1`, missing `deployment.cloudProvider`
2. Assert response status 400
3. Assert response body `success: false`
4. Assert `error.code: "INVALID_QUESTIONNAIRE"`
5. Assert `error.details` contains field-level errors with paths (e.g., `agents.agentCount`, `deployment.cloudProvider`)

**Expected Result:** 400 with structured Zod validation errors.

---

### E2E-5: Questionnaire Validation -- Boundary Values

**Description:** Submit a questionnaire at exact tier boundaries and verify correct classification.

**Steps:**

1. POST with exactly 10 agents, 1000 concurrent conversations, 10000 documents, 10000 messages/day, 1000 workflow executions/day -> expect Tier S
2. POST with 11 agents (one dimension over S boundary) -> expect Tier M
3. POST with 1001 agents -> expect Tier L
4. POST with 10001 agents (over L max of 1000) -> expect Tier XL

**Expected Result:** Tier classification respects boundary definitions exactly.

---

### E2E-6: Compare Multiple Configurations

**Description:** Submit 2 questionnaires for comparison and verify side-by-side output.

**Steps:**

1. POST `/api/sizing/compare` with `{ configurations: [tierS_questionnaire, tierM_questionnaire] }`
2. Assert response status 200
3. Assert response body contains `results` array with 2 entries
4. Assert `results[0].tier === "S"` and `results[1].tier === "M"`
5. Assert `results[1].totalNodes.min > results[0].totalNodes.min`
6. Assert `results[1].monthlyStorageGrowthGB > results[0].monthlyStorageGrowthGB`

**Expected Result:** Two topologies returned with M > S in all sizing dimensions.

---

### E2E-7: Profile CRUD with Tenant Isolation

**Description:** Create, read, update, delete a sizing profile. Verify cross-tenant access returns 404.

**Preconditions:**

- Two test tenants (tenantA, tenantB) with valid auth tokens
- A test project under tenantA

**Steps:**

1. POST `/api/projects/:projectId/sizing-profiles` as tenantA with `{ name: "prod-sizing", questionnaire: {...} }`
2. Assert 201 with profile `_id` returned
3. GET `/api/projects/:projectId/sizing-profiles/:id` as tenantA -> 200 with profile data
4. GET `/api/projects/:projectId/sizing-profiles/:id` as tenantB -> 404 (not 403)
5. PUT `/api/projects/:projectId/sizing-profiles/:id` as tenantA with updated name -> 200
6. GET again as tenantA -> verify name updated
7. DELETE `/api/projects/:projectId/sizing-profiles/:id` as tenantA -> 200
8. GET again as tenantA -> 404

**Expected Result:** Full CRUD lifecycle works with tenant isolation (cross-tenant returns 404).

---

### E2E-8: Authentication Required

**Description:** Verify all endpoints require authentication.

**Steps:**

1. POST `/api/sizing/calculate` without auth header -> 401
2. POST `/api/sizing/export` without auth header -> 401
3. GET `/api/sizing/tiers` without auth header -> 401
4. POST `/api/projects/:projectId/sizing-profiles` without auth header -> 401
5. GET `/api/projects/:projectId/sizing-profiles` without auth header -> 401

**Expected Result:** All 5 endpoint categories return 401 without auth.

---

## 4. Integration Test Scenarios

Integration tests exercise real service boundaries with the full middleware chain. No mocking of codebase components.

### INT-1: Engine -- Tier Classification Across All Boundaries

**Description:** Verify tier classifier handles all boundary transitions correctly.

**Setup:** Import `classifyTier` from the engine package.

**Test Cases:**

- Input at S ceiling: `{ agentCount: 10, concurrentConversations: 1000, totalDocuments: 10000, messagesPerDay: 10000, workflowExecutionsPerDay: 1000 }` -> S
- One dimension over S: `{ agentCount: 11, ...rest at S ceiling }` -> M
- All dimensions at M ceiling -> M
- One dimension over M -> L
- All dimensions at L ceiling -> L
- One dimension over L -> XL
- All dimensions at maximum -> XL
- Minimum inputs (all at 1/0) -> S

**Expected Result:** 8 boundary conditions produce correct tier.

---

### INT-2: Engine -- Service Sizer Workload Scaling

**Description:** Verify service replica adjustment logic responds to workload dimensions.

**Setup:** Import `sizeApplicationServices` from the engine package.

**Test Cases:**

- Tier M with 10x conversation threshold -> runtime replicas scaled up
- Tier M with 10x document threshold -> search-ai replicas scaled up
- Tier M with 10x workflow threshold -> workflow-engine replicas scaled up
- Tier M with web-crawl connector -> crawler replicas scaled up
- Tier S baseline -> all services at baseline replicas (no scaling)

**Expected Result:** Each service scales independently based on its relevant workload dimension.

---

### INT-3: Engine -- Datastore Sizer TTL Policies

**Description:** Verify TTL policies are derived from questionnaire retention settings.

**Setup:** Import `sizeDataStores` from the engine package.

**Test Cases:**

- Conversation retention "30d" -> MongoDB messages TTL = 30 days
- Conversation retention "1y" -> MongoDB messages TTL = 365 days
- Trace retention "7d" -> ClickHouse trace_events TTL = 7 days
- Audit log retention "7y" -> MongoDB audit-logs TTL = 2555 days
- Document retention "until-deleted" -> OpenSearch chunks TTL = 36500 days

**Expected Result:** All TTL policies match retention settings from questionnaire.

---

### INT-4: Engine -- Managed Recommender Decision Matrix

**Description:** Verify managed vs self-hosted decisions across provider/tier/isolation combinations.

**Setup:** Import `recommendManagedServices` from the engine package.

**Test Cases:**

- Air-gapped + any tier -> all stores self-hosted
- AWS + Tier S -> most stores self-hosted (cost-effective)
- AWS + Tier XL -> most stores managed (ops burden)
- Restate + any combination -> always self-hosted (no managed offering)
- On-prem + any tier -> no managed service names (only Atlas available)

**Expected Result:** Decision matrix produces correct recommendations for 15+ combinations.

---

### INT-5: Engine -- Disk Growth Projections Sanity

**Description:** Verify disk growth calculations produce reasonable numbers and scale with input.

**Setup:** Import `calculateDiskGrowth` from the engine package.

**Test Cases:**

- 1000 messages/day -> MongoDB growth < 1 GB/month
- 1,000,000 messages/day -> MongoDB growth between 30-100 GB/month
- 0 documents + one-time ingestion -> OpenSearch growth near 0
- 10M documents + real-time ingestion -> OpenSearch growth > 10 GB/month
- Redis growth is TTL-bounded (yearly ~ monthly)
- All stores: yearly = 12x monthly (except Redis)

**Expected Result:** Growth projections are proportional to input and within reasonable ranges.

---

### INT-6: Engine -- Helm Values Generator Structure

**Description:** Verify generated Helm YAML contains required keys per service type.

**Setup:** Import `calculateTopology` and `generateHelmValues` from the engine package.

**Test Cases:**

- Tier S topology -> `app-services.yaml` contains runtime, studio, admin sections
- Tier L topology -> `app-services.yaml` contains autoscaling sections with min/max replicas
- MongoDB operator values contain `psmdb.replsets` and `backup` sections
- Redis operator values contain `redisCluster.clusterSize`
- ClickHouse values contain `keeper.replicas: 3`
- Node pools YAML contains all pool names from topology

**Expected Result:** All generated YAML files have correct structure per operator chart.

---

### INT-7: API -- Rate Limiting on Calculate Endpoint

**Description:** Verify the calculate endpoint enforces rate limits.

**Setup:** Start admin server on random port with rate limiting middleware.

**Steps:**

1. Send 11 POST requests to `/api/sizing/calculate` in rapid succession (limit is 10/min)
2. Assert first 10 return 200
3. Assert 11th returns 429 with `error.code: "RATE_LIMITED"`

**Expected Result:** Rate limit enforced at 10 requests per minute per tenant.

---

### INT-8: API -- Cloud Provider Instance Types

**Description:** Verify all 4 cloud providers produce valid instance type mappings in node pools.

**Setup:** Import `calculateTopology`.

**Test Cases:**

- AWS -> instance types contain `m5.`, `c5.`, `r5.`
- Azure -> instance types contain `Standard_`
- GCP -> instance types contain `e2-standard`, `c2-standard`, `n2-highmem`
- On-prem -> instance types are formatted as `vCPU-Gi` (e.g., `4vCPU-16Gi`)

**Expected Result:** Each provider maps to its correct instance type naming convention.

---

## 5. Property-Based Test Scenarios

### PROP-1: Monotonicity -- Larger Workload Produces Larger Topology

**Description:** For any two questionnaires where Q2 >= Q1 in all dimensions, the topology of Q2 must be >= Q1 in total replicas, node counts, and storage.

**Properties:**

- `totalNodes(Q2).min >= totalNodes(Q1).min`
- `sum(services.replicas(Q2)) >= sum(services.replicas(Q1))`
- `monthlyStorageGrowthGB(Q2) >= monthlyStorageGrowthGB(Q1)`

### PROP-2: Tier Ordering -- S < M < L < XL

**Description:** For random inputs, the tier numeric value is monotonically non-decreasing with workload size.

### PROP-3: All Outputs Non-Negative

**Description:** For any valid questionnaire, all numeric outputs (replicas, node counts, disk growth, shard counts) are non-negative integers or positive floats.

---

## 6. Snapshot Test Scenarios

### SNAP-1: Helm Values Golden File -- Tier S AWS

**Description:** Generate Helm values for a fixed Tier-S AWS questionnaire and compare against golden file.

### SNAP-2: Helm Values Golden File -- Tier L GCP with Self-Hosted LLM

**Description:** Generate Helm values for a fixed Tier-L GCP questionnaire with self-hosted LLM and compare against golden file.

---

## 7. Test Data

### Tier-S Questionnaire Fixture

```json
{
  "deployment": {
    "cloudProvider": "aws",
    "regionCount": 1,
    "haRequirement": "standard",
    "networkIsolation": "shared-vpc",
    "compliance": []
  },
  "llm": {
    "hostingModel": "external-api",
    "selfHostedModels": [],
    "concurrentRequests": 50,
    "contextWindow": "medium",
    "embeddingModel": "bge-m3"
  },
  "agents": {
    "agentCount": 5,
    "concurrentConversations": 100,
    "avgConversationLength": 10,
    "messagesPerDay": 1000,
    "toolCallsPerConversation": 3,
    "multiAgentUsage": 0
  },
  "knowledgeBase": {
    "totalDocuments": 1000,
    "avgDocumentSize": "small",
    "documentTypes": ["pdf"],
    "ingestionFrequency": "daily",
    "connectorTypes": ["file-upload"],
    "kbPerProject": 1,
    "vectorSearchQueriesPerDay": 500
  },
  "workflows": {
    "activeWorkflows": 10,
    "executionsPerDay": 100,
    "avgStepsPerWorkflow": 5,
    "triggers": ["manual"],
    "externalApiCallsPerWorkflow": 2
  },
  "channels": {
    "activeChannels": ["web-widget"],
    "voiceVideoUsage": 0,
    "inboundWebhooksPerDay": 0,
    "outboundWebhooksPerDay": 0
  },
  "observability": {
    "adminUsers": 5,
    "traceRetention": "30d",
    "metricsRetention": "90d",
    "auditLogRetention": "1y",
    "monitoringStack": "platform-builtin"
  },
  "retention": {
    "conversationRetention": "90d",
    "documentRetention": "until-deleted",
    "attachmentRetention": "1y",
    "encryptionAtRest": "platform-aes256",
    "backupFrequency": "daily",
    "drRtpRpo": "rpo-24h-rto-4h"
  }
}
```

### Tier-XL Questionnaire Fixture

```json
{
  "deployment": {
    "cloudProvider": "aws",
    "regionCount": 3,
    "haRequirement": "maximum",
    "networkIsolation": "dedicated-vpc",
    "compliance": ["soc2", "hipaa"]
  },
  "llm": {
    "hostingModel": "self-hosted",
    "selfHostedModels": ["llama-3.1-70b"],
    "concurrentRequests": 5000,
    "contextWindow": "xl",
    "embeddingModel": "bge-m3"
  },
  "agents": {
    "agentCount": 5000,
    "concurrentConversations": 500000,
    "avgConversationLength": 25,
    "messagesPerDay": 10000000,
    "toolCallsPerConversation": 15,
    "multiAgentUsage": 80
  },
  "knowledgeBase": {
    "totalDocuments": 10000000,
    "avgDocumentSize": "large",
    "documentTypes": ["pdf", "word", "html", "spreadsheet", "image"],
    "ingestionFrequency": "real-time",
    "connectorTypes": ["web-crawl", "sharepoint", "git", "api"],
    "kbPerProject": 25,
    "vectorSearchQueriesPerDay": 5000000
  },
  "workflows": {
    "activeWorkflows": 5000,
    "executionsPerDay": 500000,
    "avgStepsPerWorkflow": 20,
    "triggers": ["scheduled", "webhook", "event-driven"],
    "externalApiCallsPerWorkflow": 10
  },
  "channels": {
    "activeChannels": ["web-widget", "slack", "teams", "whatsapp", "voice"],
    "voiceVideoUsage": 30,
    "inboundWebhooksPerDay": 1000000,
    "outboundWebhooksPerDay": 500000
  },
  "observability": {
    "adminUsers": 50,
    "traceRetention": "90d",
    "metricsRetention": "1y",
    "auditLogRetention": "7y",
    "monitoringStack": "prometheus-grafana"
  },
  "retention": {
    "conversationRetention": "1y",
    "documentRetention": "3y",
    "attachmentRetention": "1y",
    "encryptionAtRest": "customer-kms",
    "backupFrequency": "continuous",
    "drRtpRpo": "rpo-1min-rto-15min"
  }
}
```

---

## 8. Coverage Matrix

| Component           | E2E                 | Integration | Unit     | Property       | Snapshot       |
| ------------------- | ------------------- | ----------- | -------- | -------------- | -------------- |
| Tier Classifier     | E2E-2, E2E-5        | INT-1       | Existing | PROP-2         | -              |
| Service Sizer       | E2E-1, E2E-2        | INT-2       | Existing | PROP-1         | -              |
| Compute Sizer       | E2E-2               | INT-2       | Existing | PROP-1         | -              |
| Datastore Sizer     | E2E-1, E2E-2        | INT-3       | Existing | PROP-3         | -              |
| Disk Growth         | E2E-1               | INT-5       | Existing | PROP-1, PROP-3 | -              |
| Managed Recommender | E2E-1, E2E-2        | INT-4       | Existing | -              | -              |
| Helm Generator      | E2E-3               | INT-6       | Existing | -              | SNAP-1, SNAP-2 |
| API Calculate       | E2E-1, E2E-2, E2E-5 | INT-7       | -        | -              | -              |
| API Export          | E2E-3               | -           | -        | -              | -              |
| API Compare         | E2E-6               | -           | -        | -              | -              |
| API Profiles        | E2E-7               | -           | -        | -              | -              |
| Auth/Isolation      | E2E-7, E2E-8        | -           | -        | -              | -              |
| Cloud Providers     | E2E-1               | INT-8       | -        | -              | -              |

---

## 9. Test Environment Requirements

| Requirement   | Details                                                       |
| ------------- | ------------------------------------------------------------- |
| Admin service | Real Express server on random port (`:0`)                     |
| Auth          | Test JWT tokens for 2 tenants (tenantA, tenantB)              |
| MongoDB       | Real MongoMemoryServer or test database                       |
| Middleware    | Full chain: auth, rate-limiting, validation, tenant isolation |
| No mocks      | No `vi.mock()` or `jest.mock()` for codebase components       |
| Timeout       | 30s per test (API tests), 5s per test (unit/engine)           |
