/**
 * Benchmark Environment Bootstrap Orchestrator
 *
 * Runs all setup modules in sequence to create a complete benchmark environment.
 * Designed to run as a k6 TestRun with --iterations 1 --vus 1.
 */
import { check } from 'k6';
import { config } from '../lib/config.ts';
import { bootstrapTenant } from './bootstrap-tenant.ts';
import { bootstrapAgent } from './bootstrap-agent.ts';
import { bootstrapMultiAgent } from './bootstrap-multi-agent.ts';
import { bootstrapKB } from './bootstrap-kb.ts';
import { verifyIndexes } from './bootstrap-indexes.ts';
import { seedConversations } from './seed-conversations.ts';
import { bootstrapMockModel } from './bootstrap-mock-model.ts';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function (): void {
  console.log('=== Benchmark Bootstrap Starting ===');

  // Resolve URLs from config (reads __ENV at entry script level)
  const runtimeUrl = config.runtimeUrl;
  const searchAiUrl = config.searchAiUrl;

  console.log(`  Runtime URL: ${runtimeUrl}`);
  console.log(`  Search AI URL: ${searchAiUrl}`);
  console.log(`  Studio URL: ${config.studioUrl}`);

  // Step 1: Create tenant + project
  console.log('\n--- Step 1: Bootstrap Tenant ---');
  const tenant = bootstrapTenant();
  check(tenant, {
    'tenant has accessToken': (t) => !!t.accessToken,
    'tenant has projectId': (t) => !!t.projectId,
  });
  console.log(`  Tenant: ${tenant.tenantId}`);
  console.log(`  Project: ${tenant.projectId}`);

  // Step 2: Create agent (pass runtimeUrl from entry scope)
  console.log('\n--- Step 2: Bootstrap Agent ---');
  const agent = bootstrapAgent(tenant.accessToken, tenant.projectId, runtimeUrl);
  check(agent, {
    'agent has agentId': (a) => !!a.agentId,
  });
  console.log(`  Agent: ${agent.agentId} (${agent.agentPath})`);

  // Step 2b: Create multi-agent setup (supervisor + child agents)
  console.log('\n--- Step 2b: Bootstrap Multi-Agent ---');
  const multiAgent = bootstrapMultiAgent(tenant.accessToken, tenant.projectId);
  check(multiAgent, {
    'supervisor has agentId': (m) => !!m.supervisorId,
    'has child agents': (m) => m.childAgents.length > 0,
  });
  console.log(`  Supervisor: ${multiAgent.supervisorName} (${multiAgent.supervisorId})`);
  console.log(`  Child agents: ${multiAgent.childAgents.map((a) => a.agentName).join(', ')}`);

  // Step 2c: Configure mock LLM model for benchmark agents (if MOCK_LLM=true)
  if (__ENV.MOCK_LLM === 'true') {
    console.log('\n--- Step 2c: Configure Mock LLM ---');
    const allAgentNames = [
      agent.agentName,
      multiAgent.supervisorName,
      ...multiAgent.childAgents.map((a) => a.agentName),
    ];
    const mockModel = bootstrapMockModel(
      tenant.accessToken,
      tenant.tenantId,
      tenant.projectId,
      allAgentNames,
    );
    check(mockModel, {
      'mock model configured': (m) => !!m.tenantModelId,
      'agents configured for mock': (m) => m.agentsConfigured.length > 0,
    });
    console.log(`  Mock TenantModel: ${mockModel.tenantModelId}`);
    console.log(`  Agents configured: ${mockModel.agentsConfigured.join(', ')}`);
  } else {
    console.log('\n--- Step 2c: Mock LLM skipped (MOCK_LLM not set) ---');
  }

  // Step 3: Create KB + upload documents (pass searchAiUrl from entry scope)
  console.log('\n--- Step 3: Bootstrap Knowledge Base ---');
  const kb = bootstrapKB(tenant.accessToken, tenant.projectId, searchAiUrl);
  check(kb, {
    'kb has indexId': (k) => !!k.indexId,
    'kb has kbId': (k) => !!k.kbId,
  });
  console.log(`  KB: ${kb.kbId}, Index: ${kb.indexId} (${kb.documentCount} docs uploaded)`);

  // Step 4: Verify indexes
  console.log('\n--- Step 4: Verify Indexes ---');
  const indexes = verifyIndexes(tenant.accessToken, kb.indexId);
  console.log(`  OpenSearch: ${indexes.opensearchOk ? 'OK' : 'NOT FOUND'}`);
  console.log(`  Qdrant: ${indexes.qdrantOk ? 'OK' : 'NOT FOUND'}`);

  // Step 5: Seed conversations (pass runtimeUrl from entry scope)
  console.log('\n--- Step 5: Seed Conversations ---');
  const seed = seedConversations(tenant.accessToken, tenant.projectId, runtimeUrl);
  console.log(`  Seeded: ${seed.conversationCount} conversations`);

  console.log('\n=== Benchmark Bootstrap Complete ===');
  console.log(`  Token: ${tenant.accessToken.substring(0, 20)}...`);
  console.log(`  Project ID: ${tenant.projectId}`);
  console.log(`  Agent Path: ${agent.agentPath}`);
  console.log(`  Supervisor Path: ${multiAgent.supervisorPath}`);
  console.log(`  Child Agents: ${multiAgent.childAgents.length}`);
  console.log(`  Index ID: ${kb.indexId}`);
}
