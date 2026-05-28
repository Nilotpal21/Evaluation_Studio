# SDLC Log: External Agent Host — Feature Spec

**Date**: 2026-04-17
**Phase**: Feature Spec (Phase 1)
**Artifact**: `docs/features/external-agent-host.md`
**Testing Guide**: `docs/testing/external-agent-host.md`

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle (0 AMBIGUOUS — no user escalation needed).

### Scope & Problem (5 questions)

| #   | Question                                 | Classification | Decision                                                                                                                                         |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Is this a new capability or enhancement? | ANSWERED       | New capability — `source: 'external'` agent type                                                                                                 |
| 2   | Boundary — what's out of scope?          | DECIDED        | Step-level tracing, memory governance, visual debugging — accepted trade-offs                                                                    |
| 3   | Does this replace A2A integration?       | DECIDED        | No — extends A2A. Hosted agents use A2A for inbound; A2A-only remains for unhosted                                                               |
| 4   | Priority driver?                         | ANSWERED       | RFI requirements AD-001, AD-002, AD-003, AD-005 — enterprise customer demand                                                                     |
| 5   | Competing approaches?                    | DECIDED        | Evaluated: A2A-only (insufficient), framework SDK (too invasive), sidecar-only (no LLM governance). Chose LLM Proxy + sidecar + optional library |

### User Stories & Requirements (5 questions)

| #   | Question                       | Classification | Decision                                                                                                                                                     |
| --- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | Primary personas?              | ANSWERED       | ML engineer, platform operator, project admin, prompt engineer, security auditor, DevOps, supervisor author                                                  |
| 7   | Critical user journeys?        | ANSWERED       | Register → deploy → LLM call via proxy → trace; Canary deploy → rollback; A2A inbound routing                                                                |
| 8   | Must-have vs nice-to-have?     | DECIDED        | Phase 1 (LLM Proxy, deployment, config, A2A) = must-have; Phase 2 (tools, prompts, Python lib) = high priority; Phase 3 (Studio UI, advanced) = nice-to-have |
| 9   | Performance requirements?      | INFERRED       | < 50ms proxy overhead (auth + Tier 1 guardrails + budget), 1000 concurrent streams per pod                                                                   |
| 10  | Existing feature interactions? | ANSWERED       | Model Hub, Guardrails, Budget, A2A, Deployments, MCP, Channels, Rate Limiting, Encryption, Auth                                                              |

### Technical & Architecture (5 questions)

| #   | Question                                | Classification | Decision                                                                                                 |
| --- | --------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| 11  | New models or extend existing?          | DECIDED        | New parallel models (ExternalAgentConfig, ExternalAgentDeployment) — existing models are DSL-centric     |
| 12  | Feature gating pattern?                 | ANSWERED       | `createFailClosedFeatureGate` with `external_agents` flag on BUSINESS/ENTERPRISE tiers                   |
| 13  | API key auth mechanism?                 | ANSWERED       | Existing IApiKey model with new scopes (llm:proxy, tools:execute, config:read, prompts:read, logs:write) |
| 14  | Deployment pipeline difference?         | DECIDED        | Bypass ABL compilation — container image IS the artifact. Sidecar injected via Helm chart template.      |
| 15  | Security model for external containers? | DECIDED        | NetworkPolicy default-deny egress, allowExternalEgress opt-in, read-only rootfs, non-root user           |

---

## Audit Rounds

### Round 1 — Findings & Resolutions

| Severity | Finding                                                                                                         | Resolution                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CRITICAL | Model resolution cited as "6-level" — actual code says 5-level                                                  | Corrected all references to "5-level" per `model-resolution.ts` line 4              |
| CRITICAL | `GuardrailsPipeline.evaluate()` doesn't exist — actual is `createGuardrailPipeline()` → `GuardrailPipelineImpl` | Corrected all references per `pipeline-factory.ts` line 362                         |
| HIGH     | Deployment lifecycle states too sparse (active/draining/retired)                                                | Expanded to pending/provisioning/active/canary/draining/retired/failed; added FR-9a |
| HIGH     | No `trafficWeight` field for canary deployments                                                                 | Added `trafficWeight: number (0-100)` to ExternalAgentDeployment model              |
| HIGH     | Proxy bypass risk undocumented                                                                                  | Added GAP-008 with NetworkPolicy mitigation and `allowExternalEgress` field         |
| HIGH     | Analytics pipeline integration missing from observability                                                       | Added analytics pipeline paragraph to observability section                         |
| HIGH     | Scaffolding detail insufficient for AD-010                                                                      | Added GAP-009 and expanded Phase 3 task 10.4 with `abl init` command                |
| MEDIUM   | Missing `allowExternalEgress` in data model                                                                     | Added boolean field to ExternalAgentConfig                                          |

### Round 2 — APPROVED

| Severity | Finding                                                                                                | Resolution                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| HIGH     | Integration matrix links to non-existent docs (budget-enforcement.md, encryption-kms.md, auth-rbac.md) | Fixed: linked to actual files (budget-enforcement.ts code, encryption-at-rest.md + kms.md, auth-profiles.md) |
| HIGH     | FR-3 says singular projectId/environment but IApiKey uses arrays                                       | Fixed: wording now references `projectIds[]` and `environments[]` per IApiKey model                          |
| MEDIUM   | FR numbering error (two "11." entries)                                                                 | Fixed: corrected to 11, 12, 13                                                                               |
| MEDIUM   | Testing guide missing FR-9a coverage row                                                               | Fixed: added FR-9a row + INT-11 and INT-12 scenarios                                                         |

---

## Files Created/Modified

| File                                                     | Action                              |
| -------------------------------------------------------- | ----------------------------------- |
| `docs/features/external-agent-host.md`                   | Created — full feature spec         |
| `docs/testing/external-agent-host.md`                    | Created — testing guide placeholder |
| `docs/features/README.md`                                | Updated — added row #93             |
| `docs/testing/README.md`                                 | Updated — added row #93             |
| `docs/sdlc-logs/external-agent-host/feature-spec.log.md` | Created — this file                 |

---

## Open Questions (6)

1. Container registry access model (customer-managed vs platform-managed)
2. Resource quota enforcement (K8s ResourceQuotas vs application-level)
3. External agent versioning strategy (platform auto-increment vs image tag)
4. Multi-container agent support (Phase 1 scope)
5. Warm-up and readiness probe timeout
6. Outbound network policy granularity

---

## Next Phase

Run `/test-spec external-agent-host` to generate the full test specification.
