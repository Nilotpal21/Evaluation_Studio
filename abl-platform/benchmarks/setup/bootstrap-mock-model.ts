/**
 * Bootstrap Mock LLM Model for Benchmark Agents
 *
 * Creates a TenantModel with provider "mock" and configures all benchmark
 * agents to use it via AgentModelConfig. The mock provider returns canned
 * responses without making real LLM API calls, enabling benchmarks to
 * measure platform overhead without LLM latency.
 *
 * Prerequisites:
 *   - Agents must already exist (run after bootstrap-agent + bootstrap-multi-agent)
 *   - No special env var needed — the mock provider is always available
 */
import http from 'k6/http';
import { check } from 'k6';
import { config, apiPath } from '../lib/config.ts';

/** Setup requests should not pollute the global http_req_failed metric. */
const setupResponseCallback = http.expectedStatuses(200, 201, 204, 400, 404, 409, 500);

const MOCK_MODEL_DISPLAY_NAME = 'Benchmark Mock LLM';
const MOCK_MODEL_ID = 'mock-model';
const MOCK_PROVIDER = 'mock';
const MOCK_CREDENTIAL_NAME = 'benchmark-mock-credential';
const MOCK_API_KEY = 'mock-benchmark-key';

interface MockModelResult {
  tenantModelId: string;
  credentialId: string;
  agentsConfigured: string[];
}

/**
 * Configure mock LLM model for benchmark agents.
 *
 * 1. Creates a TenantModel with provider "mock" (reuses if exists)
 * 2. Creates a credential and links it to the TenantModel
 * 3. Sets AgentModelConfig for each benchmark agent
 */
export function bootstrapMockModel(
  accessToken: string,
  tenantId: string,
  projectId: string,
  agentNames: string[],
): MockModelResult {
  const runtimeHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': tenantId,
  };

  const studioHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: config.studioUrl,
  };

  // -------------------------------------------------------------------------
  // Step 1: Create or reuse TenantModel
  // -------------------------------------------------------------------------
  console.log('[bootstrap-mock-model] Creating mock TenantModel...');

  // Check if mock model already exists
  const listRes = http.get(`${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models`)}`, {
    headers: runtimeHeaders,
    responseCallback: setupResponseCallback,
  });

  let tenantModelId = '';
  if (listRes.status === 200) {
    const body = listRes.json() as { models?: Array<{ _id: string; modelId: string }> };
    const existing = (body.models || []).find((m) => m.modelId === MOCK_MODEL_ID);
    if (existing) {
      tenantModelId = existing._id;
      console.log(`[bootstrap-mock-model] Reusing existing mock TenantModel: ${tenantModelId}`);
    }
  }

  if (!tenantModelId) {
    const createRes = http.post(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models`)}`,
      JSON.stringify({
        displayName: MOCK_MODEL_DISPLAY_NAME,
        modelId: MOCK_MODEL_ID,
        provider: MOCK_PROVIDER,
        integrationType: 'easy',
        isDefault: false,
        tier: 'balanced',
        supportsTools: true,
        supportsStreaming: true,
        capabilities: ['text', 'tools', 'streaming'],
      }),
      { headers: runtimeHeaders, responseCallback: setupResponseCallback },
    );

    check(createRes, {
      'create mock TenantModel returns 201': (r) => r.status === 201,
    });

    if (createRes.status === 201) {
      const body = createRes.json() as { model?: { _id: string } };
      tenantModelId = body.model?._id || '';
      console.log(`[bootstrap-mock-model] Created mock TenantModel: ${tenantModelId}`);
    } else {
      console.error(
        `[bootstrap-mock-model] Failed to create TenantModel: ${createRes.status} ${createRes.body}`,
      );
      throw new Error('Failed to create mock TenantModel');
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Ensure valid primary connection with live credential
  // -------------------------------------------------------------------------
  // Previous teardowns may have deleted the credential while leaving the
  // TenantModel and a dangling connection behind. Always verify.
  let credentialId = '';
  let needsNewConnection = true;

  if (tenantModelId) {
    const connListRes = http.get(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models/${tenantModelId}/connections`)}`,
      { headers: runtimeHeaders, responseCallback: setupResponseCallback },
    );
    if (connListRes.status === 200) {
      const connBody = connListRes.json() as {
        connections?: Array<{ id: string; credentialId: string; isPrimary: boolean }>;
      };
      const primary = (connBody.connections || []).find((c) => c.isPrimary);
      if (primary) {
        const credCheckRes = http.get(
          `${config.studioUrl}/api/credentials/${primary.credentialId}`,
          { headers: studioHeaders, responseCallback: setupResponseCallback },
        );
        if (credCheckRes.status === 200) {
          credentialId = primary.credentialId;
          needsNewConnection = false;
          console.log(
            `[bootstrap-mock-model] Primary connection valid, credential: ${credentialId}`,
          );
        } else {
          console.warn(
            '[bootstrap-mock-model] Primary connection credential deleted, will recreate',
          );
        }
      }
    }
  }

  // Get or create credential
  if (!credentialId) {
    const listCredRes = http.get(`${config.studioUrl}/api/credentials`, {
      headers: studioHeaders,
      responseCallback: setupResponseCallback,
    });
    if (listCredRes.status === 200) {
      const creds = listCredRes.json() as Array<{ id: string; name: string }>;
      const existing = (Array.isArray(creds) ? creds : []).find(
        (c) => c.name === MOCK_CREDENTIAL_NAME,
      );
      if (existing) {
        credentialId = existing.id;
        console.log(`[bootstrap-mock-model] Reusing existing credential: ${credentialId}`);
      }
    }
  }

  if (!credentialId) {
    const credRes = http.post(
      `${config.studioUrl}/api/credentials`,
      JSON.stringify({
        name: MOCK_CREDENTIAL_NAME,
        provider: 'custom',
        apiKey: MOCK_API_KEY,
        authType: 'api_key',
      }),
      { headers: studioHeaders, responseCallback: setupResponseCallback },
    );

    if (credRes.status === 201) {
      const body = credRes.json() as { id?: string };
      credentialId = body.id || '';
      console.log(`[bootstrap-mock-model] Created credential: ${credentialId}`);
    } else if (credRes.status === 409) {
      console.warn(`[bootstrap-mock-model] Credential name conflict (409), retrying list...`);
      const listCredRes = http.get(`${config.studioUrl}/api/credentials`, {
        headers: studioHeaders,
        responseCallback: setupResponseCallback,
      });
      if (listCredRes.status === 200) {
        const creds = listCredRes.json() as Array<{ id: string; name: string }>;
        const existing = (Array.isArray(creds) ? creds : []).find(
          (c) => c.name === MOCK_CREDENTIAL_NAME,
        );
        if (existing) {
          credentialId = existing.id;
          console.log(`[bootstrap-mock-model] Reusing existing credential: ${credentialId}`);
        }
      }
      // Still not found — create with unique name
      if (!credentialId) {
        const uniqueName = `${MOCK_CREDENTIAL_NAME}-${Date.now()}`;
        console.log(`[bootstrap-mock-model] Creating credential with unique name: ${uniqueName}`);
        const uniqueCredRes = http.post(
          `${config.studioUrl}/api/credentials`,
          JSON.stringify({
            name: uniqueName,
            provider: 'custom',
            apiKey: MOCK_API_KEY,
            authType: 'api_key',
          }),
          { headers: studioHeaders, responseCallback: setupResponseCallback },
        );
        if (uniqueCredRes.status === 201) {
          const body = uniqueCredRes.json() as { id?: string };
          credentialId = body.id || '';
          console.log(`[bootstrap-mock-model] Created credential (unique): ${credentialId}`);
        } else {
          console.error(
            `[bootstrap-mock-model] Unique credential also failed: ${uniqueCredRes.status} ${uniqueCredRes.body}`,
          );
        }
      }
    } else {
      console.warn(
        `[bootstrap-mock-model] Credential creation returned ${credRes.status}: ${credRes.body}`,
      );
    }
  }

  // Link credential as primary connection (only if needed)
  if (credentialId && tenantModelId && needsNewConnection) {
    console.log('[bootstrap-mock-model] Linking credential to TenantModel...');

    const connRes = http.post(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models/${tenantModelId}/connections`)}`,
      JSON.stringify({
        credentialId,
        isPrimary: true,
        connectionType: 'http',
      }),
      { headers: runtimeHeaders, responseCallback: setupResponseCallback },
    );

    if (connRes.status === 201 || connRes.status === 200) {
      console.log('[bootstrap-mock-model] Credential linked as primary connection');
    } else {
      console.warn(
        `[bootstrap-mock-model] Connection creation returned ${connRes.status}: ${connRes.body}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Create project-level ModelConfig linking mock-model → TenantModel
  // -------------------------------------------------------------------------
  // The model resolution chain (Level 2) looks up a ModelConfig by modelId to
  // find the TenantModel and its provider. Without this, the agent's
  // defaultModel "mock-model" cannot be resolved to provider "mock" and falls
  // back to the tenant's default (real) LLM model.
  console.log('[bootstrap-mock-model] Creating project ModelConfig...');

  const modelConfigRes = http.post(
    `${config.studioUrl}/api/models`,
    JSON.stringify({
      projectId,
      name: `Mock LLM ${Date.now()}`,
      modelId: MOCK_MODEL_ID,
      provider: MOCK_PROVIDER,
      tenantModelId,
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'balanced',
      isDefault: false,
      priority: 0,
    }),
    { headers: studioHeaders, responseCallback: setupResponseCallback },
  );

  if (modelConfigRes.status === 200 || modelConfigRes.status === 201) {
    console.log('[bootstrap-mock-model] Project ModelConfig created for mock-model');
  } else {
    console.warn(
      `[bootstrap-mock-model] Project ModelConfig: ${modelConfigRes.status} ${modelConfigRes.body}`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 5: Configure each benchmark agent to use the mock model
  // -------------------------------------------------------------------------
  const configuredAgents: string[] = [];

  for (const agentName of agentNames) {
    console.log(`[bootstrap-mock-model] Setting model config for agent "${agentName}"...`);

    const configRes = http.put(
      `${config.runtimeUrl}${apiPath(`/projects/${projectId}/agents/${agentName}/model-config`)}`,
      JSON.stringify({
        defaultModel: MOCK_MODEL_ID,
      }),
      { headers: runtimeHeaders, responseCallback: setupResponseCallback },
    );

    if (configRes.status === 200) {
      configuredAgents.push(agentName);
      console.log(`[bootstrap-mock-model] Agent "${agentName}" → mock-model`);
    } else {
      console.warn(
        `[bootstrap-mock-model] Agent config for "${agentName}" returned ${configRes.status}: ${configRes.body}`,
      );
    }
  }

  console.log(
    `[bootstrap-mock-model] Done: ${configuredAgents.length}/${agentNames.length} agents configured`,
  );

  return {
    tenantModelId,
    credentialId,
    agentsConfigured: configuredAgents,
  };
}
