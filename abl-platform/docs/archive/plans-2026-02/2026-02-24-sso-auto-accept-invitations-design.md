# SSO Auto-Accept Invitations & Eliminate Tenant Gap

## Problem

All authentication methods (Google OAuth, SAML, OIDC, email signup) create users without tenant membership. The JWT is issued without a `tenantId`, causing 403 errors on every tenant-scoped API call until the user completes onboarding.

The timing gap:

```
User authenticates
  -> User record created (no TenantMember)
  -> JWT issued WITHOUT tenantId
  -> Frontend redirects to /onboarding
  -> User creates workspace (Tenant + TenantMember)
  -> NEW JWT issued WITH tenantId
```

This gap causes cascading failures: stale tokens, 403 errors on tenant-scoped routes, dead-end UI states, and client-side retry hacks.

For invited users the problem is worse: they must create an unnecessary personal workspace before they can accept an invitation to the workspace they were actually invited to.

## Decided Behavior

| Scenario                     | Current                                          | New                                                       |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| SSO + 1 pending invitation   | Onboarding -> create workspace -> accept invite  | Auto-accept invitation, skip onboarding, JWT has tenantId |
| SSO + 2+ pending invitations | Onboarding -> create workspace -> accept invites | Show invitation picker page, user selects one             |
| SSO + 0 invitations          | Onboarding page (name workspace)                 | Same -- keep onboarding page                              |
| Email signup + invitations   | Verify email -> onboarding -> accept             | Same auto-accept/picker logic after email verification    |

## Design

### Shared Helper: `resolveUserContextOrAutoAcceptInvite()`

All 4 auth endpoints (Google callback, SAML callback, OIDC callback, email verification) currently call `resolveUserTenantContext(userId)` independently. Replace with a single shared helper in `auth-service.ts`:

```typescript
async function resolveUserContextOrAutoAcceptInvite(
  userId: string,
  email: string,
): Promise<{
  tenantContext: TenantContext | null;
  pendingInvitationChoice: boolean;
}> {
  // 1. Check existing membership
  const existing = await resolveUserTenantContext(userId);
  if (existing) return { tenantContext: existing, pendingInvitationChoice: false };

  // 2. Check pending invitations
  const invitations = await findPendingInvitations(email);

  if (invitations.length === 1) {
    // Auto-accept single invitation
    const result = await acceptInvitation(invitations[0].token, { id: userId, email });
    return {
      tenantContext: { tenantId: result.tenantId, role: result.role, orgId: result.orgId },
      pendingInvitationChoice: false,
    };
  }

  if (invitations.length > 1) {
    // Multiple invitations -- let user choose
    return { tenantContext: null, pendingInvitationChoice: true };
  }

  // 3. No invitations, no membership -- needs onboarding
  return { tenantContext: null, pendingInvitationChoice: false };
}
```

### Auth Code Metadata

The one-time auth code already carries `needsOnboarding` and `pendingInvitations`. Add `pendingInvitationChoice`:

```typescript
storeAuthCode(authCode, {
  accessToken,
  refreshToken,
  expiresIn,
  needsOnboarding: !tenantContext && !pendingInvitationChoice,
  pendingInvitationChoice,
  pendingInvitations: count > 0 ? count : undefined,
});
```

### Frontend Routing

`AuthCallback.tsx` gains one new condition:

```typescript
if (tokens.pendingInvitationChoice) {
  window.location.href = '/invitations/choose';
} else if (tokens.needsOnboarding) {
  window.location.href = '/onboarding';
} else {
  window.location.href = '/';
}
```

### New Endpoint: `GET /api/invitations/pending`

Returns pending invitations for the authenticated user's email. Used by the invitation picker page.

- Protected by `requireAuth` (not `requireTenantAuth` -- user has no tenant yet)
- Queries `WorkspaceInvitation` by email, status `pending`, not expired
- Joins Tenant for workspace name
- Returns: `{ invitations: [{ token, workspaceName, role, invitedBy, expiresAt }] }`

### New Page: `/invitations/choose`

Card list of pending invitations. Each card shows:

- Workspace name
- Role being granted
- Inviter name
- Expiry date
- "Accept" button

Bottom of page: "Create my own workspace instead" link -> `/onboarding`.

Edge cases:

- 0 pending invitations (expired/revoked since redirect): show message, link to `/onboarding`
- User already has tenantId: redirect to `/`

### New Repo Function: `findPendingInvitations(email)`

```typescript
export async function findPendingInvitations(email: string) {
  const normalized = email.toLowerCase().trim();
  const now = new Date();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  return WorkspaceInvitation.find({
    email: normalized,
    status: 'pending',
    expiresAt: { $gt: now },
  }).lean();
}
```

## Security

- **Auto-accept only fires when user has zero existing tenant memberships.** Never overrides an existing workspace context.
- **Reuses existing `acceptInvitation()` function** which validates: invitation status is `pending`, not expired, email matches the user's email.
- **Invitation was created by a workspace admin.** Accepting it is the invited user's intended action.
- **Audit event `INVITATION_ACCEPTED`** is already logged by the existing `acceptInvitation()` function.
- **Invitation picker page** is protected by `requireAuth`. Invitations are queried by authenticated user's email only.
- **No new tokens, no new auth flows.** This is earlier execution of existing invitation acceptance logic.

## Files to Create/Modify

| File                                                   | Change                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/studio/src/services/auth-service.ts`             | Add `resolveUserContextOrAutoAcceptInvite()` helper, export it |
| `apps/studio/src/repos/auth-repo.ts`                   | Add `findPendingInvitations(email)` query                      |
| `apps/studio/src/app/api/auth/callback/route.ts`       | Use new helper, pass `pendingInvitationChoice` to auth code    |
| `apps/studio/src/app/api/auth/verify-email/route.ts`   | Same change as callback                                        |
| `apps/studio/src/app/api/sso/saml/callback/route.ts`   | Same change                                                    |
| `apps/studio/src/app/api/sso/oidc/callback/route.ts`   | Same change                                                    |
| `apps/studio/src/app/api/sso/exchange/route.ts`        | Pass `pendingInvitationChoice` through to response             |
| `apps/studio/src/components/AuthCallback.tsx`          | Add routing for `pendingInvitationChoice`                      |
| `apps/studio/src/lib/sso-auth-codes.ts`                | Add `pendingInvitationChoice` to stored type                   |
| `apps/studio/src/app/api/invitations/pending/route.ts` | **New** -- GET endpoint for pending invitations                |
| `apps/studio/src/app/invitations/choose/page.tsx`      | **New** -- Invitation picker page                              |

**Not changed:** `acceptInvitation()`, `createWorkspaceWithOwner()`, onboarding page, unified auth middleware.

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-accept a single pending invitation during SSO/email-verify callbacks so invited users skip onboarding and land directly in their workspace. When multiple invitations exist, route to a picker page.

**Architecture:** Add a shared helper `resolveUserContextOrAutoAcceptInvite()` in `auth-service.ts` that checks existing membership → single invitation (auto-accept) → multiple invitations (flag for picker). All 4 auth callback endpoints call this helper instead of `resolveUserTenantContext()` directly. A new `acceptInvitationById()` function handles auto-accept without needing the raw token.

**Tech Stack:** Next.js API routes, MongoDB via repos, React page component, Zustand auth store

---

### Task 1: Add `findPendingInvitationsForEmail()` to auth-repo

**Files:**

- Modify: `apps/studio/src/repos/auth-repo.ts:392-402`

**Step 1: Add the query function**

After the existing `countPendingInvitations` function (line 402), add:

```typescript
/**
 * Find pending workspace invitations for an email (with tenant info).
 * Used by auto-accept logic during auth callbacks.
 */
export async function findPendingInvitationsForEmail(email: string): Promise<any[]> {
  await ensureDb();
  const normalized = email.toLowerCase().trim();
  const now = new Date();
  const { WorkspaceInvitation, Tenant, User } = await import('@agent-platform/database/models');
  const docs = await WorkspaceInvitation.find({
    email: normalized,
    status: 'pending',
    expiresAt: { $gt: now },
  }).lean();

  if (docs.length === 0) return [];

  // Batch-fetch tenants and inviters
  const tenantIds = docs.map((d) => d.tenantId);
  const inviterIds = docs.map((d) => d.invitedBy).filter((id): id is string => id !== null);
  const [tenants, inviters] = await Promise.all([
    Tenant.find({ _id: { $in: tenantIds } })
      .select('name')
      .lean(),
    inviterIds.length > 0
      ? User.find({ _id: { $in: inviterIds } })
          .select('name email')
          .lean()
      : [],
  ]);
  const tenantMap = new Map(tenants.map((t) => [String(t._id), { name: t.name }]));
  const inviterMap = new Map(
    inviters.map((u) => [String(u._id), { name: u.name, email: u.email }]),
  );

  return docs.map((doc) => ({
    id: String(doc._id),
    tenantId: String(doc.tenantId),
    email: doc.email,
    role: doc.role,
    status: doc.status,
    expiresAt: doc.expiresAt,
    workspaceName: tenantMap.get(String(doc.tenantId))?.name || 'Unknown',
    inviterName: doc.invitedBy
      ? inviterMap.get(String(doc.invitedBy))?.name ||
        inviterMap.get(String(doc.invitedBy))?.email ||
        null
      : null,
  }));
}
```

**Step 2: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/repos/auth-repo.ts
git commit -m "feat(studio): add findPendingInvitationsForEmail to auth-repo"
```

---

### Task 2: Add `acceptInvitationById()` to invitation-service

The existing `acceptInvitation(token, userId, userEmail)` expects a raw (unhashed) invitation token. But auto-accept finds invitations by email from the DB, which stores hashed tokens — we don't have the raw token. Add `acceptInvitationById()` that works with the invitation document ID directly.

**Files:**

- Modify: `apps/studio/src/services/invitation-service.ts:208`

**Step 1: Add the function**

After the existing `acceptInvitation()` function (after line 208), add:

```typescript
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
}> {
  const { findInvitationById } = await import('@/repos/workspace-repo');
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
  const existingMembership = await findTenantMember(invitation.tenantId, userId);

  if (existingMembership) {
    await updateInvitation(invitation.id, {
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: userId,
    });
    return { tenantId: invitation.tenantId, role: existingMembership.role };
  }

  await createTenantMember({
    tenantId: invitation.tenantId,
    userId,
    role: invitation.role,
  });

  await updateInvitation(invitation.id, {
    status: 'accepted',
    acceptedAt: new Date(),
    acceptedBy: userId,
  });

  return { tenantId: invitation.tenantId, role: invitation.role };
}
```

Note: `findInvitationById` is already exported from `workspace-repo.ts` (line 227). We use a dynamic import to avoid circular dependency since the top-level imports don't include it.

**Step 2: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/services/invitation-service.ts
git commit -m "feat(studio): add acceptInvitationById for auto-accept during SSO"
```

---

### Task 3: Add `resolveUserContextOrAutoAcceptInvite()` to auth-service

**Files:**

- Modify: `apps/studio/src/services/auth-service.ts:162`

**Step 1: Add the import**

At line 30 (end of imports from `@/repos/auth-repo`), add:

```typescript
import { findPendingInvitationsForEmail } from '@/repos/auth-repo';
```

And add the invitation service import after the auth-repo imports:

```typescript
import { acceptInvitationById } from '@/services/invitation-service';
```

**Step 2: Add the helper function**

After `resolveUserOrgContext` (line 165), add:

```typescript
/**
 * Resolve user context with auto-accept for single pending invitations.
 *
 * Logic:
 * 1. If user already has a tenant membership → return it (no auto-accept)
 * 2. If exactly 1 pending invitation → auto-accept it, return the new membership
 * 3. If 2+ pending invitations → signal the frontend to show a picker
 * 4. If 0 invitations → user needs onboarding (create workspace)
 */
export async function resolveUserContextOrAutoAcceptInvite(
  userId: string,
  email: string,
): Promise<{
  tenantContext: TenantContext | null;
  pendingInvitationChoice: boolean;
}> {
  // 1. Check existing membership
  const existing = await resolveUserTenantContext(userId);
  if (existing) {
    return { tenantContext: existing, pendingInvitationChoice: false };
  }

  // 2. Check pending invitations
  const invitations = await findPendingInvitationsForEmail(email);

  if (invitations.length === 1) {
    // Auto-accept single invitation
    try {
      const result = await acceptInvitationById(invitations[0].id, userId, email);
      // Re-resolve tenant context to get full orgId
      const tenantContext = await resolveUserTenantContext(userId);
      return {
        tenantContext: tenantContext || {
          tenantId: result.tenantId,
          role: result.role,
        },
        pendingInvitationChoice: false,
      };
    } catch (error) {
      // If auto-accept fails (expired, already accepted, etc.), fall through
      console.warn('[Auth] Auto-accept invitation failed:', error);
    }
  }

  if (invitations.length > 1) {
    // Multiple invitations — let user choose
    return { tenantContext: null, pendingInvitationChoice: true };
  }

  // 3. No invitations, no membership — needs onboarding
  return { tenantContext: null, pendingInvitationChoice: false };
}
```

**Step 3: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/services/auth-service.ts apps/studio/src/repos/auth-repo.ts
git commit -m "feat(studio): add resolveUserContextOrAutoAcceptInvite helper"
```

---

### Task 4: Add `pendingInvitationChoice` to AuthCodeData and exchange flow

**Files:**

- Modify: `apps/studio/src/lib/sso-auth-codes.ts:8-14`
- Modify: `apps/studio/src/app/api/sso/exchange/route.ts:29-34`
- Modify: `apps/studio/src/api/auth.ts:116-119`

**Step 1: Add field to AuthCodeData**

In `sso-auth-codes.ts`, add `pendingInvitationChoice` to the interface (after line 13):

```typescript
export interface AuthCodeData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  needsOnboarding?: boolean;
  pendingInvitations?: number;
  pendingInvitationChoice?: boolean;
}
```

**Step 2: Pass through in exchange endpoint**

In `sso/exchange/route.ts`, after line 34 (the `pendingInvitations` check), add:

```typescript
if (stored.pendingInvitationChoice) {
  responseBody.pendingInvitationChoice = true;
}
```

**Step 3: Add to ExchangeResult type**

In `api/auth.ts`, update the `ExchangeResult` interface (line 116-119):

```typescript
interface ExchangeResult extends TokenResponse {
  needsOnboarding?: boolean;
  pendingInvitations?: number;
  pendingInvitationChoice?: boolean;
}
```

And update the `handleOAuthCallback` return (line 148-153):

```typescript
return {
  accessToken: data.accessToken,
  expiresIn: data.expiresIn || 900,
  needsOnboarding: data.needsOnboarding,
  pendingInvitations: data.pendingInvitations,
  pendingInvitationChoice: data.pendingInvitationChoice,
};
```

**Step 4: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/lib/sso-auth-codes.ts apps/studio/src/app/api/sso/exchange/route.ts apps/studio/src/api/auth.ts
git commit -m "feat(studio): add pendingInvitationChoice to auth code exchange flow"
```

---

### Task 5: Wire Google OAuth callback to use new helper

**Files:**

- Modify: `apps/studio/src/app/api/auth/callback/route.ts:12-17,123-186`

**Step 1: Update imports**

Replace the import of `resolveUserTenantContext` and `getPendingInvitationCount` (line 12-17):

```typescript
import {
  findOrCreateGoogleUser,
  createTokenPair,
  createPartialToken,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
```

Remove `getPendingInvitationCount` from the import.

**Step 2: Replace tenant resolution logic**

Replace lines 123-186 (from `// Check pending invitations` through the `storeAuthCode` call) with:

```typescript
// Resolve tenant context, auto-accepting single pending invitation
const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
  user.id,
  user.email,
);

// Issue full tokens with tenant context
const tokenPair = await createTokenPair(user, tenantContext);

await logAuditEvent({
  userId: user.id,
  action: AuditActions.LOGIN,
  ip: request.headers.get('x-forwarded-for') || undefined,
  userAgent: request.headers.get('user-agent') || undefined,
  metadata: { provider: 'google' },
});

// Generate a one-time auth code instead of putting tokens in the URL
const authCode = crypto.randomBytes(32).toString('hex');
storeAuthCode(authCode, {
  accessToken: tokenPair.accessToken,
  refreshToken: tokenPair.refreshToken,
  expiresIn: tokenPair.expiresIn,
  needsOnboarding: !tenantContext && !pendingInvitationChoice,
  pendingInvitationChoice,
});
```

Also remove the now-unused import of `findDefaultTenantMembership` from `@/repos/auth-repo` (line 22), and remove the SSO enforcement check (lines 126-136) that uses it — or keep it if needed. Actually, keep the SSO enforcement check but import `findDefaultTenantMembership` still. The SSO enforcement block (lines 126-136) should remain as it validates org SSO policy before issuing tokens.

Actually, looking more carefully: the SSO enforcement check (lines 126-136) uses `findDefaultTenantMembership` and should remain. The change is only to replace lines 164-186.

**Step 3: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/auth/callback/route.ts
git commit -m "feat(studio): wire Google OAuth callback to auto-accept invitations"
```

---

### Task 6: Wire SAML callback to use new helper

**Files:**

- Modify: `apps/studio/src/app/api/sso/saml/callback/route.ts:15,143-155`

**Step 1: Update imports**

Replace line 15:

```typescript
import { createTokenPair, resolveUserContextOrAutoAcceptInvite } from '@/services/auth-service';
```

(Remove the import of `resolveUserOrgContext`.)

**Step 2: Replace tenant resolution logic**

Replace lines 143-155 (from `// Resolve org context` through `storeAuthCode`) with:

```typescript
// Resolve tenant context, auto-accepting single pending invitation
const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
  user.id,
  user.email,
);

// Issue tokens via auth service (includes role in JWT)
const tokenPair = await createTokenPair(user, tenantContext);

// Generate a one-time auth code instead of putting tokens in the URL
const authCode = crypto.randomBytes(32).toString('hex');
storeAuthCode(authCode, {
  accessToken: tokenPair.accessToken,
  refreshToken: tokenPair.refreshToken,
  expiresIn: tokenPair.expiresIn,
  needsOnboarding: !tenantContext && !pendingInvitationChoice,
  pendingInvitationChoice,
});
```

**Step 3: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/sso/saml/callback/route.ts
git commit -m "feat(studio): wire SAML callback to auto-accept invitations"
```

---

### Task 7: Wire OIDC callback to use new helper

**Files:**

- Modify: `apps/studio/src/app/api/sso/oidc/callback/route.ts:9,139-151`

**Step 1: Update imports**

Replace line 9:

```typescript
import { createTokenPair, resolveUserContextOrAutoAcceptInvite } from '@/services/auth-service';
```

(Remove the import of `resolveUserOrgContext`.)

**Step 2: Replace tenant resolution logic**

Replace lines 139-151 (from `// Resolve org context` through `storeAuthCode`) with:

```typescript
// Resolve tenant context, auto-accepting single pending invitation
const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
  user.id,
  user.email,
);

// Issue tokens via auth service (includes role in JWT)
const tokenPair = await createTokenPair(user, tenantContext);

// Generate a one-time auth code instead of putting tokens in the URL
const authCode = crypto.randomBytes(32).toString('hex');
storeAuthCode(authCode, {
  accessToken: tokenPair.accessToken,
  refreshToken: tokenPair.refreshToken,
  expiresIn: tokenPair.expiresIn,
  needsOnboarding: !tenantContext && !pendingInvitationChoice,
  pendingInvitationChoice,
});
```

**Step 3: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/sso/oidc/callback/route.ts
git commit -m "feat(studio): wire OIDC callback to auto-accept invitations"
```

---

### Task 8: Wire verify-email endpoint to use new helper

**Files:**

- Modify: `apps/studio/src/app/api/auth/verify-email/route.ts:9,96-126`

**Step 1: Update imports**

Replace line 9:

```typescript
import { createTokenPair, resolveUserContextOrAutoAcceptInvite } from '@/services/auth-service';
```

(Remove `resolveUserTenantContext` and `getPendingInvitationCount`.)

**Step 2: Replace tenant resolution logic**

Replace lines 96-126 (from `// Check for pending invitations` through the `NextResponse.json` call) with:

```typescript
// Resolve tenant context, auto-accepting single pending invitation
const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
  String(verificationToken.userId),
  verificationToken.user.email,
);

// Issue tokens
const tokenPair = await createTokenPair(verificationToken.user, tenantContext);

await logAuditEvent({
  userId: verificationToken.userId,
  action: AuditActions.EMAIL_VERIFIED,
  ip: request.headers.get('x-forwarded-for') || undefined,
  userAgent: request.headers.get('user-agent') || undefined,
  metadata: {
    autoAccepted: !!tenantContext && !pendingInvitationChoice,
  },
});

const response = NextResponse.json({
  user: {
    id: verificationToken.user.id,
    email: verificationToken.user.email,
    name: verificationToken.user.name,
    avatarUrl: verificationToken.user.avatarUrl,
  },
  accessToken: tokenPair.accessToken,
  expiresIn: tokenPair.expiresIn,
  needsOnboarding: !tenantContext && !pendingInvitationChoice,
  pendingInvitationChoice,
});
```

Note: `verify-email` returns tokens directly (not via auth code exchange), so `pendingInvitationChoice` must be returned in the JSON response body directly. The `AuthCallback` component doesn't handle email verification — it uses a different frontend flow. We'll need to check how the frontend handles this response.

**Step 3: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/auth/verify-email/route.ts
git commit -m "feat(studio): wire verify-email to auto-accept invitations"
```

---

### Task 9: Update AuthCallback frontend routing

**Files:**

- Modify: `apps/studio/src/components/AuthCallback.tsx:64-77`

**Step 1: Add pendingInvitationChoice routing**

Replace lines 64-77 with:

```typescript
// Check if user needs onboarding or invitation choice (from exchange response metadata)
const needsOnboarding = tokens.needsOnboarding === true;
const pendingInvitationChoice = tokens.pendingInvitationChoice === true;

// Clean URL and redirect
window.history.replaceState({}, '', '/');

// Small delay for user feedback, then redirect
setTimeout(() => {
  if (pendingInvitationChoice) {
    window.location.href = '/invitations/choose';
  } else if (needsOnboarding) {
    window.location.href = '/onboarding';
  } else {
    onComplete();
  }
}, 500);
```

**Step 2: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/components/AuthCallback.tsx
git commit -m "feat(studio): add invitation picker routing to AuthCallback"
```

---

### Task 10: Create GET /api/invitations/pending endpoint

**Files:**

- Create: `apps/studio/src/app/api/invitations/pending/route.ts`

**Step 1: Create the endpoint**

```typescript
/**
 * GET /api/invitations/pending — List pending invitations for the authenticated user
 *
 * Protected by requireAuth (not requireTenantAuth — user has no tenant yet).
 * Returns pending invitations for the user's email so the invitation picker
 * page can display them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findPendingInvitationsForEmail } from '@/repos/auth-repo';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const invitations = await findPendingInvitationsForEmail(user.email);

    return NextResponse.json({
      invitations: invitations.map((inv) => ({
        id: inv.id,
        workspaceName: inv.workspaceName,
        role: inv.role,
        inviterName: inv.inviterName,
        expiresAt: inv.expiresAt,
      })),
    });
  } catch (error) {
    console.error('[Invitations] Error fetching pending invitations:', error);
    return NextResponse.json({ error: 'Failed to fetch pending invitations' }, { status: 500 });
  }
}
```

**Step 2: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/invitations/pending/route.ts
git commit -m "feat(studio): add GET /api/invitations/pending endpoint"
```

---

### Task 11: Create /invitations/choose page

**Files:**

- Create: `apps/studio/src/app/invitations/choose/page.tsx`

**Step 1: Create the page**

```tsx
'use client';

/**
 * Invitation Picker Page
 *
 * Shown when a user has multiple pending workspace invitations.
 * They choose which workspace to join, or can create their own.
 */

import { useEffect, useState } from 'react';
import { Loader2, Building2, UserPlus, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { fetchCurrentUser, scheduleTokenRefresh } from '@/api/auth';

interface PendingInvitation {
  id: string;
  workspaceName: string;
  role: string;
  inviterName: string | null;
  expiresAt: string;
}

export default function InvitationChoosePage() {
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, accessToken, setAuth } = useAuthStore();

  useEffect(() => {
    async function loadInvitations() {
      try {
        const response = await fetch('/api/invitations/pending', {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          credentials: 'same-origin',
        });

        if (!response.ok) {
          throw new Error('Failed to fetch invitations');
        }

        const data = await response.json();
        setInvitations(data.invitations || []);

        // If no invitations (expired since redirect), show empty state
        if (!data.invitations || data.invitations.length === 0) {
          setError('no_invitations');
        }
      } catch (err) {
        console.error('Failed to load invitations:', err);
        setError('load_failed');
      } finally {
        setLoading(false);
      }
    }

    // If user already has a tenantId, redirect to home
    if (user?.tenantId) {
      window.location.href = '/';
      return;
    }

    loadInvitations();
  }, [accessToken, user?.tenantId]);

  async function handleAccept(invitationId: string) {
    setAccepting(invitationId);
    setError(null);

    try {
      const response = await fetch(`/api/invitations/${invitationId}/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to accept invitation');
      }

      const data = await response.json();

      // Refresh tokens to get the new tenantId in the JWT
      const refreshResponse = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        const updatedUser = await fetchCurrentUser(refreshData.accessToken);
        setAuth(updatedUser, refreshData.accessToken);
        scheduleTokenRefresh(refreshData.expiresIn);
      }

      // Redirect to home
      window.location.href = '/';
    } catch (err) {
      console.error('Failed to accept invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
      setAccepting(null);
    }
  }

  if (loading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  if (error === 'no_invitations') {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <Building2 className="w-12 h-12 text-muted mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">No pending invitations</h1>
          <p className="text-muted mb-6">
            Your invitations may have expired. You can create your own workspace instead.
          </p>
          <a
            href="/onboarding"
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default"
          >
            Create workspace
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <UserPlus className="w-12 h-12 text-accent mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">Choose a workspace</h1>
          <p className="text-muted">You have been invited to join the following workspaces.</p>
        </div>

        {error && error !== 'no_invitations' && error !== 'load_failed' && (
          <div className="mb-4 p-3 bg-error-subtle text-error rounded-lg text-sm">{error}</div>
        )}

        {error === 'load_failed' && (
          <div className="text-center">
            <p className="text-error mb-4">Failed to load invitations. Please try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default"
            >
              Retry
            </button>
          </div>
        )}

        <div className="space-y-3">
          {invitations.map((inv) => (
            <div
              key={inv.id}
              className="border border-default rounded-lg p-4 bg-background-muted hover:bg-background-elevated transition-default"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-foreground">{inv.workspaceName}</h3>
                  <p className="text-sm text-muted">
                    Role: <span className="font-medium">{inv.role}</span>
                    {inv.inviterName && <> &middot; Invited by {inv.inviterName}</>}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleAccept(inv.id)}
                  disabled={accepting !== null}
                  className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default disabled:opacity-50 flex items-center gap-2"
                >
                  {accepting === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Accept'}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 text-center">
          <a
            href="/onboarding"
            className="text-sm text-muted hover:text-foreground transition-default"
          >
            Create my own workspace instead
          </a>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify it compiles**

Run: `pnpm build --filter studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/app/invitations/choose/page.tsx
git commit -m "feat(studio): add invitation picker page at /invitations/choose"
```

---

### Task 12: Verify full build and run tests

**Step 1: Full build**

Run: `pnpm build`
Expected: All packages build successfully.

**Step 2: Run Studio tests**

Run: `pnpm test --filter studio`
Expected: All existing tests pass.

**Step 3: Commit any remaining fixes**

If tests fail, fix and commit.

---

## Files Summary

| File                                                   | Change                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/studio/src/repos/auth-repo.ts`                   | Add `findPendingInvitationsForEmail()`                        |
| `apps/studio/src/services/invitation-service.ts`       | Add `acceptInvitationById()`                                  |
| `apps/studio/src/services/auth-service.ts`             | Add `resolveUserContextOrAutoAcceptInvite()`, import new deps |
| `apps/studio/src/lib/sso-auth-codes.ts`                | Add `pendingInvitationChoice` to `AuthCodeData`               |
| `apps/studio/src/app/api/sso/exchange/route.ts`        | Pass `pendingInvitationChoice` through                        |
| `apps/studio/src/api/auth.ts`                          | Add `pendingInvitationChoice` to `ExchangeResult`             |
| `apps/studio/src/app/api/auth/callback/route.ts`       | Use `resolveUserContextOrAutoAcceptInvite`                    |
| `apps/studio/src/app/api/sso/saml/callback/route.ts`   | Use `resolveUserContextOrAutoAcceptInvite`                    |
| `apps/studio/src/app/api/sso/oidc/callback/route.ts`   | Use `resolveUserContextOrAutoAcceptInvite`                    |
| `apps/studio/src/app/api/auth/verify-email/route.ts`   | Use `resolveUserContextOrAutoAcceptInvite`                    |
| `apps/studio/src/components/AuthCallback.tsx`          | Add `pendingInvitationChoice` routing                         |
| `apps/studio/src/app/api/invitations/pending/route.ts` | **New** — GET endpoint                                        |
| `apps/studio/src/app/invitations/choose/page.tsx`      | **New** — Picker page                                         |

**Not changed:** `acceptInvitation()`, `createWorkspaceWithOwner()`, onboarding page, unified auth middleware.
