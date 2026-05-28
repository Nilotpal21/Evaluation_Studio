/**
 * Project I/O (Import/Export) API Route Tests
 *
 * Tests authorization (RBAC), input validation, export guards,
 * concurrent import protection, happy paths, and error rollback
 * for the project-io router.
 *
 * Permission mapping:
 *   GET  /export/preview  → project:export  (admin, developer, viewer)
 *   GET  /export          → project:export  (admin, developer, viewer)
 *   POST /import/preview  → project:import  (admin, developer — not viewer)
 *   POST /import          → project:import  (admin, developer — not viewer)
 *
 * Project role → relevant permissions:
 *   admin     → *:* (all)
 *   developer → project:export, project:import
 *   viewer    → project:export (no project:import)
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCK FUNCTIONS — declared before vi.mock() calls
// =============================================================================

// Database model mocks (used by route handlers directly)
const mockProjectFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectAgentInsertMany = vi.fn();
const mockProjectAgentBulkWrite = vi.fn();
const mockProjectAgentDeleteMany = vi.fn();
const mockPromptLibraryItemFind = vi.fn();
const mockPromptLibraryItemInsertMany = vi.fn();
const mockPromptLibraryItemBulkWrite = vi.fn();
const mockPromptLibraryItemDeleteMany = vi.fn();
const mockPromptLibraryVersionFind = vi.fn();
const mockPromptLibraryVersionInsertMany = vi.fn();
const mockPromptLibraryVersionDeleteMany = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockMCPServerConfigInsertMany = vi.fn();
const mockMCPServerConfigBulkWrite = vi.fn();
const mockMCPServerConfigDeleteMany = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectToolInsertMany = vi.fn();
const mockProjectToolBulkWrite = vi.fn();
const mockProjectToolDeleteMany = vi.fn();
const mockSearchIndexFindOne = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockProjectConfigVariableInsertMany = vi.fn();
const mockProjectConfigVariableBulkWrite = vi.fn();
const mockProjectConfigVariableDeleteMany = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectRuntimeConfigFindOneAndUpdate = vi.fn();
const mockProjectRuntimeConfigDeleteOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOneAndUpdate = vi.fn();
const mockProjectLLMConfigDeleteOne = vi.fn();
const mockGetOrCreateDefaultNamespace = vi.fn();
const mockModelConfigFind = vi.fn();
const mockModelConfigFindOneAndUpdate = vi.fn();
const mockModelConfigDeleteOne = vi.fn();
const mockTenantModelFind = vi.fn();
const mockAgentModelConfigFind = vi.fn();
const mockAgentModelConfigFindOneAndUpdate = vi.fn();
const mockAgentModelConfigDeleteOne = vi.fn();
const mockDeploymentFind = vi.fn();
const mockTenantConfigGetConfig = vi.fn();
const mockResolveAdvancedNluEntitlement = vi.fn();
const mockInvalidateModelResolutionCaches = vi.fn();

// Project-IO package mocks
const mockExportProject = vi.fn();
const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn();
const mockBuildDefaultAssemblerMap = vi.fn();
const mockBuildLayerPreview = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn();
const mockExtractProfileManifestEntries = vi.fn();
const mockScanProjectEnvVars = vi.fn();
const mockBuildCoreImportApplyPlanV2 = vi.fn();
const mockPreviewCoreImportV2 = vi.fn();
const mockApplyCoreImportV2 = vi.fn();
const mockBuildDependencyGraph = vi.fn();
const mockValidateDependencies = vi.fn();

// Redis mock
let mockRedisClient: any = null;

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: vi.fn((...args: any[]) => ({
      lean: () => mockProjectFindOne(...args),
      select: () => ({ lean: () => mockProjectFindOne(...args) }),
    })),
    findOneAndUpdate: (...args: any[]) => mockProjectFindOneAndUpdate(...args),
  },
  ProjectAgent: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockProjectAgentFind(...args) })),
    insertMany: (...args: any[]) => mockProjectAgentInsertMany(...args),
    bulkWrite: (...args: any[]) => mockProjectAgentBulkWrite(...args),
    deleteMany: (...args: any[]) => mockProjectAgentDeleteMany(...args),
  },
  PromptLibraryItem: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockPromptLibraryItemFind(...args) })),
    insertMany: (...args: any[]) => mockPromptLibraryItemInsertMany(...args),
    bulkWrite: (...args: any[]) => mockPromptLibraryItemBulkWrite(...args),
    deleteMany: (...args: any[]) => mockPromptLibraryItemDeleteMany(...args),
  },
  PromptLibraryVersion: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockPromptLibraryVersionFind(...args) })),
    insertMany: (...args: any[]) => mockPromptLibraryVersionInsertMany(...args),
    deleteMany: (...args: any[]) => mockPromptLibraryVersionDeleteMany(...args),
  },
  MCPServerConfig: {
    find: vi.fn((...args: any[]) => ({
      select: () => ({ lean: () => mockMCPServerConfigFind(...args) }),
    })),
    insertMany: (...args: any[]) => mockMCPServerConfigInsertMany(...args),
    bulkWrite: (...args: any[]) => mockMCPServerConfigBulkWrite(...args),
    deleteMany: (...args: any[]) => mockMCPServerConfigDeleteMany(...args),
  },
  ProjectTool: {
    find: vi.fn((...args: any[]) => ({
      lean: () => mockProjectToolFind(...args),
      select: () => ({ lean: () => mockProjectToolFind(...args) }),
    })),
    insertMany: (...args: any[]) => mockProjectToolInsertMany(...args),
    bulkWrite: (...args: any[]) => mockProjectToolBulkWrite(...args),
    deleteMany: (...args: any[]) => mockProjectToolDeleteMany(...args),
  },
  SearchIndex: {
    findOne: vi.fn((...args: any[]) => ({ lean: () => mockSearchIndexFindOne(...args) })),
  },
  ConnectorConfig: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockConnectorConfigFind(...args) })),
  },
  ProjectConfigVariable: {
    find: vi.fn((...args: any[]) => ({
      select: () => ({ lean: () => mockProjectConfigVariableFind(...args) }),
    })),
    insertMany: (...args: any[]) => mockProjectConfigVariableInsertMany(...args),
    bulkWrite: (...args: any[]) => mockProjectConfigVariableBulkWrite(...args),
    deleteMany: (...args: any[]) => mockProjectConfigVariableDeleteMany(...args),
  },
  ProjectRuntimeConfig: {
    findOne: vi.fn((...args: any[]) => ({ lean: () => mockProjectRuntimeConfigFindOne(...args) })),
    findOneAndUpdate: (...args: any[]) => mockProjectRuntimeConfigFindOneAndUpdate(...args),
    deleteOne: (...args: any[]) => mockProjectRuntimeConfigDeleteOne(...args),
  },
  ProjectLLMConfig: {
    findOne: vi.fn((...args: any[]) => ({ lean: () => mockProjectLLMConfigFindOne(...args) })),
    findOneAndUpdate: (...args: any[]) => mockProjectLLMConfigFindOneAndUpdate(...args),
    deleteOne: (...args: any[]) => mockProjectLLMConfigDeleteOne(...args),
  },
  ModelConfig: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockModelConfigFind(...args) })),
    findOneAndUpdate: (...args: any[]) => mockModelConfigFindOneAndUpdate(...args),
    deleteOne: (...args: any[]) => mockModelConfigDeleteOne(...args),
  },
  TenantModel: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockTenantModelFind(...args) })),
    distinct: vi.fn().mockResolvedValue([]),
  },
  AgentModelConfig: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockAgentModelConfigFind(...args) })),
    findOneAndUpdate: (...args: any[]) => mockAgentModelConfigFindOneAndUpdate(...args),
    deleteOne: (...args: any[]) => mockAgentModelConfigDeleteOne(...args),
  },
  Deployment: {
    find: vi.fn((...args: any[]) => ({ lean: () => mockDeploymentFind(...args) })),
  },
}));

vi.mock('@agent-platform/project-io/export', () => ({
  exportProject: (...args: any[]) => mockExportProject(...args),
  exportProjectV2: (...args: any[]) => mockExportProjectV2(...args),
  resolveLayers: (...args: any[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: any[]) =>
    mockResolveLayersForToolDependencies(...args),
  buildDefaultAssemblerMap: (...args: any[]) => mockBuildDefaultAssemblerMap(...args),
  buildLayerPreview: (...args: any[]) => mockBuildLayerPreview(...args),
  buildExportProvisioningRequirements: (...args: any[]) =>
    mockBuildExportProvisioningRequirements(...args),
  extractProfileManifestEntries: (...args: any[]) => mockExtractProfileManifestEntries(...args),
  scanProjectEnvVars: (...args: any[]) => mockScanProjectEnvVars(...args),
}));

vi.mock('@agent-platform/project-io/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/project-io/import')>();
  return {
    ...actual,
    buildCoreImportApplyPlanV2: (...args: any[]) => mockBuildCoreImportApplyPlanV2(...args),
    previewCoreImportV2: (...args: any[]) => mockPreviewCoreImportV2(...args),
    applyCoreImportV2: (...args: any[]) => mockApplyCoreImportV2(...args),
    resolveAdvancedNluEntitlement: (...args: any[]) => mockResolveAdvancedNluEntitlement(...args),
  };
});

vi.mock('@agent-platform/project-io/dependencies', () => ({
  buildDependencyGraph: (...args: any[]) => mockBuildDependencyGraph(...args),
  validateDependencies: (...args: any[]) => mockValidateDependencies(...args),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => mockRedisClient,
  getRedisHandle: () => ({
    client: mockRedisClient,
    isReady: () => true,
    duplicate: () => (mockRedisClient.duplicate ? mockRedisClient.duplicate() : mockRedisClient),
    disconnect: async () => {},
  }),
}));

vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: any[]) => mockInvalidateModelResolutionCaches(...args),
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: (...args: any[]) => mockTenantConfigGetConfig(...args),
  }),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

// Route imports requireProjectScope from @agent-platform/shared-auth
vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
}));

// RBAC uses hasPermission from shared-auth/rbac
vi.mock('@agent-platform/shared-auth/rbac', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('../openapi/registry.js', () => ({
  requirePermissionInline: vi.fn(),
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// RBAC repository mocks — used by real requireProjectPermission middleware
vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'proj-admin-user': { role: 'admin' },
      'proj-dev-user': { role: 'developer' },
      'proj-viewer-user': { role: 'viewer' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'OPERATOR' }),
}));

vi.mock('../repos/variable-namespace-repo.js', () => ({
  getOrCreateDefaultNamespace: (...args: any[]) => mockGetOrCreateDefaultNamespace(...args),
}));

// =============================================================================
// IMPORTS — after all mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';
import { findProjectByIdAndTenant, findProjectMember } from '../repos/project-repo.js';

// =============================================================================
// HELPERS
// =============================================================================

const IO_BASE = '/api/projects/proj-1/project-io';

async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: any; rawBody?: string },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let bodyStr: string | undefined;
  if (opts?.rawBody !== undefined) {
    bodyStr = opts.rawBody;
  } else if (opts?.body !== undefined) {
    bodyStr = JSON.stringify(opts.body);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyStr,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createServerForUser(
  tenantRole: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
  userId: string,
) {
  const app = express();
  // DO NOT add express.json() here — import routes have their own body parser (60MB limit)
  const ctx = makeTenantContext('tenant-A', userId, tenantRole);
  app.use(injectTenantContext(ctx));
  const projectIORouter = (await import('../routes/project-io.js')).default;
  app.use('/api/projects/:projectId/project-io', projectIORouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function createUnauthenticatedServer() {
  const app = express();
  const projectIORouter = (await import('../routes/project-io.js')).default;
  app.use('/api/projects/:projectId/project-io', projectIORouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// Default mock data
const DEFAULT_PROJECT = {
  _id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  description: 'A test project',
  entryAgentName: null,
  tenantId: 'tenant-A',
  ownerId: 'project-owner',
};

const DEFAULT_AGENTS: any[] = [
  {
    name: 'booking_agent',
    description: 'Booking agent',
    dslContent: 'AGENT: booking_agent\nGOAL: Book things',
    dslValidationStatus: 'valid',
    dslDiagnostics: [],
    ownerId: null,
    ownerTeamId: null,
  },
];

const VALID_IMPORT_BODY = {
  files: {
    'agents/test.agent.abl': 'AGENT: test_agent\nGOAL: Test agent',
  },
};

function makeCorePlan(input?: {
  agentOperations?: Array<{
    type: 'create' | 'update' | 'delete';
    agentName: string;
    description: string | null;
    dslContent: string | null;
    systemPromptLibraryRef?: {
      promptId: string;
      versionId: string;
      resolvedHash?: string;
    } | null;
    sourceHash?: string | null;
  }>;
  promptOperations?: Array<{
    type: 'create' | 'update' | 'delete';
    promptId: string;
    promptName?: string;
    name?: string;
    description: string | null;
    tags: string[];
    status: 'active' | 'archived';
    nextVersionNumber: number;
    versions: Array<{
      versionId: string;
      versionNumber: number;
      template: string;
      variables: string[];
      description: string | null;
      status: 'draft' | 'active' | 'archived';
      sourceHash: string;
      metadata?: Record<string, unknown> | null;
    }>;
    sourceHash: string | null;
    sourceFile: string | null;
  }>;
  toolOperations?: Array<{
    type: 'create' | 'update' | 'delete';
    toolName: string;
    toolType: string | null;
    description: string | null;
    dslContent: string | null;
    sourceHash: string | null;
    sourceFile: string | null;
    autogenerated?: boolean;
  }>;
  localeOperations?: Array<{
    type: 'create' | 'update' | 'delete';
    relativePath: string;
    filePath: string;
    value: string | null;
    description: string | null;
    sourceHash: string | null;
    sourceFile: string | null;
  }>;
  profileOperations?: Array<{
    type: 'create' | 'update' | 'delete';
    profileName: string;
    filePath: string;
    dslContent: string | null;
    sourceHash: string | null;
    sourceFile: string | null;
  }>;
  modelPolicyOperations?: Array<{
    type: 'upsert' | 'delete';
    configType: 'runtime' | 'llm' | 'project_model' | 'agent_model';
    agentName?: string;
    data?: Record<string, unknown>;
  }>;
  preview?: {
    agentChanges?: {
      added?: string[];
      modified?: Array<{ name: string; diff: Record<string, unknown> }>;
      removed?: string[];
      unchanged?: string[];
    };
    promptChanges?: { added?: string[]; modified?: string[]; removed?: string[] };
    toolChanges?: { added?: string[]; modified?: string[]; removed?: string[] };
    localeChanges?: { added?: string[]; modified?: string[]; removed?: string[] };
    profileChanges?: { added?: string[]; modified?: string[]; removed?: string[] };
    entryAgentResolution?: { requested: string | null; resolved: string | null; matchedBy: string };
  };
  warnings?: string[];
  entryAgentName?: string | null;
}) {
  const agentOperations = input?.agentOperations?.map((operation) => ({
    ...operation,
    sourceHash: operation.type === 'delete' ? null : (operation.sourceHash ?? 'hash-123'),
  })) ?? [
    {
      type: 'create' as const,
      agentName: 'test_agent',
      description: null,
      dslContent: 'AGENT: test_agent\nGOAL: Test',
      systemPromptLibraryRef: null,
      sourceHash: 'hash-123',
    },
  ];
  const promptOperations =
    input?.promptOperations?.map((operation) => {
      const promptName = operation.promptName ?? operation.name ?? operation.promptId;
      return {
        type: operation.type,
        promptId: operation.promptId,
        promptName,
        bundle:
          operation.type === 'delete'
            ? null
            : {
                promptId: operation.promptId,
                name: promptName,
                description: operation.description,
                tags: operation.tags,
                status: operation.status,
                nextVersionNumber: operation.nextVersionNumber,
                versions: operation.versions,
              },
        sourceHash: operation.type === 'delete' ? null : operation.sourceHash,
        sourceFile: operation.type === 'delete' ? null : operation.sourceFile,
      };
    }) ?? [];
  const toolOperations =
    input?.toolOperations?.map((operation) => ({
      autogenerated: false,
      ...operation,
    })) ?? [];
  const localeOperations = input?.localeOperations ?? [];
  const profileOperations = input?.profileOperations ?? [];
  const modelPolicyOperations = input?.modelPolicyOperations ?? [];
  const modelPoliciesUpserted = modelPolicyOperations.filter(
    (operation) => operation.type === 'upsert',
  ).length;
  const modelPoliciesDeleted = modelPolicyOperations.filter(
    (operation) => operation.type === 'delete',
  ).length;

  return {
    preparedFiles: new Map<string, string>(),
    preview: {
      valid: true,
      formatVersion: '2.0' as const,
      layers: ['core'],
      layerChanges: {
        core: {
          added:
            agentOperations.filter((operation) => operation.type === 'create').length +
            promptOperations.filter((operation) => operation.type === 'create').length +
            toolOperations.filter((operation) => operation.type === 'create').length +
            localeOperations.filter((operation) => operation.type === 'create').length +
            profileOperations.filter((operation) => operation.type === 'create').length +
            modelPoliciesUpserted,
          modified:
            agentOperations.filter((operation) => operation.type === 'update').length +
            promptOperations.filter((operation) => operation.type === 'update').length +
            toolOperations.filter((operation) => operation.type === 'update').length +
            localeOperations.filter((operation) => operation.type === 'update').length +
            profileOperations.filter((operation) => operation.type === 'update').length,
          removed:
            agentOperations.filter((operation) => operation.type === 'delete').length +
            promptOperations.filter((operation) => operation.type === 'delete').length +
            toolOperations.filter((operation) => operation.type === 'delete').length +
            localeOperations.filter((operation) => operation.type === 'delete').length +
            profileOperations.filter((operation) => operation.type === 'delete').length +
            modelPoliciesDeleted,
          unchanged: 0,
        },
      },
      agentChanges: {
        added:
          input?.preview?.agentChanges?.added ??
          agentOperations
            .filter((operation) => operation.type === 'create')
            .map((operation) => operation.agentName),
        modified:
          input?.preview?.agentChanges?.modified ??
          agentOperations
            .filter((operation) => operation.type === 'update')
            .map((operation) => ({ name: operation.agentName, diff: {} })),
        removed:
          input?.preview?.agentChanges?.removed ??
          agentOperations
            .filter((operation) => operation.type === 'delete')
            .map((operation) => operation.agentName),
        unchanged: input?.preview?.agentChanges?.unchanged ?? [],
      },
      promptChanges: {
        added:
          input?.preview?.promptChanges?.added ??
          promptOperations
            .filter((operation) => operation.type === 'create')
            .map((operation) => operation.promptName),
        modified:
          input?.preview?.promptChanges?.modified ??
          promptOperations
            .filter((operation) => operation.type === 'update')
            .map((operation) => operation.promptName),
        removed:
          input?.preview?.promptChanges?.removed ??
          promptOperations
            .filter((operation) => operation.type === 'delete')
            .map((operation) => operation.promptName),
      },
      toolChanges: {
        added:
          input?.preview?.toolChanges?.added ??
          toolOperations
            .filter((operation) => operation.type === 'create')
            .map((operation) => operation.toolName),
        modified:
          input?.preview?.toolChanges?.modified ??
          toolOperations
            .filter((operation) => operation.type === 'update')
            .map((operation) => operation.toolName),
        removed:
          input?.preview?.toolChanges?.removed ??
          toolOperations
            .filter((operation) => operation.type === 'delete')
            .map((operation) => operation.toolName),
      },
      localeChanges: {
        added:
          input?.preview?.localeChanges?.added ??
          localeOperations
            .filter((operation) => operation.type === 'create')
            .map((operation) => operation.filePath),
        modified:
          input?.preview?.localeChanges?.modified ??
          localeOperations
            .filter((operation) => operation.type === 'update')
            .map((operation) => operation.filePath),
        removed:
          input?.preview?.localeChanges?.removed ??
          localeOperations
            .filter((operation) => operation.type === 'delete')
            .map((operation) => operation.filePath),
      },
      profileChanges: {
        added:
          input?.preview?.profileChanges?.added ??
          profileOperations
            .filter((operation) => operation.type === 'create')
            .map((operation) => operation.filePath),
        modified:
          input?.preview?.profileChanges?.modified ??
          profileOperations
            .filter((operation) => operation.type === 'update')
            .map((operation) => operation.filePath),
        removed:
          input?.preview?.profileChanges?.removed ??
          profileOperations
            .filter((operation) => operation.type === 'delete')
            .map((operation) => operation.filePath),
      },
      shaIntegrity: {
        valid: true,
        integrityMatch: true,
        layerResults: {},
        errors: [],
        warnings: [],
      },
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [],
      hasBlockingIssues: false,
      requiresAcknowledgement: false,
      blockingIssueCount: 0,
      nonBlockingIssueCount: 0,
      entryAgentResolution: input?.preview?.entryAgentResolution ?? {
        requested: null,
        resolved: input?.entryAgentName ?? null,
        matchedBy: 'none',
      },
      previewDigest: 'preview-digest-1',
      warnings: input?.warnings ?? [],
    },
    agentOperations,
    promptOperations,
    toolOperations,
    mcpServerOperations: [],
    localeOperations,
    profileOperations,
    modelPolicyOperations,
    evalOperations: [],
    entryAgentName: input?.entryAgentName ?? null,
    warnings: input?.warnings ?? [],
    applied: {
      created: agentOperations.filter((operation) => operation.type === 'create').length,
      updated: agentOperations.filter((operation) => operation.type === 'update').length,
      deleted: agentOperations.filter((operation) => operation.type === 'delete').length,
      promptsCreated: promptOperations.filter((operation) => operation.type === 'create').length,
      promptsUpdated: promptOperations.filter((operation) => operation.type === 'update').length,
      promptsDeleted: promptOperations.filter((operation) => operation.type === 'delete').length,
      toolsCreated: toolOperations.filter((operation) => operation.type === 'create').length,
      toolsUpdated: toolOperations.filter((operation) => operation.type === 'update').length,
      toolsDeleted: toolOperations.filter((operation) => operation.type === 'delete').length,
      localesCreated: localeOperations.filter((operation) => operation.type === 'create').length,
      localesUpdated: localeOperations.filter((operation) => operation.type === 'update').length,
      localesDeleted: localeOperations.filter((operation) => operation.type === 'delete').length,
      profilesCreated: profileOperations.filter((operation) => operation.type === 'create').length,
      profilesUpdated: profileOperations.filter((operation) => operation.type === 'update').length,
      profilesDeleted: profileOperations.filter((operation) => operation.type === 'delete').length,
      modelPoliciesUpserted,
      modelPoliciesDeleted,
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Project I/O route authorization and validation', () => {
  beforeEach(() => {
    // Database model mocks
    mockProjectFindOne.mockReset().mockResolvedValue(DEFAULT_PROJECT);
    mockProjectFindOneAndUpdate.mockReset().mockResolvedValue(DEFAULT_PROJECT);
    mockProjectAgentFind.mockReset().mockResolvedValue(DEFAULT_AGENTS);
    mockPromptLibraryItemFind.mockReset().mockResolvedValue([]);
    mockPromptLibraryVersionFind.mockReset().mockResolvedValue([]);
    mockPromptLibraryItemInsertMany.mockReset().mockResolvedValue([]);
    mockPromptLibraryItemBulkWrite.mockReset().mockResolvedValue(undefined);
    mockPromptLibraryItemDeleteMany.mockReset().mockResolvedValue(undefined);
    mockPromptLibraryVersionInsertMany.mockReset().mockResolvedValue([]);
    mockPromptLibraryVersionDeleteMany.mockReset().mockResolvedValue(undefined);
    mockMCPServerConfigFind.mockReset().mockResolvedValue([]);
    mockMCPServerConfigInsertMany.mockReset().mockResolvedValue([{ _id: 'new-mcp-1' }]);
    mockMCPServerConfigBulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
    mockMCPServerConfigDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockProjectToolFind.mockReset().mockResolvedValue([]);
    mockSearchIndexFindOne.mockReset().mockResolvedValue(null);
    mockDeploymentFind.mockReset().mockResolvedValue([]);
    mockProjectAgentInsertMany.mockReset().mockResolvedValue([{ _id: 'new-agent-1' }]);
    mockProjectAgentBulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
    mockProjectAgentDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockConnectorConfigFind.mockReset().mockResolvedValue([]);
    mockProjectToolInsertMany.mockReset().mockResolvedValue([{ _id: 'new-tool-1' }]);
    mockProjectToolBulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
    mockProjectToolDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockProjectConfigVariableFind.mockReset().mockResolvedValue([]);
    mockProjectConfigVariableInsertMany.mockReset().mockResolvedValue([{ _id: 'new-locale-1' }]);
    mockProjectConfigVariableBulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
    mockProjectConfigVariableDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockProjectRuntimeConfigFindOne.mockReset().mockResolvedValue(null);
    mockProjectRuntimeConfigFindOneAndUpdate
      .mockReset()
      .mockResolvedValue({ _id: 'runtime-config-1' });
    mockProjectRuntimeConfigDeleteOne.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockProjectLLMConfigFindOne.mockReset().mockResolvedValue(null);
    mockProjectLLMConfigFindOneAndUpdate.mockReset().mockResolvedValue({ _id: 'llm-config-1' });
    mockProjectLLMConfigDeleteOne.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockGetOrCreateDefaultNamespace.mockReset().mockResolvedValue({ _id: 'ns-default' });
    mockModelConfigFind.mockReset().mockResolvedValue([]);
    mockModelConfigFindOneAndUpdate.mockReset().mockResolvedValue({ _id: 'model-config-1' });
    mockModelConfigDeleteOne.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockTenantModelFind.mockReset().mockResolvedValue([
      {
        _id: 'tm-destination',
        provider: 'openai',
        modelId: 'gpt-4o',
        capabilities: ['text', 'streaming'],
      },
    ]);
    mockAgentModelConfigFind.mockReset().mockResolvedValue([]);
    mockAgentModelConfigFindOneAndUpdate.mockReset().mockResolvedValue({ _id: 'agent-config-1' });
    mockAgentModelConfigDeleteOne.mockReset().mockResolvedValue({ deletedCount: 0 });
    mockTenantConfigGetConfig.mockReset().mockResolvedValue({ features: { advancedNlu: true } });
    mockResolveAdvancedNluEntitlement.mockReset().mockResolvedValue({ allowed: true });
    mockInvalidateModelResolutionCaches.mockReset();

    // Export mock
    mockExportProject.mockReset().mockReturnValue({
      success: true,
      files: new Map([['agents/booking_agent.abl', 'AGENT: booking_agent\nGOAL: Book']]),
      manifest: { version: '1.0' },
      lockfile: {},
      warnings: [],
    });
    mockExportProjectV2.mockReset().mockResolvedValue({
      success: true,
      files: new Map([
        ['agents/booking_agent.agent.yaml', 'agent: booking_agent'],
        ['project.json', '{"format_version":"2.0"}'],
        ['abl.lock', '{"lockfile_version":"2.0"}'],
      ]),
      manifest: { format_version: '2.0' },
      lockfile: { lockfile_version: '2.0' },
      warnings: [],
    });
    mockResolveLayers
      .mockReset()
      .mockReturnValue(['core', 'connections', 'guardrails', 'workflows']);
    mockResolveLayersForToolDependencies.mockReset().mockImplementation((layers: string[]) => {
      const resolved = new Set(layers);
      resolved.add('core');
      return [...resolved];
    });
    mockBuildDefaultAssemblerMap.mockReset().mockReturnValue(new Map());
    mockBuildLayerPreview.mockReset().mockResolvedValue([
      { name: 'core', defaultMode: 'always', entityCount: 2 },
      { name: 'connections', defaultMode: 'always', entityCount: 0 },
      { name: 'guardrails', defaultMode: 'on', entityCount: 0 },
      { name: 'workflows', defaultMode: 'on', entityCount: 0 },
      { name: 'evals', defaultMode: 'off', entityCount: 0 },
      { name: 'search', defaultMode: 'off', entityCount: 0 },
      { name: 'channels', defaultMode: 'off', entityCount: 0 },
      { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
    ]);
    mockBuildExportProvisioningRequirements.mockReset().mockReturnValue({
      requiredEnvVars: [],
      requiredConnectors: [],
      requiredMcpServers: [],
    });
    mockExtractProfileManifestEntries
      .mockReset()
      .mockImplementation((profiles: Map<string, string>, _agents: Array<{ name: string }>) =>
        Array.from(profiles.keys()).map((name) => ({
          name,
          file: `behavior_profiles/${name}.behavior_profile.abl`,
          sha256: `sha-${name}`,
          attached_agents: [],
        })),
      );
    mockScanProjectEnvVars.mockReset().mockReturnValue([]);

    // Import mock
    mockBuildCoreImportApplyPlanV2.mockReset().mockResolvedValue({
      success: true,
      plan: makeCorePlan(),
    });
    mockPreviewCoreImportV2.mockReset().mockImplementation(async (input: any) => {
      const currentState = await input.stateStore.loadCurrentState();
      const planResult = await mockBuildCoreImportApplyPlanV2(
        input.files,
        {
          agents: new Map(
            currentState.agents.map((agent: any) => [
              agent.name,
              {
                name: agent.name,
                dslContent: agent.dslContent,
                systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
              },
            ]),
          ),
          prompts: new Map(
            (currentState.prompts ?? []).map((prompt: any) => [prompt.promptId, prompt]),
          ),
          toolFiles: new Map(),
          tools: new Map(
            currentState.tools.map((tool: any) => [
              tool.name,
              { name: tool.name, dslContent: tool.dslContent },
            ]),
          ),
          localeFiles: new Map(
            (currentState.locales ?? []).map((locale: any) => [
              `locales/${locale.relativePath}`,
              locale.value,
            ]),
          ),
          profileFiles: new Map(
            (currentState.profiles ?? []).map((profile: any) => [
              `behavior_profiles/${profile.name}.behavior_profile.abl`,
              profile.dslContent,
            ]),
          ),
          projectModelConfigs: new Map(
            (currentState.projectModelConfigs ?? []).map((config: any) => [config.name, config]),
          ),
          agentModelConfigs: new Map(
            (currentState.agentModelConfigs ?? []).map((config: any) => [config.agentName, config]),
          ),
          activeRecords: new Map(),
        },
        input.planOptions,
      );
      if (!planResult.success) {
        return {
          success: false,
          error: planResult.error,
          preview: planResult.preview,
          warnings: planResult.warnings ?? [],
        };
      }
      return {
        success: true,
        currentState,
        plan: planResult.plan,
        preview: planResult.plan.preview,
        warnings: planResult.plan.warnings,
      };
    });
    mockApplyCoreImportV2.mockReset().mockImplementation(async (input: any) => {
      const currentState = await input.stateStore.loadCurrentState();
      const planResult = await mockBuildCoreImportApplyPlanV2(
        input.files,
        {
          agents: new Map(
            currentState.agents.map((agent: any) => [
              agent.name,
              {
                name: agent.name,
                dslContent: agent.dslContent,
                systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
              },
            ]),
          ),
          prompts: new Map(
            (currentState.prompts ?? []).map((prompt: any) => [prompt.promptId, prompt]),
          ),
          toolFiles: new Map(),
          tools: new Map(
            currentState.tools.map((tool: any) => [
              tool.name,
              { name: tool.name, dslContent: tool.dslContent },
            ]),
          ),
          localeFiles: new Map(
            (currentState.locales ?? []).map((locale: any) => [
              `locales/${locale.relativePath}`,
              locale.value,
            ]),
          ),
          profileFiles: new Map(
            (currentState.profiles ?? []).map((profile: any) => [
              `behavior_profiles/${profile.name}.behavior_profile.abl`,
              profile.dslContent,
            ]),
          ),
          projectModelConfigs: new Map(
            (currentState.projectModelConfigs ?? []).map((config: any) => [config.name, config]),
          ),
          agentModelConfigs: new Map(
            (currentState.agentModelConfigs ?? []).map((config: any) => [config.agentName, config]),
          ),
          activeRecords: new Map(),
        },
        input.planOptions,
      );
      if (!planResult.success) {
        return {
          success: false,
          stage: 'prepare',
          error: planResult.error,
          preview: planResult.preview,
          warnings: planResult.warnings ?? [],
        };
      }

      const { executeCoreImportApplyPlanV2 } = await import('@agent-platform/project-io/import');
      const applyResult = await executeCoreImportApplyPlanV2(planResult.plan, input.adapter);
      if (!applyResult.success) {
        return {
          success: false,
          stage: 'apply',
          error: applyResult.error,
          preview: planResult.plan.preview,
          warnings: planResult.plan.warnings,
        };
      }

      return {
        success: true,
        preview: planResult.plan.preview,
        warnings: planResult.plan.warnings,
        applied: applyResult.applied,
        entryAgentName: applyResult.entryAgentName,
      };
    });

    // Dependency graph mock
    mockBuildDependencyGraph.mockReset().mockReturnValue({ edges: [] });
    mockValidateDependencies
      .mockReset()
      .mockReturnValue({ valid: true, missing: [], circular: [] });

    // Redis — no Redis by default (dev mode)
    mockRedisClient = null;

    // Reset RBAC repo mocks
    vi.mocked(findProjectByIdAndTenant).mockReset().mockResolvedValue({
      _id: 'proj-1',
      tenantId: 'tenant-A',
      ownerId: 'project-owner',
    });
    vi.mocked(findProjectMember)
      .mockReset()
      .mockImplementation((_projectId: string, userId: string) => {
        const memberships: Record<string, { role: string }> = {
          'proj-admin-user': { role: 'admin' },
          'proj-dev-user': { role: 'developer' },
          'proj-viewer-user': { role: 'viewer' },
        };
        return Promise.resolve(memberships[userId] ?? null);
      });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated → 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('GET /export returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /export/preview returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /import/preview returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /import returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant → 404 (tenant isolation)
  // ---------------------------------------------------------------------------
  describe('Cross-tenant isolation', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // OPERATOR has no project:* wildcard → falls through to project lookup in RBAC
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'cross-tenant-user'));
    });
    afterAll(() => server?.close());

    test('GET /export returns 404 for project not in tenant', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValueOnce(null);
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /export/preview returns 404 for project not in tenant', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValueOnce(null);
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /import/preview returns 404 for project not in tenant', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValueOnce(null);
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /import returns 404 for project not in tenant', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValueOnce(null);
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC: Tenant OWNER — workspace authority bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('GET /export passes (workspace authority)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import passes (workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC: Tenant ADMIN — has *:* wildcard → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant ADMIN (wildcard permissions)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('ADMIN', 'admin-user'));
    });
    afterAll(() => server?.close());

    test('GET /export passes', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import passes', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC: Project admin — has *:* via project membership → all pass
  // ---------------------------------------------------------------------------
  describe('Project admin (RBAC)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // OPERATOR tenant role → no wildcard → falls through to project membership
      // findProjectMember returns { role: 'admin' } for 'proj-admin-user'
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-admin-user'));
    });
    afterAll(() => server?.close());

    test('GET /export passes (admin has *:*)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /export/preview passes (admin has *:*)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import passes (admin has *:*)', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import/preview passes (admin has *:*)', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC: Project viewer — can export, cannot import
  // ---------------------------------------------------------------------------
  describe('Project viewer (RBAC)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // MEMBER tenant role → no project:* → falls through to project membership
      // findProjectMember returns { role: 'viewer' } for 'proj-viewer-user'
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET /export/preview passes (viewer has project:export)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /export passes (viewer has project:export)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import/preview returns 403 (viewer lacks project:import)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('POST /import returns 403 (viewer lacks project:import)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC: Project developer — can both export and import
  // Also used for functional tests (validation, guards, happy paths, etc.)
  // ---------------------------------------------------------------------------
  describe('Project developer (RBAC + functional tests)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // OPERATOR tenant role → no project:* → falls through to project membership
      // findProjectMember returns { role: 'developer' } for 'proj-dev-user'
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    // -- RBAC passes --

    test('GET /export passes (developer has project:export)', async () => {
      const { status } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import/preview passes (developer has project:import)', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /import passes (developer has project:import)', async () => {
      const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    // -- Input validation --

    describe('Import input validation', () => {
      test('rejects missing files field', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: {},
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('files');
      });

      test('rejects empty files', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: {} },
        });
        expect(status).toBe(400);
        expect(body.error.message).toBe('No files provided');
      });

      test('rejects path traversal: ../', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { '../etc/passwd': 'malicious' } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('path traversal');
      });

      test('rejects path traversal: absolute path', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { '/etc/passwd': 'malicious' } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('path traversal');
      });

      test('rejects path traversal: backslash', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { 'agents\\foo.abl': 'content' } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('path traversal');
      });

      test('rejects non-string file content', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { 'a.abl': 123 } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('must be a string');
      });

      test('rejects oversized file (> 1MB)', async () => {
        const bigContent = 'x'.repeat(1024 * 1024 + 1);
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { 'agents/big.abl': bigContent } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('File too large');
      });

      test('rejects path traversal: null byte', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: { 'agents/foo\u0000.abl': 'content' } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('path traversal');
      });

      test('rejects too many files (> 500)', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 501; i++) {
          files[`agents/agent_${i}.abl`] = `AGENT: agent_${i}
GOAL: "Handle agent tasks"`;
        }
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('Too many files');
        expect(body.error.message).toContain('501');
      });

      test('rejects total content size exceeding 50MB', async () => {
        // 52 files of ~1MB each = ~52MB > 50MB limit
        const files: Record<string, string> = {};
        const contentJustUnder1MB = 'x'.repeat(1024 * 1024 - 100);
        for (let i = 0; i < 52; i++) {
          files[`agents/agent_${i}.abl`] = contentJustUnder1MB;
        }
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('50MB');
      });

      test('rejects files field as non-object (string)', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: 'not-an-object' },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('files');
      });

      test('rejects files field as null', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: null },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('files');
      });

      test('files field as array is treated as object (edge case)', async () => {
        // Arrays pass typeof === 'object' and Object.entries produces valid [index, value] pairs.
        // This is technically valid input — entries like ['0', 'not'] are strings mapped to strings.
        // The import will process them (likely failing at DSL parsing, not input validation).
        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { files: ['not', 'an', 'object'] },
        });
        // Should not crash — processed as { '0': 'not', '1': 'an', '2': 'object' }
        expect(status).not.toBe(500);
      });

      test('rejects non-boolean deleteUnmatched', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { ...VALID_IMPORT_BODY, deleteUnmatched: 'yes' },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('deleteUnmatched');
      });

      test('validation applies to /import as well as /import/preview', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: { files: { '../etc/passwd': 'malicious' } },
        });
        expect(status).toBe(400);
        expect(body.error.message).toContain('path traversal');
      });
    });

    // -- Export guards --

    describe('Export guards', () => {
      test('rejects export when project has > 1000 agents', async () => {
        const manyAgents = Array.from({ length: 1001 }, (_, i) => ({
          name: `agent_${i}`,
          dslContent: `AGENT: agent_${i}
GOAL: "Handle agent tasks"`,
        }));
        mockProjectAgentFind.mockResolvedValueOnce(manyAgents);

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(400);
        expect(body.error.message).toContain('too many agents');
      });

      test('rejects export when project has > 500 tools', async () => {
        const manyTools = Array.from({ length: 501 }, (_, i) => ({
          name: `tool_${i}`,
          slug: `tool_${i}`,
          toolType: 'http',
          dslContent: `TOOL: tool_${i}`,
        }));
        mockProjectToolFind.mockResolvedValueOnce(manyTools);

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(400);
        expect(body.error.message).toContain('too many tools');
      });

      test('returns 400 when exportProjectV2 returns success: false', async () => {
        mockExportProjectV2.mockResolvedValueOnce({
          success: false,
          error: { code: 'MANIFEST_ERROR', message: 'Manifest generation failed' },
          files: new Map(),
          manifest: {},
          lockfile: {},
          warnings: [],
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Manifest generation failed');
      });

      test('rejects export response exceeding 100MB', async () => {
        // Mock exportProject returning a very large file map
        const hugeContent = 'x'.repeat(60 * 1024 * 1024); // 60MB per file
        mockExportProjectV2.mockResolvedValueOnce({
          success: true,
          files: new Map([
            ['agents/big1.abl', hugeContent],
            ['agents/big2.abl', hugeContent],
          ]),
          manifest: { version: '1.0' },
          lockfile: {},
          warnings: [],
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(400);
        expect(body.error.message).toContain('Export response too large');
        expect(body.error.message).toContain('100MB');
      });
    });

    // -- Happy paths --

    describe('Happy paths', () => {
      test('GET /export/preview returns profiles, dependencies, and canonical layer metadata', async () => {
        mockProjectConfigVariableFind.mockResolvedValueOnce([
          {
            key: 'profile:vip_support',
            value: 'BEHAVIOR_PROFILE vip_support',
          },
        ]);
        mockConnectorConfigFind.mockResolvedValueOnce([
          { connectorType: 'salesforce' },
          { connectorType: 'salesforce' },
        ]);
        mockMCPServerConfigFind.mockResolvedValueOnce([{ name: 'docs-mcp' }]);
        mockBuildExportProvisioningRequirements.mockReturnValueOnce({
          requiredEnvVars: ['OPENAI_API_KEY'],
          requiredAuthProfiles: [
            {
              authType: 'unknown',
              config: {},
              name: 'zendesk_oauth',
              referencedBy: ['booking_agent'],
              scope: 'project',
            },
          ],
          requiredConnectors: ['salesforce'],
          requiredMcpServers: ['docs-mcp'],
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
        expect(status).toBe(200);
        expect(body.project).toEqual({ name: 'Test Project', slug: 'test-project' });
        expect(body.agents).toHaveLength(1);
        expect(body.agents[0].name).toBe('booking_agent');
        expect(body.profiles).toEqual(['vip_support']);
        expect(body.provisioning).toEqual({
          requiredEnvVars: ['OPENAI_API_KEY'],
          requiredAuthProfiles: [
            {
              authType: 'unknown',
              config: {},
              name: 'zendesk_oauth',
              referencedBy: ['booking_agent'],
              scope: 'project',
            },
          ],
          requiredConnectors: ['salesforce'],
          requiredMcpServers: ['docs-mcp'],
        });
        expect(body.dependencies).toBeDefined();
        expect(body.dependencies.validation).toEqual({ valid: true, missing: [], circular: [] });
        expect(body.layers).toEqual([
          { name: 'core', defaultMode: 'always', entityCount: 2 },
          { name: 'connections', defaultMode: 'always', entityCount: 0 },
          { name: 'guardrails', defaultMode: 'on', entityCount: 0 },
          { name: 'workflows', defaultMode: 'on', entityCount: 0 },
          { name: 'evals', defaultMode: 'off', entityCount: 0 },
          { name: 'search', defaultMode: 'off', entityCount: 0 },
          { name: 'channels', defaultMode: 'off', entityCount: 0 },
          { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
        ]);
        expect(body.defaultLayers).toEqual(['core', 'connections', 'guardrails', 'workflows']);
        expect(mockBuildLayerPreview).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'proj-1', tenantId: 'tenant-A' }),
        );
      });

      test('GET /export returns a canonical v2 layered export response', async () => {
        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.version).toBe(2);
        expect(body.files).toBeDefined();
        expect(body.files['agents/booking_agent.agent.yaml']).toBeDefined();
        expect(body.files['project.json']).toBe('{"format_version":"2.0"}');
        expect(body.files['abl.lock']).toBe('{"lockfile_version":"2.0"}');
        expect(body.manifest).toBeDefined();
        expect(body.lockfile).toBeDefined();
        expect(body.warnings).toEqual([]);
      });

      test('GET /export/preview blocks saved drafts with validation errors', async () => {
        mockProjectAgentFind.mockResolvedValueOnce([
          {
            ...DEFAULT_AGENTS[0],
            dslValidationStatus: 'error',
            dslDiagnostics: [
              {
                severity: 'error',
                message: 'Unknown handoff target',
                source: 'runtime-import',
              },
            ],
          },
        ]);

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);

        expect(status).toBe(409);
        expect(mockBuildDependencyGraph).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [{ agentName: DEFAULT_AGENTS[0].name }],
        });
      });

      test('GET /export blocks saved drafts with validation errors', async () => {
        mockProjectAgentFind.mockResolvedValueOnce([
          {
            ...DEFAULT_AGENTS[0],
            dslValidationStatus: 'error',
            dslDiagnostics: [
              {
                severity: 'error',
                message: 'Unknown handoff target',
                source: 'runtime-import',
              },
            ],
          },
        ]);

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);

        expect(status).toBe(409);
        expect(mockExportProjectV2).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [
            {
              agentName: DEFAULT_AGENTS[0].name,
              diagnostics: [
                {
                  severity: 'error',
                  message: 'Unknown handoff target',
                  source: 'runtime-import',
                },
              ],
            },
          ],
        });
      });

      test('GET /export/preview blocks invalid runtime config state', async () => {
        mockProjectRuntimeConfigFindOne.mockResolvedValueOnce({
          extraction: { advanced_sidecar_url: 'not-a-url' },
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);

        expect(status).toBe(409);
        expect(mockBuildDependencyGraph).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [
            {
              kind: 'runtime_config',
              diagnostics: [
                {
                  severity: 'error',
                  message: expect.stringContaining('Invalid url'),
                },
              ],
            },
          ],
        });
      });

      test('GET /export blocks invalid runtime config state', async () => {
        mockProjectRuntimeConfigFindOne.mockResolvedValueOnce({
          extraction: { advanced_sidecar_url: 'not-a-url' },
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);

        expect(status).toBe(409);
        expect(mockExportProjectV2).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [
            {
              kind: 'runtime_config',
              diagnostics: [
                {
                  severity: 'error',
                  message: expect.stringContaining('Invalid url'),
                },
              ],
            },
          ],
        });
      });

      test('GET /export/preview blocks invalid model policy config state', async () => {
        mockProjectLLMConfigFindOne.mockResolvedValueOnce({
          operationTierOverrides: {
            response_gen: 'voice',
          },
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);

        expect(status).toBe(409);
        expect(mockBuildDependencyGraph).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [
            {
              kind: 'model_policy',
              diagnostics: [
                {
                  severity: 'error',
                  message: expect.stringContaining('Invalid operation-tier overrides'),
                },
              ],
            },
          ],
        });
      });

      test('GET /export blocks invalid model policy config state', async () => {
        mockProjectLLMConfigFindOne.mockResolvedValueOnce({
          operationTierOverrides: {
            response_gen: 'voice',
          },
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);

        expect(status).toBe(409);
        expect(mockExportProjectV2).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          success: false,
          error: { code: 'INVALID_AGENT_DRAFT' },
          issues: [
            {
              kind: 'model_policy',
              diagnostics: [
                {
                  severity: 'error',
                  message: expect.stringContaining('Invalid operation-tier overrides'),
                },
              ],
            },
          ],
        });
      });

      test('GET /export forwards systemPromptLibraryRef into the v2 manifest metadata payload', async () => {
        mockProjectAgentFind.mockResolvedValueOnce([
          {
            ...DEFAULT_AGENTS[0],
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          },
        ]);
        mockExportProjectV2.mockImplementationOnce(
          (_options: any, _deps: any, manifestMeta: any) => ({
            success: true,
            files: new Map([['agents/booking_agent.agent.yaml', 'agent: booking_agent']]),
            manifest: {
              format_version: '2.0',
              agents: {
                booking_agent: {
                  path: 'agents/booking_agent.agent.yaml',
                  systemPromptLibraryRef: manifestMeta.agents[0].systemPromptLibraryRef,
                },
              },
            },
            lockfile: {},
            warnings: [],
          }),
        );

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);

        expect(status).toBe(200);
        expect(mockExportProjectV2).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            agentData: [
              expect.objectContaining({
                name: 'booking_agent',
                systemPromptLibraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash-1',
                },
              }),
            ],
          }),
          expect.objectContaining({
            agents: [
              expect.objectContaining({
                name: 'booking_agent',
                systemPromptLibraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash-1',
                },
              }),
            ],
          }),
        );
        expect(body.manifest.agents.booking_agent.systemPromptLibraryRef).toEqual({
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash-1',
        });
      });

      test('GET /export preserves the sealed v2 file map instead of appending MCP files post-export', async () => {
        mockMCPServerConfigFind.mockResolvedValueOnce([{ name: 'public-repo-tools' }]);
        mockExportProjectV2.mockResolvedValueOnce({
          success: true,
          files: new Map([
            ['agents/booking_agent.agent.yaml', 'agent: booking_agent'],
            ['core/mcp-servers/public-repo-tools.mcp-config.json', '{"name":"public-repo-tools"}'],
            ['project.json', '{"format_version":"2.0"}'],
            ['abl.lock', '{"lockfile_version":"2.0"}'],
          ]),
          manifest: { format_version: '2.0' },
          lockfile: { lockfile_version: '2.0' },
          warnings: [],
        });

        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);

        expect(status).toBe(200);
        expect(body.files).toEqual({
          'agents/booking_agent.agent.yaml': 'agent: booking_agent',
          'core/mcp-servers/public-repo-tools.mcp-config.json': '{"name":"public-repo-tools"}',
          'project.json': '{"format_version":"2.0"}',
          'abl.lock': '{"lockfile_version":"2.0"}',
        });
        expect(Object.keys(body.files)).toHaveLength(4);
      });

      test('GET /export forwards canonical layer and DSL format options into v2 export', async () => {
        // resolveLayers is only called when no layers were requested; for this
        // case the URL provides `connections,evals`, so the runtime forwards
        // those into resolveLayersForToolDependencies, which appends `core` as
        // a dependency. Match the canonical insertion order expected below.
        mockResolveLayers.mockReturnValueOnce(['core', 'connections', 'evals']);
        mockResolveLayersForToolDependencies.mockReturnValueOnce(['connections', 'evals', 'core']);

        const { status } = await request(
          baseUrl,
          'GET',
          `${IO_BASE}/export?layers=connections,evals&dsl_format=yaml&include_deployments=true`,
        );

        expect(status).toBe(200);
        expect(mockExportProjectV2).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'proj-1',
            format: 'folder',
            layers: ['connections', 'evals', 'core'],
            dslFormat: 'yaml',
            includeDeployments: true,
          }),
          expect.any(Object),
          expect.any(Object),
        );
      });

      test('POST /import/preview returns preview with changes', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.preview).toBeDefined();
        expect(body.previewDigest).toBe('preview-digest-1');
        expect(body.previewDigest).toBe(body.preview.previewDigest);
        expect(body.preview.changes.agents.added).toContain('test_agent');
      });

      test('POST /import/preview includes existing systemPromptLibraryRef in planner state', async () => {
        mockProjectAgentFind.mockResolvedValueOnce([
          {
            ...DEFAULT_AGENTS[0],
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
            },
          },
        ]);

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(mockBuildCoreImportApplyPlanV2).toHaveBeenCalledWith(
          expect.any(Map),
          expect.objectContaining({
            agents: expect.any(Map),
          }),
          expect.any(Object),
        );
        const plannerState = mockBuildCoreImportApplyPlanV2.mock.calls[0][1];
        expect(plannerState.agents.get('booking_agent')).toEqual({
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: Book things',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        });
      });

      test('POST /import/preview includes existing prompt bundles in planner state', async () => {
        mockPromptLibraryItemFind.mockResolvedValueOnce([
          {
            _id: 'prompt-1',
            name: 'Support Prompt',
            description: 'Shared support guidance',
            tags: ['support'],
            status: 'active',
            nextVersionNumber: 3,
          },
        ]);
        mockPromptLibraryVersionFind.mockResolvedValueOnce([
          {
            _id: 'version-7',
            promptId: 'prompt-1',
            versionNumber: 2,
            template: 'Be concise and empathetic.',
            variables: ['customer_name'],
            description: 'Current support prompt',
            status: 'active',
            sourceHash: 'prompt-version-hash-7',
            metadata: { tone: 'friendly' },
          },
        ]);

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        const plannerState = mockBuildCoreImportApplyPlanV2.mock.calls[0][1];
        expect(plannerState.prompts.get('prompt-1')).toEqual({
          promptId: 'prompt-1',
          name: 'Support Prompt',
          description: 'Shared support guidance',
          tags: ['support'],
          status: 'active',
          nextVersionNumber: 3,
          versions: [
            {
              versionId: 'version-7',
              versionNumber: 2,
              template: 'Be concise and empathetic.',
              variables: ['customer_name'],
              description: 'Current support prompt',
              status: 'active',
              sourceHash: 'prompt-version-hash-7',
              metadata: { tone: 'friendly' },
            },
          ],
        });
      });

      test('POST /import/preview strips tenant-local references from project model planner state', async () => {
        mockModelConfigFind.mockResolvedValueOnce([
          {
            name: 'GPT-4o Realtime Preview (2025-06-03)',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            provider: 'openai',
            tenantModelId: 'tm-voice',
            credentialId: 'cred-should-not-round-trip',
            authProfileId: 'auth-profile-should-not-round-trip',
            tier: 'voice',
            isDefault: true,
          },
        ]);

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        const plannerState = mockBuildCoreImportApplyPlanV2.mock.calls[0][1];
        expect(mockModelConfigFind).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
        });
        expect(
          plannerState.projectModelConfigs.get('GPT-4o Realtime Preview (2025-06-03)'),
        ).toEqual({
          name: 'GPT-4o Realtime Preview (2025-06-03)',
          data: {
            name: 'GPT-4o Realtime Preview (2025-06-03)',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            provider: 'openai',
            tier: 'voice',
            isDefault: true,
          },
        });
      });

      test('POST /import/preview exposes tool changes in legacy preview format', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            toolOperations: [
              {
                type: 'create',
                toolName: 'lookup_ticket',
                toolType: 'http',
                description: 'Lookup a support ticket',
                dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}',
                sourceHash: 'tool-hash-1',
                sourceFile: 'tools/lookup_ticket.tools.abl',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.preview.changes.tools.added).toEqual([
          {
            name: 'lookup_ticket',
            toolType: 'http',
            sourceFile: 'tools/lookup_ticket.tools.abl',
          },
        ]);
      });

      test('POST /import creates agents and returns applied counts', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.applied).toMatchObject({ created: 1, updated: 0, deleted: 0 });
        expect(mockProjectAgentInsertMany).toHaveBeenCalled();
        expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
      });

      test('POST /import assigns destination default variable namespace IDs to created tools', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            toolOperations: [
              {
                type: 'create',
                toolName: 'lookup_ticket',
                toolType: 'http',
                description: 'Lookup support ticket',
                dslContent: [
                  'lookup_ticket(ticket_id: string) -> object',
                  '  description: "Lookup support ticket"',
                  '  type: http',
                  '  endpoint: "https://support.example.com/tickets"',
                  '  method: GET',
                ].join('\n'),
                sourceHash: 'tool-hash-1',
                sourceFile: 'tools/lookup_ticket.tools.abl',
              },
            ],
          }),
        });

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(mockGetOrCreateDefaultNamespace).toHaveBeenCalledWith(
          'tenant-A',
          'proj-1',
          'proj-dev-user',
        );
        expect(mockProjectToolInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            name: 'lookup_ticket',
            variableNamespaceIds: ['ns-default'],
          }),
        ]);
      });

      test('POST /import backfills missing namespace IDs on updated tools without overwriting custom scopes', async () => {
        mockProjectToolFind
          .mockResolvedValueOnce([
            {
              name: 'missing_scope',
              dslContent:
                'missing_scope() -> object\n  type: http\n  endpoint: "https://api.example.com/missing"\n  method: GET',
              variableNamespaceIds: [],
            },
            {
              name: 'custom_scope',
              dslContent:
                'custom_scope() -> object\n  type: http\n  endpoint: "https://api.example.com/custom"\n  method: GET',
              variableNamespaceIds: ['ns-custom'],
            },
          ])
          .mockResolvedValueOnce([
            {
              name: 'missing_scope',
              variableNamespaceIds: [],
            },
            {
              name: 'custom_scope',
              variableNamespaceIds: ['ns-custom'],
            },
          ]);
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            toolOperations: [
              {
                type: 'update',
                toolName: 'missing_scope',
                toolType: 'http',
                description: 'Updated missing scope',
                dslContent:
                  'missing_scope() -> object\n  type: http\n  endpoint: "https://api.example.com/missing"\n  method: GET',
                sourceHash: 'tool-hash-missing',
                sourceFile: 'tools/missing_scope.tools.abl',
              },
              {
                type: 'update',
                toolName: 'custom_scope',
                toolType: 'http',
                description: 'Updated custom scope',
                dslContent:
                  'custom_scope() -> object\n  type: http\n  endpoint: "https://api.example.com/custom"\n  method: GET',
                sourceHash: 'tool-hash-custom',
                sourceFile: 'tools/custom_scope.tools.abl',
              },
            ],
          }),
        });

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        const bulkOps = mockProjectToolBulkWrite.mock.calls[0][0];
        expect(bulkOps[0].updateOne.update.$set).toEqual(
          expect.objectContaining({ variableNamespaceIds: ['ns-default'] }),
        );
        expect(bulkOps[1].updateOne.update.$set).not.toHaveProperty('variableNamespaceIds');
      });

      test('POST /import invalidates model resolution caches when model policy configs change', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            modelPolicyOperations: [
              {
                type: 'upsert',
                configType: 'llm',
                data: {
                  operationTierOverrides: {
                    realtime_voice: 'voice',
                  },
                },
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: {
            files: {
              'config/llm-config.json': JSON.stringify({
                operationTierOverrides: {
                  realtime_voice: 'voice',
                },
              }),
            },
          },
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({ modelPoliciesUpserted: 1 });
        expect(mockProjectLLMConfigFindOneAndUpdate).toHaveBeenCalledWith(
          { projectId: 'proj-1', tenantId: 'tenant-A' },
          expect.objectContaining({
            $set: expect.objectContaining({
              operationTierOverrides: { realtime_voice: 'voice' },
            }),
          }),
          { upsert: true, new: true },
        );
        expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import upserts project model configs inside the target tenant only', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            modelPolicyOperations: [
              {
                type: 'upsert',
                configType: 'project_model',
                modelConfigName: 'GPT-4o',
                data: {
                  name: 'GPT-4o',
                  provider: 'openai',
                  modelId: 'gpt-4o',
                  tier: 'smart',
                },
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({ modelPoliciesUpserted: 1 });
        expect(mockModelConfigFindOneAndUpdate).toHaveBeenCalledWith(
          { projectId: 'proj-1', tenantId: 'tenant-A', name: 'GPT-4o' },
          expect.objectContaining({
            $set: expect.objectContaining({
              projectId: 'proj-1',
              tenantId: 'tenant-A',
              name: 'GPT-4o',
              provider: 'openai',
              modelId: 'gpt-4o',
            }),
          }),
          { upsert: true, new: true },
        );
        expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import deletes runtime config without deleting canonical LLM overrides', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            modelPolicyOperations: [
              {
                type: 'delete',
                configType: 'runtime',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({ modelPoliciesDeleted: 1 });
        expect(mockProjectRuntimeConfigDeleteOne).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
        });
        expect(mockProjectLLMConfigDeleteOne).not.toHaveBeenCalled();
        expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import deletes project model configs inside the target tenant only', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            modelPolicyOperations: [
              {
                type: 'delete',
                configType: 'project_model',
                modelConfigName: 'GPT-4o',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({ modelPoliciesDeleted: 1 });
        expect(mockModelConfigDeleteOne).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
          name: 'GPT-4o',
        });
        expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import deleting LLM config clears only the runtime override mirror', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [],
            modelPolicyOperations: [
              {
                type: 'delete',
                configType: 'llm',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({ modelPoliciesDeleted: 1 });
        expect(mockProjectLLMConfigDeleteOne).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
        });
        expect(mockProjectRuntimeConfigFindOneAndUpdate).toHaveBeenCalledWith(
          { projectId: 'proj-1', tenantId: 'tenant-A' },
          { $set: { operationTierOverrides: {} } },
          { new: true },
        );
        expect(mockProjectRuntimeConfigDeleteOne).not.toHaveBeenCalled();
        expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import defaults deleteUnmatched to true for desired-state apply', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(mockBuildCoreImportApplyPlanV2).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Object),
          expect.objectContaining({ deleteUnmatched: true }),
        );
      });

      test('POST /import/preview honors deleteUnmatched=false override', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { ...VALID_IMPORT_BODY, deleteUnmatched: false },
        });

        expect(mockBuildCoreImportApplyPlanV2).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Object),
          expect.objectContaining({ deleteUnmatched: false }),
        );
      });

      test('POST /import/preview forwards requested layers to the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: { ...VALID_IMPORT_BODY, layers: ['core'] },
        });

        expect(mockBuildCoreImportApplyPlanV2).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Object),
          expect.objectContaining({ layers: ['core'] }),
        );
      });

      test('POST /import forwards requested layers to the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: { ...VALID_IMPORT_BODY, layers: ['core', 'evals'] },
        });

        expect(mockBuildCoreImportApplyPlanV2).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Object),
          expect.objectContaining({ layers: ['core', 'evals'] }),
        );
      });

      test('POST /import/preview wires async tool binding validation into the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(mockPreviewCoreImportV2).toHaveBeenCalledWith(
          expect.objectContaining({
            planOptions: expect.objectContaining({
              validateToolBindingForSave: expect.any(Function),
            }),
          }),
        );
      });

      test('POST /import/preview wires runtime config validation into the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        expect(mockPreviewCoreImportV2).toHaveBeenCalledWith(
          expect.objectContaining({
            planOptions: expect.objectContaining({
              validateRuntimeConfigForSave: expect.any(Function),
            }),
          }),
        );
      });

      test('POST /import/preview runtime config validator rejects advanced NLU without entitlement', async () => {
        mockResolveAdvancedNluEntitlement.mockResolvedValueOnce({ allowed: false });

        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        const validator =
          mockPreviewCoreImportV2.mock.calls[0][0].planOptions.validateRuntimeConfigForSave;
        const result = await validator({
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          data: {
            extraction: {
              nlu_provider: 'advanced',
              advanced_sidecar_url: 'https://advanced-nlu.example.com',
            },
          },
        });

        expect(result).toMatchObject({
          valid: false,
          status: 403,
          code: 'PLAN_FEATURE_UNAVAILABLE',
          message: 'Advanced NLU provider requires an Enterprise plan',
        });
        expect(mockResolveAdvancedNluEntitlement).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import/preview validator rejects SearchAI bindings outside the project scope', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });

        const validator =
          mockPreviewCoreImportV2.mock.calls[0][0].planOptions.validateToolBindingForSave;
        const result = await validator({
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  description: "Search docs"',
            '  type: searchai',
            '  index_id: "idx-other-project"',
            '  tenant_id: "tenant-A"',
          ].join('\n'),
        });

        expect(result).toMatchObject({
          valid: false,
          status: 404,
          code: 'SEARCHAI_INDEX_NOT_FOUND',
        });
        expect(mockSearchIndexFindOne).toHaveBeenCalledWith(
          expect.objectContaining({
            _id: 'idx-other-project',
            tenantId: 'tenant-A',
            projectId: 'proj-1',
          }),
        );
      });

      test('POST /import wires async tool binding validation into the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(mockApplyCoreImportV2).toHaveBeenCalledWith(
          expect.objectContaining({
            planOptions: expect.objectContaining({
              validateToolBindingForSave: expect.any(Function),
            }),
          }),
        );
      });

      test('POST /import wires runtime config validation into the import planner', async () => {
        await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(mockApplyCoreImportV2).toHaveBeenCalledWith(
          expect.objectContaining({
            planOptions: expect.objectContaining({
              validateRuntimeConfigForSave: expect.any(Function),
            }),
          }),
        );
      });

      test('POST /import runtime config validator rejects advanced NLU without entitlement', async () => {
        mockResolveAdvancedNluEntitlement.mockResolvedValueOnce({ allowed: false });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        const validator =
          mockApplyCoreImportV2.mock.calls[0][0].planOptions.validateRuntimeConfigForSave;
        const result = await validator({
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          data: {
            extraction: {
              nlu_provider: 'advanced',
              advanced_sidecar_url: 'https://advanced-nlu.example.com',
            },
          },
        });

        expect(result).toMatchObject({
          valid: false,
          status: 403,
          code: 'PLAN_FEATURE_UNAVAILABLE',
          message: 'Advanced NLU provider requires an Enterprise plan',
        });
        expect(mockResolveAdvancedNluEntitlement).toHaveBeenCalledWith('tenant-A');
      });

      test('POST /import updates existing agents via bulkWrite', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'update',
                agentName: 'existing_agent',
                description: 'Updated description',
                dslContent: 'AGENT: existing_agent\nGOAL: Updated goal',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.applied).toMatchObject({ created: 0, updated: 1, deleted: 0 });
        expect(mockProjectAgentBulkWrite).toHaveBeenCalled();
        expect(mockProjectAgentInsertMany).not.toHaveBeenCalled();
      });

      test('POST /import deletes removed agents via deleteMany', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'delete',
                agentName: 'old_agent',
                description: null,
                dslContent: null,
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.applied).toMatchObject({ created: 0, updated: 0, deleted: 1 });
        expect(mockProjectAgentDeleteMany).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
          name: { $in: ['old_agent'] },
        });
      });

      test('POST /import handles mixed create+update+delete operations', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'new_agent',
                description: 'New',
                dslContent: 'AGENT: new_agent',
              },
              {
                type: 'update',
                agentName: 'existing_agent',
                description: 'Updated',
                dslContent: 'AGENT: existing_agent',
              },
              {
                type: 'delete',
                agentName: 'old_agent',
                description: null,
                dslContent: null,
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.applied).toMatchObject({ created: 1, updated: 1, deleted: 1 });
        expect(mockProjectAgentInsertMany).toHaveBeenCalled();
        expect(mockProjectAgentBulkWrite).toHaveBeenCalled();
        expect(mockProjectAgentDeleteMany).toHaveBeenCalled();
      });

      test('GET /export with include_deployments=true fetches deployments', async () => {
        const { status, body } = await request(
          baseUrl,
          'GET',
          `${IO_BASE}/export?include_deployments=true`,
        );
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(mockExportProjectV2).toHaveBeenCalledWith(
          expect.objectContaining({ includeDeployments: true }),
          expect.any(Object),
          expect.any(Object),
        );
      });

      test('GET /export/preview returns project not found (404) when project does not exist in DB', async () => {
        mockProjectFindOne.mockResolvedValueOnce(null);
        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
        expect(status).toBe(404);
        expect(body.error.message).toBe('Project not found');
      });

      test('GET /export returns project not found (404) when project does not exist in DB', async () => {
        mockProjectFindOne.mockResolvedValueOnce(null);
        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(404);
        expect(body.error.message).toBe('Project not found');
      });
    });

    // -- Concurrent import protection --

    describe('Concurrent import protection', () => {
      test('returns 409 when import lock cannot be acquired', async () => {
        mockRedisClient = {
          set: vi.fn().mockResolvedValue(null), // Lock not acquired
        };

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(409);
        expect(body.error.message).toContain('Another import is in progress');
      });

      test('import proceeds without Redis (dev mode)', async () => {
        // mockRedisClient is null (default) → acquireImportLock returns 'no-redis'
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
      });

      test('import succeeds when lock is acquired', async () => {
        mockRedisClient = {
          set: vi.fn().mockResolvedValue('OK'), // Lock acquired
          call: vi.fn().mockResolvedValue(1), // Lock released
        };

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
      });
    });

    // -- Import rollback --

    describe('Import rollback on error', () => {
      test('rolls back created agents on DB error during update', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'new_agent',
                description: null,
                dslContent: 'AGENT: new_agent',
              },
              {
                type: 'update',
                agentName: 'existing',
                description: null,
                dslContent: 'AGENT: existing',
              },
            ],
          }),
        });
        mockProjectAgentInsertMany.mockResolvedValueOnce([{ _id: 'created-id-1' }]);
        mockProjectAgentBulkWrite.mockRejectedValueOnce(new Error('DB write error'));

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(500);
        expect(body.error.code).toBe('IMPORT_APPLY_FAILED');
        expect(body.error.message).toContain('rolled back');
        expect(body.error.stage).toBe('update_agents');
        expect(body.error.sanitizedCause).toBe('Persistence operation failed');

        // Verify rollback: deleteMany called with created IDs
        expect(mockProjectAgentDeleteMany).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
          _id: { $in: ['created-id-1'] },
        });
      });

      test('handles rollback failure gracefully (does not crash)', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'new_agent',
                description: null,
                dslContent: 'AGENT: new_agent',
              },
              {
                type: 'update',
                agentName: 'existing',
                description: null,
                dslContent: 'AGENT: existing',
              },
            ],
          }),
        });
        mockProjectAgentInsertMany.mockResolvedValueOnce([{ _id: 'created-id-1' }]);
        mockProjectAgentBulkWrite.mockRejectedValueOnce(new Error('DB write error'));
        mockProjectAgentDeleteMany.mockRejectedValueOnce(new Error('Rollback also failed'));

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        // Still returns 500 even when rollback fails
        expect(status).toBe(500);
        expect(body.error.code).toBe('IMPORT_APPLY_FAILED');
        expect(body.error.stage).toBe('update_agents');
      });
    });

    // -- Import validation failure --

    describe('Import validation failure (core planner returns success: false)', () => {
      test('returns 400 with preview and error from the core planner', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: false,
          warnings: [],
          preview: {
            ...makeCorePlan().preview,
            valid: false,
          },
          error: { code: 'SYNTAX_ERROR', message: 'Invalid ABL syntax' },
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('SYNTAX_ERROR');
      });
    });

    // -- Server error paths (500) --

    describe('Server error paths', () => {
      test('GET /export/preview returns 500 on DB exception', async () => {
        mockProjectFindOne.mockRejectedValueOnce(new Error('DB connection lost'));
        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
        expect(status).toBe(500);
        expect(body.error.message).toBe('Failed to generate export preview');
      });

      test('GET /export returns 500 on DB exception', async () => {
        mockProjectFindOne.mockRejectedValueOnce(new Error('DB connection lost'));
        const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
        expect(status).toBe(500);
        expect(body.error.message).toBe('Failed to export project');
      });

      test('POST /import/preview returns 500 on DB exception', async () => {
        mockProjectAgentFind.mockRejectedValueOnce(new Error('DB connection lost'));
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(500);
        expect(body.error.message).toBe('Failed to generate import preview');
      });

      test('POST /import returns 500 on outer catch (non-DB error)', async () => {
        // Trigger error in the outer try block (before apply operations)
        mockProjectAgentFind.mockRejectedValueOnce(new Error('Unexpected error'));
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(500);
        expect(body.error.message).toBe('Failed to apply import');
      });
    });

    // -- Body parser error handling --

    describe('Body parser errors', () => {
      test('returns 400 for malformed JSON body', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
          rawBody: '{ invalid json',
        });
        expect(status).toBe(400);
        expect(body.error.message).toBe('Invalid JSON in request body');
      });

      test('returns 400 for malformed JSON on /import route', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          rawBody: '{ invalid json',
        });
        expect(status).toBe(400);
        expect(body.error.message).toBe('Invalid JSON in request body');
      });
    });

    // -- Lock release verification --

    describe('Lock release verification', () => {
      test('releases lock after successful import', async () => {
        const mockCall = vi.fn().mockResolvedValue(1);
        mockRedisClient = {
          set: vi.fn().mockResolvedValue('OK'),
          call: mockCall,
        };

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        // Lock release uses redis.call('EVAL', script, '1', key, owner)
        expect(mockCall).toHaveBeenCalledWith(
          'EVAL',
          expect.stringContaining('redis.call("get"'),
          '1',
          expect.stringContaining('import:lock:proj-1'),
          expect.stringMatching(/^import-/),
        );
      });

      test('releases lock even after import failure', async () => {
        const mockCall = vi.fn().mockResolvedValue(1);
        mockRedisClient = {
          set: vi.fn().mockResolvedValue('OK'),
          call: mockCall,
        };

        // Cause an error in the import
        mockProjectAgentFind.mockRejectedValueOnce(new Error('DB error'));

        const { status } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(500);
        // Lock should still be released via finally block
        expect(mockCall).toHaveBeenCalledWith(
          'EVAL',
          expect.stringContaining('redis.call("get"'),
          '1',
          expect.stringContaining('import:lock:proj-1'),
          expect.stringMatching(/^import-/),
        );
      });

      test('handles lock release failure gracefully', async () => {
        mockRedisClient = {
          set: vi.fn().mockResolvedValue('OK'),
          call: vi.fn().mockRejectedValue(new Error('Redis down during release')),
        };

        // Import should still succeed even if lock release fails
        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
      });
    });

    // -- Import apply: insertMany doc structure verification --

    describe('Import apply data integrity', () => {
      test('insertMany docs include all required fields', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'new_agent',
                description: 'New sales agent',
                dslContent: 'AGENT: new_agent\nGOAL: Sell things',
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            projectId: 'proj-1',
            tenantId: 'tenant-A',
            name: 'new_agent',
            agentPath: 'proj-1/new_agent',
            description: 'New sales agent',
            dslContent: 'AGENT: new_agent\nGOAL: Sell things',
            sourceHash: 'hash-123',
            lastEditedBy: expect.any(String),
            lastEditedAt: expect.any(Date),
          }),
        ]);
      });

      test('insertMany persists imported systemPromptLibraryRef', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'new_agent',
                description: 'New sales agent',
                dslContent: 'AGENT: new_agent\nGOAL: Sell things',
                systemPromptLibraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash-1',
                },
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            name: 'new_agent',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          }),
        ]);
      });

      test('import persists imported prompt bundles through the route adapter', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            promptOperations: [
              {
                type: 'create',
                promptId: 'prompt-1',
                name: 'Support Prompt',
                description: 'Shared support guidance',
                tags: ['support'],
                status: 'active',
                nextVersionNumber: 3,
                versions: [
                  {
                    versionId: 'version-7',
                    versionNumber: 2,
                    template: 'Be concise and empathetic.',
                    variables: ['customer_name'],
                    description: 'Current support prompt',
                    status: 'active',
                    sourceHash: 'prompt-version-hash-7',
                    metadata: { tone: 'friendly' },
                  },
                ],
                sourceHash: 'prompt-bundle-hash-1',
                sourceFile: 'prompts/support_prompt.prompt.json',
              },
            ],
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.applied).toMatchObject({
          created: 1,
          promptsCreated: 1,
          promptsUpdated: 0,
          promptsDeleted: 0,
        });
        expect(mockPromptLibraryItemInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            _id: 'prompt-1',
            projectId: 'proj-1',
            tenantId: 'tenant-A',
            name: 'Support Prompt',
            createdBy: 'proj-dev-user',
          }),
        ]);
        expect(mockPromptLibraryVersionInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            _id: 'version-7',
            promptId: 'prompt-1',
            projectId: 'proj-1',
            tenantId: 'tenant-A',
            versionNumber: 2,
            sourceHash: 'prompt-version-hash-7',
            createdBy: 'proj-dev-user',
          }),
        ]);
      });

      test('imported parse-valid but compiler-invalid drafts persist error metadata', async () => {
        mockProjectAgentFind.mockResolvedValue([]);
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'create',
                agentName: 'billing_agent',
                description: 'Imported billing agent',
                dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentInsertMany).toHaveBeenCalledWith([
          expect.objectContaining({
            name: 'billing_agent',
            dslValidationStatus: 'error',
            dslDiagnostics: expect.arrayContaining([
              expect.objectContaining({
                severity: 'error',
                source: 'runtime-import',
                message: expect.stringContaining('Handoff target "booking_agent" does not exist'),
              }),
            ]),
          }),
        ]);
      });

      test('bulkWrite includes tenant-scoped filter and version increment', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'update',
                agentName: 'existing_agent',
                description: 'Updated',
                dslContent: 'AGENT: existing_agent\nGOAL: Updated',
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentBulkWrite).toHaveBeenNthCalledWith(1, [
          {
            updateOne: {
              filter: { projectId: 'proj-1', tenantId: 'tenant-A', name: 'existing_agent' },
              update: {
                $set: {
                  dslContent: 'AGENT: existing_agent\nGOAL: Updated',
                  description: 'Updated',
                  systemPromptLibraryRef: null,
                  sourceHash: 'hash-123',
                  lastEditedBy: expect.any(String),
                  lastEditedAt: expect.any(Date),
                  dslValidationStatus: 'valid',
                  dslDiagnostics: [],
                },
                $inc: { _v: 1 },
              },
            },
          },
        ]);
      });

      test('bulkWrite persists imported systemPromptLibraryRef updates', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'update',
                agentName: 'existing_agent',
                description: 'Updated',
                dslContent: 'AGENT: existing_agent\nGOAL: Updated',
                systemPromptLibraryRef: {
                  promptId: 'prompt-2',
                  versionId: 'version-2',
                  resolvedHash: 'prompt-hash-2',
                },
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentBulkWrite).toHaveBeenNthCalledWith(1, [
          {
            updateOne: {
              filter: { projectId: 'proj-1', tenantId: 'tenant-A', name: 'existing_agent' },
              update: {
                $set: expect.objectContaining({
                  systemPromptLibraryRef: {
                    promptId: 'prompt-2',
                    versionId: 'version-2',
                    resolvedHash: 'prompt-hash-2',
                  },
                }),
                $inc: { _v: 1 },
              },
            },
          },
        ]);
      });

      test('deleteMany uses tenant-scoped query', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'delete',
                agentName: 'remove_me',
                description: null,
                dslContent: null,
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentDeleteMany).toHaveBeenCalledWith({
          projectId: 'proj-1',
          tenantId: 'tenant-A',
          name: { $in: ['remove_me'] },
        });
      });

      test('refreshes untouched sibling metadata after imported deletes change the final agent set', async () => {
        mockProjectAgentFind
          .mockResolvedValueOnce([
            {
              _id: 'booking-agent',
              name: 'booking_agent',
              dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings"\n',
            },
            {
              _id: 'billing-agent',
              name: 'billing_agent',
              dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
            },
          ])
          .mockResolvedValueOnce([
            {
              _id: 'billing-agent',
              name: 'billing_agent',
              dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
            },
          ]);
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            agentOperations: [
              {
                type: 'delete',
                agentName: 'booking_agent',
                description: null,
                dslContent: null,
              },
            ],
          }),
        });

        await request(baseUrl, 'POST', `${IO_BASE}/import`, { body: VALID_IMPORT_BODY });

        expect(mockProjectAgentBulkWrite).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              updateOne: expect.objectContaining({
                filter: {
                  _id: 'billing-agent',
                  projectId: 'proj-1',
                  tenantId: 'tenant-A',
                },
                update: expect.objectContaining({
                  $set: expect.objectContaining({
                    dslValidationStatus: 'error',
                    dslDiagnostics: expect.arrayContaining([
                      expect.objectContaining({
                        severity: 'error',
                        source: 'runtime-import',
                        message: expect.stringContaining(
                          'Handoff target "booking_agent" does not exist',
                        ),
                      }),
                    ]),
                  }),
                }),
              }),
            }),
          ]),
        );
      });

      test('entry agent updates are delegated through the core execution adapter', async () => {
        mockBuildCoreImportApplyPlanV2.mockResolvedValueOnce({
          success: true,
          plan: makeCorePlan({
            entryAgentName: 'resolved_entry_agent',
            preview: {
              entryAgentResolution: {
                requested: 'resolved_entry_agent',
                resolved: 'resolved_entry_agent',
                matchedBy: 'manifest',
              },
            },
          }),
        });

        const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
          body: VALID_IMPORT_BODY,
        });

        expect(status).toBe(200);
        expect(body.entryAgentName).toBe('resolved_entry_agent');
        expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
          { _id: 'proj-1', tenantId: 'tenant-A' },
          { $set: { entryAgentName: 'resolved_entry_agent' } },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Non-member → 404 (concealed as not found despite tenant membership)
  // ---------------------------------------------------------------------------
  describe('Non-member (no project membership)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // 'non-member-user' has no entry in findProjectMember mock → returns null
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'non-member-user'));
    });
    afterAll(() => server?.close());

    test('GET /export returns 404', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });

    test('GET /export/preview returns 404', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${IO_BASE}/export/preview`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });

    test('POST /import/preview returns 404', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import/preview`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });

    test('POST /import returns 404', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${IO_BASE}/import`, {
        body: VALID_IMPORT_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });
  });
});
