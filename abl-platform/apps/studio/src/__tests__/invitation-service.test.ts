/**
 * Invitation Service Tests
 *
 * Tests for workspace invitation lifecycle: create, accept, revoke, list, lookup.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock repos
const mockFindTenantMember = vi.fn();
const mockFindInvitationByEmail = vi.fn();
const mockDeleteInvitation = vi.fn();
const mockCreateInvitationRepo = vi.fn();
const mockUpdateInvitation = vi.fn();
const mockFindInvitations = vi.fn();
const mockFindInvitationByTokenWithRelations = vi.fn();
const mockFindInvitationById = vi.fn();
const mockCreateTenantMember = vi.fn();
const mockFindTenantById = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: (...args: any[]) => mockFindTenantMember(...args),
  findInvitationByEmail: (...args: any[]) => mockFindInvitationByEmail(...args),
  deleteInvitation: (...args: any[]) => mockDeleteInvitation(...args),
  createInvitation: (...args: any[]) => mockCreateInvitationRepo(...args),
  updateInvitation: (...args: any[]) => mockUpdateInvitation(...args),
  findInvitations: (...args: any[]) => mockFindInvitations(...args),
  findInvitationByTokenWithRelations: (...args: any[]) =>
    mockFindInvitationByTokenWithRelations(...args),
  findInvitationById: (...args: any[]) => mockFindInvitationById(...args),
  createTenantMember: (...args: any[]) => mockCreateTenantMember(...args),
  findTenantById: (...args: any[]) => mockFindTenantById(...args),
}));

const mockFindUserByEmail = vi.fn();
const mockFindUserById = vi.fn();
const mockUpdateUserLastActiveTenantId = vi.fn();

vi.mock('@/repos/auth-repo', () => ({
  findUserByEmail: (...args: any[]) => mockFindUserByEmail(...args),
  findUserById: (...args: any[]) => mockFindUserById(...args),
  updateUserLastActiveTenantId: (...args: any[]) => mockUpdateUserLastActiveTenantId(...args),
}));

const mockSendEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('@agent-platform/shared', () => ({
  createEmailService: () => ({ sendEmail: mockSendEmail }),
  workspaceInvitationEmail: vi.fn(() => ({
    subject: 'Invitation',
    html: '<p>Invite</p>',
  })),
}));

vi.mock('@/lib/token-hash', () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getFrontendUrl: () => 'http://localhost:5173',
}));

// Import after mocks
import {
  createInvitation,
  acceptInvitation,
  acceptInvitationById,
  revokeInvitation,
  listInvitations,
  getInvitationByToken,
} from '../services/invitation-service';
import { AppError } from '@agent-platform/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-001';
const INVITER_ID = 'user-owner-001';
const INVITEE_EMAIL = 'newuser@example.com';

function ownerMembership() {
  return { role: 'OWNER', userId: INVITER_ID, tenantId: TENANT_ID };
}

function adminMembership() {
  return { role: 'ADMIN', userId: 'user-admin', tenantId: TENANT_ID };
}

function viewerMembership() {
  return { role: 'VIEWER', userId: 'user-viewer', tenantId: TENANT_ID };
}

function pendingInvitation(overrides: Record<string, any> = {}) {
  return {
    id: 'inv-001',
    tenantId: TENANT_ID,
    email: INVITEE_EMAIL,
    role: 'MEMBER',
    status: 'pending',
    token: 'hashed_sometoken',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    invitedBy: INVITER_ID,
    tenant: { name: 'Dev Workspace' },
    inviter: { name: 'Owner User', email: 'owner@example.com' },
    ...overrides,
  };
}

async function expectRejectedMessage(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(message),
  });
}

// ---------------------------------------------------------------------------
// createInvitation
// ---------------------------------------------------------------------------

describe('createInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates invitation successfully for OWNER inviter', async () => {
    mockFindTenantMember.mockResolvedValue(ownerMembership());
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });
    mockFindUserByEmail.mockResolvedValue(null);
    mockFindInvitationByEmail.mockResolvedValue(null);
    mockCreateInvitationRepo.mockResolvedValue({
      id: 'inv-new',
      email: INVITEE_EMAIL,
      role: 'MEMBER',
      status: 'pending',
      expiresAt: new Date(),
    });
    mockFindTenantById.mockResolvedValue({ name: 'Dev Workspace' });

    const result = await createInvitation({
      tenantId: TENANT_ID,
      email: INVITEE_EMAIL,
      role: 'MEMBER',
      invitedBy: INVITER_ID,
    });

    expect(result.email).toBe(INVITEE_EMAIL);
    expect(result.role).toBe('MEMBER');
    expect(result.status).toBe('pending');
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockCreateInvitationRepo).toHaveBeenCalledOnce();
  });

  test('prevents self-invite', async () => {
    mockFindTenantMember.mockResolvedValue(ownerMembership());
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: 'Owner@Example.com', // case-insensitive match
        role: 'MEMBER',
        invitedBy: INVITER_ID,
      }),
      'You cannot invite yourself',
    );
  });

  test('prevents inviting existing member', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce(ownerMembership()) // inviter check
      .mockResolvedValueOnce({ role: 'MEMBER' }); // existing member check
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });
    mockFindUserByEmail.mockResolvedValue({ id: 'existing-user' });

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: INVITEE_EMAIL,
        role: 'MEMBER',
        invitedBy: INVITER_ID,
      }),
      'already a member',
    );
  });

  test('prevents duplicate pending invitation', async () => {
    mockFindTenantMember.mockResolvedValue(ownerMembership());
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });
    mockFindUserByEmail.mockResolvedValue(null);
    mockFindInvitationByEmail.mockResolvedValue(
      pendingInvitation({ status: 'pending', expiresAt: new Date(Date.now() + 86400000) }),
    );

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: INVITEE_EMAIL,
        role: 'MEMBER',
        invitedBy: INVITER_ID,
      }),
      'already been sent',
    );
  });

  test('VIEWER cannot create invitations', async () => {
    mockFindTenantMember.mockResolvedValue(viewerMembership());

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: INVITEE_EMAIL,
        role: 'MEMBER',
        invitedBy: 'user-viewer',
      }),
      'Only workspace owners and admins',
    );
  });

  test('ADMIN cannot invite OWNER role', async () => {
    mockFindTenantMember.mockResolvedValue(adminMembership());

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: INVITEE_EMAIL,
        role: 'OWNER',
        invitedBy: 'user-admin',
      }),
      'Admins cannot invite users with OWNER role',
    );
  });

  test('inviter not a member throws FORBIDDEN', async () => {
    mockFindTenantMember.mockResolvedValue(null);

    await expectRejectedMessage(
      createInvitation({
        tenantId: TENANT_ID,
        email: INVITEE_EMAIL,
        role: 'MEMBER',
        invitedBy: 'unknown-user',
      }),
      'not a member',
    );
  });

  test('deletes expired invitation before creating new one', async () => {
    mockFindTenantMember.mockResolvedValue(ownerMembership());
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });
    mockFindUserByEmail.mockResolvedValue(null);
    // Return an expired invitation
    mockFindInvitationByEmail.mockResolvedValue(
      pendingInvitation({
        status: 'pending',
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
      }),
    );
    mockCreateInvitationRepo.mockResolvedValue({
      id: 'inv-new',
      email: INVITEE_EMAIL,
      role: 'MEMBER',
      status: 'pending',
      expiresAt: new Date(),
    });
    mockFindTenantById.mockResolvedValue({ name: 'Dev Workspace' });

    await createInvitation({
      tenantId: TENANT_ID,
      email: INVITEE_EMAIL,
      role: 'MEMBER',
      invitedBy: INVITER_ID,
    });

    expect(mockDeleteInvitation).toHaveBeenCalledWith('inv-001', TENANT_ID);
    expect(mockCreateInvitationRepo).toHaveBeenCalledOnce();
  });

  test('normalizes email to lowercase', async () => {
    mockFindTenantMember.mockResolvedValue(ownerMembership());
    mockFindUserById.mockResolvedValue({ id: INVITER_ID, email: 'owner@example.com' });
    mockFindUserByEmail.mockResolvedValue(null);
    mockFindInvitationByEmail.mockResolvedValue(null);
    mockCreateInvitationRepo.mockResolvedValue({
      id: 'inv-new',
      email: 'newuser@example.com',
      role: 'MEMBER',
      status: 'pending',
      expiresAt: new Date(),
    });
    mockFindTenantById.mockResolvedValue({ name: 'Dev Workspace' });

    await createInvitation({
      tenantId: TENANT_ID,
      email: '  NewUser@Example.COM  ',
      role: 'MEMBER',
      invitedBy: INVITER_ID,
    });

    // The repo should receive the normalized email
    expect(mockCreateInvitationRepo).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'newuser@example.com' }),
    );
  });
});

// ---------------------------------------------------------------------------
// acceptInvitation
// ---------------------------------------------------------------------------

describe('acceptInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('accepts valid invitation and creates membership', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(pendingInvitation());
    mockFindTenantMember.mockResolvedValue(null); // not yet a member
    mockCreateTenantMember.mockResolvedValue({});
    mockUpdateInvitation.mockResolvedValue({});

    const result = await acceptInvitation('sometoken', 'user-new', INVITEE_EMAIL);

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.role).toBe('MEMBER');
    expect(result.membershipCreated).toBe(true);
    expect(mockCreateTenantMember).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: 'user-new',
      role: 'MEMBER',
    });
    expect(mockUpdateInvitation).toHaveBeenCalledWith(
      'inv-001',
      TENANT_ID,
      expect.objectContaining({ status: 'accepted' }),
    );
    expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-new', TENANT_ID);
  });

  test('rejects invalid token', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(null);

    await expectRejectedMessage(
      acceptInvitation('bogus', 'user-new', INVITEE_EMAIL),
      'Invalid invitation',
    );
  });

  test('rejects already-accepted invitation', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(
      pendingInvitation({ status: 'accepted' }),
    );

    await expectRejectedMessage(
      acceptInvitation('sometoken', 'user-new', INVITEE_EMAIL),
      'already been used',
    );
  });

  test('rejects expired invitation', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(
      pendingInvitation({ expiresAt: new Date(Date.now() - 86400000) }),
    );

    await expectRejectedMessage(
      acceptInvitation('sometoken', 'user-new', INVITEE_EMAIL),
      'expired',
    );
  });

  test('rejects wrong email', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(pendingInvitation());

    await expectRejectedMessage(
      acceptInvitation('sometoken', 'user-new', 'wrong@example.com'),
      'different email address',
    );
  });

  test('handles already-a-member gracefully', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(pendingInvitation());
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockUpdateInvitation.mockResolvedValue({});

    const result = await acceptInvitation('sometoken', 'user-new', INVITEE_EMAIL);

    // Should return existing role, not invitation role
    expect(result.role).toBe('ADMIN');
    expect(result.membershipCreated).toBe(false);
    // Should NOT create a new membership
    expect(mockCreateTenantMember).not.toHaveBeenCalled();
    // Should still mark invitation as accepted
    expect(mockUpdateInvitation).toHaveBeenCalled();
    expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-new', TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// acceptInvitationById
// ---------------------------------------------------------------------------

describe('acceptInvitationById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('accepts valid invitation by ID', async () => {
    mockFindInvitationById.mockResolvedValue(pendingInvitation());
    mockFindTenantMember.mockResolvedValue(null);
    mockCreateTenantMember.mockResolvedValue({});
    mockUpdateInvitation.mockResolvedValue({});

    const result = await acceptInvitationById('inv-001', 'user-new', INVITEE_EMAIL);

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.role).toBe('MEMBER');
    expect(result.membershipCreated).toBe(true);
    expect(mockUpdateUserLastActiveTenantId).toHaveBeenCalledWith('user-new', TENANT_ID);
  });

  test('rejects invalid invitation ID', async () => {
    mockFindInvitationById.mockResolvedValue(null);

    await expectRejectedMessage(
      acceptInvitationById('bogus-id', 'user-new', INVITEE_EMAIL),
      'Invalid invitation',
    );
  });

  test('rejects expired invitation', async () => {
    mockFindInvitationById.mockResolvedValue(
      pendingInvitation({ expiresAt: new Date(Date.now() - 86400000) }),
    );

    await expectRejectedMessage(
      acceptInvitationById('inv-001', 'user-new', INVITEE_EMAIL),
      'expired',
    );
  });

  test('rejects wrong email', async () => {
    mockFindInvitationById.mockResolvedValue(pendingInvitation());

    await expectRejectedMessage(
      acceptInvitationById('inv-001', 'user-new', 'wrong@example.com'),
      'different email address',
    );
  });
});

// ---------------------------------------------------------------------------
// revokeInvitation
// ---------------------------------------------------------------------------

describe('revokeInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('updates invitation status to revoked', async () => {
    mockUpdateInvitation.mockResolvedValue({});

    await revokeInvitation('inv-001', TENANT_ID);

    expect(mockUpdateInvitation).toHaveBeenCalledWith('inv-001', TENANT_ID, { status: 'revoked' });
  });
});

// ---------------------------------------------------------------------------
// listInvitations
// ---------------------------------------------------------------------------

describe('listInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns mapped invitation list with inviter names', async () => {
    mockFindInvitations.mockResolvedValue([
      pendingInvitation(),
      pendingInvitation({
        id: 'inv-002',
        email: 'other@example.com',
        status: 'accepted',
        inviter: null,
      }),
    ]);

    const result = await listInvitations(TENANT_ID);

    expect(result).toHaveLength(2);
    expect(result[0].inviterName).toBe('Owner User');
    expect(result[1].inviterName).toBeNull();
    expect(mockFindInvitations).toHaveBeenCalledWith(TENANT_ID, { includeInviter: true });
  });
});

// ---------------------------------------------------------------------------
// getInvitationByToken
// ---------------------------------------------------------------------------

describe('getInvitationByToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns invitation details with workspace name', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(pendingInvitation());

    const result = await getInvitationByToken('raw-token');

    expect(result).not.toBeNull();
    expect(result!.workspaceName).toBe('Dev Workspace');
    expect(result!.inviterName).toBe('Owner User');
    // Token should be hashed before lookup
    expect(mockFindInvitationByTokenWithRelations).toHaveBeenCalledWith('hashed_raw-token');
  });

  test('returns null for nonexistent token', async () => {
    mockFindInvitationByTokenWithRelations.mockResolvedValue(null);

    const result = await getInvitationByToken('nonexistent');
    expect(result).toBeNull();
  });
});
