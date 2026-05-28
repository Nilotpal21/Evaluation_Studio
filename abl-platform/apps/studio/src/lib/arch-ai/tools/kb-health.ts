import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createKBApiClient, validatePathSegment } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-health');

type HealthAction = 'summary' | 'errors' | 'retry_failed' | 'sync_counters' | 'check_operation';

interface KBHealthInput {
  action: HealthAction;
  kbId?: string;
  kbName?: string;
  connectorId?: string;
  jobId?: string;
  documentIds?: string[];
}

interface KBHealthEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
}

export async function executeKBHealth(
  input: KBHealthInput,
  ctx: ToolPermissionContext,
  env: KBHealthEnv,
) {
  try {
    const perm = await checkToolPermission('kb_health', input.action, ctx);
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

    switch (input.action) {
      case 'summary': {
        const data = await client.get<Record<string, unknown>>(
          `/api/search-ai/knowledge-bases/${resolved.kbId}/health-summary`,
        );
        return { success: true, data };
      }

      case 'errors': {
        const data = await client.get<Record<string, unknown>>(
          `/api/search-ai/admin/errors?knowledgeBaseId=${resolved.kbId}`,
        );
        return { success: true, data };
      }

      case 'retry_failed': {
        if (!input.documentIds || input.documentIds.length === 0) {
          return {
            success: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'documentIds is required for retry_failed',
            },
          };
        }
        const data = await client.post<Record<string, unknown>>(
          `/api/search-ai/projects/${ctx.projectId}/knowledge-bases/${resolved.kbId}/documents/bulk-reprocess`,
          { documentIds: input.documentIds },
        );
        log.info('KB retry_failed via Arch', {
          kbId: resolved.kbId,
          count: input.documentIds.length,
        });
        return { success: true, data };
      }

      case 'sync_counters': {
        const summary = await client.get<Record<string, unknown>>(
          `/api/search-ai/knowledge-bases/${resolved.kbId}/health-summary`,
        );
        return {
          success: true,
          data: {
            kbId: resolved.kbId,
            counters: summary,
          },
        };
      }

      case 'check_operation': {
        if (input.jobId) {
          validatePathSegment(input.jobId, 'jobId');
          const data = await client.get<Record<string, unknown>>(
            `/api/search-ai/jobs/${input.jobId}`,
          );
          return { success: true, data };
        }
        if (input.connectorId) {
          validatePathSegment(input.connectorId, 'connectorId');
          const data = await client.get<Record<string, unknown>>(
            `/api/search-ai/connectors/${input.connectorId}/sync/status`,
          );
          return { success: true, data };
        }
        return {
          success: false,
          error: {
            code: 'MISSING_PARAM',
            message: 'Either jobId or connectorId is required for check_operation',
          },
        };
      }

      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('KB health failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
