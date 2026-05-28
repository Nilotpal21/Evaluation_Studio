/**
 * Profile Assembler for Benchmark Orchestrator
 *
 * Combines k6 results, saturation detection, pod resources, and optional
 * Coroot metrics into CalibrationProfile objects.
 */

import type {
  CalibrationProfile,
  ServiceCapacity,
  SaturationTrigger,
  Tier,
} from '@agent-platform/sizing-calculator';
import type { K6SaturationResult } from './k6-runner.js';
import type { SaturationResult } from './saturation-detector.js';
import type { PodResources } from './kubectl-ops.js';

export interface ServiceCapacityInput {
  serviceName: string;
  k6Result: K6SaturationResult;
  saturation: SaturationResult;
  podResources: PodResources;
  testedUrl: string;
  testedViaIngress: boolean;
  baselineP95Ms: number;
  measured?: {
    cpuPeak: string | null;
    cpuAvg: string | null;
    memoryPeak: string | null;
    memoryAvg: string | null;
    podRestarts: number;
    oomKills: number;
  };
}

export interface ProfileAssemblyInput {
  tier: Tier;
  environment: string;
  services: Record<string, ServiceCapacity>;
  dataStores?: Record<string, CalibrationProfile['dataStores'][string]>;
}

/**
 * Assemble a ServiceCapacity from benchmark results for a single service.
 */
export function assembleServiceCapacity(opts: ServiceCapacityInput): ServiceCapacity {
  const trigger: SaturationTrigger =
    opts.saturation.trigger === 'none' ? 'error-rate' : opts.saturation.trigger;

  return {
    provisioned: {
      cpu: opts.podResources.cpu,
      memory: opts.podResources.memory,
    },
    saturation: {
      trigger,
      maxRpsPerPod: opts.saturation.maxRpsPerPod,
      maxConcurrentPerPod: opts.saturation.maxConcurrentPerPod,
    },
    websocket: null,
    scenarios: {},
    measured: opts.measured ?? {
      cpuPeak: null,
      cpuAvg: null,
      memoryPeak: null,
      memoryAvg: null,
      podRestarts: 0,
      oomKills: 0,
    },
    latency: {
      p50Ms: opts.k6Result.latency.p50Ms,
      p95Ms: opts.k6Result.latency.p95Ms,
      p99Ms: opts.k6Result.latency.p99Ms,
      minMs: opts.k6Result.latency.minMs,
      maxMs: opts.k6Result.latency.maxMs,
      baselineP95Ms: opts.baselineP95Ms,
    },
    testedUrl: opts.testedUrl,
    testedViaIngress: opts.testedViaIngress,
  };
}

/**
 * Create a complete CalibrationProfile from collected service capacities.
 */
export function assembleProfile(opts: ProfileAssemblyInput): CalibrationProfile {
  return {
    version: '1.0',
    tier: opts.tier,
    timestamp: new Date().toISOString(),
    environment: opts.environment,
    services: opts.services,
    dataStores: opts.dataStores ?? {},
  };
}

/**
 * Merge multiple CalibrationProfiles. Last value wins for overlapping service keys.
 * Throws on tier mismatch or empty input array.
 */
export function mergeProfiles(profiles: CalibrationProfile[]): CalibrationProfile {
  if (profiles.length === 0) {
    throw new Error('Cannot merge zero profiles');
  }

  const tier = profiles[0].tier;
  for (const p of profiles) {
    if (p.tier !== tier) {
      throw new Error(`Tier mismatch: first profile has tier "${tier}" but found "${p.tier}"`);
    }
  }

  const mergedServices: Record<string, ServiceCapacity> = {};
  const mergedDataStores: Record<string, CalibrationProfile['dataStores'][string]> = {};
  let latestTimestamp = profiles[0].timestamp;

  for (const p of profiles) {
    for (const [key, value] of Object.entries(p.services)) {
      mergedServices[key] = value;
    }
    for (const [key, value] of Object.entries(p.dataStores)) {
      mergedDataStores[key] = value;
    }
    if (p.timestamp > latestTimestamp) {
      latestTimestamp = p.timestamp;
    }
  }

  return {
    version: '1.0',
    tier,
    timestamp: latestTimestamp,
    environment: profiles[profiles.length - 1].environment,
    services: mergedServices,
    dataStores: mergedDataStores,
  };
}
