import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'crypto';
import {
  WorkspaceInvitation,
  PlatformAllowedEmail,
  PlatformAllowedDomain,
} from '../models/index.js';
import {
  addAllowedEmail,
  revokeAllowedEmail,
  listAllowedEmails,
  isAllowlistedEmail,
  hasValidInvitationForEmail,
  isEmailAllowedForAuth,
  canUserCreateWorkspace,
} from '../platform-access-policy.js';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';

beforeAll(async () => {
  await setupTestMongo();
});
afterAll(async () => {
  await teardownTestMongo();
});
beforeEach(async () => {
  await clearCollections();
});

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

describe('addAllowedEmail / isAllowlistedEmail / listAllowedEmails', () => {
  test('addAllowedEmail stores normalized email and isAllowlistedEmail finds it', async () => {
    if (!isMongoReady()) return;
    await addAllowedEmail('  John@Gmail.com  ', 'actor-1');
    expect(await isAllowlistedEmail('john@gmail.com')).toBe(true);
    expect(await isAllowlistedEmail('other@gmail.com')).toBe(false);
  });

  test('addAllowedEmail rejects invalid email', async () => {
    if (!isMongoReady()) return;
    await expect(addAllowedEmail('not-an-email', 'actor-1')).rejects.toThrow();
  });

  test('revokeAllowedEmail removes access', async () => {
    if (!isMongoReady()) return;
    await addAllowedEmail('jane@icloud.com', 'actor-1');
    await revokeAllowedEmail('jane@icloud.com');
    expect(await isAllowlistedEmail('jane@icloud.com')).toBe(false);
  });

  test('revokeAllowedEmail returns false for unknown email', async () => {
    if (!isMongoReady()) return;
    expect(await revokeAllowedEmail('unknown@gmail.com')).toBe(false);
  });

  test('listAllowedEmails returns only active entries', async () => {
    if (!isMongoReady()) return;
    await addAllowedEmail('a@yahoo.com', 'actor-1');
    await addAllowedEmail('b@yahoo.com', 'actor-1');
    await revokeAllowedEmail('b@yahoo.com');
    const list = await listAllowedEmails();
    expect(list.map((e) => e.email)).toEqual(['a@yahoo.com']);
  });
});

describe('hasValidInvitationForEmail', () => {
  test('returns true for a valid pending invitation matching email and token', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'rawtoken123';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'invited@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await hasValidInvitationForEmail('invited@yahoo.com', rawToken)).toBe(true);
  });

  test('returns false when token does not match', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'correcttoken';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'invited@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await hasValidInvitationForEmail('invited@yahoo.com', 'wrongtoken')).toBe(false);
  });

  test('returns false when invitation is expired', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'expiredtoken';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'invited@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await hasValidInvitationForEmail('invited@yahoo.com', rawToken)).toBe(false);
  });

  test('returns false when invitation email does not match', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'sometoken';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'other@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await hasValidInvitationForEmail('invited@yahoo.com', rawToken)).toBe(false);
  });
});

describe('isEmailAllowedForAuth with inviteToken', () => {
  test('returns true for domain-allowed email without invite', async () => {
    if (!isMongoReady()) return;
    await PlatformAllowedDomain.create({ domain: 'kore.ai', status: 'active', addedByUserId: 'a' });
    expect(await isEmailAllowedForAuth('user@kore.ai')).toBe(true);
  });

  test('returns true for allowlisted individual email', async () => {
    if (!isMongoReady()) return;
    await addAllowedEmail('john@gmail.com', 'actor-1');
    expect(await isEmailAllowedForAuth('john@gmail.com')).toBe(true);
  });

  test('returns false for non-allowed domain without invite', async () => {
    if (!isMongoReady()) return;
    expect(await isEmailAllowedForAuth('user@yahoo.com')).toBe(false);
  });

  test('returns true for non-allowed domain WITH valid invite token', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'invitetoken';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'user@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await isEmailAllowedForAuth('user@yahoo.com', { inviteToken: rawToken })).toBe(true);
  });

  test('returns false for non-allowed domain WITH expired invite token', async () => {
    if (!isMongoReady()) return;
    const rawToken = 'expiredtoken2';
    const hashed = sha256(rawToken);
    await WorkspaceInvitation.create({
      tenantId: 'tenant-1',
      email: 'user@yahoo.com',
      role: 'MEMBER',
      token: hashed,
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await isEmailAllowedForAuth('user@yahoo.com', { inviteToken: rawToken })).toBe(false);
  });
});

describe('canUserCreateWorkspace', () => {
  test('returns true for allowlisted domain', async () => {
    if (!isMongoReady()) return;
    await PlatformAllowedDomain.create({ domain: 'kore.ai', status: 'active', addedByUserId: 'a' });
    expect(await canUserCreateWorkspace('user@kore.ai')).toBe(true);
  });

  test('returns true for allowlisted email', async () => {
    if (!isMongoReady()) return;
    await addAllowedEmail('jane@gmail.com', 'actor-1');
    expect(await canUserCreateWorkspace('jane@gmail.com')).toBe(true);
  });

  test('returns false for invited-only user (no domain/email in allowlist)', async () => {
    if (!isMongoReady()) return;
    expect(await canUserCreateWorkspace('invited@yahoo.com')).toBe(false);
  });
});
