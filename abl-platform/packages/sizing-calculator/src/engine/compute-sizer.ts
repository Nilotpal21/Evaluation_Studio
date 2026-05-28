import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { ServiceTopology, Tier, HpaConfig, KedaTrigger } from '../types/topology.types.js';
import { COMPUTE_SERVICES, SELF_HOSTED_LLM_SPECS, GPU_REQUIREMENTS } from './constants.js';

/**
 * Size compute-intensive services (Tier 1): BGE-M3, Docling, self-hosted LLM.
 *
 * Handles GPU node pool generation when self-hosted LLM is selected,
 * KEDA config for BGE-M3, and Docling scaling based on document volume.
 */
export function sizeComputeServices(tier: Tier, questionnaire: Questionnaire): ServiceTopology[] {
  const services: ServiceTopology[] = [];

  // BGE-M3 Embeddings
  if (questionnaire.llm.embeddingModel === 'bge-m3') {
    services.push(sizeBgeM3(tier, questionnaire));
  }

  // Docling (document processing)
  services.push(sizeDocling(tier, questionnaire));

  // Self-hosted LLM (vLLM/TGI)
  if (questionnaire.llm.hostingModel !== 'external-api') {
    const llmServices = sizeSelfHostedLlm(questionnaire);
    services.push(...llmServices);
  }

  return services;
}

function sizeBgeM3(tier: Tier, q: Questionnaire): ServiceTopology {
  const baseline = COMPUTE_SERVICES['bge-m3'][tier];
  let replicas = baseline.replicas;

  // Scale based on vector search volume + ingestion
  const queryFactor = q.knowledgeBase.vectorSearchQueriesPerDay / getBgeQueryThreshold(tier);
  if (queryFactor > 1.5) {
    replicas = Math.ceil(replicas * Math.min(queryFactor, 3));
  }

  // Add KEDA trigger for queue-based scaling
  const kedaTriggers: KedaTrigger[] = [];
  if (
    q.knowledgeBase.ingestionFrequency === 'real-time' ||
    q.knowledgeBase.ingestionFrequency === 'hourly'
  ) {
    kedaTriggers.push({
      type: 'redis',
      metadata: {
        address: 'redis:6379',
        listName: 'queue:embedding',
        listLength: '100',
      },
    });
  }

  const hpa: HpaConfig = {
    minReplicas: replicas,
    maxReplicas: baseline.maxReplicas ?? replicas * 2,
    targetCPUPercent: 70,
    ...(kedaTriggers.length > 0 ? { kedaTriggers } : {}),
  };

  return {
    name: 'bge-m3',
    replicas,
    resources: { cpu: baseline.cpu, memory: baseline.memory },
    nodePool: baseline.nodePool,
    hpa,
  };
}

function sizeDocling(tier: Tier, q: Questionnaire): ServiceTopology {
  const baseline = COMPUTE_SERVICES.docling[tier];
  let replicas = baseline.replicas;

  // Scale based on document volume and types
  const hasHeavyDocs = q.knowledgeBase.documentTypes.some((t) =>
    ['pdf', 'image', 'video'].includes(t),
  );
  const docFactor = q.knowledgeBase.totalDocuments / getDoclingThreshold(tier);

  if (hasHeavyDocs && docFactor > 1.5) {
    replicas = Math.ceil(replicas * Math.min(docFactor, 2.5));
  }

  const hpa: HpaConfig | undefined = baseline.maxReplicas
    ? {
        minReplicas: replicas,
        maxReplicas: Math.max(baseline.maxReplicas, replicas),
        targetCPUPercent: 70,
      }
    : undefined;

  return {
    name: 'docling',
    replicas,
    resources: { cpu: baseline.cpu, memory: baseline.memory },
    nodePool: baseline.nodePool,
    ...(hpa ? { hpa } : {}),
  };
}

function sizeSelfHostedLlm(q: Questionnaire): ServiceTopology[] {
  const models = q.llm.selfHostedModels ?? [];
  if (models.length === 0) {
    // Default to a generic self-hosted model
    return [createLlmService('custom', q)];
  }

  return models.map((model) => createLlmService(model, q));
}

function createLlmService(model: string, q: Questionnaire): ServiceTopology {
  const spec = SELF_HOSTED_LLM_SPECS[model] ?? SELF_HOSTED_LLM_SPECS.custom;
  const gpu = GPU_REQUIREMENTS[model] ?? GPU_REQUIREMENTS.custom;

  // Scale replicas with concurrent LLM requests
  let replicas = spec.replicas;
  const requestFactor = q.llm.concurrentRequests / 100;
  if (requestFactor > 2) {
    replicas = Math.ceil(replicas * Math.min(requestFactor / 2, 4));
  }

  return {
    name: `self-hosted-llm-${model}`,
    replicas,
    resources: {
      cpu: spec.cpu,
      memory: spec.memory,
      gpu,
    },
    nodePool: 'gpu',
    hpa: {
      minReplicas: replicas,
      maxReplicas: spec.maxReplicas ?? replicas * 2,
      targetCPUPercent: 60,
    },
  };
}

function getBgeQueryThreshold(tier: Tier): number {
  const thresholds: Record<Tier, number> = { S: 500, M: 50000, L: 500000, XL: 2000000 };
  return thresholds[tier];
}

function getDoclingThreshold(tier: Tier): number {
  const thresholds: Record<Tier, number> = { S: 5000, M: 50000, L: 500000, XL: 2000000 };
  return thresholds[tier];
}
