/**
 * connection_ops — Arch AI tool for connector-connection lifecycle inside a project.
 *
 * Wraps the Studio singleton ConnectionService (which delegates credential
 * resolution to the auth-profile system) and the existing dynamic-options /
 * dynamic-fields proxy routes. All errors are sanitized before returning.
 *
 * Permissions:
 *  - list, resolve_options, resolve_dynamic_props → connection:read
 *  - create, delete                                → connection:write / :delete
 */

import { z } from 'zod';
import { ConnectorConnection } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getConnectionService } from '@/lib/connection-service';
import { invalidateProjectCaches } from './cache-invalidation';
import { syncActiveDraftFromConnection } from '../integration-draft-service';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { sanitizeToolError } from '../sanitize-tool-error';

const log = createLogger('arch-ai:connection-ops');

// ─── Input schema ──────────────────────────────────────────────────────────

// NOTE: We use z.object with optional fields rather than z.discriminatedUnion
// because OpenAI's function-calling JSON Schema requires `type: "object"` at the
// top level. Zod's discriminatedUnion produces a top-level `anyOf`/`oneOf` shape
// that OpenAI rejects with: "schema must be a JSON Schema of type: 'object', got
// type: 'None'". Action-specific required fields are enforced at runtime in
// executeConnectionOps via narrow typing per branch.
export const connectionOpsInputSchema = z.object({
  action: z.enum(['list', 'create', 'delete', 'resolve_options', 'resolve_dynamic_props']),
  connectorName: z.string().min(1).optional(),
  authProfileId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  connectionId: z.string().min(1).optional(),
  actionName: z.string().min(1).optional(),
  propName: z.string().min(1).optional(),
  propsValue: z.record(z.unknown()).optional(),
  searchValue: z.string().optional(),
});

export type ConnectionOpsInput = z.infer<typeof connectionOpsInputSchema>;

export interface ConnectionOpsResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function unavailableOptionsResult(): ConnectionOpsResult {
  return {
    success: true,
    data: {
      disabled: true,
      placeholder: 'Connector unavailable; please type the value manually.',
      options: [],
    },
  };
}

function unavailableDynamicPropsResult(): ConnectionOpsResult {
  return {
    success: true,
    data: { properties: {}, disabled: true },
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────

export async function executeConnectionOps(
  input: ConnectionOpsInput,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const perm = await checkToolPermission('connection_ops', input.action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: perm.error ?? 'Permission denied',
      },
    };
  }

  try {
    switch (input.action) {
      case 'list':
        return await listConnections(ctx);
      case 'create': {
        const missing = ['connectorName', 'authProfileId'].filter(
          (k) => !(input as Record<string, unknown>)[k],
        );
        if (missing.length > 0) {
          return {
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message: `Missing required fields for action 'create': ${missing.join(', ')}`,
            },
          };
        }
        return await createConnection(
          input as ConnectionOpsInput & {
            connectorName: string;
            authProfileId: string;
          },
          ctx,
        );
      }
      case 'delete':
        if (!input.connectionId) {
          return {
            success: false,
            error: { code: 'INVALID_INPUT', message: "Missing 'connectionId' for action 'delete'" },
          };
        }
        return await deleteConnection(input as ConnectionOpsInput & { connectionId: string }, ctx);
      case 'resolve_options': {
        const missing = ['connectorName', 'actionName', 'propName', 'connectionId'].filter(
          (k) => !(input as Record<string, unknown>)[k],
        );
        if (missing.length > 0) {
          return {
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message: `Missing required fields for action 'resolve_options': ${missing.join(', ')}`,
            },
          };
        }
        return await resolveOptions(
          input as ConnectionOpsInput & {
            connectorName: string;
            actionName: string;
            propName: string;
            connectionId: string;
          },
          ctx,
        );
      }
      case 'resolve_dynamic_props': {
        const missing = ['connectorName', 'actionName', 'propName', 'connectionId'].filter(
          (k) => !(input as Record<string, unknown>)[k],
        );
        if (missing.length > 0) {
          return {
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message: `Missing required fields for action 'resolve_dynamic_props': ${missing.join(', ')}`,
            },
          };
        }
        return await resolveDynamicProps(
          input as ConnectionOpsInput & {
            connectorName: string;
            actionName: string;
            propName: string;
            connectionId: string;
          },
          ctx,
        );
      }
    }
  } catch (err) {
    const sanitized = sanitizeToolError(err);
    log.error('connection_ops_error', {
      action: input.action,
      projectId: ctx.projectId,
      code: sanitized.code,
      message: sanitized.message,
    });
    return {
      success: false,
      error: { code: sanitized.code, message: sanitized.message },
    };
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────

async function listConnections(ctx: ToolPermissionContext): Promise<ConnectionOpsResult> {
  // NEVER findById — scope by tenant + project for isolation.
  const connections = (await ConnectorConnection.find({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
  }).lean()) as Array<{
    _id: unknown;
    connectorName: string;
    displayName: string;
    authProfileId: string;
    scope: string;
    status: string;
  }>;
  return {
    success: true,
    data: {
      connections: connections.map((c) => ({
        id: String(c._id),
        connectorName: c.connectorName,
        displayName: c.displayName,
        authProfileId: c.authProfileId,
        scope: c.scope,
        status: c.status,
      })),
    },
  };
}

async function createConnection(
  input: ConnectionOpsInput & { connectorName: string; authProfileId: string },
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const service = await getConnectionService();
  // Default displayName to the connectorName when omitted — ConnectionService
  // requires a non-empty displayName.
  const displayName = input.displayName ?? input.connectorName;
  const connection = await service.create(
    ctx.user.tenantId,
    ctx.projectId,
    {
      connectorName: input.connectorName,
      authProfileId: input.authProfileId,
      displayName,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    ctx.user.userId,
  );

  const connectionId = String(connection._id);

  await syncActiveDraftFromConnection({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    userId: ctx.user.userId,
    connectionId,
  });

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);

  log.info('connection_created', {
    projectId: ctx.projectId,
    connectionId,
    connectorName: input.connectorName,
  });

  return {
    success: true,
    data: {
      connectionId,
      connectorName: connection.connectorName,
      authProfileId: connection.authProfileId,
      status: connection.status,
    },
  };
}

async function deleteConnection(
  input: ConnectionOpsInput & { connectionId: string },
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const service = await getConnectionService();
  const deleted = await service.delete(ctx.user.tenantId, ctx.projectId, input.connectionId);

  if (!deleted) {
    // Cross-scope misses surface as 404 to avoid leaking existence.
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Connection not found' },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);

  log.info('connection_deleted', {
    projectId: ctx.projectId,
    connectionId: input.connectionId,
  });

  return { success: true, data: { deleted: input.connectionId } };
}

async function resolveOptions(
  input: ConnectionOpsInput & {
    connectorName: string;
    actionName: string;
    propName: string;
    connectionId: string;
  },
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const url =
    `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(ctx.projectId)}` +
    `/connectors/${encodeURIComponent(input.connectorName)}` +
    `/actions/${encodeURIComponent(input.actionName)}` +
    `/props/${encodeURIComponent(input.propName)}/options`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {}),
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        propsValue: input.propsValue ?? {},
        searchValue: input.searchValue ?? '',
      }),
    });

    if (!response.ok) {
      log.warn('resolve_options_non_ok', {
        projectId: ctx.projectId,
        connectorName: input.connectorName,
        status: response.status,
      });
      return unavailableOptionsResult();
    }

    const body = (await response.json()) as Record<string, unknown>;
    return { success: true, data: body };
  } catch (err) {
    log.warn('resolve_options_failed', {
      projectId: ctx.projectId,
      connectorName: input.connectorName,
      error: err instanceof Error ? err.message : String(err),
    });
    return unavailableOptionsResult();
  }
}

async function resolveDynamicProps(
  input: ConnectionOpsInput & {
    connectorName: string;
    actionName: string;
    propName: string;
    connectionId: string;
  },
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  // NOTE: the upstream Studio proxy route is named "dynamic-fields", not
  // "dynamic-props". Keep the tool action name matching the spec while
  // pointing at the actual proxy path.
  const url =
    `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(ctx.projectId)}` +
    `/connectors/${encodeURIComponent(input.connectorName)}` +
    `/actions/${encodeURIComponent(input.actionName)}` +
    `/props/${encodeURIComponent(input.propName)}/dynamic-fields`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {}),
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        propsValue: input.propsValue ?? {},
      }),
    });

    if (!response.ok) {
      log.warn('resolve_dynamic_props_non_ok', {
        projectId: ctx.projectId,
        connectorName: input.connectorName,
        status: response.status,
      });
      return unavailableDynamicPropsResult();
    }

    const body = (await response.json()) as Record<string, unknown>;
    return { success: true, data: body };
  } catch (err) {
    log.warn('resolve_dynamic_props_failed', {
      projectId: ctx.projectId,
      connectorName: input.connectorName,
      error: err instanceof Error ? err.message : String(err),
    });
    return unavailableDynamicPropsResult();
  }
}
