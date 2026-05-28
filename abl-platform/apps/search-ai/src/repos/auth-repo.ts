/**
 * Auth Repository (Search Engine)
 *
 * MongoDB user, tenant membership resolution.
 * Used by: middleware/auth.ts
 *
 * Models are resolved via getLazyModel() so they use the dual-connection's
 * platform connection instead of the default mongoose connection (which is
 * suppressed when MONGODB_MANAGED=true in deployed environments).
 */

import type { IUser, ITenantMember, ITenant } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';

const User = getLazyModel<IUser>('User');
const TenantMember = getLazyModel<ITenantMember>('TenantMember');
const Tenant = getLazyModel<ITenant>('Tenant');

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string | null;
}

export interface TenantMembershipRecord {
  role: string;
  customRoleId: string | null;
  orgId?: string;
}

export async function findUserById(id: string): Promise<AuthUserRecord | null> {
  const doc = await User.findOne({ _id: id }, { email: 1, name: 1 }).lean();
  return doc ? { id: doc._id as string, email: doc.email, name: doc.name } : null;
}

export async function resolveTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantMembershipRecord | null> {
  const m = await TenantMember.findOne({ tenantId, userId }).lean();
  if (!m) return null;
  const tenant = await Tenant.findOne({ _id: tenantId }, { organizationId: 1 }).lean();
  return {
    role: m.role,
    customRoleId: m.customRoleId,
    orgId: (tenant as any)?.organizationId ?? undefined,
  };
}

export async function resolveDefaultTenant(
  userId: string,
): Promise<(TenantMembershipRecord & { tenantId: string }) | null> {
  const m = await TenantMember.findOne({ userId }).sort({ createdAt: 1 }).lean();
  if (!m) return null;
  const tenant = await Tenant.findOne({ _id: m.tenantId }, { organizationId: 1 }).lean();
  return {
    tenantId: m.tenantId,
    role: m.role,
    customRoleId: m.customRoleId,
    orgId: (tenant as any)?.organizationId ?? undefined,
  };
}
