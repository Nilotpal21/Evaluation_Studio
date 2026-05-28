# Model Resolution Cache Versioning

This guide defines the explicit runtime contract for:

- full model resolution
- settings-only reasoning resolution
- which inputs are versioned
- which inputs are only request scope
- which inputs must **not** churn these caches

## Two Resolution Contracts

### 1. Full model resolution

Entry point: `ModelResolutionService.resolve()`

Use this when the runtime needs a callable model:

- model ID and provider
- merged execution parameters
- credential-bearing access
- provider allowlist enforcement
- per-call budget reservation

This contract is user-scoped. Its cache key must include `userId` because user-scoped credential policy can change whether the exact same model snapshot is callable.

### 2. Settings-only reasoning resolution

Entry point: `ModelResolutionService.resolveReasoningSettings()`

Use this when the runtime only needs the merged reasoning settings for prompt-building or session pre-resolution:

- `enableThinking`
- `thinkingBudget`
- `thoughtDescription`
- `compactionThreshold`
- reasoning `modelId`

This contract intentionally excludes:

- `userId`
- user-scoped credential policy
- per-call budget reservation

The corresponding cache key must be based on the reasoning snapshot for a tenant/project/agent, not on the caller identity.

## Three Different Identities

1. Full `AgentIR` hash
   Used by session/IR caches such as `SessionService.computeIRHash()`.
   This is whole-agent identity and should change for any semantic IR change.

2. Full `configHash`
   Stored on sessions for STI tracing and observability.
   This is also whole-agent identity, not a model-resolution key.

3. Model-resolution snapshot fingerprint
   Used only for caches whose result is the resolved model plus merged execution parameters.
   This must stay narrow and only change when model-selection inputs change.

## Snapshot-Versioned Inputs

These inputs are versioned and should invalidate both the full-resolution snapshot fingerprint and the reasoning-settings snapshot fingerprint:

| Input                                          | Why it is versioned                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `settingsVersionId`                            | Project settings lookups such as `findProjectEnableThinking()` are pinned by settings version. |
| Full deployment override payload               | Deployment overrides can change resolved model parameters, not just model ID.                  |
| Resolution-relevant `AgentIR.execution` fields | `ModelResolutionService` reads these fields directly when merging execution parameters.        |

The current `AgentIR.execution` fields in scope live in [model-resolution-versioning.ts](/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/llm/model-resolution-versioning.ts):

- `execution.model`
- `execution.operation_models`
- `execution.temperature`
- `execution.max_tokens`
- `execution.reasoning_effort`
- `execution.enable_thinking`
- `execution.thinking_budget`
- `execution.thought_description`
- `execution.compaction_threshold`

## Scope-Only Cache Inputs

These inputs are cache-significant, but they are **not** part of the versioned snapshot itself.

### Full model resolution scope

| Input           | Why it stays in cache scope                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| `tenantId`      | Tenant-scoped model configs, policies, and credentials differ.                        |
| `projectId`     | Project model config and project settings differ.                                     |
| `agentName`     | Agent DB overrides are per agent.                                                     |
| `operationType` | `operation_models` and project tier overrides vary by operation.                      |
| `userId`        | Credential policy and user-scoped credentials can change whether resolution succeeds. |

### Settings-only reasoning scope

| Input       | Why it stays in cache scope                      |
| ----------- | ------------------------------------------------ |
| `tenantId`  | Tenant-scoped model config and policy differ.    |
| `projectId` | Project model config and pinned settings differ. |
| `agentName` | Agent DB overrides are per agent.                |

`userId` must not appear in the settings-only reasoning cache key.

## Inputs That Should Not Invalidate Model-Resolution Caches

These parts of `AgentIR` are intentionally excluded today because model resolution does not read them:

- `identity`
- `tools`
- `gather`
- `memory`
- `constraints`
- `coordination`
- `completion`
- `error_handling`
- `flow`
- `messages`
- `routing`
- `behavior_profiles`

Behavior profiles are a useful example: they currently mutate tools, constraints, voice, gather, and flow, but not the execution-model inputs above. Profile-only changes should not churn model-resolution caches unless profile application starts mutating execution/model fields in the future.

## Shared Policy

The runtime now centralizes this policy in [model-resolution-versioning.ts](/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/llm/model-resolution-versioning.ts).

These helpers are the canonical key builders:

- `buildModelResolutionCacheKey()` for full credential-bearing resolution
- `buildReasoningSettingsCacheKey()` for settings-only reasoning resolution

These call sites should use the shared helpers instead of building ad-hoc string keys:

- `ModelResolutionService` metadata/singleflight cache
- `LLMWiringService` thinking-resolution cache

## Change Checklist

When model resolution starts reading a new field or a new caller is added:

1. Add the field to `MODEL_RESOLUTION_EXECUTION_FIELD_PATHS`.
2. Include it in `getModelResolutionExecutionSnapshot()`.
3. Add or update tests in [model-resolution-versioning.test.ts](/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/__tests__/model-resolution-versioning.test.ts).
4. Decide whether it belongs to full `resolve()`, settings-only `resolveReasoningSettings()`, or both.
5. Update this guide.
