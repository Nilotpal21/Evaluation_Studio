# ARCH Specialist Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance ARCH's topology generation and agent generation pipeline with a 3-stage architecture: topology reasoning with pattern intelligence, parallel agent enrichment with construct discovery, and compile-fix loops.

**Architecture:** 3 internal helpers (`getRelevantConstructs`, `getModelRecommendation`, `compileAndFix`) enrich the existing `generate_topology`/`generate_agents` tool orchestration. 1 new specialist-visible tool (`get_topology_patterns`) for project mode. The LLM-facing surface stays simple; intelligence is behind the existing tools.

**Tech Stack:** TypeScript, Vercel AI SDK `tool()`, Zod schemas, `@abl/core` parser, `@abl/compiler`, existing `ArchLLMResolution` for LLM calls.

**Design Spec:** `docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md`

---

## File Map

### New Files

| File                                                              | Responsibility                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/construct-catalog.ts`                | Full ABL construct catalog (34 constructs) with syntax, examples, and selection rules |
| `apps/studio/src/lib/arch-ai/helpers/get-relevant-constructs.ts`  | Deterministic construct selection by agent role/domain                                |
| `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` | Model recommendation wrapping `model-capabilities.ts`                                 |
| `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts`          | Iterative compile-fix loop (max 3 rounds)                                             |
| `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`            | Cross-agent validation (handoff targets, orphans, delegate returns)                   |
| `apps/studio/src/lib/arch-ai/tools/get-topology-patterns.ts`      | Specialist-visible tool for project mode topology queries                             |
| `apps/studio/src/lib/arch-ai/topology-patterns.ts`                | Pattern catalog data (5 patterns + decision tree)                                     |

### Modified Files

| File                                                     | What Changes                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/shared/src/prompts/prompt-catalog.ts`          | Rewrite `arch.generate.topology_system` and `topology_user` with pattern catalog             |
| `apps/studio/src/services/arch.service.ts`               | Enhance `generateSingleAgent()` prompt injection, `generateTopologyStub()` pattern-awareness |
| `apps/studio/src/lib/arch-ai/tools/generate-topology.ts` | Enhanced Zod schema with `pattern`, `role`, `suggestedConstructs`, canonical edge types      |
| `apps/studio/src/lib/arch-ai/tools/generate-agents.ts`   | Wire `getRelevantConstructs`, `getModelRecommendation`, `compileAndFix` into pipeline        |
| `apps/studio/src/lib/arch-ai/abl-builder.ts`             | Enhanced `buildAbl()` with construct-aware stub generation                                   |
| `apps/studio/src/lib/arch-ai/context.ts`                 | Add `get_topology_patterns` to project context tool list                                     |
| `apps/studio/src/lib/arch-ai/types.ts`                   | Add `TopologyPattern`, `ConstructCatalogEntry`, `ModelRecommendation` types                  |

---

## Task 1: Types and Topology Pattern Data

**Files:**

- Create: `apps/studio/src/lib/arch-ai/topology-patterns.ts`
- Modify: `apps/studio/src/lib/arch-ai/types.ts:51-103`

- [ ] **Step 1: Add new types to types.ts**

Read `apps/studio/src/lib/arch-ai/types.ts` first, then append these types after the existing exports:

```typescript
// --- Staged Pipeline Types (2026-04-03) ---

export type TopologyPatternId =
  | 'single_agent'
  | 'triage_specialists'
  | 'pipeline'
  | 'hub_spoke'
  | 'mesh';

export type CanonicalEdgeType = 'routing' | 'handoff' | 'delegate' | 'escalation' | 'pipeline_next';

export interface TopologyPattern {
  id: TopologyPatternId;
  name: string;
  whenToUse: string;
  structure: string;
  ablImplications: string;
  edgeTypes: CanonicalEdgeType[];
  antiPatterns: string[];
}

export interface ConstructCatalogEntry {
  keyword: string;
  description: string;
  syntax: string;
  example: string;
  commonMistakes: string[];
  whenNotToUse: string;
}

export interface ConstructCatalogResponse {
  constructs: ConstructCatalogEntry[];
  totalTokenEstimate: number;
}

export interface ModelRecommendation {
  primary: { provider: string; model: string; reason: string };
  perOperation?: Record<string, { provider: string; model: string; reason: string }>;
  executionConfig: {
    temperature: number;
    maxTokens: number;
    compactionPolicy?: string;
  };
}

export interface CompileFixResult {
  success: boolean;
  rounds: number;
  finalAbl: string;
  errors?: Array<{ line?: number; message: string; severity: string }>;
  warnings?: Array<{ line?: number; message: string }>;
  constructsUsed: string[];
}

export interface CrossAgentValidationResult {
  valid: boolean;
  errors: Array<{
    type: string;
    severity: 'error' | 'warning';
    sourceAgent: string;
    targetAgent?: string;
    message: string;
    suggestion?: string;
  }>;
}
```

- [ ] **Step 2: Create topology-patterns.ts**

````typescript
import type { TopologyPattern } from './types.js';

export const TOPOLOGY_PATTERNS: TopologyPattern[] = [
  {
    id: 'single_agent',
    name: 'Single Agent',
    whenToUse:
      'One domain, no routing needed. Simple Q&A, task completion, or single-purpose assistant.',
    structure: '1 AGENT (reasoning or hybrid). No supervisor.',
    ablImplications:
      'No HANDOFF needed. Use GATHER + TOOLS + CONSTRAINTS. FLOW for scripted/hybrid mode.',
    edgeTypes: [],
    antiPatterns: [
      'Do not add a SUPERVISOR for a single agent — it adds latency and complexity with no benefit.',
      'Do not use this pattern when there are 2+ clearly distinct capability domains.',
    ],
  },
  {
    id: 'triage_specialists',
    name: 'Triage -> Specialists',
    whenToUse:
      'Multiple distinct domains where user intent determines which agent handles the request. Customer support, help desks, multi-purpose bots.',
    structure:
      '1 SUPERVISOR (NLU-driven routing) -> N specialist AGENTs. Supervisor classifies intent and routes.',
    ablImplications:
      'Supervisor needs NLU + HANDOFF. Each specialist is independent with its own TOOLS/GATHER/CONSTRAINTS. Most common pattern.',
    edgeTypes: ['routing', 'handoff', 'escalation'],
    antiPatterns: [
      'Do not use for sequential workflows — if step 2 always follows step 1, use Pipeline instead.',
      'Do not create specialists with overlapping responsibilities — each must have a clear domain boundary.',
    ],
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    whenToUse:
      'Sequential workflow where each stage transforms or enriches data before passing to the next. Loan processing, document intake, multi-step approval.',
    structure:
      'Chain of AGENTs connected by pipeline_next edges. Each agent completes its stage then hands off.',
    ablImplications:
      'Each agent does one job. FLOW-driven (scripted/hybrid). GATHER in early stages, TOOLS in middle stages, RESPOND at end. Use ON_START for stage initialization.',
    edgeTypes: ['pipeline_next', 'escalation'],
    antiPatterns: [
      'Do not use when steps can run in parallel — use Hub-and-Spoke with delegate instead.',
      'Do not use for conversational routing — Pipeline assumes fixed sequence, not dynamic intent.',
    ],
  },
  {
    id: 'hub_spoke',
    name: 'Hub-and-Spoke',
    whenToUse:
      'Central coordinator delegates subtasks to specialists and needs results back. Research assistants, complex analysis, multi-source aggregation.',
    structure:
      '1 SUPERVISOR with delegate edges -> N worker AGENTs that return_to_parent. Supervisor aggregates results.',
    ablImplications:
      'Supervisor uses DELEGATE (stack-based, not HANDOFF). Workers use __return_to_parent__. Supervisor needs MEMORY for aggregation state. HOOKS on_delegate_complete.',
    edgeTypes: ['delegate', 'escalation'],
    antiPatterns: [
      'Do not use for simple intent routing — if the coordinator does not need results back, use Triage instead.',
      'Do not delegate to more than 5 workers in parallel — aggregation complexity grows fast.',
    ],
  },
  {
    id: 'mesh',
    name: 'Mesh',
    whenToUse:
      'Peer agents that route to each other based on context. Highly dynamic conversations where topics shift unpredictably. Multi-department support where any agent can escalate to any other.',
    structure:
      'N AGENTs with bidirectional handoff edges. May have multiple entry points. Requires allowCycle on edges.',
    ablImplications:
      'Requires allowCycle on edges. Each agent needs CONSTRAINTS to know when to hand off. Complex — use sparingly. Every agent needs NLU for intent detection.',
    edgeTypes: ['handoff', 'escalation'],
    antiPatterns: [
      'Never use mesh for fewer than 3 agents — simpler patterns are always better.',
      'Avoid without explicit cycle limits — unbounded loops will confuse users.',
    ],
  },
];

export const TOPOLOGY_DECISION_TREE = `Q1: How many distinct capability domains?
  -> 1 domain -> SINGLE AGENT
  -> 2+ domains:
    Q2: Is the workflow sequential (each step feeds the next)?
      -> Yes -> PIPELINE
      -> No:
        Q3: Does a central agent need results back from sub-agents?
          -> Yes -> HUB-AND-SPOKE
          -> No:
            Q4: Can users enter from multiple points / agents are peers?
              -> Yes -> MESH
              -> No -> TRIAGE -> SPECIALISTS`;

export function getPatternCatalogPromptText(): string {
  let text = '## Topology Pattern Catalog\n\n';
  text += 'Choose the pattern that best fits the use case. Use the decision tree below.\n\n';

  for (const p of TOPOLOGY_PATTERNS) {
    text += `### ${p.name} (${p.id})\n`;
    text += `**When to use:** ${p.whenToUse}\n`;
    text += `**Structure:** ${p.structure}\n`;
    text += `**ABL implications:** ${p.ablImplications}\n`;
    if (p.edgeTypes.length > 0) {
      text += `**Edge types:** ${p.edgeTypes.join(', ')}\n`;
    }
    text += `**Anti-patterns:**\n`;
    for (const ap of p.antiPatterns) {
      text += `- ${ap}\n`;
    }
    text += '\n';
  }

  text += '## Pattern Selection Decision Tree\n\n```\n' + TOPOLOGY_DECISION_TREE + '\n```\n';
  return text;
}
````

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@abl/studio`

Expected: Clean build with no type errors.

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/topology-patterns.ts apps/studio/src/lib/arch-ai/types.ts
```

Commit with the relevant JIRA key: `[ABLP-XXX] feat(studio): add topology pattern catalog and staged pipeline types`

---

## Task 2: Construct Catalog

**Files:**

- Create: `apps/studio/src/lib/arch-ai/construct-catalog.ts`

This is the data foundation — every ABL construct the platform supports, with syntax reference and examples. The parser at `packages/core/src/parser/agent-based-parser.ts:505-542` lists 34 known sections. ARCH currently knows ~12. This catalog covers all 34.

- [ ] **Step 1: Create construct-catalog.ts with all construct entries**

Create `apps/studio/src/lib/arch-ai/construct-catalog.ts`. This file defines every ABL construct with syntax, examples, and metadata. Due to size (~800 lines), I'll show the structure with representative entries. Every construct must follow this pattern:

```typescript
import type { ConstructCatalogEntry } from './types.js';

/**
 * Complete ABL construct catalog.
 * Source of truth: packages/core/src/parser/agent-based-parser.ts lines 505-542 (knownSections).
 * Each entry includes syntax reference, a domain-relevant example, common mistakes, and guidance.
 */

// --- Always included (every agent) ---

export const CONSTRUCT_AGENT: ConstructCatalogEntry = {
  keyword: 'AGENT',
  description:
    'Declares a standard agent. Use SUPERVISOR: instead for routing/coordinating agents.',
  syntax: `AGENT: AgentName
GOAL: "The agent's primary objective"
PERSONA: |
  Multi-line personality description.
  Tone, expertise, behavioral guidelines.`,
  example: `AGENT: BillingAssistant
GOAL: "Help customers resolve billing questions and process refunds"
PERSONA: |
  You are a friendly billing specialist. Be empathetic about billing issues.
  Always verify the customer's identity before accessing account details.`,
  commonMistakes: [
    'Using MODE: after AGENT: — MODE is not supported, use EXECUTION: for model config',
    'Using DOMAIN: — not a valid keyword, describe the domain in PERSONA instead',
  ],
  whenNotToUse: 'Use SUPERVISOR: instead when this agent routes to other agents via HANDOFF.',
};

export const CONSTRUCT_SUPERVISOR: ConstructCatalogEntry = {
  keyword: 'SUPERVISOR',
  description:
    'Declares a routing/coordinating agent that directs conversations to specialists via HANDOFF or DELEGATE.',
  syntax: `SUPERVISOR: RouterName
GOAL: "Route users to the right specialist based on their intent"
PERSONA: |
  You are a helpful receptionist. Understand what the user needs and connect them.`,
  example: `SUPERVISOR: SupportRouter
GOAL: "Classify customer intent and route to the right specialist"
PERSONA: |
  You are the first point of contact. Greet warmly, ask clarifying questions,
  then route to Billing, Technical, or Shipping specialists.
HANDOFF:
  - TO: BillingSpecialist
    WHEN: "User asks about invoices, charges, refunds, or payment"
  - TO: TechnicalSupport
    WHEN: "User reports a bug, error, or technical issue"
  - TO: ShippingAgent
    WHEN: "User asks about delivery, tracking, or shipping status"`,
  commonMistakes: [
    'Adding TOOLS: to a supervisor — supervisors route, they do not execute tools',
    'Using ROUTING: instead of HANDOFF: — ROUTING is not a valid keyword',
  ],
  whenNotToUse: 'Use AGENT: if this agent handles requests directly without routing to others.',
};

export const CONSTRUCT_GOAL: ConstructCatalogEntry = {
  keyword: 'GOAL',
  description: 'Mandatory objective statement. Every agent must have exactly one GOAL.',
  syntax: 'GOAL: "Clear, specific objective in quotes"',
  example: 'GOAL: "Collect customer shipping address and process return label"',
  commonMistakes: ['Omitting GOAL entirely — it is mandatory for every agent'],
  whenNotToUse: 'Always required. Never omit.',
};

export const CONSTRUCT_PERSONA: ConstructCatalogEntry = {
  keyword: 'PERSONA',
  description:
    'Multi-line personality description defining tone, expertise, and behavioral guidelines.',
  syntax: `PERSONA: |
  Line 1 of persona description.
  Line 2 with behavioral guidelines.`,
  example: `PERSONA: |
  You are a patient insurance claims specialist with 10 years of experience.
  Speak in clear, simple language. Avoid jargon. Always confirm understanding.`,
  commonMistakes: ['Forgetting the | for multi-line — single-line personas are too brief'],
  whenNotToUse: 'Always recommended. Technically optional but agents without PERSONA are generic.',
};

export const CONSTRUCT_LIMITATIONS: ConstructCatalogEntry = {
  keyword: 'LIMITATIONS',
  description: 'Hard behavioral boundaries the agent must never cross. Listed as bullet points.',
  syntax: `LIMITATIONS:
  - Never provide medical advice
  - Do not share customer data with third parties`,
  example: `LIMITATIONS:
  - Never approve refunds over $500 without supervisor approval
  - Do not access accounts without verified identity
  - Never share internal pricing formulas`,
  commonMistakes: [
    'Putting limitations in PERSONA — use LIMITATIONS for hard rules, PERSONA for soft guidance',
  ],
  whenNotToUse: 'Optional for simple agents with no compliance or safety constraints.',
};

// --- Tools & Data Collection ---

export const CONSTRUCT_TOOLS: ConstructCatalogEntry = {
  keyword: 'TOOLS',
  description: 'Tool definitions the agent can invoke. Each tool has a signature and description.',
  syntax: `TOOLS:
  - lookup_order(orderId: string) -> {status: string, eta: string}
    "Look up order status by order ID"
  - create_ticket(subject: string, body: string) -> {ticketId: string}
    "Create a support ticket"`,
  example: `TOOLS:
  - search_knowledge_base(query: string) -> {results: object[]}
    "Search the knowledge base for relevant articles"
  - process_refund(orderId: string, amount: number, reason: string) -> {refundId: string, status: string}
    "Process a refund for a given order"`,
  commonMistakes: [
    'Adding TOOLS: to a SUPERVISOR — supervisors route via HANDOFF, they do not call tools',
    'Missing the description string after the signature — it helps the LLM decide when to use the tool',
  ],
  whenNotToUse:
    'Omit for supervisors that only route. Omit for agents that only gather information.',
};

export const CONSTRUCT_GATHER: ConstructCatalogEntry = {
  keyword: 'GATHER',
  description:
    'Information collection with LLM extraction. Fields are collected conversationally — the agent asks questions and extracts structured data from user responses.',
  syntax: `GATHER:
  - field_name: type (required|optional)
    "Prompt question to ask the user"
    EXTRACT: "Semantic hint for LLM extraction"
    VALIDATE: "Validation rule or regex"
    ON_FAIL: "What to say if validation fails"
    DEPENDS_ON: other_field`,
  example: `GATHER:
  - full_name: string (required)
    "What is your full name?"
    EXTRACT: "Extract the person's full name from their response"
  - email: string (required)
    "What email address should we use?"
    VALIDATE: "Must be a valid email format"
    ON_FAIL: "That doesn't look like a valid email. Could you double-check?"
  - phone: string (optional)
    "Would you like to add a phone number for SMS updates?"
  - preferred_contact: enum[email,phone,both] (required)
    "How would you prefer we contact you?"
    DEPENDS_ON: phone`,
  commonMistakes: [
    'Circular DEPENDS_ON chains — field A depends on B which depends on A',
    'Missing type annotation — every field needs a type (string, number, boolean, date, enum, array)',
    'Using DEPENDS_ON without understanding progressive activation — dependent fields only appear after their dependency is collected',
  ],
  whenNotToUse: 'Omit for agents that only provide information (no data collection needed).',
};

export const CONSTRUCT_MEMORY: ConstructCatalogEntry = {
  keyword: 'MEMORY',
  description:
    'Session variables and persistent facts. REMEMBER triggers save data; RECALL loads it. Session vars are scoped to the current conversation.',
  syntax: `MEMORY:
  SESSION_VARS:
    - var_name: type = default_value
  PERSISTENT:
    - path: "storage.path"
      ttl: 3600
  REMEMBER:
    - WHEN: "condition"
      STORE: "what to remember"
  RECALL:
    - "instruction for what to recall"`,
  example: `MEMORY:
  SESSION_VARS:
    - customer_tier: string = "unknown"
    - interaction_count: number = 0
  REMEMBER:
    - WHEN: "Customer mentions their account type"
      STORE: "customer_tier from their statement"
  RECALL:
    - "Check if this customer has contacted us before about the same issue"`,
  commonMistakes: [
    'Using MEMORY for data that should be in GATHER — GATHER is for collecting from users, MEMORY is for state management',
    'Forgetting TTL on PERSISTENT paths — data without TTL accumulates indefinitely',
  ],
  whenNotToUse:
    'Omit for stateless agents that do not need to track conversation state or recall past interactions.',
};

export const CONSTRUCT_CONSTRAINTS: ConstructCatalogEntry = {
  keyword: 'CONSTRAINTS',
  description:
    'Rules evaluated continuously during conversation. REQUIRE blocks actions; WARN logs warnings. Each constraint has an ON_FAIL action.',
  syntax: `CONSTRAINTS:
  - REQUIRE: "Rule that must be true"
    ON_FAIL: RESPOND "Error message to user"
  - WARN: "Soft rule that should be true"
    ON_FAIL: ESCALATE
  - LIMIT: "Resource limit"
    ON_FAIL: BLOCK`,
  example: `CONSTRAINTS:
  - REQUIRE: "Customer identity must be verified before accessing account data"
    ON_FAIL: RESPOND "I need to verify your identity first. Can you provide your account number?"
  - REQUIRE: "Refund amount must not exceed original purchase price"
    ON_FAIL: RESPOND "The refund amount cannot exceed the original purchase price of {{purchase_price}}"
  - WARN: "Conversation should not exceed 15 minutes"
    ON_FAIL: ESCALATE`,
  commonMistakes: [
    'Using only REQUIRE when WARN is more appropriate — not every rule needs to block',
    'Missing ON_FAIL — every constraint needs an action (RESPOND, ESCALATE, HANDOFF, BLOCK)',
  ],
  whenNotToUse:
    'Omit only for the simplest agents with no business rules or compliance requirements.',
};

export const CONSTRUCT_GUARDRAILS: ConstructCatalogEntry = {
  keyword: 'GUARDRAILS',
  description:
    'Content safety checks on input and output. Three tiers: pattern-based (fast), model-based, LLM-based. Actions: block, warn, log, fix.',
  syntax: `GUARDRAILS:
  INPUT:
    - CHECK: "description of check"
      ACTION: block | warn | log | fix
  OUTPUT:
    - CHECK: "description of check"
      ACTION: block | warn | fix`,
  example: `GUARDRAILS:
  INPUT:
    - CHECK: "Detect and block prompt injection attempts"
      ACTION: block
    - CHECK: "Flag personally identifiable information (PII)"
      ACTION: warn
  OUTPUT:
    - CHECK: "Ensure responses do not contain internal system details"
      ACTION: fix
    - CHECK: "Verify no customer PII is leaked in responses"
      ACTION: block`,
  commonMistakes: [
    'Applying guardrails per-agent instead of per-topology — guardrails follow the conversation across handoffs',
  ],
  whenNotToUse: 'Omit only when there are zero compliance or safety requirements.',
};

export const CONSTRUCT_FLOW: ConstructCatalogEntry = {
  keyword: 'FLOW',
  description:
    'Step-by-step execution for scripted and hybrid agents. Each step can be REASONING (LLM-driven) or scripted. Steps execute in sequence with conditional branching.',
  syntax: `FLOW:
  - STEP: step_name
    DO: gather | tool_call | respond | branch
    REASONING: true | false
    THEN: next_step | END
  - STEP: branch_step
    IF: "condition"
    THEN: step_a
    ELSE: step_b`,
  example: `FLOW:
  - STEP: greet
    DO: RESPOND "Welcome! I'll help you file your claim."
    THEN: collect_info
  - STEP: collect_info
    DO: GATHER [claim_type, incident_date, description]
    REASONING: true
    THEN: validate
  - STEP: validate
    DO: CALL validate_claim(claim_type, incident_date)
    THEN: check_result
  - STEP: check_result
    IF: "validation.passed == true"
    THEN: submit
    ELSE: fix_errors
  - STEP: submit
    DO: CALL submit_claim(claim_type, incident_date, description)
    THEN: END`,
  commonMistakes: [
    'Using FLOW in a pure reasoning agent — reasoning agents do not need FLOW',
    'Missing THEN on steps — every step needs a THEN (next step or END)',
    'Referencing undefined tools in DO: CALL — tools must be declared in TOOLS section',
  ],
  whenNotToUse:
    'Omit for pure reasoning agents — they handle conversation dynamically without fixed steps.',
};

export const CONSTRUCT_HANDOFF: ConstructCatalogEntry = {
  keyword: 'HANDOFF',
  description:
    'Agent-to-agent routing. The current agent exits and the target takes over. No return. Used in supervisors for intent routing and in mesh patterns for peer routing.',
  syntax: `HANDOFF:
  - TO: TargetAgentName
    WHEN: "condition for this handoff"
    CONTEXT: "what context to pass"`,
  example: `HANDOFF:
  - TO: BillingSpecialist
    WHEN: "User asks about invoices, charges, refunds, or payment"
    CONTEXT: "Pass the customer's verified identity and account summary"
  - TO: TechnicalSupport
    WHEN: "User reports a bug, error, or technical issue"
    CONTEXT: "Pass the product name and error description"`,
  commonMistakes: [
    'Confusing HANDOFF with DELEGATE — HANDOFF is a full transfer (no return), DELEGATE is stack-based (returns control)',
    'Missing WHEN condition — every handoff must have a trigger condition',
  ],
  whenNotToUse: 'Use DELEGATE instead when the parent needs results back from the child.',
};

export const CONSTRUCT_DELEGATE: ConstructCatalogEntry = {
  keyword: 'DELEGATE',
  description:
    'Stack-based sub-agent call. Parent pauses, child executes, child returns control + context to parent. Used in hub-and-spoke pattern.',
  syntax: `DELEGATE:
  - TO: WorkerAgentName
    WHEN: "condition to delegate"
    INPUT: "what data to pass"
    RETURNS: "what data comes back"`,
  example: `DELEGATE:
  - TO: CreditCheckAgent
    WHEN: "Loan application requires credit verification"
    INPUT: "applicant SSN and consent flag"
    RETURNS: "credit score, risk tier, and recommendation"
  - TO: DocumentReviewAgent
    WHEN: "Supporting documents need verification"
    INPUT: "uploaded document references"
    RETURNS: "verification status and flagged issues"`,
  commonMistakes: [
    'Using DELEGATE when HANDOFF is appropriate — if the parent does not need results back, use HANDOFF',
    "Forgetting RETURNS — without it, the parent cannot use the child's output",
  ],
  whenNotToUse: 'Use HANDOFF instead when the conversation permanently shifts to the target agent.',
};

export const CONSTRUCT_ESCALATE: ConstructCatalogEntry = {
  keyword: 'ESCALATE',
  description:
    'Transfer conversation to a human agent. The conversation leaves the automated system.',
  syntax: `ESCALATE:
  - WHEN: "condition for escalation"
    PRIORITY: high | medium | low
    CONTEXT: "summary for the human agent"`,
  example: `ESCALATE:
  - WHEN: "Customer explicitly requests a human agent"
    PRIORITY: medium
    CONTEXT: "Customer requested human assistance. Topic: {{current_topic}}"
  - WHEN: "Agent cannot resolve after 3 attempts"
    PRIORITY: high
    CONTEXT: "Automated resolution failed. Issue: {{issue_summary}}"`,
  commonMistakes: [
    'Not providing CONTEXT — human agents need conversation context to pick up seamlessly',
  ],
  whenNotToUse: 'Omit only if there is truly no scenario where human intervention is needed.',
};

export const CONSTRUCT_COMPLETE: ConstructCatalogEntry = {
  keyword: 'COMPLETE',
  description: 'Conditions that mark the conversation as successfully completed.',
  syntax: `COMPLETE:
  - WHEN: "completion condition"
    RESPOND: "closing message"`,
  example: `COMPLETE:
  - WHEN: "All required information collected and ticket created"
    RESPOND: "Your support ticket #{{ticketId}} has been created. Is there anything else?"
  - WHEN: "Customer confirms their issue is resolved"
    RESPOND: "Glad I could help! Have a great day."`,
  commonMistakes: [
    'Missing COMPLETE entirely — agents without it never formally end the conversation',
  ],
  whenNotToUse: 'Omit for supervisors that route but never directly complete conversations.',
};

export const CONSTRUCT_ON_ERROR: ConstructCatalogEntry = {
  keyword: 'ON_ERROR',
  description: 'Error handling per tool type. Defines retry behavior and fallback responses.',
  syntax: `ON_ERROR:
  - TOOL: tool_name
    RETRY: 2
    BACKOFF: exponential
    RESPOND: "Fallback message if all retries fail"`,
  example: `ON_ERROR:
  - TOOL: lookup_order
    RETRY: 2
    BACKOFF: exponential
    RESPOND: "I'm having trouble looking up your order right now. Could you try again in a moment?"
  - TOOL: process_refund
    RETRY: 1
    RESPOND: "The refund system is temporarily unavailable. I've noted your request and our team will process it within 24 hours."`,
  commonMistakes: [
    'Swallowing errors without informing the user — always provide a RESPOND fallback',
  ],
  whenNotToUse: 'Omit when tool failures should use the default error handling.',
};

export const CONSTRUCT_ON_START: ConstructCatalogEntry = {
  keyword: 'ON_START',
  description:
    'Lifecycle hook that runs when a new session begins. Use for greetings, initial tool calls, or setting session variables.',
  syntax: `ON_START:
  RESPOND: "Greeting message"
  CALL: optional_init_tool()
  SET:
    - var_name: value`,
  example: `ON_START:
  RESPOND: "Welcome to Acme Support! I'm here to help with billing, technical issues, or shipping questions. How can I assist you today?"
  SET:
    - session_start_time: "{{now}}"`,
  commonMistakes: ['Using ON_START for complex logic — keep it simple (greeting + optional init)'],
  whenNotToUse: 'Omit when the agent should wait for the user to speak first.',
};

export const CONSTRUCT_EXECUTION: ConstructCatalogEntry = {
  keyword: 'EXECUTION',
  description:
    'Model configuration: which LLM to use, temperature, token limits, timeout, thinking/reasoning budget, compaction policy.',
  syntax: `EXECUTION:
  MODEL: provider/model-id
  TEMPERATURE: 0.7
  MAX_TOKENS: 4096
  TIMEOUT: 30000
  THINKING:
    enabled: true
    budget: 2048
  COMPACTION:
    strategy: sliding_window
    max_turns: 20`,
  example: `EXECUTION:
  MODEL: anthropic/claude-sonnet-4-20250514
  TEMPERATURE: 0.3
  MAX_TOKENS: 2048
  TIMEOUT: 15000`,
  commonMistakes: [
    'Setting temperature too high (>0.9) for data collection agents — use 0.1-0.3 for precision tasks',
    'Missing TIMEOUT — long-running LLM calls can hang without a timeout',
  ],
  whenNotToUse:
    'Omit to use platform defaults. Only include when you need specific model/config overrides.',
};

export const CONSTRUCT_NLU: ConstructCatalogEntry = {
  keyword: 'NLU',
  description:
    'Intent and entity definitions for understanding user messages. Includes intent classification, entity extraction, and category detection.',
  syntax: `NLU:
  INTENTS:
    - name: intent_name
      examples:
        - "example utterance 1"
        - "example utterance 2"
  ENTITIES:
    - name: entity_name
      type: string | number | date | enum
  CATEGORIES:
    - name: category_name
      description: "what this category covers"`,
  example: `NLU:
  INTENTS:
    - name: check_balance
      examples:
        - "What's my balance?"
        - "How much do I owe?"
        - "Show me my account balance"
    - name: make_payment
      examples:
        - "I want to pay my bill"
        - "Process a payment"
  ENTITIES:
    - name: account_number
      type: string
    - name: payment_amount
      type: number`,
  commonMistakes: [
    'Too few examples per intent — provide at least 3-5 diverse examples',
    'Overlapping intents — ensure each intent has a clear, distinct meaning',
  ],
  whenNotToUse:
    'Omit for agents that do not need intent classification (e.g., pure data collection agents).',
};

export const CONSTRUCT_TEMPLATES: ConstructCatalogEntry = {
  keyword: 'TEMPLATES',
  description:
    'Named response templates with variable interpolation. Reuse across FLOW steps and RESPOND actions.',
  syntax: `TEMPLATES:
  template_name: |
    Template text with {{variable}} interpolation.`,
  example: `TEMPLATES:
  welcome: |
    Welcome, {{customer_name}}! I see you're calling about {{topic}}.
    Let me pull up your account.
  ticket_created: |
    Your ticket #{{ticket_id}} has been created.
    Expected resolution: {{sla_hours}} hours.`,
  commonMistakes: [
    'Referencing undefined variables — ensure {{var}} names match GATHER fields or SESSION_VARS',
  ],
  whenNotToUse: 'Omit when responses are simple enough to inline in RESPOND actions.',
};

export const CONSTRUCT_HOOKS: ConstructCatalogEntry = {
  keyword: 'HOOKS',
  description: 'Lifecycle hooks for before/after agent activation and each conversation turn.',
  syntax: `HOOKS:
  before_agent: "action on agent activation"
  after_agent: "action on agent deactivation"
  before_turn: "action before each user turn"
  after_turn: "action after each response"`,
  example: `HOOKS:
  before_agent: "Log agent activation and load customer context"
  after_turn: "Update interaction count and check SLA timer"`,
  commonMistakes: [
    'Putting complex logic in hooks — keep hooks lightweight (logging, metrics, simple state)',
  ],
  whenNotToUse: 'Omit for simple agents that do not need lifecycle tracking.',
};

export const CONSTRUCT_ATTACHMENTS: ConstructCatalogEntry = {
  keyword: 'ATTACHMENTS',
  description:
    'File and media upload collection. Defines what file types the agent accepts and how to process them.',
  syntax: `ATTACHMENTS:
  - name: field_name
    types: [image/png, image/jpeg, application/pdf]
    max_size: 10MB
    required: true | false
    processing: ocr | transcription | none`,
  example: `ATTACHMENTS:
  - name: claim_photo
    types: [image/png, image/jpeg]
    max_size: 5MB
    required: true
    processing: ocr
  - name: supporting_doc
    types: [application/pdf]
    max_size: 10MB
    required: false`,
  commonMistakes: ['Not specifying max_size — large uploads can cause timeouts'],
  whenNotToUse: 'Omit when the agent does not need to accept file uploads.',
};

export const CONSTRUCT_DESTINATIONS: ConstructCatalogEntry = {
  keyword: 'DESTINATIONS',
  description:
    'Outbound HTTP webhook targets. Send data to external systems after specific events.',
  syntax: `DESTINATIONS:
  - name: destination_name
    url: "https://api.example.com/webhook"
    method: POST
    auth: bearer | api_key | none
    trigger: "when to send"`,
  example: `DESTINATIONS:
  - name: crm_update
    url: "https://api.salesforce.com/webhook"
    method: POST
    auth: bearer
    trigger: "When ticket is created or updated"`,
  commonMistakes: ['Hardcoding URLs — use config variables for environment-specific endpoints'],
  whenNotToUse: 'Omit when the agent does not need to push data to external systems.',
};

export const CONSTRUCT_LOOKUP_TABLES: ConstructCatalogEntry = {
  keyword: 'LOOKUP_TABLES',
  description:
    'Reference data for field validation. Inline lists, database collections, or API sources.',
  syntax: `LOOKUP_TABLES:
  - name: table_name
    source: inline | collection | api
    values: ["value1", "value2"]  # for inline`,
  example: `LOOKUP_TABLES:
  - name: us_states
    source: inline
    values: ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA"]
  - name: product_catalog
    source: collection
    collection: products`,
  commonMistakes: ['Large inline tables — use collection source for >50 values'],
  whenNotToUse: 'Omit when field validation does not require reference data.',
};

export const CONSTRUCT_ACTION_HANDLERS: ConstructCatalogEntry = {
  keyword: 'ACTION_HANDLERS',
  description:
    'Handlers for interactive UI elements (buttons, selects, inputs). Triggered when user clicks/selects.',
  syntax: `ACTION_HANDLERS:
  - action: action_name
    handler: "what to do when triggered"`,
  example: `ACTION_HANDLERS:
  - action: approve_refund
    handler: "Call process_refund and confirm to user"
  - action: reject_refund
    handler: "Log rejection reason and escalate to supervisor"`,
  commonMistakes: ['Defining handlers without corresponding UI actions in RESPOND'],
  whenNotToUse: 'Omit for text-only conversations without interactive UI elements.',
};

export const CONSTRUCT_MESSAGES: ConstructCatalogEntry = {
  keyword: 'MESSAGES',
  description:
    'Customizable system messages for specific scenarios (errors, gather prompts, timeouts).',
  syntax: `MESSAGES:
  error_default: "Custom error message"
  gather_prompt: "Custom gather prompt"
  timeout: "Custom timeout message"`,
  example: `MESSAGES:
  error_default: "I encountered an issue. Let me try a different approach."
  timeout: "It's taking longer than expected. Would you like to wait or try again?"`,
  commonMistakes: [
    'Overriding error_default with a generic message — be specific about what went wrong',
  ],
  whenNotToUse: 'Omit to use platform default messages.',
};

export const CONSTRUCT_BEHAVIOR_PROFILE: ConstructCatalogEntry = {
  keyword: 'BEHAVIOR_PROFILE',
  description:
    'Context-dependent behavior modifications. Profiles activate based on conditions (channel, time, user tier) and override agent behavior.',
  syntax: `BEHAVIOR_PROFILE: ProfileName
WHEN: "activation condition (CEL expression)"
PRIORITY: 1-100
PERSONA: |
  Override persona when this profile is active.`,
  example: `BEHAVIOR_PROFILE: AfterHours
WHEN: "hour(now()) >= 18 || hour(now()) < 8"
PRIORITY: 50
PERSONA: |
  Note that our support team is currently offline.
  Collect the customer's issue and promise a callback during business hours.`,
  commonMistakes: [
    'Conflicting profiles without priority — always set PRIORITY to resolve overlaps',
  ],
  whenNotToUse: 'Omit when agent behavior does not need to change based on context.',
};

export const CONSTRUCT_MULTI_INTENT: ConstructCatalogEntry = {
  keyword: 'MULTI_INTENT',
  description:
    'Strategy for handling messages with multiple intents (e.g., "check my balance and change my address").',
  syntax: `MULTI_INTENT:
  strategy: sequential | parallel | disambiguate | auto`,
  example: `MULTI_INTENT:
  strategy: sequential`,
  commonMistakes: [
    'Using parallel without understanding aggregation — results from parallel intents must be combined',
  ],
  whenNotToUse: 'Omit when messages are expected to contain only single intents.',
};

// --- Collect all constructs ---

export const ALL_CONSTRUCTS: ConstructCatalogEntry[] = [
  CONSTRUCT_AGENT,
  CONSTRUCT_SUPERVISOR,
  CONSTRUCT_GOAL,
  CONSTRUCT_PERSONA,
  CONSTRUCT_LIMITATIONS,
  CONSTRUCT_TOOLS,
  CONSTRUCT_GATHER,
  CONSTRUCT_MEMORY,
  CONSTRUCT_CONSTRAINTS,
  CONSTRUCT_GUARDRAILS,
  CONSTRUCT_FLOW,
  CONSTRUCT_HANDOFF,
  CONSTRUCT_DELEGATE,
  CONSTRUCT_ESCALATE,
  CONSTRUCT_COMPLETE,
  CONSTRUCT_ON_ERROR,
  CONSTRUCT_ON_START,
  CONSTRUCT_EXECUTION,
  CONSTRUCT_NLU,
  CONSTRUCT_TEMPLATES,
  CONSTRUCT_HOOKS,
  CONSTRUCT_ATTACHMENTS,
  CONSTRUCT_DESTINATIONS,
  CONSTRUCT_LOOKUP_TABLES,
  CONSTRUCT_ACTION_HANDLERS,
  CONSTRUCT_MESSAGES,
  CONSTRUCT_BEHAVIOR_PROFILE,
  CONSTRUCT_MULTI_INTENT,
];

/** Look up a construct by keyword */
export function getConstruct(keyword: string): ConstructCatalogEntry | undefined {
  return ALL_CONSTRUCTS.find((c) => c.keyword.toUpperCase() === keyword.toUpperCase());
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@abl/studio`

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/construct-catalog.ts
```

Commit: `[ABLP-XXX] feat(studio): add complete ABL construct catalog (28 constructs)`

---

## Task 3: getRelevantConstructs Helper

**Files:**

- Create: `apps/studio/src/lib/arch-ai/helpers/get-relevant-constructs.ts`

- [ ] **Step 1: Create the helpers directory**

Run: `mkdir -p apps/studio/src/lib/arch-ai/helpers`

- [ ] **Step 2: Create get-relevant-constructs.ts**

````typescript
import {
  ALL_CONSTRUCTS,
  CONSTRUCT_AGENT,
  CONSTRUCT_SUPERVISOR,
  CONSTRUCT_GOAL,
  CONSTRUCT_PERSONA,
  CONSTRUCT_LIMITATIONS,
  CONSTRUCT_TOOLS,
  CONSTRUCT_GATHER,
  CONSTRUCT_MEMORY,
  CONSTRUCT_CONSTRAINTS,
  CONSTRUCT_GUARDRAILS,
  CONSTRUCT_FLOW,
  CONSTRUCT_HANDOFF,
  CONSTRUCT_DELEGATE,
  CONSTRUCT_ESCALATE,
  CONSTRUCT_COMPLETE,
  CONSTRUCT_ON_ERROR,
  CONSTRUCT_ON_START,
  CONSTRUCT_EXECUTION,
  CONSTRUCT_NLU,
  CONSTRUCT_TEMPLATES,
  CONSTRUCT_HOOKS,
  CONSTRUCT_ATTACHMENTS,
  CONSTRUCT_DESTINATIONS,
  CONSTRUCT_LOOKUP_TABLES,
  CONSTRUCT_ACTION_HANDLERS,
  CONSTRUCT_MESSAGES,
  CONSTRUCT_BEHAVIOR_PROFILE,
  CONSTRUCT_MULTI_INTENT,
} from '../construct-catalog.js';
import type { ConstructCatalogEntry, ConstructCatalogResponse } from '../types.js';

interface GetRelevantConstructsInput {
  agentRole: string;
  agentType: 'supervisor' | 'agent';
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  domain: string;
  suggestedConstructs: string[];
  hasComplianceRequirements: boolean;
  hasVoiceChannel: boolean;
}

/**
 * Deterministic construct selection based on agent characteristics.
 * Returns only the ABL constructs relevant to this agent's role (~3-5K tokens).
 *
 * This is NOT an LLM call — it's a mapping function.
 */
export function getRelevantConstructs(input: GetRelevantConstructsInput): ConstructCatalogResponse {
  const selected = new Set<ConstructCatalogEntry>();

  // Always include identity constructs
  if (input.agentType === 'supervisor') {
    selected.add(CONSTRUCT_SUPERVISOR);
  } else {
    selected.add(CONSTRUCT_AGENT);
  }
  selected.add(CONSTRUCT_GOAL);
  selected.add(CONSTRUCT_PERSONA);
  selected.add(CONSTRUCT_EXECUTION);

  // Supervisor-specific
  if (input.agentType === 'supervisor') {
    selected.add(CONSTRUCT_HANDOFF);
    selected.add(CONSTRUCT_NLU);
    selected.add(CONSTRUCT_CONSTRAINTS);
  }

  // Scripted/hybrid agents need FLOW
  if (input.executionMode === 'scripted' || input.executionMode === 'hybrid') {
    selected.add(CONSTRUCT_FLOW);
    selected.add(CONSTRUCT_ON_START);
  }

  // Non-supervisor agents can use TOOLS
  if (input.agentType !== 'supervisor') {
    selected.add(CONSTRUCT_TOOLS);
  }

  // Role-based selection
  const roleLower = input.agentRole.toLowerCase();

  if (matchesAny(roleLower, ['collect', 'intake', 'gather', 'form', 'registration', 'onboard'])) {
    selected.add(CONSTRUCT_GATHER);
    selected.add(CONSTRUCT_MEMORY);
    selected.add(CONSTRUCT_LOOKUP_TABLES);
  }

  if (matchesAny(roleLower, ['conversation', 'chat', 'support', 'assist', 'help'])) {
    selected.add(CONSTRUCT_MEMORY);
    selected.add(CONSTRUCT_TEMPLATES);
    selected.add(CONSTRUCT_COMPLETE);
  }

  if (matchesAny(roleLower, ['route', 'triage', 'dispatch', 'classify', 'router'])) {
    selected.add(CONSTRUCT_HANDOFF);
    selected.add(CONSTRUCT_NLU);
  }

  if (matchesAny(roleLower, ['coordinate', 'orchestrat', 'hub', 'aggregat', 'manage'])) {
    selected.add(CONSTRUCT_DELEGATE);
    selected.add(CONSTRUCT_HOOKS);
    selected.add(CONSTRUCT_MEMORY);
  }

  if (matchesAny(roleLower, ['pipeline', 'process', 'stage', 'step', 'sequential'])) {
    selected.add(CONSTRUCT_FLOW);
    selected.add(CONSTRUCT_ON_START);
    selected.add(CONSTRUCT_COMPLETE);
  }

  if (matchesAny(roleLower, ['integrat', 'api', 'external', 'webhook', 'connect'])) {
    selected.add(CONSTRUCT_DESTINATIONS);
    selected.add(CONSTRUCT_ON_ERROR);
  }

  if (matchesAny(roleLower, ['upload', 'document', 'file', 'attachment', 'image', 'photo'])) {
    selected.add(CONSTRUCT_ATTACHMENTS);
  }

  // Compliance requirements
  if (input.hasComplianceRequirements) {
    selected.add(CONSTRUCT_GUARDRAILS);
    selected.add(CONSTRUCT_CONSTRAINTS);
    selected.add(CONSTRUCT_LIMITATIONS);
  }

  // Voice channel
  if (input.hasVoiceChannel) {
    // Voice config is embedded in GATHER (voice_prompt, barge_in) and EXECUTION (voice model)
    selected.add(CONSTRUCT_GATHER);
    selected.add(CONSTRUCT_EXECUTION);
    selected.add(CONSTRUCT_MESSAGES);
  }

  // Always include error handling and escalation for non-trivial agents
  if (selected.size > 5) {
    selected.add(CONSTRUCT_ON_ERROR);
    selected.add(CONSTRUCT_ESCALATE);
    selected.add(CONSTRUCT_COMPLETE);
  }

  // Honor suggestedConstructs from topology stage
  for (const keyword of input.suggestedConstructs) {
    const found = ALL_CONSTRUCTS.find((c) => c.keyword.toUpperCase() === keyword.toUpperCase());
    if (found) {
      selected.add(found);
    }
  }

  const constructs = Array.from(selected);
  const totalTokenEstimate = constructs.reduce((sum, c) => sum + estimateTokens(c), 0);

  return { constructs, totalTokenEstimate };
}

/**
 * Format constructs into a prompt-injectable text block.
 */
export function formatConstructsForPrompt(response: ConstructCatalogResponse): string {
  let text = '## ABL Construct Reference (for this agent)\n\n';
  text +=
    'Use these constructs to generate rich, complete ABL. Only use constructs listed here.\n\n';

  for (const c of response.constructs) {
    text += `### ${c.keyword}\n`;
    text += `${c.description}\n\n`;
    text += '```yaml\n' + c.syntax + '\n```\n\n';
    text += '**Example:**\n```yaml\n' + c.example + '\n```\n\n';
    if (c.commonMistakes.length > 0) {
      text += '**Avoid:**\n';
      for (const m of c.commonMistakes) {
        text += `- ${m}\n`;
      }
      text += '\n';
    }
  }

  return text;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function estimateTokens(entry: ConstructCatalogEntry): number {
  const text =
    entry.keyword +
    entry.description +
    entry.syntax +
    entry.example +
    entry.commonMistakes.join('') +
    entry.whenNotToUse;
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
````

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@abl/studio`

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/helpers/get-relevant-constructs.ts
```

Commit: `[ABLP-XXX] feat(studio): add getRelevantConstructs helper for per-agent construct selection`

---

## Task 4: getModelRecommendation Helper

**Files:**

- Create: `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts`

- [ ] **Step 1: Create get-model-recommendation.ts**

Read `packages/compiler/src/platform/llm/model-capabilities.ts` (specifically `getModelCapabilities()` at line 146 and `ModelCapabilities` at line 20) before writing this file.

```typescript
import type { ModelRecommendation } from '../types.js';

interface ModelRecommendationInput {
  agentRole: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  requiresToolCalling: boolean;
  requiresVision: boolean;
  requiresStructuredOutput: boolean;
  complexityTier: 'simple' | 'moderate' | 'complex';
  operations?: string[];
}

/**
 * Recommend model configuration based on agent requirements.
 * Uses a deterministic mapping based on complexity tier and capabilities.
 *
 * Does NOT call the model registry at runtime — uses static recommendations
 * from well-known model capabilities. The registry at
 * packages/compiler/src/platform/llm/model-registry.ts has 147+ models,
 * but we recommend from a curated short-list for predictability.
 */
export function getModelRecommendation(input: ModelRecommendationInput): ModelRecommendation {
  const primary = selectPrimaryModel(input);
  const executionConfig = selectExecutionConfig(input);
  const perOperation = selectPerOperationModels(input);

  return {
    primary,
    ...(Object.keys(perOperation).length > 0 ? { perOperation } : {}),
    executionConfig,
  };
}

function selectPrimaryModel(input: ModelRecommendationInput): {
  provider: string;
  model: string;
  reason: string;
} {
  // Scripted agents need minimal model — they follow FLOW steps
  if (input.executionMode === 'scripted') {
    return {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      reason:
        'Scripted agents follow predefined FLOW steps — a fast, cost-effective model is sufficient.',
    };
  }

  // Complex reasoning agents need top-tier models
  if (input.complexityTier === 'complex') {
    if (input.requiresToolCalling) {
      return {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        reason:
          'Complex agent with tool calling needs strong reasoning + reliable tool use. Sonnet 4 balances capability and cost.',
      };
    }
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      reason: 'Complex reasoning requires strong language understanding and nuanced responses.',
    };
  }

  // Moderate complexity
  if (input.complexityTier === 'moderate') {
    if (input.requiresToolCalling) {
      return {
        provider: 'openai',
        model: 'gpt-4o',
        reason:
          'Moderate complexity with tool calling — GPT-4o offers good tool reliability at reasonable cost.',
      };
    }
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      reason: 'Moderate complexity — Sonnet 4 provides good quality at reasonable cost.',
    };
  }

  // Simple
  if (input.requiresVision) {
    return {
      provider: 'openai',
      model: 'gpt-4o-mini',
      reason: 'Simple agent with vision needs — GPT-4o-mini supports vision at low cost.',
    };
  }

  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    reason: 'Simple agent — Haiku is fast and cost-effective for straightforward tasks.',
  };
}

function selectExecutionConfig(input: ModelRecommendationInput): {
  temperature: number;
  maxTokens: number;
  compactionPolicy?: string;
} {
  if (input.executionMode === 'scripted') {
    return { temperature: 0.1, maxTokens: 2048 };
  }

  if (input.complexityTier === 'complex') {
    return {
      temperature: 0.5,
      maxTokens: 4096,
      compactionPolicy: 'sliding_window',
    };
  }

  if (input.complexityTier === 'moderate') {
    return { temperature: 0.5, maxTokens: 4096 };
  }

  return { temperature: 0.7, maxTokens: 2048 };
}

function selectPerOperationModels(
  input: ModelRecommendationInput,
): Record<string, { provider: string; model: string; reason: string }> {
  const ops: Record<string, { provider: string; model: string; reason: string }> = {};

  if (!input.operations || input.operations.length === 0) return ops;

  for (const op of input.operations) {
    if (op === 'extraction' && input.complexityTier !== 'simple') {
      ops.extraction = {
        provider: 'openai',
        model: 'gpt-4o-mini',
        reason: 'Data extraction is a focused task — a smaller model is faster and cheaper.',
      };
    }
    if (op === 'summarization') {
      ops.summarization = {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        reason: 'Summarization is well-handled by fast models.',
      };
    }
    if (op === 'coordination' && input.complexityTier === 'complex') {
      ops.coordination = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        reason: 'Coordination across multiple agents requires strong reasoning.',
      };
    }
  }

  return ops;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@abl/studio`

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts
```

Commit: `[ABLP-XXX] feat(studio): add getModelRecommendation helper for agent model selection`

---

## Task 5: compileAndFix Helper

**Files:**

- Create: `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts`

This helper wraps the existing `@abl/core` parser + `@abl/compiler` with an iterative fix loop. Read `apps/studio/src/lib/arch-ai/tools/generate-agents.ts:65-107` (the existing `validateAbl` function) before writing this.

- [ ] **Step 1: Create compile-and-fix.ts**

````typescript
import type { ArchLLMResolution } from '../../arch-llm.js';
import type { CompileFixResult } from '../types.js';

/**
 * Iterative compile-fix loop for LLM-generated ABL.
 *
 * Round 0: Compile the LLM's output.
 * Round 1-N: If compilation fails, call the LLM with the errors and ask it to fix.
 * Final: If all rounds fail, return the last errors for the caller to handle.
 *
 * This is an INTERNAL helper called by generateSingleAgent().
 * It does NOT replace compile_abl (the specialist-visible tool for Monaco edits).
 */
export async function compileAndFix(input: {
  agentName: string;
  ablContent: string;
  maxRounds: number;
  constructContext: string;
  resolution: ArchLLMResolution;
}): Promise<CompileFixResult> {
  const { agentName, maxRounds, constructContext, resolution } = input;
  let currentAbl = input.ablContent;
  let lastErrors: Array<{ line?: number; message: string; severity: string }> = [];
  let lastWarnings: Array<{ line?: number; message: string }> = [];

  for (let round = 0; round < maxRounds; round++) {
    const result = await compileAbl(currentAbl);

    if (result.valid) {
      return {
        success: true,
        rounds: round + 1,
        finalAbl: currentAbl,
        warnings: result.warnings,
        constructsUsed: extractConstructs(currentAbl),
      };
    }

    lastErrors = result.errors;
    lastWarnings = result.warnings;

    // Last round — don't try to fix, just return the failure
    if (round === maxRounds - 1) {
      break;
    }

    // Ask the LLM to fix the errors
    const fixed = await llmFix(agentName, currentAbl, result.errors, constructContext, resolution);

    if (fixed) {
      currentAbl = fixed;
    } else {
      // LLM fix failed — stop trying
      break;
    }
  }

  return {
    success: false,
    rounds: maxRounds,
    finalAbl: currentAbl,
    errors: lastErrors,
    warnings: lastWarnings,
    constructsUsed: extractConstructs(currentAbl),
  };
}

async function compileAbl(ablContent: string): Promise<{
  valid: boolean;
  errors: Array<{ line?: number; message: string; severity: string }>;
  warnings: Array<{ line?: number; message: string }>;
}> {
  try {
    // Dynamic import to avoid SSR issues
    const { parseAgentBasedABL } = await import('@abl/core');
    const { compileABLtoIR } = await import('@abl/compiler');

    const parseResult = parseAgentBasedABL(ablContent);
    const parseErrors = (parseResult.errors || []).map((e: any) => ({
      line: e.line,
      message: e.message || String(e),
      severity: 'error',
    }));

    if (parseErrors.length > 0 || !parseResult.document) {
      return { valid: false, errors: parseErrors, warnings: [] };
    }

    const compileResult = compileABLtoIR([parseResult.document], { mode: 'preview' });
    const compileErrors = (compileResult.compilation_errors || []).map((e: any) => ({
      line: e.line,
      message: e.message || String(e),
      severity: e.severity || 'error',
    }));
    const compileWarnings = (compileResult.compilation_warnings || []).map((w: any) => ({
      line: w.line,
      message: w.message || String(w),
    }));

    const hasErrors = compileErrors.some((e: any) => e.severity === 'error');

    return {
      valid: !hasErrors,
      errors: compileErrors.filter((e: any) => e.severity === 'error'),
      warnings: [...compileWarnings, ...compileErrors.filter((e: any) => e.severity !== 'error')],
    };
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          message: `Compilation crashed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
      warnings: [],
    };
  }
}

async function llmFix(
  agentName: string,
  abl: string,
  errors: Array<{ line?: number; message: string; severity: string }>,
  constructContext: string,
  resolution: ArchLLMResolution,
): Promise<string | null> {
  if (!resolution.client) return null;

  const errorList = errors
    .map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message))
    .join('\n');

  const systemPrompt = `You are an expert ABL developer. Fix the compilation errors in the ABL code below.
Preserve all construct usage — only change what the error messages indicate.
Output ONLY the fixed ABL code, no explanations, no markdown fences.

${constructContext}`;

  const userPrompt = `Fix this ABL agent "${agentName}":

\`\`\`
${abl}
\`\`\`

Compilation errors:
${errorList}

Output the fixed ABL code only:`;

  try {
    const response = await resolution.client.chat({
      model: resolution.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 4096,
      temperature: 0.1,
    });

    const fixed =
      typeof response === 'string' ? response : response?.content || response?.text || '';

    if (!fixed || fixed.trim().length < 20) return null;

    // Strip markdown fences if present
    return fixed
      .replace(/^```(?:yaml|abl)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
  } catch {
    return null;
  }
}

function extractConstructs(abl: string): string[] {
  const keywords = [
    'AGENT',
    'SUPERVISOR',
    'GOAL',
    'PERSONA',
    'LIMITATIONS',
    'TOOLS',
    'GATHER',
    'MEMORY',
    'CONSTRAINTS',
    'GUARDRAILS',
    'FLOW',
    'STEPS',
    'HANDOFF',
    'DELEGATE',
    'ESCALATE',
    'COMPLETE',
    'ON_ERROR',
    'ON_START',
    'EXECUTION',
    'NLU',
    'TEMPLATES',
    'HOOKS',
    'ATTACHMENTS',
    'DESTINATIONS',
    'LOOKUP_TABLES',
    'ACTION_HANDLERS',
    'MESSAGES',
    'BEHAVIOR_PROFILE',
    'MULTI_INTENT',
  ];

  return keywords.filter((k) => {
    const regex = new RegExp(`^${k}:`, 'm');
    return regex.test(abl);
  });
}
````

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@abl/studio`

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts
```

Commit: `[ABLP-XXX] feat(studio): add compileAndFix helper for iterative ABL compilation`

---

## Task 6: Cross-Agent Validator

**Files:**

- Create: `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`

- [ ] **Step 1: Create cross-agent-validator.ts**

```typescript
import type { CrossAgentValidationResult } from './types.js';

interface AgentNode {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  isEntry: boolean;
}

interface AgentEdge {
  from: string;
  to: string;
  type: string;
  returnsControl: boolean;
}

interface GeneratedAgent {
  name: string;
  ablContent: string;
  constructsUsed: string[];
}

/**
 * Cross-agent validation after all agents are individually compiled.
 * Checks topology-level consistency that per-agent compilation cannot catch.
 */
export function validateCrossAgent(
  topology: { nodes: AgentNode[]; edges: AgentEdge[] },
  agents: GeneratedAgent[],
): CrossAgentValidationResult {
  const errors: CrossAgentValidationResult['errors'] = [];
  const agentNames = new Set(agents.map((a) => a.name));
  const nodeNames = new Set(topology.nodes.map((n) => n.name));

  // 1. Check handoff targets exist
  for (const edge of topology.edges) {
    const fromNode = topology.nodes.find((n) => n.id === edge.from || n.name === edge.from);
    const toNode = topology.nodes.find((n) => n.id === edge.to || n.name === edge.to);

    if (fromNode && !toNode) {
      errors.push({
        type: 'missing_handoff_target',
        severity: 'error',
        sourceAgent: fromNode.name,
        targetAgent: edge.to,
        message: `Agent "${fromNode.name}" has a ${edge.type} edge to "${edge.to}", but no agent with that name exists.`,
        suggestion: findSimilarName(edge.to, nodeNames),
      });
    }
  }

  // 2. Check delegate return paths (hub-spoke pattern)
  for (const edge of topology.edges) {
    if (edge.type === 'delegate') {
      const returnEdge = topology.edges.find(
        (e) => e.from === edge.to && e.to === edge.from && e.returnsControl,
      );
      if (!returnEdge) {
        const fromNode = topology.nodes.find((n) => n.id === edge.from || n.name === edge.from);
        const toNode = topology.nodes.find((n) => n.id === edge.to || n.name === edge.to);
        errors.push({
          type: 'missing_delegate_return',
          severity: 'warning',
          sourceAgent: fromNode?.name || edge.from,
          targetAgent: toNode?.name || edge.to,
          message: `Delegate edge from "${fromNode?.name || edge.from}" to "${toNode?.name || edge.to}" has no return path. The child agent should use __return_to_parent__.`,
          suggestion: `Add DELEGATE with RETURNS in the child agent's definition.`,
        });
      }
    }
  }

  // 3. Check for orphan agents (unreachable from entry)
  const entryNodes = topology.nodes.filter((n) => n.isEntry);
  if (entryNodes.length > 0) {
    const reachable = new Set<string>();
    const queue = entryNodes.map((n) => n.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      for (const edge of topology.edges) {
        if (edge.from === current && !reachable.has(edge.to)) {
          queue.push(edge.to);
        }
      }
    }

    for (const node of topology.nodes) {
      if (!reachable.has(node.id)) {
        errors.push({
          type: 'orphan_agent',
          severity: 'warning',
          sourceAgent: node.name,
          message: `Agent "${node.name}" is not reachable from any entry point.`,
          suggestion: `Add an edge from the supervisor to "${node.name}", or remove this agent if it's not needed.`,
        });
      }
    }
  }

  // 4. Check HANDOFF references in ABL match topology
  for (const agent of agents) {
    const handoffMatches = agent.ablContent.matchAll(/TO:\s*(\w+)/g);
    for (const match of handoffMatches) {
      const target = match[1];
      if (!agentNames.has(target) && !nodeNames.has(target)) {
        errors.push({
          type: 'abl_handoff_mismatch',
          severity: 'error',
          sourceAgent: agent.name,
          targetAgent: target,
          message: `Agent "${agent.name}" references HANDOFF TO: ${target}, but no agent with that name exists in the topology.`,
          suggestion: findSimilarName(target, agentNames),
        });
      }
    }
  }

  return {
    valid: errors.filter((e) => e.severity === 'error').length === 0,
    errors,
  };
}

function findSimilarName(target: string, names: Set<string>): string | undefined {
  const lower = target.toLowerCase();
  for (const name of names) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return `Did you mean "${name}"?`;
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Verify build and commit**

```bash
pnpm build --filter=@abl/studio
npx prettier --write apps/studio/src/lib/arch-ai/cross-agent-validator.ts
```

Commit: `[ABLP-XXX] feat(studio): add cross-agent validator for topology consistency`

---

## Task 7: Enhanced Topology Prompt

**Files:**

- Modify: `packages/shared/src/prompts/prompt-catalog.ts:1047-1101`
- Modify: `apps/studio/src/lib/arch-ai/tools/generate-topology.ts:16-25` (Zod schema)
- Modify: `apps/studio/src/services/arch.service.ts:2091-2142` (`generateTopologyStub`)

- [ ] **Step 1: Read current topology prompts**

Read `packages/shared/src/prompts/prompt-catalog.ts` lines 1046-1102 to understand the current `topology_system` and `topology_user` templates.

- [ ] **Step 2: Update topology_system prompt in prompt-catalog.ts**

Replace the `topology_system` template (line 1047) with a pattern-aware version:

```typescript
topology_system: `You are an expert agent system architect. Design optimal multi-agent topologies using the pattern catalog below.

## Topology Pattern Catalog

### Single Agent (single_agent)
**When:** 1 domain, no routing needed. Simple Q&A or task completion.
**Structure:** 1 AGENT (reasoning or hybrid). No supervisor.
**Anti-patterns:** Do not add a supervisor for a single agent.

### Triage -> Specialists (triage_specialists)
**When:** Multiple distinct domains, user intent determines routing.
**Structure:** 1 SUPERVISOR (NLU routing) -> N specialist AGENTs.
**Anti-patterns:** Do not use for sequential workflows.

### Pipeline (pipeline)
**When:** Sequential workflow, each stage transforms/enriches before passing to next.
**Structure:** Chain of AGENTs with pipeline_next edges.
**Anti-patterns:** Do not use when steps can run in parallel.

### Hub-and-Spoke (hub_spoke)
**When:** Central coordinator delegates subtasks, needs results back.
**Structure:** 1 SUPERVISOR with delegate edges -> N workers that return.
**Anti-patterns:** Do not use for simple intent routing.

### Mesh (mesh)
**When:** Peer agents route to each other based on context.
**Structure:** N AGENTs with bidirectional handoff edges.
**Anti-patterns:** Never use for fewer than 3 agents.

## Pattern Selection Decision Tree

Q1: How many distinct capability domains?
  -> 1 domain -> SINGLE AGENT
  -> 2+ domains:
    Q2: Is the workflow sequential (each step feeds the next)?
      -> Yes -> PIPELINE
      -> No:
        Q3: Does a central agent need results back from sub-agents?
          -> Yes -> HUB-AND-SPOKE
          -> No:
            Q4: Can users enter from multiple points / agents are peers?
              -> Yes -> MESH
              -> No -> TRIAGE -> SPECIALISTS

## Canonical Edge Types

- routing: Supervisor intent-based routing (triage pattern)
- delegate: Stack-based, parent pauses, child returns (hub-spoke)
- handoff: Full transfer, no return (triage specialists, mesh)
- escalation: Human handoff
- pipeline_next: Sequential chain (pipeline pattern)

## Output Format

Output valid JSON matching this schema:
{
  "pattern": "single_agent|triage_specialists|pipeline|hub_spoke|mesh",
  "reasoning": "Why this pattern fits the use case",
  "nodes": [{ "id": "string", "name": "PascalCase", "type": "supervisor|agent", "role": "what this agent does", "isEntry": true|false, "executionMode": "reasoning|scripted|hybrid", "tools": [], "gatherFields": [], "description": "string", "suggestedConstructs": ["GATHER","MEMORY","FLOW"] }],
  "edges": [{ "from": "nodeId", "to": "nodeId", "type": "routing|handoff|delegate|escalation|pipeline_next", "condition": "when this edge fires", "returnsControl": true|false }]
}

Output ONLY valid JSON. No markdown, no explanation.`,
```

- [ ] **Step 3: Update topology Zod schema in generate-topology.ts**

Read `apps/studio/src/lib/arch-ai/tools/generate-topology.ts` lines 13-25 first. Then update the node schema to include the new fields:

In `apps/studio/src/lib/arch-ai/tools/generate-topology.ts`, find the `topologySchema` (around line 13) and add the new fields:

```typescript
const topologySchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(['supervisor', 'agent']).catch('agent'),
      isEntry: z.boolean().catch(false),
      executionMode: z.enum(['scripted', 'reasoning', 'hybrid']).catch('reasoning'),
      tools: z.array(z.string()).catch([]),
      gatherFields: z.array(z.string()).catch([]),
      description: z.string().optional(),
      // New fields from staged pipeline
      role: z.string().catch(''),
      suggestedConstructs: z.array(z.string()).catch([]),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      type: z
        .enum(['routing', 'handoff', 'delegate', 'escalation', 'pipeline_next'])
        .catch('routing'),
      condition: z.string().optional(),
      // New field from staged pipeline
      returnsControl: z.boolean().catch(false),
    }),
  ),
});
```

Also add `pattern` and `reasoning` to the tool result by updating `TopologyToolResult` in `types.ts` or handling it inline.

- [ ] **Step 4: Update generateTopologyStub in arch.service.ts**

Read `apps/studio/src/services/arch.service.ts` lines 2091-2142. Update `generateTopologyStub` to be pattern-aware:

In `arch.service.ts`, modify `generateTopologyStub()` to check the number of use cases:

```typescript
export function generateTopologyStub(brief: any) {
  const useCases = (brief.useCases || []).filter(
    (uc: any) => typeof uc === 'string' || uc?.enabled !== false,
  );
  const labels = useCases.map((uc: any) => (typeof uc === 'string' ? uc : uc.label || 'assistant'));

  // Pattern-aware stub: single agent for 1 use case, triage for multiple
  if (labels.length <= 1) {
    const agentName = labels[0]
      ? labels[0].replace(/[^a-zA-Z0-9]/g, '').replace(/^./, (c: string) => c.toUpperCase()) +
        'Agent'
      : 'Assistant';
    return {
      pattern: 'single_agent',
      reasoning: 'Single use case — a single agent is sufficient.',
      nodes: [
        {
          id: agentName.toLowerCase(),
          name: agentName,
          type: 'agent',
          isEntry: true,
          executionMode: 'reasoning',
          tools: [],
          gatherFields: [],
          description: labels[0] || 'General assistant',
          role: labels[0] || 'General assistant',
          suggestedConstructs: ['TOOLS', 'GATHER', 'CONSTRAINTS'],
        },
      ],
      edges: [],
    };
  }

  // Multiple use cases: triage -> specialists (existing logic enhanced)
  const supervisorId = 'supervisor';
  const nodes: any[] = [
    {
      id: supervisorId,
      name: 'Supervisor',
      type: 'supervisor',
      isEntry: true,
      executionMode: 'reasoning',
      tools: [],
      gatherFields: [],
      description: `Routes users to the right specialist based on intent`,
      role: 'Intent classification and routing',
      suggestedConstructs: ['HANDOFF', 'NLU', 'CONSTRAINTS'],
    },
  ];
  const edges: any[] = [];

  for (const label of labels) {
    const safe = label.replace(/[^a-zA-Z0-9]/g, '');
    const name = safe.charAt(0).toUpperCase() + safe.slice(1) + 'Agent';
    const id = name.toLowerCase();
    const isScripted = /\b(status|balance|lookup|check|verify)\b/i.test(label);

    nodes.push({
      id,
      name,
      type: 'agent',
      isEntry: false,
      executionMode: isScripted ? 'scripted' : 'reasoning',
      tools: [],
      gatherFields: [],
      description: label,
      role: label,
      suggestedConstructs: isScripted
        ? ['FLOW', 'TOOLS', 'GATHER', 'ON_START']
        : ['TOOLS', 'GATHER', 'CONSTRAINTS', 'MEMORY'],
    });
    edges.push({
      from: supervisorId,
      to: id,
      type: 'routing',
      condition: `User intent matches: ${label}`,
      returnsControl: false,
    });
  }

  return {
    pattern: 'triage_specialists',
    reasoning: `${labels.length} distinct use cases — triage pattern routes by intent.`,
    nodes,
    edges,
  };
}
```

- [ ] **Step 5: Also update the lenient Zod schema in arch.service.ts**

Read `apps/studio/src/services/arch.service.ts` lines 219-273. Update `topologyNodeSchema` (line 219) and `topologyResponseSchemaLenient` (line 247) to include the new fields (`role`, `suggestedConstructs`, `returnsControl`, `pattern`, `reasoning`).

- [ ] **Step 6: Verify build**

Run: `pnpm build --filter=@abl/studio`

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write packages/shared/src/prompts/prompt-catalog.ts apps/studio/src/lib/arch-ai/tools/generate-topology.ts apps/studio/src/services/arch.service.ts
```

Commit: `[ABLP-XXX] feat(studio): enhance topology generation with pattern catalog and decision tree`

---

## Task 8: Enhanced Agent Generation Pipeline

**Files:**

- Modify: `apps/studio/src/services/arch.service.ts:1958-2076` (`generateSingleAgent`)
- Modify: `apps/studio/src/lib/arch-ai/tools/generate-agents.ts:109-242` (pipeline wiring)
- Modify: `apps/studio/src/lib/arch-ai/abl-builder.ts:24-130` (`buildAbl` enhancement)

This is the largest task — wiring `getRelevantConstructs`, `getModelRecommendation`, and `compileAndFix` into the existing generation pipeline.

- [ ] **Step 1: Read the current generateSingleAgent function**

Read `apps/studio/src/services/arch.service.ts` lines 1958-2076 to understand the current inline prompt construction.

- [ ] **Step 2: Enhance generateSingleAgent with construct injection**

Modify `generateSingleAgent()` in `arch.service.ts` to accept and use construct context and model recommendation. Add two new parameters and inject them into the prompt:

After the existing `const systemPrompt = 'You are an expert ABL developer...'` line, inject the construct reference and model recommendation into the user prompt:

```typescript
export async function generateSingleAgent(
  node: {
    id: string;
    name: string;
    type: string;
    executionMode?: string;
    tools?: string[];
    gatherFields?: string[];
    description?: string;
    role?: string;
    suggestedConstructs?: string[];
  },
  brief: any,
  topology: { nodes: any[]; edges: any[] },
  resolution: ArchLLMResolution,
  // New parameters from staged pipeline
  constructContext?: string,
  modelRecommendation?: { provider: string; model: string; temperature: number; maxTokens: number },
): Promise<{ name: string; ablContent: string } | null> {
```

Then, in the user prompt construction, append the construct context:

```typescript
// After existing prompt content, add construct reference
const constructBlock = constructContext
  ? `\n\n${constructContext}\n\nUse these constructs to generate rich, complete ABL for this agent. Include all relevant sections.`
  : '';

const modelBlock = modelRecommendation
  ? `\n\nEXECUTION config to include:\n  MODEL: ${modelRecommendation.provider}/${modelRecommendation.model}\n  TEMPERATURE: ${modelRecommendation.temperature}\n  MAX_TOKENS: ${modelRecommendation.maxTokens}`
  : '';
```

- [ ] **Step 3: Wire helpers into generate-agents.ts parallel pipeline**

Read `apps/studio/src/lib/arch-ai/tools/generate-agents.ts` lines 109-242. Modify the parallel generation path (lines 192-208) to call `getRelevantConstructs` and `getModelRecommendation` before each agent call, and `compileAndFix` after:

```typescript
// In the ARCH_AI_FAST_GEN === true path, replace the Promise.all block:
const agentPromises = topology.nodes.map(async (node) => {
  // Stage 2a: Construct discovery (deterministic, instant)
  const constructResponse = getRelevantConstructs({
    agentRole: node.role || node.description || node.name,
    agentType: (node.type as 'supervisor' | 'agent') || 'agent',
    executionMode: (node.executionMode as 'reasoning' | 'scripted' | 'hybrid') || 'reasoning',
    domain: brief.domain || '',
    suggestedConstructs: node.suggestedConstructs || [],
    hasComplianceRequirements: brief.constraints?.includes('compliance') || false,
    hasVoiceChannel: brief.channels?.includes('voice') || false,
  });
  const constructPromptText = formatConstructsForPrompt(constructResponse);

  // Stage 2b: Model recommendation (deterministic, instant)
  const modelRec = getModelRecommendation({
    agentRole: node.role || node.description || node.name,
    executionMode: (node.executionMode as 'reasoning' | 'scripted' | 'hybrid') || 'reasoning',
    requiresToolCalling: (node.tools || []).length > 0,
    requiresVision: false,
    requiresStructuredOutput: false,
    complexityTier: determineComplexity(node),
    operations: [],
  });

  // Stage 2c: Generate with enriched prompt
  const raw = await generateSingleAgent(node, brief, topology, resolution, constructPromptText, {
    provider: modelRec.primary.provider,
    model: modelRec.primary.model,
    temperature: modelRec.executionConfig.temperature,
    maxTokens: modelRec.executionConfig.maxTokens,
  });

  if (!raw) return null;

  // Stage 3a: Compile-fix loop (replaces single-shot validate + stub fallback)
  const compileResult = await compileAndFix({
    agentName: raw.name,
    ablContent: sanitizeAbl(raw.ablContent),
    maxRounds: 3,
    constructContext: constructPromptText,
    resolution,
  });

  if (compileResult.success) {
    return {
      ...raw,
      ablContent: compileResult.finalAbl,
      validation: { valid: true, parseErrors: [], compileErrors: [] },
      fromStub: false,
      constructsUsed: compileResult.constructsUsed,
    };
  }

  // Enhanced stub fallback (construct-aware)
  const stubAbl = buildAbl({
    name: node.name,
    type: (node.type as 'supervisor' | 'agent') || 'agent',
    executionMode: node.executionMode,
    description: node.description,
    tools: node.tools,
    gatherFields: node.gatherFields,
    handoffs: topology.edges
      .filter((e) => e.from === node.id)
      .map((e) => {
        const target = topology.nodes.find((n) => n.id === e.to);
        return { to: target?.name || e.to, when: e.condition || '' };
      }),
    domain: brief.domain,
    tone: brief.tone,
    suggestedConstructs: node.suggestedConstructs,
  });

  return {
    ...raw,
    ablContent: stubAbl,
    validation: {
      valid: false,
      parseErrors: [],
      compileErrors: (compileResult.errors || []).map((e) => e.message),
    },
    fromStub: true,
    constructsUsed: [],
  };
});

const rawResults = await Promise.all(agentPromises);
```

Add a helper function `determineComplexity`:

```typescript
function determineComplexity(node: any): 'simple' | 'moderate' | 'complex' {
  const toolCount = (node.tools || []).length;
  const gatherCount = (node.gatherFields || []).length;
  const constructCount = (node.suggestedConstructs || []).length;

  if (toolCount > 3 || constructCount > 5) return 'complex';
  if (toolCount > 1 || gatherCount > 2 || constructCount > 3) return 'moderate';
  return 'simple';
}
```

- [ ] **Step 4: Add imports to generate-agents.ts**

At the top of `generate-agents.ts`, add:

```typescript
import {
  getRelevantConstructs,
  formatConstructsForPrompt,
} from '../helpers/get-relevant-constructs.js';
import { getModelRecommendation } from '../helpers/get-model-recommendation.js';
import { compileAndFix } from '../helpers/compile-and-fix.js';
```

- [ ] **Step 5: Enhance buildAbl with suggestedConstructs**

Read `apps/studio/src/lib/arch-ai/abl-builder.ts` lines 6-16 (`AgentBuildInput`). Add `suggestedConstructs` to the interface:

```typescript
export interface AgentBuildInput {
  name: string;
  type: 'supervisor' | 'agent';
  executionMode?: string;
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  handoffs?: { to: string; when: string }[];
  domain?: string;
  tone?: string;
  suggestedConstructs?: string[]; // New: from topology stage
}
```

Then in `buildAbl()`, after the existing FLOW section, add construct-aware stubs based on `suggestedConstructs`:

```typescript
// Construct-aware stub sections
if (input.suggestedConstructs) {
  if (input.suggestedConstructs.includes('MEMORY') && input.type !== 'supervisor') {
    lines.push('');
    lines.push('MEMORY:');
    lines.push('  SESSION_VARS:');
    lines.push('    - interaction_count: number = 0');
  }

  if (input.suggestedConstructs.includes('CONSTRAINTS') && input.type !== 'supervisor') {
    lines.push('');
    lines.push('CONSTRAINTS:');
    lines.push(`  - REQUIRE: "Verify user identity before accessing sensitive data"`);
    lines.push(`    ON_FAIL: RESPOND "I need to verify your identity first."`);
  }

  if (input.suggestedConstructs.includes('ON_START')) {
    lines.push('');
    lines.push('ON_START:');
    lines.push(`  RESPOND: "Hello! I'm the ${input.name}. How can I help you today?"`);
  }
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm build --filter=@abl/studio`

Fix any type errors immediately.

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/services/arch.service.ts apps/studio/src/lib/arch-ai/tools/generate-agents.ts apps/studio/src/lib/arch-ai/abl-builder.ts
```

Commit: `[ABLP-XXX] feat(studio): wire construct discovery + model recommendation + compile-fix into agent generation`

---

## Task 9: Cross-Agent Validation Wiring

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/generate-agents.ts`

- [ ] **Step 1: Wire cross-agent validator into generate-agents.ts**

After the parallel generation completes and agents are processed, add the cross-agent validation step. In `generate-agents.ts`, after the `Promise.all` results are collected:

```typescript
import { validateCrossAgent } from '../cross-agent-validator.js';

// After processing all agent results into the agents array:

// Stage 3b: Cross-agent validation (sequential)
const crossValidation = validateCrossAgent(
  topology,
  agents.map((a) => ({
    name: a.name,
    ablContent: a.ablContent,
    constructsUsed: a.constructsUsed || [],
  })),
);

// Include cross-validation results in the tool output
return {
  agents,
  allValid: agents.every((a) => a.validation.valid) && crossValidation.valid,
  stats: {
    total: topology.nodes.length,
    valid: agents.filter((a) => a.validation.valid).length,
    stubbed: agents.filter((a) => a.fromStub).length,
    failed: agents.filter((a) => !a.validation.valid && !a.fromStub).length,
  },
  crossValidation: crossValidation.valid
    ? undefined
    : {
        errors: crossValidation.errors,
      },
};
```

- [ ] **Step 2: Verify build and commit**

```bash
pnpm build --filter=@abl/studio
npx prettier --write apps/studio/src/lib/arch-ai/tools/generate-agents.ts
```

Commit: `[ABLP-XXX] feat(studio): wire cross-agent validation into generation pipeline`

---

## Task 10: get_topology_patterns Tool (Project Mode)

**Files:**

- Create: `apps/studio/src/lib/arch-ai/tools/get-topology-patterns.ts`
- Modify: `apps/studio/src/lib/arch-ai/context.ts:31-60`

- [ ] **Step 1: Create get-topology-patterns.ts**

```typescript
import { z } from 'zod';
import { tool } from 'ai';
import { TOPOLOGY_PATTERNS, TOPOLOGY_DECISION_TREE } from '../topology-patterns.js';

export function createTopologyPatternsTool() {
  return tool({
    description:
      'Query the topology pattern catalog. Returns available patterns with selection criteria and anti-patterns. Use when the user asks about restructuring the topology or wants to understand pattern alternatives.',
    parameters: z.object({
      filter: z
        .enum(['all', 'simple', 'complex'])
        .optional()
        .describe(
          'Filter patterns by complexity. simple = single_agent + triage. complex = pipeline + hub_spoke + mesh.',
        ),
      currentPattern: z
        .string()
        .optional()
        .describe('The current topology pattern, for "what alternatives exist?" queries'),
    }),
    execute: async ({ filter, currentPattern }) => {
      let patterns = TOPOLOGY_PATTERNS;

      if (filter === 'simple') {
        patterns = patterns.filter((p) => ['single_agent', 'triage_specialists'].includes(p.id));
      } else if (filter === 'complex') {
        patterns = patterns.filter((p) => ['pipeline', 'hub_spoke', 'mesh'].includes(p.id));
      }

      if (currentPattern) {
        patterns = patterns.filter((p) => p.id !== currentPattern);
      }

      return {
        patterns: patterns.map((p) => ({
          id: p.id,
          name: p.name,
          whenToUse: p.whenToUse,
          structure: p.structure,
          ablImplications: p.ablImplications,
          edgeTypes: p.edgeTypes,
          antiPatterns: p.antiPatterns,
        })),
        decisionTree: TOPOLOGY_DECISION_TREE,
        currentPattern: currentPattern || null,
      };
    },
  });
}
```

- [ ] **Step 2: Add to project context in context.ts**

Read `apps/studio/src/lib/arch-ai/context.ts` lines 31-60. In `getToolsForContext()`, add the new tool to the project context section.

Find the project context block (where `agent_ops`, `analyze`, etc. are defined) and add:

```typescript
import { createTopologyPatternsTool } from './tools/get-topology-patterns.js';

// In the project context return object, add:
get_topology_patterns: createTopologyPatternsTool(),
```

- [ ] **Step 3: Verify build and commit**

```bash
pnpm build --filter=@abl/studio
npx prettier --write apps/studio/src/lib/arch-ai/tools/get-topology-patterns.ts apps/studio/src/lib/arch-ai/context.ts
```

Commit: `[ABLP-XXX] feat(studio): add get_topology_patterns tool for project mode`

---

## Task 11: Integration Testing

**Files:**

- No new files — test against the live app

- [ ] **Step 1: Start Studio**

```bash
SKIP_SETUP=1 NODE_ENV=production pm2 restart abl-studio
```

Wait for Studio to start (check `pm2 logs abl-studio`).

- [ ] **Step 2: Test topology pattern selection — FAQ (should be single_agent)**

Open Studio, start Arch, describe: "I need a simple FAQ bot that answers questions about our product documentation."

Verify: topology uses `single_agent` pattern, NOT supervisor + specialist.

- [ ] **Step 3: Test topology pattern selection — Support (should be triage_specialists)**

Describe: "I need a customer support system with billing, technical support, and shipping departments."

Verify: topology uses `triage_specialists` pattern with supervisor + 3 specialists.

- [ ] **Step 4: Test topology pattern selection — Loan (should be pipeline)**

Describe: "I need a loan application system: intake form, credit check, document verification, then approval."

Verify: topology uses `pipeline` pattern with 4 sequential agents.

- [ ] **Step 5: Test agent construct richness**

For any generated project, check the ABL output of at least one agent. Verify it includes constructs beyond PERSONA + GOAL + TOOLS — look for MEMORY, CONSTRAINTS, EXECUTION, GATHER with DEPENDS_ON, etc.

- [ ] **Step 6: Test compile-fix loop**

Check PM2 logs for compile-fix round messages. If an agent's ABL fails initial compilation, verify the logs show a retry with error context.

- [ ] **Step 7: Verify cross-agent validation**

For a multi-agent topology, verify logs show cross-agent validation results after all agents are generated.

---

## Dependency Graph

```
Task 1 (types + patterns) ─────┐
                                ├─→ Task 7 (topology prompt) ──→ Task 10 (patterns tool)
Task 2 (construct catalog) ─────┤
                                ├─→ Task 3 (getRelevantConstructs) ──┐
                                │                                     ├─→ Task 8 (agent pipeline) ──→ Task 9 (cross-validation wire) ──→ Task 11 (integration test)
                                ├─→ Task 4 (getModelRecommendation) ─┘
                                │
                                ├─→ Task 5 (compileAndFix) ──────────┘
                                │
                                └─→ Task 6 (cross-agent validator) ──┘
```

**Parallelizable:** Tasks 1-6 can all be built in parallel (no dependencies between them). Tasks 7-10 depend on foundation tasks but are independent of each other. Task 11 depends on everything.
