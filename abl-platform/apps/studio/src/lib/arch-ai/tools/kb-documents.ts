import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { createKBApiClient, validatePathSegment } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-documents');

type DocumentAction = 'list' | 'status_summary' | 'reprocess' | 'delete';

interface KBDocumentsInput {
  action: DocumentAction;
  kbId?: string;
  kbName?: string;
  documentId?: string;
  documentIds?: string[];
  status?: string;
  limit?: number;
  offset?: number;
  confirmed?: boolean;
}

interface KBDocumentsEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
}

async function resolveKBAndIndex(
  input: { kbId?: string; kbName?: string },
  ctx: ToolPermissionContext,
  env: KBDocumentsEnv,
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

export async function executeKBDocuments(
  input: KBDocumentsInput,
  ctx: ToolPermissionContext,
  env: KBDocumentsEnv,
) {
  try {
    const perm = await checkToolPermission('kb_documents', input.action, ctx);
    if (!perm.allowed) {
      return {
        success: false,
        error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
      };
    }

    if (isDangerousAction('kb_documents', input.action) && !input.confirmed) {
      return {
        needsConfirmation: true,
        warning: `Delete document "${input.documentId}"? This will remove the document and its vectors permanently.`,
      };
    }

    switch (input.action) {
      case 'list': {
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const params = new URLSearchParams();
        if (input.status) params.set('status', input.status);
        if (input.limit) params.set('limit', String(input.limit));
        if (input.offset) params.set('offset', String(input.offset));
        const qs = params.toString() ? `?${params.toString()}` : '';

        const data = await idx.client!.get<Record<string, unknown>>(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/documents${qs}`,
        );
        return { success: true, data };
      }

      case 'status_summary': {
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await idx.client!.get<Record<string, unknown>>(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/documents/status-summary`,
        );
        return { success: true, data };
      }

      case 'reprocess': {
        if (!input.documentIds || input.documentIds.length === 0) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'documentIds is required for reprocess' },
          };
        }
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await idx.client!.post<Record<string, unknown>>(
          `/api/search-ai/projects/${ctx.projectId}/knowledge-bases/${idx.resolved!.kbId}/documents/bulk-reprocess`,
          { documentIds: input.documentIds },
        );
        log.info('Documents reprocessed via Arch', {
          kbId: idx.resolved!.kbId,
          count: input.documentIds.length,
        });
        return { success: true, data };
      }

      case 'delete': {
        if (!input.documentId) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'documentId is required for delete' },
          };
        }
        validatePathSegment(input.documentId, 'documentId');
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        await idx.client!.del(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/documents/${input.documentId}`,
        );
        log.info('Document deleted via Arch', {
          kbId: idx.resolved!.kbId,
          documentId: input.documentId,
        });
        return { success: true, data: { deleted: true } };
      }

      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('KB documents failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
