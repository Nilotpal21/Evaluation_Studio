# AFG Blue Advisory — E2E Test Results

**Last run:** 2026-03-20
**Branch:** develop
**Lane:** `pnpm --dir apps/runtime test:afg-e2e`

## Architecture

- **GuardRail_Supervisor** → routes to **Advisor_Agent** or **Store_Policy_Agent**
- **Advisor_Agent**: `product_search` tool (AFG Render search service)
- **Store_Policy_Agent**: `policy_search` tool (Kore.ai SearchAI KB)
- **LLM:** OpenAI GPT-4.1 (reasoning mode)
- **Pipeline:** Qwen3.5-35B-A3B for fast routing classification

## Results: 11 passed, 3 failed (14 total)

### Pipeline Mode (7 passed, 2 failed)

| #   | Test                                                             | Status | Notes                                                                                         |
| --- | ---------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| 1   | Greeting — hello returns friendly greeting                       | PASS   |                                                                                               |
| 2   | Product Search — red sneakers returns product results            | PASS   |                                                                                               |
| 3   | Automobile Search — Toyota SUV returns car results               | PASS   |                                                                                               |
| 4   | Guard Rail — flight booking is declined with alternatives        | FAIL   | Supervisor did not reject the off-topic request; routed to Advisor_Agent instead of declining |
| 5   | Multi-turn — follow-up refines previous search                   | PASS   |                                                                                               |
| 6   | Summary Continuity — summary references prior results            | PASS   |                                                                                               |
| 7   | Delegation — product + policy query triggers cross-agent handoff | FAIL   | LLM did not produce expected cross-agent delegation                                           |

### No-Pipeline Mode (4 passed, 1 failed)

| #   | Test                                                           | Status | Notes                                  |
| --- | -------------------------------------------------------------- | ------ | -------------------------------------- |
| 8   | NP: Greeting — hello returns friendly greeting                 | PASS   |                                        |
| 9   | NP: Product Search — red sneakers returns product results      | PASS   |                                        |
| 10  | NP: Automobile — Toyota SUV returns car results                | PASS   |                                        |
| 11  | NP: Multi-turn — follow-up refines previous search             | PASS   |                                        |
| 12  | NP: Delegation — product + policy triggers cross-agent handoff | FAIL   | Same delegation issue as pipeline mode |

### Skipped (2)

| #   | Test                                  | Status | Notes                                 |
| --- | ------------------------------------- | ------ | ------------------------------------- |
| 13  | Policy Search — return policy from KB | SKIP   | Requires `AFG_SEARCHAI_TOKEN` env var |
| 14  | NP: Policy Search                     | SKIP   | Requires `AFG_SEARCHAI_TOKEN` env var |

## Bug Fixes Applied This Run

- **DSL file paths**: Fixed 4 path references in test file:
  - `supervisor.agent.abl` → `agents/guardrail_supervisor.agent.abl` (2 occurrences)
  - `tools/product_search.tool.abl` → `tools/product_search.tools.abl`
  - `tools/policy_search.tool.abl` → `tools/policy_search.tools.abl`

## Failure Analysis

### Guard Rail Decline (Test #4)

The supervisor agent is expected to decline off-topic requests (e.g., "book me a flight to Paris") with alternatives. Instead, it routes to Advisor_Agent. This suggests the guardrail routing logic in the supervisor DSL or the pipeline classifier doesn't have strong enough rejection criteria for out-of-scope queries.

### Delegation (Tests #7, #12)

Queries combining product + policy intent (e.g., "find red sneakers and what's the return policy") should trigger cross-agent delegation between Advisor_Agent and Store_Policy_Agent. The LLM handles the product portion but does not initiate a handoff to Store_Policy_Agent for the policy part. This is likely a DSL or prompt engineering issue in the supervisor's routing instructions.

## How to Run

```bash
pnpm --dir apps/runtime test:afg-e2e
```

Required env vars: `OPENAI_API_KEY`, `Qwen3.5-35B-A3B_API_KEY`, `Qwen3.5-35B-A3B_URL`
Optional: `AFG_SEARCHAI_ENDPOINT`, `AFG_SEARCHAI_TOKEN` (enables policy search tests)
