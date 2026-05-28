/**
 * Blast-Radius Aggregator Tests
 *
 * Tests consumer counting, affected user counting, and payload shape.
 * Uses dependency injection (DI) via the `deps` parameter — no vi.mock needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  aggregate,
  type BlastRadiusDeps,
} from '../../services/auth-profile/blast-radius-aggregator.js';

function buildDeps(overrides: Partial<BlastRadiusDeps> = {}): BlastRadiusDeps {
  return {
    ConnectorConnection: { countDocuments: vi.fn().mockResolvedValue(0) },
    ChannelConnection: { countDocuments: vi.fn().mockResolvedValue(0) },
    MCPServerConfig: { countDocuments: vi.fn().mockResolvedValue(0) },
    ServiceNode: { countDocuments: vi.fn().mockResolvedValue(0) },
    GitIntegration: { countDocuments: vi.fn().mockResolvedValue(0) },
    TriggerRegistration: { countDocuments: vi.fn().mockResolvedValue(0) },
    EndUserOAuthToken: {
      countDocuments: vi.fn().mockResolvedValue(0),
      distinct: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe('blast-radius aggregator', () => {
  // ─── Payload Shape ────────────────────────────────────────────────

  it('returns full payload shape with all 9 consumer types', async () => {
    const deps = buildDeps();
    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'profile' }, deps);

    expect(result).toEqual({
      type: 'profile',
      affectedConsumers: {
        tools: 0,
        integrationNodes: 0,
        mcpServers: 0,
        a2aServers: 0,
        connectorConnections: 0,
        channelConnections: 0,
        serviceNodes: 0,
        gitIntegrations: 0,
        triggerRegistrations: 0,
      },
      affectedUsers: 0,
      activeSessions: 0,
      irreversible: true,
      cascadeDeletesTokens: 0,
    });
  });

  it('returns payload without irreversible for tokens type', async () => {
    const deps = buildDeps();
    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.type).toBe('tokens');
    expect(result.irreversible).toBeUndefined();
    expect(result.cascadeDeletesTokens).toBeUndefined();
  });

  // ─── Consumer Counts ──────────────────────────────────────────────

  it('aggregates connector connection counts', async () => {
    const deps = buildDeps({
      ConnectorConnection: { countDocuments: vi.fn().mockResolvedValue(3) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.connectorConnections).toBe(3);
    expect(deps.ConnectorConnection.countDocuments).toHaveBeenCalledWith({
      authProfileId: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
  });

  it('aggregates channel connection counts', async () => {
    const deps = buildDeps({
      ChannelConnection: { countDocuments: vi.fn().mockResolvedValue(2) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.channelConnections).toBe(2);
  });

  it('aggregates MCP server counts', async () => {
    const deps = buildDeps({
      MCPServerConfig: { countDocuments: vi.fn().mockResolvedValue(5) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.mcpServers).toBe(5);
  });

  it('aggregates service node counts', async () => {
    const deps = buildDeps({
      ServiceNode: { countDocuments: vi.fn().mockResolvedValue(1) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.serviceNodes).toBe(1);
  });

  it('aggregates git integration counts', async () => {
    const deps = buildDeps({
      GitIntegration: { countDocuments: vi.fn().mockResolvedValue(4) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.gitIntegrations).toBe(4);
  });

  it('aggregates trigger registration counts', async () => {
    const deps = buildDeps({
      TriggerRegistration: { countDocuments: vi.fn().mockResolvedValue(7) },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(result.affectedConsumers.triggerRegistrations).toBe(7);
  });

  // ─── Affected Users ───────────────────────────────────────────────

  it('counts affected users from distinct userId values', async () => {
    const deps = buildDeps({
      EndUserOAuthToken: {
        countDocuments: vi.fn().mockResolvedValue(0),
        distinct: vi.fn().mockResolvedValue(['user-1', 'user-2', 'user-3']),
      },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'profile' }, deps);

    expect(result.affectedUsers).toBe(3);
  });

  // ─── Token Filter ─────────────────────────────────────────────────

  it('scopes token queries to provider key and tenantId', async () => {
    const deps = buildDeps();

    await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'tokens' }, deps);

    expect(deps.EndUserOAuthToken.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'auth-profile:profile-1',
      revokedAt: null,
    });
  });

  it('filters tokens by userId when provided', async () => {
    const deps = buildDeps();

    await aggregate(
      'profile-1',
      'tenant-1',
      'project-1',
      { type: 'tokens', userId: 'user-specific' },
      deps,
    );

    expect(deps.EndUserOAuthToken.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'auth-profile:profile-1',
      revokedAt: null,
      userId: 'user-specific',
    });
  });

  // ─── Profile Type Cascade ─────────────────────────────────────────

  it('sets cascadeDeletesTokens for profile type', async () => {
    const deps = buildDeps({
      EndUserOAuthToken: {
        countDocuments: vi.fn().mockResolvedValue(15),
        distinct: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'profile' }, deps);

    expect(result.cascadeDeletesTokens).toBe(15);
    expect(result.irreversible).toBe(true);
  });

  // ─── All counts combined ──────────────────────────────────────────

  it('aggregates all consumer types correctly', async () => {
    const deps: BlastRadiusDeps = {
      ConnectorConnection: { countDocuments: vi.fn().mockResolvedValue(2) },
      ChannelConnection: { countDocuments: vi.fn().mockResolvedValue(1) },
      MCPServerConfig: { countDocuments: vi.fn().mockResolvedValue(3) },
      ServiceNode: { countDocuments: vi.fn().mockResolvedValue(1) },
      GitIntegration: { countDocuments: vi.fn().mockResolvedValue(2) },
      TriggerRegistration: { countDocuments: vi.fn().mockResolvedValue(4) },
      EndUserOAuthToken: {
        countDocuments: vi.fn().mockResolvedValue(10),
        distinct: vi.fn().mockResolvedValue(['u1', 'u2']),
      },
    };

    const result = await aggregate('profile-1', 'tenant-1', 'project-1', { type: 'profile' }, deps);

    expect(result.affectedConsumers).toEqual({
      tools: 0,
      integrationNodes: 0,
      mcpServers: 3,
      a2aServers: 0,
      connectorConnections: 2,
      channelConnections: 1,
      serviceNodes: 1,
      gitIntegrations: 2,
      triggerRegistrations: 4,
    });
    expect(result.affectedUsers).toBe(2);
    expect(result.cascadeDeletesTokens).toBe(10);
    expect(result.irreversible).toBe(true);
  });

  // ─── Error Handling ───────────────────────────────────────────────

  it('throws on DB error (not swallowed)', async () => {
    const deps = buildDeps({
      ConnectorConnection: {
        countDocuments: vi.fn().mockRejectedValue(new Error('MongoDB connection lost')),
      },
    });

    await expect(
      aggregate('profile-1', 'tenant-1', 'project-1', { type: 'profile' }, deps),
    ).rejects.toThrow('MongoDB connection lost');
  });
});
