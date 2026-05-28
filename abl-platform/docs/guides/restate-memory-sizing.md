# Restate Memory Sizing Runbook

**Date:** 2026-04-13
**Based on:** `abl-platform-dev-restate-0` OOM loop incident (19 restarts in 79 minutes, cgroup 2 GiB)
**Status:** Authoritative — operator sizing decisions against Restate 1.3
**Audience:** Platform operators, on-call engineers, DevOps
**Prerequisite:** `kubectl` access to the target cluster; read access to `packages/sizing-calculator/src/engine/constants.ts` (the source of truth for tier numbers)

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [What uses memory inside Restate](#2-what-uses-memory-inside-restate)
3. [Partitions — what they are, what they cost, and how to pick N](#3-partitions--what-they-are-what-they-cost-and-how-to-pick-n)
4. [The formula](#4-the-formula)
5. [Choosing `rocksdb-total-memory-size`](#5-choosing-rocksdb-total-memory-size)
6. [Tier calibration table](#6-tier-calibration-table)
7. [Empirical verification](#7-empirical-verification)
8. [Worked example — dev cluster, 2026-04-13](#8-worked-example--dev-cluster-2026-04-13)
9. [When to open a ticket vs. resize — decision tree](#9-when-to-open-a-ticket-vs-resize--decision-tree)
10. [Appendix A: Partition count is bootstrap-immutable](#appendix-a-partition-count-is-bootstrap-immutable)

> **Change control:** The tier numbers in §6 come from `packages/sizing-calculator/src/engine/constants.ts`. Update the code, not this doc, when tiers evolve.

---

## 1. Purpose

Open this doc when:

- A Restate pod is `OOMKilled` or in `CrashLoopBackOff` with exit code `137`.
- Restate logs emit `[Stall Detector] ... rocksdb-write-stall-threshold` warnings.
- You are bootstrapping a new Restate cluster and need to pick `resources.limits.memory` and `[worker] partitions`.
- You are graduating an environment between tiers (S → M → L → XL).

The doc answers three questions: _what does Restate spend memory on_, _how much does it need for a given workload_, and _how do I verify the number I picked is right_.

---

## 2. What uses memory inside Restate

Restate is a Rust process with an embedded RocksDB. Its memory footprint is the sum of five buckets. Knowing which bucket dominates is the first step in sizing.

| Bucket                                   | Driven by                                                                        | Representative size (Restate 1.3 defaults)                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **A. Process base**                      | binary, stack, tokio runtime, metadata-store, admin server                       | **~400 MiB**                                                                               |
| **B. RocksDB block cache**               | read cache shared across column families                                         | **~50 %** of `rocksdb-total-memory-size`                                                   |
| **C. RocksDB memtables / write buffers** | one set per partition column family                                              | `partitions × write_buffer_size × max_write_buffer_number` (defaults: 64 MiB × 2-3 per CF) |
| **D. Ingress + invocation buffers**      | Kafka consumer queues, HTTP ingress, `internal-queue-length`, in-flight journals | **~200 MiB per Kafka subscription under backlog**                                          |
| **E. cgroup headroom**                   | kernel page cache of SST files charged to cgroup RSS                             | **~10-15 % of limit**                                                                      |

The 2026-04-13 dev incident was bucket **C** pathology: 24 partitions × ~192 MiB per CF worst-case ≈ 4.6 GiB of memtables alone, against a 2 GiB cgroup limit. RocksDB tried to flush, hit a write stall, and the cgroup killed the process before buffers drained.

---

## 3. Partitions — what they are, what they cost, and how to pick N

### 3.1 Mental model

Restate shards its keyspace into `N` **partitions**. Every invocation carries a key (virtual-object key, workflow ID, or a synthetic key for unkeyed services); Restate computes `partition_id = hash(key) mod N` and routes to the owning partition processor.

Each partition owns real resources, not just a logical label:

- A **partition processor** (the `pp-N` tasks visible in logs) that replays the journal and drives the state machine.
- A **dedicated RocksDB column family** for user state.
- A **memtable + write-buffer stack** for that column family.
- A **slice of the journal log**.
- A **bounded invocation queue** (`[worker] internal-queue-length`).

This is why `N` is a first-class sizing input: every increment adds a fixed per-partition memory floor.

### 3.2 What partition count actually buys you

| Property                                         | Does more partitions help? | Note                                                                        |
| ------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------- |
| Invocation concurrency across **different** keys | **Yes**                    | Each partition processor runs independently.                                |
| Kafka backlog drain speed                        | **Yes**                    | Messages hash across partitions; a bigger `N` drains proportionally faster. |
| Throughput on a **single hot key**               | **No**                     | One key always lands on one partition; adding partitions never helps.       |
| HA rebalance granularity (multi-node)            | **Yes**                    | Partitions are the unit of replica placement.                               |
| Memory cost                                      | **Linear**                 | The bucket C contribution from §2 scales directly with `N`.                 |

**Rule of thumb:** more partitions is only useful if you have real cross-key concurrency _and_ multiple nodes to distribute them across. A single-node, low-concurrency environment gets almost nothing from `N > 4`.

### 3.3 How to pick `N`

1. Look up your target tier in §6. Use that partition count.
2. If you're between tiers, round **down** — partition count is bootstrap-immutable (see Appendix A), so adding later requires a maintenance window but not an emergency one, whereas over-provisioning now wastes memory continuously.
3. Single-node dev should be tier-S (`partitions = 1`) or tier-M (`partitions = 4`). Pick tier-M if you expect to exercise concurrent Kafka backlog drain; tier-S if the cluster is near-idle.

> **Historical note:** Restate 1.3's built-in default when `[worker] partitions` is omitted is **24**. Nothing in `abl-platform-deploy` currently sets this value, so `abl-platform-dev-restate` was running at 24 by accident — not design. The 2026-04-13 incident sized memory for tier-S while partition count was leaking through at tier-L scale. Always set `partitions` explicitly at bootstrap.

> **Partition reduction is NOT safe for any environment holding in-flight workflow state.** For those environments, size memory up to fit the existing partition count instead of reducing `N`. See Appendix A.

---

## 4. The formula

```
memory_limit  ≈  base
               + rocksdb_budget
               + partitions × per_partition_overhead
               + kafka_subscriptions × ingress_headroom
               + 20 % safety margin
```

| Term                     | Default (Restate 1.3)                                               | Source                                                                                             |
| ------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `base`                   | **400 MiB**                                                         | Measured across idle Restate 1.3 pods; covers binary, tokio runtime, metadata-store, admin server. |
| `rocksdb_budget`         | **you set this** via `[worker] rocksdb-total-memory-size`           | See §5.                                                                                            |
| `partitions`             | **24** when `[worker] partitions` unset                             | See §3; pick explicitly.                                                                           |
| `per_partition_overhead` | **80-150 MiB**                                                      | Dominated by `write_buffer_size × max_write_buffer_number` per CF.                                 |
| `kafka_subscriptions`    | count of `[[ingress.kafka-clusters]]` consumers × subscribed topics | Check `ConfigMap`.                                                                                 |
| `ingress_headroom`       | **200 MiB / subscription** under active backlog                     | Kafka consumer buffer + in-flight invocation journals.                                             |
| safety margin            | **20 %**                                                            | Accounts for bucket E (cgroup page-cache headroom) and transient spikes.                           |

The formula scales linearly with `partitions`. **That term dominates** for any non-trivial `N`. Cutting `partitions` from 24 to 4 reduces the memory floor by 6× with no behavioral loss on a single-node dev cluster.

---

## 5. Choosing `rocksdb-total-memory-size`

The `[worker] rocksdb-total-memory-size` setting caps RocksDB's internal allocations (block cache + memtables + pinned/index/filter blocks). Restate sets it **defensively** — if unset, RocksDB sizes its block cache as a fraction of system memory, which in a cgroup-limited container means "size for the host, OOM for me."

### Rule of thumb

Pick **40-50 % of the container memory limit.** The remaining ~50 % covers:

- Bucket A (process base).
- Bucket D (ingress + invocation buffers).
- Bucket E (cgroup page-cache headroom).
- Tokio/Rust allocator overhead.

### Trade-offs

| If `rocksdb-total-memory-size` is… | Symptom                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Too small (< 25 % of limit)        | Block cache thrashes, read latency spikes, CPU climbs as SSTs are re-read.                  |
| Too large (> 65 % of limit)        | Memtables starve for headroom → write stalls → OOM under backlog.                           |
| Unset                              | RocksDB picks its own fraction of **host** memory, ignores cgroup → OOM. **Always set it.** |

### Example

For a 4 GiB container limit:

```toml
[worker]
rocksdb-total-memory-size = "1500 MiB"
```

1500 MiB ≈ 37 % of 4 GiB. Leaves ~2.5 GiB for everything else in the process.

---

## 6. Tier calibration table

**Authoritative source:** `packages/sizing-calculator/src/engine/constants.ts` (`DATA_STORE_SPECS.restate`, lines 528-577 as of 2026-04-13). Update the code, not this doc, when tiers change.

| Tier   | CPU | Memory    | Storage | Replicas | **Partitions** (`shardCount` in code) | Strategy                       |
| ------ | --- | --------- | ------- | -------- | ------------------------------------- | ------------------------------ |
| **S**  | `1` | **`2Gi`** | `20Gi`  | 3        | **`1`**                               | `single-partition-raft`        |
| **M**  | `2` | **`4Gi`** | `100Gi` | 3        | **`4`**                               | `4-partition-raft`             |
| **L**  | `4` | **`8Gi`** | `500Gi` | 5        | **`16`**                              | `16-partition-raft`            |
| **XL** | `4` | **`8Gi`** | `1Ti`   | 5        | **`32`**                              | `32-partition-raft-standby-dr` |

This table is the source of truth. If tiers change, edit the code, not this doc.

### Picking a tier for an environment

- **Local / CI** → tier-S. Single partition. Minimum viable memory.
- **Shared dev** (current `abl-platform-dev`) → tier-M. Gives parallel Kafka backlog drain without wasting memory; matches observed concurrency.
- **Staging / preview** → tier-M or tier-L depending on whether it mirrors production load.
- **Production** → tier-L or tier-XL per the sizing questionnaire in `packages/sizing-calculator`.

> **Do not mix tiers.** Running tier-L partitions (`N = 16`) on tier-S memory (`2 Gi`) is what caused the 2026-04-13 incident. The tier row is a bundle: memory, CPU, partitions, replicas, and storage all move together.

---

## 7. Empirical verification

A formula is a starting bound. Real sizing is confirmed by measurement. After any Restate config change, run these four probes against the rolled pod.

### 7.1 RSS versus cgroup limit

```bash
kubectl -n <ns> top pod <restate-pod>
```

Compare `MEMORY(bytes)` to the pod's `limits.memory`. Healthy: RSS plateaus at **65-75 %** of limit.

### 7.2 Where the memory is going

```bash
kubectl -n <ns> exec <restate-pod> -c restate -- \
  curl -s localhost:9070/metrics | \
  grep -E 'rocksdb_block_cache_usage|rocksdb_cur_size_all_mem_tables|process_resident_memory_bytes'
```

Sanity check: `rocksdb_block_cache_usage` ≤ `rocksdb-total-memory-size × 0.5`; `rocksdb_cur_size_all_mem_tables` should climb under load and **fall** after flushes (if it only climbs, you're heading for a stall).

> Metric names may be prefixed (e.g., `restate_rocksdb_*`) depending on Restate version. Verify against `curl <pod>:<admin-port>/metrics | grep rocksdb` on your deployment before relying on these greps.

### 7.3 Stall detection

```bash
kubectl -n <ns> logs <restate-pod> --tail=2000 | grep -iE 'stall|slow|write.*threshold'
```

Zero lines in the last 10 minutes of a steady-state window = pass. Any line = under-sized or a downstream consumer is broken (see §9).

### 7.4 Steady-state acceptance criterion

Leave the pod running for **30 minutes after Kafka backlog drains**. Re-run §7.1.

| Outcome                                        | Meaning                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| RSS plateaus at 65-75 % of limit, no stalls    | **Correctly sized.** Commit the change.                         |
| RSS pinned at > 85 % of limit, periodic stalls | **Under-sized.** Go up one tier.                                |
| RSS flat < 40 % of limit for 30 min            | **Over-sized.** Consider dropping a tier on the next bootstrap. |

---

## 8. Worked example — dev cluster, 2026-04-13

### 8.1 Evidence

From the live cluster at the time of the incident:

- **Pod state:** `CrashLoopBackOff`, 19 restarts in 79 minutes.
- **Last state:** `Terminated · Reason: OOMKilled · Exit Code: 137`.
- **Kernel log:** `Memory cgroup out of memory: Killed process … restate-server … anon-rss:2069392kB`.
- **Container limit:** `cpu: 500m · memory: 2Gi` (requests `100m / 512Mi`).
- **Rendered `restate.toml`:** only `[worker] internal-queue-length = 1000` and the Kafka broker list. **No `partitions`, no `rocksdb-total-memory-size`.**
- **Runtime partition count:** 24 (verified: `Partition 0 started` … `Partition 23 started` across two successive container lifetimes).
- **Active subscriptions:** 3 (`abl.session.ended`, `abl.message.agent`, `abl.message.user`), all targeting `service://PipelineTrigger/handleEvent`.
- **First log warning before OOM:** `[Stall Detector] Rocksdb write operation exceeded rocksdb-write-stall-threshold` on `local-loglet` DB.

### 8.2 Applying the formula

Plug the evidence into §4:

```
base                       400 MiB
rocksdb_budget (unset → unbounded, sized from host RAM not cgroup)
24 partitions × 100 MiB   2400 MiB     ← dominant
3 subs × 200 MiB           600 MiB
─────────────────────────────────────
subtotal                 ~4900 MiB
+ 20 % safety            ~ 980 MiB
─────────────────────────────────────
required                 ~5900 MiB

actual limit              2048 MiB   ← OOM guaranteed
```

A 2 GiB container cannot hold 24 partitions with default RocksDB tuning. Every restart replayed the Kafka backlog, every replay re-built memtables across all 24 CFs, every time the cgroup killed the process before they could flush. Classic bucket-C pathology.

### 8.3 Remediation snippets (apply in `abl-platform-deploy`)

> **These snippets live in `bitbucket.org/koreteam1/abl-platform-deploy`, not this repo.** ArgoCD (`argocd/abl-platform-dev`) syncs the live cluster from that source. Any edit to the live StatefulSet via `kubectl patch` is reverted on the next sync.

Two files must change. A values-only edit is a no-op without the corresponding chart template edit.

#### File 1: `environments/dev/values.yaml` — `restate:` block

Bump `restate.resources.limits.memory` from `2Gi` to `4Gi`; add `restate.config.partitions: 4` and `restate.config.rocksdbTotalMemorySize: "1500 MiB"`.

> **Path:** `abl-platform-stack.abl-platform.restate` — this block lives nested two levels deep in the wrapper chart values.

```yaml
# environments/dev/values.yaml
abl-platform-stack:
  abl-platform:
    restate:
      resources:
        requests:
          memory: 512Mi # unchanged
        limits:
          memory: 4Gi # was 2Gi  ← the OOM fix
      config: # new block
        partitions: 4 # explicit; matches tier-M
        rocksdbTotalMemorySize: '1500 MiB' # chart key that renders into [worker]
```

#### File 2: `helm/abl-platform/templates/restate/configmap.yaml` — template patch

The current template is hardcoded and does not read `.Values.restate.config.*`:

```yaml
# BEFORE (current state)
data:
  restate.toml: |
    [worker]
    internal-queue-length = 1000
    [[ingress.kafka-clusters]]
    name = "local"
    brokers = [{{ include "abl-platform.kafkaBootstrap" . | quote }}]
```

Patch the template to render the new values conditionally (Helm `{{- if }}` guards ensure backward compatibility when keys are absent):

```yaml
# AFTER (with conditional rendering)
data:
  restate.toml: |
    [worker]
    internal-queue-length = 1000
    {{- if .Values.restate.config.partitions }}
    partitions = {{ .Values.restate.config.partitions }}
    {{- end }}
    {{- if .Values.restate.config.rocksdbTotalMemorySize }}
    rocksdb-total-memory-size = {{ .Values.restate.config.rocksdbTotalMemorySize | quote }}
    {{- end }}
    [[ingress.kafka-clusters]]
    name = "local"
    brokers = [{{ include "abl-platform.kafkaBootstrap" . | quote }}]
```

After the change, the rendered `restate.toml` for dev should read:

```toml
[worker]
internal-queue-length = 1000
partitions = 4
rocksdb-total-memory-size = "1500 MiB"

[[ingress.kafka-clusters]]
name = "local"
brokers = ["abl-platform-dev-kafka-kafka-bootstrap:9092"]
```

### 8.4 Re-bootstrap sequence (mandatory when `partitions` changes)

Because `partitions` is bootstrap-immutable (Appendix A), the deploy PR **cannot** be rolled live against the existing PVC. Follow this order.

> **This procedure is safe for dev only.** For any environment with in-flight workflow state (staging, prod), do **not** reduce `partitions` — size memory up to fit the existing count instead. See Appendix A.

1. **Quiesce producers.** Disable the three Kafka subscriptions (or scale runtime producers to 0) so no new messages arrive during the maintenance window.
2. **Scale the StatefulSet to 0:**

   ```bash
   kubectl -n abl-platform-dev scale sts abl-platform-dev-restate --replicas=0
   ```

3. **Delete the PVC** (ArgoCD's `whenDeleted: Retain` preserves the PV object; deleting the PVC is the explicit opt-in to wipe state):

   > ⚠️ **WARNING — DEV ONLY.** This permanently deletes all Restate state: in-flight workflows, journals, user-keyed durable state, partition metadata. Safe for `abl-platform-dev` because no durable workflow state is expected there. **For any environment holding real workflow state (staging, prod, customer), do NOT run this command — size memory up to fit the existing partition count instead. See Appendix A.**

   ```bash
   kubectl -n abl-platform-dev delete pvc data-abl-platform-dev-restate-0
   ```

4. **Merge the `abl-platform-deploy` PR.** Wait for ArgoCD to sync.
5. **Verify the StatefulSet scales back up** with a fresh PVC and the new config:

   ```bash
   kubectl -n abl-platform-dev get sts,pvc,pod -l app.kubernetes.io/component=restate
   kubectl -n abl-platform-dev get cm abl-platform-dev-restate-config -o jsonpath='{.data.restate\.toml}'
   ```

   The rendered `restate.toml` should contain the new `partitions = 4` and `rocksdb-total-memory-size` lines.

6. **Re-enable producers and run §7 empirical checks** over the next 30 minutes.

**Acceptance:** RSS steady-state ≤ 3 GiB (75 % of 4 GiB limit); zero `stall` lines in the last 10 minutes of logs post-drain.

---

## 9. When to open a ticket vs. resize — decision tree

```
Symptom: Restate pod OOM or write stalls
│
├── Is RSS at > 85 % of limit at steady state?
│     ├── YES → under-sized. Move up one tier in §6. Apply §8.4 if partitions change.
│     └── NO  → memory is fine; investigate further.
```

To see both numbers side-by-side:

```bash
kubectl -n abl-platform-dev top pod abl-platform-dev-restate-0
kubectl -n abl-platform-dev get pod abl-platform-dev-restate-0 \
  -o jsonpath='{.spec.containers[0].resources.limits.memory}{"\n"}'
```

Or in Grafana, `container_memory_working_set_bytes / kube_pod_container_resource_limits{resource="memory"}` gives the ratio directly.

```
│
├── Are there 'stall' lines in logs with RSS < 60 % of limit?
│     ├── YES → write pipeline is backed up by a downstream consumer.
│     │         Check the target handler (e.g. PipelineTrigger/handleEvent)
│     │         — is it healthy, is there a circuit-broken dependency,
│     │         is the Kafka backlog unbounded? File a ticket on the
│     │         handler, not on Restate.
│     └── NO  → not a resize/handler problem; investigate further.
│
├── RSS climbs linearly over hours/days with no steady state?
│     └── Likely memory leak in Restate or a handler session.
│         File a Restate bug with /metrics dump + version.
│
└── Everything flat but user complaints of latency?
      └── Partition count may be too low for cross-key concurrency.
          Plan a re-bootstrap (Appendix A) to move up a tier.
```

---

## Appendix A: Partition count is bootstrap-immutable

Restate pins `[worker] partitions` at the moment a cluster first initialises its state. Keys are hashed `partition_id = hash(key) mod N`; any change to `N` would rehash every existing key into a different partition, invalidating all state.

Restate will **not silently re-shard.** Depending on version it either:

- refuses to start with an error about mismatched partition count, or
- continues with the original `N` and ignores the new setting.

**Implications:**

- Pick `N` correctly at first bootstrap using §6.
- To change `N` on a running cluster, you must delete the PVC and accept state loss (the §8.4 sequence).
- **Never** reduce `N` on a cluster with in-flight workflow state.
- Prefer erring high on the first bootstrap for prod-adjacent environments; the memory cost is visible and easy to plan, while a partition-count bump later requires a maintenance window.
