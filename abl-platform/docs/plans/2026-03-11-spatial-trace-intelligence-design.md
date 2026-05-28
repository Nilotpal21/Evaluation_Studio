# Spatial Trace Intelligence (STI) — Design Document

**Date**: 2026-03-11
**Status**: Draft v7 (all 15 open questions resolved, config_snapshots schema added)
**Author**: Prasanna Arikala + Claude
**Review rounds**: 2 (5 reviewers each: problem-solution fit, overengineering, scalability/cost, novelty/prior art, maintainability)

---

## Problem Statement

In a complex distributed agent platform, customers build solutions using combinations of channels, agents, workflows, tools, SearchAI pipelines, integrations, and state machines. These customer configurations touch diverse code paths across a multi-pod distributed deployment.

When something goes wrong in production — a trace is slow, a component is saturated, a regression appears after deploy, or a systemic pattern emerges across tenants — the **platform engineering team and support team** need to diagnose the issue using only a trace ID, without knowledge of the customer's specific agent configuration.

### Audience Separation

This system serves a **different audience** than the existing trace infrastructure:

|                         | Agent Developer Traces (existing)                                                         | STI (this design)                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Audience**            | Agent developers, business leaders, operations, compliance                                | Platform engineers, support team, SRE                                            |
| **Primary question**    | "What did MY agent do?"                                                                   | "What happened in THE SYSTEM?"                                                   |
| **Data model**          | Rich text events — LLM responses, tool outputs, conversation content, guardrail reasoning | Numerical coordinates — code path taken, resource vectors, config hashes         |
| **Scope**               | Single tenant / project / agent                                                           | Cross-tenant, cross-component, cross-deploy                                      |
| **Storage**             | ClickHouse `platform_events` table                                                        | ClickHouse `spatial_trace_records` table (separate)                              |
| **Access control**      | Tenant-scoped (agent developers see only their own data)                                  | Platform-team-only (engineers see anonymized cross-tenant patterns)              |
| **Content sensitivity** | Contains customer LLM conversations, PII, business data                                   | Contains NO text/PII by design — only numerical coordinates and resource metrics |
| **Retention**           | Limited by cost (50-200KB per trace)                                                      | Long-lived (median <2KB per STR, 90-day hot + cold archive)                      |

**STI does NOT replace existing traces.** It is a parallel, complementary system. Agent developers keep their rich text traces for debugging agent logic, LLM responses, and tool outputs. STI gives platform engineers a numerical lens for system reliability, cross-tenant analysis, and infrastructure troubleshooting — without exposing customer content.

**Why separate systems, not structured attributes on existing traces:**

1. **Access isolation**: Platform engineers should see cross-tenant system patterns without accessing customer conversation content. Mixing STI data into agent developer traces creates access control problems — either platform engineers get customer content (compliance risk) or you need per-field access control on every query (engineering nightmare).
2. **Structural PII exclusion**: The STI data model is _incapable_ of containing customer content by construction. It stores only integer coordinates, resource vectors, and config hashes. This is fundamentally stronger than RBAC on a shared store — a misconfiguration cannot expose PII because PII never enters the STR pipeline.
3. **Different retention/cost profiles**: STRs at median <2KB can be retained at 90 days for $5-50/month. The 50-200KB text events cannot match this at the same retention.
4. **Different query patterns**: Agent developer traces are queried by `(tenant, agent, session, time)` with text search. STI is queried by `(component, deploy, config_hash, coordinate)` with numerical aggregation. Different schemas and indices serve each pattern.
5. **No audience confusion**: Agent developers don't need to understand coordinate spaces. Platform engineers don't need to wade through LLM conversation logs.

**Platform engineer access model**: Platform engineers need config-level access (DSL structure, IR nodes, tenant settings referenced by config_hash) without conversation-level access (messages, LLM responses). The config snapshot store provides this — keyed by config_hash, containing only structural configuration, not conversation content.

### What STI is NOT designed for

- Debugging LLM hallucinations (agent developer traces have the content)
- Understanding conversation flow (agent developer traces have the messages)
- Compliance audit of customer data (existing traces + audit logs cover this)
- Replacing OpenTelemetry (STI is a domain-specific layer, not a general-purpose tracing replacement)

---

## Integration with `@agent-platform/shared-observability`

STI builds on top of the existing observability stack rather than creating parallel context management. The key integration points:

**Existing infrastructure (already implemented, wired by the Trace Readiness plan):**

- `createObservabilityMiddleware` (`@agent-platform/shared-observability/middleware`) — W3C `traceparent` parsing, `X-Trace-Id` response header, tenant/session/correlation context injection. Mounted on all Express servers.
- `runWithObservabilityContext` / `getObservabilityContext` / `getCurrentTraceId` (`@abl/compiler/platform`) — AsyncLocalStorage context binding. Every HTTP request and WebSocket turn runs inside this ALS context.
- `requestIdMiddleware` (`@agent-platform/shared-observability`) — `X-Request-ID` propagation via separate ALS, already mounted on runtime.
- `ObservabilityContext` type — `{ traceId, spanId, tenantId, sessionId, userId, correlationId }` — available from ALS in all async code paths.

**How STI uses this:**

1. **`tracePath()` reads `traceId` from the existing ALS** via `getCurrentTraceId()` — no parameter drilling, no separate context. The STR buffer associates each entry with the current trace automatically.
2. **System plane resource vectors** hook into `createObservabilityMiddleware`'s `recordMetrics` callback — duration, status code, and route are already captured per-request. STI extends this with per-component resource vectors from instrumented client wrappers.
3. **Cross-service propagation** reuses the W3C `traceparent` header that the middleware already parses/emits — STR segments on downstream services (SearchAI, workers) share the same `trace_id` without additional plumbing.
4. **BullMQ async boundaries** carry `traceId` in job payloads (wired by Trace Readiness plan Task 9). Worker entry points call `runWithObservabilityContext` to restore the ALS — `tracePath()` wrappers inside workers automatically pick up the trace context.

**What STI adds (not in shared-observability):**

- `tracePath()` HOF wrapper — taxonomy-aware path recording with <10us overhead
- STR ring buffer — per-trace accumulation of coordinate entries, flushed to ClickHouse
- Config hash computation — `config_hash_full` / `config_hash_tenant` from agent DSL + tenant config
- `packages/sti/taxonomy.json` — controlled vocabulary for path strings

---

## Core Concept

Every trace produces a **Spatial Trace Record (STR)** — a compact numerical object encoded across two orthogonal planes, hierarchically structured, analyzable without reading a single text log.

The key insight: with the deployed code version + compiled IR + configuration snapshot, you can reconstruct the full decision tree offline. The trace only needs to record **which path was taken** at each decision point, not describe the paths themselves.

**Size target: median <2KB per STR** (complex multi-agent traces with handoffs may reach 3-5KB).

---

## Two-Plane Architecture

### Application Plane

Captures the domain topology: which channel → which agent → which workflow nodes → which tools → which SearchAI pipelines → which integrations were traversed, what conversation/state machine paths were taken.

**Encoding**: Hybrid fixed + learned.

- **Fixed taxonomy coordinates** (Phase 0): Every known construct type gets a stable coordinate derived from its path string at build/compile time. In Phase 0a, coordinates are the path strings themselves (ClickHouse string interning handles aggregation performance). In Phase 1+, the build-time scanner assigns sequential integer coordinates for compact storage.
- **Learned behavioral embeddings** (Phase 2, deferred): Trained periodically on rolling windows of trace data. Captures dynamic patterns within each taxonomy node — conversation path shapes, state machine trajectory patterns, LLM response distribution characteristics.

**Hierarchy**:

```
depth 0: Channel (voice=0, chat=1, api=2, webhook=3)
depth 1: Agent (index into deployed agent registry per project)
depth 2: Workflow/Pipeline step (index into compiled IR node list)
depth 3: Leaf action — one of:
         - Tool call (tool registry index + outcome: success/fail/timeout)
         - LLM call (model index + token_count_bucket + latency_bucket)
         - SearchAI query (pipeline index + result_count_bucket)
         - Integration call (integration index + status)
         - Guardrail eval (guardrail index + action: pass/block/redact/reask)
         - Handoff/Delegate (target agent index + reason_code)
         - State machine transition (from_state, to_state, trigger_code)
```

Each coordinate is a small integer or short vector. The version-pinned code + IR + config provides human-readable labels when needed.

**Hierarchy evolution**: The depth structure may evolve (e.g., adding a supervisor layer, supporting nested agent delegation). The coordinate system uses path strings as stable keys, so structural changes add new depth levels without invalidating existing coordinates. Historical STRs retain their original depth encoding; cross-version queries map via path strings.

### System Plane

Captures infrastructure-level behavior: which pods handled the request, queue latencies, DB query patterns, Redis operations, external HTTP calls, resource consumption.

**Resource vector collection**: The existing `createObservabilityMiddleware` from `@agent-platform/shared-observability` already captures per-request `{ method, route, statusCode, durationMs }` via its `recordMetrics` callback. STI extends this by instrumenting database/Redis/HTTP client wrappers to record `[latency_us, throughput, error_bit, saturation_pct]` per system component per trace. These per-component vectors are associated with the current trace via `getCurrentTraceId()` from the ALS (same context the middleware populates). The codebase does NOT use OpenTelemetry — it has its own span management with manual `spanStack` tracking. Existing `durationMs` and `hasError` fields in trace events provide partial data; STI formalizes it into a structured vector per system component.

**Two sub-layers**:

1. **Resource vectors (always-on)**: Per-component `[latency_us, throughput, error_bit, saturation_pct]` for every system component touched by the trace. Collected from instrumented client wrappers in the runtime.

2. **Causal model (on-demand, Phase 3)**: Causal Bayesian Network over system components (inspired by Sage, ASPLOS 2021). Trained offline from historical resource vectors. **Deferred until Layer 1 proves value and ML engineering capacity is available. Listed as future research direction, not a committed phase.**

---

## Three-Layer Data Model

### Layer 1 — Always-On Collection (Phase 0-1)

Emitted inline by every **instrumented** code path on every trace. Coverage expands through phases: top 10 hot paths in Phase 0a, all executor/service/handler paths in Phase 1. Cheap, compact, comprehensive at full coverage.

- Fixed taxonomy coordinates (application plane)
- Resource vectors per system component (system plane)
- Config hash (single level in Phase 0a, hierarchical in Phase 1+)
- Version vector: `{code: "v2.3.1", ir_schema: 4, deploy_id: "d-9f3a"}`
- Timestamps aligned with coordinate sequence
- **Cost**: median <2KB per trace, inline emission, no external dependencies

**Flush strategy**: STR entries are accumulated in a per-trace buffer keyed by `traceId` (obtained from `getCurrentTraceId()` via the `@agent-platform/shared-observability` ALS context). The buffer is flushed to ClickHouse using the same batched async write pattern as the existing `trace-emitter.ts` EventStore emission (fire-and-forget via the existing ClickHouse client). At flush time, the STR is stamped with `tenant_id`, `project_id`, and `agent_id` from `getObservabilityContext()` — the same ALS context that the middleware populates. In Phase 0a, this reuses the existing write path infrastructure. In Phase 1, a dedicated ring buffer with the following safeguards:

- **Hard cap**: 10,000 entries maximum. When full, drop oldest entries. NEVER block the hot path.
- **Kill switch**: Environment variable `STI_ENABLED=false` makes all `tracePath()` wrappers into no-ops. Changeable via config map + pod restart, no deploy required.
- **Circuit breaker**: After N consecutive flush failures (default: 5), stop write attempts for M seconds (default: 30). Emit metric `sti.flush.circuit_open` so alerting catches it.
- **Latency budget**: The `tracePath()` wrapper itself (entry recording + timestamp capture) MUST complete in <10 microseconds. No allocations beyond the ring buffer slot. Benchmark before shipping.
- **ClickHouse Buffer table**: Use a `Buffer` engine table in front of `spatial_trace_records` so batch inserts do not compete with MergeTree merge operations.
- **Exception safety**: The `tracePath()` wrapper MUST NOT propagate its own exceptions to the wrapped function. STI failures are silently logged and metricked, never affecting request processing.

### Layer 2 — Learned Embeddings (Phase 2, deferred)

Computed in batch on **sampled** traces (1-5% + all anomalous) from Layer 1 data.

- Behavioral embeddings per taxonomy node
- Configuration embeddings (project config → vector space)
- Baseline trajectory distributions per config hash
- Cluster centroids for known execution patterns
- **Sampling strategy**: Embed 1-5% random sample + 100% of traces flagged anomalous by Layer 1 modes. Do NOT embed all traces.
- **Updated**: On deploy (debounced, max once per 6 hours), or on detected distribution shift
- **Cost**: Batch GPU/CPU job, periodic
- **Storage**: ClickHouse vector columns first; migrate to dedicated vector DB only if ClickHouse `cosineDistance` proves insufficient at scale
- **Prerequisite**: Ship only after Layer 1 proves value across 50+ deploys

### Layer 3 — Causal Model (future research direction)

Listed here for completeness. Not a committed phase — only pursued if concrete investigation cases prove Layers 1-2 insufficient AND dedicated ML engineering capacity is available.

- Causal Bayesian Network structure over system components
- Counterfactual simulation via Graphical VAE
- Root cause ranking with calibrated confidence scores
- Must include "known answer" test set and engineer feedback loop (mark root cause suggestions as correct/incorrect)
- No uncalibrated confidence scores in production

---

## Spatial Trace Record (STR) Schema

### Logical Schema

```
STR = {
  trace_id:           string,
  segment_id:         string,          // '0' for single-segment, opaque id for async (pod_id+counter)
  config_hash:        string,          // Phase 0a: single hash. Phase 1+: config_hash_full
  version_vector: {
    code:             string,          // git SHA or semver
    ir_schema:        number,          // compiled IR schema version
    deploy_id:        string,          // deployment identifier
  },
  application_plane: [                 // hierarchical coordinate sequence
    {
      depth:          number,
      taxonomy_path:  string,          // Phase 0a: "runtime/executor/flow/step-entry"
      taxonomy_coord: number[],        // Phase 1+: [0, 1, 2, 0] (integer encoding)
      decision_vector: number[],       // which branches taken at this node
      outcome:        number,          // success=0, fail=1, timeout=2, skip=3
      duration_us:    number,          // time spent in this node
    },
    ...
  ],
  system_plane: {
    components: Map<string, number[]>, // component_name -> [latency_us, throughput, error_bit, saturation_pct]
  },
  timing: number[],                    // microsecond timestamps aligned with application_plane entries
  duration_us: number,                 // total trace duration
  is_async_boundary: boolean,          // marks segments that crossed async boundaries
  is_truncated: boolean,               // true if app_paths was capped at 200 entries
}
```

### ClickHouse Physical Schema

```sql
-- Main storage table (must be created first — Buffer references it)
CREATE TABLE spatial_trace_records (
  trace_id            String,
  segment_id          String DEFAULT '0',   -- opaque: '0' for single-segment, pod_id+counter for async
  timestamp           DateTime64(6),
  -- Config hashes (Phase 0a: full + tenant; Phase 1+: all three)
  config_hash_full    String,
  config_hash_system  String DEFAULT '',    -- Phase 1+
  config_hash_tenant  String,               -- Required from Phase 0a for Mode 2
  -- Version vector
  code_version        String,
  ir_schema           UInt16,
  deploy_id           String,
  -- Application plane
  app_paths           Array(String),          -- Phase 0a: taxonomy path strings
  app_depths          Array(UInt8),
  app_coords          Array(Array(Int32)),     -- Phase 1+: integer coordinates
  app_decisions       Array(Array(Int16)),
  app_outcomes        Array(UInt8),
  app_durations       Array(UInt64),           -- per-node duration in microseconds
  -- System plane: Map-based for extensibility (no DDL for new components)
  sys_components      Map(String, Array(Float32)),
  -- Timing
  timings             Array(UInt64),
  duration_us         UInt64,
  is_async_boundary   Bool DEFAULT false,
  is_truncated        Bool DEFAULT false,
  -- Partitioning / indexing
  tenant_id           String,
  project_id          String,
  agent_id            String
  -- Secondary index for direct trace_id lookups (primary key is optimized for aggregate queries)
  INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tenant_id, project_id, timestamp, trace_id)
TTL timestamp + INTERVAL 90 DAY DELETE;

-- Buffer table for absorbing write bursts without competing with MergeTree merges
-- Created AFTER main table (references it)
CREATE TABLE spatial_trace_records_buffer AS spatial_trace_records
ENGINE = Buffer(currentDatabase(), spatial_trace_records, 16, 1, 5, 1000, 10000, 1048576, 10485760);
```

**Design notes:**

- `app_paths` (string array) is the primary coordinate column in Phase 0a. ClickHouse string interning makes GROUP BY on strings efficient at moderate volumes. Integer `app_coords` added in Phase 1 for compact storage at scale.
- `sys_components` uses `Map(String, Array(Float32))` — no DDL migration when adding new system components.
- `app_durations` per node enables the **waterfall view** (where did time go?) as a first-class capability.
- `config_hash_system` and `config_hash_tenant` default to empty string in Phase 0a; populated in Phase 1+.
- The `Buffer` engine table absorbs write bursts and flushes to the MergeTree table in configurable intervals, preventing write contention with merge operations.

**Capacity estimates (Phase 0, current scale):**

| Metric                                     | Estimate     |
| ------------------------------------------ | ------------ |
| Daily traces                               | 50K-500K     |
| STR size per trace                         | 2KB median   |
| Daily raw volume                           | 100MB-1GB    |
| ClickHouse compressed (ZSTD on int arrays) | 15-150MB/day |
| 90-day hot storage                         | 1.3-13.5GB   |
| Monthly incremental ClickHouse cost        | **$5-50**    |

**Scale thresholds:**

| Scale          | Concern                                  | Mitigation                                   |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| 2M traces/day  | Write throughput during background scans | Batch inserts + `max_insert_threads` tuning  |
| 5M traces/day  | Mode 8 scans exceed 30s                  | Materialized views for pre-aggregated stats  |
| 10M traces/day | 90-day storage exceeds 1.8TB compressed  | Reduce hot retention to 30 days + cold tier  |
| 20M traces/day | Single-node CPU saturation               | ClickHouse read replica for background scans |

---

## Configuration Snapshot System

Multiple factors influence which paths a trace takes. These are captured in a layered scheme.

### Phase 0a: Two Config Hashes (minimum for Mode 2)

Phase 0a requires **two** hashes from day one. A single hash including `code_version` would break Mode 2 regression detection — a deploy changes `code_version`, so before/after cohorts would never match on the same hash.

```
config_hash_full   = sha256(dsl_content_hash + tenant_config_hash + feature_flags_bitmap + code_version + ir_schema_version)
config_hash_tenant = sha256(dsl_content_hash + tenant_config_hash)
```

- `config_hash_full`: Exact cohort matching (same agent, same config, same code). Used for Mode 1 baseline comparison.
- `config_hash_tenant`: Cross-deploy comparison (same agent config, different code versions). **Used by Mode 2 regression detection** — partitions before/after windows by tenant config while allowing code_version to differ across the deploy boundary.

Two traces with the same `config_hash_tenant` ran under the same agent definition and tenant settings, making their behavioral differences attributable to code changes.

### Phase 1+: Hierarchical Config Hash

Three hash levels to enable orthogonal slicing:

```
config_hash_full   = sha256(dsl_hash + tenant_config_hash + flags_bitmap + code_version + ir_schema_version)
config_hash_system = sha256(code_version + ir_schema_version + flags_bitmap)
config_hash_tenant = sha256(dsl_hash + tenant_config_hash)
```

This enables:

- `config_hash_full`: Exact cohort comparison (same agent, same config, same code)
- `config_hash_system`: Cross-tenant comparison (different agents, same platform version). Includes `code_version` so bug-fix deploys with no schema change produce distinct hashes.
- `config_hash_tenant`: Cross-deploy comparison (same agent config, different code versions)

A single feature flag toggle only changes `config_hash_full` and `config_hash_system`, not `config_hash_tenant` — tenant-level regression detection remains valid across flag changes.

### Snapshot Storage

Full configuration snapshots (DSL content, tenant settings, feature flags) stored keyed by config_hash with deduplication. The STR carries only the hash; full config is resolved on-demand. Snapshots contain structural configuration only (DSL definitions, model selections, guardrail policies), NOT conversation content.

---

## Automatic Instrumentation System

### Design Principle

Developers MUST NOT manually manage coordinates, emit numerical events, or maintain registries. The system auto-discovers and auto-assigns.

### Higher-Order Function Wrapper (not decorators)

The codebase uses a functional pattern (`createTraceEmitter()`, `createSessionService()`, etc.) and does NOT have `experimentalDecorators` enabled in any `tsconfig.json`. TypeScript decorators are not viable without a significant refactor.

Instead, STI uses a **higher-order function wrapper** that works with both class methods and factory functions:

```typescript
import { tracePath } from '@abl/sti';

// Wrapping a class method
class FlowStepExecutor {
  executeStep = tracePath('runtime/executor/flow/step-entry', async (step: IRStep) => {
    // ... existing implementation
  });
}

// Wrapping a factory function's returned methods
function createGuardrailPipeline(config: GuardrailConfig) {
  return {
    evaluatePreInput: tracePath('runtime/guardrail/evaluate/pre-input', async (input: string) => {
      // ... existing implementation
    }),
    evaluatePostOutput: tracePath(
      'runtime/guardrail/evaluate/post-output',
      async (output: string) => {
        // ... existing implementation
      },
    ),
  };
}

// Wrapping a standalone async function
const handleVoiceSessionStart = tracePath(
  'runtime/channel/voice/session-start',
  async (config: VoiceConfig) => {
    // ... existing implementation
  },
);
```

**Implementation of `tracePath()`:**

```typescript
import { getCurrentTraceId, getObservabilityContext } from '@abl/compiler/platform';

function tracePath<T extends (...args: any[]) => Promise<any>>(path: string, fn: T): T {
  if (!STI_ENABLED) return fn; // kill switch: env var check at module load

  const traced = async function (this: any, ...args: any[]) {
    // Read traceId from the existing ObservabilityContext ALS
    // (populated by createObservabilityMiddleware on HTTP, or runWithObservabilityContext on WS/BullMQ)
    const traceId = getCurrentTraceId();
    if (!traceId) return fn.apply(this, args); // no trace context — skip STI recording silently

    const entry = strBuffer.recordEntry(traceId, path); // <10μs: timestamp + path ref + traceId key
    try {
      const result = await fn.apply(this, args);
      entry.recordSuccess(process.hrtime.bigint()); // outcome + exit timestamp
      return result;
    } catch (err) {
      entry.recordFailure(process.hrtime.bigint());
      throw err; // always re-throw — STI never swallows application errors
    }
    // NOTE: no try/catch around STI's own operations (recordEntry/recordSuccess/recordFailure)
    // Those functions internally catch their own errors and emit metrics, never throwing
  } as unknown as T;

  // Preserve function name and length for debugging
  Object.defineProperty(traced, 'name', { value: `traced(${fn.name || path})` });
  return traced;
}
```

**Key change from earlier drafts:** `tracePath()` does NOT manage its own trace context. It reads `traceId` from the existing `@agent-platform/shared-observability` / `@abl/compiler/platform` ALS that is already populated by middleware (HTTP), per-turn context (WebSocket), or job payload restoration (BullMQ). This eliminates a parallel context management system and ensures STR entries are always correlated with the same `trace_id` used by `platform_events`.

If `getCurrentTraceId()` returns `undefined` (code running outside a traced context — e.g., startup, background timers), the wrapper silently passes through to the original function with zero overhead. This is a safe degradation, not an error.

**Key properties:**

- Works with class methods, factory functions, and standalone functions — no `experimentalDecorators` needed
- No tsconfig changes required
- `STI_ENABLED` check at module load — disabled wrapper is zero-overhead (returns original function)
- STI's own operations (`recordEntry`, `recordSuccess`, `recordFailure`) internally catch all exceptions and emit metrics — they NEVER throw
- The wrapped function's exceptions are always re-thrown — STI never affects application control flow
- `this` binding preserved via `fn.apply(this, args)`

### Taxonomy Naming Convention

Path strings follow a strict convention to prevent inconsistency:

```
<subsystem>/<component>/<action>/<detail>

Examples:
  runtime/executor/flow/step-entry
  runtime/executor/flow/step-exit
  runtime/guardrail/evaluate/pre-input
  runtime/guardrail/evaluate/post-output
  runtime/channel/voice/session-start
  runtime/tool/execute/custom-http
  runtime/llm/call/completion
  runtime/handoff/execute/transfer
  searchai/pipeline/query/retrieve
  searchai/pipeline/query/rerank
```

**Controlled vocabulary** (enforced via `packages/sti/taxonomy.json`):

```json
{
  "subsystems": ["runtime", "searchai", "compiler", "pipeline-engine"],
  "components": [
    "executor",
    "guardrail",
    "channel",
    "tool",
    "llm",
    "handoff",
    "pipeline",
    "session",
    "state-machine"
  ],
  "actions": [
    "execute",
    "evaluate",
    "call",
    "query",
    "transition",
    "start",
    "stop",
    "dispatch",
    "resolve"
  ]
}
```

Adding a new term requires modifying `taxonomy.json` — creating review friction and preventing vocabulary sprawl. The lint rule validates both path format AND vocabulary membership.

**PII prevention**: Path strings MUST NOT contain dynamic or user-derived values. The lint rule rejects paths containing:

- Variable interpolation (`${...}`, template literals)
- UUID patterns, numeric IDs, or email-like strings
- Any token not in the controlled vocabulary

This enforces the "PII-free by construction" claim at the instrumentation boundary. The `tracePath()` wrapper itself accepts only a string literal — no runtime-computed paths.

**Config snapshot allowlisting**: The snapshot storage (keyed by config_hash) stores only structural configuration fields: DSL definitions, model IDs, guardrail policy names/thresholds, feature flag states, execution mode settings. An explicit allowlist prevents secrets, API keys, or tenant-identifying strings from entering the snapshot store. Fields not on the allowlist are hashed before storage.

### Phase 0a: Coverage via CI Grep

In Phase 0a (proving the concept), no build-time AST scanner. Instead:

1. The platform team manually instruments the top 10 hot paths with `tracePath()`.
2. A CI script (`grep -r "tracePath(" apps/ packages/ --include="*.ts" | wc -l`) tracks coverage count.
3. A manifest is generated as a build artifact by extracting all `tracePath()` path strings — for documentation, not as a runtime dependency.
4. Path strings are used directly in ClickHouse queries (no integer coordinate mapping yet).

### Phase 1: Build-Time Scanner + Integer Coordinates

After Phase 0 proves value (coordinate stability across 10+ deploys):

1. **AST scanner**: A TypeScript AST visitor collects all `tracePath()` calls, extracts path strings, and assigns sequential integer coordinates per hierarchy level.
2. **Coordinate manifest**: `{ "runtime/executor/flow/step-entry": [0, 1, 2, 0], ... }` — versioned build artifact.
3. **Manifest integrity**: sha256 checksum of the manifest file stored alongside it in S3. Runtime validates checksum on startup. (Full cryptographic chaining deferred to Phase 1 hardening.)
4. **Coverage lint rule**: Warning-only for first 4 weeks. Error only for Tier 1 paths (executors, channel handlers) after taxonomy stabilization.
5. **Taxonomy diff on PRs**: CI comment showing "This PR adds N new trace paths, removes M, renames K" — reviewers catch junk annotations.

### Phase 1 Hardening: Manifest Integrity Chain

After 50+ deploys validate coordinate stability:

1. **Cryptographic parent chain**: Each manifest includes `parent_manifest_hash` linking to the previous version.
2. **Genesis manifest**: First-ever manifest uses sentinel `parent_manifest_hash: "genesis"`.
3. **CAS writes**: Manifest upload to S3 uses conditional write — "write only if current head matches expected hash" — preventing fork from concurrent builds.
4. **Recovery**: Scanner loads last-known-good manifest and append-only from there, never reassigns existing coordinates.
5. **Runtime validation on startup**: Validate manifest checksum + parent chain. On mismatch: **disable STI emission** (equivalent to kill switch) and emit `sti.manifest.checksum_valid = false` alert. The pod starts normally and serves traffic — STI integrity issues MUST NOT become availability incidents. Engineers investigate and redeploy with a corrected manifest.

### Coordinate Stability

- Same path string → same coordinate across deploys
- New paths → appended (next sequential integer at their depth level)
- Removed paths → tombstoned, coordinate never reassigned
- Renamed paths → treated as remove + add (old tombstoned, new assigned)
- The manifest is diffable across versions for migration analysis
- **Exit criteria for Phase 0 → Phase 1**: Fewer than 5% of path strings change per deploy after a 10-deploy burn-in period

### Compiler-Side Coordinates

For DSL constructs (agents, workflows, tools, guardrails), the ABL compiler emits a **coordinate manifest** during IR compilation:

- Each IR node gets a deterministic coordinate based on its position
- Agent "OrderBot" in project X = `[project=3, agent=7]`
- Workflow step 4 in agent 7 = `[project=3, agent=7, step=4]`
- This falls out of compilation for free

### Async Boundaries

For traces that span BullMQ job queues or handoffs across pods:

1. The STR buffer is flushed at each async boundary (job enqueue, HTTP handoff).
2. The downstream consumer starts a new STR segment linked by `trace_id`. The Trace Readiness plan (Tasks 8-10) ensures `traceId` is threaded through BullMQ job payloads and restored via `runWithObservabilityContext` at worker entry points — so `getCurrentTraceId()` returns the correct trace ID in the downstream worker, and `tracePath()` wrappers automatically associate entries with the parent trace.
3. For cross-service HTTP calls (e.g., Runtime -> SearchAI), the `createObservabilityMiddleware` from `@agent-platform/shared-observability` already parses the W3C `traceparent` header on the receiving side (Trace Readiness Task 13 ensures the header is injected on the sending side). STI piggybacks on this — no additional header propagation needed.
4. The `segment_id` is generated as a **unique opaque identifier** (`pod_id + monotonic_counter` or short UUID), NOT a sequential integer — because parallel fan-out (e.g., 3 BullMQ workers processing sub-tasks) would cause sequential IDs to collide without a global allocator.
5. Segments are reassembled at query time **by `(trace_id, timestamp)` ordering**, not by `segment_id` ordering. `segment_id` is used only for deduplication, not sequencing. Timing gaps between segments are marked as `is_async_boundary = true`.
6. Each segment carries its own `version_vector` — handles rolling deploys where different pods run different code versions.
7. Segment reassembly logic is shipped behind a feature flag and validated against known traces before trusting for investigations.

### Rolling Deploy Handling

During rolling deploys, different pods may run different code versions. Each STR segment carries its own `version_vector`. Cross-version traces have multiple segments with different manifests, resolved independently at query time using the path string as the stable cross-version key.

---

## Investigation Modes

### Phase 0a Modes (Layer 1, string-based coordinates)

#### Mode 0: Trace Waterfall

**Trigger**: Platform engineer provides a trace ID.

**Process**:

1. Load all STR segments for this trace_id from ClickHouse
2. Reassemble segments by segment_id, marking async boundaries
3. Display a waterfall breakdown: each `app_paths` entry with its `app_durations` value, showing where time was spent
4. Highlight system plane resource vectors alongside each node

This is the most basic "where did the 4 seconds go?" view and is table stakes for Phase 0a. It requires no baseline comparison, no statistical analysis — just structured display of the STR data.

**Data**: Layer 1

#### Mode 1: Root Cause Analysis

**Trigger**: Platform engineer or support provides a trace ID.

**Process**:

1. Load STR from ClickHouse
2. Walk the application plane hierarchy — at each depth, highlight path entries that deviate from the baseline distribution for this config_hash
3. Walk the system plane — flag resource vectors that exceed baseline thresholds
4. Present: "At depth 2 (workflow step 4: 'validate-input'), the guardrail at depth 3 returned outcome=1 (fail). System plane shows MongoDB latency at p99 (saturation=87%). This pattern correlates with 47 other traces in the last hour."
5. **Link to agent developer traces**: One-click deep link to the corresponding trace in the Observatory (same trace_id, opens in new tab) for content-level drill-down.

**Bootstrap note**: Mode 1 baseline comparison requires historical data. During the first N days (configurable, default 7), Mode 1 operates without baseline — it shows the raw STR waterfall (Mode 0) plus system plane resource vectors, without deviation highlighting. After N days, baseline distributions are computed from historical STRs with the same config_hash.

**Data**: Layer 1

**Entry points beyond trace_id**: Support tickets often arrive with a session ID or timestamp range rather than a trace_id. The existing `platform_events` table (which has `session_id`) serves as the resolution layer: query `platform_events` by session to get trace_ids, then query `spatial_trace_records`. The System View UI includes a session-to-trace lookup field.

### Phase 0b Modes

#### Mode 2: Regression Detection

**Trigger**: Deploy hook or on-demand comparison.

**Process**:

1. Partition traces by `config_hash_tenant` into before/after time windows around the deploy. This groups traces by tenant configuration (same agent DSL, same tenant settings) while allowing `code_version` to differ — which is the point of regression detection.
2. Compute distribution statistics per path entry at each depth (mean duration, variance, outcome distribution)
3. Statistical test (KL divergence, KS test) between windows at each path
4. Rank paths by divergence magnitude
5. Present: "After deploy d-9f3a, path [runtime/executor/flow/step-entry] shifted from 95% success to 72% success across 12 tenants. Decision vector distribution shifted: branch 0 (happy path) dropped from 89% to 61%."

**Data**: Layer 1 (cohort comparison using `config_hash_tenant`)

#### Mode 5: Blast Radius Scoping

**Trigger**: On-demand, typically triggered by a Mode 1 or Mode 3 finding.

**Process**:

1. Take the anomalous path+outcome pattern from Mode 1 or Mode 3
2. Query ClickHouse for all recent traces matching the same pattern. Uses `arrayExists` with zipped arrays to handle repeated path occurrences (retries, loops): `WHERE arrayExists((p, o) -> p = 'runtime/guardrail/evaluate/pre-input' AND o = 1, app_paths, app_outcomes)`. Note: `indexOf` would only check the first occurrence; `arrayExists` checks all.
3. Group matches by tenant_id, project_id, agent_id
4. Present: "This failure pattern affects 3 tenants, 7 projects, ~2,400 traces in the last hour."

**Data**: Layer 1 (ClickHouse filtering — no vector DB needed)

#### Mode 7: Capacity / Saturation Detection

**Trigger**: Continuous background scan (Phase 0b: on-demand query; Phase 1: scheduled).

**Process**:

1. Aggregate system plane resource vectors across traces over sliding windows
2. Detect saturation trends: components approaching capacity limits
3. Correlate with application plane outcomes: "when `sys_components['mongodb'][3]` (saturation) > 80%, tool call timeout rate increases 3x"
4. Alert before hard failures occur

**Data**: Layer 1 (system plane aggregation)

### Phase 1 Modes (Background Scans)

Background scans run as scheduled ClickHouse queries (cron jobs or BullMQ repeatable jobs). Each scan has:

- **Concurrency limit**: Max 1 concurrent scan query at a time
- **Query timeout**: 30 seconds (prevents pathological queries from starving inserts)
- **Burn-in period**: First 4 weeks, alerts route to low-priority channel for tuning

#### Mode 3: Cross-Dimensional Anomaly Detection

**Trigger**: Scheduled every 5-15 minutes.

**Process**:

1. For each sliceable dimension (component, subsystem, config, agent, tenant), compute rolling distribution statistics
2. Detect dimensions where current distribution diverges from historical baseline
3. Rank by divergence magnitude and blast radius (number of affected traces/tenants)
4. Alert when divergence exceeds threshold

**Data**: Layer 1 (aggregated)

#### Mode 8: Cross-Tenant Pattern Correlation

**Trigger**: On-demand query (not continuous background scan in Phase 1 — promoted to scheduled in Phase 1 hardening if signal-to-noise is proven).

**Process**:

1. Strip tenant/project/agent identity from traces
2. Cluster by system plane + lower-depth application plane paths
3. Detect clusters spanning multiple tenants
4. Present: "Tenants A and C are experiencing the same failure pattern at the infrastructure level — both hitting Redis connection pool exhaustion during BullMQ job processing — despite completely different agent configurations."

**Data**: Layer 1 (anonymized system plane). Note: tenant_id is stored in plaintext for operational queries; Mode 8 anonymization is a query-time operation. For stricter anonymization, consider opaque tenant tokens resolvable only by an access-controlled service (future hardening).

### Phase 2 Modes (Layer 2 required, deferred)

#### Mode 4: Trend Discovery

**Process**: Re-cluster sampled trace embeddings, detect new/migrating/growing clusters. Surface emerging execution patterns.

**Data**: Layer 2 (sampled embeddings)

#### Mode 9: Silent Degradation

**Process**: Measure trajectory drift against baseline per config_hash cohort. Alert when drift exceeds threshold despite all outcomes remaining successful.

**Approximation in Phase 1**: Per-coordinate latency percentile trending (p50, p95, p99) from Layer 1 data catches most silent degradation without embeddings. Full trajectory-shape drift detection requires Layer 2.

**Data**: Layer 1 (approximation) + Layer 2 (full)

### Future Research: Mode 6 (Counterfactual Reasoning)

Not a committed phase. Listed as a research direction for completeness.

**Process**: Given a trace's STR and an alternate version/config, simulate what the trajectory would have been. Requires causal model (Layer 3) with calibrated confidence and engineer feedback loop.

---

## Proactive Modes: Prevention Over Detection

The reactive modes (1-9) answer "what happened?" after the fact. STI's numerical model uniquely enables **proactive modes** that prevent issues before they reach production or catch them within seconds of deployment — capabilities that no existing observability tool provides.

### The Gap in Existing Tools

Today's deployment safety ecosystem is entirely metric-based:

| Tool                                    | What It Compares                                         | Blind Spot                                                                                                    |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Flagger / Argo Rollouts                 | Error rate, latency p99 between canary and stable        | A code change that shifts 30% of traces from path A to path B is invisible if both paths have similar latency |
| Netflix Kayenta                         | Mann-Whitney U tests on time-series metrics              | Structural changes in execution topology that don't affect aggregate metrics                                  |
| Tracetest                               | Individual span assertions (manually defined)            | Cannot automatically detect "this trace looks structurally different from baseline"                           |
| Gremlin / Steadybit                     | System resilience under injected faults                  | Tests what happens, cannot predict what will happen                                                           |
| Config drift tools (Komodor, Terraform) | Declarative state (what config says vs. what's deployed) | Cannot detect whether a config change caused different execution paths                                        |

**No existing system compares trace topology distributions as a deployment gate.** STI's compact numerical coordinates make this feasible — you can compute statistical distance between coordinate distributions in milliseconds, something impossible with text traces.

### Proactive Mode 10: Pre-Release Regression Gate (CI/CD Integration)

**When**: During CI, before merge to main.

**How it works**:

1. Integration/e2e tests run against the PR branch in CI (already happening today).
2. STI instrumentation is active in the test environment — each test run generates STRs written to a test-scoped ClickHouse table (or in-memory buffer for CI).
3. The CI pipeline collects the STR coordinate distributions from the test run.
4. Compares against the **baseline STR distribution** from the same test suite on main branch (stored as a compact summary: per-path outcome distribution + mean/p95 duration).
5. Computes a **trajectory divergence score**: the aggregate KL divergence across all taxonomy paths.
6. If divergence exceeds threshold → CI warning (soft gate) or failure (hard gate).

**What it catches that existing tests miss**:

- A refactor that changes execution order (tests still pass, but traces take a different path through the system)
- A new code path that adds an extra downstream call (latency might be similar, but the trace shape is different — could indicate an unintended dependency)
- A guardrail configuration change that shifts the block/pass ratio in ways the test assertions don't check
- Silent behavioral changes where all assertions pass but the system is doing more/less work per request

**Example output**:

```
STI Regression Gate: WARN
  Trajectory divergence: 0.23 (threshold: 0.15)
  Top divergent paths:
    runtime/guardrail/evaluate/pre-input: outcome distribution shifted
      baseline: {pass: 92%, block: 8%}  →  PR: {pass: 74%, block: 26%}
    runtime/llm/call/completion: duration distribution shifted
      baseline: p50=180ms, p95=400ms  →  PR: p50=310ms, p95=720ms
    runtime/tool/execute/custom-http: NEW PATH (not in baseline)
      appears in 34% of test traces
```

**Implementation (Phase 1+)**:

- Lightweight: STI is already active in the runtime. Just need a CI step that queries the test ClickHouse (or reads from a file-based STR collector in CI) and compares against stored baselines.
- Baseline snapshots stored alongside the coordinate manifest as build artifacts.
- Initial rollout as warning-only (soft gate). Promote to hard gate after tuning divergence thresholds over 20+ PRs.

**Prior art**: Tracetest (Kubeshop) makes structural assertions on individual spans in CI. Mode 10 goes further: automatic **distribution-level** comparison across all traces in the test suite, without manually defining per-span assertions.

### Proactive Mode 11: Post-Deploy Canary with Trajectory Comparison

**When**: Immediately after deployment, during canary rollout (first 5-15 minutes).

**How it works**:

1. During canary rollout, both old and new pods serve traffic.
2. Both emit STRs. STRs from new pods carry the new `deploy_id`; STRs from old pods carry the previous `deploy_id`.
3. A canary analysis job (triggered by deploy hook) continuously compares coordinate distributions between old and new cohorts — same statistical tests as Mode 2 (KL divergence, KS test), but **in real-time with a sliding window**.
4. If trajectory divergence exceeds threshold within the canary window → trigger automatic rollback or alert.

**What it catches beyond metric-based canary**:

- A code change that introduces an additional database call on 20% of requests (average latency barely changes because the call is fast, but the trace topology shifted — new coordinate appears in the system plane)
- A change that eliminates a guardrail evaluation (error rate unchanged, latency improves slightly, but a safety check is missing — invisible to metrics, visible in coordinate distribution as a dropped path)
- An unintended path shift where requests that used to go through path A now go through path B (both paths work, but B has different failure modes under load)

**Example output**:

```
STI Canary Analysis (deploy d-9f3a, 8 minutes in):
  Trajectory compatibility: 87% (threshold: 90%)
  ALERT: Structural divergence detected
  New path appeared:  runtime/tool/execute/custom-http (12% of canary traces, 0% baseline)
  Path disappeared:   runtime/guardrail/evaluate/post-output (0% canary, 100% baseline)
  ⚠ A guardrail evaluation is missing in the new code path.
  Recommendation: HALT canary. Investigate missing guardrail.
```

**Implementation (Phase 1+)**:

- Requires the hierarchical config hash (`config_hash_system`) to partition canary vs. stable while comparing across tenants.
- The canary analysis job is a scheduled ClickHouse query (every 60 seconds during canary window) comparing `WHERE deploy_id = 'new' vs. deploy_id = 'old'`.
- Integrates with existing deployment tooling (Argo Rollouts, Flagger) as a custom metric provider or webhook.

**Prior art**: Netflix Kayenta does Mann-Whitney U tests on time-series metrics. Uber CRISP extracts critical paths from traces for analysis. Mode 11 combines both: statistical tests on trace coordinate distributions, used as a real-time deployment gate.

### Proactive Mode 12: Configuration Impact Preview

**When**: Before a tenant/project configuration change takes effect.

**How it works**:

1. Agent developer is about to change their agent's DSL (add a guardrail, change a model, modify a workflow step) or a platform operator is about to change tenant-level settings (guardrail policy thresholds, model selection, rate limits).
2. Before applying the change, STI computes the new `config_hash` and searches for existing tenants/projects with similar configuration profiles.
3. Compares the STR distributions of the **similar-config cohort** against the current tenant's STR distribution.
4. Predicts the likely trajectory shift: which paths will be activated/deactivated, how outcome distributions will change, what the performance impact will be.

**What it catches**:

- "Tightening PII detection threshold from 0.7 to 0.5 will increase guardrail block rate from 8% to ~35% based on similar tenants" — before the change goes live
- "Adding this new tool to the workflow will introduce a new external API call on ~60% of traces, adding ~200ms p50 latency based on similar configurations"
- "Switching from model A to model B will shift LLM latency distribution: p50 improves by 40ms but p99 degrades by 300ms"

**Example output**:

```
STI Configuration Impact Preview:
  Proposed change: guardrail/pii-detection threshold 0.7 → 0.5
  Similar configurations found: 4 tenants with threshold ≤0.5

  Predicted impact:
    runtime/guardrail/evaluate/pre-input:
      block rate: 8% → ~32% (±5%, based on 4 similar configs)
      reask rate: 3% → ~12% (±3%)
    Overall trace duration:
      p50: +45ms (guardrail re-evaluation on reask)
      p95: +180ms

  ⚠ High impact change. 32% of user inputs will be blocked or re-asked.
```

**Implementation (Phase 1+)**:

- Config similarity uses the hierarchical config hash: find tenants with the same `config_hash_tenant` minus the changing dimension.
- Prediction is statistical (distributions from similar configs), not ML-based — works with Layer 1 data alone.
- Exposed as an API endpoint called by Studio's agent editor before applying configuration changes.
- Also valuable for the **support team**: "tenant X changed their config 2 hours ago, and now their agents are slow" → compare STR distributions before/after the config change.

**Prior art**: No existing tool provides behavioral impact preview for configuration changes. Config drift tools (Komodor, Terraform) detect state divergence but cannot predict behavioral impact.

### Proactive Mode 13: Deployment Confidence Score

**When**: Continuous, computed per deploy.

**How it works**:

1. After each deploy completes canary and reaches full rollout, STI computes a **deployment confidence score**: a single number (0-100) summarizing how structurally compatible the new version is with the baseline.
2. Score components:
   - **Path stability** (0-40): Percentage of taxonomy paths with unchanged outcome distributions
   - **Latency compatibility** (0-30): KS test p-values on duration distributions per path
   - **System plane health** (0-20): Resource vector deviation from baseline
   - **Coverage completeness** (0-10): Percentage of known paths that appeared in post-deploy traces (catches missing paths)
3. Score is tracked as a time series. Trending downward across deploys = system is accumulating structural debt.

**What it enables**:

- **Deploy-over-deploy trend**: "Deployment confidence has dropped from 95 → 88 → 76 over the last 3 deploys. Something is accumulating."
- **Automatic rollback threshold**: If confidence score drops below X within Y minutes of deploy → trigger rollback.
- **Release quality dashboard**: Platform leadership sees deployment health at a glance without understanding individual modes.

**Implementation (Phase 0b+)**:

- Simple: computed from the same ClickHouse queries that power Mode 2 (regression detection).
- The score is a weighted aggregate of statistical tests already being computed.
- Stored as a row in a `deployment_confidence` ClickHouse table for trending.
- Visualized in the System View UI as a sparkline per deploy.

### Proactive Mode 14: Capacity Forecasting for Tenant Onboarding

**When**: Before onboarding a new large tenant, or when a tenant significantly scales up.

**How it works**:

1. New tenant provides their agent configuration (DSL, expected traffic volume, workflow complexity).
2. STI computes the config_hash and finds existing tenants with similar configurations.
3. Uses the system plane resource vectors from similar tenants to project: MongoDB load, Redis memory, BullMQ queue depth, external API call volume, LLM token consumption.
4. Multiplied by the expected traffic volume → capacity forecast.

**What it catches**:

- "This tenant's configuration is similar to Tenant X, which consumes 3x more MongoDB IOPS than average due to their 5-step workflow with 3 tool calls per step. At their projected 100K traces/day, expect an additional 15% MongoDB load."
- "No existing tenant has a configuration this complex. The 8-agent delegate chain with cross-agent handoffs is unprecedented. Manual capacity review recommended."

**Implementation (Phase 1+)**:

- Config similarity via hierarchical config hash.
- Resource projection: linear extrapolation from similar tenants' system plane vectors, scaled by projected traffic.
- Exposed as an API endpoint and in the admin dashboard.

### Proactive Mode 15: Simulated Traffic Validation (Staging)

**When**: Before promoting a release from staging to production.

**How it works**:

1. STI captures **trajectory templates** from production: the set of unique coordinate paths (not content) that represent real-world usage patterns. These are just sequences of taxonomy paths — no customer data.
2. In staging, a traffic generator replays these trajectory templates by invoking the system with synthetic inputs designed to trigger the same code paths.
3. STRs generated in staging are compared against production STR distributions for the same config_hash.
4. Divergence indicates that the staging build would behave differently than production on real traffic patterns.

**What it catches**:

- Code changes that affect execution paths only under specific usage patterns (e.g., multi-agent handoff chains that only occur with certain agent configurations)
- Performance regressions that only manifest under production-like path distributions (not caught by synthetic test suites that don't cover all real-world patterns)
- Infrastructure differences between staging and production that cause different system plane behavior

**Key property: PII-free by construction.** Trajectory templates are coordinate sequences, not customer data. You can replay production usage patterns in staging without any privacy concern.

**Implementation (Phase 2+)**:

- Requires enough Layer 1 data to extract meaningful trajectory templates.
- Traffic generator maps coordinate paths to synthetic inputs that trigger those paths.
- The mapping between coordinates and synthetic inputs is the hard part — requires knowledge of which inputs trigger which paths. This can be approximated by using the test suite as the traffic source and comparing its STR distribution against production.

### Proactive Mode 16: IR Path Coverage Simulation

**When**: In CI, alongside Mode 10, or on-demand before major releases.

**How it works**:

1. The compiler already produces an IR graph of the agent's execution topology — all possible branches, handoffs, tool invocations, and state transitions.
2. STI extracts the set of **reachable coordinate paths** from the IR graph. This is the theoretical coverage set: every path the agent _could_ take.
3. Compare this against the **observed coverage set** from production STRs (the paths the agent _actually_ takes in practice).
4. Generate synthetic test inputs designed to force-hit **uncovered or rarely-covered branches** — particularly error paths, edge-case handoffs, and fallback flows.

**What it catches**:

- Untested rare branches that work in theory but fail in production (e.g., a 4-agent handoff chain that only triggers when the first three agents all escalate)
- Dead code paths that exist in IR but are never reached — candidates for removal
- Regression risk concentration: paths with high change frequency but low test coverage

**Key property**: IR graph is a compile-time artifact. Combined with STI's coordinate taxonomy, it provides a formal coverage metric — not "line coverage" but "execution path coverage" measured against actual production usage.

**Implementation (Phase 1+)**:

- Depends on compiler IR producing a traversable graph of execution paths.
- Path extraction maps IR nodes to STI taxonomy paths.
- Coverage gap report surfaced in CI and Studio's agent editor.
- Synthetic input generation is approximate — uses heuristics to select inputs likely to trigger target paths.

### Proactive Mode 17: Config Mutation Testing

**When**: In staging, before promoting config changes to production. Can also run on a schedule for regression hunting.

**How it works**:

1. Start from the current production config (identified by `config_hash_tenant`).
2. Systematically mutate configuration dimensions: toggle feature flags, swap model providers, change guardrail thresholds, modify execution modes, adjust tool timeouts.
3. For each mutation, run the standard test suite (or replay production trajectory templates from Mode 15) and capture STRs.
4. Compare each mutation's STR distribution against the baseline. Flag mutations that cause **unstable path/outcome shifts** — paths that change outcome (success→failure or vice versa) or new paths that appear/disappear.

**What it catches**:

- Feature flags that silently change execution topology (e.g., enabling a flag routes traffic through an untested code path)
- Configuration combinations that individually work but interact badly (e.g., guardrail threshold A + model provider B causes timeouts)
- "Cliff edges" where small config changes cause disproportionate behavioral shifts

**Key property**: Unlike traditional config testing that checks "does it start?", config mutation testing checks "does it behave the same?" — using STR distributions as the behavioral fingerprint.

**Implementation (Phase 2+)**:

- Config mutation generator derives mutations from the config schema (feature flags, model settings, guardrail policies).
- Requires Mode 15's trajectory replay infrastructure for production-representative traffic.
- Results surfaced as a mutation stability report: each config dimension scored by behavioral stability.

### Proactive Mode 18: Performance Budget Gate

**When**: In CI/CD pipeline, before merge or deploy.

**How it works**:

1. Define per-coordinate **latency budgets**: maximum acceptable p50/p95/p99 `app_durations` for critical paths (e.g., `runtime/executor/agent/dispatch` must stay under 200ms p95).
2. During CI test runs, STRs capture `app_durations` for every instrumented path.
3. Compare observed durations against budgets. If any critical path exceeds its budget, the gate fails (soft or hard, configurable).
4. In production, Mode 2's regression detection also compares against budgets — flagging not just "slower than before" but "slower than acceptable."

**What it catches**:

- Performance regressions caught before they reach production — not as aggregate latency increase, but as specific coordinate-level budget violations
- Gradual performance erosion across releases (each PR adds 5ms, undetectable individually, but budget violation accumulates)
- Performance impact of dependency upgrades isolated to specific code paths

**Key property**: Budgets are defined per-coordinate, not per-endpoint. A slow guardrail evaluation is caught even if the overall request latency is within bounds, because the specific coordinate (`runtime/guardrail/evaluate/pre-input`) has its own budget.

**Implementation (Phase 1)**:

- Budget definitions stored in `packages/sti/budgets.json` alongside `taxonomy.json`.
- CI gate reads budgets and compares against test-run STRs.
- Soft gate initially (warning comment on PR); hard gate after budget calibration period (~4 weeks of production data to set realistic thresholds).
- Production budget monitoring piggybacks on Mode 2/Mode 7 queries.

### Proactive Mode 19: Synthetic Warmup + Cold-Start Probe

**When**: Immediately after deployment, during the pod warmup window (first 30-120 seconds).

**How it works**:

1. After a new deploy lands, a warmup probe sends controlled synthetic requests through critical paths — agent dispatch, tool calls, guardrail evaluation, LLM routing.
2. STRs from warmup requests are captured with a `is_warmup: true` flag (or separate segment).
3. Compare warmup STR durations and outcomes against steady-state baselines. Flag paths where cold-start penalty exceeds threshold.
4. If critical paths show degraded outcomes (not just latency — actual failures), trigger alert before real user traffic hits the pod.

**What it catches**:

- Cold-start failures: connection pool not ready, cache empty, model not loaded, config not fetched
- Infrastructure mismatches: new pod connects to different DB replica, Redis shard, or queue partition than expected
- Deploy-specific issues: environment variable missing, secret rotation incomplete, dependency version mismatch

**Key property**: Warmup probes use STI coordinates to verify that the system _behaviorally_ matches expectations, not just that a health check endpoint returns 200. A pod can be "healthy" per liveness probe but behaviorally degraded on specific code paths.

**Implementation (Phase 1+)**:

- Warmup probe service sends predefined synthetic requests post-deploy.
- STR capture during warmup uses existing `tracePath()` instrumentation — no additional code.
- Cold-start threshold defined per-coordinate (some paths are expected to be slower on first invocation).
- Integrates with canary rollout (Mode 11): warmup results can gate traffic shift.

### Proactive Mode 20: Config Drift Sentinel

**When**: Continuously in production, on a scheduled scan (every 5-15 minutes).

**How it works**:

1. At deploy time, the expected `config_hash_full` and `config_hash_tenant` are recorded in the deploy manifest.
2. The sentinel periodically queries recent STRs and compares their config hashes against the deploy manifest's expected values.
3. Drift is detected when STRs contain config hashes not present in the manifest — meaning the live system's configuration has diverged from what was deployed.
4. Alert includes: which hash diverged (full vs tenant), which pods are affected, when drift started, and the magnitude (% of STRs with unexpected hashes).

**What it catches**:

- Runtime config changes that bypass the deploy pipeline (e.g., direct database edits, admin API calls that modify feature flags without a deploy)
- Partial deploy failures where some pods received new config but others didn't
- External system changes that affect config inputs (e.g., a shared config service updated a value that feeds into the config hash)
- Config rollback that was applied to some pods but not all

**Key property**: Unlike Terraform/Komodor drift detection which compares declared state vs actual state, config drift sentinel detects **behavioral drift** — the system is executing with a configuration that wasn't part of any known deployment. This catches changes that don't touch declarative config files.

**Implementation (Phase 1)**:

- Deploy hook writes expected config hashes to a manifest table or Redis key.
- Sentinel is a scheduled ClickHouse query: `SELECT DISTINCT config_hash_full FROM spatial_trace_records WHERE timestamp > now() - INTERVAL 15 MINUTE AND config_hash_full NOT IN (SELECT hash FROM deploy_manifest WHERE active = true)`.
- Low overhead: one query every 5-15 minutes against recent data (covered by Buffer table, in memory).
- Alert severity tiered: `config_hash_tenant` drift is P1 (different agent config), `config_hash_full` drift with matching tenant hash is P2 (code/flag change only).

### Proactive Modes Summary

| Mode                                 | When                             | Layer Required | Phase    | Novelty                                                                             |
| ------------------------------------ | -------------------------------- | -------------- | -------- | ----------------------------------------------------------------------------------- |
| **10: Pre-Release Regression Gate**  | CI, before merge                 | Layer 1        | Phase 1  | **Novel** — no tool does automatic trace-distribution comparison in CI              |
| **11: Post-Deploy Canary**           | Canary rollout, first 5-15 min   | Layer 1        | Phase 1  | **Novel** — extends metric-based canary with topology comparison                    |
| **12: Config Impact Preview**        | Before config change             | Layer 1        | Phase 1  | **Novel** — no tool predicts behavioral impact of config changes                    |
| **13: Deployment Confidence Score**  | Post-deploy, continuous          | Layer 1        | Phase 0b | Adaptation — aggregate of existing statistical tests                                |
| **14: Capacity Forecasting**         | Tenant onboarding                | Layer 1        | Phase 1  | Adaptation — extrapolation from similar config cohorts                              |
| **15: Simulated Traffic Validation** | Staging, pre-promotion           | Layer 1+       | Phase 2  | **Novel** — PII-free trajectory replay for staging validation                       |
| **16: IR Path Coverage Simulation**  | CI, before release               | Layer 1 + IR   | Phase 1  | **Novel** — formal execution path coverage from IR graph + production STRs          |
| **17: Config Mutation Testing**      | Staging, before config promotion | Layer 1        | Phase 2  | **Novel** — behavioral stability testing via systematic config perturbation         |
| **18: Performance Budget Gate**      | CI/CD, before merge/deploy       | Layer 1        | Phase 1  | Adaptation — per-coordinate latency budgets (extends Mode 2)                        |
| **19: Synthetic Warmup + Probe**     | Post-deploy, first 30-120s       | Layer 1        | Phase 1  | Adaptation — behavioral cold-start detection via STR comparison                     |
| **20: Config Drift Sentinel**        | Continuous, every 5-15 min       | Layer 1        | Phase 1  | **Novel** — behavioral config drift via config hash divergence from deploy manifest |

### Why STI Uniquely Enables These

These modes are impossible or impractical with text traces because:

1. **Statistical comparison requires compact numerical representation.** Computing KL divergence across 500K text trace events is prohibitively expensive. Computing it across 500K 2KB STRs with integer arrays is a sub-second ClickHouse query.
2. **Path distribution comparison requires structured coordinates.** Text events have variable structure. STR taxonomy paths provide a consistent basis for distribution comparison across deploys, configs, and environments.
3. **PII-free trajectory templates enable cross-environment replay.** You can move production usage patterns to staging/CI without touching customer data — because coordinates contain no content.
4. **Config-hash cohorts enable behavioral prediction.** "What will this config change do?" is answerable only if you can find similar configs and compare their trace distributions. This requires the hierarchical config hash scheme.
5. **The <2KB size makes it feasible to generate STRs in CI/staging.** Text trace events at 50-200KB per trace are too expensive to store from every CI run. STRs at 2KB can be stored for every test execution across every PR.
6. **Compile-time IR + runtime STRs enable formal coverage analysis.** The compiler knows every possible path; STI knows every observed path. The gap is measurable, actionable, and automatable (Mode 16).
7. **Config hashes make drift detection a simple set comparison.** Config drift sentinel (Mode 20) is a single ClickHouse query because config is already reduced to a hash — no need to parse or compare complex config structures at query time.

---

## STI Health Monitoring

STI is an observability system that itself needs observability. Phase 0 minimum:

| Metric                         | Source                       | Alert Threshold                |
| ------------------------------ | ---------------------------- | ------------------------------ |
| `sti.flush.lag_ms`             | Ring buffer flush latency    | >5000ms                        |
| `sti.flush.circuit_open`       | Circuit breaker activated    | Any occurrence                 |
| `sti.flush.dropped_entries`    | Ring buffer overflow drops   | >0 (warning), >100/min (error) |
| `sti.wrapper.error_count`      | tracePath internal errors    | >10/min                        |
| `sti.clickhouse.insert_errors` | ClickHouse write failures    | >0 for >60s                    |
| `sti.manifest.checksum_valid`  | Manifest integrity on deploy | false                          |
| `sti.coverage.path_count`      | Number of unique trace paths | Sudden drop >10%               |

**Background scan health (Phase 1):**

| Metric                  | Source                            | Alert Threshold            |
| ----------------------- | --------------------------------- | -------------------------- |
| `sti.scan.duration_ms`  | Per-mode scan execution time      | >30000ms                   |
| `sti.scan.last_success` | Timestamp of last successful scan | >30min stale               |
| `sti.alert.fired_count` | Alerts generated per hour         | >20 (alert fatigue signal) |

---

## Phased Rollout

### Phase 0a: Prove the Data Model (1 week)

**Goal**: STR data flowing into ClickHouse, queryable, immediately useful for support.

**Prerequisites (must be complete before Phase 0a starts):**

- **Trace Readiness plan** — `createObservabilityMiddleware` from `@agent-platform/shared-observability` mounted on all Express servers, WebSocket handlers entering `runWithObservabilityContext` per-turn, BullMQ workers restoring trace context from job payloads. Without this, `getCurrentTraceId()` returns `undefined` and `tracePath()` silently degrades to a no-op.
- **Trace Event Consolidation** (at minimum Phase 1: Tasks 1-3b) — `platform_events` has `span_id`/`parent_span_id` columns, so STR entries can be correlated with platform events via shared `trace_id`.

**Phase 0a deliverables:**

- Implement `tracePath()` higher-order function wrapper (`packages/sti/`) — reads `traceId` from `getCurrentTraceId()` (`@abl/compiler/platform`), which reads from the `@agent-platform/shared-observability` ALS context
- Instrument top 10 hot paths: session entry, agent dispatch, workflow step execution, tool call, guardrail eval, LLM call, handoff, SearchAI query, state machine transition, channel handler
- ClickHouse `spatial_trace_records` table + Buffer engine table
- Write path: reuse existing ClickHouse client infrastructure from `trace-emitter.ts`
- STR buffer keyed by `traceId` from ALS — entries accumulated per-trace, flushed on trace completion or timeout
- Two config hashes: `config_hash_full` (exact matching) + `config_hash_tenant` (cross-deploy regression detection)
- Kill switch (`STI_ENABLED` env var)
- One API endpoint: **Mode 0 (Trace Waterfall)** + **Mode 1 (Root Cause, without baseline initially)**
- CI script: `grep -r "tracePath(" | wc -l` for coverage tracking
- Manifest generated as build artifact (documentation, not runtime dependency)
- **Validation gate**: Data flowing, engineers can query by trace_id, STR waterfall view is useful, `trace_id` in STRs matches `trace_id` in `platform_events` for the same request

### Phase 0b: Core Investigation Modes (2-3 weeks after 0a)

**Goal**: The three highest-value investigation modes + deployment confidence scoring.

- Mode 1 with baseline comparison (after 7+ days of data)
- Mode 2 (Regression Detection): deploy-hook comparison by config_hash
- Mode 5 (Blast Radius Scoping): on-demand ClickHouse query
- Mode 7 (Capacity/Saturation): on-demand resource vector aggregation
- **Mode 13 (Deployment Confidence Score)**: computed from the same queries as Mode 2 — minimal incremental effort
- Studio UI: "System View" tab in Observatory (platform-team-only role gate)
  - Trace waterfall view
  - System plane resource visualization
  - Session-to-trace lookup field
  - One-click deep link to agent developer trace in Observatory
  - Deployment confidence sparkline per deploy
- **Validation gate**: Coordinate stability verified across 10+ deploys. Platform engineers actively using it for support tickets.

### Phase 1: Coverage + Background Scans + Proactive Gates (4-6 weeks after Phase 0b)

**Goal**: Full code path coverage, continuous monitoring, proactive prevention, hardened infrastructure.

- Extend `tracePath()` to all executor/service/handler paths
- Build-time AST scanner + integer coordinate assignment
- Coordinate manifest with sha256 checksum
- Controlled vocabulary enforcement (`taxonomy.json`)
- Coverage lint rule (warning-only initially, error for Tier 1 after 4 weeks)
- Taxonomy diff on PRs (CI comment)
- Hierarchical config hash (full/system/tenant)
- Dedicated ring buffer with hard cap, circuit breaker, kill switch
- Background scans: Mode 3 (anomaly, scheduled), Mode 7 (scheduled), Mode 8 (on-demand)
- **Mode 10 (Pre-Release Regression Gate)**: CI integration comparing test STR distributions against baseline (soft gate initially)
- **Mode 11 (Post-Deploy Canary)**: Real-time trajectory comparison during canary rollout
- **Mode 12 (Config Impact Preview)**: API endpoint for Studio's agent editor
- **Mode 14 (Capacity Forecasting)**: API endpoint for admin dashboard
- **Mode 16 (IR Path Coverage Simulation)**: IR graph → reachable paths vs observed coverage, surfaced in CI
- **Mode 18 (Performance Budget Gate)**: Per-coordinate latency budgets in CI (soft gate initially)
- **Mode 19 (Synthetic Warmup + Probe)**: Post-deploy behavioral warmup validation
- **Mode 20 (Config Drift Sentinel)**: Continuous config hash divergence monitoring
- Alert routing to platform team channels (burn-in on low-priority channel first)
- **Validation gate**: Coordinate stability across 50+ deploys (churn rate <5% per deploy). Alert signal-to-noise ratio acceptable. Regression gate false positive rate <10%.

### Phase 1 Hardening (after Phase 1 validation gate)

- Manifest cryptographic parent chain + CAS writes
- `TracePathExempt` annotation for non-critical utility methods
- Mode 8 promoted to scheduled if signal-to-noise proven
- Ring buffer backed by memory-mapped file for crash recovery (optional, based on Phase 0-1 experience with in-memory buffer)
- Materialized views for pre-aggregated Mode 3/7 statistics (if scan duration exceeds 30s)
- Materialized view extracting most-queried `sys_components` entries (runtime_pod, mongodb, redis) into flat columns for hot-path queries

### Phase 2: Embeddings + Simulated Traffic (only if Phase 1 proves insufficient)

**Prerequisite**: Documented cases where Phase 1 modes failed to surface a pattern that embeddings would have caught.

- Layer 2 embedding training pipeline (sampled, 1-5% + anomalous)
- ClickHouse vector columns for similarity search
- Mode 4 (trend discovery), Mode 9 (full trajectory drift)
- **Mode 15 (Simulated Traffic Validation)**: PII-free trajectory replay in staging
- **Mode 17 (Config Mutation Testing)**: Systematic config perturbation with behavioral stability scoring
- Migrate to dedicated vector DB only if ClickHouse `cosineDistance` insufficient at scale

### Phase 3: Causal Model (future research direction)

**Prerequisite**: Concrete customer cases where Phases 0-2 failed to diagnose, AND dedicated ML engineering capacity.

- Causal Bayesian Network training pipeline
- Counterfactual simulation (Mode 6)
- Calibration test set + engineer feedback loop

---

## Relationship to Existing Systems

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Developer Traces                       │
│  (ClickHouse platform_events + Observatory UI)                   │
│                                                                  │
│  • Rich text: LLM responses, tool outputs, conversation content  │
│  • Tenant-scoped access                                          │
│  • Used by: agent developers, business, compliance               │
│  • Question: "What did my agent do?"                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ shared trace_id (cross-reference link)
┌──────────────────────────┴──────────────────────────────────────┐
│                  Spatial Trace Intelligence (STI)                 │
│  (ClickHouse spatial_trace_records + System View UI)             │
│                                                                  │
│  • Numerical: coordinates, resource vectors, config hashes       │
│  • Platform-team-only access (PII-free by construction)          │
│  • Used by: platform engineers, support, SRE                     │
│  • Question: "What happened in the system?"                      │
└─────────────────────────────────────────────────────────────────┘
```

Both systems share the same `trace_id`. An STI investigation provides a one-click deep link to the corresponding agent developer trace for content-level drill-down. The systems are complementary, not competing.

---

## Research Foundations & Prior Art

### Related Work

| System/Paper                               | Relationship to STI                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Google Dapper** (2010)                   | Foundational distributed tracing. STI's two-plane separation follows the same app/infra distinction.                                                                           |
| **OpenTelemetry GenAI Agent Spans** (2025) | OTel is defining hierarchical spans for agent/tool/LLM operations. STI's taxonomy aligns with and extends these conventions for ABL-specific constructs.                       |
| **Honeycomb BubbleUp**                     | Multi-dimensional distribution divergence. Mode 3 applies the same technique to numerical coordinates instead of text attributes.                                              |
| **Jaeger Trace Comparison**                | Side-by-side trace diffing. Mode 2 extends this with statistical comparison at scale across config cohorts.                                                                    |
| **Flagger / Argo Rollouts**                | Canary deployment metric comparison. Mode 2's config-hash cohort comparison extends beyond binary A/B to three-axis decomposition.                                             |
| **Chronosphere Governance**                | Multi-tenant observability cost control and data governance. STI's structural PII exclusion is a stronger guarantee than policy-based governance.                              |
| **TraceCRL** (FSE 2022)                    | GNN-based trace embedding. Layer 2 adapts this with domain-aware hierarchy instead of flat service graph.                                                                      |
| **DeepTraLog** (ICSE 2022)                 | Joint trace+log embedding. STI separates text (existing traces) from structure (STR) by design.                                                                                |
| **Sage** (ASPLOS 2021)                     | Causal Bayesian Network for performance debugging. Layer 3 adapts this as an on-demand layer, not always-on.                                                                   |
| **CauseInfer** (INFOCOM 2014)              | Hierarchical causal graph for distributed systems. Foundational for Layer 3's approach.                                                                                        |
| **CausalRCA** (JSS 2023)                   | Fine-grained causal root cause localization. Relevant to Layer 3 design.                                                                                                       |
| **Tracezip** (ISSTA 2025)                  | Trace compression via Span Retrieval Trees (6.46x compression). Different goal: STR compresses for analysis, Tracezip for storage.                                             |
| **Flow2Vec** (OOPSLA 2020)                 | Value-flow code embedding. STI applies execution path encoding at runtime rather than static analysis.                                                                         |
| **GMTA** (FSE 2020)                        | Graph-based trace abstraction into business flows. Relevant to application plane hierarchy.                                                                                    |
| **Chain-of-Event** (FSE 2024)              | Interpretable root cause analysis via weighted event causal graphs. Relevant to Mode 1 and Layer 3.                                                                            |
| **Evidently AI**                           | Concept drift detection for ML. Phase 2 Mode 9 applies trajectory drift detection to trace coordinates.                                                                        |
| **Netflix Kayenta**                        | Automated canary analysis via Mann-Whitney U tests on metrics. Mode 11 extends to trace topology distributions.                                                                |
| **Uber CRISP** (ATC 2022)                  | Critical path extraction from traces for performance analysis. Mode 10/11 use coordinate distributions as deployment gates, not just analysis.                                 |
| **Tracetest** (Kubeshop)                   | Trace-based testing with per-span assertions in CI. Mode 10 extends to automatic distribution-level comparison without manual assertion definitions.                           |
| **Signadot SmartTests**                    | AI-based API contract diffing in sandboxed environments. Mode 15 compares full trace topology, not just API responses.                                                         |
| **Komodor / Terraform drift**              | Declarative config drift detection. Mode 12/20 detect behavioral drift (execution path changes) from config changes, not just state drift.                                     |
| **Mutation Testing** (Pitest, Stryker)     | Code mutation testing for test suite adequacy. Mode 17 applies mutation to _configuration_ instead of code, using STR distributions instead of test assertions.                |
| **Istanbul / c8 coverage**                 | Line/branch code coverage. Mode 16 provides _execution path coverage_ combining compile-time IR reachability with runtime trace observations — a higher-level coverage metric. |

### Novelty Assessment (honest)

**Genuinely novel:**

- **Hierarchical config-hash with three-axis decomposition** (full/system/tenant) for multi-tenant platform analysis. No existing system provides orthogonal configuration slicing on the same trace data. Extends canary deployment comparison beyond binary A/B.
- **Cross-tenant anonymized pattern correlation** (Mode 8) — real gap in multi-tenant observability. Existing tools focus on tenant isolation, not cross-tenant correlation.
- **Structural PII exclusion** — the STI data model is incapable of containing customer content by construction. Stronger than RBAC on shared stores.
- **Coordinate manifest with integrity chain and tombstoning** (Phase 1) — goes beyond OTel `@WithSpan` by providing versioned, chained, deterministic coordinate assignment with cross-deploy stability guarantees.
- **Trace-topology-based deployment gates** (Modes 10, 11) — no existing system uses trace coordinate distribution comparison for CI regression gating or canary analysis. All production canary systems (Kayenta, Flagger, Argo) are metric-based.
- **Configuration behavioral impact preview** (Mode 12) — no existing tool predicts execution path changes from config modifications. Config drift tools detect state divergence, not behavioral divergence.
- **PII-free trajectory replay** (Mode 15) — production usage patterns can be replayed in staging/CI using coordinate sequences that contain zero customer content.
- **IR-derived execution path coverage** (Mode 16) — formal coverage metric combining compile-time IR reachability with runtime STR observations. No existing tool measures "execution path coverage" against a compiled agent topology.
- **Behavioral config mutation testing** (Mode 17) — systematic config perturbation using STR distributions as behavioral fingerprints. Existing mutation testing mutates code; this mutates configuration and measures behavioral impact via trace topology.
- **Behavioral config drift detection** (Mode 20) — detects runtime configuration divergence from deploy manifest via config hash comparison. Goes beyond declarative state drift (Terraform/Komodor) to detect behavioral divergence.

**Well-framed adaptations (not novel, but domain-specific value):**

- Two-plane separation (standard since Dapper 2010, applied to agent platform specifics)
- Hierarchical coordinates (categorical encoding of span attributes with ABL taxonomy)
- Auto-instrumentation via HOF wrapper (OTel `@WithSpan` equivalent for functional codebases)
- Anomaly detection, regression detection, capacity monitoring (solved problems applied to STR data)
- Analysis-depth tiering (always-on → batch → on-demand, gated on demonstrated value)
- Per-coordinate performance budgets (Mode 18) — applies SLO concepts at coordinate granularity, extends Mode 2
- Synthetic warmup probes (Mode 19) — cold-start detection using STR behavioral comparison, extends standard health checks

**Research-grade (future direction, not committed):**

- Config-aware counterfactual simulation combining both planes (Mode 6)
- TDA / persistent homology applied to trace trajectory shapes

---

## Key Design Decisions

| Decision                                     | Choice                                                         | Rationale                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Reuse `@agent-platform/shared-observability` | `tracePath()` reads traceId from existing ALS, not own context | Eliminates parallel context management; correlates STRs with platform_events by construction |
| Separate system from agent traces            | Parallel pipeline, shared trace_id, PII-free by construction   | Different audiences, access controls, retention, query patterns                              |
| HOF wrapper, not decorators                  | `tracePath()` higher-order function                            | Codebase is functional; no `experimentalDecorators` in tsconfig                              |
| String paths first, integers later           | Phase 0a uses strings; Phase 1 adds integer coordinates        | Prove value before optimizing storage. ClickHouse string interning handles moderate volumes. |
| Single config hash first, hierarchical later | Phase 0a single hash; Phase 1+ three-level                     | Avoid premature complexity. Single hash sufficient for initial regression detection.         |
| CI grep first, AST scanner later             | Phase 0a grep; Phase 1 scanner                                 | Prove taxonomy stability before investing in build tooling.                                  |
| Reuse existing ClickHouse write path first   | Phase 0a fire-and-forget; Phase 1 ring buffer                  | Minimize new code touching hot path. Ring buffer added after write patterns validated.       |
| Existing write infra, Buffer table           | Reuse ClickHouse client + Buffer engine                        | No new write infrastructure in Phase 0. Buffer absorbs burst without merge contention.       |
| Two planes                                   | Application + System separated                                 | Different analysis techniques, different audiences within platform team                      |
| Hybrid fixed + learned                       | Fixed taxonomy + learned behavior (deferred)                   | Known structure shouldn't be re-learned; dynamic behavior should be                          |
| Three layers                                 | Always-on + batch + on-demand                                  | Cost proportional to analysis depth; each phase gated on prior value                         |
| ClickHouse first                             | Single storage for L1 + L2 vectors initially                   | Minimize operational burden; add vector DB only if proven insufficient                       |
| Map-based system columns                     | `Map(String, Array(Float32))`                                  | New components need no DDL migration                                                         |

---

## Operational Model

### Phase 0-1 Infrastructure

| Component                                | New?                                               | Operational Burden                                                   |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `@agent-platform/shared-observability`   | Existing package, already deployed                 | Zero — middleware mount is the only change (done by Trace Readiness) |
| `tracePath()` HOF wrapper                | New code in `packages/sti/`, deployed with runtime | Zero — part of normal app deployment, reads from existing ALS        |
| ClickHouse `spatial_trace_records` table | New table, existing cluster                        | One DDL migration. Near-zero ongoing.                                |
| ClickHouse Buffer table                  | New table, existing cluster                        | Auto-managed by ClickHouse.                                          |
| Manifest store (S3)                      | New prefix in existing bucket                      | Near-zero. Manifests are <100KB each.                                |
| Redis cache for manifests                | Existing cluster, new key prefix                   | Negligible memory. A few keys per active version.                    |
| CI grep / taxonomy lint                  | Build pipeline addition                            | Adds 2-5 seconds to CI.                                              |
| Background scans (Phase 1)               | Scheduled ClickHouse queries                       | Low — query timeout + concurrency limit prevent resource contention. |

**Total ongoing FTE (Phase 0-1): ~0.05-0.1** (2-4 hours/week), concentrated in alert tuning during Phase 1's first month.

### Cost Comparison

| Approach             | Monthly Cost (500K traces/day) | FTE      | Novel Capabilities                                                           |
| -------------------- | ------------------------------ | -------- | ---------------------------------------------------------------------------- |
| **STI Phase 0-1**    | **$5-50**                      | 0.05-0.1 | Config-hash cohorts, cross-tenant correlation, PII-free system view          |
| STI Full (v1 design) | $17K-30K                       | 1-1.5    | + embeddings, + causal model, + counterfactual                               |
| Datadog APM          | $2K-8K                         | 0.1-0.2  | Generic APM, no config-hash cohorts, no cross-tenant correlation             |
| Honeycomb            | $2K-5K                         | 0.1-0.2  | BubbleUp, no multi-tenant anonymized analysis                                |
| Datadog + Honeycomb  | $4K-12K                        | 0.1-0.2  | ~60-70% of STI capability, but no config-hash cohorts, no PII-free guarantee |

---

## Resolved Design Questions

| #   | Question                             | Resolution                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Cardinality bounds**               | Hard cap at 200 entries per STR. Truncated STRs flagged with `is_truncated: Bool DEFAULT false` column. No materialized views until a Mode query exceeds 5s on 30 days of data.                                                                                                                                                                                                                           |
| 2   | **Cold archive / manifest lifetime** | Manifests kept forever, append-only, no TTL. ~90GB over 5 years at 5 deploys/day — negligible S3 cost.                                                                                                                                                                                                                                                                                                    |
| 3   | **Multi-cluster synchronization**    | Not a concern. Manifests are build artifacts in S3 — all clusters read from the same bucket. Deploy rollout lag handled by `code_version` field on each STR.                                                                                                                                                                                                                                              |
| 4   | **Backfill / bootstrap strategy**    | Per `config_hash_tenant` cohort progressive bootstrap: disabled (days 0-3), low-confidence (days 3-7), full (day 7+). Mode 13 reports "insufficient baseline for N cohorts" rather than misleading scores.                                                                                                                                                                                                |
| 5   | **Write amplification**              | Negligible at current scale (STRs add ~1-4% write volume). At 5M+ traces/day: tail sampling — 100% error/slow/novel-path traces, X% random baseline. Tail > head sampling because value is in anomalies.                                                                                                                                                                                                  |
| 6   | **Tenant anonymization**             | Query-time stripping sufficient for Phase 0-1. Mode 8 API strips `tenant_id` server-side before returning results. Correlation to tenant requires separate audited query. Revisit with opaque tokens if audience broadens.                                                                                                                                                                                |
| 7   | **Mode 10 divergence threshold**     | No upfront threshold. 4-week soft gate with human labels (thumbs-up/down per PR). Discriminator is divergence × path breadth, not divergence alone. Auto-calibrate at 90% recall / <10% FPR after 20-30 labeled PRs.                                                                                                                                                                                      |
| 8   | **Mode 12 prediction accuracy**      | Approach C: dimension-level hashes + structural signature. Tiered confidence: <5 cohort = "no prediction", 5-20 = low, 20-100 = medium, 100+ = high. "No similar config" is itself a signal ("unprecedented configuration, manual review recommended"). Two-tier query: exact dimension match first, structural similarity fallback if cohort < 5. Stored in `config_snapshots` table (see schema below). |
| 9   | **Mode 15 trajectory-to-input**      | Three progressive strategies: (1) Phase 2: test suite STR distribution vs production STR distribution — identifies coverage gaps without generating inputs. (2) Phase 2+: IR-based heuristic input hints for structural branches. (3) Future: input shape recording (length, category, not content). Strategy 1 alone is valuable.                                                                        |
| 10  | **CI environments**                  | `STI_MODE` env var: `production` (full STR), `ci` (coordinates only, no resource vectors, output to local `strs.jsonl`), `disabled`. CI artifacts store STR files. Mode 10/18 compare against baseline artifact from main branch's last successful run.                                                                                                                                                   |
| 11  | **IR-to-taxonomy mapping**           | Two-category coverage report: DSL coverage (IR-reachable vs observed paths) and platform coverage (runtime paths not in IR). Static IR-to-taxonomy mapping table maintained alongside `taxonomy.json`. Missing paths are a signal — either expected platform paths or incomplete IR (fix the compiler).                                                                                                   |
| 12  | **Mode 17 mutation explosion**       | Single-dimension mutations only, risk-prioritized: model > flags > guardrails > execution mode > tools > topology. Capped at 30 mutations per run. Pairwise combinations only for proven-unstable dimensions. Smart termination if first 5 mutations in a family show zero divergence.                                                                                                                    |
| 13  | **Mode 18 budget calibration**       | Auto-calibrate from 2 weeks production data. Formula: `budget_p95 = observed_p95 × 1.3`, `budget_p99 = observed_p99 × 1.5`. Critical paths: tighter (1.2×/1.3×), hard gate. Non-critical: looser (1.5×/2.0×), soft gate only. Monthly re-calibration from trailing 30-day data. Manual override in `budgets.json`.                                                                                        |
| 14  | **Mode 19 warmup safety**            | `X-STI-Warmup: true` header propagated through execution. LLM and guardrails execute normally (needed for warming). Tool calls return mock success, channel responses suppressed, state mutations suppressed. 3-5 predefined synthetic scenarios, 30-second warmup window.                                                                                                                                |
| 15  | **Mode 20 expected hash updates**    | Admin API config mutations register new expected hashes via `stiManifest.registerExpectedHash()`. Manifest is a log (not snapshot) with source, actor, dimension, timestamp. "Unexpected" = never registered (direct DB edit, partial deploy, bypass). Entries archived at STR TTL (90 days).                                                                                                             |

### Config Snapshots Schema (from Q8 resolution)

```sql
CREATE TABLE config_snapshots (
  config_hash_full   String,
  config_hash_tenant String,
  -- Dimension hashes (for Mode 12 exact match)
  topology_hash      String,
  model_hash         String,
  guardrail_hash     String,
  tool_hash          String,
  workflow_hash      String,
  channel_hash       String,
  flags_hash         String,
  execution_hash     String,
  -- Structural signature (for Mode 12 similarity fallback, Mode 14 capacity)
  agent_count        UInt8,
  max_depth          UInt8,
  tool_count         UInt8,
  guardrail_count    UInt8,
  has_handoffs       Bool,
  has_delegates      Bool,
  has_state_machine  Bool,
  execution_mode     String,
  -- Metadata
  created_at         DateTime64(6)
) ENGINE = ReplacingMergeTree(created_at)
ORDER BY config_hash_full;
```

**Mode 12 query pattern** (two-tier):

```sql
-- Tier 1: Exact dimension match (high confidence)
-- "What happens if I change model provider?" — match all dimensions except model
SELECT s.app_paths, s.app_outcomes, s.app_durations
FROM spatial_trace_records s
JOIN config_snapshots c ON s.config_hash_full = c.config_hash_full
WHERE c.guardrail_hash = :current_guardrail_hash
  AND c.topology_hash  = :current_topology_hash
  AND c.tool_hash      = :current_tool_hash
  AND c.workflow_hash   = :current_workflow_hash
  AND c.channel_hash    = :current_channel_hash
  AND c.flags_hash      = :current_flags_hash
  AND c.execution_hash  = :current_execution_hash
  AND c.model_hash     != :current_model_hash
  AND s.timestamp > now() - INTERVAL 30 DAY;

-- Tier 2: Structural similarity fallback (low confidence, if Tier 1 cohort < 5)
SELECT s.app_paths, s.app_outcomes, s.app_durations
FROM spatial_trace_records s
JOIN config_snapshots c ON s.config_hash_full = c.config_hash_full
WHERE c.agent_count    = :current_agent_count
  AND c.has_handoffs   = :current_has_handoffs
  AND c.execution_mode = :current_execution_mode
  AND c.model_hash    != :current_model_hash
  AND s.timestamp > now() - INTERVAL 30 DAY;
```
