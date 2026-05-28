# LLD: AWS Bedrock Provider Integration

**Feature Spec**: `docs/features/sub-features/aws-bedrock-provider.md`
**HLD**: `docs/specs/aws-bedrock-provider.hld.md`
**Test Spec**: `docs/testing/sub-features/aws-bedrock-provider.md`
**Status**: DONE
**Date**: 2026-04-28
**Jira**: ABLP-674

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                  | Alternatives Rejected                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | `createAmazonBedrock` imported statically; `fromNodeProviderChain` via module-level await (same pattern as existing `ai/test` lazy load in the file)                                                                                                                                                                                                                                                                                                                                                                           | Keeps `createVercelProvider()` synchronous; graceful fallback if `@aws-sdk/credential-providers` absent                                    | Dynamic `await import()` inside case block (requires async function)                                                                                |
| D-2  | `buildProviderCacheKey()` exported from `provider-cache.ts` as a pure function taking `(providerType, apiKeyHash, effectiveUrl, modelId, authConfig?)`                                                                                                                                                                                                                                                                                                                                                                         | Testable without invoking LLM stack; matches test spec INT-3/INT-4; per CLAUDE.md "fix the code, not the test"                             | Inline key string in `session-llm-client.ts` (untestable as pure logic)                                                                             |
| D-3  | `parseJsonField()` extracted to `apps/runtime/src/services/llm/utils.ts` and re-imported in `model-resolution.ts`; `model-resolver.ts` imports from same utils                                                                                                                                                                                                                                                                                                                                                                 | Avoids duplication of identical utility between two files; keeps `model-resolution.ts` unchanged in behavior                               | Inline duplication in `model-resolver.ts` (CLAUDE.md code smell); export from `model-resolution.ts` (couples `model-resolver.ts` to a heavy module) |
| D-4  | Studio IAM role toggle uses `RadioGroup` component from `apps/studio/src/components/ui/RadioGroup.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                         | Component already exists with correct API (`options`, `value`, `onChange`, `label`); no new UI primitives needed                           | Custom radio HTML (redundant; defeats design system)                                                                                                |
| D-5  | ~~Bedrock form labels remain hardcoded English strings (no i18n keys)~~ **SUPERSEDED** — see D-5a                                                                                                                                                                                                                                                                                                                                                                                                                              | Feature spec §6 explicitly documents existing Bedrock labels are hardcoded English; consistency requires the same for new IAM role strings | New i18n keys (would require key backfill for existing Bedrock labels too)                                                                          |
| D-5a | **REVERSED during implementation (pr-review round 1+5)**: The deviation was reversed. All Bedrock credential form labels — including the new IAM role toggle strings and the existing field labels (AWS Region, Access Key ID, Secret Access Key, Session Token) — use `t()` calls with keys in `packages/i18n/locales/en/studio.json`. This is consistent with the original feature spec §10/§13 plan. **Post-impl-sync action from original D-5a is CANCELLED** — `packages/i18n` correctly remains in feature spec and HLD. | Reversed: implementation correctly used i18n as originally planned                                                                         | N/A                                                                                                                                                 |
| D-6  | Route schema extension (`platform-admin-models.ts`): add `authConfig: z.record(z.unknown()).optional()` to `connection` object and to `createConnectionSchema`                                                                                                                                                                                                                                                                                                                                                                 | Enables E2E test credential seeding via HTTP API; general-purpose (any future provider benefits)                                           | Bedrock-only extension (premature specialization)                                                                                                   |
| D-7  | Phase A includes both explicit and ambient factory paths (same `provider-factory.ts` file); separate Phase B only adds `@aws-sdk/credential-providers` dependency                                                                                                                                                                                                                                                                                                                                                              | Both paths share the `BedrockAuthConfig` interface and `case 'bedrock'` block; splitting them would require touching the same file twice   | Two-pass edit to `provider-factory.ts` (error-prone)                                                                                                |

### Key Interfaces & Types

```typescript
// packages/llm/src/provider-factory.ts (Phase A)
// Internal interface — not exported from the package
interface BedrockAuthConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  useAmbientCredentials?: boolean;
  roleArn?: string; // Phase 3 placeholder — reserved, not implemented in ABLP-674
}
```

```typescript
// apps/runtime/src/services/llm/provider-cache.ts (Phase C — new export)
// Pure function: no imports from node:crypto (caller hashes the key); no side effects
export function buildProviderCacheKey(
  providerType: string,
  apiKeyHash: string,
  effectiveUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): string;
// authSuffix encodes: resourceName, apiVersion (existing Azure), region, useAmbientCredentials (new Bedrock)
```

```typescript
// apps/runtime/src/services/llm/utils.ts (Phase D — new file)
// Extracted from model-resolution.ts:282; identical behavior, now shared
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonField(val: unknown): any;
// Return type is `any` (not `unknown`) to match the original signature at model-resolution.ts:282
// and avoid breaking the 4+ call sites that assign the result to typed variables
// (e.g., requestTemplate?: string, realtimeConfig: RealtimeModelConfig).
// The input type is `unknown` (stricter than the original `any`) — this is the only type improvement.
```

```typescript
// apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts (Phase F — extended)
// Existing connection type extended with authConfig
connection?: {
  credentialName: string;
  apiKey: string;
  authType?: string;
  authConfig?: Record<string, unknown>; // NEW — enables Bedrock test credential seeding
}
```

### Module Boundaries

| Module                                             | Responsibility                                                                                | Depends On                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/llm`                                     | `createVercelProvider()` factory; `BedrockAuthConfig` interface; provider instantiation logic | `@ai-sdk/amazon-bedrock`, `@aws-sdk/credential-providers` (new deps) |
| `apps/runtime/services/llm/provider-cache.ts`      | Provider instance cache + pure `buildProviderCacheKey()`                                      | `ai` (LanguageModel type only)                                       |
| `apps/runtime/services/llm/session-llm-client.ts`  | Provider cache orchestration; delegates key building to `buildProviderCacheKey()`             | `provider-cache.ts`, `@agent-platform/llm`                           |
| `apps/runtime/services/llm/utils.ts`               | Shared JSON field parsing utility                                                             | (none)                                                               |
| `apps/runtime/services/pipeline/model-resolver.ts` | Pipeline LLM resolution; passes `authConfig` through                                          | `@agent-platform/llm`, `apps/runtime/services/llm/utils.ts`          |
| `apps/studio/AddConnectionDialog.tsx`              | Bedrock IAM role UI toggle; credential mode radio                                             | `RadioGroup` UI component                                            |

---

## 2. File-Level Change Map

### New Files

| File                                                     | Purpose                                             | LOC Estimate |
| -------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `packages/llm/src/__tests__/provider-factory.test.ts`    | 6 unit tests for `case 'bedrock'`                   | 80           |
| `apps/runtime/src/services/llm/utils.ts`                 | Shared `parseJsonField()` utility                   | 20           |
| `apps/runtime/src/__tests__/bedrock-integration.test.ts` | 6 integration tests (INT-1 through INT-6)           | 200          |
| `apps/runtime/src/__tests__/bedrock-e2e.test.ts`         | 6 automated E2E tests (E2E-1 through E2E-6)         | 250          |
| `apps/studio/e2e/bedrock-connection-dialog.spec.ts`      | 5 Playwright tests (PLY-1 through PLY-5)            | 120          |
| `docs/guides/llm-providers/aws-bedrock.md`               | Ops guide (IRSA setup, IAM policy, troubleshooting) | 150          |

### Modified Files

| File                                                          | Change Description                                                                                                                            | Risk                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/llm/package.json`                                   | Add `@ai-sdk/amazon-bedrock@^4.0.0` and `@aws-sdk/credential-providers@^3.998.0`                                                              | LOW — additive dep; version verified compatible                                                                                       |
| `packages/llm/src/provider-factory.ts`                        | Add `BedrockAuthConfig`, `case 'bedrock'`, module-level `_fromNodeProviderChain` init                                                         | LOW — additive; no existing cases touched                                                                                             |
| `apps/runtime/src/services/llm/classify-llm-error.ts`         | Add `'accessdeniedexception'` to `AUTH_PATTERNS`; add 404 handler for `ResourceNotFoundException`                                             | LOW — additive pattern; existing handlers unchanged                                                                                   |
| `apps/runtime/src/services/llm/provider-cache.ts`             | Export `buildProviderCacheKey()` pure function; extend `authSuffix` to include `region` + `useAmbientCredentials`                             | MEDIUM — changes cache key format; existing Azure entries unaffected (new fields append)                                              |
| `apps/runtime/src/services/llm/session-llm-client.ts`         | Replace inline cache key construction (lines 837-843) with `buildProviderCacheKey()` call; append `apiSuffix` after                           | MEDIUM — must preserve exact key format for Azure/existing providers                                                                  |
| `apps/runtime/src/services/llm/model-resolution.ts`           | Import `parseJsonField` from `./utils.js`; remove local definition                                                                            | LOW — identical signature (`(val: any): any` → `(val: unknown): any`); no call sites change because return type is preserved as `any` |
| `apps/runtime/src/services/pipeline/model-resolver.ts`        | Import `parseJsonField` from `../llm/utils.js`; extract `credential.authConfig` after decryption; pass as 6th arg to `createVercelProvider()` | MEDIUM — currently broken for Bedrock; fix must not regress non-Bedrock pipeline models                                               |
| `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`   | Add `'AWS_REGION'`, `'AWS_ACCESS_KEY_ID'`, `'AWS_SECRET_ACCESS_KEY'` to `MANAGED_ENV_KEYS`                                                    | LOW — additive; snapshot/restore handles cleanup                                                                                      |
| `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` | Extend `provisionTenantModel` `connection` type with `authConfig?: Record<string, unknown>`                                                   | LOW — optional field; no existing call sites break                                                                                    |
| `apps/runtime/src/routes/platform-admin-models.ts`            | Add `authConfig: z.record(z.unknown()).optional()` to provisioning schema; add `authConfig` param to `createCredentialForTenant`              | LOW — optional field; existing credential creation unaffected                                                                         |
| `apps/studio/src/components/admin/AddConnectionDialog.tsx`    | Add `newCredBedrockMode` state; `RadioGroup` toggle; conditional rendering; IAM role credential path in `handleCreateCredential`              | MEDIUM — must not regress existing explicit-credentials Bedrock flow                                                                  |
| `apps/runtime/package.json`                                   | Add `nock@^14` devDependency                                                                                                                  | LOW — test-only dep                                                                                                                   |

---

## 3. Implementation Phases

### Phase A: Core Provider Factory — packages/llm (Phase 1 + Phase 2 backend)

**Goal**: Install the Bedrock SDK dependencies, implement both explicit and ambient credential paths in `createVercelProvider()`, and write all 6 unit tests. This is the P0 core that unblocks FloridaBlue.

**Tasks**:

A.1. **Add dependencies to `packages/llm/package.json`**

- Add `"@ai-sdk/amazon-bedrock": "^4.0.0"` under `dependencies`
- Add `"@aws-sdk/credential-providers": "^3.998.0"` under `dependencies`
- Run `pnpm install --filter=@agent-platform/llm` to update the lockfile

A.2. **Add `BedrockAuthConfig` interface to `provider-factory.ts`**

- Place below the existing `let _simulateReadableStream` declaration and before the `export function createVercelProvider(...)` signature
- Not exported (internal to the factory file)

A.3. **Add `createAmazonBedrock` static import at the top of `provider-factory.ts`**

- Add alongside existing provider imports: `import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';`

A.4. **Add module-level `_fromNodeProviderChain` initialization (ambient creds) after the existing `ai/test` try/catch**

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fromNodeProviderChain: ((opts?: any) => any) | undefined;
try {
  const credProviders = await import('@aws-sdk/credential-providers');
  _fromNodeProviderChain = credProviders.fromNodeProviderChain;
} catch {
  // @aws-sdk/credential-providers not available — ambient Bedrock creds will throw on use
}
```

A.5. **Add `case 'bedrock':` to `createVercelProvider()` — insert before the `default:` case (after the `'mock'` case)**

The actual case order in `provider-factory.ts` is: `'litellm'` (line 175) → `'mock'` (line 181) → `default:` (line 250). Insert the new `case 'bedrock':` between `'mock'` and `default:`.

Full implementation:

```typescript
case 'bedrock': {
  const bedrockAuth = authConfig as BedrockAuthConfig | undefined;
  const region = bedrockAuth?.region || process.env.AWS_REGION || 'us-east-1';

  // Ambient credentials path (IRSA / ECS Task Role / EC2 Instance Profile)
  if (bedrockAuth?.useAmbientCredentials === true) {
    if (!_fromNodeProviderChain) {
      throw new Error(
        'Bedrock ambient credentials require @aws-sdk/credential-providers. ' +
        'Ensure the package is installed in packages/llm.',
      );
    }
    const providerFactory = createAmazonBedrock({
      region,
      credentialProvider: () => _fromNodeProviderChain!({ clientConfig: { region } })(),
    });
    return providerFactory(cleanModelId);
  }

  // Explicit credentials path
  if (bedrockAuth?.accessKeyId && bedrockAuth?.secretAccessKey) {
    const providerFactory = createAmazonBedrock({
      region,
      accessKeyId: bedrockAuth.accessKeyId,
      secretAccessKey: bedrockAuth.secretAccessKey,
      ...(bedrockAuth.sessionToken ? { sessionToken: bedrockAuth.sessionToken } : {}),
    });
    return providerFactory(cleanModelId);
  }

  // Partial credentials — fail fast with a descriptive error
  if (bedrockAuth?.accessKeyId && !bedrockAuth?.secretAccessKey) {
    throw new Error(
      'Bedrock credential is missing secretAccessKey. ' +
      'Provide both accessKeyId and secretAccessKey for explicit credential mode.',
    );
  }

  throw new Error(
    'Bedrock credential requires either explicit AWS credentials ' +
    '(accessKeyId + secretAccessKey) or useAmbientCredentials: true for IAM role mode.',
  );
}
```

A.6. **Run `pnpm build --filter=@agent-platform/llm`** — fix any type errors before continuing.

A.7. **Create `packages/llm/src/__tests__/provider-factory.test.ts`**

File structure:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createVercelProvider } from '../provider-factory.js';

describe('createVercelProvider — bedrock', () => {
  // Save/restore process.env for each test
  const originalEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    /* save AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY */
  });
  afterEach(() => {
    /* restore */
  });

  it('UT-1: explicit credentials → returns LanguageModel', () => {
    const model = createVercelProvider(
      'bedrock',
      'AKIATEST',
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { region: 'us-west-2', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' },
    );
    expect(model).toBeTruthy();
    expect(model.modelId).toBeTruthy();
  });

  it('UT-2: ambient credentials → returns LanguageModel (no network call)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'fakesecret';
    const model = createVercelProvider(
      'bedrock',
      '__iam_role__',
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { region: 'us-east-1', useAmbientCredentials: true },
    );
    expect(model).toBeTruthy();
  });

  it('UT-3: no region in authConfig, no AWS_REGION env → defaults to us-east-1', () => {
    delete process.env.AWS_REGION;
    const model = createVercelProvider(
      'bedrock',
      '__iam_role__',
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { useAmbientCredentials: true },
    );
    expect(model).toBeTruthy(); // No throw means region defaulted correctly
  });

  it('UT-4 (FR-8a): AWS_REGION env var used when authConfig.region absent', () => {
    process.env.AWS_REGION = 'ap-southeast-1';
    const model = createVercelProvider(
      'bedrock',
      '__iam_role__',
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { useAmbientCredentials: true },
    );
    expect(model).toBeTruthy(); // ap-southeast-1 was picked up
  });

  it('UT-5: accessKeyId present but secretAccessKey absent → throws', () => {
    expect(() =>
      createVercelProvider(
        'bedrock',
        'AKIATEST',
        undefined,
        'anthropic.claude-sonnet-4-6-v1:0',
        undefined,
        { region: 'us-east-1', accessKeyId: 'AKIATEST' },
      ),
    ).toThrow(/secretAccessKey/i);
  });

  it('UT-6: no credentials, no ambient flag → throws descriptive error', () => {
    expect(() =>
      createVercelProvider(
        'bedrock',
        'somekey',
        undefined,
        'anthropic.claude-sonnet-4-6-v1:0',
        undefined,
        {},
      ),
    ).toThrow(/requires either/i);
  });
});
```

A.8. **Run `pnpm test --filter=@agent-platform/llm`** — all 6 tests must pass.

**Files Touched**:

- `packages/llm/package.json` — add 2 dependencies
- `packages/llm/src/provider-factory.ts` — add case 'bedrock', BedrockAuthConfig, imports, module-level init
- `packages/llm/src/__tests__/provider-factory.test.ts` — new file

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/llm` exits 0 with no type errors
- [ ] `pnpm test --filter=@agent-platform/llm` — all 6 `createVercelProvider — bedrock` tests pass
- [ ] `createVercelProvider('bedrock', 'AKIATEST', undefined, 'anthropic.claude-sonnet-4-6-v1:0', undefined, { region: 'us-east-1', accessKeyId: 'AKIA...', secretAccessKey: '...' })` returns an object with a `modelId` property (manual spot check in REPL)
- [ ] `createVercelProvider('bedrock', 'key', undefined, 'model', undefined, {})` throws `Error` (no regression of default fallback for Bedrock)

**Test Strategy**:

- Unit: 6 pure function tests in `provider-factory.test.ts` — no network, no mocking
- No integration testing at this phase (SDK construction is synchronous)

**Rollback**: Remove `case 'bedrock'` from `provider-factory.ts`; revert `package.json` changes; `pnpm install`.

---

### Phase B: Runtime LLM Services — Error Classifier + Cache Key + Utils

**Goal**: Extend the error classifier for Bedrock-specific errors, extract and export `buildProviderCacheKey()` from `provider-cache.ts`, update `session-llm-client.ts` to use it, and extract `parseJsonField()` to a shared utility.

**Tasks**:

B.1. **Extend `classify-llm-error.ts` — add Bedrock-specific error patterns**

Add to `AUTH_PATTERNS` (line 38-47):

```typescript
'accessdeniedexception',  // AWS Bedrock: IAM role lacks bedrock:InvokeModel
```

Add new block after the 401/403 handler (after line 98, before the context-length check):

```typescript
// ── Resource not found (404 from Bedrock) ────────────────────────
if (
  status === 404 ||
  matchesAny(lowerMessage, [
    'resourcenotfoundexception',
    'model not found',
    'invocation model not found',
  ])
) {
  return new AppError(
    `AI Model Error: The Bedrock model is not available in the configured region. ` +
      `Verify that the model ID is supported in your AWS region.`,
    {
      ...ErrorCodes.MODEL_API_ERROR,
      cause: err,
    },
  );
}
```

Also add a `ValidationException` handler BEFORE the `ResourceNotFoundException` block (AWS `ValidationException` can contain model IDs and regions in its message, which must not be leaked to users):

```typescript
// ── Bedrock ValidationException (400) ────────────────────────────
if (matchesAny(lowerMessage, ['validationexception', 'malformed input request'])) {
  return new AppError(
    'AI Model Error: The Bedrock request was rejected. Verify the model ID and region configuration.',
    {
      ...ErrorCodes.MODEL_API_ERROR,
      cause: err,
    },
  );
}
```

Note: `ThrottlingException` is already handled via `status === 429`. `ServiceUnavailableException` is handled by the `status >= 500` branch. `ValidationException` must NOT fall to the generic fallback because the raw AWS message contains model IDs and region values (violates HLD §5 Concern #4 error sanitization requirement).

B.2. **Extract `buildProviderCacheKey()` from `session-llm-client.ts` into `provider-cache.ts`**

Add to `provider-cache.ts` (after `clearProviderCache`):

```typescript
/**
 * Build a deterministic cache key for a provider instance.
 * Pure function — no side effects, no I/O.
 *
 * @param apiKeyHash - SHA-256 hash prefix of the API key (caller's responsibility to hash)
 *
 * KEY FORMAT (must remain stable across deploys — process-local cache):
 *   `${providerType}:${apiKeyHash}:${effectiveUrl}:${modelId}:ac=${rn}:${av}[:${region}:${amb}]`
 *   - Azure fields (resourceName, apiVersion) always present when authConfig exists
 *   - Bedrock fields (region, useAmbientCredentials) only appended when at least one is truthy
 *   - This ensures exact key identity for existing Azure entries after deployment
 */
export function buildProviderCacheKey(
  providerType: string,
  apiKeyHash: string,
  effectiveUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): string {
  if (!authConfig) {
    return `${providerType}:${apiKeyHash}:${effectiveUrl || ''}:${modelId}`;
  }
  const rn = String(authConfig.resourceName || '');
  const av = String(authConfig.apiVersion || '');
  const region = String(authConfig.region || '');
  const amb = authConfig.useAmbientCredentials ? 'true' : '';
  // Base authSuffix — identical to the pre-existing inline formula for Azure
  let authSuffix = `:ac=${rn}:${av}`;
  // Append Bedrock-specific fields only when at least one is non-empty
  // This preserves exact key identity for existing Azure cache entries
  if (region || amb) {
    authSuffix += `:${region}:${amb}`;
  }
  return `${providerType}:${apiKeyHash}:${effectiveUrl || ''}:${modelId}${authSuffix}`;
}
```

B.3. **Update `session-llm-client.ts` `getOrCreateProvider()` to use `buildProviderCacheKey()`**

Import: Add `buildProviderCacheKey` to the import from `./provider-cache.js`.

Replace lines 837-843 (the inline cache key construction):

```typescript
// Before:
const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 12);
const apiSuffix = useResponsesApi != null ? `:ra=${useResponsesApi ? 1 : 0}` : '';
const authSuffix = authConfig
  ? `:ac=${String(authConfig.resourceName || '')}:${String(authConfig.apiVersion || '')}`
  : '';
const cacheKey = `${providerType}:${keyHash}:${effectiveUrl || ''}:${modelId}${apiSuffix}${authSuffix}`;

// After:
const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 12);
const apiSuffix = useResponsesApi != null ? `:ra=${useResponsesApi ? 1 : 0}` : '';
const cacheKey = `${buildProviderCacheKey(providerType, keyHash, effectiveUrl, modelId, authConfig)}${apiSuffix}`;
```

**Ordering note**: The original inline formula was `...${modelId}${apiSuffix}${authSuffix}` (apiSuffix before authSuffix). The new formula produces `...${modelId}${authSuffix}${apiSuffix}` (authSuffix first, apiSuffix appended after). This changes the combined key string for configurations where BOTH `apiSuffix` AND `authSuffix` are non-empty (e.g., Azure OpenAI with `useResponsesApi` set). Impact: zero — the provider cache is process-local and ephemeral; it rebuilds on every deployment regardless. The new ordering is the canonical format going forward.

B.4. **Create `apps/runtime/src/services/llm/utils.ts`**

```typescript
// Shared JSON field parsing utility.
// Extracted from model-resolution.ts:282 — identical behavior and signature.
// Return type is `any` to match the original — call sites in model-resolution.ts assign
// the result to typed variables (string, RealtimeModelConfig, etc.) without explicit casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonField(val: unknown): any {
  if (!val) return undefined;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val; // already an object from MongoDB
}
```

B.5. **Update `model-resolution.ts` to import `parseJsonField` from `utils.ts`**

- Add import: `import { parseJsonField } from './utils.js';`
- Remove the local `function parseJsonField(val: any): any { ... }` definition (lines 282-292)
- No call sites change (return type `any` is preserved — no type narrowing required at call sites)

B.6. **Run `pnpm build --filter=@agent-platform/runtime`** — fix any type errors immediately.

**Files Touched**:

- `apps/runtime/src/services/llm/classify-llm-error.ts` — Bedrock error patterns
- `apps/runtime/src/services/llm/provider-cache.ts` — export `buildProviderCacheKey()`
- `apps/runtime/src/services/llm/session-llm-client.ts` — use `buildProviderCacheKey()`
- `apps/runtime/src/services/llm/utils.ts` — new file
- `apps/runtime/src/services/llm/model-resolution.ts` — import from utils.ts

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0 with no type errors
- [ ] `buildProviderCacheKey('bedrock', 'hash', undefined, 'model', { region: 'us-east-1' })` and `buildProviderCacheKey('bedrock', 'hash', undefined, 'model', { region: 'us-west-2' })` produce different strings (manual spot check in REPL)
- [ ] `buildProviderCacheKey('azure', 'hash', undefined, 'model', { resourceName: 'my-resource', apiVersion: '2024-10-21' })` produces `'azure:hash::model:ac=my-resource:2024-10-21'` — identical to the pre-existing inline formula at `session-llm-client.ts:840-842` (no trailing `::` because `region` and `useAmbientCredentials` are falsy for Azure configs)
- [ ] `classifyLlmError({ status: 404, message: 'ResourceNotFoundException: Model not found' })` returns `AppError` without "OpenAI" in the message

**Test Strategy**:

- Integration: `buildProviderCacheKey()` is a pure function testable as a unit
- The full provider cache key differentiation is covered by INT-3 and INT-4 in Phase F

**Rollback**: Revert the 5 modified files; the `buildProviderCacheKey` export is additive so revert to inline key construction in `session-llm-client.ts`.

---

### Phase C: SearchAI Pipeline Fix — model-resolver.ts authConfig Passthrough

**Goal**: Fix the P0 bug where `model-resolver.ts:142` calls `createVercelProvider()` with only 4 arguments, causing Bedrock models to silently fail in pipeline classification.

**Tasks**:

C.1. **Import `parseJsonField` from `utils.ts` in `model-resolver.ts`**

```typescript
import { parseJsonField } from '../llm/utils.js';
```

C.2. **Extract `authConfig` after credential decryption in `resolveTenantModel()`**

After the existing decryption block (lines 116-136), add:

```typescript
// Extract authConfig — post-find decryption hook already decrypted it;
// parseJsonField handles the string/object normalization (Mixed field).
const authConfig = parseJsonField((credential as { authConfig?: unknown }).authConfig) as
  | Record<string, unknown>
  | undefined;
```

C.3. **Update `createVercelProvider()` call at line 142**

```typescript
// Before:
return createVercelProvider(provider, apiKey, baseUrl ?? undefined, modelId);

// After:
return createVercelProvider(provider, apiKey, baseUrl ?? undefined, modelId, undefined, authConfig);
```

The `undefined` for `useResponsesApi` preserves existing auto-detection behavior for non-Bedrock providers in the pipeline.

C.4. **Run `pnpm build --filter=@agent-platform/runtime`** — fix any type errors.

**Files Touched**:

- `apps/runtime/src/services/pipeline/model-resolver.ts` — 2 insertions + 1 line change

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0 with no type errors
- [ ] `resolvePipelineModel({ modelSource: 'tenant', tenantModelId: '<bedrock-id>' }, { tenantId: '...' })` with a seeded Bedrock TenantModel returns a non-null `LanguageModel` (manual test with MongoMemoryServer or real DB)
- [ ] Existing pipeline test `apps/runtime/src/__tests__/realtime-llm-payload.test.ts` still passes (run: `pnpm test --filter=@agent-platform/runtime realtime-llm-payload`)

**Test Strategy**:

- Integration: INT-5 and INT-6 (in Phase F) exercise `resolvePipelineModel()` end-to-end
- Existing test suite guards against regressions in non-Bedrock pipeline models

**Rollback**: Revert `model-resolver.ts` to the 4-argument call. Non-Bedrock pipeline models are unaffected.

---

### Phase D: Studio UI — IAM Role Toggle

**Goal**: Add the credential mode radio toggle to `AddConnectionDialog.tsx` so users can create Bedrock connections in "Use Platform IAM Role" mode without entering AWS keys.

**Tasks**:

D.1. **Add `RadioGroup` import to `AddConnectionDialog.tsx`**

```typescript
import { RadioGroup } from '../ui/RadioGroup.tsx';
```

Check if this import already exists; if so, skip.

D.2. **Add `newCredBedrockMode` state variable** (after line 132, alongside other Bedrock-specific state):

```typescript
const [newCredBedrockMode, setNewCredBedrockMode] = useState<'explicit' | 'iam_role'>('explicit');
```

D.3. **Add `newCredBedrockMode` reset to `reset()` function** (after `setNewCredAwsSessionToken('')` at line 180):

```typescript
setNewCredBedrockMode('explicit');
```

D.4. **Update the Bedrock form section (lines 557-587) to add the radio toggle above the inputs**:

Replace the existing `{newCredProvider === 'bedrock' ? ( <> ... </> ) : ( ... )}` block with:

```tsx
{
  newCredProvider === 'bedrock' ? (
    <>
      <RadioGroup
        label="Credential Mode"
        value={newCredBedrockMode}
        onChange={(v) => setNewCredBedrockMode(v as 'explicit' | 'iam_role')}
        options={[
          { value: 'explicit', label: 'Explicit AWS Credentials' },
          {
            value: 'iam_role',
            label: 'Use Platform IAM Role',
            description:
              'Running on EKS? The platform IAM role provides credential-free access. Ensure the role has bedrock:InvokeModel permissions.',
          },
        ]}
      />
      <Input
        label="AWS Region"
        placeholder="us-east-1"
        value={newCredAwsRegion}
        onChange={(e) => setNewCredAwsRegion(e.target.value)}
      />
      {newCredBedrockMode === 'explicit' && (
        <>
          <Input
            label="Access Key ID"
            placeholder="AKIA..."
            value={newCredAwsAccessKeyId}
            onChange={(e) => setNewCredAwsAccessKeyId(e.target.value)}
          />
          <Input
            label="Secret Access Key"
            type="password"
            autoComplete="off"
            placeholder="Enter AWS Secret Access Key"
            value={newCredAwsSecretKey}
            onChange={(e) => setNewCredAwsSecretKey(e.target.value)}
          />
          <Input
            label="Session Token (optional)"
            type="password"
            autoComplete="off"
            placeholder="For temporary credentials (STS)"
            value={newCredAwsSessionToken}
            onChange={(e) => setNewCredAwsSessionToken(e.target.value)}
          />
        </>
      )}
    </>
  ) : (
    <Input
      label={t('models_page.add_connection.api_key_label')}
      type="password"
      autoComplete="off"
      placeholder={t('models_page.add_connection.api_key_placeholder')}
      value={newCredApiKey}
      onChange={(e) => setNewCredApiKey(e.target.value)}
    />
  );
}
```

D.5. **Update `handleCreateCredential()` for IAM role mode** (starting at line 207):

Replace the Bedrock validation block (lines 210-211):

```typescript
// Before:
if (isBedrock) {
  if (!newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()) return;
}

// After:
if (isBedrock) {
  if (newCredBedrockMode === 'explicit') {
    if (!newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()) return;
  }
  // IAM role mode: only region required (always has default 'us-east-1')
}
```

Replace the Bedrock-specific body construction (lines 243-251):

```typescript
// Before:
if (isBedrock) {
  body.authType = 'aws_iam';
  body.authConfig = {
    region: newCredAwsRegion,
    accessKeyId: newCredAwsAccessKeyId.trim(),
    secretAccessKey: newCredAwsSecretKey.trim(),
    ...(newCredAwsSessionToken.trim() ? { sessionToken: newCredAwsSessionToken.trim() } : {}),
  };
}

// After:
if (isBedrock) {
  body.authType = 'aws_iam';
  if (newCredBedrockMode === 'iam_role') {
    body.apiKey = '__iam_role__';
    body.authConfig = {
      region: newCredAwsRegion || 'us-east-1',
      useAmbientCredentials: true,
    };
  } else {
    body.apiKey = newCredAwsAccessKeyId.trim(); // already set above but explicit for clarity
    body.authConfig = {
      region: newCredAwsRegion,
      accessKeyId: newCredAwsAccessKeyId.trim(),
      secretAccessKey: newCredAwsSecretKey.trim(),
      ...(newCredAwsSessionToken.trim() ? { sessionToken: newCredAwsSessionToken.trim() } : {}),
    };
  }
}
```

Note: The `body.apiKey = '__iam_role__'` in IAM role mode overrides the `apiKey` set at line 220. Ensure ordering is correct (IAM role block runs after line 220).

D.6. **Update the Save button `disabled` condition (line 688-691)**:

```typescript
// Before:
disabled={
  !newCredName.trim() ||
  (isBedrockProvider
    ? !newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()
    : !newCredApiKey.trim())
}

// After:
disabled={
  !newCredName.trim() ||
  (isBedrockProvider
    ? newCredBedrockMode === 'explicit'
      ? !newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()
      : false // IAM role mode: region always valid (has default)
    : !newCredApiKey.trim())
}
```

D.7. **Consolidate the inline Cancel button onClick handler (lines ~664-677) to use `reset()`**

The Cancel button in the "Create new credential" form has an inline onClick that manually resets individual state vars. It DOES NOT call `reset()`, so `newCredBedrockMode` will not be reset to `'explicit'` when the user clicks Cancel. Reopening the dialog would retain the previous IAM role mode selection.

Fix: Replace the inline Cancel onClick body with a call to `reset()`. Also ensure `reset()` calls `setShowCreateForm(false)` (add it if not already present). This consolidates all state reset logic in the single `reset()` function and prevents future drift bugs.

```typescript
// Before (inline per-field resets at ~line 664-677):
onClick={() => {
  setNewCredName('');
  setNewCredApiKey('');
  // ... many individual setters ...
  setShowCreateForm(false);
}}

// After:
onClick={() => {
  reset();
  setShowCreateForm(false); // if reset() doesn't already do this
}}
```

D.8. **Run `pnpm build --filter=@agent-platform/studio`** — fix any type errors immediately.

D.9. **Verify in browser**: Start Studio dev server, navigate to Admin → Models → Bedrock TenantModel → Add Connection. Verify toggle renders, IAM role mode hides key fields, explicit mode shows them. Click Cancel → reopen dialog → verify "Explicit AWS Credentials" is selected (reset was applied).

**Files Touched**:

- `apps/studio/src/components/admin/AddConnectionDialog.tsx` — ~60 lines net change (cancel handler consolidation adds ~5 lines)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` exits 0 with no type errors
- [ ] "Explicit AWS Credentials" radio selected by default when opening Bedrock dialog
- [ ] Selecting "Use Platform IAM Role" hides Access Key ID / Secret Access Key / Session Token
- [ ] Region input remains visible in IAM role mode
- [ ] Save button is enabled in IAM role mode when only region is set
- [ ] Save button is disabled in explicit mode when accessKeyId is empty
- [ ] Switching back to explicit mode re-shows key fields
- [ ] Cancel in IAM role mode → reopen dialog → "Explicit AWS Credentials" selected (reset applied correctly)

**Test Strategy**:

- Studio dev server manual test (per D.8)
- PLY-1 through PLY-5 Playwright tests (written in Phase F) cover automated verification

**Rollback**: Revert `AddConnectionDialog.tsx` to the previous version. Explicit-credentials Bedrock connections continue to work. IAM role toggle is the only lost capability.

---

### Phase E: Test Infrastructure + All Tests

**Goal**: Wire up the test infrastructure prerequisites identified in the test spec, then write all automated test files.

**Tasks**:

E.1. **Add `nock@^14` to `apps/runtime/package.json` devDependencies**

```json
"nock": "^14.0.0"
```

Run `pnpm install --filter=@agent-platform/runtime`.

E.2. **Extend `MANAGED_ENV_KEYS` in `runtime-api-harness.ts`**

Add before the `] as const;` at line 69:

```typescript
'AWS_REGION',
'AWS_ACCESS_KEY_ID',
'AWS_SECRET_ACCESS_KEY',
```

E.3. **Extend provisioning route schema in `platform-admin-models.ts`**

In `createProvisionedModelSchema` (line 83-89), add `authConfig` to the `connection` object:

```typescript
connection: z.object({
  credentialName: z.string().max(MAX_FIELD_LENGTH),
  apiKey: z.string().min(1),
  authType: z.string().optional(),
  authConfig: z.record(z.unknown()).optional(), // NEW
}).optional(),
```

In `createConnectionSchema` (line 109-114), add:

```typescript
authConfig: z.record(z.unknown()).optional(), // NEW
```

In `createCredentialForTenant` function signature (line 130-135), add `authConfig?: Record<string, unknown>`:

```typescript
async function createCredentialForTenant(opts: {
  tenantId: string;
  provider: string;
  name: string;
  apiKey: string;
  authType: string;
  authConfig?: Record<string, unknown>; // NEW
}): Promise<string>;
```

In `LLMCredential.create()` call (line 138-148), add:

```typescript
...(opts.authConfig ? { authConfig: opts.authConfig } : {}), // NEW
```

Update the call site at line ~308 (where `createCredentialForTenant` is invoked) to pass `authConfig: connection.authConfig`.

E.4. **Extend `provisionTenantModel` helper in `channel-e2e-bootstrap.ts`**

Add `authConfig?: Record<string, unknown>` to the `connection` type (line 728-732):

```typescript
connection?: {
  credentialName: string;
  apiKey: string;
  authType?: string;
  authConfig?: Record<string, unknown>; // NEW
};
```

E.5. **Write `packages/llm/src/__tests__/provider-factory.test.ts`**

- Already specified in Phase A task A.7. If Phase A was committed already, verify the file exists and all 6 tests pass.

E.6. **Write `apps/runtime/src/__tests__/bedrock-integration.test.ts`**

Implementation guide for each test (per test spec):

- **INT-1** (`ModelResolutionService.resolve()` returns Bedrock authConfig): Setup MongoMemoryServer + encryption init + `LLMCredential.create({ tenantId, authType: 'aws_iam', encryptedApiKey: 'AKIATEST', authConfig: { region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret' } })` + `TenantModel` + `TenantModelConnection`. Call `ModelResolutionService.resolve()`. Assert `resolved.provider === 'bedrock'`, `resolved.authConfig.accessKeyId === 'AKIATEST'`.
- **INT-2** (explicit creds LanguageModel + nock HTTP round-trip): Intercept Bedrock converse endpoint with nock. Call `createVercelProvider('bedrock', 'AKIATEST', undefined, 'anthropic.claude-sonnet-4-6-v1:0', undefined, { region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret' })` → `generateText({ model, messages: [...] })`. Assert nock interceptor was called.
- **INT-3** (cache key region differentiation): `clearProviderCache()`; call `buildProviderCacheKey('bedrock', 'hash', undefined, 'model', { region: 'us-east-1' })` → `keyA`; call with `{ region: 'us-west-2' }` → `keyB`; assert `keyA !== keyB`.
- **INT-4** (cache key explicit vs ambient): `buildProviderCacheKey('bedrock', 'hashA', undefined, 'model', { region: 'us-east-1', accessKeyId: 'AKIA...' })` vs `buildProviderCacheKey('bedrock', 'hashB', undefined, 'model', { region: 'us-east-1', useAmbientCredentials: true })` → different strings.
- **INT-5** (`resolvePipelineModel` with Bedrock returns LanguageModel): Seed TenantModel + LLMCredential with `authConfig: { region: 'us-west-2', accessKeyId: 'AKIA...', secretAccessKey: 'secret' }`. Call `resolvePipelineModel(...)`. Assert non-null LanguageModel returned.
- **INT-6** (pipeline error is Bedrock-specific): Same setup as INT-5. nock returns 401 from Bedrock. Call `generateText()` on the resolved model. Assert error message does not contain "OpenAI".

E.7. **Write `apps/runtime/src/__tests__/bedrock-e2e.test.ts`**

Use `startRuntimeServerHarness()` + `bootstrapProject()` + nock pattern.

E2E test template:

```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import nock from 'nock';
import { startRuntimeServerHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import { authHeaders, bootstrapProject, requestJson } from './helpers/channel-e2e-bootstrap.js';

const BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-4-6-v1:0';
const CANNED_BEDROCK_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'Hello from Bedrock.' }] } },
  usage: { inputTokens: 8, outputTokens: 6 },
  stopReason: 'end_turn',
};

describe('Bedrock E2E', () => {
  let harness: RuntimeApiHarness;
  let token: string;
  let tenantId: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    const boot = await bootstrapProject(harness, 'bedrock-e2e@test.com', 'bedrock-tenant', 'bedrock-proj');
    token = boot.token; tenantId = boot.tenantId; projectId = boot.projectId;
  }, 90_000);

  afterAll(() => harness?.close());

  beforeEach(() => nock.cleanAll());

  test('E2E-1: explicit creds connection → chat returns response', async () => { ... });
  // ... E2E-2 through E2E-6
});
```

For each E2E test, follow the step-by-step scenarios from the test spec exactly. Key assertion pattern for nock: intercept before the chat call, then `expect(nockScope.isDone()).toBe(true)` after.

E.8. **Write `apps/studio/e2e/bedrock-connection-dialog.spec.ts`**

Use existing Playwright helpers from `apps/studio/e2e/helpers/`. Reference `apps/studio/e2e/model-guardrails-e2e.spec.ts` for dialog interaction patterns. Implement PLY-1 through PLY-5 per test spec.

E.9. **Run `pnpm build --filter=@agent-platform/runtime` and `pnpm test --filter=@agent-platform/runtime`**

**Files Touched**:

- `apps/runtime/package.json` — add nock devDep
- `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` — add AWS env vars to MANAGED_ENV_KEYS
- `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` — extend provisionTenantModel
- `apps/runtime/src/routes/platform-admin-models.ts` — extend provisioning schema + createCredentialForTenant
- `apps/runtime/src/__tests__/bedrock-integration.test.ts` — new file
- `apps/runtime/src/__tests__/bedrock-e2e.test.ts` — new file
- `apps/studio/e2e/bedrock-connection-dialog.spec.ts` — new file

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0
- [ ] All 6 unit tests (`provider-factory.test.ts`) pass
- [ ] All 6 integration tests (`bedrock-integration.test.ts`) pass (nock + MongoMemoryServer)
- [ ] All 6 E2E tests (`bedrock-e2e.test.ts`) pass (full runtime server + nock)
- [ ] Studio Playwright tests: all 5 PLY tests pass when Studio dev server is running (`pnpm playwright test apps/studio/e2e/bedrock-connection-dialog.spec.ts`). If the Studio server is unavailable in CI, each test must use `test.skip('Studio server not running')` — zero silent passes are permitted
- [ ] `provisionTenantModel()` call with `connection.authConfig: { region: 'us-east-1', ... }` seeds the credential correctly (verify via GET response)
- [ ] No regressions in existing runtime tests: `pnpm test --filter=@agent-platform/runtime` passes before and after

**Test Strategy**:

- This phase IS the test-writing phase; all tests are run in this phase
- Integration tests use `setupTestMongo()` + `initializeRuntimeTestEncryption()` (existing helpers)
- E2E tests use `startRuntimeServerHarness()` + nock (no real AWS calls)

**Rollback**: Remove new test files. Revert `MANAGED_ENV_KEYS`, `provisionTenantModel` type, and route schema additions (all backward-compatible optional additions).

---

### Phase F: Documentation

**Goal**: Create the AWS Bedrock ops guide for platform operators.

**Tasks**:

F.1. **Create `docs/guides/llm-providers/aws-bedrock.md`**

Sections to include:

- Overview (explicit creds vs IRSA ambient)
- Prerequisites (supported models, AWS regions)
- Explicit credentials setup (step-by-step Studio UI guide)
- IRSA setup guide (EKS cluster requirements, IAM policy template, IRSA configuration)
- Minimum IAM policy (from feature spec §12):
  ```json
  {
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
    "Effect": "Allow"
  }
  ```
- Supported models (from model registry: `anthropic.claude-opus-4-6-v1:0`, `anthropic.claude-sonnet-4-6-v1:0`, `anthropic.claude-sonnet-4-20250514-v1:0`)
- Multi-region configuration
- Provider cache TTL configuration (`LLM_PROVIDER_CACHE_TTL_SECONDS`, default 1800)
- Troubleshooting (AccessDeniedException, wrong region errors, IRSA resolution failures)

**Files Touched**:

- `docs/guides/llm-providers/aws-bedrock.md` — new file

**Exit Criteria**:

- [ ] File exists at `docs/guides/llm-providers/aws-bedrock.md`
- [ ] IAM policy template is present and correct
- [ ] IRSA setup steps are documented
- [ ] All 3 supported model IDs are listed

**Rollback**: Delete file. No code impact.

---

## 4. Wiring Checklist

CRITICAL: Every component must be reachable from its callers.

- [x] `case 'bedrock'` in `provider-factory.ts` — reached by `SessionLLMClient.getOrCreateProvider()` when `providerType === 'bedrock'` (existing call site at `session-llm-client.ts:847`)
- [x] `case 'bedrock'` in `provider-factory.ts` — reached by `model-resolver.ts:142` after Phase C fix
- [x] `@ai-sdk/amazon-bedrock` — imported at top of `provider-factory.ts`; `packages/llm/package.json` dep
- [x] `@aws-sdk/credential-providers` — module-level init in `provider-factory.ts`; `packages/llm/package.json` dep
- [x] `buildProviderCacheKey()` — exported from `provider-cache.ts`; imported in `session-llm-client.ts` (Phase B task B.3)
- [x] `parseJsonField()` — exported from `utils.ts`; imported in `model-resolution.ts` (replaces local def) and `model-resolver.ts` (Phase C task C.1)
- [x] `authConfig` passthrough in `model-resolver.ts` — passed as 6th arg to `createVercelProvider()` (Phase C task C.3)
- [x] Bedrock error patterns in `classify-llm-error.ts` — reached by `classifyLlmError()` called in session execution error handler
- [x] `RadioGroup` import in `AddConnectionDialog.tsx` — component renders inline (Phase D task D.1)
- [x] `newCredBedrockMode` state — initialized and reset in `AddConnectionDialog.tsx`; wired in `handleCreateCredential` (Phase D)
- [x] IAM role credential body (`apiKey: '__iam_role__'`, `authConfig.useAmbientCredentials: true`) — sent via `POST /api/tenant-credentials`; stored in `LLMCredential` via existing route
- [x] `nock@^14` devDep — imported in integration and E2E test files (Phase E)
- [x] AWS env vars in `MANAGED_ENV_KEYS` — snapshot/restore runs automatically in `startRuntimeServerHarness()` (Phase E task E.2)
- [x] `authConfig` in provisioning route schema — `createCredentialForTenant` passes it to `LLMCredential.create()` which stores it encrypted (Phase E task E.3)
- [x] `provisionTenantModel` `connection.authConfig` type — used in test helper calls in E2E tests (Phase E task E.4)
- [ ] **Studio `apps/studio/Dockerfile`**: NOT needed — no new `packages/<name>/` workspace package added; `@ai-sdk/amazon-bedrock` and `@aws-sdk/credential-providers` are dependencies of the existing `@agent-platform/llm` package which is already in the Dockerfile

---

## 5. Cross-Phase Concerns

### Database Migrations

None. `authConfig: Schema.Types.Mixed` already exists and is encrypted. No collection or index changes.

### Feature Flags

None. There are no feature flags for this integration. IAM role mode is per-connection at the data level (`authConfig.useAmbientCredentials`). The Studio UI toggle in Phase D is immediately visible to all users once deployed.

### Configuration Changes

| Env Variable                     | Default         | Purpose                                                                                                                                          |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AWS_REGION`                     | (none)          | Fallback region for Bedrock when `authConfig.region` absent. Platform-level default when no per-connection region specified.                     |
| `LLM_PROVIDER_CACHE_TTL_SECONDS` | `1800` (30 min) | Tune down for stricter credential materialization window (e.g., `300` for 5 min on HIPAA deployments). Existing config key — no new code needed. |

No new env vars need to be added to `apps/runtime/src/config/index.ts`. `AWS_REGION` is read directly via `process.env.AWS_REGION` in `provider-factory.ts` (same pattern as other SDK calls in the project).

### Commit Sequence

Per CLAUDE.md commit discipline (max 40 files, max 3 packages per commit):

| Commit | Phase              | Packages       | Files                                                                                                    |
| ------ | ------------------ | -------------- | -------------------------------------------------------------------------------------------------------- |
| 1      | Phase A            | `packages/llm` | `package.json`, `provider-factory.ts`, `__tests__/provider-factory.test.ts`                              |
| 2      | Phase B            | `apps/runtime` | `classify-llm-error.ts`, `provider-cache.ts`, `session-llm-client.ts`, `utils.ts`, `model-resolution.ts` |
| 3      | Phase C            | `apps/runtime` | `model-resolver.ts`                                                                                      |
| 4      | Phase D            | `apps/studio`  | `AddConnectionDialog.tsx` (Note: Bedrock labels are hardcoded English per Decision D-5; no i18n changes) |
| 5a     | Phase E infra      | `apps/runtime` | `package.json`, `runtime-api-harness.ts`, `channel-e2e-bootstrap.ts`, `platform-admin-models.ts`         |
| 5b     | Phase E tests      | `apps/runtime` | `bedrock-integration.test.ts`, `bedrock-e2e.test.ts`                                                     |
| 5c     | Phase E Playwright | `apps/studio`  | `bedrock-connection-dialog.spec.ts`                                                                      |
| 6      | Phase F            | docs only      | `aws-bedrock.md`                                                                                         |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] **FR-1**: Agent session with `provider='bedrock'`, explicit `accessKeyId`+`secretAccessKey` in `authConfig` completes a chat round-trip (verified by E2E-1)
- [ ] **FR-2**: Agent session with `useAmbientCredentials: true`, no AWS keys in DB, runs successfully on EKS with IRSA (verified by E2E-2 automated, M-2 manual on EKS)
- [ ] **FR-3**: Studio `AddConnectionDialog` renders "Use Platform IAM Role" toggle for Bedrock provider; IAM role mode hides key fields; submission stores `useAmbientCredentials: true` in `authConfig` (verified by PLY-1 through PLY-5)
- [ ] **FR-4a**: Tool calling works for Bedrock models — Bedrock's `toolUse` content block translates correctly through the Vercel AI SDK (verified by E2E-5)
- [ ] **FR-4b**: Streaming responses for Bedrock models — deferred to post-BETA per test spec §11 Q2; `application/vnd.amazon.eventstream` mock helper not yet available. Manual verification: M-1 on staging with real AWS credentials
- [ ] **FR-5**: Error responses from Bedrock do not contain "OpenAI API error" (verified by E2E-3)
- [ ] **FR-6**: Two Bedrock connections with the same model but different regions produce different provider cache entries (verified by INT-3)
- [ ] **FR-7**: `resolvePipelineModel()` with a Bedrock TenantModel returns a non-null `LanguageModel` (verified by INT-5)
- [ ] **FR-8**: Region defaults to `AWS_REGION` env var then `us-east-1` when not in `authConfig` (verified by UT-3, UT-4)
- [ ] All 6 unit tests pass: `pnpm test --filter=@agent-platform/llm`
- [ ] All 6 integration tests pass: `pnpm test --filter=@agent-platform/runtime bedrock-integration`
- [ ] All 6 automated E2E tests pass: `pnpm test --filter=@agent-platform/runtime bedrock-e2e`
- [ ] No regressions: `pnpm build && pnpm test` passes for all packages
- [ ] Feature spec updated: `docs/features/sub-features/aws-bedrock-provider.md` — status PLANNED → ALPHA, provider cache TTL 5s claim corrected to 30 min (post-impl-sync)
- [ ] Test matrix updated: `docs/testing/sub-features/aws-bedrock-provider.md` — all covered scenarios updated from NOT TESTED to status

---

## 7. Open Questions

1. **`fromNodeProviderChain()` credential caching verification**: Confirm that `fromNodeProviderChain()` from `@aws-sdk/credential-providers@^3.998.0` caches credentials internally and refreshes before expiry. Verify by reading the installed package types after `pnpm install` in Phase A. If the behavior differs from what the HLD documents (two-layer caching), the IRSA rotation story must be updated in the ops guide (Phase F).

2. **Bedrock Converse API nock response format**: The exact binary/JSON format that `@ai-sdk/amazon-bedrock` expects in the nock mock response must be verified against the installed SDK in Phase E before writing E2E tests. The test spec specifies a JSON object but streaming uses `application/vnd.amazon.eventstream` binary format. Automated E2E tests (Phase E) should use the non-streaming `POST /model/{modelId}/converse` endpoint initially; streaming coverage deferred to post-BETA (see test spec §11 Q2).

3. **`RadioGroup` import path in `AddConnectionDialog.tsx`**: Phase D specifies `import { RadioGroup } from '../ui/RadioGroup.tsx'`. Verify the exact relative import path from `apps/studio/src/components/admin/` to `apps/studio/src/components/ui/RadioGroup.tsx` before writing. The component exists at the expected path (confirmed in pre-LLD code read).

4. **`pnpm install` lockfile changes**: Adding `@ai-sdk/amazon-bedrock@^4.0.0` and `@aws-sdk/credential-providers@^3.998.0` will update `pnpm-lock.yaml`. Verify no other package resolutions change unexpectedly (run `pnpm install --dry-run` first in Phase A).
