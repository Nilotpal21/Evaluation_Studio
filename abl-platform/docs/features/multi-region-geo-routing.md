# Feature: Multi-Region / Geo-Routing

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `enterprise`, `governance`, `admin operations`
**Package(s)**: `packages/shared` (region module), `packages/database` (region-aware connections), `packages/config` (region constants), `apps/runtime`, `apps/search-ai`, `apps/studio`, `apps/admin`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/multi-region-geo-routing.md](../testing/multi-region-geo-routing.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers operating globally face three compounding challenges on the current single-region ABL platform:

1. **Data sovereignty violations**: EU-based tenants' personal data (conversation history, PII, analytics traces) is stored and processed in a single US or India region, exposing the platform to GDPR Article 44-49 cross-border transfer violations (fines up to 4% of global revenue or EUR 20M). Over 120 countries now have data residency laws, and enforcement is intensifying (EUR 5.88B cumulative GDPR fines as of 2024).
2. **Latency degradation**: Users in APAC or EMEA experience 150-400ms round-trip latency to a single-region deployment. Agent interactions — which require multiple LLM round-trips, tool calls, and streaming responses — amplify this to multi-second perceived delays, degrading the conversational UX.
3. **Single point of failure**: A regional outage (cloud provider AZ failure, network partition, DNS failure) takes the entire platform offline for all tenants globally. There is no mechanism for regional failover, and the RTO/RPO for a single-region deployment is measured in hours, not minutes.

Without multi-region capabilities, the platform cannot serve regulated industries (financial services, healthcare, government) or compete with enterprise competitors (Decagon, Sierra, Cognigy) that offer data residency guarantees and regional failover.

### Goal Statement

Provide a multi-region architecture for the ABL platform that enables region-pinned tenant data residency (EU tenants' data stays in EU), latency-optimized geo-routing (users connect to the nearest healthy region), and automated regional failover — while preserving the platform's existing multi-tenant isolation, encryption-at-rest, and observability guarantees. The architecture must support a phased rollout from single-region to active-active without requiring tenant downtime or data migration during normal operations.

### Summary

Multi-Region / Geo-Routing introduces a region-aware layer across the ABL platform stack:

1. **Region Registry**: A centralized catalog of deployed regions (e.g., `us-east-1`, `eu-west-1`, `ap-southeast-1`) with health status, capacity, and compliance metadata stored in each region's local database with cross-region synchronization.
2. **Tenant-Region Pinning**: Each tenant is assigned a "home region" at provisioning time based on compliance requirements (e.g., GDPR tenants pinned to `eu-west-1`). All primary data for a pinned tenant resides in its home region. This pinning is enforced at the database connection layer, not just the routing layer.
3. **Geo-DNS Routing**: DNS-level routing (Route53 latency-based or CloudFlare geo-steering) directs users to the nearest healthy region. A region-aware API gateway validates the tenant's home region and either serves locally (if matching) or proxies to the correct region.
4. **Data Replication**: MongoDB cross-region replica sets for read replicas (Phase 2), Redis CRDT-based active-active replication for session caches (Phase 4), and ClickHouse cross-region replicated tables for analytics (Phase 3). Write operations always go to the tenant's home region; reads can be served from local replicas with configurable staleness tolerance.
5. **Regional Failover**: Automated health monitoring with configurable failover thresholds. Active-passive failover (Phase 3) promotes a secondary region when the primary is unhealthy. Active-active (Phase 4) eliminates the failover step for participating tenants.
6. **Observability**: Region-level dashboards for replication lag, cross-region latency, failover events, and data sovereignty compliance status.

---

## 2. Scope

### Goals

- Enable tenant-level region pinning with enforcement at the database query layer (not just DNS routing)
- Comply with GDPR, LGPD, PDPA, PIPL, and other data residency regulations by guaranteeing that pinned tenant data never leaves the designated region
- Reduce P95 API latency for geo-distributed users to < 100ms for read operations via local read replicas
- Achieve < 5-minute RTO and < 30-second RPO for regional failover (active-passive)
- Achieve zero-downtime reads and < 5-second write convergence for active-active regions
- Provide geo-DNS routing that directs traffic to the nearest healthy region with < 50ms DNS resolution overhead
- Support cross-region observability with unified dashboards across all regions
- Enable zero-downtime tenant migration between regions for rebalancing or compliance changes
- Minimize cross-region data transfer costs through region-local processing and selective replication

### Non-Goals (Out of Scope)

- Client-side region selection — region assignment is operator/compliance-driven, not user-chosen
- Multi-cloud deployment (AWS + Azure + GCP simultaneously) — single cloud provider per deployment, multi-region within that provider
- Edge computing / CDN for agent execution — agents execute in the region cluster, not at the edge
- Real-time synchronous replication across regions (too high latency penalty) — all cross-region replication is asynchronous
- Per-agent or per-project region pinning — region pinning is at the tenant level only (projects inherit tenant region)
- Custom region naming — regions use cloud provider region identifiers (e.g., `us-east-1`, `eu-west-1`)
- ClickHouse cross-region writes — analytics data is ingested in the local region and replicated asynchronously

---

## 3. User Stories

1. As an **enterprise customer (EU-based)**, I want my tenant's data to be stored and processed exclusively in the EU region so that I comply with GDPR data residency requirements and can provide evidence to auditors.
2. As a **compliance officer**, I want a dashboard showing which regions each tenant's data resides in and whether any cross-border data transfers have occurred so that I can produce compliance reports for regulatory audits.
3. As an **SRE**, I want automated regional failover with configurable health thresholds so that when a region becomes unhealthy, tenant traffic is redirected to a healthy region within 5 minutes without manual intervention.
4. As a **platform operator**, I want to provision new regions via Terraform/Helm and register them in the platform so that I can expand to new geographies as customer demand grows.
5. As a **tenant admin**, I want to see which region my tenant is pinned to and the latency characteristics of my region so that I understand my deployment topology.
6. As an **SRE**, I want a unified observability dashboard that shows replication lag, cross-region latency, and failover status across all regions so that I can proactively identify issues before they impact tenants.
7. As a **platform operator**, I want to migrate a tenant from one region to another with zero downtime so that I can rebalance capacity or respond to compliance changes.
8. As an **enterprise customer (APAC-based)**, I want my agent interactions to have < 100ms P95 latency for read operations so that the conversational UX feels responsive despite being served from a geographically distributed platform.
9. As a **security engineer**, I want all cross-region replication traffic to be encrypted in transit (mTLS) and authenticated so that data sovereignty is not violated by network-level interception.
10. As a **platform operator**, I want region-specific rate limits and quotas so that a traffic spike in one region does not degrade performance in other regions.

---

## 4. Functional Requirements

1. **FR-1**: The system must maintain a `region_configs` collection that stores each region's identifier, display name, cloud provider, geographic coordinates, status (active/draining/inactive), compliance tags (GDPR, HIPAA, PCI-DSS), and capacity metadata.
2. **FR-2**: The system must assign a `homeRegion` to every tenant at provisioning time, defaulting to the region nearest to the provisioning operator or explicitly specified via API. The `homeRegion` field must be indexed and included in all tenant-scoped queries.
3. **FR-3**: The system must enforce data residency by routing all write operations for a tenant to the tenant's home region database instance. Read operations may be served from local replicas if configured, with a maximum staleness tolerance configurable per tenant (default: 5 seconds).
4. **FR-4**: The system must provide a geo-DNS configuration (Route53 latency-based routing or CloudFlare geo-steering) that resolves the platform's API domain to the nearest healthy region's ingress endpoint, with health checks at 10-second intervals.
5. **FR-5**: The system must implement a region-aware API gateway (or middleware) that inspects the authenticated tenant's `homeRegion` and either serves the request locally (if the tenant's home region matches the current region) or proxies the request to the correct region via an internal service mesh.
6. **FR-6**: The system must support MongoDB cross-region read replicas where secondary replica set members in remote regions serve read-preference `secondaryPreferred` queries for non-home-region tenants, with replication lag monitoring and alerting when lag exceeds the configured staleness tolerance.
7. **FR-7**: The system must support Redis cross-region replication for session and cache data, using either Redis Enterprise Active-Active (CRDT-based) or a custom replication layer that synchronizes session state across regions with eventual consistency and automatic conflict resolution (last-writer-wins for simple keys, CRDT merge for counters and sets).
8. **FR-8**: The system must support ClickHouse cross-region replicated tables for analytics data, with each region writing to its local shard and a distributed table providing a global query view across all regions.
9. **FR-9**: The system must provide automated regional failover: when a region's health score drops below a configurable threshold for a sustained period (default: 60 seconds), the system must automatically redirect affected tenants' traffic to a designated failover region and update DNS records accordingly.
10. **FR-10**: The system must support zero-downtime tenant migration between regions by: (a) replicating the tenant's data to the target region, (b) switching the tenant's `homeRegion` pointer, (c) draining in-flight requests from the source region, and (d) cleaning up source data after a configurable retention period.
11. **FR-11**: The system must encrypt all cross-region replication traffic using mTLS with certificates managed by the platform's existing certificate infrastructure, and must authenticate replication endpoints using service-to-service tokens.
12. **FR-12**: The system must provide a compliance audit log recording all cross-region data access events, tenant region changes, failover events, and replication topology changes, stored in the tenant's home region.
13. **FR-13**: The system must support region-specific rate limits and quotas, configurable per region and per tenant, to prevent cross-region resource contention.
14. **FR-14**: The system must expose region health metrics (latency, availability, replication lag, capacity utilization) via both an internal API for the admin portal and Prometheus/OpenTelemetry endpoints for external monitoring.
15. **FR-15**: The system must validate that backup and disaster recovery operations respect data residency — backups for EU-pinned tenants must be stored in EU regions only.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                   |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Projects inherit tenant region; no project-level region pinning                         |
| Agent lifecycle            | SECONDARY    | Agent execution routed to tenant's home region; agent definitions replicated for reads  |
| Customer experience        | PRIMARY      | Latency reduction and regional UX optimization directly impact end-user experience      |
| Integrations / channels    | SECONDARY    | Channel endpoints must be region-aware; webhook callbacks routed to correct region      |
| Observability / tracing    | PRIMARY      | Cross-region trace correlation, region-level dashboards, replication lag monitoring     |
| Governance / controls      | PRIMARY      | Data sovereignty enforcement, compliance audit logging, residency certification         |
| Enterprise / compliance    | PRIMARY      | GDPR/LGPD/PDPA/PIPL data residency, regulatory audit support, cross-border transfer log |
| Admin / operator workflows | PRIMARY      | Region provisioning, tenant migration, failover management, capacity planning           |

### Related Feature Integration Matrix

| Related Feature            | Relationship Type | Why It Matters                                                                                       | Key Touchpoints                                                        | Current State |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------- |
| Encryption at Rest         | extends           | Encryption keys must be region-scoped; KMS instances per region; cross-region key sharing prohibited | `EncryptionService`, `TenantKMSConfig`, region-scoped key derivation   | BETA          |
| Session Management         | depends on        | Sessions must be accessible in the serving region; cross-region session handoff for failover         | `SessionState` model, Redis session cache, WebSocket reconnection      | STABLE        |
| Rate Limiting              | extends           | Rate limits must be region-aware; per-region quotas prevent cross-region contention                  | Rate limiter middleware, Redis counters, region-scoped limits          | STABLE        |
| Tenant LLM Policy          | shares data with  | LLM credential routing must respect tenant region; model endpoints should prefer in-region providers | `LLMCredential`, model hub region preferences, latency-based selection | STABLE        |
| Audit Logging              | emits into        | All cross-region operations (failover, migration, replication) must emit audit events                | `audit_events` ClickHouse table, compliance audit trail                | STABLE        |
| Backup / Disaster Recovery | depends on        | Backups must respect data residency; cross-region backup replication for DR                          | Backup storage region, restore-to-region, backup encryption            | PLANNED       |
| Analytics Pipeline         | shares data with  | ClickHouse distributed tables span regions; analytics queries must be region-aware                   | ClickHouse replicated tables, distributed query routing                | STABLE        |
| Channels                   | configured by     | Channel webhook endpoints must route to the tenant's home region; region-aware callback URLs         | Channel connection config, webhook delivery, region-prefixed endpoints | STABLE        |
| Auth Profiles              | depends on        | OAuth tokens and auth profile secrets must remain in the tenant's home region                        | `AuthProfile` model, `EndUserOAuthToken`, region-scoped encryption     | STABLE        |
| Deployments / Versioning   | extends           | Agent deployments must be region-aware; promote-to-region workflow for multi-region rollout          | Deployment model, version promotion, region-scoped deployment status   | STABLE        |

---

## 6. Design Considerations (Optional)

### Admin Portal UI

- **Region Management Page** (`/admin/regions`): List all regions with status indicators (healthy/degraded/offline), capacity bars, tenant count, and replication lag sparklines. Actions: add region, drain region, force failover.
- **Tenant Region Assignment** (`/admin/tenants/:id/region`): Show current region, allow migration initiation with progress tracker, show compliance tags.
- **Global Topology Map**: Visual map showing regions as nodes, replication links as edges with latency/lag annotations, and traffic flow indicators.
- **Failover Dashboard** (`/admin/regions/failover`): Active failover events, failover history, configurable thresholds, manual failover trigger.

### Studio UI

- **Tenant Settings > Region**: Read-only display of current region with latency indicator. Tenant admins can request region change (creates a migration ticket for platform operators).
- **Health Badge**: Region health indicator in the Studio header bar showing current region name and status.

---

## 7. Technical Considerations (Optional)

### Architecture Topology

The recommended topology progresses through four phases:

1. **Phase 1 — Single-Region Foundation**: Region metadata, tenant `homeRegion` field, region-aware middleware, DNS infrastructure. All traffic still single-region.
2. **Phase 2 — Read Replicas**: MongoDB cross-region read replicas. Reads served locally, writes proxied to home region. ClickHouse replicated tables.
3. **Phase 3 — Active-Passive Failover**: Automated failover with health monitoring. Secondary region promoted on primary failure. Redis replication for session continuity.
4. **Phase 4 — Active-Active**: Redis CRDT-based replication, multi-region write capability (each tenant writes to home region, but the infrastructure supports multiple simultaneous write regions for different tenants), conflict resolution.

### MongoDB Multi-Region Strategy

- **Replica Set Distribution**: Primary in home region, secondaries in 2+ remote regions. Use `readPreference: secondaryPreferred` with `maxStalenessSeconds` for local reads.
- **Zone Sharding** (Phase 4): For active-active, use MongoDB zone sharding to pin tenant data to specific regions. Shard key: `{ tenantId: "hashed" }` with zone ranges mapping tenant ID prefixes to regions.
- **Write Concern**: `w: majority` for cross-region durability. Configurable per-tenant: `w: 1` for latency-sensitive, `w: majority` for compliance-sensitive.
- **Election Topology**: 3 or 5 members across 3 regions to maintain quorum during single-region failure.

### Redis Multi-Region Strategy

- **Phase 2-3**: Redis Sentinel with cross-region replicas. Read-only replicas in remote regions for cache reads.
- **Phase 4**: Redis Enterprise Active-Active with CRDTs, or custom replication via change streams. Session data uses last-writer-wins; rate limit counters use CRDT counters for accurate cross-region aggregation.
- **BullMQ**: Job queues remain region-local. Cross-region job routing via a federation layer that forwards jobs to the correct region's queue.

### ClickHouse Multi-Region Strategy

- **Replicated Tables**: Use `ReplicatedMergeTree` with ZooKeeper/ClickHouse Keeper per region. Each region has its own shard that ingests local data.
- **Distributed Tables**: A `Distributed` table provides a global view across all regional shards for cross-region analytics queries.
- **Write Path**: Analytics events always written to the local region's shard (no cross-region writes). ZooKeeper latency constraints (< 100ms RTT recommended) mean each region needs its own Keeper cluster.

### Cross-Region Communication

- All inter-region communication via mTLS-authenticated gRPC or HTTPS.
- Service mesh (Istio or Linkerd) for cross-region service discovery and load balancing.
- Circuit breakers on all cross-region calls with configurable timeout (default: 5s) and retry (default: 2 attempts).

### Three-Repo Impact

- **abl-platform** (source): Region-aware middleware, tenant `homeRegion` field, region health service, migration controller, replication monitors.
- **abl-platform-deploy** (helm/argocd): Per-region Helm values, multi-cluster ArgoCD ApplicationSets, region-specific ingress configs, DNS record management.
- **abl-platform-infra** (terraform): Multi-region VPC peering, cross-region MongoDB replica sets, Redis cross-region setup, ClickHouse Keeper clusters, Route53/CloudFlare DNS records, IAM roles per region.

---

## 8. How to Consume

### Studio UI

- **Tenant Settings**: Display current region assignment, region health status, and latency to current region.
- **Region Badge**: Header component showing active region name and status icon.
- **Migration Request**: Tenant admins can submit a region change request from Settings > Region.

### API (Runtime)

| Method | Path                               | Purpose                                              |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| GET    | `/api/v1/regions`                  | List all available regions with health status        |
| GET    | `/api/v1/regions/:regionId`        | Get detailed region info (latency, capacity, status) |
| GET    | `/api/v1/regions/:regionId/health` | Real-time health check for a specific region         |
| GET    | `/api/v1/tenant/region`            | Get current tenant's region assignment               |

### API (Studio)

| Method | Path                                            | Purpose                                       |
| ------ | ----------------------------------------------- | --------------------------------------------- |
| GET    | `/api/admin/regions`                            | List all regions (admin)                      |
| POST   | `/api/admin/regions`                            | Register a new region                         |
| PUT    | `/api/admin/regions/:regionId`                  | Update region config (status, capacity, tags) |
| DELETE | `/api/admin/regions/:regionId`                  | Decommission a region (must be drained first) |
| GET    | `/api/admin/regions/:regionId/tenants`          | List tenants pinned to a region               |
| POST   | `/api/admin/tenants/:tenantId/migrate`          | Initiate tenant migration to target region    |
| GET    | `/api/admin/tenants/:tenantId/migration/status` | Get migration progress                        |
| POST   | `/api/admin/regions/:regionId/failover`         | Trigger manual failover for a region          |
| GET    | `/api/admin/regions/topology`                   | Get replication topology graph                |
| GET    | `/api/admin/compliance/data-residency`          | Data residency compliance report              |

### Admin Portal

- **Region Management**: CRUD for regions, health monitoring, capacity planning.
- **Tenant Migration**: Initiate, monitor, and rollback tenant migrations.
- **Failover Control**: Manual failover trigger, failover policy configuration, failover history.
- **Compliance Reports**: Data residency audit reports, cross-border transfer logs.
- **Topology View**: Visual representation of region interconnections, replication status, and traffic flow.

### Channel / SDK / Voice / A2A / MCP Integration

- Channel webhook callback URLs must include region routing hints (e.g., `https://eu.api.platform.com/webhooks/...`) to ensure callbacks are delivered to the correct region.
- SDKs should support region-aware connection initialization where the SDK resolves the nearest region via the geo-DNS endpoint.
- A2A protocol handoffs between agents in different regions must include the target tenant's home region to ensure the handoff is routed correctly.
- MCP server connections are region-local; MCP tool invocations that access tenant data must be routed to the tenant's home region.

---

## 9. Data Model

### Collections / Tables

```text
Collection: region_configs
Fields:
  - _id: string (uuidv7)
  - regionId: string (required, unique, e.g., "us-east-1")
  - displayName: string (required, e.g., "US East (Virginia)")
  - cloudProvider: string (required, e.g., "aws", "azure", "gcp")
  - geolocation: { latitude: number, longitude: number }
  - status: string (enum: "active", "draining", "inactive", "failover_target")
  - complianceTags: string[] (e.g., ["GDPR", "HIPAA", "PCI-DSS"])
  - capacity: { maxTenants: number, currentTenants: number, cpuUtilization: number, memoryUtilization: number }
  - endpoints: { apiGateway: string, internalMesh: string, replicationPort: number }
  - failoverConfig: { priority: number, failoverTargetRegionId: string, healthCheckIntervalMs: number, unhealthyThresholdCount: number }
  - replicationConfig: { mongoReplicaSetName: string, redisClusterEndpoint: string, clickhouseShardName: string }
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { regionId: 1 } (unique)
  - { status: 1 }
  - { cloudProvider: 1, status: 1 }
```

```text
Collection: tenant_region_assignments (extends existing tenants collection)
Additional Fields on Tenant document:
  - homeRegion: string (required, indexed, references region_configs.regionId)
  - regionComplianceRequirement: string (enum: "strict", "preferred", "any")
  - allowedRegions: string[] (regions the tenant's data may reside in, for compliance)
  - regionAssignedAt: Date
  - regionAssignedBy: string (userId or "system")
Indexes:
  - { homeRegion: 1 } (for per-region tenant listing)
  - { homeRegion: 1, status: 1 }
```

```text
Collection: tenant_migrations
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - sourceRegion: string (required)
  - targetRegion: string (required)
  - status: string (enum: "pending", "replicating", "switching", "draining", "cleanup", "completed", "failed", "rolled_back")
  - progress: { totalCollections: number, completedCollections: number, totalDocuments: number, replicatedDocuments: number, percentComplete: number }
  - startedAt: Date
  - completedAt: Date
  - initiatedBy: string (userId)
  - failureReason: string (nullable)
  - rollbackAvailable: boolean
  - sourceRetentionDays: number (default: 30)
Indexes:
  - { tenantId: 1, status: 1 }
  - { status: 1, startedAt: 1 }
```

```text
Collection: region_health_snapshots
Fields:
  - _id: string (uuidv7)
  - regionId: string (required, indexed)
  - timestamp: Date (required, indexed)
  - healthScore: number (0-100)
  - metrics: { p50LatencyMs: number, p95LatencyMs: number, p99LatencyMs: number, availabilityPercent: number, errorRate: number, replicationLagMs: number, activeConnections: number, cpuUtilization: number, memoryUtilization: number }
  - mongoStatus: { replicaSetStatus: string, oplogLagSeconds: number, primaryRegion: string }
  - redisStatus: { clusterStatus: string, replicationLagMs: number, connectedReplicas: number }
  - clickhouseStatus: { shardStatus: string, replicationLagSeconds: number, pendingMutations: number }
  - ttl: Date (expires after 7 days)
Indexes:
  - { regionId: 1, timestamp: -1 }
  - { timestamp: 1 } (TTL index, expireAfterSeconds: 604800)
```

```text
Collection: cross_region_audit_log
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - eventType: string (enum: "cross_region_read", "cross_region_write_proxy", "failover_initiated", "failover_completed", "migration_started", "migration_completed", "region_assignment_changed", "replication_lag_exceeded")
  - sourceRegion: string (required)
  - targetRegion: string (required)
  - details: object (event-specific metadata)
  - timestamp: Date (required)
  - initiatedBy: string (userId or "system")
Indexes:
  - { tenantId: 1, timestamp: -1 }
  - { eventType: 1, timestamp: -1 }
  - { sourceRegion: 1, targetRegion: 1, timestamp: -1 }
```

```text
ClickHouse Table: region_metrics (MergeTree, partitioned by region + day)
Columns:
  - region_id: String
  - timestamp: DateTime64(3)
  - metric_name: String
  - metric_value: Float64
  - tags: Map(String, String)
Partition: toYYYYMMDD(timestamp), region_id
Order: (region_id, metric_name, timestamp)
TTL: timestamp + INTERVAL 90 DAY
```

### Key Relationships

- `tenant.homeRegion` -> `region_configs.regionId`: Every tenant is pinned to exactly one region.
- `tenant_migrations.tenantId` -> `tenants._id`: Migration records track the tenant being moved.
- `tenant_migrations.sourceRegion` / `targetRegion` -> `region_configs.regionId`: Migration endpoints reference valid regions.
- `region_health_snapshots.regionId` -> `region_configs.regionId`: Health data is per-region.
- `cross_region_audit_log.tenantId` -> `tenants._id`: Audit events are tenant-scoped for compliance.
- `region_configs.failoverConfig.failoverTargetRegionId` -> `region_configs.regionId`: Failover targets form a directed graph.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                | Purpose                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/shared/src/region/region-registry.ts`     | Region configuration registry, health aggregation, topology graph    |
| `packages/shared/src/region/region-router.ts`       | Tenant-to-region routing logic, failover resolution                  |
| `packages/shared/src/region/region-health.ts`       | Health score computation, threshold evaluation, alerting triggers    |
| `packages/shared/src/region/replication-monitor.ts` | Cross-region replication lag monitoring for Mongo, Redis, ClickHouse |
| `packages/shared/src/region/tenant-migration.ts`    | Tenant migration state machine (replicate, switch, drain, cleanup)   |
| `packages/shared/src/region/types.ts`               | Type definitions for region, migration, health, topology             |
| `packages/shared/src/region/constants.ts`           | Region-related constants (default thresholds, intervals, timeouts)   |
| `packages/config/src/region-constants.ts`           | Region identifiers, endpoint templates, port assignments             |

### Routes / Handlers

| File                                                          | Purpose                                             |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `apps/runtime/src/middleware/region-routing.middleware.ts`    | Request-level region validation, cross-region proxy |
| `apps/runtime/src/routes/region.routes.ts`                    | Public region API (list, health, tenant region)     |
| `apps/admin/src/routes/region-admin.routes.ts`                | Admin region CRUD, migration, failover endpoints    |
| `apps/studio/src/app/api/admin/regions/route.ts`              | Studio admin region management API routes           |
| `apps/studio/src/app/api/admin/tenants/[id]/migrate/route.ts` | Tenant migration initiation endpoint                |

### UI Components

| File                                                         | Purpose                                              |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| `apps/studio/src/components/admin/RegionManagement.tsx`      | Region list with health indicators and actions       |
| `apps/studio/src/components/admin/RegionTopologyMap.tsx`     | Visual topology map of regions and replication links |
| `apps/studio/src/components/admin/TenantMigrationDialog.tsx` | Migration initiation and progress tracking dialog    |
| `apps/studio/src/components/admin/FailoverDashboard.tsx`     | Failover event history and manual trigger            |
| `apps/studio/src/components/settings/TenantRegionInfo.tsx`   | Tenant-facing region display with health badge       |
| `apps/admin/src/pages/regions/index.tsx`                     | Admin portal region management page                  |
| `apps/admin/src/pages/regions/topology.tsx`                  | Admin portal topology visualization page             |

### Jobs / Workers / Background Processes

| File                                                          | Purpose                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/runtime/src/workers/region-health-monitor.worker.ts`    | Periodic health check collection and score computation     |
| `apps/runtime/src/workers/replication-lag-monitor.worker.ts`  | Cross-region replication lag polling and alerting          |
| `apps/runtime/src/workers/tenant-migration.worker.ts`         | Background tenant data replication and migration execution |
| `apps/runtime/src/workers/failover-controller.worker.ts`      | Automated failover detection, DNS update, traffic redirect |
| `apps/runtime/src/workers/region-metrics-collector.worker.ts` | Region metrics aggregation and ClickHouse ingestion        |

### Tests

| File                                                             | Type        | Coverage Focus                                      |
| ---------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `packages/shared/src/__tests__/region/region-registry.test.ts`   | unit        | Registry CRUD, topology graph, region lookup        |
| `packages/shared/src/__tests__/region/region-router.test.ts`     | unit        | Routing logic, failover resolution, proxy decisions |
| `packages/shared/src/__tests__/region/region-health.test.ts`     | unit        | Health score computation, threshold evaluation      |
| `packages/shared/src/__tests__/region/tenant-migration.test.ts`  | unit        | Migration state machine transitions                 |
| `apps/runtime/src/__tests__/region-routing.e2e.test.ts`          | e2e         | Full region routing through HTTP API                |
| `apps/runtime/src/__tests__/region-failover.e2e.test.ts`         | e2e         | Failover detection and traffic redirect             |
| `apps/runtime/src/__tests__/region-migration.e2e.test.ts`        | e2e         | Tenant migration lifecycle via API                  |
| `apps/runtime/src/__tests__/region-data-sovereignty.e2e.test.ts` | e2e         | Data residency enforcement verification             |
| `apps/admin/src/__tests__/region-admin.integration.test.ts`      | integration | Admin region CRUD and tenant assignment             |

---

## 11. Configuration

### Environment Variables

| Variable                             | Default    | Description                                                          |
| ------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `REGION_ID`                          | (required) | Current region identifier (e.g., `us-east-1`)                        |
| `REGION_DISPLAY_NAME`                | (required) | Human-readable region name (e.g., `US East (Virginia)`)              |
| `REGION_CLOUD_PROVIDER`              | `aws`      | Cloud provider for this region (`aws`, `azure`, `gcp`)               |
| `REGION_FAILOVER_TARGET`             | (optional) | Default failover target region ID                                    |
| `REGION_HEALTH_CHECK_INTERVAL_MS`    | `10000`    | Health check polling interval in milliseconds                        |
| `REGION_UNHEALTHY_THRESHOLD`         | `6`        | Consecutive unhealthy checks before failover trigger                 |
| `REGION_REPLICATION_LAG_WARN_MS`     | `5000`     | Replication lag warning threshold in milliseconds                    |
| `REGION_REPLICATION_LAG_CRITICAL_MS` | `30000`    | Replication lag critical threshold in milliseconds                   |
| `REGION_CROSS_REGION_TIMEOUT_MS`     | `5000`     | Timeout for cross-region proxy requests                              |
| `REGION_CROSS_REGION_RETRIES`        | `2`        | Retry count for failed cross-region requests                         |
| `REGION_MTLS_CERT_PATH`              | (optional) | Path to mTLS certificate for cross-region communication              |
| `REGION_MTLS_KEY_PATH`               | (optional) | Path to mTLS private key for cross-region communication              |
| `REGION_MTLS_CA_PATH`                | (optional) | Path to mTLS CA certificate for cross-region communication           |
| `MONGO_READ_PREFERENCE`              | `primary`  | MongoDB read preference (`primary`, `secondaryPreferred`, `nearest`) |
| `MONGO_MAX_STALENESS_SECONDS`        | `5`        | Maximum staleness for secondary reads                                |
| `CLICKHOUSE_SHARD_NAME`              | (auto)     | ClickHouse shard identifier for this region                          |

### Runtime Configuration

- **Region status toggle**: Platform operators can set region status to `active`, `draining`, or `inactive` via admin API. `draining` stops accepting new tenant assignments but continues serving existing tenants.
- **Per-tenant staleness tolerance**: Configurable via tenant settings. Compliance-strict tenants may set to `0` (primary reads only), while latency-sensitive tenants may accept up to `30s` staleness.
- **Failover policy**: Per-region configurable: `automatic` (default), `manual` (requires operator trigger), or `disabled` (no failover).
- **Migration concurrency**: Maximum concurrent migrations per region (default: 5) to prevent resource exhaustion.
- **Feature flags**:
  - `MULTI_REGION_ENABLED`: Master toggle for multi-region features (default: `false`)
  - `CROSS_REGION_READS_ENABLED`: Enable read-replica serving (default: `false`, Phase 2)
  - `AUTO_FAILOVER_ENABLED`: Enable automated failover (default: `false`, Phase 3)
  - `ACTIVE_ACTIVE_ENABLED`: Enable active-active mode (default: `false`, Phase 4)

### DSL / Agent IR / Schema

Multi-region is transparent to the DSL and Agent IR. No DSL syntax changes required. The region is resolved at runtime from the tenant context, not from the agent definition.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every tenant-scoped query includes `tenantId` AND routes to the tenant's `homeRegion` database. Cross-tenant access returns 404. Cross-region data access for a tenant is prohibited unless the request is proxied to the home region.                |
| Project isolation | Projects inherit the tenant's `homeRegion`. All project-scoped queries include `projectId` and are routed to the tenant's home region. Cross-project access within the same region returns 404.                                                       |
| User isolation    | User-owned resources (sessions, API keys) are filtered by `createdBy`/`ownerId` within the tenant's home region. Cross-region user access is proxied transparently.                                                                                   |
| Region isolation  | Data for a tenant pinned to `eu-west-1` must never be persisted in a different region's primary storage. Read replicas may contain copies but writes are always to the home region. Compliance-strict tenants may disable cross-region read replicas. |

### Security & Compliance

- **Cross-region encryption**: All inter-region traffic encrypted via mTLS. Certificates rotated per the platform's certificate rotation policy (default: 90 days).
- **Data sovereignty enforcement**: Write operations validate `tenant.homeRegion === currentRegion` at the middleware layer. Violations are rejected with 421 Misdirected Request (RFC 7540 Section 9.1.2) and logged to the compliance audit trail.
- **Compliance tags**: Regions carry compliance tags (GDPR, HIPAA, PCI-DSS). Tenant provisioning validates that the assigned region satisfies the tenant's compliance requirements.
- **Audit trail**: All cross-region data access events logged to `cross_region_audit_log` with source region, target region, tenant ID, event type, and timestamp. Stored in the tenant's home region.
- **Encryption key isolation**: Encryption master keys and KMS configurations are region-specific. A tenant's encryption keys are derived and stored in the tenant's home region only. Cross-region key sharing is prohibited.

### Performance & Scalability

- **Latency targets**: P50 < 50ms, P95 < 100ms, P99 < 200ms for in-region read operations. Cross-region proxy adds 50-150ms depending on distance.
- **Replication lag**: Target < 1s for MongoDB oplog replication, < 100ms for Redis CRDT sync, < 5s for ClickHouse async replication.
- **DNS resolution**: Geo-DNS resolution overhead < 50ms. TTL set to 60s for health-responsive routing.
- **Failover time**: RTO < 5 minutes (time from failure detection to traffic serving in new region). RPO < 30 seconds (maximum data loss during failover).
- **Migration throughput**: Target 1 GB/minute per tenant migration, parallelized across collections. A 10 GB tenant migrates in ~10 minutes.
- **Cross-region bandwidth**: Minimize by replicating only necessary data. Session cache replication limited to active sessions. ClickHouse replication uses compressed batches.
- **Connection pooling**: Per-region MongoDB connection pools sized to regional load. Cross-region proxy connections pooled with keep-alive.

### Reliability & Failure Modes

- **Region failure**: Automated failover redirects traffic to the designated failover region. DNS TTL (60s) ensures propagation within 2 minutes. Failover region serves from replicated data.
- **Replication lag spike**: If replication lag exceeds the configured threshold, the system downgrades cross-region reads to primary-only (proxied to home region) and alerts operators.
- **Split brain prevention**: During failover, the old primary is fenced (removed from DNS, connections drained) before the new primary accepts writes. MongoDB replica set election ensures single-primary guarantee.
- **Migration failure**: Migrations are resumable. If a migration fails mid-replication, the tenant continues serving from the source region. Rollback cleans up partial data in the target region.
- **Cross-region network partition**: Circuit breakers on cross-region calls prevent cascading failures. Tenants whose home region is reachable continue serving normally; tenants requiring cross-region proxy receive 503 with retry-after header.
- **Degraded mode**: If cross-region communication is down but the local region is healthy, the system serves local tenants normally and returns 503 for proxied requests with a `Retry-After` header.

### Observability

- **Metrics** (Prometheus / OpenTelemetry):
  - `region_health_score{region_id}`: 0-100 health score per region
  - `region_replication_lag_ms{region_id, store}`: Replication lag by store (mongo, redis, clickhouse)
  - `region_cross_region_latency_ms{source, target}`: Latency between region pairs
  - `region_failover_events_total{region_id, type}`: Failover event counter
  - `region_migration_progress{tenant_id, source, target}`: Migration completion percentage
  - `region_active_tenants{region_id}`: Tenant count per region
  - `region_cross_region_requests_total{source, target, status}`: Cross-region proxy traffic
- **Dashboards**: Grafana dashboards for region health, replication topology, failover history, migration progress, and compliance status.
- **Alerts**:
  - CRITICAL: Region health score < 20, replication lag > 30s, failover initiated
  - WARNING: Region health score < 50, replication lag > 5s, migration stalled, capacity > 80%
  - INFO: Region status change, tenant migration completed, failover completed
- **Trace correlation**: Cross-region requests include `X-Region-Source` and `X-Region-Trace-Id` headers for distributed trace stitching across regions.

### Data Lifecycle

- **Region health snapshots**: 7-day TTL, auto-expired via MongoDB TTL index.
- **Cross-region audit logs**: Retained per tenant's audit log retention policy (default: 2 years for compliance).
- **Migration records**: Retained for 90 days after completion, then archived.
- **Region metrics (ClickHouse)**: 90-day TTL on `region_metrics` table.
- **Tenant data after migration**: Source region retains data for `sourceRetentionDays` (default: 30) as rollback safety net, then permanently deleted.
- **Decommissioned regions**: All tenant data must be migrated out before a region can be decommissioned. Region config retained as `inactive` for audit trail.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 1 — Single-Region Foundation** (Sprint 1-2)
   1.1 Create `region_configs` collection and `RegionRegistry` service
   1.2 Add `homeRegion` field to tenant model with migration script (default to current single region)
   1.3 Implement `region-routing.middleware.ts` — validate tenant home region, log cross-region attempts
   1.4 Create admin API for region CRUD (`/api/admin/regions`)
   1.5 Create public region API (`/api/v1/regions`, `/api/v1/tenant/region`)
   1.6 Implement region health monitoring worker and `region_health_snapshots` collection
   1.7 Set up Terraform modules for multi-region VPC peering and DNS infrastructure
   1.8 Set up Helm values templating for per-region deployments
   1.9 Admin portal: Region management page with health indicators
   1.10 Studio: Tenant region display in settings

2. **Phase 2 — Read Replicas** (Sprint 3-4)
   2.1 Configure MongoDB cross-region replica sets (secondaries in remote regions)
   2.2 Implement `readPreference: secondaryPreferred` with `maxStalenessSeconds` for local reads
   2.3 Implement cross-region request proxy in `region-routing.middleware.ts`
   2.4 Set up ClickHouse `ReplicatedMergeTree` tables with per-region shards
   2.5 Create ClickHouse `Distributed` tables for cross-region analytics queries
   2.6 Implement replication lag monitoring worker for MongoDB and ClickHouse
   2.7 Add replication lag metrics to Prometheus and Grafana dashboards
   2.8 Create cross-region audit log collection and event emission
   2.9 Integration tests for read replica routing and staleness enforcement

3. **Phase 3 — Active-Passive Failover** (Sprint 5-7)
   3.1 Implement failover controller worker with health threshold evaluation
   3.2 Implement DNS update automation (Route53 / CloudFlare API integration)
   3.3 Configure Redis Sentinel with cross-region replicas for session continuity
   3.4 Implement session handoff protocol for cross-region failover
   3.5 Implement tenant migration state machine and worker
   3.6 Create migration admin API and progress tracking
   3.7 Implement mTLS for all cross-region communication
   3.8 Admin portal: Failover dashboard with manual trigger
   3.9 Admin portal: Tenant migration dialog with progress tracker
   3.10 E2E tests for failover scenario and tenant migration
   3.11 Chaos engineering: simulate region failure, validate failover within RTO target

4. **Phase 4 — Active-Active** (Sprint 8-10)
   4.1 Set up Redis Enterprise Active-Active with CRDT-based replication (or implement custom CRDT layer)
   4.2 Implement MongoDB zone sharding for tenant data pinning
   4.3 Implement conflict resolution for active-active writes (last-writer-wins with vector clocks)
   4.4 Cross-region BullMQ job federation layer
   4.5 Rate limit counter CRDT synchronization across regions
   4.6 Admin portal: Global topology map with real-time traffic flow
   4.7 Compliance dashboard: Data residency report generation
   4.8 Performance benchmarking: cross-region latency, replication convergence
   4.9 E2E tests for active-active write convergence and conflict resolution
   4.10 Load testing: multi-region traffic distribution under stress

---

## 14. Success Metrics

| Metric                         | Baseline (single-region) | Target                 | How Measured                                                         |
| ------------------------------ | ------------------------ | ---------------------- | -------------------------------------------------------------------- |
| In-region read P95 latency     | N/A (single region)      | < 100ms                | Prometheus `http_request_duration_seconds` histogram                 |
| Cross-region proxy P95 latency | N/A                      | < 300ms                | Prometheus `region_cross_region_latency_ms` histogram                |
| Regional failover RTO          | Hours (manual)           | < 5 minutes            | Time from failure detection to traffic serving in failover region    |
| Regional failover RPO          | Unbounded                | < 30 seconds           | Maximum replication lag at time of failover                          |
| MongoDB replication lag P95    | N/A                      | < 1 second             | `region_replication_lag_ms{store="mongo"}` P95                       |
| Redis replication lag P95      | N/A                      | < 100ms                | `region_replication_lag_ms{store="redis"}` P95                       |
| Data sovereignty compliance    | N/A                      | 100% (zero violations) | `cross_region_audit_log` events with type `cross_region_write_proxy` |
| Tenant migration success rate  | N/A                      | > 99%                  | `tenant_migrations` collection: completed / total                    |
| Tenant migration zero-downtime | N/A                      | 0 dropped requests     | Error rate during migration window                                   |
| Platform global availability   | 99.9% (single region)    | 99.99% (multi-region)  | Synthetic monitoring across all regions                              |
| Cross-region bandwidth cost    | N/A                      | < 5% of compute cost   | Cloud provider billing reports                                       |

---

## 15. Open Questions

1. **Redis strategy**: Should we invest in Redis Enterprise Active-Active (CRDT-native, vendor-managed) or build a custom replication layer on open-source Redis? Redis Enterprise simplifies conflict resolution but adds licensing cost and vendor lock-in.
2. **MongoDB topology**: Should we use a single large replica set spanning regions (simpler) or zone-sharded clusters (more scalable but operationally complex)? The sharded approach is recommended for Phase 4 active-active, but may be premature for Phase 2-3.
3. **DNS provider**: Should we standardize on Route53 (AWS-native, latency-based routing built-in) or CloudFlare (cloud-agnostic, Anycast, geo-steering)? Route53 is more granular; CloudFlare is more cloud-neutral.
4. **ClickHouse Keeper topology**: Should each region run its own ClickHouse Keeper cluster (simpler, avoids cross-region latency on ZK writes) or share a global Keeper (simpler coordination but high-latency writes)? Per-region Keeper with async table replication is recommended.
5. **Conflict resolution strategy**: For active-active (Phase 4), should we use last-writer-wins (simple, lossy) or application-level CRDTs (complex, lossless)? Different data types may warrant different strategies.
6. **Tenant migration SLA**: What is the acceptable migration window for large tenants (>100 GB)? Should we support incremental migration with change data capture, or full-copy-then-switch?
7. **Cost allocation**: How should cross-region data transfer costs be attributed to tenants? Should high-bandwidth tenants pay a premium for multi-region reads?
8. **Compliance certification**: Which specific compliance frameworks (GDPR, HIPAA, PCI-DSS, SOC2, ISO 27001) must be certified per region at launch?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No backup/disaster-recovery feature spec exists yet. Multi-region failover and region-pinned backups depend on a backup strategy that respects data residency.                                             | High     | Open   |
| GAP-002 | MongoDB zone sharding requires careful shard key design. Current `tenantId` is a UUID string; hashed sharding may not provide clean zone boundaries. May need a composite key with region prefix.          | High     | Open   |
| GAP-003 | ClickHouse cross-region replication with per-region Keeper clusters requires a custom sync mechanism (no native cross-Keeper replication). Altinity Kubernetes Operator may help.                          | Medium   | Open   |
| GAP-004 | Redis Enterprise Active-Active licensing cost is significant. Open-source Redis does not natively support CRDTs. A custom replication layer would need to handle conflict resolution for BullMQ job state. | Medium   | Open   |
| GAP-005 | Cross-region mTLS certificate management is not yet integrated with the platform's existing certificate infrastructure. A certificate distribution mechanism for multi-cluster is needed.                  | Medium   | Open   |
| GAP-006 | Current session management uses a single Redis instance. Cross-region session handoff during failover requires session data replication, which adds complexity to the WebSocket reconnection flow.         | High     | Open   |
| GAP-007 | Tenant migration for large datasets (>100 GB) may exceed acceptable downtime windows. Change data capture (CDC) for incremental migration is not yet designed.                                             | Medium   | Open   |
| GAP-008 | The `abl-platform-deploy` repo does not currently support multi-cluster ArgoCD ApplicationSets. Helm values templating needs restructuring for per-region overrides.                                       | High     | Open   |
| GAP-009 | Rate limiting counters are currently Redis-local. Cross-region rate limit aggregation (to enforce global tenant limits) requires CRDT counters or a coordination service.                                  | Medium   | Open   |
| GAP-010 | No cost modeling exists for cross-region data transfer. Excessive replication (e.g., replicating all ClickHouse analytics data) could significantly increase cloud provider egress costs.                  | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                       | Coverage Type | Status     | Test File / Note                          |
| --- | ---------------------------------------------- | ------------- | ---------- | ----------------------------------------- |
| 1   | Region CRUD via admin API                      | e2e           | NOT TESTED | `region-routing.e2e.test.ts`              |
| 2   | Tenant region assignment at provisioning       | e2e           | NOT TESTED | `region-routing.e2e.test.ts`              |
| 3   | Request routing to tenant home region          | e2e           | NOT TESTED | `region-routing.e2e.test.ts`              |
| 4   | Cross-region read replica serving              | integration   | NOT TESTED | `region-replication.integration.test.ts`  |
| 5   | Data sovereignty enforcement (write rejection) | e2e           | NOT TESTED | `region-data-sovereignty.e2e.test.ts`     |
| 6   | Automated failover on region failure           | e2e           | NOT TESTED | `region-failover.e2e.test.ts`             |
| 7   | Tenant migration lifecycle                     | e2e           | NOT TESTED | `region-migration.e2e.test.ts`            |
| 8   | Replication lag monitoring and alerting        | integration   | NOT TESTED | `replication-monitor.integration.test.ts` |
| 9   | Cross-region mTLS authentication               | integration   | NOT TESTED | `cross-region-auth.integration.test.ts`   |
| 10  | Region health score computation                | unit          | NOT TESTED | `region-health.test.ts`                   |
| 11  | Migration state machine transitions            | unit          | NOT TESTED | `tenant-migration.test.ts`                |
| 12  | Failover DNS update automation                 | integration   | NOT TESTED | `failover-controller.integration.test.ts` |
| 13  | Active-active write convergence                | e2e           | NOT TESTED | `active-active.e2e.test.ts` (Phase 4)     |
| 14  | Compliance audit log generation                | integration   | NOT TESTED | `cross-region-audit.integration.test.ts`  |

### Testing Notes

All test scenarios are currently NOT TESTED as this feature is in PLANNED status. Testing strategy is documented in the companion testing guide. Key testing challenges include:

- Multi-region E2E tests require either multi-cluster test infrastructure or a simulation layer that emulates region separation.
- Failover tests require the ability to simulate region failures (network partitions, service unavailability).
- Data sovereignty tests must verify at the storage layer (DB queries) that data never persists in the wrong region.

> Full testing details: [../testing/multi-region-geo-routing.md](../testing/multi-region-geo-routing.md)

---

## 18. References

- Design docs: `docs/specs/multi-region-geo-routing.hld.md` (to be created)
- Reference docs: `docs/feature-matrix.md`, `docs/enterprise-readiness.md`
- Related feature docs:
  - [Encryption at Rest](./encryption-at-rest.md)
  - [Rate Limiting](./rate-limiting.md)
  - [Tenant LLM Policy](./tenant-llm-policy.md)
  - [Session Management](./memory-sessions.md)
  - [Audit Logging](./audit-logging.md)
- External references:
  - [MongoDB Multi-Region Deployment Paradigm](https://www.mongodb.com/docs/atlas/architecture/current/deployment-paradigms/multi-region/)
  - [Redis Active-Active Geo-Distribution](https://redis.io/active-active/)
  - [ClickHouse Multi-Region Replication FAQ](https://clickhouse.com/docs/faq/operations/multi-region-replication)
  - [AWS Multi-Region Architecture Guide](https://aws.amazon.com/blogs/migration-and-modernization/mastering-multi-region-resilience-and-scalability-active-active-design-with-amazon-elasticache-redis/)
  - [GDPR Data Residency Requirements](https://www.kiteworks.com/gdpr-compliance/understand-and-adhere-to-gdpr-data-residency-requirements/)
  - [Data Residency Laws by Country (2026)](https://www.signzy.com/blogs/data-residency-laws-and-requirements-by-region)
  - [Altinity: Cross-Region ClickHouse Replication in Kubernetes](https://altinity.com/blog/setting-up-cross-region-clickhouse-replication-in-kubernetes)
  - [Cloudflare Geo Steering](https://developers.cloudflare.com/load-balancing/understand-basics/traffic-steering/steering-policies/geo-steering/)
