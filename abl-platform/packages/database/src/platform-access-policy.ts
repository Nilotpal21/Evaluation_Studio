import crypto from 'crypto';
import {
  PlatformAccessRequest,
  PlatformAdmin,
  PlatformAllowedDomain,
  PlatformAllowedEmail,
  User,
  WorkspaceInvitation,
} from './models/index.js';

export const DEFAULT_ALLOWED_DOMAINS = ['kore.ai', 'kore.com'] as const;

const DOMAIN_PATTERN = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PlatformAccessPolicy {
  defaultDomains: string[];
  customDomains: Array<{
    id: string;
    domain: string;
    addedByUserId: string;
    createdAt: Date;
  }>;
  allowedEmails: Array<{
    id: string;
    email: string;
    addedByUserId: string;
    createdAt: Date;
  }>;
  platformAdmins: Array<{
    id: string;
    email: string;
    userId: string | null;
    addedByUserId: string;
    createdAt: Date;
  }>;
  pendingAccessRequests: PlatformAccessRequestRecord[];
}

export interface PlatformAdminPrincipal {
  id: string;
  email?: string | null;
}

export interface PlatformAccessRequestRecord {
  id: string;
  email: string;
  domain: string;
  name: string | null;
  message: string | null;
  requestCount: number;
  lastRequestedAt: Date;
  createdAt: Date;
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, '');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAllowedDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(normalizeDomain(value));
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function getEmailDomain(email: string): string | null {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return null;
  }
  return normalized.slice(atIndex + 1);
}

function emailDomainMatches(domain: string, allowedDomain: string): boolean {
  return domain === allowedDomain;
}

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function listAllowedDomains(): Promise<{
  defaultDomains: string[];
  customDomains: PlatformAccessPolicy['customDomains'];
}> {
  const customDomains = await PlatformAllowedDomain.find({ status: 'active' })
    .sort({ domain: 1 })
    .limit(1000)
    .lean();

  return {
    defaultDomains: [...DEFAULT_ALLOWED_DOMAINS],
    customDomains: customDomains.map((domain) => ({
      id: domain._id,
      domain: domain.domain,
      addedByUserId: domain.addedByUserId,
      createdAt: domain.createdAt,
    })),
  };
}

export async function getAllowedDomainValues(): Promise<string[]> {
  const domains = await listAllowedDomains();
  return [...domains.defaultDomains, ...domains.customDomains.map((domain) => domain.domain)];
}

export async function listPlatformAdmins(): Promise<PlatformAccessPolicy['platformAdmins']> {
  const admins = await PlatformAdmin.find({ status: 'active' })
    .sort({ email: 1 })
    .limit(500)
    .lean();
  return admins.map((admin) => ({
    id: admin._id,
    email: admin.email,
    userId: admin.userId ?? null,
    addedByUserId: admin.addedByUserId,
    createdAt: admin.createdAt,
  }));
}

export async function listAccessPolicy(): Promise<PlatformAccessPolicy> {
  const [domains, emails, admins, pendingAccessRequests] = await Promise.all([
    listAllowedDomains(),
    listAllowedEmails(),
    listPlatformAdmins(),
    listPendingAccessRequests(),
  ]);

  return {
    ...domains,
    allowedEmails: emails,
    platformAdmins: admins,
    pendingAccessRequests,
  };
}

export async function isPlatformAdminUser(
  user: PlatformAdminPrincipal,
  options?: { isBootstrapSuperAdmin?: (userId: string) => boolean },
): Promise<boolean> {
  if (options?.isBootstrapSuperAdmin?.(user.id)) {
    return true;
  }

  const clauses: Array<Record<string, string>> = [{ userId: user.id }];
  if (user.email) {
    clauses.push({ email: normalizeEmail(user.email) });
  }

  const existing = await PlatformAdmin.findOne({
    status: 'active',
    $or: clauses,
  })
    .select('_id userId email')
    .lean();

  if (!existing) {
    return false;
  }

  if (!existing.userId && existing.email === normalizeEmail(user.email ?? '')) {
    await PlatformAdmin.updateOne({ _id: existing._id }, { $set: { userId: user.id } });
  }

  return true;
}

export async function isPlatformAdminEmail(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const existing = await PlatformAdmin.findOne({
    email: normalizedEmail,
    status: 'active',
  })
    .select('_id')
    .lean();
  return existing !== null;
}

export async function isBootstrapPlatformAdminEmail(
  email: string,
  bootstrapUserIds: readonly string[],
): Promise<boolean> {
  if (bootstrapUserIds.length === 0) {
    return false;
  }

  const user = await User.findOne({
    email: normalizeEmail(email),
    _id: { $in: [...bootstrapUserIds] },
  })
    .select('_id')
    .lean();
  return user !== null;
}

export async function isEmailAllowedForAuth(
  email: string,
  options?: { bootstrapUserIds?: readonly string[]; inviteToken?: string },
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const domain = getEmailDomain(normalizedEmail);
  if (!domain) {
    return false;
  }

  if (await isPlatformAdminEmail(normalizedEmail)) {
    return true;
  }

  if (await isBootstrapPlatformAdminEmail(normalizedEmail, options?.bootstrapUserIds ?? [])) {
    return true;
  }

  const allowedDomains = await getAllowedDomainValues();
  if (allowedDomains.some((allowedDomain) => emailDomainMatches(domain, allowedDomain))) {
    return true;
  }

  if (await isAllowlistedEmail(normalizedEmail)) {
    return true;
  }

  if (options?.inviteToken) {
    return hasValidInvitationForEmail(normalizedEmail, options.inviteToken);
  }

  return false;
}

export async function addAllowedDomain(domain: string, actorUserId: string): Promise<void> {
  const normalizedDomain = normalizeDomain(domain);
  if (!isValidAllowedDomain(normalizedDomain)) {
    throw new Error('Enter a valid domain, for example kore.ai.');
  }

  await PlatformAllowedDomain.findOneAndUpdate(
    { domain: normalizedDomain },
    {
      $set: {
        domain: normalizedDomain,
        status: 'active',
        addedByUserId: actorUserId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function recordPlatformAccessRequest(params: {
  email: string;
  name?: string;
  message?: string;
}): Promise<PlatformAccessRequestRecord> {
  const email = normalizeEmail(params.email);
  const domain = getEmailDomain(email);
  if (!domain || !isValidEmail(email)) {
    throw new Error('Enter a valid email address.');
  }

  const request = await PlatformAccessRequest.findOneAndUpdate(
    { email },
    {
      $set: {
        domain,
        name: params.name?.trim() || null,
        message: params.message?.trim() || null,
        status: 'pending',
        lastRequestedAt: new Date(),
        notifiedAt: null,
      },
      $setOnInsert: { email },
      $inc: { requestCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!request) {
    throw new Error('Unable to record platform access request.');
  }

  return {
    id: request._id,
    email: request.email,
    domain: request.domain,
    name: request.name ?? null,
    message: request.message ?? null,
    requestCount: request.requestCount,
    lastRequestedAt: request.lastRequestedAt,
    createdAt: request.createdAt,
  };
}

export async function listPendingAccessRequestsForDomain(
  domain: string,
): Promise<PlatformAccessRequestRecord[]> {
  const normalizedDomain = normalizeDomain(domain);
  const requests = await PlatformAccessRequest.find({
    domain: normalizedDomain,
    status: 'pending',
  })
    .sort({ lastRequestedAt: 1 })
    .lean();

  return requests.map((request) => ({
    id: request._id,
    email: request.email,
    domain: request.domain,
    name: request.name ?? null,
    message: request.message ?? null,
    requestCount: request.requestCount,
    lastRequestedAt: request.lastRequestedAt,
    createdAt: request.createdAt,
  }));
}

export async function listPendingAccessRequests(
  limit = 100,
): Promise<PlatformAccessRequestRecord[]> {
  const requests = await PlatformAccessRequest.find({ status: 'pending' })
    .sort({ lastRequestedAt: -1 })
    .limit(limit)
    .lean();

  return requests.map((request) => ({
    id: request._id,
    email: request.email,
    domain: request.domain,
    name: request.name ?? null,
    message: request.message ?? null,
    requestCount: request.requestCount,
    lastRequestedAt: request.lastRequestedAt,
    createdAt: request.createdAt,
  }));
}

export async function markAccessRequestsNotified(requestIds: string[]): Promise<number> {
  if (requestIds.length === 0) {
    return 0;
  }

  const result = await PlatformAccessRequest.updateMany(
    { _id: { $in: requestIds }, status: 'pending' },
    { $set: { status: 'notified', notifiedAt: new Date() } },
  );
  return result.modifiedCount;
}

export async function revokeAllowedDomain(domain: string): Promise<boolean> {
  const normalizedDomain = normalizeDomain(domain);
  if (
    DEFAULT_ALLOWED_DOMAINS.includes(normalizedDomain as (typeof DEFAULT_ALLOWED_DOMAINS)[number])
  ) {
    throw new Error('Default Kore domains cannot be removed.');
  }

  const result = await PlatformAllowedDomain.updateOne(
    { domain: normalizedDomain, status: 'active' },
    { $set: { status: 'revoked' } },
  );
  return result.modifiedCount > 0;
}

// ─── Allowed Email CRUD ──────────────────────────────────────────────────────

export async function listAllowedEmails(): Promise<PlatformAccessPolicy['allowedEmails']> {
  const emails = await PlatformAllowedEmail.find({ status: 'active' })
    .sort({ email: 1 })
    .limit(1000)
    .lean();
  return emails.map((e) => ({
    id: e._id,
    email: e.email,
    addedByUserId: e.addedByUserId,
    createdAt: e.createdAt,
  }));
}

export async function isAllowlistedEmail(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const existing = await PlatformAllowedEmail.findOne({
    email: normalized,
    status: 'active',
  })
    .select('_id')
    .lean();
  return existing !== null;
}

export async function addAllowedEmail(email: string, actorUserId: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Enter a valid email address.');
  }

  // Preserve the original `addedByUserId` when reactivating a revoked entry —
  // only set it on first insert.
  await PlatformAllowedEmail.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $set: {
        email: normalizedEmail,
        status: 'active',
      },
      $setOnInsert: {
        addedByUserId: actorUserId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Enter a valid email address.');
  }
  const result = await PlatformAllowedEmail.updateOne(
    { email: normalizedEmail, status: 'active' },
    { $set: { status: 'revoked' } },
  );
  return result.modifiedCount > 0;
}

// ─── Invitation bypass ───────────────────────────────────────────────────────

export async function hasValidInvitationForEmail(
  email: string,
  inviteToken: string,
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const hashedToken = hashInviteToken(inviteToken);
  const now = new Date();
  const invitation = await WorkspaceInvitation.findOne({
    token: hashedToken,
    email: normalizedEmail,
    status: 'pending',
    expiresAt: { $gt: now },
  })
    .select('_id')
    .lean();
  return invitation !== null;
}

// ─── Workspace creation eligibility ─────────────────────────────────────────

export async function canUserCreateWorkspace(
  email: string,
  options?: { bootstrapUserIds?: readonly string[] },
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const domain = getEmailDomain(normalizedEmail);
  if (!domain) return false;

  if (await isPlatformAdminEmail(normalizedEmail)) return true;
  if (await isBootstrapPlatformAdminEmail(normalizedEmail, options?.bootstrapUserIds ?? [])) {
    return true;
  }

  const allowedDomains = await getAllowedDomainValues();
  if (allowedDomains.some((d) => emailDomainMatches(domain, d))) return true;

  return isAllowlistedEmail(normalizedEmail);
}

export async function addPlatformAdmin(email: string, actorUserId: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Enter a valid email address.');
  }

  const existingUser = await User.findOne({ email: normalizedEmail }).select('_id').lean();
  await PlatformAdmin.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $set: {
        email: normalizedEmail,
        userId: existingUser?._id ?? null,
        status: 'active',
        addedByUserId: actorUserId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function revokePlatformAdmin(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Enter a valid email address.');
  }

  const result = await PlatformAdmin.updateOne(
    { email: normalizedEmail, status: 'active' },
    { $set: { status: 'revoked' } },
  );
  return result.modifiedCount > 0;
}

export async function listPlatformAdminEmails(options?: {
  bootstrapUserIds?: readonly string[];
}): Promise<string[]> {
  const [admins, bootstrapUsers] = await Promise.all([
    PlatformAdmin.find({ status: 'active' }).select('email').limit(500).lean(),
    options?.bootstrapUserIds?.length
      ? User.find({ _id: { $in: [...options.bootstrapUserIds] } })
          .select('email')
          .lean()
      : Promise.resolve([]),
  ]);

  return [
    ...new Set([
      ...admins.map((admin) => admin.email),
      ...bootstrapUsers.map((user) => user.email),
    ]),
  ].filter(Boolean);
}
