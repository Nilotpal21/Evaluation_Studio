/**
 * Collaboration Model Tests
 *
 * Tests for: AgentLock, AgentOwnership, Team, GitIntegration, GitSyncHistory
 *
 * Pure-logic tests (validation, defaults) always run via validateSync() / new Model().
 * MongoDB-dependent tests (unique indexes, CRUD) gracefully skip if
 * MongoMemoryServer is not available in the environment.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { AgentLock } from '../models/agent-lock.model.js';
import { AgentOwnership } from '../models/agent-ownership.model.js';
import { Team } from '../models/team.model.js';
import { GitIntegration } from '../models/git-integration.model.js';
import { GitSyncHistory } from '../models/git-sync-history.model.js';

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── AgentLock Model ────────────────────────────────────────────────────────

describe('AgentLock', () => {
  const validLock = () => ({
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    agentName: 'booking_agent',
    lockedBy: 'user-1',
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 600000),
    lockType: 'edit' as const,
  });

  // ── Validation tests (no DB needed) ──────────────────────────────────

  it('validates required fields - tenantId', () => {
    const data = validLock();
    delete (data as any).tenantId;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('validates required fields - projectId', () => {
    const data = validLock();
    delete (data as any).projectId;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('validates required fields - agentId', () => {
    const data = validLock();
    delete (data as any).agentId;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentId).toBeDefined();
  });

  it('validates required fields - agentName', () => {
    const data = validLock();
    delete (data as any).agentName;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentName).toBeDefined();
  });

  it('validates required fields - lockedBy', () => {
    const data = validLock();
    delete (data as any).lockedBy;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lockedBy).toBeDefined();
  });

  it('validates required fields - lockedAt', () => {
    const data = validLock();
    delete (data as any).lockedAt;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lockedAt).toBeDefined();
  });

  it('validates required fields - expiresAt', () => {
    const data = validLock();
    delete (data as any).expiresAt;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('validates required fields - lockType', () => {
    const data = validLock();
    delete (data as any).lockType;
    const err = new AgentLock(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lockType).toBeDefined();
  });

  it('validates lockType enum', () => {
    const err = new AgentLock({ ...validLock(), lockType: 'invalid' as any }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lockType).toBeDefined();
  });

  it('accepts valid lockType values', () => {
    const types = ['edit', 'deploy'] as const;
    for (const lockType of types) {
      const err = new AgentLock({ ...validLock(), lockType }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  // ── Default value tests (no DB needed) ───────────────────────────────

  it('sets default fields on a valid lock', () => {
    const doc = new AgentLock(validLock());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.agentId).toBe('agent-1');
    expect(doc.agentName).toBe('booking_agent');
    expect(doc.lockedBy).toBe('user-1');
    expect(doc.lockedAt).toBeInstanceOf(Date);
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.lockType).toBe('edit');
    expect(doc._v).toBe(1);
  });

  it('passes validation for a complete lock', () => {
    const err = new AgentLock(validLock()).validateSync();
    expect(err).toBeUndefined();
  });

  // ── DB-dependent tests ───────────────────────────────────────────────

  it('creates a valid agent lock in DB', async () => {
    if (!isMongoReady()) return;
    const lock = await AgentLock.create(validLock());
    expect(lock._id).toBeDefined();
    expect(lock.tenantId).toBe('tenant-1');
    expect(lock.projectId).toBe('proj-1');
    expect(lock.agentId).toBe('agent-1');
    expect(lock.agentName).toBe('booking_agent');
    expect(lock.lockedBy).toBe('user-1');
    expect(lock.lockedAt).toBeInstanceOf(Date);
    expect(lock.expiresAt).toBeInstanceOf(Date);
    expect(lock.lockType).toBe('edit');
    expect(lock._v).toBe(1);
  });

  it('enforces unique projectId+agentId+lockType', async () => {
    if (!isMongoReady()) return;
    await AgentLock.create(validLock());
    await expect(AgentLock.create(validLock())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same agent with different lock types', async () => {
    if (!isMongoReady()) return;
    await AgentLock.create(validLock());
    const lock2 = await AgentLock.create({ ...validLock(), lockType: 'deploy' });
    expect(lock2.lockType).toBe('deploy');
  });
});

// ─── AgentOwnership Model ───────────────────────────────────────────────────

describe('AgentOwnership', () => {
  const validOwnership = () => ({
    projectId: 'proj-1',
    agentId: 'agent-1',
    agentName: 'booking_agent',
    ownerId: 'user-1',
  });

  // ── Validation tests (no DB needed) ──────────────────────────────────

  it('validates required fields - projectId', () => {
    const data = validOwnership();
    delete (data as any).projectId;
    const err = new AgentOwnership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('validates required fields - agentId', () => {
    const data = validOwnership();
    delete (data as any).agentId;
    const err = new AgentOwnership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentId).toBeDefined();
  });

  it('validates required fields - agentName', () => {
    const data = validOwnership();
    delete (data as any).agentName;
    const err = new AgentOwnership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.agentName).toBeDefined();
  });

  it('validates permission principalType enum', () => {
    const err = new AgentOwnership({
      ...validOwnership(),
      permissions: [
        {
          principalType: 'invalid',
          principalId: 'u',
          operations: ['view'],
          grantedBy: 'u',
        },
      ],
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['permissions.0.principalType']).toBeDefined();
  });

  it('validates permission operations enum', () => {
    const err = new AgentOwnership({
      ...validOwnership(),
      permissions: [
        {
          principalType: 'user',
          principalId: 'u',
          operations: ['invalid_op'],
          grantedBy: 'u',
        },
      ],
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['permissions.0.operations.0']).toBeDefined();
  });

  // ── Default value tests (no DB needed) ───────────────────────────────

  it('sets default fields on a valid ownership', () => {
    const doc = new AgentOwnership(validOwnership());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.agentId).toBe('agent-1');
    expect(doc.agentName).toBe('booking_agent');
    expect(doc.ownerId).toBe('user-1');
    expect(doc.ownerTeamId).toBeNull();
    expect(doc.permissions).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('stores permission grants', () => {
    const doc = new AgentOwnership({
      ...validOwnership(),
      agentId: 'agent-2',
      permissions: [
        {
          principalType: 'user',
          principalId: 'user-2',
          operations: ['view', 'edit'],
          grantedBy: 'user-1',
          expiresAt: null,
        },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.permissions).toHaveLength(1);
    expect(doc.permissions[0].principalType).toBe('user');
    expect(doc.permissions[0].operations).toEqual(['view', 'edit']);
  });

  it('passes validation for a complete ownership', () => {
    const err = new AgentOwnership(validOwnership()).validateSync();
    expect(err).toBeUndefined();
  });

  // ── DB-dependent tests ───────────────────────────────────────────────

  it('creates a valid agent ownership in DB', async () => {
    if (!isMongoReady()) return;
    const ownership = await AgentOwnership.create(validOwnership());
    expect(ownership._id).toBeDefined();
    expect(ownership.projectId).toBe('proj-1');
    expect(ownership.agentId).toBe('agent-1');
    expect(ownership.agentName).toBe('booking_agent');
    expect(ownership.ownerId).toBe('user-1');
    expect(ownership.ownerTeamId).toBeNull();
    expect(ownership.permissions).toEqual([]);
    expect(ownership._v).toBe(1);
  });

  it('enforces unique projectId+agentId', async () => {
    if (!isMongoReady()) return;
    await AgentOwnership.create(validOwnership());
    await expect(AgentOwnership.create(validOwnership())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── Team Model ─────────────────────────────────────────────────────────────

describe('Team', () => {
  const validTeam = () => ({
    tenantId: 'tenant-1',
    name: 'Backend Team',
    slug: 'backend-team',
  });

  // ── Validation tests (no DB needed) ──────────────────────────────────

  it('validates required fields - tenantId', () => {
    const err = new Team({ name: 'T', slug: 's' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('validates required fields - name', () => {
    const err = new Team({ tenantId: 't', slug: 's' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('validates required fields - slug', () => {
    const err = new Team({ tenantId: 't', name: 'T' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slug).toBeDefined();
  });

  it('validates member role enum', () => {
    const err = new Team({
      ...validTeam(),
      members: [{ userId: 'u', role: 'invalid', addedBy: 'a' }],
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['members.0.role']).toBeDefined();
  });

  // ── Default value tests (no DB needed) ───────────────────────────────

  it('sets default fields on a valid team', () => {
    const doc = new Team(validTeam());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.name).toBe('Backend Team');
    expect(doc.slug).toBe('backend-team');
    expect(doc.description).toBeNull();
    expect(doc.members).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('stores team members', () => {
    const doc = new Team({
      ...validTeam(),
      members: [
        { userId: 'user-1', role: 'lead', addedBy: 'admin-1' },
        { userId: 'user-2', role: 'member', addedBy: 'user-1' },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.members).toHaveLength(2);
    expect(doc.members[0].role).toBe('lead');
    expect(doc.members[1].role).toBe('member');
  });

  it('passes validation for a complete team', () => {
    const err = new Team(validTeam()).validateSync();
    expect(err).toBeUndefined();
  });

  // ── DB-dependent tests ───────────────────────────────────────────────

  it('creates a valid team in DB', async () => {
    if (!isMongoReady()) return;
    const team = await Team.create(validTeam());
    expect(team._id).toBeDefined();
    expect(team.tenantId).toBe('tenant-1');
    expect(team.name).toBe('Backend Team');
    expect(team.slug).toBe('backend-team');
    expect(team.description).toBeNull();
    expect(team.members).toEqual([]);
    expect(team._v).toBe(1);
  });

  it('enforces unique tenantId+slug', async () => {
    if (!isMongoReady()) return;
    await Team.create(validTeam());
    await expect(Team.create({ ...validTeam(), name: 'Other Name' })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('enforces unique tenantId+name', async () => {
    if (!isMongoReady()) return;
    await Team.create(validTeam());
    await expect(Team.create({ ...validTeam(), slug: 'other-slug' })).rejects.toThrow(
      /duplicate key/i,
    );
  });
});

// ─── GitIntegration Model ───────────────────────────────────────────────────

describe('GitIntegration', () => {
  const validGit = () => ({
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    provider: 'github' as const,
    repositoryUrl: 'https://github.com/org/repo',
    authProfileId: 'auth-profile-1',
  });

  // ── Validation tests (no DB needed) ──────────────────────────────────

  it('validates required fields - projectId', () => {
    const data = validGit();
    delete (data as any).projectId;
    const err = new GitIntegration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('validates required fields - tenantId', () => {
    const data = validGit();
    delete (data as any).tenantId;
    const err = new GitIntegration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('validates required fields - provider', () => {
    const data = validGit();
    delete (data as any).provider;
    const err = new GitIntegration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('validates provider enum', () => {
    const err = new GitIntegration({
      ...validGit(),
      provider: 'invalid' as any,
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('accepts valid provider values', () => {
    const providers = ['github', 'gitlab', 'bitbucket', 'generic'] as const;
    for (const provider of providers) {
      const err = new GitIntegration({ ...validGit(), provider }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates required fields - repositoryUrl', () => {
    const data = validGit();
    delete (data as any).repositoryUrl;
    const err = new GitIntegration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.repositoryUrl).toBeDefined();
  });

  it('validates required fields - authProfileId', () => {
    const data = validGit();
    delete (data as any).authProfileId;
    const err = new GitIntegration(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authProfileId).toBeDefined();
  });

  it('does not model legacy credentials on git integrations', () => {
    const doc = new GitIntegration({
      ...validGit(),
      credentials: { type: 'token', secretId: 'legacy-secret-1' },
    } as any);

    expect((doc as any).credentials).toBeUndefined();
    expect(doc.toObject()).not.toHaveProperty('credentials');
  });

  it('validates status enum', () => {
    const err = new GitIntegration({
      ...validGit(),
      status: 'invalid' as any,
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  // ── Default value tests (no DB needed) ───────────────────────────────

  it('sets default fields on a valid git integration', () => {
    const doc = new GitIntegration(validGit());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.provider).toBe('github');
    expect(doc.repositoryUrl).toBe('https://github.com/org/repo');
    expect(doc.defaultBranch).toBe('main');
    expect(doc.syncPath).toBe('/');
    expect((doc as any).credentials).toBeUndefined();
    expect(doc.authProfileId).toBe('auth-profile-1');
    expect(doc.webhookSecret).toBeNull();
    expect(doc.previousWebhookSecret).toBeNull();
    expect(doc.previousWebhookSecretExpiresAt).toBeNull();
    expect(doc.webhookId).toBeNull();
    expect(doc.syncConfig.autoSync).toBe(false);
    expect(doc.syncConfig.autoDeploy).toBeNull();
    expect(doc.syncConfig.conflictStrategy).toBe('manual');
    expect(doc.lastSyncAt).toBeNull();
    expect(doc.lastSyncCommit).toBeNull();
    expect(doc.lastSyncStatus).toBeNull();
    expect(doc.lastSyncError).toBeNull();
    expect(doc.status).toBe('active');
    expect(doc._v).toBe(1);
  });

  it('passes validation for a complete git integration', () => {
    const err = new GitIntegration(validGit()).validateSync();
    expect(err).toBeUndefined();
  });

  // ── DB-dependent tests ───────────────────────────────────────────────

  it('creates a valid git integration in DB', async () => {
    if (!isMongoReady()) return;
    const git = await GitIntegration.create(validGit());
    expect(git._id).toBeDefined();
    expect(git.projectId).toBe('proj-1');
    expect(git.tenantId).toBe('tenant-1');
    expect(git.provider).toBe('github');
    expect(git.repositoryUrl).toBe('https://github.com/org/repo');
    expect(git.defaultBranch).toBe('main');
    expect(git.syncPath).toBe('/');
    expect((git as any).credentials).toBeUndefined();
    expect(git.authProfileId).toBe('auth-profile-1');
    expect(git.webhookSecret).toBeNull();
    expect(git.previousWebhookSecret).toBeNull();
    expect(git.previousWebhookSecretExpiresAt).toBeNull();
    expect(git.webhookId).toBeNull();
    expect(git.syncConfig.autoSync).toBe(false);
    expect(git.syncConfig.autoDeploy).toBeNull();
    expect(git.syncConfig.conflictStrategy).toBe('manual');
    expect(git.lastSyncAt).toBeNull();
    expect(git.lastSyncCommit).toBeNull();
    expect(git.lastSyncStatus).toBeNull();
    expect(git.lastSyncError).toBeNull();
    expect(git.status).toBe('active');
    expect(git._v).toBe(1);
  });

  it('enforces unique projectId', async () => {
    if (!isMongoReady()) return;
    await GitIntegration.create(validGit());
    await expect(GitIntegration.create(validGit())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── GitSyncHistory Model ───────────────────────────────────────────────────

describe('GitSyncHistory', () => {
  const validSync = () => ({
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    direction: 'push' as const,
    branch: 'main',
    status: 'success' as const,
    triggeredBy: 'user-1',
  });

  // ── Validation tests (no DB needed) ──────────────────────────────────

  it('validates required fields - projectId', () => {
    const data = validSync();
    delete (data as any).projectId;
    const err = new GitSyncHistory(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('validates required fields - direction', () => {
    const data = validSync();
    delete (data as any).direction;
    const err = new GitSyncHistory(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.direction).toBeDefined();
  });

  it('validates direction enum', () => {
    const err = new GitSyncHistory({
      ...validSync(),
      direction: 'invalid' as any,
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.direction).toBeDefined();
  });

  it('validates required fields - branch', () => {
    const data = validSync();
    delete (data as any).branch;
    const err = new GitSyncHistory(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.branch).toBeDefined();
  });

  it('validates required fields - status', () => {
    const data = validSync();
    delete (data as any).status;
    const err = new GitSyncHistory(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new GitSyncHistory({
      ...validSync(),
      status: 'invalid' as any,
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('validates required fields - triggeredBy', () => {
    const data = validSync();
    delete (data as any).triggeredBy;
    const err = new GitSyncHistory(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggeredBy).toBeDefined();
  });

  // ── Default value tests (no DB needed) ───────────────────────────────

  it('sets default fields on a valid git sync history', () => {
    const doc = new GitSyncHistory(validSync());
    expect(doc._id).toBeDefined();
    expect(doc.projectId).toBe('proj-1');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.direction).toBe('push');
    expect(doc.commitSha).toBeNull();
    expect(doc.branch).toBe('main');
    expect(doc.status).toBe('success');
    expect(doc.agentsAffected).toEqual([]);
    expect(doc.changesSummary.added).toEqual([]);
    expect(doc.changesSummary.modified).toEqual([]);
    expect(doc.changesSummary.deleted).toEqual([]);
    expect(doc.conflictDetails).toEqual([]);
    expect(doc.triggeredBy).toBe('user-1');
    expect(doc.error).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('stores conflict details', () => {
    const doc = new GitSyncHistory({
      ...validSync(),
      status: 'conflict',
      conflictDetails: [
        { agentName: 'agent-1', file: 'agents/agent-1.abl', resolved: false, resolution: null },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.conflictDetails).toHaveLength(1);
    expect(doc.conflictDetails[0].agentName).toBe('agent-1');
    expect(doc.conflictDetails[0].resolved).toBe(false);
  });

  it('passes validation for a complete sync history', () => {
    const err = new GitSyncHistory(validSync()).validateSync();
    expect(err).toBeUndefined();
  });

  // ── DB-dependent tests ───────────────────────────────────────────────

  it('creates a valid git sync history in DB', async () => {
    if (!isMongoReady()) return;
    const sync = await GitSyncHistory.create(validSync());
    expect(sync._id).toBeDefined();
    expect(sync.projectId).toBe('proj-1');
    expect(sync.tenantId).toBe('tenant-1');
    expect(sync.direction).toBe('push');
    expect(sync.commitSha).toBeNull();
    expect(sync.branch).toBe('main');
    expect(sync.status).toBe('success');
    expect(sync.agentsAffected).toEqual([]);
    expect(sync.changesSummary.added).toEqual([]);
    expect(sync.changesSummary.modified).toEqual([]);
    expect(sync.changesSummary.deleted).toEqual([]);
    expect(sync.conflictDetails).toEqual([]);
    expect(sync.triggeredBy).toBe('user-1');
    expect(sync.error).toBeNull();
    expect(sync._v).toBe(1);
  });
});
