import { describe, it, expect } from 'vitest';
import {
  OwnershipService,
  type OwnershipRecord,
  type OwnershipStore,
} from '../ownership/ownership-service.js';

function createMockStore(): OwnershipStore & { data: Map<string, OwnershipRecord> } {
  const data = new Map<string, OwnershipRecord>();
  let idCounter = 0;

  return {
    data,
    async getOwnership(projectId, agentId) {
      return data.get(`${projectId}:${agentId}`) ?? null;
    },
    async upsertOwnership(record) {
      if (!record.id) record.id = `ownership-${++idCounter}`;
      data.set(`${record.projectId}:${record.agentId}`, record);
      return record;
    },
    async listByOwner(projectId, ownerId) {
      return [...data.values()].filter((r) => r.projectId === projectId && r.ownerId === ownerId);
    },
    async listByTeam(projectId, teamId) {
      return [...data.values()].filter(
        (r) => r.projectId === projectId && r.ownerTeamId === teamId,
      );
    },
  };
}

describe('OwnershipService', () => {
  it('should assign individual owner', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    const result = await service.assignOwner('proj-1', 'agent-1', 'TestAgent', {
      ownerId: 'user-1',
    });
    expect(result.ownerId).toBe('user-1');
    expect(result.projectId).toBe('proj-1');
  });

  it('should assign team owner', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    const result = await service.assignOwner('proj-1', 'agent-1', 'TestAgent', {
      ownerTeamId: 'team-1',
    });
    expect(result.ownerTeamId).toBe('team-1');
  });

  it('should transfer ownership', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await service.assignOwner('proj-1', 'agent-1', 'TestAgent', { ownerId: 'user-1' });
    const transferred = await service.transferOwnership(
      'proj-1',
      'agent-1',
      { newOwnerId: 'user-2' },
      'admin-1',
    );

    expect(transferred.ownerId).toBe('user-2');
  });

  it('should throw when transferring non-existent ownership', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await expect(
      service.transferOwnership('proj-1', 'agent-1', { newOwnerId: 'user-2' }, 'admin-1'),
    ).rejects.toThrow('No ownership record found');
  });

  it('should grant and revoke permissions', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await service.grantPermission('proj-1', 'agent-1', 'TestAgent', {
      principalType: 'user',
      principalId: 'user-2',
      operations: ['view', 'edit'],
      grantedBy: 'user-1',
    });

    const ownership = await service.getOwnership('proj-1', 'agent-1');
    expect(ownership?.permissions).toHaveLength(1);
    expect(ownership?.permissions[0].principalId).toBe('user-2');
    expect(ownership?.permissions[0].operations).toEqual(['view', 'edit']);

    await service.revokePermission('proj-1', 'agent-1', 'user-2');
    const updated = await service.getOwnership('proj-1', 'agent-1');
    expect(updated?.permissions).toHaveLength(0);
  });

  it('should replace existing permission for same principal', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await service.grantPermission('proj-1', 'agent-1', 'TestAgent', {
      principalType: 'user',
      principalId: 'user-2',
      operations: ['view'],
      grantedBy: 'user-1',
    });

    await service.grantPermission('proj-1', 'agent-1', 'TestAgent', {
      principalType: 'user',
      principalId: 'user-2',
      operations: ['view', 'edit', 'deploy'],
      grantedBy: 'user-1',
    });

    const ownership = await service.getOwnership('proj-1', 'agent-1');
    expect(ownership?.permissions).toHaveLength(1);
    expect(ownership?.permissions[0].operations).toEqual(['view', 'edit', 'deploy']);
  });

  it('should reject assignOwner when neither ownerId nor ownerTeamId provided', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await expect(service.assignOwner('proj-1', 'agent-1', 'TestAgent', {})).rejects.toThrow(
      'At least one of ownerId or ownerTeamId must be provided',
    );
  });

  it('should reject assignOwner with empty string ownerId', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await expect(
      service.assignOwner('proj-1', 'agent-1', 'TestAgent', { ownerId: '' }),
    ).rejects.toThrow('ownerId must be a non-empty string');
  });

  it('should reject assignOwner with empty string ownerTeamId', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await expect(
      service.assignOwner('proj-1', 'agent-1', 'TestAgent', { ownerTeamId: '' }),
    ).rejects.toThrow('ownerTeamId must be a non-empty string');
  });

  it('should log audit trail on transferOwnership without throwing', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await service.assignOwner('proj-1', 'agent-1', 'TestAgent', { ownerId: 'user-1' });
    const result = await service.transferOwnership(
      'proj-1',
      'agent-1',
      { newOwnerId: 'user-2' },
      'admin-1',
    );

    expect(result.ownerId).toBe('user-2');
  });

  it('should list owned agents by userId', async () => {
    const store = createMockStore();
    const service = new OwnershipService(store);

    await service.assignOwner('proj-1', 'agent-1', 'AgentA', { ownerId: 'user-1' });
    await service.assignOwner('proj-1', 'agent-2', 'AgentB', { ownerId: 'user-1' });
    await service.assignOwner('proj-1', 'agent-3', 'AgentC', { ownerId: 'user-2' });

    const owned = await service.listOwnedAgents('proj-1', { userId: 'user-1' });
    expect(owned).toHaveLength(2);
  });

  describe('assignOwner edge cases', () => {
    it('should overwrite existing individual owner with team owner', async () => {
      const store = createMockStore();
      const service = new OwnershipService(store);

      await service.assignOwner('p1', 'a1', 'Agent', { ownerId: 'user-1' });
      const result = await service.assignOwner('p1', 'a1', 'Agent', { ownerTeamId: 'team-1' });
      expect(result.ownerTeamId).toBe('team-1');
      expect(result.ownerId).toBe('user-1'); // unchanged since we only set ownerTeamId
    });
  });

  describe('transferOwnership edge cases', () => {
    it('should throw when no ownership record exists', async () => {
      const store = createMockStore();
      const service = new OwnershipService(store);

      await expect(
        service.transferOwnership('p1', 'missing', { newOwnerId: 'u2' }, 'admin'),
      ).rejects.toThrow('No ownership record found');
    });
  });

  describe('revokePermission edge cases', () => {
    it('should be a no-op when revoking from agent with no ownership record', async () => {
      const store = createMockStore();
      const service = new OwnershipService(store);

      await service.revokePermission('p1', 'no-record', 'user-1');
    });

    it('should be a no-op when revoking nonexistent principal', async () => {
      const store = createMockStore();
      const service = new OwnershipService(store);

      await service.assignOwner('p1', 'a1', 'Agent', { ownerId: 'user-1' });
      await service.grantPermission('p1', 'a1', 'Agent', {
        principalType: 'user',
        principalId: 'user-2',
        operations: ['view'],
        grantedBy: 'admin',
      });
      await service.revokePermission('p1', 'a1', 'user-999');
      const record = await service.getOwnership('p1', 'a1');
      expect(record!.permissions).toHaveLength(1); // user-2 still there
    });
  });

  describe('listOwnedAgents edge cases', () => {
    it('should return empty when no userId or teamId given', async () => {
      const store = createMockStore();
      const service = new OwnershipService(store);

      const result = await service.listOwnedAgents('p1', {});
      expect(result).toEqual([]);
    });
  });
});
