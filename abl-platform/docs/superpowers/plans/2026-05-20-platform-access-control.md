# Platform Access Control — Invitation Bypass & Email Allowlisting Implementation Plan

> **Status:** COMPLETE — all 10 tasks implemented 2026-05-21. See post-impl-sync log.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let invited users sign up/login on non-allowlisted domains while restricting them from creating workspaces; let admins allowlist individual email addresses for full platform access.

**Architecture:** New `PlatformAllowedEmail` MongoDB model mirrors `PlatformAllowedDomain`. `isEmailAllowedForAuth` gains an optional `inviteToken` parameter for bypass. A new `canCreateWorkspace` JWT claim gates workspace creation — computed at login time, absent = `true` (backward compat).

**Tech Stack:** TypeScript, Mongoose/MongoDB, Next.js App Router, Zod, Zustand, Vitest

**Spec:** `docs/superpowers/specs/2026-05-20-platform-access-control-design.md`

---

## File Map

| Status | File                                                                   | Change                                                    |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| CREATE | `packages/database/src/models/platform-allowed-email.model.ts`         | New Mongoose model                                        |
| MODIFY | `packages/database/src/models/index.ts`                                | Export new model                                          |
| MODIFY | `packages/database/src/platform-access-policy.ts`                      | Email functions + invite check + `canUserCreateWorkspace` |
| CREATE | `packages/database/src/__tests__/platform-access-policy-email.test.ts` | Integration tests                                         |
| MODIFY | `apps/studio/src/lib/platform-auth-policy.ts`                          | Expose new DB functions                                   |
| MODIFY | `apps/studio/src/services/auth-service.ts`                             | `canCreateWorkspace` JWT claim                            |
| MODIFY | `apps/studio/src/lib/auth.ts`                                          | `canCreateWorkspace` on `AuthenticatedUser`               |
| MODIFY | `apps/studio/src/app/api/auth/me/route.ts`                             | Return `canCreateWorkspace`                               |
| MODIFY | `apps/studio/src/api/auth.ts`                                          | `fetchCurrentUser` includes `canCreateWorkspace`          |
| MODIFY | `apps/studio/src/store/auth-store.ts`                                  | `User.canCreateWorkspace`, decode from JWT                |
| MODIFY | `apps/studio/src/app/api/auth/signup/route.ts`                         | Accept + thread `inviteToken`                             |
| MODIFY | `apps/studio/src/app/api/auth/login/route.ts`                          | Accept + thread `inviteToken`                             |
| MODIFY | `apps/studio/src/app/api/auth/resolve-account/route.ts`                | Accept + thread `inviteToken`                             |
| MODIFY | `apps/studio/src/app/api/auth/callback/route.ts`                       | Read `oauth_invite` before domain check                   |
| MODIFY | `apps/studio/src/app/api/auth/microsoft/callback/route.ts`             | Same                                                      |
| MODIFY | `apps/studio/src/app/api/auth/linkedin/callback/route.ts`              | Same                                                      |
| MODIFY | `apps/studio/src/app/api/auth/create-workspace/route.ts`               | Gate on `canCreateWorkspace`                              |
| MODIFY | `apps/studio/src/app/auth/signup/page.tsx`                             | Pass `inviteToken` in body                                |
| MODIFY | `apps/studio/src/app/auth/login/page.tsx`                              | Pass `inviteToken` in body                                |
| MODIFY | `apps/studio/src/components/auth/UserMenu.tsx`                         | Gate create-workspace button                              |
| MODIFY | `apps/studio/src/app/onboarding/page.tsx`                              | Gate / show restricted message                            |
| MODIFY | `apps/studio/src/app/invitations/choose/page.tsx`                      | Gate create-workspace link                                |
| MODIFY | `apps/admin/src/lib/platform-access-policy.ts`                         | Export email CRUD functions                               |
| CREATE | `apps/admin/src/app/api/access/emails/route.ts`                        | GET/POST/DELETE allowed emails                            |
| MODIFY | `apps/admin/src/app/(dashboard)/access/page.tsx`                       | Allowed Emails panel                                      |

---

## Task 1: `PlatformAllowedEmail` Mongoose Model

**Files:**

- Create: `packages/database/src/models/platform-allowed-email.model.ts`
- Modify: `packages/database/src/models/index.ts`

- [x] **Step 1: Create the model file**

```typescript
// packages/database/src/models/platform-allowed-email.model.ts
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

export type PlatformAllowedEmailStatus = 'active' | 'revoked';

export interface IPlatformAllowedEmail {
  _id: string;
  email: string;
  status: PlatformAllowedEmailStatus;
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformAllowedEmailSchema = new Schema<IPlatformAllowedEmail>(
  {
    _id: { type: String, default: uuidv7 },
    email: { type: String, required: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
    addedByUserId: { type: String, required: true },
  },
  { timestamps: true, collection: 'platform_allowed_emails' },
);

PlatformAllowedEmailSchema.plugin(auditTrailPlugin);
PlatformAllowedEmailSchema.index({ email: 1 }, { unique: true });
PlatformAllowedEmailSchema.index({ status: 1, email: 1 });

export const PlatformAllowedEmail =
  (mongoose.models.PlatformAllowedEmail as mongoose.Model<IPlatformAllowedEmail>) ||
  model<IPlatformAllowedEmail>('PlatformAllowedEmail', PlatformAllowedEmailSchema);
```

- [x] **Step 2: Export from models index**

In `packages/database/src/models/index.ts`, add alongside the `PlatformAllowedDomain` export:

```typescript
export {
  PlatformAllowedEmail,
  type IPlatformAllowedEmail,
  type PlatformAllowedEmailStatus,
} from './platform-allowed-email.model.js';
```

- [x] **Step 3: Build and verify**

```bash
cd /Users/Pattabhi.Dasari/abl-platform/.worktrees/ABLP-1145-platform-access-requests-fix
npx turbo build --filter=@agent-platform/database
```

Expected: build succeeds with no TypeScript errors.

- [x] **Step 4: Commit**

```bash
git add packages/database/src/models/platform-allowed-email.model.ts \
        packages/database/src/models/index.ts
git commit -m "[ABLP-1145] feat(db): add PlatformAllowedEmail model"
```

---

## Task 2: DB Access Policy — Email Functions + Invitation Bypass

**Files:**

- Modify: `packages/database/src/platform-access-policy.ts`
- Create: `packages/database/src/__tests__/platform-access-policy-email.test.ts`

- [x] **Step 1: Write failing tests first**

Create `packages/database/src/__tests__/platform-access-policy-email.test.ts`:

```typescript
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
```

- [x] **Step 2: Run failing tests to confirm they fail**

```bash
cd /Users/Pattabhi.Dasari/abl-platform/.worktrees/ABLP-1145-platform-access-requests-fix
pnpm test --filter=@agent-platform/database -- --reporter=verbose \
  packages/database/src/__tests__/platform-access-policy-email.test.ts 2>&1 | tail -30
```

Expected: Tests fail with "addAllowedEmail is not a function" or similar import errors.

- [x] **Step 3: Implement the new functions in `platform-access-policy.ts`**

Add imports at the top of `packages/database/src/platform-access-policy.ts`:

```typescript
import crypto from 'crypto';
import {
  PlatformAccessRequest,
  PlatformAdmin,
  PlatformAllowedDomain,
  PlatformAllowedEmail,
  User,
  WorkspaceInvitation,
} from './models/index.js';
```

Add the `AllowedEmailRecord` type to the `PlatformAccessPolicy` interface:

```typescript
export interface PlatformAccessPolicy {
  defaultDomains: string[];
  customDomains: Array<{
    id: string;
    domain: string;
    addedByUserId: string;
    createdAt: Date;
  }>;
  allowedEmails: Array<{
    // NEW
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
```

Add all new functions after the existing `revokeAllowedDomain` function:

```typescript
// ─── Internal helper ────────────────────────────────────────────────────────

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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

  await PlatformAllowedEmail.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $set: {
        email: normalizedEmail,
        status: 'active',
        addedByUserId: actorUserId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
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
```

Update `isEmailAllowedForAuth` to accept `inviteToken` and check email allowlist:

```typescript
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
```

Update `listAccessPolicy` to include `allowedEmails`:

```typescript
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
```

- [x] **Step 4: Build the database package**

```bash
npx turbo build --filter=@agent-platform/database
```

Expected: build succeeds.

- [x] **Step 5: Run tests and verify they pass**

```bash
pnpm test --filter=@agent-platform/database -- --reporter=verbose \
  packages/database/src/__tests__/platform-access-policy-email.test.ts 2>&1 | tail -40
```

Expected: All tests pass. If any fail, read the error and fix the implementation before continuing.

- [x] **Step 6: Commit**

```bash
npx prettier --write packages/database/src/platform-access-policy.ts \
  packages/database/src/__tests__/platform-access-policy-email.test.ts
git add packages/database/src/platform-access-policy.ts \
        packages/database/src/__tests__/platform-access-policy-email.test.ts
git commit -m "[ABLP-1145] feat(db): add email allowlisting + invitation bypass to access policy"
```

---

## Task 3: Studio `platform-auth-policy.ts` Wrapper

**Files:**

- Modify: `apps/studio/src/lib/platform-auth-policy.ts`

- [x] **Step 1: Update imports in `platform-auth-policy.ts`**

Replace the existing import block at the top of `apps/studio/src/lib/platform-auth-policy.ts`:

```typescript
import {
  addAllowedDomain as addAllowedDomainShared,
  addAllowedEmail as addAllowedEmailShared,
  addPlatformAdmin as addPlatformAdminShared,
  canUserCreateWorkspace as canUserCreateWorkspaceShared,
  DEFAULT_ALLOWED_DOMAINS,
  getEmailDomain,
  isEmailAllowedForAuth as isEmailAllowedForAuthShared,
  isPlatformAdminUser as isPlatformAdminUserShared,
  listAccessPolicy as listAccessPolicyShared,
  listAllowedDomains as listAllowedDomainsShared,
  listAllowedEmails as listAllowedEmailsShared,
  listPlatformAdminEmails,
  listPlatformAdmins as listPlatformAdminsShared,
  normalizeDomain,
  normalizeEmail,
  recordPlatformAccessRequest,
  revokeAllowedDomain,
  revokeAllowedEmail as revokeAllowedEmailShared,
  revokePlatformAdmin as revokePlatformAdminShared,
} from '@agent-platform/database/platform-access-policy';
import type { PlatformAdminPrincipal } from '@agent-platform/database/platform-access-policy';
```

- [x] **Step 2: Update `isEmailAllowedForAuth` wrapper to accept `inviteToken`**

Replace the existing `isEmailAllowedForAuth` export:

```typescript
export async function isEmailAllowedForAuth(
  email: string,
  opts?: { inviteToken?: string },
): Promise<boolean> {
  await ensureDb();
  return isEmailAllowedForAuthShared(email, {
    bootstrapUserIds: readBootstrapSuperAdminUserIds(),
    inviteToken: opts?.inviteToken,
  });
}
```

- [x] **Step 3: Add new wrappers after existing ones**

Add these exports to `apps/studio/src/lib/platform-auth-policy.ts`:

```typescript
export async function canUserCreateWorkspace(email: string): Promise<boolean> {
  await ensureDb();
  return canUserCreateWorkspaceShared(email, {
    bootstrapUserIds: readBootstrapSuperAdminUserIds(),
  });
}

export async function listAllowedEmails(): ReturnType<typeof listAllowedEmailsShared> {
  await ensureDb();
  return listAllowedEmailsShared();
}

export async function addAllowedEmail(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addAllowedEmailShared(email, actorUserId);
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  await ensureDb();
  return revokeAllowedEmailShared(email);
}
```

Also update the `export {` block to include `normalizeEmail`:

```typescript
export {
  DEFAULT_ALLOWED_DOMAINS,
  getEmailDomain,
  normalizeDomain,
  normalizeEmail,
  revokeAllowedDomain as removeAllowedDomain,
};
```

- [x] **Step 4: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/lib/platform-auth-policy.ts
git add apps/studio/src/lib/platform-auth-policy.ts
git commit -m "[ABLP-1145] feat(studio): expose email allowlisting + invite bypass in platform-auth-policy wrapper"
```

---

## Task 4: JWT `canCreateWorkspace` Claim

**Files:**

- Modify: `apps/studio/src/services/auth-service.ts`
- Modify: `apps/studio/src/lib/auth.ts`

- [x] **Step 1: Add `canCreateWorkspace` to `JWTPayload` in `auth-service.ts`**

Find the `JWTPayload` interface (line ~178) and add the new field:

```typescript
export interface JWTPayload {
  sub: string;
  email: string;
  type: 'access' | 'refresh' | 'mfa_pending';
  tokenClass?: 'user';
  tenantId?: string;
  role?: string;
  orgId?: string;
  isSuperAdmin?: boolean;
  canCreateWorkspace?: boolean; // absent = true (backward compat)
  iat?: number;
  exp?: number;
}
```

- [x] **Step 2: Update `createAccessToken` to accept and set `canCreateWorkspace`**

Find the `createAccessToken` function signature (line ~392) and update the options parameter:

```typescript
export function createAccessToken(
  user: Pick<User, 'id' | 'email'>,
  tenantContext?: TenantContext | null,
  options?: { isSuperAdmin?: boolean; canCreateWorkspace?: boolean },
): string {
  const { secret, accessExpiry } = getJWTConfig();
  const isSuperAdmin = options?.isSuperAdmin ?? checkIsSuperAdmin(user.id);

  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
    tokenClass: 'user',
    ...(tenantContext
      ? {
          tenantId: tenantContext.tenantId,
          role: tenantContext.role,
          orgId: tenantContext.orgId,
        }
      : {}),
    ...(isSuperAdmin ? { isSuperAdmin: true } : {}),
    // Only set canCreateWorkspace: false explicitly — absence means true (backward compat)
    ...(options?.canCreateWorkspace === false ? { canCreateWorkspace: false } : {}),
  };

  const expiresInSeconds = Math.floor(parseExpiry(accessExpiry) / 1000);

  return signPlatformAccessToken(payload as unknown as Record<string, unknown>, secret, {
    expiresIn: expiresInSeconds,
  });
}
```

- [x] **Step 3: Update `createTokenPair` to compute and pass `canCreateWorkspace`**

Find `createTokenPair` (line ~505) and update it:

```typescript
export async function createTokenPair(
  user: Pick<User, 'id' | 'email'>,
  tenantContext?: TenantContext | null,
): Promise<TokenPair> {
  const { accessExpiry } = getJWTConfig();
  const isSuperAdmin = await isPlatformAdminUser(user);
  const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email));
  const accessToken = createAccessToken(user, tenantContext, {
    isSuperAdmin,
    canCreateWorkspace: canCreate,
  });
  const created = await createRefreshToken(user.id);

  const expiryMs = parseExpiry(accessExpiry);
  const expiresIn = Math.floor(expiryMs / 1000);

  return {
    accessToken,
    refreshToken: created.token,
    expiresIn,
  };
}
```

Add import of `canUserCreateWorkspace` at the top of `auth-service.ts` where platform-auth-policy is imported:

```typescript
import { canUserCreateWorkspace, isPlatformAdminUser } from '@/lib/platform-auth-policy';
```

- [x] **Step 4: Update `buildTokenPair` similarly**

Find `buildTokenPair` (line ~530) and update it:

```typescript
async function buildTokenPair(
  user: Pick<User, 'id' | 'email'>,
  tenantContext: TenantContext | null,
  rawRefreshToken: string,
): Promise<TokenPairWithAuditContext> {
  const { accessExpiry } = getJWTConfig();
  const isSuperAdmin = await isPlatformAdminUser(user);
  const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email));
  const accessToken = createAccessToken(user, tenantContext, {
    isSuperAdmin,
    canCreateWorkspace: canCreate,
  });
  const expiryMs = parseExpiry(accessExpiry);
  const expiresIn = Math.floor(expiryMs / 1000);
  return {
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn,
    userId: user.id,
    tenantId: tenantContext?.tenantId ?? null,
    // ...rest of existing fields unchanged
  };
}
```

> Note: only update the `isSuperAdmin`/`accessToken` lines in `buildTokenPair`. Do not change the return shape or other fields.

- [x] **Step 5: Add `canCreateWorkspace` to `AuthenticatedUser` in `lib/auth.ts`**

Find the `AuthenticatedUser` interface (line ~27) and add the field:

```typescript
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  tenantId?: string;
  role?: string;
  permissions: string[];
  canCreateWorkspace?: boolean; // decoded from JWT claim; absent = true
}
```

In `getAuthenticatedUser` (line ~76), add `canCreateWorkspace` to the result object. The `payload` variable is already available in that function:

```typescript
const result: AuthenticatedUser = {
  id: user.id,
  email: user.email,
  name: user.name,
  tenantId,
  role,
  permissions,
  ...(payload.canCreateWorkspace === false ? { canCreateWorkspace: false } : {}),
};
```

- [x] **Step 6: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/services/auth-service.ts \
  apps/studio/src/lib/auth.ts
git add apps/studio/src/services/auth-service.ts \
        apps/studio/src/lib/auth.ts
git commit -m "[ABLP-1145] feat(studio): add canCreateWorkspace JWT claim in auth-service"
```

---

## Task 5: Auth Store + `/me` Route + `fetchCurrentUser`

**Files:**

- Modify: `apps/studio/src/store/auth-store.ts`
- Modify: `apps/studio/src/app/api/auth/me/route.ts`
- Modify: `apps/studio/src/api/auth.ts`

- [x] **Step 1: Add `canCreateWorkspace` to `User` in auth-store**

In `apps/studio/src/store/auth-store.ts`, update the `User` interface:

```typescript
export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isSuperAdmin?: boolean;
  canCreateWorkspace?: boolean; // absent or true = can create; false = restricted
  role?: string | null;
  permissions?: string[];
}
```

- [x] **Step 2: Decode `canCreateWorkspace` from JWT in `setAuth`**

In `setAuth`, extend the JWT decode block to also extract `canCreateWorkspace`:

```typescript
setAuth: (user, accessToken, tenantId?) => {
  let resolvedTenantId = tenantId ?? null;
  const enrichedUser = { ...user };
  if (accessToken) {
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      if (payload.tenantId) resolvedTenantId = payload.tenantId;
      if (payload.canCreateWorkspace === false) {
        enrichedUser.canCreateWorkspace = false;
      }
    } catch {
      // Ignore decode errors
    }
  }
  set({
    user: enrichedUser,
    accessToken,
    tenantId: resolvedTenantId,
    isSuperAdmin: !!enrichedUser.isSuperAdmin,
    isAuthenticated: true,
    isLoading: false,
    idleLockReason: null,
  });
},
```

- [x] **Step 3: Decode `canCreateWorkspace` from JWT in `setTokens`**

Update `setTokens` to re-decode `canCreateWorkspace` when tokens rotate:

```typescript
setTokens: (accessToken) => {
  let tenantId: string | null = null;
  let canCreateWorkspace: boolean | undefined;
  if (accessToken) {
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      if (payload.tenantId) tenantId = payload.tenantId;
      if (payload.canCreateWorkspace === false) canCreateWorkspace = false;
    } catch {
      // Ignore decode errors
    }
  }
  set((state) => ({
    accessToken,
    ...(tenantId ? { tenantId } : {}),
    ...(canCreateWorkspace !== undefined && state.user
      ? { user: { ...state.user, canCreateWorkspace } }
      : {}),
  }));
},
```

- [x] **Step 4: Update `/api/auth/me` to return `canCreateWorkspace`**

In `apps/studio/src/app/api/auth/me/route.ts`, update both the response schema and the handler:

```typescript
const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  isSuperAdmin: z.boolean().optional(),
  canCreateWorkspace: z.boolean().optional(), // ADD
  role: z.string().nullable().optional(),
  permissions: z.array(z.string()).optional(),
});

async function handler(request: NextRequest) {
  const result = await requireAuth(request);
  if (isAuthError(result)) return result;

  return NextResponse.json({
    id: result.id,
    email: result.email,
    name: result.name,
    isSuperAdmin: await isPlatformAdminUser(result),
    canCreateWorkspace: result.canCreateWorkspace ?? true, // ADD
    role: result.role ?? null,
    permissions: result.permissions ?? [],
  });
}
```

- [x] **Step 5: Update `fetchCurrentUser` in `apps/studio/src/api/auth.ts`**

Find the `fetchCurrentUser` function. Add `canCreateWorkspace` to the `UserResponse` type and to the user object:

```typescript
// Around line 30 — update the UserResponse interface (if typed) or the inline type
interface UserResponse {
  id: string;
  email: string;
  name: string | null;
  avatarUrl?: string;
  isSuperAdmin?: boolean;
  canCreateWorkspace?: boolean; // ADD
  role?: string | null;
  permissions?: string[];
}

// In the function body, after setting isSuperAdmin:
export async function fetchCurrentUser(accessToken: string): Promise<User> {
  // ... existing fetch ...
  const user: User = {
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.avatarUrl,
    role: data.role ?? null,
    permissions: data.permissions ?? [],
  };
  if (data.isSuperAdmin) {
    user.isSuperAdmin = true;
  }
  if (data.canCreateWorkspace === false) {
    // ADD
    user.canCreateWorkspace = false;
  }
  return user;
}
```

- [x] **Step 6: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/store/auth-store.ts \
  apps/studio/src/app/api/auth/me/route.ts \
  apps/studio/src/api/auth.ts
git add apps/studio/src/store/auth-store.ts \
        apps/studio/src/app/api/auth/me/route.ts \
        apps/studio/src/api/auth.ts
git commit -m "[ABLP-1145] feat(studio): propagate canCreateWorkspace through auth store and /me route"
```

---

## Task 6: Thread `inviteToken` Through Email/Password Routes + UI

**Files:**

- Modify: `apps/studio/src/app/api/auth/signup/route.ts`
- Modify: `apps/studio/src/app/api/auth/login/route.ts`
- Modify: `apps/studio/src/app/api/auth/resolve-account/route.ts`
- Modify: `apps/studio/src/app/auth/signup/page.tsx`
- Modify: `apps/studio/src/app/auth/login/page.tsx`

- [x] **Step 1: Update `signup/route.ts` to accept and thread `inviteToken`**

In `apps/studio/src/app/api/auth/signup/route.ts`, update the request schema and the `isEmailAllowedForAuth` call:

```typescript
const signupRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254).describe('User email address'),
  password: z.string().min(8).max(128).describe('Password (must meet strength requirements)'),
  name: z.string().max(200).optional().describe('User display name (optional)'),
  inviteToken: z.string().max(512).optional().describe('Workspace invitation token'),
});
```

Update the domain check in the handler (current line ~98):

```typescript
const { email, password, name, inviteToken } = body;

// ...

if (!(await isEmailAllowedForAuth(normalizedEmail, { inviteToken: inviteToken || undefined }))) {
  return NextResponse.json(
    {
      error: 'This email domain is not approved for self-service access.',
      code: 'DOMAIN_NOT_ALLOWED',
    },
    { status: 403 },
  );
}
```

- [x] **Step 2: Update `login/route.ts` to accept and thread `inviteToken`**

In `apps/studio/src/app/api/auth/login/route.ts`, update the request schema:

```typescript
const loginRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254),
  password: z.string().min(1).max(128),
  inviteToken: z.string().max(512).optional(),
});
```

Update the domain check (current line ~97):

```typescript
const { email, password, inviteToken } = parsed.data;
const normalizedEmail = email.toLowerCase().trim();

if (!(await isEmailAllowedForAuth(normalizedEmail, { inviteToken: inviteToken || undefined }))) {
  return NextResponse.json(
    {
      error: 'This email domain is not approved for platform access.',
      code: 'DOMAIN_NOT_ALLOWED',
    },
    { status: 403 },
  );
}
```

- [x] **Step 3: Update `resolve-account/route.ts` to accept and thread `inviteToken`**

In `apps/studio/src/app/api/auth/resolve-account/route.ts`, find the request schema and add `inviteToken`:

```typescript
const resolveAccountRequestSchema = z.object({
  email: z.string().email().max(254),
  inviteToken: z.string().max(512).optional(),
});
```

Update the domain check:

```typescript
const { email: rawEmail, inviteToken } = parsed.data;
const normalizedEmail = rawEmail.toLowerCase().trim();

if (!(await isEmailAllowedForAuth(normalizedEmail, { inviteToken: inviteToken || undefined }))) {
  // ...existing 403 response unchanged
}
```

- [x] **Step 4: Update `signup/page.tsx` to pass `inviteToken` in body**

In `apps/studio/src/app/auth/signup/page.tsx`, find the fetch call to `/api/auth/signup` and add `inviteToken`:

```typescript
const response = await fetch('/api/auth/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email,
    password,
    name,
    ...(inviteToken ? { inviteToken } : {}),
  }),
});
```

- [x] **Step 5: Update `login/page.tsx` to pass `inviteToken` in both fetch calls**

In `apps/studio/src/app/auth/login/page.tsx`:

**In `handleEmailContinue`** (calls resolve-account), add inviteToken:

```typescript
const response = await fetch('/api/auth/resolve-account', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: email.trim(),
    ...(inviteToken ? { inviteToken } : {}),
  }),
});
```

**In `handleLogin`** (calls login), add inviteToken:

```typescript
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken || ''}`,
  },
  body: JSON.stringify({
    email,
    password,
    ...(inviteToken ? { inviteToken } : {}),
  }),
});
```

- [x] **Step 6: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 7: Commit**

```bash
npx prettier --write \
  apps/studio/src/app/api/auth/signup/route.ts \
  apps/studio/src/app/api/auth/login/route.ts \
  apps/studio/src/app/api/auth/resolve-account/route.ts \
  apps/studio/src/app/auth/signup/page.tsx \
  apps/studio/src/app/auth/login/page.tsx
git add \
  apps/studio/src/app/api/auth/signup/route.ts \
  apps/studio/src/app/api/auth/login/route.ts \
  apps/studio/src/app/api/auth/resolve-account/route.ts \
  apps/studio/src/app/auth/signup/page.tsx \
  apps/studio/src/app/auth/login/page.tsx
git commit -m "[ABLP-1145] feat(studio): thread inviteToken through email/password auth routes"
```

---

## Task 7: Thread `inviteToken` Through OAuth Callback Routes

**Files:**

- Modify: `apps/studio/src/app/api/auth/callback/route.ts` (Google)
- Modify: `apps/studio/src/app/api/auth/microsoft/callback/route.ts`
- Modify: `apps/studio/src/app/api/auth/linkedin/callback/route.ts`

For each OAuth callback, the pattern is the same:

1. Read `oauth_invite` cookie **before** the `isEmailAllowedForAuth` call (currently it's read after)
2. Pass it to `isEmailAllowedForAuth` as `inviteToken`

- [x] **Step 1: Update Google callback (`callback/route.ts`)**

Find the section in `callback/route.ts` where `oauth_invite` is currently cleared (line ~74) and where the domain check happens (line ~127). The cookie is first READ at line ~220.

Move the cookie read to BEFORE the domain check. Find these two lines and reorder:

```typescript
// Read invite token BEFORE domain check (move from ~line 220 to here)
const inviteToken = request.cookies.get('oauth_invite')?.value;

// ...existing code...

if (!(await isEmailAllowedForAuth(payload.email, { inviteToken: inviteToken || undefined }))) {
  return redirectToAuthError('domain_not_allowed', { email: payload.email });
}
```

The `inviteToken` variable is already used later at line ~220 for the auth code. Since we've moved the declaration earlier, remove the duplicate declaration at line ~220.

- [x] **Step 2: Update Microsoft callback**

In `apps/studio/src/app/api/auth/microsoft/callback/route.ts`:

Read `oauth_invite` before line ~135 where `isEmailAllowedForAuth(email)` is called:

```typescript
// Read invite token BEFORE domain check
const inviteToken = request.cookies.get('oauth_invite')?.value;

// ...existing profile fetch code...

if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
  return redirectToAuthError('domain_not_allowed', { email });
}
```

Remove the duplicate `inviteToken` declaration at line ~249.

- [x] **Step 3: Update LinkedIn callback**

In `apps/studio/src/app/api/auth/linkedin/callback/route.ts`:

Apply the same pattern: read `oauth_invite` before line ~119 where `isEmailAllowedForAuth(email)` is called.

```typescript
// Read invite token BEFORE domain check
const inviteToken = request.cookies.get('oauth_invite')?.value;

// ...existing code...

if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
  return redirectToAuthError('domain_not_allowed', { email });
}
```

Remove the duplicate `inviteToken` declaration further down.

- [x] **Step 4: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 5: Commit**

```bash
npx prettier --write \
  apps/studio/src/app/api/auth/callback/route.ts \
  apps/studio/src/app/api/auth/microsoft/callback/route.ts \
  apps/studio/src/app/api/auth/linkedin/callback/route.ts
git add \
  apps/studio/src/app/api/auth/callback/route.ts \
  apps/studio/src/app/api/auth/microsoft/callback/route.ts \
  apps/studio/src/app/api/auth/linkedin/callback/route.ts
git commit -m "[ABLP-1145] feat(studio): thread inviteToken through OAuth callback routes"
```

---

## Task 8: Workspace Creation Gate + UI Restrictions

**Files:**

- Modify: `apps/studio/src/app/api/auth/create-workspace/route.ts`
- Modify: `apps/studio/src/components/auth/UserMenu.tsx`
- Modify: `apps/studio/src/app/onboarding/page.tsx`
- Modify: `apps/studio/src/app/invitations/choose/page.tsx`

- [x] **Step 1: Gate `create-workspace` route on `canCreateWorkspace`**

In `apps/studio/src/app/api/auth/create-workspace/route.ts`, add the check right after `requireAuth`:

```typescript
const authResult = await requireAuth(request);
if (isAuthError(authResult)) return authResult;
const user = authResult;

// Block invited-only users from creating workspaces
if (user.canCreateWorkspace === false) {
  return authError(
    'Workspace creation is not available for your account. Contact your administrator.',
    403,
  );
}
```

- [x] **Step 2: Gate "Create workspace" in `UserMenu.tsx`**

In `apps/studio/src/components/auth/UserMenu.tsx`, find the create workspace button (line ~256):

```tsx
// Current:
{!loadingWorkspaces && (
  <button
    onClick={handleCreateWorkspace}
    data-testid="user-menu-create-workspace"
    ...
  >
    ...
  </button>
)}

// Replace with: hide the button when canCreateWorkspace is false
{!loadingWorkspaces && user?.canCreateWorkspace !== false && (
  <button
    onClick={handleCreateWorkspace}
    data-testid="user-menu-create-workspace"
    className="flex items-center gap-2.5 w-full mt-2 px-2.5 py-1.5 rounded-lg text-sm text-muted hover:text-foreground hover:bg-background-muted transition-default"
  >
    <span className="shrink-0 opacity-70">
      <Plus className="w-4 h-4" />
    </span>
    <span className="flex-1 text-left">{t('create_workspace')}</span>
  </button>
)}
```

- [x] **Step 3: Gate workspace creation in `onboarding/page.tsx`**

In `apps/studio/src/app/onboarding/page.tsx`, show a restricted message instead of the form when `canCreateWorkspace` is false:

```tsx
// After the authReady check, before the return:
if (authReady && accessToken && user?.canCreateWorkspace === false) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <div className="w-14 h-14 bg-accent-subtle rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Building2 className="w-7 h-7 text-accent" />
        </div>
        <h1 className="text-2xl font-semibold text-foreground mb-2">Join a workspace</h1>
        <p className="text-muted text-sm">
          Workspace creation requires an allowlisted domain or email. Accept an invitation to join
          an existing workspace, or contact your platform administrator.
        </p>
      </div>
    </div>
  );
}
```

- [x] **Step 4: Gate "Create workspace" link in `invitations/choose/page.tsx`**

In `apps/studio/src/app/invitations/choose/page.tsx`, locate and conditionally render the two create-workspace links:

In the "no invitations" error state (line ~120), hide the create workspace button:

```tsx
{
  error === 'no_invitations' && (
    <div className="h-screen bg-background flex items-center justify-center">
      <div className="text-center max-w-md">
        <Building2 className="w-12 h-12 text-muted mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">No pending invitations</h1>
        <p className="text-muted mb-6">
          {user?.canCreateWorkspace !== false
            ? 'Your invitations may have expired. You can create your own workspace instead.'
            : 'Your invitations may have expired. Contact your workspace administrator for a new invitation.'}
        </p>
        {user?.canCreateWorkspace !== false && (
          <a
            href="/onboarding"
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default"
          >
            Create workspace
            <ArrowRight className="w-4 h-4" />
          </a>
        )}
      </div>
    </div>
  );
}
```

At the bottom of the invitations list (line ~190), hide the "Create my own workspace instead" link:

```tsx
{
  user?.canCreateWorkspace !== false && (
    <div className="mt-6 text-center">
      <a href="/onboarding" className="text-sm text-muted hover:text-foreground transition-default">
        Create my own workspace instead
      </a>
    </div>
  );
}
```

- [x] **Step 5: Build studio**

```bash
npx turbo build --filter=@agent-platform/studio
```

Expected: no TypeScript errors.

- [x] **Step 6: Commit**

```bash
npx prettier --write \
  apps/studio/src/app/api/auth/create-workspace/route.ts \
  apps/studio/src/components/auth/UserMenu.tsx \
  apps/studio/src/app/onboarding/page.tsx \
  apps/studio/src/app/invitations/choose/page.tsx
git add \
  apps/studio/src/app/api/auth/create-workspace/route.ts \
  apps/studio/src/components/auth/UserMenu.tsx \
  apps/studio/src/app/onboarding/page.tsx \
  apps/studio/src/app/invitations/choose/page.tsx
git commit -m "[ABLP-1145] feat(studio): gate workspace creation for invited-only users"
```

---

## Task 9: Admin — Allowed Emails API Route

**Files:**

- Modify: `apps/admin/src/lib/platform-access-policy.ts`
- Create: `apps/admin/src/app/api/access/emails/route.ts`

- [x] **Step 1: Export email functions from admin `lib/platform-access-policy.ts`**

In `apps/admin/src/lib/platform-access-policy.ts`, update the import block at the top:

```typescript
import {
  addAllowedDomain as addAllowedDomainShared,
  addAllowedEmail as addAllowedEmailShared,
  addPlatformAdmin as addPlatformAdminShared,
  DEFAULT_ALLOWED_DOMAINS,
  isPlatformAdminUser as isPlatformAdminUserShared,
  isValidAllowedDomain,
  isValidEmail,
  listAccessPolicy as listAccessPolicyShared,
  listPendingAccessRequestsForDomain,
  markAccessRequestsNotified,
  normalizeDomain,
  normalizeEmail,
  revokeAllowedDomain as revokeAllowedDomainShared,
  revokeAllowedEmail as revokeAllowedEmailShared,
  revokePlatformAdmin as revokePlatformAdminShared,
} from '@agent-platform/database/platform-access-policy';
import type {
  PlatformAccessPolicy,
  PlatformAccessRequestRecord,
  PlatformAdminPrincipal,
} from '@agent-platform/database/platform-access-policy';
```

Add the email wrapper functions after `revokeAllowedDomain`:

```typescript
export async function addAllowedEmail(email: string, actorUserId: string): Promise<void> {
  await ensureDb();
  return addAllowedEmailShared(email, actorUserId);
}

export async function revokeAllowedEmail(email: string): Promise<boolean> {
  await ensureDb();
  return revokeAllowedEmailShared(email);
}
```

Also update `listAccessPolicy` to include the `PlatformAccessPolicy` type (which now has `allowedEmails`) — this wrapper already delegates to `listAccessPolicyShared`, so no change to the function body is needed; the return type update is automatic.

Export `normalizeEmail` in the existing `export {` block:

```typescript
export {
  DEFAULT_ALLOWED_DOMAINS,
  isValidAllowedDomain,
  isValidEmail,
  listPendingAccessRequestsForDomain,
  markAccessRequestsNotified,
  normalizeDomain,
  normalizeEmail,
};
export type { PlatformAccessPolicy };
```

- [x] **Step 2: Create `apps/admin/src/app/api/access/emails/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';
import { logAdminAction } from '../../../../lib/audit-logger';
import {
  addAllowedEmail,
  listAccessPolicy,
  normalizeEmail,
  revokeAllowedEmail,
} from '../../../../lib/platform-access-policy';

const emailBodySchema = z.object({ email: z.string().email().max(254) }).strict();

export const GET = withAdminRoute({ role: 'VIEWER' }, async () => {
  const policy = await listAccessPolicy();
  return NextResponse.json(policy);
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, emailBodySchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    await addAllowedEmail(parsedBody.data.email, ctx.user.userId);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid email' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_email_allow',
    target: `platform/email/${parsedBody.data.email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const email = normalizeEmail(ctx.request.nextUrl.searchParams.get('email') || '');
  if (!email) {
    return NextResponse.json({ success: false, error: 'Email required' }, { status: 400 });
  }

  let removed: boolean;
  try {
    removed = await revokeAllowedEmail(email);
    if (!removed) {
      return NextResponse.json({ success: false, error: 'Email not found' }, { status: 404 });
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Invalid email' },
      { status: 400 },
    );
  }

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'platform_email_revoke',
    target: `platform/email/${email}`,
    ipAddress: ctx.user.ipAddress,
  });

  return NextResponse.json(await listAccessPolicy());
});
```

- [x] **Step 3: Build admin**

```bash
npx turbo build --filter=@agent-platform/admin
```

Expected: no TypeScript errors.

- [x] **Step 4: Commit**

```bash
npx prettier --write \
  apps/admin/src/lib/platform-access-policy.ts \
  apps/admin/src/app/api/access/emails/route.ts
git add \
  apps/admin/src/lib/platform-access-policy.ts \
  apps/admin/src/app/api/access/emails/route.ts
git commit -m "[ABLP-1145] feat(admin): add allowed emails API route"
```

---

## Task 10: Admin UI — Allowed Emails Panel

**Files:**

- Modify: `apps/admin/src/app/(dashboard)/access/page.tsx`

- [x] **Step 1: Add `AllowedEmailRow` interface and state to the page**

In `apps/admin/src/app/(dashboard)/access/page.tsx`, add the interface after `AccessRequestRow`:

```typescript
interface AllowedEmailRow {
  id: string;
  email: string;
  addedByUserId: string;
  createdAt: string;
}
```

Update `AccessPolicyResponse` to include `allowedEmails`:

```typescript
interface AccessPolicyResponse {
  defaultDomains: string[];
  customDomains: Array<{ id: string; domain: string; createdAt: string; addedByUserId: string }>;
  allowedEmails: AllowedEmailRow[]; // ADD
  platformAdmins: AdminRow[];
  pendingAccessRequests: AccessRequestRow[];
}
```

Add state and input variables after existing state declarations:

```typescript
const [allowedEmails, setAllowedEmails] = useState<AllowedEmailRow[]>([]);
const [newEmail, setNewEmail] = useState('');
```

Update `applyPolicy` to set `allowedEmails`:

```typescript
const applyPolicy = (policy: AccessPolicyResponse) => {
  setDomains([
    ...policy.defaultDomains.map((value) => ({ domain: value, source: 'default' as const })),
    ...policy.customDomains.map((row) => ({
      id: row.id,
      domain: row.domain,
      source: 'custom' as const,
    })),
  ]);
  setAllowedEmails(policy.allowedEmails ?? []); // ADD
  setAdmins(policy.platformAdmins);
  setRequests(policy.pendingAccessRequests);
};
```

- [x] **Step 2: Add email CRUD handlers**

Add after `removeAdmin`:

```typescript
const addEmail = async (event: React.FormEvent) => {
  event.preventDefault();
  setSaving('email' as any);
  setError('');
  try {
    const response = await fetch('/api/access/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail }),
    });
    const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to add email.'));
    }
    applyPolicy(data);
    setNewEmail('');
  } catch (saveError) {
    setError(saveError instanceof Error ? saveError.message : 'Failed to add email.');
  } finally {
    setSaving(null);
  }
};

const removeEmail = async (email: string) => {
  setSaving('delete');
  setError('');
  try {
    const response = await fetch(`/api/access/emails?email=${encodeURIComponent(email)}`, {
      method: 'DELETE',
    });
    const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to remove email.'));
    }
    applyPolicy(data);
  } catch (deleteError) {
    setError(deleteError instanceof Error ? deleteError.message : 'Failed to remove email.');
  } finally {
    setSaving(null);
  }
};
```

Also update the `saving` state type:

```typescript
const [saving, setSaving] = useState<'domain' | 'admin' | 'email' | 'delete' | null>(null);
```

- [x] **Step 3: Add the Allowed Emails panel to the JSX**

Add the `Mail` icon import (already imported) and add a new `AtSign` icon import. Find the icon imports at the top:

```typescript
import { Loader2, Mail, AtSign, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
```

Insert the Allowed Emails section after the Allowed Domains section and before Platform Admins, inside the `<div className="grid gap-6 lg:grid-cols-2">`:

```tsx
{
  /* --- Allowed Emails panel (insert after Allowed Domains section) --- */
}
<section className="rounded-lg border border-border bg-background-subtle p-5">
  <div className="mb-4 flex items-center gap-2">
    <AtSign className="h-5 w-5 text-accent" />
    <h2 className="text-lg font-semibold text-foreground">Allowed Emails</h2>
  </div>

  <form onSubmit={addEmail} className="mb-4 flex gap-2">
    <input
      type="email"
      value={newEmail}
      onChange={(event) => setNewEmail(event.target.value)}
      className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus"
      placeholder="user@gmail.com"
    />
    <button
      type="submit"
      disabled={saving !== null || !newEmail.trim()}
      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {saving === 'email' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Plus className="h-4 w-4" />
      )}
      Add
    </button>
  </form>

  <div className="divide-y divide-border rounded-md border border-border">
    {allowedEmails.length === 0 ? (
      <div className="px-3 py-6 text-center text-sm text-muted">
        No individual emails added. Users must have an allowlisted domain to sign up.
      </div>
    ) : (
      allowedEmails.map((row) => (
        <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.email}</p>
          </div>
          <button
            type="button"
            onClick={() => removeEmail(row.email)}
            disabled={saving !== null}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50"
            title="Remove email"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))
    )}
  </div>
</section>;
```

The result is a 2×2 grid: Allowed Domains + Allowed Emails on the first row, Platform Admins + (empty cell) on the second, with Pending Requests spanning full width below.

Actually, to keep Pending Requests spanning full width and the grid balanced, move Platform Admins to share the second row with nothing (or adjust the layout so Allowed Domains and Allowed Emails are both top-row, Platform Admins is bottom-left). The grid `lg:grid-cols-2` with 3 sections will naturally put Domain + Email on row 1 and Admins on row 2 left. The Pending Requests section is outside the grid (in the `mt-6` section), so no changes needed there.

- [x] **Step 4: Build admin**

```bash
npx turbo build --filter=@agent-platform/admin
```

Expected: no TypeScript errors.

- [x] **Step 5: Commit**

```bash
npx prettier --write "apps/admin/src/app/\(dashboard\)/access/page.tsx"
git add "apps/admin/src/app/(dashboard)/access/page.tsx"
git commit -m "[ABLP-1145] feat(admin): add Allowed Emails panel to access control page"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement                                             | Task that covers it |
| ------------------------------------------------------------ | ------------------- |
| New `PlatformAllowedEmail` model                             | Task 1              |
| `addAllowedEmail`, `revokeAllowedEmail`, `listAllowedEmails` | Task 2              |
| `hasValidInvitationForEmail`                                 | Task 2              |
| Updated `isEmailAllowedForAuth` with `inviteToken`           | Task 2              |
| `canUserCreateWorkspace`                                     | Task 2              |
| Studio wrapper exports new functions                         | Task 3              |
| `canCreateWorkspace` JWT claim                               | Task 4              |
| `canCreateWorkspace` decoded in auth-store                   | Task 5              |
| `/api/auth/me` returns `canCreateWorkspace`                  | Task 5              |
| Thread inviteToken: signup, login, resolve-account           | Task 6              |
| Thread inviteToken: Google, Microsoft, LinkedIn              | Task 7              |
| `create-workspace` route gate                                | Task 8              |
| UI hide "Create workspace" in UserMenu                       | Task 8              |
| UI gate in onboarding                                        | Task 8              |
| UI gate in invitations/choose                                | Task 8              |
| Admin: emails API route (GET/POST/DELETE)                    | Task 9              |
| Admin: Allowed Emails panel in UI                            | Task 10             |
| `listAccessPolicy` includes `allowedEmails`                  | Task 2              |
| Admin lib wrapper exports email functions                    | Task 9              |

All spec requirements covered. ✓

**Placeholder scan:** No TBDs, no "implement later" stubs. All code steps are complete. ✓

**Type consistency:**

- `PlatformAccessPolicy.allowedEmails` defined in Task 2, used in Tasks 9+10. ✓
- `canCreateWorkspace?: boolean` on `JWTPayload` (Task 4), `AuthenticatedUser` (Task 4), `User` (Task 5). ✓
- `isAllowlistedEmail` defined in Task 2, used in Task 2 (`canUserCreateWorkspace`, `isEmailAllowedForAuth`). ✓
- `inviteToken` parameter: DB function (Task 2) → studio wrapper (Task 3) → routes (Tasks 6,7). ✓
- `saving` state type updated in Task 10 to include `'email'`. ✓

**One gap found and fixed:** The `setTokens` in auth-store (Task 5) needs to handle the case where `state.user` is null — already handled with `state.user` null check in the implementation above. ✓
