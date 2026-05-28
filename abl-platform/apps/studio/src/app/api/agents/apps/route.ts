/**
 * GET /api/agents/apps - List all available apps (projects) from database
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findProjectAgentsByTenantId } from '@/repos/project-repo';
import { findAccessibleProjectIds } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('legacy-agent-apps-route');

const appAgentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  type: z.enum(['supervisor', 'agent']),
  mode: z.enum(['scripted', 'reasoning']),
  toolCount: z.number(),
  gatherFieldCount: z.number(),
  isSupervisor: z.boolean(),
});

const appSchema = z.object({
  name: z.string(),
  domain: z.string(),
  entryAgent: z.string(),
  agents: z.array(appAgentInfoSchema),
  agentCount: z.number(),
});

const listAppsResponseSchema = z.object({
  success: z.boolean(),
  total: z.number(),
  apps: z.array(appSchema),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const tenantId = user.tenantId;
    const projectIds = await findAccessibleProjectIds(user);

    const agents = await findProjectAgentsByTenantId(tenantId ?? '', projectIds);

    // Group by project
    const byProject: Record<string, { projectName: string; agents: any[] }> = {};
    for (const agent of agents) {
      const projId = agent.project?.id || agent.projectId;
      const projName = agent.project?.name || 'Unknown';
      if (!byProject[projId]) byProject[projId] = { projectName: projName, agents: [] };
      byProject[projId].agents.push(agent);
    }

    const apps = Object.entries(byProject)
      .map(([projectId, { projectName, agents: projAgents }]) => {
        const supervisor = projAgents.find((a: any) =>
          /(?:SUPERVISOR|supervisor):/m.test(a.dslContent ?? ''),
        );
        return {
          name: projectName,
          domain: projectId,
          entryAgent: supervisor?.name || projAgents[0]?.name || 'unknown',
          agents: projAgents.map((a: any) => ({
            id: a.name,
            name: a.name,
            filePath: '',
            type: /(?:SUPERVISOR|supervisor):/m.test(a.dslContent ?? '')
              ? ('supervisor' as const)
              : ('agent' as const),
            mode: /(?:MODE|mode):\s*scripted/m.test(a.dslContent ?? '')
              ? ('scripted' as const)
              : ('reasoning' as const),
            toolCount: 0,
            gatherFieldCount: 0,
            isSupervisor: /(?:SUPERVISOR|supervisor):/m.test(a.dslContent ?? '') ?? false,
          })),
          agentCount: projAgents.length,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      success: true,
      total: apps.length,
      apps,
    });
  } catch (error) {
    log.error('Error listing apps', {
      error: error instanceof Error ? error.message : String(error),
      userId: user.id,
      tenantId: user.tenantId,
    });
    return NextResponse.json({ success: false, error: 'Failed to list apps' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List all apps',
    description: 'List all available apps (projects) from database.',
    response: listAppsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
