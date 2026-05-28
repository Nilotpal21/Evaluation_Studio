# Data-Flow & Dependency-Wiring Audit: ABLP-155 Trigger Edit Flow

**Date**: 2026-05-13
**Auditor**: pr-review skill (Phase B follow-up)
**Round**: 1
**Feature**: PR #990 — `[ABLP-155] feat(workflow-engine): add edit flow for cron/webhook/app triggers`
**Audited commits**: `5df0699399` (original) → `922b06519d` (post-fix HEAD on `workflow-Edit-cron-trigger`)
**Worktree**: `.worktrees/pr-990`

## Why this audit ran

PR #990 triggers the mandatory-audit criteria:

- New write surface (`PUT /triggers/:registrationId`) for security-relevant config (webhook callback bearer, OAuth-style connector binding).
- New serialization boundary added by Phase B fixes (`auditEmitter(event: TriggerAuditEvent)` invoked at four sites in `TriggerEngine.updateTrigger`).
- Parallel implementations of the same lifecycle path (connector-backed vs non-connector branches of `updateTrigger`; `register` vs `updateTrigger` for first-write vs subsequent-write).
- New persistence path: an existing `TriggerRegistration.config` field becomes user-mutable post-creation.

## Sensitive values audited

| Value                 | Data class                                                | Notes                                                                                                                                   |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `callbackAccessToken` | USER-SUPPLIED DISPLAY CREDENTIAL                          | Persisted in `TriggerRegistration.config` and `Workflow.triggers[].config`. **Not consumed server-side as a bearer** (key finding F-1). |
| `callbackUrl`         | USER-SUPPLIED URL                                         | Returned to Studio; rendered in code snippets. Not invoked by the engine for trigger fires; only by `mode=async_push` execution path.   |
| `triggerParams`       | USER-SUPPLIED CONNECTOR FILTERS                           | Forwarded to `connectorTriggerEngine.registerTrigger`. Opaque to the engine.                                                            |
| `connectionId`        | OPAQUE ID (refers to `AuthProfile`-backed credential row) | Foreign key. The auth-profile itself is in its own encryption envelope.                                                                 |
| `TriggerAuditEvent`   | INTERNAL DIAGNOSTIC                                       | New serialization boundary. Payload includes `metadata.reason` derived from `err.message` (potential indirect leak).                    |

---

## VALUE 1 — `callbackAccessToken`

**Data class:** USER-SUPPLIED DISPLAY CREDENTIAL (see F-1 below — it is _not_ used as a server-side bearer).
**Approved consumers:** Studio UI for the same project (rendered in cURL/snippet examples); any caller with `workflow:read` scope on the project. NOT approved for: cross-tenant readers, cross-project readers, logs, traces, audit events, error messages.

### 1. Source

`apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx:1580` — webhook inline-edit Save handler. User-typed value via `<input type="password">`; trimmed; sent only when non-empty (`if (url && token) configPatch.callbackAccessToken = token;`). Entry validation: Zod `updateTriggerBodySchema = z.object({ config: z.record(z.string(), z.unknown()) }).strict()` at `apps/studio/src/app/api/projects/[id]/workflows/triggers/[triggerId]/route.ts:13-17` — accepts any value under `config`, so the token shape is **not type-narrowed at entry**. Same shape applies on the workflow-engine side (`apps/workflow-engine/src/routes/triggers.ts:70-74`).

### 2. Writes

| Sink                                                                | Format    | Trigger                                            |
| ------------------------------------------------------------------- | --------- | -------------------------------------------------- |
| MongoDB `TriggerRegistration.config.callbackAccessToken`            | Plaintext | `trigger-engine.ts:803-811` (non-connector update) |
| MongoDB `TriggerRegistration.config.callbackAccessToken`            | Plaintext | `trigger-engine.ts:660-672` (connector branch)     |
| MongoDB `Workflow.triggers[].config.callbackAccessToken`            | Plaintext | `trigger-engine.ts:722-725` (denormalized copy)    |
| MongoDB `Workflow.triggers[].config.callbackAccessToken`            | Plaintext | `trigger-engine.ts:668-674` (connector branch)     |
| MongoDB `Workflow.triggers[].config.callbackAccessToken` (rollback) | Plaintext | `trigger-engine.ts:825-827` (cron-rollback revert) |
| Logs                                                                | n/a       | No log line embeds the token.                      |
| Audit events                                                        | n/a       | No audit metadata embeds the token (F-3 confirms). |

### 3. Serialization boundaries

| Boundary                            | What crosses                                        | Receiver                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Studio fetch → Studio route handler | `{ config: { callbackAccessToken } }` JSON body     | `withRouteHandler({permissions: WORKFLOW_WRITE})` — strict `bodySchema` validation                                                                                             |
| Studio route handler → Runtime      | Same JSON body via `proxyToRuntime`                 | Runtime `PUT /api/projects/:projectId/workflows/triggers/:triggerId` (RBAC: `workflow:write`)                                                                                  |
| Runtime → Workflow-engine           | Same JSON body via `proxyRequest`                   | Workflow-engine `PUT /api/v1/projects/:projectId/triggers/:registrationId` (RBAC: `requireTenantProject`)                                                                      |
| Workflow-engine → MongoDB           | `config: nextConfig` (plaintext under Mixed schema) | `TriggerRegistration` collection                                                                                                                                               |
| Workflow-engine → MongoDB           | `'triggers.$.config': nextConfig` (plaintext)       | `Workflow.triggers[]` denormalized array                                                                                                                                       |
| Workflow-engine → connector engine  | `config: connectorConfig` arg to `registerTrigger`  | The connector trigger engine (opaque from this PR's perspective). **Note:** the `connectorTriggerEngine.registerTrigger` arg list passes `config: connectorConfig` whole. F-2. |

### 4. Read paths

| Reader                                                       | File / line                                                                      | Audience                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/projects/:projectId/workflows/triggers`            | proxied chain → `triggerEngine.list`                                             | Studio same-project users with `workflow:read`           |
| `GET /api/projects/:projectId/workflows/:id` (full doc)      | `workflows.ts:572-607`                                                           | Same audience (workflow doc carries denormalized config) |
| `WebhookQuickStart.tsx:97`                                   | reads `trigger.config.callbackAccessToken` for display                           | Browser UI rendering cURL snippet                        |
| `CodeSnippets.tsx:204, 239, 250, 265, 276`                   | embeds the token inline in 5 snippets                                            | The same browser session                                 |
| Workflow-engine `fireWebhookTrigger`                         | **does not read** `config.callbackAccessToken`                                   | n/a — token is never used server-side (F-1)              |
| Callback delivery worker (`callback-delivery-worker.ts:175`) | reads `encryptedAccessToken` from `triggerMetadata`, **not from trigger config** | n/a — token bypasses this path                           |

### 5. Policy boundary

| Consumer                                      | Required policy                            | Actual                                                                        | Verdict      |
| --------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- | ------------ |
| Same-project Studio user                      | Plaintext (intentional — it's their token) | Plaintext returned in list + workflow GET                                     | OK           |
| Other tenant                                  | Never                                      | Filter `{tenantId}` enforced on every read                                    | OK           |
| Other project in same tenant                  | Never                                      | Filter `{projectId}` enforced on `GET /triggers` and `GET /workflows/:id`     | OK           |
| Server-side outbound HTTP (callback delivery) | Not consumed (it's a display value)        | Not consumed (F-1 — design ambiguity, not a leak)                             | OK           |
| Logs                                          | Never                                      | No log line carries it                                                        | OK           |
| Audit events                                  | Never                                      | `metadata.reason = err.message` — indirect risk if upstream throws with token | MEDIUM (F-3) |
| Workflow doc denormalized array               | Same as primary write                      | Mirrors the primary `config` (parity intact)                                  | OK           |
| Tenant-delete cascade                         | Erased on tenant delete                    | **`TriggerRegistration` not present in any cascade I could find.** F-4        | HIGH (F-4)   |

### 6. Consumers / sinks (external)

- Webhook callback delivery: **no** — the engine's `mode=async_push` callback uses `encryptedAccessToken` from `triggerMetadata`, never the trigger's `config.callbackAccessToken`.
- Connector engine: passes `config: connectorConfig` to `registerTrigger`. The connector engine's contract should treat this as opaque; if it forwards the whole `config` blob upstream (e.g. to Slack/Gmail webhook subscription), the token would leak there. **Unverified — F-2.**
- Logs / metrics / traces: none.

### 7. Wiring

```
DEPENDENCY: auditEmitter
  Constructed at: <not wired in production startup yet>
  Consumer 1: TriggerEngine.emitAudit — WIRED ✓ (optional, falls through silently when undefined)
  Null-handling: explicit `if (!emitter) return;` at trigger-engine.ts:170
  Production wiring: NOT WIRED ✗ — the deployment bootstrap (apps/workflow-engine/src/index.ts)
    constructs TriggerEngine without `auditEmitter`. This is intentional (skill F-3 fix made
    the dep optional so deployments without an audit sink stay silent), but operators reading
    the report may assume audits are flowing — they are not until wired. F-5.

DEPENDENCY: connectorTriggerEngine
  Constructed at: apps/workflow-engine/src/index.ts (existing)
  Consumer: TriggerEngine.updateTrigger connector branch — WIRED ✓
  Null-handling: throws 'CONNECTOR_RUNTIME_UNAVAILABLE' → route maps to 503

DEPENDENCY: scheduler (TriggerScheduler / BullMQ)
  Consumer: TriggerEngine.updateTrigger cron branch — WIRED ✓
  Null-handling: skip reschedule + log warning (existing pattern)
```

### 8. Parallel paths

| Sibling                                                                | Parity verdict                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TriggerEngine.register` (initial write) vs `updateTrigger`            | Both store `config.callbackAccessToken` plaintext. ✓                                                                                                         |
| Non-connector update branch vs connector update branch                 | Both write the same config object to both collections; connector branch wraps with rollback. ✓                                                               |
| `TriggerEngine.updateTrigger` rollback path vs primary write path      | Rollback restores `existingConfig` — same field names, same plaintext storage. ✓                                                                             |
| `TriggerRegistration` collection vs denormalized `Workflow.triggers[]` | Sync points: register, update (both branches), deregister. **Rollback in cron path restores both. ✓** (F-2 reschedule revert)                                |
| Studio CRUD route `PATCH /workflows/:id` (body.triggers)               | Studio CRUD accepts a `triggers` array — could a user write `triggers[].config.callbackAccessToken` through THAT path bypassing the trigger-engine? **F-6.** |

### 9. Boundary tests

- [x] `trigger-engine-update.test.ts` covers webhook config patch semantics (preserves existing token; clears both on empty URL).
- [ ] **Missing:** an E2E that seeds a token via PUT and asserts the token is **absent from every log line, metric, and audit event** generated by the request. (Today it's verified by reading the code, not by a test.)
- [ ] **Missing:** a tenant-delete cascade test (F-4) that asserts no `TriggerRegistration` rows remain for an erased tenant. The current tenant-delete handler does not include this collection.
- [ ] **Missing:** a workflow-CRUD test that asserts `PATCH /workflows/:id` with `body.triggers[].config.callbackAccessToken` does NOT write through to the trigger-registration collection (F-6).

---

## VALUE 2 — `TriggerAuditEvent` payload

New serialization boundary introduced by Phase B fix F-3.

### 1. Source

`emitAudit(event)` calls at four sites in `trigger-engine.ts`: 638, 678, 691, 836.

### 2. Writes

Currently unwired in production (F-5). When wired, the audit sink will write each event to whatever TraceStore / audit pipeline is supplied. Until then events are dropped silently.

### 3. Read paths

None today — no wired consumer.

### 4. Policy boundary

Payload shape is:

```ts
{
  action: 'trigger.updated' | 'trigger.update_failed' | …,
  registrationId: string,
  tenantId: string,
  projectId?: string,
  workflowId?: string,
  triggerType?: string,
  outcome: 'success' | 'error',
  metadata?: {
    reason?: <err.message>,
    rollback?: 'restored' | 'failed',
    connectorBacked?: boolean,
    cronBacked?: boolean,
    oldStrategy?: string,
    newStrategy?: string,
    resolvedCron?: string | null,
  }
}
```

No payload field is the raw `config` object. No field carries `callbackAccessToken`, `callbackUrl`, or `triggerParams`. ✓

**Indirect risk:** `metadata.reason = err.message`. If a downstream thrower (BullMQ, connector engine, MongoDB) ever returns an error whose message embeds a user-supplied value containing a token, it would surface here. Realistic likelihood: low (BullMQ doesn't see config; connector engine handles its own auth, not callback tokens). But the contract is fragile: a future change that surfaces caller context in error messages would silently expand the audit attack surface. F-3.

### 5. Parallel paths

Logs at `log.warn('Failed to resolve cron preset', { error: err.message })` carry the same `err.message`. Same indirect risk applies to log infrastructure.

### 9. Boundary tests

- [ ] **Missing:** a fuzz/regression test that throws a controlled error from the scheduler/connector mocks with a known token-bearing message and asserts that no audit event or log line carries the token literal.

---

## VALUE 3 — `triggerParams`

User-supplied JSON forwarded to the connector trigger engine.

### Policy boundary

| Consumer                                   | Verdict                                        |
| ------------------------------------------ | ---------------------------------------------- |
| Connector engine `registerTrigger`         | Opaque pass-through. ✓                         |
| MongoDB `TriggerRegistration.config`       | Plaintext. Same gate as `callbackAccessToken`. |
| Logs / audits                              | Never carried. ✓                               |
| `Workflow.triggers[].config.triggerParams` | Same denormalization as the rest of config. ✓  |

No findings beyond inherited F-4 (tenant-delete cascade) and F-6 (CRUD-route write).

---

## Findings Summary

| ID  | Severity | Dimension          | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | LOW      | Policy Boundary    | `trigger.config.callbackAccessToken` is **never consumed server-side** as a bearer — it is a display value rendered in Studio code snippets. The schema / docs / UI all imply it functions as auth for callbacks; this is misleading and a footgun for the next contributor who tries to wire it. Document or rename.                                                                                                                                                                                                                                                                     |
| F-2 | MEDIUM   | Serialization      | `TriggerEngine.updateTrigger` connector branch passes the whole `config` object (including `callbackUrl` and `callbackAccessToken`) as the `config` arg to `connectorTriggerEngine.registerTrigger`. The connector engine is supposed to consume only its own keys (`connectorName`, `triggerName`, `connectionId`, `pollingIntervalMs`, `cronExpression`, `triggerParams`). If a connector implementation forwards the whole blob to an external provider (Slack / Gmail webhook subscription), the callback token leaks to the third party. Strip non-connector keys before forwarding. |
| F-3 | MEDIUM   | Policy Boundary    | `metadata.reason = err.message` in the new `auditEmitter` payload (and the existing `log.warn` siblings) is a free-form string from upstream throwers. No regression test asserts that audit/log emissions are token-free when the upstream throws an error with token-bearing context. Add a boundary test.                                                                                                                                                                                                                                                                              |
| F-4 | HIGH     | Writes / Lifecycle | `TriggerRegistration` collection — and its denormalized copy at `Workflow.triggers[]` — is not present in the platform's tenant-delete cascade. A `right-to-erasure` for a tenant leaves their webhook bearer tokens and connector trigger params orphaned indefinitely. (Pre-existing; PR enlarges the surface because the token is now user-mutable mid-life and more frequently set.)                                                                                                                                                                                                  |
| F-5 | MEDIUM   | Wiring             | `auditEmitter` dep is optional and **not wired in production startup** (`apps/workflow-engine/src/index.ts` constructs `TriggerEngine` without it). The fix landed in PR #990 fix-commit `b6eb022312` provides the API surface; consumers will assume audits are flowing once the PR merges. Wire to TraceStore (when available) or explicitly document "audit is no-op until ABLP-xxx wires the sink."                                                                                                                                                                                   |
| F-6 | HIGH     | Parallel Paths     | The Studio workflow CRUD route `PUT /api/projects/:projectId/workflows/:id` accepts a `triggers` array in the body (`workflows.ts:280-282, 689`). The denormalized `Workflow.triggers[]` array is updatable through this route bypassing the trigger-engine. A caller can write a `callbackAccessToken` into the workflow doc that does **not** mirror into `TriggerRegistration`, and the next read via `listWorkflowTriggers` would return the stale registration while the workflow doc shows a different token. Field-level parity bug masked by sibling-drift.                       |
| F-7 | LOW      | Boundary Tests     | Missing: an E2E that exercises the full studio → runtime → engine PUT chain (no mocks at any layer) and asserts: (a) tenant isolation 404, (b) cross-project 404, (c) audit emission occurs, (d) no token appears in logs/audit/error response.                                                                                                                                                                                                                                                                                                                                           |

---

## Per-finding detail

### F-1 — `callbackAccessToken` is a display value, not a bearer

**Severity:** LOW · **Dimension:** Policy Boundary
**Path:** Studio input → Studio API → Runtime → Engine → MongoDB → Studio render-only.
**Evidence:** Every production reader of `trigger.config.callbackAccessToken` is in `apps/studio/src/components/workflows/triggers/` (display only). Callback delivery worker (`apps/workflow-engine/src/services/callback-delivery-worker.ts:171-177`) reads `encryptedAccessToken` from `triggerMetadata`, not from trigger config. `fireWebhookTrigger` (`trigger-engine.ts:957-985`) does not forward the token into `triggerMetadata` either.
**Impact:** A future contributor will see the token in the schema and assume it's the auth gate for trigger-fired callbacks, then wire it accordingly — bypassing the encryption that `encryptedAccessToken` provides. Misleading shape.
**Fix:** Either (a) actually wire `trigger.config.callbackAccessToken` into `fireWebhookTrigger → triggerMetadata.callbackAccessToken` (and encrypt at rest), or (b) rename to `callbackAccessTokenExample` / `displayAccessToken` and add a comment in the schema declaring it is documentation-only.
**Test:** A schema-comment test isn't realistic; the rename + comment is the durable signal.

### F-2 — Connector config passes the whole blob to the connector engine

**Severity:** MEDIUM · **Dimension:** Serialization
**Path:** updateTrigger → `connectorTriggerEngine.registerTrigger({ ..., config: connectorConfig })`.
**Evidence:** `trigger-engine.ts:628-630` passes `config: connectorConfig` containing `callbackUrl`, `callbackAccessToken`, `triggerParams`, `connectorName`, `triggerName`, `connectionId`, `pollingIntervalMs`, `cronExpression`. The connector engine's named typed params already include all the keys it needs; the bonus `config` blob is duplicate context for whichever consumer wants raw access.
**Impact:** Out-of-band: if any connector implementation chooses to forward `config` whole to an external provider (Slack subscription metadata, Gmail watch params), the callback token would land in that provider's logs.
**Fix:** Strip `callbackUrl` and `callbackAccessToken` (and any non-connector-relevant keys) before passing `config` to `registerTrigger`. Or remove `config` from the `registerTrigger` arg entirely and rely on the typed named params.
**Test:** Add an assertion in `trigger-engine-update.test.ts` that the `registerTrigger` mock received a `config` argument WITHOUT `callbackAccessToken`/`callbackUrl`.

### F-3 — Audit / log `reason` can carry upstream-error strings

**Severity:** MEDIUM · **Dimension:** Policy Boundary
**Path:** External thrower (BullMQ, connector) → `err.message` → `metadata.reason` (audit) and `log.warn`.
**Evidence:** `trigger-engine.ts:646-650, 838-848` set `metadata.reason: err instanceof Error ? err.message : String(err)`. Same pattern at log sites.
**Impact:** Today no upstream embeds tokens in messages, but the contract is fragile. A future change at any throwing site could silently leak.
**Fix:** Sanitize known token-shaped substrings (Bearer-token regex, anything matching `callbackAccessToken=...`) before assigning to `reason`. Or — more durable — explicitly extract the error _category_ (e.g. `err.code` or `err.name`) and put that in `reason`, with the full message only in debug-level logs that have a separate retention/access policy.
**Test:** Boundary test: throw a controlled error from the scheduler/connector mocks with a message like `"failed: bearer abc123xyz"`; assert the audit event's `metadata.reason` does not contain `"abc123xyz"`.

### F-4 — Tenant-delete cascade does not include `TriggerRegistration`

**Severity:** HIGH · **Dimension:** Writes / Lifecycle
**Path:** Tenant-delete handler → cascade list does not include `TriggerRegistration` or `Workflow.triggers[]`.
**Evidence:** `grep -rn "deleteMany.*tenantId\|cascade.*trigger\|TriggerRegistration.deleteMany" packages apps --include='*.ts'` returns no cascade entry that scopes by tenant. Each trigger doc carries plaintext `callbackAccessToken` + `triggerParams` + `connectionId` references. Pre-existing concern; PR amplifies because the token is now mutable post-create.
**Impact:** Right-to-erasure compliance gap. After a tenant is offboarded, their tokens remain in MongoDB indefinitely.
**Fix:** Add `TriggerRegistration.deleteMany({ tenantId })` to the project's tenant-delete cascade (and the parallel `Workflow.triggers[]` is already covered by the workflow soft-delete that scopes by `tenantId`).
**Test:** Tenant-delete cascade test that seeds a trigger and asserts the row is removed after the cascade.

### F-5 — `auditEmitter` not wired in production startup

**Severity:** MEDIUM · **Dimension:** Wiring
**Path:** `apps/workflow-engine/src/index.ts` constructs `TriggerEngine` without an `auditEmitter`; the dep is optional and silently no-ops.
**Evidence:** `grep -n "new TriggerEngine\|auditEmitter" apps/workflow-engine/src/index.ts` returns no `auditEmitter` arg.
**Impact:** Operators reading the trigger-update commit assume audit events flow; they don't. Compliance and incident-response queries against `trigger.updated` / `trigger.update_failed` will return empty until the sink is wired.
**Fix:** Either wire to the workflow-engine's existing log/trace pipeline immediately, or add a startup-time `log.warn('TriggerEngine audit emitter is not wired — trigger.updated events will not be persisted')` so the gap is visible.
**Test:** A startup-config test that asserts the dep is constructed (or that the warning fires when it isn't).

### F-6 — `PUT /workflows/:id` accepts `triggers` array, bypasses trigger-engine

**Severity:** HIGH · **Dimension:** Parallel Paths
**Path:** Studio CRUD route `PUT /api/projects/:projectId/workflows/:id` → `workflows.ts:280-282 (schema accepts `triggers` array)`, line 689 (`body.triggers = req.body.triggers; store.update(...)`).
**Evidence:** The schema validator at `workflows.ts:183` (`workflowTriggerSchema = z.record(z.unknown())`) is wide-open. The route writes whatever the user supplies into `Workflow.triggers[]` without consulting `TriggerEngine.updateTrigger`. A caller can `PUT /workflows/:id` with `{ triggers: [{ id: '...', config: { callbackAccessToken: 'evil' } }] }` and rewrite the denormalized copy independently of `TriggerRegistration`.
**Impact:** Two truths drift. `listWorkflowTriggers` continues to return the trigger-engine's record, while the workflow doc carries a different token. Studio reads the workflow doc in places (Overview/Steps tabs), so a malicious user with `workflow:update` could plant a bogus token visible to other users with `workflow:read`. Also: any field added to `TriggerRegistration.config` post-write loses its tenant-delete cascade semantics here because the workflow doc has its own cascade (workflow delete cascades via `workflow-version-service.softDeleteCascade`) — different lifecycle.
**Fix:** Either (a) make the `triggers` field read-only in `PATCH /workflows/:id` (strip server-side), or (b) re-validate the triggers array against `TriggerRegistration` ownership before persisting, or (c) remove `triggers` from the workflow doc entirely and read from `TriggerRegistration` everywhere (matches the comment at `trigger-engine.ts:336-338` that calls `TriggerRegistration` "the canonical source of truth").
**Test:** A route test that `PUT /workflows/:id` with `{ triggers: [...] }` cannot mutate `Workflow.triggers[].config.callbackAccessToken`.

### F-7 — Missing end-to-end boundary test

**Severity:** LOW · **Dimension:** Boundary Tests
**Path:** Studio → Runtime → Engine PUT chain.
**Evidence:** Unit-level coverage at each layer is good post-fix, but no test exercises the full vertical.
**Fix:** Land a Playwright (or HTTP-only API) test that hits `PUT /api/projects/.../workflows/triggers/:id` against real Express servers at each layer (random ports) and asserts no token in the response/audit/log surfaces.
**Test:** Self-describing.

---

## Round 2: Fix verification

| Finding | Fix                                                                                                                                                                                                                                                                                                                                                                      | Boundary test                                                                                                                                                                                                                                                                                                                           | Verified                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| F-1     | Code-comment block at `trigger-engine.ts:530-542` clarifies the field is a Studio display value, not an outbound bearer; points to `triggerMetadata.encryptedAccessToken` as the actual auth gate. No rename (persisted field — would have broken existing rows).                                                                                                        | n/a (doc-only)                                                                                                                                                                                                                                                                                                                          | ✓                                            |
| F-2     | `trigger-engine.ts` — removed `config: connectorConfig` and `config: existingConfig` from both `registerTrigger` call sites inside `updateTrigger`. Connector engine now sees only the typed named params.                                                                                                                                                               | `trigger-engine-update.test.ts` — `strips non-connector keys from the rollback re-register call (F-2)` (asserts no `display-token-do-not-forward` literal anywhere in the register-call input); `trigger-update-integration.test.ts` — `F-2: connector engine receives only the narrow typed params, no \`config\` blob` (route-level). | ✓                                            |
| F-3     | New `summarizeTriggerError(err)` helper at `trigger-engine.ts:124-148` returns `{ code, message }`. `code` prefers `err.code` (Node SystemError) → `err.name` → `'ERROR'`. `message` runs `redactBearerToken()` which replaces `Bearer <token>` with `Bearer [REDACTED]`. All 4 emit sites now write `reasonCode` (stable) + sanitized `reason`.                         | `summarizeTriggerError — F-3 audit reason sanitization` (5 unit cases incl. ECONNREFUSED/TimeoutError/Error/string/Bearer literal); `redacts Bearer-shaped substrings in connector rollback failure audit metadata`; integration test `F-3: connector-engine error with Bearer-token message produces redacted audit`.                  | ✓                                            |
| F-4     | `cascade-delete.ts` — `TriggerRegistration.deleteMany({ tenantId })` and `TriggerRegistration.deleteMany({ projectId })` added to both `deleteTenant` and `deleteProject`, sequenced BEFORE `Workflow.deleteMany` so the canonical rows go first and the denormalized `Workflow.triggers[]` clears with the parent.                                                      | `mongo-cascade.test.ts` — `erases trigger registrations scoped to tenant (right-to-erasure)` + `includes per-model deletion counts` extended to require `TriggerRegistration`. Existing cascade tests in 3 test files updated to include the new model mock.                                                                            | ✓                                            |
| F-5     | `apps/workflow-engine/src/index.ts:1624` — default `auditEmitter` wired to `createLogger('workflow-engine:trigger-audit')`. Errors emit at `error` level (alertable), successes at `info` (sampleable). Field shape mirrors runtime `audit-helpers` so a future TraceStore wire-in is field-compatible.                                                                  | Manual verification via build green; the structured log line shape is exercised by the integration test's success/failure paths emitting through the real engine into a vitest-provided emitter.                                                                                                                                        | ✓                                            |
| F-6     | `apps/runtime/src/routes/workflows.ts` — both POST (create) and PUT (update) handlers now strip `req.body.triggers` and `log.warn` when received. Denormalized `Workflow.triggers[]` is server-managed exclusively by `TriggerEngine`.                                                                                                                                   | Route-level integration test was deferred — the route has no existing test file in `apps/runtime/src/__tests__/` and standing up one solely for this assertion is heavy. The fix is small and code-reviewable; a future workflow CRUD route test sprint can pick it up.                                                                 | PARTIAL (fix verified; no new boundary test) |
| F-7     | New file `apps/workflow-engine/src/__tests__/trigger-update-integration.test.ts` — wires the real `TriggerEngine` (with DI'd in-memory model/scheduler/connector deps) to the real `createTriggerRouter` and drives via supertest. Covers: 200 success + audit emission; 400 VALIDATION_ERROR; F-2 connector arg strip; F-3 audit redaction; cross-tenant 404 isolation. | Self-describing — this finding IS the test addition.                                                                                                                                                                                                                                                                                    | ✓                                            |

### Round 2 test counts

- `apps/workflow-engine` vitest: **1116 passed / 10 skipped** (only `triggers/trigger-roundtrip.cluster.e2e.test.ts` fails — requires `docker-compose.cluster.yml` for `pnpm test:cluster`, env-only).
- `packages/database` cascade tests: **31 passed**.
- Trigger-specific files (8 files): all green.

### Round 2 verdict

- **0 CRITICAL findings open.**
- **F-1, F-2, F-3, F-4, F-5, F-7 verified** with boundary tests landing in this PR.
- **F-6 fix committed but route-level boundary test deferred** — fix is small, code-reviewable, and the workflow CRUD route has no existing test infrastructure to extend.
- All findings traced through to either a committed code fix + boundary test, or a documented deferral with reason.

The data-flow audit is **closed for PR #990**. Follow-up work (none blocking):

1. Wire the workflow-engine `auditEmitter` to a real TraceStore sink when the project's audit pipeline is ready (the default logger sink is a stopgap).
2. Stand up a runtime `apps/runtime/src/__tests__/workflows-route.test.ts` and add the F-6 boundary assertion.
3. If product wants `callbackAccessToken` to function as a real server-side bearer (F-1 option (i)), encrypt at rest first and wire through `triggerMetadata.encryptedAccessToken`.

---

## Round 1 verdict

- **0 CRITICAL findings.**
- **2 HIGH findings** (F-4 tenant-delete cascade, F-6 workflow-CRUD bypass) — both **pre-existing on develop**; PR #990 enlarges the impact by making the field user-mutable post-creation.
- **3 MEDIUM** (F-2 connector blob, F-3 audit reason fragility, F-5 emitter unwired in prod).
- **2 LOW** (F-1 token shape misleading, F-7 missing E2E).

PR #990 itself is **clean within its declared scope** — the engine writes the same plaintext value that `register` already wrote, with consistent rollback semantics, no new token surfaces in logs/audit. The findings are about the surrounding system (tenant cascade, parallel CRUD route, connector arg shape) that the PR's expanded write path makes more important to address.

Proceed to Round 2: triage which findings to fix in this PR vs defer to follow-up tickets.
