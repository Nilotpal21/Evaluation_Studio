/**
 * GET /api/arch-ai/sessions/:id/checkpoints — Preview checkpoint summaries
 * Returns all checkpoints with summary info for preview before rollback.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { actionJson, errorJson, handleApiError } from '@/lib/api-response';
import { SessionService, SessionNotFoundError } from '@agent-platform/arch-ai';
import type { SessionCheckpoint } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

const log = createLogger('api:arch-ai:sessions:[id]:checkpoints');

const sessionService = new SessionService(ArchSessionModel);

interface CheckpointPreview {
  checkpointId: string;
  phase: string;
  trigger: SessionCheckpoint['trigger'];
  timestamp: string;
  messageCount: number;
  summary: {
    agentCount: number;
    topologyPattern: string | null;
    buildStage: string | null;
    hasSpecification: boolean;
    topologyApproved: boolean;
    approvedAgentCount: number;
  };
  previewText: string;
}

function buildPreviewText(cp: SessionCheckpoint): string {
  const parts: string[] = [cp.phase];

  const agentCount = cp.stateSnapshot.topology
    ? ((Object.keys((cp.stateSnapshot.topology as Record<string, unknown>).agents ?? {}).length ||
        ((cp.stateSnapshot.topology as { agents?: unknown[] })?.agents as unknown[] | undefined)
          ?.length) ??
      0)
    : 0;

  if (agentCount > 0) {
    parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
  }

  const pattern = (cp.stateSnapshot.topology as Record<string, unknown>)?.pattern as
    | string
    | undefined;
  if (pattern) {
    parts.push(`${pattern} pattern`);
  }

  const buildStage = cp.stateSnapshot.buildProgress?.stage;
  if (buildStage) {
    parts.push(buildStage === 'complete' ? 'build complete' : `build ${buildStage}`);
  }

  if (cp.stateSnapshot.topologyApproved) {
    parts.push('topology approved');
  }

  return parts.join(' \u2014 ');
}

function summarizeCheckpoint(cp: SessionCheckpoint): CheckpointPreview {
  const topology = cp.stateSnapshot.topology as Record<string, unknown> | undefined;
  const agents = topology?.agents;
  const agentCount = Array.isArray(agents)
    ? agents.length
    : typeof agents === 'object' && agents !== null
      ? Object.keys(agents).length
      : 0;

  return {
    checkpointId: cp.checkpointId,
    phase: cp.phase,
    trigger: cp.trigger,
    timestamp: cp.timestamp,
    messageCount: cp.messageCount,
    summary: {
      agentCount,
      topologyPattern: (topology?.pattern as string) ?? null,
      buildStage: cp.stateSnapshot.buildProgress?.stage ?? null,
      hasSpecification: cp.stateSnapshot.specification != null,
      topologyApproved: cp.stateSnapshot.topologyApproved ?? false,
      approvedAgentCount: cp.stateSnapshot.approvedAgents?.length ?? 0,
    },
    previewText: buildPreviewText(cp),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    const session = await sessionService.getById(ctx, id);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const checkpoints: SessionCheckpoint[] = session.metadata.checkpoints ?? [];
    const previews = checkpoints.map(summarizeCheckpoint);

    log.info('Checkpoint previews requested', {
      sessionId: id,
      checkpointCount: previews.length,
      userId: auth.id,
    });

    return actionJson({
      checkpoints: previews,
      currentPhase: session.metadata.phase ?? 'INTERVIEW',
      currentBuildStage: session.metadata.buildProgress?.stage ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof SessionNotFoundError) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    return handleApiError(err, 'arch-ai');
  }
}
