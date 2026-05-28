/**
 * Project Import/Export Public API
 *
 * REST endpoints for programmatic project import/export, usable by
 * external customers, CLI tools, and AI agents.
 *
 * Mounted at /api/projects/:projectId/project-io
 *
 * GET  /export/preview  — Metadata preview (agents, tools, deps)
 * GET  /export          — Full export (file map + manifest + lockfile)
 * POST /import/preview  — Dry-run import (preview changes)
 * POST /import          — Apply import (create/update/delete agents + tools)
 */

import express, {
  type Router as RouterType,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import {
  buildProjectAgentPath,
  isProjectToolType,
  prepareProjectToolDslForPersistence,
} from '@agent-platform/shared';
import {
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseDslProperties,
  validateSearchAIToolBinding,
  validateWorkflowToolBinding,
  type SearchAIIndexesRepo,
  type TriggerRegistrationsRepo,
  type WorkflowVersionsRepo,
  type WorkflowsRepo,
} from '@agent-platform/shared/tools';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import {
  MCPServerConfig,
  ProjectAgent,
  ProjectConfigVariable,
  AgentModelConfig,
  ModelConfig,
  TenantModel,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  ProjectTool,
  PromptLibraryItem,
  PromptLibraryVersion,
  SearchIndex,
  TriggerRegistration,
  Workflow,
  WorkflowVersion,
  ConnectorConfig,
  Project,
  type IMCPServerConfig,
  type IProjectAgent,
  type IProjectTool,
  type ProjectToolType,
  type IProject,
} from '@agent-platform/database/models';
import {
  LAYER_DEFAULTS,
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
  type ExportDslFormat,
  type LayerName,
} from '@agent-platform/project-io';
import {
  buildDefaultAssemblerMap,
  buildExportProvisioningRequirements,
  buildLayerPreview,
  exportProjectV2,
  extractProfileManifestEntries,
  resolveLayers,
  resolveLayersForToolDependencies,
  type ExportV2Deps,
} from '@agent-platform/project-io/export';
import {
  buildDependencyGraph,
  validateDependencies,
} from '@agent-platform/project-io/dependencies';
import {
  MCP_SERVER_CONFIG_EXPORT_SELECT,
  applyCoreImportV2,
  behaviorProfileConfigKeyToName,
  collectImportedProjectModelIds,
  collectImportedPromptVersionSnapshots,
  behaviorProfileNameToConfigKey,
  localeAssetRelativePathToConfigKey,
  normalizeMcpServerConfigForIO,
  previewCoreImportV2,
  resolveAdvancedNluEntitlement,
  type CoreImportApplyAdapterV2,
  type CoreImportApplyPlanV2,
  type CoreImportRuntimeConfigSaveValidationResultV2,
  type CoreImportSnapshotStateV2,
  type CoreImportRuntimeConfigSaveValidatorV2,
  type CoreImportToolBindingSaveValidatorV2,
  type CoreImportToolOperationV2,
  type CoreImportToolWriteOperationV2,
  type ProjectIOMcpServerConfig,
} from '@agent-platform/project-io/import';
import { getRedisClient } from '../services/redis/redis-client.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';
import { getOrCreateDefaultNamespace } from '../repos/variable-namespace-repo.js';
import {
  evaluateRuntimeProjectAgentDrafts,
  mergeProjectAgentDraftStates,
  toProjectAgentDraftState,
} from '../services/session/project-agent-draft-metadata.js';
import { validateProjectRuntimeConfigWrite } from '../services/config/project-runtime-config-write-validation.js';

const log = createLogger('project-io-route');

async function getOrCreateDefaultVariableNamespaceIds(params: {
  tenantId: string;
  projectId: string;
  createdBy: string;
}): Promise<string[]> {
  try {
    const namespace = await getOrCreateDefaultNamespace(
      params.tenantId,
      params.projectId,
      params.createdBy,
    );
    return namespace?._id ? [String(namespace._id)] : [];
  } catch (err) {
    log.warn('Failed to get or create default variable namespace for project import', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// =============================================================================
// OPENAPI ROUTER
// =============================================================================

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/project-io',
  tags: ['Project Import/Export'],
});
const router: RouterType = openapi.router;

// Middleware chain (same as all other Runtime project-scoped routes)
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// CONSTANTS
// =============================================================================

// Export guards — prevent memory exhaustion on very large projects
const MAX_EXPORT_AGENTS = 1000;
const MAX_EXPORT_TOOLS = 500;
const MAX_EXPORT_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

const VALID_LAYERS: Set<string> = new Set(Object.keys(LAYER_DEFAULTS));

const validateRuntimeToolBindingForSave: CoreImportToolBindingSaveValidatorV2 = async ({
  tenantId,
  projectId,
  toolType,
  dslContent,
}) => {
  if (toolType === 'workflow') {
    try {
      const binding = buildWorkflowBindingFromProps(parseDslProperties(dslContent));
      const workflowsRepo: WorkflowsRepo = {
        findOne: (filter) => Workflow.findOne(filter).lean(),
      };
      const workflowVersionsRepo: WorkflowVersionsRepo = {
        findOne: (filter) => WorkflowVersion.findOne(filter).lean(),
      };
      const triggerRegistrationsRepo: TriggerRegistrationsRepo = {
        findOne: (filter) => TriggerRegistration.findOne(filter).lean(),
      };
      const result = await validateWorkflowToolBinding(
        {
          workflowId: binding.workflowId,
          workflowVersionId: binding.workflowVersionId,
          workflowVersion: binding.workflowVersion,
          triggerId: binding.triggerId,
        },
        {
          tenantId,
          projectId,
          workflowsRepo,
          workflowVersionsRepo,
          triggerRegistrationsRepo,
        },
      );

      if (!result.valid) {
        return {
          valid: false,
          status: result.error.code === 'WORKFLOW_NOT_FOUND' ? 404 : 400,
          code: result.error.code,
          message: result.error.message,
        };
      }
    } catch (err) {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_TOOL_BINDING',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (toolType === 'searchai') {
    try {
      const binding = buildSearchAIBindingFromProps(parseDslProperties(dslContent));
      const searchIndexesRepo: SearchAIIndexesRepo = {
        findOne: (filter) => SearchIndex.findOne(filter).lean(),
      };
      const result = await validateSearchAIToolBinding(binding, {
        tenantId,
        projectId,
        searchIndexesRepo,
      });

      if (!result.valid) {
        return {
          valid: false,
          status: result.error.code === 'SEARCHAI_INDEX_NOT_FOUND' ? 404 : 400,
          code: result.error.code,
          message: result.error.message,
        };
      }
    } catch (err) {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_TOOL_BINDING',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { valid: true };
};

const validateRuntimeConfigForSave: CoreImportRuntimeConfigSaveValidatorV2 = async ({
  tenantId,
  projectId,
  data,
}) => {
  const result = await validateProjectRuntimeConfigWrite({ tenantId, projectId, data });
  if (!result.valid) {
    return {
      valid: false,
      status: result.status,
      code: result.code,
      message: result.message,
    };
  }
  const entitlementFailure = await validateAdvancedNluEntitlementForImport(tenantId, result.data);
  if (entitlementFailure) {
    return entitlementFailure;
  }
  return { valid: true, data: result.data };
};

function createRuntimeConfigImportValidator(
  files: ReadonlyMap<string, string>,
): CoreImportRuntimeConfigSaveValidatorV2 {
  const importedPromptVersions = collectImportedPromptVersionSnapshots(files);
  const importedProjectModelIds = collectImportedProjectModelIds(files);

  return async ({ tenantId, projectId, data }) => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId,
      projectId,
      data,
      importedPromptVersions,
      importedProjectModelIds,
    });
    if (!result.valid) {
      return {
        valid: false,
        status: result.status,
        code: result.code,
        message: result.message,
      };
    }

    const entitlementFailure = await validateAdvancedNluEntitlementForImport(tenantId, result.data);
    if (entitlementFailure) {
      return entitlementFailure;
    }

    return { valid: true, data: result.data };
  };
}

function parseProjectAgentActiveVersions(
  activeVersions: IProjectAgent['activeVersions'],
): Record<string, string> {
  if (!activeVersions) {
    return {};
  }

  if (typeof activeVersions === 'string') {
    try {
      const parsed = JSON.parse(activeVersions) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
        ),
      );
    } catch {
      return {};
    }
  }

  return Object.fromEntries(
    Object.entries(activeVersions as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

function getProjectAgentExportVersion(agent: IProjectAgent): string {
  const activeVersions = parseProjectAgentActiveVersions(agent.activeVersions);
  return (
    activeVersions.default ??
    activeVersions.production ??
    activeVersions.staging ??
    activeVersions.dev ??
    Object.values(activeVersions)[0] ??
    '1.0'
  );
}

// Import guards — prevent abuse and protect server resources
const MAX_IMPORT_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_IMPORT_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total content
const MAX_IMPORT_FILE_COUNT = 500;
const MAX_IMPORT_BODY_SIZE = 60 * 1024 * 1024; // 60MB (JSON overhead above 50MB content)

// Concurrent import lock
const IMPORT_LOCK_TTL_SECONDS = 120; // 2 minutes max
const IMPORT_LOCK_PREFIX = 'import:lock:';
const MODEL_POLICY_INTERNAL_KEYS = new Set([
  '_id',
  '__v',
  'projectId',
  'tenantId',
  'createdAt',
  'updatedAt',
]);

function parseLayers(raw: string | undefined): LayerName[] | undefined {
  if (!raw) return undefined;

  const layers = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => VALID_LAYERS.has(name));
  return layers.length > 0 ? (layers as LayerName[]) : undefined;
}

function parseDslFormat(raw: string | undefined): ExportDslFormat {
  return raw === 'yaml' ? 'yaml' : 'source';
}

function sanitizeModelPolicyData(value: unknown): Record<string, unknown> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !MODEL_POLICY_INTERNAL_KEYS.has(key)),
  );
}

const PROJECT_MODEL_POLICY_REFERENCE_KEYS = new Set([
  'tenantModelId',
  'credentialId',
  'authProfileId',
]);

function sanitizeProjectModelPolicyData(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitizeModelPolicyData(value)).filter(
      ([key]) => !PROJECT_MODEL_POLICY_REFERENCE_KEYS.has(key),
    ),
  );
}

function isRealtimeVoiceProjectModel(data: Record<string, unknown>): boolean {
  return data.tier === 'voice';
}

function hasRealtimeVoiceCapability(model: Record<string, unknown>): boolean {
  return Array.isArray(model.capabilities) && model.capabilities.includes('realtime_voice');
}

async function resolveDestinationTenantModelIdForImport(input: {
  data: Record<string, unknown>;
  tenantId: string;
  modelConfigName: string;
}): Promise<string | null> {
  const provider = typeof input.data.provider === 'string' ? input.data.provider.trim() : '';
  const modelId = typeof input.data.modelId === 'string' ? input.data.modelId.trim() : '';

  if (!provider || !modelId) {
    throw new Error(
      `Project model config "${input.modelConfigName}" must include provider and modelId for portable import binding`,
    );
  }

  const candidates = (await TenantModel.find({
    tenantId: input.tenantId,
    provider,
    modelId,
    isActive: true,
    inferenceEnabled: { $ne: false },
  }).lean()) as Array<Record<string, unknown>>;

  const usable = isRealtimeVoiceProjectModel(input.data)
    ? candidates.filter(hasRealtimeVoiceCapability)
    : candidates;

  if (usable.length !== 1) {
    return null;
  }

  const id = usable[0]._id ?? usable[0].id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return id;
}

function hasOperationTierOverrides(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, 'operationTierOverrides');
}

function hasModelPolicyMutations(applied: {
  modelPoliciesUpserted?: number;
  modelPoliciesDeleted?: number;
}): boolean {
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

async function validateAdvancedNluEntitlementForImport(
  tenantId: string,
  config: Record<string, unknown> | undefined,
): Promise<CoreImportRuntimeConfigSaveValidationResultV2 | null> {
  const extraction = config?.extraction;
  if (
    typeof extraction !== 'object' ||
    extraction === null ||
    (extraction as Record<string, unknown>).nlu_provider !== 'advanced'
  ) {
    return null;
  }

  const entitlement = await resolveAdvancedNluEntitlement(tenantId);
  if (entitlement.allowed) {
    return null;
  }

  return {
    valid: false,
    status: 403,
    code: 'PLAN_FEATURE_UNAVAILABLE',
    message: 'Advanced NLU provider requires an Enterprise plan',
  };
}

async function verifyProjectModelConfigScope(projectId: string, tenantId: string): Promise<void> {
  const project = await Project.findOne({ _id: projectId, tenantId }).select('_id').lean();
  if (!project) {
    throw new Error('Project not found for tenant-scoped model config import');
  }
}

async function loadProjectModelConfigs(projectId: string, tenantId: string) {
  await verifyProjectModelConfigScope(projectId, tenantId);
  return ModelConfig.find({ projectId, tenantId }).lean() as Promise<
    Array<Record<string, unknown>>
  >;
}

function buildPromptBundles(
  promptItems: Array<{
    _id?: string;
    name?: string;
    description?: string;
    tags?: string[];
    status?: 'active' | 'archived';
    nextVersionNumber?: number;
  }>,
  promptVersions: Array<{
    _id?: string;
    promptId?: string;
    versionNumber?: number;
    template?: string;
    variables?: string[];
    description?: string;
    status?: 'draft' | 'active' | 'archived';
    sourceHash?: string;
    metadata?: Record<string, unknown> | null;
    publishedAt?: Date | null;
  }>,
) {
  const versionsByPromptId = new Map<
    string,
    Array<{
      versionId: string;
      versionNumber: number;
      template: string;
      variables: string[];
      description?: string;
      status: 'draft' | 'active' | 'archived';
      sourceHash: string;
      metadata?: Record<string, unknown>;
      publishedAt?: string;
    }>
  >();

  for (const version of promptVersions) {
    if (
      typeof version._id !== 'string' ||
      typeof version.promptId !== 'string' ||
      typeof version.versionNumber !== 'number' ||
      typeof version.template !== 'string' ||
      typeof version.sourceHash !== 'string'
    ) {
      continue;
    }

    versionsByPromptId.set(version.promptId, [
      ...(versionsByPromptId.get(version.promptId) ?? []),
      {
        versionId: version._id,
        versionNumber: version.versionNumber,
        template: version.template,
        variables: Array.isArray(version.variables) ? version.variables : [],
        ...(typeof version.description === 'string' ? { description: version.description } : {}),
        status: version.status ?? 'draft',
        sourceHash: version.sourceHash,
        ...(version.metadata && typeof version.metadata === 'object'
          ? { metadata: version.metadata }
          : {}),
        ...(version.publishedAt instanceof Date
          ? { publishedAt: version.publishedAt.toISOString() }
          : {}),
      },
    ]);
  }

  return promptItems
    .map((item) => {
      if (typeof item._id !== 'string' || typeof item.name !== 'string') {
        return null;
      }

      return {
        promptId: item._id,
        name: item.name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        tags: Array.isArray(item.tags) ? item.tags : [],
        status: item.status ?? 'active',
        nextVersionNumber: item.nextVersionNumber ?? 0,
        versions: (versionsByPromptId.get(item._id) ?? []).sort(
          (left, right) => left.versionNumber - right.versionNumber,
        ),
      };
    })
    .filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null);
}

// =============================================================================
// BODY PARSER FOR IMPORT ROUTES
// =============================================================================

const importBodyParser = express.json({ limit: '60mb' });

/**
 * Handle JSON parse errors from the import body parser.
 * Express.json throws SyntaxError for malformed JSON and
 * a type:'entity.too.large' error when limit is exceeded.
 */
function importBodyErrorHandler(
  err: Error & { type?: string },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!err) {
    next();
    return;
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' },
    });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: {
        code: 'BODY_TOO_LARGE',
        message: `Request body too large (max ${MAX_IMPORT_BODY_SIZE / 1024 / 1024}MB)`,
      },
    });
    return;
  }

  next(err);
}

/**
 * Reject requests with Content-Length exceeding the import limit
 * before Express buffers the body.
 */
function rejectOversizedContentLength(req: Request, res: Response, next: NextFunction): void {
  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength, 10) > MAX_IMPORT_BODY_SIZE) {
    res.status(413).json({
      success: false,
      error: {
        code: 'BODY_TOO_LARGE',
        message: `Request body too large (max ${MAX_IMPORT_BODY_SIZE / 1024 / 1024}MB)`,
      },
    });
    return;
  }
  next();
}

// =============================================================================
// DISTRIBUTED LOCK FOR CONCURRENT IMPORT PROTECTION
// =============================================================================

/**
 * Lua script for atomic lock release: only deletes the key if
 * the value matches our lock owner token. Same pattern as session-lock.ts.
 */
const RELEASE_LOCK_SCRIPT = [
  'if redis.call("get", KEYS[1]) == ARGV[1] then',
  '  return redis.call("del", KEYS[1])',
  'else',
  '  return 0',
  'end',
].join('\n');

async function acquireImportLock(projectId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return 'no-redis'; // Allow in dev without Redis

  const lockKey = `${IMPORT_LOCK_PREFIX}${projectId}`;
  const lockOwner = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(lockKey, lockOwner, 'EX', IMPORT_LOCK_TTL_SECONDS, 'NX');
  return acquired ? lockOwner : null;
}

async function releaseImportLock(projectId: string, lockOwner: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || lockOwner === 'no-redis') return;

  const lockKey = `${IMPORT_LOCK_PREFIX}${projectId}`;
  // Atomic release: only delete if we still own the lock (prevents releasing after TTL expiry)
  await (redis as any).call('EVAL', RELEASE_LOCK_SCRIPT, '1', lockKey, lockOwner);
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

interface ValidatedImportFiles {
  files: Map<string, string>;
  entries: [string, string][];
  deleteUnmatched: boolean;
  layers?: LayerName[];
}

function validateImportPayload(
  body: unknown,
  res: Response,
  defaultDeleteUnmatched: boolean,
): ValidatedImportFiles | null {
  if (!body || typeof body !== 'object' || !('files' in body)) {
    res.status(400).json({
      success: false,
      error: { code: 'MISSING_FILES', message: 'Request body must contain a "files" object' },
    });
    return null;
  }

  const payload = body as { files: unknown; deleteUnmatched?: unknown; layers?: unknown };
  const filesObj = payload.files;
  if (!filesObj || typeof filesObj !== 'object') {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_FILES_TYPE',
        message: '"files" must be an object mapping paths to content strings',
      },
    });
    return null;
  }

  const entries = Object.entries(filesObj as Record<string, unknown>);

  if (entries.length === 0) {
    res
      .status(400)
      .json({ success: false, error: { code: 'EMPTY_FILES', message: 'No files provided' } });
    return null;
  }
  if (entries.length > MAX_IMPORT_FILE_COUNT) {
    res.status(400).json({
      success: false,
      error: {
        code: 'TOO_MANY_FILES',
        message: `Too many files (${entries.length}, max ${MAX_IMPORT_FILE_COUNT})`,
      },
    });
    return null;
  }

  let totalSize = 0;
  for (const [filePath, content] of entries) {
    if (typeof content !== 'string') {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FILE_CONTENT',
          message: `File content must be a string: ${filePath}`,
        },
      });
      return null;
    }

    // Path traversal prevention
    if (
      filePath.includes('..') ||
      filePath.startsWith('/') ||
      filePath.includes('\0') ||
      filePath.includes('\\')
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'PATH_TRAVERSAL',
          message: `Invalid file path (path traversal detected): ${filePath}`,
        },
      });
      return null;
    }

    if (content.length > MAX_IMPORT_FILE_SIZE) {
      res.status(400).json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File too large (max 1MB): ${filePath} (${(content.length / 1024 / 1024).toFixed(1)}MB)`,
        },
      });
      return null;
    }

    totalSize += content.length;
    if (totalSize > MAX_IMPORT_TOTAL_SIZE) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TOTAL_SIZE_EXCEEDED',
          message: `Total content size exceeds 50MB (at ${filePath})`,
        },
      });
      return null;
    }
  }

  if (payload.deleteUnmatched !== undefined && typeof payload.deleteUnmatched !== 'boolean') {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_DELETE_UNMATCHED',
        message: '"deleteUnmatched" must be a boolean when provided',
      },
    });
    return null;
  }

  let layers: LayerName[] | undefined;
  if (payload.layers !== undefined) {
    if (
      !Array.isArray(payload.layers) ||
      !payload.layers.every((layer) => typeof layer === 'string')
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LAYERS',
          message: '"layers" must be an array of layer names when provided',
        },
      });
      return null;
    }

    const invalidLayers = payload.layers.filter((layer) => !VALID_LAYERS.has(layer));
    if (invalidLayers.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LAYERS',
          message: `Unsupported import layer(s): ${invalidLayers.join(', ')}`,
        },
      });
      return null;
    }

    layers = [...new Set(payload.layers)] as LayerName[];
  }

  return {
    files: new Map(entries as [string, string][]),
    entries: entries as [string, string][],
    deleteUnmatched: payload.deleteUnmatched ?? defaultDeleteUnmatched,
    layers,
  };
}

// =============================================================================
// ZOD SCHEMAS (for OpenAPI documentation)
// =============================================================================

const exportPreviewResponseSchema = z.object({
  project: z.object({ name: z.string(), slug: z.string() }),
  agents: z.array(
    z.object({
      name: z.string(),
      hasDslContent: z.boolean(),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string(),
      toolType: z.string(),
    }),
  ),
  profiles: z.array(z.string()),
  dependencies: z.object({
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.string(),
      }),
    ),
    validation: z.object({
      valid: z.boolean(),
      missing: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          type: z.string(),
        }),
      ),
      circular: z.array(z.array(z.string())),
    }),
  }),
  provisioning: z.object({
    requiredEnvVars: z.array(z.string()),
    requiredAuthProfiles: z.array(
      z.object({
        name: z.string(),
        authType: z.string(),
        scope: z.enum(['tenant', 'project']),
        connector: z.string().optional(),
        category: z.string().optional(),
        connectionMode: z.enum(['shared', 'per_user']).optional(),
        config: z.record(z.unknown()),
        referencedBy: z.array(z.string()),
      }),
    ),
    requiredConnectors: z.array(z.string()),
    requiredMcpServers: z.array(z.string()),
  }),
  layers: z.array(
    z.object({
      name: z.string(),
      defaultMode: z.enum(['always', 'on', 'off']),
      entityCount: z.number(),
    }),
  ),
  defaultLayers: z.array(z.string()),
});

const exportQuerySchema = z.object({
  format: z.enum(['folder', 'zip', 'tar.gz']).default('folder'),
  include_deployments: z.enum(['true', 'false']).default('false'),
  dsl_format: z.enum(['source', 'yaml']).default('source'),
  layers: z.string().optional(),
});

const exportResponseSchema = z.object({
  success: z.boolean(),
  version: z.literal(2),
  manifest: z.record(z.unknown()),
  lockfile: z.record(z.unknown()),
  files: z.record(z.string()),
  warnings: z.array(z.string()),
});

const importBodySchema = z.object({
  files: z.record(z.string()),
  deleteUnmatched: z.boolean().optional(),
  layers: z.array(z.string()).optional(),
});

const structuredErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  stage: z.string().optional(),
  sanitizedCause: z.string().optional(),
});

const importPreviewResponseSchema = z.object({
  success: z.boolean(),
  preview: z.unknown().optional(),
  previewDigest: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: structuredErrorSchema.optional(),
});

const importApplyResponseSchema = z.object({
  success: z.boolean(),
  applied: z
    .object({
      created: z.number(),
      updated: z.number(),
      deleted: z.number(),
      toolsCreated: z.number(),
      toolsUpdated: z.number(),
      toolsDeleted: z.number(),
      localesCreated: z.number(),
      localesUpdated: z.number(),
      localesDeleted: z.number(),
      profilesCreated: z.number(),
      profilesUpdated: z.number(),
      profilesDeleted: z.number(),
    })
    .optional(),
  entryAgentName: z.string().nullable().optional(),
  previewDigest: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: structuredErrorSchema.optional(),
});

function createRuntimeCoreImportStateStore(input: { projectId: string; tenantId: string }) {
  return {
    loadCurrentState: async (): Promise<CoreImportSnapshotStateV2> => {
      const [
        existingAgents,
        existingPromptItems,
        existingPromptVersions,
        existingTools,
        existingMcpServers,
        existingLocales,
        existingProfiles,
        existingRuntimeConfig,
        existingLlmConfig,
        existingProjectModelConfigs,
        existingAgentModelConfigs,
        project,
      ] = await Promise.all([
        ProjectAgent.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<IProjectAgent[]>,
        PromptLibraryItem.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<
          Array<{
            _id?: string;
            name?: string;
            description?: string;
            tags?: string[];
            status?: 'active' | 'archived';
            nextVersionNumber?: number;
          }>
        >,
        PromptLibraryVersion.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<
          Array<{
            _id?: string;
            promptId?: string;
            versionNumber?: number;
            template?: string;
            variables?: string[];
            description?: string;
            status?: 'draft' | 'active' | 'archived';
            sourceHash?: string;
            metadata?: Record<string, unknown> | null;
            publishedAt?: Date | null;
          }>
        >,
        ProjectTool.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<IProjectTool[]>,
        MCPServerConfig.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        })
          .select(MCP_SERVER_CONFIG_EXPORT_SELECT)
          .lean() as Promise<
          Array<
            Partial<ProjectIOMcpServerConfig> & Pick<ProjectIOMcpServerConfig, 'name' | 'transport'>
          >
        >,
        ProjectConfigVariable.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
          key: /^locale:/,
        })
          .select('key value description')
          .lean() as Promise<Array<{ key?: string; value?: string; description?: string | null }>>,
        ProjectConfigVariable.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
          key: /^profile:/,
        })
          .select('key value description')
          .lean() as Promise<Array<{ key?: string; value?: string; description?: string | null }>>,
        ProjectRuntimeConfig.findOne({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<Record<string, unknown> | null>,
        ProjectLLMConfig.findOne({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<Record<string, unknown> | null>,
        loadProjectModelConfigs(input.projectId, input.tenantId),
        AgentModelConfig.find({
          projectId: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<Array<Record<string, unknown>>>,
        Project.findOne({
          _id: input.projectId,
          tenantId: input.tenantId,
        }).lean() as Promise<Pick<IProject, 'entryAgentName'> | null>,
      ]);

      return {
        agents: existingAgents.map((agent) => ({
          name: agent.name,
          dslContent: agent.dslContent,
          description: agent.description ?? null,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        })),
        prompts: buildPromptBundles(existingPromptItems, existingPromptVersions),
        tools: existingTools.map((tool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
          description: tool.description ?? null,
        })),
        mcpServers: existingMcpServers.map((server) => normalizeMcpServerConfigForIO(server)),
        locales: existingLocales
          .map((locale) => {
            const key = typeof locale.key === 'string' ? locale.key : null;
            if (!key || !key.startsWith('locale:') || typeof locale.value !== 'string') {
              return null;
            }

            return {
              relativePath: key.slice('locale:'.length),
              value: locale.value,
              description: locale.description ?? null,
            };
          })
          .filter(
            (
              locale,
            ): locale is { relativePath: string; value: string; description: string | null } =>
              locale !== null,
          ),
        profiles: existingProfiles
          .map((profile) => {
            const key = typeof profile.key === 'string' ? profile.key : null;
            const profileName = key ? behaviorProfileConfigKeyToName(key) : null;
            if (!profileName || typeof profile.value !== 'string') {
              return null;
            }

            return {
              name: profileName,
              dslContent: profile.value,
            };
          })
          .filter((profile): profile is { name: string; dslContent: string } => profile !== null),
        ...(existingRuntimeConfig
          ? { runtimeConfig: sanitizeModelPolicyData(existingRuntimeConfig) }
          : {}),
        ...(existingLlmConfig ? { llmConfig: sanitizeModelPolicyData(existingLlmConfig) } : {}),
        projectModelConfigs: existingProjectModelConfigs
          .map((config) => {
            const data = sanitizeProjectModelPolicyData(config);
            const name = typeof data.name === 'string' ? data.name : null;
            return name ? { name, data } : null;
          })
          .filter(
            (config): config is { name: string; data: Record<string, unknown> } => config !== null,
          ),
        agentModelConfigs: existingAgentModelConfigs
          .map((config) => {
            const data = sanitizeModelPolicyData(config);
            const agentName = typeof data.agentName === 'string' ? data.agentName : null;
            return agentName ? { agentName, data } : null;
          })
          .filter(
            (config): config is { agentName: string; data: Record<string, unknown> } =>
              config !== null,
          ),
        entryAgentName: project?.entryAgentName ?? null,
      };
    },
  };
}

function buildRuntimePreview(
  preview: CoreImportApplyPlanV2['preview'],
  toolOperations: CoreImportToolOperationV2[] = [],
) {
  const toolDetailsByName = new Map<string, { toolType: string; sourceFile: string }>();

  for (const operation of toolOperations) {
    if (operation.type === 'delete') {
      continue;
    }

    toolDetailsByName.set(operation.toolName, {
      toolType: operation.toolType ?? 'unknown',
      sourceFile: operation.sourceFile ?? '',
    });
  }

  const materializeToolChanges = (names: string[]) =>
    names.map((name) => ({
      name,
      toolType: toolDetailsByName.get(name)?.toolType ?? 'unknown',
      sourceFile: toolDetailsByName.get(name)?.sourceFile ?? '',
    }));

  return {
    ...preview,
    changes: {
      agents: preview.agentChanges,
      tools: {
        added: materializeToolChanges(preview.toolChanges.added),
        modified: materializeToolChanges(preview.toolChanges.modified),
        removed: preview.toolChanges.removed,
      },
      locales: preview.localeChanges ?? { added: [], modified: [], removed: [] },
      profiles: preview.profileChanges ?? { added: [], modified: [], removed: [] },
    },
    dependencyValidation: {
      valid: preview.crossLayerDeps.valid,
      missing: preview.crossLayerDeps.missingDependencies,
      circular: [],
    },
  };
}

function normalizeToolWriteOperationForPersistence(input: {
  operation: CoreImportToolWriteOperationV2;
  tenantId: string;
  projectId: string;
}): CoreImportToolWriteOperationV2 {
  const { operation, tenantId, projectId } = input;

  if (!isProjectToolType(operation.toolType)) {
    throw new Error(
      `Imported tool "${operation.toolName}" has unsupported toolType "${operation.toolType}".`,
    );
  }

  const prepared = prepareProjectToolDslForPersistence({
    tenantId,
    projectId,
    name: operation.toolName,
    toolType: operation.toolType,
    dslContent: operation.dslContent,
  });

  if (!prepared.valid) {
    throw new Error(`Imported tool "${operation.toolName}" is invalid: ${prepared.message}`);
  }

  return {
    ...operation,
    dslContent: prepared.dslContent,
    sourceHash: prepared.sourceHash,
  };
}

async function loadProjectConfigVariablesMap(
  projectId: string,
  tenantId: string,
): Promise<Record<string, string> | undefined> {
  const docs = (await ProjectConfigVariable.find({ projectId, tenantId }, { key: 1, value: 1 })
    .select('key value')
    .lean()) as Array<{ key?: string; value?: string }>;

  if (docs.length === 0) {
    return undefined;
  }

  const configVariables: Record<string, string> = {};
  for (const doc of docs) {
    if (typeof doc.key === 'string' && typeof doc.value === 'string') {
      configVariables[doc.key] = doc.value;
    }
  }

  return Object.keys(configVariables).length > 0 ? configVariables : undefined;
}

async function buildImportedAgentMetadataMap(input: {
  projectId: string;
  tenantId: string;
  agentOperations: Array<{
    agentName: string;
    dslContent: string;
    systemPromptLibraryRef?: IProjectAgent['systemPromptLibraryRef'] | null;
  }>;
}) {
  const existingAgents = (await ProjectAgent.find({
    projectId: input.projectId,
    tenantId: input.tenantId,
  }).lean()) as IProjectAgent[];

  const configVariables = await loadProjectConfigVariablesMap(input.projectId, input.tenantId);
  return evaluateRuntimeProjectAgentDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: mergeProjectAgentDraftStates(
      existingAgents,
      input.agentOperations.map((operation) => ({
        recordName: operation.agentName,
        dslContent: operation.dslContent,
        systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
      })),
    ),
    configVariables,
    diagnosticSource: 'runtime-import',
  });
}

async function refreshPersistedImportedAgentMetadata(input: {
  projectId: string;
  tenantId: string;
}): Promise<void> {
  const existingAgents = (await ProjectAgent.find({
    projectId: input.projectId,
    tenantId: input.tenantId,
  }).lean()) as IProjectAgent[];

  if (existingAgents.length === 0) {
    return;
  }

  const configVariables = await loadProjectConfigVariablesMap(input.projectId, input.tenantId);
  const metadataByAgent = await evaluateRuntimeProjectAgentDrafts({
    projectId: input.projectId,
    tenantId: input.tenantId,
    agents: existingAgents
      .map((agent) => toProjectAgentDraftState(agent))
      .filter((agent): agent is NonNullable<ReturnType<typeof toProjectAgentDraftState>> =>
        Boolean(agent),
      ),
    configVariables,
    diagnosticSource: 'runtime-import',
  });

  await ProjectAgent.bulkWrite(
    existingAgents.map((agent) => {
      const metadata = metadataByAgent.get(agent.name);
      return {
        updateOne: {
          filter: {
            _id: agent._id,
            projectId: input.projectId,
            tenantId: input.tenantId,
          },
          update: {
            $set: {
              sourceHash: metadata?.sourceHash ?? null,
              dslValidationStatus: metadata?.dslValidationStatus ?? null,
              dslDiagnostics: metadata?.dslDiagnostics ?? [],
            },
            $inc: { _v: 1 },
          },
        },
      };
    }),
  );
}

function createCoreImportApplyAdapter(input: {
  projectId: string;
  tenantId: string;
  userId: string;
  now: Date;
}): CoreImportApplyAdapterV2 {
  const { projectId, tenantId, userId, now } = input;

  return {
    createPrompts: async (promptOperations) => {
      const promptDocs = promptOperations.map((operation) => ({
        _id: operation.promptId,
        projectId,
        tenantId,
        name: operation.bundle.name,
        description: operation.bundle.description,
        tags: operation.bundle.tags,
        usageCount: 0,
        nextVersionNumber: operation.bundle.nextVersionNumber,
        status: operation.bundle.status,
        createdBy: userId,
      }));
      const created = await PromptLibraryItem.insertMany(promptDocs);
      const versionDocs = promptOperations.flatMap((operation) =>
        operation.bundle.versions.map((version) => ({
          _id: version.versionId,
          projectId,
          tenantId,
          promptId: operation.promptId,
          versionNumber: version.versionNumber,
          template: version.template,
          variables: version.variables,
          description: version.description,
          status: version.status,
          sourceHash: version.sourceHash,
          metadata: version.metadata ?? null,
          createdBy: userId,
          publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
          publishedBy: version.publishedAt ? userId : null,
        })),
      );
      if (versionDocs.length > 0) {
        await PromptLibraryVersion.insertMany(versionDocs);
      }
      return created.map((document: { _id: string }) => String(document._id));
    },
    updatePrompts: async (promptOperations) => {
      await PromptLibraryItem.bulkWrite(
        promptOperations.map((operation) => ({
          updateOne: {
            filter: { projectId, tenantId, _id: operation.promptId },
            update: {
              $set: {
                name: operation.bundle.name,
                description: operation.bundle.description,
                tags: operation.bundle.tags,
                nextVersionNumber: operation.bundle.nextVersionNumber,
                status: operation.bundle.status,
              },
            },
          },
        })),
      );
      await PromptLibraryVersion.deleteMany({
        projectId,
        tenantId,
        promptId: { $in: promptOperations.map((operation) => operation.promptId) },
      });
      const versionDocs = promptOperations.flatMap((operation) =>
        operation.bundle.versions.map((version) => ({
          _id: version.versionId,
          projectId,
          tenantId,
          promptId: operation.promptId,
          versionNumber: version.versionNumber,
          template: version.template,
          variables: version.variables,
          description: version.description,
          status: version.status,
          sourceHash: version.sourceHash,
          metadata: version.metadata ?? null,
          createdBy: userId,
          publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
          publishedBy: version.publishedAt ? userId : null,
        })),
      );
      if (versionDocs.length > 0) {
        await PromptLibraryVersion.insertMany(versionDocs);
      }
    },
    deletePrompts: async (promptIds) => {
      await PromptLibraryVersion.deleteMany({ projectId, tenantId, promptId: { $in: promptIds } });
      await PromptLibraryItem.deleteMany({ projectId, tenantId, _id: { $in: promptIds } });
    },
    createAgents: async (agentOperations) => {
      const metadataByAgent = await buildImportedAgentMetadataMap({
        projectId,
        tenantId,
        agentOperations,
      });
      const docs = agentOperations.map((operation) => ({
        ...(metadataByAgent.get(operation.agentName)
          ? {
              dslValidationStatus:
                metadataByAgent.get(operation.agentName)?.dslValidationStatus ?? 'valid',
              dslDiagnostics: metadataByAgent.get(operation.agentName)?.dslDiagnostics ?? [],
            }
          : { dslValidationStatus: 'valid' as const, dslDiagnostics: [] }),
        projectId,
        tenantId,
        name: operation.agentName,
        agentPath: buildProjectAgentPath(projectId, operation.agentName),
        description: operation.description,
        dslContent: operation.dslContent,
        systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
        sourceHash: operation.sourceHash,
        lastEditedBy: userId,
        lastEditedAt: now,
      }));
      const created = await ProjectAgent.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateAgents: async (agentOperations) => {
      const metadataByAgent = await buildImportedAgentMetadataMap({
        projectId,
        tenantId,
        agentOperations,
      });
      await ProjectAgent.bulkWrite(
        agentOperations.map((operation) => {
          const metadata = metadataByAgent.get(operation.agentName);
          return {
            updateOne: {
              filter: { projectId, tenantId, name: operation.agentName },
              update: {
                $set: {
                  dslContent: operation.dslContent,
                  description: operation.description,
                  systemPromptLibraryRef: operation.systemPromptLibraryRef ?? null,
                  sourceHash: operation.sourceHash,
                  lastEditedBy: userId,
                  lastEditedAt: now,
                  dslValidationStatus: metadata?.dslValidationStatus ?? 'valid',
                  dslDiagnostics: metadata?.dslDiagnostics ?? [],
                },
                $inc: { _v: 1 },
              },
            },
          };
        }),
      );
    },
    deleteAgents: async (agentNames) => {
      await ProjectAgent.deleteMany({
        projectId,
        tenantId,
        name: { $in: agentNames },
      });
    },
    refreshAgentDraftMetadata: async () => {
      await refreshPersistedImportedAgentMetadata({ projectId, tenantId });
    },
    upsertModelPolicyConfigs: async (operations) => {
      let projectModelScopeVerified = false;
      for (const operation of operations) {
        const data = sanitizeModelPolicyData(operation.data);
        if (operation.configType === 'runtime') {
          await ProjectRuntimeConfig.findOneAndUpdate(
            { projectId, tenantId },
            { $set: { ...data, projectId, tenantId } },
            { upsert: true, new: true },
          );
          if (hasOperationTierOverrides(data)) {
            await ProjectLLMConfig.findOneAndUpdate(
              { projectId, tenantId },
              {
                $set: { projectId, tenantId, operationTierOverrides: data.operationTierOverrides },
              },
              { upsert: true, new: true },
            );
          }
          continue;
        }
        if (operation.configType === 'llm') {
          await ProjectLLMConfig.findOneAndUpdate(
            { projectId, tenantId },
            { $set: { ...data, projectId, tenantId } },
            { upsert: true, new: true },
          );
          if (hasOperationTierOverrides(data)) {
            await ProjectRuntimeConfig.findOneAndUpdate(
              { projectId, tenantId },
              {
                $set: { projectId, tenantId, operationTierOverrides: data.operationTierOverrides },
              },
              { upsert: true, new: true },
            );
          }
          continue;
        }
        if (operation.configType === 'project_model') {
          const projectModelData = sanitizeProjectModelPolicyData(data);
          const modelConfigName = operation.modelConfigName;
          if (!modelConfigName) {
            continue;
          }
          if (!projectModelScopeVerified) {
            await verifyProjectModelConfigScope(projectId, tenantId);
            projectModelScopeVerified = true;
          }
          const tenantModelId = await resolveDestinationTenantModelIdForImport({
            data: projectModelData,
            tenantId,
            modelConfigName,
          });
          await ModelConfig.findOneAndUpdate(
            { projectId, tenantId, name: modelConfigName },
            {
              $set: {
                ...projectModelData,
                tenantModelId,
                projectId,
                tenantId,
                name: modelConfigName,
              },
            },
            { upsert: true, new: true },
          );
          continue;
        }
        if (operation.agentName) {
          await AgentModelConfig.findOneAndUpdate(
            { projectId, tenantId, agentName: operation.agentName },
            { $set: { ...data, projectId, tenantId, agentName: operation.agentName } },
            { upsert: true, new: true },
          );
        }
      }
    },
    deleteModelPolicyConfigs: async (operations) => {
      let projectModelScopeVerified = false;
      for (const operation of operations) {
        if (operation.configType === 'runtime') {
          await ProjectRuntimeConfig.deleteOne({ projectId, tenantId });
          continue;
        }
        if (operation.configType === 'llm') {
          await ProjectLLMConfig.deleteOne({ projectId, tenantId });
          await ProjectRuntimeConfig.findOneAndUpdate(
            { projectId, tenantId },
            { $set: { operationTierOverrides: {} } },
            { new: true },
          );
          continue;
        }
        if (operation.configType === 'project_model' && operation.modelConfigName) {
          if (!projectModelScopeVerified) {
            await verifyProjectModelConfigScope(projectId, tenantId);
            projectModelScopeVerified = true;
          }
          await ModelConfig.deleteOne({ projectId, tenantId, name: operation.modelConfigName });
          continue;
        }
        if (operation.agentName) {
          await AgentModelConfig.deleteOne({ projectId, tenantId, agentName: operation.agentName });
        }
      }
    },
    createMcpServers: async (serverOperations) => {
      const docs = serverOperations.map((operation) => ({
        projectId,
        tenantId,
        ...operation.config,
        createdBy: userId,
        modifiedBy: userId,
      }));
      const created = await MCPServerConfig.insertMany(docs as IMCPServerConfig[]);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateMcpServers: async (serverOperations) => {
      await MCPServerConfig.bulkWrite(
        serverOperations.map((operation) => ({
          updateOne: {
            filter: { projectId, tenantId, name: operation.serverName },
            update: {
              $set: {
                ...operation.config,
                modifiedBy: userId,
              },
              $inc: { _v: 1 },
            },
          },
        })),
      );
    },
    deleteMcpServers: async (serverNames) => {
      await MCPServerConfig.deleteMany({
        projectId,
        tenantId,
        name: { $in: serverNames },
      });
    },
    createTools: async (toolOperations) => {
      const preparedOperations = toolOperations.map((operation) =>
        normalizeToolWriteOperationForPersistence({ operation, tenantId, projectId }),
      );
      const variableNamespaceIds = await getOrCreateDefaultVariableNamespaceIds({
        tenantId,
        projectId,
        createdBy: userId,
      });
      const docs = preparedOperations.map((operation) => ({
        projectId,
        tenantId,
        name: operation.toolName,
        slug: operation.toolName,
        toolType: (operation.toolType ?? 'http') as ProjectToolType,
        description: operation.description,
        dslContent: operation.dslContent,
        sourceHash: operation.sourceHash,
        variableNamespaceIds,
        createdBy: userId,
        lastEditedBy: userId,
      }));
      const created = await ProjectTool.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateTools: async (toolOperations) => {
      const preparedOperations = toolOperations.map((operation) =>
        normalizeToolWriteOperationForPersistence({ operation, tenantId, projectId }),
      );
      const toolNames = preparedOperations.map((operation) => operation.toolName);
      const existingTools = await ProjectTool.find({
        projectId,
        tenantId,
        name: { $in: toolNames },
      })
        .select('name variableNamespaceIds')
        .lean();
      const existingNamespaceIdsByName = new Map(
        (existingTools as Array<{ name: string; variableNamespaceIds?: string[] }>).map((tool) => [
          tool.name,
          Array.isArray(tool.variableNamespaceIds) ? tool.variableNamespaceIds : [],
        ]),
      );
      const needsDefaultNamespace = preparedOperations.some((operation) => {
        const existingNamespaceIds = existingNamespaceIdsByName.get(operation.toolName);
        return !existingNamespaceIds || existingNamespaceIds.length === 0;
      });
      const variableNamespaceIds = needsDefaultNamespace
        ? await getOrCreateDefaultVariableNamespaceIds({
            tenantId,
            projectId,
            createdBy: userId,
          })
        : [];
      await ProjectTool.bulkWrite(
        preparedOperations.map((operation) => {
          const set: Record<string, unknown> = {
            dslContent: operation.dslContent,
            description: operation.description,
            toolType: (operation.toolType ?? 'http') as ProjectToolType,
            sourceHash: operation.sourceHash,
            lastEditedBy: userId,
          };
          const existingNamespaceIds = existingNamespaceIdsByName.get(operation.toolName);
          if (!existingNamespaceIds || existingNamespaceIds.length === 0) {
            set.variableNamespaceIds = variableNamespaceIds;
          }

          return {
            updateOne: {
              filter: { projectId, tenantId, name: operation.toolName },
              update: {
                $set: set,
                $inc: { _v: 1 },
              },
            },
          };
        }),
      );
    },
    deleteTools: async (toolNames) => {
      await ProjectTool.deleteMany({
        projectId,
        tenantId,
        name: { $in: toolNames },
      });
    },
    createLocales: async (localeOperations) => {
      const docs = localeOperations.map((operation) => ({
        projectId,
        tenantId,
        key: localeAssetRelativePathToConfigKey(operation.relativePath),
        value: operation.value,
        description: operation.description ?? null,
        createdBy: userId,
        updatedBy: userId,
      }));
      const created = await ProjectConfigVariable.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateLocales: async (localeOperations) => {
      await ProjectConfigVariable.bulkWrite(
        localeOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId,
              tenantId,
              key: localeAssetRelativePathToConfigKey(operation.relativePath),
            },
            update: {
              $set: {
                value: operation.value,
                updatedBy: userId,
              },
            },
          },
        })),
      );
    },
    deleteLocales: async (relativePaths) => {
      await ProjectConfigVariable.deleteMany({
        projectId,
        tenantId,
        key: {
          $in: relativePaths.map((relativePath) =>
            localeAssetRelativePathToConfigKey(relativePath),
          ),
        },
      });
    },
    createProfiles: async (profileOperations) => {
      const docs = profileOperations.map((operation) => ({
        projectId,
        tenantId,
        key: behaviorProfileNameToConfigKey(operation.profileName),
        value: operation.dslContent,
        description: null,
        createdBy: userId,
        updatedBy: userId,
      }));
      const created = await ProjectConfigVariable.insertMany(docs);
      return created.map((document: { _id: string }) => String(document._id));
    },
    updateProfiles: async (profileOperations) => {
      await ProjectConfigVariable.bulkWrite(
        profileOperations.map((operation) => ({
          updateOne: {
            filter: {
              projectId,
              tenantId,
              key: behaviorProfileNameToConfigKey(operation.profileName),
            },
            update: {
              $set: {
                value: operation.dslContent,
                updatedBy: userId,
              },
            },
          },
        })),
      );
    },
    deleteProfiles: async (profileNames) => {
      await ProjectConfigVariable.deleteMany({
        projectId,
        tenantId,
        key: {
          $in: profileNames.map((profileName) => behaviorProfileNameToConfigKey(profileName)),
        },
      });
    },
    setEntryAgent: async (entryAgentName) => {
      await Project.findOneAndUpdate(
        { _id: projectId, tenantId },
        entryAgentName ? { $set: { entryAgentName } } : { $unset: { entryAgentName: 1 } },
      );
    },
    rollbackCreated: async (promptIds, agentIds, toolIds, mcpServerIds, localeIds, profileIds) => {
      const rollbackOperations: Promise<unknown>[] = [];
      if (promptIds.length > 0) {
        rollbackOperations.push(
          PromptLibraryVersion.deleteMany({ projectId, tenantId, promptId: { $in: promptIds } }),
        );
        rollbackOperations.push(
          PromptLibraryItem.deleteMany({ projectId, tenantId, _id: { $in: promptIds } }),
        );
      }
      if (agentIds.length > 0) {
        rollbackOperations.push(
          ProjectAgent.deleteMany({ projectId, tenantId, _id: { $in: agentIds } }),
        );
      }
      if (toolIds.length > 0) {
        rollbackOperations.push(
          ProjectTool.deleteMany({ projectId, tenantId, _id: { $in: toolIds } }),
        );
      }
      if (mcpServerIds.length > 0) {
        rollbackOperations.push(
          MCPServerConfig.deleteMany({ projectId, tenantId, _id: { $in: mcpServerIds } }),
        );
      }
      if (localeIds.length > 0) {
        rollbackOperations.push(
          ProjectConfigVariable.deleteMany({ projectId, tenantId, _id: { $in: localeIds } }),
        );
      }
      if (profileIds.length > 0) {
        rollbackOperations.push(
          ProjectConfigVariable.deleteMany({ projectId, tenantId, _id: { $in: profileIds } }),
        );
      }
      await Promise.all(rollbackOperations);
    },
  };
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /export/preview
 * Metadata preview: canonical v2 layer coverage, dependencies, and exported entities.
 */
openapi.route(
  'get',
  '/export/preview',
  {
    summary: 'Preview project export',
    description:
      'Returns metadata about the canonical layered export: agents, tools, profiles, layer counts, and dependency validation.',
    response: exportPreviewResponseSchema,
  },
  async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'project:export'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = req.params.projectId;

    try {
      const project = (await Project.findOne({
        _id: projectId,
        tenantId,
      }).lean()) as IProject | null;
      if (!project) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }

      const [agents, tools, profiles, connectorConfigs, mcpServers, runtimeConfig, llmConfig] =
        await Promise.all([
          ProjectAgent.find({ projectId, tenantId }).lean() as Promise<IProjectAgent[]>,
          ProjectTool.find({ projectId, tenantId }).lean() as Promise<IProjectTool[]>,
          ProjectConfigVariable.find({
            projectId,
            tenantId,
            key: /^profile:/,
          })
            .select('key value')
            .lean() as Promise<Array<{ key?: string; value?: string }>>,
          ConnectorConfig.find({ projectId, tenantId }).lean() as Promise<
            Array<{ connectorType?: string | null }>
          >,
          MCPServerConfig.find({ projectId, tenantId }).select('name').lean() as Promise<
            Array<{ name?: string | null }>
          >,
          ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
            string,
            unknown
          > | null>,
          ProjectLLMConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
            string,
            unknown
          > | null>,
        ]);

      const readinessIssues = await getProjectExportReadinessIssues({
        agents,
        projectId,
        tenantId,
        runtimeConfig,
        llmConfig,
      });
      if (readinessIssues.length > 0) {
        res.status(409).json(buildInvalidProjectExportPayload(readinessIssues));
        return;
      }

      const profileEntries = profiles
        .map((profile) => {
          const name =
            typeof profile.key === 'string' ? behaviorProfileConfigKeyToName(profile.key) : null;
          return name ? { name, dslContent: profile.value ?? '' } : null;
        })
        .filter((profile): profile is { name: string; dslContent: string } => profile !== null);
      const profileNames = profileEntries.map((profile) => profile.name);
      const agentEntries = agents
        .filter((a) => a.dslContent)
        .map((a) => ({ name: a.name, dslContent: a.dslContent! }));

      const toolEntries = tools.map((t) => ({
        name: t.name,
        path: `tools/${(t as unknown as Record<string, unknown>).slug as string}.tools.abl`,
        content: (t as unknown as Record<string, unknown>).dslContent as string,
      }));

      const graph = buildDependencyGraph(agentEntries, toolEntries, profileNames);
      const validation = validateDependencies(graph);
      const layers = await buildLayerPreview({ projectId, tenantId });
      const provisioning = buildExportProvisioningRequirements({
        agents: agentEntries,
        tools: toolEntries,
        profiles: profileEntries,
        connectorConfigs,
        mcpServers,
      });

      res.json({
        project: { name: project.name, slug: project.slug },
        agents: agents.map((a) => ({
          name: a.name,
          hasDslContent: !!a.dslContent,
        })),
        tools: tools.map((t) => ({
          name: t.name,
          toolType: (t as unknown as Record<string, unknown>).toolType ?? 'unknown',
        })),
        profiles: profileNames,
        dependencies: { edges: graph.edges, validation },
        provisioning,
        layers,
        defaultLayers: resolveLayers(),
      });
    } catch (err) {
      log.error('Export preview failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'EXPORT_PREVIEW_FAILED', message: 'Failed to generate export preview' },
      });
    }
  },
);

/**
 * GET /export
 * Full export: canonical v2 file map + manifest + lockfile.
 */
openapi.route(
  'get',
  '/export',
  {
    summary: 'Export project',
    description:
      'Export the project using the canonical layered v2 contract as a file map with manifest and lockfile.',
    query: exportQuerySchema,
    response: exportResponseSchema,
  },
  async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'project:export'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = req.params.projectId;
    const userId = req.tenantContext!.userId;
    const format = (req.query.format as string) ?? 'folder';
    const includeDeployments = req.query.include_deployments === 'true';
    const dslFormat = parseDslFormat(
      typeof req.query.dsl_format === 'string' ? req.query.dsl_format : undefined,
    );
    const requestedLayers = parseLayers(
      typeof req.query.layers === 'string' ? req.query.layers : undefined,
    );

    try {
      const project = (await Project.findOne({
        _id: projectId,
        tenantId,
      }).lean()) as IProject | null;
      if (!project) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }

      const [agents, tools, profiles, connectorConfigs, mcpServers, runtimeConfig, llmConfig] =
        await Promise.all([
          ProjectAgent.find({ projectId, tenantId }).lean() as Promise<IProjectAgent[]>,
          ProjectTool.find({ projectId, tenantId }).lean() as Promise<IProjectTool[]>,
          ProjectConfigVariable.find({
            projectId,
            tenantId,
            key: /^profile:/,
          })
            .select('key value')
            .lean() as Promise<Array<{ key?: string; value?: string }>>,
          ConnectorConfig.find({ projectId, tenantId }).lean() as Promise<
            Array<{ connectorType?: string | null }>
          >,
          MCPServerConfig.find({ projectId, tenantId }).select('name').lean() as Promise<
            Array<{ name?: string | null }>
          >,
          ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
            string,
            unknown
          > | null>,
          ProjectLLMConfig.findOne({ projectId, tenantId }).lean() as Promise<Record<
            string,
            unknown
          > | null>,
        ]);

      if (agents.length > MAX_EXPORT_AGENTS) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TOO_MANY_AGENTS',
            message: `Project has too many agents to export (${agents.length}, max ${MAX_EXPORT_AGENTS})`,
          },
        });
        return;
      }
      if (tools.length > MAX_EXPORT_TOOLS) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TOO_MANY_TOOLS',
            message: `Project has too many tools to export (${tools.length}, max ${MAX_EXPORT_TOOLS})`,
          },
        });
        return;
      }

      const readinessIssues = await getProjectExportReadinessIssues({
        agents,
        projectId,
        tenantId,
        runtimeConfig,
        llmConfig,
      });
      if (readinessIssues.length > 0) {
        res.status(409).json(buildInvalidProjectExportPayload(readinessIssues));
        return;
      }

      const profileMap = new Map(
        profiles.flatMap((profile) => {
          const profileName =
            typeof profile.key === 'string'
              ? behaviorProfileConfigKeyToName(profile.key)
              : undefined;
          if (!profileName || typeof profile.value !== 'string') {
            return [];
          }
          return [[profileName, profile.value] as const];
        }),
      );
      const profileManifestEntries = extractProfileManifestEntries(
        profileMap,
        agents.map((agent) => ({
          name: agent.name,
          dslContent: agent.dslContent ?? '',
        })),
      );
      const profileEntries = [...profileMap.entries()].map(([name, dslContent]) => ({
        name,
        dslContent,
      }));
      const layers = resolveLayersForToolDependencies(
        requestedLayers ?? resolveLayers(requestedLayers),
        tools.map((tool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
          toolType: tool.toolType,
        })),
      );
      const provisioning = buildExportProvisioningRequirements({
        agents: agents.map((agent) => ({ name: agent.name, dslContent: agent.dslContent ?? '' })),
        tools: tools.map((tool) => ({ name: tool.name, dslContent: tool.dslContent })),
        profiles: profileEntries,
        connectorConfigs,
        mcpServers,
      });
      const result = await exportProjectV2(
        {
          projectId,
          userId: userId ?? '',
          tenantId,
          format: format as 'folder' | 'zip' | 'tar.gz',
          layers,
          dslFormat,
          includeDeployments,
        },
        {
          assemblers: buildDefaultAssemblerMap(layers),
          agentData: agents.map((agent) => ({
            name: agent.name,
            version: getProjectAgentExportVersion(agent),
            dslContent: agent.dslContent ?? '',
            status: 'active',
            systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
          })),
          toolData: tools.map((tool) => ({
            name: tool.name,
            dslContent: tool.dslContent,
            toolType: tool.toolType,
          })),
        } satisfies ExportV2Deps,
        {
          projectName: project.name,
          projectSlug: project.slug,
          projectDescription: project.description ?? null,
          exportedBy: userId ?? '',
          entryAgent: project.entryAgentName ?? null,
          agents: agents.map((agent) => ({
            name: agent.name,
            description: agent.description ?? null,
            ownerId: agent.ownerId ?? null,
            ownerTeamId: agent.ownerTeamId ?? null,
            version: null,
            systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
          })),
          tools: tools.map((tool) => ({ name: tool.name, ownerId: null })),
          profiles: profileManifestEntries,
          entityCounts: {
            agents: agents.length,
            tools: tools.length,
            behavior_profiles: profileManifestEntries.length,
          },
          requiredEnvVars: provisioning.requiredEnvVars,
          requiredAuthProfiles: provisioning.requiredAuthProfiles,
          requiredConnectors: provisioning.requiredConnectors,
          requiredMcpServers: provisioning.requiredMcpServers,
        },
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: {
            code: result.error?.code ?? 'EXPORT_FAILED',
            message: result.error?.message ?? 'Export failed',
          },
        });
        return;
      }

      // Convert Map to plain object for JSON response
      const filesObj: Record<string, string> = {};
      let totalResponseSize = 0;
      for (const [path, content] of result.files) {
        filesObj[path] = content;
        totalResponseSize += path.length + content.length;
      }

      if (totalResponseSize > MAX_EXPORT_RESPONSE_SIZE) {
        log.warn('Export response too large', {
          projectId,
          tenantId,
          estimatedSize: totalResponseSize,
          maxSize: MAX_EXPORT_RESPONSE_SIZE,
        });
        res.status(400).json({
          success: false,
          error: {
            code: 'EXPORT_TOO_LARGE',
            message: `Export response too large (~${Math.round(totalResponseSize / 1024 / 1024)}MB, max ${MAX_EXPORT_RESPONSE_SIZE / 1024 / 1024}MB). Consider exporting fewer agents.`,
          },
        });
        return;
      }

      log.info('Project exported', {
        projectId,
        tenantId,
        agentCount: agents.length,
        toolCount: tools.length,
        mcpServerCount: mcpServers.length,
        profileCount: profileManifestEntries.length,
        layerCount: layers.length,
        fileCount: result.files.size,
        responseSizeBytes: totalResponseSize,
      });

      res.json({
        success: true,
        version: 2,
        manifest: result.manifest,
        lockfile: result.lockfile,
        files: filesObj,
        warnings: result.warnings,
      });
    } catch (err) {
      log.error('Export failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'EXPORT_FAILED', message: 'Failed to export project' },
      });
    }
  },
);

/**
 * POST /import/preview
 * Dry-run import: validates files, computes changes. Does not apply.
 */
openapi.route(
  'post',
  '/import/preview',
  {
    summary: 'Preview project import',
    description:
      'Dry-run import: validates files, computes what agents/tools would be added, modified, or removed.',
    body: importBodySchema,
    response: importPreviewResponseSchema,
  },
  rejectOversizedContentLength,
  importBodyParser,
  importBodyErrorHandler as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'project:import'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = req.params.projectId;
    const userId = req.tenantContext!.userId;

    const validated = validateImportPayload(req.body, res, true);
    if (!validated) return;

    try {
      const previewResult = await previewCoreImportV2({
        files: validated.files,
        planOptions: {
          projectId,
          tenantId,
          userId: userId ?? '',
          deleteUnmatched: validated.deleteUnmatched,
          layers: validated.layers,
          validateToolBindingForSave: validateRuntimeToolBindingForSave,
          validateRuntimeConfigForSave: createRuntimeConfigImportValidator(validated.files),
        },
        stateStore: createRuntimeCoreImportStateStore({ projectId, tenantId }),
      });

      const preview = previewResult.success
        ? buildRuntimePreview(previewResult.preview, previewResult.plan.toolOperations)
        : previewResult.preview
          ? buildRuntimePreview(previewResult.preview)
          : undefined;

      log.info('Import preview generated', {
        projectId,
        tenantId,
        success: previewResult.success,
        fileCount: validated.entries.length,
        added: previewResult.success
          ? previewResult.preview.agentChanges.added.length
          : (previewResult.preview?.agentChanges.added.length ?? 0),
        modified: previewResult.success
          ? previewResult.preview.agentChanges.modified.length
          : (previewResult.preview?.agentChanges.modified.length ?? 0),
        removed: previewResult.success
          ? previewResult.preview.agentChanges.removed.length
          : (previewResult.preview?.agentChanges.removed.length ?? 0),
      });

      res.json({
        success: previewResult.success,
        preview,
        previewDigest: preview?.previewDigest,
        warnings: previewResult.warnings,
        error: previewResult.success ? undefined : previewResult.error,
      });
    } catch (err) {
      log.error('Import preview failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'IMPORT_PREVIEW_FAILED', message: 'Failed to generate import preview' },
      });
    }
  },
);

/**
 * POST /import
 * Apply import: creates, updates, or deletes agents based on uploaded files.
 * Acquires a distributed lock to prevent concurrent imports.
 */
openapi.route(
  'post',
  '/import',
  {
    summary: 'Apply project import',
    description:
      'Apply import: creates, updates, or deletes agents. Only one import can run per project at a time.',
    body: importBodySchema,
    response: importApplyResponseSchema,
  },
  rejectOversizedContentLength,
  importBodyParser,
  importBodyErrorHandler as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'project:import'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = req.params.projectId;
    const userId = req.tenantContext!.userId;

    const validated = validateImportPayload(req.body, res, true);
    if (!validated) return;

    // Acquire distributed lock — only one import per project at a time
    const lockOwner = await acquireImportLock(projectId);
    if (!lockOwner) {
      res.status(409).json({
        success: false,
        error: {
          code: 'IMPORT_LOCKED',
          message: 'Another import is in progress for this project. Please try again shortly.',
        },
      });
      return;
    }

    try {
      const executionResult = await applyCoreImportV2({
        files: validated.files,
        planOptions: {
          projectId,
          tenantId,
          userId: userId ?? '',
          deleteUnmatched: validated.deleteUnmatched,
          layers: validated.layers,
          validateToolBindingForSave: validateRuntimeToolBindingForSave,
          validateRuntimeConfigForSave: createRuntimeConfigImportValidator(validated.files),
        },
        stateStore: createRuntimeCoreImportStateStore({ projectId, tenantId }),
        adapter: createCoreImportApplyAdapter({
          projectId,
          tenantId,
          userId: userId ?? '',
          now: new Date(),
        }),
      });

      if (!executionResult.success) {
        res.status(executionResult.stage === 'apply' ? 500 : 400).json({
          success: false,
          preview: executionResult.preview
            ? buildRuntimePreview(executionResult.preview)
            : undefined,
          previewDigest: executionResult.preview?.previewDigest,
          warnings: executionResult.warnings,
          error: executionResult.error,
        });
        return;
      }

      log.info('Project imported', {
        projectId,
        tenantId,
        created: executionResult.applied.created,
        updated: executionResult.applied.updated,
        deleted: executionResult.applied.deleted,
        toolsCreated: executionResult.applied.toolsCreated,
        toolsUpdated: executionResult.applied.toolsUpdated,
        toolsDeleted: executionResult.applied.toolsDeleted,
        localesCreated: executionResult.applied.localesCreated,
        localesUpdated: executionResult.applied.localesUpdated,
        localesDeleted: executionResult.applied.localesDeleted,
        modelPoliciesUpserted: executionResult.applied.modelPoliciesUpserted ?? 0,
        modelPoliciesDeleted: executionResult.applied.modelPoliciesDeleted ?? 0,
        entryAgentName: executionResult.entryAgentName,
      });

      if (hasModelPolicyMutations(executionResult.applied)) {
        invalidateModelResolutionCaches(tenantId);
      }

      res.json({
        success: true,
        applied: executionResult.applied,
        entryAgentName: executionResult.entryAgentName,
        warnings: executionResult.warnings,
      });
    } catch (err) {
      log.error('Import apply failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'IMPORT_APPLY_FAILED', message: 'Failed to apply import' },
      });
    } finally {
      await releaseImportLock(projectId, lockOwner).catch((lockErr) => {
        log.error('Failed to release import lock', {
          projectId,
          error: lockErr instanceof Error ? lockErr.message : String(lockErr),
        });
      });
    }
  },
);

export default router;
