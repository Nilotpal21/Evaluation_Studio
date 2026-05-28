# Multi-Agent Orchestration in ABL

This Charter bundle uses multiple agents because telecom support is not one job. Recommendation, setup readiness, billing, policy explanation, troubleshooting, authentication, and live transfer each want different control surfaces.

## The active orchestration lanes

| Lane                      | Agent path                     | Why it exists                                                                   |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Top-level routing         | `Charter_Concierge_Supervisor` | Keeps ownership of intent classification and specialist selection explicit      |
| New service and bundles   | `Charter_Intake_Agent`         | Handles fuzzy sales questions without losing deterministic offer search         |
| Hidden structured pricing | `Offer_Analyst`                | Produces replayable recommendation outputs without changing the visible speaker |
| Setup readiness           | `Setup_Readiness_Collector`    | Normalizes fuzzy setup language into deterministic install-safe state           |
| Current service advice    | `Connectivity_Advisor`         | Answers current-plan questions and routes material changes back into intake     |
| Policy explanation        | `Policy_Advisor`               | Explains hard rules without pretending to waive them                            |
| Auth gate                 | `Authentication_Agent`         | Creates a deterministic account-verification lane before billing work           |
| Billing care              | `Billing_Care_Agent`           | Grounds bill explanation and low-risk credits in tool results and policy        |
| Human transfer            | `Human_Support_Transfer`       | Owns deterministic callback creation and queue assignment                       |

## The key orchestration constructs

| Construct     | What it means here                                            |
| ------------- | ------------------------------------------------------------- |
| `HANDOFF`     | Change who owns the conversation                              |
| `DELEGATE`    | Run a bounded subroutine without changing the visible speaker |
| `FLOW`        | Make a sequence replayable and auditable                      |
| `GATHER`      | Commit the exact data the runtime needs                       |
| `CONSTRAINTS` | Enforce business rules before risky work proceeds             |
| `GUARDRAILS`  | Protect transport boundaries like input and output            |

## Three representative paths

### 1. New service recommendation

`Supervisor -> Charter_Intake_Agent -> Offer_Analyst`

- The supervisor hands off because service intake becomes the visible owner.
- Intake delegates because pricing is a subroutine, not a conversation transfer.
- The offer analyst runs deterministic recommendation math.

### 2. Billing with auth return

`Supervisor -> Authentication_Agent -> Supervisor -> Billing_Care_Agent`

- The supervisor hands off with `RETURN: true` because billing work is blocked on identity verification.
- Authentication finishes and returns control.
- The supervisor resumes routing and hands off to billing only after `user.is_authenticated == true`.

### 3. Unsupported or high-trust work

`Specialist -> Human_Support_Transfer`

- Sensitive requests, high-value credits, and failed auth do not get “best-effort” reasoning.
- They move to a deterministic callback or live-support lane.

## Why not one LLM with tools

One generalist LLM with every tool would blur four things that should stay visible:

- who owns the conversation now
- which work is deterministic versus adaptive
- where business rules are enforced
- what exactly happened when support or audit teams inspect the trace

ABL gives each of those its own authored surface. That is the main orchestration advantage.
