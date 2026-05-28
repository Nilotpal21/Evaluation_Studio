/**
 * Studio MCP Discovery Service
 *
 * Handles MCP tool discovery, preview, persist, test-connection, and tool testing.
 * Each operation creates its own short-lived MCPServerManager instance (G16: NOT the runtime singleton).
 * All connections are guaranteed to disconnect via try/finally (E5).
 *
 * Uses the flat project_tools collection (DSL-native tools, no versioning).
 */

import { isRecord } from '@agent-platform/shared';
import { computeSourceHash } from '@agent-platform/shared';
import {
  findMcpServerConfigById,
  findProjectToolByName,
  findProjectToolsByProject,
  createProjectTool,
  updateProjectTool,
  updateMcpServerConnectionStatus,
} from '@agent-platform/shared/repos';
import { serializeToolFormToDsl } from '@agent-platform/shared';
import type { McpToolFormData } from '@agent-platform/shared';
import { MCPServerRegistryService } from '@agent-platform/shared/services/mcp-registry';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';

// ─── Types ───────────────────────────────────────────────────────────────

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  suggestedSlug?: string;
}

export interface DiscoveryPreviewResult {
  tools: DiscoveredTool[];
  totalDiscovered: number;
}

export interface DiscoveryPersistResult {
  successful: number;
  failed: Array<{ toolName: string; error: string }>;
  schemaDrift: Array<{ toolName: string; field: string }>;
  conflicting: Array<{ toolName: string; reason: string }>;
  totalDiscovered: number;
}

export interface ConnectionTestResult {
  connected: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  latencyMs: number;
  error?: string;
}

export interface ToolTestResult {
  success: boolean;
  output?: unknown;
  latencyMs: number;
  error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_TOOLS_PER_SERVER = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Filter LLM-artifact keys (thought/reason) from MCP tool schemas */
function filterSchemaArtifacts(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  const filtered = { ...schema };
  if (isRecord(filtered.properties)) {
    const props = { ...filtered.properties };
    delete props.thought;
    delete props.reason;
    filtered.properties = props;
    if (Array.isArray(filtered.required)) {
      filtered.required = (filtered.required as unknown[]).filter(
        (r): r is string => typeof r === 'string' && r !== 'thought' && r !== 'reason',
      );
    }
  }
  return filtered;
}

function mcpSlug(serverName: string, toolName: string): string {
  const name = `${serverName}__${toolName}`;
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_|_$/g, '');
}

type TempManagerResult =
  | { ok: true; manager: any; config: any; tempScope: string }
  | { ok: false; error: string };

/** Create a short-lived MCPServerManager + registry for a single operation */
async function createTempManager(
  tenantId: string,
  projectId: string,
  serverId: string,
  verifyProject?: (projectId: string, tenantId: string) => Promise<boolean>,
): Promise<TempManagerResult> {
  const { MCPServerManager } = await import('@abl/compiler/platform/studio-exports.js');

  const registry = new MCPServerRegistryService(
    {
      decryptForTenant: (encrypted, scopedTenantId) =>
        decryptForTenantAuto(encrypted, scopedTenantId),
    },
    verifyProject,
  );
  const configs = await registry.getServerConfigs(tenantId, projectId);
  const config = configs.find((c) => c.id === serverId);

  if (!config) {
    return { ok: false, error: 'Failed to build server config (decryption may have failed)' };
  }

  // Allow localhost/private ranges in non-production environments
  const devOpts = getDevSSRFOptions();
  if (devOpts.allowLocalhost || devOpts.allowPrivateRanges) {
    config.ssrfOptions = devOpts;
  }

  const manager = new MCPServerManager();
  const tempScope = `studio:${crypto.randomUUID()}`;

  return { ok: true, manager, config, tempScope };
}

/**
 * Build dslContent for an MCP tool discovered from a server.
 * Uses serializeToolFormToDsl to produce consistent DSL format.
 */
function buildMcpToolDsl(
  toolName: string,
  serverName: string,
  serverId: string,
  description?: string,
  inputSchema?: unknown,
): string {
  // Extract parameters from inputSchema if available
  const parameters: Array<{ name: string; type: string; description: string; required: boolean }> =
    [];
  if (isRecord(inputSchema) && isRecord(inputSchema.properties)) {
    const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
    for (const [pName, pSchema] of Object.entries(inputSchema.properties)) {
      if (isRecord(pSchema)) {
        parameters.push({
          name: pName,
          type: (pSchema.type as string) || 'string',
          description: (pSchema.description as string) || '',
          required: required.includes(pName),
        });
      }
    }
  }

  const formData: McpToolFormData = {
    name: toolName,
    toolType: 'mcp',
    description: description || '',
    parameters,
    returnType: 'object',
    server: serverName,
    serverTool: toolName.includes('__') ? toolName.split('__').pop() || toolName : undefined,
  };

  return serializeToolFormToDsl(formData);
}

// ─── Discovery Preview ───────────────────────────────────────────────────

/**
 * Connect to an MCP server and list available tools without persisting.
 * Returns tool names, descriptions, and filtered input schemas.
 */
export async function discoverPreview(
  serverId: string,
  tenantId: string,
  projectId: string,
): Promise<DiscoveryPreviewResult | { error: string; status: number }> {
  const server = await findMcpServerConfigById(serverId, tenantId);
  if (!server || server.projectId !== projectId) {
    return { error: 'MCP server not found', status: 404 };
  }

  const result = await createTempManager(tenantId, projectId, server.id);
  if (!result.ok) {
    return { error: result.error, status: 500 };
  }

  const { manager, config, tempScope } = result;

  try {
    await manager.registerServer(config, tempScope);
    await manager.connectServer(config.name, tempScope);

    let tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    try {
      tools = await manager.listAllTools(tempScope);
    } catch {
      // Failed to list — return empty
    }

    if (tools.length > MAX_TOOLS_PER_SERVER) {
      tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
    }

    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || undefined,
        inputSchema: isRecord(t.inputSchema) ? filterSchemaArtifacts(t.inputSchema) : undefined,
        suggestedSlug: mcpSlug(server.name, t.name),
      })),
      totalDiscovered: tools.length,
    };
  } catch (err) {
    return {
      error: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      status: 502,
    };
  } finally {
    try {
      await manager.disconnectServer(config.name, tempScope);
    } catch {
      /* E5: guaranteed cleanup */
    }
  }
}

// ─── Discovery Persist ───────────────────────────────────────────────────

/**
 * Connect to MCP server, discover tools, and persist into project_tools.
 * Optionally filter to specific tool names from a previous preview.
 */
export async function discoverAndPersist(
  serverId: string,
  tenantId: string,
  projectId: string,
  userId: string,
  toolNames?: string[],
): Promise<DiscoveryPersistResult | { error: string; status: number }> {
  const server = await findMcpServerConfigById(serverId, tenantId);
  if (!server || server.projectId !== projectId) {
    return { error: 'MCP server not found', status: 404 };
  }

  const result = await createTempManager(tenantId, projectId, server.id);
  if (!result.ok) {
    return { error: result.error, status: 500 };
  }

  const { manager, config, tempScope } = result;
  let allDiscovered: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];

  try {
    await manager.registerServer(config, tempScope);
    await manager.connectServer(config.name, tempScope);

    try {
      allDiscovered = await manager.listAllTools(tempScope);
    } catch {
      // Failed to list tools
    }
  } catch (err) {
    return {
      error: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      status: 502,
    };
  } finally {
    try {
      await manager.disconnectServer(config.name, tempScope);
    } catch {
      /* E5 */
    }
  }

  if (allDiscovered.length > MAX_TOOLS_PER_SERVER) {
    allDiscovered = allDiscovered.slice(0, MAX_TOOLS_PER_SERVER);
  }

  // Filter to selected tools if toolNames provided
  const selectedTools = toolNames
    ? allDiscovered.filter((t) => toolNames.includes(t.name))
    : allDiscovered;
  const defaultVariableNamespaceIds = await getOrCreateDefaultVariableNamespaceIds({
    tenantId,
    projectId,
    createdBy: userId,
  });

  let successful = 0;
  const failed: Array<{ toolName: string; error: string }> = [];
  const schemaDrift: Array<{ toolName: string; field: string }> = [];
  const conflicting: Array<{ toolName: string; reason: string }> = [];
  let didMutateProjectTools = false;

  for (const dt of selectedTools) {
    const projectToolName = mcpSlug(server.name, dt.name);
    const filteredSchema = isRecord(dt.inputSchema) ? filterSchemaArtifacts(dt.inputSchema) : null;

    try {
      // Build DSL content for this MCP tool
      const dslContent = buildMcpToolDsl(
        projectToolName,
        server.name,
        serverId,
        dt.description,
        filteredSchema,
      );
      const sourceHash = computeSourceHash(dslContent);

      // Check if tool already exists by name
      const existing = await findProjectToolByName(tenantId, projectId, projectToolName);

      if (existing) {
        // Check schema drift (compare sourceHash)
        if (existing.sourceHash !== sourceHash) {
          schemaDrift.push({ toolName: dt.name, field: 'dslContent' });

          // Update existing tool with new dslContent
          await updateProjectTool(existing.id, tenantId, projectId, {
            dslContent,
            sourceHash,
            description: dt.description || null,
            lastEditedBy: userId,
          });
          didMutateProjectTools = true;
        }
        successful++;
      } else {
        // Create new project tool
        await createProjectTool({
          tenantId,
          projectId,
          name: projectToolName,
          slug: projectToolName,
          toolType: 'mcp',
          description: dt.description || null,
          dslContent,
          sourceHash,
          variableNamespaceIds: defaultVariableNamespaceIds,
          createdBy: userId,
        });
        didMutateProjectTools = true;
        successful++;
      }
    } catch (err) {
      failed.push({
        toolName: dt.name,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  if (didMutateProjectTools) {
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId,
      tenantId,
    });
  }

  return {
    successful,
    failed,
    schemaDrift,
    conflicting,
    totalDiscovered: allDiscovered.length,
  };
}

// ─── Test Connection ─────────────────────────────────────────────────────

/**
 * Test connectivity to an MCP server. Returns connection status, tool count, and latency.
 */
export async function testConnection(
  serverId: string,
  tenantId: string,
  projectId: string,
): Promise<ConnectionTestResult | { error: string; status: number }> {
  const server = await findMcpServerConfigById(serverId, tenantId);
  if (!server || server.projectId !== projectId) {
    return { error: 'MCP server not found', status: 404 };
  }

  const result = await createTempManager(tenantId, projectId, server.id);
  if (!result.ok) {
    return { error: result.error, status: 500 };
  }

  const { manager, config, tempScope } = result;
  const start = Date.now();

  try {
    await manager.registerServer(config, tempScope);
    await manager.connectServer(config.name, tempScope);

    const tools = await manager.listAllTools(tempScope);
    const latencyMs = Date.now() - start;

    // Persist connection status to DB (fire-and-forget)
    updateMcpServerConnectionStatus(serverId, tenantId, {
      lastConnectionStatus: 'connected',
      lastConnectionAt: new Date(),
      lastConnectionLatencyMs: latencyMs,
      lastConnectionToolCount: tools.length,
    }).catch((err) => console.error('[MCP] Failed to persist connection status:', err));

    return {
      connected: true,
      toolCount: tools.length,
      tools: tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      })),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;

    // Persist failure status to DB (fire-and-forget)
    updateMcpServerConnectionStatus(serverId, tenantId, {
      lastConnectionStatus: 'failed',
      lastConnectionAt: new Date(),
      lastConnectionLatencyMs: latencyMs,
      lastConnectionError: err instanceof Error ? err.message : String(err),
    }).catch((persistErr) =>
      console.error('[MCP] Failed to persist connection status:', persistErr),
    );

    return {
      connected: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  } finally {
    try {
      await manager.disconnectServer(config.name, tempScope);
    } catch {
      /* E5 */
    }
  }
}

// ─── Test Tool ───────────────────────────────────────────────────────────

/**
 * Execute a single MCP tool with given input. Creates a temporary connection.
 */
export async function testMcpTool(
  serverId: string,
  tenantId: string,
  projectId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): Promise<ToolTestResult | { error: string; status: number }> {
  const server = await findMcpServerConfigById(serverId, tenantId);
  if (!server || server.projectId !== projectId) {
    return { error: 'MCP server not found', status: 404 };
  }

  const result = await createTempManager(tenantId, projectId, server.id);
  if (!result.ok) {
    return { error: result.error, status: 500 };
  }

  const { manager, config, tempScope } = result;
  const start = Date.now();

  try {
    await manager.registerServer(config, tempScope);
    await manager.connectServer(config.name, tempScope);

    const output = await manager.callTool(toolName, input, tempScope);
    return {
      success: true,
      output,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    try {
      await manager.disconnectServer(config.name, tempScope);
    } catch {
      /* E5 */
    }
  }
}

// ─── List Discovered Tools ───────────────────────────────────────────────

/**
 * List MCP tools previously discovered and persisted for a given MCP server.
 * Queries project_tools where name matches the server prefix pattern.
 */
export async function listDiscoveredTools(
  serverId: string,
  tenantId: string,
  projectId: string,
): Promise<
  | Array<{
      id: string;
      toolName: string;
      description: string | null;
      serverName: string;
      discoveredAt: string;
      lastVerifiedAt: string;
      isAvailable: boolean;
    }>
  | { error: string; status: number }
> {
  const server = await findMcpServerConfigById(serverId, tenantId);
  if (!server || server.projectId !== projectId) {
    return { error: 'MCP server not found', status: 404 };
  }

  // Query project_tools for MCP tools whose name starts with the server prefix
  const serverPrefix = server.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const result = await findProjectToolsByProject(tenantId, projectId, {
    toolType: 'mcp',
    search: `${serverPrefix}__`,
    limit: MAX_TOOLS_PER_SERVER,
  });

  return result.data
    .filter((t) => t.name.startsWith(`${serverPrefix}__`))
    .map((t) => ({
      id: t.id,
      toolName: t.name,
      description: t.description,
      serverName: server.name,
      discoveredAt: String(t.createdAt),
      lastVerifiedAt: String(t.updatedAt),
      isAvailable: true,
    }));
}

// ─── Get Single Discovered Tool ──────────────────────────────────────────

/**
 * Get a single discovered tool by ID.
 */
export async function getDiscoveredTool(
  toolId: string,
  tenantId: string,
  projectId: string,
): Promise<
  | {
      id: string;
      toolName: string;
      description: string | null;
      serverName: string;
      discoveredAt: string;
      lastVerifiedAt: string;
      isAvailable: boolean;
    }
  | { error: string; status: number }
> {
  const { findProjectToolById } = await import('@agent-platform/shared/repos');
  const tool = await findProjectToolById(toolId, tenantId, projectId);
  if (!tool) {
    return { error: 'Tool not found', status: 404 };
  }

  return {
    id: tool.id,
    toolName: tool.name,
    description: tool.description,
    serverName: tool.name.split('__')[0] || '',
    discoveredAt: String(tool.createdAt),
    lastVerifiedAt: String(tool.updatedAt),
    isAvailable: true,
  };
}
