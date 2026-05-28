# SDLC Log: Model Hub -- Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec Generation
**Status**: Complete

## Decision Log

| Question                         | Classification | Answer                                                                                                                                                                                         |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What providers are supported?    | ANSWERED       | 15 provider types mapped via `createVercelProvider()` in `packages/llm/src/provider-factory.ts`. 147 models across 6 primary providers in `MODEL_REGISTRY`.                                    |
| What is the resolution chain?    | ANSWERED       | 5-level deterministic chain documented in `model-resolution.ts`: deployment -> agent IR -> agent DB -> project DB -> tenant model -> FAIL.                                                     |
| What data models exist?          | ANSWERED       | 7 collections found: tenant_models, model_configs, project_llm_configs, agent_model_configs, llm_credentials, tenant_llm_policies, llm_usage_metrics. Plus tenant_service_instances for voice. |
| What security measures exist?    | ANSWERED       | AES-256-GCM encryption plugin, SSRF protection on gateway discovery, audit trail plugin, tenant isolation plugin, blocked security-sensitive headers, rate limiting.                           |
| What governance is implemented?  | ANSWERED       | `tenant_llm_policies` schema exists with budget/rate/provider fields; enforcement is partial (GAP-005).                                                                                        |
| What gaps exist vs full feature? | INFERRED       | 11 gaps cataloged from code analysis: missing real-time policy enforcement, no health check automation, no cross-pod cache invalidation, reserved authProfileId fields not wired, etc.         |

## Files Created

- `docs/features/model-hub.md` -- Full 18-section feature spec

## Review Summary

- All 18 TEMPLATE.md sections addressed
- 6 user stories (exceeds minimum 3)
- 10 functional requirements (exceeds minimum 4)
- Integration matrix references 6 related features
- Non-functional concerns address tenant, project, and user isolation
- Delivery plan has 3 parent tasks with numbered subtasks
- 5 open questions
- 11 gaps documented with severity and status
- All claims grounded in code evidence with source file references

## Codebase Files Explored

- `apps/runtime/src/services/llm/model-resolution.ts`
- `apps/runtime/src/services/llm/model-catalog.ts`
- `apps/runtime/src/services/llm/session-llm-client.ts`
- `apps/runtime/src/services/diagnostics/analyzers/model-resolution.ts`
- `apps/runtime/src/routes/model-catalog.ts`
- `apps/runtime/src/routes/tenant-models.ts`
- `apps/runtime/src/routes/agent-model-config.ts`
- `apps/runtime/src/routes/project-llm-config.ts`
- `apps/runtime/src/routes/platform-admin-models.ts`
- `packages/database/src/models/tenant-model.model.ts`
- `packages/database/src/models/model-config.model.ts`
- `packages/database/src/models/project-llm-config.model.ts`
- `packages/database/src/models/llm-credential.model.ts`
- `packages/llm/src/provider-factory.ts`
- `packages/compiler/src/platform/llm/model-registry.ts`
- `packages/compiler/src/platform/llm/model-capabilities.ts`
