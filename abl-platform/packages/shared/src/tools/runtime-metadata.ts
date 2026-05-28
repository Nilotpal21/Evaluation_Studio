import { computeSourceHash } from '../utils/hash.js';

export interface ToolRuntimeMetadataHashInput {
  variableNamespaceIds?: readonly string[];
  mcpServerConfigs?: readonly ToolRuntimeMcpServerConfigHashInput[] | null;
}

export interface ToolRuntimeMcpServerConfigHashInput {
  id?: string | null;
  name?: string | null;
  transport?: string | null;
  url?: string | null;
  encryptedEnv?: string | null;
  encryptedAuthConfig?: string | null;
  authType?: string | null;
  authProfileId?: string | null;
  headers?: string | null;
  connectionTimeoutMs?: number | null;
  requestTimeoutMs?: number | null;
}

function normalizeMcpServerConfig(config: ToolRuntimeMcpServerConfigHashInput) {
  return {
    id: config.id ?? null,
    name: config.name ?? null,
    transport: config.transport ?? null,
    url: config.url ?? null,
    encryptedEnv: config.encryptedEnv ?? null,
    encryptedAuthConfig: config.encryptedAuthConfig ?? null,
    authType: config.authType ?? null,
    authProfileId: config.authProfileId ?? null,
    headers: config.headers ?? null,
    connectionTimeoutMs: config.connectionTimeoutMs ?? null,
    requestTimeoutMs: config.requestTimeoutMs ?? null,
  };
}

export function computeToolRuntimeMetadataHash(tool: ToolRuntimeMetadataHashInput): string {
  const variableNamespaceIds = [...new Set(tool.variableNamespaceIds ?? [])].sort();
  const mcpServerConfigs = (tool.mcpServerConfigs ?? [])
    .map(normalizeMcpServerConfig)
    .sort((a, b) => {
      const byName = (a.name ?? '').localeCompare(b.name ?? '');
      if (byName !== 0) return byName;
      return (a.id ?? '').localeCompare(b.id ?? '');
    });
  return computeSourceHash(JSON.stringify({ variableNamespaceIds, mcpServerConfigs }));
}
