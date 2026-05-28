/**
 * Ownership Service — manages agent ownership and permissions
 *
 * Provides a pure-logic service that computes ownership changes.
 * Database operations are abstracted through a store interface
 * so the service can be tested without a real database.
 */

import type { AgentOperation, PrincipalType } from '../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('ownership-service');

// ─── Store Interface (injected by caller) ───────────────────────────────

export interface OwnershipRecord {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  ownerId: string | null;
  ownerTeamId: string | null;
  permissions: Array<{
    principalType: PrincipalType;
    principalId: string;
    operations: AgentOperation[];
    grantedBy: string;
    expiresAt: Date | null;
  }>;
}

export interface OwnershipStore {
  getOwnership(projectId: string, agentId: string): Promise<OwnershipRecord | null>;
  upsertOwnership(record: OwnershipRecord): Promise<OwnershipRecord>;
  listByOwner(projectId: string, ownerId: string): Promise<OwnershipRecord[]>;
  listByTeam(projectId: string, teamId: string): Promise<OwnershipRecord[]>;
}

// ─── Service ────────────────────────────────────────────────────────────

export class OwnershipService {
  constructor(private readonly store: OwnershipStore) {}

  async assignOwner(
    projectId: string,
    agentId: string,
    agentName: string,
    params: { ownerId?: string; ownerTeamId?: string },
  ): Promise<OwnershipRecord> {
    if (params.ownerId === undefined && params.ownerTeamId === undefined) {
      throw new Error('At least one of ownerId or ownerTeamId must be provided');
    }
    if (params.ownerId !== undefined && params.ownerId === '') {
      throw new Error('ownerId must be a non-empty string');
    }
    if (params.ownerTeamId !== undefined && params.ownerTeamId === '') {
      throw new Error('ownerTeamId must be a non-empty string');
    }

    const existing = await this.store.getOwnership(projectId, agentId);
    const record: OwnershipRecord = existing ?? {
      id: '',
      projectId,
      agentId,
      agentName,
      ownerId: null,
      ownerTeamId: null,
      permissions: [],
    };

    if (params.ownerId !== undefined) record.ownerId = params.ownerId;
    if (params.ownerTeamId !== undefined) record.ownerTeamId = params.ownerTeamId;

    return this.store.upsertOwnership(record);
  }

  async transferOwnership(
    projectId: string,
    agentId: string,
    params: { newOwnerId?: string; newOwnerTeamId?: string },
    transferredBy: string,
  ): Promise<OwnershipRecord> {
    const existing = await this.store.getOwnership(projectId, agentId);
    if (!existing) {
      throw new Error(`No ownership record found for agent ${agentId} in project ${projectId}`);
    }

    const previousOwner = existing.ownerId;
    const previousTeam = existing.ownerTeamId;

    if (params.newOwnerId !== undefined) existing.ownerId = params.newOwnerId;
    if (params.newOwnerTeamId !== undefined) existing.ownerTeamId = params.newOwnerTeamId;

    const result = await this.store.upsertOwnership(existing);

    log.info('Ownership transferred', {
      projectId,
      agentId,
      transferredBy,
      previousOwner,
      previousTeam,
      newOwner: existing.ownerId,
      newTeam: existing.ownerTeamId,
    });

    return result;
  }

  async grantPermission(
    projectId: string,
    agentId: string,
    agentName: string,
    grant: {
      principalType: PrincipalType;
      principalId: string;
      operations: AgentOperation[];
      grantedBy: string;
      expiresAt?: Date | null;
    },
  ): Promise<void> {
    const existing = await this.store.getOwnership(projectId, agentId);
    const record: OwnershipRecord = existing ?? {
      id: '',
      projectId,
      agentId,
      agentName,
      ownerId: null,
      ownerTeamId: null,
      permissions: [],
    };

    // Remove existing grant for same principal
    record.permissions = record.permissions.filter(
      (p) => !(p.principalType === grant.principalType && p.principalId === grant.principalId),
    );

    record.permissions.push({
      principalType: grant.principalType,
      principalId: grant.principalId,
      operations: grant.operations,
      grantedBy: grant.grantedBy,
      expiresAt: grant.expiresAt ?? null,
    });

    await this.store.upsertOwnership(record);
  }

  async revokePermission(projectId: string, agentId: string, principalId: string): Promise<void> {
    const existing = await this.store.getOwnership(projectId, agentId);
    if (!existing) return;

    existing.permissions = existing.permissions.filter((p) => p.principalId !== principalId);

    await this.store.upsertOwnership(existing);
  }

  async getOwnership(projectId: string, agentId: string): Promise<OwnershipRecord | null> {
    return this.store.getOwnership(projectId, agentId);
  }

  async listOwnedAgents(
    projectId: string,
    params: { userId?: string; teamId?: string },
  ): Promise<OwnershipRecord[]> {
    if (params.userId) {
      return this.store.listByOwner(projectId, params.userId);
    }
    if (params.teamId) {
      return this.store.listByTeam(projectId, params.teamId);
    }
    return [];
  }
}
