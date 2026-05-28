# Decision Log Design

Date: 2026-03-08
Status: Approved

## Problem

Runtime decision reasoning is opaque. Trace events record outcomes (handoff to X, transition to step Y) but not the reasoning (which conditions were evaluated, what data values drove the decision). This makes debugging agent behavior during development and post-mortem analysis slow and painful.

## Solution

A Decision Log — a compact per-session document that captures the causal chain of runtime decisions. Separate from the trace event stream.

## Data Model

```typescript
interface DecisionLog {
  sessionId: string;
  agentName: string;
  entries: DecisionEntry[];
  createdAt: Date;
  updatedAt: Date;
}

interface DecisionEntry {
  turn: number;
  timestamp: number;
  type: DecisionType;
  outcome: string;
  condition?: string;
  matched: boolean;
  trigger?: Record<string, unknown>;
  candidates?: string[];
  selectedReason?: string;
  field?: string;
  violation?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: string;
}

type DecisionType =
  | 'handoff'
  | 'flow_transition'
  | 'constraint_check'
  | 'completion'
  | 'escalation'
  | 'delegation'
  | 'gather_extraction'
  | 'field_validation'
  | 'guardrail_check'
  | 'correction'
  | 'data_mutation';
```

## Entry Types (11 total)

| Type              | What It Captures                                                   | Typical Size  |
| ----------------- | ------------------------------------------------------------------ | ------------- |
| handoff           | Candidate list, condition evaluated, which matched, trigger values | 150-200 bytes |
| flow_transition   | fromStep, toStep, condition, trigger values                        | 100-150 bytes |
| constraint_check  | Constraint name, field, pass/fail, violation type                  | 100-150 bytes |
| completion        | Which completion condition matched, trigger values                 | 100-150 bytes |
| escalation        | Reason, priority, trigger condition                                | 100-150 bytes |
| delegation        | Target agent, purpose, input mapping, WHEN condition               | 120-180 bytes |
| gather_extraction | Strategy chosen (pattern/llm/hybrid), fields extracted, failures   | 100-200 bytes |
| field_validation  | Field name, rule type (pattern/enum/range), pass/fail, value       | 80-150 bytes  |
| guardrail_check   | Guardrail name, tier evaluated, action taken                       | 100-150 bytes |
| correction        | Field corrected, old value, new value, dependent fields cleared    | 80-120 bytes  |
| data_mutation     | Field name, old value, new value, source (hook/SET/delegate/tool)  | 60-100 bytes  |

## Tiered Verbosity

Uses the existing `session.traceVerbosity` field (already defined in RuntimeSession, not yet wired).

| Level    | Decision Log | Trace Events                      | Use Case                         |
| -------- | ------------ | --------------------------------- | -------------------------------- |
| minimal  | OFF          | Errors + handoffs only            | High-volume production           |
| standard | OFF          | Current behavior (17 event types) | Default production               |
| verbose  | ON           | Current + enriched                | Per-session production debugging |
| debug    | ON           | Full enrichment + LLM content     | Studio dev-time                  |

How verbosity is set:

1. Project-level default in ProjectRuntimeConfigIR
2. Studio chat sessions auto-set `debug`
3. MCP debug server sets `verbose` when attaching
4. API override via POST /sessions param

## Emission

Single function, 11 call sites, gated by verbosity:

```typescript
function appendDecision(
  session: RuntimeSession,
  entry: Omit<DecisionEntry, 'turn' | 'timestamp'>,
): void {
  if (!shouldLogDecisions(session.traceVerbosity)) return;
  session.decisionLog ??= [];
  session.decisionLog.push({
    ...entry,
    turn: session.conversationHistory.filter((m) => m.role === 'user').length,
    timestamp: Date.now(),
  });
}
```

### Emission Points

1. handoff — routing-executor, handoff condition evaluation loop
2. flow_transition — flow-step-executor, THEN/ON_INPUT/conditional transitions
3. constraint_check — constraint-checker, constraint evaluation
4. completion — completion-detector / flow-step-executor, COMPLETE condition
5. escalation — routing-executor, escalation trigger
6. delegation — flow-step-executor, DELEGATE dispatch
7. gather_extraction — flow-step-executor, extraction strategy selection + result
8. field_validation — flow-step-executor, per-field validation
9. guardrail_check — guardrail pipeline evaluation
10. correction — correction-handler, user correction detection
11. data_mutation — anywhere data.values is modified by non-gather source (hooks, SET, delegate results, tool result mapping)

## Storage

| Store      | Format                                                   | TTL                             | Purpose                             |
| ---------- | -------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| In-memory  | `session.decisionLog: DecisionEntry[]` on session object | Session lifetime                | Real-time access for Studio and MCP |
| MongoDB    | `decisionLog` field on session document                  | Same as session                 | Post-mortem queries                 |
| ClickHouse | Materialized from MongoDB on session close               | 30d warm, 90d cold, 730d delete | Aggregate analytics                 |

MongoDB index: `{ projectId: 1, "decisionLog.type": 1, updatedAt: -1 }`

## Size & Scale

Per session: 2-10 KB (15-50 entries at 100-200 bytes each)

At 10M sessions/day (worst case, all verbose):

- MongoDB: +50 GB/day pre-compression
- ClickHouse: +12 GB/day (ZSTD compressed)

In practice: production sessions default to `standard` (decision log OFF). Only Studio/debug sessions pay the cost.

## Observatory UI — Tab Consolidation

The current 10-tab DebugTabs creates cognitive overload with significant overlap between tabs. Consolidate to 5 tabs:

### Current (10 tabs) → New (5 tabs)

| Current Tab          | Current Content                                 | Maps To                                          |
| -------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Timeline             | Flat event stream, latency metrics              | **Decisions** (causal tree replaces flat stream) |
| Data (Gather)        | Gathered field values, progress bars            | **Data** (merged with Context)                   |
| Guards (Constraints) | Constraint pass/fail results                    | **Decisions** (constraint_check entries)         |
| Context              | Phase, gatherProgress, context vars, flow state | **Data** (merged with Data)                      |
| History              | Conversation messages                           | **Conversation** (standalone)                    |
| LLM Calls            | Model, tokens, latency per call                 | **Performance** (merged with Logs)               |
| IR                   | Agent DSL source, compiled IR JSON              | **Agent IR** (standalone, low priority)          |
| Analysis             | Diagnostic pattern detection                    | **Decisions** (issues surfaced inline)           |
| Test Context         | Test mocks, tool overrides                      | **Agent IR** (collapsed section)                 |
| Logs                 | Runtime log stream with level filter            | **Performance** (merged with LLM Calls)          |

### New Tab Definitions

#### 1. Decisions (primary debugging view)

Replaces: Timeline + Guards + Analysis

Renders `session.decisionLog` grouped by conversation turn as a causal tree:

```
Turn 1: "book a flight to Paris"
  ├─ gather_extraction: destination="Paris" (pattern)
  ├─ field_validation: destination ✓
  └─ completion: false (pending: travel_date, num_passengers)

Turn 2: "next Monday"
  ├─ gather_extraction: travel_date="2026-03-09" (llm)
  ├─ field_validation: travel_date ✓
  ├─ constraint_check: future_date ✓
  └─ data_mutation: _turns 1→2 (source: lifecycle_hook:after_turn)

Turn 3: "just me"
  ├─ gather_extraction: num_passengers=1 (pattern)
  ├─ completion: true (all_fields_collected)
  └─ handoff: Booking_Agent (condition: "intent=='booking'", 2 candidates)
```

All 11 decision entry types rendered. Icons + color coding per type. Expand any entry for full trigger data.

Diagnostic issues from Analysis (gather stall, extraction fallback, etc.) surface as inline warnings on the relevant turn.

Latency metrics from SessionTimeline surface as a collapsible summary at the top (total LLM time, tool time, turn count).

#### 2. Data

Replaces: Data (Gather) + Context

Two sections in one tab:

- **Collected Fields** — gathered field values with progress indicators (from GatherProgressPanel)
- **Session State** — phase, context variables, flow state, constraint results (from ContextTab)

Same components, just co-located.

#### 3. Conversation

Replaces: History

No change — conversation messages as-is. Clear, focused purpose.

#### 4. Performance

Replaces: LLM Calls + Logs

Two sections:

- **LLM Calls** — model, tokens, latency, cost per call (from LLMCallsTab)
- **Runtime Logs** — log stream with level filter and clear button (from LogsTab)

Collapses operational diagnostics into one place.

#### 5. Agent IR

Replaces: IR + Test Context

Two sections:

- **Agent Definition** — DSL source with syntax highlighting, compiled IR JSON (from IRTab)
- **Test Context** — tool mocks, test overrides (from TestContextPanel, collapsed by default)

Static reference, rarely used during active debugging.

### Implementation

The DebugTab type changes from 10 values to 5:

```typescript
type DebugTab = 'decisions' | 'data' | 'conversation' | 'performance' | 'ir';
```

Existing sub-components (SessionTimeline, GatherProgressPanel, ConstraintMonitor, LLMCallsTab, etc.) are reused — they're composed into the new tab layouts, not rewritten.

The DecisionTreeView is the only new component. It renders `session.decisionLog` entries grouped by turn with expand/collapse per entry.

## MCP Integration

- `debug_get_current_state` — returns `decisionLog` as part of session state (already included)
- `debug_explain_decision` — queries `decisionLog` for entries around the decision point, builds causal chain

## PII Boundary

Trigger values include ONLY the fields referenced in conditions (not full data.values). All values pass through existing `scrubSecrets()` pipeline before MongoDB/ClickHouse persistence.
