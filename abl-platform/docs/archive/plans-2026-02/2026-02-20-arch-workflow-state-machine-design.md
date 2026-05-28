# Arch Workflow State Machine — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Arch's prompt-based behavior control with a server-side state machine that programmatically enforces read-before-modify, always-confirm, and plan-for-large-changes workflows.

**Architecture:** Server-side state machine per conversation, compiled IR context injection, structured response contract with explicit state + allowed actions.

**Tech Stack:** TypeScript, Next.js API routes, Zustand, existing ABL compiler pipeline.

---

## Problem

Arch's current architecture has three fundamental flaws:

1. **Behavior is prompt-controlled, not programmatic.** The system prompt says "always validate with compile_abl" and "use dryRun=true first" — but the LLM can ignore these instructions. Nothing prevents `modify_agent_abl` from being called without reading the agent first, without user confirmation, or with invalid syntax.

2. **Arch is ABL-ignorant.** It receives the raw DSL as a string and has a one-line syntax reference (`CONSTRAINTS: <name>: "<rule>"` — which is wrong). It doesn't see the compiled IR, doesn't know about compile errors, and halluccinates syntax.

3. **No confirmation gate.** The `modify_agent_abl` tool can auto-apply changes (dryRun defaults to false when Arch doesn't pass it). The user sees the result after the fact, not before.

## Scope

The state machine applies to three stage groups:

| Stage Group          | Stages                               | What Changes                                                                          |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| **ABL editing**      | `build`, `evolve`                    | Full state machine: read → compile → analyze → propose → confirm → execute → validate |
| **Artifact editing** | `edit`                               | Lighter state machine: analyze → propose → confirm → apply (no ABL compilation)       |
| **Conversational**   | `ideate`, `design`, `test`, `deploy` | Unchanged — no state machine needed                                                   |

---

## Design

### 1. Workflow States

```
IDLE ──► READING ──► ANALYZING ──► PROPOSING ──► CONFIRMING
                                       │              │  │  │
                                       ▼           confirm refine reject
                                   RESPONDING         │    │    │
                                       │               ▼    │    ▼
                                       ▼          EXECUTING  │  IDLE
                                     IDLE              │     │
                                                       ▼     │
                                                  VALIDATING  │
                                                    │    │    │
                                                   ok  error  ▼
                                                    │    └►ANALYZING
                                                    ▼
                                                  IDLE
```

| State          | Purpose                                   | Tools Available                                        | LLM Called?        |
| -------------- | ----------------------------------------- | ------------------------------------------------------ | ------------------ |
| **IDLE**       | Waiting for user input                    | None                                                   | No                 |
| **READING**    | Auto-fetch agent DSL + compile to IR      | `read_agent_dsl`, `list_project_agents` (auto-invoked) | No                 |
| **ANALYZING**  | LLM analyzes request with full IR context | `compile_abl` (read-only)                              | Yes                |
| **PROPOSING**  | LLM produces plan or diff                 | None (response only)                                   | Yes                |
| **CONFIRMING** | Waiting for user confirm/reject/refine    | None                                                   | No                 |
| **EXECUTING**  | Apply changes via `modify_agent_abl`      | `modify_agent_abl`                                     | No (deterministic) |
| **VALIDATING** | Auto-compile modified DSL                 | `compile_abl` (auto-invoked)                           | No                 |
| **RESPONDING** | Pure Q&A, no code changes                 | `query_session_traces`                                 | Yes                |

### Key Rules (enforced in code)

- `modify_agent_abl` is physically absent from the tool list in every state except EXECUTING
- EXECUTING is only reachable from CONFIRMING — user must have explicitly confirmed
- READING is automatic — when context has an agent, server reads + compiles before calling LLM
- VALIDATING is automatic — after every execution, server compiles; errors loop back to ANALYZING

### Intent Classification

Server determines question vs. action before invoking LLM:

- editContext exists AND message implies change → action path (READING → ANALYZING → PROPOSING)
- Message is purely interrogative → response path (RESPONDING)
- Ambiguous → lightweight LLM call returns `{ intent: 'question' | 'action' }`

### Edit Stage Variant

For the `edit` stage (artifact JSON, not ABL):

- No READING or VALIDATING states (no DSL to compile)
- ANALYZING receives the current artifact JSON from context
- PROPOSING returns a diff of the JSON artifact
- EXECUTING applies the artifact change directly
- Same CONFIRMING gate applies

---

### 2. ABL-Aware Context Injection

When the state machine enters READING, the server runs an enrichment pipeline (no LLM):

```
1. Fetch raw DSL (findProjectAgent)
2. Parse (parseAgentBasedABL → AST)
3. Compile (compileABLtoIR → IR + errors)
4. Extract structured context:
   {
     agent: { name, mode, goal, persona },
     constraints: [
       { condition, on_fail: { action, message }, has_error?: true, error?: string }
     ],
     tools: [ { name, params, return_type, binding } ],
     gather: [ { name, type, required, prompt } ],
     flow: { entry_point, steps: [ { name, transitions } ] },
     coordination: { handoffs, delegates, escalation },
     compile_errors: [ { message, type, agent } ],
     warnings: []
   }
5. If editContext.section exists, expand that section's data; summarize others
```

What the LLM receives (instead of raw DSL string):

```
<agent_context>
Agent: booking_agent (scripted mode)
Goal: "Help users book hotels"

CURRENT CONSTRAINTS (2):
  1. REQUIRE num_guests <= 10 → ON_FAIL: RESPOND "Max 10 guests"
  2. REQUIRE destination <<= origin → ON_FAIL: RESPOND "..."
     ⚠ COMPILE ERROR: Invalid operator "<<=" — valid: ==, !=, >, <, >=, <=

CURRENT TOOLS (3): search_hotels, book_room, cancel_booking
CURRENT GATHER (4): destination, check_in, check_out, num_guests
CURRENT FLOW: welcome → search → confirm → complete (4 steps)
</agent_context>
```

Benefits:

- Arch sees errors before thinking — no hallucinated syntax
- Structured data means Arch can reference "constraint #2" precisely
- Section-focused: editing CONSTRAINTS expands that section; others summarized
- Raw DSL still available via tool call for full-file context

---

### 3. Confirmation Gate & Scaled Presentation

Every code modification requires explicit user confirmation. Presentation scales to change size.

#### Scope Classification (server-side, deterministic)

```typescript
function classifyScope(proposal): 'small' | 'large' {
  if (proposal.sections_affected.length > 1) return 'large';
  if (proposal.estimated_line_changes > 5) return 'large';
  if (proposal.changes_flow_structure) return 'large';
  if (proposal.changes_entry_point) return 'large';
  return 'small';
}
```

#### Small Change → Compact Diff Card

Single section, ≤5 lines. Server returns:

```json
{
  "state": "confirming",
  "message": "Changing <<= to != so the constraint triggers when cities match.",
  "proposal": {
    "scope": "small",
    "sections_affected": ["CONSTRAINTS"],
    "diffs": [
      {
        "section": "CONSTRAINTS",
        "before": "  - REQUIRE destination <<= origin",
        "after": "  - REQUIRE destination != origin",
        "summary": "Fix invalid operator <<= → !="
      }
    ]
  },
  "actions": [{ "type": "confirm" }, { "type": "reject" }, { "type": "refine" }]
}
```

Client renders diff card with Apply/Reject buttons.

#### Large Change → Plan Card First

Multiple sections or structural change. Server returns:

```json
{
  "state": "confirming",
  "message": "Here's my plan to add error handling to the booking flow:",
  "proposal": {
    "scope": "large",
    "sections_affected": ["FLOW", "CONSTRAINTS", "TOOLS"],
    "plan": {
      "summary": "Add error handling to booking flow",
      "steps": [
        { "section": "FLOW", "description": "Add ON_ERROR handler to search step" },
        { "section": "FLOW", "description": "Add retry logic to book step" },
        { "section": "CONSTRAINTS", "description": "Add timeout constraint" }
      ]
    }
  },
  "actions": [{ "type": "confirm" }, { "type": "reject" }, { "type": "refine" }]
}
```

Client renders plan card with Go ahead/Refine buttons. After confirmation, server executes steps sequentially, showing individual diffs.

#### Refine Loop

User clicks "Refine" → state goes back to ANALYZING with user's feedback. Arch re-proposes. Loops until confirm or reject.

---

### 4. Server Response Contract

Every response from `/api/arch/chat` follows this shape:

```typescript
interface ArchChatResponse {
  success: boolean;
  data: {
    message: string; // Arch's text
    state: WorkflowState; // Current state
    actions: ArchAction[]; // Allowed user actions

    // Conditional
    proposal?: ArchProposal; // In CONFIRMING state
    validation?: ArchValidation; // After VALIDATING
    agentContext?: ArchAgentContext; // After READING (structured IR)
    toolsUsed?: string[]; // Tools called this turn
  };
}

type WorkflowState =
  | 'idle'
  | 'reading'
  | 'analyzing'
  | 'proposing'
  | 'confirming'
  | 'executing'
  | 'validating'
  | 'responding';

type ArchAction =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'refine'; placeholder: string }
  | { type: 'send'; placeholder: string }
  | { type: 'none' };
```

### Client Rendering Rules

Client reads `state` and `actions` — doesn't decide UI independently:

| `state`                    | Client Renders                 |
| -------------------------- | ------------------------------ |
| `idle`                     | Normal chat input              |
| `reading`                  | Spinner: "Reading agent..."    |
| `analyzing`                | Spinner: "Analyzing..."        |
| `confirming` + small scope | Diff card + Apply/Reject       |
| `confirming` + large scope | Plan card + Go ahead/Refine    |
| `executing`                | Spinner: "Applying changes..." |
| `validating`               | Spinner: "Validating..."       |
| `responding`               | Normal message bubble          |

---

### 5. File Plan

#### New Files

| File                                          | Purpose                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/studio/src/lib/arch-workflow.ts`        | State machine: state definitions, transition rules, state handlers, scope classifier |
| `apps/studio/src/lib/arch-context-builder.ts` | IR context builder: reads DSL, compiles, extracts structured context                 |

#### Modified Files

| File                                            | Changes                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/arch/chat/route.ts`    | Replace `agenticLoop` with state machine dispatch. New response shape. System prompts simplified.                                                    |
| `apps/studio/src/lib/arch-tools.ts`             | Tools gated by state. `modify_agent_abl` only in EXECUTING. ABL syntax removed from descriptions.                                                    |
| `apps/studio/src/store/arch-store.ts`           | Add `workflowState`, `proposal` fields. Actions: `setWorkflowState()`, `setProposal()`, `confirmProposal()`, `rejectProposal()`, `refineProposal()`. |
| `apps/studio/src/components/arch/ArchPanel.tsx` | Read `workflowState`. Render action buttons from server `actions`. Spinners for transient states. Disable input during executing/validating.         |
| `apps/studio/src/components/arch/ArchChat.tsx`  | Accept `workflowState` and `actions` props. Render action bar from `actions`.                                                                        |
| `apps/studio/src/types/arch.ts`                 | Add `WorkflowState`, `ArchAction`, `ArchProposal`, `ArchAgentContext`, `ArchValidation` types.                                                       |

#### Unchanged

- Tool implementations (`read_agent_dsl`, `list_project_agents`, `compile_abl`, `query_session_traces`)
- `spliceSections`, `diffABL` from project-io
- `parseAgentBasedABL`, `compileABLtoIR` from compiler
- Conversation persistence (localStorage + MongoDB) — gains `workflowState` field
- ArchDiffView, PlanMessage, ProposalMessage components — reused as-is
- Section editing flow (editContext, suggestion chips)
- Ideate, design, test, deploy stages — conversational, unchanged

---

## Verification

1. **Programmatic guarantee**: Attempt to call `modify_agent_abl` without user confirmation → server rejects (tool not in allowed set for current state)
2. **ABL awareness**: Open agent with compile errors → Arch sees errors in structured context before LLM call → proposes fix accurately
3. **Small change**: Ask "fix the constraint operator" → compact diff card → user confirms → applied + validated
4. **Large change**: Ask "add error handling to the entire flow" → plan card with steps → user confirms → sequential diffs → validated
5. **Refine loop**: User clicks "Refine" on a plan → Arch re-analyzes → new proposal
6. **Validation failure**: Arch produces invalid ABL in EXECUTING → VALIDATING catches it → errors fed back to ANALYZING → Arch fixes
7. **Edit stage**: Modify topology JSON in onboarding → same confirm gate, no ABL compilation
8. **Q&A path**: Ask "explain this constraint" → RESPONDING state, no confirmation needed, instant answer
