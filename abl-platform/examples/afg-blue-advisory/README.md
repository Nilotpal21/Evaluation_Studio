# AFG Blue Advisory

Multi-brand retail and automotive advisory system demonstrating the ABL supervisor pattern with pipeline pre-classification, multi-agent delegation, guard rails, and comprehensive evals.

## Architecture

```
                         User
                          |
                  ┌───────▼────────┐
                  │  GuardRail     │
                  │  Supervisor    │
                  │  (pipeline:    │
                  │   qwen35-a3b)  │
                  └──┬──────────┬──┘
                     │          │
          ┌──────────▼──┐  ┌───▼──────────────┐
          │ Advisor     │  │ Store Policy     │
          │ Agent       │  │ Agent            │
          │ (gpt-4.1)   │  │ (gpt-4.1)        │
          └──────┬──────┘  └───┬──────────────┘
                 │             │
          ┌──────▼──────┐  ┌───▼──────────────┐
          │ product_    │  │ policy_search    │
          │ search      │  │ (SearchAI KB)    │
          │ (HTTP API)  │  │                  │
          └─────────────┘  └──────────────────┘
```

### Key Patterns

- **Supervisor Pattern**: GuardRail_Supervisor validates input, classifies intent, and routes to specialist agents
- **Pipeline Pre-Classification**: Uses a fast model (Qwen 3.5-35B-A3B) to pre-classify queries before the reasoning model, with short-circuit for high-confidence classifications and keyword veto for policy-related terms
- **Multi-Agent Delegation**: Advisor_Agent can delegate policy questions to Store_Policy_Agent mid-conversation and resume after receiving the policy response
- **Guard Rails**: Out-of-scope requests (flight bookings, weather, etc.) are politely declined without routing to any agent
- **Namespace Switching**: Product search tool supports multiple catalogs (retail, automobiles, offers) via namespace parameter

## Environment Variables

These are referenced in the DSL via `{{env.*}}` and must be set in the project's environment configuration:

| Variable                | Description                                             | Referenced In                   |
| ----------------------- | ------------------------------------------------------- | ------------------------------- |
| `AFG_SEARCHAI_ENDPOINT` | Kore.ai SearchAI advanced-search endpoint for policy KB | `tools/policy_search.tools.abl` |
| `AFG_SEARCHAI_TOKEN`    | Kore.ai SearchAI JWT token for policy KB auth           | `tools/policy_search.tools.abl` |

## Required Models

These models must be configured in the platform's model settings (Studio → Settings → Models). The credentials are managed by the platform, not by the agent package.

| Model            | Used By                                | Purpose                                      |
| ---------------- | -------------------------------------- | -------------------------------------------- |
| `gpt-4.1`        | All 3 agents (EXECUTION block)         | Reasoning, tool calling, response generation |
| `qwen35-a3b-35b` | GuardRail_Supervisor (pipeline config) | Fast pre-classification for routing          |

## Project Structure

```
examples/afg-blue-advisory/
  project.json                          # v2 export manifest
  agents/
    guardrail_supervisor.agent.abl      # Entry point — input validation & routing
    advisor_agent.agent.abl             # Product search & recommendations
    store_policy_agent.agent.abl        # Store policy KB lookups
  tools/
    product_search.tools.abl            # HTTP tool — AFG product/auto/offers search
    policy_search.tools.abl             # HTTP tool — SearchAI policy KB
  config/
    project-settings.json               # Runtime settings
    agent-model-configs/                # Per-agent model configuration
  environment/
    env-vars.json                       # Required environment variables
  evals/
    afg-regression/                     # Regression test suite
      eval-set.json                     # Suite configuration
      scenarios/                        # 6 test scenarios
      personas/                         # 3 simulated user personas
    evaluators/                         # 3 evaluator definitions
  locales/
    en/                                 # English UI strings per agent
  fixtures/
    products.json                       # Sample product catalog
    policies.json                       # Sample store policies
```

## Eval Scenarios

| Scenario                  | Category   | Difficulty | Description                                                 |
| ------------------------- | ---------- | ---------- | ----------------------------------------------------------- |
| Greeting                  | routing    | easy       | Basic greeting routes to Advisor_Agent                      |
| Product Search Multi-Turn | tool_usage | medium     | 3-turn flow with filter extraction and follow-up refinement |
| Multi-Agent Delegation    | delegation | hard       | Combined product + policy query spanning two agents         |
| Guard Rail Out of Scope   | safety     | easy       | Flight booking declined, alternatives suggested             |
| Conversation Continuity   | context    | medium     | Prior conversation summary referenced on resumption         |
| Automobile Domain         | tool_usage | medium     | Namespace switch to afg_automobiles with Toyota SUV filters |

## Model Configuration

- **Reasoning Model**: GPT-4.1 (all agents) -- handles conversation, tool calling, and response generation
- **Pipeline Classifier**: Qwen 3.5-35B-A3B (supervisor only) -- fast pre-classification with 0.85 confidence short-circuit threshold

## Usage

### Compile Check

```bash
pnpm build --filter=@abl/core --filter=@abl/compiler
node examples/afg-blue-advisory/compile-check.mjs
```

### Import to Platform

Use the v2 project import API:

```bash
curl -X POST http://localhost:3112/api/v1/projects/import \
  -H "Content-Type: application/json" \
  -d @project.json
```

### Run Evals

```bash
# Run the full regression suite
pnpm eval --project afg-blue-advisory --suite afg-regression

# Run a single scenario
pnpm eval --project afg-blue-advisory --scenario greeting
```
