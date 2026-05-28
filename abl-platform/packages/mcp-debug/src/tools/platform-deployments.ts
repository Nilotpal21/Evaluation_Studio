/**
 * platform_deployments Tool
 *
 * Manage deployments within a project via the Runtime REST API.
 * Supports list, create, get, retire, and rollback actions.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformDeploymentsSchema = z.object({
  action: z.enum(['list', 'create', 'get', 'retire', 'rollback']),
  projectId: z.string().describe('Project ID'),
  deploymentId: z.string().optional().describe('Deployment ID (for get, retire, rollback)'),
  label: z.string().optional().describe('Deployment label (for create)'),
  environment: z
    .string()
    .optional()
    .describe('Environment (for create: development, staging, production)'),
  entryAgentName: z.string().optional().describe('Name of the entry agent (required for create)'),
  agentVersionManifest: z
    .record(z.string())
    .optional()
    .describe('Map of agentName to version string (for create)'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (retire)'),
});

type PlatformDeploymentsArgs = z.infer<typeof platformDeploymentsSchema>;

// =============================================================================
// HANDLER
// =============================================================================

export async function platformDeployments(
  args: PlatformDeploymentsArgs,
  ctx: DebugContext,
): Promise<string> {
  const {
    action,
    projectId,
    deploymentId,
    label,
    environment,
    entryAgentName,
    agentVersionManifest,
    confirm,
  } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const basePath = `/api/projects/${safeProjectId}/deployments`;

  try {
    switch (action) {
      case 'list': {
        const result = await ctx.httpClient.get(basePath);
        return JSON.stringify({ success: true, data: sanitizeResponse(result) }, null, 2);
      }

      case 'create': {
        if (!environment) {
          return JSON.stringify({
            success: false,
            error: 'environment is required for the create action.',
          });
        }
        if (!entryAgentName) {
          return JSON.stringify({
            success: false,
            error: 'entryAgentName is required for the create action.',
          });
        }
        if (!agentVersionManifest) {
          return JSON.stringify({
            success: false,
            error: 'agentVersionManifest is required for the create action.',
          });
        }
        const body: Record<string, unknown> = {
          environment,
          entryAgentName,
          agentVersionManifest,
        };
        if (label) body.label = label;
        const result = await ctx.httpClient.post(basePath, body);
        return JSON.stringify({ success: true, data: sanitizeResponse(result) }, null, 2);
      }

      case 'get': {
        if (!deploymentId) {
          return JSON.stringify({
            success: false,
            error: 'deploymentId is required for the get action.',
          });
        }
        const safeDeploymentId = validatePathParam(deploymentId, 'deploymentId');
        const result = await ctx.httpClient.get(`${basePath}/${safeDeploymentId}`);
        return JSON.stringify({ success: true, data: sanitizeResponse(result) }, null, 2);
      }

      case 'retire': {
        if (!deploymentId) {
          return JSON.stringify({
            success: false,
            error: 'deploymentId is required for the retire action.',
          });
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message:
              'This will retire the deployment and take it offline. Set confirm: true to proceed.',
          });
        }
        const safeDeploymentId = validatePathParam(deploymentId, 'deploymentId');
        const result = await ctx.httpClient.post(`${basePath}/${safeDeploymentId}/retire`);
        return JSON.stringify({ success: true, data: sanitizeResponse(result) }, null, 2);
      }

      case 'rollback': {
        if (!deploymentId) {
          return JSON.stringify({
            success: false,
            error: 'deploymentId is required for the rollback action.',
          });
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message:
              'This will rollback the deployment to a previous version. Set confirm: true to proceed.',
          });
        }
        const safeDeploymentId = validatePathParam(deploymentId, 'deploymentId');
        const result = await ctx.httpClient.post(`${basePath}/${safeDeploymentId}/rollback`);
        return JSON.stringify({ success: true, data: sanitizeResponse(result) }, null, 2);
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      success: false,
      error: `platform_deployments ${action} failed: ${message}`,
      hint: 'Ensure the runtime is running and you are connected (platform_connect).',
    });
  }
}
