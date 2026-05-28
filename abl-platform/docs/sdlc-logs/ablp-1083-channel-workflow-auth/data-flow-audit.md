# Data-Flow & Dependency-Wiring Audit: Channel-Session Workflow Tool Auth

**Date**: 2026-05-15
**Auditor**: Claude (paired with Vishal Veerannapet)
**Round**: 1 + 2 (combined)
**Ticket**: ABLP-1083
**PR**: bitbucket.org/koreteam1/abl-platform/pull-requests/1044
**Fix commit**: `7b6ba2eb8f` — `[ABLP-1083] fix(runtime,workflow-engine): use service token for agent->workflow auth so channel sessions succeed`

## Scope

The fix changes the JWT subject the runtime sends to workflow-engine for agent → workflow tool calls. Pre-fix, `sub` was `session.userId` — a real `User._id` for Studio sessions but a synthetic channel principal (e.g. `ai4w:<connectionId>:<base64Email>:<agentContextId>`) for AI4Work and other channel sessions. The channel-session ID does not exist in the `User` collection, so workflow-engine's `unifiedAuth.getUserById(sub)` returned `null` and rejected the call with 401 "User not found". Post-fix, `sub` is the stable `'service:runtime'`, and workflow-engine's auth recognizes `service:*` subjects as a synthetic OWNER principal — mirroring the already-shipped pattern in `apps/search-ai/src/middleware/auth.ts:125-155` and `apps/search-ai-runtime/src/middleware/auth.ts:38-93`.

## Sensitive Values Audited

- **VALUE A** — Internal service JWT minted by runtime for workflow-engine calls — DATA CLASS: CREDENTIAL
- **VALUE B** — End-user identity for channel sessions (contactId, customerId, anonymousId, sessionPrincipalId) — DATA CLASS: PII
- **VALUE C** — Tenant isolation (`tenantId` claim and route-handler scoping) — DATA CLASS: INTERNAL

## VALUE A — Internal service JWT

1. **Source**: minted at `apps/runtime/src/services/execution/llm-wiring.ts:1159` via `mintWorkflowAuthToken({ secret, tenantId, projectId })` (helper at `apps/runtime/src/services/execution/workflow-auth-token.ts`). The token's `sub` is the constant `WORKFLOW_AUTH_TOKEN_SUB = 'service:runtime'`. The same file also mints a SearchAI token at line 969 with the same `sub: 'service:runtime'`. The only other `workflowAuthToken` mint site is `apps/runtime/src/routes/internal-tools.ts:391` (Studio "try this tool" flow) which uses a real `actorUserId` — separate path, unaffected.
2. **Writes**: not persisted. Held only in the closure of the per-session `WorkflowToolExecutor` / `WorkflowStatusTool` config. Never logged (the only token-context log line at `llm-wiring.ts:1175` logs `err.message` from a catch, not the token).
3. **Serialization**: sent exclusively as `Authorization: Bearer <token>` header on three call paths in `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — POST execute (line 320), GET status poll (line 500), POST cancel (line 589). Never in the request body.
4. **Read paths on receiver**: workflow-engine's `unifiedAuth` (config now at `apps/workflow-engine/src/middleware/auth.ts` — extracted in this commit to enable focused testing) calls `getUserById(payload.sub)` and `resolveTenantMembership(user.id, tenantId)`. With `service:` bypass, both return synthetic shapes; `req.tenantContext = { tenantId: <from claim>, userId: 'service:runtime', role: 'OWNER', authType: 'user', projectId: <from claim> }`.
5. **Policy boundary**: the receiver sites that consume `tenantContext.userId`:
   - DB queries (connectors / connections / action-test routes): not reachable from this token — those routes are called from Studio with browser JWTs only.
   - Authorization gates: `requireAuth()` passes (tenantContext set); permission gates use role-mapped `TENANT_ROLE_PERMISSIONS` for OWNER.
   - Audit-log "actor" fields: `cancelledBy` (workflow-executions.ts:855), `respondedBy` / `decidedBy` (workflow-approvals.ts, human-task-resolution.ts) — these now write the literal string `'service:runtime'` when reached via this token. See F-1.
   - Outbox / EventBus events: `WorkflowExecutionEvent` schema (event-builders.ts) has no `userId`/actor field — no leak downstream.
   - Trace events / ClickHouse: no userId in the event-builder schema.
6. **Consumers / Sinks**: end-user identity reaches LLM nodes / memory scoping via `triggerMetadata.agentSession.endUserId`, which is independent of the JWT `sub`. The JWT itself never reaches an LLM.
7. **Wiring**: single `createUnifiedAuthMiddleware` call (now in `apps/workflow-engine/src/middleware/auth.ts`), applied via `authMiddleware = [unifiedAuth, requireAuth()]` at `apps/workflow-engine/src/index.ts`, mounted globally on `apiRouter` (covering all `/api/v1/*`). Callback router and connector-webhook router are mounted before `apiRouter` directly on `app` for HMAC-authenticated paths — intentional.
8. **Parallel paths**: services that accept internal service tokens — `apps/workflow-engine/src/middleware/auth.ts` (new), `apps/search-ai/src/middleware/auth.ts` (existing), `apps/search-ai-runtime/src/middleware/auth.ts` (existing) — all three implement the `service:` bypass with identical shape. Services receiving only user JWTs (runtime, template-store, academy) do not have the bypass — correct.
9. **Regression tests**: `apps/workflow-engine/src/middleware/__tests__/auth.test.ts` (added) — three cases: accept `sub: 'service:runtime'` and assert tenantContext shape, accept any `service:*` prefix, reject wrong-secret regardless of sub. `apps/runtime/src/services/execution/__tests__/workflow-auth-token.test.ts` (added) — four cases on the helper: sub constant, claim shape, projectId optionality, wrong-secret rejection.

## VALUE B — End-user identity for channel sessions

1. **Source**: AI4W session key built at `apps/runtime/src/channels/adapters/ai4w-types.ts:151` (`buildAI4WSessionKey`). `compatibilityUserId` resolved at `apps/runtime/src/services/session/execution-owners.ts:77-78` as `contactId ?? customerId ?? actorOwnerId ?? explicitUserId ?? sessionPrincipalId`.
2. **Pre-fix flow**: identity was baked into the JWT `sub` and arrived at workflow-engine as `tenantContext.userId`.
3. **Post-fix flow**: identity now flows exclusively in the request body via `triggerMetadata.agentSession` and `triggerMetadata.agentContext` (built in `apps/runtime/src/services/workflow/workflow-tool-executor.ts:310-353` via `buildAgentSessionProjection` / `buildAgentContextProjection`).
4. **Receiver**: workflow-engine re-materializes `agentSession` at `apps/workflow-engine/src/handlers/workflow-handler.ts:334` (`materializeAgentSession`); the projection lands in `WorkflowContextData.agentSession` and is read by `loadMemoryProjection` (line 396) for user-scoped memory loads. Available to LLM nodes as `{{context.agentSession.endUserId}}`.
5. **Attribution gap test**: the fallback `triggeredBy: tenantContext?.userId` at `workflow-executions.ts:736` fires only when `rawTriggerMetadata` is null; the runtime always populates `triggerMetadata`, so this fallback is not on the agent path. The cancel-by attribution (F-1) does shift from synthetic channel principal to `'service:runtime'` — pre-fix value was also synthetic, so the change is in shape rather than information content.

## VALUE C — Tenant isolation

1. **tenantId derivation**: workflow-engine reads `tenantId` from the JWT `tenantId` claim (set by the runtime's `mintWorkflowAuthToken`); not derived from `sub`. Route handlers use `tenantContext.tenantId` via `requireTenantProject` (`apps/workflow-engine/src/lib/route-helpers.ts:60`).
2. **Threat model**: a process inside the cluster with knowledge of `JWT_SECRET` could mint `service:anything` with any `tenantId` and obtain OWNER on that tenant. This is identical to the already-shipped search-ai pattern. Trust boundary = `JWT_SECRET` confidentiality, not the `sub` shape. External attackers without the secret cannot forge tokens (standard JWT verification gate).
3. **projectId**: workflow JWT now carries `projectId` (added in this commit to match the SearchAI block). `requireTenantProject` still reads `projectId` from URL path params, not the JWT claim — so the claim is defense-in-depth, not the primary scope source.

## Findings Summary

| ID  | Severity | Dimension        | Finding                                                                                                                                                                                                                                                                                            | Disposition                                                                                                                                                                     |
| --- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM   | Read paths       | `cancelledBy` / `respondedBy` written to MongoDB human task records becomes the literal `'service:runtime'` when the runtime cancels via service token (`apps/workflow-engine/src/routes/workflow-executions.ts:855`). Pre-fix was the synthetic channel principal — also opaque, different shape. | Leave as-is (user decision). Real attribution lives in `agentSession`.                                                                                                          |
| F-2 | HIGH     | Regression tests | The `service:` bypass in `apps/workflow-engine/src/middleware/auth.ts:30,38` had no boundary test before this commit; the JWT shape minted in `apps/runtime/src/services/execution/llm-wiring.ts:1159` had no contract test.                                                                       | **CLOSED** — `apps/workflow-engine/src/middleware/__tests__/auth.test.ts` and `apps/runtime/src/services/execution/__tests__/workflow-auth-token.test.ts` added in this commit. |
| F-3 | MEDIUM   | Policy boundary  | Bypass grants OWNER for any `service:*` sub on any tenantId — no allowlist of known service names, no check on JWT `type`/`internal` claim. Matches existing search-ai pattern. Trust boundary is the shared `JWT_SECRET`.                                                                         | Leave as-is (user decision). Diverging here would require also tightening search-ai / search-ai-runtime.                                                                        |
| F-4 | LOW      | Source           | `apps/runtime/src/routes/internal-tools.ts:391` mints a workflow JWT with `sub: actorUserId ?? 'studio-tool-test'` — neither service prefix nor always a real ID. Unaffected by this fix; latent risk if the bypass is ever tightened to a specific allowlist.                                     | No action.                                                                                                                                                                      |
| F-5 | LOW      | Parallel paths   | Approval / human-task-resolution routes (`workflow-approvals.ts:129,155`; `human-task-resolution.ts:76,112,130`) write `tenantContext.userId` as `respondedBy`. Currently only reachable from real user JWTs; latent risk if any future automated approval path calls these with a service token.  | No action — future automation should pass a real actor identity explicitly.                                                                                                     |

## Boundary Test Coverage Added

| Test                                                                        | Asserts                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/middleware/__tests__/auth.test.ts`                | `sub: 'service:runtime'` is accepted by the real `unifiedAuth` config (no DB), produces `tenantContext = { userId: 'service:runtime', role: 'OWNER', tenantId, projectId }`. Any `service:*` prefix accepted. Wrong-secret rejected.      |
| `apps/runtime/src/services/execution/__tests__/workflow-auth-token.test.ts` | `mintWorkflowAuthToken()` always produces `sub: 'service:runtime'`, carries `tenantId` / `projectId` / `role: OWNER` / `internal: true` / `type: 'access'`. `projectId` claim omitted when not supplied. Wrong-secret rejected on verify. |

The two tests together lock both sides of the runtime → workflow-engine auth contract.

## Final Verdict

- [x] No CRITICAL findings open
- [x] HIGH finding (F-2) closed with boundary tests
- [x] Parallel paths verified identical across workflow-engine / search-ai / search-ai-runtime
- [x] Tenant isolation invariant preserved
- [x] End-user identity propagation preserved via `triggerMetadata.agentSession` (independent of JWT `sub`)
- [x] Audit log complete (this document)

F-1 and F-3 acknowledged and accepted as-is per maintainer decision. F-4 and F-5 are informational and require no action in this change.
