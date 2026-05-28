import { ABL_CONSTRUCT_EXPERT_SYNTAX } from '@agent-platform/arch-ai/prompts/construct-expert';
import type { AgentArchitecturePlan } from '@agent-platform/arch-ai/planning';
import type { DomainContextInput } from './scaffold/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentGenerationContext {
  agentSpec: {
    name: string;
    role: string;
    executionMode: 'reasoning' | 'scripted' | 'hybrid';
    description?: string;
    tools?: string[];
    gatherFields?: string[];
    gatherFieldSource?: 'declared' | 'inferred' | 'none';
    flowStepSeeds?: string[];
    flowStepSource?: 'declared' | 'inferred' | 'none';
    isEntry: boolean;
    suggestedConstructs?: string[];
  };
  topology: {
    agents: Array<{
      name: string;
      role: string;
      executionMode: string;
      description?: string;
      tools?: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      type: string;
      experienceMode?: string;
      condition?: string;
      expectReturn?: boolean;
    }>;
  };
  domain: DomainContextInput;
  sensitivity?: { categories: string[]; evidence: string[] };
  modelRec?: { provider: string; model: string; temperature: number; maxTokens: number };
  retryFeedback?: {
    attempt: number;
    errors: string[];
    warnings?: string[];
    hint?: string;
    diagnosticCodes?: string[];
    retryReason?: string;
  };
  /** Pre-computed architecture plan from topology analysis */
  plan?: AgentArchitecturePlan;
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

/**
 * Render the architecture plan as a structured specification section.
 * Complements the Entry-Point Routing and Return-Path Contract sections
 * by providing pre-computed structural requirements derived from topology.
 */
function renderArchitecturePlan(plan: AgentArchitecturePlan): string {
  const sections: string[] = [];

  sections.push(`## Architecture Plan (pre-computed from topology)

This section is the source of truth for what this agent MUST produce.
Follow these specifications exactly.`);

  sections.push(`DSL Keyword: ${plan.keyword}
Archetype: ${plan.archetype}
Entry Agent: ${plan.isEntry ? 'yes' : 'no'}

### Complexity Decision
Selected execution mode: ${plan.complexity.selectedExecutionMode}
Complexity level: ${plan.complexity.level}
Reason: ${plan.complexity.reason}
Signals: ${plan.complexity.signals.length > 0 ? plan.complexity.signals.join(', ') : 'none'}`);

  if (plan.gather.required) {
    const fieldHint =
      plan.gather.suggestedFields.length > 0
        ? `\nSeed fields from topology: ${plan.gather.suggestedFields.join(', ')} (expand with domain-specific fields)`
        : "\nDerive domain-specific GATHER fields from this agent's role and description.";
    sections.push(`### GATHER: REQUIRED
Reason: ${plan.gather.reason}${fieldHint}
You MUST include a GATHER section with fields that drive toward COMPLETE conditions.`);
  } else {
    sections.push(`### GATHER: Optional
${plan.gather.reason}`);
  }

  if (plan.complete.required) {
    sections.push(`### COMPLETE: REQUIRED
Reason: ${plan.complete.reason}
You MUST include COMPLETE conditions that reference GATHER fields.
Without COMPLETE, the parent agent blocks forever waiting for return.`);
  } else {
    sections.push(`### COMPLETE: Optional
${plan.complete.reason}`);
  }

  if (plan.flow.recommended) {
    sections.push(`### FLOW: Recommended
Mode: ${plan.flow.executionMode}
${plan.flow.reason}`);
  }

  if (plan.handoffs.targets.length > 0) {
    const targetLines = plan.handoffs.targets.map((t) => {
      const whenText = t.condition ? t.condition : `intent.category == "${toIntentCategory(t.to)}"`;
      return `  - TO: ${t.to}\n    WHEN: ${whenText}\n    RETURN: ${t.returnExpected}`;
    });
    const catchAllBlock = plan.handoffs.needsCatchAll
      ? `\n  # Catch-all REQUIRED — emit this LAST so unmatched intents route to the broadest specialist:\n  - TO: ${plan.handoffs.catchAllTarget ?? '<broadest specialist>'}\n    WHEN: true\n    RETURN: true`
      : '';
    sections.push(`### HANDOFF Targets (from topology — preserve targets and return flags)
You MUST include every TO: target listed below in the agent's HANDOFF block. Do not substitute the agent's own name for any TO:.
When a topology edge has no condition, use the generated intent.category condition or replace it with a declared, runtime-actionable intent category. Do not use prose placeholders.

\`\`\`yaml
HANDOFF:
${targetLines.join('\n')}${catchAllBlock}
\`\`\`

**Remote (external) handoff variant**: if a target is a registered external A2A-compatible agent (NOT defined in this project), add \`LOCATION: remote\` and use \`RETURN: false\` — endpoint, protocol, and auth resolve from the external-agent registry by TO: name. Never inline ENDPOINT, PROTOCOL, or auth fields. Example:
\`\`\`yaml
HANDOFF:
  - TO: PartnerSupportAgent
    LOCATION: remote
    WHEN: intent.category == "partner_support"
    CONTEXT:
      pass: [customer_id, order_id]
    RETURN: false
\`\`\`
Local handoffs (default) OMIT LOCATION; do not write \`LOCATION: local\`.`);
  } else {
    sections.push(`### HANDOFF: None
No outgoing handoff targets. Use FLOW, COMPLETE, or RESPOND instead of inventing routing.`);
  }

  const passSeedLine =
    plan.allowedPassFields.length > 0
      ? `Topology field seeds that may become valid CONTEXT.pass candidates once this agent declares or collects them: ${plan.allowedPassFields.join(', ')}`
      : 'No topology-provided CONTEXT.pass seeds were detected for this agent.';
  const returnSeedLines = plan.handoffs.targets
    .filter((target) => target.returnExpected && (target.returnFieldSeeds?.length ?? 0) > 0)
    .map((target) => `- ${target.to}: ${(target.returnFieldSeeds ?? []).join(', ')}`);
  const summaryHintLines = plan.handoffs.targets
    .filter((target) => target.historyHint?.summaryRecommended)
    .map((target) => {
      const focusFields =
        (target.historyHint?.summaryFocusFields?.length ?? 0) > 0
          ? ` Focus fields when known: ${target.historyHint?.summaryFocusFields.join(', ')}.`
          : '';
      return `- ${target.to}: author CONTEXT.summary. Seed: "${target.historyHint?.summaryTemplateSeed}"${focusFields}`;
    });
  const historyHintLines = plan.handoffs.targets
    .filter((target) => target.historyHint)
    .map(
      (target) =>
        `- ${target.to}: prefer history: ${target.historyHint?.suggestedHistory} when you author CONTEXT.summary. ${target.historyHint?.reason}`,
    );
  const returnContractLines = plan.handoffs.targets
    .filter((target) => target.returnExpected && target.returnContractHint)
    .map((target) => `- ${target.to}: ${target.returnContractHint?.reason}`);
  sections.push(`### Handoff Continuity
Runtime continuity is explicit — gathered state does not automatically cross agent boundaries.
Use CONTEXT.pass only for fields that already exist in this agent's session state.
Use CONTEXT.summary when the child mainly needs a concise brief, and prefer history: auto with that summary. The runtime resolves auto to summary_only only when the target supports summary-only handoff behavior; otherwise it falls back to bounded raw history.
Use explicit history: summary_only only when you intentionally want strict summary-only transfer.
Use BEHAVIOR_PROFILE for shared customer voice, channel shaping, and handoff continuity; do not duplicate those global rules inside every specialist PERSONA.
RETURN: true already default-merges child gathered fields back to the parent by same name. Use ON_RETURN.map only when the parent needs renamed fields, selective mapping, or non-gather child outputs.
Only use ON_RETURN.map keys that the child agent actually gathers or populates before it returns.
Use context.memory_grants only for declared MEMORY.persistent paths that truly need cross-agent access.
${passSeedLine}`);

  if (summaryHintLines.length > 0) {
    sections.push(`### Summary Hints
These hints are derived from topology context so CONTEXT.summary carries the right brief into the child:
${summaryHintLines.join('\n')}`);
  }

  if (historyHintLines.length > 0) {
    sections.push(`### Handoff History Hints
These hints are derived from target execution mode and mirror the runtime's auto history behavior:
${historyHintLines.join('\n')}`);
  }

  if (returnSeedLines.length > 0) {
    sections.push(`### Default Return Fields
These target gather fields already flow back to the parent by same name on RETURN: true when no ON_RETURN.map overrides that behavior:
${returnSeedLines.join('\n')}`);
  }

  if (returnContractLines.length > 0) {
    sections.push(`### Return Contract Hints
These hints are derived from runtime return behavior:
${returnContractLines.join('\n')}`);
  }

  if (plan.blocked.length > 0) {
    const blockedLines = plan.blocked.map((b) => `- BLOCKED: ${b.pattern} — ${b.detail}`);
    sections.push(`### Blocked Patterns
${blockedLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

function toIntentCategory(agentName: string): string {
  return agentName
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Assembles the full system prompt for a single parallel agent generation
 * worker. Includes the compiler-aligned BUILD prompt plus the agent, topology,
 * and domain context needed for a single-agent generation pass.
 */
export function buildAgentSystemPrompt(context: AgentGenerationContext): string {
  const { agentSpec, topology, domain, sensitivity, modelRec, retryFeedback } = context;

  const sections: string[] = [];
  const workerContractRules = [
    'Generate only the agent named below.',
    'Do not ask the user questions.',
    'Do not present completion widgets or discuss other phases.',
    'Call `generate_agent` with the full ABL YAML.',
    'Call `compile_abl` immediately after each generation pass.',
    'Treat compilation as necessary but not sufficient: the final artifact must also have a coherent runtime path, routing contract, and terminal response shape.',
    'If validation fails, fix the reported syntax or runtime-shape issues, regenerate the full ABL, and run `compile_abl` again.',
    'Keep repair loops targeted and avoid repeating the same invalid syntax.',
    'Use topology agent names exactly as given for any `TO:` or routing target.',
    '`MEMORY.remember[].STORE.target` must always be a declared `MEMORY.persistent[].path`, never a bare session variable name.',
    'Prefer the compiler-verified syntax in the prompt above over any legacy reference material.',
  ];
  const ablGenerationRules = [
    'Use UPPERCASE DSL format (AGENT:, GOAL:, PERSONA:, TOOLS:) — never lowercase YAML keys',
    'EVERY agent needs: GOAL:, PERSONA:, MEMORY: with session variable, GUARDRAILS: with content_safety',
    'TOOLS: use arrow-signature format: `tool_name(param: type) -> { field: type }`',
    'SUPERVISOR agents MUST end HANDOFF list with catch-all: WHEN: true, RETURN: true. Returnable child AGENTs must COMPLETE; do not add a catch-all HANDOFF back to the supervisor.',
    // SV-13: CRITICAL — COMPLETION without a state path is a blocking error
    'COMPLETION requires a state path: If an agent has a COMPLETE block, the referenced fields must be populated by user GATHER, CONTEXT.pass, MEMORY, FLOW SET, or tool result state. Without a state path, the agent cannot make progress toward completion and will block forever (SV-13). This applies to ALL agents with COMPLETE, not just delegates.',
    'Delegate targets (RETURN: true in HANDOFF): MUST have completion state and a COMPLETE block. Add GATHER only for values the child must ask the user for directly.',
    'FLOW: every step in `steps:` list MUST have a matching step definition block',
    'FLOW CALL: use `CALL: tool_name` with nested `WITH:` args and optional `AS: result_name`; never emit object-shaped `CALL:` / `tool:` / `args:` / `save:` blocks.',
    'HANDOFF CONTEXT: pass: fields MUST match declared MEMORY.session variable names',
    'If the source session contract is unclear, omit HANDOFF CONTEXT.pass rather than inventing fields like IDs or issue summaries',
    // C-07: Prevent the `user_authenticated` anti-pattern
    'CONSTRAINTS: NEVER reference variables that are not declared in GATHER or MEMORY.session. The identifier `user_authenticated` has NO runtime source in ABL — any constraint using it always evaluates incorrectly and must be removed (C-07). Only constrain on fields you actually collect.',
    // G-09: Prevent ghost GATHER fields
    'GATHER: ONLY declare fields you reference in at least one COMPLETE WHEN condition, HANDOFF PASS block, or FLOW step. Every GATHER field must drive toward completion — if a field is not in any COMPLETE condition it is wasted conversation turns (G-09).',
    'GATHER validation rules belong under a real field. Never create a standalone GATHER field named validation; use validation: under invoice_id, email, order_number, etc.',
    // CO-04: Return contract integrity
    'Return contracts: When you HANDOFF with RETURN: true, the target agent MUST have a COMPLETE block. Do NOT add a HANDOFF back to the caller to simulate return; runtime returns through the parent thread stack after COMPLETE.',
    // CO-07: Reachable completion
    'COMPLETE conditions: Every WHEN condition must be reachable — if you require a field to equal a specific value, ensure your FLOW/GATHER logic actually sets that value. Unreachable completions cause infinite waiting.',
    // O-01/O-02: Clear identity
    'GOAL must be specific and actionable — not "Help users" or "Handle requests". Say WHAT the agent does (e.g., "Cancel flight bookings and process refunds"). PERSONA must define communication style and domain expertise.',
    // G-03: Field usage consistency
    'Field references: If you use a field in COMPLETE, HANDOFF CONTEXT.pass, or FLOW logic, you MUST either (a) collect it in GATHER or (b) declare it in MEMORY.session. Never reference undeclared fields.',
    'For scripted or hybrid agents, FLOW must reflect the real business journey for this project. Do not fall back to generic placeholder steps like greet -> collect_info -> process -> complete unless the requirement is genuinely that simple.',
    'FLOW tool execution: scripted agents MUST use explicit `CALL:` steps for deterministic lookups, calculations, validations, creates, updates, sends, and case creation. Hybrid agents may use `REASONING: true` with `available_tools` only for open-ended analysis or option selection, but known API work still needs explicit `CALL`, `AS`, and `ON_RESULT`/`ON_SUCCESS`/`ON_FAILURE` handling.',
    'Do not use `REASONING: true` as a substitute for a known tool call. If the step name starts with or implies lookup, search, calculate, validate, create, update, cancel, book, send, store, notify, or escalate, write a concrete `CALL:` block unless there is a clear reason the LLM must choose among tools dynamically.',
    'Handoff and COMPLETE WHEN values must be raw runtime expressions, not whole quoted strings: write `WHEN: intent.category == "billing"` or `WHEN: issue_id != null`, never `WHEN: "intent.category == \\"billing\\""`. Never use placeholders like "matching intent" or "<infer from agent role>".',
    'TOOLS: Every signature must include a nested `description: "..."` line. If the same tool name is used by multiple agents, every agent must declare the exact same signature, return shape, and description for that tool.',
  ];
  const finalInstructions = [
    'Follow the worker contract tool sequence exactly: generate, compile, fix the reported validation issues, and recompile.',
    'Use the topology context for HANDOFF or delegation targets when this agent routes to siblings.',
    'Prefer concise, compilable ABL over large speculative sections.',
    'Make the agent richly functional for its role and domain — not a minimal stub.',
  ];

  // Syntax reference only — no in-project tools, no conversational BUILD phase instructions.
  // Knowledge cards (platform-limits, delegate-full) removed — they added ~1.6K tokens
  // of platform status info and DELEGATE details that most agents don't need.
  // The return-path contract is already in ABL_CONSTRUCT_EXPERT_SYNTAX.
  sections.push(ABL_CONSTRUCT_EXPERT_SYNTAX);

  // Architecture Plan — pre-computed structural specification derived
  // from topology. Complements (not replaces) the Entry-Point Routing and
  // Return-Path Contract sections further below, which emit exact ABL YAML.
  if (context.plan) {
    sections.push(renderArchitecturePlan(context.plan));
  }

  sections.push(`## Single-Agent Worker Contract

You are the focused BUILD worker for exactly one topology agent.

${workerContractRules.map((rule) => `- ${rule}`).join('\n')}

## ABL Auto-Fix Pipeline
The system has a safety net for missing mandatory sections, but final BUILD artifacts must be domain-specific and runtime-meaningful.
Author the real structure yourself: GOAL, PERSONA, MEMORY, GUARDRAILS, HANDOFF conditions, GATHER fields, COMPLETE conditions, and FLOW logic when needed.
Generic auto-filled fields or placeholder questions are not acceptable final output.

## Final Runtime Shape Contract
Generate the shape the project should keep, not just YAML that compiles.

- Every source-grounded user journey implied by this agent's role must have an executable path: entry behavior, state collection or context intake, tool/reasoning work, handoff when needed, and a terminal outcome.
- Entry behavior may use \`ON_START\` when it is genuinely useful, but it must not mask or replace handling of the user's first real request. The first real user request should be processed into routing, gathering, tool use, or a substantive response.
- Use one routing-state vocabulary per supervisor or routing decision point. If you derive a helper field from classifier output or gathered state, make that mapping explicit before evaluating HANDOFF or FLOW conditions.
- Supervisors and routers need an executable fallback for unmatched or ambiguous requests, either a final catch-all handoff or an in-agent clarification/response path.
- Specialist agents must return useful state or visible content according to their handoff experience. Silent/internal completion is valid only when the parent has guaranteed mapped state that will produce the visible response.
- Terminal paths must not produce an empty customer experience. Before finalizing, check the end-to-end path: who speaks, what state is returned, what tool result is used, and what happens on ambiguity or failure.

## CRITICAL ABL Generation Rules
${ablGenerationRules.map((rule) => `- ${rule}`).join('\n')}
`);

  sections.push(`## Runtime Expression Contract

Use runtime-actionable boolean expressions wherever ABL evaluates conditions: HANDOFF WHEN, COMPLETE WHEN, FLOW ON_INPUT, CALL success_when, CONSTRAINTS, and SET-derived state.

- Prefer explicit parentheses for nested logic: \`(status == "active" OR priority == "high") AND approval_needed == true\`.
- Runtime accepts legacy ABL operators such as \`AND\`, \`OR\`, \`IS SET\`, and CEL-style operators such as \`&&\` and \`||\`; keep one style consistent inside a condition.
- Use null-safe checks such as \`field != null\` or \`field IS SET\`. Use \`has(obj.field)\` only for member access, not as a bare-field shortcut.
- Use \`abl.*\` helpers only when they make the condition clearer, such as \`abl.lower(channel) == "email"\`.
- Supervisor intent routes should use declared or derivable categories, for example \`intent.category == "billing"\`.
- delegate INPUT mappings are dot-path mappings only; do not put CEL expressions in delegate INPUT.
- Never emit empty conditions, \`WHEN: ""\`, prose placeholders, or values like \`matching intent\`.`);

  if (
    retryFeedback &&
    (retryFeedback.errors.length > 0 ||
      (retryFeedback.warnings?.length ?? 0) > 0 ||
      typeof retryFeedback.hint === 'string' ||
      (retryFeedback.diagnosticCodes?.length ?? 0) > 0 ||
      typeof retryFeedback.retryReason === 'string')
  ) {
    const errorLines =
      retryFeedback.errors.length > 0
        ? retryFeedback.errors
            .slice(0, 8)
            .map((error) => `- ${error}`)
            .join('\n')
        : '- No compiler errors were preserved from the prior attempt.';
    const warningLines =
      (retryFeedback.warnings?.length ?? 0) > 0
        ? retryFeedback.warnings
            ?.slice(0, 6)
            .map((warning) => `- ${warning}`)
            .join('\n')
        : '';
    const compilerHint =
      typeof retryFeedback.hint === 'string' && retryFeedback.hint.trim().length > 0
        ? retryFeedback.hint.trim()
        : '';
    const diagnosticCodes =
      (retryFeedback.diagnosticCodes?.length ?? 0) > 0
        ? retryFeedback.diagnosticCodes?.join(', ')
        : '';
    const retryReason =
      typeof retryFeedback.retryReason === 'string' && retryFeedback.retryReason.trim().length > 0
        ? retryFeedback.retryReason.trim()
        : '';

    sections.push(`## Previous Build Validation Feedback

This is retry attempt ${retryFeedback.attempt}. The previous ABL failed build validation.
Some feedback may be compiler syntax; some may be runtime-readiness contract feedback from the generated project behaving incorrectly.
Fix these exact validation issues before you call \`generate_agent\` again.

Errors:
${errorLines}${warningLines ? `\n\nWarnings:\n${warningLines}` : ''}${diagnosticCodes ? `\n\nDiagnostic codes:\n- ${diagnosticCodes}` : ''}${compilerHint ? `\n\nCompiler hint:\n${compilerHint}` : ''}${retryReason ? `\n\nRetry policy note:\n${retryReason}` : ''}

Do not repeat the same invalid syntax or runtime contract. Address the validation feedback directly, then call \`compile_abl\` again.`);
  }

  // Agent to Generate
  let agentSpecSection = `## Agent to Generate

Name: ${agentSpec.name}
Role: ${agentSpec.role}
Execution Mode: ${agentSpec.executionMode}
Entry Agent: ${agentSpec.isEntry ? 'yes' : 'no'}`;

  if (agentSpec.description) {
    agentSpecSection += `\nDescription: ${agentSpec.description}`;
  }
  if (agentSpec.tools && agentSpec.tools.length > 0) {
    agentSpecSection += `\nTools: ${agentSpec.tools.join(', ')}`;
  }
  if (agentSpec.gatherFields && agentSpec.gatherFields.length > 0) {
    agentSpecSection += `\nGather Fields: ${agentSpec.gatherFields.join(', ')}`;
  }
  if (agentSpec.flowStepSeeds && agentSpec.flowStepSeeds.length > 0) {
    agentSpecSection += `\nSuggested Flow Steps: ${agentSpec.flowStepSeeds.join(' -> ')}`;
  }
  if (agentSpec.suggestedConstructs && agentSpec.suggestedConstructs.length > 0) {
    agentSpecSection += `\nSuggested Constructs: ${agentSpec.suggestedConstructs.join(', ')}`;
  }

  sections.push(agentSpecSection);

  if (agentSpec.gatherFieldSource === 'inferred' && (agentSpec.gatherFields?.length ?? 0) > 0) {
    sections.push(`## Requirement-Derived Gather Hints

The topology did not declare strong gather fields for this agent, so BUILD inferred a project-aware starting set from the agent role, approved blueprint, edge conditions, and interview notes.

Use these fields unless you can author clearly better domain-specific refinements:
- ${agentSpec.gatherFields?.join('\n- ')}

Do not collapse back to generic placeholders like \`info\`, \`details\`, or \`user_input\`. Every field should map to a real business need for this project.`);
  }

  if (
    agentSpec.flowStepSource === 'inferred' &&
    (agentSpec.flowStepSeeds?.length ?? 0) > 0 &&
    (agentSpec.executionMode === 'scripted' || agentSpec.executionMode === 'hybrid')
  ) {
    sections.push(`## Suggested Flow Outline

This ${agentSpec.executionMode} agent should use FLOW because the work is structured enough to benefit from ordered steps.

Start from this requirement-aware outline:
- ${agentSpec.flowStepSeeds?.join('\n- ')}

Each step in \`FLOW.steps\` must have a matching definition block below it. Make the step logic specific to the project's journey, data needs, and exit condition.`);
  }

  // Return-path guidance
  const incomingEdges = topology.edges.filter((e) => e.to === agentSpec.name);
  const hasReturnExpectation = incomingEdges.some((e) => e.expectReturn === true);

  if (hasReturnExpectation) {
    sections.push(`## Return-Path Contract — CRITICAL
This agent is a delegate target — at least one supervisor expects control to return.
You MUST include BOTH a GATHER: block and a COMPLETE: block.

GATHER fields define what data the agent collects. COMPLETE conditions reference that collected data.

⚠️ SV-13 BLOCKING ERROR: An agent with COMPLETE but no GATHER or FLOW cannot make progress.
The parent agent will block forever waiting for return. This is a deploy-blocking error.

For all execution modes: COMPLETE is runtime-evaluated against session state, so the WHEN expression must reference fields your GATHER or FLOW actually populates.
Do not use natural-language phrases like "issue resolved" as COMPLETE conditions.
Use RESPOND: "" for explicit silent completion when the agent already answered or is only returning control to a parent. Do not omit RESPOND — the runtime falls back to the generic conversation_complete message.

Example:
\`\`\`yaml
GATHER:
  issue_summary:
    type: string
    required: true
    prompt: "Can you describe the issue you're experiencing?"
  resolution_confirmed:
    type: boolean
    required: true
    prompt: "Has the issue been resolved to your satisfaction?"

COMPLETE:
  - WHEN: issue_summary != null AND resolution_confirmed == true
    RESPOND: ""
\`\`\`

Replace the field names and questions with domain-specific ones for this agent's role.`);
  }

  const outgoingEdges = topology.edges.filter((e) => e.from === agentSpec.name);
  const hasOutgoingHandoffs = outgoingEdges.length > 0;

  if (hasOutgoingHandoffs || hasReturnExpectation) {
    sections.push(`## Handoff Continuity — CRITICAL
The runtime does NOT automatically move gathered state across agent boundaries.
Author cross-agent continuity deliberately:

- Use CONTEXT.pass only for fields that already exist in GATHER or MEMORY.session and are populated before the handoff runs.
- Use CONTEXT.summary when the child mainly needs a concise brief, and prefer history: auto with that summary. The runtime resolves auto to summary_only only when the target supports summary-only handoff behavior; otherwise it falls back to bounded raw history.
- Use explicit history: summary_only only when you intentionally want strict summary-only transfer.
- Use BEHAVIOR_PROFILE for shared customer voice, channel shaping, and handoff continuity; do not duplicate those global rules inside every specialist PERSONA.
- RETURN: true already merges child gathered fields back to the parent by same name. Add ON_RETURN as a structured object only when the parent needs renamed fields, selective mapping, or non-gather child outputs.
- Only use ON_RETURN.map keys that the child agent actually gathers or populates before it returns.
- Use context.memory_grants only for declared MEMORY.persistent paths that must be shared across the handoff boundary.
- Do not rely on legacy inline ON_RETURN shorthand in newly generated code.`);
  }

  const incomingSharedVoiceEdges = incomingEdges.filter(
    (edge) => edge.experienceMode === 'shared_voice_handoff',
  );
  if (incomingSharedVoiceEdges.length > 0) {
    sections.push(`## Shared Voice Continuity — CRITICAL
This agent receives shared_voice_handoff traffic from: ${incomingSharedVoiceEdges.map((edge) => edge.from).join(', ')}.

Add \`USE BEHAVIOR_PROFILE: shared_voice_handoff\` near the top of this agent's ABL.
Continue the existing customer conversation as the same perceived assistant. Do not re-introduce yourself, announce an internal transfer, or repeat an empathy acknowledgment already made in the conversation history.`);
  }

  if (agentSpec.isEntry) {
    const handoffLines = outgoingEdges
      .map((e) => {
        const condition = e.condition || `intent.category == "${toIntentCategory(e.to)}"`;
        return `- TO: ${e.to} WHEN: ${condition} RETURN: ${e.expectReturn !== false}`;
      })
      .join('\n');

    // Also list agents that DON'T have explicit edges — they still need handoff rules
    const edgeTargets = new Set(outgoingEdges.map((e) => e.to));
    const unlinkedAgents = topology.agents
      .filter((a) => a.name !== agentSpec.name && !edgeTargets.has(a.name))
      .map((a) => a.name);

    sections.push(`## Entry-Point Routing — CRITICAL
This agent is the entry point. Use SUPERVISOR: keyword (not AGENT:).

You MUST include a HANDOFF rule for EVERY agent listed below. Missing any causes CROSS-02 (orphaned agents).

Required HANDOFF rules:
${handoffLines}${unlinkedAgents.length > 0 ? `\n\nThese agents also need HANDOFF rules (no explicit edge in topology — derive a valid intent.category route from their role):\n${unlinkedAgents.map((n) => `- TO: ${n} WHEN: intent.category == "${toIntentCategory(n)}"`).join('\n')}` : ''}

Add a catch-all HANDOFF as the LAST rule: WHEN: true pointing to the most general specialist.`);
  }

  // Topology Context — compact format (agent names + full edge list only, not full JSON)
  const siblingNames = topology.agents.map((a) => `${a.name} (${a.executionMode})`).join(', ');
  const allEdges = topology.edges
    .map(
      (e) =>
        `${e.from} → ${e.to} [${e.type}${e.experienceMode ? `, experienceMode: ${e.experienceMode}` : ''}${e.condition ? `, when: "${e.condition}"` : ''}${e.expectReturn ? ', RETURN: true' : ''}]`,
    )
    .join('\n');
  const toolUsage = new Map<string, string[]>();
  for (const agent of topology.agents) {
    for (const tool of agent.tools ?? []) {
      const users = toolUsage.get(tool) ?? [];
      users.push(agent.name);
      toolUsage.set(tool, users);
    }
  }
  const duplicateToolContracts = [...toolUsage.entries()]
    .filter(([tool, users]) => users.length > 1 && (agentSpec.tools ?? []).includes(tool))
    .map(
      ([tool, users]) =>
        `- ${tool}: ${tool}(request: object) -> { success: boolean, data: object, message: string }\n` +
        `  description: "Execute ${tool} for the current ${domain.domain} workflow."\n` +
        `  shared by: ${users.join(', ')}`,
    )
    .join('\n');
  const allAgentTools = topology.agents
    .filter((agent) => (agent.tools ?? []).length > 0)
    .map((agent) => `- ${agent.name}: ${(agent.tools ?? []).join(', ')}`)
    .join('\n');

  sections.push(`## Topology Context

Agents: ${siblingNames}
${allEdges ? `\nFull topology edges:\n${allEdges}` : ''}
${allAgentTools ? `\nAgent tool usage:\n${allAgentTools}` : ''}`);

  if (duplicateToolContracts) {
    sections.push(`## Canonical Shared Tool Contracts

These tool names are used by multiple agents. To avoid ProjectTool bootstrap drift, copy the exact signature and description below in this agent's TOOLS section. Do not add, remove, or rename parameters for these shared tools.

${duplicateToolContracts}`);
  }

  const sourceToolContracts = (domain.sourceTools ?? [])
    .filter((tool) => (agentSpec.tools ?? []).includes(tool.name))
    .map((tool) => {
      const guidance = [
        tool.callWhen?.length ? `  call_when: ${tool.callWhen.join('; ')}` : '',
        tool.doNotCallWhen?.length ? `  do_not_call_when: ${tool.doNotCallWhen.join('; ')}` : '',
      ].filter(Boolean);
      return [
        `- ${tool.name}${tool.signature ? `: ${tool.signature}` : ''}`,
        tool.description ? `  description: ${tool.description}` : '',
        ...guidance,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  if (sourceToolContracts) {
    sections.push(`## Source Tool Contracts

The uploaded source documents define these tool contracts and call boundaries. Preserve these signatures and descriptions when filling tool-facing prose.

${sourceToolContracts}`);
  }

  const sourceConsentPolicies = (domain.consentPolicies ?? [])
    .filter((policy) => !policy.toolName || (agentSpec.tools ?? []).includes(policy.toolName))
    .map((policy) =>
      [
        `- ${policy.toolName ?? policy.action}: confirm=${policy.requiredIn === 'conversation' || policy.mode === 'never' ? 'never' : 'when_side_effects'}`,
        `  consent_required_in: ${policy.requiredIn}`,
        policy.scopeFields.length > 0 ? `  consent_scope: ${policy.scopeFields.join(', ')}` : '',
        `  fallback: ${policy.fallback}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');

  if (sourceConsentPolicies) {
    sections.push(`## Source Consent Policies

The uploaded source documents define write-action consent boundaries. If consent is established conversationally, do not ask the customer to reply yes again.

${sourceConsentPolicies}`);
  }

  // Domain Context
  const languageLabel = domain.language && domain.language !== 'English' ? domain.language : null;
  sections.push(`## Domain Context

Domain: ${domain.domain}
Channels: ${domain.channels.join(', ')}${languageLabel ? `\nLanguage: ${languageLabel} — ALL agent responses MUST be in ${languageLabel}. Include a PERSONA directive: "Always respond in ${languageLabel}."` : ''}
Compliance: ${domain.compliance.length > 0 ? domain.compliance.join(', ') : 'none'}
Integrations: ${domain.integrations.length > 0 ? domain.integrations.join(', ') : 'none'}
Tone: ${domain.tone}`);

  if (domain.blueprintSummary) {
    sections.push(`## Blueprint Rationale

Use this approved blueprint summary as the architectural intent for the generated agent:

${domain.blueprintSummary}`);
  }

  // Data Sensitivity (optional)
  if (sensitivity && sensitivity.categories.length > 0) {
    sections.push(`## Data Sensitivity\n\nCategories: ${sensitivity.categories.join(', ')}`);
  }

  // Model Recommendation (optional)
  if (modelRec) {
    sections.push(`## Model Recommendation

Provider: ${modelRec.provider}
Model: ${modelRec.model}
Temperature: ${modelRec.temperature}
Max Tokens: ${modelRec.maxTokens}`);
  }

  // Instructions
  sections.push(`## Instructions

Generate a complete, valid ABL agent definition for the agent described above.

${finalInstructions.map((instruction) => `- ${instruction}`).join('\n')}`);

  return sections.join('\n\n');
}
