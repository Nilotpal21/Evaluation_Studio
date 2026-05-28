/**
 * Shared module types for runtime module resolution and provenance tracking.
 *
 * These types are used by the deployment resolver to merge mounted module
 * agents and tools into the runtime's resolved agent/tool sets, and to
 * track provenance through session state and trace events.
 */

import type { AgentIR } from '@abl/compiler';
import type { ToolDefinitionLocal } from '@agent-platform/shared/tools';

/**
 * Provenance metadata attached to agents/tools sourced from a module.
 * Used to trace runtime entities back to their originating module.
 */
export interface ModuleProvenance {
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  sourceAgentName: string;
}

/** AgentIR extended with optional module provenance metadata */
export type ResolvedAgentIR = AgentIR & {
  _moduleProvenance?: ModuleProvenance;
};

/** ToolDefinition extended with optional module provenance metadata */
export type ResolvedToolDefinition = ToolDefinitionLocal & {
  _moduleProvenance?: Omit<ModuleProvenance, 'sourceAgentName'> & {
    sourceToolName: string;
  };
};

/**
 * Entry in the dependencies array of a deployment module snapshot payload.
 * Records which module releases were resolved at deployment build time.
 */
export interface DeploymentModuleDependency {
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  version: string;
  configOverrides?: Record<string, string>;
}

/**
 * Mounted agent entry in the deployment snapshot.
 * Contains the alias-rewritten AgentIR plus provenance metadata.
 */
export interface MountedAgentEntry {
  sourceAgentName: string;
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  ir: AgentIR;
}

/**
 * Mounted tool entry in the deployment snapshot.
 * Contains the alias-rewritten ToolDefinitionLocal plus provenance metadata.
 */
export interface MountedToolEntry {
  sourceToolName: string;
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  definition: ToolDefinitionLocal;
}

/**
 * The JSON payload stored (gzip-compressed) in DeploymentModuleSnapshot.compressedPayload.
 * Contains all resolved module dependencies and their mounted agents/tools
 * with alias-rewritten IR, ready for runtime consumption.
 */
export interface DeploymentModuleSnapshotPayload {
  dependencies: DeploymentModuleDependency[];
  mountedAgents: Record<string, MountedAgentEntry>;
  mountedTools: Record<string, MountedToolEntry>;
  snapshotHash: string;
}
