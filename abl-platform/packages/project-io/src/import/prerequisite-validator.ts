/**
 * Prerequisite Validator — checks that the target environment satisfies
 * requirements declared in a v2 manifest before allowing an import.
 *
 * Validates:
 * - Required environment variables exist
 * - Required connectors are configured
 * - Required MCP servers are present
 * - Required auth profiles are available
 * - Per-layer permissions are held by the importing user
 *
 * Uses an injected context interface (PrereqContext) to avoid coupling
 * to Mongoose models. The caller (route handler) populates the context
 * from database queries.
 */

import type { ProjectManifestV2, LayerName } from '../types.js';

// ── Types ──

export type PrerequisiteSeverity = 'blocking' | 'warning';

export interface PrerequisiteIssue {
  severity: PrerequisiteSeverity;
  category: 'env_var' | 'connector' | 'mcp_server' | 'auth_profile' | 'permission';
  key: string;
  message: string;
  /** Actionable guidance shown in Studio UI */
  remediation: string;
}

export interface PrerequisiteResult {
  /** true if no issues at all */
  satisfied: boolean;
  /** true if no blocking issues (warnings allowed) */
  canProceed: boolean;
  issues: PrerequisiteIssue[];
}

/** Injected context — avoids coupling to Mongoose models */
export interface PrereqContext {
  tenantId: string;
  projectId: string;
  environment: string;
  /** Keys present in EnvironmentVariable collection for this project+env */
  existingEnvVarKeys: Set<string>;
  /** Connector type names present in ConnectorConfig for this tenant */
  existingConnectorTypes: Set<string>;
  /** MCP server names present in MCPServerConfig for this project */
  existingMcpServerNames: Set<string>;
  /** Auth profile names present in AuthProfile for this tenant */
  existingAuthProfileNames: Set<string>;
  /** Permission strings for the importing user */
  userPermissions: string[];
}

// ── Per-layer permission mapping ──

const LAYER_PERMISSION_MAP: Record<string, string> = {
  core: 'project:import',
  connections: 'connector:write',
  guardrails: 'guardrail:write',
  workflows: 'workflow:write',
  evals: 'eval:write',
  search: 'search:write',
  channels: 'channel:write',
  vocabulary: 'vocabulary:write',
};

// ── Validator ──

/**
 * Validate that required env vars, connectors, MCP servers, auth profiles,
 * and per-layer permissions exist in the target environment.
 *
 * Returns a result indicating whether the import can proceed. Blocking issues
 * prevent import; warnings allow it but flag potential degradation.
 */
export function validateImportPrerequisites(
  manifest: ProjectManifestV2,
  ctx: PrereqContext,
): PrerequisiteResult {
  const issues: PrerequisiteIssue[] = [];

  // 1. Environment variables
  for (const varName of manifest.metadata.required_env_vars) {
    if (!ctx.existingEnvVarKeys.has(varName)) {
      issues.push({
        severity: 'blocking',
        category: 'env_var',
        key: varName,
        message: `Required environment variable "${varName}" is not set`,
        remediation: `Set "${varName}" at Settings > Environment Variables > ${ctx.environment}`,
      });
    }
  }

  // 2. Connectors
  for (const connType of manifest.metadata.required_connectors) {
    if (!ctx.existingConnectorTypes.has(connType)) {
      issues.push({
        severity: 'warning',
        category: 'connector',
        key: connType,
        message: `Connector "${connType}" is not configured in this environment`,
        remediation: `Configure "${connType}" at Settings > Connectors > Add Connector`,
      });
    }
  }

  // 3. MCP Servers
  for (const serverName of manifest.metadata.required_mcp_servers) {
    if (!ctx.existingMcpServerNames.has(serverName)) {
      issues.push({
        severity: 'warning',
        category: 'mcp_server',
        key: serverName,
        message: `MCP server "${serverName}" is not configured in this project`,
        remediation: `Add MCP server "${serverName}" at Settings > MCP Servers > Add Server`,
      });
    }
  }

  // 4. Auth Profiles
  const requiredProfiles = manifest.metadata.required_auth_profiles ?? [];
  for (const profile of requiredProfiles) {
    if (!ctx.existingAuthProfileNames.has(profile.name)) {
      issues.push({
        severity: 'blocking',
        category: 'auth_profile',
        key: profile.name,
        message:
          `Auth profile "${profile.name}" (${profile.authType}) ` +
          `is not available — referenced by: ${profile.referencedBy.join(', ')}`,
        remediation:
          `Create auth profile "${profile.name}" at Settings > Auth Profiles, ` +
          `or re-map during import`,
      });
    }
  }

  // 5. Per-layer permission check
  for (const layer of manifest.layers_included) {
    const requiredPerm = LAYER_PERMISSION_MAP[layer];
    if (requiredPerm && !ctx.userPermissions.includes(requiredPerm)) {
      // Check wildcard permissions
      const [resource] = requiredPerm.split(':');
      const hasWildcard =
        ctx.userPermissions.includes('*:*') || ctx.userPermissions.includes(`${resource}:*`);
      if (!hasWildcard) {
        issues.push({
          severity: 'blocking',
          category: 'permission',
          key: requiredPerm,
          message: `Missing permission "${requiredPerm}" required to import the ${layer} layer`,
          remediation: `Request the "${requiredPerm}" permission from your administrator`,
        });
      }
    }
  }

  const hasBlocking = issues.some((i) => i.severity === 'blocking');
  return {
    satisfied: issues.length === 0,
    canProceed: !hasBlocking,
    issues,
  };
}
