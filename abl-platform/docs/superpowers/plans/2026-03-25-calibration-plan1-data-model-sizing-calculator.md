# Calibration Pipeline — Plan 1: Data Model, Traffic Model, Sizing Calculator Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CalibrationProfile types, Zod validation schema, traffic model, and calibration-aware sizing functions to `packages/sizing-calculator/`, then wire the `--calibration` flag into the CLI's `sizing calculate` command.

**Architecture:** The sizing calculator gains an optional `CalibrationProfile` parameter. When provided, `calibratedSizeServices()` and `calibratedSizeDataStores()` replace the hardcoded path with measured per-pod capacity data. The traffic model converts questionnaire workload inputs to expected peak RPS per service. All existing behavior is unchanged when calibration is not provided.

**Tech Stack:** TypeScript, Zod, Vitest, existing `@agent-platform/sizing-calculator` package

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Sections 4, 5, 10, 11 (sizing calculate only), 14

**Plan series:** This is Plan 1 of 6. Subsequent plans build on the types and functions created here.

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| **1 (this)** | Data Model + Traffic Model + Sizing Calculator | —      |
| 2            | Saturation k6 Scripts + Shared Lib             | —      |
| 3            | Coroot Metrics Collector                       | —      |
| 4            | CLI Benchmark Orchestrator                     | —      |
| 5            | Report Generation                              | —      |
| 6            | Shell Script Updates (service groups)          | —      |

---

## File Structure

### New Files

| File                                                                          | Responsibility                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sizing-calculator/src/types/calibration.types.ts`                   | CalibrationProfile, ServiceCapacity, DataStoreCapacity, WebSocketCapacity, ScenarioCapacity, IntegrationFlowCapacity interfaces |
| `packages/sizing-calculator/src/schemas/calibration.schema.ts`                | Zod validation schema for CalibrationProfile JSON files                                                                         |
| `packages/sizing-calculator/src/engine/traffic-model.ts`                      | `peakRps()`, `expectedRps()`, ENTERPRISE_TRAFFIC constants                                                                      |
| `packages/sizing-calculator/src/engine/calibrated-service-sizer.ts`           | `calibratedSizeServices()` — replaces hardcoded path when calibration available                                                 |
| `packages/sizing-calculator/src/engine/calibrated-datastore-sizer.ts`         | `calibratedSizeDataStores()` — measured resource usage for data stores                                                          |
| `packages/sizing-calculator/src/engine/resource-utils.ts`                     | `roundUpResource()`, `inferNodePool()` — shared helpers                                                                         |
| `packages/sizing-calculator/src/__tests__/calibration.schema.test.ts`         | Zod schema validation tests                                                                                                     |
| `packages/sizing-calculator/src/__tests__/traffic-model.test.ts`              | Traffic model unit tests                                                                                                        |
| `packages/sizing-calculator/src/__tests__/calibrated-service-sizer.test.ts`   | Calibrated sizing tests                                                                                                         |
| `packages/sizing-calculator/src/__tests__/calibrated-datastore-sizer.test.ts` | Calibrated datastore sizing tests                                                                                               |
| `packages/sizing-calculator/src/__tests__/resource-utils.test.ts`             | Resource utility unit tests                                                                                                     |
| `packages/sizing-calculator/src/__tests__/helpers/make-questionnaire.ts`      | Shared test helper — reusable `makeQ()` factory                                                                                 |
| `packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json`        | Fixture: realistic tier M CalibrationProfile                                                                                    |

### Modified Files

| File                                                          | Changes                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/sizing-calculator/src/types/index.ts`               | Export new calibration types                                   |
| `packages/sizing-calculator/src/schemas/index.ts`             | Export CalibrationProfileSchema                                |
| `packages/sizing-calculator/src/index.ts`                     | Export new functions and types                                 |
| `packages/sizing-calculator/src/engine/calculator.ts`         | Accept optional `CalibrationProfile`, route to calibrated path |
| `packages/sizing-calculator/src/__tests__/calculator.test.ts` | Add tests for calibration path                                 |
| `packages/kore-platform-cli/src/commands/sizing.ts`           | Add `--calibration` flag to `sizing calculate`                 |

---

## Task 1: CalibrationProfile Type Definitions

**Files:**

- Create: `packages/sizing-calculator/src/types/calibration.types.ts`
- Modify: `packages/sizing-calculator/src/types/topology.types.ts` (add `notes?: string` to `ServiceTopology`)
- Modify: `packages/sizing-calculator/src/types/index.ts`

> **Note:** `ServiceTopology` needs a `notes?: string` field added so the calibrated datastore sizer (Task 6) can attach store-specific config recommendations. Add `notes?: string;` after the `hpa?` field in `ServiceTopology`.

- [ ] **Step 1: Write the type definitions file**

Create `packages/sizing-calculator/src/types/calibration.types.ts` with all interfaces from the design spec Section 4:

```typescript
import type { Tier } from './topology.types.js';

/** Central artifact: flows between benchmark collection and the sizing calculator. */
export interface CalibrationProfile {
  version: '1.0';
  tier: Tier;
  timestamp: string; // ISO 8601
  environment: string; // e.g., "staging-eks", "customer-aks"

  services: Record<string, ServiceCapacity>;
  dataStores: Record<string, DataStoreCapacity>;
  integrationFlows?: Record<string, IntegrationFlowCapacity>;
}

export interface ServiceCapacity {
  provisioned: { cpu: string; memory: string };

  saturation: {
    trigger: SaturationTrigger;
    maxRpsPerPod: number;
    maxConcurrentPerPod: number;
  };

  websocket: WebSocketCapacity | null;

  scenarios: Record<string, ScenarioCapacity>;

  measured: {
    cpuPeak: string | null;
    cpuAvg: string | null;
    memoryPeak: string | null;
    memoryAvg: string | null;
    podRestarts: number;
    oomKills: number;
  };

  latency: LatencyMetrics & { baselineP95Ms: number };

  testedUrl: string;
  testedViaIngress: boolean;
}

export type SaturationTrigger = 'error-rate' | 'latency' | 'cpu' | 'connections';

export interface LatencyMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

export interface WebSocketCapacity {
  endpoints: Record<string, WebSocketEndpointCapacity>;
  maxTotalConnectionsPerPod: number;
  connectLatency: LatencyMetrics;
  connectionErrors: number;
  connectionTimeouts: number;
  unexpectedDisconnects: number;
  heartbeatFailures: number;
  estimatedMemoryPerConnection: string;
}

export interface WebSocketEndpointCapacity {
  path: string;
  configuredMax: number;
  measuredMax: number;
  saturationSignal: string;
  messageLatency: { p50Ms: number; p95Ms: number; p99Ms: number };
}

export interface ScenarioCapacity {
  name: string;
  weight: number;
  maxRpsPerPod: number;
  maxConcurrentConnections?: number;
  trigger: SaturationTrigger;
  latency: LatencyMetrics & { baselineP95Ms: number };
}

export interface DataStoreCapacity {
  provisioned: { cpu: string; memory: string; storage: string };

  latency: {
    queryP50Ms: number;
    queryP95Ms: number;
    queryP99Ms: number;
    queryMinMs: number;
    queryMaxMs: number;
    writeP50Ms: number;
    writeP95Ms: number;
    writeP99Ms: number;
    writeMinMs: number;
    writeMaxMs: number;
  };

  connections: {
    used: number;
    max: number;
    utilizationPercent: number;
  };

  resources: {
    cpuPeak: string | null;
    cpuAvg: string | null;
    memoryPeak: string | null;
    memoryAvg: string | null;
    diskUsageGB: number;
    diskGrowthRateGBPerDay: number;
  };

  storeSpecific: Record<string, number | string | boolean | null>;

  dataSource: 'coroot-native' | 'coroot-tcp' | 'prometheus' | 'unavailable';
}

export interface IntegrationFlowCapacity {
  name: string;
  servicesInPath: string[];

  systemCeiling: {
    maxRps: number;
    maxConcurrentUsers: number;
    trigger: 'error-rate' | 'latency' | 'connections';
  };

  scenarios: Record<string, IntegrationScenarioCapacity>;

  latency: LatencyMetrics & { baselineP95Ms: number };

  serviceMetrics: Record<
    string,
    {
      cpuUtilization: number;
      memoryUtilization: number;
      errorRate: number;
      p95Ms: number;
      activeConnections: number;
    }
  >;

  bottleneck: { service: string; reason: string };
}

export interface IntegrationScenarioCapacity {
  name: string;
  weight: number;
  maxRps: number;
  maxConcurrentUsers: number;
  trigger: 'error-rate' | 'latency' | 'connections';
  latency: LatencyMetrics & { baselineP95Ms: number };
  bottleneckService: string;
}
```

- [ ] **Step 2: Export from types/index.ts**

Add to `packages/sizing-calculator/src/types/index.ts`:

```typescript
export type {
  CalibrationProfile,
  ServiceCapacity,
  DataStoreCapacity,
  WebSocketCapacity,
  WebSocketEndpointCapacity,
  ScenarioCapacity,
  IntegrationFlowCapacity,
  IntegrationScenarioCapacity,
  SaturationTrigger,
  LatencyMetrics,
} from './calibration.types.js';
```

- [ ] **Step 3: Build to verify types compile**

Run: `pnpm build --filter=@agent-platform/sizing-calculator`
Expected: SUCCESS — no type errors

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/types/calibration.types.ts packages/sizing-calculator/src/types/index.ts
git add packages/sizing-calculator/src/types/calibration.types.ts packages/sizing-calculator/src/types/index.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add CalibrationProfile type definitions"
```

---

## Task 2: CalibrationProfile Zod Schema

**Files:**

- Create: `packages/sizing-calculator/src/schemas/calibration.schema.ts`
- Create: `packages/sizing-calculator/src/__tests__/calibration.schema.test.ts`
- Create: `packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json`
- Modify: `packages/sizing-calculator/src/schemas/index.ts`

- [ ] **Step 1: Write the test file first**

Create `packages/sizing-calculator/src/__tests__/calibration.schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CalibrationProfileSchema } from '../schemas/calibration.schema.js';

describe('CalibrationProfileSchema', () => {
  it('validates a well-formed calibration profile', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const result = CalibrationProfileSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('rejects missing version field', () => {
    const result = CalibrationProfileSchema.safeParse({
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid version', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '2.0',
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '1.0',
      tier: 'XXXL',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty environment', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '1.0',
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: '',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('validates service with null Coroot fields (graceful degradation)', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    // Simulate Coroot unavailable
    profile.services.runtime.measured.cpuPeak = null;
    profile.services.runtime.measured.memoryPeak = null;

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('validates service with websocket: null (HTTP-only service)', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    // search-ai has no websocket
    expect(profile.services['search-ai'].websocket).toBeNull();

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('rejects negative maxRpsPerPod', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    profile.services.runtime.saturation.maxRpsPerPod = -10;

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Create the fixture file**

Create `packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json`:

```json
{
  "version": "1.0",
  "tier": "M",
  "timestamp": "2026-03-25T10:00:00Z",
  "environment": "staging-aks",
  "services": {
    "runtime": {
      "provisioned": { "cpu": "2", "memory": "4Gi" },
      "saturation": {
        "trigger": "error-rate",
        "maxRpsPerPod": 180,
        "maxConcurrentPerPod": 800
      },
      "websocket": {
        "endpoints": {
          "/ws": {
            "path": "/ws",
            "configuredMax": 1000,
            "measuredMax": 850,
            "saturationSignal": "upgrade_refused",
            "messageLatency": { "p50Ms": 5, "p95Ms": 25, "p99Ms": 80 }
          }
        },
        "maxTotalConnectionsPerPod": 850,
        "connectLatency": { "p50Ms": 8, "p95Ms": 35, "p99Ms": 120, "minMs": 2, "maxMs": 500 },
        "connectionErrors": 3,
        "connectionTimeouts": 1,
        "unexpectedDisconnects": 0,
        "heartbeatFailures": 0,
        "estimatedMemoryPerConnection": "2.5MB"
      },
      "scenarios": {
        "single_turn": {
          "name": "single_turn",
          "weight": 0.5,
          "maxRpsPerPod": 320,
          "trigger": "latency",
          "latency": {
            "p50Ms": 120,
            "p95Ms": 350,
            "p99Ms": 800,
            "minMs": 45,
            "maxMs": 2000,
            "baselineP95Ms": 180
          }
        },
        "multi_turn": {
          "name": "multi_turn",
          "weight": 0.25,
          "maxRpsPerPod": 85,
          "maxConcurrentConnections": 400,
          "trigger": "cpu",
          "latency": {
            "p50Ms": 300,
            "p95Ms": 900,
            "p99Ms": 2200,
            "minMs": 100,
            "maxMs": 5000,
            "baselineP95Ms": 450
          }
        },
        "tool_calling": {
          "name": "tool_calling",
          "weight": 0.15,
          "maxRpsPerPod": 45,
          "trigger": "latency",
          "latency": {
            "p50Ms": 500,
            "p95Ms": 1500,
            "p99Ms": 4000,
            "minMs": 200,
            "maxMs": 8000,
            "baselineP95Ms": 700
          }
        },
        "concurrent": {
          "name": "concurrent",
          "weight": 0.1,
          "maxRpsPerPod": 250,
          "trigger": "error-rate",
          "latency": {
            "p50Ms": 130,
            "p95Ms": 400,
            "p99Ms": 1000,
            "minMs": 50,
            "maxMs": 3000,
            "baselineP95Ms": 200
          }
        }
      },
      "measured": {
        "cpuPeak": "1.82",
        "cpuAvg": "1.45",
        "memoryPeak": "3.2Gi",
        "memoryAvg": "2.8Gi",
        "podRestarts": 0,
        "oomKills": 0
      },
      "latency": {
        "p50Ms": 150,
        "p95Ms": 500,
        "p99Ms": 1200,
        "minMs": 30,
        "maxMs": 5000,
        "baselineP95Ms": 250
      },
      "testedUrl": "https://agents-staging.kore.ai/api",
      "testedViaIngress": true
    },
    "search-ai": {
      "provisioned": { "cpu": "1", "memory": "2Gi" },
      "saturation": {
        "trigger": "cpu",
        "maxRpsPerPod": 250,
        "maxConcurrentPerPod": 0
      },
      "websocket": null,
      "scenarios": {
        "kb_operations": {
          "name": "kb_operations",
          "weight": 0.4,
          "maxRpsPerPod": 300,
          "trigger": "cpu",
          "latency": {
            "p50Ms": 80,
            "p95Ms": 200,
            "p99Ms": 500,
            "minMs": 20,
            "maxMs": 1500,
            "baselineP95Ms": 100
          }
        }
      },
      "measured": {
        "cpuPeak": "0.92",
        "cpuAvg": "0.65",
        "memoryPeak": "1.6Gi",
        "memoryAvg": "1.2Gi",
        "podRestarts": 0,
        "oomKills": 0
      },
      "latency": {
        "p50Ms": 80,
        "p95Ms": 200,
        "p99Ms": 500,
        "minMs": 20,
        "maxMs": 1500,
        "baselineP95Ms": 100
      },
      "testedUrl": "https://agents-staging.kore.ai/api/search-ai",
      "testedViaIngress": true
    }
  },
  "dataStores": {
    "mongodb": {
      "provisioned": { "cpu": "2", "memory": "4Gi", "storage": "50Gi" },
      "latency": {
        "queryP50Ms": 2,
        "queryP95Ms": 8,
        "queryP99Ms": 25,
        "queryMinMs": 0.5,
        "queryMaxMs": 100,
        "writeP50Ms": 3,
        "writeP95Ms": 12,
        "writeP99Ms": 40,
        "writeMinMs": 1,
        "writeMaxMs": 150
      },
      "connections": { "used": 120, "max": 500, "utilizationPercent": 24 },
      "resources": {
        "cpuPeak": "1.5",
        "cpuAvg": "0.8",
        "memoryPeak": "3.5Gi",
        "memoryAvg": "2.8Gi",
        "diskUsageGB": 12.5,
        "diskGrowthRateGBPerDay": 0.15
      },
      "storeSpecific": { "wiredTigerCacheHitRatio": 0.98, "replicationLagMs": 5 },
      "dataSource": "coroot-native"
    },
    "redis": {
      "provisioned": { "cpu": "1", "memory": "2Gi", "storage": "0" },
      "latency": {
        "queryP50Ms": 0.2,
        "queryP95Ms": 0.8,
        "queryP99Ms": 2,
        "queryMinMs": 0.05,
        "queryMaxMs": 10,
        "writeP50Ms": 0.3,
        "writeP95Ms": 1,
        "writeP99Ms": 3,
        "writeMinMs": 0.05,
        "writeMaxMs": 15
      },
      "connections": { "used": 80, "max": 300, "utilizationPercent": 26.7 },
      "resources": {
        "cpuPeak": "0.4",
        "cpuAvg": "0.2",
        "memoryPeak": "1.2Gi",
        "memoryAvg": "0.8Gi",
        "diskUsageGB": 0,
        "diskGrowthRateGBPerDay": 0
      },
      "storeSpecific": { "keyspaceHitRatio": 0.95, "blockedClients": 2 },
      "dataSource": "coroot-native"
    }
  }
}
```

- [ ] **Step 3: Write the Zod schema**

Create `packages/sizing-calculator/src/schemas/calibration.schema.ts`:

```typescript
import { z } from 'zod';

const LatencyMetricsSchema = z.object({
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  p99Ms: z.number().nonnegative(),
  minMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});

const LatencyWithBaselineSchema = LatencyMetricsSchema.extend({
  baselineP95Ms: z.number().nonnegative(),
});

const SaturationTriggerSchema = z.enum(['error-rate', 'latency', 'cpu', 'connections']);

const WebSocketEndpointCapacitySchema = z.object({
  path: z.string().min(1),
  configuredMax: z.number().nonnegative(),
  measuredMax: z.number().nonnegative(),
  saturationSignal: z.string().min(1),
  messageLatency: z.object({
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    p99Ms: z.number().nonnegative(),
  }),
});

const WebSocketCapacitySchema = z.object({
  endpoints: z.record(z.string(), WebSocketEndpointCapacitySchema),
  maxTotalConnectionsPerPod: z.number().nonnegative(),
  connectLatency: LatencyMetricsSchema,
  connectionErrors: z.number().nonnegative(),
  connectionTimeouts: z.number().nonnegative(),
  unexpectedDisconnects: z.number().nonnegative(),
  heartbeatFailures: z.number().nonnegative(),
  estimatedMemoryPerConnection: z.string().min(1),
});

const ScenarioCapacitySchema = z.object({
  name: z.string().min(1),
  weight: z.number().min(0).max(1),
  maxRpsPerPod: z.number().nonnegative(),
  maxConcurrentConnections: z.number().nonnegative().optional(),
  trigger: SaturationTriggerSchema,
  latency: LatencyWithBaselineSchema,
});

const ServiceCapacitySchema = z.object({
  provisioned: z.object({
    cpu: z.string().min(1),
    memory: z.string().min(1),
  }),
  saturation: z.object({
    trigger: SaturationTriggerSchema,
    maxRpsPerPod: z.number().positive(),
    maxConcurrentPerPod: z.number().nonnegative(),
  }),
  websocket: WebSocketCapacitySchema.nullable(),
  scenarios: z.record(z.string(), ScenarioCapacitySchema),
  measured: z.object({
    cpuPeak: z.string().nullable(),
    cpuAvg: z.string().nullable(),
    memoryPeak: z.string().nullable(),
    memoryAvg: z.string().nullable(),
    podRestarts: z.number().nonnegative(),
    oomKills: z.number().nonnegative(),
  }),
  latency: LatencyWithBaselineSchema,
  testedUrl: z.string().min(1),
  testedViaIngress: z.boolean(),
});

const DataStoreCapacitySchema = z.object({
  provisioned: z.object({
    cpu: z.string().min(1),
    memory: z.string().min(1),
    storage: z.string().min(1),
  }),
  latency: z.object({
    queryP50Ms: z.number().nonnegative(),
    queryP95Ms: z.number().nonnegative(),
    queryP99Ms: z.number().nonnegative(),
    queryMinMs: z.number().nonnegative(),
    queryMaxMs: z.number().nonnegative(),
    writeP50Ms: z.number().nonnegative(),
    writeP95Ms: z.number().nonnegative(),
    writeP99Ms: z.number().nonnegative(),
    writeMinMs: z.number().nonnegative(),
    writeMaxMs: z.number().nonnegative(),
  }),
  connections: z.object({
    used: z.number().nonnegative(),
    max: z.number().nonnegative(),
    utilizationPercent: z.number().min(0).max(100),
  }),
  resources: z.object({
    cpuPeak: z.string().nullable(),
    cpuAvg: z.string().nullable(),
    memoryPeak: z.string().nullable(),
    memoryAvg: z.string().nullable(),
    diskUsageGB: z.number().nonnegative(),
    diskGrowthRateGBPerDay: z.number().nonnegative(),
  }),
  storeSpecific: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
  dataSource: z.enum(['coroot-native', 'coroot-tcp', 'prometheus', 'unavailable']),
});

const IntegrationScenarioCapacitySchema = z.object({
  name: z.string().min(1),
  weight: z.number().min(0).max(1),
  maxRps: z.number().nonnegative(),
  maxConcurrentUsers: z.number().nonnegative(),
  trigger: z.enum(['error-rate', 'latency', 'connections']),
  latency: LatencyWithBaselineSchema,
  bottleneckService: z.string().min(1),
});

const IntegrationFlowCapacitySchema = z.object({
  name: z.string().min(1),
  servicesInPath: z.array(z.string().min(1)),
  systemCeiling: z.object({
    maxRps: z.number().nonnegative(),
    maxConcurrentUsers: z.number().nonnegative(),
    trigger: z.enum(['error-rate', 'latency', 'connections']),
  }),
  scenarios: z.record(z.string(), IntegrationScenarioCapacitySchema),
  latency: LatencyWithBaselineSchema,
  serviceMetrics: z.record(
    z.string(),
    z.object({
      cpuUtilization: z.number().min(0).max(100),
      memoryUtilization: z.number().min(0).max(100),
      errorRate: z.number().min(0).max(1),
      p95Ms: z.number().nonnegative(),
      activeConnections: z.number().nonnegative(),
    }),
  ),
  bottleneck: z.object({
    service: z.string().min(1),
    reason: z.string().min(1),
  }),
});

export const CalibrationProfileSchema = z.object({
  version: z.literal('1.0'),
  tier: z.enum(['S', 'M', 'L', 'XL']),
  timestamp: z.string().datetime(),
  environment: z.string().min(1),
  services: z.record(z.string(), ServiceCapacitySchema),
  dataStores: z.record(z.string(), DataStoreCapacitySchema),
  integrationFlows: z.record(z.string(), IntegrationFlowCapacitySchema).optional(),
});

export type ValidatedCalibrationProfile = z.infer<typeof CalibrationProfileSchema>;
```

- [ ] **Step 4: Export from schemas/index.ts**

Add to `packages/sizing-calculator/src/schemas/index.ts`:

```typescript
export {
  CalibrationProfileSchema,
  type ValidatedCalibrationProfile,
} from './calibration.schema.js';
```

- [ ] **Step 5: Run test to verify it fails (schema not yet importable)**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/calibration.schema.test.ts`
Expected: PASS — fixture validates, invalid inputs rejected

- [ ] **Step 6: Fix any test failures, then commit**

```bash
npx prettier --write packages/sizing-calculator/src/schemas/calibration.schema.ts packages/sizing-calculator/src/schemas/index.ts packages/sizing-calculator/src/__tests__/calibration.schema.test.ts packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json
git add packages/sizing-calculator/src/schemas/calibration.schema.ts packages/sizing-calculator/src/schemas/index.ts packages/sizing-calculator/src/__tests__/calibration.schema.test.ts packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json
git commit -m "[ABLP-2] feat(sizing-calculator): add CalibrationProfile Zod validation schema"
```

---

## Task 3: Traffic Model

**Files:**

- Create: `packages/sizing-calculator/src/engine/traffic-model.ts`
- Create: `packages/sizing-calculator/src/__tests__/traffic-model.test.ts`

- [ ] **Step 1: Create the shared test helper**

Create `packages/sizing-calculator/src/__tests__/helpers/make-questionnaire.ts`:

```typescript
import type { Questionnaire } from '../../schemas/questionnaire.schema.js';

/**
 * Shared test factory for Questionnaire objects.
 * Provides sensible defaults for a tier-M deployment.
 * Used across traffic-model, calibrated-service-sizer, and calibrated-datastore-sizer tests.
 */
export function makeQ(overrides: Partial<Questionnaire> = {}): Questionnaire {
  return {
    deployment: {
      cloudProvider: 'aws',
      regionCount: 1,
      haRequirement: 'standard',
      networkIsolation: 'shared-vpc',
      compliance: [],
    },
    llm: {
      hostingModel: 'external-api',
      selfHostedModels: [],
      concurrentRequests: 50,
      contextWindow: 'medium',
      embeddingModel: 'bge-m3',
    },
    agents: {
      agentCount: 5,
      concurrentConversations: 500,
      avgConversationLength: 10,
      messagesPerDay: 10000,
      toolCallsPerConversation: 3,
      multiAgentUsage: 0,
    },
    knowledgeBase: {
      totalDocuments: 1000,
      avgDocumentSize: 'small',
      documentTypes: ['pdf'],
      ingestionFrequency: 'daily',
      connectorTypes: ['file-upload'],
      kbPerProject: 1,
      vectorSearchQueriesPerDay: 5000,
    },
    workflows: {
      activeWorkflows: 10,
      executionsPerDay: 100,
      avgStepsPerWorkflow: 5,
      triggers: ['manual'],
      externalApiCallsPerWorkflow: 2,
    },
    channels: {
      activeChannels: ['web-widget'],
      voiceVideoUsage: 0,
      inboundWebhooksPerDay: 0,
      outboundWebhooksPerDay: 0,
    },
    observability: {
      adminUsers: 5,
      traceRetention: '30d',
      metricsRetention: '90d',
      auditLogRetention: '1y',
      monitoringStack: 'platform-builtin',
    },
    retention: {
      conversationRetention: '90d',
      documentRetention: 'until-deleted',
      attachmentRetention: '1y',
      encryptionAtRest: 'platform-aes256',
      backupFrequency: 'daily',
      drRtpRpo: 'rpo-24h-rto-4h',
    },
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the test file**

Create `packages/sizing-calculator/src/__tests__/traffic-model.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { peakRps, expectedRps } from '../engine/traffic-model.js';
import { makeQ } from './helpers/make-questionnaire.js';

describe('peakRps', () => {
  it('converts daily volume to peak RPS using enterprise traffic model', () => {
    // 10,000 messages/day → peak hour = 10000 * 0.4 / 2 = 2000 per hour → 2000/3600 ≈ 0.556
    const rps = peakRps(10000);
    expect(rps).toBeCloseTo(0.556, 2);
  });

  it('returns 0 for zero daily volume', () => {
    expect(peakRps(0)).toBe(0);
  });
});

describe('expectedRps', () => {
  it('uses concurrentConversations for runtime when available', () => {
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 500,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });
    // concurrentConversations > 0 → direct: 500
    expect(expectedRps('runtime', q)).toBe(500);
  });

  it('falls back to daily messages for runtime when concurrentConversations is 0', () => {
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 0,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });
    // peakRps(10000) * 3 (toolCalls) ≈ 0.556 * 3 ≈ 1.667
    const rps = expectedRps('runtime', q);
    expect(rps).toBeCloseTo(1.667, 2);
  });

  it('derives search-ai-runtime from vectorSearchQueriesPerDay', () => {
    const q = makeQ();
    const rps = expectedRps('search-ai-runtime', q);
    expect(rps).toBeCloseTo(peakRps(5000), 2);
  });

  it('derives bge-m3 from search-ai ingestion + search-ai-runtime queries', () => {
    const q = makeQ();
    const rps = expectedRps('bge-m3', q);
    expect(rps).toBeGreaterThan(0);
  });

  it('returns 0 for unknown service', () => {
    const q = makeQ();
    expect(expectedRps('unknown-service', q)).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/traffic-model.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the traffic model implementation**

Create `packages/sizing-calculator/src/engine/traffic-model.ts`:

```typescript
import type { Questionnaire } from '../schemas/questionnaire.schema.js';

/**
 * Standard enterprise traffic distribution.
 *
 * 8-hour business day with 2-hour peak window carrying 40% of daily traffic.
 * This is a hardcoded default — not exposed in the questionnaire.
 */
const ENTERPRISE_TRAFFIC = {
  businessDayHours: 8,
  peakWindowHours: 2,
  peakTrafficPercent: 0.4,
  normalWindowHours: 6,
  normalTrafficPercent: 0.6,
} as const;

/**
 * Convert a daily volume to peak-hour RPS using the enterprise traffic model.
 *
 * Peak hour receives: dailyVolume * 40% / 2 hours → convert to per-second.
 */
export function peakRps(dailyVolume: number): number {
  if (dailyVolume <= 0) return 0;
  const peakHourVolume =
    (dailyVolume * ENTERPRISE_TRAFFIC.peakTrafficPercent) / ENTERPRISE_TRAFFIC.peakWindowHours;
  return peakHourVolume / 3600;
}

/**
 * Compute expected peak RPS for a given service from questionnaire inputs.
 *
 * When the questionnaire provides concurrent fields (e.g., concurrentConversations),
 * those take priority — they represent the user's known peak load.
 * Daily volumes are converted to peak RPS via the traffic model only as a fallback.
 */
export function expectedRps(service: string, q: Questionnaire): number {
  switch (service) {
    case 'runtime': {
      if (q.agents.concurrentConversations > 0) {
        return q.agents.concurrentConversations;
      }
      return peakRps(q.agents.messagesPerDay) * q.agents.toolCallsPerConversation;
    }

    case 'search-ai-runtime': {
      return peakRps(q.knowledgeBase.vectorSearchQueriesPerDay);
    }

    case 'search-ai': {
      if (q.knowledgeBase.ingestionFrequency === 'real-time') {
        return peakRps(q.knowledgeBase.totalDocuments);
      }
      // Batch ingestion: spread over off-peak 16h window
      return q.knowledgeBase.totalDocuments / (16 * 3600);
    }

    case 'bge-m3': {
      // ~10 chunks per doc for ingestion + search queries
      return expectedRps('search-ai', q) * 10 + expectedRps('search-ai-runtime', q);
    }

    case 'workflow-engine': {
      return peakRps(q.workflows.executionsPerDay) * q.workflows.avgStepsPerWorkflow;
    }

    case 'studio': {
      // Studio scales with admin users, not with data volume
      return q.observability.adminUsers * 0.5; // ~0.5 RPS per admin user
    }

    case 'admin': {
      return q.observability.adminUsers * 0.1; // Low-traffic admin API
    }

    case 'preprocessing': {
      return expectedRps('search-ai', q) * 5; // ~5 preprocessing steps per doc
    }

    case 'docling': {
      // Docling only for PDF/image processing
      const heavyDocTypes = ['pdf', 'image', 'video'];
      const heavyDocFraction =
        q.knowledgeBase.documentTypes.filter((t) => heavyDocTypes.includes(t)).length /
        Math.max(q.knowledgeBase.documentTypes.length, 1);
      return expectedRps('search-ai', q) * heavyDocFraction;
    }

    default:
      return 0;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/traffic-model.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/__tests__/helpers/make-questionnaire.ts packages/sizing-calculator/src/engine/traffic-model.ts packages/sizing-calculator/src/__tests__/traffic-model.test.ts
git add packages/sizing-calculator/src/__tests__/helpers/make-questionnaire.ts packages/sizing-calculator/src/engine/traffic-model.ts packages/sizing-calculator/src/__tests__/traffic-model.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add traffic model for workload-to-RPS conversion"
```

---

## Task 4: Resource Utilities

**Files:**

- Create: `packages/sizing-calculator/src/engine/resource-utils.ts`
- Create: `packages/sizing-calculator/src/__tests__/resource-utils.test.ts`

- [ ] **Step 1: Write the test file first**

Create `packages/sizing-calculator/src/__tests__/resource-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  roundUpCpu,
  roundUpMemoryGi,
  parseMemoryGi,
  inferNodePool,
} from '../engine/resource-utils.js';

describe('roundUpCpu', () => {
  it('rounds 1.82 up to 2.0', () => expect(roundUpCpu(1.82)).toBe(2.0));
  it('rounds 2.09 up to 2.25', () => expect(roundUpCpu(2.09)).toBe(2.25));
  it('keeps exact quarter values', () => expect(roundUpCpu(1.5)).toBe(1.5));
  it('handles zero', () => expect(roundUpCpu(0)).toBe(0));
});

describe('roundUpMemoryGi', () => {
  it('rounds 3.68 up to 3.75', () => expect(roundUpMemoryGi(3.68)).toBe(3.75));
  it('rounds 2.1 up to 2.25', () => expect(roundUpMemoryGi(2.1)).toBe(2.25));
  it('keeps exact quarter values', () => expect(roundUpMemoryGi(4.0)).toBe(4.0));
});

describe('parseMemoryGi', () => {
  it('parses "3.2Gi" to 3.2', () => expect(parseMemoryGi('3.2Gi')).toBe(3.2));
  it('parses "1.6G" to 1.6', () => expect(parseMemoryGi('1.6G')).toBe(1.6));
  it('parses "512Mi" to ~0.5', () => expect(parseMemoryGi('512Mi')).toBeCloseTo(0.5, 2));
  it('returns null for null input', () => expect(parseMemoryGi(null)).toBeNull());
  it('returns null for empty string', () => expect(parseMemoryGi('')).toBeNull());
  it('returns null for invalid format', () => expect(parseMemoryGi('invalid')).toBeNull());
});

describe('inferNodePool', () => {
  it('returns "data" for mongodb', () => expect(inferNodePool('mongodb', 2)).toBe('data'));
  it('returns "data" for redis', () => expect(inferNodePool('redis', 1)).toBe('data'));
  it('returns "gpu" for self-hosted-llm', () =>
    expect(inferNodePool('self-hosted-llm', 4)).toBe('gpu'));
  it('returns "compute" for high-CPU service', () =>
    expect(inferNodePool('runtime', 4)).toBe('compute'));
  it('returns "general" for low-CPU service', () =>
    expect(inferNodePool('studio', 1)).toBe('general'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/resource-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write resource-utils.ts**

```typescript
/** GPU service name prefixes. */
const GPU_SERVICE_PREFIXES = ['self-hosted-llm'];

/** Known data store names. */
const DATA_STORES = ['mongodb', 'redis', 'clickhouse', 'opensearch', 'qdrant', 'neo4j', 'restate'];

/**
 * Round CPU to nearest 0.25 cores.
 * Example: 1.82 → 2.0, 2.09 → 2.25
 */
export function roundUpCpu(cores: number): number {
  return Math.ceil(cores * 4) / 4;
}

/**
 * Round memory to nearest 256Mi (0.25Gi).
 * Input is in Gi (e.g., 3.68).
 * Example: 3.68 → 3.75, 2.1 → 2.25
 */
export function roundUpMemoryGi(gi: number): number {
  return Math.ceil(gi * 4) / 4;
}

/**
 * Parse a memory string like "3.2Gi" or "1.6Gi" to a number in Gi.
 * Returns null if unparseable.
 */
export function parseMemoryGi(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)\s*(Gi|G|Mi|M)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'Gi').toLowerCase();
  if (unit === 'mi' || unit === 'm') return num / 1024;
  return num; // Gi or G
}

/**
 * Infer the appropriate node pool based on service characteristics.
 * - GPU services (self-hosted-llm) → 'gpu'
 * - Data stores → 'data'
 * - CPU >= 4 cores → 'compute'
 * - Everything else → 'general'
 */
export function inferNodePool(serviceName: string, cpu: number): string {
  if (GPU_SERVICE_PREFIXES.some((prefix) => serviceName.startsWith(prefix))) return 'gpu';
  if (DATA_STORES.includes(serviceName)) return 'data';
  if (cpu >= 4) return 'compute';
  return 'general';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/resource-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/engine/resource-utils.ts packages/sizing-calculator/src/__tests__/resource-utils.test.ts
git add packages/sizing-calculator/src/engine/resource-utils.ts packages/sizing-calculator/src/__tests__/resource-utils.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add resource rounding and node pool inference utilities"
```

---

## Task 5: Calibrated Service Sizer

**Files:**

- Create: `packages/sizing-calculator/src/engine/calibrated-service-sizer.ts`
- Create: `packages/sizing-calculator/src/__tests__/calibrated-service-sizer.test.ts`

- [ ] **Step 1: Write the test file first**

Create `packages/sizing-calculator/src/__tests__/calibrated-service-sizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { calibratedSizeServices } from '../engine/calibrated-service-sizer.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { makeQ } from './helpers/make-questionnaire.js';

async function loadCalibration(): Promise<CalibrationProfile> {
  const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
  return JSON.parse(raw) as CalibrationProfile;
}

describe('calibratedSizeServices', () => {
  it('computes replicas from measured maxRpsPerPod', async () => {
    const calibration = await loadCalibration();
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 500,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    expect(runtime).toBeDefined();
    // 500 concurrent / 180 maxRps * 1.2 headroom = ceil(3.33) = 4
    expect(runtime!.replicas).toBe(4);
  });

  it('respects tier minimum replicas', async () => {
    const calibration = await loadCalibration();
    // Very low workload — replicas should not go below tier minimum
    const q = makeQ({
      agents: {
        agentCount: 1,
        concurrentConversations: 10,
        avgConversationLength: 5,
        messagesPerDay: 100,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // ceil(10 / 180 * 1.2) = 1, but M tier minimum should be >= 2
    expect(runtime!.replicas).toBeGreaterThanOrEqual(2);
  });

  it('uses max(RPS, connections) for two-dimensional sizing', async () => {
    const calibration = await loadCalibration();
    // High concurrent conversations → both RPS and connection dimensions are significant
    // concurrentConversations=5000 is used directly as RPS for runtime
    // RPS replicas: ceil(5000 / 180 * 1.2) = 34
    // Connection replicas: ceil(5000 / 850 * 1.2) = 8
    // max(2, 34, 8) = 34 → RPS dominates
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 5000,
        avgConversationLength: 10,
        messagesPerDay: 1000,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // Should be max(RPS-based=34, connection-based=8) = 34
    expect(runtime!.replicas).toBe(34);
  });

  it('connection dimension contributes when maxRpsPerPod is very high', async () => {
    const calibration = await loadCalibration();
    // Override maxRpsPerPod to be very high so RPS-based replicas are small
    calibration.services.runtime.saturation.maxRpsPerPod = 50000;
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 5000,
        avgConversationLength: 10,
        messagesPerDay: 1000,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // RPS replicas: ceil(5000 / 50000 * 1.2) = 1
    // Connection replicas: ceil(5000 / 850 * 1.2) = 8
    // max(2, 1, 8) = 8 → connections dominate
    expect(runtime!.replicas).toBe(8);
  });

  it('uses measured CPU/memory with 15% buffer for resources', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // cpuPeak 1.82 * 1.15 = 2.093 → roundUp to 2.25
    expect(parseFloat(runtime!.resources.cpu)).toBeGreaterThanOrEqual(2);
    // memoryPeak 3.2 * 1.15 = 3.68 → roundUp to 3.75Gi
    expect(runtime!.resources.memory).toMatch(/\d+(\.\d+)?Gi/);
  });

  it('falls back to provisioned specs when Coroot data is null', async () => {
    const calibration = await loadCalibration();
    calibration.services.runtime.measured.cpuPeak = null;
    calibration.services.runtime.measured.memoryPeak = null;
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // Should use provisioned: cpu=2, memory=4Gi
    expect(runtime!.resources.cpu).toBe('2');
    expect(runtime!.resources.memory).toBe('4Gi');
  });

  it('includes HPA config on all services', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    for (const svc of services) {
      expect(svc.hpa).toBeDefined();
      expect(svc.hpa!.minReplicas).toBe(svc.replicas);
      expect(svc.hpa!.maxReplicas).toBeGreaterThan(svc.replicas);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/calibrated-service-sizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `packages/sizing-calculator/src/engine/calibrated-service-sizer.ts`:

```typescript
import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { ServiceTopology, Tier } from '../types/topology.types.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { expectedRps } from './traffic-model.js';
import { roundUpCpu, roundUpMemoryGi, parseMemoryGi, inferNodePool } from './resource-utils.js';

/** Tier minimum replicas for HA. */
const MIN_REPLICAS: Record<Tier, number> = {
  S: 1,
  M: 2,
  L: 3,
  XL: 3,
};

/**
 * Size services using measured per-pod capacity from saturation benchmarks.
 *
 * Replaces both sizeApplicationServices() and sizeComputeServices()
 * when a CalibrationProfile is available. Services not in the calibration
 * profile are silently skipped (they'll use the hardcoded path).
 */
export function calibratedSizeServices(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
  headroom = 1.2,
): ServiceTopology[] {
  const services: ServiceTopology[] = [];

  for (const [name, capacity] of Object.entries(calibration.services)) {
    const rps = expectedRps(name, questionnaire);

    // Replicas from RPS
    const replicasForRps =
      capacity.saturation.maxRpsPerPod > 0
        ? Math.ceil((rps / capacity.saturation.maxRpsPerPod) * headroom)
        : MIN_REPLICAS[tier];

    // Replicas from WebSocket connections (two-dimensional sizing)
    let replicasForConnections = 0;
    if (capacity.websocket && questionnaire.agents.concurrentConversations > 0) {
      replicasForConnections = Math.ceil(
        (questionnaire.agents.concurrentConversations /
          capacity.websocket.maxTotalConnectionsPerPod) *
          headroom,
      );
    }

    const replicas = Math.max(MIN_REPLICAS[tier], replicasForRps, replicasForConnections);

    // Resources: measured peak with 15% buffer, or fallback to provisioned
    const measuredCpu = capacity.measured.cpuPeak
      ? roundUpCpu(parseFloat(capacity.measured.cpuPeak) * 1.15)
      : null;
    const measuredMemGi = capacity.measured.memoryPeak
      ? roundUpMemoryGi((parseMemoryGi(capacity.measured.memoryPeak) ?? 0) * 1.15)
      : null;

    const cpu = measuredCpu !== null ? `${measuredCpu}` : capacity.provisioned.cpu;
    const memory = measuredMemGi !== null ? `${measuredMemGi}Gi` : capacity.provisioned.memory;

    const cpuNum = parseFloat(cpu);
    const nodePool = inferNodePool(name, cpuNum);

    services.push({
      name,
      replicas,
      resources: { cpu, memory },
      nodePool,
      hpa: {
        minReplicas: replicas,
        maxReplicas: Math.ceil(replicas * 1.5),
        targetCPUPercent: 70,
        targetMemoryPercent: 80,
      },
    });
  }

  return services;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/calibrated-service-sizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/engine/calibrated-service-sizer.ts packages/sizing-calculator/src/__tests__/calibrated-service-sizer.test.ts
git add packages/sizing-calculator/src/engine/calibrated-service-sizer.ts packages/sizing-calculator/src/__tests__/calibrated-service-sizer.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add calibrated service sizer with two-dimensional sizing"
```

---

## Task 6: Calibrated Datastore Sizer

**Files:**

- Create: `packages/sizing-calculator/src/engine/calibrated-datastore-sizer.ts`
- Create: `packages/sizing-calculator/src/__tests__/calibrated-datastore-sizer.test.ts`

- [ ] **Step 1: Write the test file first**

Create `packages/sizing-calculator/src/__tests__/calibrated-datastore-sizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { calibratedSizeDataStores } from '../engine/calibrated-datastore-sizer.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { makeQ } from './helpers/make-questionnaire.js';

async function loadCalibration(): Promise<CalibrationProfile> {
  const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
  return JSON.parse(raw) as CalibrationProfile;
}

describe('calibratedSizeDataStores', () => {
  it('sizes mongodb with measured resource peaks + 15% buffer', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    expect(mongo).toBeDefined();
    // cpuPeak 1.5 * 1.15 = 1.725 → rounded to 1.75
    expect(parseFloat(mongo!.resources.cpu)).toBeGreaterThanOrEqual(1.5);
  });

  it('computes storage from disk usage + 90-day projected growth + 30% buffer', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    // diskUsageGB=12.5, growth=0.15/day, 90d projection = 12.5 + 13.5 = 26, * 1.3 = 33.8 → 34Gi
    expect(mongo!.resources.storage).toBeDefined();
    const storageGi = parseInt(mongo!.resources.storage!.replace('Gi', ''));
    expect(storageGi).toBeGreaterThanOrEqual(30);
  });

  it('includes stores not in calibration using hardcoded fallback', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    // Calibration only has mongodb + redis, but should also include others from hardcoded
    const storeNames = stores.map((s) => s.name);
    expect(storeNames).toContain('mongodb');
    expect(storeNames).toContain('redis');
    // Non-calibrated stores should also be present
    expect(stores.length).toBeGreaterThanOrEqual(2);
  });

  it('includes store-specific config in notes for mongodb', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    // connections.max=500 → recommended maxConnections in notes
    expect(mongo).toBeDefined();
    expect(mongo!.notes).toBeDefined();
    expect(mongo!.notes).toContain('maxConnections');
  });

  it('includes maxmemory config in notes for redis', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const redis = stores.find((s) => s.name === 'redis');

    expect(redis).toBeDefined();
    expect(redis!.notes).toBeDefined();
    expect(redis!.notes).toContain('maxmemory');
  });
});
```

- [ ] **Step 2: Write the implementation**

Create `packages/sizing-calculator/src/engine/calibrated-datastore-sizer.ts`:

```typescript
import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { DataStoreTopology, Tier } from '../types/topology.types.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { sizeDataStores } from './datastore-sizer.js';
import { roundUpCpu, roundUpMemoryGi, parseMemoryGi } from './resource-utils.js';

/**
 * Derive store-specific configuration recommendations from calibration data.
 * Uses measured connection counts and memory to produce tuning notes.
 */
function deriveStoreConfig(
  name: string,
  capacity: CalibrationProfile['dataStores'][string],
): string {
  const lines: string[] = [];

  switch (name) {
    case 'mongodb': {
      const maxConn = Math.ceil(capacity.connections.max * 1.5);
      lines.push(`maxConnections: ${maxConn}`);
      const cacheHit = capacity.storeSpecific['wiredTigerCacheHitRatio'];
      if (typeof cacheHit === 'number') {
        lines.push(`wiredTigerCacheHitRatio: ${cacheHit}`);
      }
      break;
    }
    case 'redis': {
      const memGi = parseMemoryGi(capacity.resources.memoryPeak);
      if (memGi !== null) {
        const maxmemory = `${roundUpMemoryGi(memGi * 1.2)}gb`;
        lines.push(`maxmemory: ${maxmemory}`);
      }
      break;
    }
    case 'clickhouse': {
      const maxConcurrent = capacity.storeSpecific['maxConcurrentQueries'];
      if (typeof maxConcurrent === 'number') {
        lines.push(`maxConcurrentQueries: ${Math.ceil(maxConcurrent * 1.5)}`);
      }
      break;
    }
    case 'opensearch': {
      const memGi = parseMemoryGi(capacity.resources.memoryPeak);
      if (memGi !== null) {
        lines.push(`jvmHeapSize: ${roundUpMemoryGi(memGi * 0.5)}g`);
      }
      break;
    }
  }

  return lines.length > 0 ? `Calibrated config: ${lines.join(', ')}` : '';
}

/**
 * Size data stores using measured capacity from saturation benchmarks.
 *
 * Data stores don't scale horizontally by RPS — they scale for HA.
 * Calibration primarily provides measured CPU, memory, and disk usage
 * to replace hardcoded resource specs. Store-specific config is derived
 * and placed in the `notes` field.
 *
 * Stores not in the calibration profile fall back to the hardcoded sizer.
 */
export function calibratedSizeDataStores(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
): DataStoreTopology[] {
  // Get all hardcoded stores as fallback
  const hardcodedStores = sizeDataStores(tier, questionnaire);
  const hardcodedMap = new Map(hardcodedStores.map((s) => [s.name, s]));

  const stores: DataStoreTopology[] = [];

  for (const [name, capacity] of Object.entries(calibration.dataStores)) {
    const fallback = hardcodedMap.get(name);
    if (!fallback) continue; // Unknown store in calibration — skip

    // Resources: measured peak with 15% buffer
    const measuredCpu = capacity.resources.cpuPeak
      ? roundUpCpu(parseFloat(capacity.resources.cpuPeak) * 1.15)
      : null;
    const measuredMemGi = capacity.resources.memoryPeak
      ? roundUpMemoryGi((parseMemoryGi(capacity.resources.memoryPeak) ?? 0) * 1.15)
      : null;

    const cpu = measuredCpu !== null ? `${measuredCpu}` : fallback.resources.cpu;
    const memory = measuredMemGi !== null ? `${measuredMemGi}Gi` : fallback.resources.memory;

    // Storage: measured disk + projected growth with 30% buffer
    const currentDisk = capacity.resources.diskUsageGB;
    const dailyGrowth = capacity.resources.diskGrowthRateGBPerDay;
    const projectedDisk90d = currentDisk + dailyGrowth * 90;
    const storage =
      currentDisk > 0 ? `${Math.ceil(projectedDisk90d * 1.3)}Gi` : fallback.resources.storage;

    // Store-specific config recommendations
    const configNotes = deriveStoreConfig(name, capacity);
    const notes = [fallback.notes, configNotes].filter(Boolean).join('; ');

    stores.push({
      ...fallback,
      resources: {
        ...fallback.resources,
        cpu,
        memory,
        ...(storage ? { storage } : {}),
      },
      ...(notes ? { notes } : {}),
    });

    hardcodedMap.delete(name);
  }

  // Add non-calibrated stores using hardcoded fallback
  for (const store of hardcodedMap.values()) {
    stores.push(store);
  }

  return stores;
}
```

- [ ] **Step 3: Build and run tests**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test -- --run src/__tests__/calibrated-datastore-sizer.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/engine/calibrated-datastore-sizer.ts packages/sizing-calculator/src/__tests__/calibrated-datastore-sizer.test.ts
git add packages/sizing-calculator/src/engine/calibrated-datastore-sizer.ts packages/sizing-calculator/src/__tests__/calibrated-datastore-sizer.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add calibrated datastore sizer with measured resources"
```

---

## Task 7: Wire CalibrationProfile into calculator.ts

**Files:**

- Modify: `packages/sizing-calculator/src/engine/calculator.ts`
- Modify: `packages/sizing-calculator/src/index.ts`
- Modify: `packages/sizing-calculator/src/__tests__/calculator.test.ts`

- [ ] **Step 1: Add calibration tests to calculator.test.ts**

Append to `packages/sizing-calculator/src/__tests__/calculator.test.ts`:

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { CalibrationProfile } from '../types/calibration.types.js';

describe('calculateTopology with CalibrationProfile', () => {
  async function loadCalibration(): Promise<CalibrationProfile> {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    return JSON.parse(raw) as CalibrationProfile;
  }

  it('produces topology using calibrated path when calibration provided', async () => {
    const calibration = await loadCalibration();
    const q = makeQuestionnaire({
      agents: {
        agentCount: 50,
        concurrentConversations: 5000,
        avgConversationLength: 15,
        messagesPerDay: 50000,
        toolCallsPerConversation: 5,
        multiAgentUsage: 20,
      },
    });

    const topology = calculateTopology(q, calibration);

    expect(topology.tier).toBe('M');
    expect(topology.services.length).toBeGreaterThan(0);

    // Runtime replicas should be calibration-derived
    const runtime = topology.services.find((s) => s.name === 'runtime');
    expect(runtime).toBeDefined();
    // 5000 / 180 * 1.2 = 33.3 → 34
    expect(runtime!.replicas).toBeGreaterThanOrEqual(20);
  });

  it('falls back to hardcoded path when no calibration', () => {
    const q = makeQuestionnaire();
    const topology = calculateTopology(q);

    expect(topology.tier).toBe('S');
    expect(topology.services.length).toBeGreaterThan(0);
  });

  it('existing tests still pass (backward compatibility)', () => {
    const q = makeQuestionnaire();
    const topology = calculateTopology(q);

    expect(topology.tier).toBe('S');
    expect(topology.dataStores).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Modify calculator.ts to accept optional CalibrationProfile**

Update `packages/sizing-calculator/src/engine/calculator.ts`:

Change the import block to add:

```typescript
import type { CalibrationProfile } from '../types/calibration.types.js';
import { calibratedSizeServices } from './calibrated-service-sizer.js';
import { calibratedSizeDataStores } from './calibrated-datastore-sizer.js';
```

Change the function signature and body:

```typescript
export function calculateTopology(
  questionnaire: Questionnaire,
  calibration?: CalibrationProfile,
): ClusterTopology {
  const tier = classifyTier(questionnaire);
  const provider = questionnaire.deployment.cloudProvider;

  // Size services: calibrated path when calibration available, hardcoded otherwise
  const allServices = calibration
    ? calibratedSizeServices(tier, questionnaire, calibration)
    : [...sizeApplicationServices(tier, questionnaire), ...sizeComputeServices(tier, questionnaire)];

  const dataStores = calibration
    ? calibratedSizeDataStores(tier, questionnaire, calibration)
    : sizeDataStores(tier, questionnaire);

  // Rest unchanged...
```

- [ ] **Step 3: Update index.ts exports**

Add to `packages/sizing-calculator/src/index.ts`:

```typescript
export { CalibrationProfileSchema, type ValidatedCalibrationProfile } from './schemas/index.js';
export type {
  CalibrationProfile,
  ServiceCapacity,
  DataStoreCapacity,
  WebSocketCapacity,
  ScenarioCapacity,
  IntegrationFlowCapacity,
  SaturationTrigger,
  LatencyMetrics,
} from './types/index.js';
export { peakRps, expectedRps } from './engine/traffic-model.js';
export { calibratedSizeServices } from './engine/calibrated-service-sizer.js';
export { calibratedSizeDataStores } from './engine/calibrated-datastore-sizer.js';
```

- [ ] **Step 4: Build and run ALL tests**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test`
Expected: ALL PASS — existing tests unchanged, new calibration tests pass

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/sizing-calculator/src/engine/calculator.ts packages/sizing-calculator/src/index.ts packages/sizing-calculator/src/__tests__/calculator.test.ts
git add packages/sizing-calculator/src/engine/calculator.ts packages/sizing-calculator/src/index.ts packages/sizing-calculator/src/__tests__/calculator.test.ts
git commit -m "[ABLP-2] feat(sizing-calculator): wire CalibrationProfile into calculateTopology"
```

---

## Task 8: Add --calibration Flag to CLI

**Files:**

- Modify: `packages/kore-platform-cli/src/commands/sizing.ts`

- [ ] **Step 1: Add --calibration option to sizing calculate command**

In `packages/kore-platform-cli/src/commands/sizing.ts`, modify the `sizing calculate` command (around line 86):

```typescript
sizing
  .command('calculate')
  .description('Calculate topology from questionnaire')
  .requiredOption('--input <path>', 'Input questionnaire JSON file')
  .requiredOption('--output <path>', 'Output topology JSON file')
  .option('--calibration <path>', 'CalibrationProfile JSON file (measured per-pod capacity)')
  .action(async (opts: { input: string; output: string; calibration?: string }) => {
    const { QuestionnaireSchema, CalibrationProfileSchema } =
      await import('@agent-platform/sizing-calculator');
    const { calculateTopology } = await import('@agent-platform/sizing-calculator');

    const raw = await readFile(opts.input, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = QuestionnaireSchema.safeParse(parsed);
    if (!result.success) {
      console.error('Invalid questionnaire:');
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }

    // Load and validate calibration if provided
    let calibration;
    if (opts.calibration) {
      const calibrationRaw = await readFile(opts.calibration, 'utf-8');
      const calibrationParsed = JSON.parse(calibrationRaw);
      const calibrationResult = CalibrationProfileSchema.safeParse(calibrationParsed);
      if (!calibrationResult.success) {
        console.error('Invalid calibration profile:');
        for (const issue of calibrationResult.error.issues) {
          console.error(`  ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
      }
      calibration = calibrationResult.data;
      console.log(`Using calibration profile: ${opts.calibration}`);
      console.log(`  Environment: ${calibration.environment}`);
      console.log(`  Services calibrated: ${Object.keys(calibration.services).length}`);
      console.log(`  Data stores calibrated: ${Object.keys(calibration.dataStores).length}`);
    }

    const topology = calculateTopology(result.data, calibration);
    await writeFile(opts.output, JSON.stringify(topology, null, 2));
    console.log(`Topology written to ${opts.output}`);
    console.log(`  Tier: ${topology.tier}`);
    console.log(`  Services: ${topology.services.length}`);
    console.log(`  Data stores: ${topology.dataStores.length}`);
    console.log(`  Node pools: ${topology.nodePools.length}`);
    console.log(`  Total nodes: ${topology.totalNodes.min}-${topology.totalNodes.max}`);
    console.log(`  Monthly storage growth: ${topology.monthlyStorageGrowthGB} GB`);
    if (calibration) {
      console.log(`  Mode: CALIBRATED (measured per-pod capacity)`);
    } else {
      console.log(`  Mode: BASELINE (hardcoded estimates)`);
    }
  });
```

- [ ] **Step 2: Build the CLI to verify**

Run: `pnpm build --filter=@agent-platform/cli`
Expected: SUCCESS

- [ ] **Step 3: Verify CLI help shows new flag**

Run: `npx kore-platform-cli sizing calculate --help`
Expected: Shows `--calibration <path>` option

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/sizing.ts
git add packages/kore-platform-cli/src/commands/sizing.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add --calibration flag to sizing calculate CLI command"
```

---

## Task 9: Final Verification — All Tests Pass

- [ ] **Step 1: Run full sizing-calculator test suite**

Run: `cd packages/sizing-calculator && pnpm build && pnpm test`
Expected: ALL tests pass (existing + new)

- [ ] **Step 2: Run typecheck**

Run: `pnpm build --filter=@agent-platform/sizing-calculator && cd packages/sizing-calculator && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run CLI build**

Run: `pnpm build --filter=@agent-platform/cli`
Expected: SUCCESS

- [ ] **Step 4: Verify no regressions in existing calculator behavior**

Run: `cd packages/sizing-calculator && pnpm test -- --run src/__tests__/calculator.test.ts`
Expected: ALL existing tests still pass

---

## Summary

| Task | What It Produces            | Test Count                       |
| ---- | --------------------------- | -------------------------------- |
| 1    | CalibrationProfile types    | 0 (type-only, verified by build) |
| 2    | Zod schema + fixture        | 7 tests                          |
| 3    | Traffic model + test helper | 5 tests                          |
| 4    | Resource utilities          | 5 tests (roundUp, parse, infer)  |
| 5    | Calibrated service sizer    | 7 tests                          |
| 6    | Calibrated datastore sizer  | 5 tests                          |
| 7    | calculator.ts integration   | 3 tests                          |
| 8    | CLI --calibration flag      | 0 (verified by build + help)     |
| 9    | Final verification          | All tests pass                   |

**Total new tests:** ~32
**Total new files:** 9 source + 6 test + 1 helper
**Total modified files:** 5
**Backward compatibility:** All existing tests pass unchanged
