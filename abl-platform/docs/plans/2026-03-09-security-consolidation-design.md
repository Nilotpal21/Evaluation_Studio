# Security Consolidation Design

**Date:** 2026-03-09
**Status:** Approved
**Scope:** Two-part refactor — channel security utils → shared-kernel, duplicate security-repo → consolidated in shared

---

## Problem

Two independent security-related duplication issues:

1. **Channel security utilities** (`inbound-auth.ts`, `webhook-signature.ts`) live in `apps/runtime/src/channels/security/`, but they are pure crypto helpers with no runtime-specific dependencies. Any app needing inbound channel authentication or webhook signing must copy or import from runtime internals.

2. **Security repository** is duplicated. `packages/shared/src/repos/security-repo.ts` is well-typed with proper normalization. `apps/runtime/src/repos/security-repo.ts` was added during ABLP-2 work and duplicates ToolSecrets, OrgProxyConfigs, and EndUserOAuthTokens with `any` types throughout, plus adds EnvironmentVariable operations that the shared version lacks.

---

## Part 1: Channel Security Utils → shared-kernel

### Decision

**Option B**: Move code to `packages/shared-kernel/src/security/`, delete originals, update all import sites.

### What moves

| File                                                      | Destination                                                |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/runtime/src/channels/security/inbound-auth.ts`      | `packages/shared-kernel/src/security/inbound-auth.ts`      |
| `apps/runtime/src/channels/security/webhook-signature.ts` | `packages/shared-kernel/src/security/webhook-signature.ts` |

### What stays

`apps/runtime/src/channels/security/callback-url-policy.ts` — depends on `createLogger` from `@abl/compiler/platform`. Moving it would add an unwanted dep to shared-kernel. It also overlaps functionally with the existing `ssrf-validator.ts`. Leave in place.

### Import sites to update (6 files)

| File                                                      | Change                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/channel-genesys.ts`              | `../channels/security/inbound-auth.js` → `@agent-platform/shared-kernel/security`       |
| `apps/runtime/src/routes/channel-audiocodes.ts`           | same                                                                                    |
| `apps/runtime/src/routes/channel-vxml.ts`                 | same                                                                                    |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts` | `../../../channels/security/inbound-auth.js` → `@agent-platform/shared-kernel/security` |
| `apps/runtime/src/routes/http-async-channel.ts`           | `../channels/security/webhook-signature.js` → `@agent-platform/shared-kernel/security`  |
| `apps/runtime/src/__tests__/inbound-auth.test.ts`         | update import, move test to `packages/shared-kernel/src/security/__tests__/`            |

### shared-kernel/security/index.ts additions

```ts
export { extractIngressToken, tokensMatch } from './inbound-auth.js';
export {
  generateWebhookSecret,
  computeWebhookSignature,
  buildSignatureHeaders,
} from './webhook-signature.js';
```

---

## Part 2: Security-Repo Consolidation

### Decision

**Option A**: Extend `packages/shared/src/repos/security-repo.ts` with EnvironmentVariable operations (with proper types), then replace `apps/runtime/src/repos/security-repo.ts` with a re-export barrel pointing to the shared version.

### EnvironmentVariable types to add to shared-kernel

Add `NormalizedEnvironmentVariable` to `packages/shared-kernel/src/types/security.ts`:

```ts
export interface NormalizedEnvironmentVariable {
  id: string;
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

### EnvironmentVariable operations to add to shared security-repo

Typed signatures matching the runtime version's behavior:

- `createEnvironmentVariable(data): Promise<NormalizedEnvironmentVariable>`
- `findEnvironmentVariables(filter, opts?): Promise<NormalizedEnvironmentVariable[]>`
- `countEnvironmentVariables(filter): Promise<number>`
- `findEnvironmentVariableById(id, tenantId): Promise<NormalizedEnvironmentVariable | null>`
- `findEnvironmentVariableByKey(tenantId, projectId, environment, key): Promise<NormalizedEnvironmentVariable | null>`
- `updateEnvironmentVariable(id, tenantId, data): Promise<NormalizedEnvironmentVariable | null>`
- `deleteEnvironmentVariable(id, tenantId): Promise<void>`
- `bulkUpsertEnvironmentVariables(...)` — preserve the encryption-safe batch pattern from the runtime version

### Runtime replacement

Replace `apps/runtime/src/repos/security-repo.ts` with a re-export barrel:

```ts
/**
 * @deprecated Import from @agent-platform/shared directly.
 * This file re-exports the canonical security repository from the shared package.
 */
export * from '@agent-platform/shared/repos/security-repo';
```

All existing import sites in runtime (`routes/environment-variables.ts`, `routes/deployments.ts`, tests) continue to work unchanged.

---

## Testing

- Move `apps/runtime/src/__tests__/inbound-auth.test.ts` → `packages/shared-kernel/src/security/__tests__/inbound-auth.test.ts` (update import path)
- Add EnvironmentVariable tests to `packages/shared/src/__tests__/security-repo.test.ts`
- Runtime's `repos-data.test.ts` mocks continue to work via re-export

---

## Verification

```bash
pnpm build        # compiles shared-kernel, shared, runtime
pnpm test         # all runtime + shared-kernel tests pass
```

No runtime behaviour changes — this is purely structural consolidation.
