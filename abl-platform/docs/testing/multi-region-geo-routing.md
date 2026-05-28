# Testing Guide: Multi-Region / Geo-Routing

**Feature**: [Multi-Region / Geo-Routing](../features/multi-region-geo-routing.md)
**Status**: NOT STARTED
**Last Updated**: 2026-03-23

---

## Quick Health Dashboard

| Area                        | Status     | Notes                                       |
| --------------------------- | ---------- | ------------------------------------------- |
| Unit Tests                  | NOT TESTED | Feature is PLANNED — no implementation yet  |
| Integration Tests           | NOT TESTED | Requires multi-region test infrastructure   |
| E2E Tests                   | NOT TESTED | Requires multi-cluster or region simulation |
| Data Sovereignty Validation | NOT TESTED | Critical compliance path — highest priority |
| Failover Testing            | NOT TESTED | Requires chaos engineering infrastructure   |
| Migration Testing           | NOT TESTED | Requires dual-region data replication setup |
| Performance Benchmarks      | NOT TESTED | Requires multi-region deployment            |

---

## 1. Coverage Matrix

| FR    | Description                                        | Unit | Integration | E2E | Manual | Status     |
| ----- | -------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Region configs collection and registry             | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-2  | Tenant homeRegion assignment at provisioning       | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-3  | Data residency enforcement (writes to home region) | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-4  | Geo-DNS configuration and health-based routing     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-5  | Region-aware API gateway / middleware              | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-6  | MongoDB cross-region read replicas                 | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-7  | Redis cross-region replication                     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-8  | ClickHouse cross-region replicated tables          | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-9  | Automated regional failover                        | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-10 | Zero-downtime tenant migration                     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-11 | Cross-region mTLS encryption                       | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-12 | Compliance audit log for cross-region events       | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-13 | Region-specific rate limits and quotas             | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-14 | Region health metrics exposure                     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-15 | Backup data residency enforcement                  | NO   | NO          | NO  | NO     | NOT TESTED |

---

## 2. Existing Test Inventory

### Unit Tests

None — feature is in PLANNED status.

### Integration Tests

None — feature is in PLANNED status.

### E2E Tests

None — feature is in PLANNED status.

---

## 3. E2E Test Scenarios (Mandatory — minimum 5)

### E2E-1: Region Routing — Tenant Requests Reach Home Region

**Objective**: Verify that an authenticated request from a tenant pinned to `eu-west-1` is served by the EU region's runtime, and that the request never touches the US region's database for write operations.

**Prerequisites**:

- Two runtime instances running: one configured as `REGION_ID=us-east-1`, one as `REGION_ID=eu-west-1`.
- Region registry populated with both regions.
- A tenant `tenant-eu-001` provisioned with `homeRegion: "eu-west-1"`.
- Separate MongoDB instances (or logical separation) per region.

**Steps**:

1. Authenticate as `tenant-eu-001` and send POST `/api/v1/projects` to create a new project.
2. Assert 201 response with project data.
3. Query the EU region's MongoDB to verify the project document exists with `tenantId: "tenant-eu-001"` and the document was written to the EU database.
4. Query the US region's MongoDB to verify the project document does NOT exist in the US primary database (it may appear in read replicas with a delay, but must not be a primary write).
5. Send GET `/api/v1/projects/:projectId` from the EU region — assert 200 with project data.
6. Send GET `/api/v1/projects/:projectId` from the US region (if proxying is enabled) — assert the request is proxied to EU and returns the same data.

**Expected Result**: Write operations for EU-pinned tenant are persisted in EU MongoDB only. Cross-region proxy returns data from the home region.

**Validates**: FR-2 (home region assignment), FR-3 (data residency enforcement), FR-5 (region-aware middleware)

---

### E2E-2: Regional Failover — Automatic Traffic Redirect

**Objective**: Verify that when the primary region becomes unhealthy, tenant traffic is automatically redirected to the failover region within the RTO target (< 5 minutes).

**Prerequisites**:

- Two regions: `us-east-1` (primary) and `us-west-2` (failover target).
- Region config: `us-east-1.failoverConfig.failoverTargetRegionId = "us-west-2"`.
- Tenant `tenant-us-001` pinned to `us-east-1`.
- MongoDB replica set with members in both regions.
- Failover controller worker running.

**Steps**:

1. Verify `tenant-us-001` can successfully make API calls to `us-east-1` runtime.
2. Simulate `us-east-1` failure: stop the runtime process, or block the health check endpoint to return 503.
3. Wait for the failover controller to detect unhealthy status (observe `region_health_snapshots` — health score should drop below threshold after `unhealthyThresholdCount` consecutive checks).
4. Verify the failover controller updates `us-east-1` status to `failover_target` or `inactive`.
5. Verify DNS records are updated to point `tenant-us-001` traffic to `us-west-2`.
6. Send API requests as `tenant-us-001` — verify they are now served by `us-west-2` runtime.
7. Verify a `failover_initiated` event in `cross_region_audit_log`.
8. Measure total time from failure simulation to successful request serving in failover region — assert < 5 minutes.

**Expected Result**: Automatic failover detects region failure, updates DNS, and redirects tenant traffic within RTO. Audit log records the event.

**Validates**: FR-9 (automated failover), FR-12 (compliance audit log), FR-14 (health metrics)

---

### E2E-3: Data Sovereignty — Cross-Region Write Rejection

**Objective**: Verify that the system rejects attempts to write data for an EU-pinned tenant to a non-EU region, returning 421 Misdirected Request.

**Prerequisites**:

- EU region (`eu-west-1`) and US region (`us-east-1`) both active.
- Tenant `tenant-gdpr-001` pinned to `eu-west-1` with `regionComplianceRequirement: "strict"`.
- Region routing middleware deployed.

**Steps**:

1. Authenticate as `tenant-gdpr-001`.
2. Send a POST request directly to the `us-east-1` runtime endpoint (bypassing geo-DNS) to create an agent: POST `https://us-east-1.api.platform.com/api/v1/projects/:projectId/agents` with agent definition body.
3. Assert the response is `421 Misdirected Request` with body `{ success: false, error: { code: "REGION_MISMATCH", message: "Tenant is pinned to eu-west-1. Write operations must be directed to the home region." } }`.
4. Verify a `cross_region_write_proxy` event (or rejection event) is logged to `cross_region_audit_log` with `sourceRegion: "us-east-1"`, `targetRegion: "eu-west-1"`.
5. Verify the agent was NOT created in the `us-east-1` MongoDB.
6. Send the same POST request to the `eu-west-1` runtime endpoint — assert 201 success.
7. Verify the agent exists in the `eu-west-1` MongoDB only.

**Expected Result**: Write operations to the wrong region are rejected with 421. No data persists in the non-home region. Compliance audit trail captures the violation attempt.

**Validates**: FR-3 (data residency enforcement), FR-5 (region-aware middleware), FR-12 (audit log)

---

### E2E-4: Cross-Region Replication — Read Replica Serving

**Objective**: Verify that a tenant's data, written in the home region, is readable from a remote region's read replica within the configured staleness tolerance.

**Prerequisites**:

- Two regions with MongoDB replica set spanning both.
- Tenant `tenant-us-002` pinned to `us-east-1`.
- `CROSS_REGION_READS_ENABLED=true`.
- `MONGO_READ_PREFERENCE=secondaryPreferred` in `us-west-2`.
- `MONGO_MAX_STALENESS_SECONDS=5`.

**Steps**:

1. Authenticate as `tenant-us-002` and create a project via `us-east-1` runtime: POST `/api/v1/projects`.
2. Assert 201 response.
3. Wait up to 5 seconds (staleness tolerance).
4. Send GET `/api/v1/projects/:projectId` to `us-west-2` runtime — assert 200 with the project data, indicating the read replica served the request.
5. Verify response header `X-Served-By-Region: us-west-2` (or equivalent) confirming local serving.
6. Verify replication lag metric `region_replication_lag_ms{region_id="us-west-2", store="mongo"}` is below the staleness threshold.
7. Create another project via `us-east-1` and immediately (within 100ms) attempt to read from `us-west-2` — depending on replication lag, the response may be 200 (if replicated) or should gracefully handle staleness.

**Expected Result**: Data written in the home region is readable from a remote read replica within the staleness window. The read is served locally, not proxied.

**Validates**: FR-6 (MongoDB cross-region read replicas), FR-3 (staleness tolerance), FR-14 (replication lag metrics)

---

### E2E-5: Tenant Migration — Zero-Downtime Region Transfer

**Objective**: Verify that a tenant can be migrated from one region to another without request failures during the migration window.

**Prerequisites**:

- Two regions: `us-east-1` (source) and `eu-west-1` (target).
- Tenant `tenant-migrate-001` pinned to `us-east-1` with existing projects, agents, and session data.
- Migration worker running.

**Steps**:

1. Verify `tenant-migrate-001` is fully operational in `us-east-1`: create a project, run an agent session, verify data.
2. Initiate migration via admin API: POST `/api/admin/tenants/tenant-migrate-001/migrate` with `{ targetRegion: "eu-west-1" }`.
3. Assert 202 Accepted with migration ID.
4. Poll migration status: GET `/api/admin/tenants/tenant-migrate-001/migration/status`.
5. During migration (while status is `replicating`), send API requests as `tenant-migrate-001` — assert all requests succeed (served from source region during replication).
6. Wait for migration status to reach `switching`.
7. During the switch phase, send API requests — assert requests continue to succeed (brief pause acceptable, but no errors).
8. Wait for migration status to reach `completed`.
9. Verify `tenant-migrate-001.homeRegion` is now `eu-west-1`.
10. Send API requests — verify they are served by `eu-west-1` runtime.
11. Verify all data (projects, agents, sessions) is accessible from `eu-west-1`.
12. Verify source data in `us-east-1` is retained for the configured retention period.
13. Verify `migration_started` and `migration_completed` events in `cross_region_audit_log`.

**Expected Result**: Tenant migration completes without request failures. All data is accessible in the target region. Audit trail records the migration.

**Validates**: FR-10 (zero-downtime migration), FR-12 (audit log), FR-2 (homeRegion update)

---

### E2E-6: Region Health Monitoring and Metrics Exposure

**Objective**: Verify that region health metrics are collected, health scores computed accurately, and exposed via both the admin API and Prometheus endpoints.

**Prerequisites**:

- At least two active regions.
- Region health monitor worker running.
- Prometheus scrape endpoint configured.

**Steps**:

1. GET `/api/admin/regions` — verify both regions listed with `status: "active"` and health data populated.
2. GET `/api/admin/regions/us-east-1/health` — verify response includes `healthScore`, `metrics` (latency percentiles, availability, error rate, replication lag), and per-store status (mongo, redis, clickhouse).
3. Scrape the Prometheus endpoint (`/metrics`) — verify `region_health_score{region_id="us-east-1"}` gauge exists with value 0-100.
4. Verify `region_replication_lag_ms` metrics exist for each store type.
5. Simulate degraded conditions (e.g., increase artificial latency on MongoDB queries) — verify health score decreases.
6. Verify `region_health_snapshots` collection contains recent snapshots with appropriate TTL.
7. Restore healthy conditions — verify health score recovers.

**Expected Result**: Health metrics accurately reflect region state, are queryable via API, and are exposed to Prometheus for alerting.

**Validates**: FR-14 (health metrics exposure), FR-1 (region configs), FR-9 (health threshold for failover)

---

### E2E-7: Compliance Audit Trail for Cross-Region Operations

**Objective**: Verify that all cross-region operations (data access, failover, migration, region changes) are logged to the compliance audit trail in the tenant's home region.

**Prerequisites**:

- Two active regions.
- Compliance audit log collection configured.
- Tenant with cross-region activity history.

**Steps**:

1. As `tenant-audit-001` (pinned to `eu-west-1`), trigger a cross-region read from `us-east-1` by querying a replicated resource.
2. Verify `cross_region_audit_log` contains a `cross_region_read` event with `tenantId`, `sourceRegion: "us-east-1"`, `targetRegion: "eu-west-1"`, and timestamp.
3. Change the tenant's region assignment: PUT `/api/admin/tenants/tenant-audit-001` with `{ homeRegion: "us-east-1" }`.
4. Verify `region_assignment_changed` event in audit log.
5. Trigger a failover event (or simulate one) — verify `failover_initiated` and `failover_completed` events.
6. GET `/api/admin/compliance/data-residency` — verify the report lists all cross-region events for the tenant.
7. Verify audit log entries are stored in the tenant's home region database (not a central region).

**Expected Result**: Complete audit trail of all cross-region operations, stored in the tenant's home region for compliance.

**Validates**: FR-12 (compliance audit log), FR-3 (data residency for audit data)

---

## 4. Integration Test Scenarios (Mandatory — minimum 5)

### INT-1: Region Registry CRUD and Topology Resolution

**Objective**: Test that the `RegionRegistry` service correctly manages region configurations, computes topology graphs, and resolves failover targets.

**Setup**: In-memory or MongoMemoryServer with `region_configs` collection.

**Steps**:

1. Register three regions: `us-east-1`, `eu-west-1`, `ap-southeast-1` via `RegionRegistry.registerRegion()`.
2. Verify `getRegion("us-east-1")` returns the full region configuration.
3. Verify `listRegions({ status: "active" })` returns all three.
4. Set `us-east-1` failover target to `us-west-2`. Verify `getFailoverTarget("us-east-1")` returns `us-west-2`.
5. Compute topology graph via `getTopology()` — verify it returns nodes (regions) and edges (failover relationships, replication links).
6. Update `eu-west-1` status to `draining` — verify `listRegions({ status: "active" })` returns only two.
7. Attempt to register a region with a duplicate `regionId` — verify it throws a conflict error.
8. Attempt to delete a region with active tenants — verify it rejects with an error.

**Validates**: FR-1 (region configs collection), region topology computation

---

### INT-2: Region Routing Middleware — Tenant Home Region Validation

**Objective**: Test that the region routing middleware correctly identifies whether a request should be served locally or proxied to the tenant's home region.

**Setup**: Express app with region routing middleware, mocked region registry, two simulated regions.

**Steps**:

1. Configure middleware with `REGION_ID=us-east-1`.
2. Send a request with tenant context `{ tenantId: "t-001", homeRegion: "us-east-1" }` — verify middleware passes through (local serving).
3. Send a request with tenant context `{ tenantId: "t-002", homeRegion: "eu-west-1" }` — verify middleware triggers cross-region proxy to `eu-west-1` endpoint.
4. Send a write request (POST) with tenant `{ homeRegion: "eu-west-1" }` and `regionComplianceRequirement: "strict"` — verify middleware returns 421 Misdirected Request (strict tenants reject proxy, must be direct).
5. Send a read request (GET) with tenant `{ homeRegion: "eu-west-1" }` and `CROSS_REGION_READS_ENABLED=true` — verify middleware serves from local read replica.
6. Send a read request with `CROSS_REGION_READS_ENABLED=false` — verify middleware proxies to home region.
7. Verify `X-Region-Source` header is set on all responses.

**Validates**: FR-5 (region-aware middleware), FR-3 (data residency enforcement)

---

### INT-3: Tenant Migration State Machine

**Objective**: Test that the tenant migration state machine transitions correctly through all states and handles failures gracefully.

**Setup**: `TenantMigrationService` with mocked data replication and region assignment services.

**Steps**:

1. Initiate migration for `tenant-001` from `us-east-1` to `eu-west-1`.
2. Verify initial state is `pending`.
3. Trigger start — verify transition to `replicating`.
4. Simulate replication progress updates — verify `progress.percentComplete` increases.
5. Mark replication complete — verify transition to `switching`.
6. Execute switch (update `homeRegion` pointer) — verify transition to `draining`.
7. Simulate drain completion (no in-flight requests from source) — verify transition to `cleanup`.
8. Simulate cleanup completion — verify transition to `completed`.
9. Test failure during replication: simulate replication error — verify state transitions to `failed` and `rollbackAvailable: true`.
10. Execute rollback — verify state transitions to `rolled_back` and tenant remains in source region.
11. Attempt to start a second migration while one is in progress — verify rejection with conflict error.

**Validates**: FR-10 (zero-downtime migration), migration state machine robustness

---

### INT-4: Replication Lag Monitor — Threshold Alerting

**Objective**: Test that the replication lag monitor correctly measures lag across MongoDB, Redis, and ClickHouse, and triggers alerts when thresholds are exceeded.

**Setup**: `ReplicationMonitor` with mocked database connections that return configurable lag values.

**Steps**:

1. Configure thresholds: warn at 5000ms, critical at 30000ms.
2. Set mock MongoDB oplog lag to 1000ms — verify health check returns `healthy` and no alerts fired.
3. Set mock MongoDB oplog lag to 8000ms — verify health check returns `warning` and a warning alert is emitted.
4. Set mock MongoDB oplog lag to 35000ms — verify health check returns `critical` and a critical alert is emitted.
5. Set mock Redis replication lag to 200ms — verify `healthy` for Redis.
6. Set mock ClickHouse replication lag to 10000ms — verify `warning` for ClickHouse.
7. Verify aggregate health score computation combines all store statuses (worst-case wins).
8. Verify metric emission: `region_replication_lag_ms{store="mongo"}`, `{store="redis"}`, `{store="clickhouse"}`.
9. Reset all lags to healthy — verify health recovers and `healthy` status is restored.

**Validates**: FR-6 (MongoDB replication lag), FR-7 (Redis replication lag), FR-8 (ClickHouse replication lag), FR-14 (metrics exposure)

---

### INT-5: Failover Controller — Health Threshold Evaluation and DNS Update

**Objective**: Test that the failover controller correctly evaluates health thresholds, triggers failover after sustained unhealthy periods, and coordinates DNS record updates.

**Setup**: `FailoverController` with mocked `RegionRegistry`, `RegionHealthService`, and `DnsUpdateService`.

**Steps**:

1. Configure failover threshold: 6 consecutive unhealthy checks at 10s intervals (60s sustained failure).
2. Report 1 unhealthy check for `us-east-1` — verify no failover triggered (count: 1/6).
3. Report 5 more unhealthy checks — verify failover IS triggered after the 6th consecutive check.
4. Verify the failover controller calls `DnsUpdateService.updateRecord()` to point `us-east-1` traffic to `us-west-2`.
5. Verify the failover controller updates `us-east-1` status to `inactive` and logs a `failover_initiated` audit event.
6. Report 2 unhealthy checks followed by 1 healthy check — verify counter resets and no failover triggered.
7. Simulate DNS update failure — verify the failover controller retries (up to 3 times) and logs the failure.
8. Test manual failover trigger: call `failoverController.triggerManualFailover("us-east-1")` — verify immediate failover without waiting for threshold.

**Validates**: FR-9 (automated failover), FR-4 (DNS health-based routing), FR-12 (audit log)

---

### INT-6: Cross-Region Audit Log — Event Emission and Query

**Objective**: Test that cross-region operations correctly emit audit events and that the compliance query API returns filtered results.

**Setup**: `CrossRegionAuditService` with MongoMemoryServer for `cross_region_audit_log` collection.

**Steps**:

1. Emit a `cross_region_read` event for `tenant-001` from `us-east-1` to `eu-west-1`.
2. Emit a `failover_initiated` event for `tenant-001`.
3. Emit a `migration_started` event for `tenant-002` from `eu-west-1` to `ap-southeast-1`.
4. Query audit log for `tenant-001` — verify 2 events returned, ordered by timestamp descending.
5. Query audit log for `tenant-002` — verify 1 event returned.
6. Query by `eventType: "failover_initiated"` — verify 1 event returned.
7. Query by date range — verify correct filtering.
8. Verify events include all required fields: `tenantId`, `eventType`, `sourceRegion`, `targetRegion`, `timestamp`, `initiatedBy`.
9. Attempt to query audit log for a different tenant — verify no cross-tenant data leakage (returns empty, not 403).

**Validates**: FR-12 (compliance audit log), tenant isolation in audit data

---

### INT-7: Region-Specific Rate Limiting

**Objective**: Test that rate limits are enforced per-region and that per-tenant regional quotas work independently.

**Setup**: Rate limiter middleware with region-aware configuration, mocked Redis.

**Steps**:

1. Configure rate limits: `us-east-1` allows 1000 req/min per tenant, `eu-west-1` allows 500 req/min per tenant.
2. Send 1000 requests as `tenant-001` to `us-east-1` — verify all succeed.
3. Send request 1001 — verify 429 Too Many Requests.
4. Send 500 requests as `tenant-001` to `eu-west-1` — verify all succeed.
5. Send request 501 to `eu-west-1` — verify 429.
6. Verify that `tenant-001`'s limit in `us-east-1` is independent of their limit in `eu-west-1` (exhausting one does not affect the other).
7. Verify rate limit headers include region context (`X-RateLimit-Region`).

**Validates**: FR-13 (region-specific rate limits), per-region isolation

---

## 5. Test Infrastructure Requirements

### Multi-Region Simulation Layer

Since true multi-region E2E testing requires multiple clusters, the test infrastructure should support:

1. **Docker Compose Multi-Region**: A `docker-compose.multi-region.yml` file that spins up two isolated "regions" with separate MongoDB, Redis, and ClickHouse instances, each running a full ABL platform stack configured with different `REGION_ID` values.
2. **Region Simulation Middleware**: A test utility that simulates cross-region latency by injecting configurable delays on inter-service calls marked as cross-region.
3. **Network Partition Simulation**: Toxiproxy or similar tool to simulate network failures between regions for failover testing.
4. **Shared DNS Mock**: A mock DNS service that both "regions" query, allowing tests to verify DNS record updates during failover.

### Test Data Seeding

- Pre-configured region registry with 2-3 regions.
- Test tenants pre-assigned to specific regions.
- Seed data (projects, agents, sessions) for migration testing.
- Health check mock data for threshold testing.

### Chaos Engineering Harness

- Ability to kill/restart runtime processes per region.
- Ability to introduce network latency between regions (Toxiproxy).
- Ability to partition MongoDB replica set members by region.
- Ability to saturate Redis to test degraded mode behavior.

---

## 6. Testing Priority

Testing should follow the phased delivery plan:

| Priority | Phase   | Scenarios                                      | Prerequisite                     |
| -------- | ------- | ---------------------------------------------- | -------------------------------- |
| P0       | Phase 1 | INT-1, INT-2, region CRUD E2E                  | Region registry implementation   |
| P0       | Phase 1 | E2E-3 (data sovereignty)                       | Region routing middleware        |
| P1       | Phase 2 | E2E-4 (read replicas), INT-4                   | MongoDB cross-region replica set |
| P1       | Phase 2 | INT-6, E2E-7 (audit)                           | Audit log implementation         |
| P2       | Phase 3 | E2E-2 (failover), INT-5                        | Failover controller              |
| P2       | Phase 3 | E2E-5 (migration), INT-3                       | Migration state machine          |
| P2       | Phase 3 | E2E-6 (health monitoring)                      | Health monitor worker            |
| P3       | Phase 4 | Active-active convergence, INT-7 (rate limits) | Redis CRDT, zone sharding        |

---

## 7. Manual Testing Checklist

The following scenarios require manual verification in a real multi-region deployment:

- [ ] Geo-DNS resolution: Verify from EU client that DNS resolves to EU region endpoint
- [ ] Geo-DNS resolution: Verify from US client that DNS resolves to US region endpoint
- [ ] Geo-DNS failover: Verify DNS resolves to failover region when primary is unhealthy
- [ ] Cross-region latency: Measure actual RTT between regions and compare with Prometheus metrics
- [ ] Admin portal: Region management page displays correct health, capacity, and tenant counts
- [ ] Admin portal: Topology map accurately reflects region interconnections
- [ ] Admin portal: Failover dashboard shows real-time failover events
- [ ] Studio: Tenant settings displays correct region with health indicator
- [ ] MongoDB replica set: Verify oplog replication across regions via `rs.status()`
- [ ] Redis replication: Verify session data appears in remote region's Redis within tolerance
- [ ] ClickHouse: Verify distributed table query returns data from all regional shards
- [ ] Compliance report: Generate data residency report and verify completeness for audit
- [ ] Tenant migration: End-to-end migration of a real tenant with production-like data volume
- [ ] Cost verification: Review cloud provider billing for cross-region data transfer costs
