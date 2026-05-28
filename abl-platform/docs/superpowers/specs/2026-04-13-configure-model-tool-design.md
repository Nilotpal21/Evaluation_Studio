# Configure Model Tool Design

**Date:** 2026-04-13
**Branch:** arch/knowledge
**Ticket:** ABLP-162
**Status:** DESIGN

## Problem

Arch AI's `recommend_model` tool produces actionable model recommendations (primary, fallback, per-operation, execution config) but the SA cannot apply them. The SA must leave Arch, navigate to agent settings, and manually change the model. This breaks the conversational flow and makes recommendations advisory-only.

## Solution

Add a `configure_model` tool to the IN_PROJECT phase that can inspect, diff, and apply model configurations for individual agents or entire topologies. Supports two sources: auto-computed recommendations (from the existing recommendation engine) and manual model specification.

## Tool Definition

### Name

`configure_model`

### Actions

| Action    | Purpose                                                                                                                                                    | Writes? |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `inspect` | Show current model config for one agent or all agents. Shows what's explicitly configured vs inheriting defaults (no granular project/tenant distinction). | No      |
| `diff`    | Show current config vs recommended config side-by-side for one or all agents.                                                                              | No      |
| `apply`   | Write model config. Source is either `recommendation` (auto-compute via `getModelRecommendation`) or `manual` (explicit values in input).                  | Yes     |

### Input Schema

```typescript
z.object({
  action: z.enum(['inspect', 'diff', 'apply']),
  agentName: z.string().describe('Agent name, or "all" for topology-wide'),
  // Only for action: 'apply'
  source: z.enum(['recommendation', 'manual']).optional(),
  // Only for source: 'manual'
  modelId: z.string().optional().describe('LiteLLM model ID, e.g. "claude-sonnet-4-6"'),
  provider: z.string().optional().describe('Provider key, e.g. "anthropic"'),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  // operationModels values are model ID strings (e.g. "claude-haiku-4-5"),
  // matching the DB contract in AgentModelConfig and runtime upsertAgentModelConfig.
  // The recommendation engine's perOperation ScoredModel objects are translated
  // to Record<string, string> before writing: { extraction: "claude-haiku-4-5" }
  operationModels: z.record(z.string(), z.string()).optional(),
  // Dangerous-action confirmation round-trip (follows agent-ops, project-config pattern)
  confirmed: z.boolean().optional(),
});
```

**Validation:**

- `action: 'apply'` requires `source`
- `source: 'manual'` requires `modelId` and `provider`
- `source: 'recommendation'` ignores manual fields (uses recommendation engine output)
- `temperature` must be 0-2 if provided
- `maxTokens` must be a positive integer if provided

## Data Flow

### inspect

1. Fetch current `AgentModelConfig` via GET `/api/projects/:projectId/agents/:agentName/model-config` (Studio proxy API)
2. Classify status by **field presence**, not document existence. The GET endpoint always returns a config object (with null defaults when no override exists), and Studio can also persist an all-null config on reset — so document presence alone is unreliable. Classification checks **all 7** override fields from `IAgentModelConfig` that the runtime applies during model resolution:
   - `configured` = at least one field has an active value. For scalar fields (`defaultModel`, `temperature`, `maxTokens`, `useResponsesApi`, `useStreaming`): non-null. For object fields (`operationModels`, `hyperParameters`): non-null AND has at least one key (`Object.keys(v).length > 0`). The GET endpoint returns `operationModels: {}` as the empty default, so `{}` must not count as configured.
   - `inherited` = all scalar fields are null AND both object fields are null or empty (no agent-level override in effect)
3. For `agentName: "all"` — fetch project agents via `platform_context.list_agents`, then batch-fetch configs for each
4. Return structured result per agent:
   - Agent name
   - Status: `configured` or `inherited` (per the 7-field presence rule above)
   - If configured: list each non-null field. Group into **LLM selection** (defaultModel, temperature, maxTokens, operationModels) and **execution** (hyperParameters, useResponsesApi, useStreaming) so the SA sees what kind of overrides are active
   - If inherited: "No agent-level override — model resolved at runtime from project or tenant defaults"

   Note: `configure_model` only writes the 4 LLM-selection fields. The 3 execution fields (hyperParameters, useResponsesApi, useStreaming) are read-only in this tool — they're set via the Studio AgentModelTab UI. But inspect must report them because they affect runtime behavior and the SA needs the full picture.

**Limitation:** The current GET endpoint cannot distinguish whether the inherited model comes from project config (level 3) or tenant config (level 4). This is acceptable for v1 — the SA cares about "is this agent explicitly configured?" not "which fallback layer is active."

### diff

1. Fetch current config (same as inspect flow)
2. Run `getModelRecommendation()` for each target agent using agent metadata (tool count, role, complexity)
3. Return side-by-side comparison per agent:
   - Field: current value -> recommended value, with change indicator
   - For unconfigured agents: "inherited -> [recommended model]"
   - For already-optimal agents: "no changes needed"
4. Include recommendation reasoning (from `ScoredModel.reason`)

### apply — Read-Merge-Write Contract

**Critical:** The runtime's `upsertAgentModelConfig` (`project-repo.ts:473`) uses `$set` with `?? null` for every field. Any field not included in the PUT payload gets written as `null`, wiping existing overrides for `hyperParameters`, `useResponsesApi`, `useStreaming`, etc. The apply flow must therefore **read the current config first and merge** the new values onto it, preserving fields that configure_model does not manage.

**Merge rule:** GET the current AgentModelConfig. Spread all existing fields into the PUT payload. Overlay only the fields being changed (defaultModel, temperature, maxTokens, operationModels). This ensures hyperParameters, useResponsesApi, useStreaming, and any future fields are preserved.

### apply — Project ModelConfig Validation

**Why this matters:** `AgentModelConfig.defaultModel` stores a bare model ID string (e.g., `"claude-sonnet-4-6"`). Runtime Level 2 resolution (`model-resolution.ts:779`) looks up `ModelConfig.findOne({ projectId, modelId })` to find the project-level link from model ID → `tenantModelId` → credentials. If no project `ModelConfig` exists for that model ID, the runtime warns and falls through to Level 3/4 (project/tenant defaults) — the agent override silently has no effect.

The Studio UI (`ModelConfigTab.tsx`) handles this by always creating project `ModelConfig` entries from tenant models. `configure_model` must do the same.

**Validation + ensure-project-model flow (applies to both recommendation and manual sources):**

1. Resolve the target model ID and provider (from recommendation or manual input)
2. Check if a project `ModelConfig` exists for that model ID via `GET /api/models?projectId=<id>` (Studio route at `apps/studio/src/app/api/models/route.ts`), filtering the response by `modelId`
3. If a match exists with the **same provider** → proceed (the model ID will resolve correctly at Level 2)
4. If a match exists with a **different provider** → fail with `{ success: false, error: { code: 'MODEL_PROVIDER_CONFLICT', message: 'This project already has <modelId> configured via <existingProvider>. Runtime resolves by modelId only, so adding the same modelId from <requestedProvider> would be non-deterministic. Remove the existing config first, or choose a different model.' } }`. This matches the Studio UI behavior (`ModelConfigTab.tsx`), which avoids duplicate modelIds entirely.
5. If no match → do a **live** `GET /api/tenant-models` call (bypassing the 15-min `list_models` cache) and filter the response by **both `modelId` and `provider`**. Tenant models have no unique index on `{tenantId, modelId}` — the same modelId can appear multiple times across providers or even within the same provider — so both fields are required to get a deterministic match. Then filter to **usable** entries only: `isActive === true`, `inferenceEnabled === true`, and `_count.connections > 0` (the tenant-models API exposes connection counts). A tenant model without active connections cannot resolve credentials at runtime (`resolveTenantModelById` returns null). After filtering: **zero usable matches** → fail with `MODEL_NOT_AVAILABLE`. **Exactly one usable match** → proceed. **Multiple usable matches** (same modelId + provider, different tenant model entries) → fail with `{ success: false, error: { code: 'AMBIGUOUS_TENANT_MODEL', message: 'Multiple tenant model entries match <modelId> (<provider>). Select a specific one in Tenant Models settings.' } }`. This matches the Studio UI where `ModelConfigTab.tsx` presents a list for the user to choose — `configure_model` cannot make that choice automatically. Extract `tenantModelId`, `provider`, and capability flags from the single match. Then create a project `ModelConfig` entry via `POST /api/models` with `{ projectId, name: modelId, modelId, provider, tenantModelId, supportsTools, supportsVision, supportsStreaming, contextWindow, tier: 'balanced' }`.
6. Apply the same ensure-project-model step to every model ID in `operationModels`. **Provider for per-operation models:** The `operationModels` input schema carries only model ID strings (no per-operation provider). Provider is resolved by looking up each model ID in the recommendation engine's `perOperation` map (for `source: 'recommendation'`) or from the existing project `ModelConfig` / tenant model that matches the model ID (for `source: 'manual'`). If a model ID is ambiguous at the tenant level (multiple providers), fail with `MODEL_NOT_AVAILABLE` and ask the SA to specify the model via the `defaultModel` + `provider` fields instead.

**Why reject cross-provider duplicates:** Runtime Level 2 resolution uses `findOne({ projectId, modelId })` (`llm-resolution-repo.ts:85`) — no provider in the query. If two project `ModelConfig` entries share the same modelId with different providers, resolution is non-deterministic. `configure_model` prevents this by refusing to create a second entry. This is the same constraint the Studio UI enforces.

### apply (source: 'recommendation')

1. Run `getModelRecommendation()` for the target agent(s)
2. Check `tenantFilterUnavailable` — if `true`, fail with `NO_TENANT_MODELS`
3. **Ensure project ModelConfig** for the recommended model ID(s) — see validation flow above
4. **GET current agent config** from `/api/projects/:projectId/agents/:agentName/model-config`
5. Build diff table and present via `ask_user` with confirmation widget
6. On SA confirmation, **merge** new values onto current config and PUT to `/api/projects/:projectId/agents/:agentName/model-config`:
   - Overlay `defaultModel`: recommendation's primary model ID
   - Overlay `temperature`, `maxTokens`: from recommendation's `executionConfig`
   - Overlay `operationModels`: from recommendation's `perOperation` map (if present)
   - **Preserve**: `hyperParameters`, `useResponsesApi`, `useStreaming` from current config
7. Write journal entry for audit trail
8. Return success summary with what changed

### apply (source: 'manual')

1. **Ensure project ModelConfig** for the specified `modelId` + `provider` — see validation flow above. If tenant model doesn't exist, return error with available models.
2. Same read-merge-confirm-write-journal flow as recommendation path

### Topology-Wide Apply (agentName: 'all')

- Iterate each project agent, compute per-agent recommendation (not one-size-fits-all)
- Present single confirmation table showing all proposed changes
- Sequential writes (not parallel) to avoid partial-apply masking failures
- If any write fails, report which succeeded and which failed
- Skip agents where current config already matches recommendation

## Write Path

All writes go through the Studio proxy API:

```
PUT /api/projects/:projectId/agents/:agentName/model-config
```

This proxies to the runtime server, which writes to `AgentModelConfig` (Mongoose, collection: `agent_model_configs`, unique index on `{ projectId, agentName }`).

**Runtime write-side gaps (must be addressed in implementation):**

1. **Cache invalidation** — The current runtime PUT route does not invalidate model resolution caches after save. Unlike `platform-admin-models.ts` (which calls `invalidateModelResolutionCaches(tenantId)` after save), the agent model config PUT does not clear cached resolutions. The implementation must call `invalidateModelResolutionCaches` after successful upsert.

2. **Model existence check (defense-in-depth)** — The `configure_model` tool validates model identity at the tool level (ensure-project-ModelConfig, live tenant model lookup). However, the runtime PUT route is also callable from the Studio UI and other clients. Adding a lightweight check that `defaultModel` has a matching project `ModelConfig` entry before upsert provides defense-in-depth. This should warn-and-proceed (not block), since blocking would break existing clients that may write agent overrides without the ensure step.

**Validation ownership summary:** The `configure_model` tool is the primary enforcement point (live tenant lookup, project ModelConfig creation). The runtime PUT adds a secondary warning-level check. Neither relies solely on cached data for the create-project-ModelConfig path.

The runtime's 5-level model resolution chain picks up agent-level config at level 2, overriding project and tenant defaults. Cache invalidation ensures this takes effect immediately.

## Specialist Integration

### Specialists That Get configure_model

| Specialist             | Rationale                                                                 |
| ---------------------- | ------------------------------------------------------------------------- |
| `abl-construct-expert` | Configures individual agents. Natural place for "set this agent's model". |
| `diagnostician`        | Diagnoses issues. Can detect capability mismatches and offer to fix them. |

Both specialists also need `recommend_model` in their tool map to enable the recommend-then-apply workflow.

### Updated IN_PROJECT_SPECIALIST_TOOL_MAP

```typescript
'abl-construct-expert': [
  'read_agent', 'propose_modification', 'apply_modification', 'dismiss_proposal',
  'compile_abl', 'read_topology', 'health_check', 'ask_user',
  'configure_model', 'recommend_model'  // NEW
],
'diagnostician': [
  'validate_agent', 'diagnose_project', 'explain_diagnostic', 'read_agent',
  'query_traces', 'propose_modification', 'dismiss_proposal', 'health_check', 'ask_user',
  'configure_model', 'recommend_model'  // NEW
],
```

### Specialist Prompt Updates

**abl-construct-expert:** Add a "Model Configuration" section documenting the configure_model actions and the recommend -> inspect -> apply workflow.

**diagnostician:** Add guidance to suggest model changes when detecting capability mismatches (e.g., "agent has 8 tools but uses GPT-4o-mini which has weak tool calling").

## Confirmation UX

The `apply` action is a two-step process: **diff in tool result, then confirm via widget**.

**Step 1 — Detailed diff in tool result (visible in chat):** The `configure_model` tool returns the full diff as its tool result _before_ calling `ask_user`. The LLM presents this in its natural response text (which supports markdown). This is where the SA sees the detailed breakdown:

```
BillingAgent: inherited → claude-sonnet-4-6 (anthropic)
  temperature: default → 0.3 | maxTokens: default → 4096
  operations: extraction → claude-haiku-4-5
```

**Step 2 — Plain-text confirmation via widget:** After presenting the diff, the tool calls `ask_user` with a `Confirmation` widget. The `question` field is **plain text only** — no markdown, no multiline formatting. The existing `WidgetRenderer.tsx` renders `question` inside a `<p>` tag with no markdown parsing or whitespace preservation, so the question must be a single readable sentence.

```typescript
{
  question: 'Apply model config changes to BillingAgent? (claude-sonnet-4-6, temp 0.3, maxTokens 4096)',
  widgetType: 'Confirmation',
  confirmLabel: 'Apply',
  denyLabel: 'Cancel'
}
```

**Topology-wide:**

```typescript
{
  question: 'Apply model config changes to 2 agents? (SupportAgent, RouterAgent — BillingAgent unchanged)',
  widgetType: 'Confirmation',
  confirmLabel: 'Apply All',
  denyLabel: 'Cancel'
}
```

The SA must confirm before any writes occur. Declining returns a cancellation message with no side effects.

### Dangerous-Action Confirmation Round-Trip

The `apply` action follows the existing `confirmed`/`needsConfirmation` pattern used by `agent-ops.ts`, `project-config.ts`, `deployment-ops.ts`, etc.:

1. LLM calls `configure_model(action: 'apply', ...)` without `confirmed: true`
2. Tool checks `DANGEROUS_ACTIONS['configure_model']` includes `'apply'`, sees `!input.confirmed`
3. Tool returns `{ needsConfirmation: true, warning: 'Apply model config to BillingAgent? (claude-sonnet-4-6, temp 0.3)', data: { diff: ... } }`
4. LLM presents the diff from `data` in chat, then calls `ask_user` with Confirmation widget
5. If SA confirms, LLM re-calls `configure_model(action: 'apply', ..., confirmed: true)`
6. Tool proceeds with read-merge-write

This two-call pattern is the standard contract for dangerous actions. The `confirmed` field is already in the input schema above.

## Journal Integration

Each successful `apply` emits a `journal_entry` SSE event using the existing journal contract (`JournalEntryEventSchema` in `sse-events.ts`). The `entryType` is `mutation` — the only write-action type in the current enum (`decision | consultation | mutation | validation | analysis`).

```typescript
{
  type: 'journal_entry',
  entryType: 'mutation',
  summary: 'Model config applied: BillingAgent → claude-sonnet-4-6',
  description: 'source: recommendation | before: inherited | after: claude-sonnet-4-6, temp 0.3, maxTokens 4096'
}
```

The `summary` is a one-liner. The `description` encodes before/after state, source, and per-operation changes as a structured string. This fits the existing contract without expanding the journal type enum.

## Validation & Error Handling

### Validation Rules

- Model must have a project `ModelConfig` entry linking to a `TenantModel` (see "apply — Project ModelConfig Validation"). If missing, `configure_model` creates one from the tenant model before writing the agent override.
- Tenant `allowedProviders` policy is respected (already handled in recommendation engine; manual source validates separately)
- Temperature: 0-2 range
- maxTokens: positive integer

### Error Responses

| Condition                | Code                  | Response                                                                   |
| ------------------------ | --------------------- | -------------------------------------------------------------------------- |
| Model not in tenant list | `MODEL_NOT_AVAILABLE` | Error message + `availableModels` array                                    |
| Agent not in project     | `AGENT_NOT_FOUND`     | Error message with agent name                                              |
| API write failure        | `CONFIG_WRITE_FAILED` | Error message + `agentName`. For batch: reports partial success.           |
| SA declines confirmation | (no error)            | `{ success: true, cancelled: true, message: 'Configuration not applied' }` |

### Edge Cases

- **Agent exists but has no metadata** (BUILD in progress): `inspect` works. `diff`/`apply` with `source: 'recommendation'` returns "insufficient agent metadata to recommend, use manual source".
- **Agent already has recommended model**: `diff` shows "no changes needed". `apply` skips with informational message.
- **Stale tenant model cache**: The 15-min `list_models` cache is used for recommendations and `inspect`/`diff` display, but the ensure-project-ModelConfig step in `apply` does a **live** tenant model lookup (bypassing cache). If the tenant model was just removed, the live lookup catches it and fails with `MODEL_NOT_AVAILABLE`.

### Recommendation Pre-Filtering

When `configure_model` calls `getModelRecommendation()` (for `diff` or `apply` with `source: 'recommendation'`), it passes `tenantModels` (the list of tenant-available model IDs from `list_models`) into the recommendation input.

**Important caveat:** The current `getModelRecommendation` helper does NOT strictly filter to tenant models. When tenant filtering removes all candidates, it falls back to the full catalog and sets `tenantFilterUnavailable: true` on the result (`get-model-recommendation.ts:129`). This means an unavailable model can still be recommended.

`configure_model` must check `recommendation.tenantFilterUnavailable` after calling the helper. If `true`, the tool must **not** proceed to apply. Instead, return an error: `{ success: false, error: { code: 'NO_TENANT_MODELS', message: 'No tenant-available models match this agent's requirements. The recommendation (X) is from the general catalog but is not configured for your tenant. Add it via Tenant Models or choose a different model manually.' } }`

This ensures the recommend-then-apply path never writes an unavailable model, without requiring changes to the recommendation helper itself.

## Implementation Scope

### Files to Create

- `apps/studio/src/lib/arch-ai/tools/configure-model.ts` — Tool implementation (inspect, diff, apply actions)

### Files to Modify

**Shared tool contract (`packages/arch-ai/`):**

- `packages/arch-ai/src/types/tools.ts` — Add `'configure_model'` to `ToolName` union and `IN_PROJECT_TOOLS` array
- `packages/arch-ai/src/tools/schemas/in-project-schemas.ts` — Add `configure_model` Zod schema to `toolInputSchemas`
- `packages/arch-ai/src/prompts/phases/in-project.ts` — Add `configure_model` to available tools list and capabilities section in `IN_PROJECT_PHASE_PROMPT`
- `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` — Add model configuration section to prompt
- `packages/arch-ai/src/prompts/specialists/diagnostician.ts` (if exists, else the diagnostician prompt location) — Add model mismatch guidance

**Studio tool wiring (`apps/studio/`):**

- `apps/studio/src/app/api/arch-ai/message/route.ts` — Import and register `configure_model` in `buildInProjectTools()`, update `IN_PROJECT_SPECIALIST_TOOL_MAP` for abl-construct-expert and diagnostician
- `apps/studio/src/lib/arch-ai/guards.ts` — Add `configure_model` entry to `ACTION_TO_PERMISSION` (inspect/diff → `agent:read`, apply → `agent:update`) and add `configure_model: ['apply']` to `DANGEROUS_ACTIONS`. These permissions match the runtime route (`agent-model-config.ts:122` uses `agent:read` for GET and `agent:update` for PUT).

  **Transitive permission dependency:** The `apply` action's ensure-project-ModelConfig step calls `GET /api/tenant-models` (protected by `credential:read`) and `POST /api/models` (protected by user auth + project membership). The `inspect`/`diff` actions call `list_models` from `platform_context` which also hits `GET /api/tenant-models`. If the user has `agent:update` but not `credential:read`, the tool guard passes but the tenant-model enumeration returns 403. The tool must catch this and return a clear error: `{ success: false, error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Model configuration requires credential:read permission to enumerate available models.' } }`. This is a preflight check — fail fast before any writes.

- `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx` — Add `configure_model` to `TOOL_LABELS` map

**Runtime (`apps/runtime/`):**

- `apps/runtime/src/routes/agent-model-config.ts` — Call `invalidateModelResolutionCaches(tenantId)` after successful upsert (import from `services/llm/model-cache-invalidation.ts`). Add warning-level log when `defaultModel` has no matching project `ModelConfig` entry (defense-in-depth, non-blocking — see "Validation ownership summary" in Write Path section)

### Shared Tool-Contract Surfaces

IN_PROJECT tools have shared contract files in `packages/arch-ai/` that must be updated alongside the inline tool definition in `route.ts`. All of these must include `configure_model`:

1. **`packages/arch-ai/src/types/tools.ts`** — `ToolName` union type (line 10): add `'configure_model'` to the union. `IN_PROJECT_TOOLS` array (line 64): add `'configure_model'` to the list. Without this, the tool won't pass type checks or be included in `getToolsForInProject()`.
2. **`packages/arch-ai/src/tools/schemas/in-project-schemas.ts`** — `toolInputSchemas` (line 55): add `configure_model` Zod schema entry. The `tool-validator.ts` executor validates all tool inputs against this registry — an unlisted tool falls through with no validation.
3. **`packages/arch-ai/src/prompts/phases/in-project.ts`** — `IN_PROJECT_PHASE_PROMPT` (line 7): add `configure_model` to the "Available tools" list and add a "Model Configuration" capabilities entry describing the inspect/diff/apply workflow.
4. **`apps/studio/src/lib/arch-ai/guards.ts`** — `ACTION_TO_PERMISSION`: add `configure_model` entry (inspect/diff → `agent:read`, apply → `agent:update`). `DANGEROUS_ACTIONS`: add `configure_model: ['apply']`.
5. **`apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx`** — `TOOL_LABELS`: add `'configure_model': 'Configuring model'`.
6. **`IN_PROJECT_SPECIALIST_TOOL_MAP`** (in route.ts): add to `abl-construct-expert` and `diagnostician` arrays.

### Confirmation Widget

The `apply` action uses the existing `Confirmation` widget type. The `question` field is **plain text** (single sentence summarizing the change). The detailed diff is returned in the tool result for the LLM to present in chat (which supports markdown). See "Confirmation UX" section above for the two-step flow and examples.

No new widget type needed. No changes to `WidgetRenderer.tsx` or `types.ts` required.

### Files Unchanged (Read Only)

- `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` — Called by configure_model, not modified
- `apps/studio/src/lib/arch-ai/tools/platform-context.ts` — `list_models` used for validation, not modified
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/model-config/route.ts` — Existing Studio proxy, not modified
- `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx` — Existing Confirmation widget, not modified
- `apps/studio/src/components/arch-v3/widgets/types.ts` — Existing widget types, not modified

## SA Workflow Examples

### Recommend and Apply

```
SA: "What model should BillingAgent use?"
Arch: [calls recommend_model] "Claude Sonnet 4.6 — complex agent with 5 tools, needs strong tool calling. Temperature 0.3, maxTokens 4096."
SA: "Apply it"
Arch: [calls configure_model(action: 'apply', agentName: 'BillingAgent', source: 'recommendation')]
     [shows diff via ask_user, SA confirms]
     "Done. BillingAgent now uses claude-sonnet-4-6."
```

### Inspect All Agents

```
SA: "What models are my agents using?"
Arch: [calls configure_model(action: 'inspect', agentName: 'all')]
     "BillingAgent: claude-sonnet-4-6 (configured)
      SupportAgent: inherited (no agent-level override)
      RouterAgent: gpt-4o-mini (configured)"
```

### Topology-Wide Optimization

```
SA: "Optimize models for the whole project"
Arch: [calls configure_model(action: 'diff', agentName: 'all')]
     "BillingAgent: claude-sonnet-4-6 -> no change needed
      SupportAgent: inherited -> gpt-4o-mini (simple agent, 2 tools, saves 70%)
      RouterAgent: gpt-4o-mini -> claude-haiku-4-5 (faster, same capability tier)"
SA: "Apply all"
Arch: [calls configure_model(action: 'apply', agentName: 'all', source: 'recommendation')]
     [shows full table via ask_user, SA confirms]
     "Applied. 2 agents updated, 1 unchanged."
```

### Manual Override

```
SA: "Set SupportAgent to gpt-4o, I want the best model regardless of cost"
Arch: [calls configure_model(action: 'apply', agentName: 'SupportAgent', source: 'manual', modelId: 'gpt-4o', provider: 'openai')]
     [shows diff via ask_user, SA confirms]
     "Done. SupportAgent now uses gpt-4o."
```
