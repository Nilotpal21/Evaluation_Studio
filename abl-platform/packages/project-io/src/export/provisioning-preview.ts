import {
  extractEnvVarReferences,
  scanProjectAuthProfileRequirements,
  scanProjectConnectorReferences,
  scanProjectEnvVars,
  scanProjectMcpServerReferences,
  type ProjectAuthProfileRequirement,
} from './env-var-scanner.js';

export interface ExportProvisioningPreview {
  requiredEnvVars: string[];
  requiredAuthProfiles: ProjectAuthProfileRequirement[];
  requiredConnectors: string[];
  requiredMcpServers: string[];
}

export interface BuildExportProvisioningRequirementsInput {
  agents: Array<{ name?: string; dslContent: string }>;
  tools: Array<{ name?: string; content?: string; dslContent?: string }>;
  profiles?: Array<{ name?: string; dslContent: string }>;
  connectorConfigs?: Array<{ connectorType?: string | null }>;
  mcpServers?: Array<{ name?: string | null }>;
}

function scanProfileEnvVars(profiles: Array<{ dslContent: string }> = []): string[] {
  const refs = new Set<string>();
  for (const profile of profiles) {
    if (!profile.dslContent) continue;
    for (const ref of extractEnvVarReferences(profile.dslContent)) refs.add(ref);
  }
  return [...refs].sort();
}

function configuredConnectorTypes(
  connectorConfigs: Array<{ connectorType?: string | null }> = [],
): string[] {
  return connectorConfigs
    .map((config) => config.connectorType?.trim())
    .filter((connectorType): connectorType is string => Boolean(connectorType));
}

function configuredMcpServerNames(mcpServers: Array<{ name?: string | null }> = []): string[] {
  return mcpServers
    .map((server) => server.name?.trim())
    .filter((name): name is string => Boolean(name));
}

export function buildExportProvisioningRequirements(
  input: BuildExportProvisioningRequirementsInput,
): ExportProvisioningPreview {
  const requiredEnvVars = new Set([
    ...scanProjectEnvVars(input.agents, input.tools),
    ...scanProfileEnvVars(input.profiles),
  ]);
  const requiredConnectors = new Set([
    ...scanProjectConnectorReferences(input.tools),
    ...configuredConnectorTypes(input.connectorConfigs),
  ]);
  const requiredMcpServers = new Set([
    ...scanProjectMcpServerReferences(input.tools),
    ...configuredMcpServerNames(input.mcpServers),
  ]);

  return {
    requiredEnvVars: [...requiredEnvVars].sort(),
    requiredAuthProfiles: scanProjectAuthProfileRequirements(input.agents, input.tools),
    requiredConnectors: [...requiredConnectors].sort(),
    requiredMcpServers: [...requiredMcpServers].sort(),
  };
}
