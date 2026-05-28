/**
 * GET /api/agents/apps/:domain - Get all agents in a project
 *
 * The :domain param is the projectId (kept for backward compatibility in URLs).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { compileProjectAgentsForDiagnostics, pickTargetIR } from '@/lib/abl/project-aware-compile';
import { createLogger } from '@abl/compiler/platform/logger.js';

type RouteParams = { params: Promise<{ domain: string }> };

const log = createLogger('api:agents:apps');

const agentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  type: z.enum(['supervisor', 'agent']),
  mode: z.enum(['scripted', 'reasoning']),
  toolCount: z.number(),
  gatherFieldCount: z.number(),
  isSupervisor: z.boolean(),
});

const agentDetailSchema = agentInfoSchema.extend({
  dsl: z.string(),
  ir: z.any().optional(),
});

const appInfoSchema = z.object({
  name: z.string(),
  domain: z.string(),
  entryAgent: z.string(),
  agents: z.array(agentInfoSchema),
  agentCount: z.number(),
});

const pathParamsSchema = z.object({
  domain: z.string().describe('Project ID'),
});

const getAppAgentsResponseSchema = z.object({
  success: z.boolean(),
  app: appInfoSchema,
  agents: z.array(agentDetailSchema),
});

async function handler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { domain: projectId } = await params;

  try {
    const access = await requireProjectAccess(projectId, user);
    if (isAccessError(access)) return access;

    const { ProjectAgent } = await import('@agent-platform/database/models');

    const agents = await ProjectAgent.find({ projectId, tenantId: access.project.tenantId })
      .sort({ name: 1 })
      .lean();

    if (agents.length === 0) {
      return NextResponse.json(
        { success: false, error: `App not found: ${projectId}` },
        { status: 404 },
      );
    }

    const supervisor = agents.find((a: any) =>
      /(?:SUPERVISOR|supervisor):/m.test(a.dslContent ?? ''),
    );
    const compilation = await compileProjectAgentsForDiagnostics({
      agents,
      projectId,
      tenantId: access.project.tenantId,
    }).catch((error) => {
      log.warn('Project-aware legacy app agent compile failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const agentDetails = agents
      .filter((a: any) => a.dslContent)
      .map((a: any) => {
        const dsl = a.dslContent!;
        const isSupervisor = /(?:SUPERVISOR|supervisor):/m.test(dsl);

        const ir = compilation?.compiled ? pickTargetIR(compilation.compiled, [a.name]) : null;

        return {
          id: a.name,
          name: a.name,
          filePath: '',
          type: isSupervisor ? ('supervisor' as const) : ('agent' as const),
          mode: /(?:MODE|mode):\s*scripted/m.test(dsl)
            ? ('scripted' as const)
            : ('reasoning' as const),
          toolCount: 0,
          gatherFieldCount: 0,
          isSupervisor,
          dsl,
          ir: ir || undefined,
        };
      });

    const projectName = access.project.name || projectId;
    const appInfo = {
      name: projectName,
      domain: projectId,
      entryAgent: supervisor?.name || agents[0]?.name || 'unknown',
      agents: agentDetails.map((a: any) => ({
        id: a.id,
        name: a.name,
        filePath: '',
        type: a.type,
        mode: a.mode,
        toolCount: a.toolCount,
        gatherFieldCount: a.gatherFieldCount,
        isSupervisor: a.isSupervisor,
      })),
      agentCount: agents.length,
    };

    return NextResponse.json({
      success: true,
      app: appInfo,
      agents: agentDetails,
    });
  } catch (error) {
    log.error('Error loading app', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Failed to load app' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get app agents',
    description: 'Get all agents in a project.',
    params: pathParamsSchema,
    response: getAppAgentsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
