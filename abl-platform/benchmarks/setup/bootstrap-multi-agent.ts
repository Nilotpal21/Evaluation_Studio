import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, studioApiPath } from '../lib/config.ts';
import { httpWithRetry } from './helpers.ts';

const MULTI_AGENT_CONFIG_JSON = __ENV.MULTI_AGENT_CONFIG || '';

interface AgentToolParam {
  type: string;
  description: string;
}

interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, AgentToolParam>;
    required: string[];
  };
}

interface AgentDef {
  name: string;
  description: string;
  model: string;
  dslContent: string;
  tools?: AgentTool[];
}

interface MultiAgentConfig {
  supervisor: AgentDef;
  agents: AgentDef[];
}

export interface MultiAgentSetupResult {
  supervisorId: string;
  supervisorName: string;
  supervisorPath: string;
  childAgents: Array<{ agentId: string; agentName: string; agentPath: string }>;
}

/**
 * Load multi-agent config from env override or embedded fixture.
 */
function loadConfig(): MultiAgentConfig {
  if (MULTI_AGENT_CONFIG_JSON) {
    return JSON.parse(MULTI_AGENT_CONFIG_JSON) as MultiAgentConfig;
  }

  // Load from fixture file (k6 `open()` reads at init time)
  const raw = open('../fixtures/multi-agent-config.json');
  return JSON.parse(raw) as MultiAgentConfig;
}

const multiAgentConfig = loadConfig();

/**
 * Create or reuse a single agent in the project.
 * Returns the agent ID, name, and path.
 */
function ensureAgent(
  studioUrl: string,
  projectId: string,
  headers: Record<string, string>,
  agentDef: AgentDef,
): { agentId: string; agentName: string; agentPath: string } {
  const agentPath = `${projectId}/default/${agentDef.name}`;
  const agentsUrl = `${studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`;

  // Check if agent already exists
  const listRes = http.get(agentsUrl, { headers });
  if (listRes.status === 200) {
    const listBody = listRes.json() as {
      agents?: Array<{ id: string; name: string; agentPath: string }>;
    };
    const existing = (listBody.agents || []).find((a) => a.name === agentDef.name);
    if (existing) {
      console.log(`[bootstrap-multi-agent] Reusing agent: ${existing.name} (${existing.id})`);
      // Ensure dslContent is saved (Studio create doesn't persist it)
      saveDslContent(studioUrl, projectId, agentDef.name, agentDef.dslContent, headers);
      return {
        agentId: existing.id,
        agentName: existing.name,
        agentPath: existing.agentPath,
      };
    }
  }

  // Create the agent
  const payload = {
    name: agentDef.name,
    agentPath,
    description: agentDef.description,
    model: agentDef.model,
    dslContent: agentDef.dslContent,
    ...(agentDef.tools ? { tools: agentDef.tools } : {}),
  };

  console.log(`[bootstrap-multi-agent] Creating agent "${agentDef.name}" in project ${projectId}`);
  let createRes = httpWithRetry('POST', agentsUrl, JSON.stringify(payload), headers, {
    label: `create-agent-${agentDef.name}`,
  });

  // On 409, the agent name conflicts (possibly from another project).
  // Cross-project cleanup is gated behind BENCHMARK_CLEANUP_CONFLICTS=true for safety.
  if (createRes.status === 409) {
    console.warn(`[bootstrap-multi-agent] 409 conflict for "${agentDef.name}"`);

    const allowCleanup = __ENV.BENCHMARK_CLEANUP_CONFLICTS === 'true';

    if (!allowCleanup) {
      throw new Error(
        `Agent "${agentDef.name}" conflicts with an agent in another project. ` +
          `Set BENCHMARK_CLEANUP_CONFLICTS=true to enable cross-project cleanup, ` +
          `or delete the conflicting agent manually.`,
      );
    }

    // Safety: only allow cleanup of benchmark-prefixed agents
    if (!agentDef.name.startsWith('benchmark_')) {
      throw new Error(
        `Agent "${agentDef.name}" conflicts but does not have the "benchmark_" prefix. ` +
          `Cross-project cleanup is only allowed for benchmark-prefixed agents. ` +
          `Delete the conflicting agent manually.`,
      );
    }

    console.warn(`[bootstrap-multi-agent] BENCHMARK_CLEANUP_CONFLICTS=true — attempting cleanup`);
    const projectsRes = http.get(`${studioUrl}${studioApiPath('/projects')}`, { headers });
    if (projectsRes.status === 200) {
      const projectsBody = projectsRes.json() as {
        projects?: Array<{ id: string; name: string }>;
      };
      for (const proj of projectsBody.projects || []) {
        if (proj.id === projectId) continue;
        const otherRes = http.get(`${studioUrl}${studioApiPath(`/projects/${proj.id}/agents`)}`, {
          headers,
        });
        if (otherRes.status !== 200) continue;
        const otherBody = otherRes.json() as {
          agents?: Array<{ id: string; name: string }>;
        };
        const conflict = (otherBody.agents || []).find(
          (a) => a.name === agentDef.name && a.name.startsWith('benchmark_'),
        );
        if (conflict) {
          console.log(
            `[bootstrap-multi-agent] Deleting conflicting "${agentDef.name}" (${conflict.id}) from project ${proj.id}`,
          );
          http.del(
            `${studioUrl}${studioApiPath(`/projects/${proj.id}/agents/${conflict.id}`)}`,
            null,
            { headers },
          );
          break;
        }
      }
    }

    // Retry after cleanup
    createRes = httpWithRetry('POST', agentsUrl, JSON.stringify(payload), headers, {
      label: `create-agent-${agentDef.name}-retry`,
    });
  }

  const createOk = check(createRes, {
    [`create ${agentDef.name} returns 200|201`]: (r) => r.status === 200 || r.status === 201,
  });

  if (!createOk) {
    throw new Error(
      `Create agent "${agentDef.name}" failed: ${createRes.status} ${createRes.body}`,
    );
  }

  const body = createRes.json() as {
    agent?: { id: string; name: string; agentPath: string };
    id?: string;
    name?: string;
    agentPath?: string;
  };

  const result = body.agent || body;
  const agentId = (result as Record<string, unknown>).id as string;
  const createdPath = ((result as Record<string, unknown>).agentPath as string) || agentPath;

  console.log(`[bootstrap-multi-agent] Created agent: ${agentDef.name} (${agentId})`);

  // Save dslContent via dedicated DSL endpoint (Studio create doesn't persist it)
  saveDslContent(studioUrl, projectId, agentDef.name, agentDef.dslContent, headers);

  return {
    agentId,
    agentName: ((result as Record<string, unknown>).name as string) || agentDef.name,
    agentPath: createdPath,
  };
}

/**
 * Save dslContent to an agent via PUT /api/projects/:id/agents/:agentName/dsl.
 * The Studio create agent endpoint doesn't persist dslContent (Zod schema strips it).
 * The Runtime WS handler requires dslContent to load agents.
 */
function saveDslContent(
  studioUrl: string,
  projectId: string,
  agentName: string,
  dslContent: string,
  headers: Record<string, string>,
): void {
  const dslUrl = `${studioUrl}${studioApiPath(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/dsl`)}`;
  const dslRes = http.put(dslUrl, JSON.stringify({ dslContent }), { headers });

  if (dslRes.status === 200) {
    console.log(`[bootstrap-multi-agent] DSL saved for "${agentName}"`);
  } else {
    console.warn(
      `[bootstrap-multi-agent] DSL save for "${agentName}" returned ${dslRes.status}: ${(dslRes.body as string).substring(0, 200)}`,
    );
  }
}

/**
 * Bootstrap the full multi-agent setup: supervisor + child agents.
 *
 * Creates all agents in sequence (child agents first, then supervisor)
 * so the supervisor can reference them by name at runtime.
 */
export function bootstrapMultiAgent(accessToken: string, projectId: string): MultiAgentSetupResult {
  const studioUrl = config.studioUrl;
  const tenantId = config.tenantId;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: studioUrl,
    'X-Tenant-Id': tenantId,
  };

  // Step 1: Create child agents first (supervisor references them by name)
  const childAgents: MultiAgentSetupResult['childAgents'] = [];
  for (const agentDef of multiAgentConfig.agents) {
    const result = ensureAgent(studioUrl, projectId, headers, agentDef);
    childAgents.push(result);
    sleep(0.5); // brief pause between agent creations
  }

  // Step 2: Create the supervisor
  const supervisor = ensureAgent(studioUrl, projectId, headers, multiAgentConfig.supervisor);

  return {
    supervisorId: supervisor.agentId,
    supervisorName: supervisor.agentName,
    supervisorPath: supervisor.agentPath,
    childAgents,
  };
}
