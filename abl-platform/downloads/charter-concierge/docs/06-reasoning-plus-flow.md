# Why Reasoning And Deterministic Flow Coexist

The point of this example is not to choose between reasoning and flow. It is to show where each belongs.

## Mode matrix

| Agent                          | Dominant mode                        | Why                                                                          |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| `Charter_Concierge_Supervisor` | Reasoning-first                      | Intent routing and explanation are adaptive                                  |
| `Charter_Intake_Agent`         | Reasoning with deterministic tools   | Needs conversational narrowing plus offer search                             |
| `Offer_Analyst`                | Deterministic flow, reasoning finish | Pricing should replay; explanation can vary                                  |
| `Setup_Readiness_Collector`    | Deterministic flow                   | Readiness rules should not drift                                             |
| `Connectivity_Advisor`         | Reasoning-first                      | Current-service guidance is mostly explanatory                               |
| `Policy_Advisor`               | Reasoning-first                      | Why-explanations should sound human                                          |
| `Authentication_Agent`         | Deterministic flow                   | OTP sequencing should not improvise                                          |
| `Billing_Care_Agent`           | Hybrid                               | Bill loading and credit policy are deterministic; explanation stays adaptive |
| `Human_Support_Transfer`       | Deterministic flow                   | Callback creation should be exact                                            |

## Pattern A: flow inside a reasoning conversation

`Charter_Intake_Agent -> Offer_Analyst`

The parent stays conversational. The child runs deterministic pricing steps. This is the clearest example of why `DELEGATE` exists.

## Pattern B: handoff across modes

`Supervisor -> Authentication_Agent -> Supervisor -> Billing_Care_Agent`

The customer moves from reasoning router to scripted auth flow and back to a hybrid billing specialist. That is one session crossing orchestration modes on purpose.

## Pattern C: reasoning after deterministic checkpoints

`Billing_Care_Agent` loads the bill and payment history deterministically, then explains the result in natural language. The numbers are stable even if the wording changes.

## Why this beats reasoning-only

Reasoning-only systems struggle when you need:

- replayable OTP sequences
- explicit approval ceilings
- deterministic setup or install gating

## Why this beats flow-only

Flow-only systems struggle when you need:

- nuanced tradeoff explanation
- conversational intent clarification
- natural transitions between specialists

The combined model is better because the boundary is authored explicitly instead of emerging accidentally.
