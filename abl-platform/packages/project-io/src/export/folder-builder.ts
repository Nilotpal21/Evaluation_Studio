/**
 * Folder Builder — maps project data to the canonical export folder structure
 *
 * Canonical structure:
 *   <project-slug>/
 *     project.json
 *     abl.lock
 *     agents/
 *       supervisor.agent.abl
 *       booking_manager.agent.abl
 *     tools/
 *       hotels-api.tools.abl
 *     behavior_profiles/
 *       formal_tone.behavior_profile.abl
 *     config/
 *       models.json
 *       environment.json
 *     locales/
 *       en/
 *         booking_agent.json
 *         _shared.json
 *     deployments/
 *       dev.deployment.json
 */

export interface AgentFileEntry {
  name: string;
  dslContent: string;
  isSupervisor: boolean;
  format?: AgentArchiveFormat;
}

import type { ToolFileEntry } from '../types.js';
import type { AgentArchiveFormat } from '../types.js';

const MAX_FILENAME_COLLISIONS = 1000;

interface AssignedPathSet {
  has(path: string): boolean;
}

function splitPathAndExtension(path: string): { basePath: string; extension: string } {
  const lastDot = path.indexOf('.', path.lastIndexOf('/'));
  if (lastDot === -1) {
    return { basePath: path, extension: '' };
  }

  return {
    basePath: path.slice(0, lastDot),
    extension: path.slice(lastDot),
  };
}

export function assignCollisionSafePath(path: string, assignedPaths: AssignedPathSet): string {
  if (!assignedPaths.has(path)) {
    return path;
  }

  const { basePath, extension } = splitPathAndExtension(path);

  for (let suffix = 2; suffix <= MAX_FILENAME_COLLISIONS; suffix++) {
    const candidate = `${basePath}_${suffix}${extension}`;
    if (!assignedPaths.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Too many filename collisions for path "${path}"`);
}

/**
 * Build file path for an agent within the export folder structure.
 *
 * Supervisors get placed at the root `agents/` level.
 * Sub-agents are flat in `agents/` (not nested).
 */
export function agentFilePath(agentName: string, dslFormat: AgentArchiveFormat = 'yaml'): string {
  // Normalize to lowercase with underscores for filesystem safety
  const filename = agentName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `agents/${filename}.agent.${dslFormat === 'yaml' ? 'yaml' : 'abl'}`;
}

/**
 * Build file path for a tool file.
 */
export function toolFilePath(toolName: string): string {
  const filename = toolName.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
  return `tools/${filename}.tools.abl`;
}

/**
 * Build file path for a behavior profile file.
 */
export function profileFilePath(profileName: string): string {
  const filename = profileName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `behavior_profiles/${filename}.behavior_profile.abl`;
}

/**
 * Build the complete file map for an export.
 *
 * @returns Map of relativePath → content for all files in the export
 */
export function buildFileMap(
  agents: AgentFileEntry[],
  tools: ToolFileEntry[],
  configs: Map<string, string>,
  deployments: Map<string, string>,
  locales?: Map<string, string>,
  dslFormat: AgentArchiveFormat = 'yaml',
  profiles?: Map<string, string>,
): Map<string, string> {
  const files = new Map<string, string>();

  for (const agent of agents) {
    const format = agent.format ?? dslFormat;
    const path = assignCollisionSafePath(agentFilePath(agent.name, format), files);
    files.set(path, agent.dslContent);
  }

  for (const tool of tools) {
    const path = toolFilePath(tool.name);
    files.set(path, tool.content);
  }

  for (const [name, content] of configs) {
    files.set(`config/${name}`, content);
  }

  for (const [name, content] of deployments) {
    files.set(`deployments/${name}`, content);
  }

  if (locales) {
    for (const [path, content] of locales) {
      // Locale paths are already prefixed with locale code (e.g., "en/agent_name.json")
      files.set(`locales/${path}`, content);
    }
  }

  if (profiles) {
    for (const [name, content] of profiles) {
      const path = assignCollisionSafePath(profileFilePath(name), files);
      files.set(path, content);
    }
  }

  return files;
}
