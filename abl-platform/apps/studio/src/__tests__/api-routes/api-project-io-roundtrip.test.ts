import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import mongoose from 'mongoose';

const PROJECT_ID = 'proj-1';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const MCP_SERVER_NAME = 'public-repo-tools';
const MCP_SERVER_FILE = `core/mcp-servers/${MCP_SERVER_NAME}.mcp-config.json`;
const TOOL_FILE = 'tools/search_docs.tools.abl';

const AGENT_DSL = `AGENT: SupportAgent
GOAL: Answer documentation questions

ON_ERROR:
  RESPOND: "Something went wrong."
`;

const MCP_TOOL_DSL = `TOOLS:
  search_docs(query: string) -> object
    type: mcp
    description: "Search documents in the public repository"
    server: "public-repo-tools"
    tool: "search"
`;

type InMemoryProject = {
  _id: string;
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string;
  entryAgentName: string | null;
};

type InMemoryProjectAgent = {
  _id: string;
  projectId: string;
  tenantId: string;
  name: string;
  description: string | null;
  dslContent: string;
  ownerId: string | null;
  ownerTeamId: string | null;
  systemPromptLibraryRef?: {
    promptId: string;
    versionId: string;
  } | null;
  dslValidationStatus?: 'valid' | 'invalid' | 'unknown';
  dslDiagnostics?: unknown[];
  status?: string;
};

type InMemoryPromptLibraryItem = {
  _id: string;
  projectId: string;
  tenantId: string;
  name: string;
  description?: string;
  tags: string[];
  usageCount: number;
  nextVersionNumber: number;
  status: 'active' | 'archived';
  createdBy: string;
};

type InMemoryPromptLibraryVersion = {
  _id: string;
  projectId: string;
  tenantId: string;
  promptId: string;
  versionNumber: number;
  template: string;
  variables: string[];
  description?: string;
  status: 'draft' | 'active' | 'archived';
  sourceHash: string;
  metadata?: Record<string, unknown> | null;
  createdBy: string;
  publishedAt?: Date | null;
  publishedBy?: string | null;
};

type InMemoryProjectTool = {
  _id: string;
  projectId: string;
  tenantId: string;
  name: string;
  slug: string;
  toolType: 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow';
  description: string | null;
  dslContent: string;
  createdBy: string | null;
  lastEditedBy: string | null;
};

type InMemoryProjectConfigVariable = {
  _id: string;
  projectId: string;
  tenantId: string;
  key: string;
  value: string;
  description: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
};

type InMemoryMcpServer = {
  _id: string;
  projectId: string;
  tenantId: string;
  name: string;
  description: string | null;
  transport: 'http' | 'sse';
  url: string | null;
  encryptedEnv: string | null;
  authType: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials';
  encryptedAuthConfig: string | null;
  authProfileId: string | null;
  priority: number;
  tags: string | null;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  lastConnectionStatus: 'connected' | 'failed' | 'untested' | null;
  createdBy: string | null;
  modifiedBy: string | null;
  _v: number;
};

type InMemoryProjectRuntimeConfig = {
  _id: string;
  projectId: string;
  tenantId: string;
  extraction?: Record<string, unknown>;
  filler?: Record<string, unknown>;
  createdBy?: string | null;
  _v?: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type InMemoryImportOperation = {
  _id: string;
  projectId: string;
  tenantId: string;
  status: string;
  preImportSnapshot?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  layers?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
};

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

const dbState: {
  connectorConfigs: Array<Record<string, unknown>>;
  importOperations: InMemoryImportOperation[];
  mcpServers: InMemoryMcpServer[];
  projectAgents: InMemoryProjectAgent[];
  projectConfigVariables: InMemoryProjectConfigVariable[];
  promptLibraryItems: InMemoryPromptLibraryItem[];
  promptLibraryVersions: InMemoryPromptLibraryVersion[];
  projectRuntimeConfigs: InMemoryProjectRuntimeConfig[];
  projectTools: InMemoryProjectTool[];
  projects: InMemoryProject[];
} = {
  connectorConfigs: [],
  importOperations: [],
  mcpServers: [],
  projectAgents: [],
  projectConfigVariables: [],
  promptLibraryItems: [],
  promptLibraryVersions: [],
  projectRuntimeConfigs: [],
  projectTools: [],
  projects: [],
};

let nextId = 1;

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function getRecordValue(record: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, record);
}

function matchesFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or' && Array.isArray(expected)) {
      return expected.some((clause) => matchesFilter(record, clause as Record<string, unknown>));
    }

    const actual = getRecordValue(record, key);

    if (expected instanceof RegExp) {
      return typeof actual === 'string' && expected.test(actual);
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) {
        return Array.isArray((expected as { $in?: unknown[] }).$in)
          ? (expected as { $in: unknown[] }).$in.includes(actual)
          : false;
      }
      if ('$nin' in expected) {
        return Array.isArray((expected as { $nin?: unknown[] }).$nin)
          ? !(expected as { $nin: unknown[] }).$nin.includes(actual)
          : false;
      }
      if ('$exists' in expected) {
        return Boolean((expected as { $exists?: unknown }).$exists) === (actual !== undefined);
      }
    }

    return actual === expected;
  });
}

function applyProjection(
  value: Record<string, unknown> | Array<Record<string, unknown>> | null,
  projection?: string,
): Record<string, unknown> | Array<Record<string, unknown>> | null {
  if (!projection) {
    return value ? cloneValue(value) : value;
  }

  const keys = projection.split(/\s+/).filter(Boolean);
  const pick = (record: Record<string, unknown>) =>
    cloneValue(
      Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]])),
    );

  if (Array.isArray(value)) {
    return value.map((record) => pick(record));
  }

  return value ? pick(value) : value;
}

function makeQuery<T extends Record<string, unknown> | Array<Record<string, unknown>> | null>(
  resolver: () => T,
) {
  let projection: string | undefined;
  let sortSpec: Record<string, 1 | -1> | undefined;

  const applySort = <
    TValue extends Record<string, unknown> | Array<Record<string, unknown>> | null,
  >(
    value: TValue,
  ): TValue => {
    if (!sortSpec || !Array.isArray(value)) {
      return value;
    }

    const entries = Object.entries(sortSpec).filter(
      (entry): entry is [string, 1 | -1] => entry[1] === 1 || entry[1] === -1,
    );
    if (entries.length === 0) {
      return value;
    }

    return [...value].sort((left, right) => {
      for (const [sortKey, direction] of entries) {
        const leftValue = left[sortKey];
        const rightValue = right[sortKey];
        if (leftValue === rightValue) {
          continue;
        }
        if (leftValue == null) {
          return direction === 1 ? -1 : 1;
        }
        if (rightValue == null) {
          return direction === 1 ? 1 : -1;
        }
        return leftValue < rightValue ? -direction : direction;
      }

      return 0;
    }) as TValue;
  };

  const execute = () => applyProjection(applySort(resolver()), projection);

  const query = {
    select(value: string) {
      projection = value;
      return query;
    },
    sort(value: Record<string, 1 | -1>) {
      sortSpec = value;
      return query;
    },
    lean() {
      return query;
    },
    exec() {
      return Promise.resolve(execute());
    },
    then<TResult1 = Awaited<ReturnType<typeof execute>>, TResult2 = never>(
      onfulfilled?:
        | ((value: Awaited<ReturnType<typeof execute>>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(execute()).then(onfulfilled, onrejected);
    },
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ) {
      return Promise.resolve(execute()).catch(onrejected);
    },
    finally(onfinally?: (() => void) | null) {
      return Promise.resolve(execute()).finally(onfinally);
    },
  };

  return query;
}

function generateId(prefix: string): string {
  const id = `${prefix}-${nextId}`;
  nextId += 1;
  return id;
}

function applyDocumentUpdate(
  record: Record<string, unknown>,
  update: {
    $inc?: Record<string, number>;
    $set?: Record<string, unknown>;
    $unset?: Record<string, unknown>;
  },
): void {
  if (update.$set) {
    Object.assign(record, update.$set);
  }

  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      delete record[key];
    }
  }

  if (update.$inc) {
    for (const [key, value] of Object.entries(update.$inc)) {
      const current = typeof record[key] === 'number' ? (record[key] as number) : 0;
      record[key] = current + value;
    }
  }
}

function deleteMatching<T extends Record<string, unknown>>(
  collection: T[],
  filter: Record<string, unknown>,
): T[] {
  return collection.filter((record) => !matchesFilter(record, filter));
}

function getRawCollectionRecords(collectionName: string): Array<Record<string, unknown>> {
  switch (collectionName) {
    case 'project_agents':
      return dbState.projectAgents;
    case 'project_tools':
      return dbState.projectTools;
    case 'project_config_variables':
      return dbState.projectConfigVariables;
    case 'mcp_server_configs':
      return dbState.mcpServers;
    case 'prompt_library_items':
      return dbState.promptLibraryItems;
    case 'prompt_library_versions':
      return dbState.promptLibraryVersions;
    case 'project_runtime_configs':
      return dbState.projectRuntimeConfigs;
    case 'connector_configs':
      return dbState.connectorConfigs;
    default:
      return [];
  }
}

function installMockMongoConnection(): void {
  (mongoose.connection as unknown as { db?: unknown }).db = {
    collection: (collectionName: string) => ({
      find: (filter: Record<string, unknown>) => ({
        toArray: async () =>
          getRawCollectionRecords(collectionName)
            .filter((record) => matchesFilter(record, filter))
            .map((record) => cloneValue(record)),
      }),
      insertMany: async (documents: Array<Record<string, unknown>>) => {
        getRawCollectionRecords(collectionName).push(
          ...documents.map((document) => cloneValue(document)),
        );
        return {
          insertedCount: documents.length,
        };
      },
      deleteMany: async (filter: Record<string, unknown>) => {
        const records = getRawCollectionRecords(collectionName);
        const retained = records.filter((record) => !matchesFilter(record, filter));
        const deletedCount = records.length - retained.length;
        records.splice(0, records.length, ...retained);
        return { deletedCount };
      },
      updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const records = getRawCollectionRecords(collectionName).filter((record) =>
          matchesFilter(record, filter),
        );
        for (const record of records) {
          applyDocumentUpdate(record, update);
        }
        return {
          matchedCount: records.length,
          modifiedCount: records.length,
        };
      },
      bulkWrite: async (operations: Array<Record<string, unknown>>) => {
        let modifiedCount = 0;
        for (const operation of operations) {
          const updateMany = operation.updateMany as
            | { filter: Record<string, unknown>; update: Record<string, unknown> }
            | undefined;
          const updateOne = operation.updateOne as
            | { filter: Record<string, unknown>; update: Record<string, unknown> }
            | undefined;
          const updateOperation = updateMany ?? updateOne;
          if (!updateOperation) {
            continue;
          }
          const records = getRawCollectionRecords(collectionName).filter((record) =>
            matchesFilter(record, updateOperation.filter),
          );
          const targets = updateOne ? records.slice(0, 1) : records;
          for (const record of targets) {
            applyDocumentUpdate(record, updateOperation.update);
          }
          modifiedCount += targets.length;
        }
        return { modifiedCount };
      },
    }),
  };
}

function resetState(): void {
  nextId = 1;
  installMockMongoConnection();
  dbState.projects = [
    {
      _id: PROJECT_ID,
      id: PROJECT_ID,
      tenantId: TENANT_ID,
      name: 'Test Project',
      slug: 'test-project',
      description: 'Project with an MCP-backed public repo tool',
      entryAgentName: 'SupportAgent',
    },
  ];
  dbState.projectAgents = [
    {
      _id: 'agent-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      name: 'SupportAgent',
      description: 'Answers documentation questions',
      dslContent: AGENT_DSL,
      ownerId: USER_ID,
      ownerTeamId: null,
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-7',
      },
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
      status: 'active',
    },
  ];
  dbState.promptLibraryItems = [
    {
      _id: 'prompt-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      name: 'Support Prompt',
      description: 'Prompt used by SupportAgent',
      tags: ['support'],
      usageCount: 0,
      nextVersionNumber: 8,
      status: 'active',
      createdBy: USER_ID,
    },
  ];
  dbState.promptLibraryVersions = [
    {
      _id: 'version-7',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      promptId: 'prompt-1',
      versionNumber: 7,
      template: 'Answer using the support playbook.',
      variables: ['customer_name'],
      description: 'Current support prompt',
      status: 'active',
      sourceHash: 'prompt-version-hash-7',
      metadata: { tone: 'friendly' },
      createdBy: USER_ID,
      publishedAt: new Date('2026-04-01T09:00:00.000Z'),
      publishedBy: USER_ID,
    },
  ];
  dbState.projectTools = [
    {
      _id: 'tool-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      name: 'search_docs',
      slug: 'search_docs',
      toolType: 'mcp',
      description: 'Search documents in the public repository',
      dslContent: MCP_TOOL_DSL,
      createdBy: USER_ID,
      lastEditedBy: USER_ID,
    },
  ];
  dbState.mcpServers = [
    {
      _id: 'mcp-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      name: MCP_SERVER_NAME,
      description: 'Public repository MCP server',
      transport: 'sse',
      url: 'https://example.com/mcp',
      encryptedEnv: null,
      authType: 'none',
      encryptedAuthConfig: null,
      authProfileId: null,
      priority: 1,
      tags: '["public","repo"]',
      connectionTimeoutMs: 15000,
      requestTimeoutMs: 45000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      lastConnectionStatus: 'connected',
      createdBy: USER_ID,
      modifiedBy: USER_ID,
      _v: 1,
    },
  ];
  dbState.projectRuntimeConfigs = [
    {
      _id: 'runtime-config-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      extraction: { nlu_provider: 'standard' },
      filler: { modelSource: 'system' },
      createdBy: USER_ID,
      _v: 7,
      createdAt: new Date('2026-04-01T09:00:00.000Z'),
      updatedAt: new Date('2026-04-02T09:00:00.000Z'),
    },
  ];
  dbState.connectorConfigs = [];
  dbState.importOperations = [];
  dbState.projectConfigVariables = [
    {
      _id: 'config-var-1',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      key: 'support.region',
      value: 'emea',
      description: 'Support routing region',
      createdBy: USER_ID,
      updatedBy: USER_ID,
    },
  ];

  mockRequireAuth.mockResolvedValue({
    id: USER_ID,
    tenantId: TENANT_ID,
    email: 'test@example.com',
    name: 'Test User',
    permissions: ['*:*'],
  });
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockImplementation(async () => ({ project: dbState.projects[0] }));
  mockIsAccessError.mockReturnValue(false);
}

function makeEmptyEvalModel(prefix: string) {
  return {
    find: vi.fn(() => makeQuery(() => [])),
    insertMany: vi.fn(async (documents: Array<Record<string, unknown>>) =>
      documents.map((document) => ({
        _id: generateId(prefix),
        ...cloneValue(document),
      })),
    ),
    bulkWrite: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => undefined),
    countDocuments: vi.fn(async () => 0),
  };
}

const databaseModule = {
  COMPLETED_OPERATION_TTL_SECONDS: 3600,
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AgentModelConfig: {
    find: vi.fn(() => makeQuery(() => [])),
  },
  ConnectorConfig: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(
        () =>
          dbState.connectorConfigs.filter((record) => matchesFilter(record, filter)) as Array<
            Record<string, unknown>
          >,
      ),
    ),
  },
  Deployment: {
    find: vi.fn(() => makeQuery(() => [])),
  },
  EnvironmentVariable: {
    find: vi.fn(() => makeQuery(() => [])),
  },
  EvalEvaluator: makeEmptyEvalModel('eval-evaluator'),
  EvalPersona: makeEmptyEvalModel('eval-persona'),
  EvalScenario: makeEmptyEvalModel('eval-scenario'),
  EvalSet: makeEmptyEvalModel('eval-set'),
  ImportOperation: {
    create: vi.fn(
      async (document: Omit<InMemoryImportOperation, '_id' | 'createdAt' | 'updatedAt'>) => {
        const created: InMemoryImportOperation = {
          _id: generateId('import-op'),
          createdAt: new Date('2026-04-03T00:00:00.000Z'),
          updatedAt: new Date('2026-04-03T00:00:00.000Z'),
          ...document,
        };
        dbState.importOperations.push(created);
        return cloneValue(created);
      },
    ),
    findOne: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(
        () => dbState.importOperations.find((record) => matchesFilter(record, filter)) ?? null,
      ),
    ),
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const target = dbState.importOperations.find((record) => matchesFilter(record, filter));
      if (target) {
        applyDocumentUpdate(target, update);
      }
      return {
        matchedCount: target ? 1 : 0,
        modifiedCount: target ? 1 : 0,
      };
    }),
  },
  PromptLibraryItem: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() => dbState.promptLibraryItems.filter((record) => matchesFilter(record, filter))),
    ),
    countDocuments: vi.fn(
      async (filter: Record<string, unknown>) =>
        dbState.promptLibraryItems.filter((record) => matchesFilter(record, filter)).length,
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryPromptLibraryItem>>) => {
      const created = documents.map((document) => {
        const record: InMemoryPromptLibraryItem = {
          _id: String(document._id ?? generateId('prompt')),
          projectId: String(document.projectId ?? PROJECT_ID),
          tenantId: String(document.tenantId ?? TENANT_ID),
          name: String(document.name),
          description: (document.description as string | undefined) ?? undefined,
          tags: (document.tags as string[] | undefined) ?? [],
          usageCount: (document.usageCount as number | undefined) ?? 0,
          nextVersionNumber: (document.nextVersionNumber as number | undefined) ?? 0,
          status: (document.status as InMemoryPromptLibraryItem['status'] | undefined) ?? 'active',
          createdBy: String(document.createdBy ?? USER_ID),
        };
        dbState.promptLibraryItems.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    bulkWrite: vi.fn(
      async (
        operations: Array<{ updateOne: { filter: Record<string, unknown>; update: any } }>,
      ) => {
        for (const operation of operations) {
          const target = dbState.promptLibraryItems.find((record) =>
            matchesFilter(record, operation.updateOne.filter),
          );
          if (target) {
            applyDocumentUpdate(target, operation.updateOne.update);
          }
        }
      },
    ),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.promptLibraryItems = deleteMatching(dbState.promptLibraryItems, filter);
    }),
  },
  PromptLibraryVersion: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() =>
        dbState.promptLibraryVersions.filter((record) => matchesFilter(record, filter)),
      ),
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryPromptLibraryVersion>>) => {
      const created = documents.map((document) => {
        const record: InMemoryPromptLibraryVersion = {
          _id: String(document._id ?? generateId('prompt-version')),
          projectId: String(document.projectId ?? PROJECT_ID),
          tenantId: String(document.tenantId ?? TENANT_ID),
          promptId: String(document.promptId),
          versionNumber: Number(document.versionNumber ?? 1),
          template: String(document.template ?? ''),
          variables: (document.variables as string[] | undefined) ?? [],
          description: (document.description as string | undefined) ?? undefined,
          status:
            (document.status as InMemoryPromptLibraryVersion['status'] | undefined) ?? 'draft',
          sourceHash: String(document.sourceHash ?? ''),
          metadata: (document.metadata as Record<string, unknown> | null | undefined) ?? null,
          createdBy: String(document.createdBy ?? USER_ID),
          publishedAt: (document.publishedAt as Date | null | undefined) ?? null,
          publishedBy: (document.publishedBy as string | null | undefined) ?? null,
        };
        dbState.promptLibraryVersions.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.promptLibraryVersions = deleteMatching(dbState.promptLibraryVersions, filter);
    }),
  },
  MCPServerConfig: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() => dbState.mcpServers.filter((record) => matchesFilter(record, filter))),
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryMcpServer>>) => {
      const created = documents.map((document) => {
        const record: InMemoryMcpServer = {
          _id: generateId('mcp'),
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          name: String(document.name),
          description: (document.description as string | null | undefined) ?? null,
          transport: (document.transport as 'http' | 'sse') ?? 'sse',
          url: (document.url as string | null | undefined) ?? null,
          encryptedEnv: null,
          authType: (document.authType as InMemoryMcpServer['authType'] | undefined) ?? 'none',
          encryptedAuthConfig: null,
          authProfileId: null,
          priority: (document.priority as number | undefined) ?? 0,
          tags: (document.tags as string | null | undefined) ?? null,
          connectionTimeoutMs: (document.connectionTimeoutMs as number | undefined) ?? 30000,
          requestTimeoutMs: (document.requestTimeoutMs as number | undefined) ?? 30000,
          autoReconnect: (document.autoReconnect as boolean | undefined) ?? true,
          maxReconnectAttempts: (document.maxReconnectAttempts as number | undefined) ?? 3,
          lastConnectionStatus:
            (document.lastConnectionStatus as
              | InMemoryMcpServer['lastConnectionStatus']
              | undefined) ?? null,
          createdBy: (document.createdBy as string | null | undefined) ?? null,
          modifiedBy: (document.modifiedBy as string | null | undefined) ?? null,
          _v: 1,
        };
        dbState.mcpServers.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    bulkWrite: vi.fn(
      async (
        operations: Array<{ updateOne: { filter: Record<string, unknown>; update: any } }>,
      ) => {
        for (const operation of operations) {
          const target = dbState.mcpServers.find((record) =>
            matchesFilter(record, operation.updateOne.filter),
          );
          if (target) {
            applyDocumentUpdate(target, operation.updateOne.update);
          }
        }
      },
    ),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.mcpServers = deleteMatching(dbState.mcpServers, filter);
    }),
    countDocuments: vi.fn(
      async (filter: Record<string, unknown>) =>
        dbState.mcpServers.filter((record) => matchesFilter(record, filter)).length,
    ),
  },
  Project: {
    findOne: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() => dbState.projects.find((record) => matchesFilter(record, filter)) ?? null),
    ),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const project = dbState.projects.find((record) => matchesFilter(record, filter)) ?? null;
        if (project) {
          applyDocumentUpdate(project, update as any);
        }
        return project ? cloneValue(project) : null;
      },
    ),
  },
  ProjectAgent: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() =>
        dbState.projectAgents
          .filter((record) => matchesFilter(record, filter))
          .map((record) => ({
            ...record,
            systemPromptLibraryRef: record.systemPromptLibraryRef ?? null,
          })),
      ),
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryProjectAgent>>) => {
      const created = documents.map((document) => {
        const record: InMemoryProjectAgent = {
          _id: generateId('agent'),
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          name: String(document.name),
          description: (document.description as string | null | undefined) ?? null,
          dslContent: String(document.dslContent ?? ''),
          ownerId: (document.ownerId as string | null | undefined) ?? null,
          ownerTeamId: (document.ownerTeamId as string | null | undefined) ?? null,
          systemPromptLibraryRef:
            (document.systemPromptLibraryRef as
              | InMemoryProjectAgent['systemPromptLibraryRef']
              | undefined) ?? null,
          status: (document.status as string | undefined) ?? 'active',
        };
        dbState.projectAgents.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    bulkWrite: vi.fn(
      async (
        operations: Array<{ updateOne: { filter: Record<string, unknown>; update: any } }>,
      ) => {
        for (const operation of operations) {
          const target = dbState.projectAgents.find((record) =>
            matchesFilter(record, operation.updateOne.filter),
          );
          if (target) {
            applyDocumentUpdate(target, operation.updateOne.update);
          }
        }
      },
    ),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.projectAgents = deleteMatching(dbState.projectAgents, filter);
    }),
    countDocuments: vi.fn(
      async (filter: Record<string, unknown>) =>
        dbState.projectAgents.filter((record) => matchesFilter(record, filter)).length,
    ),
  },
  ProjectConfigVariable: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() =>
        dbState.projectConfigVariables.filter((record) => matchesFilter(record, filter)),
      ),
    ),
    findOne: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(
        () =>
          dbState.projectConfigVariables.find((record) => matchesFilter(record, filter)) ?? null,
      ),
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryProjectConfigVariable>>) => {
      const created = documents.map((document) => {
        const record: InMemoryProjectConfigVariable = {
          _id: generateId('locale'),
          projectId: String(document.projectId ?? PROJECT_ID),
          tenantId: String(document.tenantId ?? TENANT_ID),
          key: String(document.key),
          value: String(document.value ?? ''),
          description: (document.description as string | null | undefined) ?? null,
          createdAt: (document.createdAt as Date | undefined) ?? new Date(),
          updatedAt: (document.updatedAt as Date | undefined) ?? new Date(),
          createdBy: (document.createdBy as string | null | undefined) ?? null,
          updatedBy: (document.updatedBy as string | null | undefined) ?? null,
        };
        dbState.projectConfigVariables.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    bulkWrite: vi.fn(
      async (
        operations: Array<{ updateOne: { filter: Record<string, unknown>; update: any } }>,
      ) => {
        for (const operation of operations) {
          const target = dbState.projectConfigVariables.find((record) =>
            matchesFilter(record, operation.updateOne.filter),
          );
          if (target) {
            applyDocumentUpdate(target, operation.updateOne.update);
          }
        }
      },
    ),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.projectConfigVariables = deleteMatching(dbState.projectConfigVariables, filter);
    }),
    countDocuments: vi.fn(
      async (filter: Record<string, unknown>) =>
        dbState.projectConfigVariables.filter((record) => matchesFilter(record, filter)).length,
    ),
  },
  ProjectLLMConfig: {
    findOne: vi.fn(() => makeQuery(() => null)),
  },
  ModelConfig: {
    find: vi.fn(() => makeQuery(() => [])),
    countDocuments: vi.fn(async () => 0),
  },
  ProjectRuntimeConfig: {
    findOne: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(
        () => dbState.projectRuntimeConfigs.find((record) => matchesFilter(record, filter)) ?? null,
      ),
    ),
  },
  ProjectSettings: {
    findOne: vi.fn(() => makeQuery(() => null)),
  },
  ProjectTool: {
    find: vi.fn((filter: Record<string, unknown>) =>
      makeQuery(() => dbState.projectTools.filter((record) => matchesFilter(record, filter))),
    ),
    insertMany: vi.fn(async (documents: Array<Partial<InMemoryProjectTool>>) => {
      const created = documents.map((document) => {
        const record: InMemoryProjectTool = {
          _id: generateId('tool'),
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          name: String(document.name),
          slug: String(document.slug ?? document.name),
          toolType: (document.toolType as InMemoryProjectTool['toolType'] | undefined) ?? 'http',
          description: (document.description as string | null | undefined) ?? null,
          dslContent: String(document.dslContent ?? ''),
          createdBy: (document.createdBy as string | null | undefined) ?? null,
          lastEditedBy: (document.lastEditedBy as string | null | undefined) ?? null,
        };
        dbState.projectTools.push(record);
        return cloneValue(record);
      });

      return created;
    }),
    bulkWrite: vi.fn(
      async (
        operations: Array<{ updateOne: { filter: Record<string, unknown>; update: any } }>,
      ) => {
        for (const operation of operations) {
          const target = dbState.projectTools.find((record) =>
            matchesFilter(record, operation.updateOne.filter),
          );
          if (target) {
            applyDocumentUpdate(target, operation.updateOne.update);
          }
        }
      },
    ),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      dbState.projectTools = deleteMatching(dbState.projectTools, filter);
    }),
    countDocuments: vi.fn(
      async (filter: Record<string, unknown>) =>
        dbState.projectTools.filter((record) => matchesFilter(record, filter)).length,
    ),
  },
};

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectById: vi.fn(),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-secret' },
    server: { frontendUrl: 'http://localhost:3000' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@abl/compiler', () => ({
  mapProjectRuntimeConfigDocumentToIR: vi.fn((input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    return {
      extraction_strategy: 'auto',
      nlu_provider:
        record.extraction &&
        typeof record.extraction === 'object' &&
        typeof (record.extraction as Record<string, unknown>).nlu_provider === 'string'
          ? (record.extraction as Record<string, unknown>).nlu_provider
          : 'standard',
    };
  }),
  validateABL: vi.fn(() => ({
    errors: [],
    warnings: [],
  })),
}));

vi.mock('@agent-platform/database/models', () => databaseModule);
vi.mock('@agent-platform/database', () => databaseModule);

function makeRequest(path: string, method = 'GET', body?: Record<string, unknown>): NextRequest {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  return new NextRequest(new URL(path, 'http://localhost:3000'), init);
}

describe('project I/O route round-trip for MCP server configs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('round-trips exported MCP server configs through the Studio export and import routes', async () => {
    const exportRoute = await import('@/app/api/projects/[id]/export/route');
    const previewRoute = await import('@/app/api/projects/[id]/import/preview/route');
    const applyRoute = await import('@/app/api/projects/[id]/import/apply/route');
    const routeContext = { params: Promise.resolve({ id: PROJECT_ID }) };

    const exportResponse = await exportRoute.GET(
      makeRequest(`/api/projects/${PROJECT_ID}/export?layers=core,prompts`),
      routeContext,
    );
    expect(exportResponse.status).toBe(200);

    const exportedBody = (await exportResponse.json()) as {
      files: Record<string, string>;
      manifest: {
        agents: Record<
          string,
          {
            systemPromptLibraryRef?: {
              promptId: string;
              versionId: string;
            };
          }
        >;
        metadata: { required_mcp_servers: string[] };
      };
      success: boolean;
      warnings: string[];
    };

    expect(exportedBody.success).toBe(true);
    expect(exportedBody.manifest.metadata.required_mcp_servers).toEqual([MCP_SERVER_NAME]);
    expect(exportedBody.manifest.agents.SupportAgent.systemPromptLibraryRef).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-7',
    });
    expect(
      (
        JSON.parse(exportedBody.files['project.json']) as {
          agents: Record<string, { systemPromptLibraryRef?: unknown }>;
        }
      ).agents.SupportAgent.systemPromptLibraryRef,
    ).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-7',
    });
    expect(exportedBody.files['prompts/support_prompt.prompt.json']).toBeDefined();
    expect(exportedBody.files[MCP_SERVER_FILE]).toBeDefined();
    expect(exportedBody.files[TOOL_FILE]).toContain('server: "public-repo-tools"');
    expect(exportedBody.files['config/runtime-config.json']).toBeDefined();
    expect(JSON.parse(exportedBody.files['environment/config-vars.json'])).toEqual([
      {
        key: 'support.region',
        value: 'emea',
        description: 'Support routing region',
      },
    ]);

    const exportedRuntimeConfig = JSON.parse(
      exportedBody.files['config/runtime-config.json'],
    ) as Record<string, unknown>;
    expect(exportedRuntimeConfig).toMatchObject({
      extraction: expect.objectContaining({ nlu_provider: 'standard' }),
      filler: expect.objectContaining({ modelSource: 'system' }),
    });
    expect(exportedRuntimeConfig).not.toHaveProperty('projectId');
    expect(exportedRuntimeConfig).not.toHaveProperty('tenantId');
    expect(exportedRuntimeConfig).not.toHaveProperty('createdBy');
    expect(exportedRuntimeConfig).not.toHaveProperty('_v');

    const exportedPromptBundle = JSON.parse(
      exportedBody.files['prompts/support_prompt.prompt.json'],
    ) as Record<string, unknown>;
    expect(exportedPromptBundle).toMatchObject({
      promptId: 'prompt-1',
      name: 'Support Prompt',
      nextVersionNumber: 8,
      versions: [
        expect.objectContaining({
          versionId: 'version-7',
          versionNumber: 7,
          template: 'Answer using the support playbook.',
          sourceHash: 'prompt-version-hash-7',
        }),
      ],
    });

    const exportedMcpConfig = JSON.parse(exportedBody.files[MCP_SERVER_FILE]) as Record<
      string,
      unknown
    >;
    expect(exportedMcpConfig).toMatchObject({
      name: MCP_SERVER_NAME,
      description: 'Public repository MCP server',
      transport: 'sse',
      url: 'https://example.com/mcp',
      authType: 'none',
      priority: 1,
      tags: '["public","repo"]',
      connectionTimeoutMs: 15000,
      requestTimeoutMs: 45000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      lastConnectionStatus: 'connected',
    });
    expect(exportedMcpConfig).not.toHaveProperty('serverName');
    expect(exportedMcpConfig).not.toHaveProperty('endpoint');

    dbState.projectAgents = [];
    dbState.projectTools = [];
    dbState.mcpServers = [];
    dbState.promptLibraryItems = [];
    dbState.promptLibraryVersions = [];
    dbState.projectRuntimeConfigs = [];
    dbState.projectConfigVariables = [];
    dbState.projects[0].entryAgentName = null;

    const previewResponse = await previewRoute.POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/preview`, 'POST', {
        files: exportedBody.files,
        deleteUnmatched: true,
      }),
      routeContext,
    );
    expect(previewResponse.status).toBe(200);

    const previewBody = (await previewResponse.json()) as {
      previewDigest?: string;
      preview: {
        hasBlockingIssues: boolean;
        issues: Array<{ blocking: boolean; id: string }>;
        layerChanges: { core?: { added?: number } };
        previewDigest?: string;
        requiresAcknowledgement?: boolean;
      };
      success: boolean;
    };

    expect(previewBody.success).toBe(true);
    expect(previewBody.preview.hasBlockingIssues).toBe(false);
    expect(previewBody.preview.layerChanges.core?.added).toBe(5);
    expect(previewBody.preview.layerChanges.prompts?.added).toBe(1);
    expect(previewBody.previewDigest).toBeTruthy();
    expect(previewBody.preview.previewDigest).toBeTruthy();
    expect(previewBody.previewDigest).toBe(previewBody.preview.previewDigest);

    const applyResponse = await applyRoute.POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/apply`, 'POST', {
        files: exportedBody.files,
        deleteUnmatched: true,
        previewDigest: previewBody.previewDigest ?? null,
        acknowledgedIssueIds: previewBody.preview.issues
          .filter((issue) => !issue.blocking)
          .map((issue) => issue.id),
      }),
      routeContext,
    );
    expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);

    const applyBody = (await applyResponse.json()) as {
      applied: {
        created: number;
        deleted: number;
        modelPoliciesUpserted?: number;
        toolsCreated: number;
        toolsDeleted: number;
        toolsUpdated: number;
        updated: number;
      };
      entryAgentName: string | null;
      success: boolean;
    };

    expect(applyBody).toMatchObject({
      success: true,
      entryAgentName: 'SupportAgent',
      applied: {
        created: 1,
        updated: 0,
        deleted: 0,
        toolsCreated: 1,
        toolsUpdated: 0,
        toolsDeleted: 0,
        modelPoliciesUpserted: 1,
      },
    });

    expect(dbState.projectAgents).toHaveLength(1);
    expect(dbState.promptLibraryItems).toHaveLength(1);
    expect(dbState.promptLibraryVersions).toHaveLength(1);
    expect(dbState.projectTools).toHaveLength(1);
    expect(dbState.mcpServers).toHaveLength(1);
    expect(dbState.projectRuntimeConfigs).toHaveLength(1);
    expect(dbState.projectConfigVariables).toHaveLength(1);
    expect(dbState.projects[0].entryAgentName).toBe('SupportAgent');
    expect(dbState.projectRuntimeConfigs[0]).toMatchObject({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      extraction: expect.objectContaining({ nlu_provider: 'standard' }),
      filler: expect.objectContaining({ modelSource: 'system' }),
    });
    expect(dbState.projectRuntimeConfigs[0]).not.toHaveProperty('createdBy');
    expect(dbState.projectRuntimeConfigs[0]).not.toHaveProperty('_v');
    expect(dbState.projectConfigVariables[0]).toMatchObject({
      key: 'support.region',
      value: 'emea',
      description: 'Support routing region',
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
    });
    expect(
      dbState.projectAgents[0].systemPromptLibraryRef,
      JSON.stringify(dbState.projectAgents[0], null, 2),
    ).toEqual({
      promptId: dbState.promptLibraryItems[0]._id,
      versionId: dbState.promptLibraryVersions[0]._id,
    });
    expect(dbState.mcpServers[0]).toMatchObject({
      name: MCP_SERVER_NAME,
      description: 'Public repository MCP server',
      transport: 'sse',
      url: 'https://example.com/mcp',
      authType: 'none',
      priority: 1,
      tags: '["public","repo"]',
      connectionTimeoutMs: 15000,
      requestTimeoutMs: 45000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      lastConnectionStatus: 'connected',
    });
    expect(dbState.mcpServers[0]).not.toHaveProperty('serverName');
    expect(dbState.mcpServers[0]).not.toHaveProperty('endpoint');
    expect(dbState.promptLibraryItems[0]).toMatchObject({
      name: 'Support Prompt',
      nextVersionNumber: 8,
    });
    expect(dbState.promptLibraryVersions[0]).toMatchObject({
      promptId: dbState.promptLibraryItems[0]._id,
      versionNumber: 7,
      sourceHash: 'prompt-version-hash-7',
    });

    const reExportResponse = await exportRoute.GET(
      makeRequest(`/api/projects/${PROJECT_ID}/export?layers=core,prompts`),
      routeContext,
    );
    expect(reExportResponse.status).toBe(200);

    const reExportBody = (await reExportResponse.json()) as {
      files: Record<string, string>;
      manifest: {
        agents: Record<
          string,
          {
            systemPromptLibraryRef?: {
              promptId: string;
              versionId: string;
            };
          }
        >;
        metadata: { required_mcp_servers: string[] };
      };
      success: boolean;
    };

    expect(reExportBody.success).toBe(true);
    expect(reExportBody.manifest.metadata.required_mcp_servers).toEqual([MCP_SERVER_NAME]);
    expect(reExportBody.manifest.agents.SupportAgent.systemPromptLibraryRef).toEqual({
      promptId: dbState.promptLibraryItems[0]._id,
      versionId: dbState.promptLibraryVersions[0]._id,
    });
    const reExportedPromptBundle = JSON.parse(
      reExportBody.files['prompts/support_prompt.prompt.json'],
    ) as Record<string, unknown>;
    expect(reExportedPromptBundle).toMatchObject({
      promptId: dbState.promptLibraryItems[0]._id,
      name: 'Support Prompt',
      nextVersionNumber: 8,
      versions: [
        expect.objectContaining({
          versionId: dbState.promptLibraryVersions[0]._id,
          versionNumber: 7,
          template: 'Answer using the support playbook.',
          sourceHash: 'prompt-version-hash-7',
        }),
      ],
    });
    expect(reExportBody.files[MCP_SERVER_FILE]).toBe(exportedBody.files[MCP_SERVER_FILE]);
    expect(reExportBody.files[TOOL_FILE].trimEnd()).toBe(exportedBody.files[TOOL_FILE].trimEnd());
    expect(reExportBody.files['environment/config-vars.json']).toBe(
      exportedBody.files['environment/config-vars.json'],
    );
  });
});
