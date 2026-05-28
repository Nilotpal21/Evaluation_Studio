# Examples Rewrite — Export/Import Format with Best Practices

**Date**: 2026-03-12
**Status**: In Progress

## Goal

Rewrite all example agents in the `examples/` folder to:

1. Use the v2 export/import folder format (project.json, abl.lock, agents/, tools/, locales/, etc.)
2. Apply current ABL DSL best practices (EXECUTION blocks, pipeline mode, behavior profiles)
3. For AFG Blue Advisory specifically: include full evals recreated from the e2e test scenarios

## Decisions

### Scope: All Examples

| #   | Example              | Agents           | Group           | Priority |
| --- | -------------------- | ---------------- | --------------- | -------- |
| 1   | afg-blue-advisory    | 3                | AFG (dedicated) | P0       |
| 2   | travel               | 9                | Commerce        | P1       |
| 3   | retail               | 7                | Commerce        | P1       |
| 4   | unified              | 6                | Commerce        | P1       |
| 5   | telco                | 7                | Operations      | P1       |
| 6   | apple-care           | 6                | Operations      | P1       |
| 7   | DisputeTransaction   | 9                | Operations      | P1       |
| 8   | banknexus            | 4                | Banking         | P1       |
| 9   | agent-transfer       | 2                | Banking         | P2       |
| 10  | env-demo             | 2                | Banking         | P2       |
| 11  | guardrails           | 2                | Patterns        | P1       |
| 12  | flow-test            | 8→1 consolidated | Patterns        | P1       |
| 13  | tool-bindings        | 2                | Integration     | P1       |
| 14  | a2a-demo             | 2                | Integration     | P1       |
| 15  | crawler              | 1                | Integration     | P2       |
| 16  | search-ai-strategies | 3                | Search          | P1       |
| 17  | airlines             | 4                | Search          | P1       |
| 18  | saludsa              | 16               | Search          | P1       |
| 19  | saludsa-imported     | skip (duplicate) | —               | —        |

### DSL Best Practices Applied

1. **EXECUTION block** replaces deprecated `MODE:` and `MODEL:` sections
2. **Pipeline mode** added to all supervisors (sequential, confidence 0.85)
3. **VERSION: "1.0"** and **DESCRIPTION:** added to all agents
4. **LIMITATIONS:** section used where agents have clear boundaries
5. **Behavior profiles** created for channel-specific overrides where applicable
6. **GATHER** uses `inline_gather: true` in EXECUTION for faster extraction
7. **Flow agents** use CALL WITH/AS, SET, TRANSFORM where applicable
8. **COMPLETE** conditions explicitly defined

### Export Format (v2)

Each example becomes:

```
examples/<name>/
  project.json              # v2 manifest
  agents/
    supervisor.agent.abl
    <agent_name>.agent.abl
  tools/
    <tool_name>.tools.abl
  config/
    project-settings.json
  environment/
    env-vars.json           # References only (no secrets)
  locales/
    en/
      <agent_name>.json
  README.md
```

### AFG Blue Advisory — Special Treatment

Full export with evals layer:

```
examples/afg-blue-advisory/
  project.json
  agents/
    guardrail_supervisor.agent.abl
    advisor_agent.agent.abl
    store_policy_agent.agent.abl
  tools/
    product_search.tools.abl
    policy_search.tools.abl
  config/
    project-settings.json
    agent-model-configs/
      guardrail_supervisor.json    # GPT-4.1 + Qwen pipeline
      advisor_agent.json           # GPT-4.1
      store_policy_agent.json      # GPT-4.1
  environment/
    env-vars.json
  evals/
    afg-regression/
      eval-set.json
      scenarios/
        greeting.scenario.json
        product_search_multiturn.scenario.json
        multi_agent_delegation.scenario.json
        guard_rail_out_of_scope.scenario.json
        conversation_continuity.scenario.json
        automobile_domain.scenario.json
      personas/
        happy_path_shopper.persona.json
        edge_case_explorer.persona.json
        adversarial_tester.persona.json
    evaluators/
      response_quality.evaluator.json
      tool_correctness.evaluator.json
      routing_accuracy.evaluator.json
  locales/
    en/
      guardrail_supervisor.json
      advisor_agent.json
      store_policy_agent.json
  fixtures/
    products.json
    policies.json
  README.md
```

**Models configured:**

- Main LLM: OpenAI GPT-4.1 (via `OPENAI_API_KEY`)
- Pipeline classifier: Qwen3.5-35B-A3B (via `Qwen3.5-35B-A3B_API_KEY` + `Qwen3.5-35B-A3B_URL`)
- Filler generator: Same Qwen model

**Evals recreated from e2e test scenarios:**

- 6 scenarios mapping to the 6 e2e test cases
- 3 personas (happy path, edge case, adversarial)
- 3 evaluators (response quality, tool correctness, routing accuracy)

### Flow-Test Consolidation

The 8 flow-test variants are consolidated into a single best example:

- `hotel_booking_advanced.agent.abl` as the primary (demonstrates all flow patterns)
- Uses SET, CALL WITH/AS, ON_RESULT, TRANSFORM, CONSTRAINTS

### Environment Variables

Each example's `environment/env-vars.json` documents required env vars with descriptions but no values:

```json
{
  "variables": [
    { "key": "OPENAI_API_KEY", "description": "OpenAI API key for GPT-4.1", "required": true }
  ]
}
```

## Parallel Execution Plan

7 agents dispatched simultaneously:

| Agent             | Examples                                | Est. Files |
| ----------------- | --------------------------------------- | ---------- |
| AFG Agent         | afg-blue-advisory (with evals)          | ~25        |
| Commerce Agent    | travel, retail, unified                 | ~35        |
| Operations Agent  | telco, apple-care, DisputeTransaction   | ~35        |
| Banking Agent     | banknexus, agent-transfer, env-demo     | ~15        |
| Patterns Agent    | guardrails, flow-test (consolidated)    | ~10        |
| Integration Agent | tool-bindings, a2a-demo, crawler        | ~15        |
| Search Agent      | search-ai-strategies, airlines, saludsa | ~30        |
