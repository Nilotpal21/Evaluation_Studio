/**
 * Auth Requirement Collector
 *
 * Post-compilation pass that walks all agents/tools in compiled IR,
 * collects tools with auth_profile_ref + consent_mode, and deduplicates
 * by auth target context (merging scopes across tools that share the same
 * resolved consent boundary).
 */

import type { AuthRequirementIR, ToolDefinition } from './schema.js';

export type AuthRequirementSourceTool = Pick<
  ToolDefinition,
  | 'name'
  | 'auth_profile_ref'
  | 'variable_namespace_ids'
  | 'connection_mode'
  | 'consent_mode'
  | 'connector_binding'
  | 'http_binding'
>;

export interface AuthRequirementSourceAgent {
  tools?: AuthRequirementSourceTool[];
}

export interface AuthRequirementSource {
  agents: Record<string, AuthRequirementSourceAgent>;
}

export interface CollectAuthRequirementsOptions {
  /**
   * When provided, limit collection to the specified agents.
   * Missing agent names are ignored so callers can safely scope by runtime state.
   */
  agentNames?: readonly string[];
}

/**
 * Collect auth requirements from tools in the compiled IR.
 * By default this walks all agents; callers can optionally scope collection to
 * a subset of agent names (for example, the currently active runtime agent).
 * Deduplicates by auth_profile_ref + connection_mode. For templated refs, the
 * variable namespace context is also part of the key so we do not merge tools
 * that may resolve to different auth profiles at runtime.
 */
export function collectAuthRequirements(
  output: AuthRequirementSource,
  options: CollectAuthRequirementsOptions = {},
): AuthRequirementIR[] {
  const requirementMap = new Map<
    string,
    {
      connector: string;
      auth_profile_ref: string;
      variable_namespace_ids?: Set<string>;
      scopes: Set<string>;
      connection_mode: 'per_user' | 'shared';
      consent_mode: 'preflight' | 'inline';
    }
  >();

  for (const agentIR of selectAgents(output, options)) {
    for (const tool of agentIR.tools ?? []) {
      collectFromTool(tool, requirementMap);
    }
  }

  return Array.from(requirementMap.values())
    .sort((a, b) => {
      const refCompare = a.auth_profile_ref.localeCompare(b.auth_profile_ref);
      if (refCompare !== 0) {
        return refCompare;
      }

      const modeCompare = a.connection_mode.localeCompare(b.connection_mode);
      if (modeCompare !== 0) {
        return modeCompare;
      }

      const existingNamespaces = normalizeVariableNamespaceIds(
        a.variable_namespace_ids ? Array.from(a.variable_namespace_ids) : undefined,
      ).join(',');
      const incomingNamespaces = normalizeVariableNamespaceIds(
        b.variable_namespace_ids ? Array.from(b.variable_namespace_ids) : undefined,
      ).join(',');
      return existingNamespaces.localeCompare(incomingNamespaces);
    })
    .map((entry) => ({
      connector: entry.connector,
      auth_profile_ref: entry.auth_profile_ref,
      ...(entry.variable_namespace_ids && entry.variable_namespace_ids.size > 0
        ? { variable_namespace_ids: Array.from(entry.variable_namespace_ids).sort() }
        : {}),
      scopes: entry.scopes.size > 0 ? Array.from(entry.scopes).sort() : undefined,
      connection_mode: entry.connection_mode,
      consent_mode: entry.consent_mode,
    }));
}

function selectAgents(
  output: AuthRequirementSource,
  options: CollectAuthRequirementsOptions,
): AuthRequirementSourceAgent[] {
  if (!options.agentNames || options.agentNames.length === 0) {
    return Object.values(output.agents);
  }

  const uniqueAgentNames = new Set(options.agentNames);
  const selectedAgents: AuthRequirementSourceAgent[] = [];
  for (const agentName of uniqueAgentNames) {
    const agent = output.agents[agentName];
    if (agent) {
      selectedAgents.push(agent);
    }
  }
  return selectedAgents;
}

function normalizeVariableNamespaceIds(variableNamespaceIds?: readonly string[]): string[] {
  if (!variableNamespaceIds || variableNamespaceIds.length === 0) {
    return [];
  }

  return Array.from(
    new Set(variableNamespaceIds.filter((namespaceId): namespaceId is string => !!namespaceId)),
  ).sort((a, b) => a.localeCompare(b));
}

function buildRequirementDedupKey(params: {
  authProfileRef: string;
  connectionMode: 'per_user' | 'shared';
  variableNamespaceIds?: readonly string[];
}): string {
  const modePart = `mode:${params.connectionMode}`;
  if (!params.authProfileRef.includes('{{')) {
    return `ref:${params.authProfileRef}|${modePart}`;
  }

  const normalizedNamespaces = normalizeVariableNamespaceIds(params.variableNamespaceIds);
  const namespacePart =
    normalizedNamespaces.length > 0 ? normalizedNamespaces.join(',') : '__unscoped__';
  return `ref:${params.authProfileRef}|ns:${namespacePart}|${modePart}`;
}

export interface MergeableAuthRequirement {
  connector: string;
  auth_profile_ref: string;
  variable_namespace_ids?: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
  connection_mode: 'per_user' | 'shared';
  consent_mode: 'preflight' | 'inline';
}

/**
 * Merge two requirement entries for the same deduplication context.
 * Rules:
 * - scopes: set union
 * - connection_mode: preserved from the merged entries (keys ensure matching mode)
 * - consent_mode: preflight wins
 * - connector: deterministic lexical pick to avoid traversal-order drift
 */
export function mergeAuthRequirement(
  existing: MergeableAuthRequirement,
  incoming: MergeableAuthRequirement,
): {
  connector: string;
  auth_profile_ref: string;
  variable_namespace_ids?: Set<string>;
  scopes: Set<string>;
  connection_mode: 'per_user' | 'shared';
  consent_mode: 'preflight' | 'inline';
} {
  const mergedVariableNamespaces = new Set<string>(existing.variable_namespace_ids ?? []);
  for (const namespaceId of incoming.variable_namespace_ids ?? []) {
    mergedVariableNamespaces.add(namespaceId);
  }

  const mergedScopes = new Set<string>(existing.scopes);
  for (const scope of incoming.scopes) {
    mergedScopes.add(scope);
  }

  return {
    connector: [existing.connector, incoming.connector].sort((a, b) => a.localeCompare(b))[0],
    auth_profile_ref: existing.auth_profile_ref,
    ...(mergedVariableNamespaces.size > 0
      ? { variable_namespace_ids: mergedVariableNamespaces }
      : {}),
    scopes: mergedScopes,
    connection_mode:
      existing.connection_mode === 'per_user' || incoming.connection_mode === 'per_user'
        ? 'per_user'
        : 'shared',
    consent_mode:
      existing.consent_mode === 'preflight' || incoming.consent_mode === 'preflight'
        ? 'preflight'
        : 'inline',
  };
}

function collectFromTool(
  tool: AuthRequirementSourceTool,
  map: Map<
    string,
    {
      connector: string;
      auth_profile_ref: string;
      variable_namespace_ids?: Set<string>;
      scopes: Set<string>;
      connection_mode: 'per_user' | 'shared';
      consent_mode: 'preflight' | 'inline';
    }
  >,
): void {
  // Only collect tools that have an auth profile ref and a consent mode
  if (!tool.auth_profile_ref || !tool.consent_mode) {
    return;
  }

  const connectionMode = tool.connection_mode ?? 'per_user';
  const key = buildRequirementDedupKey({
    authProfileRef: tool.auth_profile_ref,
    connectionMode,
    variableNamespaceIds: tool.variable_namespace_ids,
  });
  const existing = map.get(key);

  // Derive connector name from the tool name or auth profile ref
  const connector = deriveConnectorName(tool);

  // Extract scopes from HTTP binding if present
  const scopes = extractScopes(tool);

  if (existing) {
    const merged = mergeAuthRequirement(existing, {
      connector,
      auth_profile_ref: tool.auth_profile_ref,
      variable_namespace_ids:
        tool.variable_namespace_ids && tool.variable_namespace_ids.length > 0
          ? new Set(tool.variable_namespace_ids)
          : undefined,
      scopes: new Set(scopes),
      connection_mode: connectionMode,
      consent_mode: tool.consent_mode,
    });
    existing.connector = merged.connector;
    existing.variable_namespace_ids = merged.variable_namespace_ids;
    existing.scopes = merged.scopes;
    existing.connection_mode = merged.connection_mode;
    existing.consent_mode = merged.consent_mode;
  } else {
    map.set(key, {
      connector,
      auth_profile_ref: tool.auth_profile_ref,
      variable_namespace_ids:
        tool.variable_namespace_ids && tool.variable_namespace_ids.length > 0
          ? new Set(tool.variable_namespace_ids)
          : undefined,
      scopes: new Set(scopes),
      connection_mode: connectionMode,
      consent_mode: tool.consent_mode,
    });
  }
}

/**
 * Derive a connector name from the tool. Uses the auth profile ref as the
 * connector identifier (the profile name is the logical connector identity).
 */
function deriveConnectorName(tool: AuthRequirementSourceTool): string {
  // Use connector_binding connector name if available, otherwise use the auth profile ref
  if (tool.connector_binding?.connector) {
    return tool.connector_binding.connector;
  }
  return tool.auth_profile_ref ?? tool.name;
}

/**
 * Extract OAuth scopes from the tool's HTTP binding auth config.
 */
function extractScopes(tool: AuthRequirementSourceTool): string[] {
  if (tool.http_binding?.auth?.config?.oauth?.scopes) {
    return tool.http_binding.auth.config.oauth.scopes;
  }
  return [];
}
