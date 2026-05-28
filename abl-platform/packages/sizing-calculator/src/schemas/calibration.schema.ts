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
