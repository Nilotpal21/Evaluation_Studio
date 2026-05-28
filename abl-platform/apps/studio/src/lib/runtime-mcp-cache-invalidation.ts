import { createLogger } from '@abl/compiler/platform/logger.js';
import { createServiceToken } from '@agent-platform/shared-auth';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('runtime-mcp-cache-invalidation');

/**
 * Tell the runtime to drop its per-project MCP-server init cache so the next
 * session start reloads MCP servers from MongoDB. Best-effort; errors are
 * logged but not thrown — the caller's primary mutation has already succeeded,
 * and the next session start (after the in-memory TTL elapses) will pick up
 * the change anyway.
 *
 * Triggered by Studio after `mcp_server_ops:create | update | delete` so a new
 * MCP server becomes visible to existing pod sessions immediately rather than
 * waiting up to 5 minutes for the existing project-init TTL.
 *
 * NOTE: This helper is not yet wired into mutation handlers — that arrives in
 * Task 1.8 of the ABLP-162 plan, where `mcp_server_ops:create | update | delete`
 * handlers will call `notifyRuntimeMcpServersChanged(tenantId, projectId)` after
 * the DB write commits.
 *
 * Authentication: signs a short-lived service token (5 min TTL) scoped to the
 * given tenant + project, mirroring the `/api/internal/tools/execute` pattern
 * in `services/tool-test-service.ts`. The runtime route (`requireServiceAuth`
 * + `rejectIfTokenMismatch`) verifies the token signature and cross-checks
 * the `tenantId` / `projectId` claims against the request body.
 */
export async function notifyRuntimeMcpServersChanged(
  tenantId: string,
  projectId: string,
): Promise<void> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    log.warn('Skipping runtime MCP cache invalidation — JWT_SECRET not configured', {
      tenantId,
      projectId,
    });
    return;
  }

  const authToken = createServiceToken(jwtSecret, {
    tenantId,
    projectId,
    serviceName: 'studio-mcp-cache-invalidation',
  });

  try {
    const response = await fetch(`${getRuntimeUrl()}/api/internal/mcp/reset-project-init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId, projectId }),
    });

    if (!response.ok) {
      log.warn('Runtime MCP project-init cache invalidation returned non-OK status', {
        tenantId,
        projectId,
        status: response.status,
      });
    }
  } catch (error: unknown) {
    log.warn('Failed to notify runtime MCP project-init cache invalidation', {
      tenantId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
