/**
 * Module Contract Extractor
 *
 * Extracts the contract from a module's agents and tools DSL content.
 * The contract describes what the module provides (agents, tools) and
 * what it requires (env vars, auth profiles, connectors, MCP servers,
 * config keys, runtime secrets). Reuses existing scanner utilities from the export layer.
 */

import type { ModuleReleaseContract } from '@agent-platform/database/models';
import {
  convertStandaloneToolDSL,
  parseDslNestedBlock,
  parseDslProperties,
  parseSignatureLine,
} from '@agent-platform/shared/tools';
import {
  extractEnvVarReferences,
  extractSecretReferences,
  extractAuthProfileReferences,
  extractConnectorReferences,
  extractMcpServerReferences,
} from '../export/env-var-scanner.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('module-contract');

// ─── Input Types ─────────────────────────────────────────────────────────

export interface ContractAgentInput {
  name: string;
  description?: string | null;
  dslContent: string;
  compiledIR?: Record<string, unknown>; // compiled AgentIR for metadata extraction
}

export interface ContractToolInput {
  name: string;
  toolType: string;
  dslContent: string;
  definition?: Record<string, unknown>; // materialized tool definition
}

export interface ContractProfileInput {
  name: string;
  dslContent: string;
}

interface ContractAgentIRShape {
  execution?: { mode?: string };
  tools?: Array<{ name?: string }>;
  coordination?: {
    handoffs?: Array<{ to?: string }>;
    delegates?: Array<{ agent?: string }>;
  };
  gather?: { fields?: unknown[] };
  flow?: unknown;
}

interface ContractToolDefinitionShape {
  description?: string;
  http_binding?: {
    url?: string;
    method?: string;
  };
  auth_profile_ref?: string;
}

// ─── Regex patterns ──────────────────────────────────────────────────────

/** Matches {{config.KEY}} template references */
const CONFIG_REF_RE = /\{\{config\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Matches {{secrets.KEY}} template references — runtime secrets resolved by tool scope */
const SECRET_REF_RE = /\{\{secrets\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

const TOOL_AUTH_TYPES_WITH_IMPLICIT_SECRETS = new Set([
  'api_key',
  'bearer',
  'oauth2_client',
  'searchai',
]);

// ─── Main extractor ──────────────────────────────────────────────────────

/**
 * Extract a ModuleReleaseContract from the module's agents and tools.
 *
 * Scans DSL content for:
 * - Provided agents and tools (from the inputs directly)
 * - Required env vars ({{env.KEY}} patterns)
 * - Required auth profiles (AUTH: directives)
 * - Required connectors (CONNECTOR: directives)
 * - Required MCP servers (MCP_SERVER: directives)
 * - Required config keys ({{config.KEY}} patterns)
 * - Required runtime secrets (tool-scoped {{secrets.KEY}} patterns)
 */
export function extractModuleContract(
  agents: ContractAgentInput[],
  tools: ContractToolInput[],
  profiles: ContractProfileInput[] = [],
): ModuleReleaseContract {
  const envVarSet = new Set<string>();
  const authProfileMap = new Map<string, string[]>(); // profileName → referencedBy agents
  const connectorSet = new Set<string>();
  const mcpServerSet = new Set<string>();
  const configKeySet = new Set<string>();
  const secretMap = new Map<
    string,
    { key: string; referencedBy: Set<string>; toolName?: string }
  >();
  const warnings: Array<{ code: string; message: string }> = [];

  const addSecretReference = (key: string, referencedBy: string, toolName?: string) => {
    const mapKey = `${key}:${toolName ?? ''}`;
    const existing = secretMap.get(mapKey);
    if (existing) {
      existing.referencedBy.add(referencedBy);
      return;
    }

    secretMap.set(mapKey, {
      key,
      referencedBy: new Set([referencedBy]),
      ...(toolName ? { toolName } : {}),
    });
  };

  const warnUnsupportedSecretReference = (key: string, referencedBy: string) => {
    warnings.push({
      code: 'UNSCOPED_SECRET_REFERENCE',
      message: `Runtime secret "${key}" referenced by "${referencedBy}" is not tool-scoped and cannot be validated during deployment. Move it into a tool binding or model it as an environment variable, config variable, or auth profile.`,
    });
  };

  const collectSecretTemplateReferences = (content: string): string[] => [
    ...new Set([...extractSecretReferences(content), ...extractSecretConfigReferences(content)]),
  ];

  // ── Scan agents ──────────────────────────────────────────────────────

  for (const agent of agents) {
    // Env vars
    for (const ref of extractEnvVarReferences(agent.dslContent)) {
      envVarSet.add(ref);
    }
    // Agent-level secrets have no runtime tool scope, so they are warnings only.
    for (const ref of collectSecretTemplateReferences(agent.dslContent)) {
      warnUnsupportedSecretReference(ref, agent.name);
    }
    // Auth profiles
    for (const ref of extractAuthProfileReferences(agent.dslContent)) {
      if (!authProfileMap.has(ref)) authProfileMap.set(ref, []);
      authProfileMap.get(ref)!.push(agent.name);
    }
    // Config keys
    for (const ref of extractConfigReferences(agent.dslContent)) {
      configKeySet.add(ref);
    }
  }

  // ── Scan tools ───────────────────────────────────────────────────────

  for (const tool of tools) {
    // Env vars
    for (const ref of extractEnvVarReferences(tool.dslContent)) {
      envVarSet.add(ref);
    }
    // Runtime secrets
    for (const ref of collectSecretTemplateReferences(tool.dslContent)) {
      addSecretReference(ref, `tool:${tool.name}`, tool.name);
    }
    for (const ref of extractImplicitAuthFallbackSecrets(tool.dslContent, tool.name)) {
      addSecretReference(ref, `tool:${tool.name}`, tool.name);
    }
    // Auth profiles
    for (const ref of extractAuthProfileReferences(tool.dslContent)) {
      if (!authProfileMap.has(ref)) authProfileMap.set(ref, []);
      authProfileMap.get(ref)!.push(`tool:${tool.name}`);
    }
    // Connectors
    for (const ref of extractConnectorReferences(tool.dslContent)) {
      connectorSet.add(ref);
    }
    // MCP servers
    for (const ref of extractMcpServerReferences(tool.dslContent)) {
      mcpServerSet.add(ref);
    }
    // Config keys
    for (const ref of extractConfigReferences(tool.dslContent)) {
      configKeySet.add(ref);
    }
  }

  // ── Scan behavior profiles ────────────────────────────────────────────

  for (const profile of profiles) {
    for (const ref of extractEnvVarReferences(profile.dslContent)) {
      envVarSet.add(ref);
    }
    for (const ref of collectSecretTemplateReferences(profile.dslContent)) {
      warnUnsupportedSecretReference(ref, `profile:${profile.name}`);
    }
    for (const ref of extractConfigReferences(profile.dslContent)) {
      configKeySet.add(ref);
    }
  }

  // ── Build contract ───────────────────────────────────────────────────

  const providedAgents = agents.map((a) => {
    const ir = a.compiledIR as ContractAgentIRShape | undefined;
    return {
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      // Enriched fields from compiled IR
      ...(ir?.execution?.mode ? { mode: ir.execution.mode } : {}),
      ...(ir?.tools?.length
        ? { tools: ir.tools.map((t) => t.name).filter((name): name is string => !!name) }
        : {}),
      ...(ir?.coordination?.handoffs?.length
        ? {
            handoffTargets: ir.coordination.handoffs
              .map((h) => h.to)
              .filter((target): target is string => !!target),
          }
        : {}),
      ...(ir?.coordination?.delegates?.length
        ? {
            delegateTargets: ir.coordination.delegates
              .map((d) => d.agent)
              .filter((target): target is string => !!target),
          }
        : {}),
      ...(ir?.gather?.fields?.length ? { hasGather: true } : {}),
      ...(ir?.flow ? { hasFlow: true } : {}),
    };
  });

  const providedBehaviorProfiles = profiles.map((profile) => ({
    name: profile.name,
  }));

  const providedTools = tools.map((t) => {
    const def = t.definition as ContractToolDefinitionShape | undefined;
    const parsed = parseToolSignature(t.dslContent);
    const toolEnvVars = [...t.dslContent.matchAll(/\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map(
      (m) => m[1],
    );

    return {
      name: t.name,
      toolType: t.toolType,
      // Enriched fields from definition + DSL
      ...(def?.description || parsed?.description
        ? { description: def?.description ?? parsed?.description }
        : {}),
      ...(parsed?.parameters?.length
        ? {
            parameters: parsed.parameters.map(
              (p: { name: string; type?: string; required?: boolean; description?: string }) => ({
                name: p.name,
                type: p.type ?? 'string',
                required: p.required !== false,
                ...(p.description ? { description: p.description } : {}),
              }),
            ),
          }
        : {}),
      ...(parsed?.returnType ? { returnType: parsed.returnType } : {}),
      ...(def?.http_binding?.url ? { endpoint: def.http_binding.url } : {}),
      ...(def?.http_binding?.method ? { method: def.http_binding.method } : {}),
      ...(def?.auth_profile_ref ? { authProfileRef: def.auth_profile_ref } : {}),
      ...(toolEnvVars.length > 0 ? { requiredEnvVars: toolEnvVars } : {}),
    };
  });

  const requiredEnvVars = [...envVarSet].sort().map((name) => ({ name }));

  const requiredAuthProfiles = [...authProfileMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, referencedBy]) => ({
      name,
      referencedBy: [...new Set(referencedBy)].sort(),
    }));

  const requiredConnectors = [...connectorSet].sort().map((name) => ({ name }));

  const requiredMcpServers = [...mcpServerSet].sort().map((name) => ({ name }));

  const requiredConfigKeys = [...configKeySet].sort().map((key) => ({
    key,
    isSecret: false,
  }));

  const requiredSecrets = [...secretMap.values()]
    .sort((a, b) => {
      const keyCompare = a.key.localeCompare(b.key);
      if (keyCompare !== 0) return keyCompare;
      return (a.toolName ?? '').localeCompare(b.toolName ?? '');
    })
    .map((secret) => ({
      key: secret.key,
      referencedBy: [...secret.referencedBy].sort(),
      ...(secret.toolName ? { toolName: secret.toolName } : {}),
    }));

  return {
    providedAgents,
    ...(providedBehaviorProfiles.length > 0 ? { providedBehaviorProfiles } : {}),
    providedTools,
    requiredConfigKeys,
    requiredEnvVars,
    requiredSecrets,
    requiredAuthProfiles,
    requiredConnectors,
    requiredMcpServers,
    warnings,
  };
}

// ─── Helper extractors ──────────────────────────────────────────────────

/**
 * Parse tool signature and DSL properties to extract parameter info, return type, and description.
 * Returns null if no meaningful data could be extracted.
 */
function parseToolSignature(dslContent: string): {
  parameters: Array<{ name: string; type: string; required: boolean; description?: string }>;
  returnType?: string;
  description?: string;
} | null {
  try {
    const sig = parseSignatureLine(dslContent);
    const props = parseDslProperties(dslContent);

    const parameters = sig.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
    }));

    // returnType defaults to 'object' in parseSignatureLine; only include if the DSL
    // actually contained a -> declaration (non-default)
    const hasExplicitReturn = dslContent.split('\n')[0]?.includes('->') ?? false;
    const returnType = hasExplicitReturn ? sig.returnType : undefined;

    const description = props.description || undefined;

    if (parameters.length === 0 && !returnType && !description) {
      return null;
    }

    return {
      parameters,
      ...(returnType ? { returnType } : {}),
      ...(description ? { description } : {}),
    };
  } catch (err) {
    log.warn('Failed to parse module tool signature for contract extraction', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Extract {{config.KEY}} references from content */
function extractConfigReferences(content: string): string[] {
  const refs = new Set<string>();
  const re = new RegExp(CONFIG_REF_RE.source, CONFIG_REF_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.add(match[1]);
  }
  return [...refs];
}

/** Extract {{secrets.KEY}} references from content (these are secret config keys) */
function extractSecretConfigReferences(content: string): string[] {
  const refs = new Set<string>();
  const re = new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.add(match[1]);
  }
  return [...refs];
}

function normalizeToolDsl(content: string): string {
  const firstNonEmptyLine = content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (firstNonEmptyLine?.startsWith('TOOL:')) {
    return convertStandaloneToolDSL(content);
  }

  return content;
}

function parseNestedBlockMap(content: string, blockName: string): Record<string, string> {
  return Object.fromEntries(
    parseDslNestedBlock(content, blockName).map((entry) => [entry.key, entry.value]),
  );
}

function getHeaderValue(headers: Record<string, string>, headerName: string): string | undefined {
  const normalizedHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedHeaderName) {
      return value;
    }
  }
  return undefined;
}

function hasConfiguredValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function extractImplicitAuthFallbackSecrets(content: string, toolName: string): string[] {
  const normalizedDsl = normalizeToolDsl(content);
  const props = parseDslProperties(normalizedDsl);
  const authType = props.auth?.toLowerCase();
  if (!authType || !TOOL_AUTH_TYPES_WITH_IMPLICIT_SECRETS.has(authType)) {
    return [];
  }

  const authConfig = parseNestedBlockMap(normalizedDsl, 'auth_config');
  const headers = parseNestedBlockMap(normalizedDsl, 'headers');

  switch (authType) {
    case 'api_key': {
      const headerName = authConfig.header_name || props.header_name || 'X-API-Key';
      if (
        hasConfiguredValue(authConfig.api_key) ||
        hasConfiguredValue(getHeaderValue(headers, headerName))
      ) {
        return [];
      }
      return [`api_key_token_${toolName}`];
    }
    case 'bearer': {
      if (
        hasConfiguredValue(authConfig.token) ||
        hasConfiguredValue(getHeaderValue(headers, 'Authorization'))
      ) {
        return [];
      }
      return [`bearer_token_${toolName}`];
    }
    case 'oauth2_client': {
      const refs: string[] = [];
      if (!hasConfiguredValue(authConfig.client_id) && !hasConfiguredValue(props.client_id)) {
        refs.push('oauth_client_id');
      }
      if (
        !hasConfiguredValue(authConfig.client_secret) &&
        !hasConfiguredValue(props.client_secret)
      ) {
        refs.push('oauth_client_secret');
      }
      return refs;
    }
    case 'searchai': {
      const tokenUrl = authConfig.token_url || props.token_url;
      if (hasConfiguredValue(tokenUrl)) {
        return hasConfiguredValue(authConfig.client_secret) ||
          hasConfiguredValue(props.client_secret)
          ? []
          : ['searchai_client_secret'];
      }

      const headerName = authConfig.header_name || props.header_name || 'Auth';
      if (hasConfiguredValue(getHeaderValue(headers, headerName))) {
        return [];
      }
      return [`searchai_token_${toolName}`];
    }
    default:
      return [];
  }
}
