# Transcripts — How Charter Concierge Behaves In Real Sessions

Each transcript is a narrated scenario tied to real ABL constructs from `agents/` and deterministic outputs from `tools/charter_mocks.tools.abl`.

## Scenario index

| #   | Transcript                                                                                   | Core constructs shown                                                                   |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | [Supervisor to recommendation](./01-supervisor-to-recommendation.md)                         | `SUPERVISOR`, `HANDOFF`, `DELEGATE`, `FLOW`, deterministic pricing                      |
| 2   | [Setup readiness deterministic collection](./02-setup-readiness-deterministic-collection.md) | `ENTITIES`, `ENTITY_REF`, `GATHER`, `CONSTRAINTS`, `FLOW`                               |
| 3   | [Policy boundaries](./03-policy-boundaries.md)                                               | reasoning plus deterministic policy lookup                                              |
| 4   | [Guardrail block](./04-guardrail-block.md)                                                   | input `GUARDRAILS`, fraud-sensitive blocking                                            |
| 5   | [Connectivity advice and refresh](./05-connectivity-advice-and-refresh.md)                   | reasoning plus material-change routing                                                  |
| 6   | [Live support transfer](./06-live-support-transfer.md)                                       | `FLOW`, `CALL`, deterministic callback creation                                         |
| 7   | [Billing auth return](./07-billing-auth-return.md)                                           | `HANDOFF` with `RETURN: true`, auth `FLOW`, billing `CONSTRAINTS`, live-support routing |
| 8   | [Billing guardrails](./08-billing-guardrail-redaction-and-neutrality.md)                     | input redaction, output `reask`, safe boundary handling                                 |

## Coverage view

| Transcript | Reasoning | Deterministic flow | Handoff  | Delegate | Guardrails | Constraints |
| ---------- | --------- | ------------------ | -------- | -------- | ---------- | ----------- |
| 1          | Yes       | Yes                | Yes      | Yes      | No         | Yes         |
| 2          | Minimal   | Yes                | No       | No       | No         | Yes         |
| 3          | Yes       | Minimal            | Possible | No       | No         | Yes         |
| 4          | Minimal   | No                 | Yes      | No       | Yes        | No          |
| 5          | Yes       | Minimal            | Yes      | No       | No         | Minimal     |
| 6          | Minimal   | Yes                | Yes      | No       | No         | Minimal     |
| 7          | Yes       | Yes                | Yes      | No       | No         | Yes         |
| 8          | Yes       | Minimal            | No       | No       | Yes        | Minimal     |

Read [../docs/07-scenario-review.md](../docs/07-scenario-review.md) for the reviewer-style verdict across the full scenario set.
