# SDLC Log: External Agent Registry — HLD

**Phase**: HLD
**Artifact**: `docs/specs/external-agent-registry.hld.md`
**Feature Spec**: `docs/features/external-agent-registry.md`
**Test Spec**: `docs/testing/external-agent-registry.md`
**Date**: 2026-04-28
**Status**: APPROVED (3 audit rounds)

---

## Oracle Decisions

All 15 clarifying questions were answered from the feature spec, codebase reading, and established
patterns. No AMBIGUOUS items required user escalation.

| #   | Question                                              | Classification | Decision                                                                                                                                               |
| --- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | DI approach for `resolveRemoteFromHandoff()`          | ANSWERED       | Function parameter `lookupExternalAgent?: LookupExternalAgent` — plain function (not a class method), consistent with existing `agent-lookup.ts` style |
| A2  | Concurrency safety of `globalThis.fetch` monkey-patch | ANSWERED       | Self-healing via host-guard in `createAuthFetch` — no cross-agent credential leakage; no new risk introduced                                           |
| A3  | Agent card fetch UX: sync-verify-create vs async      | ANSWERED       | Synchronous verify-then-create; failure is non-blocking (201 with `lastConnectionStatus: 'failed'`)                                                    |
| A4  | Hot-path registry lookup: MongoDB vs in-memory cache  | ANSWERED       | MongoDB indexed query only in Phase 1 — `<2 ms p99`; Phase 2 LRU if benchmarks require                                                                 |
| A5  | Studio proxy scope                                    | ANSWERED       | All 6 ops proxied to Runtime; `proxyToRuntime` helper from `@/lib/runtime-proxy`                                                                       |
| B1  | Which fields to encrypt                               | ANSWERED       | Only `encryptedAuthConfig` (Mongoose String, JSON `{value, header?}`); endpoint URL plaintext                                                          |
| B2  | Autocomplete pattern in agent editor                  | ANSWERED       | Extend `loadAgentsForContext()` at `ABLEditor.tsx:269`; parallel fetch from `/external-agents`                                                         |
| B3  | Cascade delete pattern                                | ANSWERED       | Add `ExternalAgentConfig.deleteMany({ projectId })` to `deleteProject()` + `deleteTenant()`                                                            |
| B4  | Visual handoff builder scope                          | DECIDED        | Deferred to Phase 2 — delivery plan has no explicit task; DSL editor autocomplete covers Phase 1                                                       |
| B5  | Runtime error on auth injection failure               | ANSWERED       | Hard-fail handoff; sanitized message `"Agent not found: {name}"`; raw error in `log.error`                                                             |
| C1  | IR with `auth.value` populated skips DB lookup?       | ANSWERED       | IR never has `auth.value` populated — registry lookup happens before inline fallback check                                                             |
| C2  | Rollback strategy                                     | DECIDED        | Hard-fail on auth injection failure — no unauthenticated fallback (security principle)                                                                 |
| C3  | `ENCRYPTION_MASTER_KEY` startup check                 | ANSWERED       | Check exists at `server.ts:~1963` — runtime won't start without it                                                                                     |
| C4  | `allowPrivateEndpoints` in harness                    | ANSWERED       | NOT yet in `RuntimeHarnessOptions` — must be added as part of this feature                                                                             |
| C5  | localhost enforcement beyond SSRF                     | DECIDED        | SSRF validation is the only enforcement needed — `SsrfEndpointValidator` already blocks private IPs                                                    |

---

## Audit Rounds

### Round 1

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [HD-1] CRITICAL: `headerName` → `header` in 3 locations (Section 1, data model, request body) — matches `OutboundAuthConfig.header` at `authenticated-client-factory.ts:57`
- [HD-2] CRITICAL: Added `authType: 'none'` explicit mapping documentation in Runtime Handoff Resolution Flow step 3b
- [HD-3] CRITICAL: Changed `encryptedAuthConfig` from nested object to `Mongoose String` type with JSON serialization note — matches MCP reference `mcp-server-config.model.ts:65`
- [HD-4] HIGH: Replaced `ExternalAgentCardFetcher` (fabricated) with `discoverAgent()` from `packages/a2a` in all 3 locations
- [HD-5] HIGH: Replaced `createAuthenticatedA2AClient()` with `createA2AClientWithAuth()` (public export) in all locations
- [HD-6] HIGH: Error code `CONFLICT` → `DUPLICATE_NAME` to align with test spec INT-2
- [HD-7] HIGH: Added Studio proxy design note explaining deliberate divergence from MCP direct-DB pattern; referenced `proxyToRuntime` helper; resolved Open Question #2

**Also fixed (MEDIUM)**:

- [HD-8] Server.ts line reference softened to `~1963`
- [HD-9] Added note about `RUNTIME_ENCRYPTION_KEY` vs `ENCRYPTION_MASTER_KEY` feature spec drift

### Round 2

**Verdict**: APPROVED (with HIGH findings to address)

**Findings fixed before Round 3**:

- [R2-H1] HIGH: Added PATCH request body definition with fields, `name` immutability, auth-clearing semantics, SSRF re-validation
- [R2-H2] HIGH: Added GET list note: no pagination in Phase 1, expected 1-50 entries per project
- [R2-M1] MEDIUM: Added `LookupExternalAgent` TypeScript type signature to Data Access Pattern concern
- [R2-M2] MEDIUM: Added `discoverAgent({endpoint, tenantId}, deps)` signature with 5 s timeout via AbortController note
- [R2-M3] MEDIUM: Added cross-phase drift notes in Section 10 References for `headerName` and `RUNTIME_ENCRYPTION_KEY`

### Round 3

**Verdict**: APPROVED (final)

**Findings** (all LOW/MEDIUM — no blockers):

- [HD-M1] MEDIUM: `lastConnectionStatus: null` vs MCP `'untested'` — added explanatory comment; HLD uses `null` per feature spec (idiomatic MongoDB default)

---

## Files Created/Modified

| File                                                | Action                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `docs/specs/external-agent-registry.hld.md`         | CREATED — full HLD (3 alternatives, 12 concerns, full API contract) |
| `docs/sdlc-logs/external-agent-registry/hld.log.md` | CREATED — this file                                                 |

---

## Key Decisions for LLD

1. **`LookupExternalAgent` DI signature**: `(tenantId: string, projectId: string, name: string) => Promise<{ endpoint, protocol, authType, encryptedAuthConfig? } | null>`. The `encryptionPlugin` auto-decrypts — returned `encryptedAuthConfig` is plaintext JSON string.

2. **`authType: 'none'` → `remote.auth = undefined`**: `createClientForAgent()` guard `auth?.type && auth?.value` at `routing-executor.ts:1626` causes unauthenticated client path when `auth` is absent.

3. **`encryptedAuthConfig` is Mongoose `String`**: Plugin encrypts the entire string value. JSON-serialize `{ value, header? }` before encryption. NOT a subdocument schema.

4. **Studio proxy via `proxyToRuntime`**: Use existing helper from `@/lib/runtime-proxy`. No direct DB access in Studio routes for this feature.

5. **`allowPrivateEndpoints: boolean` in `RuntimeHarnessOptions`**: Not yet present — must be added and threaded to `SsrfEndpointValidator.validate(url, allowPrivate)`.

6. **`discoverAgent()` signature**: `discoverAgent({endpoint, tenantId}, deps)` from `packages/a2a`. 5 s timeout via `AbortController` signal in `deps`. Used for both create and test-connection.

7. **`lastConnectionStatus` initial value**: `null` (not `'untested'` string) — follows feature spec; idiomatic MongoDB default.

8. **PATCH `name` immutability**: `name` is the registry lookup key — cannot be changed after creation.
