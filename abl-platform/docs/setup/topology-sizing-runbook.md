# ABL Platform -- Topology Sizing Operational Runbook

**Last Updated:** 2026-03-04
**Applies to:** ABL Platform production K8s deployments (S/M/L/XL tiers)
**Prerequisites:** Access to the cluster via `kubectl`, `kore-platform-cli` installed, Grafana dashboards provisioned

---

## Table of Contents

1. [Running Benchmarks](#1-running-benchmarks)
2. [Using the Sizing Calculator CLI](#2-using-the-sizing-calculator-cli)
3. [Interpreting Results](#3-interpreting-results)
4. [Scaling Triggers and Alert Thresholds](#4-scaling-triggers-and-alert-thresholds)
5. [Backup Verification Procedures](#5-backup-verification-procedures)
6. [Failover Testing Procedures](#6-failover-testing-procedures)

---

## 1. Running Benchmarks

The benchmark suite uses k6 1.0 with native TypeScript and Prometheus remote write. There are three levels of benchmarks, each building on the previous.

### 1.1 Local Development Benchmarks

Use local benchmarks for quick validation against a docker-compose-based environment.

**Prerequisites:**

- Docker Compose environment running (`docker compose up -d`)
- k6 1.0+ installed locally (`brew install grafana/tap/k6` or equivalent)

**Run a single per-service benchmark:**

```bash
# Set the target service URL
export K6_TARGET_URL=http://localhost:3112

# Run the runtime micro-benchmark
k6 run benchmarks/per-service/runtime.ts \
  --env SERVICE=runtime \
  --env TARGET_URL=$K6_TARGET_URL \
  --duration 5m \
  --vus 10
```

**Run all per-service benchmarks sequentially:**

```bash
for script in benchmarks/per-service/*.ts; do
  service=$(basename "$script" .ts)
  echo "--- Running benchmark: $service ---"
  k6 run "$script" \
    --env SERVICE="$service" \
    --duration 5m \
    --vus 10 \
    --out json=results/${service}.json
done
```

**Run integration benchmarks locally:**

```bash
k6 run benchmarks/integration/agent-conversation-e2e.ts \
  --env RUNTIME_URL=http://localhost:3112 \
  --env STUDIO_URL=http://localhost:5173 \
  --duration 10m \
  --vus 5
```

### 1.2 Cloud / Kubernetes Benchmarks

For production-representative results, run benchmarks on Kubernetes using the k6 Operator.

**Prerequisites:**

- k6 Operator installed in the cluster (`helm install k6-operator grafana/k6-operator`)
- Prometheus configured to accept remote write
- Grafana dashboards provisioned from `deploy/grafana/dashboards/`

**Configure Prometheus remote write:**

```bash
export K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write
export K6_PROMETHEUS_RW_PUSH_INTERVAL=5s
export K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS=true
export K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),max
```

**Create a k6 TestRun for per-service benchmarks:**

```yaml
# benchmarks/k8s/per-service-testrun.yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: runtime-benchmark
  namespace: abl-benchmarks
spec:
  parallelism: 4
  script:
    configMap:
      name: runtime-benchmark-script
      file: runtime.ts
  arguments: >-
    --env SERVICE=runtime
    --env TARGET_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --duration 30m
    --vus 50
  runner:
    env:
      - name: K6_PROMETHEUS_RW_SERVER_URL
        value: http://prometheus-server.monitoring.svc.cluster.local:9090/api/v1/write
      - name: K6_PROMETHEUS_RW_PUSH_INTERVAL
        value: '5s'
      - name: K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS
        value: 'true'
      - name: K6_PROMETHEUS_RW_TREND_STATS
        value: 'p(50),p(95),p(99),max'
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: '1'
        memory: 1Gi
```

**Apply and monitor:**

```bash
# Create the ConfigMap from benchmark scripts
kubectl create configmap runtime-benchmark-script \
  --from-file=runtime.ts=benchmarks/per-service/runtime.ts \
  -n abl-benchmarks

# Apply the TestRun
kubectl apply -f benchmarks/k8s/per-service-testrun.yaml

# Watch progress
kubectl get testrun -n abl-benchmarks -w

# View runner pod logs
kubectl logs -n abl-benchmarks -l k6_cr=runtime-benchmark -f
```

**Run system-wide stress tests:**

```yaml
# benchmarks/k8s/stress-testrun.yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: steady-state-soak
  namespace: abl-benchmarks
spec:
  parallelism: 8
  script:
    configMap:
      name: soak-test-script
      file: steady-state-soak.ts
  arguments: >-
    --env TEST_TYPE=steady-state-soak
    --duration 4h
    --vus 100
  runner:
    env:
      - name: K6_PROMETHEUS_RW_SERVER_URL
        value: http://prometheus-server.monitoring.svc.cluster.local:9090/api/v1/write
    resources:
      requests:
        cpu: '1'
        memory: 1Gi
```

### 1.3 Benchmark Execution Checklist

Before running production benchmarks:

- [ ] Verify the target cluster is dedicated to benchmarks (no customer traffic)
- [ ] Confirm Prometheus has sufficient retention for the test duration
- [ ] Ensure Grafana dashboards are provisioned (`k6-per-service`, `k6-integration`, `k6-system-wide`)
- [ ] Set resource requests on k6 runner pods to prevent them from being evicted
- [ ] Capture the cluster state before testing (`kubectl get nodes -o wide`, `kubectl top nodes`)
- [ ] Disable HPA on target services if testing per-replica throughput limits
- [ ] Enable HPA on target services if testing autoscaling behavior

---

## 2. Using the Sizing Calculator CLI

The sizing calculator is part of `@agent-platform/cli` and follows a three-step workflow: questionnaire, calculate, and helm. Run it via the `pnpm cli` shortcut from the repo root.

### 2.1 Generate a Questionnaire Template

```bash
pnpm cli sizing questionnaire --output questionnaire.json
```

This creates a JSON file with all 8 sections (Deployment, LLM, Agents, Knowledge Base, Workflows, Channels, Observability, Retention) pre-filled with starter-tier defaults.

### 2.2 Fill Out the Questionnaire

Edit `questionnaire.json` with customer-specific parameters. Key fields that have the largest impact on sizing:

| Field                              | Impact                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| `agents.concurrentConversations`   | Runtime replicas, Redis memory, MongoDB IOPS             |
| `agents.messagesPerDay`            | MongoDB growth, ClickHouse trace volume                  |
| `knowledgeBase.totalDocuments`     | OpenSearch/Qdrant storage, BGE-M3 compute                |
| `knowledgeBase.ingestionFrequency` | Search AI queue depth, Docling throughput                |
| `llm.hostingModel`                 | GPU node pool (self-hosted) or network egress (external) |
| `llm.concurrentRequests`           | Runtime replicas, queue depth                            |
| `retention.conversationRetention`  | MongoDB storage growth rate                              |
| `observability.traceRetention`     | ClickHouse storage growth rate                           |

### 2.3 Calculate Topology

```bash
pnpm cli sizing calculate \
  --input questionnaire.json \
  --output topology.json
```

The output includes:

- `tier`: S, M, L, or XL
- `services[]`: Per-service CPU, memory, replica count, and HPA config
- `dataStores[]`: Per-store node count, storage size, replication config
- `nodePools[]`: Node types, counts, and labels
- `totalNodes`: Min/max node range
- `monthlyStorageGrowthGB`: Estimated monthly disk growth

### 2.4 Generate Helm Values

```bash
pnpm cli sizing helm \
  --input topology.json \
  --output-dir helm-values/
```

This generates per-component Helm values files in the output directory:

- `runtime-values.yaml`
- `mongodb-values.yaml`
- `redis-values.yaml`
- `clickhouse-values.yaml`
- `opensearch-values.yaml`
- `qdrant-values.yaml`
- `neo4j-values.yaml`
- `restate-values.yaml`
- And other application service values files

### 2.5 Apply Helm Values

```bash
# Example: update runtime deployment
helm upgrade runtime deploy/helm/charts/runtime \
  -f helm-values/runtime-values.yaml \
  -n abl-platform

# Example: update MongoDB via Percona Operator
helm upgrade mongodb percona/psmdb-db \
  -f helm-values/mongodb-values.yaml \
  -n abl-platform
```

---

## 3. Interpreting Results

### 3.1 Per-Service Benchmark Results

Open the **k6 Per-Service Benchmarks** Grafana dashboard (`abl-k6-per-service`).

**Key metrics to evaluate per service:**

| Metric      | Healthy                       | Warning   | Action Required                                |
| ----------- | ----------------------------- | --------- | ---------------------------------------------- |
| p95 latency | < 200ms (app), < 50ms (data)  | 200-500ms | Investigate slow queries, add replicas         |
| p99 latency | < 500ms (app), < 100ms (data) | 500ms-2s  | Check for tail latency (GC, locks)             |
| Error rate  | < 0.1%                        | 0.1-1%    | Check logs, connection limits                  |
| Error rate  | > 1%                          | --        | Service under duress, reduce VUs to find limit |

**Finding the per-replica throughput ceiling:**

1. Select the service in the dashboard
2. Observe where the request rate plateaus despite VU increase
3. Note the p95 latency at that point -- this is the service's max throughput at acceptable latency
4. Record: `throughput_per_replica = plateau_rps / replica_count`

### 3.2 Integration Benchmark Results

Open the **k6 Integration Benchmarks** dashboard (`abl-k6-integration`).

**How to read the service breakdown panels:**

- Each bar represents time spent in a specific service within the pipeline
- The longest bar is the bottleneck for that journey
- Optimization priority: focus on the service consuming the most time

**Agent Conversation E2E expectations:**

| Phase         | Typical Range | Notes                                    |
| ------------- | ------------- | ---------------------------------------- |
| Studio API    | 5-20ms        | Routing only                             |
| Runtime       | 50-200ms      | Agent execution overhead (excluding LLM) |
| LLM Inference | 200ms - 5s    | Dominates total latency; varies by model |
| MongoDB       | 5-20ms        | Persistence                              |
| ClickHouse    | 1-5ms         | Async trace writes                       |

**KB Ingestion E2E expectations:**

| Phase     | Typical Range | Notes                               |
| --------- | ------------- | ----------------------------------- |
| Search AI | 10-50ms       | Orchestration                       |
| Docling   | 500ms - 60s   | Varies with document size and type  |
| BGE-M3    | 50-500ms      | Depends on chunk count per document |
| Indexing  | 50-200ms      | OpenSearch + Qdrant bulk operations |
| Neo4j     | 10-50ms       | Graph entity creation               |

### 3.3 System-Wide Stress Test Results

Open the **k6 System-Wide Stress Tests** dashboard (`abl-k6-system-wide`).

**Steady-state soak (4+ hours):**

- Watch for gradual p95 latency increase -- indicates memory leak or connection exhaustion
- Watch for gradual error rate increase -- indicates resource leak
- Memory panel: should be flat (no upward drift)

**Ramp-to-saturation:**

- The throughput plateau point is the system's max capacity
- Note the VU count at first error spike -- this is the saturation point
- Formula: `max_concurrent_users = saturation_VUs / safety_factor (typically 0.7)`

**Multi-tenant isolation:**

- Compare per-tenant p95 latencies
- A healthy result shows <20% variance between tenants at equal load
- > 50% variance indicates noisy-neighbor problems requiring resource isolation

**Burst traffic (10x spike):**

- Recovery time = duration from spike end to error rate <0.1% AND p95 < 2x baseline
- Target: <60s for Tier S/M, <30s for Tier L/XL

### 3.4 Capacity Planning

Open the **Capacity Planning** dashboard (`abl-capacity-planning`).

**Critical alerts to watch:**

| Metric                                  | Warning           | Critical     |
| --------------------------------------- | ----------------- | ------------ |
| PVC usage                               | 70%               | 85%          |
| Days to 85% full                        | <30 days          | <14 days     |
| Redis memory usage                      | 80% of maxmemory  | 90%          |
| MongoDB connections                     | 70% of pool limit | 90%          |
| HPA desired > current (sustained >5min) | Yes               | Yes (>15min) |

---

## 4. Scaling Triggers and Alert Thresholds

### 4.1 Horizontal Pod Autoscaler (HPA) Triggers

| Service           | Scale-Up Trigger     | Scale-Down Trigger    | Min Replicas | Max Replicas (L tier) |
| ----------------- | -------------------- | --------------------- | ------------ | --------------------- |
| Runtime           | CPU > 70% avg (3min) | CPU < 30% avg (10min) | 3            | 20                    |
| Search AI         | CPU > 70% avg (3min) | CPU < 30% avg (10min) | 2            | 10                    |
| Search AI Runtime | CPU > 70% avg (3min) | CPU < 30% avg (10min) | 2            | 10                    |
| BGE-M3            | CPU > 60% avg (3min) | CPU < 25% avg (10min) | 3            | 20                    |
| Docling           | CPU > 70% avg (3min) | CPU < 25% avg (10min) | 2            | 10                    |
| Studio            | CPU > 70% avg (5min) | CPU < 30% avg (10min) | 2            | 8                     |
| Workflow Engine   | CPU > 70% avg (3min) | CPU < 30% avg (10min) | 2            | 8                     |

### 4.2 KEDA Event-Driven Scaling

| Service                       | Trigger Source                        | Scale-Up Threshold | Cooldown |
| ----------------------------- | ------------------------------------- | ------------------ | -------- |
| Runtime (channel workers)     | BullMQ `channel-inbound` queue depth  | > 50 waiting jobs  | 60s      |
| Runtime (webhook delivery)    | BullMQ `webhook-delivery` queue depth | > 100 waiting jobs | 60s      |
| Search AI (ingestion workers) | BullMQ `document-ingest` queue depth  | > 20 waiting jobs  | 120s     |
| BGE-M3                        | BullMQ `embedding-batch` queue depth  | > 10 waiting jobs  | 60s      |

### 4.3 Alerting Thresholds

Configure these alerts in Prometheus Alertmanager or your monitoring system:

**Severity: Critical (page)**

```yaml
- alert: PVCNearFull
  expr: kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: 'PVC {{ $labels.persistentvolumeclaim }} is above 85% capacity'

- alert: ServiceErrorRateHigh
  expr: >
    sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
    / sum by (service) (rate(http_requests_total[5m])) > 0.05
  for: 5m
  labels:
    severity: critical

- alert: RedisMemoryNearMax
  expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.9
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: 'Redis {{ $labels.pod }} at 90% memory -- BullMQ will reject writes at 100%'

- alert: MongoDBReplicationLag
  expr: mongodb_rs_members_replicationLag > 30
  for: 5m
  labels:
    severity: critical

- alert: ClickHousePartCount
  expr: clickhouse_table_parts > 300
  for: 15m
  labels:
    severity: critical
  annotations:
    summary: 'ClickHouse will reject inserts if parts exceed 300'
```

**Severity: Warning (ticket)**

```yaml
- alert: PVCGrowingFast
  expr: >
    predict_linear(kubelet_volume_stats_used_bytes[7d], 30 * 24 * 3600)
    / kubelet_volume_stats_capacity_bytes > 0.85
  for: 1h
  labels:
    severity: warning
  annotations:
    summary: 'PVC {{ $labels.persistentvolumeclaim }} projected to reach 85% within 30 days'

- alert: HPAAtMaxReplicas
  expr: >
    kube_horizontalpodautoscaler_status_current_replicas
    == kube_horizontalpodautoscaler_spec_max_replicas
  for: 15m
  labels:
    severity: warning

- alert: QueueBacklogGrowing
  expr: delta(bullmq_queue_waiting[30m]) > 100
  for: 10m
  labels:
    severity: warning

- alert: ServiceP99LatencyHigh
  expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 2
  for: 10m
  labels:
    severity: warning
```

### 4.4 Node Pool Scaling (Karpenter)

Karpenter handles node provisioning automatically. Review these NodePool configurations for each tier:

| Node Pool | Instance Types (AWS)     | Min | Max (L tier) | Consolidation Policy |
| --------- | ------------------------ | --- | ------------ | -------------------- |
| general   | m5.xlarge, m5.2xlarge    | 3   | 15           | WhenUnderutilized    |
| compute   | c5.2xlarge, c5.4xlarge   | 1   | 5            | WhenUnderutilized    |
| data      | r5.2xlarge, r5.4xlarge   | 3   | 12           | WhenEmpty (stateful) |
| gpu       | g5.2xlarge, p4d.24xlarge | 0   | 8            | WhenEmpty            |

---

## 5. Backup Verification Procedures

### 5.1 MongoDB Backup Verification

**Backup method:** Percona Backup for MongoDB (PBM) -- physical backup + continuous oplog archival

**Verify backup status:**

```bash
# Check PBM status
kubectl exec -it mongodb-rs0-0 -n abl-platform -c mongod -- \
  pbm status

# List recent backups
kubectl exec -it mongodb-rs0-0 -n abl-platform -c mongod -- \
  pbm list --type=physical

# Verify the latest backup is complete (not "in progress" or "error")
kubectl exec -it mongodb-rs0-0 -n abl-platform -c mongod -- \
  pbm describe-backup <backup-name>
```

**Test restore (non-production):**

```bash
# 1. Create a temporary MongoDB instance
kubectl run mongo-restore-test --image=percona/percona-server-mongodb:8.0 \
  -n abl-benchmarks --restart=Never -- sleep 3600

# 2. Copy backup from S3 and restore
kubectl exec -it mongo-restore-test -n abl-benchmarks -- \
  pbm restore <backup-name> --base-snapshot

# 3. Verify data integrity
kubectl exec -it mongo-restore-test -n abl-benchmarks -- \
  mongosh --eval "db.adminCommand({dbStats: 1})"

# 4. Clean up
kubectl delete pod mongo-restore-test -n abl-benchmarks
```

**Verification schedule:** Weekly automated restore test via CronJob, monthly manual verification.

### 5.2 ClickHouse Backup Verification

**Backup method:** Altinity clickhouse-backup to S3

```bash
# List backups
kubectl exec -it clickhouse-0 -n abl-platform -- \
  clickhouse-backup list

# Create an on-demand backup
kubectl exec -it clickhouse-0 -n abl-platform -- \
  clickhouse-backup create --tables=trace_events

# Upload to S3
kubectl exec -it clickhouse-0 -n abl-platform -- \
  clickhouse-backup upload <backup-name>

# Verify backup integrity
kubectl exec -it clickhouse-0 -n abl-platform -- \
  clickhouse-backup check <backup-name>
```

### 5.3 OpenSearch Backup Verification

**Backup method:** Snapshot to S3 repository

```bash
# Check snapshot repository status
curl -s http://opensearch:9200/_snapshot/s3-backup/_status | jq .

# List recent snapshots
curl -s http://opensearch:9200/_snapshot/s3-backup/_all | jq '.snapshots[-5:]'

# Verify snapshot completeness (state should be "SUCCESS")
curl -s http://opensearch:9200/_snapshot/s3-backup/latest | jq '.snapshots[0].state'
```

**Test restore:**

```bash
# Restore a specific index to a test index name
curl -X POST http://opensearch:9200/_snapshot/s3-backup/latest/_restore \
  -H 'Content-Type: application/json' \
  -d '{
    "indices": "search-chunks-test-tenant-*",
    "rename_pattern": "(.+)",
    "rename_replacement": "restored_$1"
  }'

# Verify document count matches
curl -s http://opensearch:9200/restored_search-chunks-test-tenant-*/_count | jq .count
```

### 5.4 Redis Backup Verification

**Backup method:** RDB snapshots + AOF

```bash
# Check last save time
kubectl exec -it redis-0 -n abl-platform -- redis-cli info persistence | grep rdb_last_save

# Trigger manual RDB save
kubectl exec -it redis-0 -n abl-platform -- redis-cli bgsave

# Verify AOF is active
kubectl exec -it redis-0 -n abl-platform -- redis-cli info persistence | grep aof_enabled
```

### 5.5 Neo4j Backup Verification

```bash
# Run backup via neo4j-admin
kubectl exec -it neo4j-0 -n abl-platform -- \
  neo4j-admin database dump --to-path=/backups neo4j

# Verify backup file
kubectl exec -it neo4j-0 -n abl-platform -- ls -la /backups/neo4j.dump
```

### 5.6 Qdrant Backup Verification

```bash
# Create a snapshot of a collection
curl -X POST http://qdrant:6333/collections/vectors/snapshots

# List snapshots
curl -s http://qdrant:6333/collections/vectors/snapshots | jq .

# Download and verify snapshot
curl -o vectors-snapshot.tar http://qdrant:6333/collections/vectors/snapshots/<snapshot-name>
```

### 5.7 Restate Backup Verification

```bash
# Restate uses RocksDB with Raft consensus -- state is derived from the journal log
# Verify journal health
curl -s http://restate:9070/health | jq .

# Check snapshot age
kubectl exec -it restate-0 -n abl-platform -- ls -la /data/snapshots/

# Verify Raft consensus
kubectl exec -it restate-0 -n abl-platform -- curl -s localhost:5122/cluster/status | jq .
```

### 5.8 Backup Verification Checklist (Monthly)

- [ ] MongoDB: PBM backup listed, status "done", restore test successful
- [ ] ClickHouse: clickhouse-backup list shows recent entries, check passes
- [ ] OpenSearch: Latest snapshot state is "SUCCESS", test restore matches doc count
- [ ] Redis: RDB last save within 24h, AOF enabled
- [ ] Neo4j: dump file created successfully, size is non-zero
- [ ] Qdrant: snapshot created, downloadable, non-empty
- [ ] Restate: snapshots directory populated, journal healthy
- [ ] S3 lifecycle rules verified (no premature deletion of backups)

---

## 6. Failover Testing Procedures

### 6.1 Pre-Failover Checklist

Before any failover test:

- [ ] Confirm the test is scheduled in the maintenance window
- [ ] Verify all backups are current (Section 5)
- [ ] Record baseline metrics: current replica counts, latency, error rates
- [ ] Ensure monitoring dashboards are open and visible
- [ ] Have rollback commands ready
- [ ] Notify stakeholders

### 6.2 MongoDB Failover

**Test: Force primary stepdown**

```bash
# Record current primary
kubectl exec -it mongodb-rs0-0 -n abl-platform -c mongod -- \
  mongosh --eval "rs.isMaster().primary"

# Force stepdown (triggers election)
kubectl exec -it mongodb-rs0-0 -n abl-platform -c mongod -- \
  mongosh --eval "rs.stepDown(60)"

# Monitor election
kubectl exec -it mongodb-rs0-1 -n abl-platform -c mongod -- \
  mongosh --eval "rs.status().members.map(m => ({name: m.name, state: m.stateStr}))"
```

**Expected behavior:**

- Election completes within 10 seconds
- Application connections failover automatically (MongoDB driver handles this)
- Brief error spike (1-5s), then full recovery
- No data loss (w:majority ensures writes are replicated before ack)

**Verify recovery:**

- New primary is elected
- Application error rate returns to baseline within 30 seconds
- Replication lag is zero on all secondaries

### 6.3 Redis Failover

**Test: Kill the primary pod**

```bash
# Identify current primary (Sentinel mode)
kubectl exec -it redis-sentinel-0 -n abl-platform -- \
  redis-cli -p 26379 sentinel get-master-addr-by-name mymaster

# Delete the primary pod
kubectl delete pod redis-0 -n abl-platform

# Watch Sentinel promote a replica
kubectl exec -it redis-sentinel-0 -n abl-platform -- \
  redis-cli -p 26379 sentinel get-master-addr-by-name mymaster
```

**Expected behavior:**

- Sentinel detects failure within 5 seconds (down-after-milliseconds)
- Promotion completes within 10 seconds
- BullMQ workers reconnect automatically (IORedis retry)
- No job loss (jobs are persistent in Redis)

### 6.4 ClickHouse Failover

**Test: Kill one replica in a ReplicatedMergeTree pair**

```bash
# Delete one replica pod
kubectl delete pod clickhouse-0 -n abl-platform

# Monitor via ClickHouse system tables on surviving replica
kubectl exec -it clickhouse-1 -n abl-platform -- \
  clickhouse-client --query "SELECT * FROM system.replicas FORMAT Pretty"
```

**Expected behavior:**

- Surviving replica handles all reads and writes
- Pod restarts and catches up from ZooKeeper/Keeper log
- No data loss due to quorum writes

### 6.5 OpenSearch Failover

**Test: Drain a data node**

```bash
# Exclude a node from allocation
curl -X PUT http://opensearch:9200/_cluster/settings \
  -H 'Content-Type: application/json' \
  -d '{"transient": {"cluster.routing.allocation.exclude._name": "opensearch-data-0"}}'

# Monitor shard reallocation
curl -s http://opensearch:9200/_cluster/health | jq '.relocating_shards, .status'

# After shards relocate, delete the pod
kubectl delete pod opensearch-data-0 -n abl-platform

# Remove exclusion after pod restarts
curl -X PUT http://opensearch:9200/_cluster/settings \
  -H 'Content-Type: application/json' \
  -d '{"transient": {"cluster.routing.allocation.exclude._name": null}}'
```

**Expected behavior:**

- Cluster status goes yellow briefly, then green
- Searches continue on remaining nodes
- No data loss (replica shards serve reads)

### 6.6 Restate Failover

**Test: Kill the Raft leader**

```bash
# Identify the current leader
kubectl exec -it restate-0 -n abl-platform -- \
  curl -s localhost:5122/cluster/status | jq '.leader'

# Delete the leader pod
kubectl delete pod restate-0 -n abl-platform

# Monitor Raft election
for i in 1 2; do
  kubectl exec -it restate-$i -n abl-platform -- \
    curl -s localhost:5122/cluster/status | jq '{node: .node_id, leader: .leader}'
done
```

**Expected behavior:**

- New leader elected within 10 seconds
- In-flight workflow invocations retry automatically
- No duplicate side effects (Restate's exactly-once guarantee)
- Journal replay from last snapshot completes in <1 minute

### 6.7 Application Service Failover

**Test: Kill a Runtime pod during active conversations**

```bash
# Record active WebSocket connections
kubectl exec -it runtime-0 -n abl-platform -- \
  curl -s localhost:3112/health | jq '.connections'

# Delete the pod
kubectl delete pod runtime-0 -n abl-platform

# Monitor HPA scaling
kubectl get hpa runtime -n abl-platform -w
```

**Expected behavior:**

- WebSocket clients reconnect to remaining pods (load balancer redistribution)
- Session state is preserved in Redis (stateless runtime principle)
- HPA may scale up if remaining pods exceed CPU threshold
- New pod is ready within 30-60 seconds

### 6.8 Full Availability Zone Failure Simulation

**Test: Cordon all nodes in one AZ**

```bash
# List nodes by AZ
kubectl get nodes -L topology.kubernetes.io/zone

# Cordon all nodes in AZ-a
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a -o name | \
  xargs -I{} kubectl cordon {}

# Drain pods (with PDB protection)
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a -o name | \
  xargs -I{} kubectl drain {} --ignore-daemonsets --delete-emptydir-data --timeout=300s

# Monitor service availability
# (Use the k6-system-wide Grafana dashboard or a simple availability probe)

# Restore after testing
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a -o name | \
  xargs -I{} kubectl uncordon {}
```

**Expected behavior:**

- PodDisruptionBudgets prevent all replicas from being evicted simultaneously
- Karpenter provisions replacement nodes in remaining AZs
- Data stores with cross-AZ replication continue serving
- Services with 3+ replicas remain available throughout
- Full recovery within 5-10 minutes after uncordoning

### 6.9 Failover Test Results Template

Record results for each failover test:

```
Test:               [e.g., MongoDB primary stepdown]
Date:               [YYYY-MM-DD]
Tier:               [S/M/L/XL]
Detection Time:     [seconds from failure to first alert]
Failover Time:      [seconds from failure to new primary/leader]
Recovery Time:      [seconds from failure to error rate < baseline + 0.1%]
Data Loss:          [none / bytes / records]
Error Spike:        [peak error rate during failover]
Client Impact:      [description of user-visible impact]
Notes:              [any anomalies or follow-up items]
```
