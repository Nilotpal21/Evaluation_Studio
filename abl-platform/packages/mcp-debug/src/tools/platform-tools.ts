/**
 * platform_tools Tool
 *
 * Manage project tools (list, get, create, update, delete, test).
 *
 * NOTE: Tool CRUD endpoints live on the Studio API. Remote deployments
 * co-host Studio behind the same origin as runtime; local dev rewrites
 * the runtime port to the Studio port.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { buildStudioHeaders, deriveStudioUrl } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformToolsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'test']),
  projectId: z.string().describe('Project ID'),
  toolId: z.string().optional().describe('Tool ID (for get, update, delete, test)'),
  name: z.string().optional().describe('Tool name (for create)'),
  type: z.string().optional().describe('Tool type (for create: http, function, mcp)'),
  definition: z
    .record(z.unknown())
    .optional()
    .describe('Tool definition object (for create, update)'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (delete)'),
});

type PlatformToolsArgs = z.infer<typeof platformToolsSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify({ success: true, data: sanitizeResponse(data) });
}

function error(message: string, hint?: string): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}) });
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformTools(args: PlatformToolsArgs, ctx: DebugContext): Promise<string> {
  const { action, projectId, toolId, name, type, definition, confirm } = args;
  const studioUrl = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx);
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const basePath = `${studioUrl}/api/projects/${safeProjectId}/tools`;

  try {
    switch (action) {
      // ----- LIST -----
      case 'list': {
        const response = await fetchWithTimeout(basePath, { headers }, 10_000);
        if (!response.ok) {
          return error(`GET ${basePath} failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- GET -----
      case 'get': {
        if (!toolId) {
          return error('toolId is required for the "get" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}`;
        const response = await fetchWithTimeout(url, { headers }, 10_000);
        if (!response.ok) {
          return error(`GET ${url} failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- CREATE -----
      case 'create': {
        const body: Record<string, unknown> = { ...definition };
        if (name) body.name = name;
        if (type) body.type = type;

        const response = await fetchWithTimeout(
          basePath,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`POST ${basePath} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- UPDATE -----
      case 'update': {
        if (!toolId) {
          return error('toolId is required for the "update" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}`;
        const body: Record<string, unknown> = { ...definition };
        if (name) body.name = name;
        if (type) body.type = type;

        const response = await fetchWithTimeout(
          url,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`PUT ${url} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- DELETE -----
      case 'delete': {
        if (!toolId) {
          return error('toolId is required for the "delete" action.');
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message: 'This will permanently delete the tool. Set confirm: true to proceed.',
          });
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}`;
        const response = await fetchWithTimeout(
          url,
          {
            method: 'DELETE',
            headers,
          },
          10_000,
        );
        if (!response.ok) {
          return error(`DELETE ${url} failed: ${response.status} ${response.statusText}`);
        }
        return success({ deleted: true, toolId });
      }

      // ----- TEST -----
      case 'test': {
        if (!toolId) {
          return error('toolId is required for the "test" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}/test`;
        const response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers,
          },
          15_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`POST ${url} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Tool management request failed: ${message}`,
      'Tool CRUD endpoints are served by Studio. For local runtime URLs, ensure Studio is running on http://localhost:5173. For remote URLs, Arch uses the connected origin.',
    );
  }
}
