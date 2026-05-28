import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { createKBApiClient } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-manage');

type ManageAction = 'list' | 'create' | 'get' | 'update' | 'delete';

interface KBManageInput {
  action: ManageAction;
  kbId?: string;
  kbName?: string;
  description?: string;
  confirmed?: boolean;
}

interface KBToolEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
}

export async function executeKBManage(
  input: KBManageInput,
  ctx: ToolPermissionContext,
  env: KBToolEnv,
) {
  try {
    const perm = await checkToolPermission('kb_manage', input.action, ctx);
    if (!perm.allowed) {
      return {
        success: false,
        error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
      };
    }

    if (isDangerousAction('kb_manage', input.action) && !input.confirmed) {
      return {
        needsConfirmation: true,
        warning: `Delete knowledge base "${input.kbName ?? input.kbId}"? All documents and indexes will be permanently removed.`,
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
        const data = await client.get<{
          knowledgeBases: Array<Record<string, unknown>>;
          total: number;
        }>(`/api/search-ai/knowledge-bases?projectId=${ctx.projectId}`);
        const tenantKbs = data.knowledgeBases.filter((kb) => kb.tenantId === ctx.user.tenantId);
        return {
          success: true,
          data: {
            total: tenantKbs.length,
            knowledgeBases: tenantKbs.map((kb) => ({
              id: kb._id,
              name: kb.name,
              description: kb.description ?? null,
              status: kb.status,
              documentCount: kb.documentCount ?? 0,
            })),
          },
        };
      }

      case 'create': {
        if (!input.kbName) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'kbName is required' },
          };
        }
        const result = await client.post<{
          knowledgeBase: Record<string, unknown>;
        }>('/api/search-ai/knowledge-bases', {
          projectId: ctx.projectId,
          name: input.kbName,
          description: input.description ?? undefined,
        });
        log.info('KB created via Arch', {
          kbId: result.knowledgeBase._id,
          name: input.kbName,
        });
        return { success: true, data: result };
      }

      case 'get': {
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
            success: false,
            needsInput: true,
            availableKBs: resolved.availableKBs,
            error: {
              code: 'KB_NOT_SPECIFIED',
              message:
                'Which knowledge base? ' +
                (resolved.availableKBs ?? []).map((kb) => `"${kb.name}"`).join(', '),
            },
          };
        }
        const data = await client.get<{
          knowledgeBase: Record<string, unknown>;
        }>(`/api/search-ai/knowledge-bases/${resolved.kbId}`);
        return { success: true, data };
      }

      case 'update': {
        const resolved = await resolveKBContext(
          { kbId: input.kbId },
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
            success: false,
            error: { code: 'KB_NOT_SPECIFIED', message: 'kbId is required' },
          };
        }
        const updates: Record<string, unknown> = {};
        if (input.kbName !== undefined) updates.name = input.kbName;
        if (input.description !== undefined) updates.description = input.description;
        const data = await client.patch<{
          knowledgeBase: Record<string, unknown>;
        }>(`/api/search-ai/knowledge-bases/${resolved.kbId}`, updates);
        return { success: true, data };
      }

      case 'delete': {
        const resolved = await resolveKBContext(
          { kbId: input.kbId },
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
            success: false,
            error: { code: 'KB_NOT_SPECIFIED', message: 'kbId is required' },
          };
        }
        await client.del(`/api/search-ai/knowledge-bases/${resolved.kbId}`);
        log.info('KB deleted via Arch', { kbId: resolved.kbId });
        return { success: true, data: { deleted: true } };
      }

      default:
        return {
          success: false,
          error: {
            code: 'INVALID_ACTION',
            message: `Unknown action: ${input.action}`,
          },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('KB manage failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
