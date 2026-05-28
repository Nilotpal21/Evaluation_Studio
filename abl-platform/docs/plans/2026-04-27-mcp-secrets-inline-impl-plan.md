# LLD: MCP Tool Secrets — Fully Inline DEK Envelope Baking

**Status**: IN PROGRESS
**Date**: 2026-04-27
**JIRA**: ABLP-155

---

**Audit Log**: Round 1 (architecture compliance) — CRITICAL fixed (5 call sites, not 3). HIGH fixed (RawMCPServerConfig fields, error sanitization, compileProjectTool signature gap). Round 2 (pattern consistency) — HIGH fixed (compileProjectTool signature, auth_config guard symmetry). MEDIUM fixed (type file placement, magic number defaults). Round 3 (completeness) — MEDIUM fixed (null-coalescing for timeout fields in dsl-property-parser.ts). Round 4 (cross-phase, phase-auditor) — APPROVED. HIGH fixed (import updates explicit in task 2.1/2.3, D-8 behavior-change documented). MEDIUM fixed (test placement note, Phase 4 debug cleanup, DI wording). Round 5 (final sweep) — APPROVED. MEDIUM fixed (JIRA subtask tracking for Phase 4 cleanup). **LLD AUDIT COMPLETE — READY FOR IMPLEMENTATION.**

---

## 1. Design Decisions

### Problem Statement

MCP tools bake `encryptedEnv` and `encryptedAuthConfig` from the DB into the IR at compile time.
Mongoose `post('find')` hooks auto-decrypt those fields **before** the compiler reads them, so the IR ends up carrying plaintext JSON in fields named `encrypted_env` / `encrypted_auth_config`. The runtime then:

- **`encrypted_auth_config`**: hits a workaround path (`isPlainJSON` branch) that works by accident.
- **`encrypted_env`**: has no workaround and throws `"env decryption failed"` for any MCP server that has env vars configured.

The design intent (documented in IR schema comments at `schema.ts:1141`) is that these fields carry **DEK-envelope ciphertext** and are decrypted at execution time using `decryptForTenantAuto` (async, handles cold DEK cache).

### Decision Log

| #   | Decision                                                                                                                         | Rationale                                                                                                                                                                                                                                                  | Alternatives Rejected                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Bypass Mongoose hooks via `MCPServerConfig.collection.find()` (native driver)                                                    | Zero blast radius. Established test-time pattern (see `kms-e2e-full-chain.test.ts:443`). Explicit and self-documenting. tenantId+projectId isolation is manually enforced in the query filter.                                                             | (a) `skipDecrypt` plugin option — global blast radius. (b) `.select('-tenantId')` — fragile coupling to plugin internals.                  |
| D-2 | Add `mcpServerConfigRawLoader` to `ResolveToolImplDeps`; update **all 5** call sites                                             | All 5 call sites are internal. Makes raw-vs-decrypted intent explicit in the type. The raw loader is the only correct loader for IR baking.                                                                                                                | Renaming `mcpServerConfigLoader` in-place — could break any callers that legitimately need decrypted configs (Studio registry, discovery). |
| D-3 | Add `McpServerConfigForIR` base type shared by `RawMCPServerConfig` and `NormalizedMCPServerConfig` for the `mcpConfigMap` union | Prevents field-drift between raw and normalized paths. `NormalizedMCPServerConfig` (20+ consumers) unchanged. `RawMCPServerConfig` only consumed by IR-baking path.                                                                                        | Modifying `NormalizedMCPServerConfig` — too wide.                                                                                          |
| D-4 | Remove the plain-JSON fallback after transitional window (Phase 4)                                                               | Post-fix, the fallback accepts unencrypted secrets in IR — a security regression. Mark `TODO(mcp-secrets): remove after 2026-05-12`.                                                                                                                       | Keeping it permanently — masks future mis-baking bugs.                                                                                     |
| D-5 | Apply `isDEKFormat \| isPlainJSON` transitional detection to `encrypted_env` (parallel to auth config)                           | IRs compiled before the fix persist for up to 24h in Redis. Must not break running sessions.                                                                                                                                                               | Cache bust — too disruptive for active sessions.                                                                                           |
| D-6 | Warn at `InlineMcpClientProvider` construction if encrypted fields present but no decryptor                                      | Fail fast at the right granularity — only block the specific server that needs secrets.                                                                                                                                                                    | `decryptorRequired: boolean` flag — unnecessary API surface.                                                                               |
| D-8 | Phase 3 changes `!decryptor` + encrypted_env from "silently skip" to "throw if DEK format"                                       | **Intentional security improvement**: fail-closed rather than injecting an MCP process with zero env vars (which would cause silent tool failures). The old behavior masked misconfiguration. The new behavior surfaces it immediately at tool invocation. | Keeping silent-skip — masks configuration errors, harder to diagnose.                                                                      |
| D-7 | Tenant ID must NOT appear in user-facing error messages                                                                          | Per CLAUDE.md "User-Facing Runtime Error Sanitization": tenant IDs belong in server logs only.                                                                                                                                                             | Existing pattern in `inline-mcp-provider.ts:128` — it is wrong and must be corrected.                                                      |

### Key Interfaces & Types

```typescript
// packages/shared/src/types/mcp-server.ts (NEW — alongside NormalizedMCPServerConfig)
// Re-exported from packages/shared/src/repos/index.ts for backward compat.

/**
 * Minimal shape required by buildMcpBindingFromProps for IR baking.
 * Both RawMCPServerConfig and NormalizedMCPServerConfig satisfy this.
 */
export interface McpServerConfigForIR {
  name: string;
  transport: string;
  url: string | null | undefined;
  /** May be DEK-envelope ciphertext (raw loader) or null */
  encryptedEnv: string | null | undefined;
  /** May be DEK-envelope ciphertext (raw loader) or null */
  encryptedAuthConfig: string | null | undefined;
  authType: string | null | undefined;
  /** JSON string of headers object, or null */
  headers: string | null | undefined;
  connectionTimeoutMs: number | null | undefined;
  requestTimeoutMs: number | null | undefined;
}

/**
 * Raw MCP server config — encrypted fields carry DEK-envelope ciphertext,
 * NOT decrypted plaintext. Use ONLY for IR baking at compile time.
 */
export interface RawMCPServerConfig extends McpServerConfigForIR {
  id: string;
  tenantId: string;
  projectId: string;
  /** DEK-envelope ciphertext — decrypted at runtime by InlineMcpClientProvider */
  encryptedEnv: string | null;
  /** DEK-envelope ciphertext — decrypted at runtime by InlineMcpClientProvider */
  encryptedAuthConfig: string | null;
  headers: string | null;
  authType: string | null;
  authProfileId: string | null;
}

// packages/shared/src/tools/resolve-tool-implementations.ts (MODIFIED)
interface ResolveToolImplDeps {
  // ... existing fields ...
  /** Decrypted configs — for Studio display, registry, tool preview. NOT for IR baking. */
  mcpServerConfigLoader?: (
    tenantId: string,
    projectId: string,
  ) => Promise<NormalizedMCPServerConfig[]>;
  /**
   * Raw loader for IR baking — returns DEK-envelope ciphertext in encrypted fields.
   * MUST be used instead of mcpServerConfigLoader for all compile-time IR generation.
   * Uses native MongoDB driver to bypass Mongoose post-find decryption hooks.
   */
  mcpServerConfigRawLoader?: (tenantId: string, projectId: string) => Promise<RawMCPServerConfig[]>;
}
```

### Module Boundaries

| Module                                                    | Responsibility                                                                                                          | Depends On                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/database` (MCPServerConfig model)               | Schema + encryption plugin registration — unchanged                                                                     | Mongoose, encryption plugin                            |
| `packages/shared/repos/mcp-server-config-repo`            | NEW: `findMcpServerConfigsRaw()` — native driver query returning ciphertext                                             | MongoDB native driver via `MCPServerConfig.collection` |
| `packages/shared/tools/resolve-tool-implementations`      | Wire `mcpServerConfigRawLoader`; build `mcpConfigMap` from raw configs when available                                   | `RawMCPServerConfig`, `McpServerConfigForIR`           |
| `packages/shared/tools/dsl-property-parser`               | `buildMcpBindingFromProps` — type annotation updated to `McpServerConfigForIR`; no logic change                         | `McpServerConfigForIR`                                 |
| `apps/runtime/services/mcp/inline-mcp-provider`           | Fix `encrypted_env` path; add transitional detection for both fields; add construction warning; sanitize error messages | `isDEKEnvelopeFormat`, `decryptForTenantAuto`          |
| `apps/runtime/services/version-service`                   | Inject `findMcpServerConfigsRaw` as `mcpServerConfigRawLoader`                                                          | `packages/shared/repos`                                |
| `apps/runtime/services/execution/types.ts`                | Inject raw loader (2nd runtime call site)                                                                               | `packages/shared/repos`                                |
| `apps/studio/lib/abl/project-aware-compile`               | Inject raw loader (1st Studio call site)                                                                                | `packages/shared/repos`                                |
| `apps/studio/src/app/api/abl/compile/route.ts`            | Inject raw loader (2nd Studio call site)                                                                                | `packages/shared/repos`                                |
| `apps/studio/src/app/api/projects/[id]/topology/route.ts` | Inject raw loader (3rd Studio call site)                                                                                | `packages/shared/repos`                                |

---

## 2. File-Level Change Map

### New Files

None. All changes to existing files.

### Modified Files

| File                                                        | Change Description                                                                                                                                                      | Risk   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/shared/src/types/mcp-server.ts`                   | Add `McpServerConfigForIR`, `RawMCPServerConfig` types (alongside `NormalizedMCPServerConfig`)                                                                          | Low    |
| `packages/shared/src/repos/mcp-server-config-repo.ts`       | Re-export types from `../types/mcp-server`; add `findMcpServerConfigsRaw()`                                                                                             | Low    |
| `packages/shared/src/repos/index.ts`                        | Export new types + function                                                                                                                                             | Low    |
| `packages/shared/src/tools/resolve-tool-implementations.ts` | Add `mcpServerConfigRawLoader` to `ResolveToolImplDeps`; use raw loader when building `mcpConfigMap`; update `mcpConfigMap` type to `Map<string, McpServerConfigForIR>` | Medium |
| `packages/shared/src/tools/dsl-property-parser.ts`          | Update `mcpConfigMap` type annotation to `Map<string, McpServerConfigForIR>`                                                                                            | Low    |
| `apps/runtime/src/services/mcp/inline-mcp-provider.ts`      | Fix `encrypted_env` path; add transitional plain-JSON detection for both fields; add construction warning; remove tenantId from error message                           | Medium |
| `apps/runtime/src/services/version-service.ts`              | Inject `findMcpServerConfigsRaw` as `mcpServerConfigRawLoader`                                                                                                          | Low    |
| `apps/runtime/src/services/execution/types.ts`              | Inject `findMcpServerConfigsRaw` as `mcpServerConfigRawLoader`                                                                                                          | Low    |
| `apps/studio/src/lib/abl/project-aware-compile.ts`          | Inject raw loader                                                                                                                                                       | Low    |
| `apps/studio/src/app/api/abl/compile/route.ts`              | Inject raw loader                                                                                                                                                       | Low    |
| `apps/studio/src/app/api/projects/[id]/topology/route.ts`   | Inject raw loader                                                                                                                                                       | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Raw Repo Function + Types

**Goal**: Add `findMcpServerConfigsRaw()` that returns raw DEK-envelope ciphertext from MongoDB without Mongoose decryption, plus the `McpServerConfigForIR` and `RawMCPServerConfig` types.

**Tasks**:

1.1. In `packages/shared/src/types/mcp-server.ts`, add the `McpServerConfigForIR` interface alongside `NormalizedMCPServerConfig` (this matches the existing pattern where types live in `types/` and repos import from `../types/`):

```typescript
/**
 * Minimal shape required by buildMcpBindingFromProps for IR baking.
 * Satisfied by both RawMCPServerConfig (native driver, ciphertext) and
 * NormalizedMCPServerConfig (Mongoose, decrypted — legacy path only).
 */
export interface McpServerConfigForIR {
  name: string;
  transport: string;
  url: string | null | undefined;
  encryptedEnv: string | null | undefined;
  encryptedAuthConfig: string | null | undefined;
  authType: string | null | undefined;
  headers: string | null | undefined;
  connectionTimeoutMs: number | null | undefined;
  requestTimeoutMs: number | null | undefined;
}
```

1.1b. Also export `McpServerConfigForIR` from `packages/shared/src/repos/mcp-server-config-repo.ts` (re-export from `../types/mcp-server`) so callers that import from the repos barrel still work.

1.2. Add `RawMCPServerConfig` interface in `packages/shared/src/types/mcp-server.ts`:

```typescript
/**
 * Raw MCP server config — encrypted fields carry DEK-envelope ciphertext,
 * NOT decrypted plaintext. Use ONLY for IR baking at compile time.
 * Do NOT expose via API responses or Studio UI.
 */
export interface RawMCPServerConfig extends McpServerConfigForIR {
  id: string;
  tenantId: string;
  projectId: string;
  encryptedEnv: string | null;
  encryptedAuthConfig: string | null;
  headers: string | null;
  authType: string | null;
  authProfileId: string | null;
}
```

1.3. Add `findMcpServerConfigsRaw()` function:

```typescript
/**
 * Fetch MCP server configs using the native MongoDB driver, bypassing Mongoose
 * post-find decryption hooks. Returns raw DEK-envelope ciphertext in encryptedEnv
 * and encryptedAuthConfig — suitable for baking into the IR.
 *
 * IMPORTANT: Do NOT use this function for Studio UI, API responses, or tool discovery.
 * Use findMcpServerConfigsByProject() for those cases (returns decrypted values).
 */
export async function findMcpServerConfigsRaw(
  tenantId: string,
  projectId: string,
): Promise<RawMCPServerConfig[]> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  // Native driver bypasses ALL Mongoose plugins (post-find decrypt, tenant isolation plugin).
  // Tenant+project isolation is enforced explicitly in the filter below.
  const docs = await MCPServerConfig.collection
    .find({ tenantId, projectId })
    .sort({ priority: -1 })
    .toArray();
  return docs.map((d) => ({
    id: String(d._id),
    name: d.name as string,
    transport: (d.transport ?? 'http') as string,
    url: (d.url ?? null) as string | null,
    encryptedEnv: (d.encryptedEnv ?? null) as string | null,
    encryptedAuthConfig: (d.encryptedAuthConfig ?? null) as string | null,
    authType: (d.authType ?? null) as string | null,
    authProfileId: (d.authProfileId ?? null) as string | null,
    headers: (d.headers ?? null) as string | null,
    // Schema defaults (30000) are applied at write time so stored docs always have these values.
    // Cast is safe — schema type is number, not nullable.
    connectionTimeoutMs: d.connectionTimeoutMs as number,
    requestTimeoutMs: d.requestTimeoutMs as number,
    tenantId: d.tenantId as string,
    projectId: d.projectId as string,
  }));
}
```

1.4. Export `McpServerConfigForIR`, `RawMCPServerConfig`, and `findMcpServerConfigsRaw` from `packages/shared/src/repos/index.ts`.

1.5. Run `pnpm build --filter=@agent-platform/shared` — must exit 0.

**Files Touched**:

- `packages/shared/src/types/mcp-server.ts`
- `packages/shared/src/repos/mcp-server-config-repo.ts`
- `packages/shared/src/repos/index.ts`

**Exit Criteria**:

- [ ] `McpServerConfigForIR`, `RawMCPServerConfig`, `findMcpServerConfigsRaw` exported from `@agent-platform/shared/repos`
- [ ] `pnpm build --filter=@agent-platform/shared` exits 0
- [ ] Manual spot-check against dev DB: `findMcpServerConfigsRaw('tenant-dev-001', '<projectId>')` returns objects where `encryptedEnv`/`encryptedAuthConfig` are base64 DEK-envelope strings when set (verify with `isDEKEnvelopeFormat(result[0].encryptedEnv) === true`)

**Test Strategy**:

- Integration test in `packages/database/src/__tests__/mcp-server-config-raw.test.ts` (placed in `packages/database` intentionally — it exercises the real Mongoose encryption plugin + native driver bypass, which requires the database test infrastructure):
  1. Start real MongoDB (reuse existing test setup from `kms-e2e-full-chain.test.ts`)
  2. Create an `MCPServerConfig` with `encryptedEnv = JSON.stringify({ API_KEY: 'test' })` (will be encrypted by pre-save hook)
  3. Call `findMcpServerConfigsRaw(tenantId, projectId)`
  4. Assert `isDEKEnvelopeFormat(result[0].encryptedEnv) === true`
  5. Assert `result[0].encryptedEnv` does NOT start with `{` (not plain JSON)
  6. Assert `findMcpServerConfigsByProject` returns the same record with plaintext (`result[0].encryptedEnv` starts with `{`)
  - No mocks. Real encryption plugin. Real MongoDB.

**Rollback**: Revert repo file additions. No schema/DB changes.

---

### Phase 2: Wire Raw Loader into All 5 IR Baking Call Sites

**Goal**: Replace `mcpServerConfigLoader` injections with `mcpServerConfigRawLoader` at all 5 compilation call sites, so the `mcpConfigMap` always carries raw ciphertext for IR baking.

**Tasks**:

2.1. In `packages/shared/src/tools/resolve-tool-implementations.ts`:

- Update the import at line 20 to include `McpServerConfigForIR` and `RawMCPServerConfig`:
  ```typescript
  import type {
    NormalizedMCPServerConfig,
    McpServerConfigForIR,
    RawMCPServerConfig,
  } from '../types/mcp-server.js';
  ```
- Locate `ResolveToolImplDeps` interface and add:

```typescript
/**
 * Raw loader for IR baking — returns DEK-envelope ciphertext in encrypted fields.
 * MUST be used for all compile-time IR generation.
 * Injected by version-service.ts, execution/types.ts, project-aware-compile.ts,
 * apps/studio/src/app/api/abl/compile/route.ts, and topology/route.ts.
 */
mcpServerConfigRawLoader?: (tenantId: string, projectId: string) => Promise<RawMCPServerConfig[]>;
```

2.2. In the same file, update the `mcpConfigMap` building block AND the `compileProjectTool()` function signature (line ~470) to use `McpServerConfigForIR` as the map value type:

- Update local variable: `let mcpConfigMap = new Map<string, McpServerConfigForIR>()`
- Update `compileProjectTool()` parameter type: `mcpConfigMap: Map<string, McpServerConfigForIR>`
- Prefer `mcpServerConfigRawLoader` over `mcpServerConfigLoader`

```typescript
let mcpConfigMap = new Map<string, McpServerConfigForIR>();
if (deps.mcpServerConfigRawLoader || deps.mcpServerConfigLoader) {
  const hasMcp = toolsToCompile.some((t) => t.toolType === 'mcp');
  if (hasMcp) {
    const configs = deps.mcpServerConfigRawLoader
      ? await deps.mcpServerConfigRawLoader(tenantId, projectId)
      : await deps.mcpServerConfigLoader!(tenantId, projectId);
    mcpConfigMap = new Map(configs.map((c) => [c.name, c]));
  }
}
```

2.3. In `packages/shared/src/tools/dsl-property-parser.ts`:

- Update the import to use `McpServerConfigForIR` instead of `NormalizedMCPServerConfig` for the `mcpConfigMap` type annotation.
- Update the `mcpConfigMap` option type from `Map<string, NormalizedMCPServerConfig>` to `Map<string, McpServerConfigForIR>`. All 9 field accesses in `buildMcpBindingFromProps` are present on `McpServerConfigForIR`. Additionally, update lines 507-508 to coalesce `null` to `undefined` since `McpServerConfigForIR` allows `null | undefined` but `McpBindingIRLocal.server_config.connection_timeout_ms` only allows `number | undefined`:

```typescript
// Before:
connection_timeout_ms: serverConfig.connectionTimeoutMs,
request_timeout_ms: serverConfig.requestTimeoutMs,
// After:
connection_timeout_ms: serverConfig.connectionTimeoutMs ?? undefined,
request_timeout_ms: serverConfig.requestTimeoutMs ?? undefined,
```

2.4. Verify the 5 call sites via `grep -rn "mcpServerConfigLoader" .` and update each:

**Call site 1** — `apps/runtime/src/services/version-service.ts` (~line 285):

```typescript
mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
```

**Call site 2** — `apps/runtime/src/services/execution/types.ts` (~line 1504):

```typescript
mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
```

**Call site 3** — `apps/studio/src/lib/abl/project-aware-compile.ts` (~line 181):

```typescript
mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
```

**Call site 4** — `apps/studio/src/app/api/abl/compile/route.ts` (~line 141):

```typescript
mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
```

**Call site 5** — `apps/studio/src/app/api/projects/[id]/topology/route.ts` (~line 146):

```typescript
mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
```

For each call site: add the import `import { findMcpServerConfigsRaw } from '@agent-platform/shared/repos'` if not already present.

2.5. Run `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/runtime --filter=@agent-platform/studio` — must exit 0.

**Files Touched**:

- `packages/shared/src/tools/resolve-tool-implementations.ts`
- `packages/shared/src/tools/dsl-property-parser.ts`
- `apps/runtime/src/services/version-service.ts`
- `apps/runtime/src/services/execution/types.ts`
- `apps/studio/src/lib/abl/project-aware-compile.ts`
- `apps/studio/src/app/api/abl/compile/route.ts`
- `apps/studio/src/app/api/projects/[id]/topology/route.ts`

**Exit Criteria**:

- [ ] `mcpServerConfigRawLoader` in `ResolveToolImplDeps`
- [ ] All 5 call sites inject `findMcpServerConfigsRaw` (verify with `grep -rn "mcpServerConfigRawLoader"`)
- [ ] No remaining `mcpServerConfigLoader` injections in compilation paths (grep should find 0 results for `mcpServerConfigLoader:` in the 5 call-site files)
- [ ] `pnpm build` (runtime + studio + shared) exits 0
- [ ] After recompiling an agent with an MCP tool in Studio, the compiled IR's `mcp_binding.server_config.encrypted_env` and `encrypted_auth_config` are base64 DEK-envelope strings (verify via runtime debug log `isDEKEnvelopeFormat=true`)

**Test Strategy**:

- Integration test: call `resolveToolImplementations` with a test implementation of `mcpServerConfigRawLoader` injected via the `deps` parameter (DI, not `vi.mock`) returning `RawMCPServerConfig` objects with known fake DEK-envelope strings. Assert the resulting IR `mcp_binding.server_config.encrypted_env` equals the raw ciphertext string (not decrypted).
- Negative: assert that when only `mcpServerConfigLoader` is provided (backward compat), the pipeline still works.

**Rollback**: Revert DI interface change and all 5 call-site injections atomically. The old `mcpServerConfigLoader` path is preserved.

---

### Phase 3: Fix Runtime `encrypted_env` Path + Error Sanitization + Construction Warning

**Goal**: Make `inline-mcp-provider.ts` correctly handle DEK-envelope ciphertext for `encrypted_env` (new IRs), transitionally handle plain JSON (24h cache window), sanitize error messages, and warn at construction when decryptor is missing.

**Tasks**:

3.1. In `apps/runtime/src/services/mcp/inline-mcp-provider.ts`, replace the `encrypted_env` block (lines 100-132) with:

```typescript
if (config.encrypted_env) {
  const rawEnv = config.encrypted_env;
  const isDEKFormat = isDEKEnvelopeFormat(rawEnv);
  const isPlainJSON = rawEnv.trimStart().startsWith('{');
  log.debug('MCP env decryption attempt', {
    server: config.name,
    valueLength: rawEnv.length,
    isDEKEnvelopeFormat: isDEKFormat,
    looksLikePlainJSON: isPlainJSON,
  });
  try {
    let decryptedEnv: string;
    if (isDEKFormat && this.decryptor) {
      decryptedEnv = await this.decryptor.decryptForTenant(rawEnv, this.tenantId);
    } else if (isDEKFormat && !this.decryptor) {
      throw new Error(
        `MCP server "${config.name}" has encrypted env but no decryptor is available`,
      );
    } else if (isPlainJSON) {
      // TODO(mcp-secrets): Remove after 2026-05-12. Transitional backward compat for IRs
      // compiled before the raw-loader fix. New IRs always carry DEK-envelope ciphertext.
      log.warn('MCP env is plain JSON in IR — using directly (transitional backward compat)', {
        server: config.name,
      });
      decryptedEnv = rawEnv;
    } else {
      throw new Error(
        `MCP server "${config.name}" encrypted_env is neither a DEK envelope nor valid JSON`,
      );
    }
    const parsed = JSON.parse(decryptedEnv);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      env = parsed as Record<string, string>;
    } else {
      throw new Error(
        `MCP server "${config.name}" env decrypted to non-object value. Expected JSON object.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('non-object value')) throw err;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to decrypt MCP env', {
      server: config.name,
      tenantId: this.tenantId, // tenantId in log context only, NOT in error message
      error: errMsg,
    });
    // Do NOT include tenantId in user-facing error (per CLAUDE.md error sanitization)
    throw new Error(`MCP server "${config.name}" env decryption failed. Check KMS configuration.`);
  }
}
```

3.2. Update the `encrypted_auth_config` block for symmetry with the `encrypted_env` fix:

- Add the `isDEKFormat && !this.decryptor` guard (throw instead of silently falling through)
- Update the transitional comment:

```typescript
// Guard: DEK format but no decryptor available
if (isDEKFormat && !this.decryptor) {
  throw new Error(
    `MCP server "${config.name}" has encrypted auth config but no decryptor is available`,
  );
}
// TODO(mcp-secrets): Remove plain-JSON fallback after 2026-05-12 (same as encrypted_env above).
```

3.3. Add construction-time warning in the constructor (after the existing `serverTools` map is built):

```typescript
if (!this.decryptor) {
  const needsDecryptor = tools.some(
    (t) =>
      t.mcp_binding?.server_config?.encrypted_env ||
      t.mcp_binding?.server_config?.encrypted_auth_config,
  );
  if (needsDecryptor) {
    log.warn('InlineMcpClientProvider: encrypted MCP fields present but no decryptor available', {
      affectedServers: tools
        .filter(
          (t) =>
            t.mcp_binding?.server_config?.encrypted_env ||
            t.mcp_binding?.server_config?.encrypted_auth_config,
        )
        .map((t) => t.mcp_binding?.server_config?.name)
        .filter(Boolean),
    });
  }
}
```

3.4. Run `pnpm build --filter=@agent-platform/runtime` — must exit 0.

**Files Touched**:

- `apps/runtime/src/services/mcp/inline-mcp-provider.ts`

**Exit Criteria**:

- [ ] `encrypted_env` path has `isDEKFormat | isPlainJSON` detection symmetric with `encrypted_auth_config`
- [ ] Error message for env decryption failure does NOT include `this.tenantId`
- [ ] Both transitional fallbacks have `TODO(mcp-secrets): Remove after 2026-05-12`
- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0
- [ ] Manual test: MCP server with `authType=api_key` → `X-API-Key` header sent correctly (no 401)
- [ ] Manual test: MCP server with env vars → env injected into process (no `env decryption failed`)
- [ ] Manual test: runtime logs show `isDEKEnvelopeFormat=true` for both fields on newly compiled agent
- [ ] JIRA subtask created under ABLP-155 titled "Remove mcp-secrets transitional backward compat" with due date 2026-05-12 and label `tech-debt`

**Test Strategy**:

- Unit tests in `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`:
  - `encrypted_env` is DEK envelope → `decryptForTenant` called, env injected
  - `encrypted_env` is plain JSON → used directly, `log.warn` called with backward-compat message
  - `encrypted_env` is neither → throws
  - `encrypted_env` is DEK format but decryptor is undefined → throws with clear message
  - `encrypted_auth_config` is DEK envelope → decryptor called, auth headers set
  - No decryptor + encrypted fields → construction-time `log.warn` called
  - Error message does NOT contain tenantId (assert on thrown error string)

**Rollback**: Revert `inline-mcp-provider.ts`. Pre-existing env failure is no regression.

---

### Phase 4: Cleanup (Post-Cache-Window, after 2026-05-12)

**Goal**: Remove all transitional backward-compat code, investigation debug logs, and the now-unnecessary `mcpServerConfigLoader` if it has no remaining consumers.

**Tasks**:

4.1. In `inline-mcp-provider.ts`:

- Remove `isPlainJSON` branches from both `encrypted_env` and `encrypted_auth_config`
- Both paths must hard-fail if value is not a DEK envelope
- Remove all `TODO(mcp-secrets)` comments

  4.2. In `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`:

- Remove investigation debug logs (`MCP auth config pre-save`, `MCP auth config post-save`)
- Remove `isTenantEncryptionReady` and `isDEKEnvelopeFormat` imports added during debugging

  4.2b. In `apps/runtime/src/services/mcp/inline-mcp-provider.ts`:

- Remove `valuePrefix` debug fields from both the `encrypted_env` and `encrypted_auth_config` debug log entries (investigation artifacts, not needed in steady state)

  4.3. Audit `ResolveToolImplDeps.mcpServerConfigLoader` — if no remaining call sites use it, remove the property and update the interface. If Studio registry/discovery still uses it, keep it with a clear JSDoc noting it is for non-IR uses only.

  4.4. Run `pnpm build && pnpm test:report` — must exit 0.

**Files Touched**:

- `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
- `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`
- `packages/shared/src/tools/resolve-tool-implementations.ts` (if `mcpServerConfigLoader` removed)

**Exit Criteria**:

- [ ] `grep -rn "TODO(mcp-secrets)"` returns 0 results
- [ ] Both encrypted field paths require DEK-envelope format — no plaintext fallback
- [ ] `pnpm build && pnpm test:report` exits 0

**Rollback**: Revert cleanup changes. The transitional code is designed to be safe even past the window.

---

## 4. Wiring Checklist

- [ ] `McpServerConfigForIR` defined in `packages/shared/src/types/mcp-server.ts` and re-exported from `packages/shared/src/repos/index.ts`
- [ ] `RawMCPServerConfig` defined in `packages/shared/src/types/mcp-server.ts` and re-exported from `packages/shared/src/repos/index.ts`
- [ ] `findMcpServerConfigsRaw` exported from `packages/shared/src/repos/index.ts`
- [ ] `mcpServerConfigRawLoader` added to `ResolveToolImplDeps` in `resolve-tool-implementations.ts`
- [ ] `mcpConfigMap` type updated to `Map<string, McpServerConfigForIR>` in `resolve-tool-implementations.ts` (local variable AND `compileProjectTool()` parameter at line ~470) and `dsl-property-parser.ts`
- [ ] All 5 call sites inject `findMcpServerConfigsRaw` as `mcpServerConfigRawLoader`:
  - [ ] `apps/runtime/src/services/version-service.ts`
  - [ ] `apps/runtime/src/services/execution/types.ts`
  - [ ] `apps/studio/src/lib/abl/project-aware-compile.ts`
  - [ ] `apps/studio/src/app/api/abl/compile/route.ts`
  - [ ] `apps/studio/src/app/api/projects/[id]/topology/route.ts`
- [ ] `inline-mcp-provider.ts` handles `encrypted_env` and `encrypted_auth_config` symmetrically
- [ ] `inline-mcp-provider.ts` error messages do NOT contain `tenantId`
- [ ] Construction-time warning logs when decryptor absent but encrypted fields present
- [ ] Freshly compiled IR's `encrypted_env` and `encrypted_auth_config` are DEK-envelope ciphertext (not plaintext JSON)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes. MongoDB already stores DEK-envelope ciphertext. The bug was only in the read path.

### Feature Flags

None. The IR shape is unchanged — only the values in existing fields become correct.

### Configuration Changes

None.

### Cache Considerations

- **Redis tool cache TTL**: 24h. Old compiled IRs with plaintext in encrypted fields persist for up to 24h post-deployment.
- **Mitigation**: Phase 3 adds transitional detection for both fields so old cached IRs continue to work.
- **Phase 4 cleanup**: 2026-05-12 (two weeks post-deployment).

### Tenant Isolation Note

The `findMcpServerConfigsRaw` native driver query bypasses the `tenantIsolationPlugin` Mongoose hook. However, that plugin's read-path behavior is to scope queries — which is manually replicated by the explicit `{ tenantId, projectId }` filter in the native query. Write-path isolation (enforced by the plugin on save) is unaffected since this is a read-only function.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Phases 1–3 complete with all exit criteria met
- [ ] `pnpm build` (monorepo) exits 0
- [ ] MCP server with `auth_type=api_key` + tool invocation → `X-API-Key` header sent correctly (no 401)
- [ ] MCP server with env vars + tool invocation → env vars injected into MCP process (no `env decryption failed`)
- [ ] Runtime logs for freshly compiled agent show `isDEKEnvelopeFormat=true` for both fields
- [ ] All 5 call sites confirmed using raw loader (grep)
- [ ] No tenantId in user-facing error messages from `inline-mcp-provider.ts`
- [ ] No regressions: MCP tools without auth/env continue to work
- [ ] Phase 4 cleanup tracked in JIRA with target date 2026-05-12

---

## 7. Open Questions

1. **Call site exact lines**: The 5 call sites are identified by audit but line numbers may shift. At implementation time run `grep -rn "mcpServerConfigLoader" .` across the full monorepo to confirm all injection points before updating.
2. **`mcpServerConfigLoader` in Studio registry/discovery**: The `MCPServerRegistryService` and Studio discovery service use `findMcpServerConfigsByProject` (decrypted). This is intentional — they need plaintext for live connection. The `mcpServerConfigLoader` property in `ResolveToolImplDeps` may still be used by these paths. Phase 4 audit will determine if it can be removed.
3. **authProfileId usage**: `RawMCPServerConfig` includes `authProfileId`. If the IR baking path ever needs to resolve OAuth2 auth profiles, it will need the raw `authProfileId` value. For now, this field is carried through but not used in `buildMcpBindingFromProps`.
