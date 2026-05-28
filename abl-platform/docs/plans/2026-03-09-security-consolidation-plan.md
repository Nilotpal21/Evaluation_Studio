# Security Consolidation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move inbound-auth and webhook-signature utilities to shared-kernel, and consolidate the duplicate runtime security-repo into the shared package.

**Architecture:** Two independent parts. Part 1 moves pure crypto utilities out of `apps/runtime/src/channels/security/` into `packages/shared-kernel/src/security/` and updates all import sites directly (no re-export stubs). Part 2 extends `packages/shared/src/repos/security-repo.ts` with EnvironmentVariable operations (adding a new `NormalizedEnvironmentVariable` type to shared-kernel), then replaces `apps/runtime/src/repos/security-repo.ts` with a re-export barrel so all existing runtime import sites continue to work unchanged.

**Tech Stack:** TypeScript, Node.js crypto built-in, Vitest 4.x, pnpm workspaces/Turbo

---

## Part 1: Channel Security Utils → shared-kernel

### Task 1: Create inbound-auth.ts in shared-kernel

**Files:**

- Create: `packages/shared-kernel/src/security/inbound-auth.ts`

**Step 1: Create the file** — copy the implementation verbatim:

```typescript
/**
 * Inbound Channel Authentication Helpers
 *
 * Shared utilities for authenticating inbound channel traffic using
 * pre-shared tokens from headers, bearer auth, or query params.
 */

import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';

function normalizeToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return normalizeToken(value[0]);
  }
  return normalizeToken(value);
}

export function extractIngressToken(
  headers: IncomingHttpHeaders,
  queryToken?: string | null,
): string | null {
  const explicitHeader =
    normalizeHeaderValue(headers['x-channel-secret']) ||
    normalizeHeaderValue(headers['x-ingress-secret']) ||
    normalizeHeaderValue(headers['x-webhook-secret']);
  if (explicitHeader) return explicitHeader;

  const authHeader = normalizeHeaderValue(headers.authorization);
  if (authHeader?.startsWith('Bearer ')) {
    return normalizeToken(authHeader.slice('Bearer '.length));
  }

  return normalizeToken(queryToken);
}

export function tokensMatch(providedToken: string | null, expectedToken: string | null): boolean {
  if (!providedToken || !expectedToken) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}
```

**Step 2: Verify TypeScript can find `IncomingHttpHeaders`**

`packages/shared-kernel` has no `@types/node` in devDependencies. Check `tsconfig.json`:

```bash
cat packages/shared-kernel/tsconfig.json
```

If `lib` does not include `node` types or if `@types/node` is missing, add it:

```bash
pnpm add -D @types/node --filter @agent-platform/shared-kernel
```

---

### Task 2: Create webhook-signature.ts in shared-kernel

**Files:**

- Create: `packages/shared-kernel/src/security/webhook-signature.ts`

**Step 1: Create the file** — copy verbatim:

```typescript
/**
 * Webhook Signature Utilities
 *
 * HMAC-SHA256 signing for outbound webhook deliveries.
 * Follows the standard webhook signature pattern used by Stripe, GitHub, etc.
 */

import crypto from 'crypto';

const SECRET_PREFIX = 'whsec_';

/**
 * Generate a new webhook signing secret.
 * Returns a prefixed hex string: "whsec_<32 random bytes hex>"
 */
export function generateWebhookSecret(): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `${SECRET_PREFIX}${secret}`;
}

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 *
 * @param secret - The webhook signing secret (with or without whsec_ prefix)
 * @param body - The raw request body string
 * @param timestamp - Optional timestamp for replay protection
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function computeWebhookSignature(secret: string, body: string, timestamp?: string): string {
  const rawSecret = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;

  const signedContent = timestamp ? `${timestamp}.${body}` : body;

  return crypto.createHmac('sha256', rawSecret).update(signedContent, 'utf8').digest('hex');
}

/**
 * Build the standard webhook signature headers.
 */
export function buildSignatureHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeWebhookSignature(secret, body, timestamp);

  return {
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
    'x-webhook-id': crypto.randomUUID(),
  };
}
```

---

### Task 3: Update shared-kernel security index.ts

**Files:**

- Modify: `packages/shared-kernel/src/security/index.ts`

**Step 1: Add exports** for both new files at the end of the existing file:

```typescript
// Inbound channel authentication
export { extractIngressToken, tokensMatch } from './inbound-auth.js';

// Webhook signature utilities
export {
  generateWebhookSecret,
  computeWebhookSignature,
  buildSignatureHeaders,
} from './webhook-signature.js';
```

---

### Task 4: Move and update the inbound-auth test

**Files:**

- Create: `packages/shared-kernel/src/security/__tests__/inbound-auth.test.ts`
- Delete: `apps/runtime/src/__tests__/inbound-auth.test.ts`

**Step 1: Create the test in shared-kernel** — copy the existing test but update the import:

```typescript
import { describe, it, expect } from 'vitest';
import { extractIngressToken, tokensMatch } from '../inbound-auth.js';

describe('extractIngressToken', () => {
  it('returns x-channel-secret header when present', () => {
    expect(extractIngressToken({ 'x-channel-secret': 'secret-a' })).toBe('secret-a');
  });

  it('returns x-ingress-secret header when present', () => {
    expect(extractIngressToken({ 'x-ingress-secret': 'secret-b' })).toBe('secret-b');
  });

  it('returns x-webhook-secret header when present', () => {
    expect(extractIngressToken({ 'x-webhook-secret': 'secret-c' })).toBe('secret-c');
  });

  it('prefers x-channel-secret over Authorization header', () => {
    expect(
      extractIngressToken({ 'x-channel-secret': 'explicit', authorization: 'Bearer bearer-tok' }),
    ).toBe('explicit');
  });

  it('extracts Bearer token from Authorization header', () => {
    expect(extractIngressToken({ authorization: 'Bearer my-token-123' })).toBe('my-token-123');
  });

  it('falls back to query param token when no headers match', () => {
    expect(extractIngressToken({}, 'query-tok')).toBe('query-tok');
  });

  it('returns null when nothing is provided', () => {
    expect(extractIngressToken({})).toBeNull();
  });

  it('returns null for empty string query param', () => {
    expect(extractIngressToken({}, '')).toBeNull();
  });

  it('trims whitespace from query param', () => {
    expect(extractIngressToken({}, '  trimmed  ')).toBe('trimmed');
  });

  it('handles array header values by using first element', () => {
    expect(extractIngressToken({ 'x-channel-secret': ['first', 'second'] })).toBe('first');
  });
});

describe('tokensMatch', () => {
  it('returns true for identical tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different tokens of same length', () => {
    expect(tokensMatch('aaaaaa', 'bbbbbb')).toBe(false);
  });

  it('returns false for different length tokens', () => {
    expect(tokensMatch('short', 'much-longer-token')).toBe(false);
  });

  it('returns false when provided token is null', () => {
    expect(tokensMatch(null, 'expected')).toBe(false);
  });

  it('returns false when expected token is null', () => {
    expect(tokensMatch('provided', null)).toBe(false);
  });

  it('returns false when both are null', () => {
    expect(tokensMatch(null, null)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(tokensMatch('Token', 'token')).toBe(false);
  });

  it('works with a realistic 64-char hex secret', () => {
    const secret = 'a'.repeat(64);
    expect(tokensMatch(secret, secret)).toBe(true);
    expect(tokensMatch(secret, 'b'.repeat(64))).toBe(false);
  });
});
```

**Step 2: Run shared-kernel tests to verify they pass**

```bash
pnpm --filter @agent-platform/shared-kernel test
```

Expected: all inbound-auth tests pass.

**Step 3: Delete the original test file**

```bash
rm apps/runtime/src/__tests__/inbound-auth.test.ts
```

---

### Task 5: Update runtime import sites — inbound-auth (4 files)

**Files:**

- Modify: `apps/runtime/src/routes/channel-genesys.ts`
- Modify: `apps/runtime/src/routes/channel-audiocodes.ts`
- Modify: `apps/runtime/src/routes/channel-vxml.ts`
- Modify: `apps/runtime/src/services/voice/korevg/korevg-router.ts`

For each file, replace:

```typescript
import { extractIngressToken, tokensMatch } from '../channels/security/inbound-auth.js';
```

with:

```typescript
import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security';
```

Note: `korevg-router.ts` has a deeper relative path (`../../../channels/security/inbound-auth.js`) — apply the same substitution.

---

### Task 6: Update runtime import site — webhook-signature (1 file)

**Files:**

- Modify: `apps/runtime/src/routes/http-async-channel.ts`

Replace:

```typescript
import { generateWebhookSecret } from '../channels/security/webhook-signature.js';
```

with:

```typescript
import { generateWebhookSecret } from '@agent-platform/shared-kernel/security';
```

If `http-async-channel.ts` also imports other items from `webhook-signature.js`, include them in the same import statement.

---

### Task 7: Delete the original source files

```bash
rm apps/runtime/src/channels/security/inbound-auth.ts
rm apps/runtime/src/channels/security/webhook-signature.ts
```

`callback-url-policy.ts` stays — it has a `createLogger` dependency on `@abl/compiler/platform` and is runtime-specific.

---

### Task 8: Build shared-kernel and runtime, run tests, commit

**Step 1: Build**

```bash
pnpm build --filter @agent-platform/shared-kernel --filter @agent-platform/runtime
```

Expected: zero TypeScript errors.

**Step 2: Run tests**

```bash
pnpm --filter @agent-platform/shared-kernel test
pnpm --filter @agent-platform/runtime test
```

Expected: all pass. No test should reference the deleted files.

**Step 3: Format changed files**

```bash
npx prettier --write \
  packages/shared-kernel/src/security/inbound-auth.ts \
  packages/shared-kernel/src/security/webhook-signature.ts \
  packages/shared-kernel/src/security/index.ts \
  packages/shared-kernel/src/security/__tests__/inbound-auth.test.ts \
  apps/runtime/src/routes/channel-genesys.ts \
  apps/runtime/src/routes/channel-audiocodes.ts \
  apps/runtime/src/routes/channel-vxml.ts \
  apps/runtime/src/routes/http-async-channel.ts \
  apps/runtime/src/services/voice/korevg/korevg-router.ts
```

**Step 4: Commit**

```bash
git add \
  packages/shared-kernel/src/security/inbound-auth.ts \
  packages/shared-kernel/src/security/webhook-signature.ts \
  packages/shared-kernel/src/security/index.ts \
  packages/shared-kernel/src/security/__tests__/inbound-auth.test.ts \
  apps/runtime/src/routes/channel-genesys.ts \
  apps/runtime/src/routes/channel-audiocodes.ts \
  apps/runtime/src/routes/channel-vxml.ts \
  apps/runtime/src/routes/http-async-channel.ts \
  apps/runtime/src/services/voice/korevg/korevg-router.ts
git rm apps/runtime/src/__tests__/inbound-auth.test.ts
git rm apps/runtime/src/channels/security/inbound-auth.ts
git rm apps/runtime/src/channels/security/webhook-signature.ts
git commit -m "feat(shared-kernel): move inbound-auth and webhook-signature to shared-kernel/security"
```

---

## Part 2: Security-Repo Consolidation

### Task 9: Add NormalizedEnvironmentVariable type to shared-kernel

**Files:**

- Modify: `packages/shared-kernel/src/types/security.ts`
- Modify: `packages/shared-kernel/src/index.ts`

**Step 1: Add the type** to `packages/shared-kernel/src/types/security.ts` at the end:

```typescript
export interface NormalizedEnvironmentVariable {
  id: string;
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  updatedBy: string | null;
  createdBy: string;
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}
```

**Step 2: Export from shared-kernel index.ts** — add to the existing security types export block:

```typescript
export type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
  NormalizedEnvironmentVariable, // add this line
} from './types/security.js';
```

**Step 3: Update `packages/shared/src/types/security.ts`** — this file re-exports only specific named types from shared-kernel. Add `NormalizedEnvironmentVariable` to the list:

```typescript
export type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
  NormalizedEnvironmentVariable, // add this line
} from '@agent-platform/shared-kernel';
```

Without this step, `packages/shared/src/repos/security-repo.ts` cannot find the type even though it lives in shared-kernel, because it imports via `'../types/security.js'` not directly from the kernel.

---

### Task 10: Add EnvironmentVariable tests to shared security-repo test file

**Files:**

- Modify: `packages/shared/src/__tests__/security-repo.test.ts`

**Step 1: Add mock model for EnvironmentVariable** — in the mock setup section alongside the existing mocks:

```typescript
const mockEnvironmentVariable: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
};
```

**Step 2: Add EnvironmentVariable to the vi.mock call** — update the existing mock:

```typescript
vi.mock('@agent-platform/database/models', () => ({
  ToolSecret: mockToolSecret,
  OrgProxyConfig: mockOrgProxyConfig,
  EndUserOAuthToken: mockEndUserOAuthToken,
  EnvironmentVariable: mockEnvironmentVariable, // add this
}));
```

**Step 3: Add test data constant**:

```typescript
const ENV_VAR_RAW = {
  _id: 'ev-id-1',
  tenantId: TENANT_A,
  projectId: 'proj-1',
  environment: 'production',
  key: 'API_KEY',
  encryptedValue: 'enc-val',
  isSecret: true,
  description: 'The API key',
  updatedBy: null,
  createdBy: 'user-1',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  toObject: () => ({ ...ENV_VAR_RAW }),
};
```

**Step 4: Add test suite** at the end of the file:

```typescript
describe('security-repo: Environment Variables', () => {
  beforeEach(() => {
    mockEnvironmentVariable.find.mockReset();
    mockEnvironmentVariable.findOne.mockReset();
    mockEnvironmentVariable.create.mockReset();
    mockEnvironmentVariable.deleteOne.mockReset();
    mockEnvironmentVariable.countDocuments.mockReset();
  });

  test('createEnvironmentVariable returns normalized doc', async () => {
    const created = { ...ENV_VAR_RAW, toObject: () => ({ ...ENV_VAR_RAW }) };
    mockEnvironmentVariable.create.mockResolvedValue(created);
    const result = await securityRepo.createEnvironmentVariable({
      tenantId: TENANT_A,
      projectId: 'proj-1',
      environment: 'production',
      key: 'API_KEY',
      encryptedValue: 'enc-val',
      isSecret: true,
      description: 'The API key',
      createdBy: 'user-1',
    });
    expect(result.id).toBe('ev-id-1');
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.key).toBe('API_KEY');
  });

  test('findEnvironmentVariables returns normalized array', async () => {
    // No options passed → find() result goes straight to .lean(), no skip/limit/select
    mockEnvironmentVariable.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([ENV_VAR_RAW]),
    });
    const results = await securityRepo.findEnvironmentVariables({ tenantId: TENANT_A });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('ev-id-1');
  });

  test('findEnvironmentVariableById enforces tenantId', async () => {
    mockEnvironmentVariable.findOne.mockResolvedValue(null);
    const result = await securityRepo.findEnvironmentVariableById('ev-id-1', 'other-tenant');
    expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
      _id: 'ev-id-1',
      tenantId: 'other-tenant',
    });
    expect(result).toBeNull();
  });

  test('deleteEnvironmentVariable enforces tenantId', async () => {
    mockEnvironmentVariable.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await securityRepo.deleteEnvironmentVariable('ev-id-1', TENANT_A);
    expect(mockEnvironmentVariable.deleteOne).toHaveBeenCalledWith({
      _id: 'ev-id-1',
      tenantId: TENANT_A,
    });
  });
});
```

**Step 5: Run tests to verify they FAIL** (implementation not added yet):

```bash
pnpm --filter @agent-platform/shared test
```

Expected: test suite errors with "securityRepo.createEnvironmentVariable is not a function" or similar.

---

### Task 11: Add EnvironmentVariable operations to shared security-repo

**Files:**

- Modify: `packages/shared/src/repos/security-repo.ts`

**Step 1: Add the import** for `NormalizedEnvironmentVariable` at the top with the existing type imports:

```typescript
import type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
  NormalizedEnvironmentVariable,
} from '../types/security.js';
```

Note: `../types/security.js` re-exports from `@agent-platform/shared-kernel`, so `NormalizedEnvironmentVariable` is available there after Task 9.

**Step 2: Add a normalize helper** alongside the existing ones:

```typescript
function normalizeEnvVar(doc: IEnvironmentVariable | null): NormalizedEnvironmentVariable | null {
  return normalizeDocument(doc) as NormalizedEnvironmentVariable | null;
}
```

But first add the `IEnvironmentVariable` import — update the database models import at the top:

```typescript
import type {
  IToolSecret,
  IOrgProxyConfig,
  IEndUserOAuthToken,
  IEnvironmentVariable,
} from '@agent-platform/database/models';
```

**Step 3: Add EnvironmentVariable interface types and functions** at the end of the file:

```typescript
// ─── Environment Variables ───────────────────────────────────────────────

export interface EnvironmentVariableCreateData {
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  createdBy: string;
}

export interface EnvironmentVariableFilter {
  tenantId: string;
  projectId?: string;
  environment?: string;
  key?: string;
}

export async function createEnvironmentVariable(
  data: EnvironmentVariableCreateData,
): Promise<NormalizedEnvironmentVariable> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.create(data);
  const normalized = normalizeEnvVar(doc.toObject());
  if (!normalized) throw new Error('Failed to normalize created environment variable');
  return normalized;
}

export async function findEnvironmentVariables(
  filter: EnvironmentVariableFilter,
  options?: { select?: Record<string, number | boolean>; skip?: number; take?: number },
): Promise<NormalizedEnvironmentVariable[]> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  let query = EnvironmentVariable.find(filter);
  if (options?.select) query = query.select(options.select);
  if (options?.skip) query = query.skip(options.skip);
  if (options?.take) query = query.limit(options.take);
  const docs = await query.lean();
  return docs.map((doc: IEnvironmentVariable) => {
    const normalized = normalizeEnvVar(doc);
    if (!normalized) throw new Error('Failed to normalize environment variable');
    return normalized;
  });
}

export async function countEnvironmentVariables(
  filter: EnvironmentVariableFilter,
): Promise<number> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  return EnvironmentVariable.countDocuments(filter);
}

export async function findEnvironmentVariableById(
  id: string,
  tenantId: string,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.findOne({ _id: id, tenantId }).lean();
  return normalizeEnvVar(doc);
}

export async function findEnvironmentVariableByKey(
  tenantId: string,
  projectId: string,
  environment: string,
  key: string,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.findOne({ tenantId, projectId, environment, key }).lean();
  return normalizeEnvVar(doc);
}

export async function updateEnvironmentVariable(
  id: string,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await EnvironmentVariable.findOne({ _id: id, tenantId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeEnvVar(doc.toObject());
}

export async function deleteEnvironmentVariable(id: string, tenantId: string): Promise<void> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  await EnvironmentVariable.deleteOne({ _id: id, tenantId });
}

export async function bulkUpsertEnvironmentVariables(
  tenantId: string,
  projectId: string,
  targetEnvironment: string,
  variables: Array<{
    key: string;
    encryptedValue: string;
    isSecret: boolean;
    description: string | null;
  }>,
  userId: string,
  overwrite: boolean,
): Promise<{ upserted: number; matched: number }> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');

  // Use findOne + save/create so the encryption plugin's pre-save hook fires.
  // bulkWrite bypasses Mongoose middleware, storing plaintext in DB.
  // Process in parallel batches of 10 to limit DB connection pressure.
  let upserted = 0;
  let matched = 0;

  const BATCH_SIZE = 10;
  for (let i = 0; i < variables.length; i += BATCH_SIZE) {
    const batch = variables.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (v) => {
        const existing = await EnvironmentVariable.findOne({
          tenantId,
          projectId,
          environment: targetEnvironment,
          key: v.key,
        });

        if (existing) {
          if (overwrite) {
            existing.set('encryptedValue', v.encryptedValue);
            existing.set('isSecret', v.isSecret);
            existing.set('description', v.description);
            existing.set('updatedBy', userId);
            await existing.save();
          }
          return 'matched' as const;
        } else {
          await EnvironmentVariable.create({
            tenantId,
            projectId,
            environment: targetEnvironment,
            key: v.key,
            encryptedValue: v.encryptedValue,
            isSecret: v.isSecret,
            description: v.description,
            createdBy: userId,
          });
          return 'upserted' as const;
        }
      }),
    );

    for (const r of results) {
      if (r === 'matched') matched++;
      else upserted++;
    }
  }

  return { upserted, matched };
}
```

**Step 4: Run tests to verify they now pass**:

```bash
pnpm --filter @agent-platform/shared test
```

Expected: all pass including the new EnvironmentVariable suite.

---

### Task 12: Export EnvironmentVariable functions from shared repos barrel

**Files:**

- Modify: `packages/shared/src/repos/index.ts`

**Step 1: Add exports** at the end of the security-repo export block:

```typescript
// (existing security repo exports above)
export {
  createToolSecret,
  findToolSecrets,
  countToolSecrets,
  findToolSecretById,
  updateToolSecret,
  deleteToolSecret,
  createOrgProxyConfig,
  findOrgProxyConfigs,
  countOrgProxyConfigs,
  findOrgProxyConfigById,
  updateOrgProxyConfig,
  deleteOrgProxyConfig,
  findEndUserOAuthTokens,
  countEndUserOAuthTokens,
  // add these:
  createEnvironmentVariable,
  findEnvironmentVariables,
  countEnvironmentVariables,
  findEnvironmentVariableById,
  findEnvironmentVariableByKey,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  bulkUpsertEnvironmentVariables,
} from './security-repo.js';
export type {
  ToolSecretFilter,
  ToolSecretUpdateData,
  OrgProxyConfigCreateData,
  OrgProxyConfigFilter,
  // add these:
  EnvironmentVariableCreateData,
  EnvironmentVariableFilter,
} from './security-repo.js';
```

---

### Task 13: Replace runtime security-repo with re-export barrel

**Files:**

- Modify: `apps/runtime/src/repos/security-repo.ts`

**Step 1: Replace the entire file contents** with explicit named re-exports from the `./repos` subpath (avoids wildcard leakage and works with the defined package exports):

```typescript
/**
 * Security Repository
 *
 * @deprecated Import directly from @agent-platform/shared/repos.
 * This file re-exports the canonical security repository from the shared package
 * for backwards compatibility with existing runtime import sites.
 */
export {
  createToolSecret,
  findToolSecrets,
  countToolSecrets,
  findToolSecretById,
  updateToolSecret,
  deleteToolSecret,
  createOrgProxyConfig,
  findOrgProxyConfigs,
  countOrgProxyConfigs,
  findOrgProxyConfigById,
  updateOrgProxyConfig,
  deleteOrgProxyConfig,
  findEndUserOAuthTokens,
  countEndUserOAuthTokens,
  createEnvironmentVariable,
  findEnvironmentVariables,
  countEnvironmentVariables,
  findEnvironmentVariableById,
  findEnvironmentVariableByKey,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  bulkUpsertEnvironmentVariables,
} from '@agent-platform/shared/repos';
export type {
  ToolSecretFilter,
  ToolSecretUpdateData,
  OrgProxyConfigCreateData,
  OrgProxyConfigFilter,
  EnvironmentVariableCreateData,
  EnvironmentVariableFilter,
} from '@agent-platform/shared/repos';
```

---

### Task 14: Build and test everything, commit

**Step 1: Build full dependency chain**

```bash
pnpm build --filter @agent-platform/shared-kernel --filter @agent-platform/shared --filter @agent-platform/runtime
```

Expected: zero TypeScript errors across all three packages.

**Step 2: Run all tests**

```bash
pnpm --filter @agent-platform/shared-kernel test
pnpm --filter @agent-platform/shared test
pnpm --filter @agent-platform/runtime test
```

Expected: all pass. The runtime `repos-data.test.ts` which mocks `../repos/security-repo.js` will continue working since the re-export barrel forwards all the same function names.

**Step 3: Format all changed files**

```bash
npx prettier --write \
  packages/shared-kernel/src/types/security.ts \
  packages/shared-kernel/src/index.ts \
  packages/shared/src/repos/security-repo.ts \
  packages/shared/src/repos/index.ts \
  apps/runtime/src/repos/security-repo.ts
```

**Step 4: Commit**

```bash
git add \
  packages/shared-kernel/src/types/security.ts \
  packages/shared-kernel/src/index.ts \
  packages/shared/src/repos/security-repo.ts \
  packages/shared/src/repos/index.ts \
  packages/shared/src/__tests__/security-repo.test.ts \
  apps/runtime/src/repos/security-repo.ts
git commit -m "feat(shared): consolidate security-repo — add EnvironmentVariable ops, replace runtime duplicate with re-export"
```

---

## Final Verification

```bash
pnpm build
pnpm test
```

Both should complete with zero errors. The channel security utilities are now in shared-kernel and the runtime duplicate security-repo is gone.
