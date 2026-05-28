/**
 * Manifest Generator — builds project.json from project + agent data
 */

import type {
  ProjectManifest,
  ProjectManifestV2,
  ManifestAgent,
  ManifestTool,
  ManifestBehaviorProfile,
  DependencyEdge,
  LayerName,
  ProjectDslFormat,
} from '../types.js';
import {
  agentFilePath,
  assignCollisionSafePath,
  profileFilePath,
  toolFilePath,
} from './folder-builder.js';

export interface ManifestInput {
  projectName: string;
  projectSlug: string;
  projectDescription: string | null;
  exportedBy: string;
  entryAgent: string | null;
  agents: Array<{
    name: string;
    description: string | null;
    ownerId: string | null;
    ownerTeamId: string | null;
    version: string | null;
    systemPromptLibraryRef?: ManifestAgent['systemPromptLibraryRef'];
  }>;
  tools: Array<{
    name: string;
    ownerId: string | null;
  }>;
  profiles?: Array<{
    name: string;
    priority: number;
    whenSummary: string;
    usedBy: string[];
  }>;
  edges: DependencyEdge[];
  dslFormat?: ProjectDslFormat;
  agentPaths?: Record<string, string>;
  toolPaths?: Record<string, string>;
  profilePaths?: Record<string, string>;
}

function resolveProfilePaths(input: ManifestInput): Record<string, string> {
  const resolvedPaths: Record<string, string> = { ...(input.profilePaths ?? {}) };
  const assignedPaths = new Set(Object.values(resolvedPaths));

  for (const profile of input.profiles ?? []) {
    if (resolvedPaths[profile.name]) {
      continue;
    }

    const path = assignCollisionSafePath(profileFilePath(profile.name), assignedPaths);
    assignedPaths.add(path);
    resolvedPaths[profile.name] = path;
  }

  return resolvedPaths;
}

/**
 * Generate a ProjectManifest from project data.
 */
export function generateManifest(input: ManifestInput): ProjectManifest {
  const agentNames = new Set<string>();
  for (const agent of input.agents) {
    if (agentNames.has(agent.name)) {
      throw new Error(`Duplicate agent name in manifest input: "${agent.name}"`);
    }
    agentNames.add(agent.name);
  }

  const agents: Record<string, ManifestAgent> = {};
  for (const agent of input.agents) {
    agents[agent.name] = {
      path: input.agentPaths?.[agent.name] ?? agentFilePath(agent.name),
      owner: agent.ownerId,
      ownerTeam: agent.ownerTeamId,
      description: agent.description,
      version: agent.version,
      ...(agent.systemPromptLibraryRef
        ? { systemPromptLibraryRef: { ...agent.systemPromptLibraryRef } }
        : {}),
    };
  }

  const tools: Record<string, ManifestTool> = {};
  for (const tool of input.tools) {
    tools[tool.name] = {
      path: input.toolPaths?.[tool.name] ?? toolFilePath(tool.name),
      owner: tool.ownerId,
    };
  }

  const agentReferences: Array<{ from: string; to: string; type: 'handoff' | 'delegate' }> = [];
  const toolImports: Array<{ agent: string; source: string; tools: string[] }> = [];

  for (const edge of input.edges) {
    if (edge.type === 'handoff' || edge.type === 'delegate') {
      agentReferences.push({ from: edge.from, to: edge.to, type: edge.type });
    } else if (edge.type === 'tool_import' && edge.sourcePath) {
      toolImports.push({
        agent: edge.from,
        source: edge.sourcePath,
        tools: edge.toolNames ?? [],
      });
    }
  }

  // Build behavior profiles map (optional)
  let behavior_profiles: Record<string, ManifestBehaviorProfile> | undefined;
  if (input.profiles && input.profiles.length > 0) {
    const profilePaths = resolveProfilePaths(input);
    behavior_profiles = {};
    for (const profile of input.profiles) {
      behavior_profiles[profile.name] = {
        name: profile.name,
        path: profilePaths[profile.name],
        priority: profile.priority,
        when_summary: profile.whenSummary,
        used_by: profile.usedBy,
      };
    }
  }

  return {
    name: input.projectName,
    slug: input.projectSlug,
    description: input.projectDescription,
    version: '1.0.0',
    abl_version: '1.0',
    exported_at: new Date().toISOString(),
    exported_by: input.exportedBy,
    entry_agent: input.entryAgent,
    dsl_format: input.dslFormat ?? 'yaml',
    agents,
    tools,
    ...(behavior_profiles ? { behavior_profiles } : {}),
    dependencies: {
      agent_references: agentReferences,
      tool_imports: toolImports,
    },
  };
}

// ─── Manifest v2 ────────────────────────────────────────────────────────────

export interface ManifestInputV2 extends ManifestInput {
  layers: LayerName[];
  entityCounts: Record<string, number>;
  requiredEnvVars: string[];
  requiredConnectors: string[];
  requiredMcpServers: string[];
  requiredAuthProfiles?: Array<{
    name: string;
    authType: string;
    scope: 'tenant' | 'project';
    connector?: string;
    category?: string;
    connectionMode?: 'shared' | 'per_user';
    config: Record<string, unknown>;
    referencedBy: string[];
  }>;
}

/**
 * Generate a v2 ProjectManifest with layer metadata.
 */
export function generateManifestV2(input: ManifestInputV2): ProjectManifestV2 {
  const agentNames = new Set<string>();
  for (const agent of input.agents) {
    if (agentNames.has(agent.name)) {
      throw new Error(`Duplicate agent name in manifest input: "${agent.name}"`);
    }
    agentNames.add(agent.name);
  }

  const agents: Record<string, ManifestAgent> = {};
  for (const agent of input.agents) {
    agents[agent.name] = {
      path: input.agentPaths?.[agent.name] ?? agentFilePath(agent.name),
      owner: agent.ownerId,
      ownerTeam: agent.ownerTeamId,
      description: agent.description,
      version: agent.version,
      ...(agent.systemPromptLibraryRef
        ? { systemPromptLibraryRef: { ...agent.systemPromptLibraryRef } }
        : {}),
    };
  }

  const tools: Record<string, ManifestTool> = {};
  for (const tool of input.tools) {
    tools[tool.name] = {
      path: input.toolPaths?.[tool.name] ?? toolFilePath(tool.name),
      owner: tool.ownerId,
    };
  }

  const behavior_profiles: Record<string, ManifestBehaviorProfile> = {};
  if (input.profiles && input.profiles.length > 0) {
    const profilePaths = resolveProfilePaths(input);
    for (const profile of input.profiles) {
      behavior_profiles[profile.name] = {
        name: profile.name,
        path: profilePaths[profile.name],
        priority: profile.priority,
        when_summary: profile.whenSummary,
        used_by: profile.usedBy,
      };
    }
  }

  return {
    format_version: '2.0',
    name: input.projectName,
    slug: input.projectSlug,
    description: input.projectDescription,
    abl_version: '1.0',
    exported_at: new Date().toISOString(),
    exported_by: input.exportedBy,
    entry_agent: input.entryAgent,
    dsl_format: input.dslFormat ?? 'yaml',
    layers_included: input.layers,
    agents,
    tools,
    behavior_profiles,
    metadata: {
      entity_counts: input.entityCounts ?? {},
      required_env_vars: input.requiredEnvVars ?? [],
      required_connectors: input.requiredConnectors ?? [],
      required_mcp_servers: input.requiredMcpServers ?? [],
      ...(input.requiredAuthProfiles && input.requiredAuthProfiles.length > 0
        ? { required_auth_profiles: input.requiredAuthProfiles }
        : {}),
    },
  };
}
