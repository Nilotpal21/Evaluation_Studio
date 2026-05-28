/**
 * MCP Server Config Repository Tests
 *
 * Coverage:
 * - Tenant isolation (every query includes tenantId)
 * - CRUD operations (create, read, update, delete)
 * - findByProject
 * - findWithToolCount (batch count via ProjectTool DSL parsing)
 * - Cascade delete (server config + linked MCP project tools)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as mcpRepo from '../repos/mcp-server-config-repo.js';

// ─── Mock Setup ──────────────────────────────────────────────────────────

interface MockModel {
  findOne: Mock;
  find: Mock;
  findOneAndUpdate: Mock;
  deleteOne: Mock;
  deleteMany: Mock;
  create: Mock;
  countDocuments: Mock;
  aggregate: Mock;
  collection?: {
    find: Mock;
  };
}

const mockCollectionFind = vi.fn();

const mockMCPServerConfig: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
  collection: {
    find: mockCollectionFind,
  },
};

const mockProjectTool: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
};

vi.mock('@agent-platform/database/models', () => ({
  MCPServerConfig: mockMCPServerConfig,
  ProjectTool: mockProjectTool,
}));

// ─── Test Data ───────────────────────────────────────────────────────────

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_1 = 'project-1';

const now = new Date();

function makeMcpDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'mcp-1',
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    name: 'test-server',
    transport: 'http',
    url: 'http://localhost:3100/mcp',
    encryptedEnv: null,
    priority: 0,
    tags: null,
    connectionTimeoutMs: 30000,
    requestTimeoutMs: 30000,
    autoReconnect: true,
    maxReconnectAttempts: 3,
    createdBy: 'user-1',
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Helper to Mock Method Chaining ──────────────────────────────────────

function createChainableMock(returnValue: unknown) {
  const chain = {
    lean: vi.fn().mockResolvedValue(returnValue),
    sort: vi.fn(),
    skip: vi.fn(),
    limit: vi.fn(),
    select: vi.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  return chain;
}

/** Create a mock Mongoose document with set/save/toObject for findOne+save pattern */
function createDocMock(data: Record<string, unknown>) {
  const docData = { ...data };
  return {
    ...docData,
    set: vi.fn((key: string, value: unknown) => {
      (docData as any)[key] = value;
    }),
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(() => docData),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('MCP Server Config Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Tenant Isolation ────────────────────────────────────────────────

  describe('Tenant Isolation', () => {
    test('findMcpServerConfigById enforces tenantId filter', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(makeMcpDoc()));

      await mcpRepo.findMcpServerConfigById('mcp-1', TENANT_A);

      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
    });

    test('findMcpServerConfigById returns null for wrong tenant', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(null));

      const result = await mcpRepo.findMcpServerConfigById('mcp-1', TENANT_B);

      expect(result).toBeNull();
      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_B,
      });
    });

    test('findMcpServerConfigsByProject enforces tenantId + projectId', async () => {
      const chain = createChainableMock([]);
      mockMCPServerConfig.find.mockReturnValue(chain);

      await mcpRepo.findMcpServerConfigsByProject(TENANT_A, PROJECT_1);

      expect(mockMCPServerConfig.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
    });

    test('updateMcpServerConfig enforces tenantId filter', async () => {
      const doc = createDocMock(makeMcpDoc({ name: 'updated' }));
      mockMCPServerConfig.findOne.mockResolvedValue(doc);

      await mcpRepo.updateMcpServerConfig('mcp-1', TENANT_A, { name: 'updated' });

      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
    });

    test('deleteMcpServerConfigWithCascade enforces tenantId on all operations', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(
        createChainableMock(makeMcpDoc({ _id: 'mcp-1', name: 'test-server' })),
      );
      mockProjectTool.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

      await mcpRepo.deleteMcpServerConfigWithCascade('mcp-1', TENANT_A);

      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
      expect(mockProjectTool.deleteMany).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        toolType: 'mcp',
        dslContent: expect.objectContaining({ $regex: expect.any(String), $options: 'm' }),
      });
      expect(mockMCPServerConfig.deleteOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
    });
  });

  // ─── Find By ID ──────────────────────────────────────────────────────

  describe('findMcpServerConfigById', () => {
    test('returns normalized config with id field', async () => {
      const doc = makeMcpDoc();
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(doc));

      const result = await mcpRepo.findMcpServerConfigById('mcp-1', TENANT_A);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('mcp-1');
      expect(result!.name).toBe('test-server');
      expect(result!.transport).toBe('http');
    });

    test('returns null when not found', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(null));

      const result = await mcpRepo.findMcpServerConfigById('nonexistent', TENANT_A);

      expect(result).toBeNull();
    });
  });

  // ─── Find By Project ─────────────────────────────────────────────────

  describe('findMcpServerConfigsByProject', () => {
    test('returns all configs for tenant+project sorted by priority', async () => {
      const docs = [
        makeMcpDoc({ _id: 'mcp-1', priority: 10 }),
        makeMcpDoc({ _id: 'mcp-2', priority: 0 }),
      ];
      const chain = createChainableMock(docs);
      mockMCPServerConfig.find.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsByProject(TENANT_A, PROJECT_1);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('mcp-1');
      expect(result[1].id).toBe('mcp-2');
      expect(chain.sort).toHaveBeenCalledWith({ priority: -1 });
    });

    test('returns empty array when no configs found', async () => {
      const chain = createChainableMock([]);
      mockMCPServerConfig.find.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsByProject(TENANT_A, PROJECT_1);

      expect(result).toEqual([]);
    });
  });

  // ─── Find With Tool Count ────────────────────────────────────────────

  describe('findMcpServerConfigsWithToolCount', () => {
    test('returns configs with tool counts parsed from DSL', async () => {
      const docs = [
        makeMcpDoc({ _id: 'mcp-1', name: 'test-server' }),
        makeMcpDoc({ _id: 'mcp-2', name: 'other-server' }),
      ];
      const serverChain = createChainableMock(docs);
      mockMCPServerConfig.find.mockReturnValue(serverChain);

      // 3 tools reference test-server, 0 reference other-server
      const toolChain = createChainableMock([
        { dslContent: 'tool mcp_tool_a\n  type: mcp\n  server: "test-server"\n' },
        { dslContent: 'tool mcp_tool_b\n  type: mcp\n  server: "test-server"\n' },
        { dslContent: 'tool mcp_tool_c\n  type: mcp\n  server: "test-server"\n' },
      ]);
      mockProjectTool.find.mockReturnValue(toolChain);

      const result = await mcpRepo.findMcpServerConfigsWithToolCount(TENANT_A, PROJECT_1);

      expect(result).toHaveLength(2);
      expect(result[0]._count.discoveredTools).toBe(3);
      expect(result[1]._count.discoveredTools).toBe(0);
    });

    test('queries ProjectTool with toolType mcp filter', async () => {
      const docs = [makeMcpDoc({ _id: 'mcp-1', name: 'test-server' })];
      const serverChain = createChainableMock(docs);
      mockMCPServerConfig.find.mockReturnValue(serverChain);

      const toolChain = createChainableMock([]);
      mockProjectTool.find.mockReturnValue(toolChain);

      await mcpRepo.findMcpServerConfigsWithToolCount(TENANT_A, PROJECT_1);

      expect(mockProjectTool.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        toolType: 'mcp',
      });
    });

    test('returns empty array when no configs exist', async () => {
      const chain = createChainableMock([]);
      mockMCPServerConfig.find.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsWithToolCount(TENANT_A, PROJECT_1);

      expect(result).toEqual([]);
      expect(mockProjectTool.find).not.toHaveBeenCalled();
    });
  });

  // ─── Create ──────────────────────────────────────────────────────────

  describe('createMcpServerConfig', () => {
    test('creates config and returns normalized result', async () => {
      const doc = makeMcpDoc();
      mockMCPServerConfig.create.mockResolvedValue({
        toObject: () => doc,
      });

      const result = await mcpRepo.createMcpServerConfig({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        name: 'test-server',
        transport: 'http',
        url: 'http://localhost:3100/mcp',
      });

      expect(result.id).toBe('mcp-1');
      expect(result.name).toBe('test-server');
      expect(result.transport).toBe('http');
    });

    test('passes all fields to create', async () => {
      const doc = makeMcpDoc({ priority: 10, tags: 'prod' });
      mockMCPServerConfig.create.mockResolvedValue({
        toObject: () => doc,
      });

      await mcpRepo.createMcpServerConfig({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        name: 'test-server',
        transport: 'http',
        url: 'http://localhost:3100/mcp',
        priority: 10,
        tags: 'prod',
        createdBy: 'user-1',
      });

      expect(mockMCPServerConfig.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          name: 'test-server',
          transport: 'http',
          priority: 10,
          tags: 'prod',
          createdBy: 'user-1',
        }),
      );
    });
  });

  // ─── Update ──────────────────────────────────────────────────────────

  describe('updateMcpServerConfig', () => {
    test('updates config and returns normalized result', async () => {
      const updated = makeMcpDoc({ name: 'updated-server' });
      const doc = createDocMock(updated);
      mockMCPServerConfig.findOne.mockResolvedValue(doc);

      const result = await mcpRepo.updateMcpServerConfig('mcp-1', TENANT_A, {
        name: 'updated-server',
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('updated-server');
      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
      expect(doc.set).toHaveBeenCalled();
      expect(doc.save).toHaveBeenCalled();
    });

    test('returns null when config not found', async () => {
      mockMCPServerConfig.findOne.mockResolvedValue(null);

      const result = await mcpRepo.updateMcpServerConfig('nonexistent', TENANT_A, {
        name: 'updated',
      });

      expect(result).toBeNull();
    });

    test('project-scoped wrapper includes projectId in the lookup query', async () => {
      const updated = makeMcpDoc({ name: 'updated-server' });
      const doc = createDocMock(updated);
      mockMCPServerConfig.findOne.mockResolvedValue(doc);

      const result = await mcpRepo.updateProjectScopedMcpServerConfig(
        'mcp-1',
        TENANT_A,
        PROJECT_1,
        {
          name: 'updated-server',
        },
      );

      expect(result).not.toBeNull();
      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
    });
  });

  // ─── Update Connection Status ─────────────────────────────────────────

  describe('updateMcpServerConnectionStatus', () => {
    test('delegates to updateMcpServerConfig with status fields', async () => {
      const updated = makeMcpDoc({ lastConnectionStatus: 'connected' });
      const doc = createDocMock(updated);
      mockMCPServerConfig.findOne.mockResolvedValue(doc);

      const statusDate = new Date();
      const result = await mcpRepo.updateMcpServerConnectionStatus('mcp-1', TENANT_A, {
        lastConnectionStatus: 'connected',
        lastConnectionAt: statusDate,
        lastConnectionLatencyMs: 150,
        lastConnectionToolCount: 5,
      });

      expect(result).not.toBeNull();
      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
      });
      expect(doc.set).toHaveBeenCalledWith('lastConnectionStatus', 'connected');
      expect(doc.set).toHaveBeenCalledWith('lastConnectionAt', statusDate);
      expect(doc.set).toHaveBeenCalledWith('lastConnectionLatencyMs', 150);
      expect(doc.set).toHaveBeenCalledWith('lastConnectionToolCount', 5);
      expect(doc.save).toHaveBeenCalled();
    });
  });

  // ─── Cascade Delete ──────────────────────────────────────────────────

  describe('deleteMcpServerConfigWithCascade', () => {
    test('deletes server config when no linked tools exist', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(
        createChainableMock(makeMcpDoc({ _id: 'mcp-1', name: 'test-server' })),
      );
      mockProjectTool.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await mcpRepo.deleteMcpServerConfigWithCascade('mcp-1', TENANT_A);

      expect(result).toEqual({
        deleted: true,
        cascadedTools: 0,
        cascadedLinks: 0,
      });
    });

    test('cascades delete to linked MCP project tools', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(
        createChainableMock(makeMcpDoc({ _id: 'mcp-1', name: 'test-server' })),
      );
      mockProjectTool.deleteMany.mockResolvedValue({ deletedCount: 3 });
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await mcpRepo.deleteMcpServerConfigWithCascade('mcp-1', TENANT_A);

      expect(result.deleted).toBe(true);
      expect(result.cascadedTools).toBe(3);
      expect(mockProjectTool.deleteMany).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        toolType: 'mcp',
        dslContent: expect.objectContaining({ $regex: expect.any(String), $options: 'm' }),
      });
    });

    test('returns deleted:false when server config not found', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(null));
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 0 });

      const result = await mcpRepo.deleteMcpServerConfigWithCascade('nonexistent', TENANT_A);

      expect(result.deleted).toBe(false);
    });

    test('does not cascade when server config lookup returns null', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(createChainableMock(null));
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await mcpRepo.deleteMcpServerConfigWithCascade('mcp-1', TENANT_A);

      expect(result.cascadedTools).toBe(0);
      expect(mockProjectTool.deleteMany).not.toHaveBeenCalled();
    });

    test('project-scoped delete wrapper includes projectId in lookup and delete queries', async () => {
      mockMCPServerConfig.findOne.mockReturnValue(
        createChainableMock(makeMcpDoc({ _id: 'mcp-1', name: 'test-server' })),
      );
      mockProjectTool.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockMCPServerConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await mcpRepo.deleteProjectScopedMcpServerConfigWithCascade(
        'mcp-1',
        TENANT_A,
        PROJECT_1,
      );

      expect(result.deleted).toBe(true);
      expect(mockMCPServerConfig.findOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
      expect(mockMCPServerConfig.deleteOne).toHaveBeenCalledWith({
        _id: 'mcp-1',
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
    });
  });

  // ─── findMcpServerConfigsRaw ─────────────────────────────────────────────

  describe('findMcpServerConfigsRaw', () => {
    /** Build a chain mock for collection.find().sort().toArray() */
    function createCollectionChain(docs: Record<string, unknown>[]) {
      const chain = {
        sort: vi.fn(),
        toArray: vi.fn().mockResolvedValue(docs),
      };
      chain.sort.mockReturnValue(chain);
      return chain;
    }

    test('uses native collection driver to bypass Mongoose plugins', async () => {
      const chain = createCollectionChain([]);
      mockCollectionFind.mockReturnValue(chain);

      await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      // Must call collection.find (native driver), NOT model.find (Mongoose)
      expect(mockCollectionFind).toHaveBeenCalledWith({ tenantId: TENANT_A, projectId: PROJECT_1 });
      expect(mockMCPServerConfig.find).not.toHaveBeenCalled();
    });

    test('enforces explicit tenantId + projectId filter (no Mongoose plugin)', async () => {
      const chain = createCollectionChain([]);
      mockCollectionFind.mockReturnValue(chain);

      await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      expect(mockCollectionFind).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
      });
    });

    test('returns raw encryptedEnv field as-is (does NOT decrypt)', async () => {
      const rawCiphertext = 'base64-dek-envelope-ciphertext'; // simulates DEK-envelope ciphertext
      const chain = createCollectionChain([
        {
          _id: 'mcp-raw-1',
          name: 'my-server',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          transport: 'http',
          url: 'http://localhost:3100/mcp',
          encryptedEnv: rawCiphertext,
          encryptedAuthConfig: null,
          authType: null,
          authProfileId: null,
          headers: null,
          connectionTimeoutMs: 30000,
          requestTimeoutMs: 30000,
        },
      ]);
      mockCollectionFind.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      expect(result).toHaveLength(1);
      // encryptedEnv must be the raw ciphertext, not decrypted plaintext
      expect(result[0].encryptedEnv).toBe(rawCiphertext);
    });

    test('maps _id to id string and preserves all fields', async () => {
      const mockObjectId = { toString: () => 'mcp-obj-id' };
      const chain = createCollectionChain([
        {
          _id: mockObjectId,
          name: 'full-server',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          encryptedEnv: 'cipher-env',
          encryptedAuthConfig: 'cipher-auth',
          authType: 'bearer',
          authProfileId: 'auth-profile-1',
          headers: '{"X-Custom": "value"}',
          connectionTimeoutMs: 5000,
          requestTimeoutMs: 10000,
        },
      ]);
      mockCollectionFind.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      expect(result[0]).toMatchObject({
        id: 'mcp-obj-id',
        name: 'full-server',
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
        encryptedEnv: 'cipher-env',
        encryptedAuthConfig: 'cipher-auth',
        authType: 'bearer',
        authProfileId: 'auth-profile-1',
        headers: '{"X-Custom": "value"}',
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 10000,
      });
    });

    test('returns empty array when no configs exist for the project', async () => {
      const chain = createCollectionChain([]);
      mockCollectionFind.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsRaw(TENANT_A, 'empty-project');

      expect(result).toEqual([]);
    });

    test('sorts by priority descending (highest priority first)', async () => {
      const chain = createCollectionChain([]);
      mockCollectionFind.mockReturnValue(chain);

      await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      expect(chain.sort).toHaveBeenCalledWith({ priority: -1 });
    });

    test('defaults transport to http when missing in raw doc', async () => {
      const chain = createCollectionChain([
        {
          _id: 'mcp-no-transport',
          name: 'legacy-server',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          // transport is missing — should default to 'http'
          url: null,
          encryptedEnv: null,
          encryptedAuthConfig: null,
          authType: null,
          authProfileId: null,
          headers: null,
          connectionTimeoutMs: 30000,
          requestTimeoutMs: 30000,
        },
      ]);
      mockCollectionFind.mockReturnValue(chain);

      const result = await mcpRepo.findMcpServerConfigsRaw(TENANT_A, PROJECT_1);

      expect(result[0].transport).toBe('http');
    });
  });
});
