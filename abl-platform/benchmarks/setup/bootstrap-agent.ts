import http from 'k6/http';
import { check } from 'k6';
import { config, studioApiPath } from '../lib/config.ts';
import { assertStatus, httpWithRetry } from './helpers.ts';

const AGENT_CONFIG_JSON = __ENV.AGENT_CONFIG || '{}';

const DEFAULT_AGENT_NAME = config.agentName;
const DEFAULT_AGENT_DESCRIPTION = 'Benchmark agent for load testing';
const DEFAULT_AGENT_INSTRUCTIONS =
  'You are a helpful assistant for benchmark testing. Respond concisely.';
const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-5-20250929';

export interface AgentSetupResult {
  agentId: string;
  agentName: string;
  agentPath: string;
}

/**
 * Create (or reuse) the benchmark agent in the given project.
 *
 * Uses Studio API for agent CRUD — Studio owns the /api/projects/:id/agents routes.
 * On 409 (name collision from another project), deletes the conflicting agent and retries.
 */
export function bootstrapAgent(
  accessToken: string,
  projectId: string,
  _runtimeUrl?: string,
): AgentSetupResult {
  const studioUrl = config.studioUrl;
  const tenantId = config.tenantId;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: studioUrl,
    'X-Tenant-Id': tenantId,
  };

  const overrides = JSON.parse(AGENT_CONFIG_JSON) as Record<string, unknown>;
  const agentName = (overrides.name as string) || DEFAULT_AGENT_NAME;
  // agentPath follows the pattern: {projectId}/default/{agentName}
  const agentPath = (overrides.agentPath as string) || `${projectId}/default/${agentName}`;
  const agentConfig = {
    name: agentName,
    agentPath,
    description: (overrides.description as string) || DEFAULT_AGENT_DESCRIPTION,
    instructions: (overrides.instructions as string) || DEFAULT_AGENT_INSTRUCTIONS,
    model: (overrides.model as string) || DEFAULT_AGENT_MODEL,
    dslContent: `\nAGENT: ${agentName}\nMODEL: ${(overrides.model as string) || DEFAULT_AGENT_MODEL}\nGOAL: \"responsd to user question. if you do not know answer, respond NO.\"\nPERSONA: |\n  Calm, Cool person\n  CRITICAL: Keep each response to 1 sentence. each sentence should be more 2-3 words.\nLIMITATIONS:\n  - \"do not perform any web search\"`,
  };

  const agentsUrl = `${studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`;
  console.log(`[bootstrap-agent] Agents URL: ${agentsUrl}`);

  // Step 1: Check if agent already exists in this project
  const listRes = http.get(agentsUrl, { headers });
  if (listRes.status === 200) {
    const listBody = listRes.json() as {
      success?: boolean;
      agents?: Array<{ id: string; name: string; agentPath: string }>;
    };
    const agents = listBody.agents || [];
    console.log(`[bootstrap-agent] Found ${agents.length} agents in project`);
    if (agents.length > 0) {
      console.log(`[bootstrap-agent] Agent names: ${agents.map((a) => a.name).join(', ')}`);
    }
    const existing = agents.find((a) => a.name === agentName);
    if (existing) {
      console.log(`[bootstrap-agent] Reusing existing agent: ${existing.id}`);
      check(existing, { 'agent has agentId': (a) => !!a.id });
      // Ensure dslContent is saved (Studio create doesn't persist it)
      saveDslContent(studioUrl, projectId, agentName, agentConfig.dslContent, headers);
      return {
        agentId: existing.id,
        agentName: existing.name,
        agentPath: existing.agentPath,
      };
    }
  } else {
    console.warn(
      `[bootstrap-agent] List agents returned ${listRes.status}: ${(listRes.body as string).substring(0, 300)}`,
    );
  }

  // Step 2: Try to create the agent
  console.log(`[bootstrap-agent] Creating agent "${agentName}" in project ${projectId}`);
  let createRes = httpWithRetry('POST', agentsUrl, JSON.stringify(agentConfig), headers, {
    label: 'create-agent',
  });

  // Step 3: On 409, the agent name conflicts (possibly from another project).
  // Cross-project cleanup is gated behind BENCHMARK_CLEANUP_CONFLICTS=true for safety.
  // Without the flag, we fail with a descriptive error instead of deleting agents
  // that might belong to other users.
  if (createRes.status === 409) {
    console.warn(`[bootstrap-agent] 409 conflict — agent "${agentName}" exists elsewhere`);

    const allowCleanup = __ENV.BENCHMARK_CLEANUP_CONFLICTS === 'true';

    if (!allowCleanup) {
      throw new Error(
        `Agent "${agentName}" conflicts with an agent in another project. ` +
          `Set BENCHMARK_CLEANUP_CONFLICTS=true to enable cross-project cleanup, ` +
          `or delete the conflicting agent manually.`,
      );
    }

    // Safety: only allow cleanup of benchmark-prefixed agents
    if (!agentName.startsWith('benchmark_')) {
      throw new Error(
        `Agent "${agentName}" conflicts but does not have the "benchmark_" prefix. ` +
          `Cross-project cleanup is only allowed for benchmark-prefixed agents. ` +
          `Delete the conflicting agent manually.`,
      );
    }

    console.warn(`[bootstrap-agent] BENCHMARK_CLEANUP_CONFLICTS=true — attempting cleanup`);

    // Search all projects for the conflicting agent
    const projectsRes = http.get(`${studioUrl}${studioApiPath('/projects')}`, { headers });
    if (projectsRes.status === 200) {
      const projectsBody = projectsRes.json() as {
        projects?: Array<{ id: string; name: string }>;
      };
      const projects = projectsBody.projects || [];

      for (const proj of projects) {
        if (proj.id === projectId) continue; // skip current project
        const otherAgentsRes = http.get(
          `${studioUrl}${studioApiPath(`/projects/${proj.id}/agents`)}`,
          { headers },
        );
        if (otherAgentsRes.status !== 200) continue;

        const otherBody = otherAgentsRes.json() as {
          agents?: Array<{ id: string; name: string; agentPath: string }>;
        };
        const conflict = (otherBody.agents || []).find(
          (a) => a.name === agentName && a.name.startsWith('benchmark_'),
        );
        if (conflict) {
          console.log(
            `[bootstrap-agent] Found conflicting agent ${conflict.id} in project ${proj.id} (${proj.name}), deleting...`,
          );
          const delRes = http.del(
            `${studioUrl}${studioApiPath(`/projects/${proj.id}/agents/${conflict.id}`)}`,
            null,
            { headers },
          );
          console.log(`[bootstrap-agent] Delete returned ${delRes.status}`);
          break;
        }
      }

      // Retry creation after cleanup
      console.log(`[bootstrap-agent] Retrying agent creation...`);
      createRes = httpWithRetry('POST', agentsUrl, JSON.stringify(agentConfig), headers, {
        label: 'create-agent-retry',
      });
    }
  }

  const createOk = check(createRes, {
    'create agent returns 200|201': (r) => r.status === 200 || r.status === 201,
  });

  if (!createOk) {
    throw new Error(`Create agent failed: ${createRes.status} ${createRes.body}`);
  }

  const agent = createRes.json() as {
    success?: boolean;
    agent?: { id: string; name: string; agentPath: string };
    id?: string;
    name?: string;
    agentPath?: string;
  };

  const result = agent.agent || agent;
  const createdId = (result as Record<string, unknown>).id as string;
  const createdPath = ((result as Record<string, unknown>).agentPath as string) || agentPath;
  console.log(`[bootstrap-agent] Created agent: ${createdId} (${createdPath})`);

  // Save dslContent via dedicated DSL endpoint (create doesn't persist it)
  saveDslContent(studioUrl, projectId, agentName, agentConfig.dslContent, headers);

  return {
    agentId: createdId,
    agentName: ((result as Record<string, unknown>).name as string) || agentName,
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
    console.log(`[bootstrap-agent] DSL content saved for "${agentName}"`);
  } else {
    console.warn(
      `[bootstrap-agent] DSL save returned ${dslRes.status}: ${(dslRes.body as string).substring(0, 200)}`,
    );
  }
}
