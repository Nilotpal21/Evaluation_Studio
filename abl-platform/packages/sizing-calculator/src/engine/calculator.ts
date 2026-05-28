import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { ClusterTopology, NodePool } from '../types/topology.types.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { classifyTier } from './tier-classifier.js';
import { sizeApplicationServices } from './service-sizer.js';
import { sizeComputeServices } from './compute-sizer.js';
import { sizeDataStores } from './datastore-sizer.js';
import { calibratedSizeServices } from './calibrated-service-sizer.js';
import { calibratedSizeDataStores } from './calibrated-datastore-sizer.js';
import { calculateDiskGrowth } from './disk-growth.js';
import { recommendManagedServices } from './managed-recommender.js';
import { INSTANCE_TYPES, NODE_POOL_SIZING } from './constants.js';

/**
 * Main entry point: takes a questionnaire, produces a complete ClusterTopology.
 *
 * Orchestrates: tier classifier → service sizer → compute sizer →
 * datastore sizer → disk growth → managed recommender → node pool assembly.
 */
export function calculateTopology(
  questionnaire: Questionnaire,
  calibration?: CalibrationProfile,
): ClusterTopology {
  const tier = classifyTier(questionnaire);
  const provider = questionnaire.deployment.cloudProvider;

  // Size services: calibrated path when calibration available, hardcoded otherwise
  const allServices = calibration
    ? calibratedSizeServices(tier, questionnaire, calibration)
    : [
        ...sizeApplicationServices(tier, questionnaire),
        ...sizeComputeServices(tier, questionnaire),
      ];

  const dataStores = calibration
    ? calibratedSizeDataStores(tier, questionnaire, calibration)
    : sizeDataStores(tier, questionnaire);

  // Calculate disk growth projections
  const diskGrowth = calculateDiskGrowth(questionnaire);
  const monthlyStorageGrowthGB = diskGrowth.reduce((sum, d) => sum + d.monthlyGB, 0);

  // Managed vs self-hosted recommendations
  const managedRecommendations = recommendManagedServices(tier, questionnaire);

  // Assemble node pools
  const nodePools = assembleNodePools(tier, provider, allServices, questionnaire);

  // Calculate total node counts
  const totalNodes = calculateTotalNodes(tier, questionnaire);

  return {
    tier,
    cloudProvider: provider,
    regionCount: questionnaire.deployment.regionCount,
    services: allServices,
    dataStores,
    nodePools,
    totalNodes,
    diskGrowth,
    managedRecommendations,
    monthlyStorageGrowthGB: Math.round(monthlyStorageGrowthGB * 100) / 100,
  };
}

function assembleNodePools(
  tier: string,
  provider: string,
  services: { nodePool: string }[],
  questionnaire: Questionnaire,
): NodePool[] {
  const pools: NodePool[] = [];
  const usedPools = new Set(services.map((s) => s.nodePool));

  // Always include general and data pools
  usedPools.add('general');
  usedPools.add('data');

  for (const poolName of usedPools) {
    const instanceKey = `${poolName}-${tier}`;
    const instanceType =
      INSTANCE_TYPES[provider]?.[instanceKey] ?? INSTANCE_TYPES.aws[instanceKey] ?? 'custom';
    const sizing = NODE_POOL_SIZING[tier as keyof typeof NODE_POOL_SIZING]?.[poolName];

    const pool: NodePool = {
      name: poolName,
      instanceType,
      minNodes: sizing?.min ?? 1,
      maxNodes: sizing?.max ?? 3,
      labels: { 'node-role': poolName },
    };

    // Add GPU taints
    if (poolName === 'gpu') {
      pool.taints = [{ key: 'nvidia.com/gpu', value: 'true', effect: 'NoSchedule' }];
      pool.labels['accelerator'] = 'nvidia';
      // GPU pool sizing depends on model count
      const gpuModels = questionnaire.llm.selfHostedModels ?? [];
      pool.minNodes = Math.max(gpuModels.length, 1);
      pool.maxNodes = pool.minNodes * 2;
    }

    pools.push(pool);
  }

  return pools;
}

function calculateTotalNodes(
  tier: string,
  questionnaire: Questionnaire,
): { min: number; max: number } {
  const poolSizing = NODE_POOL_SIZING[tier as keyof typeof NODE_POOL_SIZING];
  if (!poolSizing) {
    return { min: 5, max: 10 };
  }

  let min = 0;
  let max = 0;
  for (const pool of Object.values(poolSizing)) {
    min += pool.min;
    max += pool.max;
  }

  // Add GPU nodes if self-hosted LLM
  if (questionnaire.llm.hostingModel !== 'external-api') {
    const gpuModels = questionnaire.llm.selfHostedModels ?? [];
    min += Math.max(gpuModels.length, 1);
    max += Math.max(gpuModels.length * 2, 2);
  }

  return { min, max };
}
