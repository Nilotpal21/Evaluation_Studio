# Testing Guide: External Agent Host

**Feature**: [External Agent Host](../features/external-agent-host.md)
**Status**: PLANNED
**Last Updated**: 2026-04-17

---

## Current State (as of 2026-04-17)

No executable tests exist yet. Slice 1 is a spec-foundation slice, so the required regression artifact for this iteration is the locked contract below. Downstream implementation slices must preserve these seams as they add integration and E2E coverage.

---

## Slice 1 Spec Regression Contract

| ID    | Seam                           | Current Type  | Target Type       | Locked Contract                                                                                                                                                                                                                                                                                             | Status |
| ----- | ------------------------------ | ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1-1  | Zero-code onboarding           | Spec contract | E2E + integration | Managed adapter mode requires no customer-owned `/message`, `/health`, or A2A routes. The sidecar owns the platform contract and targets a platform-managed workload bridge over loopback HTTP inside the pod.                                                                                              | LOCKED |
| S1-2  | Deployment auth binding        | Spec contract | Integration + E2E | Deployment API keys bind exactly one tenant, one project, one environment, and one deployment. Zero-binding and multi-binding keys are invalid, and the baseline scope set includes `llm:proxy`, `tools:execute`, `config:read`, `prompts:read`, and `logs:write`.                                          | LOCKED |
| S1-3  | Config Resolution semantics    | Spec contract | Integration + E2E | Runtime config reads return the frozen deployment snapshot. Live inheritance-chain changes do not mutate existing deployments.                                                                                                                                                                              | LOCKED |
| S1-4  | Governance availability policy | Spec contract | Integration       | Guardrail and budget outages use a project-scoped policy shared by native and external agents. Default behavior is fail-closed.                                                                                                                                                                             | LOCKED |
| S1-5  | A2A registration contract      | Spec contract | Integration + E2E | A2A is deployment-scoped and connection-scoped. The sidecar owns the `A2AExpressHandlers` route shape and optional per-connection auth.                                                                                                                                                                     | LOCKED |
| S1-6  | Phase 1 egress posture         | Spec contract | Integration + ops | Phase 1 does not rely on enforced NetworkPolicy-based default-deny egress. Until Phase 3 lands, `allowExternalEgress` is declarative only and direct outbound provider bypass remains possible wherever cluster networking permits it.                                                                      | LOCKED |
| S1-7  | Deployment version semantics   | Spec contract | Integration + E2E | Deployment `version` is an explicit semantic version supplied at deploy time and stored separately from `containerTag`. Phase 1 rollout remains promote/rollback/drain only; weighted traffic semantics are out of scope.                                                                                   | LOCKED |
| S1-8  | Registry access contract       | Spec contract | Integration + ops | Phase 1 pulls directly from approved customer-managed or platform-managed OCI registries. Private registries require `registryCredentialId`; mandatory mirroring into a platform-managed registry is out of scope.                                                                                          | LOCKED |
| S1-9  | Pod packaging contract         | Spec contract | Integration + ops | Phase 1 supports exactly one customer workload container plus one platform adapter sidecar. Customer-defined multi-container pods are out of scope.                                                                                                                                                         | LOCKED |
| S1-10 | Managed bridge bootstrap       | Spec contract | Integration + ops | Managed mode resolves the customer launch command from OCI image metadata or `startCommandOverride`, mounts a platform-owned bootstrap launcher via read-only projected volume, overrides the workload command so the launcher becomes PID 1, and fails before rollout if no launch command can be derived. | LOCKED |

---

## Coverage Matrix

| FR     | Requirement                                                                                             | Unit | Integration | E2E | Manual | Status     |
| ------ | ------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1   | LLM Proxy (single-binding auth + model resolution + guardrails + budget)                                | -    | -           | -   | -      | NOT TESTED |
| FR-2   | Container deployment with adapter sidecar + health monitoring                                           | -    | -           | -   | -      | NOT TESTED |
| FR-2a  | Managed bootstrap launcher (resolved launch command + command override + fail-closed preflight)         | -    | -           | -   | -      | NOT TESTED |
| FR-3   | Auto-generated deployment-scoped API key with single project+environment binding + `prompts:read` scope | -    | -           | -   | -      | NOT TESTED |
| FR-4   | Config Resolution API (frozen deployment snapshot + secret delivery)                                    | -    | -           | -   | -      | NOT TESTED |
| FR-5   | Agent catalog registration + deployment-scoped A2A connection registration                              | -    | -           | -   | -      | NOT TESTED |
| FR-6   | Sidecar-owned inbound contract + connection-scoped A2A translation                                      | -    | -           | -   | -      | NOT TESTED |
| FR-7   | Tool Proxy (function-calling + explicit HTTP)                                                           | -    | -           | -   | -      | NOT TESTED |
| FR-8   | Prompt Template Service (versioning + ETag + A/B)                                                       | -    | -           | -   | -      | NOT TESTED |
| FR-9   | Deployment lifecycle (explicit versioning + promote + rollback + drain)                                 | -    | -           | -   | -      | NOT TESTED |
| FR-9a  | Deployment status state machine (`pending` → `provisioning` → `active` → ...)                           | -    | -           | -   | -      | NOT TESTED |
| FR-10  | Log capture (stdout + structured API)                                                                   | -    | -           | -   | -      | NOT TESTED |
| FR-11  | Feature gate (BUSINESS/ENTERPRISE only)                                                                 | -    | -           | -   | -      | NOT TESTED |
| FR-12  | Thin Python library                                                                                     | -    | -           | -   | -      | NOT TESTED |
| FR-12a | Governance availability policy (project-scoped fail-closed default)                                     | -    | -           | -   | -      | NOT TESTED |

---

## E2E Test Scenarios

| #     | Scenario                                                                                                    | Auth Context                         | Assertions                                                                                                                                | Status     |
| ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| E2E-1 | Register external agent in managed adapter mode → deploy → send LLM call via proxy → verify trace emitted   | API key (deployment-scoped)          | 200 response, trace event in store, audit log entry                                                                                       | NOT TESTED |
| E2E-2 | Deploy zero-code external workload with no platform-owned endpoints → A2A inbound message via sidecar route | JWT (project developer) + A2A bearer | 200 response, message delivered through connection-scoped sidecar route and bridged through the platform-managed loopback workload bridge | NOT TESTED |
| E2E-3 | Cross-tenant LLM Proxy call → verify 404 returned                                                           | API key (wrong tenant)               | 404 response, no data leakage                                                                                                             | NOT TESTED |
| E2E-4 | Deploy new version → promote → rollback to previous active deployment                                       | JWT (project operator)               | Previous version reactivated, promoted version drained or retired                                                                         | NOT TESTED |
| E2E-5 | External agent + native ABL agent in same project → supervisor routes to both                               | JWT (project developer)              | Both agents invocable, routing works across source types                                                                                  | NOT TESTED |
| E2E-6 | Budget exhaustion → LLM Proxy returns 429 → verify agent receives rate limit                                | API key (deployment-scoped)          | 429 with descriptive error, no LLM call forwarded                                                                                         | NOT TESTED |
| E2E-7 | Deploy external agent on FREE plan → verify feature gate blocks with 403                                    | JWT (project developer, FREE tier)   | 403 response, feature not available                                                                                                       | NOT TESTED |

---

## Integration Test Scenarios

| #      | Scenario                                                                                                 | Assertions                                                                                                                                                                                                                           | Status     |
| ------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| INT-1  | LLM Proxy auth resolves API key to a single deployment binding                                           | `tenantId`, `projectId`, `environment`, and `deploymentId` resolve from one valid binding                                                                                                                                            | NOT TESTED |
| INT-2  | LLM Proxy input guardrails redact PII before forwarding to provider                                      | PII redacted in forwarded request, original preserved in trace                                                                                                                                                                       | NOT TESTED |
| INT-3  | LLM Proxy output guardrails block toxic response                                                         | 400 or policy-defined block response, trace captures block event                                                                                                                                                                     | NOT TESTED |
| INT-4  | Model resolution resolves the correct provider from deployment/project/tenant policy                     | Resolved model matches configured deployment override or project/tenant default                                                                                                                                                      | NOT TESTED |
| INT-5  | Config Resolution API returns the deployment snapshot and ignores later live config changes              | Snapshot values remain stable after project or tenant config changes                                                                                                                                                                 | NOT TESTED |
| INT-6  | Tool Proxy lists MCP tools in OpenAI function schema format                                              | Tool schemas match MCP server registry                                                                                                                                                                                               | NOT TESTED |
| INT-7  | Tool Proxy executes MCP tool with audit event                                                            | Tool result returned, audit event emitted with tenant/project                                                                                                                                                                        | NOT TESTED |
| INT-8  | Prompt Template versioning (create draft → activate → fetch latest)                                      | Active version returned, draft not served by default                                                                                                                                                                                 | NOT TESTED |
| INT-9  | Deployment rollback restores previous container version, snapshot, and deployment binding                | Previous deployment reactivated, current retired or drained, prior binding usable                                                                                                                                                    | NOT TESTED |
| INT-10 | API key auto-generation enforces exactly one project + environment and includes `prompts:read`           | Key scopes match deployment context, zero-binding or multi-binding rejected                                                                                                                                                          | NOT TESTED |
| INT-11 | Deployment status state machine rejects invalid transitions (for example `retired` → `active`)           | 400 with invalid transition error, status unchanged                                                                                                                                                                                  | NOT TESTED |
| INT-12 | Governance availability policy defaults to fail-closed when guardrail or budget dependencies are missing | 503 returned, no provider call forwarded                                                                                                                                                                                             | NOT TESTED |
| INT-13 | A2A registration creates exactly one deployment-scoped `ChannelConnection` and connection-scoped routes  | Sidecar routes match `A2AExpressHandlers` shape, inbound API-key validation enforced, and managed mode targets the platform-managed loopback workload bridge                                                                         | NOT TESTED |
| INT-14 | Deployment lifecycle persists explicit semantic `version` separately from `containerTag`                 | Rollout and rollback use deployment `version` as the source of truth while image tags remain frozen metadata                                                                                                                         | NOT TESTED |
| INT-15 | Deployment provisioning enforces the Phase 1 registry and pod packaging contract                         | Approved registries pass, private registries require `registryCredentialId`, and customer-defined multi-container packaging is rejected                                                                                              | NOT TESTED |
| INT-16 | Managed-mode provisioning enforces the bootstrap launcher contract                                       | Resolved launch command is captured from OCI metadata or `startCommandOverride`, bootstrap launcher volume mount and command override are present, and provisioning fails closed when neither path yields a customer process command | NOT TESTED |

---

## Testing Notes

- Slice 1 coverage is doc-contract coverage only. Future implementation slices must convert `S1-1` through `S1-10` into executable integration, E2E, and ops coverage.
- All executable tests must exercise real platform infrastructure and must not mock `@agent-platform/*` or `@abl/*` packages.
- Zero-code onboarding coverage must use a managed-adapter workload that does not implement platform-owned `/message`, `/health`, or A2A routes in customer code.
- Zero-code onboarding coverage must prove that managed mode sidecar delivery targets the platform-managed loopback workload bridge rather than customer-owned platform routes.
- Managed-mode provisioning coverage must assert the bootstrap launcher volume mount, workload command override, persisted launch command, and preflight failure when no customer process command can be resolved.
- Optional passthrough coverage, when added, must prove the sidecar still owns the platform contract while proxying to internal workload HTTP paths.
- A2A coverage must exercise the connection-scoped `A2AExpressHandlers` route shape and per-connection inbound API-key validation; generic `/a2a` route coverage is insufficient.
- Config coverage must verify snapshot semantics explicitly: mutate live project or tenant configuration after deployment and prove existing deployments still receive their frozen snapshot values.
- Governance availability tests must assert fail-closed default behavior and verify that no upstream provider call is attempted on blocked requests.
- Deployment lifecycle coverage must assert that semantic deployment `version` is stored separately from `containerTag` and that Phase 1 uses promote/rollback rather than weighted traffic splits.
- Provisioning coverage must assert the Phase 1 packaging contract: one workload container plus one sidecar, approved registry handling, and `registryCredentialId` requirements for private registries.
- Phase 1 security posture tests and rollout docs must not assume container egress is blocked by default; NetworkPolicy enforcement is a Phase 3 control.
