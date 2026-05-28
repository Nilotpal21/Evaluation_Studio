import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateTopology } from '../engine/calculator.js';
import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { CalibrationProfile } from '../types/calibration.types.js';

function makeQuestionnaire(overrides: Partial<Questionnaire> = {}): Questionnaire {
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
      concurrentConversations: 100,
      avgConversationLength: 10,
      messagesPerDay: 1000,
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
      vectorSearchQueriesPerDay: 500,
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

describe('calculateTopology', () => {
  it('produces complete tier S topology', () => {
    const q = makeQuestionnaire();
    const topology = calculateTopology(q);

    expect(topology.tier).toBe('S');
    expect(topology.cloudProvider).toBe('aws');
    expect(topology.services.length).toBeGreaterThan(0);
    expect(topology.dataStores).toHaveLength(7);
    expect(topology.nodePools.length).toBeGreaterThanOrEqual(3);
    expect(topology.diskGrowth).toHaveLength(7);
    expect(topology.managedRecommendations).toHaveLength(7);
    expect(topology.monthlyStorageGrowthGB).toBeGreaterThan(0);
  });

  it('produces tier M topology for mid-market workload', () => {
    const q = makeQuestionnaire({
      agents: {
        agentCount: 50,
        concurrentConversations: 5000,
        avgConversationLength: 15,
        messagesPerDay: 50000,
        toolCallsPerConversation: 5,
        multiAgentUsage: 20,
      },
      knowledgeBase: {
        totalDocuments: 100000,
        avgDocumentSize: 'medium',
        documentTypes: ['pdf', 'word', 'html'],
        ingestionFrequency: 'daily',
        connectorTypes: ['file-upload', 'web-crawl'],
        kbPerProject: 5,
        vectorSearchQueriesPerDay: 50000,
      },
    });
    const topology = calculateTopology(q);

    expect(topology.tier).toBe('M');
    expect(topology.totalNodes.min).toBeGreaterThanOrEqual(6);
  });

  it('produces tier L topology with GPU nodes for self-hosted LLM', () => {
    const q = makeQuestionnaire({
      llm: {
        hostingModel: 'self-hosted',
        selfHostedModels: ['llama-3.1-70b'],
        concurrentRequests: 500,
        contextWindow: 'large',
        embeddingModel: 'bge-m3',
      },
      agents: {
        agentCount: 200,
        concurrentConversations: 50000,
        avgConversationLength: 20,
        messagesPerDay: 200000,
        toolCallsPerConversation: 10,
        multiAgentUsage: 50,
      },
      knowledgeBase: {
        totalDocuments: 2000000,
        avgDocumentSize: 'large',
        documentTypes: ['pdf', 'word', 'html', 'spreadsheet'],
        ingestionFrequency: 'hourly',
        connectorTypes: ['web-crawl', 'sharepoint', 'api'],
        kbPerProject: 10,
        vectorSearchQueriesPerDay: 500000,
      },
    });
    const topology = calculateTopology(q);

    expect(topology.tier).toBe('L');

    // Should have GPU node pool
    const gpuPool = topology.nodePools.find((p) => p.name === 'gpu');
    expect(gpuPool).toBeDefined();
    expect(gpuPool!.taints).toBeDefined();

    // Should have self-hosted LLM service
    const llm = topology.services.find((s) => s.name.startsWith('self-hosted-llm'));
    expect(llm).toBeDefined();
    expect(llm!.resources.gpu).toBeDefined();

    // Total nodes should include GPU
    expect(topology.totalNodes.min).toBeGreaterThan(10);
  });

  it('uses correct instance types per cloud provider', () => {
    const q = makeQuestionnaire({
      deployment: {
        cloudProvider: 'gcp',
        regionCount: 1,
        haRequirement: 'standard',
        networkIsolation: 'shared-vpc',
        compliance: [],
      },
    });
    const topology = calculateTopology(q);

    const generalPool = topology.nodePools.find((p) => p.name === 'general');
    expect(generalPool!.instanceType).toContain('e2-standard');
  });

  it('storage growth increases with higher tiers', () => {
    const smallQ = makeQuestionnaire();
    const largeQ = makeQuestionnaire({
      agents: {
        agentCount: 500,
        concurrentConversations: 100000,
        avgConversationLength: 20,
        messagesPerDay: 500000,
        toolCallsPerConversation: 10,
        multiAgentUsage: 50,
      },
    });

    const smallTopology = calculateTopology(smallQ);
    const largeTopology = calculateTopology(largeQ);

    expect(largeTopology.monthlyStorageGrowthGB).toBeGreaterThan(
      smallTopology.monthlyStorageGrowthGB,
    );
  });
});

describe('calculateTopology — calibrated path', () => {
  async function loadCalibration(): Promise<CalibrationProfile> {
    const raw = await readFile(join(__dirname, 'fixtures', 'calibration-m.json'), 'utf-8');
    return JSON.parse(raw) as CalibrationProfile;
  }

  it('produces topology using calibrated path when calibration provided', async () => {
    const calibration = await loadCalibration();
    const q = makeQuestionnaire({
      agents: {
        agentCount: 50,
        concurrentConversations: 20000,
        avgConversationLength: 15,
        messagesPerDay: 50000,
        toolCallsPerConversation: 5,
        multiAgentUsage: 20,
      },
      knowledgeBase: {
        totalDocuments: 100000,
        avgDocumentSize: 'medium',
        documentTypes: ['pdf', 'word', 'html'],
        ingestionFrequency: 'daily',
        connectorTypes: ['file-upload', 'web-crawl'],
        kbPerProject: 5,
        vectorSearchQueriesPerDay: 50000,
      },
    });

    const topology = calculateTopology(q, calibration);

    // Calibrated path should use calibration data — runtime replicas should be high
    // due to 20000 concurrent conversations / 850 maxTotalConnectionsPerPod
    const runtime = topology.services.find((s) => s.name === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime!.replicas).toBeGreaterThanOrEqual(20);

    // Should still produce complete topology
    expect(topology.tier).toBeDefined();
    expect(topology.services.length).toBeGreaterThan(0);
    expect(topology.dataStores.length).toBeGreaterThan(0);
    expect(topology.nodePools.length).toBeGreaterThan(0);
  });

  it('falls back to hardcoded path when no calibration', () => {
    const q = makeQuestionnaire();
    const topology = calculateTopology(q);

    // Without calibration, should still work as before
    expect(topology.tier).toBe('S');
    expect(topology.services.length).toBeGreaterThan(0);
    expect(topology.dataStores).toHaveLength(7);
  });

  it('existing tests still pass (backward compatibility)', () => {
    const q = makeQuestionnaire();
    const topology = calculateTopology(q);

    // Verify dataStores count matches original expectation
    expect(topology.dataStores).toHaveLength(7);
    expect(topology.nodePools.length).toBeGreaterThanOrEqual(3);
    expect(topology.monthlyStorageGrowthGB).toBeGreaterThan(0);
  });

  it('partial calibration preserves all services from hardcoded defaults', async () => {
    const calibration = await loadCalibration();
    const q = makeQuestionnaire();

    const uncalibrated = calculateTopology(q);
    const calibrated = calculateTopology(q, calibration);

    // Calibrated topology should have at least as many services as uncalibrated
    expect(calibrated.services.length).toBeGreaterThanOrEqual(uncalibrated.services.length);

    // Every uncalibrated service name should appear in the calibrated output
    for (const svc of uncalibrated.services) {
      expect(calibrated.services.find((s) => s.name === svc.name)).toBeDefined();
    }
  });
});
