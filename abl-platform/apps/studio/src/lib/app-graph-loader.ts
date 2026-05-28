import { authHeaders } from './api-client';
import { sanitizeServerError } from './sanitize-error';
import { generateStaticGraph } from '../utils/graph-generator';
import type { AgentConnection, AppStaticGraph, InterAgentEdge, StaticGraph } from '../types';

export interface AvailableAppInfo {
  name: string;
  /** projectId — used as URL param to /api/agents/apps/:projectId */
  domain: string;
  entryAgent: string;
  agentCount: number;
}

interface AppAgentSummary {
  name: string;
}

interface AppResponse {
  name: string;
  domain: string;
  entryAgent: string;
  agents: AppAgentSummary[];
  agentCount: number;
}

interface AgentDetailResponse {
  name: string;
  type: 'supervisor' | 'agent';
  mode: 'scripted' | 'reasoning';
  isSupervisor: boolean;
  dsl: string;
  ir?: unknown;
}

interface AppListResponse {
  success: boolean;
  apps?: AvailableAppInfo[];
  error?: string;
}

interface AppDetailResponse {
  success: boolean;
  app?: AppResponse;
  agents?: AgentDetailResponse[];
  error?: string;
}

export async function fetchAvailableAppsList(): Promise<AvailableAppInfo[]> {
  const response = await fetch('/api/agents/apps', { headers: authHeaders() });
  const data = (await response.json()) as AppListResponse;

  if (!data.success || !Array.isArray(data.apps)) {
    throw new Error(sanitizeServerError(data.error, 'Failed to fetch apps'));
  }

  return data.apps;
}

export async function fetchAppStaticGraph(domain: string): Promise<AppStaticGraph> {
  const response = await fetch(`/api/agents/apps/${domain}`, { headers: authHeaders() });
  const data = (await response.json()) as AppDetailResponse;

  if (!data.success || !data.app || !Array.isArray(data.agents)) {
    throw new Error(sanitizeServerError(data.error, 'Failed to load app'));
  }

  return buildAppStaticGraph(data.app, data.agents);
}

function buildAppStaticGraph(app: AppResponse, agents: AgentDetailResponse[]): AppStaticGraph {
  const agentGraphs: Record<string, StaticGraph> = {};
  const connections: AgentConnection[] = [];

  for (const agent of agents) {
    const ir = agent.ir as { flow?: { staticGraph?: StaticGraph } } | undefined;
    if (ir?.flow?.staticGraph) {
      agentGraphs[agent.name] = ir.flow.staticGraph;
    } else {
      const generatedGraph = generateStaticGraph({
        name: agent.name,
        type: agent.type,
        mode: agent.mode,
        isSupervisor: agent.isSupervisor,
        ir: (agent.ir ?? {}) as Record<string, unknown>,
      });
      if (generatedGraph) {
        agentGraphs[agent.name] = generatedGraph;
      }
    }

    if (agent.isSupervisor && agent.dsl) {
      const handoffMatches = agent.dsl.matchAll(/- TO:\s*(\w+)\s*\n\s*WHEN:\s*([^\n]+)/g);
      for (const match of handoffMatches) {
        connections.push({
          from: agent.name,
          to: match[1],
          type: 'handoff',
          when: match[2].trim(),
          returns: agent.dsl.includes(`TO: ${match[1]}`) && agent.dsl.includes('RETURN: true'),
          label: match[1],
        });
      }
    }
  }

  const agentPositions: Record<string, { row: number; col: number }> = {
    [app.entryAgent]: { row: 0, col: 0 },
  };

  let col = 1;
  let row = 0;
  for (const agentInfo of app.agents) {
    if (agentInfo.name !== app.entryAgent) {
      agentPositions[agentInfo.name] = { row: row++, col };
      if (row > 3) {
        row = 0;
        col++;
      }
    }
  }

  const interAgentEdges: InterAgentEdge[] = connections.map((conn, idx) => ({
    id: `inter-${idx}`,
    fromAgent: conn.from,
    toAgent: conn.to,
    type: conn.type,
    label: conn.label,
    returns: conn.returns,
  }));

  return {
    app: {
      name: app.name,
      entryAgent: app.entryAgent,
      agents: app.agents.map((agent) => agent.name),
      connections,
    },
    agentGraphs,
    interAgentEdges,
    layout: {
      agentPositions,
      entryPosition: 'left',
      direction: 'horizontal',
    },
  };
}
