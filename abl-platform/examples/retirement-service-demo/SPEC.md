# Vanguard Service Orchestration Demo Spec

## Overview

This project is the runnable counterpart to the Vanguard HTML deck. It demonstrates a polished retirement-service experience built on supervisor-led multi-agent orchestration.

The example is designed to be:

- importable into Studio and the hosted import API
- runnable in `agents-dev`
- easy to validate through hosted traces
- polished enough for customer-facing platform demos

## Goals

- Match the deck topology with a real importable project
- Demonstrate distinct specialist experiences instead of a single monolithic agent
- Show workflow memory carrying context between specialists
- Show both single-turn and multi-turn orchestration patterns
- Demonstrate sandbox-tool execution and hosted SearchAI retrieval in one project
- Keep the experience stable enough to trace and explain live

## Non-Goals

- live Vanguard connectivity
- personalized investment advice
- tax, legal, or filing advice
- production-grade case management or transfer execution

## Personas

- solution consultant showing the platform to the Vanguard team
- platform engineer validating imports, tools, and traces
- customer architect reviewing how Kore.ai handles orchestration and grounding

## Experience Principles

- Keep every answer calm, concise, and executive-ready
- Show continuity across turns so the platform feels coordinated rather than fragmented
- Keep financial language operational and safe rather than advisory
- Use specialists to make the experience feel purposeful, not decorative
- Let traces clearly show what each agent and tool contributed to the outcome

## Project Assets

### Agents

- `Vanguard_Supervisor`
  Top-level router for portfolio review, contribution management, rollover coordination, and market or policy insight.
- `Portfolio_Review`
  Retrieves the demo household account snapshot and returns the most relevant retirement account summary.
- `Contribution_Manager`
  Calculates 2026 IRA contribution guidance and, when requested, produces a demo contribution confirmation.
- `Rollover_Specialist`
  Opens a demo rollover case and packages specialist follow-up.
- `Market_Insights`
  Answers broad market or policy questions using the hosted KB first and the sandbox fallback second.

### Imported Tools

- `get_household_accounts`
  Demo household account list and top-line summary.
- `get_portfolio_snapshot`
  Position snapshot for a selected account.
- `check_ira_limits`
  Demo-safe 2026 IRA limit calculation.
- `extract_contribution_amount`
  Parses an explicitly requested contribution amount from the user's original message.
- `execute_contribution`
  Demo contribution confirmation generator.
- `extract_rollover_source`
  Parses a likely rollover source plan from the user's original message.
- `start_rollover_case`
  Demo rollover case intake tool.
- `schedule_rollover_callback`
  Demo callback packaging tool for rollover follow-up.
- `search_demo_policy_library`
  Curated fallback knowledge tool for deadline, contribution, rollover, and general market themes.

### Hosted Knowledge

The import bundle includes portable SearchAI configuration. After import and document upload, the project should also expose:

- knowledge base `Retirement Policy KB`
- SearchAI-generated tool `search_kb_retirement_policy_kb`

### Knowledge Documents

- `knowledge/ira-contribution-deadline-2026.md`
- `knowledge/ira-contribution-limits-2026.md`
- `knowledge/rollover-readiness.md`
- `knowledge/market-guidance-themes.md`
- `knowledge/retirement-escalation-playbook.md`

## Orchestration Contract

### Supervisor behavior

`Vanguard_Supervisor` performs intent routing only. It does not answer specialist questions directly.

Routing lanes:

- rollover, transfer, advisor, or specialist requests -> `Rollover_Specialist`
- deadline, policy, market, fund, or outlook requests -> `Market_Insights`
- contribution, deposit, limit, room, or scheduling requests -> `Contribution_Manager`
- balance, IRA, account, position, or portfolio review requests -> `Portfolio_Review`

### Shared context

The demo uses workflow-scoped memory to preserve a lightweight retirement context:

- `workflow.customer_id`
- `workflow.customer_name`
- `workflow.default_account_id`

`Portfolio_Review` writes the default account context so a follow-up contribution request can feel natural without asking the user to restate the account.

### Return strategy

The demo deliberately uses two different handoff patterns.

- `Portfolio_Review` and `Market_Insights` use `RETURN: true`
  These specialists are usually single-turn, so the supervisor can resume cleanly after the answer.
- `Contribution_Manager` and `Rollover_Specialist` use `RETURN: false`
  These specialists collect information across turns. Letting them retain control prevents the child flow from restarting when the user answers a gather prompt.

This split is intentional and is part of the demo story: the platform can mix quick specialist consults with deeper multi-turn task ownership inside the same orchestration graph.

## Specialist Behavior

### Portfolio_Review

- Resolves the demo household
- Chooses the most relevant retirement account based on the request or prior workflow context
- Calls `get_household_accounts`
- Calls `get_portfolio_snapshot`
- Responds with balance, holdings, why it matters, household context, and a natural next step

### Contribution_Manager

- Defaults to tax year `2026`
- Chooses the current IRA based on explicit wording or saved workflow context
- Detects whether the user is asking for guidance only or scheduling
- Extracts an explicitly requested contribution amount from the original request when available
- Gathers age first and only asks for amount when it was not already provided
- Calls `check_ira_limits`
- Calls `execute_contribution` only when the request is within limit and explicitly asks to schedule
- Packages over-limit cases as specialist review rather than improvised tax guidance

### Rollover_Specialist

- Chooses a default destination IRA, with Roth routing when explicitly requested
- Extracts the likely source plan from the original rollover request when available
- Gathers source plan only when the user did not already provide it
- Gathers estimated amount across turns
- Calls `start_rollover_case`
- Calls `schedule_rollover_callback`
- Returns a case id, next step, and packaged callback

### Market_Insights

- Uses the hosted SearchAI KB when available
- Responds directly with concise KB content when the hosted KB has a match
- Falls back to `search_demo_policy_library` when the KB is not ready or returns no results
- Keeps guidance general and presentation-safe
- Avoids language that sounds like personalized advice

## Expected User Journeys

### 1. Portfolio review

Input:

- `Show me my IRA balance`

Behavior:

- Supervisor routes to `Portfolio_Review`
- `Portfolio_Review` calls `get_household_accounts`
- `Portfolio_Review` calls `get_portfolio_snapshot`
- Response includes selected account balance, holdings summary, and a next-step suggestion

Expected trace signals:

- one `handoff`
- two `tool_call` events
- child completion

### 2. Portfolio to contribution continuity

Input sequence:

1. `Show me my IRA balance`
2. `Schedule a 3500 contribution to it`
3. `52`

Behavior:

- Portfolio turn writes the selected IRA into workflow memory
- Contribution turn reuses that account context
- `Contribution_Manager` gathers age and can carry forward the requested amount from the scheduling utterance
- `Contribution_Manager` asks for amount only when the original request did not include one
- `Contribution_Manager` calls `check_ira_limits`
- `Contribution_Manager` calls `execute_contribution`

Expected trace signals:

- `handoff` to `Portfolio_Review`
- later `handoff` to `Contribution_Manager`
- `tool_call` for `extract_contribution_amount`
- `tool_call` for `check_ira_limits`
- `tool_call` for `execute_contribution`

### 3. Contribution guidance only

Input sequence:

1. `How much can I contribute to my IRA in 2026?`
2. `52`

Behavior:

- Routed to `Contribution_Manager`
- Returns the annual limit and current demo room before any new contribution
- Does not ask for an amount unless the user explicitly wants to test or schedule one
- Does not create a confirmation because scheduling was not requested

### 4. Rollover coordination

Input sequence:

1. `I want to roll an old 401k into an IRA`
2. `about 180000`

Behavior:

- Routed to `Rollover_Specialist`
- The common `old 401k into an IRA` wording carries the source plan forward from the original request
- Calls `start_rollover_case`
- Calls `schedule_rollover_callback`
- Returns rollover case id, next step, and callback packaging details

Expected trace signals:

- `handoff` to `Rollover_Specialist`
- `tool_call` for `extract_rollover_source`
- `tool_call` for `start_rollover_case`
- `tool_call` for `schedule_rollover_callback`

### 5. Market or policy insight

Input:

- `What is the deadline for a 2026 IRA contribution?`

Behavior:

- Routed to `Market_Insights`
- Calls `search_kb_retirement_policy_kb` when the hosted KB exists
- Falls back to `search_demo_policy_library` when the KB is not provisioned or returns no results
- Returns contribution-year guidance that is safe for demo use

## Import And Provisioning Model

### Portable import bundle

The import bundle includes:

- all five agents
- the nine sandbox tool files
- portable SearchAI config under `search/`
- project settings and environment metadata
- knowledge markdown that can be uploaded into the hosted KB

### Hosted post-import provisioning

The hosted environment still needs one document-ingestion step:

1. import the project so the `Retirement Policy KB` search layer is created
2. upload the markdown files from `knowledge/` into the `Demo Knowledge Upload` source
3. wait for processing to finish
4. confirm that the hosted tool `search_kb_retirement_policy_kb` appears in the project

This split exists because the KB configuration is portable, but the indexed document corpus and generated search tool only appear after the hosted environment processes uploaded content.

## Safety Constraints

- All responses must stay general and operational
- No personalized allocation advice
- No tax filing or deductibility advice
- Over-limit contribution cases should trigger specialist review language instead of corrective tax guidance
- Rollover guidance should emphasize process clarity and specialist review for edge cases

## Verification Checklist

- Imported project exposes the five deck-aligned agents
- Imported project exposes the nine sandbox tools used by the portfolio, contribution, rollover, and grounded insight journeys
- Hosted Studio inventory resolves to 5 agents, 10 visible tools, and 1 knowledge base after stale legacy assets are pruned
- Hosted project contains the `Retirement Policy KB` and SearchAI-generated tool `search_kb_retirement_policy_kb`
- Portfolio review, contribution, rollover, and market or policy journeys run successfully in `agents-dev`
- Trace inspection shows the expected handoff and tool-call pattern for each journey

## Known Limitations

- Document ingestion is still a hosted post-import step even though the SearchAI config is now part of the portable bundle
- Market insight quality is best when the KB has all markdown documents indexed; the sandbox fallback is deterministic but less rich
- All account, position, contribution, and rollover outputs are demo data rather than live customer data
