# SDLC Log: mcp-secrets-inline — Implementation Phase

**Feature**: mcp-secrets-inline
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-27-mcp-secrets-inline-impl-plan.md`
**JIRA**: ABLP-155
**Date Started**: 2026-04-27
**Date Completed**: 2026-04-27

---

## Preflight

- [x] LLD file paths verified — all 11 modified files confirmed to exist
- [x] Function signatures current — confirmed at audit rounds 1-5
- [x] No conflicting recent changes — git log clean
- Discrepancies: none

## Phase Execution

### LLD Phase 1: Raw Repo Function + Types

- **Status**: DONE
- **Commit**: ea62a0a64
- **Exit Criteria**: all met — `McpServerConfigForIR`, `RawMCPServerConfig` in `types/mcp-server.ts`; `findMcpServerConfigsRaw()` in repo; re-exported from barrel; `pnpm build --filter=@agent-platform/shared` exits 0
- **Deviations**: minor — `docs.map((d) =>` needed explicit `d: Record<string, unknown>` type annotation to fix "implicit any" TS error
- **Files Changed**: 3 (`types/mcp-server.ts`, `mcp-server-config-repo.ts`, `repos/index.ts`)

### LLD Phase 2: Wire Raw Loader

- **Status**: DONE
- **Commit**: e5719fb8a
- **Exit Criteria**: all met — `mcpServerConfigRawLoader` in `ResolveToolImplDeps`; `mcpConfigMap` type widened to `McpServerConfigForIR`; all 5 call sites updated; `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/runtime` exits 0
- **Deviations**: none — all 5 call sites: `version-service.ts:285`, `execution/types.ts:1504`, `project-aware-compile.ts:181`, `compile/route.ts:141`, `topology/route.ts:149`
- **Files Changed**: 8

### LLD Phase 3: Fix Runtime encrypted_env Path

- **Status**: DONE
- **Commit**: b9b1527e7
- **Exit Criteria**: all met — `isDEKFormat | isPlainJSON | neither` detection in both `encrypted_env` and `encrypted_auth_config` blocks; fail-closed guard (DEK + no decryptor → throw); construction-time `log.warn`; error messages sanitized (no tenantId); `pnpm build` exits 0
- **Deviations**: none
- **Files Changed**: 2 (`inline-mcp-provider.ts`, `topology/route.ts`)

## Wiring Verification

- [x] `findMcpServerConfigsRaw` exported from `packages/shared/src/repos/index.ts`
- [x] `McpServerConfigForIR`, `RawMCPServerConfig` exported from repo barrel and types barrel
- [x] All 5 IR-baking call sites use `mcpServerConfigRawLoader` (grep verified: 5 matches)
- [x] `mcpServerConfigRawLoader` takes priority over `mcpServerConfigLoader` in `resolveToolImplementations`
- Missing wiring found: none

## Review Rounds

| Round | Verdict     | Critical | High | Medium | Low |
| ----- | ----------- | -------- | ---- | ------ | --- |
| 1     | NEEDS_FIXES | 1        | 2    | 0      | 0   |
| 2     | NEEDS_FIXES | 0        | 2    | 1      | 0   |
| 3     | NEEDS_FIXES | 1        | 1    | 1      | 0   |
| 4     | NEEDS_FIXES | 0        | 1    | 2      | 1   |
| 5     | APPROVED    | 0        | 0    | 1 (NB) | 0   |

### Deferred Findings

- Round 5 MEDIUM: TODO(mcp-secrets) cleanup is tracked via ABLP-155 with target date 2026-05-12. Code comment documents the deadline.
- Round 4 HIGH: Compile route returns IR with ciphertext to browser — pre-existing issue (was plaintext before, now ciphertext). Strictly better. Tracked as follow-up; not blocking.

## Acceptance Criteria

- [x] All LLD phases complete with exit criteria met
- [x] `pnpm build` (TypeScript check) exits 0 for shared + runtime
- [x] All 5 call sites confirmed using raw loader (grep verified)
- [x] No tenantId in user-facing error messages (test assertion at inline-mcp-provider.test.ts:413-428)
- [x] No regressions — 38 unit tests passing in inline-mcp-provider.test.ts; 30 passing in mcp-server-config-repo.test.ts
- [x] Phase 4 cleanup tracked in JIRA ABLP-155 with TODO deadline 2026-05-12
- [ ] MCP auth_type=api_key → X-API-Key header sent (no 401) — requires live test with real MCP server
- [ ] MCP env vars → injected correctly — requires live test with real MCP server
- [ ] Runtime logs isDEKEnvelopeFormat=true for freshly compiled agent — requires live test

Note: Live integration tests (api_key, env vars, isDEKEnvelopeFormat logs) require a running environment with MongoDB + Redis + MCP server. These are post-deploy verification steps.

## Learnings

### packages/shared

- Mongoose `.lean()` does NOT bypass `post('find')` plugins — the encryption plugin runs for all Mongoose find paths including `.lean()`. To bypass, use `Model.collection.find()` (native MongoDB driver).
- Native driver bypasses ALL Mongoose plugins: tenant isolation, encryption, validation. Must replicate tenant+project filter explicitly in the native query.
- `docs.map((d) =>` from native collection result needs explicit `d: Record<string, unknown>` annotation — the cursor `.toArray()` return type is `Document[]` which TypeScript considers `any`-adjacent.
- `mcpServerConfigLoader` (legacy, Mongoose path) should remain in `ResolveToolImplDeps` for backward compat. Any code that hasn't been updated to use `mcpServerConfigRawLoader` should still work.

### apps/runtime

- DEK envelope format check (`isDEKEnvelopeFormat`) is a fast pure function — no I/O, safe to call in hot paths.
- The `encrypted_auth_config` catch block intentionally falls open for non-decryption failures (e.g., OAuth provider network error). Document this clearly — it's not a bug.
- Construction-time `log.warn` for missing decryptor is appropriate for early diagnostics before getClient is called.
- Test fixtures for DEK-format values: use `Buffer.concat([Buffer.from([dekIdLen]), dekIdBytes, iv[12], authTag[16], ciphertext])` → base64. The dekId first byte must be printable ASCII (0x20-0x7e).
- `@agent-platform/shared-encryption`'s `isDEKEnvelopeFormat` is a pure function — no need to mock it in tests; use real DEK-format fixtures instead.
