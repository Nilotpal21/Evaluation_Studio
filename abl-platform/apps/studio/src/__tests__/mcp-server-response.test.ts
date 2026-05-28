import { describe, it, expect } from 'vitest';
import { sanitizeMcpServer } from '@/lib/mcp-server-response';

describe('sanitizeMcpServer', () => {
  const baseMcpServer = {
    id: 'srv-1',
    _id: 'srv-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Test MCP Server',
    description: null,
    transport: 'http' as const,
    url: 'http://localhost:3001',
    encryptedEnv: 'encrypted-blob',
    authType: 'none' as const,
    encryptedAuthConfig: null,
    priority: 1,
    tags: '["api","weather"]',
    connectionTimeoutMs: 30000,
    requestTimeoutMs: 30000,
    autoReconnect: true,
    maxReconnectAttempts: 3,
    lastConnectionStatus: null,
    lastConnectionAt: null,
    lastConnectionLatencyMs: null,
    lastConnectionToolCount: null,
    lastConnectionError: null,
    createdBy: 'user-1',
    modifiedBy: null,
    _v: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  };

  it('strips internal fields (tenantId, projectId, encryptedEnv, _v, _id)', () => {
    const result = sanitizeMcpServer(baseMcpServer as any);
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('projectId');
    expect(result).not.toHaveProperty('encryptedEnv');
    expect(result).not.toHaveProperty('_v');
    expect(result).not.toHaveProperty('_id');
  });

  it('preserves id, createdBy, modifiedBy, timestamps', () => {
    const result = sanitizeMcpServer(baseMcpServer as any);
    expect(result.id).toBe('srv-1');
    expect(result.createdBy).toBe('user-1');
    expect(result.modifiedBy).toBeNull();
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result.updatedAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('parses tags JSON string to array', () => {
    const result = sanitizeMcpServer(baseMcpServer as any);
    expect(result.tags).toEqual(['api', 'weather']);
  });

  it('returns empty array for null tags', () => {
    const result = sanitizeMcpServer({ ...baseMcpServer, tags: null } as any);
    expect(result.tags).toEqual([]);
  });

  it('promotes _count.discoveredTools to discoveredToolCount', () => {
    const result = sanitizeMcpServer({
      ...baseMcpServer,
      _count: { discoveredTools: 5 },
    } as any);
    expect(result.discoveredToolCount).toBe(5);
    expect(result).not.toHaveProperty('_count');
  });

  it('preserves explicit discoveredToolCount over _count', () => {
    const result = sanitizeMcpServer({
      ...baseMcpServer,
      discoveredToolCount: 10,
      _count: { discoveredTools: 5 },
    } as any);
    expect(result.discoveredToolCount).toBe(10);
  });
});
