# Feature Spec: Connector Discovery

- **Feature ID**: #39
- **Status**: ALPHA
- **Owner**: SearchAI Team
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22

---

## 1. Problem Statement

Enterprise connectors (SharePoint, Jira, Confluence, Salesforce, etc.) expose heterogeneous resource hierarchies -- sites, drives, libraries, spaces, projects, objects -- each with different content types, schemas, and permission models. Without auto-discovery, every new connector setup requires manual configuration: users must know which SharePoint sites contain relevant documents, what file types exist, how frequently content changes, and what permission model to use.

This manual process is error-prone, time-consuming, and requires expertise that most Knowledge Base administrators lack. The Connector Discovery feature automates the exploration of a connected data source to produce:

1. A **resource inventory** (hierarchical sites, drives, libraries)
2. **Content profiles** (file type distribution, size, recency, sensitivity indicators)
3. **Intelligent recommendations** (which resources to sync, sync strategy, permissions, filters)
4. A **one-click quick setup** path that chains discovery through to configuration

The goal is to reduce connector setup from 20+ minutes of manual configuration to under 60 seconds with high-confidence recommendations.

## 2. Scope

### In Scope

- **Resource discovery**: Enumerate all accessible resources from a connector's data source via connector-specific API calls (Graph API for SharePoint, REST for Jira/Salesforce)
- **Content profiling**: Sample documents per resource to analyze file type distribution, date ranges, update frequency, document sizes, and sensitivity indicators (PII, financial, health)
- **Recommendation engine**: Pure deterministic scoring (no LLM) that produces resource scores, sync strategy, permission mode, filter config, and cost estimates
- **Quick setup orchestration**: One-click flow that chains discover -> profile -> recommend -> accept -> optionally start sync
- **Discovery persistence**: MongoDB model with TTL (7 days) for discovery results and recommendations
- **BullMQ worker**: Background discovery processing with distributed locking, progress reporting, and error recovery
- **REST API**: 7 endpoints for triggering discovery, retrieving results, generating/accepting recommendations, and quick setup
- **Studio UI integration**: Enterprise Connector Wizard steps for discovery progress, review, and accept
- **Schema discovery pipeline**: Post-acceptance trigger of schema discovery and field mapping suggestion

### Out of Scope

- LLM-based recommendation enhancement (future: semantic content analysis)
- Discovery scheduling (periodic re-discovery)
- Cross-connector deduplication (same document discovered from multiple sources)
- Discovery for non-enterprise connectors (web crawlers, document upload)
- Real-time discovery streaming via WebSocket (currently uses polling)

## 3. Background & Context

### Current State

The connector discovery feature has been implemented as part of the connector platform (RFC-006). Key components exist across three packages:

| Layer            | Package                          | Key Files                                                                                      |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Interface        | `packages/connectors/base`       | `resource-discovery.interface.ts`, `recommendation.interface.ts`, `base-resource-discovery.ts` |
| Implementation   | `packages/connectors/sharepoint` | `sharepoint-resource-discovery.ts`                                                             |
| Worker           | `apps/search-ai`                 | `connector-discovery-worker.ts`                                                                |
| Routes           | `apps/search-ai`                 | `connector-discovery.ts` (routes)                                                              |
| Orchestrator     | `apps/search-ai`                 | `quick-setup-orchestrator.ts`                                                                  |
| Recommendation   | `apps/search-ai`                 | `recommendation-engine.service.ts`                                                             |
| Schema Discovery | `apps/search-ai`                 | `base-discovery.service.ts`, 4 connector-specific services                                     |
| Database         | `packages/database`              | `connector-discovery.model.ts`, `connector-schema.model.ts`                                    |
| Studio           | `apps/studio`                    | `EnterpriseConnectorWizard.tsx`                                                                |

### Related Systems

- **Schema Discovery** (`apps/search-ai/src/services/schema-discovery/`): Discovers field schemas from connectors. Triggered after recommendation acceptance to populate the Fields tab.
- **Connector Sync Workers**: Full and delta sync workers that execute after discovery-based configuration.
- **Filter Engine** (`packages/connectors/base/src/filters/`): Applies the filter configuration generated from recommendations.
- **Permission Crawler**: Uses the permission mode recommended by discovery.

## 4. User Stories

### US-1: Auto-Discover Resources

**As a** Knowledge Base administrator,
**I want to** trigger auto-discovery on a connected data source,
**So that** I can see all available sites, drives, and libraries without manually browsing the source system.

**Acceptance Criteria:**

- Discovery can be triggered via `POST /connectors/:connectorId/discover`
- Three modes: `discover_only`, `discover_and_profile`, `quick_setup`
- Resources are returned as a flat list with `parentId` linkage for hierarchy
- Discovery progress is trackable via job progress (0-100%)
- Discovery fails gracefully with lock contention error if already running

### US-2: Content Profiling

**As a** Knowledge Base administrator,
**I want to** see content profiles (file types, sizes, dates, sensitivity) for each discovered resource,
**So that** I can understand what data exists before deciding what to sync.

**Acceptance Criteria:**

- Content profiling samples up to 100 documents per drive (configurable via `sampleSize`)
- Profile includes: totalDocuments, totalSizeBytes, fileTypeDistribution, dateRange, updateFrequency, sensitivityIndicators
- Sensitivity detection scans file names for PII, financial, and health indicators
- Update frequency is calculated from modification date patterns

### US-3: Intelligent Recommendations

**As a** Knowledge Base administrator,
**I want to** receive intelligent recommendations about which resources to sync and how,
**So that** I can make informed decisions without deep technical knowledge.

**Acceptance Criteria:**

- Recommendations are generated from discovery results via `POST /connectors/:connectorId/recommendations`
- Each resource gets a 0-1 score based on activity (30%), size (20%), content richness (20%), and sensitivity penalty (30%)
- Resources below 0.3 threshold are not recommended
- Sync strategy recommends full-only vs full+delta with cron schedules
- Filter config recommends which resources to include and which content types
- Cost estimate includes: estimated documents, storage, sync duration, monthly API calls

### US-4: One-Click Quick Setup

**As a** Knowledge Base administrator,
**I want to** set up a connector with one click,
**So that** I can start ingesting content without manual configuration.

**Acceptance Criteria:**

- Quick setup via `POST /connectors/:connectorId/quick-setup`
- Chains: discover -> profile -> recommend (all in worker)
- User reviews recommendations in UI and accepts with optional overrides
- Acceptance applies filter config, permission mode, and configuration source to connector
- Optionally triggers initial full sync on acceptance

### US-5: Review and Accept in Studio

**As a** Knowledge Base administrator using Studio,
**I want to** review discovered resources and recommendations in a visual wizard,
**So that** I can accept, modify, or reject the auto-generated configuration.

**Acceptance Criteria:**

- Wizard step shows discovery progress with animated loading
- Review step displays resource tree with scores, reasoning, and recommended badges
- User can accept recommendations as-is or with overrides
- Acceptance triggers schema discovery for the Fields tab
- Error states are handled gracefully (discovery failure, timeout, lock contention)

## 5. Functional Requirements

### FR-1: Resource Discovery Interface

The `IResourceDiscovery` interface defines the contract for all connector discovery implementations:

- `discoverResources(progressCallback?)`: Returns flat list of `DiscoveredResource[]` with `parentId` linkage
- `profileContent(resourceId, sampleSize?)`: Returns `ContentProfile` for a single resource
- Resources include: id, name, displayName, url, resourceType, parentId, metadata
- Progress callback provides: phase, resourcesFound, currentResource, percentComplete

### FR-2: SharePoint Discovery Implementation

Currently the only production implementation:

- Discovers SharePoint sites via Graph API `getSites()`
- For each site, discovers drives (document libraries) via `getDrives(siteId)`
- Handles access-denied sites gracefully by recording them as `site-error` type
- Profiles drives by streaming document items and analyzing file metadata
- Uses `BaseResourceDiscovery` helpers for sensitivity detection and update frequency calculation

### FR-3: Recommendation Engine

Pure deterministic scoring service with no external dependencies:

- **Activity score** (weight 0.3): Based on days since latest modification
  - <=7 days: 1.0, <=30 days: 0.7, <=90 days: 0.4, >90 days: 0.1
- **Size score** (weight 0.2): Bell curve favoring 100-10K documents
- **Content score** (weight 0.2): Ratio of rich content types (pdf, docx, etc.) to total
- **Sensitivity penalty** (weight 0.3): Subtracted based on PII (0.3), financial (0.2), health (0.3)
- Recommendation threshold: overall score >= 0.3
- Sync strategy: based on dominant update frequency across profiles
- Cost estimation: based on document counts, API call rates, sync frequency

### FR-4: Discovery Worker

BullMQ-based background processor:

- Queue: `connector-discovery`
- Concurrency: 2 workers
- Distributed lock via Redis (10-minute TTL, no retry)
- Job modes: `discover_only`, `discover_and_profile`, `quick_setup`
- Progress reporting: 0-50% for discovery, 50-90% for profiling, 90-100% for completion
- In `quick_setup` mode, automatically generates recommendations after discovery
- Discovery record status transitions: pending -> discovering -> profiling -> completed | failed

### FR-5: REST API Endpoints

7 endpoints under `/connectors/:connectorId/`:

| Method | Path                                        | Purpose                                       |
| ------ | ------------------------------------------- | --------------------------------------------- |
| POST   | `/discover`                                 | Trigger resource discovery                    |
| GET    | `/discovery`                                | Get latest discovery results                  |
| GET    | `/discovery/:discoveryId`                   | Get specific discovery by ID                  |
| POST   | `/recommendations`                          | Generate recommendations from discovery       |
| GET    | `/recommendations`                          | Get latest recommendation                     |
| POST   | `/recommendations/:recommendationId/accept` | Accept recommendation with optional overrides |
| POST   | `/quick-setup`                              | One-click setup flow                          |

### FR-6: Discovery Persistence

MongoDB model `ConnectorDiscovery`:

- Embedded subdocuments: `DiscoveredResource[]`, `ContentProfile[]`
- Status enum: `pending | discovering | profiling | completed | failed`
- TTL: 7-day expiry via `expiresAt` index
- Tenant isolation: `tenantIsolationPlugin` applied
- Indexes: `(tenantId, connectorId)` for primary lookup

### FR-7: Quick Setup Orchestrator

Three-function orchestrator:

1. `triggerDiscovery()`: Creates discovery record, queues BullMQ job, returns discoveryId + jobId
2. `generateRecommendations()`: Validates discovery is completed, runs recommendation engine, saves result
3. `acceptRecommendation()`: Marks recommendation as accepted, builds filter config, updates connector config, optionally triggers sync, triggers schema discovery for Fields tab

### FR-8: Schema Discovery Pipeline Integration

After recommendation acceptance:

- Triggers schema discovery job for the connector's knowledge base
- Uses the `QUEUE_SCHEMA_DISCOVERY` queue
- Schema discovery discovers field schemas specific to the connector type (Jira, Salesforce, etc.)
- Field mapping suggestion worker then suggests mappings from source fields to canonical schema

## 6. Non-Functional Requirements

### NFR-1: Performance

- Discovery of a SharePoint tenant with 50 sites and 200 drives completes in under 5 minutes
- Content profiling of 100 documents per drive completes in under 30 seconds per drive
- Recommendation generation is synchronous and completes in under 100ms
- Discovery results are cached in MongoDB for 7 days (no re-computation)

### NFR-2: Scalability

- BullMQ worker supports concurrency of 2 (lighter than sync workers)
- Distributed lock prevents concurrent discovery for the same connector
- Discovery queue supports multiple connectors in parallel across different tenants

### NFR-3: Reliability

- Discovery worker handles partial failures gracefully (e.g., access-denied sites)
- Lock auto-expires after 10 minutes to prevent deadlocks
- Failed discovery records error messages and transitions to `failed` status
- SIGTERM handler enables graceful worker shutdown

### NFR-4: Security

- All endpoints require authentication via tenant context (`req.tenantContext!.tenantId`)
- Connector lookup uses `findOne({ _id, tenantId })` for tenant isolation
- Discovery records are scoped to tenant via isolation plugin
- OAuth tokens are never logged or exposed in discovery results
- Cross-tenant access returns 404 (not 403)

### NFR-5: Observability

- Worker logs discovery start, completion, and failure with structured context
- Progress reporting via BullMQ job progress (0-100%)
- Duration tracking per discovery run

## 7. Data Model

### ConnectorDiscovery

```
{
  _id: string (uuidv7),
  tenantId: string,
  connectorId: string,
  status: 'pending' | 'discovering' | 'profiling' | 'completed' | 'failed',
  resources: DiscoveredResource[],
  profiles: ContentProfile[],
  totalResources: number,
  discoveredAt: Date | null,
  durationMs: number,
  error: string | null,
  jobId: string | null,
  expiresAt: Date (TTL: 7 days),
  _v: number,
  createdAt: Date,
  updatedAt: Date
}
```

### ConnectorRecommendation

```
{
  _id: string,
  tenantId: string,
  connectorId: string,
  discoveryId: string,
  status: 'generated' | 'accepted' | 'rejected',
  resourceScores: ResourceScore[],
  syncStrategy: SyncStrategyRecommendation,
  permissionMode: PermissionRecommendation,
  filterConfig: FilterRecommendation,
  costEstimate: CostEstimate,
  overallConfidence: number,
  generatedAt: Date,
  userDecision: { action, overrides, decidedAt }
}
```

### DiscoveredResource (Embedded)

```
{
  id: string,
  name: string,
  displayName: string,
  url: string,
  resourceType: string,
  parentId: string | null,
  metadata: Record<string, unknown>,
  children?: DiscoveredResource[]
}
```

### ContentProfile (Embedded)

```
{
  resourceId: string,
  totalDocuments: number,
  totalSizeBytes: number,
  fileTypeDistribution: Record<string, number>,
  dateRange: { earliest: Date | null, latest: Date | null },
  averageDocumentSizeBytes: number,
  updateFrequency: 'daily' | 'weekly' | 'monthly' | 'rarely',
  sensitivityIndicators: string[],
  sampleDocumentCount: number
}
```

## 8. API Contract

### POST /connectors/:connectorId/discover

**Request:**

```json
{
  "mode": "discover_and_profile",
  "sampleSize": 100
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "discoveryId": "01abc...",
    "jobId": "conn-1-discovery-1711...",
    "status": "pending",
    "message": "Discovery job queued"
  }
}
```

**Error (400):**

```json
{
  "success": false,
  "error": {
    "code": "NOT_AUTHENTICATED",
    "message": "Connector must be authenticated before discovery"
  }
}
```

### GET /connectors/:connectorId/discovery

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "01abc...",
    "status": "completed",
    "resources": [...],
    "profiles": [...],
    "totalResources": 15,
    "discoveredAt": "2026-03-22T...",
    "durationMs": 23456
  }
}
```

### POST /connectors/:connectorId/recommendations

**Request:**

```json
{ "discoveryId": "01abc..." }
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "rec-789",
    "status": "generated",
    "resourceScores": [
      {
        "resourceId": "drive-1",
        "resourceName": "Engineering Docs",
        "overallScore": 0.85,
        "recommended": true,
        "factors": {
          "activityScore": 1.0,
          "sizeScore": 0.8,
          "contentScore": 0.9,
          "sensitivityPenalty": 0
        },
        "reasoning": "Recommended (score: 0.85): recently active, ideal size, rich content"
      }
    ],
    "syncStrategy": {
      "syncMode": "full_then_delta",
      "fullSyncSchedule": "0 0 * * 0",
      "deltaSyncSchedule": "0 * * * *",
      "enableWebhooks": true,
      "reasoning": "Frequently updated content...",
      "confidence": 0.85
    },
    "overallConfidence": 0.8
  }
}
```

### POST /connectors/:connectorId/recommendations/:recommendationId/accept

**Request:**

```json
{
  "overrides": { "permissionMode": "full" },
  "startSync": true
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "connector": { ... },
    "syncJobId": "conn-1-full-1711...",
    "message": "Recommendation accepted and sync started"
  }
}
```

### POST /connectors/:connectorId/quick-setup

**Request:**

```json
{ "startSync": false }
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "discoveryId": "01abc...",
    "jobId": "conn-1-discovery-1711...",
    "status": "pending",
    "startSync": false,
    "message": "Quick setup initiated..."
  }
}
```

## 9. UX/UI Design

The Enterprise Connector Wizard in Studio includes two discovery-specific steps:

### Step 4: Discovery Progress

- Shows animated progress bar tracking BullMQ job progress
- Polls `GET /discovery` every 4 seconds
- Displays current phase (discovering, profiling) and resource count
- Error state shows failure message with retry option

### Step 5: Review Recommendations

- Resource tree visualization showing sites and drives
- Each resource card shows: name, score badge, recommended indicator, reasoning text
- Summary card showing sync strategy, permission mode, cost estimate
- Accept button (applies as-is), Accept with modifications (opens override panel)
- Accept triggers schema discovery pipeline for Fields tab population

## 10. Technical Architecture

```
Studio UI (Wizard)
    |
    v
SearchAI API (connector-discovery routes)
    |
    v
Quick Setup Orchestrator
    |
    +-- triggerDiscovery() --> BullMQ Queue --> Connector Discovery Worker
    |                                              |
    |                                              +-- IResourceDiscovery.discoverResources()
    |                                              +-- IResourceDiscovery.profileContent()
    |                                              +-- RecommendationEngineService (quick_setup mode)
    |                                              +-- MongoDB: ConnectorDiscovery, ConnectorRecommendation
    |
    +-- generateRecommendations() --> RecommendationEngineService
    |
    +-- acceptRecommendation() --> ConnectorConfig update
                                   |
                                   +-- Schema Discovery Queue
                                   +-- Connector Sync Queue (optional)
```

### Component Layers

1. **Interface Layer** (`packages/connectors/base`): `IResourceDiscovery`, `BaseResourceDiscovery`, recommendation types
2. **Connector Layer** (`packages/connectors/sharepoint`): `SharePointResourceDiscovery` (Graph API)
3. **Worker Layer** (`apps/search-ai/workers`): `connector-discovery-worker.ts` (BullMQ)
4. **Service Layer** (`apps/search-ai/services`): `recommendation-engine.service.ts`, `quick-setup-orchestrator.ts`
5. **Route Layer** (`apps/search-ai/routes`): `connector-discovery.ts` (7 endpoints)
6. **Persistence Layer** (`packages/database`): `ConnectorDiscovery`, `ConnectorRecommendation` models
7. **UI Layer** (`apps/studio`): `EnterpriseConnectorWizard.tsx`

## 11. Dependencies

### Upstream

- `@agent-platform/connector-sharepoint`: SharePoint Graph API client
- `@agent-platform/connectors-base`: Base interfaces and types
- `@agent-platform/database`: Mongoose models and tenant isolation
- `@agent-platform/shared-observability`: Distributed lock manager
- `bullmq`: Background job processing
- `ioredis`: Redis client for locking

### Downstream

- Schema discovery worker (`QUEUE_SCHEMA_DISCOVERY`)
- Connector sync worker (`QUEUE_CONNECTOR_SYNC`)
- Field mapping suggestion pipeline
- Studio Enterprise Connector Wizard

## 12. Feature Flags & Rollout

Currently no feature flags. The feature is accessible to all tenants with enterprise connectors. Future rollout considerations:

- Feature flag for new connector types as discovery implementations are added
- Gradual rollout for quick setup mode via tenant-level feature flag

## 13. Migration & Backward Compatibility

- Discovery is additive; existing manual connector configuration continues to work
- `configurationSource` field on ConnectorConfig differentiates `quick_setup` from `manual`
- Discovery records have 7-day TTL, so no migration needed
- No breaking changes to existing connector sync or permission workflows

## 14. Risks & Mitigations

| Risk                                         | Impact                                                 | Mitigation                                                                            |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Only SharePoint discovery implemented        | Other connector types require manual setup             | Framework is extensible; Jira/Salesforce/Confluence implementations are backlog items |
| Rate limiting by Graph API during discovery  | Discovery timeout or failure                           | Reuse existing rate limiter and retry handler from connectors-base                    |
| Large tenant with 1000+ sites                | Discovery exceeds 10-minute lock TTL                   | Paginated discovery, configurable lock TTL, progress-based lock renewal               |
| Sensitivity detection is filename-based only | False negatives for content with PII in body           | Documented limitation; future: LLM-based content sampling                             |
| Discovery results stored as embedded arrays  | MongoDB 16MB document limit for very large discoveries | Monitor discovery sizes; future: chunked storage for large tenants                    |
| Console.log usage in routes                  | Violates platform logging standard                     | Must be replaced with `createLogger('connector-discovery')`                           |

## 15. Open Questions

1. **Multi-connector discovery**: Should we support batch discovery across all connectors in a knowledge base?
2. **Discovery scheduling**: Should discovery be re-run periodically to detect new resources?
3. **WebSocket progress**: Should we add WebSocket-based real-time progress instead of polling?
4. **Recommendation persistence**: Should accepted recommendations be archived instead of TTL-expired?
5. **Cross-connector dedup**: When multiple connectors index the same document, should discovery detect this?

## 16. Success Metrics

| Metric                         | Target                             | Measurement                                            |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| Quick setup completion rate    | >80% of new enterprise connectors  | Ratio of quick_setup to manual configurationSource     |
| Time-to-first-sync             | <2 minutes from auth to sync start | Duration from connector creation to first sync job     |
| Recommendation acceptance rate | >70% accepted as-is                | Ratio of 'accepted' to 'modified' userDecision actions |
| Discovery failure rate         | <5%                                | Ratio of 'failed' to total discovery records           |
| Discovery duration P95         | <5 minutes                         | ConnectorDiscovery.durationMs percentile               |

## 17. Testing Strategy

- **Unit tests**: Recommendation engine scoring algorithms, sensitivity detection, update frequency calculation
- **Integration tests**: Discovery worker processing with mocked connector, orchestrator flow with real MongoDB
- **E2E tests**: Full API flow from discovery trigger through recommendation acceptance with real HTTP server
- **See**: `docs/testing/connector-discovery.md` for detailed test spec

## 18. Changelog

| Date       | Version | Change                                           |
| ---------- | ------- | ------------------------------------------------ |
| 2026-03-22 | 1.0     | Initial feature spec generated via SDLC pipeline |
