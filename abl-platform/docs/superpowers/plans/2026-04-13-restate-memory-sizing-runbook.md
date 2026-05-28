# Restate Memory Sizing Runbook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an operator-facing runbook at `docs/guides/restate-memory-sizing.md` explaining how to size Restate memory, why the dev cluster OOM-looped on 2026-04-13, and the exact remediation to apply in `abl-platform-deploy`.

**Architecture:** Single Markdown document, 9 numbered sections, cross-referenced. Cites authoritative constants from `packages/sizing-calculator/src/engine/constants.ts` instead of duplicating them. Pure documentation — no code, no tests, no runtime change in this repo. Downstream consumer (platform engineer) applies the `environments/dev/values.yaml` and `restate.toml` snippets in `abl-platform-deploy`.

**Tech Stack:** Markdown, GitHub-flavored tables; `prettier` for formatting; `pnpm jira:update` for Jira round-trip; Bitbucket PR.

**Spec:** `docs/superpowers/specs/2026-04-13-restate-memory-sizing-design.md`

---

## File Structure

| Path                                                                 | Action              | Responsibility                                                                 |
| -------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `docs/guides/restate-memory-sizing.md`                               | **Create**          | The runbook itself. Single authoritative source for operator sizing decisions. |
| `docs/superpowers/specs/2026-04-13-restate-memory-sizing-design.md`  | **Already present** | Design spec, included in the same commit to keep design + doc paired.          |
| `docs/superpowers/plans/2026-04-13-restate-memory-sizing-runbook.md` | **This file**       | Plan artifact — also included in the same commit.                              |

No other files touched. No code. No tests. No config.

---

## Task 0: Pre-flight — branch + Jira ticket

**Files:** none (repo/Jira state only)

- [ ] **Step 1: Verify clean working tree except for already-known files**

```bash
git status --short
```

Expected:

```
 M apps/studio/next-env.d.ts
?? docs/superpowers/specs/2026-04-13-insights-coverage-master-plan.md
?? docs/superpowers/specs/2026-04-13-restate-memory-sizing-design.md
?? docs/superpowers/plans/2026-04-13-restate-memory-sizing-runbook.md
```

If anything else appears, stop and investigate before proceeding.

- [ ] **Step 2: Search Jira for an existing Restate / OOM / dev-infra ticket to reuse**

```bash
pnpm jira:search -- "project = ABLP AND (text ~ 'restate' OR text ~ 'OOM') AND status != Done" --max 10
```

If the repo doesn't expose `jira:search`, fall back to:

```bash
pnpm jira:update -- --help
```

…and pick the nearest verb. If no ticket matches, create a fresh one:

```bash
pnpm jira:create -- --project ABLP \
  --summary "dev Restate OOM CrashLoop — memory sizing runbook + deploy-repo config" \
  --type Task \
  --label infra,restate,dev-cluster
```

Record the returned key (e.g. `ABLP-XYZ`) — it goes in every commit header in this plan.

- [ ] **Step 3: Create the branch from `develop`**

Branch creation is explicitly in scope per user approval of the spec.

```bash
git checkout -b docs/restate-memory-sizing develop
git status
```

Expected: `On branch docs/restate-memory-sizing` with the three untracked files from Step 1 still listed.

- [ ] **Step 4: Confirm no work is lost**

```bash
git log --oneline -5
```

Expected: the `develop` tip commits (`e2f04ca81`, `2728b98d7`, …) are visible. Branch base is correct.

---

## Task 1: Scaffold the runbook file with section headings

**Files:**

- Create: `docs/guides/restate-memory-sizing.md`

- [ ] **Step 1: Create the file with frontmatter and empty sections**

```bash
mkdir -p docs/guides
```

Then write `docs/guides/restate-memory-sizing.md` with exactly this skeleton:

```markdown
# Restate Memory Sizing Runbook

**Status:** Authoritative for operator sizing decisions against Restate 1.3.
**Last incident referenced:** `abl-platform-dev-restate-0` OOM loop, 2026-04-13.
**Change control:** The tier numbers in §6 come from `packages/sizing-calculator/src/engine/constants.ts`. Update the code, not this doc, when tiers evolve.

## 1. Purpose

## 2. What uses memory inside Restate

## 3. Partitions — what they are, what they cost, and how to pick N

### 3.1 Mental model

### 3.2 What partition count actually buys you

### 3.3 How to pick N

## 4. The formula

## 5. Choosing `rocksdb-total-memory-size`

## 6. Tier calibration table

## 7. Empirical verification

## 8. Worked example — dev cluster, 2026-04-13

### 8.1 Evidence

### 8.2 Applying the formula

### 8.3 Remediation snippets (for `abl-platform-deploy`)

### 8.4 Re-bootstrap sequence (mandatory when `partitions` changes)

## 9. When to open a ticket vs. resize — decision tree

## Appendix A: Partition count is bootstrap-immutable
```

- [ ] **Step 2: Verify file created**

```bash
ls -la docs/guides/restate-memory-sizing.md
head -5 docs/guides/restate-memory-sizing.md
```

Expected: file exists, header + status block visible.

---

## Task 2: §1 Purpose and §2 Memory buckets

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §1 and §2)

- [ ] **Step 1: Fill §1 Purpose**

Replace the empty `## 1. Purpose` heading's body with exactly:

```markdown
## 1. Purpose

Open this doc when:

- A Restate pod is `OOMKilled` or in `CrashLoopBackOff` with exit code `137`.
- Restate logs emit `[Stall Detector] ... rocksdb-write-stall-threshold` warnings.
- You are bootstrapping a new Restate cluster and need to pick `resources.limits.memory` and `[worker] partitions`.
- You are graduating an environment between tiers (S → M → L → XL).

The doc answers three questions: _what does Restate spend memory on_, _how much does it need for a given workload_, and _how do I verify the number I picked is right_.
```

- [ ] **Step 2: Fill §2 Memory buckets**

Replace the empty `## 2. What uses memory inside Restate` section body with exactly:

```markdown
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
```

- [ ] **Step 3: Verify sections render**

```bash
grep -n "^## " docs/guides/restate-memory-sizing.md
```

Expected: 9 `## ` headings in order `1..9` plus the Appendix A heading.

---

## Task 3: §3 Partitions (3 subsections)

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §3.1, §3.2, §3.3)

- [ ] **Step 1: Fill §3.1 Mental model**

```markdown
### 3.1 Mental model

Restate shards its keyspace into `N` **partitions**. Every invocation carries a key (virtual-object key, workflow ID, or a synthetic key for unkeyed services); Restate computes `partition_id = hash(key) mod N` and routes to the owning partition processor.

Each partition owns real resources, not just a logical label:

- A **partition processor** (the `pp-N` tasks visible in logs) that replays the journal and drives the state machine.
- A **dedicated RocksDB column family** for user state.
- A **memtable + write-buffer stack** for that column family.
- A **slice of the journal log**.
- A **bounded invocation queue** (`[worker] internal-queue-length`).

This is why `N` is a first-class sizing input: every increment adds a fixed per-partition memory floor.
```

- [ ] **Step 2: Fill §3.2 What partition count buys you**

```markdown
### 3.2 What partition count actually buys you

| Property                                         | Does more partitions help?                                               | Note                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Invocation concurrency across **different** keys | **Yes**                                                                  | Each partition processor runs independently.                                |
| Kafka backlog drain speed                        | **Yes**                                                                  | Messages hash across partitions; a bigger `N` drains proportionally faster. |
| Throughput on a **single hot key**               | **No**                                                                   | One key always lands on one partition; adding partitions never helps.       |
| HA rebalance granularity (multi-node)            | **Yes**                                                                  | Partitions are the unit of replica placement.                               |
| Memory cost                                      | **Linear** — the bucket C contribution from §2 scales directly with `N`. |

**Rule of thumb:** more partitions is only useful if you have real cross-key concurrency _and_ multiple nodes to distribute them across. A single-node, low-concurrency environment gets almost nothing from `N > 4`.
```

- [ ] **Step 3: Fill §3.3 How to pick N**

```markdown
### 3.3 How to pick `N`

1. Look up your target tier in §6. Use that partition count.
2. If you're between tiers, round **down** — partition count is bootstrap-immutable (see Appendix A), so it's cheaper to add later (when you re-bootstrap anyway for other reasons) than to over-provision now.
3. Single-node dev should be tier-S (`partitions = 1`) or tier-M (`partitions = 4`). Pick tier-M if you expect to exercise concurrent Kafka backlog drain; tier-S if the cluster is near-idle.

> **Historical note:** Restate 1.3's built-in default when `[worker] partitions` is omitted is **24**. Nothing in `abl-platform-deploy` currently sets this value, so `abl-platform-dev-restate` was running at 24 by accident — not design. The 2026-04-13 incident sized memory for tier-S while partition count was leaking through at tier-L scale. Always set `partitions` explicitly at bootstrap.
```

- [ ] **Step 4: Verify**

```bash
grep -cE "^### 3\.[123]" docs/guides/restate-memory-sizing.md
```

Expected: `3`.

---

## Task 4: §4 The formula

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §4)

- [ ] **Step 1: Fill §4**

````markdown
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
````

- [ ] **Step 2: Verify**

```bash
grep -c 'memory_limit' docs/guides/restate-memory-sizing.md
```

Expected: `1`.

---

## Task 5: §5 Choosing `rocksdb-total-memory-size`

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §5)

- [ ] **Step 1: Fill §5**

````markdown
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
````

---

## Task 6: §6 Tier calibration table

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §6)

- [ ] **Step 1: Fill §6**

```markdown
## 6. Tier calibration table

**Authoritative source:** `packages/sizing-calculator/src/engine/constants.ts` (`DATA_STORE_SPECS.restate`, lines 528-577 as of 2026-04-13). Update the code, not this doc, when tiers change.

| Tier   | CPU | Memory    | Storage | Replicas | **Partitions** | Strategy                       |
| ------ | --- | --------- | ------- | -------- | -------------- | ------------------------------ |
| **S**  | `1` | **`2Gi`** | `20Gi`  | 3        | **`1`**        | `single-partition-raft`        |
| **M**  | `2` | **`4Gi`** | `100Gi` | 3        | **`4`**        | `4-partition-raft`             |
| **L**  | `4` | **`8Gi`** | `500Gi` | 5        | **`16`**       | `16-partition-raft`            |
| **XL** | `4` | **`8Gi`** | `1Ti`   | 5        | **`32`**       | `32-partition-raft-standby-dr` |

### Picking a tier for an environment

- **Local / CI** → tier-S. Single partition. Minimum viable memory.
- **Shared dev** (current `abl-platform-dev`) → tier-M. Gives parallel Kafka backlog drain without wasting memory; matches observed concurrency.
- **Staging / preview** → tier-M or tier-L depending on whether it mirrors production load.
- **Production** → tier-L or tier-XL per the sizing questionnaire in `packages/sizing-calculator`.

> **Do not mix tiers.** Running tier-L partitions (`N = 16`) on tier-S memory (`2 Gi`) is what caused the 2026-04-13 incident. The tier row is a bundle: memory, CPU, partitions, replicas, and storage all move together.
```

---

## Task 7: §7 Empirical verification

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §7)

- [ ] **Step 1: Fill §7**

````markdown
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
````

---

## Task 8: §8 Worked example with 4 subsections

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §8.1-8.4)

- [ ] **Step 1: Fill §8.1 Evidence**

```markdown
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
```

- [ ] **Step 2: Fill §8.2 Applying the formula**

````markdown
### 8.2 Applying the formula

Plug the evidence into §4:

```
base                       400 MiB
rocksdb_budget (unset → defaulted huge) ≥ 1500 MiB effective
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
````

- [ ] **Step 3: Fill §8.3 Remediation snippets**

````markdown
### 8.3 Remediation snippets (apply in `abl-platform-deploy`)

> **These snippets live in `bitbucket.org/koreteam1/abl-platform-deploy`, not this repo.** ArgoCD (`argocd/abl-platform-dev`) syncs the live cluster from that source. Any edit to the live StatefulSet via `kubectl patch` is reverted on the next sync.

**File:** `environments/dev/values.yaml` — `restate:` block:

```yaml
restate:
  resources:
    requests:
      cpu: 500m
      memory: 2Gi # was 512Mi
    limits:
      cpu: '1'
      memory: 4Gi # was 2Gi  ← the OOM fix
  config:
    partitions: 4 # explicit; matches tier-M
    rocksdbTotalMemorySize: '1500 MiB' # chart key that renders into [worker]
```

The chart in `abl-platform-deploy` renders these into `ConfigMap abl-platform-dev-restate-config`. After the change the rendered `restate.toml` should read:

```toml
[worker]
internal-queue-length = 1000
partitions = 4
rocksdb-total-memory-size = "1500 MiB"

[[ingress.kafka-clusters]]
name = "local"
brokers = ["abl-platform-dev-kafka-kafka-bootstrap:9092"]
```

If the chart does not currently expose `partitions` or `rocksdbTotalMemorySize` as value-keys, a chart template edit is also required — confirm with the platform team before the deploy PR merges.
````

- [ ] **Step 4: Fill §8.4 Re-bootstrap sequence**

````markdown
### 8.4 Re-bootstrap sequence (mandatory when `partitions` changes)

Because `partitions` is bootstrap-immutable (Appendix A), the deploy PR **cannot** be rolled live against the existing PVC. Follow this order:

1. **Quiesce producers.** Disable the three Kafka subscriptions (or scale runtime producers to 0) so no new messages arrive during the maintenance window.
2. **Scale the StatefulSet to 0:**

   ```bash
   kubectl -n abl-platform-dev scale sts abl-platform-dev-restate --replicas=0
   ```

3. **Delete the PVC** (ArgoCD's `whenDeleted: Retain` preserves the PV object; deleting the PVC is the explicit opt-in to wipe state):

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

6. **Re-enable producers.**
7. **Run §7 empirical checks** over the next 30 minutes.

**Acceptance:** RSS steady-state ≤ 3 GiB (75 % of 4 GiB limit); zero `stall` lines in the last 10 minutes of logs post-drain.

> This procedure is safe for **dev only**. For any environment with in-flight workflow state (staging, prod), do **not** reduce `partitions` — size memory up to fit the existing count instead. See Appendix A.
````

---

## Task 9: §9 Decision tree and Appendix A

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (fill §9 and Appendix A)

- [ ] **Step 1: Fill §9 Decision tree**

````markdown
## 9. When to open a ticket vs. resize — decision tree

```
Symptom: Restate pod OOM or write stalls
│
├── Is RSS at > 85 % of limit at steady state?
│     ├── YES → under-sized. Move up one tier in §6. Apply §8.4 if partitions change.
│     └── NO  → memory is fine; investigate further.
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
````

- [ ] **Step 2: Fill Appendix A**

```markdown
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
```

- [ ] **Step 3: Verify full section count**

```bash
grep -cE "^## " docs/guides/restate-memory-sizing.md
```

Expected: `10` (§1 through §9, plus `## Appendix A`).

```bash
grep -cE "^### " docs/guides/restate-memory-sizing.md
```

Expected: `11` (§3.1-3.3, §7.1-7.4, §8.1-8.4).

---

## Task 10: Format, link-check, internal review

**Files:**

- Modify: `docs/guides/restate-memory-sizing.md` (formatting only)

- [ ] **Step 1: Format with prettier**

CLAUDE.md mandates prettier on all changed files before commit.

```bash
npx prettier --write docs/guides/restate-memory-sizing.md \
                     docs/superpowers/specs/2026-04-13-restate-memory-sizing-design.md \
                     docs/superpowers/plans/2026-04-13-restate-memory-sizing-runbook.md
```

Expected: all three files listed as changed or unchanged; no errors.

- [ ] **Step 2: Grep for placeholder text**

```bash
grep -nE 'TODO|TBD|XXX|FIXME|\.\.\.' docs/guides/restate-memory-sizing.md || echo "clean"
```

Expected: `clean` (or only intentional ellipses inside code fences — review each hit).

- [ ] **Step 3: Confirm every cross-reference resolves**

```bash
grep -oE '§[0-9]+(\.[0-9]+)?|Appendix A' docs/guides/restate-memory-sizing.md | sort -u
```

Every § reference must correspond to a heading that exists. Verify by cross-check with `grep -nE '^(##|###) ' docs/guides/restate-memory-sizing.md`.

- [ ] **Step 4: Confirm authoritative sources resolve**

```bash
ls packages/sizing-calculator/src/engine/constants.ts
sed -n '528,577p' packages/sizing-calculator/src/engine/constants.ts
```

Expected: file exists; lines 528-577 contain the `restate:` tier block. If line numbers have shifted, update §6 to match.

- [ ] **Step 5: Self-read the rendered markdown**

```bash
cat docs/guides/restate-memory-sizing.md | less
```

Read top-to-bottom. Check for: broken code fences (every ` ``` ` must have a closing pair), table column alignment, that the numbers in §4.2, §8.2 remediation, and Appendix A are consistent.

---

## Task 11: Commit

**Files:** (3) the doc, the spec, the plan.

- [ ] **Step 1: Stage exactly the three files**

```bash
git add docs/guides/restate-memory-sizing.md \
        docs/superpowers/specs/2026-04-13-restate-memory-sizing-design.md \
        docs/superpowers/plans/2026-04-13-restate-memory-sizing-runbook.md
git status
```

Expected: 3 files staged; `apps/studio/next-env.d.ts` and unrelated specs remain **unstaged**.

- [ ] **Step 2: Pre-commit hook dry-run**

```bash
git diff --cached --name-only
```

Expected: the same 3 paths. Confirms the PreToolUse prettier hook will operate on those files only.

- [ ] **Step 3: Commit with the real Jira key from Task 0**

Use the ticket key captured in Task 0, Step 2. Replace `ABLP-XYZ` below with the real key.

```bash
git commit -m "[ABLP-XYZ] docs(ops): add Restate memory sizing runbook

Document how to size Restate memory against Restate 1.3. Includes:
- 5 memory buckets (process base, RocksDB block cache, memtables,
  ingress buffers, cgroup headroom)
- Sizing formula with default inputs
- Partition concept, cost model, and bootstrap-immutability rule
- Tier calibration table citing packages/sizing-calculator
- Empirical verification procedure
- Worked example for the 2026-04-13 dev OOM incident with
  remediation snippets for abl-platform-deploy
- Re-bootstrap sequence required when partitions changes
- Decision tree for resize-vs-ticket
- Appendix A: partition count bootstrap-immutability

Documentation only. No runtime change in this repo. The
abl-platform-deploy follow-up PR applies the dev remediation."
```

- [ ] **Step 4: Verify commit landed**

```bash
git log --oneline -1
git show --stat HEAD
```

Expected: commit with `[ABLP-XYZ] docs(ops): add Restate memory sizing runbook`, exactly 3 files changed, all under `docs/`.

---

## Task 12: Push and open PR

**Files:** (none — Git/remote operations)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin docs/restate-memory-sizing
```

Expected: branch created on remote, tracking set.

- [ ] **Step 2: Open the PR against `develop`**

Bitbucket CLI or web UI. If `bb` is configured:

```bash
bb pr create \
  --source docs/restate-memory-sizing \
  --destination develop \
  --title "[ABLP-XYZ] docs(ops): Restate memory sizing runbook" \
  --description "$(cat <<'EOF'
## Summary

Adds `docs/guides/restate-memory-sizing.md` — operator runbook for sizing Restate memory. Written in response to the 2026-04-13 dev `Restate` OOM CrashLoop.

## What's in it

- 5-bucket memory model (process / block cache / memtables / ingress / cgroup headroom).
- Sizing formula with Restate 1.3 defaults.
- Partition concept, cost model, and the bootstrap-immutability rule.
- Tier calibration table citing `packages/sizing-calculator/src/engine/constants.ts` as the authoritative source.
- Empirical verification procedure (kubectl top, /metrics, log stall grep, 30-min steady-state criterion).
- Worked example for the dev incident: evidence → formula → remediation snippets → re-bootstrap sequence.
- Decision tree for when to resize vs. file a ticket.

## Scope

Documentation only. No code, no config, no runtime change in this repo.

## Follow-up (not in this PR — separate work in `abl-platform-deploy`)

1. **Values + config change** in `environments/dev/values.yaml`: bump `restate.resources.limits.memory` to `4Gi`, set `config.partitions: 4`, add `rocksdbTotalMemorySize: "1500 MiB"`.
2. **Re-bootstrap the dev cluster** per §8.4 of the runbook: quiesce producers → scale STS to 0 → delete PVC → merge deploy PR → ArgoCD sync → re-enable producers → run §7 empirical checks. This is mandatory because `partitions` is bootstrap-immutable.

## Test plan

- [ ] Doc renders on Bitbucket (tables + code fences).
- [ ] All `§X` cross-references resolve.
- [ ] `packages/sizing-calculator/src/engine/constants.ts:528-577` still matches the tier table in §6.
- [ ] Spec + plan files are committed alongside the runbook for traceability.
EOF
)"
```

If `bb` isn't configured, open the PR in the Bitbucket web UI using the same title, description, source, and destination.

- [ ] **Step 3: Comment the PR link back to the Jira ticket**

```bash
pnpm jira:update -- ABLP-XYZ --comment "Runbook PR: <PR-URL>

Follow-up work tracked separately: apply remediation snippets from §8.3 of the runbook to abl-platform-deploy, then execute the §8.4 re-bootstrap sequence against abl-platform-dev."
```

Replace `ABLP-XYZ` with the real key and `<PR-URL>` with the URL from Step 2.

- [ ] **Step 4: Verify the round-trip**

```bash
pnpm jira:get -- ABLP-XYZ | tail -30
```

Expected: the comment appears on the ticket with the PR URL.

---

## Self-Review

### Spec coverage

| Spec section                                | Implementing task(s)                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| §1 Context                                  | Task 8.1 (Evidence)                                                               |
| §2 Goal                                     | Whole plan (the runbook IS the goal)                                              |
| §3 Non-goals                                | §8.3 callout (not this repo); plan header                                         |
| §4.1 Document structure (§1-9 + Appendix A) | Tasks 1-9 section-by-section                                                      |
| §4.2 Numbers the doc commits to             | Task 4 (§4 formula table)                                                         |
| §4.3 Bootstrap-immutable caveat             | Task 8.4 + Task 9 Appendix A                                                      |
| §5 Out of scope                             | Reflected in §8.3 scope callout and Task 11 commit message                        |
| §6 Rollout & validation                     | Task 12 PR description "Follow-up" section                                        |
| §7 Risks                                    | Mitigations embedded in §8.4 mandatory sequence and Appendix A                    |
| §9 Implementation notes (1-7)               | Tasks 0 (Jira + branch), 10 (prettier), 11 (commit), 12 (push + PR + jira update) |

No gaps.

### Placeholder scan

All tasks contain complete markdown content. The only placeholder is `ABLP-XYZ`, which is explicitly flagged in Task 0 Step 2 as "record the returned key … it goes in every commit header in this plan" — the engineer substitutes the real key. No TBD, no TODO, no "add appropriate error handling."

### Type / name consistency

- `docs/guides/restate-memory-sizing.md` — same path in Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11.
- Branch name `docs/restate-memory-sizing` — same in Task 0 and Task 12.
- Jira placeholder `ABLP-XYZ` — same in Tasks 0, 11, 12.
- Tier numbers (`2Gi/4Gi/8Gi`, `1/4/16/32`) match between Task 6 (§6 table) and `packages/sizing-calculator/src/engine/constants.ts:528-577` (verified in Task 10 Step 4).
- Dev recommendation (`4 Gi + partitions:4 + 1500 MiB`) identical in Task 4 (§4), Task 5 (§5 example), Task 8.3 (§8.3 snippets), Task 12 (PR description).

No inconsistencies.
