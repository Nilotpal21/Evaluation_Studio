/**
 * platform_config Tool
 *
 * Get and update project settings and LLM configuration via the Runtime REST API.
 *
 * Endpoints:
 *   GET  /api/projects/:projectId/settings    — Get project settings
 *   PUT  /api/projects/:projectId/settings    — Update project settings
 *   GET  /api/projects/:projectId/llm-config  — Get LLM config (operation-tier mapping)
 *   PUT  /api/projects/:projectId/llm-config  — Update LLM config
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformConfigSchema = z.object({
  action: z.enum(['get_settings', 'update_settings', 'get_llm_config', 'update_llm_config']),
  projectId: z.string().describe('Project ID'),
  settings: z.record(z.unknown()).optional().describe('Settings to update'),
});

type PlatformConfigArgs = z.infer<typeof platformConfigSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

function error(message: string, hint?: string): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}) });
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformConfig(args: PlatformConfigArgs, ctx: DebugContext): Promise<string> {
  const { action, projectId, settings } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');

  try {
    switch (action) {
      // ----- GET SETTINGS -----
      case 'get_settings': {
        const data = await ctx.httpClient.get(`/api/projects/${safeProjectId}/settings`);
        return success(sanitizeResponse(data));
      }

      // ----- UPDATE SETTINGS -----
      case 'update_settings': {
        if (!settings) {
          return error('settings is required for the "update_settings" action.');
        }
        const data = await ctx.httpClient.put(`/api/projects/${safeProjectId}/settings`, settings);
        return success(sanitizeResponse(data));
      }

      // ----- GET LLM CONFIG -----
      case 'get_llm_config': {
        const data = await ctx.httpClient.get(`/api/projects/${safeProjectId}/llm-config`);
        return success(sanitizeResponse(data));
      }

      // ----- UPDATE LLM CONFIG -----
      case 'update_llm_config': {
        if (!settings) {
          return error('settings is required for the "update_llm_config" action.');
        }
        const data = await ctx.httpClient.put(
          `/api/projects/${safeProjectId}/llm-config`,
          settings,
        );
        return success(sanitizeResponse(data));
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Configuration request failed: ${message}`,
      'Ensure the runtime is running and you are connected (platform_connect).',
    );
  }
}
