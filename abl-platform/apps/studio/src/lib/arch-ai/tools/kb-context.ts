import type { PageContext } from '@agent-platform/arch-ai';
import { createKBApiClient, validatePathSegment } from './kb-api-client';

interface KBContextInput {
  kbId?: string;
  kbName?: string;
}

interface KBContextEnv {
  pageContext: PageContext | null | undefined;
  projectId: string;
  authToken: string;
  tenantId: string;
  userId?: string;
}

interface KBContextResult {
  kbId: string | null;
  kbName?: string;
  source: 'explicit' | 'page_context' | 'auto_single' | 'needs_input';
  availableKBs?: Array<{ id: string; name: string }>;
}

export async function resolveKBContext(
  input: KBContextInput,
  env: KBContextEnv,
): Promise<KBContextResult> {
  if (input.kbId) {
    validatePathSegment(input.kbId, 'kbId');
    return { kbId: input.kbId, kbName: input.kbName, source: 'explicit' };
  }

  const entity = env.pageContext?.entity;
  if (entity?.type === 'knowledge_base' && entity.id) {
    return {
      kbId: entity.id,
      kbName: entity.name ?? undefined,
      source: 'page_context',
    };
  }

  const client = createKBApiClient({
    authToken: env.authToken,
    tenantId: env.tenantId,
    projectId: env.projectId,
    userId: env.userId,
  });

  const data = await client.get<{
    knowledgeBases: Array<{ _id: string; name: string }>;
    total: number;
  }>(`/api/search-ai/knowledge-bases?projectId=${env.projectId}`);

  if (data.knowledgeBases.length === 1) {
    const kb = data.knowledgeBases[0];
    return { kbId: kb._id, kbName: kb.name, source: 'auto_single' };
  }

  return {
    kbId: null,
    source: 'needs_input',
    availableKBs: data.knowledgeBases.map((kb) => ({
      id: kb._id,
      name: kb.name,
    })),
  };
}
