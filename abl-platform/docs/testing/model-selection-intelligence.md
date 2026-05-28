# Test Specification: Model Selection Intelligence

**Feature Spec**: [`docs/features/model-selection-intelligence.md`](../features/model-selection-intelligence.md)
**HLD**: N/A (not yet generated)
**LLD**: N/A (not yet generated)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-05

---

## 1. Coverage Matrix

| FR    | Description                                    | Unit | Integration | E2E | Manual | Status  |
| ----- | ---------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Complexity tier mapping                        | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-2  | Capability matching (vision, streaming, tools) | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-3  | Tenant model + policy filtering                | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-4  | Fallback chain generation                      | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-5  | Cost comparison (relative + absolute)          | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-6  | recommend_model tool (IN_PROJECT)              | ❌   | ❌          | ❌  | ❌     | PLANNED |
| FR-7  | Comparison widget rendering                    | ❌   | ❌          | ❌  | ❌     | PLANNED |
| FR-8  | Journal event persistence                      | ❌   | ❌          | ❌  | ❌     | PLANNED |
| FR-9  | Compliance constraint filtering                | ✅   | ❌          | ❌  | ❌     | PARTIAL |
| FR-10 | Topology-wide recommendation                   | ❌   | ❌          | ❌  | ❌     | PLANNED |
| FR-11 | Proactive upgrade suggestions                  | ❌   | ❌          | ❌  | ❌     | PLANNED |

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests exercise the real Arch AI pipeline through HTTP API. No mocks, no direct DB access, no stubbed servers. Full middleware chain: auth, tenant isolation, validation.

### E2E-1: Simple scripted agent gets fast/cheap model during BUILD

- **Preconditions**: Tenant with at least 2 provisioned models (Haiku, Sonnet). Project created. Arch session in ONBOARDING mode.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }` → session created
  2. Send interview messages describing a simple FAQ bot with 1 tool, linear scripted flow
  3. Approve topology (1 agent, scripted, simple)
  4. Wait for BUILD phase to generate the agent
  5. `GET /api/arch-ai/sessions/:id/journal` → retrieve journal events
- **Expected Result**:
  - Journal contains a `model_recommendation` event for the agent
  - Recommended primary model is a fast/cheap tier (e.g., `claude-haiku-4-5-*`)
  - Event includes `reasoning` field explaining "scripted agent, fast model sufficient"
  - Generated ABL EXECUTION section contains the recommended model
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: N/A for BUILD (single tenant context)

### E2E-2: Complex reasoning agent gets powerful model during BUILD

- **Preconditions**: Same tenant. Arch session in ONBOARDING mode.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }`
  2. Send interview messages describing a complex dispute resolution system: 5 tools, multi-step FLOW, conditional branching, PCI-DSS compliance
  3. Approve topology (3+ agents including a complex specialist)
  4. Wait for BUILD to generate all agents
  5. `GET /api/arch-ai/sessions/:id/journal` → retrieve journal events
- **Expected Result**:
  - The complex specialist agent gets a powerful model (e.g., `claude-sonnet-4-*` or `gpt-4o`)
  - Simple triage agent gets a cheaper model
  - Each agent's journal event has distinct reasoning matching its complexity
  - Fallback chain present for each agent (different provider than primary)
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A for BUILD

### E2E-3: IN_PROJECT model query returns comparison widget

- **Preconditions**: Existing project with at least 2 agents of different complexity. Arch session in IN_PROJECT mode.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'IN_PROJECT', projectId: '<id>' }`
  2. `POST /api/arch-ai/message` with `{ text: "what model should I use for billing_agent?", sessionId: '<id>' }`
  3. Parse SSE stream response
- **Expected Result**:
  - Response contains a `tool_call` event for `recommend_model` tool
  - Tool result includes structured comparison with 2-4 model options
  - Each option has: `model`, `provider`, `strengths`, `weaknesses`, `costTier`, `latencyTier`
  - One option is marked as `recommended: true` with `reasoning` field
  - Fallback model specified with different provider than primary
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: Response must not include models from `test-tenant-2`'s provisioned catalog

### E2E-4: Tenant policy restricts to allowed providers only

- **Preconditions**: Tenant `test-tenant-2` with LLM policy `{ allowedProviders: ['anthropic'] }`. Project with agents requiring tool calling.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'IN_PROJECT', projectId: '<id>' }` as `test-tenant-2` user
  2. `POST /api/arch-ai/message` with `{ text: "recommend models for all agents" }`
  3. Parse SSE stream response
- **Expected Result**:
  - All recommended models are from Anthropic provider only
  - No OpenAI, Google, or other providers appear as primary or fallback recommendations
  - If policy prevents any valid fallback (all Anthropic), the response notes "fallback limited to same provider due to tenant policy"
- **Auth Context**: `Authorization: Bearer <tenant-2-user-jwt>`, tenant: `test-tenant-2`
- **Isolation Check**: `test-tenant-1`'s OpenAI models never appear in `test-tenant-2`'s results

### E2E-5: Topology-wide recommendation with cost totals

- **Preconditions**: Project with 4 agents of varying complexity (1 supervisor, 2 specialists, 1 escalation). IN_PROJECT session.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'IN_PROJECT', projectId: '<id>' }`
  2. `POST /api/arch-ai/message` with `{ text: "recommend models for all my agents" }`
  3. Parse SSE stream response
- **Expected Result**:
  - Response contains per-agent recommendation table with 4 rows
  - Each row: agent name, recommended model, cost tier, reasoning
  - Total estimated cost per conversation shown
  - Inter-agent consistency check: handoff paths between agents note if provider switching would add latency
  - Journal contains a `model_recommendation` event with `agentName: "all"`
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: Only agents from `test-project-1` appear (not `test-project-2`)

### E2E-6: Vision tool agent gets vision-capable model

- **Preconditions**: Project with an agent that has a vision-requiring tool (e.g., `analyze_screenshot`). IN_PROJECT session.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'IN_PROJECT', projectId: '<id>' }`
  2. `POST /api/arch-ai/message` with `{ text: "what model for the image_analysis_agent?" }`
  3. Parse SSE stream response
- **Expected Result**:
  - Primary recommended model has `supportsVision: true` in its capabilities
  - Models without vision support do not appear as primary recommendation
  - Reasoning references "agent requires vision capabilities"
  - Fallback model also supports vision
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A (single tenant)

### E2E-7: Journal persistence of model_recommendation events

- **Preconditions**: IN_PROJECT session with completed model recommendation.
- **Steps**:
  1. Complete E2E-3 (get a model recommendation)
  2. `GET /api/arch-ai/sessions/:id/journal` with auth headers
  3. Filter journal events by `type: 'model_recommendation'`
- **Expected Result**:
  - At least 1 `model_recommendation` event exists
  - Event contains: `agentName`, `recommendations` array, `reasoning`, `timestamp`
  - `recommendations` array has structured `ModelRecommendation` objects (not raw text)
  - Timestamp is within the last 60 seconds
- **Auth Context**: Same user who triggered the recommendation
- **Isolation Check**: Different user in same project cannot see journal events from this session

---

## 3. Integration Test Scenarios (MANDATORY)

> Integration tests verify service boundaries using real implementations. Only external third-party services may be mocked.

### INT-1: Registry-based scoring replaces hardcoded logic

- **Boundary**: `getModelRecommendation()` → `MODEL_REGISTRY` (compiler package)
- **Setup**: Import `getModelRecommendation` from `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` and `MODEL_REGISTRY` from `packages/compiler`
- **Steps**:
  1. Call `getModelRecommendation({ agentRole: 'specialist', executionMode: 'reasoning', requiresToolCalling: true, requiresVision: false, requiresStructuredOutput: false, complexityTier: 'complex', operations: ['response_gen', 'tool_selection'] })`
  2. Verify the returned model exists in `MODEL_REGISTRY`
  3. Verify the model's `ModelCapabilities` includes `supportsTools: true`
  4. Verify the model's `contextWindow` is >= 32K (complex agents need large context)
- **Expected Result**: Returned model is from the registry with matching capabilities, not a hardcoded string
- **Failure Mode**: If `MODEL_REGISTRY` import fails, the function should fall back to the existing static short-list

### INT-2: Tenant model filtering restricts candidates

- **Boundary**: `getModelRecommendation()` → tenant model list (from runtime API)
- **Setup**: Create a mock tenant model list with 3 specific models: `claude-haiku-4-5-*`, `claude-sonnet-4-*`, `gpt-4o-mini`
- **Steps**:
  1. Call `getModelRecommendation()` with the tenant model list as a parameter
  2. Verify all returned candidates (primary + fallback + alternatives) are within the tenant list
  3. Call again with an empty tenant model list
  4. Verify the function returns recommendations from the full registry with a warning
- **Expected Result**: When tenant list is provided, no model outside the list appears. When empty, full registry used with warning flag.
- **Failure Mode**: If tenant list fetch fails (network error), function uses full registry and sets a `tenantFilterUnavailable: true` flag

### INT-3: Fallback chain uses different provider

- **Boundary**: `getModelRecommendation()` internal fallback logic
- **Setup**: Request recommendation for a complex agent
- **Steps**:
  1. Call with `complexityTier: 'complex'` where primary recommendation is Anthropic
  2. Verify `fallback` field exists in the result
  3. Verify `fallback.provider !== primary.provider`
  4. Verify fallback model has equivalent core capabilities (`supportsTools`, `supportsStreaming`)
  5. Call with tenant policy `{ allowedProviders: ['anthropic'] }` — verify fallback is still Anthropic (same provider when only one allowed)
- **Expected Result**: Fallback always from different provider when possible; same provider when constrained
- **Failure Mode**: If no alternative provider is available, fallback is same provider with different model

### INT-4: Compliance filtering excludes non-compliant models

- **Boundary**: `getModelRecommendation()` → compliance constraint analysis
- **Setup**: Agent with `CONSTRAINTS` including PCI-DSS requirement
- **Steps**:
  1. Call with `constraints: ['PCI-DSS']` parameter
  2. Verify no models from providers without PCI-DSS certification appear as primary
  3. Verify reasoning mentions compliance filtering
  4. Call without constraints — verify the excluded models are now available
- **Expected Result**: Compliance-constrained calls produce a filtered candidate set; unconstrained calls include all models
- **Failure Mode**: If compliance data is unavailable for a model, it's excluded from compliant recommendations (fail-safe)

### INT-5: Cost comparison ratios match registry pricing

- **Boundary**: `getModelRecommendation()` → `MODEL_REGISTRY` pricing data
- **Setup**: Known model pairs with published pricing (e.g., Haiku vs Sonnet vs Opus)
- **Steps**:
  1. Call for a simple agent → get Haiku recommendation with cost tier
  2. Call for a complex agent → get Sonnet recommendation with cost tier
  3. Verify the relative cost comparison ("3x cheaper" or "60% savings") matches the actual pricing ratios from `MODEL_REGISTRY`
  4. Verify absolute cost estimate (if conversation volume provided) is within 20% of manual calculation
- **Expected Result**: Cost ratios are accurate to within 10% of registry data
- **Failure Mode**: If pricing data is missing for a model, cost comparison shows "pricing unavailable" instead of a wrong number

### INT-6: Streaming/voice channel agents get streaming-capable models

- **Boundary**: `getModelRecommendation()` → capability matching
- **Setup**: Agent with voice channel configuration requiring low TTFT
- **Steps**:
  1. Call with `channels: ['voice']` and `requiresStreaming: true`
  2. Verify primary model has `supportsStreaming: true`
  3. Verify models without streaming are not in the candidate list
  4. Call with `channels: ['web']` (no streaming requirement) — verify streaming models appear but are not required
- **Expected Result**: Voice/streaming channels enforce streaming capability; web channels don't
- **Failure Mode**: If no streaming model is available in tenant list, return best alternative with warning

### INT-7: Per-operation model splitting for complex agents

- **Boundary**: `getModelRecommendation()` → per-operation model selection
- **Setup**: Complex agent with operations: `['extraction', 'summarization', 'response_gen', 'coordination']`
- **Steps**:
  1. Call with `operations` list and `complexityTier: 'complex'`
  2. Verify `perOperation` field in result
  3. Verify extraction/summarization operations use cheaper models (Haiku-class)
  4. Verify coordination/response_gen use more capable models (Sonnet-class)
- **Expected Result**: Different operations get different model recommendations based on task complexity
- **Failure Mode**: If per-operation splitting is disabled, all operations use the primary model

---

## 4. Unit Test Scenarios

### UT-1: Complexity tier classification

- **Module**: `getModelRecommendation()` — complexity analysis
- **Input**: Agent profiles with varying tool counts, FLOW depths, GATHER fields
- **Expected Output**:
  - 0-1 tools, linear FLOW → `simple`
  - 2-4 tools, some branching → `moderate`
  - 5+ tools, multi-step conditional FLOW → `complex`

### UT-2: Execution mode detection

- **Module**: `getModelRecommendation()` — execution mode mapping
- **Input**: Various `executionMode` values
- **Expected Output**:
  - `scripted` → fast/cheap models (temperature 0.1)
  - `reasoning` → capable models (temperature 0.5)
  - `hybrid` → balanced models

### UT-3: Cost tier calculation

- **Module**: Cost comparison logic
- **Input**: Two models with known pricing from `MODEL_REGISTRY`
- **Expected Output**: Correct relative ratio string ("3x cheaper", "60% savings")

### UT-4: Token budget for recommendation output

- **Module**: Recommendation serialization
- **Input**: Full recommendation with 4 candidates
- **Expected Output**: Serialized output is under 2K tokens (within system prompt budget)

### UT-5: Empty/null input handling

- **Module**: `getModelRecommendation()`
- **Input**: Missing fields (no tools, no constraints, no operations)
- **Expected Output**: Returns a valid recommendation with sensible defaults, no errors thrown

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant model isolation**: Tenant A's provisioned models never appear in Tenant B's recommendations
  - Seed: Tenant A has OpenAI models; Tenant B has only Anthropic
  - Test: Tenant B's recommendations never include OpenAI models
- [x] **Cross-project isolation**: Recommendations are scoped to the requested project's agents
  - Seed: Project 1 has 3 agents; Project 2 has 5 agents
  - Test: "Recommend for all" in Project 1 returns exactly 3 rows
- [x] **Missing auth returns 401**: `POST /api/arch-ai/message` without `Authorization` header returns 401
- [x] **Insufficient permissions returns 403**: User without project access cannot get recommendations for that project
- [x] **No credential leakage**: Recommendation responses never contain API keys, credential IDs, or connection strings from the tenant model configuration
- [x] **Input validation**: `recommend_model` tool rejects malformed agent names (SQL injection, path traversal)
- [x] **Policy enforcement**: Recommendations respect `tenant_llm_policies.allowedProviders` — no bypass via direct tool call

---

## 6. Performance & Load Tests

| Scenario                                 | Target    | How Measured                                          |
| ---------------------------------------- | --------- | ----------------------------------------------------- |
| Single agent recommendation latency      | <100ms    | Time from `getModelRecommendation()` call to return   |
| Topology-wide recommendation (10 agents) | <500ms    | End-to-end including all 10 agent analyses            |
| Registry lookup (147+ models)            | <10ms     | MODEL_REGISTRY scan + filter time                     |
| Concurrent recommendations (10 sessions) | No errors | 10 parallel IN_PROJECT sessions requesting model recs |

---

## 7. Test Infrastructure

- **Required services**: Studio dev server (Next.js), MongoDB (for sessions/journals), runtime API (for tenant models)
- **Data seeding**:
  - 2 tenants with different model provisioning and LLM policies
  - 2 projects per tenant with agents of varying complexity
  - Agents with diverse tool profiles (vision, payment, health, general)
- **Environment variables**: Standard Studio dev env (`MONGODB_URI`, `AUTH_SECRET`). No new vars needed.
- **CI configuration**: Runs as part of `apps/studio` test suite. No Docker dependencies beyond MongoDB.

---

## 8. Test File Mapping

| Test File                                                                    | Type        | Covers                               |
| ---------------------------------------------------------------------------- | ----------- | ------------------------------------ |
| `apps/studio/src/__tests__/arch-ai/model-recommendation.test.ts`             | unit        | FR-1, FR-2, FR-4, FR-5               |
| `apps/studio/src/__tests__/arch-ai/model-recommendation-integration.test.ts` | integration | FR-3, FR-4, FR-9, INT-1–INT-7        |
| `apps/studio/src/__tests__/arch-ai/model-recommendation-compliance.test.ts`  | unit        | FR-9                                 |
| `apps/studio/src/__tests__/arch-ai/model-recommendation-cost.test.ts`        | unit        | FR-5                                 |
| `apps/studio/src/__tests__/e2e/arch-ai-model-recommendation.e2e.test.ts`     | e2e         | FR-6, FR-7, FR-8, FR-10, E2E-1–E2E-7 |
| `apps/studio/src/__tests__/arch-ai/model-comparison-widget.test.tsx`         | unit        | FR-7                                 |

---

## 9. Open Testing Questions

1. How should E2E tests seed tenant LLM policies? Direct DB insertion is prohibited — does a runtime admin API exist for setting `tenant_llm_policies`?
2. Should E2E tests verify the actual ABL EXECUTION section content (requires parsing the generated ABL output), or just verify the journal event?
3. For compliance filtering tests (FR-9), which specific models are considered PCI-DSS compliant? Is this metadata in `MODEL_REGISTRY` or a separate data source?
4. How should the `recommend_model` tool invocation be verified in E2E? SSE stream parsing needs to identify tool_call events vs text responses.
5. Should performance tests run in CI or only on-demand? The 147-model registry scan is fast, but concurrent session tests may need dedicated infrastructure.
