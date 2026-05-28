import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createKBApiClient, validatePathSegment } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-connector');

type ConnectorAction = 'list' | 'create' | 'auth' | 'sync_start' | 'sync_status' | 'sync_pause';

interface KBConnectorInput {
  action: ConnectorAction;
  kbId?: string;
  kbName?: string;
  connectorId?: string;
  connectorType?: string;
  connectorName?: string;
  config?: Record<string, unknown>;
  resume?: boolean;
}

interface KBConnectorEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
}

async function resolveKBAndIndex(
  input: { kbId?: string; kbName?: string },
  ctx: ToolPermissionContext,
  env: KBConnectorEnv,
) {
  const client = createKBApiClient({
    authToken: env.authToken,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
  });

  const resolved = await resolveKBContext(
    { kbId: input.kbId, kbName: input.kbName },
    {
      pageContext: env.pageContext,
      projectId: ctx.projectId,
      authToken: env.authToken,
      tenantId: ctx.user.tenantId,
      userId: ctx.user.userId,
    },
  );
  if (!resolved.kbId) {
    return {
      resolved: null,
      error: {
        success: false as const,
        needsInput: true,
        availableKBs: resolved.availableKBs,
        error: {
          code: 'KB_NOT_SPECIFIED',
          message:
            'Which knowledge base? ' +
            (resolved.availableKBs ?? []).map((kb) => `"${kb.name}"`).join(', '),
        },
      },
    };
  }

  const kb = await client.get<{
    knowledgeBase: Record<string, unknown>;
  }>(`/api/search-ai/knowledge-bases/${resolved.kbId}`);
  const indexId = kb.knowledgeBase.searchIndexId as string | undefined;
  if (!indexId) {
    return {
      resolved: null,
      error: {
        success: false as const,
        error: { code: 'NO_INDEX', message: 'Knowledge base has no search index yet' },
      },
    };
  }

  return { resolved: { kbId: resolved.kbId, indexId }, client, error: null };
}

export async function executeKBConnector(
  input: KBConnectorInput,
  ctx: ToolPermissionContext,
  env: KBConnectorEnv,
) {
  try {
    const perm = await checkToolPermission('kb_connector', input.action, ctx);
    if (!perm.allowed) {
      return {
        success: false,
        error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
      };
    }

    const client = createKBApiClient({
      authToken: env.authToken,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      userId: ctx.user.userId,
    });

    switch (input.action) {
      case 'list': {
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await client.get<Record<string, unknown>>(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/connectors`,
        );
        return { success: true, data };
      }

      case 'create': {
        if (!input.connectorType) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'connectorType is required' },
          };
        }
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await client.post<Record<string, unknown>>(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/connectors`,
          {
            type: input.connectorType,
            name: input.connectorName ?? input.connectorType,
            config: input.config ?? {},
          },
        );
        log.info('Connector created via Arch', {
          kbId: idx.resolved!.kbId,
          type: input.connectorType,
        });
        return { success: true, data };
      }

      case 'auth': {
        if (!input.connectorId) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'connectorId is required' },
          };
        }
        validatePathSegment(input.connectorId, 'connectorId');
        const data = await client.post<Record<string, unknown>>(
          `/api/search-ai/connectors/${input.connectorId}/auth/initiate`,
          {},
        );
        log.info('Connector auth initiated via Arch', { connectorId: input.connectorId });
        return { success: true, data };
      }

      case 'sync_start': {
        if (!input.connectorId) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'connectorId is required' },
          };
        }
        validatePathSegment(input.connectorId, 'connectorId');
        const data = await client.post<Record<string, unknown>>(
          `/api/search-ai/connectors/${input.connectorId}/sync/start`,
          {},
        );
        log.info('Connector sync started via Arch', { connectorId: input.connectorId });
        return { success: true, data };
      }

      case 'sync_status': {
        if (!input.connectorId) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'connectorId is required' },
          };
        }
        validatePathSegment(input.connectorId, 'connectorId');
        const data = await client.get<Record<string, unknown>>(
          `/api/search-ai/connectors/${input.connectorId}/sync/status`,
        );
        return { success: true, data };
      }

      case 'sync_pause': {
        if (!input.connectorId) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'connectorId is required' },
          };
        }
        validatePathSegment(input.connectorId, 'connectorId');
        const endpoint = input.resume ? 'resume' : 'pause';
        const data = await client.post<Record<string, unknown>>(
          `/api/search-ai/connectors/${input.connectorId}/sync/${endpoint}`,
          {},
        );
        log.info(`Connector sync ${endpoint} via Arch`, { connectorId: input.connectorId });
        return { success: true, data };
      }

      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('KB connector failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
