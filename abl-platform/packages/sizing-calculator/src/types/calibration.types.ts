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
