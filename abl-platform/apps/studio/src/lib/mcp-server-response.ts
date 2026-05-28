/**
 * MCP Server Response Helpers
 *
 * Sanitizers and response builders specific to MCP server config entities.
 * Built on top of the generic sanitizer in sanitize.ts and
 * the response framework in api-response.ts.
 */

import type { NextResponse } from 'next/server';
import type { NormalizedMCPServerConfig, ApiMCPServerConfig } from '@agent-platform/shared';
import { sanitizeDocument } from '@/lib/sanitize';
import { successJson } from '@/lib/api-response';

// ─── Strip List ─────────────────────────────────────────────────────────────

const MCP_STRIP = ['tenantId', 'projectId', 'encryptedEnv', 'encryptedAuthConfig', '_v', '__v'];

// ─── Input Type ─────────────────────────────────────────────────────────────

type McpServerInput = NormalizedMCPServerConfig & {
  discoveredToolCount?: number;
  _count?: { discoveredTools: number };
};

// ─── Sanitizer ──────────────────────────────────────────────────────────────

export function sanitizeMcpServer(s: McpServerInput): ApiMCPServerConfig {
  const out = sanitizeDocument<Record<string, unknown>>(s as Record<string, unknown>, {
    stripFields: MCP_STRIP,
    jsonArrayFields: ['tags'],
  });
  // Parse headers JSON string → Record<string, string> (null → undefined)
  if (typeof out.headers === 'string') {
    try {
      out.headers = JSON.parse(out.headers as string);
    } catch {
      out.headers = undefined;
    }
  } else if (!out.headers) {
    delete out.headers;
  }
  // Entity-specific: promote _count.discoveredTools
  const count = out._count as { discoveredTools?: number } | undefined;
  if (count?.discoveredTools !== undefined && out.discoveredToolCount === undefined) {
    out.discoveredToolCount = count.discoveredTools;
  }
  delete out._count;
  // Default discoveredToolCount to 0 when neither _count nor explicit value was provided
  if (out.discoveredToolCount === undefined) out.discoveredToolCount = 0;
  return out as ApiMCPServerConfig;
}

// ─── Response Builders ──────────────────────────────────────────────────────

/** Single MCP server response */
export function mcpServerResponse(server: McpServerInput, status = 200): NextResponse {
  return successJson('server', sanitizeMcpServer(server), status);
}

/** MCP server list response (uses 'servers' key for frontend backward compat) */
export function mcpServerListResponse(servers: McpServerInput[]): NextResponse {
  return successJson(
    'servers',
    servers.map((s) => sanitizeMcpServer(s)),
  );
}
