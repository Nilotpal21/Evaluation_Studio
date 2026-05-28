/**
 * Invitation Service
 *
 * Manages workspace invitation lifecycle: create, accept, revoke.
 */

import crypto from 'crypto';
import { createEmailService, workspaceInvitationEmail } from '@agent-platform/shared';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { hashToken } from '@/lib/token-hash';
import {
  findTenantMember,
  findInvitationByEmail,
  deleteInvitation,
  createInvitation as createInvitationRepo,
  updateInvitation,
  findInvitations,
  findInvitationByTokenWithRelations,
  findInvitationById,
  createTenantMember,
  findTenantById,
} from '@/repos/workspace-repo';
import { findUserByEmail, findUserById, updateUserLastActiveTenantId } from '@/repos/auth-repo';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { getFrontendUrl } from '@/lib/auth-helpers';

const INVITE_EXPIRY_DAYS = 7;
const VALID_INVITE_ROLES = ['MEMBER', 'VIEWER', 'OPERATOR'];
const ADMIN_CAN_INVITE = ['MEMBER', 'VIEWER', 'OPERATOR', 'ADMIN'];
const EXISTING_MEMBER_STATUSES = ['active', 'suspended', 'deactivated'];
const log = createLogger('invitation-service');

async function persistLastActiveTenant(userId: string, tenantId: string): Promise<void> {
  try {
    await updateUserLastActiveTenantId(userId, tenantId);
  } catch (error) {
    log.warn('Failed to persist last active workspace after invitation acceptance', {
      userId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createInvitation(params: {
  tenantId: string;
  email: string;
  role: string;
  invitedBy: string;
}): Promise<{
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
}> {
  const normalizedEmail = params.email.toLowerCase().trim();

  // Validate the role being assigned (only OWNER can invite ADMIN+, ADMIN can invite MEMBER/VIEWER/OPERATOR)
  const inviterMembership = await findTenantMember(params.tenantId, params.invitedBy);
  if (!inviterMembership) {
    throw new AppError('Inviter is not a member of this workspace', { ...ErrorCodes.FORBIDDEN });
  }

  // Role hierarchy check: prevent privilege escalation
  if (inviterMembership.role === 'OWNER') {
    // OWNER can invite any role
  } else if (inviterMembership.role === 'ADMIN') {
    if (!ADMIN_CAN_INVITE.includes(params.role)) {
      throw new AppError('Admins cannot invite users with OWNER role', { ...ErrorCodes.FORBIDDEN });
    }
  } else {
    throw new AppError('Only workspace owners and admins can send invitations', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  if (
    !VALID_INVITE_ROLES.includes(params.role) &&
    params.role !== 'ADMIN' &&
    params.role !== 'OWNER'
  ) {
    throw new AppError('Invalid role', { ...ErrorCodes.BAD_REQUEST });
  }

  // Prevent self-invite
  const inviterUser = await findUserById(params.invitedBy);
  if (inviterUser && inviterUser.email?.toLowerCase().trim() === normalizedEmail) {
    throw new AppError('You cannot invite yourself', { ...ErrorCodes.BAD_REQUEST });
  }

  // Check if user is already a member
  const existingUser = await findUserByEmail(normalizedEmail);
  if (existingUser) {
    const existingMembership = await findTenantMember(params.tenantId, existingUser.id, {
      memberStatuses: EXISTING_MEMBER_STATUSES,
    });
    if (existingMembership) {
      throw new AppError('User is already a member of this workspace', {
        ...ErrorCodes.BAD_REQUEST,
      });
    }
  }

  // Check for existing pending invitation
  const existingInvite = await findInvitationByEmail(params.tenantId, normalizedEmail);

  if (
    existingInvite &&
    existingInvite.status === 'pending' &&
    existingInvite.expiresAt > new Date()
  ) {
    throw new AppError('An invitation has already been sent to this email', {
      ...ErrorCodes.BAD_REQUEST,
    });
  }

  // If there's an expired/revoked/accepted invitation, delete it so we can create a new one
  if (existingInvite) {
    await deleteInvitation(existingInvite.id, params.tenantId);
  }

  const token = crypto.randomBytes(64).toString('hex');
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const created = await createInvitationRepo({
    tenantId: params.tenantId,
    email: normalizedEmail,
    role: params.role,
    invitedBy: params.invitedBy,
    token: hashedToken,
    expiresAt,
  });

  // Send invitation email (inviterUser already fetched above for self-invite check)
  const tenant = await findTenantById(params.tenantId);

  if (tenant) {
    const frontendUrl = getFrontendUrl();
    const acceptUrl = `${frontendUrl}/invite/${token}`;

    const emailContent = workspaceInvitationEmail({
      inviterName: inviterUser?.name || inviterUser?.email || 'A team member',
      workspaceName: tenant.name,
      role: params.role,
      acceptUrl,
    });

    const emailService = createEmailService();
    await emailService.sendEmail(normalizedEmail, emailContent.subject, emailContent.html);
  }

  return {
    id: created.id,
    email: created.email,
    role: created.role,
    status: created.status,
    expiresAt: created.expiresAt,
  };
}

export async function acceptInvitation(
  token: string,
  userId: string,
  userEmail: string,
): Promise<{
  tenantId: string;
  role: string;
  membershipCreated: boolean;
}> {
  const normalizedUserEmail = userEmail.toLowerCase().trim();
  const hashedToken = hashToken(token);

  const invitation = await findInvitationByTokenWithRelations(hashedToken);

  if (!invitation) {
    throw new AppError('Invalid invitation', { ...ErrorCodes.NOT_FOUND });
  }

  if (invitation.status !== 'pending') {
    throw new AppError('This invitation has already been used', { ...ErrorCodes.BAD_REQUEST });
  }

  if (invitation.expiresAt < new Date()) {
    throw new AppError('This invitation has expired', { ...ErrorCodes.BAD_REQUEST });
  }

  // Verify the accepting user's email matches the invitation email
  if (invitation.email !== normalizedUserEmail) {
    throw new AppError('This invitation was sent to a different email address', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  // Check if already a member
  const existingMembership = await findTenantMember(invitation.tenantId, userId, {
    memberStatuses: EXISTING_MEMBER_STATUSES,
  });

  if (existingMembership) {
    // Mark invitation as accepted even though user was already a member
    await updateInvitation(invitation.id, invitation.tenantId, {
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: userId,
    });
    await persistLastActiveTenant(userId, invitation.tenantId);
    return {
      tenantId: invitation.tenantId,
      role: existingMembership.role,
      membershipCreated: false,
    };
  }

  // Create membership and update invitation separately (not in transaction since repos abstract that)
  try {
    await createTenantMember({
      tenantId: invitation.tenantId,
      userId,
      role: invitation.role,
    });

    await updateInvitation(invitation.id, invitation.tenantId, {
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: userId,
    });
  } catch (error) {
    // If member creation fails after invitation update, we have a partial state
    // In a real system, this should use a transaction or compensating action
    throw error;
  }

  await persistLastActiveTenant(userId, invitation.tenantId);
  return { tenantId: invitation.tenantId, role: invitation.role, membershipCreated: true };
}

/**
 * Accept an invitation by its database ID (for auto-accept during SSO).
 * Unlike acceptInvitation() which takes a raw token, this takes the
 * invitation ID directly — used when we find invitations by email
 * and don't have the raw token.
 */
export async function acceptInvitationById(
  invitationId: string,
  userId: string,
  userEmail: string,
): Promise<{
  tenantId: string;
  role: string;
  membershipCreated: boolean;
}> {
  const normalizedUserEmail = userEmail.toLowerCase().trim();

  const invitation = await findInvitationById(invitationId);

  if (!invitation) {
    throw new AppError('Invalid invitation', { ...ErrorCodes.NOT_FOUND });
  }

  if (invitation.status !== 'pending') {
    throw new AppError('This invitation has already been used', { ...ErrorCodes.BAD_REQUEST });
  }

  if (invitation.expiresAt < new Date()) {
    throw new AppError('This invitation has expired', { ...ErrorCodes.BAD_REQUEST });
  }

  // Verify the accepting user's email matches the invitation email
  if (invitation.email !== normalizedUserEmail) {
    throw new AppError('This invitation was sent to a different email address', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  // Check if already a member
  const existingMembership = await findTenantMember(String(invitation.tenantId), userId, {
    memberStatuses: EXISTING_MEMBER_STATUSES,
  });

  if (existingMembership) {
    await updateInvitation(String(invitation.id), String(invitation.tenantId), {
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: userId,
    });
    await persistLastActiveTenant(userId, String(invitation.tenantId));
    return {
      tenantId: String(invitation.tenantId),
      role: existingMembership.role,
      membershipCreated: false,
    };
  }

  await createTenantMember({
    tenantId: String(invitation.tenantId),
    userId,
    role: invitation.role,
  });

  await updateInvitation(String(invitation.id), String(invitation.tenantId), {
    status: 'accepted',
    acceptedAt: new Date(),
    acceptedBy: userId,
  });

  await persistLastActiveTenant(userId, String(invitation.tenantId));
  return { tenantId: String(invitation.tenantId), role: invitation.role, membershipCreated: true };
}

export async function revokeInvitation(invitationId: string, tenantId: string): Promise<void> {
  await updateInvitation(invitationId, tenantId, {
    status: 'revoked',
  });
}

export async function listInvitations(tenantId: string): Promise<
  Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    invitedBy: string | null;
    inviterName: string | null;
    expiresAt: Date;
    createdAt: Date;
  }>
> {
  const invitations = await findInvitations(tenantId, { includeInviter: true });

  return invitations.map((inv: any) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    invitedBy: inv.invitedBy,
    inviterName: inv.inviter?.name || inv.inviter?.email || null,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  }));
}

export async function getInvitationByToken(token: string): Promise<{
  id: string;
  email: string;
  role: string;
  status: string;
  workspaceName: string;
  inviterName: string | null;
  expiresAt: Date;
} | null> {
  const hashedToken = hashToken(token);

  const invitation = await findInvitationByTokenWithRelations(hashedToken);

  if (!invitation) return null;

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    workspaceName: invitation.tenant?.name || 'Unknown Workspace',
    inviterName: invitation.inviter?.name || invitation.inviter?.email || null,
    expiresAt: invitation.expiresAt,
  };
}
