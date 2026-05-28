/**
 * GET /api/agents/:name - Get specific agent details from database
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findProjectAgentByName } from '@/repos/project-repo';
import { getProjectAgents } from '@/services/project-service';
import { compileProjectAgentsForDiagnostics, pickTargetIR } from '@/lib/abl/project-aware-compile';
import { createLogger } from '@abl/compiler/platform/logger.js';

type RouteParams = { params: Promise<{ name: string }> };

const log = createLogger('api:agents:detail');

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  type: z.enum(['supervisor', 'agent']),
  mode: z.enum(['scripted', 'reasoning']),
  toolCount: z.number(),
  gatherFieldCount: z.number(),
  isSupervisor: z.boolean(),
  dsl: z.string(),
  ir: z.any().optional(),
});

const pathParamsSchema = z.object({
  name: z.string().describe('Agent name'),
});

const getAgentResponseSchema = z.object({
  success: z.boolean(),
  agent: agentSchema,
});

async function handler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { name } = await params;

  try {
    const projectId = request.nextUrl.searchParams.get('projectId')?.trim();

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'projectId query parameter is required for agent detail lookup' },
        { status: 400 },
      );
    }

    const access = await requireProjectAccess(projectId, user);
    if (isAccessError(access)) return access;

    const record = await findProjectAgentByName(name, access.project.tenantId, projectId);

    if (!record?.dslContent) {
      return NextResponse.json(
        { success: false, error: `Agent not found: ${name}` },
        { status: 404 },
      );
    }

    const dsl = record.dslContent;
    const isSupervisor = /(?:SUPERVISOR|supervisor):/m.test(dsl);

    let ir = null;
    try {
      const projectAgents = await getProjectAgents(projectId, access.project.tenantId);
      const compileAgents = projectAgents.some((agent) => agent.name === record.name)
        ? projectAgents
        : [record, ...projectAgents];
      const compilation = await compileProjectAgentsForDiagnostics({
        agents: compileAgents,
        projectId,
        tenantId: access.project.tenantId,
      });
      if (compilation.compiled) {
        ir = pickTargetIR(compilation.compiled, [record.name]);
      }
    } catch (error) {
      log.warn('Project-aware legacy agent detail compile failed', {
        projectId,
        agentName: record.name,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without IR
    }

    const agent = {
      id: record.name,
      name: record.name,
      filePath: '',
      type: isSupervisor ? ('supervisor' as const) : ('agent' as const),
      mode: /(?:MODE|mode):\s*scripted/m.test(dsl) ? ('scripted' as const) : ('reasoning' as const),
      toolCount: 0,
      gatherFieldCount: 0,
      isSupervisor,
      dsl,
      ir: ir || undefined,
    };

    return NextResponse.json({ success: true, agent });
  } catch (error) {
    log.error('Error loading agent', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Failed to load agent' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get agent details',
    description: 'Get specific agent details from database including DSL and compiled IR.',
    params: pathParamsSchema,
    response: getAgentResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
