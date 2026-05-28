# Auth Profile Phase 3 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 enterprise auth types, 2 deferred addons, multi-agent credential propagation, import/export auth mapping, voice lifecycle caching, rotation batch job, and execute irreversible cleanup of all legacy credential models/fields.

**Architecture:** Enterprise auth types live in `packages/auth-enterprise` (optional workspace package) with lazy-loaded libraries. Cleanup is staged across 5 weeks with 7-day bake periods and explicit go/no-go gates. The rotation batch job uses per-profile distributed locks and batched re-encryption (100 profiles at a time).

**Tech Stack:** `digest-fetch`, `kerberos` (native C++ bindings), `@node-saml/node-saml`, `@hapi/hawk`, `soap`, Zod discriminated unions, Redis distributed locks. Rotation job follows the existing `kms-rotation-job.ts` setInterval pattern (not BullMQ).

**Prerequisites:** Phase 2 stable in production. All go/no-go criteria from Phase 2 met. All workers confirmed reading `authProfileId` (not `credentialId`) for 30+ days. Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days. `EncryptionService` multi-key support deployed. Full MongoDB snapshot taken with documented retention policy.

**Important — Files Created by Phase 1 and Phase 2:** Many files referenced in this plan are created by Phase 1 and Phase 2, not pre-existing in the codebase. Key files created by prior phases:

- `packages/database/src/models/auth-profile.model.ts` (Phase 1 Task 1)
- `packages/shared/src/validation/auth-profile.schema.ts` (Phase 1 Task 4)
- `packages/shared/src/services/auth-profile/apply-auth.ts` (Phase 1 Task 27)
- `packages/shared/src/services/auth-profile/auth-profile-resolver.ts` (Phase 1 Task 24)
- `packages/shared/src/errors/auth-profile-errors.ts` (Phase 1 Task 38)

If implementing Phase 3 before Phase 1/2 are complete, these files must be created first. See `2026-03-11-auth-profile-implementation-plan.md` (Phase 1) and Phase 2 implementation plan for details.

---

## Task Summary

| #   | Phase                                  | Task Name                                                           | Key Files                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | A — Enterprise Auth Types              | `packages/auth-enterprise` workspace package scaffold               | `packages/auth-enterprise/package.json`, `tsconfig.json`, `src/index.ts`    |
| 2   | A — Enterprise Auth Types              | Zod schemas for 5 enterprise auth types                             | `packages/shared/src/validation/auth-profile.schema.ts`                     |
| 3   | A — Enterprise Auth Types              | Add 5 enterprise types to Mongoose enum                             | `packages/database/src/models/auth-profile.model.ts`                        |
| 4   | A — Enterprise Auth Types              | `digest-auth.ts` — Digest auth implementation                       | `packages/auth-enterprise/src/digest-auth.ts`                               |
| 5   | A — Enterprise Auth Types              | `kerberos-auth.ts` — Kerberos ticket acquisition + Redis caching    | `packages/auth-enterprise/src/kerberos-auth.ts`                             |
| 6   | A — Enterprise Auth Types              | `saml-auth.ts` — SAML assertion acquisition                         | `packages/auth-enterprise/src/saml-auth.ts`                                 |
| 7   | A — Enterprise Auth Types              | `hawk-auth.ts` — Hawk MAC computation                               | `packages/auth-enterprise/src/hawk-auth.ts`                                 |
| 8   | A — Enterprise Auth Types              | `ws-security-auth.ts` — SOAP WS-Security                            | `packages/auth-enterprise/src/ws-security-auth.ts`                          |
| 9   | A — Enterprise Auth Types              | Extend `applyAuth()` dispatcher for enterprise types                | `packages/shared/src/services/auth-profile/apply-auth.ts`                   |
| 10  | A — Enterprise Auth Types              | Dockerfile updates for `kerberos` native bindings                   | `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`                      |
| 11  | A — Enterprise Auth Types              | Add `COPY` lines for `packages/auth-enterprise` to all Dockerfiles  | `apps/*/Dockerfile`                                                         |
| 12  | B — Deferred Addons                    | `certificatePinning` addon schema + validation                      | `packages/shared/src/validation/auth-profile.schema.ts`                     |
| 13  | B — Deferred Addons                    | `jwtWrapping` addon schema + validation                             | `packages/shared/src/validation/auth-profile.schema.ts`                     |
| 14  | B — Deferred Addons                    | Add addon fields to Mongoose schema                                 | `packages/database/src/models/auth-profile.model.ts`                        |
| 15  | B — Deferred Addons                    | `certificatePinning` enforcement in request pipeline                | `packages/shared/src/services/auth-profile/apply-auth.ts`                   |
| 16  | B — Deferred Addons                    | `jwtWrapping` enforcement in request pipeline                       | `packages/shared/src/services/auth-profile/apply-auth.ts`                   |
| 17  | B — Deferred Addons                    | Phase 3 invalid combination rules                                   | `packages/shared/src/validation/auth-profile.schema.ts`                     |
| 18  | C — Multi-Agent Credential Propagation | Handoff: check Agent B `authRequirements`                           | `apps/runtime/src/services/execution/routing-executor.ts`                   |
| 19  | C — Multi-Agent Credential Propagation | Delegate: propagate user context for personal token resolution      | `apps/runtime/src/services/execution/routing-executor.ts`                   |
| 20  | C — Multi-Agent Credential Propagation | Fan-out: independent resolution per branch                          | `apps/runtime/src/services/execution/routing-executor.ts`                   |
| 21  | D — Import/Export Auth Mapping         | Export: `required_auth_profiles` in manifest metadata               | `packages/project-io/src/export/layer-assemblers/connections-assembler.ts`  |
| 22  | D — Import/Export Auth Mapping         | `env-var-scanner.ts` extended for `auth:` references                | `packages/project-io/src/export/env-var-scanner.ts`                         |
| 23  | D — Import/Export Auth Mapping         | Import preview: extract auth profile requirements                   | `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`             |
| 24  | D — Import/Export Auth Mapping         | Import apply: accept `authProfileMapping`                           | `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`               |
| 25  | D — Import/Export Auth Mapping         | Cross-tenant import: strip `authProfileId` references               | `packages/project-io/src/import/import-applier.ts`                          |
| 26  | D — Import/Export Auth Mapping         | Post-import doctor: Auth Profile checks                             | `packages/project-io/src/import/post-import-validator.ts`                   |
| 27  | E — Voice Lifecycle Auth               | Call duration credential caching                                    | `apps/runtime/src/services/voice/voice-credential-cache.ts`                 |
| 28  | E — Voice Lifecycle Auth               | Cache invalidation on call end / rotation                           | `apps/runtime/src/services/voice/voice-credential-cache.ts`                 |
| 29  | F — Rotation Batch Job                 | Rotation job: batched re-encryption                                 | `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`       |
| 30  | F — Rotation Batch Job                 | ~~Distributed lock per profile~~ (merged into Task 29)              | `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`       |
| 31  | F — Rotation Batch Job                 | `previousEncryptedSecrets` grace period                             | `packages/shared/src/services/auth-profile/auth-profile-resolver.ts`        |
| 32  | G — Cleanup Week 1                     | Remove dual-read code paths                                         | Multiple service files                                                      |
| 33  | G — Cleanup Week 2                     | Drop legacy fields from consumer models (`$unset`)                  | Migration script                                                            |
| 34  | G — Cleanup Week 3                     | Drop `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections | Migration script                                                            |
| 35  | G — Cleanup Week 4                     | Remove obsolete env vars from Dockerfiles                           | `apps/*/Dockerfile`, helm charts                                            |
| 36  | G — Cleanup Week 5                     | Remove `AUTH_PROFILE_ENABLED` feature flag                          | Multiple files                                                              |
| 37  | H — Tests                              | Unit tests for enterprise auth types                                | `packages/auth-enterprise/src/__tests__/`                                   |
| 38  | H — Tests                              | Multi-agent propagation tests                                       | `apps/runtime/src/__tests__/auth-profile-propagation.test.ts`               |
| 39  | H — Tests                              | Import/export mapping tests                                         | `packages/project-io/src/__tests__/auth-profile-mapping.test.ts`            |
| 40  | H — Tests                              | Rotation batch job tests                                            | `apps/runtime/src/__tests__/auth-profile-rotation.test.ts`                  |
| 41  | H — Tests                              | Cleanup verification tests                                          | `packages/database/src/__tests__/auth-profile/cleanup-verification.test.ts` |

---

## TDD Convention

Every task follows this 5-step cycle:

1. **Red** — Write the failing test
2. **Run** — Verify the test fails (expected)
3. **Green** — Implement the minimum code to pass
4. **Run** — Verify the test passes
5. **Commit** — `npx prettier --write <files>` then commit

**Test framework:** vitest (all `packages/` and `apps/` use vitest)
**Format:** `npx prettier --write <files>` before every commit
**Imports:** Use `.js` extension (ESM convention in this codebase)

---

## Phase A — Enterprise Auth Types

> Adds 5 enterprise auth types (`digest`, `kerberos`, `saml`, `hawk`, `ws_security`) in an optional `packages/auth-enterprise` workspace package with lazy-loaded libraries.

### Task 1: `packages/auth-enterprise` workspace package scaffold

- [ ] Create package directory and configuration files

**Files:**

- Create: `packages/auth-enterprise/package.json`
- Create: `packages/auth-enterprise/tsconfig.json`
- Create: `packages/auth-enterprise/src/index.ts`
- Modify: `pnpm-workspace.yaml` (verify `packages/*` glob already covers it)

**Steps:**

1. Create `packages/auth-enterprise/package.json`:

```json
{
  "name": "@agent-platform/auth-enterprise",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "digest-fetch": "^3.1.1",
    "kerberos": "^2.1.1",
    "@node-saml/node-saml": "^5.0.0",
    "@hapi/hawk": "^9.0.2",
    "soap": "^1.1.1"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.0.0"
  }
}
```

2. Create `packages/auth-enterprise/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

3. Create `packages/auth-enterprise/src/index.ts`:

```typescript
/**
 * Enterprise Auth Types — Optional Package
 *
 * Lazy-loaded implementations for: digest, kerberos, saml, hawk, ws_security.
 * This package is NOT bundled in core builds — only in enterprise-enabled Dockerfiles.
 */

export { applyDigestAuth, type DigestAuthConfig, type DigestAuthSecrets } from './digest-auth.js';
export {
  applyKerberosAuth,
  type KerberosAuthConfig,
  type KerberosAuthSecrets,
} from './kerberos-auth.js';
export { applySamlAuth, type SamlAuthConfig, type SamlAuthSecrets } from './saml-auth.js';
export { applyHawkAuth, type HawkAuthConfig, type HawkAuthSecrets } from './hawk-auth.js';
export {
  applyWsSecurityAuth,
  type WsSecurityAuthConfig,
  type WsSecurityAuthSecrets,
} from './ws-security-auth.js';
```

4. Run `pnpm install` from repo root to link the new package.

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm install
```

5. Verify:

```bash
cd /Users/prasannaarikala/projects/agent-platform && ls packages/auth-enterprise/package.json
```

**Commit:**

```bash
npx prettier --write packages/auth-enterprise/package.json packages/auth-enterprise/tsconfig.json packages/auth-enterprise/src/index.ts
git add packages/auth-enterprise/
git commit -m "feat(auth-enterprise): scaffold optional workspace package for enterprise auth types"
```

---

### Task 2: Zod schemas for 5 enterprise auth types

- [ ] Add config + secrets Zod schemas for `digest`, `kerberos`, `saml`, `hawk`, `ws_security`

**Files:**

- Modify: `packages/shared/src/validation/auth-profile.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/enterprise-schema.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/enterprise-schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  DigestConfigSchema,
  DigestSecretsSchema,
  KerberosConfigSchema,
  KerberosSecretsSchema,
  SamlConfigSchema,
  SamlSecretsSchema,
  HawkConfigSchema,
  HawkSecretsSchema,
  WsSecurityConfigSchema,
  WsSecuritySecretsSchema,
} from '../../validation/auth-profile.schema.js';

// ── Digest ──────────────────────────────────────────────────────────

describe('DigestConfigSchema', () => {
  it('accepts valid digest config', () => {
    const result = DigestConfigSchema.safeParse({
      algorithm: 'MD5',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional qop, realm, opaque', () => {
    const result = DigestConfigSchema.safeParse({
      algorithm: 'MD5-sess',
      qop: 'auth',
      realm: 'example.com',
      opaque: 'abc123',
    });
    expect(result.success).toBe(true);
  });

  it('requires algorithm', () => {
    const result = DigestConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    const result = DigestConfigSchema.safeParse({ algorithm: 'MD5', extra: true });
    expect(result.success).toBe(false);
  });
});

describe('DigestSecretsSchema', () => {
  it('requires username and password', () => {
    expect(DigestSecretsSchema.safeParse({}).success).toBe(false);
    expect(DigestSecretsSchema.safeParse({ username: 'u' }).success).toBe(false);
    expect(DigestSecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });
});

// ── Kerberos ────────────────────────────────────────────────────────

describe('KerberosConfigSchema', () => {
  it('accepts valid kerberos config', () => {
    const result = KerberosConfigSchema.safeParse({
      realm: 'EXAMPLE.COM',
      kdcHost: 'kdc.example.com',
      kdcPort: 88,
      servicePrincipal: 'HTTP/api.example.com',
      spnegoEnabled: true,
    });
    expect(result.success).toBe(true);
  });

  it('requires realm, kdcHost, kdcPort, servicePrincipal', () => {
    expect(KerberosConfigSchema.safeParse({}).success).toBe(false);
  });

  it('defaults spnegoEnabled to true', () => {
    const result = KerberosConfigSchema.safeParse({
      realm: 'EXAMPLE.COM',
      kdcHost: 'kdc.example.com',
      kdcPort: 88,
      servicePrincipal: 'HTTP/api.example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spnegoEnabled).toBe(true);
    }
  });
});

describe('KerberosSecretsSchema', () => {
  it('requires keytab (base64)', () => {
    expect(KerberosSecretsSchema.safeParse({ keytab: 'base64data' }).success).toBe(true);
  });

  it('accepts optional principal and password', () => {
    const result = KerberosSecretsSchema.safeParse({
      keytab: 'base64data',
      principal: 'user@EXAMPLE.COM',
      password: 'secret',
    });
    expect(result.success).toBe(true);
  });
});

// ── SAML ────────────────────────────────────────────────────────────

describe('SamlConfigSchema', () => {
  it('accepts valid SAML config', () => {
    const result = SamlConfigSchema.safeParse({
      entityId: 'https://sp.example.com',
      idpEntityId: 'https://idp.example.com',
      idpSsoUrl: 'https://idp.example.com/sso',
      assertionConsumerServiceUrl: 'https://sp.example.com/acs',
    });
    expect(result.success).toBe(true);
  });

  it('requires all 4 fields', () => {
    expect(SamlConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-URL idpSsoUrl', () => {
    const result = SamlConfigSchema.safeParse({
      entityId: 'https://sp.example.com',
      idpEntityId: 'https://idp.example.com',
      idpSsoUrl: 'not-a-url',
      assertionConsumerServiceUrl: 'https://sp.example.com/acs',
    });
    expect(result.success).toBe(false);
  });
});

describe('SamlSecretsSchema', () => {
  it('requires idpCertificate', () => {
    expect(SamlSecretsSchema.safeParse({}).success).toBe(false);
    expect(SamlSecretsSchema.safeParse({ idpCertificate: 'PEM...' }).success).toBe(true);
  });

  it('accepts optional spPrivateKey and spCertificate', () => {
    const result = SamlSecretsSchema.safeParse({
      idpCertificate: 'PEM...',
      spPrivateKey: 'PEM...',
      spCertificate: 'PEM...',
    });
    expect(result.success).toBe(true);
  });
});

// ── Hawk ────────────────────────────────────────────────────────────

describe('HawkConfigSchema', () => {
  it('accepts valid hawk config', () => {
    const result = HawkConfigSchema.safeParse({ algorithm: 'sha256' });
    expect(result.success).toBe(true);
  });

  it('requires algorithm', () => {
    expect(HawkConfigSchema.safeParse({}).success).toBe(false);
  });

  it('accepts optional ext, dlg, timestampSkewSec', () => {
    const result = HawkConfigSchema.safeParse({
      algorithm: 'sha256',
      ext: 'app-data',
      dlg: 'delegated-by',
      timestampSkewSec: 60,
    });
    expect(result.success).toBe(true);
  });
});

describe('HawkSecretsSchema', () => {
  it('requires id and key', () => {
    expect(HawkSecretsSchema.safeParse({}).success).toBe(false);
    expect(HawkSecretsSchema.safeParse({ id: 'abc', key: 'secret' }).success).toBe(true);
  });
});

// ── WS-Security ─────────────────────────────────────────────────────

describe('WsSecurityConfigSchema', () => {
  it('accepts valid ws_security config', () => {
    const result = WsSecurityConfigSchema.safeParse({ mode: 'UsernameToken' });
    expect(result.success).toBe(true);
  });

  it('requires mode', () => {
    expect(WsSecurityConfigSchema.safeParse({}).success).toBe(false);
  });

  it('accepts optional passwordType, addTimestamp, signatureAlgorithm', () => {
    const result = WsSecurityConfigSchema.safeParse({
      mode: 'X509',
      passwordType: 'PasswordDigest',
      addTimestamp: true,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });
    expect(result.success).toBe(true);
  });
});

describe('WsSecuritySecretsSchema', () => {
  it('accepts username + password for UsernameToken mode', () => {
    expect(WsSecuritySecretsSchema.safeParse({ username: 'u', password: 'p' }).success).toBe(true);
  });

  it('accepts privateKey + publicCert for X509 mode', () => {
    expect(
      WsSecuritySecretsSchema.safeParse({ privateKey: 'PEM...', publicCert: 'PEM...' }).success,
    ).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    expect(WsSecuritySecretsSchema.safeParse({}).success).toBe(true);
  });
});
```

**Run to verify failure:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/shared && pnpm vitest run src/__tests__/auth-profile/enterprise-schema.test.ts
```

**Implementation:** Add to `packages/shared/src/validation/auth-profile.schema.ts`:

```typescript
// ── Enterprise Auth Types (Phase 3) ─────────────────────────────────

export const DigestConfigSchema = z
  .object({
    algorithm: z.string().min(1),
    qop: z.string().optional(),
    realm: z.string().optional(),
    opaque: z.string().optional(),
  })
  .strict();

export const DigestSecretsSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export const KerberosConfigSchema = z
  .object({
    realm: z.string().min(1),
    kdcHost: z.string().min(1),
    kdcPort: z.number().int().positive(),
    servicePrincipal: z.string().min(1),
    spnegoEnabled: z.boolean().default(true),
  })
  .strict();

export const KerberosSecretsSchema = z
  .object({
    keytab: z.string().min(1),
    principal: z.string().optional(),
    password: z.string().optional(),
  })
  .strict();

export const SamlConfigSchema = z
  .object({
    entityId: z.string().min(1),
    idpEntityId: z.string().min(1),
    idpSsoUrl: z.string().url(),
    assertionConsumerServiceUrl: z.string().url(),
  })
  .strict();

export const SamlSecretsSchema = z
  .object({
    idpCertificate: z.string().min(1),
    spPrivateKey: z.string().optional(),
    spCertificate: z.string().optional(),
  })
  .strict();

export const HawkConfigSchema = z
  .object({
    algorithm: z.enum(['sha256', 'sha1']),
    ext: z.string().optional(),
    dlg: z.string().optional(),
    timestampSkewSec: z.number().int().positive().optional(),
  })
  .strict();

export const HawkSecretsSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();

export const WsSecurityConfigSchema = z
  .object({
    mode: z.enum(['UsernameToken', 'X509']),
    passwordType: z.string().optional(),
    addTimestamp: z.boolean().optional(),
    signatureAlgorithm: z.string().optional(),
  })
  .strict();

export const WsSecuritySecretsSchema = z
  .object({
    username: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    publicCert: z.string().optional(),
  })
  .strict();
```

Also update the `configSchemaMap` and `secretsSchemaMap` discriminated-union dispatchers to include these 5 new types.

**Run to verify pass:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/shared && pnpm vitest run src/__tests__/auth-profile/enterprise-schema.test.ts
```

**Commit:**

```bash
npx prettier --write packages/shared/src/validation/auth-profile.schema.ts packages/shared/src/__tests__/auth-profile/enterprise-schema.test.ts
git add packages/shared/src/validation/auth-profile.schema.ts packages/shared/src/__tests__/auth-profile/enterprise-schema.test.ts
git commit -m "feat(shared): add Zod validation schemas for 5 enterprise auth types"
```

---

### Task 3: Add 5 enterprise types to Mongoose enum

- [ ] Extend `AUTH_PROFILE_AUTH_TYPES` to include enterprise types

**Files:**

- Modify: `packages/database/src/models/auth-profile.model.ts`
- Test: `packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts`

**Test (Red):** Add to existing test file:

```typescript
it('has authType enum with Phase 3 enterprise values', () => {
  const pathType = AuthProfile.schema.path('authType') as any;
  expect(pathType.enumValues).toContain('digest');
  expect(pathType.enumValues).toContain('kerberos');
  expect(pathType.enumValues).toContain('saml');
  expect(pathType.enumValues).toContain('hawk');
  expect(pathType.enumValues).toContain('ws_security');
});
```

**Run to verify failure:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
```

**Implementation:** In `packages/database/src/models/auth-profile.model.ts`, update the `AUTH_PROFILE_AUTH_TYPES` array:

```typescript
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
  'ssh_key',
  'mtls',
  // Phase 3 enterprise types:
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
] as const;
```

Also update the `IAuthProfile` interface's `authType` field union type and the `AuthProfileAuthType` type alias (they are derived from the const array, so they auto-update).

**Run to verify pass:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
```

**Build check:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@agent-platform/database
```

**Commit:**

```bash
npx prettier --write packages/database/src/models/auth-profile.model.ts packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
git add packages/database/src/models/auth-profile.model.ts packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
git commit -m "feat(database): add 5 enterprise auth types to AuthProfile enum"
```

---

### Task 4: `digest-auth.ts` — Digest auth implementation

- [ ] Implement HTTP Digest auth using `digest-fetch`

**Files:**

- Create: `packages/auth-enterprise/src/digest-auth.ts`
- Test: `packages/auth-enterprise/src/__tests__/digest-auth.test.ts`

**Test (Red):**

```typescript
// packages/auth-enterprise/src/__tests__/digest-auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { applyDigestAuth, type DigestAuthConfig, type DigestAuthSecrets } from '../digest-auth.js';

describe('applyDigestAuth', () => {
  it('returns a fetch wrapper that uses digest-fetch', async () => {
    const config: DigestAuthConfig = { algorithm: 'MD5' };
    const secrets: DigestAuthSecrets = { username: 'user', password: 'pass' };

    const result = applyDigestAuth(config, secrets);
    expect(result).toBeDefined();
    expect(typeof result.fetch).toBe('function');
  });

  it('passes algorithm from config', () => {
    const config: DigestAuthConfig = { algorithm: 'MD5-sess', qop: 'auth' };
    const secrets: DigestAuthSecrets = { username: 'u', password: 'p' };

    const result = applyDigestAuth(config, secrets);
    expect(result.clientOptions.algorithm).toBe('MD5-sess');
  });
});
```

**Run to verify failure:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/auth-enterprise && pnpm vitest run src/__tests__/digest-auth.test.ts
```

**Implementation:**

```typescript
// packages/auth-enterprise/src/digest-auth.ts

export interface DigestAuthConfig {
  algorithm: string;
  qop?: string;
  realm?: string;
  opaque?: string;
}

export interface DigestAuthSecrets {
  username: string;
  password: string;
}

export interface DigestAuthResult {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  clientOptions: { algorithm: string; qop?: string };
}

/**
 * Creates a digest-auth-aware fetch wrapper.
 * Lazily loads `digest-fetch` to avoid bundling in non-enterprise builds.
 */
export function applyDigestAuth(
  config: DigestAuthConfig,
  secrets: DigestAuthSecrets,
): DigestAuthResult {
  // Lazy import performed at call time, not module load time
  const clientOptions = {
    algorithm: config.algorithm,
    qop: config.qop,
  };

  return {
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const DigestFetch = (await import('digest-fetch')).default;
      const client = new DigestFetch(secrets.username, secrets.password, {
        algorithm: config.algorithm,
        ...(config.qop ? { qop: config.qop } : {}),
      });
      return client.fetch(url, init);
    },
    clientOptions,
  };
}
```

**Run to verify pass:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/auth-enterprise && pnpm vitest run src/__tests__/digest-auth.test.ts
```

**Commit:**

```bash
npx prettier --write packages/auth-enterprise/src/digest-auth.ts packages/auth-enterprise/src/__tests__/digest-auth.test.ts
git add packages/auth-enterprise/src/digest-auth.ts packages/auth-enterprise/src/__tests__/digest-auth.test.ts
git commit -m "feat(auth-enterprise): implement digest auth with lazy-loaded digest-fetch"
```

---

### Task 5: `kerberos-auth.ts` — Kerberos ticket acquisition + Redis caching

- [ ] Implement Kerberos SPNEGO token acquisition with Redis cache for service tickets

**Files:**

- Create: `packages/auth-enterprise/src/kerberos-auth.ts`
- Test: `packages/auth-enterprise/src/__tests__/kerberos-auth.test.ts`

**Test (Red):**

```typescript
// packages/auth-enterprise/src/__tests__/kerberos-auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyKerberosAuth,
  type KerberosAuthConfig,
  type KerberosAuthSecrets,
} from '../kerberos-auth.js';

describe('applyKerberosAuth', () => {
  const config: KerberosAuthConfig = {
    realm: 'EXAMPLE.COM',
    kdcHost: 'kdc.example.com',
    kdcPort: 88,
    servicePrincipal: 'HTTP/api.example.com',
    spnegoEnabled: true,
  };
  const secrets: KerberosAuthSecrets = { keytab: 'base64keytab' };

  it('returns headers with Authorization: Negotiate', async () => {
    // Mock the kerberos module
    vi.mock('kerberos', () => ({
      initializeClient: vi.fn().mockResolvedValue({
        step: vi.fn().mockResolvedValue('mock-spnego-token'),
      }),
    }));

    const result = await applyKerberosAuth(config, secrets);
    expect(result.headers).toBeDefined();
    expect(result.headers['Authorization']).toMatch(/^Negotiate /);
  });

  it('includes service principal in the initialization', async () => {
    const { initializeClient } = await import('kerberos');
    await applyKerberosAuth(config, secrets);
    expect(initializeClient).toHaveBeenCalledWith(
      expect.stringContaining('HTTP/api.example.com'),
      expect.any(Object),
    );
  });
});
```

**Implementation:**

```typescript
// packages/auth-enterprise/src/kerberos-auth.ts

export interface KerberosAuthConfig {
  realm: string;
  kdcHost: string;
  kdcPort: number;
  servicePrincipal: string;
  spnegoEnabled: boolean;
}

export interface KerberosAuthSecrets {
  keytab: string;
  principal?: string;
  password?: string;
}

export interface KerberosAuthResult {
  headers: Record<string, string>;
}

/**
 * Obtains a Kerberos service ticket and returns an Authorization header.
 * Service tickets have 8-10h TTL; callers should cache in Redis.
 *
 * Lazily loads the `kerberos` npm package (native C++ bindings).
 *
 * SECURITY: The keytab is stored as base64 in encryptedSecrets. It must be
 * written to a temp file for the kerberos module (which reads KRB5_KTNAME).
 * The temp file is deleted immediately after ticket acquisition.
 */
export async function applyKerberosAuth(
  config: KerberosAuthConfig,
  secrets: KerberosAuthSecrets,
): Promise<KerberosAuthResult> {
  const kerberos = await import('kerberos');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  // Write keytab to temp file (kerberos module reads from filesystem)
  const keytabBuffer = Buffer.from(secrets.keytab, 'base64');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'krb5-'));
  const keytabPath = path.join(tmpDir, 'krb5.keytab');

  try {
    await fs.writeFile(keytabPath, keytabBuffer, { mode: 0o600 }); // owner-only read/write

    // Set environment for this ticket acquisition
    const prevKtName = process.env.KRB5_KTNAME;
    process.env.KRB5_KTNAME = keytabPath;

    try {
      const spn = config.servicePrincipal;
      const client = await kerberos.initializeClient(spn, {
        mechOID: config.spnegoEnabled ? kerberos.GSS_MECH_OID_SPNEGO : kerberos.GSS_MECH_OID_KRB5,
      });

      const token = await client.step('');

      return {
        headers: {
          Authorization: `Negotiate ${token}`,
        },
      };
    } finally {
      // Restore previous KRB5_KTNAME
      if (prevKtName !== undefined) {
        process.env.KRB5_KTNAME = prevKtName;
      } else {
        delete process.env.KRB5_KTNAME;
      }
    }
  } finally {
    // Always clean up temp keytab file
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
```

**Run, verify, commit** (same pattern as Task 4).

**Commit message:** `feat(auth-enterprise): implement kerberos auth with SPNEGO token acquisition`

---

### Task 6: `saml-auth.ts` — SAML assertion acquisition

- [ ] Implement SAML assertion acquisition using `@node-saml/node-saml`

**Files:**

- Create: `packages/auth-enterprise/src/saml-auth.ts`
- Test: `packages/auth-enterprise/src/__tests__/saml-auth.test.ts`

**Test (Red):**

```typescript
// packages/auth-enterprise/src/__tests__/saml-auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { applySamlAuth, type SamlAuthConfig, type SamlAuthSecrets } from '../saml-auth.js';

describe('applySamlAuth', () => {
  const config: SamlAuthConfig = {
    entityId: 'https://sp.example.com',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    assertionConsumerServiceUrl: 'https://sp.example.com/acs',
  };
  const secrets: SamlAuthSecrets = { idpCertificate: 'PEM-CERT' };

  it('returns headers with Authorization: SAML + base64 assertion', async () => {
    vi.mock('@node-saml/node-saml', () => ({
      SAML: vi.fn().mockImplementation(() => ({
        generateAuthorizeRequestAsync: vi.fn().mockResolvedValue('mock-saml-request'),
      })),
    }));

    const result = await applySamlAuth(config, secrets);
    expect(result.headers).toBeDefined();
    expect(result.headers['Authorization']).toMatch(/^SAML /);
  });
});
```

**Implementation:**

```typescript
// packages/auth-enterprise/src/saml-auth.ts

export interface SamlAuthConfig {
  entityId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  assertionConsumerServiceUrl: string;
}

export interface SamlAuthSecrets {
  idpCertificate: string;
  spPrivateKey?: string;
  spCertificate?: string;
}

export interface SamlAuthResult {
  headers: Record<string, string>;
}

/**
 * Obtains a SAML assertion from the IdP and returns an Authorization header.
 * Assertions have `NotOnOrAfter` TTL; callers should cache in Redis.
 *
 * Lazily loads `@node-saml/node-saml`.
 */
export async function applySamlAuth(
  config: SamlAuthConfig,
  secrets: SamlAuthSecrets,
): Promise<SamlAuthResult> {
  const { SAML } = await import('@node-saml/node-saml');

  const saml = new SAML({
    issuer: config.entityId,
    idpIssuer: config.idpEntityId,
    entryPoint: config.idpSsoUrl,
    callbackUrl: config.assertionConsumerServiceUrl,
    cert: secrets.idpCertificate,
    ...(secrets.spPrivateKey ? { privateKey: secrets.spPrivateKey } : {}),
    ...(secrets.spCertificate ? { decryptionPvk: secrets.spCertificate } : {}),
  });

  const assertionXml = await saml.generateAuthorizeRequestAsync('', false, false);
  const base64Assertion = Buffer.from(assertionXml).toString('base64');

  return {
    headers: {
      Authorization: `SAML ${base64Assertion}`,
    },
  };
}
```

**Commit message:** `feat(auth-enterprise): implement SAML assertion acquisition`

---

### Task 7: `hawk-auth.ts` — Hawk MAC computation

- [ ] Implement Hawk MAC-based HTTP auth using `@hapi/hawk`

**Files:**

- Create: `packages/auth-enterprise/src/hawk-auth.ts`
- Test: `packages/auth-enterprise/src/__tests__/hawk-auth.test.ts`

**Test (Red):**

```typescript
// packages/auth-enterprise/src/__tests__/hawk-auth.test.ts
import { describe, it, expect } from 'vitest';
import { applyHawkAuth, type HawkAuthConfig, type HawkAuthSecrets } from '../hawk-auth.js';

describe('applyHawkAuth', () => {
  const config: HawkAuthConfig = { algorithm: 'sha256' };
  const secrets: HawkAuthSecrets = {
    id: 'dh37fgj492je',
    key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn',
  };

  it('returns headers with Authorization: Hawk', async () => {
    const result = await applyHawkAuth(config, secrets, {
      url: 'https://example.com/resource',
      method: 'GET',
    });
    expect(result.headers['Authorization']).toMatch(/^Hawk /);
    expect(result.headers['Authorization']).toContain('id="dh37fgj492je"');
    expect(result.headers['Authorization']).toContain('mac="');
  });

  it('includes ext if provided in config', async () => {
    const configWithExt: HawkAuthConfig = { algorithm: 'sha256', ext: 'app-specific-data' };
    const result = await applyHawkAuth(configWithExt, secrets, {
      url: 'https://example.com/resource',
      method: 'GET',
    });
    expect(result.headers['Authorization']).toContain('ext="app-specific-data"');
  });
});
```

**Implementation:**

```typescript
// packages/auth-enterprise/src/hawk-auth.ts

export interface HawkAuthConfig {
  algorithm: 'sha256' | 'sha1';
  ext?: string;
  dlg?: string;
  timestampSkewSec?: number;
}

export interface HawkAuthSecrets {
  id: string;
  key: string;
}

export interface HawkAuthResult {
  headers: Record<string, string>;
}

/**
 * Computes Hawk MAC and returns an Authorization header.
 * Lazily loads `@hapi/hawk`.
 */
export async function applyHawkAuth(
  config: HawkAuthConfig,
  secrets: HawkAuthSecrets,
  request: { url: string; method: string; payload?: string; contentType?: string },
): Promise<HawkAuthResult> {
  const Hawk = await import('@hapi/hawk');

  const credentials = {
    id: secrets.id,
    key: secrets.key,
    algorithm: config.algorithm,
  };

  const { header } = Hawk.client.header(request.url, request.method, {
    credentials,
    ext: config.ext,
    dlg: config.dlg,
    payload: request.payload,
    contentType: request.contentType,
  });

  return {
    headers: {
      Authorization: header,
    },
  };
}
```

**Commit message:** `feat(auth-enterprise): implement Hawk MAC-based auth`

---

### Task 8: `ws-security-auth.ts` — SOAP WS-Security

- [ ] Implement WS-Security via `soap` library's `setSecurity()`

**Files:**

- Create: `packages/auth-enterprise/src/ws-security-auth.ts`
- Test: `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts`

**Test (Red):**

```typescript
// packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createWsSecurityHandler,
  type WsSecurityAuthConfig,
  type WsSecurityAuthSecrets,
} from '../ws-security-auth.js';

describe('createWsSecurityHandler', () => {
  it('returns a UsernameToken security object for UsernameToken mode', async () => {
    const config: WsSecurityAuthConfig = { mode: 'UsernameToken' };
    const secrets: WsSecurityAuthSecrets = { username: 'user', password: 'pass' };

    const handler = await createWsSecurityHandler(config, secrets);
    expect(handler).toBeDefined();
    expect(handler.type).toBe('UsernameToken');
  });

  it('returns an X509 security object for X509 mode', async () => {
    const config: WsSecurityAuthConfig = { mode: 'X509' };
    const secrets: WsSecurityAuthSecrets = { privateKey: 'PEM...', publicCert: 'PEM...' };

    const handler = await createWsSecurityHandler(config, secrets);
    expect(handler).toBeDefined();
    expect(handler.type).toBe('X509');
  });
});
```

**Implementation:**

```typescript
// packages/auth-enterprise/src/ws-security-auth.ts

export interface WsSecurityAuthConfig {
  mode: 'UsernameToken' | 'X509';
  passwordType?: string;
  addTimestamp?: boolean;
  signatureAlgorithm?: string;
}

export interface WsSecurityAuthSecrets {
  username?: string;
  password?: string;
  privateKey?: string;
  publicCert?: string;
}

export interface WsSecurityHandler {
  type: 'UsernameToken' | 'X509';
  applySecurity: (soapClient: unknown) => void;
}

/**
 * Creates a WS-Security handler for use with the `soap` library.
 * Lazily loads `soap` (~8MB) to avoid impacting non-SOAP workloads.
 *
 * Usage: `handler.applySecurity(soapClient)` sets the appropriate
 * security mode on the SOAP client before making calls.
 */
export async function createWsSecurityHandler(
  config: WsSecurityAuthConfig,
  secrets: WsSecurityAuthSecrets,
): Promise<WsSecurityHandler> {
  const soap = await import('soap');

  if (config.mode === 'UsernameToken') {
    const security = new soap.WSSecurity(secrets.username ?? '', secrets.password ?? '', {
      passwordType: config.passwordType ?? 'PasswordText',
      hasTimeStamp: config.addTimestamp ?? false,
    });

    return {
      type: 'UsernameToken',
      applySecurity: (soapClient: any) => {
        soapClient.setSecurity(security);
      },
    };
  }

  // X509 mode
  const security = new soap.ClientSSLSecurity(
    secrets.privateKey ?? '',
    secrets.publicCert ?? '',
    undefined,
    { strictSSL: true },
  );

  return {
    type: 'X509',
    applySecurity: (soapClient: any) => {
      soapClient.setSecurity(security);
    },
  };
}
```

**Commit message:** `feat(auth-enterprise): implement WS-Security auth for SOAP`

---

### Task 9: Extend `applyAuth()` dispatcher for enterprise types

- [ ] Add enterprise type cases to the `applyAuth()` function

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/apply-auth-enterprise.test.ts`

**Steps:**

1. Read `packages/shared/src/services/auth-profile/apply-auth.ts` to verify current signature.

2. Write test that verifies enterprise types are dispatched:

```typescript
// packages/shared/src/__tests__/auth-profile/apply-auth-enterprise.test.ts
import { describe, it, expect, vi } from 'vitest';
import { applyAuth } from '../../services/auth-profile/apply-auth.js';

describe('applyAuth — enterprise types', () => {
  it('dispatches digest to applyDigestAuth', async () => {
    const request = { url: 'https://example.com', method: 'GET', headers: {} };
    const profile = {
      authType: 'digest' as const,
      config: { algorithm: 'MD5' },
      decryptedSecrets: { username: 'user', password: 'pass' },
    };

    // Should not throw — indicates the type is handled
    await expect(applyAuth(profile, request)).resolves.toBeDefined();
  });

  it('dispatches hawk to applyHawkAuth', async () => {
    const request = { url: 'https://example.com', method: 'GET', headers: {} };
    const profile = {
      authType: 'hawk' as const,
      config: { algorithm: 'sha256' },
      decryptedSecrets: { id: 'abc', key: 'secret' },
    };

    const result = await applyAuth(profile, request);
    expect(result.headers['Authorization']).toMatch(/^Hawk /);
  });

  it('throws for ws_security applied to non-SOAP request', async () => {
    const request = { url: 'https://example.com/api', method: 'GET', headers: {} };
    const profile = {
      authType: 'ws_security' as const,
      config: { mode: 'UsernameToken' },
      decryptedSecrets: { username: 'u', password: 'p' },
    };

    // ws_security requires SOAP context — REST requests should get an error
    await expect(applyAuth(profile, request)).rejects.toThrow(/SOAP/i);
  });
});
```

3. Add cases to the `applyAuth()` switch statement:

```typescript
case 'digest': {
  const { applyDigestAuth } = await import('@agent-platform/auth-enterprise');
  const digestResult = applyDigestAuth(
    config as DigestAuthConfig,
    decryptedSecrets as DigestAuthSecrets,
  );
  // Digest uses its own fetch wrapper — return it for the caller
  return { ...request, digestFetch: digestResult.fetch };
}
case 'kerberos': {
  // Cache key: `auth-profile:kerberos:{tenantId}:{profileId}`
  // TTL: 8 hours (Kerberos service ticket lifetime)
  // Check Redis cache first; on miss, acquire ticket and cache
  const cacheKey = `auth-profile:kerberos:${profile.tenantId}:${profile._id}`;
  let token = await redis?.get(cacheKey);
  if (!token) {
    const { applyKerberosAuth } = await import('@agent-platform/auth-enterprise');
    const kerberosResult = await applyKerberosAuth(config, decryptedSecrets);
    token = kerberosResult.headers['Authorization'];
    await redis?.set(cacheKey, token, 'PX', 8 * 60 * 60 * 1000); // 8h TTL
  }
  return { ...request, headers: { ...request.headers, Authorization: token } };
}
case 'saml': {
  // Cache key: `auth-profile:saml:{tenantId}:{profileId}`
  // TTL: based on SAML assertion NotOnOrAfter (default 1h)
  const cacheKey = `auth-profile:saml:${profile.tenantId}:${profile._id}`;
  let cachedAuth = await redis?.get(cacheKey);
  if (!cachedAuth) {
    const { applySamlAuth } = await import('@agent-platform/auth-enterprise');
    const samlResult = await applySamlAuth(config, decryptedSecrets);
    cachedAuth = samlResult.headers['Authorization'];
    await redis?.set(cacheKey, cachedAuth, 'PX', 60 * 60 * 1000); // 1h default TTL
  }
  return { ...request, headers: { ...request.headers, Authorization: cachedAuth } };
}
case 'hawk': {
  const { applyHawkAuth } = await import('@agent-platform/auth-enterprise');
  const hawkResult = await applyHawkAuth(config, decryptedSecrets, {
    url: request.url,
    method: request.method,
  });
  return { ...request, headers: { ...request.headers, ...hawkResult.headers } };
}
case 'ws_security': {
  throw new AuthProfileError(
    'WS_SECURITY_REQUIRES_SOAP',
    'ws_security auth type requires a SOAP client context — cannot apply to REST HTTP requests',
  );
}
```

**Commit message:** `feat(shared): extend applyAuth() dispatcher for 5 enterprise auth types`

---

### Task 10: Dockerfile updates for `kerberos` native bindings

- [ ] Add `libkrb5-dev` to runtime and search-ai Dockerfiles

**Files:**

- Modify: `apps/runtime/Dockerfile`
- Modify: `apps/search-ai/Dockerfile`

**Context:** Both Dockerfiles use `node:22-slim` as the build stage and `gcr.io/distroless/nodejs22-debian12` as the production stage. Distroless images do NOT support `apt-get`, so native Kerberos libraries must be compiled in the build stage and the compiled `.node` bindings copied to the production image via the existing `pnpm deploy --prod` prune step. The runtime library `libkrb5-3` must be copied manually from the build stage since distroless has no package manager.

**Steps:**

1. In the build stage (which uses `node:22-slim`), add `libkrb5-dev` before `pnpm install`:

```dockerfile
# In the build stage (node:22-slim), BEFORE pnpm install:
RUN apt-get update && apt-get install -y --no-install-recommends \
    libkrb5-dev \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
```

Note: `python3 make g++` are needed for native addon compilation if not already present in `node:22-slim`.

2. The compiled `kerberos` native bindings will be included in `node_modules/kerberos/build/` and carried into the production image via the `pnpm deploy --prod /app/pruned` step.

3. For the production stage (distroless), copy the Kerberos runtime libraries from the build stage:

```dockerfile
# In the production stage (distroless), copy kerberos runtime libs:
COPY --from=builder /usr/lib/x86_64-linux-gnu/libkrb5*.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libk5crypto.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libgssapi_krb5.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libcom_err.so* /usr/lib/x86_64-linux-gnu/
```

4. For `linux/arm64` (Apple Silicon CI), the lib paths are `/usr/lib/aarch64-linux-gnu/` — use a build arg or multi-platform conditional if needed.

5. Repeat for `apps/search-ai/Dockerfile`.

6. Test both `linux/amd64` and `linux/arm64` builds:

```bash
docker build --platform linux/amd64 -t runtime-test -f apps/runtime/Dockerfile .
docker run --rm runtime-test node -e "require('kerberos')"
```

**Commit message:** `build(docker): add libkrb5 for kerberos native bindings in runtime and search-ai`

---

### Task 11: Add `COPY` lines for `packages/auth-enterprise` to all Dockerfiles

- [ ] Add package.json COPY line to every Dockerfile that uses individual `COPY packages/*/package.json` lines

**Context:** There are 10 Dockerfiles under `apps/`. Seven use `pnpm install --frozen-lockfile`. Of these, some use individual `COPY packages/<name>/package.json` lines (need updating), while others bulk-copy with `COPY packages/ packages/` in a single step (already covered). Additionally, `apps/workflow-engine/Dockerfile` and `apps/crawler-go-worker/Dockerfile` use `COPY packages/ packages/` (bulk copy) before `pnpm install`, so they do NOT need individual COPY lines.

**Files requiring individual COPY line addition:**

- Modify: `apps/runtime/Dockerfile` (individual COPY lines at L20-47)
- Modify: `apps/search-ai/Dockerfile` (individual COPY lines)
- Modify: `apps/admin/Dockerfile` (individual COPY lines)
- Modify: `apps/studio/Dockerfile` (individual COPY lines)
- Modify: `apps/search-ai-runtime/Dockerfile` (individual COPY lines)
- Modify: `apps/multimodal-service/Dockerfile` (individual COPY lines)

**Files that do NOT need changes (bulk `COPY packages/ packages/`):**

- `apps/workflow-engine/Dockerfile` — uses `COPY packages/ packages/`
- `apps/crawler-go-worker/Dockerfile` — Go-based, copies all packages
- `apps/crawler-mcp-server/Dockerfile` — verify if Node-based
- `apps/nlu-sidecar/Dockerfile` — verify if it uses pnpm

**Steps:**

Add this line alongside the other `COPY packages/<name>/package.json` lines in each Dockerfile listed above:

```dockerfile
COPY packages/auth-enterprise/package.json packages/auth-enterprise/package.json
```

**Verification:**

```bash
# Verify all Dockerfiles that individually COPY package.json files include auth-enterprise:
for f in apps/runtime/Dockerfile apps/search-ai/Dockerfile apps/admin/Dockerfile apps/studio/Dockerfile apps/search-ai-runtime/Dockerfile apps/multimodal-service/Dockerfile; do
  echo "=== $f ==="
  grep "auth-enterprise" "$f" || echo "MISSING!"
done
```

**Commit message:** `build(docker): add auth-enterprise package.json COPY to all Dockerfiles`

---

## Phase B — Deferred Addons

> Adds `certificatePinning` and `jwtWrapping` addon schemas, validation, enforcement, and Phase 3 invalid combination rules.

### Task 12: `certificatePinning` addon schema + validation

- [ ] Add Zod schema for `certificatePinning` addon

**Files:**

- Modify: `packages/shared/src/validation/auth-profile.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/addon-phase3-schema.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/addon-phase3-schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  CertificatePinningSchema,
  JwtWrappingSchema,
} from '../../validation/auth-profile.schema.js';

describe('CertificatePinningSchema', () => {
  it('accepts valid certificate pinning config', () => {
    const result = CertificatePinningSchema.safeParse({
      pins: [{ fingerprint: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }],
      mode: 'strict',
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one pin', () => {
    const result = CertificatePinningSchema.safeParse({ pins: [], mode: 'strict' });
    expect(result.success).toBe(false);
  });

  it('accepts report-only mode with reportUrl', () => {
    const result = CertificatePinningSchema.safeParse({
      pins: [{ fingerprint: 'sha256/abc123' }],
      mode: 'report-only',
      reportUrl: 'https://report.example.com/pin-violations',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional expiresAt on pins', () => {
    const result = CertificatePinningSchema.safeParse({
      pins: [{ fingerprint: 'sha256/abc', expiresAt: '2027-01-01T00:00:00Z' }],
      mode: 'strict',
    });
    expect(result.success).toBe(true);
  });
});
```

**Implementation:**

```typescript
export const CertificatePinningSchema = z
  .object({
    pins: z
      .array(
        z.object({
          fingerprint: z.string().min(1),
          expiresAt: z.string().datetime().optional(),
        }),
      )
      .min(1),
    mode: z.enum(['strict', 'report-only']),
    reportUrl: z.string().url().optional(),
  })
  .strict();
```

**Commit message:** `feat(shared): add certificatePinning addon Zod schema`

---

### Task 13: `jwtWrapping` addon schema + validation

- [ ] Add Zod schema for `jwtWrapping` addon

**Test:** Add to `addon-phase3-schema.test.ts`:

```typescript
describe('JwtWrappingSchema', () => {
  it('accepts valid JWT wrapping config', () => {
    const result = JwtWrappingSchema.safeParse({
      algorithm: 'RS256',
      issuer: 'https://auth.example.com',
      audience: 'https://api.example.com',
      expiresInSeconds: 3600,
    });
    expect(result.success).toBe(true);
  });

  it('requires algorithm, issuer, audience, expiresInSeconds', () => {
    expect(JwtWrappingSchema.safeParse({}).success).toBe(false);
  });

  it('accepts optional claims', () => {
    const result = JwtWrappingSchema.safeParse({
      algorithm: 'ES256',
      issuer: 'iss',
      audience: 'aud',
      expiresInSeconds: 300,
      claims: { role: 'admin', scope: 'read:all' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported algorithm', () => {
    const result = JwtWrappingSchema.safeParse({
      algorithm: 'HS256',
      issuer: 'iss',
      audience: 'aud',
      expiresInSeconds: 300,
    });
    expect(result.success).toBe(false);
  });
});
```

**Implementation:**

```typescript
export const JwtWrappingSchema = z
  .object({
    algorithm: z.enum(['RS256', 'ES256', 'RS384']),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    expiresInSeconds: z.number().int().positive(),
    claims: z.record(z.unknown()).optional(),
  })
  .strict();
```

**Commit message:** `feat(shared): add jwtWrapping addon Zod schema`

---

### Task 14: Add addon fields to Mongoose schema

- [ ] Add `certificatePinning` and `jwtWrapping` fields to AuthProfile Mongoose schema

**Files:**

- Modify: `packages/database/src/models/auth-profile.model.ts`

**Steps:**

Add alongside existing `signing`, `webhookVerification`, `proxy` fields:

```typescript
certificatePinning: { type: Schema.Types.Mixed },
jwtWrapping: { type: Schema.Types.Mixed },
```

Update the `IAuthProfile` interface:

```typescript
certificatePinning?: Record<string, unknown>;
jwtWrapping?: Record<string, unknown>;
```

**Commit message:** `feat(database): add certificatePinning and jwtWrapping addon fields to AuthProfile schema`

---

### Task 15: `certificatePinning` enforcement in request pipeline

- [ ] Enforce certificate pinning during HTTP requests

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/certificate-pinning.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/certificate-pinning.test.ts
import { describe, it, expect } from 'vitest';
import { applyCertificatePinning } from '../../services/auth-profile/apply-auth.js';

describe('applyCertificatePinning', () => {
  it('adds checkServerIdentity to TLS options in strict mode', () => {
    const pinning = {
      pins: [{ fingerprint: 'sha256/abc123' }],
      mode: 'strict' as const,
    };
    const tlsOptions = applyCertificatePinning(pinning);
    expect(tlsOptions.checkServerIdentity).toBeDefined();
    expect(typeof tlsOptions.checkServerIdentity).toBe('function');
  });

  it('adds reporting callback in report-only mode', () => {
    const pinning = {
      pins: [{ fingerprint: 'sha256/abc123' }],
      mode: 'report-only' as const,
      reportUrl: 'https://report.example.com',
    };
    const tlsOptions = applyCertificatePinning(pinning);
    expect(tlsOptions.checkServerIdentity).toBeDefined();
    // report-only mode should not throw on mismatch
  });
});
```

**Implementation:** Add `applyCertificatePinning()` function that returns a `checkServerIdentity` callback comparing the server certificate's SPKI SHA-256 fingerprint against the configured pins. In `strict` mode, throw on mismatch. In `report-only` mode, log violation and POST to `reportUrl`.

**Commit message:** `feat(shared): implement certificatePinning enforcement in request pipeline`

---

### Task 16: `jwtWrapping` enforcement in request pipeline

- [ ] Wrap outbound request with a signed JWT containing the original auth

**Files:**

- Modify: `packages/shared/src/services/auth-profile/apply-auth.ts`
- Test: `packages/shared/src/__tests__/auth-profile/jwt-wrapping.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/jwt-wrapping.test.ts
import { describe, it, expect } from 'vitest';
import { applyJwtWrapping } from '../../services/auth-profile/apply-auth.js';

describe('applyJwtWrapping', () => {
  it('replaces Authorization header with a signed JWT', async () => {
    const config = {
      algorithm: 'RS256' as const,
      issuer: 'https://auth.example.com',
      audience: 'https://api.example.com',
      expiresInSeconds: 3600,
    };
    const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
    const headers = { Authorization: 'Bearer original-token' };

    const result = await applyJwtWrapping(config, privateKey, headers);
    expect(result['Authorization']).toMatch(/^Bearer ey/); // JWT starts with ey
    expect(result['Authorization']).not.toBe('Bearer original-token');
  });
});
```

**Implementation:** Use `crypto.sign()` (Node.js built-in) to create a JWT with the configured algorithm, issuer, audience, expiry, and optional claims. The original bearer token is embedded as a claim (`inner_token`). The `jwtPrivateKey` is read from `encryptedSecrets`.

**Commit message:** `feat(shared): implement jwtWrapping addon in request pipeline`

---

### Task 17: Phase 3 invalid combination rules

- [ ] Add Phase 3 invalid combination checks to validation

**Files:**

- Modify: `packages/shared/src/validation/auth-profile.schema.ts`
- Test: `packages/shared/src/__tests__/auth-profile/invalid-combinations-phase3.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/invalid-combinations-phase3.test.ts
import { describe, it, expect } from 'vitest';
import { validateAddonCombinations } from '../../validation/auth-profile.schema.js';

describe('Phase 3 invalid combinations', () => {
  it('rejects ws_security + any HTTP addon (signing)', () => {
    const result = validateAddonCombinations('ws_security', {
      signing: { algorithm: 'hmac-sha256', signedComponents: ['body'] },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/ws_security.*HTTP/i);
  });

  it('rejects ws_security + proxy', () => {
    const result = validateAddonCombinations('ws_security', {
      proxy: { url: 'https://proxy.example.com' },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects ws_security + certificatePinning', () => {
    const result = validateAddonCombinations('ws_security', {
      certificatePinning: { pins: [{ fingerprint: 'sha256/abc' }], mode: 'strict' },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects ssh_key + jwtWrapping', () => {
    const result = validateAddonCombinations('ssh_key', {
      jwtWrapping: { algorithm: 'RS256', issuer: 'i', audience: 'a', expiresInSeconds: 60 },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/ssh_key.*HTTP/i);
  });

  it('allows api_key + jwtWrapping', () => {
    const result = validateAddonCombinations('api_key', {
      jwtWrapping: { algorithm: 'RS256', issuer: 'i', audience: 'a', expiresInSeconds: 60 },
    });
    expect(result.valid).toBe(true);
  });

  it('allows bearer + certificatePinning', () => {
    const result = validateAddonCombinations('bearer', {
      certificatePinning: { pins: [{ fingerprint: 'sha256/abc' }], mode: 'strict' },
    });
    expect(result.valid).toBe(true);
  });
});
```

**Implementation:** Extend the existing `validateAddonCombinations()` function with Phase 3 rules:

```typescript
// Phase 3 invalid combinations
if (authType === 'ws_security') {
  const httpAddons = [
    'signing',
    'webhookVerification',
    'proxy',
    'certificatePinning',
    'jwtWrapping',
  ];
  for (const addon of httpAddons) {
    if (addons[addon]) {
      return {
        valid: false,
        reason: `ws_security operates on SOAP XML; HTTP addon '${addon}' is not applicable`,
      };
    }
  }
}

if (authType === 'ssh_key') {
  // ssh_key + signing and ssh_key + proxy are already blocked in Phase 2.
  // Phase 3 adds jwtWrapping and certificatePinning.
  if (addons.jwtWrapping) {
    return {
      valid: false,
      reason: 'ssh_key is not used in HTTP requests; jwtWrapping is not applicable',
    };
  }
  if (addons.certificatePinning) {
    return {
      valid: false,
      reason: 'ssh_key is not used in HTTP requests; certificatePinning is not applicable',
    };
  }
}
```

**Commit message:** `feat(shared): add Phase 3 invalid addon combination rules`

---

## Phase C — Multi-Agent Credential Propagation

> Ensures credentials propagate correctly across handoff, delegate, and fan-out agent patterns.

### Task 18: Handoff — check Agent B `authRequirements`

- [ ] Before handoff, verify Agent B's auth requirements are satisfied

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts` (wire into `handleHandoff()` at L257)
- Create: `apps/runtime/src/services/execution/auth-profile-handoff.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-handoff.test.ts`

**Test (Red):**

```typescript
// apps/runtime/src/__tests__/auth-profile-handoff.test.ts
import { describe, it, expect, vi } from 'vitest';
import { validateHandoffAuthRequirements } from '../services/execution/auth-profile-handoff.js';

describe('validateHandoffAuthRequirements', () => {
  it('passes when Agent B has no auth requirements', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: { authRequirements: [] },
      userTokens: [],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(true);
  });

  it('passes when user has matching oauth2_token for required connector', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: { authRequirements: [{ connector: 'gmail', connectionMode: 'per_user' }] },
      userTokens: [{ connector: 'gmail', authType: 'oauth2_token', userId: 'u1' }],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(true);
  });

  it('fails when user lacks required auth', async () => {
    const result = await validateHandoffAuthRequirements({
      targetAgent: { authRequirements: [{ connector: 'gmail', connectionMode: 'per_user' }] },
      userTokens: [],
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].connector).toBe('gmail');
  });
});
```

**Implementation:** Create `apps/runtime/src/services/execution/auth-profile-handoff.ts`:

```typescript
import type { AuthProfile } from '@agent-platform/database';

interface AuthRequirement {
  connector: string;
  connectionMode: 'per_user' | 'shared';
}

interface ValidateHandoffParams {
  targetAgent: { authRequirements: AuthRequirement[] };
  userTokens: Array<{ connector: string; authType: string; userId: string }>;
  tenantId: string;
  projectId: string;
}

interface HandoffAuthResult {
  satisfied: boolean;
  missing: AuthRequirement[];
}

export async function validateHandoffAuthRequirements(
  params: ValidateHandoffParams,
): Promise<HandoffAuthResult> {
  const { targetAgent, userTokens } = params;

  if (!targetAgent.authRequirements.length) {
    return { satisfied: true, missing: [] };
  }

  const missing: AuthRequirement[] = [];

  for (const req of targetAgent.authRequirements) {
    if (req.connectionMode === 'per_user') {
      const hasToken = userTokens.some(
        (t) => t.connector === req.connector && t.authType === 'oauth2_token',
      );
      if (!hasToken) {
        missing.push(req);
      }
    }
    // shared mode: credentials are resolved per-project, no user token needed
  }

  return {
    satisfied: missing.length === 0,
    missing,
  };
}
```

Wire into `routing-executor.ts` at the `handleHandoff()` method (L257) — call `validateHandoffAuthRequirements()` before executing the handoff. If unsatisfied, emit a consent request or block the session depending on configuration.

**Commit message:** `feat(runtime): validate auth requirements before agent handoff`

---

### Task 19: Delegate — propagate user context for personal token resolution

- [ ] Ensure delegated agents resolve personal tokens using the delegating user's identity

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts` (wire into `handleDelegate()` at L1932)
- Create: `apps/runtime/src/services/execution/auth-profile-delegate.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-delegate.test.ts`

**Test (Red):**

```typescript
// apps/runtime/src/__tests__/auth-profile-delegate.test.ts
import { describe, it, expect } from 'vitest';
import { buildDelegateAuthContext } from '../services/execution/auth-profile-delegate.js';

describe('buildDelegateAuthContext', () => {
  it('propagates userId from delegating session', () => {
    const ctx = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-456',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(ctx.userId).toBe('user-123');
    expect(ctx.delegatedBy).toContain('session-456');
  });

  it('includes delegatedBy audit trail', () => {
    const ctx = buildDelegateAuthContext({
      delegatingUserId: 'user-123',
      delegatingSessionId: 'session-456',
      tenantId: 't1',
      projectId: 'p1',
    });
    expect(ctx.delegatedBy).toEqual(['session-456']);
  });
});
```

**Implementation:** `auth-profile-delegate.ts` creates an auth context that carries the delegating user's identity so that `authProfileService.resolve()` can use it for personal token resolution.

**Commit message:** `feat(runtime): propagate user context for delegate credential resolution`

---

### Task 20: Fan-out — independent resolution per branch

- [ ] Ensure each fan-out branch resolves credentials independently

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts` (wire into `handleFanOut()` at L2507)
- Create: `apps/runtime/src/services/execution/auth-profile-fanout.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-fanout.test.ts`

**Test (Red):**

```typescript
// apps/runtime/src/__tests__/auth-profile-fanout.test.ts
import { describe, it, expect } from 'vitest';
import { buildFanOutAuthContexts } from '../services/execution/auth-profile-fanout.js';

describe('buildFanOutAuthContexts', () => {
  it('creates independent auth contexts per branch', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b', 'agent-c'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });

    expect(contexts).toHaveLength(3);
    // Each context is independent
    expect(contexts[0].agentName).toBe('agent-a');
    expect(contexts[1].agentName).toBe('agent-b');
    // All share the same originating user for personal token resolution
    expect(contexts[0].userId).toBe('user-123');
    expect(contexts[1].userId).toBe('user-123');
  });

  it('does not share credential cache between branches', () => {
    const contexts = buildFanOutAuthContexts({
      branches: ['agent-a', 'agent-b'],
      originatingUserId: 'user-123',
      tenantId: 't1',
      projectId: 'p1',
    });

    // Each branch gets its own cache instance
    expect(contexts[0].credentialCache).not.toBe(contexts[1].credentialCache);
  });
});
```

**Commit message:** `feat(runtime): ensure independent credential resolution per fan-out branch`

---

## Phase D — Import/Export Auth Mapping

> Extends the project export/import system to handle Auth Profile references.

### Task 21: Export — `required_auth_profiles` in manifest metadata

- [ ] Add auth profile metadata to export manifest

**Files:**

- Modify: `packages/project-io/src/export/layer-assemblers/connections-assembler.ts`
- Modify: `packages/project-io/src/export/manifest-generator.ts`
- Modify: `packages/project-io/src/types.ts` (extend `ProjectManifestV2.metadata` type)
- Test: `packages/project-io/src/__tests__/connections-assembler.test.ts`

**Steps:**

1. Read `packages/project-io/src/export/layer-assemblers/connections-assembler.ts` to understand current export shape.

2. Extend the `ProjectManifestV2` interface in `packages/project-io/src/types.ts` to add `required_auth_profiles` to the `metadata` object:

```typescript
// In packages/project-io/src/types.ts — extend ProjectManifestV2.metadata
metadata: {
  entity_counts: Record<string, number>;
  required_env_vars: string[];
  required_connectors: string[];
  required_mcp_servers: string[];
  required_auth_profiles?: Array<{
    name: string;
    authType: string;
    scope: 'tenant' | 'project';
    connector?: string;
    category?: string;
    connectionMode?: 'shared' | 'per_user';
    config: Record<string, unknown>;
    referencedBy: string[];
  }>;
};
```

3. Add `required_auth_profiles` array to manifest metadata:

```typescript
// In ConnectionsAssembler — after building connection data:
const requiredAuthProfiles = connections
  .filter((c) => c.authProfileId)
  .map((c) => ({
    name: c.authProfileName, // resolved from authProfileId
    authType: c.authProfile?.authType,
    scope: c.authProfile?.scope,
    connector: c.authProfile?.connector,
    category: c.authProfile?.category,
    connectionMode: c.authProfile?.visibility === 'personal' ? 'per_user' : 'shared',
    config: stripSecrets(c.authProfile?.config ?? {}),
    referencedBy: [c.connectorName],
  }));

// Strip authProfileId from exported connections (never export IDs)
// Export authProfileName instead
```

4. Update `manifest-generator.ts` to include `required_auth_profiles` in `metadata`.

**Commit message:** `feat(project-io): export required_auth_profiles in manifest metadata`

---

### Task 22: `env-var-scanner.ts` extended for `auth:` references

- [ ] Scan DSL for `auth:` references and include in manifest

**Files:**

- Modify: `packages/project-io/src/export/env-var-scanner.ts`
- Test: `packages/project-io/src/__tests__/env-var-scanner.test.ts`

**Test (Red):**

```typescript
// packages/project-io/src/__tests__/env-var-scanner.test.ts — add new describe block
import { extractAuthProfileReferences } from '../export/env-var-scanner.js';

describe('auth reference scanning', () => {
  it('extracts AUTH: references from DSL', () => {
    const dsl = `TOOL my-tool\n  TYPE: http\n  URL: https://api.example.com\n  AUTH: production-openai`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toContain('production-openai');
  });

  it('handles multiple auth references', () => {
    const dsl = `TOOL tool-a\n  AUTH: profile-one\n\nTOOL tool-b\n  AUTH: profile-two`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['profile-one', 'profile-two']);
  });

  it('deduplicates repeated auth references', () => {
    const dsl = `TOOL tool-a\n  AUTH: shared-profile\n\nTOOL tool-b\n  AUTH: shared-profile`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['shared-profile']);
  });
});
```

**Implementation:** Add to `packages/project-io/src/export/env-var-scanner.ts`:

```typescript
/** Extract all AUTH: references from DSL content */
export function extractAuthProfileReferences(dslContent: string): string[] {
  const authPattern = /^\s*AUTH:\s+(.+)$/gim;
  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = authPattern.exec(dslContent)) !== null) {
    refs.add(match[1].trim());
  }
  return [...refs].sort();
}
```

Also update `scanProjectEnvVars()` to return auth profile names alongside env vars, or add a new `scanProjectAuthProfiles()` function following the same pattern.

**Commit message:** `feat(project-io): scan DSL for auth: references in env-var-scanner`

---

### Task 23: Import preview — extract auth profile requirements

- [ ] Show auth profile requirements in import preview response

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`
- Test: `packages/project-io/src/__tests__/auth-profile-mapping.test.ts`

**Test (Red):**

```typescript
// packages/project-io/src/__tests__/auth-profile-mapping.test.ts
import { describe, it, expect } from 'vitest';
import { extractAuthMappingRequirements } from '../import/auth-mapping.js';

describe('extractAuthMappingRequirements', () => {
  it('extracts auth requirements from manifest', () => {
    const manifest = {
      metadata: {
        required_auth_profiles: [
          { name: 'production-openai', authType: 'api_key', scope: 'project' },
        ],
      },
    };
    const result = extractAuthMappingRequirements(manifest);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('production-openai');
  });

  it('matches existing profiles by name and authType', async () => {
    const requirements = [{ name: 'production-openai', authType: 'api_key', scope: 'project' }];
    const existingProfiles = [
      { _id: 'p1', name: 'production-openai', authType: 'api_key' },
      { _id: 'p2', name: 'other-profile', authType: 'bearer' },
    ];
    const candidates = matchAuthProfileCandidates(requirements, existingProfiles);
    expect(candidates[0].candidates).toHaveLength(1);
    expect(candidates[0].candidates[0]._id).toBe('p1');
  });
});
```

**Implementation:** Create `packages/project-io/src/import/auth-mapping.ts` with extraction and matching logic.

**Commit message:** `feat(project-io): extract auth profile requirements during import preview`

---

### Task 24: Import apply — accept `authProfileMapping`

- [ ] Accept auth profile mapping in import apply endpoint

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`
- Modify: `packages/project-io/src/import/import-applier.ts`

**Steps:**

1. Accept `authProfileMapping: Record<string, string>` in the apply request body (maps exported profile name to target profile ID).
2. During import, replace `authProfileName` references with the mapped `authProfileId`.
3. Validate all mapped profile IDs exist and are accessible in the target project scope.

**Commit message:** `feat(studio): accept authProfileMapping in import apply endpoint`

---

### Task 25: Cross-tenant import — strip `authProfileId` references

- [ ] Strip all `authProfileId` references during cross-tenant import

**Files:**

- Modify: `packages/project-io/src/import/import-applier.ts`
- Test: `packages/project-io/src/__tests__/auth-profile-mapping.test.ts`

**Test:**

```typescript
describe('cross-tenant auth stripping', () => {
  it('strips authProfileId from imported connections', () => {
    const connection = {
      name: 'gmail-conn',
      authProfileId: 'foreign-tenant-profile-id',
      connectorName: 'gmail',
    };
    const stripped = stripCrossTenantAuthReferences(connection);
    expect(stripped.authProfileId).toBeUndefined();
    expect(stripped.name).toBe('gmail-conn');
  });
});
```

**Commit message:** `feat(project-io): strip authProfileId references in cross-tenant import`

---

### Task 26: Post-import doctor — Auth Profile checks

- [ ] Extend post-import doctor to report missing auth profiles

**Files:**

- Modify: `packages/project-io/src/import/post-import-validator.ts`
- Test: `packages/project-io/src/__tests__/post-import-validator.test.ts`

**Steps:**

1. Read `packages/project-io/src/import/post-import-validator.ts` to understand actual interface. The function is `validatePostImport()` (not `buildPostImportReport()`).

2. Extend `PostImportReport.provisioning_required` to include `auth_profiles`:

```typescript
// In PostImportReport.provisioning_required, add:
auth_profiles: Array<{
  name: string;
  connectionMode?: 'shared' | 'per_user';
}>;
```

3. Extend `PostImportDbAdapter` with a new method:

```typescript
/** Get auth profiles available in this project scope */
getProjectAuthProfiles(
  projectId: string,
  tenantId: string,
): Promise<Array<{ name: string; authType: string }>>;
```

4. Extend `PostImportInput` with:

```typescript
/** Auth profile names referenced in DSL (from extractAuthProfileReferences) */
referencedAuthProfiles: string[];
```

**Test (Red):**

```typescript
describe('post-import auth profile checks', () => {
  it('reports missing auth profiles in provisioning_required', async () => {
    const report = await validatePostImport(
      {
        projectId: 'p1',
        tenantId: 't1',
        importedLayers: ['core', 'connections'],
        referencedEnvVars: [],
        referencedConnectors: [],
        referencedMCPServers: [],
        referencedAuthProfiles: ['missing-profile'],
        layerCounts: {},
      },
      mockDbAdapter,
    );
    expect(report.provisioning_required.auth_profiles).toHaveLength(1);
    expect(report.provisioning_required.auth_profiles[0].name).toBe('missing-profile');
  });
});
```

**Commit message:** `feat(project-io): extend post-import doctor for auth profile checks`

---

## Phase E — Voice Lifecycle Auth

> Adds call-duration credential caching for voice sessions.

### Task 27: Call duration credential caching

- [ ] Implement Redis-based credential cache for active voice calls

**Files:**

- Create: `apps/runtime/src/services/voice/voice-credential-cache.ts`
- Test: `apps/runtime/src/__tests__/voice-credential-cache.test.ts`

**Test (Red):**

```typescript
// apps/runtime/src/__tests__/voice-credential-cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceCredentialCache } from '../services/voice/voice-credential-cache.js';

describe('VoiceCredentialCache', () => {
  let cache: VoiceCredentialCache;
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new VoiceCredentialCache(mockRedis as any);
  });

  it('caches decrypted credentials with call-scoped key', async () => {
    await cache.set({
      tenantId: 't1',
      callId: 'call-123',
      credentials: { apiKey: 'secret' },
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth-profile:voice:t1:call-123',
      expect.any(String),
      'PX',
      14400000, // 4 hours max TTL
    );
  });

  it('retrieves cached credentials', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ apiKey: 'secret' }));

    const result = await cache.get({ tenantId: 't1', callId: 'call-123' });
    expect(result).toEqual({ apiKey: 'secret' });
  });

  it('returns null on cache miss', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await cache.get({ tenantId: 't1', callId: 'call-123' });
    expect(result).toBeNull();
  });
});
```

**Implementation:**

```typescript
// apps/runtime/src/services/voice/voice-credential-cache.ts
import type { Redis } from 'ioredis';

const VOICE_CACHE_PREFIX = 'auth-profile:voice';
const MAX_CALL_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export class VoiceCredentialCache {
  constructor(private readonly redis: Redis) {}

  async set(params: {
    tenantId: string;
    callId: string;
    credentials: Record<string, unknown>;
  }): Promise<void> {
    const key = `${VOICE_CACHE_PREFIX}:${params.tenantId}:${params.callId}`;
    await this.redis.set(key, JSON.stringify(params.credentials), 'PX', MAX_CALL_TTL_MS);
  }

  async get(params: { tenantId: string; callId: string }): Promise<Record<string, unknown> | null> {
    const key = `${VOICE_CACHE_PREFIX}:${params.tenantId}:${params.callId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async invalidate(params: { tenantId: string; callId: string }): Promise<void> {
    const key = `${VOICE_CACHE_PREFIX}:${params.tenantId}:${params.callId}`;
    await this.redis.del(key);
  }
}
```

**Commit message:** `feat(runtime): add voice credential cache with call-duration TTL`

---

### Task 28: Cache invalidation on call end / rotation

- [ ] Wire cache invalidation to call end events and auth profile rotation events

**Files:**

- Modify: `apps/runtime/src/services/voice/voice-credential-cache.ts`
- Test: `apps/runtime/src/__tests__/voice-credential-cache.test.ts`

**Test:**

```typescript
describe('VoiceCredentialCache invalidation', () => {
  it('invalidates on call end', async () => {
    await cache.invalidate({ tenantId: 't1', callId: 'call-123' });
    expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:voice:t1:call-123');
  });

  it('invalidates all calls for a profile on rotation', async () => {
    // Rotation event triggers scan + delete of matching keys
    mockRedis.scan = vi
      .fn()
      .mockResolvedValueOnce([
        '0',
        ['auth-profile:voice:t1:call-1', 'auth-profile:voice:t1:call-2'],
      ]);
    mockRedis.del.mockResolvedValue(2);

    await cache.invalidateByTenant('t1');
    expect(mockRedis.del).toHaveBeenCalledTimes(1);
  });
});
```

Wire into call-end event handler and Redis Pub/Sub auth-profile-rotation channel.

**Commit message:** `feat(runtime): wire voice credential cache invalidation to call end and rotation events`

---

## Phase F — Rotation Batch Job

> Re-encrypts all Auth Profile secrets when the encryption master key is rotated.

### Task 29: Rotation job — batched re-encryption

- [ ] Implement rotation batch job

**Files:**

- Create: `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-rotation.test.ts`

**Test (Red):**

```typescript
// apps/runtime/src/__tests__/auth-profile-rotation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProfileRotationJob } from '../services/auth-profile/auth-profile-rotation-job.js';

describe('AuthProfileRotationJob', () => {
  let job: AuthProfileRotationJob;
  const mockAuthProfile = {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };
  const mockEncryptionService = {
    decrypt: vi.fn(),
    encrypt: vi.fn(),
    getCurrentKeyVersion: vi.fn().mockReturnValue(2),
  };
  const mockRedis = {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    job = new AuthProfileRotationJob({
      authProfileModel: mockAuthProfile as any,
      encryptionService: mockEncryptionService as any,
      redis: mockRedis as any,
      batchSize: 2,
    });
  });

  it('processes profiles with outdated encryptionKeyVersion', async () => {
    mockAuthProfile.find.mockResolvedValue([
      { _id: 'p1', encryptedSecrets: 'old-cipher-1', encryptionKeyVersion: 1, tenantId: 't1' },
      { _id: 'p2', encryptedSecrets: 'old-cipher-2', encryptionKeyVersion: 1, tenantId: 't1' },
    ]);
    mockEncryptionService.decrypt.mockResolvedValue('{"apiKey":"secret"}');
    mockEncryptionService.encrypt.mockResolvedValue('new-cipher');
    mockAuthProfile.findOneAndUpdate.mockResolvedValue({});

    const result = await job.run();
    expect(result.processed).toBe(2);
    expect(mockAuthProfile.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('stores previousEncryptedSecrets for grace period', async () => {
    mockAuthProfile.find.mockResolvedValue([
      { _id: 'p1', encryptedSecrets: 'old-cipher', encryptionKeyVersion: 1, tenantId: 't1' },
    ]);
    mockEncryptionService.decrypt.mockResolvedValue('{"apiKey":"secret"}');
    mockEncryptionService.encrypt.mockResolvedValue('new-cipher');
    mockAuthProfile.findOneAndUpdate.mockResolvedValue({});

    await job.run();

    expect(mockAuthProfile.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'p1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          previousEncryptedSecrets: 'old-cipher',
          encryptedSecrets: 'new-cipher',
          encryptionKeyVersion: 2,
        }),
      }),
    );
  });

  it('acquires distributed lock per profile', async () => {
    mockAuthProfile.find.mockResolvedValue([
      { _id: 'p1', encryptedSecrets: 'old', encryptionKeyVersion: 1, tenantId: 't1' },
    ]);
    mockEncryptionService.decrypt.mockResolvedValue('{}');
    mockEncryptionService.encrypt.mockResolvedValue('new');
    mockAuthProfile.findOneAndUpdate.mockResolvedValue({});

    await job.run();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth-profile:refresh:t1:p1',
      expect.any(String),
      'NX',
      'PX',
      expect.any(Number),
    );
  });

  it('skips profiles where lock is already held', async () => {
    mockAuthProfile.find.mockResolvedValue([
      { _id: 'p1', encryptedSecrets: 'old', encryptionKeyVersion: 1, tenantId: 't1' },
    ]);
    mockRedis.set.mockResolvedValue(null); // Lock already held

    const result = await job.run();
    expect(result.skipped).toBe(1);
    expect(mockAuthProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
```

**Implementation:**

```typescript
// apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts
import type { Redis } from 'ioredis';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-rotation');
const LOCK_TTL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;

interface RotationJobConfig {
  authProfileModel: any;
  encryptionService: any;
  redis: Redis;
  batchSize?: number;
}

interface RotationResult {
  processed: number;
  skipped: number;
  failed: number;
}

export class AuthProfileRotationJob {
  private readonly batchSize: number;

  constructor(private readonly config: RotationJobConfig) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async run(): Promise<RotationResult> {
    const currentVersion = this.config.encryptionService.getCurrentKeyVersion();
    const result: RotationResult = { processed: 0, skipped: 0, failed: 0 };

    let hasMore = true;
    while (hasMore) {
      const batch = await this.config.authProfileModel.find(
        { encryptionKeyVersion: { $lt: currentVersion } },
        null,
        { limit: this.batchSize },
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const profile of batch) {
        try {
          // Use the SAME lock namespace as token refresh to prevent concurrent
          // rotation + refresh on the same profile. Token refresh uses:
          //   `auth-profile:refresh:{tenantId}:{profileId}`
          // Rotation uses the same key to ensure mutual exclusion.
          const lockKey = `auth-profile:refresh:${profile.tenantId}:${profile._id}`;
          const lockAcquired = await this.config.redis.set(
            lockKey,
            'rotation',
            'NX',
            'PX',
            LOCK_TTL_MS,
          );

          if (!lockAcquired) {
            result.skipped++;
            continue;
          }

          try {
            const decrypted = await this.config.encryptionService.decrypt(profile.encryptedSecrets);
            const reEncrypted = await this.config.encryptionService.encrypt(decrypted);

            await this.config.authProfileModel.findOneAndUpdate(
              { _id: profile._id, tenantId: profile.tenantId },
              {
                $set: {
                  encryptedSecrets: reEncrypted,
                  previousEncryptedSecrets: profile.encryptedSecrets,
                  encryptionKeyVersion: currentVersion,
                },
              },
            );

            result.processed++;
            log.info('Rotated auth profile', { profileId: profile._id });
          } finally {
            await this.config.redis.del(lockKey);
          }
        } catch (err) {
          result.failed++;
          log.error('Failed to rotate auth profile', {
            profileId: profile._id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (batch.length < this.batchSize) {
        hasMore = false;
      }
    }

    log.info('Rotation job complete', { ...result });
    return result;
  }
}
```

**Commit message:** `feat(runtime): implement auth profile rotation batch job with per-profile locking`

---

### Task 30: Distributed lock per profile during rotation

- [ ] (Covered in Task 29 implementation — lock logic is part of the rotation job)

**Commit message:** N/A — merged with Task 29.

---

### Task 31: `previousEncryptedSecrets` grace period

- [ ] During credential resolution, fall back to `previousEncryptedSecrets` if primary decryption fails

**Files:**

- Modify: `packages/shared/src/services/auth-profile/auth-profile-resolver.ts`
- Test: `packages/shared/src/__tests__/auth-profile/grace-period.test.ts`

**Test (Red):**

```typescript
// packages/shared/src/__tests__/auth-profile/grace-period.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveWithGracePeriod } from '../../services/auth-profile/auth-profile-resolver.js';

describe('resolveWithGracePeriod', () => {
  it('returns primary decrypted secrets when successful', async () => {
    const profile = {
      encryptedSecrets: 'current-cipher',
      previousEncryptedSecrets: 'old-cipher',
      rotationGracePeriodMs: 86400000,
      updatedAt: new Date(),
    };
    const decrypt = vi.fn().mockResolvedValue('{"apiKey":"current"}');

    const result = await resolveWithGracePeriod(profile, decrypt);
    expect(result).toEqual({ apiKey: 'current' });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('falls back to previousEncryptedSecrets on primary decryption failure within grace period', async () => {
    const profile = {
      encryptedSecrets: 'corrupted-cipher',
      previousEncryptedSecrets: 'old-cipher',
      rotationGracePeriodMs: 86400000,
      updatedAt: new Date(), // within grace period
    };
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Decryption failed'))
      .mockResolvedValueOnce('{"apiKey":"previous"}');

    const result = await resolveWithGracePeriod(profile, decrypt);
    expect(result).toEqual({ apiKey: 'previous' });
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it('does not fall back after grace period expires', async () => {
    const profile = {
      encryptedSecrets: 'corrupted-cipher',
      previousEncryptedSecrets: 'old-cipher',
      rotationGracePeriodMs: 1000,
      updatedAt: new Date(Date.now() - 86400000), // 1 day ago, grace = 1 second
    };
    const decrypt = vi.fn().mockRejectedValue(new Error('Decryption failed'));

    await expect(resolveWithGracePeriod(profile, decrypt)).rejects.toThrow('Decryption failed');
    expect(decrypt).toHaveBeenCalledTimes(1); // No fallback attempted
  });
});
```

**Implementation:** Add `resolveWithGracePeriod()` to the resolver module:

```typescript
export async function resolveWithGracePeriod(
  profile: {
    encryptedSecrets: string;
    previousEncryptedSecrets?: string;
    rotationGracePeriodMs?: number;
    updatedAt: Date;
  },
  decrypt: (cipher: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  try {
    const decrypted = await decrypt(profile.encryptedSecrets);
    return JSON.parse(decrypted);
  } catch (primaryErr) {
    // Check if grace period is active
    if (
      profile.previousEncryptedSecrets &&
      profile.rotationGracePeriodMs &&
      Date.now() - profile.updatedAt.getTime() < profile.rotationGracePeriodMs
    ) {
      const decrypted = await decrypt(profile.previousEncryptedSecrets);
      return JSON.parse(decrypted);
    }
    throw primaryErr;
  }
}
```

**Commit message:** `feat(shared): implement previousEncryptedSecrets grace period fallback`

---

## Phase G — Cleanup (IRREVERSIBLE — Staged With Bake Periods)

> **WARNING:** Phase G operations are irreversible at the service level. Each step requires a 7-day bake period before proceeding to the next. Full MongoDB backup MUST be confirmed before starting.

### Go/No-Go Gate (MUST pass before any cleanup task)

- [ ] All workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days
- [ ] Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days
- [ ] Full MongoDB snapshot confirmed with retention policy (minimum 90 days)
- [ ] Dual-read fallback path exercised 0% of total credential resolutions for 14+ days
- [ ] All 3 legacy collections (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`) have zero new writes for 30+ days
- [ ] Canary tenant fully on Auth Profile with zero legacy fallbacks for 30+ days
- [ ] Migration rollback procedure tested on staging environment
- [ ] Phase G approval documented in team decision log

### Task 32: Cleanup Week 1 — Remove dual-read code paths

- [ ] Remove all dual-read fallback logic — every credential resolution uses only `authProfileService.resolve()`

**Files (Modify — remove dual-read branches):**

- `apps/runtime/src/services/execution/llm-wiring.ts`
- `apps/runtime/src/services/secrets-provider.ts`
- `apps/runtime/src/channels/connection-resolver.ts`
- `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`
- `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`
- `packages/connectors/src/auth/connection-resolver.ts`
- `packages/shared/src/services/mcp-server-registry.ts`
- `apps/search-ai/src/repos/connector.repository.ts`
- All BullMQ workers that use dual-read pattern

**Verification before proceeding:**

```bash
# Search for any remaining legacy credential resolution patterns:
cd /Users/prasannaarikala/projects/agent-platform && grep -r "credentialId" apps/runtime/src/services/ --include="*.ts" -l
cd /Users/prasannaarikala/projects/agent-platform && grep -r "encryptedCredentials" apps/runtime/src/ --include="*.ts" -l
cd /Users/prasannaarikala/projects/agent-platform && grep -r "LLMCredential" apps/ packages/ --include="*.ts" -l
```

Expected: Only model files, migration scripts, and test fixtures.

**Rollback procedure:** Revert the commit. Dual-read code is purely additive — removing it and then reverting restores it.

**Commit message:** `refactor(cleanup): remove all dual-read credential fallback paths — Auth Profile is sole credential system`

**Bake period:** 7 days. Monitor:

- `AUTH_PROFILE_DECRYPTION_FAILED` error rate = 0
- All API endpoints returning 200 for authenticated operations
- No increase in 401/403 error rates

---

### Task 33: Cleanup Week 2 — Drop legacy fields from consumer models (`$unset`)

- [ ] Run MongoDB `$unset` operations to remove legacy credential fields from all 14 consumer models

**Files:**

- Create: `scripts/migrations/phase3-cleanup-week2-unset-fields.ts`

**Migration script:**

```typescript
// scripts/migrations/phase3-cleanup-week2-unset-fields.ts
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI!;

interface UnsetTarget {
  collection: string;
  fields: string[];
}

const UNSET_TARGETS: UnsetTarget[] = [
  {
    collection: 'connector_connections',
    fields: [
      'encryptedCredentials',
      'encryptionKeyVersion',
      'oauth2TokenExpiresAt',
      'oauth2RefreshToken',
      'oauth2Provider',
      'authType',
    ],
  },
  {
    collection: 'mcp_server_configs',
    fields: ['encryptedAuthConfig', 'encryptedEnv', 'authType'],
  },
  {
    collection: 'channel_connections',
    fields: ['encryptedCredentials', 'config.encryptedInboundAuthToken'],
  },
  {
    collection: 'service_nodes',
    fields: ['encryptedSecrets', 'authConfig'],
  },
  {
    collection: 'org_proxy_configs',
    fields: [
      'encryptedProxyUsername',
      'encryptedProxyPassword',
      'encryptedMtlsCert',
      'encryptedMtlsKey',
      'encryptedCaCert',
      'encryptedBasicAuthToken',
    ],
  },
  {
    collection: 'tenant_models',
    fields: ['connections.$[elem].credentialId'],
    // NOTE: This uses arrayFilters — handled separately below
  },
  {
    collection: 'tenant_guardrail_provider_configs',
    fields: ['apiKeyCredentialId'],
  },
  {
    collection: 'git_integrations',
    fields: ['credentials.secretId', 'webhookSecret'],
  },
  {
    collection: 'tenant_service_instances',
    fields: ['encryptedApiKey', 'encryptedConfig'],
  },
  {
    collection: 'arch_workspace_configs',
    fields: ['encryptedApiKey', 'encryptedEndpoint'],
  },
  {
    collection: 'connector_configs',
    fields: ['oauthTokenId'],
  },
  {
    collection: 'webhook_subscriptions',
    fields: ['encryptedSecret'],
  },
  {
    collection: 'webhook_subscription_connectors',
    fields: ['encryptedClientState'],
  },
  {
    collection: 'sdk_channels',
    fields: ['secretKey'],
  },
];

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db();

    for (const target of UNSET_TARGETS) {
      console.log(`Unsetting fields from ${target.collection}: ${target.fields.join(', ')}`);

      // Special handling for array-embedded fields (e.g. tenant_models.connections[].credentialId)
      if (target.collection === 'tenant_models') {
        const result = await db
          .collection(target.collection)
          .updateMany(
            { 'connections.credentialId': { $exists: true } },
            { $unset: { 'connections.$[elem].credentialId': 1 } },
            { arrayFilters: [{ 'elem.credentialId': { $exists: true } }] },
          );
        console.log(`  Modified: ${result.modifiedCount} documents`);
        continue;
      }

      const unsetObj: Record<string, 1> = {};
      for (const field of target.fields) {
        unsetObj[field] = 1;
      }

      const result = await db.collection(target.collection).updateMany({}, { $unset: unsetObj });
      console.log(`  Modified: ${result.modifiedCount} documents`);
    }

    console.log('Phase 3 Week 2 cleanup complete.');
  } finally {
    await client.close();
  }
}

main().catch(console.error);
```

**Verification:**

```bash
# For each collection, verify no documents have the old fields:
mongosh --eval 'db.connector_connections.findOne({ encryptedCredentials: { $exists: true } })'
# Expected: null
```

**Rollback procedure:** Restore from MongoDB snapshot taken at go/no-go gate.

**Commit message:** `chore(cleanup): drop legacy credential fields from 14 consumer models via $unset`

**Bake period:** 7 days.

---

### Task 34: Cleanup Week 3 — Drop `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections

- [ ] Drop the 3 legacy credential collections

**Files:**

- Create: `scripts/migrations/phase3-cleanup-week3-drop-collections.ts`
- Delete: `packages/database/src/models/llm-credential.model.ts`
- Delete: `packages/database/src/models/end-user-oauth-token.model.ts`
- Delete: `packages/database/src/models/tool-secret.model.ts`
- Modify: `packages/database/src/models/index.ts` (remove exports for deleted models)
- Modify: `packages/database/src/index.ts` (remove exports for deleted models)
- Modify: `packages/database/src/cascade/cascade-delete.ts` (remove `LLMCredential` references — `EndUserOAuthToken` was never in cascade)
- Modify: `packages/database/src/models/connector-config.model.ts` (remove any import of `LLMCredential` if present)
- Delete: `packages/shared/src/validation/tool-secret-schemas.ts`
- Modify: `packages/shared/src/validation/index.ts` (remove export)

**Migration script:**

```typescript
// scripts/migrations/phase3-cleanup-week3-drop-collections.ts
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI!;
const COLLECTIONS_TO_DROP = ['llm_credentials', 'end_user_oauth_tokens', 'tool_secrets'];

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db();

    for (const collection of COLLECTIONS_TO_DROP) {
      const exists = await db.listCollections({ name: collection }).hasNext();
      if (exists) {
        console.log(`Dropping collection: ${collection}`);
        await db.collection(collection).drop();
        console.log(`  Dropped.`);
      } else {
        console.log(`Collection ${collection} does not exist — skipping.`);
      }
    }

    console.log('Phase 3 Week 3 cleanup complete.');
  } finally {
    await client.close();
  }
}

main().catch(console.error);
```

**Pre-drop verification:**

```bash
# Verify zero reads from legacy collections in the last 7 days
# Check application logs for any LLMCredential/EndUserOAuthToken/ToolSecret queries
grep -r "LLMCredential\|EndUserOAuthToken\|ToolSecret" apps/runtime/src/ --include="*.ts" -l
# Expected: only import statements in model registration files (which should have been cleaned up in Week 1)
```

**Post-drop verification:**

```bash
# Verify model files are deleted
ls packages/database/src/models/llm-credential.model.ts 2>&1  # Expected: No such file
ls packages/database/src/models/end-user-oauth-token.model.ts 2>&1  # Expected: No such file
ls packages/database/src/models/tool-secret.model.ts 2>&1  # Expected: No such file
```

**Build verification:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build
```

**Rollback procedure:** Restore collections from MongoDB snapshot. Re-add model files from git history.

**Commit message:** `chore(cleanup): drop LLMCredential, EndUserOAuthToken, ToolSecret collections and model files`

**Bake period:** 7 days.

---

### Task 35: Cleanup Week 4 — Remove obsolete env vars from Dockerfiles

- [ ] Remove hard-coded credential env vars from all Dockerfiles and deployment configs

**Files:**

- Modify: `apps/runtime/Dockerfile`
- Modify: `apps/studio/Dockerfile`
- Modify: `apps/search-ai/Dockerfile`
- Modify: Helm values files in `abl-platform-deploy` repo (if accessible)

**Env vars to remove:**

```
# Studio OAuth providers:
OAUTH_PROVIDER_GOOGLE_CLIENT_ID, OAUTH_PROVIDER_GOOGLE_CLIENT_SECRET
OAUTH_PROVIDER_MICROSOFT_CLIENT_ID, OAUTH_PROVIDER_MICROSOFT_CLIENT_SECRET
(etc. for all OAUTH_PROVIDER_* vars)

# Runtime channel OAuth:
CHANNEL_OAUTH_SLACK_CLIENT_ID, CHANNEL_OAUTH_SLACK_CLIENT_SECRET, CHANNEL_OAUTH_SLACK_SIGNING_SECRET
CHANNEL_OAUTH_MSTEAMS_CLIENT_ID, CHANNEL_OAUTH_MSTEAMS_CLIENT_SECRET, CHANNEL_OAUTH_MSTEAMS_TENANT_ID
CHANNEL_OAUTH_META_APP_ID, CHANNEL_OAUTH_META_APP_SECRET, CHANNEL_OAUTH_META_VERIFY_TOKEN
CHANNEL_OAUTH_META_PAGE_ACCESS_TOKEN, CHANNEL_OAUTH_META_WEBHOOK_SECRET

# Runtime LLM API keys:
ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_AI_API_KEY
AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT
```

**Verification:**

```bash
# Search for removed env vars in code:
grep -r "CHANNEL_OAUTH_SLACK\|OAUTH_PROVIDER_\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" apps/ --include="*.ts" -l
# Expected: empty (all references should have been updated in Phase 2)
```

**Commit message:** `chore(cleanup): remove obsolete credential env vars from Dockerfiles`

**Bake period:** 7 days.

---

### Task 36: Cleanup Week 5 — Remove `AUTH_PROFILE_ENABLED` feature flag

- [ ] Remove all conditional branches for `AUTH_PROFILE_ENABLED`

**Files:** All files that reference `AUTH_PROFILE_ENABLED`:

```bash
grep -r "AUTH_PROFILE_ENABLED" apps/ packages/ --include="*.ts" -l
```

**Steps:**

1. Search for all references.
2. Remove conditional branches — the `if (AUTH_PROFILE_ENABLED)` branch becomes the only code path. The `else` branch is deleted.
3. Remove the flag definition from config files and env var declarations.

**Verification:**

```bash
grep -r "AUTH_PROFILE_ENABLED" apps/ packages/ --include="*.ts" -l
# Expected: empty
```

**Build verification:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm test
```

**Commit message:** `chore(cleanup): remove AUTH_PROFILE_ENABLED feature flag — Auth Profile is permanent`

---

## Phase H — Tests

> Comprehensive test coverage for all Phase 3 features.

### Task 37: Unit tests for enterprise auth types

- [ ] Full test suite for all 5 enterprise auth implementations

**Files:**

- Test: `packages/auth-enterprise/src/__tests__/digest-auth.test.ts` (from Task 4)
- Test: `packages/auth-enterprise/src/__tests__/kerberos-auth.test.ts` (from Task 5)
- Test: `packages/auth-enterprise/src/__tests__/saml-auth.test.ts` (from Task 6)
- Test: `packages/auth-enterprise/src/__tests__/hawk-auth.test.ts` (from Task 7)
- Test: `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts` (from Task 8)

Each test file should cover:

- Happy path with valid config + secrets
- Error handling for missing required fields
- Library loading failure (module not available — mock `import()` to reject)
- Invalid algorithm / mode combinations
- **Kerberos-specific:** Temp keytab file cleanup on error, `KRB5_KTNAME` env var restoration
- **SAML-specific:** Invalid/expired certificates, assertion generation failure
- **WS-Security-specific:** Missing username/password for UsernameToken mode, missing key/cert for X509 mode
- **Digest-specific:** 401 challenge handling, realm mismatch

**Run all enterprise tests:**

```bash
cd /Users/prasannaarikala/projects/agent-platform/packages/auth-enterprise && pnpm vitest run
```

**Commit message:** `test(auth-enterprise): comprehensive unit tests for all 5 enterprise auth types`

---

### Task 38: Multi-agent propagation tests

- [ ] Integration tests for handoff, delegate, and fan-out credential propagation

**Files:**

- Test: `apps/runtime/src/__tests__/auth-profile-propagation.test.ts`

```typescript
// apps/runtime/src/__tests__/auth-profile-propagation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { validateHandoffAuthRequirements } from '../services/execution/auth-profile-handoff.js';
import { buildDelegateAuthContext } from '../services/execution/auth-profile-delegate.js';
import { buildFanOutAuthContexts } from '../services/execution/auth-profile-fanout.js';

describe('Multi-agent credential propagation', () => {
  describe('handoff', () => {
    it('blocks handoff when user lacks required per_user auth', async () => {
      const result = await validateHandoffAuthRequirements({
        targetAgent: {
          authRequirements: [
            { connector: 'gmail', connectionMode: 'per_user' },
            { connector: 'slack', connectionMode: 'per_user' },
          ],
        },
        userTokens: [{ connector: 'gmail', authType: 'oauth2_token', userId: 'u1' }],
        tenantId: 't1',
        projectId: 'p1',
      });
      expect(result.satisfied).toBe(false);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].connector).toBe('slack');
    });

    it('allows handoff when all shared auth is project-level', async () => {
      const result = await validateHandoffAuthRequirements({
        targetAgent: {
          authRequirements: [{ connector: 'openai', connectionMode: 'shared' }],
        },
        userTokens: [],
        tenantId: 't1',
        projectId: 'p1',
      });
      expect(result.satisfied).toBe(true);
    });
  });

  describe('delegate', () => {
    it('preserves delegating user identity for personal token resolution', () => {
      const ctx = buildDelegateAuthContext({
        delegatingUserId: 'user-abc',
        delegatingSessionId: 'sess-123',
        tenantId: 't1',
        projectId: 'p1',
      });
      expect(ctx.userId).toBe('user-abc');
    });
  });

  describe('fan-out', () => {
    it('each branch has independent credential cache', () => {
      const contexts = buildFanOutAuthContexts({
        branches: ['a', 'b'],
        originatingUserId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });
      expect(contexts[0].credentialCache).not.toBe(contexts[1].credentialCache);
    });
  });
});
```

**Commit message:** `test(runtime): add multi-agent credential propagation integration tests`

---

### Task 39: Import/export mapping tests

- [ ] Tests for auth profile export, import preview, and mapping

**Files:**

- Test: `packages/project-io/src/__tests__/auth-profile-mapping.test.ts` (expanded from Task 23)

Cover:

- Export includes `required_auth_profiles` with correct shape
- DSL `auth:` reference scanning
- Import preview extracts requirements
- Import apply remaps profile references
- Cross-tenant strips all `authProfileId` values
- Post-import doctor reports missing profiles

**Commit message:** `test(project-io): comprehensive import/export auth mapping tests`

---

### Task 40: Rotation batch job tests

- [ ] Full test suite for rotation job including edge cases

**Files:**

- Test: `apps/runtime/src/__tests__/auth-profile-rotation.test.ts` (expanded from Task 29)

Cover:

- Batch processing with configurable batch size
- Lock acquisition and release
- Grace period storage in `previousEncryptedSecrets`
- Decryption failure handling (skip and log)
- Empty batch (no profiles need rotation)
- Concurrent rotation prevention via distributed lock

**Commit message:** `test(runtime): comprehensive auth profile rotation job tests`

---

### Task 41: Cleanup verification tests

- [ ] Tests that verify cleanup completeness

**Files:**

- Test: `packages/database/src/__tests__/auth-profile/cleanup-verification.test.ts`

```typescript
// packages/database/src/__tests__/auth-profile/cleanup-verification.test.ts
import { describe, it, expect } from 'vitest';
import * as mongoose from 'mongoose';

describe('Phase 3 cleanup verification', () => {
  it('LLMCredential model is not registered', () => {
    expect(mongoose.models.LLMCredential).toBeUndefined();
  });

  it('EndUserOAuthToken model is not registered', () => {
    expect(mongoose.models.EndUserOAuthToken).toBeUndefined();
  });

  it('ToolSecret model is not registered', () => {
    expect(mongoose.models.ToolSecret).toBeUndefined();
  });

  it('ConnectorConnection has no encryptedCredentials field', () => {
    const ConnectorConnection = mongoose.models.ConnectorConnection;
    if (ConnectorConnection) {
      expect(ConnectorConnection.schema.path('encryptedCredentials')).toBeUndefined();
    }
  });

  it('MCPServerConfig has no encryptedAuthConfig field', () => {
    const MCPServerConfig = mongoose.models.MCPServerConfig;
    if (MCPServerConfig) {
      expect(MCPServerConfig.schema.path('encryptedAuthConfig')).toBeUndefined();
    }
  });

  it('AuthProfile has all 17 auth types in enum', () => {
    const AuthProfile = mongoose.models.AuthProfile;
    if (AuthProfile) {
      const pathType = AuthProfile.schema.path('authType') as any;
      expect(pathType.enumValues).toHaveLength(17);
      expect(pathType.enumValues).toContain('digest');
      expect(pathType.enumValues).toContain('kerberos');
      expect(pathType.enumValues).toContain('saml');
      expect(pathType.enumValues).toContain('hawk');
      expect(pathType.enumValues).toContain('ws_security');
    }
  });

  it('AuthProfile has certificatePinning and jwtWrapping addon fields', () => {
    const AuthProfile = mongoose.models.AuthProfile;
    if (AuthProfile) {
      expect(AuthProfile.schema.path('certificatePinning')).toBeDefined();
      expect(AuthProfile.schema.path('jwtWrapping')).toBeDefined();
    }
  });
});
```

**Commit message:** `test(database): add Phase 3 cleanup verification tests`

---

## Cleanup Timeline Summary

| Week | Action                                          | Rollback                | Bake   |
| ---- | ----------------------------------------------- | ----------------------- | ------ |
| 0    | **Go/No-Go gate** — verify all prerequisites    | N/A                     | N/A    |
| 1    | Remove dual-read code paths (Task 32)           | `git revert`            | 7 days |
| 2    | `$unset` legacy fields from 14 models (Task 33) | MongoDB restore         | 7 days |
| 3    | Drop 3 legacy collections (Task 34)             | MongoDB restore         | 7 days |
| 4    | Remove obsolete env vars (Task 35)              | `git revert` + redeploy | 7 days |
| 5    | Remove feature flag (Task 36)                   | `git revert`            | 7 days |

**Total cleanup duration:** 5 weeks minimum (35 days of bake time).

**After Week 5:** Auth Profile is the single, universal credential system. No legacy credential paths remain.

---

## Review Log

### Iteration 1

- **Issues found:** 12
- **Fixed:**
  1. Task 10 Dockerfile kerberos bindings: production stage uses distroless (no apt-get) — rewrote to copy shared libs from builder stage
  2. Task 11 Dockerfile COPY list: was missing `apps/multimodal-service/Dockerfile`, incorrectly included `apps/workflow-engine/Dockerfile` (uses bulk COPY) — corrected file list with context
  3. Task 9 `applyDigestAuth()` call: arguments were swapped (secrets, config) — corrected to (config, secrets)
  4. Task 33 `$unset` for `tenant_models.connections[].credentialId`: `$[]` positional all operator doesn't work with `$unset` via `updateMany({})` — added `arrayFilters` handling
  5. Added note that key files (`auth-profile.model.ts`, `auth-profile.schema.ts`, `apply-auth.ts`) don't exist yet — created by Phase 1/2
  6. Task 21: `ProjectManifestV2.metadata` type doesn't include `required_auth_profiles` — added type extension step with exact field shape
  7. Added Phase 2 dependency context to prerequisites section
  8. Verified all 17 deliverables from Phase 3 design doc Section 11 are covered by the 41 tasks
- **Remaining:** Need deeper technical accuracy checks on code snippets against codebase patterns (iteration 3-4).

### Iteration 2

- **Issues found:** 6
- **Fixed:**
  1. Task Summary table: Task 30 marked as merged into Task 29 (was listed as separate task)
  2. Tasks 18-20 file paths: All three referenced `flow-step-executor.ts` — corrected to `routing-executor.ts` where `handleHandoff()` (L257), `handleDelegate()` (L1932), and `handleFanOut()` (L2507) actually live
  3. Task 18: Added missing `Create: auth-profile-handoff.ts` file entry
  4. Task 20: Added missing `Create: auth-profile-fanout.ts` file entry
  5. Task 22: Fixed test using non-existent `scanDslReferences()` — replaced with new `extractAuthProfileReferences()` function following existing env-var-scanner patterns
  6. Task 22: Added complete implementation code for `extractAuthProfileReferences()` function
- **Remaining:** Technical accuracy checks on code snippets (iteration 3-4), edge case coverage (iteration 5-6).

### Iteration 3

- **Issues found:** 5
- **Fixed:**
  1. Rotation job file path: `apps/runtime/src/jobs/` doesn't exist — changed to `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts` (follows existing `kms-rotation-job.ts` pattern)
  2. Tech stack header incorrectly said "BullMQ for rotation job" — corrected to "follows existing kms-rotation-job.ts setInterval pattern"
  3. Task 26: Test used non-existent `buildPostImportReport()` — corrected to actual `validatePostImport()` function. Added proper type extensions to `PostImportReport`, `PostImportDbAdapter`, and `PostImportInput`
  4. Verified all 14 collection names in Task 33 `$unset` script match actual Mongoose model definitions
  5. Verified all 3 legacy collection names in Task 34 drop script match actual models
- **Remaining:** Edge cases and security (iteration 5-6), polish (iteration 7).

### Iteration 4

- **Issues found:** 3
- **Fixed:**
  1. Task 9 (`applyAuth` Kerberos/SAML cases): Design doc specifies Redis caching for Kerberos service tickets (8h TTL) and SAML assertions — implementation had no caching, just a comment. Added Redis cache get/set logic with proper TTLs in the dispatcher
  2. Verified voice-service-factory.ts uses in-memory Map cache — confirmed Task 27's Redis-based `VoiceCredentialCache` is a complementary addition, not a replacement
  3. Verified import-applier.ts structure for Tasks 24-25 — `ApplyInput` interface needs extension for `authProfileMapping` (already noted in plan)
- **Remaining:** Security deep-dive (iteration 5-6), polish (iteration 7).

### Iteration 5

- **Issues found:** 5
- **Fixed:**
  1. Task 5 (Kerberos): keytab handling was incorrect — `kerberos` npm reads from filesystem via `KRB5_KTNAME` env var, not inline base64. Added temp file write/cleanup with `mode: 0o600`, `KRB5_KTNAME` env restoration in `finally` block
  2. Task 29 (Rotation job): Lock key `auth-profile:rotation:{profileId}` was different from token refresh lock key `auth-profile:refresh:{tenantId}:{profileId}` — this means a profile could be rotated during a concurrent token refresh. Fixed to share the same lock namespace
  3. Task 29 test: Updated lock key assertion from `auth-profile:rotation:p1` to `auth-profile:refresh:t1:p1`
  4. Task 29 test import path: Still referenced old `../jobs/` path — corrected to `../services/auth-profile/`
  5. Task 37: Expanded test coverage requirements with type-specific edge cases (keytab cleanup, SAML cert errors, WS-Security mode validation)
- **Remaining:** Polish and consistency (iteration 7).

### Iteration 6

- **Issues found:** 3
- **Fixed:**
  1. Task 17: Missing `ssh_key + certificatePinning` invalid combination — added alongside existing `ssh_key + jwtWrapping` block
  2. Task 34: File list was missing `cascade-delete.ts` and `connector-config.model.ts` — added `Modify: packages/database/src/cascade/cascade-delete.ts` and `Modify: packages/database/src/models/connector-config.model.ts`
  3. Verified go/no-go gate prerequisites match Phase 3 design doc Section 11 requirements (all 7 prerequisites present plus migration rollback test)
- **Remaining:** Polish and consistency (iteration 7).

### Iteration 7

- **Issues found:** 2
- **Fixed:**
  1. Task Summary table: Tasks 29 and 30 key files column had extra trailing spaces causing misalignment — normalized column width to match other rows
  2. Task 21 Steps: Duplicate step number (two "3." entries) — renumbered second to "4."
- **Verified (no issues):**
  - Task numbering: sequential 1-41, all present
  - Commit messages: all 35 commit messages follow conventional commits (`feat`, `build`, `refactor`, `chore`, `test` scopes)
  - No TODO/FIXME/PLACEHOLDER/TBD text anywhere in plan
  - No duplicate tasks (Task 30 properly marked as merged into Task 29)
  - Phase 1 cross-references verified: Task 1 (model), Task 4 (schema), Task 24 (resolver), Task 27 (apply-auth), Task 38 (errors)
  - Phase 2 dependencies clearly stated in Prerequisites section
  - TDD convention section consistent with Phase 1 plan format
  - All 8 phases (A-H) have section headers with description blockquotes
  - Cleanup Timeline Summary table matches actual task content

**Total across 7 iterations: 36 issues found and fixed.**
