/**
 * platform_versions Tool
 *
 * Manage agent versions within a project via the Runtime REST API.
 * Supports list, create, get, promote, and diff actions.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformVersionsSchema = z.object({
  action: z.enum(['list', 'create', 'get', 'promote', 'diff']),
  projectId: z.string().describe('Project ID'),
  agentName: z.string().describe('Agent name'),
  version: z.number().optional().describe('Version number (for get, promote)'),
  otherVersion: z.number().optional().describe('Other version for diff'),
  status: z
    .string()
    .optional()
    .describe('Target status for promote (testing, staged, active, deprecated)'),
  changelog: z.string().optional().describe('Changelog message for create'),
});

type PlatformVersionsArgs = z.infer<typeof platformVersionsSchema>;

// =============================================================================
// HANDLER
// =============================================================================

export async function platformVersions(
  args: PlatformVersionsArgs,
  ctx: DebugContext,
): Promise<string> {
  const { action, projectId, agentName, version, otherVersion, status, changelog } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const safeAgentName = validatePathParam(agentName, 'agentName');
  const basePath = `/api/projects/${safeProjectId}/agents/${safeAgentName}/versions`;

  try {
    switch (action) {
      case 'list': {
        const result = await ctx.httpClient.get(basePath);
        return JSON.stringify({ success: true, data: result }, null, 2);
      }

      case 'create': {
        const body: Record<string, string> = {};
        if (changelog) {
          body.changelog = changelog;
        }
        const result = await ctx.httpClient.post(basePath, body);
        return JSON.stringify({ success: true, data: result }, null, 2);
      }

      case 'get': {
        if (version === undefined) {
          return JSON.stringify({
            success: false,
            error: 'version is required for the get action.',
          });
        }
        const result = await ctx.httpClient.get(`${basePath}/${version}`);
        return JSON.stringify({ success: true, data: result }, null, 2);
      }

      case 'promote': {
        if (version === undefined) {
          return JSON.stringify({
            success: false,
            error: 'version is required for the promote action.',
          });
        }
        if (!status) {
          return JSON.stringify({
            success: false,
            error: 'status is required for the promote action.',
          });
        }
        const result = await ctx.httpClient.post(`${basePath}/${version}/promote`, {
          targetStatus: status,
        });
        return JSON.stringify({ success: true, data: result }, null, 2);
      }

      case 'diff': {
        if (version === undefined) {
          return JSON.stringify({
            success: false,
            error: 'version is required for the diff action.',
          });
        }
        if (otherVersion === undefined) {
          return JSON.stringify({
            success: false,
            error: 'otherVersion is required for the diff action.',
          });
        }
        const result = await ctx.httpClient.get(`${basePath}/${version}/diff/${otherVersion}`);
        return JSON.stringify({ success: true, data: result }, null, 2);
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      success: false,
      error: `platform_versions ${action} failed: ${message}`,
      hint: 'Ensure the runtime is running and you are connected (platform_connect).',
    });
  }
}
