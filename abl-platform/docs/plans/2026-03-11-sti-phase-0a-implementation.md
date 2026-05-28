# STI Phase 0a Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Get Spatial Trace Records (STRs) flowing into ClickHouse and queryable by trace_id, proving the data model is useful for platform engineering support.

**Architecture:** New `packages/sti/` package containing `tracePath()` HOF wrapper, STR collector, config hash computation, and ClickHouse writer. The writer reuses the existing `BufferedClickHouseWriter` from `@agent-platform/database`. Instrumentation wraps the top 10 runtime hot paths with `tracePath()`. A single API endpoint returns STR waterfall + basic root cause analysis by trace_id.

**Tech Stack:** TypeScript, ClickHouse (`@clickhouse/client` via existing `BufferedClickHouseWriter`), Vitest, crypto (Node built-in for sha256 hashes)

**Design Doc:** `docs/plans/2026-03-11-spatial-trace-intelligence-design.md` (v7)

**Review Status:** 3 rounds of parallel review (5 reviewers each). All findings resolved below.

---

## Round 2 Amendments

Two review rounds (5 specialized reviewers each) validated this plan against the design document. Round 1 found 8 critical, 10 high-priority, 5 completeness gaps, and 5 codebase compatibility issues. Round 2 verified the fixes and provided corrected code. All amendments are applied inline to the affected tasks below, but summarized here for reference.

### Critical Architecture Change: `AsyncLocalStorage.run()` Pattern

**Affects: Tasks 5, 8, 10, 15**

The original plan used `enterWith()` + `beginTrace()`/`endTrace()` imperative API. This is **unsafe under concurrency** — `enterWith()` mutates the current async context, causing sibling requests to share/corrupt each other's STI collectors.

**Corrected design:** Callback-based API using `AsyncLocalStorage.run()`:

- `beginTrace(ctx)` → `runTrace(ctx, async () => { ... })` (lifecycle owns the ALS scope)
- `tracePath()` increments depth via `stiStore.run({ collector, depth: currentDepth + 1 }, ...)` (immutable snapshots)
- `setStiContext()`/`clearStiContext()` removed from public API
- All STI internal operations wrapped in try/catch — never propagate to application code

### Summary of All Amendments by Task

| Task | Amendment                                                                                                                             | Source       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 2    | `const enum` → regular `enum` (cross-package issue)                                                                                   | R1-X4        |
| 2    | `resolveConfig()` cached at module load, not per-request                                                                              | R1-H1        |
| 3    | Add `\0` separators between hash fields                                                                                               | R1-H7        |
| 3    | Sort `tenantConfig` keys before hashing (determinism)                                                                                 | R1-H5        |
| 4    | `segmentCounter` → `crypto.randomUUID()`                                                                                              | R1-C8        |
| 4    | Add `maxSysComponents` cap (default 50)                                                                                               | R1-H2        |
| 5    | Replace `enterWith()` with `run()` pattern                                                                                            | R1-C1, R1-C7 |
| 5    | Add try/catch around `recordEntry`/`recordSuccess`/`recordFailure`                                                                    | R1-C2        |
| 5    | Import from `node:async_hooks` (NodeNext compat)                                                                                      | R1-C4        |
| 5    | Add `_runWithCollector` test-only export                                                                                              | R2-T2        |
| 6    | Add `config_hash_system String DEFAULT ''` column                                                                                     | R1-C5        |
| 6    | Add `app_coords Array(Array(Int32))` column (Phase 1+)                                                                                | R1-C5        |
| 6    | Add `app_decisions Array(Array(Int16))` column (Phase 1+)                                                                             | R1-C5        |
| 6    | Buffer table params: `(16, 1, 5, 1000, 10000, 1048576, 10485760)`                                                                     | R1-C6        |
| 7    | Add `onError` callback with logger                                                                                                    | R1-H3        |
| 7    | New file: `ci-writer.ts` for `STI_MODE=ci` JSONL output                                                                               | R1-G2        |
| 8    | Rewrite to `runTrace(ctx, fn)` callback API                                                                                           | R1-C1        |
| 8    | Branch `getWriter()` on `config.mode === 'ci'`                                                                                        | R1-G2        |
| 8    | Wrap `writer.write()` in try/catch inside finally                                                                                     | R2-T4        |
| 8    | All tests need `vi.stubEnv('STI_MODE', 'production')`                                                                                 | R1-G5        |
| 9    | DDL includes all 3 new columns from Task 6 amendment                                                                                  | R1-C5        |
| 10   | Fix all 10 path strings to 4-segment vocabulary-conformant format                                                                     | R1-H10       |
| 10   | Pre-create wrappers as class fields, not inline per-call                                                                              | R1-H9        |
| 10   | Use `session.agentName` not `session.currentAgent`                                                                                    | R1-X2        |
| 10   | Use `session.versionInfo?.deploymentId` not `session.deploymentId`                                                                    | R1-X3        |
| 10   | Wire `runTrace()` callback in `executeMessage()`, not `beginTrace/endTrace`                                                           | R1-X5        |
| 10   | Recursive `executeMessage()` inherits parent STI context (no new trace)                                                               | Design       |
| 12   | Add auth: `authMiddleware` + `requirePermission('tenant:manage_settings')`                                                            | R1-C3        |
| 12   | Parameterized ClickHouse queries: `{traceId:String}`                                                                                  | R1-H6        |
| 12   | Validate traceId with regex before query, 400 on invalid                                                                              | R1-H8        |
| 12   | Mount at `/api/admin/sti` in `server.ts` (not `routes/index.ts`)                                                                      | R1-X1        |
| 12   | Add Observatory deep link (`observatory_url`) to response                                                                             | R1-G3        |
| 13   | Fix grep flags: count calls not files                                                                                                 | R1-G4        |
| 13   | Add manifest extraction (`--write-manifest` → `sti-manifest.json`)                                                                    | R1-G1        |
| 15   | Use `vi.stubEnv('STI_MODE', 'production')`                                                                                            | R1-G5        |
| New  | `packages/sti/taxonomy.json` — controlled vocabulary file                                                                             | R1-H10       |
| New  | 6 additional test files (concurrent isolation, exception safety, kill switch, writer failure, truncation boundary, route integration) | R2-T1..T6    |

## Round 3 Amendments

Round 3 review (5 specialized reviewers: architecture, design compliance, codebase compatibility, test coverage, security) found 4 critical, 11 high, and 8 low findings. All amendments applied inline below.

### R3 Summary of All Amendments by Task

| Task | Amendment                                                                                                               | Source         |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------- |
| 2    | Add optional `config_hash_system?: string` to `SpatialTraceRecord`                                                      | R3-L1          |
| 4    | Add tests: `maxSysComponents` cap, `recordTimeout()`, `timings` monotonicity, post-finalize safety                      | R3-H7, R3-H8   |
| 5    | Add tests: `this` context preservation, concurrent sibling `tracePath` calls, depth > 2 nesting                         | R3-H9          |
| 7    | Replace `console.error` with `createLogger('sti-writer')` from `@abl/compiler/platform`                                 | R3-H1          |
| 8    | `shutdownSti()` — add `isShuttingDown` flag + no-op writer fallback for in-flight traces                                | R3-C2          |
| 8    | `ci-writer.ts` — document `appendFileSync` as accepted CI trade-off, add comment                                        | R3-H2          |
| 8    | All lifecycle tests must call `_resetConfig()` in `beforeEach` (after stubEnv) and `afterEach`                          | R3-C1          |
| 8    | Add tests: `shutdownSti()`, CI mode lifecycle, ci-writer dedicated test file                                            | R3-H10, R3-H11 |
| 10   | Replace `session.traceId ?? sessionId` with just `sessionId` (`traceId` not on RuntimeSession)                          | R3-H6          |
| 10   | Add invariant comment explaining re-entrant guard correctness                                                           | R3-L4          |
| 12   | Fix auth imports: `authMiddleware` from `../middleware/auth.js`, `requirePermission` from `@agent-platform/shared-auth` | R3-C3          |
| 12   | Add `AND tenant_id = {tenantId:String}` filter to queries + pass from auth context                                      | R3-C4          |
| 12   | Return generic error message in 500 responses, log real error server-side only                                          | R3-H3          |
| 12   | Add `LIMIT 1000` to waterfall/root-cause queries                                                                        | R3-H4          |
| 12   | Add `observatory_url` to response (R1-G3 was documented but not applied to code)                                        | R3-H5          |
| 12   | Add length cap to traceId regex: `{1,128}`                                                                              | R3-L3          |
| 12   | Add tests: traceId validation edge cases, `analyzeRootCause` unit tests                                                 | R3-H11         |
| 15   | Concurrent test — use shared `tracePath` wrapper for stronger isolation proof                                           | R3-L7          |

---

## Task 1: Create `packages/sti/` Package Scaffold

**Files:**

- Create: `packages/sti/package.json`
- Create: `packages/sti/tsconfig.json`
- Create: `packages/sti/src/index.ts`
- Create: `packages/sti/taxonomy.json` (controlled vocabulary [R1-H10])

**Step 1: Create package.json**

```json
{
  "name": "@agent-platform/sti",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Spatial Trace Intelligence — numerical trace coordinates for platform engineering",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@agent-platform/database": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create taxonomy.json [R1-H10]**

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
  ],
  "detail_pattern": "^[a-z][a-z0-9-]*$"
}
```

**Step 4: Create empty barrel export**

```typescript
// packages/sti/src/index.ts
export {};
```

**Step 4: Install dependencies**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install`
Expected: Lockfile updated, `@agent-platform/sti` resolves

**Step 5: Verify build**

Run: `pnpm build --filter=@agent-platform/sti`
Expected: Compiles with no errors

**Step 6: Commit**

```bash
git add packages/sti/
pnpm-lock.yaml
git commit -m "feat(sti): scaffold packages/sti package"
```

---

## Task 2: Core Types — STR Schema and Config

**Files:**

- Create: `packages/sti/src/types.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the type definitions**

Reference: Design doc §"STR Data Model" and §"Resolved Design Questions" Q1 (200 entry cap), Q10 (STI_MODE).

```typescript
// packages/sti/src/types.ts

/** Outcome codes for application plane entries — regular enum (not const enum) for cross-package compat [R1-X4] */
export enum StiOutcome {
  Success = 0,
  Failure = 1,
  Timeout = 2,
  Skipped = 3,
}

/** A single application plane entry recorded by tracePath() */
export interface StiPathEntry {
  path: string;
  depth: number;
  outcome: StiOutcome;
  duration_us: number;
  start_us: number;
}

/** System plane resource vector for a single component */
export interface StiResourceVector {
  latency_us: number;
  throughput: number;
  error_bit: number;
  saturation_pct: number;
}

/** Complete Spatial Trace Record — one per request/segment */
export interface SpatialTraceRecord {
  trace_id: string;
  segment_id: string;
  timestamp: Date;
  config_hash_full: string;
  config_hash_system?: string; // Phase 1+ [R3-L1]
  config_hash_tenant: string;
  code_version: string;
  ir_schema: number;
  deploy_id: string;
  // Application plane (parallel arrays)
  app_paths: string[];
  app_depths: number[];
  app_outcomes: number[];
  app_durations: number[];
  // System plane
  sys_components: Record<string, number[]>;
  // Timing
  timings: number[];
  duration_us: number;
  is_async_boundary: boolean;
  is_truncated: boolean;
  // Partitioning
  tenant_id: string;
  project_id: string;
  agent_id: string;
}

/** STI operating mode — controls behavior in different environments */
export type StiMode = 'production' | 'ci' | 'disabled';

/** Configuration for the STI subsystem */
export interface StiConfig {
  enabled: boolean;
  mode: StiMode;
  /** Max entries per STR before truncation (default: 200) */
  maxEntriesPerStr: number;
  /** ClickHouse flush interval in ms (default: 5000) */
  flushIntervalMs: number;
  /** ClickHouse batch size (default: 1000) */
  batchSize: number;
  /** Max system components per STR (default: 50) [R1-H2] */
  maxSysComponents: number;
  /** Code version string (from build/env) */
  codeVersion: string;
  /** IR schema version number */
  irSchema: number;
}

/**
 * Resolved from environment variables.
 * Cached at module load — env vars are read once, not per-request. [R1-H1]
 * To change mode, restart the process (or use config map + pod restart).
 */
let _cachedConfig: StiConfig | undefined;

export function resolveConfig(): StiConfig {
  if (_cachedConfig) return _cachedConfig;
  const mode = (process.env.STI_MODE ?? 'disabled') as StiMode;
  _cachedConfig = {
    enabled: mode !== 'disabled',
    mode,
    maxEntriesPerStr: Number(process.env.STI_MAX_ENTRIES ?? 200),
    flushIntervalMs: Number(process.env.STI_FLUSH_INTERVAL_MS ?? 5000),
    batchSize: Number(process.env.STI_BATCH_SIZE ?? 1000),
    codeVersion: process.env.STI_CODE_VERSION ?? 'unknown',
    irSchema: Number(process.env.STI_IR_SCHEMA ?? 1),
    maxSysComponents: Number(process.env.STI_MAX_SYS_COMPONENTS ?? 50),
  };
  return _cachedConfig;
}

/** Reset cached config (for testing only) */
export function _resetConfig(): void {
  _cachedConfig = undefined;
}
```

**Step 2: Export from barrel**

```typescript
// packages/sti/src/index.ts
export * from './types.js';
```

**Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/sti`
Expected: Compiles with no errors

**Step 4: Commit**

```bash
git add packages/sti/src/types.ts packages/sti/src/index.ts
git commit -m "feat(sti): add core STR types and config resolution"
```

---

## Task 3: Config Hash Computation

**Files:**

- Create: `packages/sti/src/__tests__/config-hash.test.ts`
- Create: `packages/sti/src/config-hash.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the failing test**

```typescript
// packages/sti/src/__tests__/config-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeConfigHashFull, computeConfigHashTenant } from '../config-hash.js';

describe('config-hash', () => {
  const baseInputs = {
    dslContentHash: 'abc123',
    tenantConfigHash: 'tenant456',
    featureFlagsBitmap: '00101',
    codeVersion: 'v1.2.3',
    irSchemaVersion: 1,
  };

  describe('computeConfigHashFull', () => {
    it('returns a 64-char hex string (sha256)', () => {
      const hash = computeConfigHashFull(baseInputs);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for same inputs', () => {
      const a = computeConfigHashFull(baseInputs);
      const b = computeConfigHashFull(baseInputs);
      expect(a).toBe(b);
    });

    it('changes when code_version changes', () => {
      const a = computeConfigHashFull(baseInputs);
      const b = computeConfigHashFull({ ...baseInputs, codeVersion: 'v1.2.4' });
      expect(a).not.toBe(b);
    });

    it('changes when feature flags change', () => {
      const a = computeConfigHashFull(baseInputs);
      const b = computeConfigHashFull({ ...baseInputs, featureFlagsBitmap: '00111' });
      expect(a).not.toBe(b);
    });
  });

  describe('computeConfigHashTenant', () => {
    it('returns a 64-char hex string', () => {
      const hash = computeConfigHashTenant(baseInputs);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('does NOT change when code_version changes', () => {
      const a = computeConfigHashTenant(baseInputs);
      const b = computeConfigHashTenant({ ...baseInputs, codeVersion: 'v1.2.4' });
      expect(a).toBe(b);
    });

    it('does NOT change when feature flags change', () => {
      const a = computeConfigHashTenant(baseInputs);
      const b = computeConfigHashTenant({ ...baseInputs, featureFlagsBitmap: '00111' });
      expect(a).toBe(b);
    });

    it('DOES change when DSL content changes', () => {
      const a = computeConfigHashTenant(baseInputs);
      const b = computeConfigHashTenant({ ...baseInputs, dslContentHash: 'xyz789' });
      expect(a).not.toBe(b);
    });

    it('DOES change when tenant config changes', () => {
      const a = computeConfigHashTenant(baseInputs);
      const b = computeConfigHashTenant({ ...baseInputs, tenantConfigHash: 'other' });
      expect(a).not.toBe(b);
    });
  });

  describe('separator collision prevention [R1-H7]', () => {
    it('different field boundaries produce different hashes', () => {
      const a = computeConfigHashFull({
        dslContentHash: 'abc',
        tenantConfigHash: '123',
        featureFlagsBitmap: '00101',
        codeVersion: 'v1',
        irSchemaVersion: 1,
      });
      const b = computeConfigHashFull({
        dslContentHash: 'ab',
        tenantConfigHash: 'c123',
        featureFlagsBitmap: '00101',
        codeVersion: 'v1',
        irSchemaVersion: 1,
      });
      // Without \0 separators, 'abc'+'123' === 'ab'+'c123' → same hash. With separators, different.
      expect(a).not.toBe(b);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — `config-hash.js` module not found

**Step 3: Write implementation**

```typescript
// packages/sti/src/config-hash.ts
import { createHash } from 'crypto';

export interface ConfigHashInputs {
  dslContentHash: string;
  tenantConfigHash: string;
  featureFlagsBitmap: string;
  codeVersion: string;
  irSchemaVersion: number;
}

/** Null byte separator prevents collision when field values are concatenated [R1-H7] */
const SEP = '\0';

/**
 * Full config hash — includes code_version and feature flags.
 * Used for exact-match grouping (same deploy, same config, same code).
 *
 * Formula: sha256(dsl_content_hash \0 tenant_config_hash \0 feature_flags_bitmap \0 code_version \0 ir_schema_version)
 */
export function computeConfigHashFull(inputs: ConfigHashInputs): string {
  return createHash('sha256')
    .update(inputs.dslContentHash)
    .update(SEP)
    .update(inputs.tenantConfigHash)
    .update(SEP)
    .update(inputs.featureFlagsBitmap)
    .update(SEP)
    .update(inputs.codeVersion)
    .update(SEP)
    .update(String(inputs.irSchemaVersion))
    .digest('hex');
}

/**
 * Tenant config hash — excludes code_version and feature flags.
 * Used for cross-deploy regression detection (Mode 2).
 * Same agent DSL + same tenant config = same hash across deploys.
 *
 * Formula: sha256(dsl_content_hash \0 tenant_config_hash)
 */
export function computeConfigHashTenant(inputs: ConfigHashInputs): string {
  return createHash('sha256')
    .update(inputs.dslContentHash)
    .update(SEP)
    .update(inputs.tenantConfigHash)
    .digest('hex');
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './config-hash.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All 7 tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/config-hash.ts packages/sti/src/__tests__/config-hash.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): config hash computation (full + tenant)"
```

---

## Task 4: STR Collector — Per-Request Coordinate Accumulator

**Files:**

- Create: `packages/sti/src/__tests__/str-collector.test.ts`
- Create: `packages/sti/src/str-collector.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the failing tests**

```typescript
// packages/sti/src/__tests__/str-collector.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStrCollector } from '../str-collector.js';
import { StiOutcome } from '../types.js';

describe('StrCollector', () => {
  const baseContext = {
    traceId: 'trace-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    deployId: 'deploy-1',
    configHashFull: 'hash-full',
    configHashTenant: 'hash-tenant',
    codeVersion: 'v1.0.0',
    irSchema: 1,
  };

  it('creates a collector that records path entries', () => {
    const collector = createStrCollector(baseContext);
    const entry = collector.recordEntry('runtime/executor/agent/dispatch', 1);
    entry.recordSuccess(1000n);
    const str = collector.finalize();

    expect(str.trace_id).toBe('trace-001');
    expect(str.app_paths).toEqual(['runtime/executor/agent/dispatch']);
    expect(str.app_depths).toEqual([1]);
    expect(str.app_outcomes).toEqual([StiOutcome.Success]);
    expect(str.app_durations.length).toBe(1);
    expect(str.app_durations[0]).toBeGreaterThanOrEqual(0);
  });

  it('records multiple entries in order', () => {
    const collector = createStrCollector(baseContext);

    const e1 = collector.recordEntry('runtime/executor/agent/dispatch', 0);
    e1.recordSuccess(100n);

    const e2 = collector.recordEntry('runtime/guardrail/evaluate', 1);
    e2.recordFailure(200n);

    const str = collector.finalize();
    expect(str.app_paths).toEqual([
      'runtime/executor/agent/dispatch',
      'runtime/guardrail/evaluate',
    ]);
    expect(str.app_outcomes).toEqual([StiOutcome.Success, StiOutcome.Failure]);
  });

  it('truncates at maxEntries and sets is_truncated', () => {
    const collector = createStrCollector(baseContext, { maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      const e = collector.recordEntry(`path/${i}`, 0);
      e.recordSuccess(BigInt(i * 100));
    }

    const str = collector.finalize();
    expect(str.app_paths.length).toBe(3);
    expect(str.is_truncated).toBe(true);
    // Keeps first 3, drops 4th and 5th
    expect(str.app_paths).toEqual(['path/0', 'path/1', 'path/2']);
  });

  it('records system plane resource vectors', () => {
    const collector = createStrCollector(baseContext);
    collector.recordSystemComponent('mongodb', {
      latency_us: 1500,
      throughput: 100,
      error_bit: 0,
      saturation_pct: 45,
    });

    const str = collector.finalize();
    expect(str.sys_components).toEqual({
      mongodb: [1500, 100, 0, 45],
    });
  });

  it('caps system components at maxSysComponents [R3-H7]', () => {
    const collector = createStrCollector(baseContext, { maxSysComponents: 2 });
    collector.recordSystemComponent('mongodb', {
      latency_us: 100,
      throughput: 10,
      error_bit: 0,
      saturation_pct: 20,
    });
    collector.recordSystemComponent('redis', {
      latency_us: 50,
      throughput: 200,
      error_bit: 0,
      saturation_pct: 10,
    });
    collector.recordSystemComponent('clickhouse', {
      latency_us: 200,
      throughput: 5,
      error_bit: 0,
      saturation_pct: 30,
    });
    const str = collector.finalize();
    expect(Object.keys(str.sys_components)).toHaveLength(2);
    expect(str.sys_components).not.toHaveProperty('clickhouse');
  });

  it('allows updating an existing component even when at cap [R3-H7]', () => {
    const collector = createStrCollector(baseContext, { maxSysComponents: 1 });
    collector.recordSystemComponent('mongodb', {
      latency_us: 100,
      throughput: 10,
      error_bit: 0,
      saturation_pct: 20,
    });
    collector.recordSystemComponent('mongodb', {
      latency_us: 200,
      throughput: 20,
      error_bit: 0,
      saturation_pct: 40,
    });
    const str = collector.finalize();
    expect(Object.keys(str.sys_components)).toHaveLength(1);
    expect(str.sys_components.mongodb).toEqual([200, 20, 0, 40]);
  });

  it('records timeout outcome via recordTimeout() [R3-H8]', () => {
    const collector = createStrCollector(baseContext);
    const entry = collector.recordEntry('runtime/tool/call/invoke', 0);
    entry.recordTimeout(process.hrtime.bigint());
    const str = collector.finalize();
    expect(str.app_outcomes).toEqual([StiOutcome.Timeout]);
    expect(str.app_durations[0]).toBeGreaterThanOrEqual(0);
  });

  it('records timings relative to collector creation time [R3-H8]', async () => {
    const collector = createStrCollector(baseContext);
    await new Promise((r) => setTimeout(r, 2));
    const e1 = collector.recordEntry('runtime/executor/execute/dispatch', 0);
    e1.recordSuccess(process.hrtime.bigint());
    await new Promise((r) => setTimeout(r, 2));
    const e2 = collector.recordEntry('runtime/llm/call/completion', 1);
    e2.recordSuccess(process.hrtime.bigint());
    const str = collector.finalize();
    expect(str.timings).toHaveLength(2);
    expect(str.timings[0]).toBeGreaterThan(0);
    expect(str.timings[1]).toBeGreaterThan(str.timings[0]);
  });

  it('computes total duration_us from first entry to finalize', () => {
    const collector = createStrCollector(baseContext);
    const e = collector.recordEntry('runtime/executor/agent/dispatch', 0);
    e.recordSuccess(100n);

    const str = collector.finalize();
    expect(str.duration_us).toBeGreaterThanOrEqual(0);
  });

  it('sets metadata fields from context', () => {
    const collector = createStrCollector(baseContext);
    const str = collector.finalize();

    expect(str.tenant_id).toBe('tenant-1');
    expect(str.project_id).toBe('project-1');
    expect(str.agent_id).toBe('agent-1');
    expect(str.deploy_id).toBe('deploy-1');
    expect(str.config_hash_full).toBe('hash-full');
    expect(str.config_hash_tenant).toBe('hash-tenant');
    expect(str.code_version).toBe('v1.0.0');
    expect(str.ir_schema).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/sti/src/str-collector.ts
import { randomUUID } from 'node:crypto';
import type { SpatialTraceRecord, StiPathEntry, StiResourceVector } from './types.js';
import { StiOutcome } from './types.js';

export interface StrCollectorContext {
  traceId: string;
  tenantId: string;
  projectId: string;
  agentId: string;
  deployId: string;
  configHashFull: string;
  configHashTenant: string;
  codeVersion: string;
  irSchema: number;
}

export interface StrCollectorOptions {
  maxEntries?: number;
  /** Max system components per STR (default: 50) [R1-H2] */
  maxSysComponents?: number;
}

export interface PathEntryHandle {
  recordSuccess(endTimeNs: bigint): void;
  recordFailure(endTimeNs: bigint): void;
  recordTimeout(endTimeNs: bigint): void;
}

export interface StrCollector {
  recordEntry(path: string, depth: number): PathEntryHandle;
  recordSystemComponent(name: string, vector: StiResourceVector): void;
  finalize(): SpatialTraceRecord;
}

export function createStrCollector(
  ctx: StrCollectorContext,
  options?: StrCollectorOptions,
): StrCollector {
  const maxEntries = options?.maxEntries ?? 200;
  const maxSysComponents = options?.maxSysComponents ?? 50;
  const entries: StiPathEntry[] = [];
  const sysComponents: Record<string, number[]> = {};
  let sysComponentCount = 0;
  let truncated = false;
  const startNs = process.hrtime.bigint();
  const startTime = new Date();

  function recordEntry(path: string, depth: number): PathEntryHandle {
    if (entries.length >= maxEntries) {
      truncated = true;
      return {
        recordSuccess() {},
        recordFailure() {},
        recordTimeout() {},
      };
    }

    const entryStartNs = process.hrtime.bigint();
    const entry: StiPathEntry = {
      path,
      depth,
      outcome: StiOutcome.Success,
      duration_us: 0,
      start_us: Number(entryStartNs - startNs) / 1000,
    };
    entries.push(entry);

    return {
      recordSuccess(endTimeNs: bigint) {
        entry.outcome = StiOutcome.Success;
        entry.duration_us = Number(endTimeNs - entryStartNs) / 1000;
      },
      recordFailure(endTimeNs: bigint) {
        entry.outcome = StiOutcome.Failure;
        entry.duration_us = Number(endTimeNs - entryStartNs) / 1000;
      },
      recordTimeout(endTimeNs: bigint) {
        entry.outcome = StiOutcome.Timeout;
        entry.duration_us = Number(endTimeNs - entryStartNs) / 1000;
      },
    };
  }

  function recordSystemComponent(name: string, vector: StiResourceVector): void {
    // Cap system components to prevent unbounded Map growth [R1-H2]
    if (!(name in sysComponents) && sysComponentCount >= maxSysComponents) return;
    if (!(name in sysComponents)) sysComponentCount++;
    sysComponents[name] = [
      vector.latency_us,
      vector.throughput,
      vector.error_bit,
      vector.saturation_pct,
    ];
  }

  function finalize(): SpatialTraceRecord {
    const endNs = process.hrtime.bigint();
    // Use crypto.randomUUID() — unique across restarts/pods [R1-C8]
    const segId = randomUUID();

    return {
      trace_id: ctx.traceId,
      segment_id: segId,
      timestamp: startTime,
      config_hash_full: ctx.configHashFull,
      config_hash_tenant: ctx.configHashTenant,
      code_version: ctx.codeVersion,
      ir_schema: ctx.irSchema,
      deploy_id: ctx.deployId,
      app_paths: entries.map((e) => e.path),
      app_depths: entries.map((e) => e.depth),
      app_outcomes: entries.map((e) => e.outcome),
      app_durations: entries.map((e) => Math.round(e.duration_us)),
      sys_components: sysComponents,
      timings: entries.map((e) => Math.round(e.start_us)),
      duration_us: Number(endNs - startNs) / 1000,
      is_async_boundary: false,
      is_truncated: truncated,
      tenant_id: ctx.tenantId,
      project_id: ctx.projectId,
      agent_id: ctx.agentId,
    };
  }

  return { recordEntry, recordSystemComponent, finalize };
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './str-collector.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/str-collector.ts packages/sti/src/__tests__/str-collector.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): STR collector — per-request coordinate accumulator"
```

---

## Task 5: `tracePath()` Higher-Order Function Wrapper

**Files:**

- Create: `packages/sti/src/__tests__/trace-path.test.ts`
- Create: `packages/sti/src/trace-path.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the failing tests**

```typescript
// packages/sti/src/__tests__/trace-path.test.ts
import { describe, it, expect, vi } from 'vitest';
import { tracePath, withStiContext, getStiContext, _runWithCollector } from '../trace-path.js';
import { createStrCollector } from '../str-collector.js';
import { StiOutcome } from '../types.js';

describe('tracePath', () => {
  const collectorCtx = {
    traceId: 'trace-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    deployId: 'deploy-1',
    configHashFull: 'hash-full',
    configHashTenant: 'hash-tenant',
    codeVersion: 'v1.0.0',
    irSchema: 1,
  };

  // No beforeEach/afterEach cleanup — run()-based API scopes context to callback chain

  it('wraps a function without changing its behavior', async () => {
    const fn = async (x: number) => x * 2;
    const wrapped = tracePath('test/unit/call/noop', fn);

    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      const result = await wrapped(5);
      expect(result).toBe(10);
    });
  });

  it('records a success entry when the function resolves', async () => {
    const fn = async () => 'ok';
    const wrapped = tracePath('runtime/executor/execute/dispatch', fn);

    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      await wrapped();
    });
    const str = collector.finalize();

    expect(str.app_paths).toEqual(['runtime/executor/execute/dispatch']);
    expect(str.app_outcomes).toEqual([StiOutcome.Success]);
    expect(str.app_durations[0]).toBeGreaterThanOrEqual(0);
  });

  it('records a failure entry when the function throws', async () => {
    const fn = async () => {
      throw new Error('boom');
    };
    const wrapped = tracePath('runtime/guardrail/evaluate/pre-input', fn);

    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      await expect(wrapped()).rejects.toThrow('boom');
    });
    const str = collector.finalize();

    expect(str.app_paths).toEqual(['runtime/guardrail/evaluate/pre-input']);
    expect(str.app_outcomes).toEqual([StiOutcome.Failure]);
  });

  it('preserves function name for debugging', () => {
    async function myFunction() {
      return 42;
    }
    const wrapped = tracePath('test/unit/call/noop', myFunction);
    expect(wrapped.name).toBe('traced(myFunction)');
  });

  it('is a no-op when no STI context is set', async () => {
    const fn = async (x: number) => x + 1;
    const wrapped = tracePath('test/unit/call/noop', fn);
    const result = await wrapped(3);
    expect(result).toBe(4);
  });

  it('preserves this context when wrapping class methods [R3-H9]', async () => {
    class MyService {
      value = 42;
      readonly doWork = tracePath(
        'runtime/executor/execute/dispatch',
        async function (this: MyService) {
          return this.value;
        },
      );
    }
    const svc = new MyService();
    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      const result = await svc.doWork();
      expect(result).toBe(42);
    });
  });

  it('handles concurrent sibling tracePath calls within same context [R3-H9]', async () => {
    const fnA = tracePath('runtime/guardrail/evaluate/pre-input', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'guard-ok';
    });
    const fnB = tracePath('runtime/llm/call/completion', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'llm-ok';
    });
    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      const [a, b] = await Promise.all([fnA(), fnB()]);
      expect(a).toBe('guard-ok');
      expect(b).toBe('llm-ok');
    });
    const str = collector.finalize();
    expect(str.app_paths).toHaveLength(2);
    expect(str.app_depths).toEqual([0, 0]);
  });

  it('tracks depth correctly at 3+ levels of nesting [R3-H9]', async () => {
    const level2 = tracePath('runtime/tool/call/invoke', async () => 'deep');
    const level1 = tracePath('runtime/llm/call/completion', async () => level2());
    const level0 = tracePath('runtime/executor/execute/reasoning', async () => level1());
    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      await level0();
    });
    const str = collector.finalize();
    expect(str.app_depths).toEqual([0, 1, 2]);
  });

  it('records nested paths with correct depth [R1-C7]', async () => {
    const inner = tracePath('runtime/llm/call/completion', async () => 'response');
    const outer = tracePath('runtime/executor/execute/dispatch', async () => inner());

    const collector = createStrCollector(collectorCtx);
    await withStiContext(collector, async () => {
      await outer();
    });
    const str = collector.finalize();

    expect(str.app_paths).toEqual([
      'runtime/executor/execute/dispatch',
      'runtime/llm/call/completion',
    ]);
    expect(str.app_depths).toEqual([0, 1]);
  });

  it('does not propagate STI errors when recordEntry throws [R1-C2]', async () => {
    const fn = vi.fn().mockResolvedValue('the-result');
    const wrapped = tracePath('runtime/llm/call/completion', fn);

    const throwingCollector = {
      recordEntry() {
        throw new Error('collector exploded');
      },
      recordSystemComponent() {},
      finalize: () => createStrCollector(collectorCtx).finalize(),
    };

    let result: unknown;
    await _runWithCollector(throwingCollector as any, async () => {
      result = await wrapped('arg');
    });

    expect(fn).toHaveBeenCalledWith('arg');
    expect(result).toBe('the-result');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — module not found

**Step 3: Write implementation**

**CRITICAL: Uses `AsyncLocalStorage.run()`, NOT `enterWith()` [R1-C1, R1-C7]**

```typescript
// packages/sti/src/trace-path.ts
import type { StrCollector } from './str-collector.js';
import { AsyncLocalStorage } from 'node:async_hooks'; // [R1-C4] node: prefix for NodeNext

/**
 * AsyncLocalStorage-backed STI context.
 * Uses run() — NOT enterWith() — so each request's async chain gets
 * an isolated context that cannot corrupt sibling requests. [R1-C1]
 */
interface StiContext {
  readonly collector: StrCollector;
  readonly depth: number;
}

const stiStore = new AsyncLocalStorage<StiContext>();

/**
 * Run a function with an STI collector bound to the current async chain.
 * All tracePath() wrappers in this chain record to this collector.
 * Context is automatically scoped and cleaned up when fn completes.
 */
export function withStiContext<T>(collector: StrCollector, fn: () => Promise<T>): Promise<T> {
  return stiStore.run({ collector, depth: 0 }, fn);
}

/** Get the current STI context (if any) */
export function getStiContext(): StiContext | undefined {
  return stiStore.getStore();
}

/** Test-only: run fn with a collector injected into ALS */
export function _runWithCollector<T>(collector: StrCollector, fn: () => Promise<T>): Promise<T> {
  return stiStore.run({ collector, depth: 0 }, fn);
}

/**
 * Higher-order function that wraps an async function with STI coordinate recording.
 *
 * Usage:
 *   const executeAgent = tracePath('runtime/executor/execute/dispatch', async (session, msg) => {
 *     // original implementation
 *   });
 *
 * When an STI context is active (via withStiContext), records:
 * - The path string as an application plane coordinate
 * - Success/failure outcome
 * - Duration in microseconds
 *
 * When no context is active, the wrapper is a zero-overhead passthrough.
 * STI's own operations are wrapped in try/catch — NEVER propagates to app code [R1-C2].
 * Depth is tracked via immutable context snapshots — concurrent-safe [R1-C7].
 */
export function tracePath<T extends (...args: any[]) => Promise<any>>(path: string, fn: T): T {
  const traced = async function (this: unknown, ...args: unknown[]) {
    const ctx = stiStore.getStore();
    if (!ctx) return fn.apply(this, args);

    // Capture current depth before potential increment [R1-C7]
    const currentDepth = ctx.depth;
    let entry: ReturnType<StrCollector['recordEntry']>;
    try {
      entry = ctx.collector.recordEntry(path, currentDepth);
    } catch {
      // STI recording failed — execute the function untraced [R1-C2]
      return fn.apply(this, args);
    }

    // Run nested call with incremented depth via immutable snapshot [R1-C7]
    return stiStore.run({ collector: ctx.collector, depth: currentDepth + 1 }, async () => {
      try {
        const result = await fn.apply(this, args);
        try {
          entry.recordSuccess(process.hrtime.bigint());
        } catch {
          /* swallow STI error */
        }
        return result;
      } catch (err) {
        try {
          entry.recordFailure(process.hrtime.bigint());
        } catch {
          /* swallow STI error */
        }
        throw err; // always re-throw application errors
      }
    });
  } as unknown as T;

  Object.defineProperty(traced, 'name', {
    value: `traced(${fn.name || path})`,
    configurable: true,
  });

  return traced;
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './trace-path.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/trace-path.ts packages/sti/src/__tests__/trace-path.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): tracePath() HOF wrapper with AsyncLocalStorage context"
```

---

## Task 6: ClickHouse DDL — `spatial_trace_records` Table + Buffer

**Files:**

- Create: `packages/sti/src/__tests__/ddl.test.ts`
- Create: `packages/sti/src/ddl.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the failing test**

```typescript
// packages/sti/src/__tests__/ddl.test.ts
import { describe, it, expect } from 'vitest';
import { getCreateMainTableDDL, getCreateBufferTableDDL } from '../ddl.js';

describe('STI DDL', () => {
  describe('main table', () => {
    it('creates spatial_trace_records with MergeTree', () => {
      const ddl = getCreateMainTableDDL(false);
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records');
      expect(ddl).toContain('MergeTree()');
      expect(ddl).toContain('trace_id');
      expect(ddl).toContain('app_paths');
      expect(ddl).toContain('sys_components');
      expect(ddl).toContain('config_hash_full');
      expect(ddl).toContain('config_hash_tenant');
      expect(ddl).toContain('is_truncated');
      expect(ddl).toContain('config_hash_system'); // [R1-C5] Phase 1+ column
      expect(ddl).toContain('app_coords'); // [R1-C5] Phase 1+ column
      expect(ddl).toContain('app_decisions'); // [R1-C5] Phase 1+ column
      expect(ddl).toContain('ORDER BY (tenant_id, project_id, timestamp, trace_id)');
      expect(ddl).toContain('bloom_filter');
      expect(ddl).toContain('TTL timestamp + INTERVAL 90 DAY');
    });

    it('uses ReplicatedMergeTree when replicated=true', () => {
      const ddl = getCreateMainTableDDL(true);
      expect(ddl).toContain('ReplicatedMergeTree()');
    });
  });

  describe('buffer table', () => {
    it('creates buffer table referencing main table', () => {
      const ddl = getCreateBufferTableDDL();
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records_buffer');
      expect(ddl).toContain('Buffer(abl_platform, spatial_trace_records');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — module not found

**Step 3: Write DDL implementation**

```typescript
// packages/sti/src/ddl.ts

/**
 * DDL for the spatial_trace_records main table.
 * Reference: Design doc §"ClickHouse Physical Schema"
 */
export function getCreateMainTableDDL(replicated: boolean): string {
  const engine = replicated ? 'ReplicatedMergeTree()' : 'MergeTree()';
  return `
    CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records (
      trace_id            String,
      segment_id          String DEFAULT '0',
      timestamp           DateTime64(6),
      config_hash_full    String,
      config_hash_system  String DEFAULT '',       -- Phase 1+ [R1-C5]
      config_hash_tenant  String,
      code_version        String,
      ir_schema           UInt16,
      deploy_id           String,
      app_paths           Array(String),
      app_depths          Array(UInt8),
      app_coords          Array(Array(Int32)),      -- Phase 1+: integer coordinates [R1-C5]
      app_decisions       Array(Array(Int16)),      -- Phase 1+: decision vectors [R1-C5]
      app_outcomes        Array(UInt8),
      app_durations       Array(UInt64),
      sys_components      Map(String, Array(Float32)),
      timings             Array(UInt64),
      duration_us         UInt64,
      is_async_boundary   Bool DEFAULT false,
      is_truncated        Bool DEFAULT false,
      tenant_id           String,
      project_id          String,
      agent_id            String,
      INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1
    ) ENGINE = ${engine}
    PARTITION BY toYYYYMMDD(timestamp)
    ORDER BY (tenant_id, project_id, timestamp, trace_id)
    TTL timestamp + INTERVAL 90 DAY DELETE;
  `.trim();
}

/**
 * DDL for the Buffer engine table that absorbs write bursts.
 * Buffer params: min_time=5s, max_time=30s, min_rows=1000, max_rows=10000,
 *                min_bytes=1MB, max_bytes=10MB
 */
export function getCreateBufferTableDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records_buffer
    AS abl_platform.spatial_trace_records
    ENGINE = Buffer(abl_platform, spatial_trace_records, 16, 1, 5, 1000, 10000, 1048576, 10485760);
  `.trim();
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './ddl.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/ddl.ts packages/sti/src/__tests__/ddl.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): ClickHouse DDL for spatial_trace_records + buffer table"
```

---

## Task 7: STI Writer — ClickHouse Write Path

**Files:**

- Create: `packages/sti/src/__tests__/sti-writer.test.ts`
- Create: `packages/sti/src/sti-writer.ts`
- Modify: `packages/sti/src/index.ts`

**Step 1: Write the failing tests**

```typescript
// packages/sti/src/__tests__/sti-writer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStiWriter } from '../sti-writer.js';
import type { SpatialTraceRecord } from '../types.js';

// Mock the BufferedClickHouseWriter
const mockInsert = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@agent-platform/database/clickhouse', () => ({
  BufferedClickHouseWriter: vi.fn().mockImplementation(() => ({
    insert: mockInsert,
    flush: mockFlush,
    close: mockClose,
    get pending() {
      return 0;
    },
    getMetrics: () => ({
      table: 'test',
      pending: 0,
      utilizationPercent: 0,
      totalWrites: 0,
      totalRows: 0,
      consecutiveFailures: 0,
      secondsSinceLastFlush: 0,
    }),
  })),
  getClickHouseClient: vi.fn().mockReturnValue({}),
}));

describe('StiWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleStr: SpatialTraceRecord = {
    trace_id: 'trace-001',
    segment_id: '1234-1',
    timestamp: new Date('2026-03-11T10:00:00Z'),
    config_hash_full: 'full-hash',
    config_hash_tenant: 'tenant-hash',
    code_version: 'v1.0.0',
    ir_schema: 1,
    deploy_id: 'deploy-1',
    app_paths: ['runtime/executor/agent/dispatch'],
    app_depths: [0],
    app_outcomes: [0],
    app_durations: [1500],
    sys_components: { mongodb: [1200, 50, 0, 30] },
    timings: [0],
    duration_us: 5000,
    is_async_boundary: false,
    is_truncated: false,
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    agent_id: 'agent-1',
  };

  it('writes an STR to the buffered writer', () => {
    const writer = createStiWriter();
    writer.write(sampleStr);
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const row = mockInsert.mock.calls[0][0];
    expect(row.trace_id).toBe('trace-001');
    expect(row.app_paths).toEqual(['runtime/executor/agent/dispatch']);
    expect(row.tenant_id).toBe('tenant-1');
  });

  it('skips write when disabled', () => {
    const writer = createStiWriter({ enabled: false });
    writer.write(sampleStr);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('flush delegates to buffered writer', async () => {
    const writer = createStiWriter();
    await writer.flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('close delegates to buffered writer', async () => {
    const writer = createStiWriter();
    await writer.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/sti/src/sti-writer.ts
import { BufferedClickHouseWriter, getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform'; // [R3-H1]
import type { SpatialTraceRecord } from './types.js';

const log = createLogger('sti-writer'); // [R3-H1]

export interface StiWriterOptions {
  enabled?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface StiWriter {
  write(str: SpatialTraceRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Creates an STI writer that buffers and flushes STRs to ClickHouse.
 * Uses the existing BufferedClickHouseWriter from @agent-platform/database.
 *
 * Writes to the Buffer table (spatial_trace_records_buffer) which
 * auto-flushes to the main table.
 */
export function createStiWriter(options?: StiWriterOptions): StiWriter {
  const enabled = options?.enabled ?? true;

  if (!enabled) {
    return {
      write() {},
      async flush() {},
      async close() {},
    };
  }

  const client = getClickHouseClient();
  const writer = new BufferedClickHouseWriter<Record<string, unknown>>(client, {
    table: 'abl_platform.spatial_trace_records_buffer',
    batchSize: options?.batchSize ?? 1000,
    flushIntervalMs: options?.flushIntervalMs ?? 5000,
    // [R1-H3, R3-H1] Log flush errors via structured logger (not console.error)
    onError: (error, context) => {
      log.error('ClickHouse write failed', {
        error: error instanceof Error ? error.message : String(error),
        table: context.table,
        pending: context.pending,
        retries: context.retries,
      });
    },
  });

  return {
    write(str: SpatialTraceRecord) {
      writer.insert({
        trace_id: str.trace_id,
        segment_id: str.segment_id,
        timestamp: str.timestamp.toISOString(),
        config_hash_full: str.config_hash_full,
        config_hash_tenant: str.config_hash_tenant,
        code_version: str.code_version,
        ir_schema: str.ir_schema,
        deploy_id: str.deploy_id,
        app_paths: str.app_paths,
        app_depths: str.app_depths,
        app_outcomes: str.app_outcomes,
        app_durations: str.app_durations,
        sys_components: str.sys_components,
        timings: str.timings,
        duration_us: Math.round(str.duration_us),
        is_async_boundary: str.is_async_boundary,
        is_truncated: str.is_truncated,
        tenant_id: str.tenant_id,
        project_id: str.project_id,
        agent_id: str.agent_id,
      });
    },

    async flush() {
      await writer.flush();
    },

    async close() {
      await writer.close();
    },
  };
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './sti-writer.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/sti-writer.ts packages/sti/src/__tests__/sti-writer.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): STI writer using BufferedClickHouseWriter"
```

---

## Task 8: STI Lifecycle — Request-Level Integration

**CRITICAL: This task was redesigned in Round 2. Uses `runTrace()` callback API, NOT `beginTrace()`/`endTrace()` imperative API. [R1-C1]**

**Files:**

- Create: `packages/sti/src/__tests__/lifecycle.test.ts`
- Create: `packages/sti/src/lifecycle.ts`
- Create: `packages/sti/src/ci-writer.ts` (CI mode JSONL writer [R1-G2])
- Modify: `packages/sti/src/index.ts`

This module provides `runTrace(ctx, fn)` which scopes an STI collector to `fn`'s async chain using `AsyncLocalStorage.run()`.

**Step 1: Write the failing tests**

```typescript
// packages/sti/src/__tests__/lifecycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTrace, _setWriter, shutdownSti } from '../lifecycle.js';
import { tracePath } from '../trace-path.js';
import { StiOutcome, _resetConfig } from '../types.js'; // [R3-C1]
import type { SpatialTraceRecord } from '../types.js';

const mockWrite = vi.fn();

describe('STI lifecycle', () => {
  beforeEach(() => {
    mockWrite.mockClear();
    _resetConfig(); // [R3-C1] CRITICAL: clear cached config so vi.stubEnv takes effect
    _setWriter({
      write: mockWrite,
      async flush() {},
      async close() {},
    });
    // REQUIRED: without this, resolveConfig() returns enabled: false [R1-G5]
    vi.stubEnv('STI_MODE', 'production');
  });

  afterEach(() => {
    _resetConfig(); // [R3-C1] Clean up for next test
    vi.unstubAllEnvs();
  });

  const baseCtx = {
    traceId: 'trace-lifecycle-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    deployId: 'deploy-1',
    configHashFull: 'full',
    configHashTenant: 'tenant',
    codeVersion: 'v1',
    irSchema: 1,
  };

  it('runTrace runs the callback and writes an STR on completion', async () => {
    const doWork = tracePath('runtime/executor/execute/reasoning', async () => 'result');

    await runTrace(baseCtx, async () => {
      await doWork();
    });

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const str: SpatialTraceRecord = mockWrite.mock.calls[0][0];
    expect(str.trace_id).toBe('trace-lifecycle-001');
    expect(str.app_paths).toContain('runtime/executor/execute/reasoning');
    expect(str.app_outcomes[0]).toBe(StiOutcome.Success);
  });

  it('does not write empty STRs (no tracePath calls)', async () => {
    await runTrace({ ...baseCtx, traceId: 'trace-empty' }, async () => {
      // no tracePath calls
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('records failure outcome and still propagates the application error', async () => {
    const failingFn = tracePath('runtime/tool/call/invoke', async () => {
      throw new Error('tool failure');
    });

    await expect(
      runTrace({ ...baseCtx, traceId: 'trace-fail' }, async () => {
        await failingFn();
      }),
    ).rejects.toThrow('tool failure');

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const str: SpatialTraceRecord = mockWrite.mock.calls[0][0];
    expect(str.app_outcomes[0]).toBe(StiOutcome.Failure);
  });

  it('records nested paths with correct depth', async () => {
    const inner = tracePath('runtime/llm/call/completion', async () => 'response');
    const outer = tracePath('runtime/executor/execute/reasoning', async () => inner());

    await runTrace({ ...baseCtx, traceId: 'trace-nested' }, async () => {
      await outer();
    });

    const str: SpatialTraceRecord = mockWrite.mock.calls[0][0];
    expect(str.app_paths).toEqual([
      'runtime/executor/execute/reasoning',
      'runtime/llm/call/completion',
    ]);
    expect(str.app_depths).toEqual([0, 1]);
  });

  it('is a no-op when STI_MODE=disabled — callback still executes', async () => {
    vi.stubEnv('STI_MODE', 'disabled');
    _resetConfig(); // [R3-C1] Reset so resolveConfig() picks up new STI_MODE

    await runTrace(baseCtx, async () => {
      // no-op
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('shutdownSti flushes and closes the writer [R3-H10]', async () => {
    const mockFlush = vi.fn().mockResolvedValue(undefined);
    const mockClose = vi.fn().mockResolvedValue(undefined);
    _setWriter({ write: mockWrite, flush: mockFlush, close: mockClose });
    await shutdownSti();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('shutdownSti is safe to call twice [R3-H10]', async () => {
    await shutdownSti();
    await expect(shutdownSti()).resolves.not.toThrow();
  });

  it('does not propagate writer.write() errors to caller [R2-T4]', async () => {
    _setWriter({
      write() {
        throw new Error('ClickHouse down');
      },
      async flush() {},
      async close() {},
    });

    const fn = tracePath('runtime/llm/call/completion', async () => 'ok');
    let threw = false;
    try {
      await runTrace(baseCtx, async () => {
        await fn();
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: FAIL — module not found

**Step 2b: Create CI mode JSONL writer [R1-G2]**

```typescript
// packages/sti/src/ci-writer.ts
import { appendFileSync } from 'node:fs';
import type { SpatialTraceRecord } from './types.js';
import type { StiWriter } from './sti-writer.js';

/**
 * CI mode STI writer — appends STRs as JSONL to a local file.
 * No ClickHouse dependency. Used when STI_MODE=ci.
 * Resource vectors (sys_components) are empty in CI — mocked clients
 * don't record system plane metrics.
 *
 * NOTE [R3-H2]: Uses appendFileSync intentionally — CI environments prioritize
 * simplicity and guaranteed writes over async I/O performance. This is never
 * used in production (STI_MODE=production uses BufferedClickHouseWriter).
 */
export function createCiStiWriter(outputPath?: string): StiWriter {
  const filePath = outputPath ?? process.env.STI_CI_OUTPUT ?? 'strs.jsonl';

  return {
    write(str: SpatialTraceRecord): void {
      const row = {
        trace_id: str.trace_id,
        segment_id: str.segment_id,
        timestamp: str.timestamp.toISOString(),
        config_hash_full: str.config_hash_full,
        config_hash_tenant: str.config_hash_tenant,
        code_version: str.code_version,
        ir_schema: str.ir_schema,
        deploy_id: str.deploy_id,
        app_paths: str.app_paths,
        app_depths: str.app_depths,
        app_outcomes: str.app_outcomes,
        app_durations: str.app_durations,
        sys_components: {},
        timings: str.timings,
        duration_us: Math.round(str.duration_us),
        is_async_boundary: str.is_async_boundary,
        is_truncated: str.is_truncated,
        tenant_id: str.tenant_id,
        project_id: str.project_id,
        agent_id: str.agent_id,
      };
      appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  };
}
```

**Step 3: Write lifecycle implementation**

```typescript
// packages/sti/src/lifecycle.ts
import { createStrCollector, type StrCollectorContext } from './str-collector.js';
import { withStiContext } from './trace-path.js';
import { createStiWriter, type StiWriter } from './sti-writer.js';
import { createCiStiWriter } from './ci-writer.js';
import { resolveConfig } from './types.js';

let sharedWriter: StiWriter | undefined;
let shuttingDown = false; // [R3-C2] Prevents orphaned writer creation during shutdown

/** No-op writer returned after shutdown to prevent orphaned instances [R3-C2] */
const NO_OP_WRITER: StiWriter = {
  write() {},
  async flush() {},
  async close() {},
};

function getWriter(): StiWriter {
  if (shuttingDown) return NO_OP_WRITER; // [R3-C2]
  if (!sharedWriter) {
    const config = resolveConfig();
    if (config.mode === 'ci') {
      sharedWriter = createCiStiWriter(); // [R1-G2] CI mode: JSONL
    } else {
      sharedWriter = createStiWriter({
        enabled: config.enabled,
        batchSize: config.batchSize,
        flushIntervalMs: config.flushIntervalMs,
      });
    }
  }
  return sharedWriter;
}

/** Override the shared writer (for testing) */
export function _setWriter(writer: StiWriter): void {
  sharedWriter = writer;
}

/**
 * Run an async function with STI tracing scoped to its async chain.
 * Uses AsyncLocalStorage.run() — safe under concurrency. [R1-C1]
 *
 * All tracePath() wrappers called within fn record to a single STR collector.
 * The STR is written to ClickHouse (or JSONL in CI mode) when fn completes.
 * Application errors are always re-thrown — STI never affects control flow.
 */
export async function runTrace<T>(ctx: StrCollectorContext, fn: () => Promise<T>): Promise<T> {
  const config = resolveConfig();
  if (!config.enabled) return fn();

  let collector;
  try {
    collector = createStrCollector(ctx, { maxEntries: config.maxEntriesPerStr });
  } catch (err) {
    // Collector creation failed — run fn untraced
    return fn();
  }

  let result: T;
  let fnError: unknown;
  let fnThrew = false;

  try {
    result = await withStiContext(collector, fn);
  } catch (err) {
    fnThrew = true;
    fnError = err;
  }

  // Finalize and write — wrapped in try/catch so writer errors never propagate [R2-T4]
  try {
    const str = collector.finalize();
    if (str.app_paths.length > 0) {
      getWriter().write(str);
    }
  } catch {
    // STI write failure — silently drop (onError callback on writer handles logging)
  }

  if (fnThrew) throw fnError;
  return result!;
}

/**
 * Graceful shutdown — flush pending STRs.
 * Sets shuttingDown flag so in-flight traces get a no-op writer [R3-C2].
 */
export async function shutdownSti(): Promise<void> {
  shuttingDown = true; // [R3-C2] Prevent new writer creation
  if (sharedWriter) {
    await sharedWriter.flush();
    await sharedWriter.close();
    sharedWriter = undefined;
  }
}
```

**Step 4: Export from barrel**

Add to `packages/sti/src/index.ts`:

```typescript
export * from './lifecycle.js';
export * from './ci-writer.js';
```

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/sti/src/lifecycle.ts packages/sti/src/ci-writer.ts packages/sti/src/__tests__/lifecycle.test.ts packages/sti/src/index.ts
git commit -m "feat(sti): request lifecycle with runTrace() callback + CI JSONL writer"
```

---

## Task 9: Add DDL to ClickHouse Schema Initialization

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts`

**Step 1: Read the current init.ts to find the right insertion point**

Read: `packages/database/src/clickhouse-schemas/init.ts` — find the `initClickHouseSchema` function and the list of CREATE TABLE statements.

**Step 2: Add STI DDL import and table creation**

At the end of the `initClickHouseSchema` function, after all existing table creation statements, add:

```typescript
// --- STI: Spatial Trace Records ---
const stiMainTable = `
  CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records (
    trace_id            String,
    segment_id          String DEFAULT '0',
    timestamp           DateTime64(6),
    config_hash_full    String,
    config_hash_system  String DEFAULT '',       -- Phase 1+ [R1-C5]
    config_hash_tenant  String,
    code_version        String,
    ir_schema           UInt16,
    deploy_id           String,
    app_paths           Array(String),
    app_depths          Array(UInt8),
    app_coords          Array(Array(Int32)),      -- Phase 1+ [R1-C5]
    app_decisions       Array(Array(Int16)),      -- Phase 1+ [R1-C5]
    app_outcomes        Array(UInt8),
    app_durations       Array(UInt64),
    sys_components      Map(String, Array(Float32)),
    timings             Array(UInt64),
    duration_us         UInt64,
    is_async_boundary   Bool DEFAULT false,
    is_truncated        Bool DEFAULT false,
    tenant_id           String,
    project_id          String,
    agent_id            String,
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = ${useReplicated ? 'ReplicatedMergeTree()' : 'MergeTree()'}
  PARTITION BY toYYYYMMDD(timestamp)
  ORDER BY (tenant_id, project_id, timestamp, trace_id)
  TTL timestamp + INTERVAL 90 DAY DELETE
`;
await client.command({ query: stiMainTable });

const stiBufferTable = `
  CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records_buffer
  AS abl_platform.spatial_trace_records
  ENGINE = Buffer(abl_platform, spatial_trace_records, 16, 1, 5, 1000, 10000, 1048576, 10485760)
`;
await client.command({ query: stiBufferTable });
```

**Important:** The main table MUST be created before the Buffer table (Buffer references the main table). This was a P2 bug fix in v5 of the design doc.

**Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/database`
Expected: Compiles with no errors

**Step 4: Commit**

```bash
git add packages/database/src/clickhouse-schemas/init.ts
git commit -m "feat(sti): add spatial_trace_records DDL to ClickHouse init"
```

---

## Task 10: Instrument Top 10 Hot Paths in Runtime

**Files:**

- Modify: `apps/runtime/package.json` (add `@agent-platform/sti` dependency)
- Create: `apps/runtime/src/services/sti-paths.ts` (wrapped functions)
- Modify: `apps/runtime/src/services/runtime-executor.ts` (wire beginTrace/endTrace + use wrapped functions)

**This is the largest task. Break into sub-steps.**

### Step 1: Add dependency

Add `"@agent-platform/sti": "workspace:*"` to `apps/runtime/package.json` dependencies.

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install`

### Step 2: Create instrumentation wrappers

Read the following files FIRST to verify actual function signatures before writing wrappers:

- `apps/runtime/src/services/runtime-executor.ts` — `executeMessage()` signature
- `apps/runtime/src/services/execution/flow-step-executor.ts` — `executeFlowStep()` signature
- `apps/runtime/src/services/execution/reasoning-executor.ts` — `execute()` and `executeToolCall()` signatures
- `apps/runtime/src/services/execution/routing-executor.ts` — `executeDelegate()` signature
- `packages/compiler/src/platform/guardrails/pipeline.ts` — `execute()` signature
- `apps/runtime/src/services/search-ai/search-ai-tool-executor.ts` — `execute()` signature
- `apps/runtime/src/channels/pipeline/message-pipeline.ts` — `executeAndPersist()` signature

**CRITICAL: Read each file before wrapping. Never guess signatures.**

The instrumentation approach for Phase 0a is **inline wrapping at call sites**, not wrapping the function definitions. This avoids modifying 10+ files scattered across the codebase. Instead, the `tracePath()` wrapper is applied where these functions are called from the main execution path.

Create `apps/runtime/src/services/sti-paths.ts`:

```typescript
// apps/runtime/src/services/sti-paths.ts
/**
 * STI Path Constants — the top 10 hot paths for Phase 0a.
 * These must be string literals from the controlled vocabulary.
 */
/**
 * STI Path Constants — 4-segment format: subsystem/component/action/detail [R1-H10]
 * All segments validated against packages/sti/taxonomy.json vocabulary.
 */
export const STI_PATHS = {
  SESSION_ENTRY: 'runtime/session/execute/entry',
  AGENT_DISPATCH_FLOW: 'runtime/executor/execute/flow-step',
  AGENT_DISPATCH_REASONING: 'runtime/executor/execute/reasoning',
  TOOL_CALL: 'runtime/tool/call/invoke',
  GUARDRAIL_EVAL: 'runtime/guardrail/evaluate/pre-input',
  LLM_CALL: 'runtime/llm/call/completion',
  HANDOFF: 'runtime/handoff/execute/transfer',
  SEARCH_QUERY: 'searchai/pipeline/query/retrieve',
  STATE_TRANSITION: 'runtime/state-machine/transition/step',
  CHANNEL_HANDLER: 'runtime/channel/execute/pipeline',
} as const;
```

### Step 3: Wire runTrace() into executeMessage [R1-C1, R1-X2, R1-X3, R1-X5]

In `apps/runtime/src/services/runtime-executor.ts`, at the top of `executeMessage()`:

```typescript
import { runTrace, getStiContext } from '@agent-platform/sti';
import { STI_PATHS } from './sti-paths.js';
```

**CRITICAL: Recursive `executeMessage()` must NOT start a new trace — inherit parent context.**
Check `_executingSessions` guard or use `getStiContext()` to detect re-entrant calls:

```typescript
// At the start of executeMessage(), after session rehydration:
// [R3-L4] Safe: getStiContext() can only be non-undefined if we are inside a runTrace()
// callback chain for THIS request (ALS.run scoping guarantees isolation).
// If context exists, this is a recursive executeMessage() call (e.g., handoff re-entry)
// and should inherit the parent STI context rather than starting a new trace.
const alreadyTraced = getStiContext() !== undefined;

if (alreadyTraced) {
  // Recursive call (e.g. handoff re-entry) — inherit parent STI context
  return await executeMessageInner(session, message);
}

// Top-level call — wrap entire execution in runTrace() callback
return await runTrace(
  {
    traceId: sessionId, // [R3-H6] RuntimeSession has no traceId field — use sessionId
    tenantId: session.tenantId ?? '',
    projectId: session.projectId ?? '',
    agentId: session.agentName ?? '', // [R1-X2] not session.currentAgent
    deployId: session.versionInfo?.deploymentId ?? '', // [R1-X3] not session.deploymentId
    configHashFull: '', // Phase 0a: computed in Task 11
    configHashTenant: '', // Phase 0a: computed in Task 11
    codeVersion: process.env.STI_CODE_VERSION ?? 'unknown',
    irSchema: 1,
  },
  async () => executeMessageInner(session, message),
);
```

**Note:** Extract the body of `executeMessage()` into a private `executeMessageInner()` helper to avoid double-nesting the try/finally block.

### Step 4: Wrap key call sites with tracePath()

At each of the 10 hot path call sites within the execution flow, wrap the function call:

```typescript
import { tracePath } from '@agent-platform/sti';

// Example: wrapping LLM call in reasoning-executor.ts
// Before:
const result = await session.llmClient.chatWithToolUseStreamable(...);
// After:
const result = await tracePath(STI_PATHS.LLM_CALL, async () =>
  session.llmClient.chatWithToolUseStreamable(...)
)();
```

**Important [R1-H9]:** For class methods (`ReasoningExecutor`, `FlowStepExecutor`), prefer converting to class field syntax with `tracePath()` at class definition time — this creates the wrapper once at module load, not per-call. For standalone functions and factory returns, use inline `tracePath()` wrapping. See the class field pattern:

```typescript
// Class field pattern — wrapper created once at module load [R1-H9]
class ReasoningExecutor {
  readonly execute = tracePath(
    STI_PATHS.AGENT_DISPATCH_REASONING,
    async (session: RuntimeSession, message: string): Promise<ExecutionResult> => {
      // ... original implementation
    },
  );
}
```

**Apply tracePath wrapping at these call sites:**

1. **SESSION_ENTRY**: Wrap the entire body of `executeMessage()` (already covered by beginTrace/endTrace — the top-level entry is implicit)
2. **AGENT_DISPATCH_FLOW**: In runtime-executor.ts, where `flowStepExecutor.executeFlowStep()` is called
3. **AGENT_DISPATCH_REASONING**: In runtime-executor.ts, where `reasoningExecutor.execute()` is called
4. **TOOL_CALL**: In reasoning-executor.ts, where `executeToolCall()` is called
5. **GUARDRAIL_EVAL**: In the guardrail pipeline call site (wherever `guardrailPipeline.execute()` is called from runtime)
6. **LLM_CALL**: In reasoning-executor.ts, where `chatWithToolUseStreamable()` is called
7. **HANDOFF**: In routing-executor.ts, where `executeDelegate()` is called
8. **SEARCH_QUERY**: In search-ai-tool-executor.ts, where search tool execution happens
9. **STATE_TRANSITION**: In flow-step-executor.ts, where flow transitions are recorded
10. **CHANNEL_HANDLER**: In message-pipeline.ts, at `executeAndPersist()`

### Step 5: Verify build

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Compiles with no errors. Fix any type errors.

### Step 6: Commit

```bash
git add apps/runtime/package.json apps/runtime/src/services/sti-paths.ts apps/runtime/src/services/runtime-executor.ts
# + any other modified files
git commit -m "feat(sti): instrument top 10 hot paths with tracePath()"
```

---

## Task 11: Config Hash Integration

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts`

**Step 1: Read session-factory.ts and runtime-executor.ts to understand what config data is available at session creation time**

Look for: `dslContent`, `tenantConfig`, `featureFlags`, `deploymentId`, `agentVersions` — these are the inputs to config hash computation.

**Step 2: Compute config hashes at session creation**

In the session factory or runtime executor, after the agent is resolved/compiled, compute:

```typescript
import { computeConfigHashFull, computeConfigHashTenant } from '@agent-platform/sti';
import { createHash } from 'crypto';

// dslContentHash: hash of the DSL source or compiled IR
const dslContentHash = createHash('sha256')
  .update(resolvedAgent.dslContent ?? '')
  .digest('hex');

// tenantConfigHash: hash of tenant-specific config — sort keys for determinism [R1-H5]
const sortedConfig = JSON.stringify(
  session.tenantConfig ?? {},
  Object.keys(session.tenantConfig ?? {}).sort(),
);
const tenantConfigHash = createHash('sha256').update(sortedConfig).digest('hex');

// featureFlagsBitmap: stringify of active flags
const featureFlagsBitmap = JSON.stringify(session.featureFlags ?? {});

const configHashFull = computeConfigHashFull({
  dslContentHash,
  tenantConfigHash,
  featureFlagsBitmap,
  codeVersion: process.env.STI_CODE_VERSION ?? 'unknown',
  irSchemaVersion: 1,
});

const configHashTenant = computeConfigHashTenant({
  dslContentHash,
  tenantConfigHash,
  featureFlagsBitmap,
  codeVersion: process.env.STI_CODE_VERSION ?? 'unknown',
  irSchemaVersion: 1,
});
```

**Step 3: Pass config hashes to beginTrace**

Update the `beginTrace()` call from Task 10 to use the computed hashes instead of empty strings.

**Step 4: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Compiles with no errors

**Step 5: Commit**

```bash
git add apps/runtime/src/services/runtime-executor.ts
git commit -m "feat(sti): compute and attach config hashes to STI traces"
```

---

## Task 12: API Endpoint — Mode 0 (Trace Waterfall) + Mode 1 (Root Cause)

**Files:**

- Create: `apps/runtime/src/routes/sti.ts`
- Create: `apps/runtime/src/__tests__/sti-routes.test.ts`
- Modify: `apps/runtime/src/server.ts` (mount at `/api/admin/sti` — NOT `routes/index.ts` which doesn't exist [R1-X1])

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/sti-routes.test.ts
import { describe, it, expect, vi } from 'vitest';

// Test the query builder functions (unit test, no ClickHouse needed)
import { buildWaterfallQuery, buildRootCauseQuery } from '../routes/sti.js';

describe('STI routes', () => {
  describe('buildWaterfallQuery [R1-H6, R3-C4, R3-H4]', () => {
    it('builds a parameterized query with traceId + tenantId placeholders', () => {
      const query = buildWaterfallQuery();
      expect(query).toContain('{traceId:String}');
      expect(query).toContain('{tenantId:String}'); // [R3-C4]
      expect(query).toContain('spatial_trace_records');
      expect(query).toContain('ORDER BY timestamp');
      expect(query).toContain('LIMIT 1000'); // [R3-H4]
      expect(query).not.toContain("'${");
    });
  });

  describe('buildRootCauseQuery [R1-H6, R3-C4]', () => {
    it('builds a parameterized query with tenant filter', () => {
      const query = buildRootCauseQuery();
      expect(query).toContain('{traceId:String}');
      expect(query).toContain('{tenantId:String}'); // [R3-C4]
      expect(query).toContain('app_outcomes');
      expect(query).toContain('LIMIT 1000'); // [R3-H4]
    });
  });

  describe('traceId validation [R3-H11]', () => {
    it('rejects SQL injection characters', () => {
      const TRACE_ID_REGEX = /^[a-zA-Z0-9\-_]{1,128}$/;
      expect(TRACE_ID_REGEX.test("'; DROP TABLE --")).toBe(false);
      expect(TRACE_ID_REGEX.test('valid-trace-id-123')).toBe(true);
      expect(TRACE_ID_REGEX.test('trace_with_underscore')).toBe(true);
      expect(TRACE_ID_REGEX.test('')).toBe(false);
      expect(TRACE_ID_REGEX.test('a'.repeat(129))).toBe(false);
      expect(TRACE_ID_REGEX.test('a'.repeat(128))).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/runtime && pnpm --filter=@agent-platform/runtime test -- sti-routes`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// apps/runtime/src/routes/sti.ts
import { Router, type Request, type Response } from 'express';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js'; // [R3-C3] correct path + export
import { requirePermission } from '@agent-platform/shared-auth'; // [R3-C3]

const log = createLogger('sti-routes');
const router = Router();

const TRACE_ID_REGEX = /^[a-zA-Z0-9\-_]{1,128}$/; // [R1-H8, R3-L3] length cap added

// Auth: tenant-scoped [R1-C3, R3-C3]
router.use(authMiddleware);
router.use(requirePermission('tenant:manage_settings'));

/**
 * Parameterized ClickHouse queries — NEVER interpolate user input into SQL [R1-H6]
 */
export function buildWaterfallQuery(): string {
  return `
    SELECT
      trace_id, segment_id, timestamp, config_hash_full, config_hash_tenant,
      code_version, deploy_id, agent_id,
      app_paths, app_depths, app_outcomes, app_durations,
      sys_components, timings, duration_us,
      is_async_boundary, is_truncated,
      tenant_id, project_id
    FROM abl_platform.spatial_trace_records
    WHERE trace_id = {traceId:String}
      AND tenant_id = {tenantId:String}
    ORDER BY timestamp ASC
    LIMIT 1000
  `;
}

export function buildRootCauseQuery(): string {
  return `
    SELECT
      trace_id, segment_id, timestamp,
      app_paths, app_outcomes, app_durations,
      sys_components, duration_us,
      tenant_id, project_id, agent_id, deploy_id,
      config_hash_full, config_hash_tenant
    FROM abl_platform.spatial_trace_records
    WHERE trace_id = {traceId:String}
      AND tenant_id = {tenantId:String}
    ORDER BY timestamp ASC
    LIMIT 1000
  `;
}

/**
 * GET /api/sti/trace/:traceId
 *
 * Returns the STR waterfall for a given trace_id.
 * Mode 0: raw STR data for waterfall visualization.
 * Mode 1: root cause analysis — highlights failure paths and slow paths.
 */
router.get('/trace/:traceId', async (req: Request, res: Response) => {
  try {
    const { traceId } = req.params;
    const mode = req.query.mode === 'root-cause' ? 'root-cause' : 'waterfall';

    // [R3-C4] Extract tenantId from auth context for data isolation
    const tenantId = (req as any).tenantContext?.tenantId;
    if (!tenantId) {
      res
        .status(403)
        .json({ success: false, error: { code: 'NO_TENANT', message: 'Tenant context required' } });
      return;
    }

    // Validate traceId format before querying [R1-H8, R3-L3]
    if (!traceId || !TRACE_ID_REGEX.test(traceId)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TRACE_ID',
          message: 'traceId must be alphanumeric with hyphens/underscores (max 128 chars)',
        },
      });
      return;
    }

    const client = getClickHouseClient();
    const query = mode === 'root-cause' ? buildRootCauseQuery() : buildWaterfallQuery();

    // Parameterized query — traceId + tenantId passed via query_params, never interpolated [R1-H6, R3-C4]
    const result = await client.query({
      query,
      format: 'JSONEachRow',
      query_params: { traceId, tenantId },
    });
    const rows = await result.json();

    // [R3-H5] Observatory deep link for content-level drill-down
    const observatory_url = `/observatory?traceId=${encodeURIComponent(traceId)}`;

    if (mode === 'root-cause') {
      const analyzed = analyzeRootCause(rows as any[]);
      res.json({ success: true, data: { mode, traceId, segments: analyzed, observatory_url } });
      return;
    }

    res.json({ success: true, data: { mode, traceId, segments: rows, observatory_url } });
  } catch (err) {
    // [R3-H3] Log real error server-side, return generic message to client
    const message = err instanceof Error ? err.message : String(err);
    log.error('STI trace query failed', { error: message, traceId: req.params.traceId });
    res.status(500).json({
      success: false,
      error: { code: 'STI_QUERY_ERROR', message: 'Internal error querying trace data' },
    });
  }
});

/**
 * Basic root cause analysis — highlights:
 * - Failed paths (outcome != 0)
 * - Slowest paths (top 3 by duration)
 * - System components with high saturation or errors
 */
function analyzeRootCause(segments: any[]) {
  return segments.map((seg) => {
    const failures: Array<{ path: string; index: number; duration_us: number }> = [];
    const slow: Array<{ path: string; index: number; duration_us: number }> = [];

    const paths = seg.app_paths ?? [];
    const outcomes = seg.app_outcomes ?? [];
    const durations = seg.app_durations ?? [];

    for (let i = 0; i < paths.length; i++) {
      if (outcomes[i] !== 0) {
        failures.push({ path: paths[i], index: i, duration_us: durations[i] });
      }
    }

    // Top 3 slowest
    const indexed = durations.map((d: number, i: number) => ({
      path: paths[i],
      index: i,
      duration_us: d,
    }));
    indexed.sort((a: any, b: any) => b.duration_us - a.duration_us);
    slow.push(...indexed.slice(0, 3));

    // System plane issues
    const sysIssues: Array<{ component: string; issue: string }> = [];
    const components = seg.sys_components ?? {};
    for (const [name, vec] of Object.entries(components)) {
      const v = vec as number[];
      if (v[2] === 1) sysIssues.push({ component: name, issue: 'error' });
      if (v[3] > 80) sysIssues.push({ component: name, issue: `saturation ${v[3]}%` });
    }

    return {
      ...seg,
      _analysis: { failures, slow, sysIssues },
    };
  });
}

export default router;
```

**Step 4: Mount in server.ts [R1-X1]**

In `apps/runtime/src/server.ts` (around line ~511, after other route mounts), add:

```typescript
import stiRouter from './routes/sti.js';
// ...
app.use('/api/admin/sti', stiRouter);
```

**Note:** Auth is handled inside the router via `createUnifiedAuthMiddleware` + `requirePermission('tenant:manage_settings')` [R1-C3]. The `/api/admin/` prefix signals platform-team-only access.

**Step 5: Run tests**

Run: `pnpm build --filter=@agent-platform/runtime && pnpm --filter=@agent-platform/runtime test -- sti-routes`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add apps/runtime/src/routes/sti.ts apps/runtime/src/__tests__/sti-routes.test.ts apps/runtime/src/routes/index.ts
git commit -m "feat(sti): API endpoint — Mode 0 waterfall + Mode 1 root cause"
```

---

## Task 13: CI Coverage Script

**Files:**

- Create: `tools/sti-coverage.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# tools/sti-coverage.sh
# Reports tracePath() instrumentation coverage and writes sti-manifest.json [R1-G1, R1-G4].
# Usage:
#   bash tools/sti-coverage.sh                  # report only
#   bash tools/sti-coverage.sh --write-manifest # also write sti-manifest.json

set -euo pipefail

WRITE_MANIFEST=false
if [[ "${1:-}" == "--write-manifest" ]]; then
  WRITE_MANIFEST=true
fi

echo "=== STI Coverage Report ==="
echo ""

# Count call sites (lines, not files) [R1-G4 fix]
CALL_COUNT=$(grep -r "tracePath(" apps/ packages/ --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "__tests__" \
  | wc -l \
  | tr -d ' ')
echo "tracePath() call sites: $CALL_COUNT"

# Extract unique path strings (both quote styles)
PATHS_RAW=$(grep -roh "tracePath('[^']*'" apps/ packages/ --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "node_modules" | grep -v "__tests__" \
  | sort -u | sed "s/tracePath('//;s/'//")
PATHS_RAW2=$(grep -roh 'tracePath("[^"]*"' apps/ packages/ --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "node_modules" | grep -v "__tests__" \
  | sort -u | sed 's/tracePath("//;s/"//')
ALL_PATHS=$(printf '%s\n%s\n' "$PATHS_RAW" "$PATHS_RAW2" | sort -u | grep -v '^$')
PATH_COUNT=$(echo "$ALL_PATHS" | grep -c . || echo 0)

echo "Unique STI paths:       $PATH_COUNT"
echo ""
echo "--- Paths ---"
echo "$ALL_PATHS" | while IFS= read -r path; do echo "  $path"; done

echo ""
echo "--- Target: 10 paths (Phase 0a) ---"
if [ "$PATH_COUNT" -ge 10 ]; then
  echo "PASS: $PATH_COUNT >= 10"
else
  echo "WARN: $PATH_COUNT < 10 (need more instrumentation)"
fi

# Write manifest artifact [R1-G1]
if [[ "$WRITE_MANIFEST" == "true" ]]; then
  {
    echo "["
    first=true
    echo "$ALL_PATHS" | while IFS= read -r path; do
      if [[ "$first" == "true" ]]; then printf '  "%s"' "$path"; first=false
      else printf ',\n  "%s"' "$path"; fi
    done
    echo ""
    echo "]"
  } > sti-manifest.json
  echo ""
  echo "Written: sti-manifest.json ($PATH_COUNT paths)"
fi
```

**Step 2: Make executable**

Run: `chmod +x /Users/prasannaarikala/projects/agent-platform/tools/sti-coverage.sh`

**Step 3: Verify it runs**

Run: `bash /Users/prasannaarikala/projects/agent-platform/tools/sti-coverage.sh`
Expected: Shows count of tracePath calls (should be 10+ after Task 10)

**Step 4: Commit**

```bash
git add tools/sti-coverage.sh
git commit -m "feat(sti): CI coverage script for tracePath instrumentation count"
```

---

## Task 14: Dockerfile Update for `packages/sti/`

**Files:**

- Modify: `apps/runtime/Dockerfile`

Per CLAUDE.md: "When adding a new `packages/<name>/` workspace package, add its `COPY packages/<name>/package.json packages/<name>/package.json` line to every Dockerfile under `apps/` that uses `pnpm install --frozen-lockfile`."

**Step 1: Read Dockerfiles to find the COPY section**

Read:

- `apps/runtime/Dockerfile` — find the pattern for COPY package.json lines

**Step 2: Add the COPY line**

After the existing `packages/*/package.json` COPY lines, add:

```dockerfile
COPY packages/sti/package.json packages/sti/package.json
```

**Step 3: Check if other Dockerfiles need updating**

Read `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile` — add the COPY line if they also use `pnpm install --frozen-lockfile` and reference workspace packages.

**Note:** Only add to Dockerfiles of apps that actually depend on `@agent-platform/sti` (directly or transitively). For Phase 0a, only `apps/runtime` depends on it. But to be safe per CLAUDE.md, add to all Dockerfiles.

**Step 4: Verify Docker build (optional, local)**

Run: `docker build -f apps/runtime/Dockerfile . --target=deps` (just the dependency stage)
Expected: pnpm install succeeds

**Step 5: Commit**

```bash
git add apps/runtime/Dockerfile apps/search-ai/Dockerfile apps/admin/Dockerfile apps/studio/Dockerfile
git commit -m "chore: add packages/sti to Dockerfile COPY lines"
```

---

## Task 15: Integration Test — End-to-End STR Flow

**Files:**

- Create: `packages/sti/src/__tests__/integration.test.ts`

This test verifies the full flow: runTrace → tracePath calls → STR produced.

**Step 1: Write the integration test**

```typescript
// packages/sti/src/__tests__/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTrace, _setWriter } from '../lifecycle.js';
import { tracePath } from '../trace-path.js';
import { StiOutcome, _resetConfig } from '../types.js'; // [R3-C1]
import type { SpatialTraceRecord } from '../types.js';

describe('STI integration', () => {
  let writtenStrs: SpatialTraceRecord[];

  beforeEach(() => {
    writtenStrs = [];
    _resetConfig(); // [R3-C1] Clear cached config before stubbing env
    _setWriter({
      write(str: SpatialTraceRecord) {
        writtenStrs.push(str);
      },
      async flush() {},
      async close() {},
    });
    // [R1-G5] REQUIRED: without this, resolveConfig() returns disabled
    vi.stubEnv('STI_MODE', 'production');
  });

  afterEach(() => {
    _resetConfig(); // [R3-C1]
    vi.unstubAllEnvs();
  });

  it('full request lifecycle produces a valid STR', async () => {
    const callLLM = tracePath('runtime/llm/call/completion', async (prompt: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return `response to: ${prompt}`;
    });

    const evaluateGuardrail = tracePath('runtime/guardrail/evaluate/pre-input', async () => {
      return { passed: true };
    });

    const executeAgent = tracePath('runtime/executor/execute/reasoning', async () => {
      await evaluateGuardrail();
      const response = await callLLM('hello');
      return response;
    });

    // runTrace() callback pattern [R1-C1]
    await runTrace(
      {
        traceId: 'integration-trace-001',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'agent-1',
        deployId: 'deploy-1',
        configHashFull: 'full-hash-abc',
        configHashTenant: 'tenant-hash-xyz',
        codeVersion: 'v1.0.0-test',
        irSchema: 1,
      },
      async () => {
        await executeAgent();
      },
    );

    expect(writtenStrs.length).toBe(1);
    const str = writtenStrs[0];

    // Metadata
    expect(str.trace_id).toBe('integration-trace-001');
    expect(str.tenant_id).toBe('tenant-1');
    expect(str.config_hash_full).toBe('full-hash-abc');
    expect(str.config_hash_tenant).toBe('tenant-hash-xyz');

    // Application plane — 3 entries in execution order
    expect(str.app_paths).toEqual([
      'runtime/executor/execute/reasoning',
      'runtime/guardrail/evaluate/pre-input',
      'runtime/llm/call/completion',
    ]);
    expect(str.app_outcomes).toEqual([StiOutcome.Success, StiOutcome.Success, StiOutcome.Success]);

    // Depths — outer=0, inner=1, inner=1
    expect(str.app_depths).toEqual([0, 1, 1]);

    // Durations are non-negative
    for (const d of str.app_durations) {
      expect(d).toBeGreaterThanOrEqual(0);
    }

    expect(str.duration_us).toBeGreaterThan(0);
    expect(str.is_truncated).toBe(false);
  });

  it('handles errors without losing the STR', async () => {
    const failingFn = tracePath('runtime/tool/call/invoke', async () => {
      throw new Error('tool timeout');
    });

    await expect(
      runTrace(
        {
          traceId: 'error-trace-001',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          deployId: 'deploy-1',
          configHashFull: 'hash',
          configHashTenant: 'hash',
          codeVersion: 'v1',
          irSchema: 1,
        },
        async () => {
          await failingFn();
        },
      ),
    ).rejects.toThrow('tool timeout');

    expect(writtenStrs.length).toBe(1);
    expect(writtenStrs[0].app_outcomes).toEqual([StiOutcome.Failure]);
  });

  it('two concurrent requests with shared wrapper produce independent STRs [R2-T1, R3-L7]', async () => {
    // [R3-L7] Use SAME tracePath wrapper for stronger isolation proof —
    // proves the same function records to different collectors based on ALS context
    const sharedFn = tracePath('runtime/llm/call/completion', async (label: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return label;
    });

    await Promise.all([
      runTrace(
        {
          traceId: 'concurrent-A',
          tenantId: 'a',
          projectId: 'p',
          agentId: 'a1',
          deployId: 'd',
          configHashFull: 'fa',
          configHashTenant: 'ta',
          codeVersion: 'v1',
          irSchema: 1,
        },
        async () => {
          await sharedFn('a');
        },
      ),
      runTrace(
        {
          traceId: 'concurrent-B',
          tenantId: 'b',
          projectId: 'p',
          agentId: 'a1',
          deployId: 'd',
          configHashFull: 'fb',
          configHashTenant: 'tb',
          codeVersion: 'v1',
          irSchema: 1,
        },
        async () => {
          await sharedFn('b');
        },
      ),
    ]);

    expect(writtenStrs).toHaveLength(2);
    const strA = writtenStrs.find((s) => s.trace_id === 'concurrent-A')!;
    const strB = writtenStrs.find((s) => s.trace_id === 'concurrent-B')!;

    // Both call the same path but record to separate collectors
    expect(strA.app_paths).toEqual(['runtime/llm/call/completion']);
    expect(strB.app_paths).toEqual(['runtime/llm/call/completion']);
    // But they have different trace IDs — proving isolation
    expect(strA.trace_id).toBe('concurrent-A');
    expect(strB.trace_id).toBe('concurrent-B');
  });
});
```

**Step 2: Run tests**

Run: `pnpm build --filter=@agent-platform/sti && pnpm --filter=@agent-platform/sti test`
Expected: All tests PASS (including integration test)

**Step 3: Commit**

```bash
git add packages/sti/src/__tests__/integration.test.ts
git commit -m "test(sti): integration test — full request lifecycle"
```

---

## Task Summary

| Task | Component                     | Est. Time | Dependencies  |
| ---- | ----------------------------- | --------- | ------------- |
| 1    | Package scaffold + taxonomy   | 3 min     | —             |
| 2    | Core types                    | 3 min     | Task 1        |
| 3    | Config hash (with separators) | 5 min     | Task 2        |
| 4    | STR collector (UUID + caps)   | 5 min     | Task 2        |
| 5    | tracePath() HOF (run() API)   | 5 min     | Task 4        |
| 6    | ClickHouse DDL (+3 cols)      | 3 min     | Task 2        |
| 7    | STI writer (with onError)     | 5 min     | Task 2        |
| 8    | Lifecycle (runTrace + CI)     | 8 min     | Tasks 4, 5, 7 |
| 9    | DDL in init.ts                | 3 min     | Task 6        |
| 10   | Instrument hot paths          | 15 min    | Tasks 5, 8    |
| 11   | Config hash integration       | 5 min     | Tasks 3, 10   |
| 12   | API endpoint (auth+param)     | 10 min    | Task 9        |
| 13   | CI coverage + manifest        | 3 min     | Task 10       |
| 14   | Dockerfile update             | 3 min     | Task 1        |
| 15   | Integration + concurrency     | 8 min     | Tasks 5, 8    |

**Total: ~82 minutes of implementation time**

**After all tasks, run:**

```bash
pnpm build && pnpm test
npx prettier --write "packages/sti/**/*.ts" "apps/runtime/src/services/sti-paths.ts" "apps/runtime/src/routes/sti.ts"
bash tools/sti-coverage.sh --write-manifest
```

**Validation gate (Phase 0a done when):**

1. `STI_MODE=production` env var enables STI in runtime
2. STRs flow into ClickHouse `spatial_trace_records` table
3. `GET /api/admin/sti/trace/:traceId` returns STR waterfall data (authenticated)
4. `GET /api/admin/sti/trace/:traceId?mode=root-cause` highlights failures and slow paths
5. CI script reports 10+ instrumented paths + generates `sti-manifest.json`
6. All tests pass (including concurrent isolation test)
7. `STI_MODE=ci` writes JSONL instead of ClickHouse
8. Parameterized ClickHouse queries (no SQL injection vectors)
