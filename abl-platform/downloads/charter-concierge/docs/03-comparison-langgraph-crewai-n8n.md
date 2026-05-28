# ABL vs LangGraph vs CrewAI vs n8n

This comparison uses one Charter-style question:

> “My internet was out last week. I want a credit. If you need to verify me first, do it, then bring me back.”

## The core difference in one table

| System    | Primary authoring unit            | How auth-return is expressed                         | Where deterministic policy lives               | What observability centers on                                 |
| --------- | --------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| ABL       | Agent language constructs         | `HANDOFF` with `RETURN: true`                        | `FLOW`, `CONSTRAINTS`, `GUARDRAILS` in the DSL | Semantic events like handoff, delegate, constraint, guardrail |
| LangGraph | Graph nodes and state transitions | Manual state machine edges and return state          | Custom node code and graph logic               | Node execution and state transitions                          |
| CrewAI    | Crews, tasks, and flows           | Usually task chaining or flow logic                  | Task code plus flow rules                      | Task and flow execution traces                                |
| n8n       | Workflow nodes and branches       | Workflow re-entry, webhooks, or stateful node wiring | IF nodes, code nodes, workflow branches        | Workflow runs and node inputs/outputs                         |

## Why ABL feels different

ABL is not better because it has more raw power. It is better for this use case because the interesting orchestration concepts are first-class language concepts:

- `HANDOFF` says the owner changed.
- `RETURN: true` says ownership comes back.
- `CONSTRAINTS` say the credit ceiling is enforced by runtime policy.
- `GUARDRAILS` say billing content boundaries are enforced outside the model prompt.

In the other systems, these are possible, but they are usually assembled from more generic primitives.

## What this means in practice

### Compared with LangGraph

LangGraph is strong when you want explicit graph code, fine-grained state transitions, and custom orchestration loops. ABL shifts the emphasis from graph plumbing to semantic authorship. You write what the runtime should mean, not only how the graph should branch.

### Compared with CrewAI

CrewAI is strong when you want task-oriented multi-agent collaboration. ABL puts more weight on runtime policy surfaces like constraints and guardrails, and less on general-purpose task choreography.

### Compared with n8n

n8n is strong when the job is workflow automation first. ABL is stronger when the job is agent conversation first and the workflow has to remain inspectable as agent-native semantics.

## The decision rule

Use ABL when the thing you care about most is:

- who owns the conversation
- when deterministic gates fire
- how safety and business rules differ
- how those decisions show up in traces without custom logging
