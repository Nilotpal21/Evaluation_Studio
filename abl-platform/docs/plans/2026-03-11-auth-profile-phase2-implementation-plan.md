# Auth Profile Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all existing credential models (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`) to Auth Profile with dual-read fallback, add 6 new auth types, activate 3 addon mechanisms, and wire all 17 consumers to `authProfileId`.

**Architecture:** Every consumer stores `authProfileId` alongside its legacy credential field. Dual-read checks `authProfileId` first (via `AuthProfileService.resolve()`), falling back to legacy resolution when absent. Feature-flagged via `AUTH_PROFILE_ENABLED`. Migration scripts create Auth Profiles from legacy records; Phase 3 deletes old models after go/no-go gate.

**Tech Stack:** Mongoose, Zod discriminated unions, `@aws-sdk/signature-v4`, `@azure/identity`, `ssh2`, Redis distributed locks, native `fetch` for OAuth, vitest.

**Prerequisites:** Phase 1 stable in production with canary tenant validation. `AuthProfile` model, `AuthProfileService`, project-scoped CRUD, OAuth flow, and connector dual-read all deployed and passing health checks. No open `AUTH_PROFILE_DECRYPTION_FAILED` alerts.

---

## Task Summary

| #   | Phase                   | Task Name                                                        | Key Files                                                                                                                   |
| --- | ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | A -- New Auth Types     | Extend auth type enum (6 new types)                              | `packages/database/src/models/auth-profile.model.ts`                                                                        |
| 2   | A -- New Auth Types     | Zod schemas for `basic` and `custom_header`                      | `packages/shared/src/validation/auth-profile-phase2.schema.ts`                                                              |
| 3   | A -- New Auth Types     | Zod schemas for `aws_iam` and `azure_ad`                         | `packages/shared/src/validation/auth-profile-phase2.schema.ts`                                                              |
| 4   | A -- New Auth Types     | Zod schemas for `mtls` and `ssh_key`                             | `packages/shared/src/validation/auth-profile-phase2.schema.ts`                                                              |
| 5   | A -- New Auth Types     | Wire Phase 2 schemas into CreateAuthProfile discriminated union  | `packages/shared/src/validation/auth-profile.schema.ts`                                                                     |
| 6   | A -- New Auth Types     | `applyAuth()` dispatcher for `basic`, `custom_header`            | `packages/shared/src/services/auth-profile/apply-auth.ts`                                                                   |
| 7   | A -- New Auth Types     | `applyAuth()` dispatcher for `aws_iam`                           | `packages/shared/src/services/auth-profile/apply-auth.ts`                                                                   |
| 8   | A -- New Auth Types     | `applyAuth()` dispatcher for `azure_ad`                          | `packages/shared/src/services/auth-profile/apply-auth.ts`                                                                   |
| 9   | A -- New Auth Types     | `applyAuth()` dispatcher for `mtls`, `ssh_key`                   | `packages/shared/src/services/auth-profile/apply-auth.ts`                                                                   |
| 10  | A -- New Auth Types     | Install `@aws-sdk/signature-v4`, `@azure/identity`, `ssh2`       | `packages/shared/package.json`                                                                                              |
| 11  | B -- Addons             | Remove Phase 1 addon rejection guard                             | `packages/shared/src/services/auth-profile.service.ts`                                                                      |
| 12  | B -- Addons             | Signing addon Zod schema + `applySigning()` function             | `packages/shared/src/validation/auth-profile-addons.schema.ts`                                                              |
| 13  | B -- Addons             | Webhook verification addon schema + `verifyWebhook()` function   | `packages/shared/src/validation/auth-profile-addons.schema.ts`                                                              |
| 14  | B -- Addons             | Proxy addon schema + `applyProxy()` function                     | `packages/shared/src/validation/auth-profile-addons.schema.ts`                                                              |
| 15  | B -- Addons             | Invalid combination matrix enforcement                           | `packages/shared/src/validation/auth-profile-addons.schema.ts`                                                              |
| 16  | B -- Addons             | Addon secrets validation (signingSecret, webhookSecret)          | `packages/shared/src/validation/auth-profile-addons.schema.ts`                                                              |
| 17  | C -- Consumer Migration | `TenantModel.connections[].authProfileId` dual-read              | `apps/runtime/src/repos/tenant-model-repo.ts`                                                                               |
| 18  | C -- Consumer Migration | `ModelConfig.authProfileId` dual-read                            | `packages/database/src/models/model-config.model.ts`                                                                        |
| 19  | C -- Consumer Migration | `MCPServerConfig.authProfileId` dual-read                        | `packages/database/src/models/mcp-server-config.model.ts`                                                                   |
| 20  | C -- Consumer Migration | `ChannelConnection.authProfileId` dual-read                      | `packages/database/src/models/channel-connection.model.ts`, `apps/runtime/src/channels/connection-resolver.ts`              |
| 21  | C -- Consumer Migration | `ServiceNode.authProfileId` dual-read                            | `apps/runtime/src/services/adapters/service-node-executor.ts`                                                               |
| 22  | C -- Consumer Migration | `TenantGuardrailProviderConfig.authProfileId` dual-read          | `packages/database/src/models/guardrail-provider-config.model.ts`                                                           |
| 23  | C -- Consumer Migration | `GuardrailPolicy.providerOverrides[].authProfileId` dual-read    | `packages/database/src/models/guardrail-policy.model.ts`                                                                    |
| 24  | C -- Consumer Migration | `TenantServiceInstance.authProfileId` (voice) dual-read          | `packages/database/src/models/tenant-service-instance.model.ts`, `apps/runtime/src/services/voice/voice-service-factory.ts` |
| 25  | C -- Consumer Migration | `ArchWorkspaceConfig.authProfileId` dual-read                    | `packages/database/src/models/arch-workspace-config.model.ts`                                                               |
| 26  | C -- Consumer Migration | `GitIntegration.authProfileId` dual-read                         | `packages/database/src/models/git-integration.model.ts`                                                                     |
| 27  | C -- Consumer Migration | `WebhookSubscription` + `WebhookSubscriptionConnector` dual-read | `packages/database/src/models/webhook-subscription.model.ts`, `webhook-subscription-connector.model.ts`                     |
| 28  | C -- Consumer Migration | `SDKChannel.authProfileId` dual-read                             | `packages/database/src/models/sdk-channel.model.ts`                                                                         |
| 29  | C -- Consumer Migration | `TriggerRegistration.authProfileId` dual-read                    | `packages/database/src/models/trigger-registration.model.ts`                                                                |
| 30  | C -- Consumer Migration | `OrgProxyConfig.authProfileId` multi-credential merge            | `packages/database/src/models/org-proxy-config.model.ts`                                                                    |
| 31  | D -- Worker Migration   | Search-AI shared resolver dual-read (`llm-config/resolver.ts`)   | `apps/search-ai/src/services/llm-config/resolver.ts`                                                                        |
| 32  | D -- Worker Migration   | Search-AI embedding credentials dual-read                        | `apps/search-ai/src/services/llm-config/embedding-credentials.ts`                                                           |
| 33  | D -- Worker Migration   | IDP sync scheduler + sync workers dual-read                      | `apps/search-ai/src/workers/idp-sync-scheduler.ts`, `azuread-*.ts`, `okta-*.ts`, `google-*.ts`                              |
| 34  | D -- Worker Migration   | Runtime `model-resolution.ts` dual-read                          | `apps/runtime/src/services/llm/model-resolution.ts`                                                                         |
| 35  | D -- Worker Migration   | `tool-oauth-service.ts` Auth Profile integration                 | `apps/runtime/src/services/tool-oauth-service.ts`                                                                           |
| 36  | D -- Worker Migration   | `RuntimeSecretsProvider` Auth Profile resolution path            | `apps/runtime/src/services/secrets-provider.ts`                                                                             |
| 37  | D -- Worker Migration   | `TokenManager` (connectors/base) dual-read                       | `packages/connectors/base/src/auth/token-manager.ts`                                                                        |
| 38  | E -- EncryptionService  | Extend `EncryptionService` for multi-key support                 | `packages/shared/src/encryption/engine.ts`, `packages/shared/src/encryption/types.ts`                                       |
| 39  | F -- Tenant API         | Tenant-scoped CRUD routes                                        | `apps/studio/src/app/api/auth-profiles/route.ts`                                                                            |
| 40  | F -- Tenant API         | Tenant-scoped ID routes (GET/PUT/DELETE)                         | `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts`                                                                |
| 41  | F -- Tenant API         | Tenant-scoped validate endpoint                                  | `apps/studio/src/app/api/auth-profiles/[profileId]/validate/route.ts`                                                       |
| 42  | G -- Migration Scripts  | `LLMCredential` -> `AuthProfile` migration script                | `packages/database/src/migrations/migrate-llm-credentials.ts`                                                               |
| 43  | G -- Migration Scripts  | `ToolSecret` -> `AuthProfile` migration script                   | `packages/database/src/migrations/migrate-tool-secrets.ts`                                                                  |
| 44  | G -- Migration Scripts  | `EndUserOAuthToken` -> `AuthProfile` migration script            | `packages/database/src/migrations/migrate-oauth-tokens.ts`                                                                  |
| 45  | G -- Migration Scripts  | Name collision prevention utility                                | `packages/database/src/migrations/migration-utils.ts`                                                                       |
| 46  | H -- Monitoring Updates | `CredentialAgeMonitor` Auth Profile integration                  | `apps/runtime/src/services/credential-age-monitor.ts`                                                                       |
| 47  | H -- Monitoring Updates | `VoiceServiceFactory` cache invalidation via Auth Profile events | `apps/runtime/src/services/voice/voice-service-factory.ts`                                                                  |
| 48  | I -- Pre-Flight Auth    | Compiler `authRequirements` bubbling                             | `packages/compiler/src/phases/auth-requirements.ts`                                                                         |
| 49  | I -- Pre-Flight Auth    | `RuntimeSecretsProvider` session-level credential cache          | `apps/runtime/src/services/secrets-provider.ts`                                                                             |
| 50  | J -- Tests              | Unit tests: 6 new auth type schemas                              | `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`                                                          |
| 51  | J -- Tests              | Unit tests: addon schemas + invalid combinations                 | `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`                                                           |
| 52  | J -- Tests              | Unit tests: `applyAuth()` for all Phase 2 types                  | `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`                                                      |
| 53  | J -- Tests              | Integration tests: consumer dual-read paths                      | `apps/runtime/src/__tests__/auth-profile/consumer-dual-read.test.ts`                                                        |
| 54  | J -- Tests              | Integration tests: migration scripts (dry-run)                   | `packages/database/src/__tests__/migrations/migration-scripts.test.ts`                                                      |
| 55  | J -- Tests              | Integration tests: EncryptionService multi-key                   | `packages/shared/src/__tests__/encryption/multi-key.test.ts`                                                                |
| 56  | J -- Tests              | E2E: tenant-scoped CRUD API                                      | `apps/studio/src/__tests__/auth-profiles/tenant-crud.test.ts`                                                               |
| 57  | J -- Tests              | Integration tests: worker dual-read (search-ai resolver)         | `apps/search-ai/src/services/llm-config/__tests__/resolver-auth-profile.test.ts`                                            |

---

## TDD Convention

Every task follows this 5-step cycle:

1. **Red** -- Write the failing test
2. **Run** -- Verify the test fails (expected)
3. **Green** -- Implement the minimum code to pass
4. **Run** -- Verify the test passes
5. **Commit** -- `npx prettier --write <files>` then commit

**Test framework:** vitest (all `packages/` and `apps/` use vitest)
**Format:** `npx prettier --write <files>` before every commit
**Imports:** Use `.js` extension (ESM convention in this codebase)

---

## Phase A -- New Auth Types (6 types)

> Adds `basic`, `custom_header`, `aws_iam`, `azure_ad`, `mtls`, `ssh_key` to the Auth Profile model, Zod validation, and `applyAuth()` dispatcher.

### Task 1: Extend auth type enum (6 new types)

**Files:**

- Modify: `packages/database/src/models/auth-profile.model.ts`
- Test: `packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts`

**Step 1 -- Update test expectation for 12 auth types:**

```typescript
// packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
// Update the existing test:
it('has authType enum with 12 Phase 1+2 values', () => {
  const pathType = AuthProfile.schema.path('authType') as any;
  expect(pathType.enumValues).toHaveLength(12);
  expect(pathType.enumValues).toContain('none');
  expect(pathType.enumValues).toContain('api_key');
  expect(pathType.enumValues).toContain('bearer');
  expect(pathType.enumValues).toContain('oauth2_app');
  expect(pathType.enumValues).toContain('oauth2_token');
  expect(pathType.enumValues).toContain('oauth2_client_credentials');
  // Phase 2 types:
  expect(pathType.enumValues).toContain('basic');
  expect(pathType.enumValues).toContain('custom_header');
  expect(pathType.enumValues).toContain('aws_iam');
  expect(pathType.enumValues).toContain('azure_ad');
  expect(pathType.enumValues).toContain('mtls');
  expect(pathType.enumValues).toContain('ssh_key');
});
```

**Run to verify failure:**

```bash
cd packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
# Expected: FAIL — enum has 6, expected 12
```

**Step 2 -- Update the enum constant:**

```typescript
// packages/database/src/models/auth-profile.model.ts
// Replace the existing AUTH_PROFILE_AUTH_TYPES array:
export const AUTH_PROFILE_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
  // Phase 2 types:
  'basic',
  'custom_header',
  'aws_iam',
  'azure_ad',
  'mtls',
  'ssh_key',
] as const;
```

**Run to verify pass:**

```bash
cd packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
# Expected: PASS
```

**Step 3 -- Add Phase 2 fields to the schema:**

In addition to updating the auth type enum, add these new fields to the AuthProfile schema:

```typescript
// packages/database/src/models/auth-profile.model.ts
// Add to the schema definition:
groupId: { type: String, default: null },      // Links related profiles (OrgProxyConfig multi-credential)
migrationStatus: {
  type: String,
  enum: ['active', 'migrating', 'migrated'],
  default: 'active',
},
```

Also add an index for groupId lookups:

```typescript
// Add to the indexes:
{
  groupId: 1;
} // Find all profiles in a group
```

**Step 4 -- Build:**

```bash
pnpm build --filter=@agent-platform/database
# Expected: Build succeeds
```

**Commit:**

```bash
npx prettier --write packages/database/src/models/auth-profile.model.ts packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
git add packages/database/src/models/auth-profile.model.ts packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
git commit -m "feat(database): extend AuthProfile enum with 6 Phase 2 auth types"
```

---

### Task 2: Zod schemas for `basic` and `custom_header`

**Files:**

- Create: `packages/shared/src/validation/auth-profile-phase2.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  BasicConfigSchema,
  BasicSecretsSchema,
  CustomHeaderConfigSchema,
  CustomHeaderSecretsSchema,
} from '../../validation/auth-profile-phase2.schema.js';

describe('BasicConfigSchema', () => {
  it('accepts empty object', () => {
    expect(BasicConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(BasicConfigSchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe('BasicSecretsSchema', () => {
  it('requires username and password', () => {
    expect(BasicSecretsSchema.safeParse({}).success).toBe(false);
    expect(BasicSecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });

  it('rejects missing password', () => {
    expect(BasicSecretsSchema.safeParse({ username: 'u' }).success).toBe(false);
  });
});

describe('CustomHeaderConfigSchema', () => {
  it('requires at least one header name', () => {
    expect(CustomHeaderConfigSchema.safeParse({}).success).toBe(false);
    expect(
      CustomHeaderConfigSchema.safeParse({ headers: { 'X-Api-Key': 'key-name' } }).success,
    ).toBe(true);
  });

  it('rejects empty headers object', () => {
    const result = CustomHeaderConfigSchema.safeParse({ headers: {} });
    expect(result.success).toBe(false);
  });
});

describe('CustomHeaderSecretsSchema', () => {
  it('requires headerValues with at least one entry', () => {
    expect(CustomHeaderSecretsSchema.safeParse({}).success).toBe(false);
    expect(
      CustomHeaderSecretsSchema.safeParse({ headerValues: { 'X-Api-Key': 'secret-value' } })
        .success,
    ).toBe(true);
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: FAIL — module not found
```

**Step 2 -- Implement:**

```typescript
// packages/shared/src/validation/auth-profile-phase2.schema.ts
import { z } from 'zod';

// ── basic ──────────────────────────────────────────────────────────────
export const BasicConfigSchema = z.object({}).strict();

export const BasicSecretsSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

// ── custom_header ──────────────────────────────────────────────────────
export const CustomHeaderConfigSchema = z
  .object({
    headers: z.record(z.string(), z.string()).refine((h) => Object.keys(h).length > 0, {
      message: 'At least one header name is required',
    }),
  })
  .strict();

export const CustomHeaderSecretsSchema = z
  .object({
    headerValues: z.record(z.string(), z.string()).refine((h) => Object.keys(h).length > 0, {
      message: 'At least one header value is required',
    }),
  })
  .strict();

/**
 * Cross-field validation: headerValues keys must match config.headers keys.
 * This cannot be enforced at the individual schema level -- enforce it in the
 * CreateAuthProfile discriminated union branch via .superRefine():
 */
export const CustomHeaderCrossFieldValidator = (
  config: { headers: Record<string, string> },
  secrets: { headerValues: Record<string, string> },
) => {
  const configKeys = new Set(Object.keys(config.headers));
  const secretKeys = new Set(Object.keys(secrets.headerValues));
  const missing = [...configKeys].filter((k) => !secretKeys.has(k));
  const extra = [...secretKeys].filter((k) => !configKeys.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return { valid: false, missing, extra };
  }
  return { valid: true };
};
```

**Run to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: PASS
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git add packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git commit -m "feat(shared): add Zod schemas for basic and custom_header auth types"
```

---

### Task 3: Zod schemas for `aws_iam` and `azure_ad`

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-phase2.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`

**Step 1 -- Add failing tests:**

```typescript
// Append to packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
import {
  AwsIamConfigSchema,
  AwsIamSecretsSchema,
  AzureAdConfigSchema,
  AzureAdSecretsSchema,
} from '../../validation/auth-profile-phase2.schema.js';

describe('AwsIamConfigSchema', () => {
  it('requires region', () => {
    expect(AwsIamConfigSchema.safeParse({}).success).toBe(false);
    expect(AwsIamConfigSchema.safeParse({ region: 'us-east-1' }).success).toBe(true);
  });

  it('accepts optional service, roleArn, externalId', () => {
    expect(
      AwsIamConfigSchema.safeParse({
        region: 'us-east-1',
        service: 's3',
        roleArn: 'arn:aws:iam::123456:role/my-role',
        externalId: 'ext-123',
      }).success,
    ).toBe(true);
  });
});

describe('AwsIamSecretsSchema', () => {
  it('requires accessKeyId and secretAccessKey', () => {
    expect(AwsIamSecretsSchema.safeParse({}).success).toBe(false);
    expect(
      AwsIamSecretsSchema.safeParse({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }).success,
    ).toBe(true);
  });

  it('accepts optional sessionToken', () => {
    expect(
      AwsIamSecretsSchema.safeParse({
        accessKeyId: 'AKIA...',
        secretAccessKey: 'wJal...',
        sessionToken: 'FwoG...',
      }).success,
    ).toBe(true);
  });
});

describe('AzureAdConfigSchema', () => {
  it('requires tenantId and resource', () => {
    expect(AzureAdConfigSchema.safeParse({}).success).toBe(false);
    expect(
      AzureAdConfigSchema.safeParse({
        tenantId: 'my-azure-tenant',
        resource: 'https://graph.microsoft.com',
      }).success,
    ).toBe(true);
  });

  it('defaults endpoint to login.microsoftonline.com', () => {
    const result = AzureAdConfigSchema.safeParse({
      tenantId: 'my-azure-tenant',
      resource: 'https://graph.microsoft.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoint).toBe('https://login.microsoftonline.com');
    }
  });
});

describe('AzureAdSecretsSchema', () => {
  it('requires clientId and clientSecret', () => {
    expect(AzureAdSecretsSchema.safeParse({}).success).toBe(false);
    expect(
      AzureAdSecretsSchema.safeParse({
        clientId: 'app-id',
        clientSecret: 'secret-value',
      }).success,
    ).toBe(true);
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: FAIL — new schemas not exported
```

**Step 2 -- Implement (append to auth-profile-phase2.schema.ts):**

```typescript
// ── aws_iam ────────────────────────────────────────────────────────────
export const AwsIamConfigSchema = z
  .object({
    region: z.string().min(1),
    service: z.string().optional(),
    roleArn: z.string().optional(),
    externalId: z.string().optional(),
  })
  .strict();

export const AwsIamSecretsSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  })
  .strict();

// ── azure_ad ───────────────────────────────────────────────────────────
export const AzureAdConfigSchema = z
  .object({
    tenantId: z.string().min(1),
    resource: z.string().url(),
    endpoint: z.string().url().default('https://login.microsoftonline.com'),
  })
  .strict();

export const AzureAdSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();
```

**Run to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: PASS
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git add packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git commit -m "feat(shared): add Zod schemas for aws_iam and azure_ad auth types"
```

---

### Task 4: Zod schemas for `mtls` and `ssh_key`

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-phase2.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`

**Step 1 -- Add failing tests:**

```typescript
// Append to packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
import {
  MtlsConfigSchema,
  MtlsSecretsSchema,
  SshKeyConfigSchema,
  SshKeySecretsSchema,
} from '../../validation/auth-profile-phase2.schema.js';

describe('MtlsConfigSchema', () => {
  it('accepts empty object', () => {
    expect(MtlsConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe('MtlsSecretsSchema', () => {
  it('requires clientCert and clientKey', () => {
    expect(MtlsSecretsSchema.safeParse({}).success).toBe(false);
    expect(
      MtlsSecretsSchema.safeParse({
        clientCert: '-----BEGIN CERTIFICATE-----\n...',
        clientKey: '-----BEGIN PRIVATE KEY-----\n...',
      }).success,
    ).toBe(true);
  });

  it('accepts optional caCert', () => {
    expect(
      MtlsSecretsSchema.safeParse({
        clientCert: 'cert',
        clientKey: 'key',
        caCert: 'ca-cert',
      }).success,
    ).toBe(true);
  });
});

describe('SshKeyConfigSchema', () => {
  it('defaults keyType to rsa', () => {
    const result = SshKeyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyType).toBe('rsa');
    }
  });

  it('accepts ed25519', () => {
    expect(SshKeyConfigSchema.safeParse({ keyType: 'ed25519' }).success).toBe(true);
  });
});

describe('SshKeySecretsSchema', () => {
  it('requires privateKey', () => {
    expect(SshKeySecretsSchema.safeParse({}).success).toBe(false);
    expect(
      SshKeySecretsSchema.safeParse({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...' })
        .success,
    ).toBe(true);
  });

  it('accepts optional passphrase', () => {
    expect(SshKeySecretsSchema.safeParse({ privateKey: 'key', passphrase: 'pass' }).success).toBe(
      true,
    );
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: FAIL — new schemas not exported
```

**Step 2 -- Implement (append to auth-profile-phase2.schema.ts):**

```typescript
// ── mtls ───────────────────────────────────────────────────────────────
export const MtlsConfigSchema = z.object({}).strict();

export const MtlsSecretsSchema = z
  .object({
    clientCert: z.string().min(1),
    clientKey: z.string().min(1),
    caCert: z.string().optional(),
  })
  .strict();

// ── ssh_key ────────────────────────────────────────────────────────────
export const SshKeyConfigSchema = z
  .object({
    keyType: z.enum(['ed25519', 'rsa']).default('rsa'),
  })
  .strict();

export const SshKeySecretsSchema = z
  .object({
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  })
  .strict();
```

**Run to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
# Expected: PASS
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git add packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts
git commit -m "feat(shared): add Zod schemas for mtls and ssh_key auth types"
```

---

### Task 5: Wire Phase 2 schemas into CreateAuthProfile discriminated union

**Files:**

- Modify: `packages/shared/src/validation/auth-profile.schema.ts`
- Modify: `packages/shared/src/validation/index.ts`
- Test: existing Phase 1 schema tests still pass + new Phase 2 types accepted

**Step 1 -- Read the existing `auth-profile.schema.ts` to verify the discriminated union structure.**

**Step 2 -- Add Phase 2 config/secrets branches to the existing `z.discriminatedUnion('authType', [...])` in `CreateAuthProfileSchema`:**

For each new auth type, add a branch:

```typescript
// In the discriminatedUnion array, add:
z.object({
  authType: z.literal('basic'),
  config: BasicConfigSchema,
  secrets: BasicSecretsSchema,
  // ...common fields
}),
z.object({
  authType: z.literal('custom_header'),
  config: CustomHeaderConfigSchema,
  secrets: CustomHeaderSecretsSchema,
}),
z.object({
  authType: z.literal('aws_iam'),
  config: AwsIamConfigSchema,
  secrets: AwsIamSecretsSchema,
}),
z.object({
  authType: z.literal('azure_ad'),
  config: AzureAdConfigSchema,
  secrets: AzureAdSecretsSchema,
}),
z.object({
  authType: z.literal('mtls'),
  config: MtlsConfigSchema,
  secrets: MtlsSecretsSchema,
}),
z.object({
  authType: z.literal('ssh_key'),
  config: SshKeyConfigSchema,
  secrets: SshKeySecretsSchema,
}),
```

Import all schemas from `./auth-profile-phase2.schema.js`.

**Step 3 -- Export Phase 2 schemas from `packages/shared/src/validation/index.ts`:**

```typescript
export * from './auth-profile-phase2.schema.js';
```

**Step 4 -- Run all existing schema tests to verify no regressions:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/
# Expected: PASS (all Phase 1 + Phase 2 schema tests)
```

**Step 5 -- Build:**

```bash
pnpm build --filter=@agent-platform/shared
# Expected: Build succeeds
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile.schema.ts packages/shared/src/validation/index.ts
git add packages/shared/src/validation/auth-profile.schema.ts packages/shared/src/validation/auth-profile-phase2.schema.ts packages/shared/src/validation/index.ts
git commit -m "feat(shared): wire Phase 2 auth type schemas into CreateAuthProfile union"
```

---

### Task 6: `applyAuth()` dispatcher for `basic`, `custom_header`

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`

**Step 1 -- Read `apply-auth.ts` to verify the existing dispatcher signature and pattern.**

**Step 2 -- Write failing tests:**

```typescript
// packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
import { describe, it, expect } from 'vitest';
import { applyAuth } from '../../services/auth-profile/apply-auth.js';

describe('applyAuth - basic', () => {
  it('sets Authorization header with Base64 encoded credentials', () => {
    const request = { headers: {} as Record<string, string> };
    applyAuth(request, {
      authType: 'basic',
      config: {},
      secrets: { username: 'admin', password: 's3cret' },
    });
    const expected = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`;
    expect(request.headers['Authorization']).toBe(expected);
  });
});

describe('applyAuth - custom_header', () => {
  it('sets all custom headers from secrets', () => {
    const request = { headers: {} as Record<string, string> };
    applyAuth(request, {
      authType: 'custom_header',
      config: { headers: { 'X-Api-Key': 'api-key', 'X-Secret': 'secret' } },
      secrets: { headerValues: { 'X-Api-Key': 'key-123', 'X-Secret': 'sec-456' } },
    });
    expect(request.headers['X-Api-Key']).toBe('key-123');
    expect(request.headers['X-Secret']).toBe('sec-456');
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/apply-auth-phase2.test.ts
# Expected: FAIL — applyAuth does not handle 'basic' or 'custom_header'
```

**Step 3 -- Add cases to the `applyAuth()` switch statement:**

```typescript
// In apply-auth.ts, add to the switch (credential.authType):
case 'basic': {
  const { username, password } = credential.secrets;
  request.headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  break;
}
case 'custom_header': {
  const { headerValues } = credential.secrets;
  for (const [name, value] of Object.entries(headerValues)) {
    request.headers[name] = value;
  }
  break;
}
```

**Run to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/apply-auth-phase2.test.ts
# Expected: PASS
```

**Commit:**

```bash
npx prettier --write packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git add packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git commit -m "feat(shared): add applyAuth() support for basic and custom_header"
```

---

### Task 7: `applyAuth()` dispatcher for `aws_iam`

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`

**Step 1 -- Write failing test:**

```typescript
// Append to apply-auth-phase2.test.ts
describe('applyAuth - aws_iam', () => {
  it('signs request with AWS SigV4 headers', async () => {
    const request = {
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/my-bucket',
      headers: {} as Record<string, string>,
      body: '',
    };
    await applyAuth(request, {
      authType: 'aws_iam',
      config: { region: 'us-east-1', service: 's3' },
      secrets: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    });
    expect(request.headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256/);
    expect(request.headers['x-amz-date']).toBeDefined();
  });
});
```

**Note:** `applyAuth()` must become async (or already is) to support SigV4 signing. Read the current signature before modifying.

**Step 2 -- Implement using `@aws-sdk/signature-v4`:**

```typescript
case 'aws_iam': {
  const { SignatureV4 } = await import('@aws-sdk/signature-v4');
  const { Sha256 } = await import('@aws-crypto/sha256-js');
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credential.secrets.accessKeyId,
      secretAccessKey: credential.secrets.secretAccessKey,
      sessionToken: credential.secrets.sessionToken,
    },
    region: credential.config.region,
    service: credential.config.service ?? 'execute-api',
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: request.method ?? 'GET',
    headers: request.headers,
    hostname: new URL(request.url).hostname,
    path: new URL(request.url).pathname,
    body: request.body ?? '',
  });
  Object.assign(request.headers, signed.headers);
  break;
}
```

**Run to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/apply-auth-phase2.test.ts
# Expected: PASS
```

**Commit:**

```bash
npx prettier --write packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git add packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git commit -m "feat(shared): add applyAuth() support for aws_iam with SigV4 signing"
```

---

### Task 8: `applyAuth()` dispatcher for `azure_ad`

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`

**Step 1 -- Write failing test:**

```typescript
describe('applyAuth - azure_ad', () => {
  it('fetches a bearer token via client credentials and sets Authorization header', async () => {
    // Mock the token fetch
    const request = { headers: {} as Record<string, string> };
    // Use vi.mock to intercept @azure/identity
    await applyAuth(request, {
      authType: 'azure_ad',
      config: {
        tenantId: 'test-tenant',
        resource: 'https://graph.microsoft.com',
        endpoint: 'https://login.microsoftonline.com',
      },
      secrets: { clientId: 'app-id', clientSecret: 'secret' },
    });
    expect(request.headers['Authorization']).toMatch(/^Bearer /);
  });
});
```

**Step 2 -- Implement using `@azure/identity` lazy import:**

```typescript
case 'azure_ad': {
  const { ClientSecretCredential } = await import('@azure/identity');
  const cred = new ClientSecretCredential(
    credential.config.tenantId,
    credential.secrets.clientId,
    credential.secrets.clientSecret,
    { authorityHost: credential.config.endpoint },
  );
  const token = await cred.getToken(`${credential.config.resource}/.default`);
  if (!token) throw new AuthProfileError('AZURE_AD_TOKEN_FAILED', 'Failed to acquire Azure AD token');
  request.headers['Authorization'] = `Bearer ${token.token}`;
  break;
}
```

**Commit:**

```bash
npx prettier --write packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git add packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git commit -m "feat(shared): add applyAuth() support for azure_ad"
```

---

### Task 9: `applyAuth()` dispatcher for `mtls`, `ssh_key`

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`

**Step 1 -- Write failing tests:**

```typescript
describe('applyAuth - mtls', () => {
  it('sets TLS client certificate options on request', async () => {
    const request = { headers: {} as Record<string, string>, tlsOptions: {} as any };
    await applyAuth(request, {
      authType: 'mtls',
      config: {},
      secrets: { clientCert: 'cert-pem', clientKey: 'key-pem', caCert: 'ca-pem' },
    });
    expect(request.tlsOptions.cert).toBe('cert-pem');
    expect(request.tlsOptions.key).toBe('key-pem');
    expect(request.tlsOptions.ca).toBe('ca-pem');
  });
});

describe('applyAuth - ssh_key', () => {
  it('sets SSH key options on request', async () => {
    const request = { headers: {} as Record<string, string>, sshOptions: {} as any };
    await applyAuth(request, {
      authType: 'ssh_key',
      config: { keyType: 'ed25519' },
      secrets: { privateKey: 'key-content', passphrase: 'my-pass' },
    });
    expect(request.sshOptions.privateKey).toBe('key-content');
    expect(request.sshOptions.passphrase).toBe('my-pass');
  });
});
```

**Step 2 -- Implement:**

```typescript
case 'mtls': {
  request.tlsOptions = {
    cert: credential.secrets.clientCert,
    key: credential.secrets.clientKey,
    ...(credential.secrets.caCert && { ca: credential.secrets.caCert }),
  };
  break;
}
case 'ssh_key': {
  request.sshOptions = {
    privateKey: credential.secrets.privateKey,
    ...(credential.secrets.passphrase && { passphrase: credential.secrets.passphrase }),
  };
  break;
}
```

**Commit:**

```bash
npx prettier --write packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git add packages/shared/src/services/auth-profile/apply-auth.ts packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts
git commit -m "feat(shared): add applyAuth() support for mtls and ssh_key"
```

---

### Task 10: Install `@aws-sdk/signature-v4`, `@azure/identity`, `ssh2`

**Files:**

- Modify: `packages/shared/package.json`
- Modify: All `apps/*/Dockerfile` that use `pnpm install --frozen-lockfile`

**Step 1 -- Install dependencies:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm add @aws-sdk/signature-v4 @aws-crypto/sha256-js @azure/identity ssh2 --filter=@agent-platform/shared
pnpm add -D @types/ssh2 --filter=@agent-platform/shared
```

**Step 2 -- Verify all Dockerfiles copy `packages/shared/package.json`:**

Check: `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`. If any are missing the `COPY packages/shared/package.json` line, add it.

**Step 3 -- Build:**

```bash
pnpm build --filter=@agent-platform/shared
# Expected: Build succeeds
```

**Commit:**

```bash
git add packages/shared/package.json pnpm-lock.yaml
git commit -m "chore(shared): install @aws-sdk/signature-v4, @azure/identity, ssh2"
```

---

## Phase B -- Addons Activation

> Removes Phase 1 rejection guard and activates `signing`, `webhookVerification`, and `proxy` addons with Zod validation and invalid combination enforcement.

### Task 11: Remove Phase 1 addon rejection guard

**Files:**

- Modify: `packages/shared/src/services/auth-profile.service.ts` (or equivalent service file)
- Test: existing test that verifies 400 on addon fields should now pass

**Step 1 -- Read `auth-profile.service.ts` and find the addon rejection guard** (the code that returns 400 "Addon mechanisms are not yet supported").

**Step 2 -- Remove the guard. Update or remove the corresponding test.**

**Step 3 -- Run existing tests:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/
# Expected: PASS (addon rejection test removed or inverted)
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(shared): remove Phase 1 addon rejection guard"
```

---

### Task 12: Signing addon Zod schema + `applySigning()` function

**Files:**

- Create: `packages/shared/src/validation/auth-profile-addons.schema.ts`
- Create: `packages/shared/src/services/auth-profile/apply-signing.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// packages/shared/src/__tests__/auth-profile/addon-schema.test.ts
import { describe, it, expect } from 'vitest';
import { SigningAddonSchema } from '../../validation/auth-profile-addons.schema.js';

describe('SigningAddonSchema', () => {
  it('requires algorithm and signedComponents', () => {
    expect(SigningAddonSchema.safeParse({}).success).toBe(false);
    expect(
      SigningAddonSchema.safeParse({
        algorithm: 'hmac-sha256',
        signedComponents: ['body', 'timestamp'],
      }).success,
    ).toBe(true);
  });

  it('accepts optional timestampHeader and signatureHeader', () => {
    expect(
      SigningAddonSchema.safeParse({
        algorithm: 'hmac-sha512',
        signedComponents: ['body'],
        timestampHeader: 'X-Timestamp',
        signatureHeader: 'X-Signature',
      }).success,
    ).toBe(true);
  });

  it('rejects invalid algorithm', () => {
    expect(
      SigningAddonSchema.safeParse({
        algorithm: 'invalid',
        signedComponents: ['body'],
      }).success,
    ).toBe(false);
  });
});
```

**Step 2 -- Implement schema:**

```typescript
// packages/shared/src/validation/auth-profile-addons.schema.ts
import { z } from 'zod';

export const SigningAddonSchema = z
  .object({
    algorithm: z.enum(['hmac-sha256', 'hmac-sha512', 'aws-sig-v4', 'rsa-sha256']),
    signedComponents: z.array(z.enum(['body', 'timestamp', 'url', 'headers'])).min(1),
    timestampHeader: z.string().optional(),
    signatureHeader: z.string().optional(),
  })
  .strict();
```

**Step 3 -- Implement `applySigning()`:**

```typescript
// packages/shared/src/services/auth-profile/apply-signing.ts
import crypto from 'node:crypto';

export function applySigning(
  request: { headers: Record<string, string>; body?: string; url?: string; method?: string },
  signing: {
    algorithm: string;
    signedComponents: string[];
    timestampHeader?: string;
    signatureHeader?: string;
  },
  signingSecret: string,
): void {
  const timestamp = new Date().toISOString();
  const components: string[] = [];
  for (const component of signing.signedComponents) {
    switch (component) {
      case 'body':
        components.push(request.body ?? '');
        break;
      case 'timestamp':
        components.push(timestamp);
        break;
      case 'url':
        components.push(request.url ?? '');
        break;
      case 'headers':
        components.push(JSON.stringify(request.headers));
        break;
    }
  }
  const payload = components.join('\n');
  const algoMap: Record<string, string> = {
    'hmac-sha256': 'sha256',
    'hmac-sha512': 'sha512',
  };
  const hmacAlgo = algoMap[signing.algorithm];
  if (hmacAlgo) {
    const signature = crypto.createHmac(hmacAlgo, signingSecret).update(payload).digest('hex');
    request.headers[signing.signatureHeader ?? 'X-Signature'] = signature;
  } else if (signing.algorithm === 'rsa-sha256') {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(payload);
    const signature = sign.sign(signingSecret, 'hex');
    request.headers[signing.signatureHeader ?? 'X-Signature'] = signature;
  } else if (signing.algorithm === 'aws-sig-v4') {
    // aws-sig-v4 signing is handled by applyAuth() for aws_iam auth type.
    // The invalid combination matrix blocks aws_iam + signing addon,
    // so this branch is unreachable. Throw if somehow reached.
    throw new Error('aws-sig-v4 signing addon is not supported; use aws_iam auth type instead');
  }
  if (signing.timestampHeader) {
    request.headers[signing.timestampHeader] = timestamp;
  }
}
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile-addons.schema.ts packages/shared/src/services/auth-profile/apply-signing.ts packages/shared/src/__tests__/auth-profile/addon-schema.test.ts
git add packages/shared/src/validation/auth-profile-addons.schema.ts packages/shared/src/services/auth-profile/apply-signing.ts packages/shared/src/__tests__/auth-profile/addon-schema.test.ts
git commit -m "feat(shared): add signing addon schema and applySigning() function"
```

---

### Task 13: Webhook verification addon schema + `verifyWebhook()` function

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-addons.schema.ts`
- Create: `packages/shared/src/services/auth-profile/verify-webhook.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// Append to addon-schema.test.ts
import { WebhookVerificationAddonSchema } from '../../validation/auth-profile-addons.schema.js';

describe('WebhookVerificationAddonSchema', () => {
  it('requires method and signatureHeader', () => {
    expect(WebhookVerificationAddonSchema.safeParse({}).success).toBe(false);
    expect(
      WebhookVerificationAddonSchema.safeParse({
        method: 'hmac-sha256',
        signatureHeader: 'X-Hub-Signature-256',
      }).success,
    ).toBe(true);
  });

  it('accepts optional timestampHeader and toleranceSeconds', () => {
    expect(
      WebhookVerificationAddonSchema.safeParse({
        method: 'hmac-sha1',
        signatureHeader: 'X-Signature',
        timestampHeader: 'X-Timestamp',
        toleranceSeconds: 300,
      }).success,
    ).toBe(true);
  });
});
```

**Step 2 -- Implement schema (append to auth-profile-addons.schema.ts):**

```typescript
export const WebhookVerificationAddonSchema = z
  .object({
    method: z.enum(['hmac-sha256', 'hmac-sha1', 'svix', 'rsa-sha256']),
    signatureHeader: z.string().min(1),
    timestampHeader: z.string().optional(),
    toleranceSeconds: z.number().int().positive().optional(),
  })
  .strict();
```

**Step 3 -- Implement `verifyWebhook()`:**

```typescript
// packages/shared/src/services/auth-profile/verify-webhook.ts
import crypto from 'node:crypto';

export function verifyWebhook(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string,
  method: 'hmac-sha256' | 'hmac-sha1' | 'svix' | 'rsa-sha256',
  timestamp?: string,
  toleranceSeconds?: number,
): boolean {
  if (timestamp && toleranceSeconds) {
    const ts = new Date(timestamp).getTime();
    if (Math.abs(Date.now() - ts) > toleranceSeconds * 1000) {
      return false; // Replay attack
    }
  }
  const algoMap: Record<string, string> = { 'hmac-sha256': 'sha256', 'hmac-sha1': 'sha1' };
  const algo = algoMap[method];
  if (!algo) return false; // svix and rsa-sha256 require specialized verification
  const expected = crypto.createHmac(algo, webhookSecret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch -- guard against it
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(shared): add webhook verification addon schema and verifyWebhook()"
```

---

### Task 14: Proxy addon schema + `applyProxy()` function

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-addons.schema.ts`
- Create: `packages/shared/src/services/auth-profile/apply-proxy.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// Append to addon-schema.test.ts
import { ProxyAddonSchema } from '../../validation/auth-profile-addons.schema.js';

describe('ProxyAddonSchema', () => {
  it('requires url', () => {
    expect(ProxyAddonSchema.safeParse({}).success).toBe(false);
    expect(ProxyAddonSchema.safeParse({ url: 'https://proxy.corp.com:8080' }).success).toBe(true);
  });

  it('accepts optional proxyAuthProfileId', () => {
    expect(
      ProxyAddonSchema.safeParse({
        url: 'https://proxy.corp.com:8080',
        proxyAuthProfileId: 'ap-proxy-1',
      }).success,
    ).toBe(true);
  });

  it('rejects non-HTTPS proxy URLs', () => {
    // SSRF: only HTTPS proxy URLs allowed
    expect(ProxyAddonSchema.safeParse({ url: 'http://internal:8080' }).success).toBe(false);
  });

  it('rejects internal/private network proxy URLs (SSRF)', () => {
    expect(ProxyAddonSchema.safeParse({ url: 'https://127.0.0.1:8080' }).success).toBe(false);
    expect(ProxyAddonSchema.safeParse({ url: 'https://10.0.0.1:8080' }).success).toBe(false);
    expect(ProxyAddonSchema.safeParse({ url: 'https://192.168.1.1:8080' }).success).toBe(false);
    expect(ProxyAddonSchema.safeParse({ url: 'https://localhost:8080' }).success).toBe(false);
  });
});
```

**Step 2 -- Implement schema:**

```typescript
// SSRF blocklist for proxy URLs
const BLOCKED_HOSTS =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;

export const ProxyAddonSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), {
        message: 'Proxy URL must use HTTPS',
      })
      .refine(
        (u) => {
          try {
            const hostname = new URL(u).hostname;
            return !BLOCKED_HOSTS.test(hostname);
          } catch {
            return false;
          }
        },
        { message: 'Proxy URL must not target internal/private networks (SSRF protection)' },
      ),
    proxyAuthProfileId: z.string().optional(),
  })
  .strict();
```

**Step 2b -- Proxy cross-reference validation (service-level, not schema-level):**

The following validations MUST be enforced in `AuthProfileService.create()` and `.update()` when `proxy` addon is present:

```typescript
// In AuthProfileService, during create/update:
async function validateProxyAddon(profile: {
  _id: string;
  tenantId: string;
  visibility: string;
  proxy?: { proxyAuthProfileId?: string };
}): Promise<void> {
  if (!profile.proxy?.proxyAuthProfileId) return;
  const proxyId = profile.proxy.proxyAuthProfileId;

  // 1. Self-reference check
  if (proxyId === profile._id) {
    throw new AuthProfileError('PROXY_SELF_REFERENCE', 'Proxy cannot reference itself');
  }

  // 2. Resolve proxy profile (same tenant)
  const proxyProfile = await AuthProfile.findOne({ _id: proxyId, tenantId: profile.tenantId });
  if (!proxyProfile) {
    throw new NotFoundError('Proxy auth profile not found');
  }

  // 3. Valid proxy auth types only
  const VALID_PROXY_AUTH_TYPES = ['basic', 'bearer', 'api_key', 'mtls'];
  if (!VALID_PROXY_AUTH_TYPES.includes(proxyProfile.authType)) {
    throw new AuthProfileError(
      'INVALID_PROXY_AUTH_TYPE',
      `Proxy auth profile must use one of: ${VALID_PROXY_AUTH_TYPES.join(', ')}`,
    );
  }

  // 4. Max chain depth = 1 (no nested proxies)
  if (proxyProfile.proxy) {
    throw new AuthProfileError('PROXY_CHAIN_TOO_DEEP', 'Nested proxy chains are not allowed');
  }

  // 5. Visibility check: shared must not reference personal
  if (profile.visibility === 'shared' && proxyProfile.visibility === 'personal') {
    throw new AuthProfileError(
      'PROXY_VISIBILITY_MISMATCH',
      'A shared profile cannot reference a personal profile as its proxy',
    );
  }
}
```

**Step 3 -- Implement `applyProxy()`:**

```typescript
// packages/shared/src/services/auth-profile/apply-proxy.ts
export function applyProxy(
  request: { proxyUrl?: string; proxyHeaders?: Record<string, string> },
  proxy: { url: string },
  proxyCredentials?: { authType: string; secrets: Record<string, unknown> },
): void {
  request.proxyUrl = proxy.url;
  if (proxyCredentials) {
    // Apply proxy auth (basic/bearer/api_key only)
    request.proxyHeaders = request.proxyHeaders ?? {};
    if (proxyCredentials.authType === 'basic') {
      const { username, password } = proxyCredentials.secrets as {
        username: string;
        password: string;
      };
      request.proxyHeaders['Proxy-Authorization'] =
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    } else if (proxyCredentials.authType === 'bearer') {
      const { token } = proxyCredentials.secrets as { token: string };
      request.proxyHeaders['Proxy-Authorization'] = `Bearer ${token}`;
    }
  }
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(shared): add proxy addon schema and applyProxy()"
```

---

### Task 15: Invalid combination matrix enforcement

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-addons.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// Append to addon-schema.test.ts
import { validateAddonCombination } from '../../validation/auth-profile-addons.schema.js';

describe('validateAddonCombination', () => {
  it('rejects aws_iam + signing', () => {
    const result = validateAddonCombination('aws_iam', {
      signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/aws_iam.*signing/i);
  });

  it('rejects ssh_key + signing', () => {
    const result = validateAddonCombination('ssh_key', {
      signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects ssh_key + proxy', () => {
    const result = validateAddonCombination('ssh_key', { proxy: { url: 'https://proxy.com' } });
    expect(result.valid).toBe(false);
  });

  it('rejects webhookVerification + signing', () => {
    const result = validateAddonCombination('api_key', {
      webhookVerification: { method: 'hmac-sha256', signatureHeader: 'X-Sig' },
      signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects mtls + proxy', () => {
    const result = validateAddonCombination('mtls', { proxy: { url: 'https://proxy.com' } });
    expect(result.valid).toBe(false);
  });

  it('allows api_key + signing', () => {
    const result = validateAddonCombination('api_key', {
      signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] },
    });
    expect(result.valid).toBe(true);
  });

  it('allows oauth2_token + webhookVerification', () => {
    const result = validateAddonCombination('oauth2_token', {
      webhookVerification: { method: 'hmac-sha256', signatureHeader: 'X-Sig' },
    });
    expect(result.valid).toBe(true);
  });
});
```

**Step 2 -- Implement:**

```typescript
// In auth-profile-addons.schema.ts
interface AddonInput {
  signing?: unknown;
  webhookVerification?: unknown;
  proxy?: unknown;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const INVALID_COMBINATIONS: Array<{
  authType?: string;
  addon: string;
  addon2?: string;
  reason: string;
}> = [
  {
    authType: 'aws_iam',
    addon: 'signing',
    reason: 'aws_iam + signing: AWS SigV4 is itself a signing mechanism',
  },
  {
    authType: 'ssh_key',
    addon: 'signing',
    reason: 'ssh_key + signing: SSH key is not used in HTTP requests',
  },
  {
    authType: 'ssh_key',
    addon: 'proxy',
    reason: 'ssh_key + proxy: SSH key is not used in HTTP requests',
  },
  {
    addon: 'webhookVerification',
    addon2: 'signing',
    reason: 'webhookVerification + signing: opposite directions',
  },
  { authType: 'mtls', addon: 'proxy', reason: 'mtls + proxy: mTLS is terminated at the proxy' },
];

export function validateAddonCombination(authType: string, addons: AddonInput): ValidationResult {
  for (const rule of INVALID_COMBINATIONS) {
    if (rule.authType && rule.authType !== authType) continue;
    if (rule.addon2) {
      if (addons[rule.addon as keyof AddonInput] && addons[rule.addon2 as keyof AddonInput]) {
        return { valid: false, reason: rule.reason };
      }
    } else if (addons[rule.addon as keyof AddonInput]) {
      if (!rule.authType || rule.authType === authType) {
        return { valid: false, reason: rule.reason };
      }
    }
  }
  return { valid: true };
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(shared): enforce invalid addon combination matrix"
```

---

### Task 16: Addon secrets validation (signingSecret, webhookSecret)

**Files:**

- Modify: `packages/shared/src/validation/auth-profile-addons.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-schema.test.ts`

**Step 1 -- Write failing tests:**

```typescript
import { validateAddonSecrets } from '../../validation/auth-profile-addons.schema.js';

describe('validateAddonSecrets', () => {
  it('requires signingSecret when signing addon present', () => {
    const result = validateAddonSecrets(
      { signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] } },
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signingSecret/);
  });

  it('requires webhookSecret when webhookVerification addon present', () => {
    const result = validateAddonSecrets(
      { webhookVerification: { method: 'hmac-sha256', signatureHeader: 'X-Sig' } },
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/webhookSecret/);
  });

  it('passes when correct secrets are provided', () => {
    const result = validateAddonSecrets(
      { signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] } },
      { signingSecret: 'my-secret-key' },
    );
    expect(result.valid).toBe(true);
  });
});
```

**Step 2 -- Implement:**

```typescript
export function validateAddonSecrets(
  addons: { signing?: unknown; webhookVerification?: unknown },
  secrets: Record<string, unknown>,
): ValidationResult {
  if (addons.signing && !secrets.signingSecret) {
    return { valid: false, reason: 'signingSecret is required when signing addon is configured' };
  }
  if (addons.webhookVerification && !secrets.webhookSecret) {
    return {
      valid: false,
      reason: 'webhookSecret is required when webhookVerification addon is configured',
    };
  }
  return { valid: true };
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(shared): validate addon secrets alongside base-type secrets"
```

---

## Phase C -- Consumer Migration (14 consumers)

> Each consumer model gets an `authProfileId` field and dual-read logic. Grouped by risk level: low-risk first (metadata/config consumers), then medium-risk (runtime consumers), then high-risk (LLM resolution, OAuth).

### Generic Dual-Read Pattern

All consumer migrations follow this template:

```typescript
// 1. Add authProfileId field to the model
authProfileId: { type: String, default: null },

// 2. At module level (cached, not read on every call):
const AUTH_PROFILE_ENABLED = process.env.AUTH_PROFILE_ENABLED === 'true';

// 3. At resolution time:
async function resolveCredential(
  entity: { authProfileId?: string; credentialId?: string; /* legacy field */ },
  tenantId: string,
): Promise<DecryptedCredentials> {
  if (AUTH_PROFILE_ENABLED && entity.authProfileId) {
    // IMPORTANT: If resolve() throws (expired, revoked, decryption failure),
    // let the error propagate. Do NOT fall back to legacy on errors --
    // that would mask credential issues in production.
    return await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId });
  }
  // Legacy fallback: only when authProfileId is absent or feature is disabled
  return await legacyResolve(entity, tenantId);
}
```

### Task 17: `TenantModel.connections[].authProfileId` dual-read

**Files:**

- Modify: `packages/database/src/models/tenant-model.model.ts` -- add `authProfileId` to connection subdoc
- Modify: `apps/runtime/src/repos/tenant-model-repo.ts` -- dual-read in credential resolution
- Test: `apps/runtime/src/__tests__/auth-profile/tenant-model-dual-read.test.ts`

**Step 1 -- Read `packages/database/src/models/tenant-model.model.ts` to find the connection subdocument schema and the `credentialId` field.**

**Step 2 -- Write failing test:**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('TenantModel connection dual-read', () => {
  it('uses authProfileId when AUTH_PROFILE_ENABLED and authProfileId present', async () => {
    // Mock authProfileService.resolve()
    // Mock connection with authProfileId set
    // Assert authProfileService.resolve() was called, not legacy path
  });

  it('falls back to credentialId when authProfileId is null', async () => {
    // Mock connection with authProfileId: null, credentialId: 'cred-123'
    // Assert legacy credential resolution was called
  });

  it('falls back to credentialId when AUTH_PROFILE_ENABLED is false', async () => {
    // Even if authProfileId is set, use legacy path
  });
});
```

**Step 3 -- Add `authProfileId` to the connection subdocument:**

```typescript
// In tenant-model.model.ts, in the connection subdocument schema:
authProfileId: { type: String, default: null },
```

**Step 4 -- Update `tenant-model-repo.ts` to use dual-read in the credential resolution function.** Read the existing resolution logic first, then add the Auth Profile branch.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add authProfileId dual-read to TenantModel connections"
```

---

### Task 18: `ModelConfig.authProfileId` dual-read

**Files:**

- Modify: `packages/database/src/models/model-config.model.ts` -- add `authProfileId`
- Modify: `apps/runtime/src/services/llm/model-resolution.ts` -- dual-read at `findCredentialById` call site
- Test: `apps/runtime/src/__tests__/auth-profile/model-config-dual-read.test.ts`

**Step 1 -- Read `model-config.model.ts` and find the `credentialId` field.**

**Step 2 -- Add `authProfileId: { type: String, default: null }` alongside `credentialId`.**

**Step 3 -- In `model-resolution.ts`, find where `findCredentialById` is called. Add dual-read:**

```typescript
// Before the existing findCredentialById call:
if (AUTH_PROFILE_ENABLED && modelConfig.authProfileId) {
  const authProfile = await authProfileService.resolve({
    authProfileId: modelConfig.authProfileId,
    tenantId: ctx.tenantId,
  });
  return mapAuthProfileToLLMCredential(authProfile);
}
// Existing legacy path:
const credential = await findCredentialById(modelConfig.credentialId, ctx.tenantId);
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add authProfileId dual-read to ModelConfig"
```

---

### Tasks 19-30: Remaining consumer migrations

Each follows the same pattern as Tasks 17-18. For brevity, the steps for each are:

1. Read the model source to find the legacy credential field
2. Add `authProfileId: { type: String, default: null }` to the model
3. Find the resolution/usage site in runtime or service code
4. Add dual-read gated by `AUTH_PROFILE_ENABLED`
5. Write test for both paths
6. Commit

**Task 19 -- MCPServerConfig:** Add `authProfileId` alongside `encryptedAuthConfig`. Read `packages/database/src/models/mcp-server-config.model.ts` and `packages/shared/src/services/mcp-auth-resolver.ts` for the resolution site.

**Task 20 -- ChannelConnection:** Add `authProfileId` to `packages/database/src/models/channel-connection.model.ts` alongside `encryptedCredentials`. Update `apps/runtime/src/channels/connection-resolver.ts` where `connection.encryptedCredentials` is decrypted.

**Task 21 -- ServiceNode:** Add `authProfileId` alongside `encryptedSecrets`. Update `apps/runtime/src/services/adapters/service-node-executor.ts` (the service-node-executor).

**Task 22 -- TenantGuardrailProviderConfig:** Add `authProfileId` alongside `apiKeyCredentialId`. Read `packages/database/src/models/guardrail-provider-config.model.ts`.

**Task 23 -- GuardrailPolicy providerOverrides:** Add `authProfileId` alongside `apiKeyCredentialId` in the `providerOverrides` subdocument.

**Task 24 -- TenantServiceInstance (voice):** Add `authProfileId` alongside `encryptedApiKey`. Update `apps/runtime/src/services/voice/voice-service-factory.ts`.

**Task 25 -- ArchWorkspaceConfig:** Add `authProfileId` alongside `encryptedApiKey`. Read `packages/database/src/models/arch-workspace-config.model.ts`.

**Task 26 -- GitIntegration:** Add `authProfileId` alongside `credentials.secretId`. Read `packages/database/src/models/git-integration.model.ts`.

**Task 27 -- WebhookSubscription/WebhookSubscriptionConnector:** Add `authProfileId` alongside `encryptedSecret` (in `webhook-subscription.model.ts`) and `encryptedClientState` (in `webhook-subscription-connector.model.ts`). Both models at `packages/database/src/models/`.

**Task 28 -- SDKChannel:** Add `authProfileId` alongside `secretKey`. Read `packages/database/src/models/sdk-channel.model.ts`.

**Task 29 -- TriggerRegistration:** Add `authProfileId` for inline credentials. Check if model exists via `Glob` for `trigger-registration.model.ts`.

**Task 30 -- OrgProxyConfig multi-credential merge:** This is the complex case. Read `packages/database/src/models/org-proxy-config.model.ts`. Strategy: create multiple Auth Profiles (one per auth type), linked via a `groupId` field. `OrgProxyConfig.authProfileId` references the primary. **Dependency: Task 1 must also add the `groupId` field (`{ type: String, default: null }`) and a new index `{ groupId: 1 }` to the AuthProfile schema.** Also add `migrationStatus` field (`{ type: String, enum: ['active', 'migrating', 'migrated'], default: 'active' }`) for Phase G migration tracking.

Each task follows the same commit pattern:

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(<package>): add authProfileId dual-read to <ConsumerName>"
```

---

## Phase D -- Worker Migration

> Updates workers that directly access credentials. Group 1 (search-ai) cascades from a shared resolver. Others are individual updates.
>
> **Worker Group 3 (runtime: delivery-worker, inbound-worker):** These workers resolve credentials through `connection-resolver.ts`, which is updated in Phase 1 (Task 53). No separate Phase 2 tasks needed -- they cascade automatically from the Phase 1 connection resolver dual-read.
>
> **HTTP Tool (DSL-defined):** Covered by Task 36 (`RuntimeSecretsProvider`), not as a separate consumer migration task. The `auth: "profile-name"` DSL resolution routes through the secrets provider.
>
> **`connection-resolver.ts` dual-read (Deliverable #12):** Already completed in Phase 1 (Task 53). Phase 2 consumers that use it (ChannelConnection, delivery/inbound workers) inherit the dual-read automatically.

### Task 31: Search-AI shared resolver dual-read

**Files:**

- Modify: `apps/search-ai/src/services/llm-config/resolver.ts`
- Modify: `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`
- Test: `apps/search-ai/src/services/llm-config/__tests__/resolver-auth-profile.test.ts`

**Step 1 -- Read `resolver.ts` (full file) and `tenant-model-adapter.ts` to understand how `LLMCredential` is currently resolved.** The resolver uses `resolveTenantModelWithFallback()` which queries `TenantModel.connections[]` for the credential.

**Step 2 -- Write failing test:**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Search-AI LLM config resolver - Auth Profile dual-read', () => {
  it('resolves credential via authProfileId when present on TenantModel connection', async () => {
    // Mock TenantModel connection with authProfileId
    // Mock authProfileService.resolve()
    // Call resolver
    // Assert authProfileService.resolve() was called
  });

  it('falls back to legacy credentialId when authProfileId is absent', async () => {
    // Mock connection with credentialId only
    // Assert LLMCredential was queried
  });
});
```

**Step 3 -- Update `tenant-model-adapter.ts` to check `connection.authProfileId` first:**

```typescript
// In the function that resolves credentials from TenantModel connections:
if (AUTH_PROFILE_ENABLED && connection.authProfileId) {
  const profile = await authProfileService.resolve({
    authProfileId: connection.authProfileId,
    tenantId,
  });
  return { apiKey: profile.secrets.apiKey, ...mapProfileToConfig(profile) };
}
// Legacy: decrypt connection.credentialId via LLMCredential
```

This single change cascades to all 9+ search-ai workers that use the resolver.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(search-ai): add Auth Profile dual-read to LLM config resolver"
```

---

### Task 32: Search-AI embedding credentials dual-read

**Files:**

- Modify: `apps/search-ai/src/services/llm-config/embedding-credentials.ts`
- Test: `apps/search-ai/src/services/llm-config/__tests__/embedding-credentials.test.ts`

Same pattern as Task 31 but for the embedding-specific credential resolution path.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(search-ai): add Auth Profile dual-read to embedding credentials"
```

---

### Task 33: IDP sync scheduler + sync workers dual-read

**Files:**

- Modify: `apps/search-ai/src/workers/idp-sync-scheduler.ts`
- Modify: `apps/search-ai/src/workers/azuread-user-sync-worker.ts`
- Modify: `apps/search-ai/src/workers/azuread-group-sync-worker.ts`
- Modify: `apps/search-ai/src/workers/okta-user-sync-worker.ts`
- Modify: `apps/search-ai/src/workers/okta-group-sync-worker.ts`
- Modify: `apps/search-ai/src/workers/google-user-sync-worker.ts`
- Modify: `apps/search-ai/src/workers/google-group-sync-worker.ts`
- Test: `apps/search-ai/src/workers/__tests__/idp-sync-scheduler-auth-profile.test.ts`

**WARNING:** This is a high-risk migration. The scheduler does `LLMCredential.find()` with broad filters and uses `(cred as any).metadata` type casts. The individual sync workers (Azure AD, Okta, Google) each directly query `LLMCredential` using `credentialId` from job data. Before implementing:

1. **Read the full `idp-sync-scheduler.ts`** to understand the metadata field naming conventions
2. **Read at least one sync worker** (e.g., `azuread-user-sync-worker.ts`) to see how it resolves `credentialId` from job data and queries `LLMCredential` directly
3. **Update the scheduler** to pass `authProfileId` in job data alongside `credentialId` when dispatching jobs
4. **Update each sync worker** to dual-read: if `job.data.authProfileId` present, resolve via `AuthProfileService`; else fall back to legacy `LLMCredential.findOne({ _id: credentialId })` path
5. **Do not migrate data yet** -- that is Task 42 (migration scripts)

**Note:** The design doc references OneLogin, PingIdentity, and Generic SCIM sync workers, but these do NOT exist in the codebase. Only Azure AD, Okta, and Google sync workers exist.

**Commit:**

```bash
npx prettier --write apps/search-ai/src/workers/idp-sync-scheduler.ts apps/search-ai/src/workers/azuread-*.ts apps/search-ai/src/workers/okta-*.ts apps/search-ai/src/workers/google-*.ts
git add apps/search-ai/src/workers/
git commit -m "feat(search-ai): add Auth Profile dual-read to IDP sync scheduler and sync workers"
```

---

### Task 34: Runtime `model-resolution.ts` dual-read

**Files:**

- Modify: `apps/runtime/src/services/llm/model-resolution.ts`
- Modify: `apps/runtime/src/repos/llm-resolution-repo.ts`
- Test: `apps/runtime/src/__tests__/auth-profile/model-resolution-dual-read.test.ts`

**Step 1 -- Read `model-resolution.ts` to find all `findCredentialById` and `findDefaultUserCredential` / `findDefaultTenantCredential` call sites.**

**Step 2 -- At each credential resolution call site, add dual-read:**

```typescript
// Before each findCredentialById(credId, tenantId):
if (AUTH_PROFILE_ENABLED && source.authProfileId) {
  return await resolveViaAuthProfile(source.authProfileId, tenantId);
}
```

**Step 3 -- Create a `resolveViaAuthProfile()` helper in model-resolution.ts that maps Auth Profile output to the existing `ResolvedCredential` interface.**

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add Auth Profile dual-read to model-resolution"
```

---

### Task 35: `tool-oauth-service.ts` Auth Profile integration

**Files:**

- Modify: `apps/runtime/src/services/tool-oauth-service.ts`
- Test: `apps/runtime/src/__tests__/tool-oauth-service.test.ts`

**Step 1 -- Read `tool-oauth-service.ts` to understand the `OAuthTokenStore` interface and token refresh logic.**

**Step 2 -- Add an Auth Profile resolution path:** When `AUTH_PROFILE_ENABLED`, use `authProfileService.resolve()` for token retrieval. Token refresh now uses the Phase 1 distributed lock infrastructure instead of the lockless legacy path.

```typescript
// New method:
async getAccessTokenViaAuthProfile(
  tenantId: string,
  userId: string,
  connector: string,
): Promise<string | undefined> {
  const profile = await authProfileService.resolve({
    tenantId,
    connector,
    connectionMode: 'per_user',
    userId,
  });
  if (!profile) return undefined;
  return profile.secrets.accessToken;
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): integrate tool-oauth-service with AuthProfileService"
```

---

### Task 36: `RuntimeSecretsProvider` Auth Profile resolution path

**Files:**

- Modify: `apps/runtime/src/services/secrets-provider.ts`
- Test: `apps/runtime/src/__tests__/secrets-provider.test.ts`

**Step 1 -- Read `secrets-provider.ts` fully.** The provider implements `SecretsProvider` with a multi-layer lookup chain (special keys -> ToolSecret -> IR credentials -> env vars).

**Step 2 -- Insert Auth Profile as step 1.5 (after special keys, before ToolSecret):**

```typescript
// After special key check, before ToolSecret lookup:
if (AUTH_PROFILE_ENABLED) {
  try {
    const profile = await this.authProfileResolver?.resolveBySecretKey({
      tenantId: this.tenantId,
      projectId: this.projectId,
      secretKey: key,
      environment: this.environment,
    });
    if (profile) {
      return profile.secrets[key] ?? profile.secrets.apiKey;
    }
  } catch {
    // Fall through to legacy ToolSecret path
  }
}
```

**Step 3 -- Add `AuthProfileResolver` as a pluggable interface (matching the existing `ToolSecretStore` pattern):**

```typescript
export interface AuthProfileResolver {
  resolveBySecretKey(params: {
    tenantId: string;
    projectId: string;
    secretKey: string;
    environment: string;
  }): Promise<{ secrets: Record<string, string> } | null>;
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add Auth Profile resolution path to RuntimeSecretsProvider"
```

---

### Task 37: `TokenManager` (connectors/base) dual-read

**Files:**

- Modify: `packages/connectors/base/src/auth/token-manager.ts`
- Modify: the TokenManager to check `connection.authProfileId` before legacy token path
- Test: unit test for dual-read

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(search-ai): add Auth Profile dual-read to TokenManager"
```

---

## Phase E -- EncryptionService Multi-Key

> Extends the EncryptionService to support multiple key versions for credential rotation.

### Task 38: Extend `EncryptionService` for multi-key support

**Files:**

- Modify: `packages/shared/src/encryption/types.ts`
- Modify: `packages/shared/src/encryption/engine.ts`
- Test: `packages/shared/src/__tests__/encryption/multi-key.test.ts`

**Step 1 -- Write failing tests:**

```typescript
// packages/shared/src/__tests__/encryption/multi-key.test.ts
import { describe, it, expect } from 'vitest';
import { EncryptionService } from '../../encryption/engine.js';

describe('EncryptionService multi-key', () => {
  const currentKeyHex = 'a'.repeat(64); // 32-byte key
  const previousKeyHex = 'b'.repeat(64);

  it('encrypts with current key', () => {
    const svc = new EncryptionService({
      masterKeyHex: currentKeyHex,
      previous: [{ version: 1, masterKeyHex: previousKeyHex }],
    });
    const encrypted = svc.encrypt('secret', 'user-1');
    const decrypted = svc.decrypt(encrypted, 'user-1');
    expect(decrypted).toBe('secret');
  });

  it('decrypts data encrypted with previous key', () => {
    // Encrypt with what is now the "previous" key
    const oldSvc = new EncryptionService({ masterKeyHex: previousKeyHex });
    const encrypted = oldSvc.encrypt('old-secret', 'user-1');

    // New service with current + previous
    const newSvc = new EncryptionService({
      masterKeyHex: currentKeyHex,
      previous: [{ version: 1, masterKeyHex: previousKeyHex }],
    });
    const decrypted = newSvc.decryptWithFallback(encrypted, 'user-1');
    expect(decrypted).toBe('old-secret');
  });
});
```

**Step 2 -- Extend `EncryptionServiceConfig`:**

```typescript
// packages/shared/src/encryption/types.ts
export interface EncryptionServiceConfig {
  masterKeyHex: string;
  defaultStrategy?: KeyDerivationStrategy;
  cache?: { maxSize?: number; ttlMs?: number };
  previous?: Array<{ version: number; masterKeyHex: string }>;
}
```

**Step 3 -- Add `decryptWithFallback()` to `EncryptionService`:**

```typescript
// In engine.ts:
private readonly previousKeys: Array<{ version: number; masterKey: Buffer }>;

constructor(config: EncryptionServiceConfig) {
  // ... existing constructor code ...
  this.previousKeys = (config.previous ?? []).map(p => ({
    version: p.version,
    masterKey: Buffer.from(p.masterKeyHex, 'hex'),
  }));
}

decryptWithFallback(encryptedData: string, scope: string): string {
  // Try current key first
  try {
    return this.decrypt(encryptedData, scope);
  } catch {
    // Try previous keys in reverse order (newest first)
    for (const prev of this.previousKeys) {
      try {
        const key = this.strategy.deriveKey(prev.masterKey, scope);
        return this.aesGcmDecryptHex(encryptedData, key);
      } catch {
        continue;
      }
    }
    throw new Error('Decryption failed with all key versions');
  }
}
```

**Step 4 -- Add equivalent tenant-scoped fallback:**

```typescript
decryptForTenantWithFallback(encryptedData: string, tenantId: string): string {
  try {
    return this.decryptForTenant(encryptedData, tenantId);
  } catch {
    // IMPORTANT: deriveTenantKey uses `tenant:${tenantId}` as salt, not raw tenantId
    for (const prev of this.previousKeys) {
      try {
        const key = this.strategy.deriveKey(prev.masterKey, `tenant:${tenantId}`);
        return this.aesGcmDecryptHex(encryptedData, key);
      } catch {
        continue;
      }
    }
    throw new Error('Decryption failed with all key versions');
  }
}
```

**Commit:**

```bash
npx prettier --write packages/shared/src/encryption/engine.ts packages/shared/src/encryption/types.ts packages/shared/src/__tests__/encryption/multi-key.test.ts
git add packages/shared/src/encryption/engine.ts packages/shared/src/encryption/types.ts packages/shared/src/__tests__/encryption/multi-key.test.ts
git commit -m "feat(shared): extend EncryptionService with multi-key fallback decryption"
```

---

## Phase F -- Tenant-Scoped API

> Adds tenant-level CRUD routes for workspace admin management of Auth Profiles.

### Task 39: Tenant-scoped CRUD routes (list + create)

**Files:**

- Create: `apps/studio/src/app/api/auth-profiles/route.ts`
- Test: `apps/studio/src/__tests__/auth-profiles/tenant-crud.test.ts`

**Step 1 -- Read an existing tenant-scoped route (e.g., `apps/studio/src/app/api/projects/[id]/connections/oauth/initiate/route.ts`) for the `withRouteHandler` pattern.**

**Step 2 -- Write the route:**

```typescript
// apps/studio/src/app/api/auth-profiles/route.ts
import { NextRequest, NextResponse } from 'next/server';
// Import withRouteHandler, requireAuth, requirePermission patterns from existing routes

export async function GET(req: NextRequest) {
  // requireAuth + requirePermission('auth-profile:read')
  // Query AuthProfile.find({ tenantId, projectId: null }) for tenant-level only
  // Return { success: true, data: profiles }
}

export async function POST(req: NextRequest) {
  // requireAuth + requirePermission('auth-profile:write')
  // Validate body with CreateAuthProfileSchema
  // Set scope: 'tenant', projectId: null
  // Create via AuthProfileService.create()
  // Return { success: true, data: profile }
}
```

**Step 3 -- Write test:**

```typescript
describe('Tenant-scoped auth profiles API', () => {
  it('GET /api/auth-profiles returns tenant-level profiles only', async () => {
    // ...
  });

  it('POST /api/auth-profiles creates a tenant-level profile', async () => {
    // ...
  });

  it('requires admin role', async () => {
    // Non-admin gets 403
  });

  it('enforces tenant isolation', async () => {
    // Cross-tenant request returns empty list
  });
});
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(studio): add tenant-scoped auth profile CRUD routes (list + create)"
```

---

### Task 40: Tenant-scoped ID routes (GET/PUT/DELETE)

**Files:**

- Create: `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts`

Same pattern as project-scoped `[profileId]/route.ts` but with `projectId: null` filter and admin role requirement.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(studio): add tenant-scoped auth profile ID routes (GET/PUT/DELETE)"
```

---

### Task 41: Tenant-scoped validate endpoint

**Files:**

- Create: `apps/studio/src/app/api/auth-profiles/[profileId]/validate/route.ts`

POST endpoint that decrypts the profile's secrets and makes a test request to verify the credentials work.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(studio): add tenant-scoped auth profile validate endpoint"
```

---

## Phase G -- Migration Scripts

> Scripts to migrate legacy credential records to Auth Profile documents. Each is independently rollable.

### Task 42: `LLMCredential` -> `AuthProfile` migration script

**Files:**

- Create: `packages/database/src/migrations/migrate-llm-credentials.ts`
- Test: `packages/database/src/__tests__/migrations/migrate-llm-credentials.test.ts`

**Step 1 -- Write the migration script:**

```typescript
// packages/database/src/migrations/migrate-llm-credentials.ts
import { LLMCredential, AuthProfile } from '../models/index.js';
import { generateUniqueName } from './migration-utils.js';

interface MigrationOptions {
  dryRun: boolean;
  tenantId?: string; // Optional: migrate specific tenant only
  batchSize?: number;
}

interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: Array<{ credentialId: string; error: string }>;
}

export async function migrateLLMCredentials(options: MigrationOptions): Promise<MigrationResult> {
  const { dryRun, tenantId, batchSize = 100 } = options;
  const result: MigrationResult = { total: 0, migrated: 0, skipped: 0, errors: [] };

  const filter: Record<string, unknown> = {};
  if (tenantId) filter.tenantId = tenantId;

  // NOTE: Do NOT use .lean() -- we need the Mongoose encryption plugin to decrypt fields
  const cursor = LLMCredential.find(filter).cursor({ batchSize });

  for await (const cred of cursor) {
    result.total++;

    // Check if already migrated (authProfileId exists on consumers referencing this cred)
    const existingProfile = await AuthProfile.findOne({
      tenantId: cred.tenantId,
      category: 'llm',
      'config.legacyCredentialId': cred._id,
    });
    if (existingProfile) {
      result.skipped++;
      continue;
    }

    // Map LLMCredential fields to AuthProfile
    const authType = mapProviderToAuthType(cred.provider, cred.authType);
    const name = await generateUniqueName(
      `${cred.name || cred.provider} API Key`,
      cred.tenantId,
      null, // tenant-level
    );

    const profileData = {
      name,
      tenantId: cred.tenantId,
      projectId: null,
      scope: 'tenant' as const,
      visibility: cred.credentialScope === 'user' ? ('personal' as const) : ('shared' as const),
      createdBy: cred.ownerId,
      authType,
      config: {
        legacyCredentialId: cred._id, // For rollback reference
        provider: cred.provider,
        ...(cred.customHeaders && { customHeaders: cred.customHeaders }),
      },
      // CRITICAL: Since we're reading via Mongoose (not .lean()), the encryption
      // plugin has already decrypted `encryptedApiKey` to plaintext. We restructure
      // it into the AuthProfile secrets format as a JSON string. The AuthProfile
      // encryption plugin will re-encrypt it on .create().
      encryptedSecrets: JSON.stringify(mapSecretsForAuthType(authType, cred)),
      encryptionKeyVersion: 1,
      category: 'llm',
      status: cred.isActive ? ('active' as const) : ('invalid' as const),
      lastValidatedAt: cred.lastValidatedAt,
      lastUsedAt: cred.lastUsedAt,
      migrationStatus: 'migrating' as const,
    };

    if (!dryRun) {
      try {
        await AuthProfile.create(profileData);
        result.migrated++;
      } catch (err) {
        result.errors.push({
          credentialId: cred._id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      result.migrated++;
    }
  }

  return result;
}

function mapProviderToAuthType(provider: string, authType: string): string {
  if (authType === 'azure_ad') return 'azure_ad';
  if (authType === 'aws_iam' || provider === 'bedrock') return 'aws_iam';
  return 'api_key'; // Default for most providers
}

function mapSecretsForAuthType(authType: string, cred: any): Record<string, string> {
  switch (authType) {
    case 'api_key':
      return { apiKey: cred.encryptedApiKey }; // Already decrypted by plugin
    case 'azure_ad':
      return {
        clientId: cred.authConfig?.clientId ?? '',
        clientSecret: cred.authConfig?.clientSecret ?? '',
      };
    case 'aws_iam':
      return {
        accessKeyId: cred.authConfig?.accessKeyId ?? '',
        secretAccessKey: cred.authConfig?.secretAccessKey ?? '',
        ...(cred.authConfig?.sessionToken && { sessionToken: cred.authConfig.sessionToken }),
      };
    default:
      return { apiKey: cred.encryptedApiKey };
  }
}
```

**Step 2 -- Write test (dry-run):**

```typescript
describe('migrateLLMCredentials', () => {
  it('dry run counts credentials without creating profiles', async () => {
    // Insert test LLMCredential documents
    // Run with dryRun: true
    // Assert result.total > 0, result.migrated > 0
    // Assert no AuthProfile documents created
  });

  it('maps provider to correct authType', () => {
    expect(mapProviderToAuthType('openai', 'api_key')).toBe('api_key');
    expect(mapProviderToAuthType('azure', 'azure_ad')).toBe('azure_ad');
    expect(mapProviderToAuthType('bedrock', 'aws')).toBe('aws_iam');
  });

  it('skips already-migrated credentials', async () => {
    // Create an AuthProfile with config.legacyCredentialId
    // Run migration
    // Assert skipped count
  });
});
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(database): add LLMCredential -> AuthProfile migration script"
```

---

### Task 43: `ToolSecret` -> `AuthProfile` migration script

**Files:**

- Create: `packages/database/src/migrations/migrate-tool-secrets.ts`
- Test: `packages/database/src/__tests__/migrations/migrate-tool-secrets.test.ts`

Same pattern as Task 42 (uses Mongoose not `.lean()` for decryption, restructures secrets, lets AuthProfile plugin re-encrypt). Maps `ToolSecret.encryptedValue` to `AuthProfile.encryptedSecrets` as `JSON.stringify({ [secretKey]: decryptedValue })`. Sets `category: 'tool'`, `config.legacySecretKey: toolSecret.secretKey`, `config.legacyToolName: toolSecret.toolName`. DSL references (`{{secrets.KEY}}`) continue to work via the `RuntimeSecretsProvider` Auth Profile resolution path (Task 36).

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(database): add ToolSecret -> AuthProfile migration script"
```

---

### Task 44: `EndUserOAuthToken` -> `AuthProfile` migration script

**Files:**

- Create: `packages/database/src/migrations/migrate-oauth-tokens.ts`
- Test: `packages/database/src/__tests__/migrations/migrate-oauth-tokens.test.ts`

**CRITICAL: Lock sequencing required.** The migration must handle the token refresh race:

```typescript
export async function migrateOAuthTokens(options: MigrationOptions): Promise<MigrationResult> {
  // For each EndUserOAuthToken:
  // 1. Acquire legacy lock: `auth-profile:migrate:{legacyTokenId}` (Redis SET NX PX 30000)
  // 2. Re-read the latest token (may have been refreshed since cursor read)
  // 3. Pre-generate the new profile ID (uuidv7) so we can pre-acquire the refresh lock
  // 4. Acquire new profile lock: `auth-profile:refresh:{tenantId}:{newProfileId}` (SET NX PX 30000)
  // 5. Create AuthProfile with the pre-generated _id, visibility: 'personal', authType: 'oauth2_token'
  // 6. Release legacy lock (new lock remains held)
  // 7. Set migrationStatus: 'migrating'
  // 8. Release new profile lock
  //
  // NOTE: Pre-generating _id avoids the race window between create and lock.
  // The AuthProfile model uses uuidv7 as _id default, which can be pre-generated.
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(database): add EndUserOAuthToken -> AuthProfile migration script with lock sequencing"
```

---

### Task 45: Name collision prevention utility

**Files:**

- Create: `packages/database/src/migrations/migration-utils.ts`
- Test: `packages/database/src/__tests__/migrations/migration-utils.test.ts`

```typescript
// packages/database/src/migrations/migration-utils.ts
import { AuthProfile } from '../models/index.js';

/**
 * Generate a unique name for a migrated Auth Profile.
 * If "OpenAI API Key" collides, tries "OpenAI API Key (2)", etc.
 */
export async function generateUniqueName(
  baseName: string,
  tenantId: string,
  projectId: string | null,
  environment: string | null = null,
): Promise<string> {
  let name = baseName;
  let suffix = 1;
  const maxAttempts = 100;

  while (suffix <= maxAttempts) {
    const existing = await AuthProfile.findOne({
      tenantId,
      projectId,
      name,
      environment,
    });
    if (!existing) return name;
    suffix++;
    name = `${baseName} (${suffix})`;
  }
  throw new Error(`Could not generate unique name after ${maxAttempts} attempts: ${baseName}`);
}
```

**Test:**

```typescript
describe('generateUniqueName', () => {
  it('returns base name when no collision', async () => {
    const name = await generateUniqueName('OpenAI API Key', 'tenant-1', null);
    expect(name).toBe('OpenAI API Key');
  });

  it('appends suffix on collision', async () => {
    // Create existing profile with name "OpenAI API Key"
    const name = await generateUniqueName('OpenAI API Key', 'tenant-1', null);
    expect(name).toBe('OpenAI API Key (2)');
  });
});
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(database): add migration name collision prevention utility"
```

---

## Phase H -- Monitoring Updates

### Task 46: `CredentialAgeMonitor` Auth Profile integration

**Files:**

- Modify: `apps/runtime/src/services/credential-age-monitor.ts`
- Test: `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts`

**Step 1 -- Read `credential-age-monitor.ts` (already read lines 1-50).** The `checkAll()` method queries `ToolSecret`, `LLMCredential`, and `ApiKey`.

**Step 2 -- Add `AuthProfile` to the query set:**

```typescript
// In checkAll(), add:
const { AuthProfile } = await import('@agent-platform/database/models');
const authProfiles = (await AuthProfile.find({
  $or: [
    { createdAt: { $lt: warningThreshold }, rotationPolicy: { $exists: false } },
    { lastValidatedAt: { $lt: warningThreshold } },
  ],
}).lean()) as CredentialRecord[];

// Process authProfiles alongside the existing collections
this.processCredentials(authProfiles, 'AuthProfile', warningThreshold, criticalThreshold);
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add AuthProfile to CredentialAgeMonitor.checkAll()"
```

---

### Task 47: `VoiceServiceFactory` cache invalidation via Auth Profile events

**Files:**

- Modify: `apps/runtime/src/services/voice/voice-service-factory.ts`
- Test: `apps/runtime/src/__tests__/voice-service-factory-auth-profile.test.ts`

**Step 1 -- Read `voice-service-factory.ts` (already read lines 1-40).** The factory has a `cache: Map<string, CachedService>` with 10-minute TTL.

**Step 2 -- Add an `invalidate(tenantId)` method and wire it to Redis pub/sub for Auth Profile update events:**

```typescript
// In VoiceServiceFactory:
invalidate(tenantId: string): void {
  for (const [key] of this.cache) {
    if (key.startsWith(`${tenantId}:`)) {
      this.cache.delete(key);
    }
  }
}
```

**Step 3 -- In the runtime server startup, subscribe to `auth-profile:updated` Redis channel:**

```typescript
// In server.ts or a dedicated subscriber:
redisSub.subscribe('auth-profile:updated', (message) => {
  const { tenantId, category } = JSON.parse(message);
  if (category === 'voice') {
    voiceServiceFactory.invalidate(tenantId);
  }
});
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): wire VoiceServiceFactory cache invalidation to Auth Profile events"
```

---

## Phase I -- Pre-Flight Auth Propagation

### Task 48: Compiler `authRequirements` bubbling

**Files:**

- Create: `packages/compiler/src/phases/auth-requirements.ts`
- Test: `packages/compiler/src/__tests__/auth-requirements.test.ts`

**Step 1 -- Read the compiler's existing phase structure** to understand how to add a new compilation phase.

**Step 2 -- Implement the `authRequirements` bubbling phase:**

The compiler walks the agent -> workflow -> tool dependency tree. For each tool with `auth: "profile-name"` referencing a `per_user` + `consent: preflight` Auth Profile, the requirement bubbles up to the agent's entry point.

```typescript
// packages/compiler/src/phases/auth-requirements.ts
import type { AgentIR } from '../ir/schema.js';

export interface AuthRequirement {
  connector: string;
  authType: string;
  connectionMode: 'per_user' | 'shared';
  consent: 'preflight' | 'inline';
  scopes: string[];
  authProfileId: string;
  authProfileName: string;
}

export function extractAuthRequirements(ir: AgentIR): AuthRequirement[] {
  const requirements: AuthRequirement[] = [];
  const seen = new Set<string>();

  // Walk all tools in the IR
  for (const tool of ir.tools ?? []) {
    if (!tool.auth?.profileName) continue;
    const key = `${tool.auth.connector}:${tool.auth.scopes?.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (tool.auth.connectionMode === 'per_user') {
      requirements.push({
        connector: tool.auth.connector,
        authType: tool.auth.authType ?? 'oauth2_token',
        connectionMode: 'per_user',
        consent: tool.auth.consent ?? 'preflight',
        scopes: tool.auth.scopes ?? [],
        authProfileId: tool.auth.authProfileId ?? '',
        authProfileName: tool.auth.profileName,
      });
    }
  }

  // Deduplicate by connector, union scopes
  return deduplicateRequirements(requirements);
}

function deduplicateRequirements(reqs: AuthRequirement[]): AuthRequirement[] {
  const map = new Map<string, AuthRequirement>();
  for (const req of reqs) {
    const existing = map.get(req.connector);
    if (existing) {
      existing.scopes = [...new Set([...existing.scopes, ...req.scopes])];
    } else {
      map.set(req.connector, { ...req });
    }
  }
  return Array.from(map.values());
}
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(compiler): add authRequirements extraction and bubbling phase"
```

---

### Task 49: `RuntimeSecretsProvider` session-level credential cache

**Files:**

- Modify: `apps/runtime/src/services/secrets-provider.ts`
- Test: `apps/runtime/src/__tests__/secrets-provider.test.ts`

**Step 1 -- Add a session-scoped LRU cache to the `RuntimeSecretsProvider`:**

```typescript
// Add to RuntimeSecretsProvider class:
private readonly credentialCache = new Map<string, { value: string; cachedAt: number }>();
private readonly CACHE_MAX_SIZE = 200;
private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

private getCached(key: string): string | undefined {
  const entry = this.credentialCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > this.CACHE_TTL_MS) {
    this.credentialCache.delete(key);
    return undefined;
  }
  return entry.value;
}

private setCache(key: string, value: string): void {
  if (this.credentialCache.size >= this.CACHE_MAX_SIZE) {
    // LRU eviction: delete oldest entry
    const firstKey = this.credentialCache.keys().next().value;
    if (firstKey) this.credentialCache.delete(firstKey);
  }
  this.credentialCache.set(key, { value, cachedAt: Date.now() });
}
```

**Step 2 -- Use cache in the Auth Profile resolution path added in Task 36.**

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "feat(runtime): add session-level LRU credential cache to RuntimeSecretsProvider"
```

---

## Phase J -- Tests

> Comprehensive test coverage for all Phase 2 additions.

### Task 50: Unit tests -- 6 new auth type schemas

Already created in Tasks 2-4. Verify all pass:

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/phase2-schema.test.ts
```

### Task 51: Unit tests -- addon schemas + invalid combinations

Already created in Tasks 12-16. Verify all pass:

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/addon-schema.test.ts
```

### Task 52: Unit tests -- `applyAuth()` for all Phase 2 types

Already created in Tasks 6-9. Verify all pass:

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/apply-auth-phase2.test.ts
```

### Task 53: Integration tests -- consumer dual-read paths

**Files:**

- Create: `apps/runtime/src/__tests__/auth-profile/consumer-dual-read.test.ts`

```typescript
describe('Consumer dual-read integration', () => {
  describe.each([
    ['TenantModel connections', 'tenant-model-repo'],
    ['ModelConfig', 'model-resolution'],
    ['ChannelConnection', 'connection-resolver'],
    ['VoiceServiceInstance', 'voice-service-factory'],
  ])('%s', (name, module) => {
    it('resolves via authProfileId when AUTH_PROFILE_ENABLED=true', async () => {
      // ...
    });

    it('falls back to legacy when authProfileId is null', async () => {
      // ...
    });

    it('falls back to legacy when AUTH_PROFILE_ENABLED=false', async () => {
      // ...
    });
  });
});
```

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "test(runtime): add consumer dual-read integration tests"
```

### Task 54: Integration tests -- migration scripts (dry-run)

**Files:**

- Create: `packages/database/src/__tests__/migrations/migration-scripts.test.ts`

Tests all three migration scripts in dry-run mode against test fixtures.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "test(database): add migration script integration tests"
```

### Task 55: Integration tests -- EncryptionService multi-key

Already created in Task 38.

### Task 56: E2E -- tenant-scoped CRUD API

**Files:**

- Create: `apps/studio/src/__tests__/auth-profiles/tenant-crud.test.ts`

Tests the full tenant CRUD lifecycle: create, read, update, delete, validate. Verifies admin role enforcement and tenant isolation.

**Commit:**

```bash
npx prettier --write <changed files>
git add <changed files>
git commit -m "test(studio): add tenant-scoped auth profile CRUD e2e tests"
```

### Task 57: Integration tests -- worker dual-read (search-ai resolver)

Already created in Task 31.

---

## Rollback Procedures

Each migration is independently rollable:

| Migration           | Rollback                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `LLMCredential`     | `AuthProfile.deleteMany({ category: 'llm', migrationStatus: 'migrating' })`. Consumers fall back to `credentialId`. |
| `ToolSecret`        | `AuthProfile.deleteMany({ category: 'tool', migrationStatus: 'migrating' })`. DSL falls back to `{{secrets.KEY}}`.  |
| `EndUserOAuthToken` | `AuthProfile.deleteMany({ visibility: 'personal', authType: 'oauth2_token', migrationStatus: 'migrating' })`.       |
| Feature flag        | Set `AUTH_PROFILE_ENABLED=false`. All consumers immediately use legacy paths.                                       |

---

## Go/No-Go Criteria for Phase 3

Before Phase 3 can begin:

- [ ] All workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days
- [ ] Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days
- [ ] `EncryptionService` multi-key support deployed and tested
- [ ] All consumers listed in Phase C have `authProfileId` populated in production
- [ ] Dual-read fallback path exercised < 1% of total credential resolutions
- [ ] Full MongoDB snapshot taken with retention policy documented
- [ ] Canary tenant fully migrated and stable for 14+ days

---

## Review Log

### Iteration 1

- **Issues found:** 8
- **Fixed:**
  1. Task 37 wrong file path: `apps/search-ai/src/services/connectors/base/token-manager.ts` -> `packages/connectors/base/src/auth/token-manager.ts`
  2. Task 21 imprecise file path: `adapters/index.ts` -> `adapters/service-node-executor.ts`
  3. Task 27 missing `webhook-subscription.model.ts` -- now covers both models
  4. Task 27 body text updated to reference both model files
  5. Added Worker Group 3 cascade note (delivery/inbound workers cascade from Phase 1 connection-resolver)
  6. Added HTTP Tool consumer cross-reference (covered by Task 36 RuntimeSecretsProvider)
  7. Added connection-resolver.ts deliverable #12 Phase 1 dependency note
  8. Task 21 body text updated to reference `service-node-executor.ts`
- **Remaining:** None deferred

### Iteration 7

- **Issues found:** 0
- **Fixed:** Final pass -- formatting, task numbering, commit messages, cross-references all consistent. No TODO/placeholder text remaining. All file paths verified against codebase.
- **Remaining:** None

### Iteration 6

- **Issues found:** 3
- **Fixed:**
  1. Task 14 proxy schema missing SSRF internal IP blocklist -- added regex blocking localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, [::1]
  2. Task 14 proxy test missing SSRF test cases for internal IPs -- added 4 test cases
  3. Task 43 (ToolSecret migration) made explicit that it uses Mongoose (not `.lean()`) for decryption like Task 42, and specified the secrets structure (`{ [secretKey]: decryptedValue }`)
- **Remaining:** None deferred

### Iteration 5

- **Issues found:** 4
- **Fixed:**
  1. Generic dual-read pattern: added comment clarifying errors from `authProfileService.resolve()` must propagate (no silent fallback to legacy), and cached `AUTH_PROFILE_ENABLED` at module level
  2. Task 44 lock sequencing: fixed race window by pre-generating profile ID (uuidv7) and pre-acquiring the new profile lock BEFORE creating the document
  3. Task 30 OrgProxyConfig: explicitly noted dependency on Task 1 for `groupId` field and index
  4. Task 1: added `groupId` and `migrationStatus` fields and `{ groupId: 1 }` index that Phase G migration scripts and Task 30 depend on
- **Remaining:** None deferred

### Iteration 4

- **Issues found:** 3
- **Fixed:**
  1. Task 42 migration script double-encryption bug: directly assigning `cred.encryptedApiKey` to `encryptedSecrets` would cause the AuthProfile encryption plugin to encrypt an already-encrypted value. Fixed by using Mongoose (not `.lean()`) for decryption, restructuring secrets, and letting AuthProfile plugin re-encrypt
  2. Task 42 added `mapSecretsForAuthType` helper to properly map different credential types (api_key, azure_ad, aws_iam) to AuthProfile secrets format
  3. Task 14 proxy addon missing critical cross-reference validations from design doc: self-reference check, max chain depth=1, valid proxy auth types, tenantId match, visibility mismatch (shared vs personal). Added complete `validateProxyAddon()` function
  4. Task 2 `custom_header` missing cross-field validation between `config.headers` keys and `secrets.headerValues` keys. Added `CustomHeaderCrossFieldValidator` function
- **Remaining:** None deferred

### Iteration 3

- **Issues found:** 4
- **Fixed:**
  1. Task 38 `decryptForTenantWithFallback` used wrong salt -- `tenantId` instead of `tenant:${tenantId}` (matching existing `deriveTenantKey` which prefixes salt with `tenant:`)
  2. Task 13 `verifyWebhook()` missing length guard before `crypto.timingSafeEqual` -- throws on length mismatch instead of returning false
  3. Task 14 `applyProxy()` used `(proxyCredentials.secrets as any).token` violating no-`any` rule -- replaced with typed destructure
  4. Task 12 `applySigning()` silently ignored `rsa-sha256` and `aws-sig-v4` algorithms -- added RSA-SHA256 implementation and explicit error for unreachable `aws-sig-v4` branch
- **Remaining:** None deferred

### Iteration 2

- **Issues found:** 5
- **Fixed:**
  1. Task 33 expanded from scheduler-only to include all 6 sync workers (Azure AD, Okta, Google) that directly query `LLMCredential` -- each needs dual-read in their job handler
  2. Task 33 noted that OneLogin, PingIdentity, Generic SCIM workers referenced in design doc do NOT exist in codebase
  3. Task 20 added model file path (`channel-connection.model.ts`) alongside resolver -- model needs `authProfileId` field added
  4. Task 20 body text updated with explicit model file path
  5. Task 24 added model file path (`tenant-service-instance.model.ts`) alongside voice-service-factory
- **Remaining:** None deferred
