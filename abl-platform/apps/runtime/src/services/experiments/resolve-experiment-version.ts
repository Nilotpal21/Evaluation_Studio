/**
 * Experiment Version Resolution
 *
 * When a session is assigned to the 'experiment' group, the entry agent's
 * version may differ from the deployment's control version. This module
 * loads the experiment version's IR from the database and replaces the
 * entry agent's IR in the resolved agent payload.
 *
 * This override is applied BEFORE createSessionFromResolved() so the
 * runtime session loads the correct IR from the start.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { CachedExperiment } from '@agent-platform/pipeline-engine';
import { DeploymentResolver } from '../deployment-resolver.js';
import type { ResolvedAgent } from '../deployment-resolver.js';
import { getSessionService } from '../session/session-service.js';

const log = createLogger('experiment-version-resolver');

/**
 * Override the resolved agent's entry agent IR with the experiment version.
 *
 * Mutates the `resolved` object in place — replacing the entry agent's IR
 * and updating versionInfo.rawVersions to reflect the experiment version.
 *
 * @returns true if the override was applied, false if skipped or failed
 */
export async function overrideResolvedAgentWithExperimentVersion(
  resolved: ResolvedAgent,
  experimentVersionString: string,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const entryAgentName = resolved.entryAgent;
  const currentRawVersion = resolved.versionInfo.rawVersions?.[entryAgentName];

  // If the experiment version matches the current resolved version, no override needed
  if (currentRawVersion === experimentVersionString) {
    log.debug('Experiment version matches resolved version — no override', {
      entryAgentName,
      version: experimentVersionString,
    });
    return false;
  }

  try {
    const { ProjectAgent, AgentVersion } = await import('@agent-platform/database/models');

    // Find the entry agent's DB record to get agentId for version lookup
    const agent = await ProjectAgent.findOne(
      { tenantId, projectId, name: entryAgentName },
      { _id: 1 },
    ).lean();
    if (!agent) {
      log.warn('Entry agent not found for experiment version override', {
        entryAgentName,
        projectId,
      });
      return false;
    }

    const agentId = (agent as Record<string, unknown>)._id as string;
    const agentVersion = await AgentVersion.findOne(
      { agentId, version: experimentVersionString },
      { irContent: 1 },
    ).lean();

    if (!agentVersion) {
      log.warn('Experiment agent version not found', {
        entryAgentName,
        agentId,
        experimentVersion: experimentVersionString,
      });
      return false;
    }

    const irContent = (agentVersion as Record<string, unknown>).irContent as string | undefined;
    if (!irContent) {
      log.warn('Experiment agent version has no IR content', {
        entryAgentName,
        experimentVersion: experimentVersionString,
      });
      return false;
    }

    let parsed: CompilationOutput;
    try {
      parsed = JSON.parse(irContent) as CompilationOutput;
    } catch {
      log.warn('Experiment agent version has corrupt IR', {
        entryAgentName,
        experimentVersion: experimentVersionString,
      });
      return false;
    }

    // Extract the agent IR from the compilation output
    const experimentIR = extractAgentIR(parsed, entryAgentName);
    if (!experimentIR) {
      log.warn('Could not extract agent IR from experiment version', {
        entryAgentName,
        experimentVersion: experimentVersionString,
        availableAgents: parsed.agents ? Object.keys(parsed.agents) : [],
      });
      return false;
    }

    // Apply the override
    resolved.agents[entryAgentName] = experimentIR;

    // Update version info to reflect the experiment version
    if (resolved.versionInfo.rawVersions) {
      resolved.versionInfo.rawVersions[entryAgentName] = experimentVersionString;
    }

    // Update the compilation output's agents map
    if (resolved.compilationOutput?.agents) {
      resolved.compilationOutput.agents[entryAgentName] = experimentIR;
    }

    log.info('Applied experiment version override', {
      entryAgentName,
      controlVersion: currentRawVersion,
      experimentVersion: experimentVersionString,
      projectId,
    });

    return true;
  } catch (err) {
    log.error('Failed to apply experiment version override', {
      error: err instanceof Error ? err.message : String(err),
      entryAgentName,
      experimentVersion: experimentVersionString,
      projectId,
    });
    return false;
  }
}

/**
 * Extract an individual AgentIR from a compilation output blob.
 *
 * Resolution order:
 *   1. Exact key match in agents map
 *   2. Case-insensitive match
 *   3. First (and usually only) entry
 */
function extractAgentIR(parsed: CompilationOutput, agentName: string): AgentIR | null {
  if (!parsed.agents || typeof parsed.agents !== 'object') {
    // Legacy: irContent is the AgentIR itself
    return parsed as unknown as AgentIR;
  }

  // 1. Exact match
  if (parsed.agents[agentName]) return parsed.agents[agentName];

  // 2. Case-insensitive match
  const lowerName = agentName.toLowerCase();
  for (const key of Object.keys(parsed.agents)) {
    if (key.toLowerCase() === lowerName) return parsed.agents[key];
  }

  // 3. First entry
  const entries = Object.values(parsed.agents);
  if (entries.length > 0) return entries[0];

  return null;
}

/**
 * Resolve the full agent stack for an experiment group in deployment mode.
 *
 * Runs the complete DeploymentResolver pipeline for the group's deployment,
 * returning a fully resolved ResolvedAgent that replaces the current resolved
 * object in session-factory.
 *
 * Returns null on any failure — caller must skip assignment rather than
 * poison group membership with wrong IR (D-25).
 */
export async function resolveExperimentDeployment(
  group: 'control' | 'experiment',
  experiment: CachedExperiment,
  ctx: { tenantId: string; projectId: string; agentName?: string },
): Promise<ResolvedAgent | null> {
  const deploymentId =
    group === 'control' ? experiment.controlDeploymentId : experiment.experimentDeploymentId;

  if (!deploymentId) {
    log.warn('Experiment deployment ID missing for group', {
      group,
      experimentId: experiment.experimentId,
    });
    return null;
  }

  try {
    const resolver = new DeploymentResolver(getSessionService());
    return await resolver.resolve({
      deploymentId,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      agentName: ctx.agentName,
    });
  } catch (err) {
    log.warn('resolveExperimentDeployment failed', {
      group,
      experimentId: experiment.experimentId,
      deploymentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
