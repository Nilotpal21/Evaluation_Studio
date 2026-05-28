/**
 * GET /api/projects/:id/tools/workflow-compatible
 *
 * Returns project tools that are compatible with workflow execution:
 * - Includes tools with no auth_profile reference
 * - Includes tools referencing auth profiles with usageMode !== 'jit'
 *   and connectionMode !== 'per_user'
 * - Excludes tools that resolve to workflow-incompatible auth profiles
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('project-tools-workflow-compatible-route');

interface WorkflowToolRow {
  _id: string;
  name: string;
  dslContent: string;
  toolType?: string;
}

interface WorkflowAuthProfileRow {
  _id: string;
  name: string;
  projectId: string | null;
  usageMode?: 'preconfigured' | 'user_token' | 'jit' | 'preflight';
  connectionMode?: 'shared' | 'per_user';
}

function parseDslProperties(dslContent: string): Record<string, string> {
  const props: Record<string, string> = {};
  const lines = dslContent.split('\n');

  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    props[key] = value.replace(/^["']|["']$/g, '').trim();
  }

  return props;
}

function resolveAuthProfileRef(dslContent: string): string | null {
  const props = parseDslProperties(dslContent);
  const authProfileRef = props.auth_profile;
  if (typeof authProfileRef !== 'string') {
    return null;
  }
  const trimmed = authProfileRef.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isTemplatedAuthProfileRef(authProfileRef: string): boolean {
  return authProfileRef.includes('{{') && authProfileRef.includes('}}');
}

function pickResolvedProfile(
  profileCandidates: WorkflowAuthProfileRow[] | undefined,
  projectId: string,
): WorkflowAuthProfileRow | null {
  if (!profileCandidates || profileCandidates.length === 0) {
    return null;
  }

  const projectScoped = profileCandidates.find((profile) => profile.projectId === projectId);
  if (projectScoped) {
    return projectScoped;
  }

  return profileCandidates.find((profile) => profile.projectId === null) ?? null;
}

function isWorkflowCompatibleProfile(profile: WorkflowAuthProfileRow | null): boolean {
  if (!profile) {
    return true;
  }
  if (profile.usageMode === 'jit') {
    return false;
  }
  if (profile.connectionMode === 'per_user') {
    return false;
  }
  return true;
}

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ params, tenantId, request }) => {
    await ensureDb();

    const { ProjectTool, AuthProfile } = await import('@agent-platform/database/models');
    const projectId = params.id;
    const currentWorkflowId = request.nextUrl.searchParams.get('currentWorkflowId')?.trim() ?? '';

    const tools = (await ProjectTool.find({
      tenantId,
      projectId,
    })
      .select('_id name dslContent toolType')
      .lean()) as WorkflowToolRow[];

    const literalAuthProfileRefs = Array.from(
      new Set(
        tools
          .map((tool) => resolveAuthProfileRef(tool.dslContent))
          .filter(
            (authProfileRef): authProfileRef is string =>
              typeof authProfileRef === 'string' &&
              authProfileRef.length > 0 &&
              !isTemplatedAuthProfileRef(authProfileRef),
          ),
      ),
    );

    const profilesByName = new Map<string, WorkflowAuthProfileRow[]>();
    if (literalAuthProfileRefs.length > 0) {
      const authProfiles = (await AuthProfile.find({
        tenantId,
        name: { $in: literalAuthProfileRefs },
        status: 'active',
        $or: [{ projectId }, { projectId: null }],
      })
        .select('_id name projectId usageMode connectionMode')
        .lean()) as WorkflowAuthProfileRow[];

      for (const authProfile of authProfiles) {
        const existing = profilesByName.get(authProfile.name) ?? [];
        existing.push(authProfile);
        profilesByName.set(authProfile.name, existing);
      }
    }

    const compatibleTools = tools
      .filter((tool) => {
        if (currentWorkflowId && tool.toolType === 'workflow') {
          const workflowId = parseDslProperties(tool.dslContent).workflow_id?.trim();
          if (workflowId === currentWorkflowId) {
            return false;
          }
        }

        const authProfileRef = resolveAuthProfileRef(tool.dslContent);
        if (!authProfileRef) {
          return true;
        }

        if (isTemplatedAuthProfileRef(authProfileRef)) {
          // Dynamic refs are resolved at execution time. Keep them visible.
          return true;
        }

        const resolvedProfile = pickResolvedProfile(profilesByName.get(authProfileRef), projectId);
        return isWorkflowCompatibleProfile(resolvedProfile);
      })
      .map((tool) => ({
        id: tool._id,
        name: tool.name,
      }));

    log.debug('Resolved workflow-compatible tool list', {
      tenantId,
      projectId,
      currentWorkflowId: currentWorkflowId || undefined,
      totalTools: tools.length,
      compatibleTools: compatibleTools.length,
    });

    return NextResponse.json({
      success: true,
      data: compatibleTools,
    });
  },
);
