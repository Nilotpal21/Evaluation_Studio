# SDLC Log: Unified Deployment Endpoints — Feature Spec

**Phase**: Feature Spec
**Date**: 2026-04-10
**Status**: APPROVED (R2 passed)

---

## Oracle Decisions

All 15 clarifying questions were answered by the product-oracle agent. No AMBIGUOUS items required user escalation.

### Scope & Problem

| #   | Question                                                  | Classification | Decision                                                                 |
| --- | --------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Q1  | Primary driver: workflow exposure or broader unification? | INFERRED       | Broader unification — three parallel surface models need a unified layer |
| Q2  | Replace existing models or abstraction layer?             | DECIDED        | Abstraction layer on top — existing models carry domain-specific state   |
| Q3  | Migration story for existing deployments?                 | DECIDED        | Forward-only in Phase 1; optional backfill in Phase 2                    |
| Q4  | Cross-deployment endpoint sharing?                        | DECIDED        | No — each endpoint scoped to exactly one deployment                      |
| Q5  | Scheduled agents in Phase 1?                              | DECIDED        | Deferred — TriggerRegistration requires workflowId                       |

### User Stories & Requirements

| #   | Question                 | Classification | Decision                                                                             |
| --- | ------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| Q6  | Who creates endpoints?   | INFERRED       | Both platform (auto-create during deploy) and user (Studio/API management)           |
| Q7  | Versioned or mutable?    | DECIDED        | Mutable without redeployment; version resolution is deployment-pinned                |
| Q8  | Auth modes supported?    | INFERRED       | All existing channel manifest auth modes (sdk_auth, api_key, hmac, jwt, token, none) |
| Q9  | Rate limiting scope?     | INFERRED       | Per-endpoint override on top of always-on tenant-level baseline                      |
| Q10 | Coexist or replace URLs? | DECIDED        | Coexist — existing URLs registered with external providers can't be changed          |

### Technical & Architecture

| #   | Question                             | Classification | Decision                                                             |
| --- | ------------------------------------ | -------------- | -------------------------------------------------------------------- |
| Q11 | Which service owns it?               | ANSWERED       | Runtime — all deployment infrastructure already there                |
| Q12 | Interaction with ChannelAdapter?     | INFERRED       | Full adapter pipeline executes for conversational endpoints          |
| Q13 | Denormalize or reference at runtime? | DECIDED        | Reference at request time — existing DeploymentResolver pattern      |
| Q14 | Health monitoring?                   | DECIDED        | Standardized health on all types, extending trigger/webhook patterns |
| Q15 | Observability contract?              | ANSWERED       | endpoint.invoked TraceEvent per platform invariant #4                |

---

## Audit Results

### Round 1 — NEEDS_REVISION

2 CRITICAL, 6 HIGH, 3 MEDIUM findings.

**CRITICAL fixes applied:**

1. FR-2 reconciled to include channel connections alongside SDK channels and triggers
2. FR-3 split into FR-3a (resolution returning 404) and FR-3b (auth delegation with 6 modes)

**HIGH fixes applied:** 3. FR-5 adds explicit deploymentId/environment filtering 4. FR-10 clarified: agentVersionManifest for conversational, workflowVersionManifest for triggers, adapter pipeline for channel connections 5. `createdBy` field added to data model 6. FR-12 documents new Redis key namespace `ratelimit:endpoint:{endpointId}` 7. Auth delegation subtask 5.4 added to Phase 2 delivery plan 8. Open Question 5 (provider URLs) resolved, moved to Section 7 as design decision

**MEDIUM fixes applied:** 9. Testing scenarios 1-2 corrected from `ingress.spec.ts` to `isolation.spec.ts` 10. FR-10 E2E scenario added (version resolution via unified URL) 11. Design Rationale section added with 3 alternatives considered

### Round 2 — APPROVED

0 CRITICAL, 4 HIGH, 2 MEDIUM findings.

**HIGH fixes applied:**

1. `webhook_subscription` removed from targetType enum (outbound-only, no inbound path)
2. Delivery plan subtask 2.1 updated to include channel connections
3. Rollback behavior documented in Section 7 (new deployment = fresh endpoints)
4. Provider-registered invocation behavior moved to Open Question 5

**MEDIUM fixes applied:** 5. Auth middleware subtask 3.3 added to Phase 1 CRUD delivery plan 6. Auth rejection test scenario (#14) added to Section 17

---

## Files Created/Modified

- `docs/features/unified-deployment-endpoints.md` — Feature spec (APPROVED)
- `docs/testing/unified-deployment-endpoints.md` — Testing guide placeholder
- Updated `docs/features/README.md` — Added entry #91
- Updated `docs/testing/README.md` — Added entry #91

---

## Open Questions (from spec §15)

1. Should deployment `endpointSlug` be user-configurable?
2. How should endpoint paths be namespaced?
3. Webhook verification challenge handling at endpoint vs adapter layer?
4. Endpoint CRUD permissions: reuse deployment or new endpoint permissions?
5. Provider-registered channel connection endpoints: invocable, discovery-only, or invocable with warning?
