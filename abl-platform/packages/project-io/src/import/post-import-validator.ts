/**
 * Post-Import Validator — scans a project after import and reports
 * missing provisioning requirements.
 *
 * Reports:
 * - Missing environment variables (referenced in DSL but not provisioned)
 * - Connectors needing credentials
 * - MCP servers needing auth
 * - Guardrail providers not configured
 */

import type { LayerName } from '../types.js';
import { BUILTIN_GUARDRAIL_PROVIDER_NAMES } from '@agent-platform/database/constants/guardrail-adapters';

// ─── Types ──────────────────────────────────────────────────────────────

export interface PostImportReport {
  status: 'ready' | 'imported_with_warnings' | 'action_required';
  provisioning_required: {
    env_vars: string[];
    connectors_needing_credentials: string[];
    mcp_servers_needing_auth: string[];
    auth_profiles: Array<{
      name: string;
      connectionMode?: 'shared' | 'per_user';
    }>;
  };
  warnings: string[];
  layer_summary: Record<string, { imported: number; skipped: number }>;
}

/** Adapter for querying project state after import */
export interface PostImportDbAdapter {
  /** Get environment variables defined for this project */
  getProjectEnvVars(
    projectId: string,
    tenantId: string,
  ): Promise<Array<{ key: string; hasValue: boolean }>>;

  /** Get connector connections for this project */
  getProjectConnectors(
    projectId: string,
    tenantId: string,
  ): Promise<Array<{ name: string; hasCredentials: boolean }>>;

  /** Get MCP server configs for this project */
  getProjectMCPServers(
    projectId: string,
    tenantId: string,
  ): Promise<Array<{ serverName: string; hasAuth: boolean }>>;

  /** Get guardrail policies for this project */
  getProjectGuardrails(
    projectId: string,
    tenantId: string,
  ): Promise<Array<{ name: string; providerNames: string[] }>>;

  /** Get tenant guardrail provider configs */
  getTenantGuardrailProviders(tenantId: string): Promise<Array<{ providerName: string }>>;

  /** Get auth profiles available in this project scope */
  getProjectAuthProfiles(
    projectId: string,
    tenantId: string,
  ): Promise<Array<{ name: string; authType: string }>>;
}

/** Input describing what was imported */
export interface PostImportInput {
  projectId: string;
  tenantId: string;
  importedLayers: LayerName[];
  /** Env var keys referenced in DSL (extracted during import validation) */
  referencedEnvVars: string[];
  /** Connector names referenced in DSL */
  referencedConnectors: string[];
  /** MCP server names referenced in DSL */
  referencedMCPServers: string[];
  /** Auth profile names referenced in DSL (from extractAuthProfileReferences) */
  referencedAuthProfiles?: string[];
  /** Per-layer entity counts */
  layerCounts: Record<string, { imported: number; skipped: number }>;
}

// ─── Post-Import Validator ──────────────────────────────────────────────

/**
 * Validate a project after import and generate a provisioning report.
 *
 * This is a read-only scan — it doesn't modify any data.
 */
export async function validatePostImport(
  input: PostImportInput,
  db: PostImportDbAdapter,
): Promise<PostImportReport> {
  const warnings: string[] = [];
  const missingEnvVars: string[] = [];
  const connectorsNeedingCreds: string[] = [];
  const mcpServersNeedingAuth: string[] = [];
  const missingAuthProfiles: Array<{ name: string; connectionMode?: 'shared' | 'per_user' }> = [];

  // Check environment variables
  if (input.referencedEnvVars.length > 0) {
    const envVars = await db.getProjectEnvVars(input.projectId, input.tenantId);
    const definedKeys = new Set(envVars.map((v) => v.key));
    const valuelessKeys = new Set(envVars.filter((v) => !v.hasValue).map((v) => v.key));

    for (const key of input.referencedEnvVars) {
      if (!definedKeys.has(key)) {
        missingEnvVars.push(key);
      } else if (valuelessKeys.has(key)) {
        warnings.push(`Environment variable "${key}" is defined but has no value`);
      }
    }
  }

  // Check connectors
  if (input.referencedConnectors.length > 0) {
    const connectors = await db.getProjectConnectors(input.projectId, input.tenantId);
    const connectorMap = new Map(connectors.map((c) => [c.name, c.hasCredentials]));

    for (const name of input.referencedConnectors) {
      if (!connectorMap.has(name)) {
        connectorsNeedingCreds.push(name);
      } else if (!connectorMap.get(name)) {
        connectorsNeedingCreds.push(name);
        warnings.push(`Connector "${name}" exists but needs credentials`);
      }
    }
  }

  // Check MCP servers
  if (input.referencedMCPServers.length > 0) {
    const servers = await db.getProjectMCPServers(input.projectId, input.tenantId);
    const serverMap = new Map(servers.map((s) => [s.serverName, s.hasAuth]));

    for (const name of input.referencedMCPServers) {
      if (!serverMap.has(name)) {
        mcpServersNeedingAuth.push(name);
      } else if (!serverMap.get(name)) {
        mcpServersNeedingAuth.push(name);
        warnings.push(`MCP server "${name}" exists but needs authentication`);
      }
    }
  }

  // Check guardrail providers
  if (input.importedLayers.includes('guardrails')) {
    const policies = await db.getProjectGuardrails(input.projectId, input.tenantId);
    const tenantProviders = await db.getTenantGuardrailProviders(input.tenantId);
    const configuredProviders = new Set([
      ...tenantProviders.map((p) => p.providerName),
      ...BUILTIN_GUARDRAIL_PROVIDER_NAMES,
    ]);

    for (const policy of policies) {
      for (const providerName of policy.providerNames) {
        if (configuredProviders.has(providerName)) {
          continue;
        }
        warnings.push(
          `Guardrail "${policy.name}" references provider "${providerName}" ` +
            'which is not configured in this tenant',
        );
      }
    }
  }

  // Check auth profiles
  if (input.referencedAuthProfiles && input.referencedAuthProfiles.length > 0) {
    const authProfiles = await db.getProjectAuthProfiles(input.projectId, input.tenantId);
    const availableNames = new Set(authProfiles.map((p) => p.name));

    for (const name of input.referencedAuthProfiles) {
      if (!availableNames.has(name)) {
        missingAuthProfiles.push({ name });
      }
    }
  }

  // Determine overall status
  const hasActionRequired =
    missingEnvVars.length > 0 ||
    connectorsNeedingCreds.length > 0 ||
    mcpServersNeedingAuth.length > 0 ||
    missingAuthProfiles.length > 0;

  const status: PostImportReport['status'] = hasActionRequired
    ? 'action_required'
    : warnings.length > 0
      ? 'imported_with_warnings'
      : 'ready';

  return {
    status,
    provisioning_required: {
      env_vars: missingEnvVars,
      connectors_needing_credentials: connectorsNeedingCreds,
      mcp_servers_needing_auth: mcpServersNeedingAuth,
      auth_profiles: missingAuthProfiles,
    },
    warnings,
    layer_summary: input.layerCounts,
  };
}
