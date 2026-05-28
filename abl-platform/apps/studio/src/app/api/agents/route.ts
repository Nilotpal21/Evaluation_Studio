/**
 * GET /api/agents - List all available agents from database
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findProjectAgentsByTenantId } from '@/repos/project-repo';
import { findAccessibleProjectIds } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('legacy-agents-route');

const agentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  type: z.enum(['supervisor', 'agent']),
  mode: z.enum(['scripted', 'reasoning']),
  toolCount: z.number(),
  gatherFieldCount: z.number(),
  isSupervisor: z.boolean(),
  projectId: z.string(),
  projectName: z.string().optional(),
});

const listAgentsResponseSchema = z.object({
  success: z.boolean(),
  total: z.number(),
  agents: z.array(agentInfoSchema),
});

async function handler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const tenantId = user.tenantId;
    const projectIds = await findAccessibleProjectIds(user);

    const agents = await findProjectAgentsByTenantId(tenantId ?? '', projectIds);

    const agentInfos = agents.map((a: any) => ({
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
      projectId: a.projectId,
      projectName: a.project?.name,
    }));

    return NextResponse.json({
      success: true,
      total: agentInfos.length,
      agents: agentInfos,
    });
  } catch (error) {
    log.error('Error listing agents', {
      error: error instanceof Error ? error.message : String(error),
      userId: user.id,
      tenantId: user.tenantId,
    });
    return NextResponse.json({ success: false, error: 'Failed to list agents' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List all agents',
    description: 'List all available agents from database.',
    response: listAgentsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
