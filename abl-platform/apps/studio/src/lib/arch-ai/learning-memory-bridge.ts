/**
 * Learning Memory Bridge — lazy-loaded bridge to the LearningMemoryService.
 *
 * Provides fire-and-forget recording functions that can be called from
 * the build pipeline without blocking the main flow. Errors are logged
 * but never propagated — learning is best-effort.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:learning-memory-bridge');

/**
 * Record compile-fix patterns as learning memories.
 * Called after a successful compile-fix cycle in build-parallel-gen.
 *
 * @param compileErrors - Raw error strings from the compile result
 * @param agentName - Name of the agent being compiled
 * @param fixRounds - Number of fix rounds needed
 * @param context - Domain and role context for the learning
 */
export async function recordCompileFixLearning(
  compileErrors: string[],
  agentName: string,
  fixRounds: number,
  context?: { domain?: string; agentRole?: string },
): Promise<void> {
  try {
    const { ArchLearningMemory } = await import('@agent-platform/database/models');
    const { LearningMemoryService } = await import('@agent-platform/arch-ai/session');

    const service = new LearningMemoryService(ArchLearningMemory);

    // Record the first error as the primary pattern (most representative)
    const primaryError = compileErrors[0] ?? 'Unknown compile error';
    await service.recordErrorFix({
      errorMessage: primaryError,
      fixDescription: `Auto-fixed in ${fixRounds} round${fixRounds === 1 ? '' : 's'} for agent "${agentName}"`,
      context: {
        domain: context?.domain,
        agentRole: context?.agentRole,
      },
    });
  } catch (err: unknown) {
    log.warn('Failed to record compile-fix learning (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a topology choice as a learning memory.
 * Called after topology approval in the message route.
 *
 * @param domain - Project domain (e.g., "e-commerce", "support")
 * @param pattern - Topology pattern (e.g., "triage_specialists")
 * @param agentCount - Number of agents in the topology
 */
export async function recordTopologyLearning(
  domain: string,
  pattern: string,
  agentCount: number,
): Promise<void> {
  try {
    const { ArchLearningMemory } = await import('@agent-platform/database/models');
    const { LearningMemoryService } = await import('@agent-platform/arch-ai/session');

    const service = new LearningMemoryService(ArchLearningMemory);
    await service.recordTopologyChoice({ domain, pattern, agentCount });
  } catch (err: unknown) {
    log.warn('Failed to record topology learning (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
