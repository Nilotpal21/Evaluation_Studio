/**
 * MCP Server Config Repository
 *
 * MongoDB CRUD operations for MCP server configurations.
 * Used by: Studio (CRUD routes, discovery), Runtime (mcp-server-registry)
 */

import type { IMCPServerConfig } from '@agent-platform/database/models';
import { normalizeDocument } from '../utils/normalize.js';
import type { NormalizedMCPServerConfig, RawMCPServerConfig } from '../types/mcp-server.js';

// Re-export IR baking types so callers can import from the repos barrel
export type { McpServerConfigForIR, RawMCPServerConfig } from '../types/mcp-server.js';

function normalize(doc: IMCPServerConfig | null): NormalizedMCPServerConfig | null {
  return normalizeDocument(doc) as NormalizedMCPServerConfig | null;
}

// ─── Find ─────────────────────────────────────────────────────────────────

export async function findMcpServerConfigById(
  id: string,
  tenantId: string,
): Promise<NormalizedMCPServerConfig | null> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const doc = await MCPServerConfig.findOne({ _id: id, tenantId }).lean();
  return normalize(doc);
}

export async function findMcpServerConfigsByProject(
  tenantId: string,
  projectId: string,
): Promise<NormalizedMCPServerConfig[]> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const where: Record<string, unknown> = { tenantId, projectId };
  const docs = await MCPServerConfig.find(where).sort({ priority: -1 }).lean();
  return docs.map((doc: IMCPServerConfig) => {
    const normalized = normalize(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize MCP server config - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

/**
 * Regex to extract the `server:` value from MCP tool DSL content.
 * Matches both quoted and unquoted forms: `server: "name"` or `server: name`
 */
const SERVER_DSL_REGEX = /^\s*server:\s*"?([^"\n]+)"?/m;

export async function findMcpServerConfigsWithToolCount(
  tenantId: string,
  projectId: string,
): Promise<Array<NormalizedMCPServerConfig & { _count: { discoveredTools: number } }>> {
  const { MCPServerConfig, ProjectTool } = await import('@agent-platform/database/models');
  const where: Record<string, unknown> = { tenantId, projectId };
  const docs = await MCPServerConfig.find(where).sort({ priority: -1 }).lean();

  if (docs.length === 0) return [];

  // Batch count: fetch all MCP project tools, parse server name from DSL, count per name
  const mcpTools = await ProjectTool.find({ tenantId, projectId, toolType: 'mcp' })
    .select('dslContent')
    .lean();

  const countByName = new Map<string, number>();
  for (const tool of mcpTools) {
    const match = SERVER_DSL_REGEX.exec(tool.dslContent);
    if (match) {
      const serverName = match[1].trim();
      countByName.set(serverName, (countByName.get(serverName) || 0) + 1);
    }
  }

  return docs.map((d: IMCPServerConfig) => {
    const normalized = normalize(d);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize MCP server config - data integrity error');
    }
    /* v8 ignore stop */
    return {
      ...normalized,
      _count: { discoveredTools: countByName.get(d.name) || 0 },
    };
  });
}

// ─── Create ───────────────────────────────────────────────────────────────

export async function createMcpServerConfig(data: {
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  transport: 'sse' | 'http';
  url?: string;
  encryptedEnv?: string;
  priority?: number;
  tags?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  authType?: string;
  encryptedAuthConfig?: string;
  headers?: string;
  authProfileId?: string | null;
  envProfileId?: string | null;
  createdBy?: string;
}): Promise<NormalizedMCPServerConfig> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const doc = await MCPServerConfig.create(data);
  const normalized = normalize(doc.toObject());
  /* v8 ignore start */
  if (!normalized) {
    throw new Error('Failed to normalize newly created MCP server config - data integrity error');
  }
  /* v8 ignore stop */
  return normalized;
}

// ─── Update ───────────────────────────────────────────────────────────────

// TODO(isolation): make projectId required after all callers updated
// Callers that need updating:
//   - apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts (PATCH handler)
//   - apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts (DELETE handler)
//   - packages/shared/src/repos/mcp-server-config-repo.ts (updateMcpServerConnectionStatus — internal wrapper)
export async function updateMcpServerConfig(
  id: string,
  tenantId: string,
  data: Record<string, unknown>,
  projectId?: string,
): Promise<NormalizedMCPServerConfig | null> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await MCPServerConfig.findOne(query);
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalize(doc.toObject());
}

export async function updateProjectScopedMcpServerConfig(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
): Promise<NormalizedMCPServerConfig | null> {
  return updateMcpServerConfig(id, tenantId, data, projectId);
}

export async function updateMcpServerConnectionStatus(
  id: string,
  tenantId: string,
  status: {
    lastConnectionStatus: 'connected' | 'failed';
    lastConnectionAt: Date;
    lastConnectionLatencyMs: number;
    lastConnectionToolCount?: number;
    lastConnectionError?: string;
  },
): Promise<NormalizedMCPServerConfig | null> {
  return updateMcpServerConfig(id, tenantId, status);
}

// ─── Delete ───────────────────────────────────────────────────────────────

export async function deleteMcpServerConfigWithCascade(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<{ deleted: boolean; cascadedTools: number; cascadedLinks: number }> {
  const { MCPServerConfig, ProjectTool } = await import('@agent-platform/database/models');

  // Look up the server config to get its name (used for DSL matching)
  const lookupQuery: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) lookupQuery.projectId = projectId;
  const serverConfig = await MCPServerConfig.findOne(lookupQuery).lean();

  let cascadedTools = 0;
  if (serverConfig) {
    // Escape special regex chars in the server name
    const escapedName = serverConfig.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Find and delete project tools whose DSL references this server by name
    const toolResult = await ProjectTool.deleteMany({
      tenantId,
      projectId: serverConfig.projectId,
      toolType: 'mcp',
      dslContent: { $regex: `^\\s*server:\\s*"?${escapedName}"?`, $options: 'm' },
    });
    cascadedTools = toolResult.deletedCount;
  }

  // Delete the server config itself
  const deleteQuery: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) deleteQuery.projectId = projectId;
  const result = await MCPServerConfig.deleteOne(deleteQuery);

  return {
    deleted: result.deletedCount > 0,
    cascadedTools,
    cascadedLinks: 0,
  };
}

export async function deleteProjectScopedMcpServerConfigWithCascade(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<{ deleted: boolean; cascadedTools: number; cascadedLinks: number }> {
  return deleteMcpServerConfigWithCascade(id, tenantId, projectId);
}

// ─── Raw (IR Baking) ──────────────────────────────────────────────────────

/**
 * Fetch MCP server configs using the native MongoDB driver, bypassing Mongoose
 * post-find decryption hooks. Returns raw DEK-envelope ciphertext in encryptedEnv
 * and encryptedAuthConfig — suitable for baking into the IR.
 *
 * IMPORTANT: Do NOT use this function for Studio UI, API responses, or tool discovery.
 * Use findMcpServerConfigsByProject() for those cases (returns decrypted values).
 *
 * Tenant+project isolation is enforced explicitly in the query filter below,
 * because the native driver bypasses the Mongoose tenantIsolationPlugin hook.
 */
export async function findMcpServerConfigsRaw(
  tenantId: string,
  projectId: string,
): Promise<RawMCPServerConfig[]> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  // Native driver bypasses ALL Mongoose plugins (post-find decrypt, tenant isolation plugin).
  // Tenant+project isolation is enforced explicitly in the filter below.
  const docs = await MCPServerConfig.collection
    .find({ tenantId, projectId })
    .sort({ priority: -1 })
    .toArray();
  return docs.map((d: Record<string, unknown>) => ({
    id: String(d._id),
    name: d.name as string,
    transport: (d.transport ?? 'http') as string,
    url: (d.url ?? null) as string | null,
    encryptedEnv: (d.encryptedEnv ?? null) as string | null,
    encryptedAuthConfig: (d.encryptedAuthConfig ?? null) as string | null,
    authType: (d.authType ?? null) as string | null,
    authProfileId: (d.authProfileId ?? null) as string | null,
    envProfileId: (d.envProfileId ?? null) as string | null,
    headers: (d.headers ?? null) as string | null,
    // Schema defaults (30000) are applied at write time so stored docs always have these values.
    // Cast is safe — schema type is number, not nullable.
    connectionTimeoutMs: d.connectionTimeoutMs as number,
    requestTimeoutMs: d.requestTimeoutMs as number,
    tenantId: d.tenantId as string,
    projectId: d.projectId as string,
  }));
}
