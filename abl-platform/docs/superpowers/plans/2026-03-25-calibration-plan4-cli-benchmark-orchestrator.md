# Calibration Pipeline — Plan 4: CLI Benchmark Orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sizing benchmark`, `sizing benchmark-service`, and `sizing calibration-merge` CLI subcommands to `packages/kore-platform-cli/` that orchestrate the full saturation pipeline: pre-flight checks, per-service scale-down, k6 invocation, Coroot metrics collection, replica restore, saturation detection, and CalibrationProfile assembly.

**Architecture:** The orchestrator is a pure CLI layer that coordinates external tools (kubectl, k6) via child processes and the Coroot collector (from Plan 3) via function calls. It does not contain sizing logic itself — it collects raw benchmark data and assembles it into a `CalibrationProfile` that the sizing calculator (Plan 1) consumes. Service registry and category resolution are self-contained in the new file. All kubectl operations use a `finally`-based restore pattern to guarantee replica restoration even on failure.

**Tech Stack:** TypeScript, Commander.js, Zod (for validation), child_process (spawn), Vitest (unit tests mock child_process/kubectl)

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Sections 8, 11, 13

**Dependencies:** Plan 1 (CalibrationProfile types, CalibrationProfileSchema, Zod validation), Plan 2 (saturation k6 scripts in `benchmarks/saturation/`), Plan 3 (coroot-collector module)

**Plan series:** This is Plan 4 of 6. It wires together the collection infrastructure from Plans 1-3 into a user-facing CLI.

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| 1            | Data Model + Traffic Model + Sizing Calculator | —      |
| 2            | Saturation k6 Scripts + Shared Lib             | —      |
| 3            | Coroot Metrics Collector                       | —      |
| **4 (this)** | CLI Benchmark Orchestrator                     | —      |
| 5            | Report Generation                              | —      |
| 6            | Shell Script Updates (service groups)          | —      |

---

## File Structure

### New Files

| File                                                                                      | Responsibility                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/kore-platform-cli/src/commands/sizing-benchmark.ts`                             | Main orchestrator: `sizing benchmark`, `sizing benchmark-service`, `sizing calibration-merge`    |
| `packages/kore-platform-cli/src/commands/benchmark/service-registry.ts`                   | `SERVICE_REGISTRY` map, `SERVICE_CATEGORIES` map, `resolveServices()` category expansion         |
| `packages/kore-platform-cli/src/commands/benchmark/kubectl-ops.ts`                        | `recordReplicas()`, `scaleDown()`, `restoreReplicas()`, `getPodResources()`, `waitForPodReady()` |
| `packages/kore-platform-cli/src/commands/benchmark/k6-runner.ts`                          | `runK6Saturation()` — spawn k6 process, parse JSON summary, return structured result             |
| `packages/kore-platform-cli/src/commands/benchmark/saturation-detector.ts`                | `detectSaturation()` — multi-signal detection (error-rate, latency, CPU, connections)            |
| `packages/kore-platform-cli/src/commands/benchmark/profile-assembler.ts`                  | `assembleProfile()`, `mergeProfiles()` — combine service results into CalibrationProfile         |
| `packages/kore-platform-cli/src/commands/benchmark/preflight.ts`                          | `runPreflight()` — verify kubectl, namespace, Coroot connectivity, k6 binary                     |
| `packages/kore-platform-cli/src/__tests__/commands/sizing-benchmark.test.ts`              | Unit tests for CLI command registration, option parsing, dry-run output                          |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/service-registry.test.ts`    | Unit tests for category resolution, service lookup, combined category+name resolution            |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/kubectl-ops.test.ts`         | Unit tests for kubectl operations (mock child_process)                                           |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/k6-runner.test.ts`           | Unit tests for k6 invocation and JSON summary parsing                                            |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/saturation-detector.test.ts` | Unit tests for multi-signal saturation detection                                                 |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/profile-assembler.test.ts`   | Unit tests for profile assembly and merge                                                        |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/preflight.test.ts`           | Unit tests for preflight checks                                                                  |
| `packages/kore-platform-cli/src/__tests__/commands/benchmark/fixtures/k6-summary.json`    | Fixture: realistic k6 JSON summary output for parser tests                                       |

### Modified Files

| File                                                | Changes                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/kore-platform-cli/src/commands/sizing.ts` | Import and call `registerBenchmarkCommands(sizing)` from new file |

---

## Task 1: Service Registry and Category Resolution

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/service-registry.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/service-registry.test.ts`

- [ ] **Step 1: Write the test file first** (~3 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/service-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SERVICE_REGISTRY,
  SERVICE_CATEGORIES,
  resolveServices,
  SERVICE_TEST_ORDER,
} from '../../commands/benchmark/service-registry.js';

describe('SERVICE_REGISTRY', () => {
  it('contains all benchmarkable services from the design spec', () => {
    const expected = [
      'runtime',
      'studio',
      'admin',
      'search-ai',
      'search-ai-runtime',
      'bge-m3',
      'docling',
      'preprocessing',
      'workflow-engine',
      'mongodb',
      'redis',
      'clickhouse',
      'opensearch',
      'qdrant',
      'neo4j',
      'restate',
    ];
    for (const svc of expected) {
      expect(SERVICE_REGISTRY).toHaveProperty(svc);
    }
  });

  it('each entry has configKey and k6Script', () => {
    for (const [name, entry] of Object.entries(SERVICE_REGISTRY)) {
      expect(entry.configKey).toBeTruthy();
      expect(entry.k6Script).toMatch(/^saturation\//);
      expect(entry.category).toBeTruthy();
    }
  });
});

describe('SERVICE_CATEGORIES', () => {
  it('defines @compute, @data-stores, @ai, @integration categories', () => {
    expect(SERVICE_CATEGORIES).toHaveProperty('@compute');
    expect(SERVICE_CATEGORIES).toHaveProperty('@data-stores');
    expect(SERVICE_CATEGORIES).toHaveProperty('@ai');
    expect(SERVICE_CATEGORIES).toHaveProperty('@integration');
    expect(SERVICE_CATEGORIES).toHaveProperty('@all');
  });

  it('@compute contains runtime, studio, admin', () => {
    expect(SERVICE_CATEGORIES['@compute']).toEqual(
      expect.arrayContaining(['runtime', 'studio', 'admin']),
    );
  });

  it('@data-stores contains mongodb, redis, opensearch, qdrant, clickhouse', () => {
    expect(SERVICE_CATEGORIES['@data-stores']).toEqual(
      expect.arrayContaining(['mongodb', 'redis', 'opensearch', 'qdrant', 'clickhouse']),
    );
  });

  it('@ai contains search-ai, search-ai-runtime, bge-m3, docling, preprocessing', () => {
    expect(SERVICE_CATEGORIES['@ai']).toEqual(
      expect.arrayContaining([
        'search-ai',
        'search-ai-runtime',
        'bge-m3',
        'docling',
        'preprocessing',
      ]),
    );
  });
});

describe('resolveServices', () => {
  it('returns all services when input is undefined', () => {
    const result = resolveServices(undefined);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(SERVICE_TEST_ORDER);
  });

  it('resolves a single service name', () => {
    const result = resolveServices('runtime');
    expect(result).toEqual(['runtime']);
  });

  it('resolves comma-separated service names', () => {
    const result = resolveServices('runtime,bge-m3');
    expect(result).toEqual(['runtime', 'bge-m3']);
  });

  it('resolves @compute category', () => {
    const result = resolveServices('@compute');
    expect(result).toEqual(expect.arrayContaining(['runtime', 'studio', 'admin']));
  });

  it('resolves mixed categories and service names', () => {
    const result = resolveServices('@data-stores,bge-m3');
    expect(result).toContain('mongodb');
    expect(result).toContain('redis');
    expect(result).toContain('bge-m3');
  });

  it('deduplicates when service appears in both category and explicit list', () => {
    const result = resolveServices('@compute,runtime');
    const runtimeCount = result.filter((s) => s === 'runtime').length;
    expect(runtimeCount).toBe(1);
  });

  it('throws on unknown service name', () => {
    expect(() => resolveServices('nonexistent-service')).toThrow(/unknown service/i);
  });

  it('throws on unknown category', () => {
    expect(() => resolveServices('@nonexistent')).toThrow(/unknown category/i);
  });
});

describe('SERVICE_TEST_ORDER', () => {
  it('orders data stores before compute before app services', () => {
    const mongoIdx = SERVICE_TEST_ORDER.indexOf('mongodb');
    const runtimeIdx = SERVICE_TEST_ORDER.indexOf('runtime');
    const bgeIdx = SERVICE_TEST_ORDER.indexOf('bge-m3');

    // Data stores first
    expect(mongoIdx).toBeLessThan(bgeIdx);
    // AI/compute before app services
    expect(bgeIdx).toBeLessThan(runtimeIdx);
  });
});
```

- [ ] **Step 2: Write the service registry module** (~5 min)

Create `packages/kore-platform-cli/src/commands/benchmark/service-registry.ts`:

```typescript
/**
 * Service Registry for Benchmark Orchestration
 *
 * Maps service names to their k6 script paths, config keys, and categories.
 * Provides category resolution (@compute, @data-stores, @ai, @integration)
 * and bottom-up test ordering (data stores → AI → app services).
 */

export interface ServiceRegistryEntry {
  /** Key in benchmarks/config/cloud.env for URL resolution */
  configKey: string;
  /** Path to k6 saturation script relative to benchmarks/ */
  k6Script: string;
  /** Category for @-group resolution */
  category: 'compute' | 'data-stores' | 'ai' | 'integration';
  /** kubectl deployment name (may differ from service name) */
  deploymentName: string;
}

export const SERVICE_REGISTRY: Record<string, ServiceRegistryEntry> = {
  // Public services
  runtime: {
    configKey: 'runtimeUrl',
    k6Script: 'saturation/runtime.ts',
    category: 'compute',
    deploymentName: 'runtime',
  },
  studio: {
    configKey: 'studioUrl',
    k6Script: 'saturation/studio.ts',
    category: 'compute',
    deploymentName: 'studio',
  },
  admin: {
    configKey: 'adminUrl',
    k6Script: 'saturation/admin.ts',
    category: 'compute',
    deploymentName: 'admin',
  },

  // Private services
  'search-ai': {
    configKey: 'searchAiUrl',
    k6Script: 'saturation/search-ai.ts',
    category: 'ai',
    deploymentName: 'search-ai',
  },
  'search-ai-runtime': {
    configKey: 'searchAiRuntimeUrl',
    k6Script: 'saturation/search-ai-runtime.ts',
    category: 'ai',
    deploymentName: 'search-ai-runtime',
  },
  'bge-m3': {
    configKey: 'bgeM3Url',
    k6Script: 'saturation/bge-m3.ts',
    category: 'ai',
    deploymentName: 'bge-m3',
  },
  docling: {
    configKey: 'doclingUrl',
    k6Script: 'saturation/docling.ts',
    category: 'ai',
    deploymentName: 'docling',
  },
  preprocessing: {
    configKey: 'preprocessingUrl',
    k6Script: 'saturation/preprocessing.ts',
    category: 'ai',
    deploymentName: 'preprocessing',
  },
  // Note: workflow-engine is categorized under 'ai' rather than 'compute' because the
  // design spec puts only runtime, studio, admin in @compute. workflow-engine is more
  // closely aligned with AI/orchestration workloads. Consider a dedicated '@workflow'
  // category if more workflow services are added in the future.
  'workflow-engine': {
    configKey: 'workflowEngineUrl',
    k6Script: 'saturation/workflow-engine.ts',
    category: 'ai',
    deploymentName: 'workflow-engine',
  },

  // Data stores
  mongodb: {
    configKey: 'mongoUrl',
    k6Script: 'saturation/mongodb.ts',
    category: 'data-stores',
    deploymentName: 'mongodb',
  },
  redis: {
    configKey: 'redisUrl',
    k6Script: 'saturation/redis.ts',
    category: 'data-stores',
    deploymentName: 'redis',
  },
  clickhouse: {
    configKey: 'clickhouseUrl',
    k6Script: 'saturation/clickhouse.ts',
    category: 'data-stores',
    deploymentName: 'clickhouse',
  },
  opensearch: {
    configKey: 'opensearchUrl',
    k6Script: 'saturation/opensearch.ts',
    category: 'data-stores',
    deploymentName: 'opensearch',
  },
  qdrant: {
    configKey: 'qdrantUrl',
    k6Script: 'saturation/qdrant.ts',
    category: 'data-stores',
    deploymentName: 'qdrant',
  },
  neo4j: {
    configKey: 'neo4jUrl',
    k6Script: 'saturation/neo4j.ts',
    category: 'data-stores',
    deploymentName: 'neo4j',
  },
  restate: {
    configKey: 'restateUrl',
    k6Script: 'saturation/restate.ts',
    category: 'data-stores',
    deploymentName: 'restate',
  },
};

export const SERVICE_CATEGORIES: Record<string, string[]> = {
  '@compute': Object.entries(SERVICE_REGISTRY)
    .filter(([, e]) => e.category === 'compute')
    .map(([name]) => name),
  '@data-stores': Object.entries(SERVICE_REGISTRY)
    .filter(([, e]) => e.category === 'data-stores')
    .map(([name]) => name),
  '@ai': Object.entries(SERVICE_REGISTRY)
    .filter(([, e]) => e.category === 'ai')
    .map(([name]) => name),
  '@integration': [
    'agent-conversation-e2e',
    'multi-agent-orchestration',
    'kb-ingestion-e2e',
    'search-query-e2e',
    'channel-message-e2e',
    'workflow-execution-e2e',
  ],
  '@all': Object.keys(SERVICE_REGISTRY),
};

/**
 * Bottom-up test order: data stores → AI/embedding → app services.
 * Data stores first so their capacity numbers inform whether
 * app-service results were bottlenecked by downstream dependencies.
 */
export const SERVICE_TEST_ORDER: string[] = [
  // Data stores
  'mongodb',
  'redis',
  'clickhouse',
  'opensearch',
  'qdrant',
  'neo4j',
  'restate',
  // AI / embedding
  'bge-m3',
  'docling',
  'preprocessing',
  // App services
  'search-ai-runtime',
  'search-ai',
  'workflow-engine',
  'runtime',
  'studio',
  'admin',
];

/**
 * Resolve a comma-separated list of service names and/or @category
 * tokens into an ordered list of service names.
 *
 * - `undefined` → all services in SERVICE_TEST_ORDER
 * - `"runtime,bge-m3"` → `["runtime", "bge-m3"]`
 * - `"@compute"` → `["runtime", "studio", "admin"]` (preserving test order)
 * - `"@data-stores,bge-m3"` → data-store services + bge-m3 (deduplicated)
 */
export function resolveServices(input: string | undefined): string[] {
  if (!input) {
    return [...SERVICE_TEST_ORDER];
  }

  const tokens = input.split(',').map((t) => t.trim());
  const resolved = new Set<string>();

  for (const token of tokens) {
    if (token.startsWith('@')) {
      const category = SERVICE_CATEGORIES[token];
      if (!category) {
        throw new Error(
          `Unknown category: ${token}. Valid categories: ${Object.keys(SERVICE_CATEGORIES).join(', ')}`,
        );
      }
      for (const svc of category) {
        resolved.add(svc);
      }
    } else {
      if (!SERVICE_REGISTRY[token]) {
        throw new Error(
          `Unknown service: ${token}. Valid services: ${Object.keys(SERVICE_REGISTRY).join(', ')}`,
        );
      }
      resolved.add(token);
    }
  }

  // Return in test order (stable ordering for reproducibility)
  return SERVICE_TEST_ORDER.filter((svc) => resolved.has(svc));
}
```

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/service-registry.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/service-registry.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/service-registry.test.ts
git add packages/kore-platform-cli/src/commands/benchmark/service-registry.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/service-registry.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add service registry with category resolution for benchmark orchestrator"
```

---

## Task 2: Preflight Checks

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/preflight.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/preflight.test.ts`

- [ ] **Step 1: Write the test file first** (~3 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/preflight.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPreflight, type PreflightResult } from '../../commands/benchmark/preflight.js';

// Mock child_process.execFile for kubectl/k6 checks
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

function mockExecFile(results: Record<string, { stdout: string; stderr?: string; error?: Error }>) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      cmd: string,
      args: string[],
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const key = `${cmd} ${(args || []).join(' ')}`;
      for (const [pattern, result] of Object.entries(results)) {
        if (key.includes(pattern)) {
          if (result.error) {
            callback(result.error, '', result.stderr || '');
          } else {
            callback(null, result.stdout, result.stderr || '');
          }
          return;
        }
      }
      callback(new Error(`Unexpected command: ${key}`), '', '');
    },
  );
}

describe('runPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when kubectl, k6, and namespace are accessible', async () => {
    mockExecFile({
      'kubectl version': { stdout: 'Client Version: v1.28.0\nServer Version: v1.28.0' },
      'kubectl get namespace': { stdout: 'NAME   STATUS   AGE\nabl-dev   Active   30d' },
      'k6 version': { stdout: 'k6 v1.6.0' },
    });

    const result = await runPreflight({
      namespace: 'abl-dev',
      skipCoroot: true,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.kubectl).toBe(true);
    expect(result.checks.namespace).toBe(true);
    expect(result.checks.k6).toBe(true);
  });

  it('fails when kubectl is not found', async () => {
    mockExecFile({
      kubectl: { error: new Error('command not found'), stderr: 'command not found' },
      k6: { stdout: 'k6 v1.6.0' },
    });

    const result = await runPreflight({
      namespace: 'abl-dev',
      skipCoroot: true,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.kubectl).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/kubectl/i)]));
  });

  it('fails when namespace does not exist', async () => {
    mockExecFile({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'kubectl get namespace': { error: new Error('not found'), stderr: 'not found' },
      k6: { stdout: 'k6 v1.6.0' },
    });

    const result = await runPreflight({
      namespace: 'nonexistent',
      skipCoroot: true,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.namespace).toBe(false);
  });

  it('fails when k6 is not found', async () => {
    mockExecFile({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'kubectl get namespace': { stdout: 'abl-dev   Active' },
      k6: { error: new Error('command not found') },
    });

    const result = await runPreflight({
      namespace: 'abl-dev',
      skipCoroot: true,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.k6).toBe(false);
  });

  it('records replica counts for requested services', async () => {
    mockExecFile({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'kubectl get namespace': { stdout: 'abl-dev   Active' },
      k6: { stdout: 'k6 v1.6.0' },
      'kubectl get deployment': {
        stdout: JSON.stringify({
          items: [
            { metadata: { name: 'runtime' }, spec: { replicas: 3 } },
            { metadata: { name: 'search-ai' }, spec: { replicas: 2 } },
          ],
        }),
      },
    });

    const result = await runPreflight({
      namespace: 'abl-dev',
      skipCoroot: true,
      services: ['runtime', 'search-ai'],
    });

    expect(result.originalReplicas).toEqual({ runtime: 3, 'search-ai': 2 });
  });
});
```

- [ ] **Step 2: Write the preflight module** (~5 min)

Create `packages/kore-platform-cli/src/commands/benchmark/preflight.ts`:

Implements `runPreflight()` that:

1. Checks `kubectl version --client` to verify kubectl is installed
2. Checks `kubectl get namespace <ns>` to verify namespace exists
3. Checks `k6 version` to verify k6 is installed
4. Optionally checks Coroot connectivity (via dynamic import of coroot-collector from Plan 3)
5. Records current replica counts for all requested services via `kubectl get deployment -n <ns> -o json`
6. Returns a `PreflightResult` with pass/fail per check, errors array, and `originalReplicas` map

```typescript
export interface PreflightResult {
  passed: boolean;
  checks: {
    kubectl: boolean;
    namespace: boolean;
    k6: boolean;
    coroot: boolean;
  };
  errors: string[];
  warnings: string[];
  originalReplicas: Record<string, number>;
}
```

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/preflight.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/preflight.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/preflight.test.ts
git add packages/kore-platform-cli/src/commands/benchmark/preflight.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/preflight.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add preflight checks for benchmark orchestrator"
```

---

## Task 3: kubectl Operations

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/kubectl-ops.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/kubectl-ops.test.ts`

- [ ] **Step 1: Write the test file first** (~4 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/kubectl-ops.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scaleDown,
  restoreReplicas,
  getPodResources,
  waitForPodReady,
} from '../../commands/benchmark/kubectl-ops.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

function mockExecFileSequence(calls: Array<{ match: string; stdout?: string; error?: Error }>) {
  let callIndex = 0;
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      _cmd: string,
      args: string[],
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const fullCmd = `${_cmd} ${(args || []).join(' ')}`;
      // Find matching call spec
      for (const spec of calls) {
        if (fullCmd.includes(spec.match)) {
          if (spec.error) {
            callback(spec.error, '', '');
          } else {
            callback(null, spec.stdout || '', '');
          }
          return;
        }
      }
      callback(null, '', '');
    },
  );
}

describe('scaleDown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scales deployment to 1 replica', async () => {
    mockExecFileSequence([
      { match: 'scale deployment/runtime --replicas=1', stdout: 'deployment.apps/runtime scaled' },
      { match: 'rollout status', stdout: 'deployment "runtime" successfully rolled out' },
    ]);

    await scaleDown('runtime', 'abl-dev');

    expect(execFile).toHaveBeenCalled();
  });

  it('throws when scale command fails', async () => {
    mockExecFileSequence([{ match: 'scale', error: new Error('deployment not found') }]);

    await expect(scaleDown('runtime', 'abl-dev')).rejects.toThrow(/deployment not found/);
  });
});

describe('restoreReplicas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restores deployment to original replica count', async () => {
    mockExecFileSequence([{ match: 'scale deployment/runtime --replicas=3', stdout: 'scaled' }]);

    await restoreReplicas('runtime', 3, 'abl-dev');

    expect(execFile).toHaveBeenCalled();
  });
});

describe('getPodResources', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts CPU and memory from pod spec', async () => {
    const podJson = {
      items: [
        {
          spec: {
            containers: [
              {
                resources: {
                  requests: { cpu: '2', memory: '4Gi' },
                  limits: { cpu: '4', memory: '8Gi' },
                },
              },
            ],
          },
        },
      ],
    };

    mockExecFileSequence([{ match: 'get pods', stdout: JSON.stringify(podJson) }]);

    const resources = await getPodResources('runtime', 'abl-dev');

    expect(resources.cpu).toBe('2');
    expect(resources.memory).toBe('4Gi');
  });

  it('returns defaults when pod has no resource requests', async () => {
    const podJson = {
      items: [
        {
          spec: {
            containers: [{ resources: {} }],
          },
        },
      ],
    };

    mockExecFileSequence([{ match: 'get pods', stdout: JSON.stringify(podJson) }]);

    const resources = await getPodResources('runtime', 'abl-dev');

    expect(resources.cpu).toBe('unknown');
    expect(resources.memory).toBe('unknown');
  });
});

describe('waitForPodReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves when rollout succeeds', async () => {
    mockExecFileSequence([{ match: 'rollout status', stdout: 'successfully rolled out' }]);

    await expect(waitForPodReady('runtime', 'abl-dev', 60_000)).resolves.not.toThrow();
  });

  it('rejects when rollout times out', async () => {
    mockExecFileSequence([{ match: 'rollout status', error: new Error('timed out waiting') }]);

    await expect(waitForPodReady('runtime', 'abl-dev', 60_000)).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Write the kubectl operations module** (~5 min)

Create `packages/kore-platform-cli/src/commands/benchmark/kubectl-ops.ts`:

Implements:

- `scaleDown(deploymentName, namespace)` — `kubectl scale deployment/<name> --replicas=1 -n <ns>`, then `waitForPodReady()`
- `restoreReplicas(deploymentName, replicas, namespace)` — `kubectl scale deployment/<name> --replicas=<n> -n <ns>`
- `getPodResources(deploymentName, namespace)` — `kubectl get pods -l app=<name> -n <ns> -o json`, parse first container's resource requests
- `waitForPodReady(deploymentName, namespace, timeoutMs)` — `kubectl rollout status deployment/<name> -n <ns> --timeout=<s>`

All operations use `execFileAsync()` (promisified `child_process.execFile`). Errors include the kubectl stderr in the thrown message for debuggability.

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/kubectl-ops.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/kubectl-ops.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/kubectl-ops.test.ts
git add packages/kore-platform-cli/src/commands/benchmark/kubectl-ops.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/kubectl-ops.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add kubectl operations for benchmark scale-down and restore"
```

---

## Task 4: k6 Runner (Spawn + JSON Summary Parser)

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/k6-runner.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/k6-runner.test.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/fixtures/k6-summary.json`

- [ ] **Step 1: Create the k6 summary fixture** (~3 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/fixtures/k6-summary.json`:

A realistic k6 JSON summary (using `--out json` format) that includes:

- `metrics.http_req_duration` with `values.p(50)`, `values.p(95)`, `values.p(99)`, `values.min`, `values.max`
- `metrics.http_req_failed` with `values.rate`
- `metrics.http_reqs` with `values.rate` (RPS)
- `metrics.vus` with `values.value` (VU count at end)
- `metrics.iterations` with `values.count` and `values.rate`
- Thresholds with pass/fail

```json
{
  "metrics": {
    "http_req_duration": {
      "type": "trend",
      "contains": "time",
      "values": {
        "avg": 145.23,
        "min": 12.5,
        "med": 120.0,
        "max": 4500.0,
        "p(50)": 120.0,
        "p(90)": 350.0,
        "p(95)": 520.0,
        "p(99)": 1200.0
      }
    },
    "http_req_failed": {
      "type": "rate",
      "contains": "default",
      "values": {
        "rate": 0.008,
        "passes": 16,
        "fails": 1984
      }
    },
    "http_reqs": {
      "type": "counter",
      "contains": "default",
      "values": {
        "count": 2000,
        "rate": 166.67
      }
    },
    "vus": {
      "type": "gauge",
      "contains": "default",
      "values": {
        "value": 150,
        "min": 1,
        "max": 150
      }
    },
    "iterations": {
      "type": "counter",
      "contains": "default",
      "values": {
        "count": 2000,
        "rate": 166.67
      }
    }
  },
  "root_group": {
    "name": "",
    "path": "",
    "id": "d41d8cd98f00b204e9800998ecf8427e"
  },
  "state": {
    "isStdOutTTY": false,
    "isStdErrTTY": false,
    "testRunDurationMs": 1200000
  }
}
```

- [ ] **Step 2: Write the test file** (~4 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/k6-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parseK6Summary, type K6SaturationResult } from '../../commands/benchmark/k6-runner.js';

describe('parseK6Summary', () => {
  let fixture: Record<string, unknown>;

  beforeEach(async () => {
    const raw = await readFile(join(__dirname, 'fixtures/k6-summary.json'), 'utf-8');
    fixture = JSON.parse(raw);
  });

  it('extracts latency percentiles from k6 summary', () => {
    const result = parseK6Summary(fixture);

    expect(result.latency.p50Ms).toBe(120.0);
    expect(result.latency.p95Ms).toBe(520.0);
    expect(result.latency.p99Ms).toBe(1200.0);
    expect(result.latency.minMs).toBe(12.5);
    expect(result.latency.maxMs).toBe(4500.0);
  });

  it('extracts error rate', () => {
    const result = parseK6Summary(fixture);
    expect(result.errorRate).toBeCloseTo(0.008, 3);
  });

  it('extracts total RPS', () => {
    const result = parseK6Summary(fixture);
    expect(result.rps).toBeCloseTo(166.67, 1);
  });

  it('extracts max VUs', () => {
    const result = parseK6Summary(fixture);
    expect(result.maxVUs).toBe(150);
  });

  it('extracts test duration in ms', () => {
    const result = parseK6Summary(fixture);
    expect(result.durationMs).toBe(1200000);
  });

  it('returns timestamps (start = now - duration, end = now)', () => {
    const before = Date.now();
    const result = parseK6Summary(fixture);
    const after = Date.now();

    // end should be approximately now
    expect(result.endTimestamp).toBeGreaterThanOrEqual(before - 1000);
    expect(result.endTimestamp).toBeLessThanOrEqual(after + 1000);
    // start should be end - duration
    expect(result.startTimestamp).toBe(result.endTimestamp - result.durationMs);
  });

  it('handles missing metrics gracefully', () => {
    const minimal = { metrics: {}, state: { testRunDurationMs: 60000 } };
    const result = parseK6Summary(minimal as Record<string, unknown>);

    expect(result.latency.p50Ms).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(result.rps).toBe(0);
  });
});
```

- [ ] **Step 3: Write the k6 runner module** (~5 min)

Create `packages/kore-platform-cli/src/commands/benchmark/k6-runner.ts`:

Implements:

- `K6SaturationResult` interface: `{ latency, errorRate, rps, maxVUs, durationMs, startTimestamp, endTimestamp, summaryPath }`
- `parseK6Summary(json)` — extracts metrics from k6 JSON summary into `K6SaturationResult`
- `runK6Saturation(opts)` — spawns `k6 run <script> --summary-export <tmpPath> --env TIER=<tier>` as a child process, streams stdout/stderr to console, waits for exit, reads + parses JSON summary, returns `K6SaturationResult`
  - `opts`: `{ scriptPath, tier, namespace, maxDurationMs, envVars? }`
  - On k6 exit code !== 0 with thresholds-only failure (exit code 99), still parse the summary (thresholds failing is expected at saturation)
  - On k6 crash (exit code 1, no summary file), throw with stderr context
  - Summary file path: `/tmp/k6-saturation-<service>-<timestamp>.json`

- [ ] **Step 4: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/k6-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/k6-runner.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/k6-runner.test.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/fixtures/k6-summary.json
git add packages/kore-platform-cli/src/commands/benchmark/k6-runner.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/k6-runner.test.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/fixtures/k6-summary.json
git commit -m "[ABLP-2] feat(sizing-calculator): add k6 runner with JSON summary parser for saturation tests"
```

---

## Task 5: Saturation Detector

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/saturation-detector.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/saturation-detector.test.ts`

- [ ] **Step 1: Write the test file first** (~4 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/saturation-detector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  detectSaturation,
  type SaturationInput,
  type SaturationResult,
} from '../../commands/benchmark/saturation-detector.js';

function makeInput(overrides: Partial<SaturationInput> = {}): SaturationInput {
  return {
    errorRate: 0.005,
    baselineP95Ms: 200,
    currentP95Ms: 350,
    cpuPeakPercent: null,
    wsUpgradeRefused: 0,
    wsTimeoutSpike: false,
    rps: 180,
    maxVUs: 100,
    ...overrides,
  };
}

describe('detectSaturation', () => {
  it('returns "none" when all signals are below thresholds', () => {
    const result = detectSaturation(makeInput());
    expect(result.trigger).toBe('none');
    expect(result.saturated).toBe(false);
  });

  it('detects error-rate trigger when > 1%', () => {
    const result = detectSaturation(makeInput({ errorRate: 0.015 }));
    expect(result.trigger).toBe('error-rate');
    expect(result.saturated).toBe(true);
  });

  it('detects latency trigger when p95 > 2x baseline', () => {
    const result = detectSaturation(makeInput({ baselineP95Ms: 200, currentP95Ms: 450 }));
    expect(result.trigger).toBe('latency');
    expect(result.saturated).toBe(true);
  });

  it('does NOT trigger latency at exactly 2x baseline', () => {
    const result = detectSaturation(makeInput({ baselineP95Ms: 200, currentP95Ms: 400 }));
    expect(result.trigger).not.toBe('latency');
  });

  it('detects cpu trigger when > 85%', () => {
    const result = detectSaturation(makeInput({ cpuPeakPercent: 90 }));
    expect(result.trigger).toBe('cpu');
    expect(result.saturated).toBe(true);
  });

  it('skips cpu check when cpuPeakPercent is null (Coroot unavailable)', () => {
    const result = detectSaturation(makeInput({ cpuPeakPercent: null }));
    // Should not trigger cpu
    expect(result.trigger).not.toBe('cpu');
  });

  it('detects connections trigger when WS upgrades are refused', () => {
    const result = detectSaturation(makeInput({ wsUpgradeRefused: 5 }));
    expect(result.trigger).toBe('connections');
    expect(result.saturated).toBe(true);
  });

  it('detects connections trigger on WS timeout spike', () => {
    const result = detectSaturation(makeInput({ wsTimeoutSpike: true }));
    expect(result.trigger).toBe('connections');
    expect(result.saturated).toBe(true);
  });

  it('returns earliest trigger when multiple signals fire (error-rate wins)', () => {
    // Design spec: "earliest trigger wins"
    // Priority order: error-rate > latency > cpu > connections
    const result = detectSaturation(
      makeInput({
        errorRate: 0.02,
        currentP95Ms: 500,
        baselineP95Ms: 200,
        cpuPeakPercent: 90,
      }),
    );
    expect(result.trigger).toBe('error-rate');
  });

  it('records maxRpsPerPod and maxConcurrentPerPod at saturation', () => {
    const result = detectSaturation(makeInput({ errorRate: 0.02, rps: 250, maxVUs: 150 }));
    expect(result.maxRpsPerPod).toBe(250);
    expect(result.maxConcurrentPerPod).toBe(150);
  });
});
```

- [ ] **Step 2: Write the saturation detector module** (~4 min)

Create `packages/kore-platform-cli/src/commands/benchmark/saturation-detector.ts`:

Implements multi-signal saturation detection per the design spec (Section 8):

- Error rate > 1% → `error-rate`
- p95 > 2x baseline p95 → `latency`
- CPU peak > 85% (from Coroot, nullable) → `cpu`
- WS upgrade refused > 0 OR timeout spike → `connections`

Priority order: error-rate > latency > cpu > connections (earliest trigger wins).

```typescript
export interface SaturationInput {
  errorRate: number; // 0-1 from k6
  baselineP95Ms: number; // first 10% of ramp
  currentP95Ms: number; // overall p95 from k6
  cpuPeakPercent: number | null; // from Coroot, null if unavailable
  wsUpgradeRefused: number; // count from k6 WS metrics
  wsTimeoutSpike: boolean; // from k6 WS metrics
  rps: number; // total RPS at test end
  maxVUs: number; // max VUs reached
}

export interface SaturationResult {
  saturated: boolean;
  trigger: 'error-rate' | 'latency' | 'cpu' | 'connections' | 'none';
  maxRpsPerPod: number;
  maxConcurrentPerPod: number;
}
```

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/saturation-detector.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/saturation-detector.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/saturation-detector.test.ts
git add packages/kore-platform-cli/src/commands/benchmark/saturation-detector.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/saturation-detector.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add multi-signal saturation detector for benchmark orchestrator"
```

---

## Task 6: Profile Assembler and Merge

**Files:**

- Create: `packages/kore-platform-cli/src/commands/benchmark/profile-assembler.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/benchmark/profile-assembler.test.ts`

- [ ] **Step 1: Write the test file first** (~5 min)

Create `packages/kore-platform-cli/src/__tests__/commands/benchmark/profile-assembler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  assembleServiceCapacity,
  assembleProfile,
  mergeProfiles,
} from '../../commands/benchmark/profile-assembler.js';
import type { CalibrationProfile } from '@agent-platform/sizing-calculator';

describe('assembleServiceCapacity', () => {
  it('combines k6 result, saturation result, Coroot metrics, and pod resources', () => {
    const capacity = assembleServiceCapacity({
      k6Result: {
        latency: { p50Ms: 120, p95Ms: 500, p99Ms: 1200, minMs: 30, maxMs: 5000 },
        errorRate: 0.008,
        rps: 180,
        maxVUs: 150,
        durationMs: 1200000,
        startTimestamp: 1711324800000,
        endTimestamp: 1711326000000,
        summaryPath: '/tmp/k6-summary.json',
      },
      saturationResult: {
        saturated: true,
        trigger: 'error-rate',
        maxRpsPerPod: 180,
        maxConcurrentPerPod: 150,
      },
      podResources: { cpu: '2', memory: '4Gi' },
      corootMetrics: {
        cpuPeak: '1.82',
        cpuAvg: '1.45',
        memoryPeak: '3.2Gi',
        memoryAvg: '2.8Gi',
        podRestarts: 0,
        oomKills: 0,
      },
      baselineP95Ms: 250,
      testedUrl: 'https://agents-staging.kore.ai/api',
      testedViaIngress: true,
    });

    expect(capacity.saturation.trigger).toBe('error-rate');
    expect(capacity.saturation.maxRpsPerPod).toBe(180);
    expect(capacity.provisioned.cpu).toBe('2');
    expect(capacity.measured.cpuPeak).toBe('1.82');
    expect(capacity.latency.baselineP95Ms).toBe(250);
    expect(capacity.testedViaIngress).toBe(true);
  });

  it('handles null Coroot metrics (Coroot unavailable)', () => {
    const capacity = assembleServiceCapacity({
      k6Result: {
        latency: { p50Ms: 120, p95Ms: 500, p99Ms: 1200, minMs: 30, maxMs: 5000 },
        errorRate: 0.008,
        rps: 180,
        maxVUs: 150,
        durationMs: 1200000,
        startTimestamp: 1711324800000,
        endTimestamp: 1711326000000,
        summaryPath: '/tmp/k6-summary.json',
      },
      saturationResult: {
        saturated: true,
        trigger: 'error-rate',
        maxRpsPerPod: 180,
        maxConcurrentPerPod: 150,
      },
      podResources: { cpu: '2', memory: '4Gi' },
      corootMetrics: null,
      baselineP95Ms: 250,
      testedUrl: 'http://localhost:3112',
      testedViaIngress: false,
    });

    expect(capacity.measured.cpuPeak).toBeNull();
    expect(capacity.measured.memoryPeak).toBeNull();
    expect(capacity.measured.podRestarts).toBe(0);
    expect(capacity.measured.oomKills).toBe(0);
  });
});

describe('assembleProfile', () => {
  it('creates a valid CalibrationProfile from service results', () => {
    const profile = assembleProfile({
      tier: 'M',
      environment: 'staging-aks',
      services: {
        runtime: {
          provisioned: { cpu: '2', memory: '4Gi' },
          saturation: { trigger: 'error-rate', maxRpsPerPod: 180, maxConcurrentPerPod: 150 },
          websocket: null,
          scenarios: {},
          measured: {
            cpuPeak: '1.82',
            cpuAvg: '1.45',
            memoryPeak: '3.2Gi',
            memoryAvg: '2.8Gi',
            podRestarts: 0,
            oomKills: 0,
          },
          latency: {
            p50Ms: 150,
            p95Ms: 500,
            p99Ms: 1200,
            minMs: 30,
            maxMs: 5000,
            baselineP95Ms: 250,
          },
          testedUrl: 'https://example.com',
          testedViaIngress: true,
        },
      },
      dataStores: {},
    });

    expect(profile.version).toBe('1.0');
    expect(profile.tier).toBe('M');
    expect(profile.timestamp).toBeTruthy();
    expect(profile.services.runtime).toBeDefined();
  });
});

describe('mergeProfiles', () => {
  const makeProfile = (
    services: Record<string, unknown>,
    dataStores: Record<string, unknown> = {},
  ): CalibrationProfile =>
    ({
      version: '1.0' as const,
      tier: 'M' as const,
      timestamp: '2026-03-25T10:00:00Z',
      environment: 'staging-aks',
      services,
      dataStores,
    }) as CalibrationProfile;

  it('merges non-overlapping services from two profiles', () => {
    const a = makeProfile({ runtime: { saturation: { maxRpsPerPod: 180 } } });
    const b = makeProfile({ 'search-ai': { saturation: { maxRpsPerPod: 250 } } });

    const merged = mergeProfiles([a, b]);

    expect(merged.services).toHaveProperty('runtime');
    expect(merged.services).toHaveProperty('search-ai');
  });

  it('later profiles take precedence for overlapping services', () => {
    const a = makeProfile({ runtime: { saturation: { maxRpsPerPod: 180 } } });
    const b = makeProfile({ runtime: { saturation: { maxRpsPerPod: 200 } } });

    const merged = mergeProfiles([a, b]);

    expect(
      (merged.services.runtime as { saturation: { maxRpsPerPod: number } }).saturation.maxRpsPerPod,
    ).toBe(200);
  });

  it('merges data stores alongside services', () => {
    const a = makeProfile({}, { mongodb: { dataSource: 'coroot-native' } });
    const b = makeProfile({}, { redis: { dataSource: 'coroot-native' } });

    const merged = mergeProfiles([a, b]);

    expect(merged.dataStores).toHaveProperty('mongodb');
    expect(merged.dataStores).toHaveProperty('redis');
  });

  it('preserves tier and environment from the last profile', () => {
    const a = makeProfile({});
    const b = makeProfile({});
    (b as { environment: string }).environment = 'prod-aks';

    const merged = mergeProfiles([a, b]);

    expect(merged.environment).toBe('prod-aks');
  });

  it('throws when profiles have different tiers', () => {
    const a = makeProfile({});
    const b = makeProfile({});
    (b as { tier: string }).tier = 'L';

    expect(() => mergeProfiles([a, b])).toThrow(/tier mismatch/i);
  });

  it('throws on empty input', () => {
    expect(() => mergeProfiles([])).toThrow(/at least one/i);
  });
});
```

- [ ] **Step 2: Write the profile assembler module** (~5 min)

Create `packages/kore-platform-cli/src/commands/benchmark/profile-assembler.ts`:

Implements:

- `assembleServiceCapacity(opts)` — combines k6 result, saturation result, pod resources, and optional Coroot metrics into a `ServiceCapacity` object. Sets `websocket: null` and `scenarios: {}` as defaults (per-scenario data added in a future enhancement).
- `assembleProfile(opts)` — creates a `CalibrationProfile` with `version: '1.0'`, current ISO timestamp, and provided services/dataStores. Validates result against `CalibrationProfileSchema` before returning.
- `mergeProfiles(profiles)` — merges an array of `CalibrationProfile` objects. Later entries win for overlapping keys. Throws on tier mismatch or empty input. Uses the last profile's environment and a fresh timestamp.

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/benchmark/profile-assembler.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/benchmark/profile-assembler.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/profile-assembler.test.ts
git add packages/kore-platform-cli/src/commands/benchmark/profile-assembler.ts packages/kore-platform-cli/src/__tests__/commands/benchmark/profile-assembler.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add profile assembler and merge for calibration output"
```

---

## Task 7: Main Orchestrator CLI Commands

**Files:**

- Create: `packages/kore-platform-cli/src/commands/sizing-benchmark.ts`
- Create: `packages/kore-platform-cli/src/__tests__/commands/sizing-benchmark.test.ts`

- [ ] **Step 1: Write the test file first** (~5 min)

Create `packages/kore-platform-cli/src/__tests__/commands/sizing-benchmark.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBenchmarkCommands } from '../commands/sizing-benchmark.js';

describe('registerBenchmarkCommands', () => {
  let sizing: Command;

  beforeEach(() => {
    sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);
  });

  it('registers "benchmark" subcommand', () => {
    const cmd = sizing.commands.find((c) => c.name() === 'benchmark');
    expect(cmd).toBeDefined();
  });

  it('registers "benchmark-service" subcommand', () => {
    const cmd = sizing.commands.find((c) => c.name() === 'benchmark-service');
    expect(cmd).toBeDefined();
  });

  it('registers "calibration-merge" subcommand', () => {
    const cmd = sizing.commands.find((c) => c.name() === 'calibration-merge');
    expect(cmd).toBeDefined();
  });

  describe('benchmark command options', () => {
    it('requires --tier', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const tierOpt = cmd.options.find((o) => o.long === '--tier');
      expect(tierOpt).toBeDefined();
      expect(tierOpt!.required).toBe(true);
    });

    it('requires --output-calibration', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--output-calibration');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });

    it('has optional --services flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--services');
      expect(opt).toBeDefined();
    });

    it('has optional --namespace flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--namespace');
      expect(opt).toBeDefined();
    });

    it('has optional --dry-run flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--dry-run');
      expect(opt).toBeDefined();
    });

    it('has optional --output-report flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--output-report');
      expect(opt).toBeDefined();
    });

    it('has optional --output-pdf flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--output-pdf');
      expect(opt).toBeDefined();
    });

    it('has optional --scenario-weights flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--scenario-weights');
      expect(opt).toBeDefined();
    });

    it('has optional --skip-per-scenario flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--skip-per-scenario');
      expect(opt).toBeDefined();
    });

    it('has optional --prometheus-url flag', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--prometheus-url');
      expect(opt).toBeDefined();
    });

    it('has optional --headroom flag with default 0.20', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--headroom');
      expect(opt).toBeDefined();
      expect(opt!.defaultValue).toBe('0.20');
    });

    it('has optional --max-duration flag with default 30m', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark')!;
      const opt = cmd.options.find((o) => o.long === '--max-duration');
      expect(opt).toBeDefined();
      expect(opt!.defaultValue).toBe('30m');
    });
  });

  describe('benchmark-service command options', () => {
    it('requires --service (singular)', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark-service')!;
      const opt = cmd.options.find((o) => o.long === '--service');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });

    it('requires --tier', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'benchmark-service')!;
      const opt = cmd.options.find((o) => o.long === '--tier');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });
  });

  describe('calibration-merge command options', () => {
    it('requires --inputs', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'calibration-merge')!;
      const opt = cmd.options.find((o) => o.long === '--inputs');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });

    it('requires --output', () => {
      const cmd = sizing.commands.find((c) => c.name() === 'calibration-merge')!;
      const opt = cmd.options.find((o) => o.long === '--output');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Write the main orchestrator module** (~5 min)

Create `packages/kore-platform-cli/src/commands/sizing-benchmark.ts`:

```typescript
/**
 * CLI Benchmark Orchestrator Commands
 *
 * Provides `sizing benchmark`, `sizing benchmark-service`, and
 * `sizing calibration-merge` subcommands for the saturation pipeline.
 *
 * Full pipeline: pre-flight → per-service (scale-down → k6 → Coroot → restore) → combine → output
 */

import type { Command } from 'commander';

export function registerBenchmarkCommands(sizing: Command): void {
  // ... register all three subcommands
}
```

The `sizing benchmark` command registration should include all these options:

```typescript
sizing
  .command('benchmark')
  .description('Run saturation benchmarks for all or selected services')
  .requiredOption('--tier <tier>', 'Sizing tier (S, M, L, XL)')
  .requiredOption('--output-calibration <path>', 'Output path for CalibrationProfile JSON')
  .option('--services <services>', 'Comma-separated service names or @categories')
  .option('--namespace <ns>', 'Kubernetes namespace', 'abl-dev')
  .option('--dry-run', 'Print execution plan without running benchmarks')
  .option('--headroom <fraction>', 'Safety margin fraction for capacity', '0.20')
  .option('--max-duration <duration>', 'Max duration per service k6 run', '30m')
  .option('--output-report <path>', 'Path for markdown report output')
  .option('--output-pdf <path>', 'Path for PDF report output')
  .option('--scenario-weights <string>', 'Override scenario traffic weight distribution')
  .option('--skip-per-scenario', 'Skip per-scenario isolation runs')
  .option('--prometheus-url <string>', 'Prometheus endpoint (future: direct metrics query)')
  .action(async (opts) => {
    /* ... */
  });
```

> **Note:** `--output-report` and `--output-pdf` dynamically import Plan 5's report generation functions (`buildSaturationReportContext()`, `generatePdf()`, `loadTemplate()`) from `sizing-report.ts` to generate inline reports after calibration completes.

The `sizing benchmark` action handler implements the full orchestration loop:

```
async function runBenchmarkPipeline(opts) {
  // 1. Resolve services from --services flag (category expansion)
  const services = resolveServices(opts.services);

  // 2. Run preflight checks
  const preflight = await runPreflight({ namespace, services });
  if (!preflight.passed) { print errors, exit 1 }

  // 3. If --dry-run, print plan and exit
  if (opts.dryRun) { printPlan(services, preflight); return; }

  // 4. Per-service saturation loop
  const results: Record<string, ServiceCapacity> = {};

  for (const service of services) {
    const entry = SERVICE_REGISTRY[service];
    const originalReplicas = preflight.originalReplicas[service];

    try {
      // 4a. Scale down to 1 replica
      await scaleDown(entry.deploymentName, namespace);

      // 4b. Get pod resource requests
      const podResources = await getPodResources(entry.deploymentName, namespace);

      // 4c. Run k6 saturation test
      const k6Result = await runK6Saturation({
        scriptPath: entry.k6Script,
        tier: opts.tier,
        namespace,
        maxDurationMs: parseDuration(opts.maxDuration),
      });

      // 4d. Collect Coroot metrics (optional, graceful degradation)
      let corootMetrics = null;
      if (preflight.checks.coroot) {
        corootMetrics = await collectCorootMetrics(...);
      }

      // 4e. Detect saturation
      const saturation = detectSaturation({
        errorRate: k6Result.errorRate,
        // TODO: Replace with per-stage baseline metric from k6 custom Trend measured during first ramp stage
        baselineP95Ms: k6Result.latency.p95Ms * 0.5, // first 10% approximation
        currentP95Ms: k6Result.latency.p95Ms,
        cpuPeakPercent: corootMetrics?.cpuPeakPercent ?? null,
        wsUpgradeRefused: 0,
        wsTimeoutSpike: false,
        rps: k6Result.rps,
        maxVUs: k6Result.maxVUs,
      });

      // 4f. Assemble ServiceCapacity
      results[service] = assembleServiceCapacity({
        k6Result,
        saturationResult: saturation,
        podResources,
        corootMetrics,
        // TODO: Replace with per-stage baseline metric from k6 custom Trend measured during first ramp stage
        baselineP95Ms: k6Result.latency.p95Ms * 0.5,
        testedUrl: resolvedUrl,
        testedViaIngress: isIngress(resolvedUrl),
      });

    } finally {
      // 4g. ALWAYS restore replicas
      if (originalReplicas !== undefined) {
        await restoreReplicas(entry.deploymentName, originalReplicas, namespace);
      }
    }
  }

  // 5. Assemble CalibrationProfile
  const profile = assembleProfile({
    tier: opts.tier,
    environment: opts.namespace || 'unknown',
    services: results,
    dataStores: {},
  });

  // 6. Write output
  await writeFile(opts.outputCalibration, JSON.stringify(profile, null, 2));
}
```

The `sizing benchmark-service` action runs the same inner loop for a single service.

The `sizing calibration-merge` action:

1. Reads all `--inputs` files
2. Parses and validates each against `CalibrationProfileSchema`
3. Calls `mergeProfiles()` to combine
4. Writes merged result to `--output`

- [ ] **Step 3: Run tests to verify**

Run: `cd packages/kore-platform-cli && pnpm build && pnpm test -- --run src/__tests__/commands/sizing-benchmark.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/sizing-benchmark.ts packages/kore-platform-cli/src/__tests__/commands/sizing-benchmark.test.ts
git add packages/kore-platform-cli/src/commands/sizing-benchmark.ts packages/kore-platform-cli/src/__tests__/commands/sizing-benchmark.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add CLI benchmark orchestrator commands"
```

---

## Task 8: Wire into Existing sizing.ts

**Files:**

- Modify: `packages/kore-platform-cli/src/commands/sizing.ts`

- [ ] **Step 1: Read the current file to verify signature** (~1 min)

Read `packages/kore-platform-cli/src/commands/sizing.ts` to confirm the `registerSizingCommands(program)` function and the `sizing` command variable.

- [ ] **Step 2: Add the import and call** (~2 min)

Add to `packages/kore-platform-cli/src/commands/sizing.ts` after the `const sizing = ...` line:

```typescript
// Wire in benchmark orchestrator subcommands
const { registerBenchmarkCommands } = await import('./sizing-benchmark.js');
registerBenchmarkCommands(sizing);
```

Note: Using dynamic import (consistent with existing pattern in `sizing calculate` action) to avoid loading benchmark dependencies at CLI startup. However, since `registerBenchmarkCommands` only registers commands (no heavy imports), a static import at the top of the function body is also acceptable. The dynamic import is placed inside `registerSizingCommands()` but outside any action handler, so it runs once when `sizing` subcommands are being registered.

**Alternative (static import at file top):**

```typescript
import { registerBenchmarkCommands } from './sizing-benchmark.js';
```

Then inside `registerSizingCommands`:

```typescript
registerBenchmarkCommands(sizing);
```

Use the static import approach since `registerBenchmarkCommands` only defines Commander.js commands and does not import heavy dependencies at the module level (the heavy imports like k6-runner, kubectl-ops are done dynamically inside action handlers).

- [ ] **Step 3: Build to verify wiring compiles**

Run: `pnpm build --filter=kore-platform-cli`
Expected: SUCCESS — no type errors

- [ ] **Step 4: Verify commands are registered** (~2 min)

Run: `node packages/kore-platform-cli/dist/index.js sizing --help`
Expected output includes `benchmark`, `benchmark-service`, and `calibration-merge` alongside existing `questionnaire`, `calculate`, `helm`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/sizing.ts
git add packages/kore-platform-cli/src/commands/sizing.ts
git commit -m "[ABLP-2] feat(sizing-calculator): wire benchmark orchestrator into sizing CLI"
```

---

## Task 9: Full Build and Test Verification

- [ ] **Step 1: Full build**

Run: `pnpm build --filter=kore-platform-cli`
Expected: SUCCESS

- [ ] **Step 2: Run all new tests together**

Run: `cd packages/kore-platform-cli && pnpm test -- --run src/__tests__/commands/benchmark/ src/__tests__/commands/sizing-benchmark.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `cd packages/kore-platform-cli && pnpm test -- --run`
Expected: All existing tests still PASS

- [ ] **Step 4: Verify dry-run output** (~2 min)

The `--dry-run` flag should print:

1. Resolved service list (in test order)
2. Per-service plan: deployment name, k6 script path, current replicas
3. Estimated total duration
4. No actual kubectl/k6 invocations

This is a manual sanity check — dry-run cannot be tested without a real kubectl context, but the plan output format should be verified.

---

## Deferred: Integration Flow Saturation

> **TODO (future iteration):** This plan covers per-service saturation only (Phase 1 from spec Section 8). Integration flow saturation (Phase 2 from spec Section 8) — where cross-service flows (e.g., agent-conversation-e2e, kb-ingestion-e2e) are driven to saturation to find the system-level ceiling and bottleneck service — is deferred to a future iteration. The `@integration` category in `SERVICE_CATEGORIES` and the `integrationFlows` field in `CalibrationProfile` are defined but not populated by this plan's orchestrator loop.

---

## Summary of Commits

| #   | Commit Message                                                                                               | Files                          |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | `[ABLP-2] feat(sizing-calculator): add service registry with category resolution for benchmark orchestrator` | `service-registry.ts`, test    |
| 2   | `[ABLP-2] feat(sizing-calculator): add preflight checks for benchmark orchestrator`                          | `preflight.ts`, test           |
| 3   | `[ABLP-2] feat(sizing-calculator): add kubectl operations for benchmark scale-down and restore`              | `kubectl-ops.ts`, test         |
| 4   | `[ABLP-2] feat(sizing-calculator): add k6 runner with JSON summary parser for saturation tests`              | `k6-runner.ts`, test, fixture  |
| 5   | `[ABLP-2] feat(sizing-calculator): add multi-signal saturation detector for benchmark orchestrator`          | `saturation-detector.ts`, test |
| 6   | `[ABLP-2] feat(sizing-calculator): add profile assembler and merge for calibration output`                   | `profile-assembler.ts`, test   |
| 7   | `[ABLP-2] feat(sizing-calculator): add CLI benchmark orchestrator commands`                                  | `sizing-benchmark.ts`, test    |
| 8   | `[ABLP-2] feat(sizing-calculator): wire benchmark orchestrator into sizing CLI`                              | `sizing.ts`                    |

## Error Handling Strategy

Per the design spec Section 8 ("Error Handling"):

| Failure                             | Behavior                                                                |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Service fails to scale down         | Skip service, log warning with reason, continue to next service         |
| k6 crashes (exit code 1)            | Restore replicas (finally block), log error, continue to next service   |
| k6 threshold failure (exit code 99) | Expected at saturation — parse summary normally, proceed                |
| Coroot unreachable                  | Set all Coroot fields to `null`, produce calibration from k6 data alone |
| Replica restore fails               | Log error prominently (operator must manually verify), continue         |
| Invalid k6 summary JSON             | Log parse error, skip service, continue                                 |
| All services failed                 | Write empty CalibrationProfile (no services), exit with code 1          |
| `--dry-run`                         | Print plan, no kubectl/k6 invocations, exit 0                           |

## Key Design Decisions

1. **Separate file per concern** — service-registry, kubectl-ops, k6-runner, saturation-detector, profile-assembler are independent modules. This enables unit testing each in isolation with mocked child_process.

2. **Dynamic imports in action handlers** — Heavy dependencies (child_process spawning, filesystem operations) are loaded lazily inside Commander action handlers, not at module top level. This keeps `kore-platform-cli sizing --help` fast.

3. **finally-based restore** — Every kubectl scale-down is paired with a `finally` block that restores replicas. Even if k6 crashes, Coroot fails, or saturation detection throws, replicas are restored.

4. **Graceful Coroot degradation** — If Coroot is unavailable (preflight check fails or runtime error), the pipeline continues with k6 data alone. CPU saturation detection is skipped (only error-rate, latency, connections checked). Measured fields are set to `null`.

5. **Test-order stability** — `SERVICE_TEST_ORDER` defines a deterministic bottom-up order. Category resolution and merge operations preserve this order. This ensures data stores are always tested before app services.

6. **No mocking of codebase components in tests** — Tests mock only `child_process` (external tool boundary) and file I/O. The service registry, saturation detector, and profile assembler are tested with real logic.
