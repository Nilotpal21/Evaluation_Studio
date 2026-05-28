/**
 * Module Rehydration Fallback
 *
 * When a session's active agent is a module agent (name contains '__'),
 * and the IR is missing from cache after a runtime restart, this utility
 * resolves the agent IR directly from the module release rather than
 * trying to find it in the project's own DSL agents.
 */

import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { MODULE_NAME_SEPARATOR, isMountedModuleName } from './module-agent-stubs.js';

const log = createLogger('module-rehydration-fallback');

export interface ModuleAgentResolution {
  agentIR: AgentIR;
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
}

interface ModuleRehydrationModels {
  ProjectModuleDependency: {
    find(filter: Record<string, unknown>): { lean(): Promise<Array<Record<string, unknown>>> };
  };
  ModuleRelease: {
    findOne(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown> | null> };
  };
}

/**
 * Check if an agent name indicates a module agent (contains '__').
 */
function isModuleAgentName(agentName: string): boolean {
  return isMountedModuleName(agentName);
}

/**
 * Resolve a module agent's IR from the module release.
 *
 * Parses the agent name to extract the alias and original name,
 * finds the matching ProjectModuleDependency, loads the release,
 * and rewrites the IR with the alias prefix.
 *
 * Returns null if the agent is not a module agent, if no matching
 * dependency is found, or if resolution fails for any reason.
 */
export async function resolveModuleAgentIR(
  agentName: string,
  tenantId: string,
  projectId: string,
  models?: ModuleRehydrationModels,
): Promise<ModuleAgentResolution | null> {
  if (!isModuleAgentName(agentName)) {
    return null;
  }

  const separatorIndex = agentName.indexOf(MODULE_NAME_SEPARATOR);
  const alias = agentName.substring(0, separatorIndex);
  const originalName = agentName.substring(separatorIndex + MODULE_NAME_SEPARATOR.length);
  if (!alias || !originalName) {
    return null;
  }

  try {
    const { ProjectModuleDependency, ModuleRelease } =
      models ?? (await import('@agent-platform/database/models'));

    const dependencies = await ProjectModuleDependency.find({
      tenantId,
      projectId,
    }).lean();

    const dep = (dependencies as Array<Record<string, unknown>>).find(
      (d) => String(d.alias ?? '') === alias,
    );

    if (!dep) {
      log.debug('Agent name contains module separator but no dependency alias matched', {
        agentName,
        alias,
        projectId,
      });
      return null;
    }

    const release = await ModuleRelease.findOne({
      _id: dep.resolvedReleaseId,
      tenantId,
      moduleProjectId: dep.moduleProjectId,
      archivedAt: { $in: [null, undefined] },
    }).lean();

    if (!release) {
      log.warn('Module release not found for rehydration', {
        agentName,
        resolvedReleaseId: dep.resolvedReleaseId,
      });
      return null;
    }

    const releaseRecord = release as Record<string, unknown>;
    const compiledIR = (releaseRecord.compiledIR ?? {}) as Record<string, unknown>;
    const agentIRData = compiledIR[originalName] as AgentIR | undefined;

    if (!agentIRData) {
      log.warn('Agent not found in module compiled IR', {
        agentName,
        originalName,
        alias,
        availableAgents: Object.keys(compiledIR),
      });
      return null;
    }

    // Deep-clone and rewrite with alias
    const { rewriteModuleIR } = await import('./module-alias-rewriter.js');

    const artifact = (releaseRecord.artifact ?? {}) as Record<string, unknown>;
    const artifactTools = (artifact.tools ?? {}) as Record<string, Record<string, unknown>>;
    const toolEntries: Record<string, { definition: unknown; toolType: string }> = {};
    for (const [toolName, toolData] of Object.entries(artifactTools)) {
      toolEntries[toolName] = {
        definition: toolData.definition ?? { name: toolName, tool_type: toolData.toolType },
        toolType: String(toolData.toolType ?? ''),
      };
    }

    const rewriteResult = rewriteModuleIR(
      alias,
      { [originalName]: agentIRData },
      toolEntries,
      new Set<string>(), // No collision check needed for rehydration
    );

    const rewrittenIR = rewriteResult.agents[agentName];
    if (!rewrittenIR) {
      log.warn('Rewrite did not produce expected agent', {
        agentName,
        rewrittenAgents: Object.keys(rewriteResult.agents),
      });
      return null;
    }

    log.info('Module agent IR resolved for rehydration', {
      agentName,
      alias,
      moduleProjectId: String(dep.moduleProjectId),
    });

    return {
      agentIR: rewrittenIR as AgentIR,
      alias,
      moduleProjectId: String(dep.moduleProjectId),
      moduleReleaseId: String(dep.resolvedReleaseId),
    };
  } catch (err) {
    log.error('Failed to resolve module agent IR for rehydration', {
      agentName,
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
