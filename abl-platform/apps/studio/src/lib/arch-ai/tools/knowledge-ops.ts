import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:knowledge-ops');

interface KnowledgeOpsInput {
  action: 'list' | 'create' | 'add_document' | 'query' | 'delete';
  kbId?: string;
  kbName?: string;
  documentUrl?: string;
  documentContent?: string;
  queryText?: string;
  confirmed?: boolean;
}

interface KnowledgeOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

export async function executeKnowledgeOps(
  input: KnowledgeOpsInput,
  ctx: ToolPermissionContext,
): Promise<KnowledgeOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('knowledge_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (isDangerousAction('knowledge_ops', action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Delete knowledge base "${input.kbName ?? input.kbId}"? All documents will be removed.`,
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  switch (action) {
    case 'list':
      return listKnowledgeBases(projectId, tenantId);
    case 'create':
      if (!input.kbName) {
        return { success: false, error: { code: 'MISSING_PARAM', message: 'kbName is required' } };
      }
      return createKnowledgeBase(projectId, input.kbName, tenantId);
    case 'add_document':
      if (!input.kbId) {
        return { success: false, error: { code: 'MISSING_PARAM', message: 'kbId is required' } };
      }
      return addDocument(input.kbId, input.documentUrl, input.documentContent, tenantId);
    case 'query':
      if (!input.kbId || !input.queryText) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'kbId and queryText are required' },
        };
      }
      return queryKnowledgeBase(input.kbId, input.queryText, tenantId);
    case 'delete':
      if (!input.kbId) {
        return { success: false, error: { code: 'MISSING_PARAM', message: 'kbId is required' } };
      }
      return deleteKnowledgeBase(input.kbId, tenantId);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function listKnowledgeBases(
  projectId: string,
  tenantId: string,
): Promise<KnowledgeOpsResult> {
  try {
    const { fetchKnowledgeBases } = await import('@/api/search-ai');
    const result = await fetchKnowledgeBases(projectId);
    // Strict tenant filter — only include KBs with matching tenantId
    const tenantKbs = result.knowledgeBases.filter((kb) => kb.tenantId === tenantId);
    return {
      success: true,
      data: {
        total: tenantKbs.length,
        knowledgeBases: tenantKbs.map((kb) => ({
          id: kb._id,
          name: kb.name,
          description: kb.description ?? null,
          status: kb.status,
        })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'FETCH_ERROR', message } };
  }
}

async function createKnowledgeBase(
  projectId: string,
  kbName: string,
  tenantId: string,
): Promise<KnowledgeOpsResult> {
  try {
    const { createKnowledgeBase: createKB } = await import('@/api/search-ai');
    const result = await createKB({ tenantId, projectId, name: kbName });
    log.info('Knowledge base created', { projectId, kbName });
    return { success: true, data: { created: true, ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'CREATE_ERROR', message } };
  }
}

async function addDocument(
  kbId: string,
  documentUrl: string | undefined,
  documentContent: string | undefined,
  tenantId: string,
): Promise<KnowledgeOpsResult> {
  try {
    const { getKnowledgeBase, addSource } = await import('@/api/search-ai');
    // Verify KB ownership before mutating
    const { knowledgeBase } = await getKnowledgeBase(kbId);
    if (knowledgeBase.tenantId !== tenantId) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      };
    }
    const sourceType = documentUrl ? 'url' : 'text';
    const sourceConfig: Record<string, unknown> = {};
    if (documentUrl) sourceConfig.url = documentUrl;
    if (documentContent) sourceConfig.content = documentContent;
    const result = await addSource(kbId, {
      name: documentUrl ?? 'uploaded-document',
      sourceType,
      sourceConfig,
    });
    log.info('Document added to KB', { kbId });
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'ADD_DOC_ERROR', message } };
  }
}

async function queryKnowledgeBase(
  kbId: string,
  queryText: string,
  tenantId: string,
): Promise<KnowledgeOpsResult> {
  try {
    const { getKnowledgeBase, executeQuery } = await import('@/api/search-ai');
    // Verify KB ownership before querying
    const { knowledgeBase } = await getKnowledgeBase(kbId);
    if (knowledgeBase.tenantId !== tenantId) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      };
    }
    const result = await executeQuery(kbId, { query: queryText });
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'QUERY_ERROR', message } };
  }
}

async function deleteKnowledgeBase(kbId: string, tenantId: string): Promise<KnowledgeOpsResult> {
  try {
    const { getKnowledgeBase, deleteKnowledgeBase: deleteKB } = await import('@/api/search-ai');
    // Verify KB ownership before deleting
    const { knowledgeBase } = await getKnowledgeBase(kbId);
    if (knowledgeBase.tenantId !== tenantId) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Knowledge base not found' },
      };
    }
    await deleteKB(kbId);
    log.info('Knowledge base deleted', { kbId, tenantId });
    return { success: true, data: { deleted: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'DELETE_ERROR', message } };
  }
}
