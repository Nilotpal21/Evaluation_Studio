## Vanguard Service Orchestration Demo

Deck-aligned multi-agent retirement-service example for the Vanguard team.

Why this example exists:

- Matches the agent topology shown in the HTML deck
- Demonstrates supervisor routing, specialist ownership, workflow memory, sandbox tools, and KB-backed retrieval
- Stays deterministic enough for hosted trace validation while still feeling polished in a live customer demo

Project layout:

- `project.json` - import manifest for Studio and the import API
- `agents/` - `Vanguard_Supervisor` plus four specialists
- `tools/` - one tool per file to avoid hosted source-hash collisions during import
- `search/` - portable SearchAI index, source, and knowledge-base config for the hosted demo
- `knowledge/` - markdown documents used to seed the hosted `Retirement Policy KB`
- `SPEC.md` - full project spec and orchestration contract

## Agent Topology

- `Vanguard_Supervisor`
  Routes each request to the right specialist and preserves shared retirement context in workflow memory.
- `Portfolio_Review`
  Pulls a demo household snapshot, chooses the most relevant account, and tees up the next best action.
- `Contribution_Manager`
  Checks 2026 IRA limits, gathers age and amount across turns, and can schedule a demo contribution.
- `Rollover_Specialist`
  Collects rollover intake details, opens a demo case, and packages a smooth specialist follow-up.
- `Market_Insights`
  Uses the hosted KB when available and falls back to a curated demo policy library when it is not.

## Handoff Model

Not every specialist uses the same return strategy.

- `Portfolio_Review` and `Market_Insights` use `RETURN: true`
  These are mostly single-turn specialists, so control returns cleanly to the supervisor after the answer.
- `Contribution_Manager` and `Rollover_Specialist` use `RETURN: false`
  These are multi-turn intake flows. Letting the specialist retain control avoids restarting the child flow on the next user turn.

## Imported Tools

- `get_household_accounts`
  Demo household account list and a top-line summary.
- `get_portfolio_snapshot`
  Position snapshot for the selected account.
- `check_ira_limits`
  Demo-safe 2026 IRA contribution guidance.
- `extract_contribution_amount`
  Parses an explicitly requested contribution amount from the original user message.
- `execute_contribution`
  Demo contribution confirmation generator.
- `extract_rollover_source`
  Parses a likely rollover source plan from the original user message.
- `start_rollover_case`
  Demo rollover case intake tool.
- `schedule_rollover_callback`
  Demo rollover follow-up packaging tool.
- `search_demo_policy_library`
  Curated fallback policy and market knowledge search.

## Hosted Knowledge

The import bundle now carries the SearchAI layer for the hosted demo. After import and document upload, the project should expose:

- knowledge base `Retirement Policy KB`
- SearchAI-generated tool `search_kb_retirement_policy_kb`

`Market_Insights` is intentionally resilient. It tries the hosted KB first and falls back to the imported sandbox knowledge tool if the KB is missing or empty.

## Expected Studio Inventory

After a clean hosted sync, Studio should show:

- 5 agents
- 9 imported sandbox tools
- 1 generated SearchAI tool: `search_kb_retirement_policy_kb`
- 1 knowledge base: `Retirement Policy KB`

## Demo Journeys

### 1. Portfolio review

Prompt:

- `Show me my IRA balance`

Expected outcome:

- Routed to `Portfolio_Review`
- Calls `get_household_accounts` and `get_portfolio_snapshot`
- Returns a balance, holdings summary, household context, and natural next step

Trace pattern:

- `handoff` from `Vanguard_Supervisor` to `Portfolio_Review`
- `tool_call` for `get_household_accounts`
- `tool_call` for `get_portfolio_snapshot`

### 2. Cross-turn contribution flow

Prompt sequence:

1. `Show me my IRA balance`
2. `Schedule a 3500 contribution to it`
3. `52`

Expected outcome:

- First turn routes to `Portfolio_Review`
- Second turn routes to `Contribution_Manager`
- The contribution flow reuses the remembered IRA context from the prior review and can carry forward the requested amount from the user's original scheduling message
- Returns a demo confirmation id, applicable limit, and remaining room

Trace pattern:

- first-turn `handoff` to `Portfolio_Review`
- second-turn `handoff` to `Contribution_Manager`
- `tool_call` for `check_ira_limits`
- `tool_call` for `extract_contribution_amount`
- `tool_call` for `execute_contribution`

### 3. Contribution guidance without scheduling

Prompt sequence:

1. `How much can I contribute to my IRA in 2026?`
2. `52`

Expected outcome:

- Routed to `Contribution_Manager`
- Calls `check_ira_limits`
- Explains the applicable annual limit and current room before any new contribution
- Does not ask for an amount unless the user explicitly wants to test or schedule one
- Does not create a confirmation because scheduling was not explicitly requested

### 4. Rollover coordination

Prompt sequence:

1. `I want to roll an old 401k into an IRA`
2. `about 180000`

Expected outcome:

- Routed to `Rollover_Specialist`
- Carries forward the likely source plan from the original rollover request when it was already stated
- Calls `start_rollover_case`
- Calls `schedule_rollover_callback`
- Returns a rollover case id, next step, and callback packaging details

Trace pattern:

- `handoff` from `Vanguard_Supervisor` to `Rollover_Specialist`
- `tool_call` for `extract_rollover_source`
- `tool_call` for `start_rollover_case`
- `tool_call` for `schedule_rollover_callback`

### 5. Market and policy insights

Prompt:

- `What is the deadline for a 2026 IRA contribution?`

Expected outcome:

- Routed to `Market_Insights`
- Tries the hosted SearchAI tool `search_kb_retirement_policy_kb`
- Falls back to `search_demo_policy_library` if the KB is unavailable or empty
- Returns general guidance that is safe for a customer demo

Trace pattern:

- `handoff` from `Vanguard_Supervisor` to `Market_Insights`
- `tool_call` for `search_kb_retirement_policy_kb` when the hosted KB exists
- optional fallback `tool_call` for `search_demo_policy_library`

## Import Notes

- Import this folder into Studio or through the project import API.
- No environment variables are required for the imported sandbox tools.
- The import includes the SearchAI index, source, and KB config for `Retirement Policy KB`.
- After import, upload the markdown files from `knowledge/` into the `Demo Knowledge Upload` source and let indexing finish.
- That hosted indexing step exposes the project tool `search_kb_retirement_policy_kb`.
- Keep the sandbox fallback tool in the bundle even after KB provisioning so the demo still works in partially provisioned environments.
