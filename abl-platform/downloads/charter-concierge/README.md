# Charter Concierge

`charter-concierge` is a self-contained ABL example for a Charter Communications style telecom concierge.

It models the kinds of requests a Spectrum-facing assistant would need to handle:

- internet and mobile bundle recommendations
- setup and activation readiness
- account verification and billing credits
- current service and troubleshooting context
- policy and pricing explanations
- live support transfer for higher-trust or higher-touch cases

The bundle is intentionally designed as a teaching example, not just a demo chatbot. It is backed by live HTTP mock tools in [tools/charter_mocks.tools.abl](./tools/charter_mocks.tools.abl), a deployable mock API in [mock-server/](./mock-server/), deeper rationale docs in [docs/](./docs/), scenario narratives in [transcripts/](./transcripts/), and a regression test in [packages/project-io/src/**tests**/charter-concierge-bundle.test.ts](../../packages/project-io/src/__tests__/charter-concierge-bundle.test.ts).

## Why "Charter" Means Telecom Here

This example is scoped to Charter Communications and its Spectrum connectivity business, not private aviation.

The concept model is:

- converged connectivity recommendations
- internet plus WiFi plus mobile bundles
- account verification and billing care
- setup and activation readiness
- policy explanation
- live support routing

## Project Map

- [project.json](./project.json): importable v2 project manifest
- [agents/](./agents/): nine ABL agents covering supervisor, intake, deterministic recommendation, setup readiness, policy explanation, troubleshooting context, authentication, billing care, and live support transfer
- [tools/charter_mocks.tools.abl](./tools/charter_mocks.tools.abl): live HTTP tool bindings for the example
- [mock-server/](./mock-server/): deterministic Vercel mock API that backs the tool bindings
- [spec.md](./spec.md): concise construct map for the example
- [docs/](./docs/): porting notes, orchestration rationale, comparisons, observability notes, deterministic-control notes, and scenario review
- [transcripts/](./transcripts/): eight representative scenarios plus an index with narrative and trace notes

## Scenario Index

| Scenario | File                                                                                                               | What it demonstrates                                      | Primary constructs                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| Index    | [00-index.md](./transcripts/00-index.md)                                                                           | Coverage map across the scenario set                      | scenario inventory, review linkage                             |
| 1        | [01-supervisor-to-recommendation.md](./transcripts/01-supervisor-to-recommendation.md)                             | Supervisor handoff plus hidden recommendation delegate    | `SUPERVISOR`, `HANDOFF`, `DELEGATE`, `FLOW`, `CALL`            |
| 2        | [02-setup-readiness-deterministic-collection.md](./transcripts/02-setup-readiness-deterministic-collection.md)     | Deterministic entity collection and readiness blocking    | `ENTITIES`, `ENTITY_REF`, `CONSTRAINTS`, `FLOW`                |
| 3        | [03-policy-boundaries.md](./transcripts/03-policy-boundaries.md)                                                   | Why hard telecom requirements stay hard                   | `TOOLS`, `HANDOFF`, deterministic boundaries                   |
| 4        | [04-guardrail-block.md](./transcripts/04-guardrail-block.md)                                                       | Input guardrails blocking a fraud-sensitive request       | `GUARDRAILS`, `HANDOFF`                                        |
| 5        | [05-connectivity-advice-and-refresh.md](./transcripts/05-connectivity-advice-and-refresh.md)                       | Current service brief plus material change routing        | `TOOLS`, `HANDOFF`, reasoning plus deterministic orchestration |
| 6        | [06-live-support-transfer.md](./transcripts/06-live-support-transfer.md)                                           | Live support callback scheduling                          | `FLOW`, `CALL`, `HANDOFF`, deterministic escalation            |
| 7        | [07-billing-auth-return.md](./transcripts/07-billing-auth-return.md)                                               | Auth return before billing plus credit-ceiling routing    | `RETURN: true`, `FLOW`, `CONSTRAINTS`, `HANDOFF`               |
| 8        | [08-billing-guardrail-redaction-and-neutrality.md](./transcripts/08-billing-guardrail-redaction-and-neutrality.md) | Billing guardrails for sensitive input and neutral output | input `GUARDRAILS`, output `GUARDRAILS`, `reask`               |

## Why This Example Is Structured This Way

Use [docs/](./docs/) if you want the full rationale. The short version is:

- `HANDOFF` and `DELEGATE` are different because conversation ownership and subroutine execution are not the same thing.
- `ENTITIES` and `GATHER` are different because recognizing "address verified" is not the same as committing that state.
- `CONSTRAINTS` and `GUARDRAILS` are different because business validity is not the same as safety or fraud boundaries.
- `FLOW` and reasoning both matter because pricing, authentication, billing ceilings, and readiness should be replayable, while explanations and soft troubleshooting language should stay adaptive.

## Docs Guide

- [docs/00-porting-notes.md](./docs/00-porting-notes.md): what was ported from the stronger Spectrum blueprint and what was intentionally left out
- [docs/01-multi-agent-orchestration.md](./docs/01-multi-agent-orchestration.md): the core orchestration model in this bundle
- [docs/02-why-not-merge-constructs.md](./docs/02-why-not-merge-constructs.md): why `HANDOFF`, `DELEGATE`, `GATHER`, `CONSTRAINTS`, and `GUARDRAILS` stay separate
- [docs/03-comparison-langgraph-crewai-n8n.md](./docs/03-comparison-langgraph-crewai-n8n.md): side-by-side framing against other agent and workflow systems
- [docs/04-observability.md](./docs/04-observability.md): what ABL observability gives you beyond prompt and node logs
- [docs/05-deterministic-collection.md](./docs/05-deterministic-collection.md): how limitations, entity collection, constraints, and guardrails work together
- [docs/06-reasoning-plus-flow.md](./docs/06-reasoning-plus-flow.md): why deterministic flow and reasoning coexist instead of competing
- [docs/07-scenario-review.md](./docs/07-scenario-review.md): reviewer-style verdict across every scenario

## How To Use It

1. Import the folder rooted at `downloads/charter-concierge/`.
2. Start a session with `Charter_Concierge_Supervisor`.
3. Replay any prompt set from the transcript files.
4. Read [docs/](./docs/) alongside the transcripts if you want the construct rationale and scenario review.

## Live Mock API

The shared tool bundle is already bound to a public deterministic mock API:

- Base URL: `https://abl-charter-concierge-mock.vercel.app`
- Health check: `GET /api/router?endpoint=health`
- Tool bindings route through one live Vercel function because the Hobby plan caps the number of serverless functions.
- Example tool endpoint:
  - `POST /api/router?endpoint=search-service-offers`
- Additional logical endpoint names:
  - `assess-request-risk`
  - `lookup-account`
  - `check-recent-verification`
  - `send-otp`
  - `verify-otp`
  - `lock-session`
  - `create-plan-recommendation`
  - `validate-setup-readiness`
  - `lookup-service-policy`
  - `get-bill`
  - `get-payment-history`
  - `apply-credit`
  - `schedule-support-callback`
  - `get-service-brief`

If you want to redeploy the mock API under a different Vercel project, use [mock-server/](./mock-server/) and then update [tools/charter_mocks.tools.abl](./tools/charter_mocks.tools.abl) to the new base URL.

## Environment Requirements

No extra environment variables are required for the shared mock tools because the export is already bound to the live public mock API.

## Validation

Run build before test:

```bash
pnpm --filter @agent-platform/project-io build
pnpm --filter @agent-platform/project-io test -- charter-concierge-bundle
```

The validation test checks that the folder imports cleanly as a v2 project bundle, the mock tool file extracts successfully as HTTP bindings, the mock-server artifacts are present, and every agent parses and compiles without ABL spec errors.

## Transcript Fidelity

The transcripts are intentionally honest about two layers:

- Deterministic layer: serviceability checks, recommendation math, setup-readiness blocking, policy boundaries, callback ticket creation.
- Reasoning layer: how the assistant phrases explanations, summarizes tradeoffs, and transitions between specialists.

That means the transcripts are representative, not token-for-token golden outputs. The point is that ABL keeps the control-flow spine explicit even when the wording is adaptive.
