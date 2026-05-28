# SDLC Log: External Agent Registry — LLD

**Phase**: LLD
**Artifact**: `docs/plans/2026-04-28-external-agent-registry-impl-plan.md`
**Feature Spec**: `docs/features/external-agent-registry.md`
**HLD**: `docs/specs/external-agent-registry.hld.md`
**Date**: 2026-04-28
**Status**: APPROVED (5 audit rounds)

---

## Oracle Decisions

All 15 LLD clarifying questions resolved with no user escalation.

| #   | Question                                 | Decision                                                                                                                                                       |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Repo location                            | `packages/shared/src/repos/external-agent-config-repo.ts` — matches `mcp-server-config-repo.ts` convention                                                     |
| A2  | SsrfEndpointValidator construction       | Inline per handler — import `getDevSSRFOptions` from `@agent-platform/shared-kernel/security`; do NOT use module-private `shouldAllowPrivateRemoteEndpoints()` |
| A3  | Permission registration                  | Both `PERMISSION_REGISTRY` and `PROJECT_ROLE_PERMISSIONS` in `role-permissions.ts` — flat `string[]` format                                                    |
| A4  | Test harness SSRF allow                  | `ALLOW_SSRF_PRIVATE_RANGES` env var (via `getDevSSRFOptions()`); NOT `ALLOW_PRIVATE_ENDPOINTS`                                                                 |
| A5  | Studio proxy pattern                     | `withRouteHandler` + `proxyToRuntime` following `human-tasks/route.ts`                                                                                         |
| B1  | discoverAgent signature                  | `discoverAgent(params: DiscoverAgentParams, deps: DiscoverAgentDeps)` — wrapped in `testExternalAgentConnection()` module function                             |
| B2  | Cascade delete                           | Both ExternalAgentConfig AND MCPServerConfig (fixes existing gap) in same commit                                                                               |
| B3  | resolveRemoteFromHandoff async risk      | Keep sync; use `enrichWithRegistryAuth()` in async `handleHandoff()` — avoids ~20 call site cascade                                                            |
| B4  | ABLEditor autocomplete                   | Merge into existing `availableAgents[]` — `CompletionContext` is intentionally generic                                                                         |
| B5  | testExternalAgentConnection location     | Module-level exported function in repo module — route handlers import it directly                                                                              |
| C1  | ENCRYPTION_MASTER_KEY startup check      | Already validated at `server.ts:~1963`; no new check needed                                                                                                    |
| C2  | resolveRemoteFromHandoff async migration | Deferred to future iteration — keep sync pattern via `enrichWithRegistryAuth` in handleHandoff                                                                 |
| C3  | Both cascade gaps together               | Yes — same file, same function, data integrity fix                                                                                                             |
| C4  | mock-a2a-remote-agent extension          | Add header recording and configurable failure response for E2E auth verification                                                                               |
| C5  | Studio proxy latency                     | Negligible for management UI; Runtime owns SSRF/auth/encryption logic                                                                                          |

---

## Audit Rounds

### Round 1 (lld-reviewer — architecture compliance)

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [LLD-1] CRITICAL: Hard-fail on credential decryption (throw sanitized error) — not silent downgrade to unauthenticated
- [LLD-2] HIGH: Test target clarified as `enrichWithRegistryAuth` (not a 3-arg `resolveRemoteFromHandoff`)
- [LLD-3] HIGH: `header` canonicalized (not `headerName`); test spec E2E-3 flagged for post-impl-sync correction
- [LLD-4] HIGH: Call-site audit added (Task 3.3b) — `handleFanOut` path deferred to future iteration
- [LLD-5] MEDIUM: RoutingExecutor construction sites enumerated; optional 3rd param backward-compatible

### Round 2 (lld-reviewer — pattern consistency)

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [LLD-6] CRITICAL: PERMISSION_REGISTRY format corrected to `readonly string[]` (not `{name, label}[]`)
- [LLD-7] CRITICAL: Repo rewritten to module-level exported functions following `mcp-server-config-repo.ts` — dynamic `await import()`, `findOne + set + save()`, no class
- [LLD-8] HIGH: Studio proxy tasks rewritten with `withRouteHandler` + `proxyToRuntime` pattern
- [LLD-9] LOW: Trace event type → `'remote_agent_registry_lookup'`

### Round 3 (lld-reviewer — completeness)

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [LLD-9] HIGH: Repo filename standardized to `external-agent-config-repo.ts` everywhere
- [LLD-10] HIGH: All 7 stale class-name references replaced with function names
- [LLD-11] HIGH: Test file names aligned with test spec §8 (3 separate files vs 1 combined)
- [LLD-12] MEDIUM: "Phase 2" wording in D-9 → "future feature iteration"
- [LLD-13] LOW: Studio page path verification added to Phase 6 exit criteria

### Round 4 (phase-auditor — cross-phase consistency)

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [LLD-1 recheck] CRITICAL: `ALLOW_PRIVATE_ENDPOINTS` → `ALLOW_SSRF_PRIVATE_RANGES`; `shouldAllowPrivateRemoteEndpoints()` is module-private (line 650, no export); routes must use `getDevSSRFOptions()` from `@agent-platform/shared-kernel/security`
- [LLD-2] HIGH: Studio page path → `apps/studio/src/app/projects/[projectId]/external-agents/page.tsx`; Open Question 2 resolved
- [LLD-4 recheck] HIGH: 7 remaining class-name refs removed; Open Question 3 corrected
- [LLD-5] HIGH: Cascade-delete test file added to New Files table
- [LLD-3] HIGH: HLD divergence note with specific section cross-references added to D-2

### Round 5 (lld-reviewer — final sweep)

**Verdict**: NEEDS_CHANGES (no CRITICAL)

**Findings addressed**:

- HIGH: i18n specification added to Phase 6; `apps/studio/src/api/external-agents.ts` client module added to New Files; SWR cache invalidation and loading states specified in Phase 6 header; `packages/i18n/locales/en/studio.json` added to Modified Files
- MEDIUM/LOW: Logged below — not blocking

**Remaining logged findings (MEDIUM/LOW — not blocking)**:

- MEDIUM: API client module (`external-agents.ts`) now listed but detailed function signatures deferred to implementation
- MEDIUM: SWR cache invalidation noted in Phase 6 header but exact `mutate()` call locations deferred to implementation
- MEDIUM: Loading/disabled state logic noted in Phase 6 header but component-level details deferred to implementation
- LOW: Sidebar nav file path still TBD at implementation time (per Phase 6 exit criteria step)

---

## Files Created

| File                                                         | Action  |
| ------------------------------------------------------------ | ------- |
| `docs/plans/2026-04-28-external-agent-registry-impl-plan.md` | CREATED |
| `docs/sdlc-logs/external-agent-registry/lld.log.md`          | CREATED |

---

## Key Decisions for Implementation

1. **Repo pattern**: Module-level exported functions in `packages/shared/src/repos/external-agent-config-repo.ts`. Dynamic `await import('@agent-platform/database/models')` inside each function. Use `findOne + set + save()` (not `findOneAndUpdate`) so `encryptionPlugin` pre-save hook fires.

2. **Auth injection**: `enrichWithRegistryAuth(entry, session, targetAgent)` private method on `RoutingExecutor`. Called in `handleHandoff()` after line 872. Hard-fail (throw sanitized error) on `JSON.parse(encryptedAuthConfig)` failure — never silent downgrade to unauthenticated.

3. **SSRF in routes**: Import `getDevSSRFOptions` from `@agent-platform/shared-kernel/security`. `shouldAllowPrivateRemoteEndpoints()` at `routing-executor.ts:650` is module-private — cannot be imported.

4. **Test harness**: Add `ALLOW_SSRF_PRIVATE_RANGES` to `MANAGED_ENV_KEYS`; set to `'true'` when `allowPrivateEndpoints: true`.

5. **RoutingExecutor DI**: Optional 3rd constructor parameter `lookupExternalAgent?: LookupExternalAgent`. Production: `findExternalAgentConfigByName` from `@agent-platform/shared/repos`. Default `undefined` → existing test files unchanged.

6. **handleFanOut**: NOT enriched in this LLD. Deferred to future iteration. Phase 1 covers sequential `handleHandoff` → `handleRemoteHandoff` path only.

7. **Post-impl-sync corrections needed**:
   - Test spec E2E-3: `headerName` → `header`
   - Feature spec Section 11: `RUNTIME_ENCRYPTION_KEY` → `ENCRYPTION_MASTER_KEY`
   - HLD Sections 3, 4 concern #2, #10, #11: `resolveRemoteFromHandoff` → `enrichWithRegistryAuth`
