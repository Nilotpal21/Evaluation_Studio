export const RUNTIME_CONSTRUCT_DECISION_CARD = `## Runtime Construct Decision Card

Use this card when designing or building agents from a blueprint. The goal is not to use every ABL construct; the goal is to choose the smallest runtime-supported shape that satisfies the user's requirements.

### First decision: who owns the next action?
- Use GATHER when the value must come from the user and cannot be safely inferred or looked up.
- Use CALL when a declared tool can retrieve, validate, calculate, create, or update the value more reliably than asking the user.
- Use HANDOFF when conversation control should move to another agent. Use RETURN: true only when the original agent must resume after the child agent completes; otherwise use RETURN: false for terminal transfers.
- Use DELEGATE when the parent owns the workflow and needs a child agent's result before continuing.
- Use ESCALATE for human queue/case transfer. Do not generate human_approval yet unless the target runtime path is explicitly proven for that project.

### Tool result handling
- Prefer CALL with WITH and AS when the step depends on tool output:

\`\`\`abl
CALL: lookup_order
  WITH:
    order_id: order_id
    email: customer_email
  AS: orderResult
\`\`\`

- Use ON_SUCCESS / ON_FAILURE for simple success-vs-failure control.
- Use ON_RESULT when the next step depends on fields inside the result, such as status codes, eligibility flags, or alternative offers.
- After a tool call, SET any durable values that later RESPOND, COMPLETE, HANDOFF, DELEGATE, or CEL conditions need. Do not reference undeclared result fields in cross-agent WHEN conditions.

### Flow completion
- Prefer explicit THEN: COMPLETE on terminal steps.
- Use COMPLETE conditions for agent-level completion gates. Avoid step-level COMPLETE_WHEN unless there is a specific reason; compiler diagnostics warn because it can end a scripted step earlier than authors expect.
- A specialist that returns to a router should complete only after it has produced the promised summary/result variables and any required user confirmation.

### Cross-agent context
- Before HANDOFF or DELEGATE, decide exactly which values the child needs. Pass only those values through CONTEXT.pass or INPUT mappings.
- If the parent must continue from a child result, define a return/result contract and SET the returned values into parent-visible variables before using them in RESPOND, CEL, or next-step routing.
- HANDOFF WHEN expressions may reference declared gather fields, memory/session variables, tool results, or runtime variables. Never invent condition variables like incident, known_issue, or faq_or_howto unless the agent declares or sets them first.

### Response variables and CEL
- RESPOND templates may use variables that are gathered, set, saved from tools, or granted through context. If the source is uncertain, add a SET step first or ask for the missing field.
- Keep CEL expressions flat and explicit: field != null, flag == true, status == "eligible". Avoid nested invented namespaces unless MEMORY, SET, or tool AS defines them.
- Use COALESCE for optional response values and mask/redact sensitive values before displaying them.

### Generation guardrails
- Do not add constructs just because the DSL supports them. Complexity must come from the use case.
- When unsure between a simple scripted flow and a complex hybrid flow, start scripted for deterministic required-field/tool/action paths and add REASONING only where judgment is needed.
- Every generated agent should compile, avoid undeclared references, have a clear exit path, and make handoff/delegate semantics visible in the blueprint before build.`;
