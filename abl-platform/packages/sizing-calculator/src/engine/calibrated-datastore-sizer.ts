import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { DataStoreTopology, Tier } from '../types/topology.types.js';
import type { CalibrationProfile, DataStoreCapacity } from '../types/calibration.types.js';
import { sizeDataStores } from './datastore-sizer.js';
import { roundUpCpu, roundUpMemoryGi, parseMemoryGi } from './resource-utils.js';

/** Buffer applied to measured CPU/memory peaks. */
const RESOURCE_BUFFER = 1.15;

/** Buffer applied to projected storage. */
const STORAGE_BUFFER = 1.3;

/** Days of growth to project forward for storage. */
const GROWTH_PROJECTION_DAYS = 90;

/**
 * Derive store-specific configuration notes from calibration data.
 */
export function deriveStoreConfig(name: string, capacity: DataStoreCapacity): string {
  const parts: string[] = [];

  switch (name) {
    case 'mongodb': {
      const maxConnections = Math.ceil(capacity.connections.max * 1.5);
      parts.push(`maxConnections: ${maxConnections}`);
      const cacheHitRatio = capacity.storeSpecific['wiredTigerCacheHitRatio'];
      if (cacheHitRatio !== null && cacheHitRatio !== undefined) {
        parts.push(`wiredTigerCacheHitRatio: ${cacheHitRatio}`);
      }
      break;
    }
    case 'redis': {
      const memoryPeakGi = capacity.resources.memoryPeak
        ? parseMemoryGi(capacity.resources.memoryPeak)
        : null;
      if (memoryPeakGi !== null) {
        const maxmemory = roundUpMemoryGi(memoryPeakGi * 1.2);
        parts.push(`maxmemory: ${maxmemory}Gi`);
      }
      break;
    }
    case 'clickhouse': {
      const maxConcurrentQueries = capacity.storeSpecific['maxConcurrentQueries'];
      if (maxConcurrentQueries !== null && maxConcurrentQueries !== undefined) {
        parts.push(`maxConcurrentQueries: ${maxConcurrentQueries}`);
      }
      break;
    }
    case 'opensearch': {
      const memoryPeakGi = capacity.resources.memoryPeak
        ? parseMemoryGi(capacity.resources.memoryPeak)
        : null;
      if (memoryPeakGi !== null) {
        const jvmHeapSize = roundUpMemoryGi(memoryPeakGi * 0.5);
        parts.push(`jvmHeapSize: ${jvmHeapSize}Gi`);
      }
      break;
    }
  }

  return parts.join('; ');
}

/**
 * Size data stores using calibration measurements, falling back to
 * hardcoded tier-based values for stores without calibration data.
 *
 * For calibrated stores:
 * - CPU/memory: measured peak * 1.15 buffer
 * - Storage: diskUsageGB + (dailyGrowth * 90 days) with 30% buffer
 * - Store-specific config notes derived from calibration
 */
export function calibratedSizeDataStores(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
): DataStoreTopology[] {
  const hardcoded = sizeDataStores(tier, questionnaire);
  const fallbackMap = new Map<string, DataStoreTopology>();
  for (const store of hardcoded) {
    fallbackMap.set(store.name, store);
  }

  const result: DataStoreTopology[] = [];

  // Process calibrated stores
  for (const [name, capacity] of Object.entries(calibration.dataStores)) {
    const fallback = fallbackMap.get(name);
    if (!fallback) {
      // Calibration references a store we don't know about; skip
      continue;
    }

    // CPU with buffer
    const measuredCpu = capacity.resources.cpuPeak
      ? roundUpCpu(parseFloat(capacity.resources.cpuPeak) * RESOURCE_BUFFER)
      : null;

    // Memory with buffer
    const measuredMemGi = capacity.resources.memoryPeak
      ? roundUpMemoryGi((parseMemoryGi(capacity.resources.memoryPeak) ?? 0) * RESOURCE_BUFFER)
      : null;

    // Storage: current disk + 90-day growth projection, with 30% buffer
    const projectedStorage =
      (capacity.resources.diskUsageGB +
        capacity.resources.diskGrowthRateGBPerDay * GROWTH_PROJECTION_DAYS) *
      STORAGE_BUFFER;
    const storageGi = projectedStorage > 0 ? Math.ceil(projectedStorage) : null;

    const cpu = measuredCpu !== null ? `${measuredCpu}` : fallback.resources.cpu;
    const memory = measuredMemGi !== null ? `${measuredMemGi}Gi` : fallback.resources.memory;
    const storage = storageGi !== null ? `${storageGi}Gi` : fallback.resources.storage;

    const notes = deriveStoreConfig(name, capacity);

    result.push({
      ...fallback,
      resources: {
        ...fallback.resources,
        cpu,
        memory,
        ...(storage !== undefined ? { storage } : {}),
      },
      ...(notes ? { notes } : {}),
    });

    fallbackMap.delete(name);
  }

  // Add remaining non-calibrated stores with hardcoded values
  for (const store of fallbackMap.values()) {
    result.push(store);
  }

  return result;
}
