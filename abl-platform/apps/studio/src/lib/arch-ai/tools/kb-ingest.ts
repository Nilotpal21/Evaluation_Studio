import { createLogger } from '@abl/compiler/platform/logger.js';
import { attachmentFileStoreService, fileStoreService } from '@/lib/arch-ai/message-services';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createKBApiClient } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-ingest');

type IngestAction = 'upload_file' | 'add_url' | 'add_text' | 'list_sources';
type SourceType = 'manual' | 'web';

const ARCH_UPLOAD_SOURCE_NAME = 'Arch AI Uploads';
const ARCH_TEXT_SOURCE_NAME = 'Arch AI Notes';
const ARCH_URL_SOURCE_NAME = 'Arch AI URLs';

interface KBIngestInput {
  action: IngestAction;
  kbId?: string;
  kbName?: string;
  sourceId?: string;
  blobId?: string;
  fileName?: string;
  fileContent?: string;
  fileMimeType?: string;
  url?: string;
  urls?: string[];
  text?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

interface KBIngestEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
  sessionId?: string;
  lastCollectFileResult?: Array<{ name: string; type: string; content: string; size: number }>;
}

interface ResolvedSourceInfo {
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  created: boolean;
}

interface LoadedBlobFile {
  name: string;
  mediaType: string;
  size: number;
  buffer: Buffer;
}

type KBIndexResolution = NonNullable<Awaited<ReturnType<typeof resolveKBAndIndex>>['resolved']>;

const INLINE_TEXT_CONTENT_TYPE = 'text/plain';
const ARCH_URL_CRAWL_WARNING = 'Custom metadata is not attached to URL crawl jobs yet.';

function toBlobBytes(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.length);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function buildInlineTextFileName(title?: string): string {
  const normalizedTitle = (title ?? 'arch-note')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const baseName = normalizedTitle.length > 0 ? normalizedTitle : 'arch-note';
  return baseName.toLowerCase().endsWith('.txt') ? baseName : `${baseName}.txt`;
}

function buildUploadMetadata(
  metadata?: Record<string, unknown>,
  title?: string,
): Record<string, unknown> | undefined {
  const resolvedMetadata = metadata ? { ...metadata } : {};
  if (title && resolvedMetadata.title === undefined) {
    resolvedMetadata.title = title;
  }
  return Object.keys(resolvedMetadata).length > 0 ? resolvedMetadata : undefined;
}

async function uploadDocument(
  client: ReturnType<typeof createKBApiClient>,
  indexId: string,
  sourceId: string,
  file: { name: string; mediaType: string; buffer: Buffer },
  metadata?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([toBlobBytes(file.buffer)], { type: file.mediaType }),
    file.name,
  );
  if (metadata) {
    formData.append('metadata', JSON.stringify(metadata));
  }

  return client.postFormData<Record<string, unknown>>(
    `/api/search-ai/indexes/${indexId}/sources/${sourceId}/documents`,
    formData,
  );
}

function getPreferredSource(input: KBIngestInput): { name: string; sourceType: SourceType } {
  switch (input.action) {
    case 'add_url':
      return { name: ARCH_URL_SOURCE_NAME, sourceType: 'web' };
    case 'add_text':
      return { name: ARCH_TEXT_SOURCE_NAME, sourceType: 'manual' };
    case 'upload_file':
    default:
      return { name: ARCH_UPLOAD_SOURCE_NAME, sourceType: 'manual' };
  }
}

async function resolveKBAndIndex(
  input: { kbId?: string; kbName?: string },
  ctx: ToolPermissionContext,
  env: KBIngestEnv,
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
  const knowledgeBase = kb.knowledgeBase;
  const indexId = knowledgeBase.searchIndexId as string | undefined;
  if (!indexId) {
    return {
      resolved: null,
      error: {
        success: false as const,
        error: { code: 'NO_INDEX', message: 'Knowledge base has no search index yet' },
      },
    };
  }

  return {
    resolved: {
      kbId: resolved.kbId,
      kbName: String(knowledgeBase.name ?? input.kbName ?? ''),
      indexId,
    },
    client,
    error: null,
  };
}

async function resolveSource(
  input: KBIngestInput,
  ctx: ToolPermissionContext,
  idx: KBIndexResolution,
  env: KBIngestEnv,
): Promise<ResolvedSourceInfo> {
  if (input.sourceId) {
    return {
      sourceId: input.sourceId,
      sourceName: input.sourceId,
      sourceType: getPreferredSource(input).sourceType,
      created: false,
    };
  }

  const preferredSource = getPreferredSource(input);
  const client = createKBApiClient({
    authToken: env.authToken,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
  });
  const sourceType = preferredSource.sourceType;
  const sourceList = await client.get<{
    sources?: Array<Record<string, unknown>>;
  }>(
    `/api/search-ai/indexes/${idx.indexId}/sources?limit=200&sourceType=${encodeURIComponent(sourceType)}`,
  );
  const matchingSource = (sourceList.sources ?? []).find(
    (source) => String(source.name ?? '') === preferredSource.name,
  );

  if (matchingSource?._id) {
    return {
      sourceId: String(matchingSource._id),
      sourceName: String(matchingSource.name ?? preferredSource.name),
      sourceType,
      created: false,
    };
  }

  const created = await client.post<{
    source?: Record<string, unknown>;
  }>(`/api/search-ai/indexes/${idx.indexId}/sources`, {
    name: preferredSource.name,
    sourceType,
  });
  const createdSource = created.source;

  if (!createdSource?._id) {
    throw new Error('SearchAI source creation returned no source ID');
  }

  return {
    sourceId: String(createdSource._id),
    sourceName: String(createdSource.name ?? preferredSource.name),
    sourceType,
    created: true,
  };
}

async function loadBlobFile(
  blobId: string,
  ctx: ToolPermissionContext,
  env: KBIngestEnv,
): Promise<LoadedBlobFile> {
  const fileCtx = { tenantId: ctx.user.tenantId, userId: ctx.user.userId };
  const attachmentBlob = await attachmentFileStoreService.downloadBlobContent(fileCtx, blobId, {
    disposition: 'attachment',
  });

  if (attachmentBlob) {
    if (env.sessionId && String(attachmentBlob.mapping.sessionId) !== env.sessionId) {
      throw new Error(`Uploaded file ${blobId} belongs to a different Arch AI session`);
    }
    return {
      name: attachmentBlob.mapping.name,
      mediaType: attachmentBlob.mapping.mediaType || attachmentBlob.contentType,
      size: attachmentBlob.buffer.length,
      buffer: attachmentBlob.buffer,
    };
  }

  if (!env.sessionId) {
    throw new Error('Session context is required to resolve uploaded files');
  }

  const legacyFile = await fileStoreService.getByBlobId(fileCtx, env.sessionId, blobId);
  if (!legacyFile.content || legacyFile.content.length === 0) {
    throw new Error(`Uploaded file content is unavailable for blob ${blobId}`);
  }

  return {
    name: legacyFile.name,
    mediaType: legacyFile.mediaType,
    size: legacyFile.size,
    buffer: legacyFile.content,
  };
}

export async function executeKBIngest(
  input: KBIngestInput,
  ctx: ToolPermissionContext,
  env: KBIngestEnv,
) {
  try {
    const perm = await checkToolPermission('kb_ingest', input.action, ctx);
    if (!perm.allowed) {
      return {
        success: false,
        error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
      };
    }

    switch (input.action) {
      case 'list_sources': {
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await idx.client!.get<Record<string, unknown>>(
          `/api/search-ai/indexes/${idx.resolved!.indexId}/sources`,
        );
        return {
          success: true,
          data: {
            kbId: idx.resolved!.kbId,
            kbName: idx.resolved!.kbName,
            indexId: idx.resolved!.indexId,
            ...data,
          },
        };
      }

      case 'upload_file': {
        let resolvedFileContent = input.fileContent;
        let resolvedFileName = input.fileName;
        let resolvedMimeType = input.fileMimeType;

        if (!input.blobId && !resolvedFileContent && env.lastCollectFileResult?.length) {
          const lastFile = env.lastCollectFileResult[0];
          resolvedFileContent = lastFile.content;
          resolvedFileName = resolvedFileName ?? lastFile.name;
          resolvedMimeType = resolvedMimeType ?? lastFile.type;
          log.info('kb_ingest: auto-resolved file from last collect_file result', {
            fileName: resolvedFileName,
            mimeType: resolvedMimeType,
            size: lastFile.size,
          });
        }

        if (!input.blobId && !resolvedFileContent) {
          return {
            success: false,
            error: {
              code: 'MISSING_FILE',
              message:
                'No file available. Use collect_file first to get a file from the user, then call kb_ingest upload_file.',
            },
          };
        }
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;
        const source = await resolveSource(input, ctx, idx.resolved!, env);

        let fileName: string;
        let mediaType: string;
        let fileBuffer: Buffer;

        if (resolvedFileContent) {
          fileBuffer = Buffer.from(resolvedFileContent, 'base64');
          fileName = resolvedFileName ?? 'uploaded-file';
          mediaType = resolvedMimeType ?? 'application/octet-stream';
        } else {
          const blobFile = await loadBlobFile(input.blobId!, ctx, env);
          fileName = input.fileName ?? blobFile.name;
          mediaType = blobFile.mediaType;
          fileBuffer = blobFile.buffer;
        }

        const metadata = buildUploadMetadata(input.metadata, input.title);
        const uploadResult = await uploadDocument(
          idx.client!,
          idx.resolved!.indexId,
          source.sourceId,
          {
            name: fileName,
            mediaType,
            buffer: fileBuffer,
          },
          metadata,
        );
        log.info('KB file upload via Arch', {
          kbId: idx.resolved!.kbId,
          sourceId: source.sourceId,
          sourceCreated: source.created,
          blobId: input.blobId ?? null,
          fileName,
          directUpload: !!input.fileContent,
        });
        return {
          success: true,
          data: {
            kbId: idx.resolved!.kbId,
            kbName: idx.resolved!.kbName,
            indexId: idx.resolved!.indexId,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            sourceType: source.sourceType,
            sourceCreated: source.created,
            blobId: input.blobId ?? null,
            fileName,
            ...uploadResult,
          },
        };
      }

      case 'add_url': {
        const urls = input.urls ?? (input.url ? [input.url] : []);
        if (urls.length === 0) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'url or urls is required' },
          };
        }
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;
        const source = await resolveSource(input, ctx, idx.resolved!, env);
        const data = await idx.client!.post<Record<string, unknown>>('/api/search-ai/crawl/batch', {
          indexId: idx.resolved!.indexId,
          sourceId: source.sourceId,
          urls,
          strategy: 'single-page',
          options: {
            followLinks: false,
            useSitemap: false,
            maxPages: urls.length,
            extractMetadata: true,
          },
        });
        const warnings = input.metadata ? [ARCH_URL_CRAWL_WARNING] : [];
        log.info('KB URL ingest via Arch', {
          kbId: idx.resolved!.kbId,
          sourceId: source.sourceId,
          sourceCreated: source.created,
          urlCount: urls.length,
        });
        return {
          success: true,
          data: {
            kbId: idx.resolved!.kbId,
            kbName: idx.resolved!.kbName,
            indexId: idx.resolved!.indexId,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            sourceType: source.sourceType,
            sourceCreated: source.created,
            urls,
            warnings,
            ...data,
          },
        };
      }

      case 'add_text': {
        if (!input.text) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'text is required' },
          };
        }
        const idx = await resolveKBAndIndex(input, ctx, env);
        if (idx.error) return idx.error;
        const source = await resolveSource(input, ctx, idx.resolved!, env);
        const fileName = buildInlineTextFileName(input.title);
        const data = await uploadDocument(
          idx.client!,
          idx.resolved!.indexId,
          source.sourceId,
          {
            name: fileName,
            mediaType: INLINE_TEXT_CONTENT_TYPE,
            buffer: Buffer.from(input.text, 'utf-8'),
          },
          buildUploadMetadata(input.metadata, input.title),
        );
        log.info('KB text ingest via Arch', {
          kbId: idx.resolved!.kbId,
          sourceId: source.sourceId,
          sourceCreated: source.created,
          fileName,
        });
        return {
          success: true,
          data: {
            kbId: idx.resolved!.kbId,
            kbName: idx.resolved!.kbName,
            indexId: idx.resolved!.indexId,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            sourceType: source.sourceType,
            sourceCreated: source.created,
            fileName,
            ...data,
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
    log.error('KB ingest failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
