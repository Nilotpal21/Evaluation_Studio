import { apiJson } from './studio-chat.mjs';
import { delay } from './utils.mjs';

function authHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

export async function createCredential(baseUrl, accessToken, body) {
  return apiJson(baseUrl, '/api/credentials', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function createTenantCredential(baseUrl, accessToken, body) {
  return apiJson(baseUrl, '/api/tenant-credentials', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function createTenantModel(baseUrl, accessToken, body) {
  const result = await apiJson(baseUrl, '/api/tenant-models', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });

  return result?.model ?? result;
}

export async function createTenantModelConnection(baseUrl, accessToken, modelId, body) {
  return apiJson(baseUrl, `/api/tenant-models/${encodeURIComponent(modelId)}/connections`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function listProjectModels(baseUrl, accessToken, projectId) {
  const result = await apiJson(baseUrl, `/api/models?projectId=${encodeURIComponent(projectId)}`, {
    headers: authHeaders(accessToken),
  });

  return Array.isArray(result?.models) ? result.models : [];
}

export async function createProjectModel(baseUrl, accessToken, body) {
  return apiJson(baseUrl, '/api/models', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function getProjectRuntimeConfig(baseUrl, accessToken, projectId) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/runtime-config`, {
    headers: authHeaders(accessToken),
  });
}

export async function updateProjectRuntimeConfig(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/runtime-config`, {
    method: 'PUT',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function createProjectPIIPattern(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/pii-patterns`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function testProjectPIIPattern(baseUrl, accessToken, projectId, body) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await apiJson(
        baseUrl,
        `/api/projects/${encodeURIComponent(projectId)}/pii-patterns/test`,
        {
          method: 'POST',
          headers: authHeaders(accessToken),
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt === 4) {
        break;
      }

      const retryDelayMs = Math.max(Number(error?.retryAfterMs) || 1_000, 1_000);
      await delay(retryDelayMs);
    }
  }

  throw lastError;
}

export async function createProjectConfigVariable(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/config-variables`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function createProjectEnvironmentVariable(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/env-vars`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function listProjectPIIPatterns(baseUrl, accessToken, projectId) {
  const result = await apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/pii-patterns`,
    {
      headers: authHeaders(accessToken),
    },
  );

  if (Array.isArray(result?.data)) {
    return result.data;
  }
  if (Array.isArray(result)) {
    return result;
  }
  return [];
}

export async function createProjectTool(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/tools`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function importProjectTool(baseUrl, accessToken, projectId, body) {
  return apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/tools/import`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

export async function listProjectTools(baseUrl, accessToken, projectId) {
  const result = await apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/tools`, {
    headers: authHeaders(accessToken),
  });

  if (Array.isArray(result?.tools)) {
    return result.tools;
  }
  if (Array.isArray(result?.data)) {
    return result.data;
  }
  return [];
}

export async function getRuntimeAgent(baseUrl, accessToken, projectId, agentName) {
  return apiJson(
    baseUrl,
    `/api/runtime-agents/${encodeURIComponent(agentName)}?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: authHeaders(accessToken),
    },
  );
}

export async function updateAgentModelConfig(baseUrl, accessToken, projectId, agentName, body) {
  return apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/model-config`,
    {
      method: 'PUT',
      headers: authHeaders(accessToken),
      body: JSON.stringify(body),
    },
  );
}

export async function listProjectSessions(baseUrl, accessToken, projectId) {
  const result = await apiJson(
    baseUrl,
    `/api/runtime/sessions?projectId=${encodeURIComponent(projectId)}&limit=100`,
    {
      headers: authHeaders(accessToken),
    },
  );

  return Array.isArray(result?.sessions) ? result.sessions : [];
}

export async function getSessionDetail(baseUrl, accessToken, projectId, sessionId) {
  return apiJson(
    baseUrl,
    `/api/runtime/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}&includeTraces=false`,
    {
      headers: authHeaders(accessToken),
    },
  );
}

export async function getSessionTraces(baseUrl, accessToken, projectId, sessionId) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await apiJson(
        baseUrl,
        `/api/runtime/sessions/${encodeURIComponent(sessionId)}/traces?projectId=${encodeURIComponent(projectId)}&limit=200`,
        {
          headers: authHeaders(accessToken),
        },
      );

      if (Array.isArray(result?.traces)) {
        return result.traces;
      }
      if (Array.isArray(result?.data?.traces)) {
        return result.data.traces;
      }
      return [];
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt === 4) {
        break;
      }

      const retryDelayMs = Math.max(Number(error?.retryAfterMs) || 1_000, 1_000);
      await delay(retryDelayMs);
    }
  }

  throw lastError;
}
