/**
 * SearchAI Tool Auto-Registration
 *
 * When a SearchIndex (KB) is created, automatically registers a project_tool
 * with type: 'searchai' so agents can discover and use it.
 *
 * When a SearchIndex is deleted, removes the corresponding project_tool.
 *
 * The tool DSL includes:
 * - Tool name: search_kb_{slug}
 * - Type: searchai
 * - index_id: the SearchIndex._id
 * - tenant_id: the tenant
 * - kb_name: display name
 */

import { createHash } from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { prepareProjectToolDslForPersistence } from '@agent-platform/shared';
import { getLazyModel } from '../db/index.js';

const ProjectTool = getLazyModel('ProjectTool');

const logger = createLogger('searchai-tool-registration');
const SEARCHAI_TOOL_NAME_PREFIX = 'search_kb_';
const MAX_PROJECT_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

function quoteDslString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Build DSL content for a SearchAI KB tool.
 */
function buildSearchAIToolDsl(params: {
  toolName: string;
  indexId: string;
  tenantId: string;
  kbName: string;
  description?: string;
}): string {
  const desc = params.description || `Search the "${params.kbName}" knowledge base`;
  return [
    `${params.toolName}(query: string, queryType?: string, filters?: object[], aggregation?: {field: string, function?: string}, rerank?: boolean, skipPreprocessing?: boolean, skipVocabularyResolution?: boolean) -> {results: object[], totalCount: number, queryType: string, aggregations?: object[]}`,
    `  description: ${quoteDslString(desc)}`,
    `  type: searchai`,
    `  index_id: ${quoteDslString(params.indexId)}`,
    `  tenant_id: ${quoteDslString(params.tenantId)}`,
    `  kb_name: ${quoteDslString(params.kbName)}`,
  ].join('\n');
}

/**
 * Generate a tool name from a KB slug.
 * Ensures it matches the project_tool name regex: /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/
 */
function toolNameFromSlug(slug: string): string {
  const normalizedSlug = slug.toLowerCase();
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const candidate = `${SEARCHAI_TOOL_NAME_PREFIX}${sanitized}`;
  const needsSuffix =
    !sanitized || candidate.length > MAX_PROJECT_TOOL_NAME_LENGTH || sanitized !== normalizedSlug;
  if (!needsSuffix) {
    return candidate;
  }

  const suffix = createHash('sha256')
    .update(slug || 'knowledge-base')
    .digest('hex')
    .slice(0, HASH_SUFFIX_LENGTH);
  const maxBaseLength =
    MAX_PROJECT_TOOL_NAME_LENGTH - SEARCHAI_TOOL_NAME_PREFIX.length - HASH_SUFFIX_LENGTH - 1;
  const base = sanitized.slice(0, maxBaseLength).replace(/_+$/g, '') || 'kb';
  return `${SEARCHAI_TOOL_NAME_PREFIX}${base}_${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIndexIdDslRegex(indexId: string): RegExp {
  return new RegExp(
    `(?:^|\\n)\\s*index_id\\s*:\\s*["']?${escapeRegExp(indexId)}["']?\\s*(?:\\n|$)`,
  );
}

/**
 * Register a SearchAI KB tool when an index is created.
 *
 * Creates a project_tool record with type: 'searchai' and the index binding.
 * Idempotent - if the tool already exists, it updates it.
 */
export async function registerSearchAITool(params: {
  indexId: string;
  tenantId: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  createdBy: string;
}): Promise<void> {
  const toolName = toolNameFromSlug(params.slug);
  const dslContent = buildSearchAIToolDsl({
    toolName,
    indexId: params.indexId,
    tenantId: params.tenantId,
    kbName: params.name,
    description: params.description ?? undefined,
  });
  const prepared = prepareProjectToolDslForPersistence({
    tenantId: params.tenantId,
    projectId: params.projectId,
    name: toolName,
    toolType: 'searchai',
    dslContent,
  });
  if (!prepared.valid) {
    const message = `Generated SearchAI KB tool DSL failed validation: ${prepared.message}`;
    logger.error('Generated SearchAI KB tool DSL failed validation', {
      toolName,
      indexId: params.indexId,
      error: prepared.message,
    });
    throw new Error(message);
  }

  try {
    await ProjectTool.findOneAndUpdate(
      {
        tenantId: params.tenantId,
        projectId: params.projectId,
        name: toolName,
        toolType: 'searchai',
        dslContent: { $regex: buildIndexIdDslRegex(params.indexId) },
      },
      {
        $set: {
          toolType: 'searchai',
          description: `Search the "${params.name}" knowledge base`,
          dslContent: prepared.dslContent,
          sourceHash: prepared.sourceHash,
          lastEditedBy: params.createdBy,
        },
        $setOnInsert: {
          slug: toolName,
          createdBy: params.createdBy,
        },
      },
      { upsert: true, new: true },
    );

    logger.info('SearchAI KB tool registered', {
      toolName,
      indexId: params.indexId,
      projectId: params.projectId,
    });
  } catch (error) {
    logger.error('Failed to register SearchAI KB tool', {
      error: error instanceof Error ? error.message : String(error),
      toolName,
      indexId: params.indexId,
    });
    throw error;
  }
}

/**
 * Unregister a SearchAI KB tool when an index is deleted.
 */
export async function unregisterSearchAITool(params: {
  indexId: string;
  tenantId: string;
  projectId: string;
  slug: string;
}): Promise<void> {
  const toolName = toolNameFromSlug(params.slug);

  try {
    const result = await ProjectTool.deleteOne({
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: toolName,
      toolType: 'searchai',
      dslContent: { $regex: buildIndexIdDslRegex(params.indexId) },
    });

    if (result.deletedCount > 0) {
      logger.info('SearchAI KB tool unregistered', {
        toolName,
        projectId: params.projectId,
      });
    }
  } catch (error) {
    logger.error('Failed to unregister SearchAI KB tool', {
      error: error instanceof Error ? error.message : String(error),
      toolName,
    });
    throw error;
  }
}
