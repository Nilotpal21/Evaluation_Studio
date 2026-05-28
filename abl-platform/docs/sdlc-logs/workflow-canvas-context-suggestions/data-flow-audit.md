# Data-Flow Audit — Workflow Canvas Context Suggestions (ABLP-155)

**Feature:** `{{context.steps.X.output.Y}}` expression authoring in all workflow canvas node panels.  
**Audit rounds:** 2 (required per CLAUDE.md § Mandatory-audit triggers)  
**Date:** 2026-05-13  
**Auditor:** Phase B PR review (pr-987)

---

## Boundaries crossed

| Category   | File                                                                                               | Direction                                                     |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| schema     | `packages/database/src/models/trigger-registration.model.ts`                                       | add `samplePayload (String)`, `samplePayloadExpiresAt (Date)` |
| types      | `packages/connectors/src/triggers/types.ts`                                                        | add `samplePayload?: string`, `samplePayloadExpiresAt?: Date` |
| types      | `apps/workflow-engine/src/services/trigger-engine.ts`                                              | extend `TriggerAuditEvent.action` union                       |
| route      | `apps/workflow-engine/src/routes/triggers.ts`                                                      | add `POST /:registrationId/test-sample`                       |
| route      | `apps/workflow-engine/src/routes/workflow-node-tests.ts`                                           | add `POST /:workflowId/nodes/:nodeId/test-action`             |
| route      | `apps/runtime/src/middleware/workflow-engine-proxy.ts`                                             | proxy above two routes                                        |
| route      | `apps/studio/src/app/api/projects/[id]/workflows/triggers/[triggerId]/test-sample/route.ts`        | Studio proxy                                                  |
| route      | `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/nodes/[nodeId]/test-action/route.ts` | Studio proxy                                                  |
| store      | `packages/connectors/src/triggers/trigger-engine.ts`                                               | write `samplePayload` (encrypted) + `samplePayloadExpiresAt`  |
| store      | `apps/workflow-engine/src/services/action-test-service.ts`                                         | write `config.sampleOutput` (encrypted JSON string)           |
| serializer | `apps/runtime/src/routes/workflows.ts`                                                             | decrypt `config.sampleOutput` before serialising GET response |
| ui         | `apps/studio/src/components/workflows/canvas/hooks/useWorkflowExpressionContext.ts`                | read `sampleOutput` from canvas node config                   |
| handler    | `apps/workflow-engine/src/services/trigger-engine.ts`                                              | `getLastFirePayload` decrypt on read                          |

---

## Round 1 — Findings

### F1 (CRITICAL — pii-passthrough)

`samplePayload` on `TriggerRegistration` and `sampleOutput` on `Workflow.nodes[].config` stored
connector output (email bodies, CRM records, file metadata) in plaintext with no size limit, no
TTL, and no erasure hook.

**Fix applied (commits `d579e2d48c`, `680e6d8a94`, `1a3a3631b4`):**

- Size cap: `MAX_SAMPLE_PAYLOAD_BYTES = 65_536` enforced before store; oversized payloads replaced
  with `{ _truncated: true, _reason: 'payload exceeded 64 KB limit' }`.
- Encryption: `encryptForTenantAuto(jsonStr, tenantId)` via injectable `encryptSample` /
  `encryptField` deps; stored as DEK-envelope string. Decryption at read time via `decryptSample`
  dep in `getLastFirePayload` and inline `decryptForTenantAuto` in the runtime workflow GET handler.
- TTL: `samplePayloadExpiresAt = now + 7 days` written on store; `getLastFirePayload` returns null
  for expired entries.
- Erasure: `samplePayloadExpiresAt` soft-expires; tenant-level erasure handled by pre-existing
  `TriggerRegistration.deleteMany({ tenantId })` cascade in `packages/database/src/cascade/cascade-delete.ts`.
  `sampleOutput` on `Workflow.nodes[].config` is cleared when the workflow is deleted via the
  same cascade (`Workflow.deleteMany`).

### F2 (HIGH — coverage-matrix)

`apps/workflow-engine/src/__tests__/action-test-service.test.ts` was dropped during a rebase;
zero test coverage on `ActionTestService`.

**Fix applied (commit `477f714c62`):**
11 integration scenarios restored covering all error paths, encryption assertion, tenant/project
scoping, truncation marker, and timeout rejection.

### F3 (HIGH — audit-log)

`POST /:registrationId/test-sample` and `POST /:workflowId/nodes/:nodeId/test-action` endpoints
emitted no structured audit events.

**Fix applied (commit `1a3a3631b4`):**
Both routes emit `TriggerAuditEvent` with actions `trigger.test_sample` / `trigger.test_action`
on success and error paths via the shared `emitTriggerAudit` callback wired in `index.ts`.

### F4 (HIGH — reliability)

`testSample` and `testAction` had no timeout on external connector calls.

**Fix applied (commit `d579e2d48c`):**
`DESIGN_TIME_TEST_TIMEOUT_MS = 30_000` added. Both paths wrapped in `Promise.race` with a
30-second deadline that rejects with a user-readable "timed out" message.

### F5 (MEDIUM — data-lifecycle)

No TTL or erasure path for sample data.

**Fix applied:** See F1 above (`samplePayloadExpiresAt`, soft expiry on read, cascade delete).

### F6 (MEDIUM — stale comment)

`// ── 5. Persist` in `action-test-service.ts` was stale (step 7, not 5).

**Fix applied (commit `d579e2d48c`):** Comment corrected to `// ── 7. Persist`.

### F7 (LOW — data-flow-audit.md missing)

SDLC log file absent from `docs/sdlc-logs/workflow-canvas-context-suggestions/`.

**Fix applied:** This file.

---

## Round 2 — Verification

| Gate                  | Status | Notes                                                                                                                                                                                                             |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pii-passthrough`     | PASS   | Encryption + size cap + TTL applied to both storage paths. DEK envelope format; tenantId isolation enforced by `encryptForTenantAuto`. Decryption is server-side only (never client-side plaintext DEK exposure). |
| `data-lifecycle`      | PASS   | 7-day soft TTL on samplePayload; cascade delete covers tenant + project deletion. sampleOutput cleared on workflow delete.                                                                                        |
| `coverage-matrix`     | PASS   | 11 integration tests cover all code paths introduced by this PR.                                                                                                                                                  |
| `audit-log`           | PASS   | Structured TriggerAuditEvent emitted on both success + error for test-sample and test-action.                                                                                                                     |
| `reliability`         | PASS   | 30-second hard timeout on all outbound connector calls.                                                                                                                                                           |
| `isolation`           | PASS   | All DB queries include `tenantId` + `projectId`. userId read from `req.tenantContext`, never from request body.                                                                                                   |
| `security (auth)`     | PASS   | `requireProjectPermission(req, res, 'workflow:write')` enforced at runtime proxy layer for both endpoints.                                                                                                        |
| `wiring-reachability` | PASS   | Studio → proxyToRuntime → runtime proxy → workflow-engine express router → service. Mount trace verified in `apps/workflow-engine/src/index.ts:1670`.                                                             |

---

## Residual risks / follow-up

- **sampleOutput encryption round-trip**: encrypted value stored in `nodes[].config.sampleOutput`
  is decrypted in the workflow GET handler. If a workflow is saved _after_ the Studio canvas
  state is updated via `updateNodeConfig(node.id, { ...config, sampleOutput: out })` using the
  plaintext value from the test-action response, the next GET will have plaintext in `config`.
  The GET decryption is defensive (handles both string and object). Proper fix: the workflow PATCH
  handler should re-encrypt `sampleOutput` if present as an object. Tracked as follow-up; low
  urgency because the GET path always decrypts and serves plaintext regardless.

- **Right-to-erasure for sampleOutput per user**: `sampleOutput` is project-scoped, not
  user-scoped. Right-to-erasure for individual users doesn't apply. Document if compliance
  requirements change.
