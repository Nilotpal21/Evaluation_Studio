/**
 * Keyword documentation for hover info.
 */
export const KEYWORD_DOCS: Record<string, string> = {
  agent:
    '**agent** — The name identifier for this agent.\n\nUsed as a reference in handoffs, delegates, and supervisor routing.',
  mode: '**mode** — The execution mode.\n\n- `reasoning`: LLM-driven, uses tools and constraints to achieve the goal\n- `scripted`: Flow-based, follows a defined step sequence',
  goal: '**goal** — What this agent aims to accomplish.\n\nProvided to the LLM as the primary objective.',
  persona: "**persona** — The agent's personality and communication style.",
  tools:
    "**tools** — List of tools the agent can use.\n\nEach tool is referenced by name and must be defined in the project's tool registry.",
  flow: '**flow** — Scripted conversation flow.\n\nDefines steps with transitions, gather fields, tool calls, and branching logic.\n\nOnly used in `mode: scripted` agents.',
  gather:
    '**gather** — Data gathering configuration.\n\nDefines fields to collect from the user, with types, validation, and extraction hints.',
  constraints:
    '**constraints** — Behavior constraints.\n\nRules the agent must follow. Each has a `rule` and an `action` (warn, block, escalate).',
  handoff:
    '**handoff** — Handoff targets.\n\nOther agents this agent can transfer the conversation to.',
  delegate:
    '**delegate** — Delegate targets.\n\nOther agents this agent can delegate subtasks to, receiving results back.',
  escalate:
    '**escalate** — Escalation configuration.\n\nWhen and how to escalate to a human agent.',
  memory:
    '**memory** — Memory configuration.\n\n- `session`: Per-conversation memory\n- `persistent`: Cross-session memory',
  guardrails: '**guardrails** — Safety guardrails.\n\nInput/output filters and safety checks.',
  on_error:
    '**on_error** — Error handlers.\n\nDefines recovery behavior when tools fail or constraints are violated.',
  complete:
    '**complete** — Completion configuration.\n\nHow the agent signals conversation completion.',
  respond:
    '**respond** — Send a message to the user.\n\nSupports template variables: `{{variable_name}}`.',
  call: '**call** — Invoke a tool.\n\nUse `call_with` / `call_as` on flow steps, or `call_spec.with` / `call_spec.as` in lifecycle and branch blocks.',
  then: '**then** — Transition to next step.\n\nThe name of the flow step to transition to.',
  when: '**when** — Guard condition (CEL expression).\n\nThis step is only entered if the condition evaluates to true.',
  set: '**set** — Variable assignments.\n\nSet context variables. Each entry has `variable` (name) and `expression`.',
  on_success: '**on_success** — Success handler for tool calls.',
  on_failure: '**on_failure** — Failure handler for tool calls.',
};
