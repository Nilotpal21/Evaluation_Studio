/**
 * GET /api/projects/:id/dependencies
 *
 * Full dependency graph for a project.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, ProjectAgent, type IProjectAgent } from '@agent-platform/database/models';
import {
  buildDependencyGraph,
  validateDependencies,
  getAgentDependents,
  getAgentDependencies,
} from '@agent-platform/project-io/dependencies';

const log = createLogger('dependencies-route');

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureConnected();

    const tenantId = access.project.tenantId;
    const MAX_AGENTS_FOR_GRAPH = 1000;
    const agents = await ProjectAgent.find({ projectId, tenantId })
      .limit(MAX_AGENTS_FOR_GRAPH + 1)
      .lean();

    if (agents.length > MAX_AGENTS_FOR_GRAPH) {
      return NextResponse.json(
        {
          error: `Too many agents (${agents.length}). Dependency graph supports max ${MAX_AGENTS_FOR_GRAPH}.`,
        },
        { status: 400 },
      );
    }

    const entries = agents
      .filter((a: IProjectAgent) => a.dslContent)
      .map((a: IProjectAgent) => ({ name: a.name, dslContent: a.dslContent! }));

    const graph = buildDependencyGraph(entries);
    const validation = validateDependencies(graph);

    const agentDetails = entries.map((a: { name: string; dslContent: string }) => ({
      name: a.name,
      dependsOn: getAgentDependencies(graph, a.name),
      dependents: getAgentDependents(graph, a.name),
    }));

    return NextResponse.json({
      agents: agentDetails,
      edges: graph.edges,
      validation,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to compute dependencies', { projectId, error: message });
    return NextResponse.json({ error: 'Failed to compute dependencies' }, { status: 500 });
  }
}
