import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { ServiceTopology, Tier, HpaConfig } from '../types/topology.types.js';
import { APPLICATION_SERVICES } from './constants.js';

/**
 * Size application services (Tier 3) based on tier and questionnaire inputs.
 *
 * Starts from baseline specs for the tier, then adjusts replicas based
 * on actual workload dimensions from the questionnaire.
 */
export function sizeApplicationServices(
  tier: Tier,
  questionnaire: Questionnaire,
): ServiceTopology[] {
  const services: ServiceTopology[] = [];

  for (const [name, tierSpecs] of Object.entries(APPLICATION_SERVICES)) {
    const baseline = tierSpecs[tier];

    // Skip services with 0 replicas (e.g., crawler-mcp at tier S)
    if (baseline.replicas === 0) continue;

    let adjustedReplicas = baseline.replicas;
    let hpa: HpaConfig | undefined;

    // Adjust replicas based on workload
    adjustedReplicas = adjustReplicasForWorkload(name, tier, adjustedReplicas, questionnaire);

    // Configure HPA if max replicas defined
    if (baseline.maxReplicas) {
      hpa = {
        minReplicas: adjustedReplicas,
        maxReplicas: Math.max(baseline.maxReplicas, adjustedReplicas),
        targetCPUPercent: 70,
        targetMemoryPercent: 80,
      };
    }

    services.push({
      name,
      replicas: adjustedReplicas,
      resources: {
        cpu: baseline.cpu,
        memory: baseline.memory,
      },
      nodePool: baseline.nodePool,
      ...(hpa ? { hpa } : {}),
    });
  }

  return services;
}

function adjustReplicasForWorkload(
  serviceName: string,
  tier: Tier,
  baseReplicas: number,
  q: Questionnaire,
): number {
  switch (serviceName) {
    case 'runtime': {
      // Scale runtime with concurrent conversations
      const conversationFactor = q.agents.concurrentConversations / getConversationThreshold(tier);
      if (conversationFactor > 1.5) {
        return Math.ceil(baseReplicas * Math.min(conversationFactor, 3));
      }
      return baseReplicas;
    }
    case 'search-ai':
    case 'search-ai-runtime': {
      // Scale with document volume and search queries
      const docFactor = q.knowledgeBase.totalDocuments / getDocumentThreshold(tier);
      if (docFactor > 1.5) {
        return Math.ceil(baseReplicas * Math.min(docFactor, 2.5));
      }
      return baseReplicas;
    }
    case 'workflow-engine': {
      // Scale with workflow executions
      const wfFactor = q.workflows.executionsPerDay / getWorkflowThreshold(tier);
      if (wfFactor > 1.5) {
        return Math.ceil(baseReplicas * Math.min(wfFactor, 2));
      }
      return baseReplicas;
    }
    case 'crawler-go':
    case 'crawler-mcp': {
      // Scale with connector types and documents
      if (q.knowledgeBase.connectorTypes.includes('web-crawl')) {
        return Math.ceil(baseReplicas * 1.5);
      }
      return baseReplicas;
    }
    default:
      return baseReplicas;
  }
}

function getConversationThreshold(tier: Tier): number {
  const thresholds: Record<Tier, number> = { S: 500, M: 5000, L: 100000, XL: 500000 };
  return thresholds[tier];
}

function getDocumentThreshold(tier: Tier): number {
  const thresholds: Record<Tier, number> = { S: 5000, M: 100000, L: 1000000, XL: 5000000 };
  return thresholds[tier];
}

function getWorkflowThreshold(tier: Tier): number {
  const thresholds: Record<Tier, number> = { S: 500, M: 10000, L: 100000, XL: 500000 };
  return thresholds[tier];
}
