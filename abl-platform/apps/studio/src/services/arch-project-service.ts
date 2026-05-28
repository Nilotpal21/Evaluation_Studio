/**
 * Arch Project Service
 *
 * Shared aggregation logic for project summary data.
 * Used by both the platform_context tool and the project-summary API route.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { getProjectAgents } from './project-service';
import type { ProjectSummary } from '@/types/arch';

const log = createLogger('arch-project-service');

const SUMMARY_TIMEOUT_MS = 5_000;

/**
 * Aggregate project summary data from multiple sources.
 *
 * Uses Promise.allSettled with timeout for resilience.
 * Returns partial data (0 for failed counts) rather than failing entirely.
 */
export async function getProjectSummary(
  projectId: string,
  tenantId: string,
): Promise<ProjectSummary> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('Summary timeout')), SUMMARY_TIMEOUT_MS);
  });

  const agentsPromise = getProjectAgents(projectId, tenantId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Failed to fetch agents for summary', { projectId, error: msg });
    return [] as Awaited<ReturnType<typeof getProjectAgents>>;
  });

  const toolsPromise = (async () => {
    const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');
    const result = await findProjectToolsByProject(tenantId, projectId);
    return result?.data ?? [];
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Failed to fetch tools for summary', { projectId, error: msg });
    return [] as unknown[];
  });

  const channelsPromise = (async () => {
    const { ensureDb } = await import('@/lib/ensure-db');
    await ensureDb();
    const { ChannelConnection } = await import('@agent-platform/database/models');
    return ChannelConnection.countDocuments({ projectId, tenantId });
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Failed to fetch channel count for summary', { projectId, error: msg });
    return 0;
  });

  try {
    const [agents, tools, channelCount] = await Promise.race([
      Promise.all([agentsPromise, toolsPromise, channelsPromise]),
      timeout,
    ]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    const agentNames = Array.isArray(agents)
      ? agents.map((a: { name?: string; agentPath?: string }) => a.name ?? a.agentPath ?? 'unknown')
      : [];

    return {
      agentCount: agentNames.length,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      channelCount: typeof channelCount === 'number' ? channelCount : 0,
      guardrailCount: 0, // Guardrails live in runtime — not queryable from Studio DB yet
      agentNames,
    };
  } catch (err: unknown) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Project summary timed out, returning partial data', { projectId, error: msg });
    return {
      agentCount: 0,
      toolCount: 0,
      channelCount: 0,
      guardrailCount: 0,
      agentNames: [],
    };
  }
}
