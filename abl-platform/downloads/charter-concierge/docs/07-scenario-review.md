# Scenario Review

This file is the explicit review pass over the transcript set after the Spectrum-to-Charter port.

## Review verdict

| Scenario                                    | Verdict | Strongest construct                                  | Review note                                                                                       |
| ------------------------------------------- | ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. Supervisor to recommendation             | Pass    | `HANDOFF` + `DELEGATE`                               | Clear explanation of ownership transfer vs hidden subroutine work                                 |
| 2. Setup readiness deterministic collection | Pass    | `ENTITIES` + `ENTITY_REF` + `CONSTRAINTS`            | Strong deterministic story; ready-state logic is easy to audit                                    |
| 3. Policy boundaries                        | Pass    | reasoning plus deterministic policy lookup           | Good explanation of “why” without pretending to waive rules                                       |
| 4. Guardrail block                          | Pass    | input `GUARDRAILS`                                   | Good fraud-sensitive example; intentionally narrower than Spectrum’s project-wide guardrail story |
| 5. Connectivity advice and refresh          | Pass    | reasoning plus material-change routing               | Good example of advice staying adaptive while upgrades stay explicit                              |
| 6. Live support transfer                    | Pass    | `FLOW` + `CALL` + `HANDOFF`                          | Clean deterministic callback example                                                              |
| 7. Billing auth return                      | Pass    | `RETURN: true` + auth `FLOW` + billing `CONSTRAINTS` | Fills the biggest teaching gap from the earlier Charter version                                   |
| 8. Billing guardrails                       | Pass    | input redaction + output `reask`                     | Makes billing safety boundaries visible without needing project-wide guardrail artifacts          |

## Coverage summary

| Concern from the original request                       | Covered by                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| How multi-agent orchestration works                     | Scenarios 1, 6, 7 and [01-multi-agent-orchestration.md](./01-multi-agent-orchestration.md)  |
| Why constructs cannot be merged                         | Scenarios 1, 2, 7, 8 and [02-why-not-merge-constructs.md](./02-why-not-merge-constructs.md) |
| Comparison with LangGraph, CrewAI, n8n                  | [03-comparison-langgraph-crewai-n8n.md](./03-comparison-langgraph-crewai-n8n.md)            |
| How observability is different                          | [04-observability.md](./04-observability.md) plus transcript trace notes                    |
| Constraints, guardrails, limitations, entity collection | Scenarios 2, 4, 7, 8 and [05-deterministic-collection.md](./05-deterministic-collection.md) |
| Deterministic and reasoning orchestration together      | Scenarios 1, 5, 7 and [06-reasoning-plus-flow.md](./06-reasoning-plus-flow.md)              |

## Review findings

### Finding 1: the missing auth-return story is now covered

Before the port, the runnable Charter bundle did not show the most important control pattern from the Spectrum example: authenticate, return, then resume the blocked domain lane. Scenario 7 closes that gap.

### Finding 2: guardrail coverage is still intentionally narrower than Spectrum

The Spectrum reference used a project-wide guardrail story. This working Charter bundle uses agent-level guardrails instead so the example stays fully importable and compile-clean in the local v2 export pipeline.

This is an intentional tradeoff, not an omission by accident.

### Finding 3: the scenario set is now balanced between reasoning and deterministic lanes

The set now covers:

- reasoning-first routing and advice
- deterministic setup collection
- deterministic auth flow
- deterministic live transfer
- hybrid billing
- guardrail behavior

That balance makes the “reasoning plus flow” argument materially stronger.

## Residual limitations

- The transcripts are representative narratives, not byte-for-byte golden traces.
- The mock tools are deterministic but still demo-grade, not production systems.
- Tool-input and handoff guardrails are discussed in docs, but the runnable bundle demonstrates agent-level input/output guardrails rather than a project-wide policy layer.

No blocking scenario issues were found after the port. The remaining gaps are scope choices made to preserve correctness and importability.
