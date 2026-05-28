# Unified Agent Orchestration Design

**Date:** 2026-03-06
**Status:** Approved
**Scope:** Rename DELEGATE→INVOKE, rename FAN_OUT→PARALLEL, add PIPELINE construct, unify runtime engine, reframe mental model

---

## 1. Problem

Customers see all agents as interactive entities. Having DELEGATE (non-interactive subtask) vs HANDOFF (interactive transfer) creates confusion about when to use which. The naming "delegate" doesn't convey the interaction semantics clearly.

Additionally, fan-out only supports parallel dispatch. Sequential chained execution (where each agent builds on the prior agent's output) is a common pattern with no first-class support.

## 2. Mental Model

Four agent-to-agent coordination constructs, each with a clear purpose:

| Construct    | Customer reads as                 | User talks to child? | Execution                      |
| ------------ | --------------------------------- | -------------------- | ------------------------------ |
| **HANDOFF**  | "Transfer the user to this agent" | Yes (interactive)    | Sequential, child takes over   |
| **INVOKE**   | "Ask this agent for a result"     | No (one-shot)        | Sequential, parent blocks      |
| **PARALLEL** | "Ask multiple agents at once"     | No (one-shot each)   | Parallel, parent merges        |
| **PIPELINE** | "Chain agents in sequence"        | No (one-shot each)   | Sequential, results accumulate |

**Analogy:**

- HANDOFF = "Let me transfer you to billing"
- INVOKE = "Let me check with our pricing team"
- PARALLEL = "Let me check with billing, shipping, and inventory all at once"
- PIPELINE = "Let me research this, then analyze it, then write a report"

## 3. Industry Context

| Platform           | Transfer                | Subtask                 | Parallel                     | Pipeline               |
| ------------------ | ----------------------- | ----------------------- | ---------------------------- | ---------------------- |
| OpenAI Agents SDK  | `handoffs=[agent]`      | `agent.as_tool()`       | N/A                          | N/A                    |
| Google ADK         | `transfer_to_agent`     | `AgentTool(agent)`      | N/A                          | `SequentialAgent`      |
| LangGraph          | `create_handoff_tool()` | Supervisor pattern      | Parallel branches            | Sequential graph edges |
| CrewAI             | N/A                     | `allow_delegation=True` | `Process.parallel` (planned) | `Process.sequential`   |
| AutoGen            | `HandoffMessage`        | Nested chat             | Group chat                   | Sequential chat        |
| **ABL (proposed)** | `HANDOFF:`              | `INVOKE:`               | `PARALLEL:`                  | `PIPELINE:`            |

ABL is the only platform with first-class support for all four patterns as named DSL constructs.

## 4. DSL Syntax

### 4.1 HANDOFF (unchanged)

```dsl
HANDOFF:
  - TO: Payment_Agent
    WHEN: reservation.ready_for_payment == true
    CONTEXT:
      pass: [reservation, user.loyalty_programs]
      summary: "User booking {selected_hotel.name}, total: ${reservation.total}"
      history: full
    RETURN: true
```

No changes. The `RETURN:true` + `__return_to_parent__` system (just implemented) continues to work.

### 4.2 INVOKE (renamed from DELEGATE)

```dsl
INVOKE:
  - AGENT: Price_Calculator
    WHEN: needs_pricing == true
    PURPOSE: "Calculate total price with taxes"
    INPUT: { hotel_id: selected_hotel_id, dates: booking_dates, guests: num_guests }
    RETURNS: { total: total_price, taxes: tax_amount }
    USE_RESULT: price_breakdown
    TIMEOUT: 15s
    ON_FAILURE: continue
```

Same fields as current DELEGATE, renamed section. All existing DELEGATE behavior preserved:

- One-shot execution (no user interaction)
- Ephemeral thread
- INPUT/RETURNS mapping
- Timeout with AbortSignal
- ON_FAILURE: continue | escalate | respond
- Cycle detection via invocationStack (renamed from delegateStack)
- Depth limit (MAX_INVOKE_DEPTH = 10)

### 4.3 PARALLEL (renamed from FAN_OUT)

```dsl
# No DSL section — PARALLEL is a runtime tool available to supervisors/agents with handoff targets.
# The __parallel__ tool schema replaces __fan_out__.
# Internal change: agent tasks use INVOKE infrastructure.
```

PARALLEL agent tasks become parallel INVOKE calls internally. Tool tasks remain direct parallel execution. Result synthesis by parent LLM stays the same.

### 4.4 PIPELINE (new)

```dsl
PIPELINE:
  - AGENT: Research_Agent
    PURPOSE: "Research the topic thoroughly"
    INPUT: { topic: user_query }
    USE_RESULT: research_data
    TIMEOUT: 30s
    ON_FAILURE: respond

  - AGENT: Analysis_Agent
    PURPOSE: "Analyze research findings against criteria"
    INPUT: { data: research_data, criteria: analysis_criteria }
    USE_RESULT: analysis_result
    TIMEOUT: 20s
    ON_FAILURE: respond

  - AGENT: Report_Agent
    PURPOSE: "Generate executive summary from analysis"
    INPUT: { analysis: analysis_result, original_query: user_query }
    USE_RESULT: final_report
    TIMEOUT: 15s
    ON_FAILURE: respond
```

**Key properties:**

- Stages execute in declared order
- Each stage's INPUT can reference previous stages' USE_RESULT variables
- Each stage is a one-shot INVOKE (no user interaction)
- If a stage fails, ON_FAILURE determines whether the pipeline continues or stops
- All intermediate results are available to the parent agent after pipeline completes
- Accumulated context: each stage sees all prior USE_RESULT values in addition to its explicit INPUT

## 5. IR Schema Changes

```typescript
// Before
interface CoordinationConfig {
  delegates: DelegateConfig[];
  handoffs: HandoffConfig[];
  escalation?: EscalationConfig;
}

// After
interface CoordinationConfig {
  invocations: InvocationConfig[]; // renamed from delegates
  handoffs: HandoffConfig[];
  pipelines: PipelineConfig[]; // new
  escalation?: EscalationConfig;
}

// InvocationConfig — renamed from DelegateConfig, same fields
interface InvocationConfig {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  use_result: string;
  timeout?: string;
  on_failure: 'continue' | 'escalate' | 'respond';
  failure_message?: string;
  remote?: RemoteAgentLocation;
}

// PipelineConfig — new
interface PipelineConfig {
  name?: string; // optional pipeline name
  when?: string; // optional CEL condition
  stages: PipelineStageConfig[];
  on_failure?: 'stop' | 'skip' | 'respond'; // pipeline-level failure handling
}

interface PipelineStageConfig {
  agent: string;
  purpose: string;
  input: Record<string, string>; // can reference prior USE_RESULT vars
  use_result: string;
  timeout?: string;
  on_failure?: 'stop' | 'skip' | 'respond'; // stage-level override
  failure_message?: string;
}
```

## 6. Runtime Changes

### 6.1 System Tool Renames

| Before                                  | After                                   |
| --------------------------------------- | --------------------------------------- |
| `SYSTEM_TOOL_DELEGATE` (`__delegate__`) | `SYSTEM_TOOL_INVOKE` (`__invoke__`)     |
| `SYSTEM_TOOL_FAN_OUT` (`__fan_out__`)   | `SYSTEM_TOOL_PARALLEL` (`__parallel__`) |
| `delegateStack`                         | `invocationStack`                       |
| `handleDelegate()`                      | `handleInvoke()`                        |
| `handleFanOut()`                        | `handleParallel()`                      |
| `delegate_start` trace                  | `invoke_start` trace                    |
| `delegate_complete` trace               | `invoke_complete` trace                 |
| `fan_out_start` trace                   | `parallel_start` trace                  |
| `fan_out_complete` trace                | `parallel_complete` trace               |
| `mapDelegateInput()`                    | `mapInvokeInput()`                      |
| `mapDelegateReturns()`                  | `mapInvokeReturns()`                    |
| `handleDelegateFailure()`               | `handleInvokeFailure()`                 |
| `MAX_DELEGATE_DEPTH`                    | `MAX_INVOKE_DEPTH`                      |

### 6.2 New: `__pipeline__` System Tool

```json
{
  "name": "__pipeline__",
  "description": "Execute a sequence of agents where each builds on the prior result. Available pipelines: research_and_report (Research → Analysis → Report).",
  "input_schema": {
    "type": "object",
    "properties": {
      "pipeline": { "type": "string", "description": "Pipeline name to execute" },
      "input": { "type": "object", "description": "Initial input for the first stage" }
    },
    "required": ["pipeline"]
  }
}
```

### 6.3 New: `handlePipeline()` Method

```
handlePipeline(session, input, onChunk, onTraceEvent)
  |
  +-- Look up PipelineConfig by name
  +-- Emit 'pipeline_start' trace
  +-- For each stage (in order):
  |   +-- Resolve INPUT (merge explicit input + accumulated USE_RESULT vars)
  |   +-- Call handleInvoke() for the stage's agent
  |   +-- Store result in accumulated context under USE_RESULT key
  |   +-- Emit 'pipeline_stage_complete' trace
  |   +-- If failure: check stage/pipeline ON_FAILURE (stop | skip | respond)
  +-- Emit 'pipeline_complete' trace
  +-- Return accumulated results to parent
```

Pipeline is implemented as sequential INVOKE calls with accumulated context. No new thread model needed — reuses INVOKE infrastructure.

### 6.4 PARALLEL Internal Change (renamed from Fan-Out)

Agent tasks in PARALLEL switch from creating parallel child sessions to parallel INVOKE calls. This simplifies the engine:

- Rename `handleFanOut()` → `handleParallel()`
- Remove child session creation for agent tasks
- Use `handleInvoke()` with `Promise.allSettled()` for agent tasks
- Tool tasks remain direct parallel execution (unchanged)
- Result synthesis by parent LLM stays the same
- Trace events renamed: `fan_out_*` → `parallel_*`

### 6.5 New Trace Events

| Event                     | Emitted By       | Data Fields                           | Purpose                                             |
| ------------------------- | ---------------- | ------------------------------------- | --------------------------------------------------- |
| `invoke_start`            | `handleInvoke`   | targetAgent, input                    | Agent invocation start (replaces `delegate_start`)  |
| `invoke_complete`         | `handleInvoke`   | targetAgent, result                   | Agent invocation end (replaces `delegate_complete`) |
| `pipeline_start`          | `handlePipeline` | pipelineName, stageCount              | Pipeline execution start                            |
| `pipeline_stage_complete` | `handlePipeline` | stage, agent, result, accumulatedKeys | Pipeline stage completion                           |
| `pipeline_complete`       | `handlePipeline` | pipelineName, success, stageResults   | Pipeline execution end                              |

## 7. Backward Compatibility

### 7.1 DSL Parser

- Accept both `DELEGATE:` and `INVOKE:` sections
- `DELEGATE:` emits a deprecation warning during compilation
- Both parse to the same `InvocationConfig` IR type
- Remove `DELEGATE:` support after one release cycle

### 7.2 IR Schema

- Accept both `delegates` and `invocations` fields
- At IR load time, map `delegates` → `invocations` if present
- Runtime reads only `invocations`

### 7.3 Runtime Tools

- Accept both `__delegate__` and `__invoke__` tool calls
- `__delegate__` mapped internally to `handleInvoke()`
- Trace events emit new names (`invoke_start`/`invoke_complete`)

### 7.4 Session Model

- `delegateStack` renamed to `invocationStack` in new sessions
- On session restore, map `delegateStack` → `invocationStack` if present

## 8. What Doesn't Change

- HANDOFF syntax and all behavior (unchanged)
- `__return_to_parent__` tool (just implemented)
- Thread resume logic (just implemented)
- `__escalate__` tool (unchanged)
- Completion checking (unchanged)
- Session/thread model (unchanged)
- Supervisor routing (unchanged)
- Remote agent protocol support (unchanged)

## 9. Execution Order

```
Phase 1: DELEGATE → INVOKE rename
  - Constants, IR schema, parser, runtime handler, tool injection, trace events
  - Backward compat: accept both DELEGATE and INVOKE
  - Tests: update all delegate tests, add invoke-specific tests

Phase 2: PIPELINE construct
  - DSL parser: add PIPELINE section parsing
  - IR schema: add PipelineConfig
  - Compiler: compile PIPELINE to IR
  - Runtime: add __pipeline__ tool, handlePipeline() method
  - Tool injection: add pipeline tool to prompt-builder
  - Tests: pipeline execution, failure handling, accumulated context

Phase 3: FAN_OUT → PARALLEL rename + internal alignment
  - Rename constants, handler, tool, trace events (fan_out → parallel)
  - Refactor agent tasks to use handleInvoke() internally
  - Remove child session creation for agent tasks
  - Simplify parallel engine
  - Backward compat: accept both __fan_out__ and __parallel__ tool calls
  - Tests: verify parallel dispatch still works with new infrastructure

Phase 4: Deprecation removal (future release)
  - Remove DELEGATE parser support
  - Remove delegates IR field
  - Remove __delegate__ tool handling
  - Remove delegateStack compat mapping
  - Remove __fan_out__ tool handling
```

## 10. Key Files

| File                                                        | Phase | Change                                                               |
| ----------------------------------------------------------- | ----- | -------------------------------------------------------------------- |
| `packages/compiler/src/platform/constants.ts`               | 1     | Rename `SYSTEM_TOOL_DELEGATE` → `SYSTEM_TOOL_INVOKE`                 |
| `packages/compiler/src/platform/ir/schema.ts`               | 1+2   | Rename `DelegateConfig` → `InvocationConfig`, add `PipelineConfig`   |
| `packages/compiler/src/platform/ir/compiler.ts`             | 1+2   | Compile INVOKE and PIPELINE sections                                 |
| `packages/core/src/parser/agent-based-parser.ts`            | 1+2   | Parse INVOKE and PIPELINE sections                                   |
| `apps/runtime/src/services/execution/prompt-builder.ts`     | 1+2+3 | Inject `__invoke__`, `__pipeline__`, `__parallel__` tools            |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | 1+2+3 | Dispatch `__invoke__`, `__pipeline__`, `__parallel__` tool calls     |
| `apps/runtime/src/services/execution/routing-executor.ts`   | 1+2+3 | Rename handlers, add `handlePipeline()`, refactor `handleParallel()` |
| `apps/runtime/src/services/execution/types.ts`              | 1     | Rename `delegateStack` → `invocationStack`                           |
| `apps/runtime/src/services/runtime-executor.ts`             | 1     | Update references                                                    |

## Feature Change Analysis

> Merged from `2026-03-06-unified-orchestration-feature-changes.md`.

The unified orchestration design introduces **1 new feature** (PIPELINE), **2 DSL renames** (DELEGATE->INVOKE, FAN_OUT->PARALLEL), and **zero behavioral changes** to existing constructs. Backward compatibility is maintained throughout.

### New Feature: PIPELINE

Sequential chained agent execution where each stage builds on the prior stage's output. Does not exist today.

**DSL syntax:**

```dsl
PIPELINE:
  - AGENT: Research_Agent
    PURPOSE: "Research the topic"
    INPUT: { topic: user_query }
    USE_RESULT: research_data

  - AGENT: Analysis_Agent
    PURPOSE: "Analyze findings"
    INPUT: { data: research_data, criteria: analysis_criteria }
    USE_RESULT: analysis_result

  - AGENT: Report_Agent
    PURPOSE: "Generate summary"
    INPUT: { analysis: analysis_result }
    USE_RESULT: final_report
```

**Use cases:** Research -> Analysis -> Report generation, Data Extraction -> Validation -> Enrichment, Draft -> Review -> Finalize, any workflow where agents must process results sequentially.

**Runtime behavior:** Stages execute in declared order, each stage is a one-shot INVOKE (no user interaction), each stage's INPUT can reference prior stages' USE_RESULT variables, ON_FAILURE per stage: `stop` | `skip` | `respond`, all intermediate results available to parent after pipeline completes. New system tool: `__pipeline__`. New trace events: `pipeline_start`, `pipeline_stage_complete`, `pipeline_complete`.

### Renames (No Behavioral Change)

#### DELEGATE -> INVOKE

| Aspect          | Before                                | After                             |
| --------------- | ------------------------------------- | --------------------------------- |
| DSL section     | `DELEGATE:`                           | `INVOKE:`                         |
| System tool     | `__delegate__`                        | `__invoke__`                      |
| Runtime handler | `handleDelegate()`                    | `handleInvoke()`                  |
| Session field   | `delegateStack`                       | `invocationStack`                 |
| Trace events    | `delegate_start`, `delegate_complete` | `invoke_start`, `invoke_complete` |
| IR field        | `coordination.delegates`              | `coordination.invocations`        |

**Why rename:** "Invoke" better conveys "ask this agent for a result." Aligns with Google ADK's `AgentTool` and OpenAI's `agent.as_tool()` pattern. "Delegate" implied the parent gives up responsibility, which isn't what happens.

**Backward compat:** Parser accepts both `DELEGATE:` and `INVOKE:`. `DELEGATE:` emits deprecation warning. Runtime accepts both `__delegate__` and `__invoke__` tool calls.

#### FAN_OUT -> PARALLEL

| Aspect          | Before           | After              |
| --------------- | ---------------- | ------------------ |
| System tool     | `__fan_out__`    | `__parallel__`     |
| Runtime handler | `handleFanOut()` | `handleParallel()` |
| Trace events    | `fan_out_*`      | `parallel_*`       |

**Why rename:** "Parallel" is a clearer complement to "Pipeline" (parallel vs sequential). Four constructs now read naturally: HANDOFF, INVOKE, PARALLEL, PIPELINE.

**Backward compat:** Runtime accepts both `__fan_out__` and `__parallel__` tool calls.

### What Does NOT Change

- HANDOFF syntax and all behavior (including RETURN:true, `__return_to_parent__`, thread resume)
- ESCALATE, COMPLETE
- Supervisor routing, Session/thread model
- Remote agent protocol support

### Final Construct Model

| Construct    | Customer reads as                 | Interactive?       | Execution                           |
| ------------ | --------------------------------- | ------------------ | ----------------------------------- |
| **HANDOFF**  | "Transfer the user to this agent" | Yes                | Child takes over conversation       |
| **INVOKE**   | "Ask this agent for a result"     | No (one-shot)      | Parent blocks, gets result back     |
| **PARALLEL** | "Ask multiple agents at once"     | No (one-shot each) | All run concurrently, parent merges |
| **PIPELINE** | "Chain agents in sequence"        | No (one-shot each) | Each builds on prior result         |

### Implementation Phases

| Phase                  | Scope                                                                       | New feature? |
| ---------------------- | --------------------------------------------------------------------------- | ------------ |
| 1: DELEGATE -> INVOKE  | Rename constants, IR, parser, runtime, tests                                | No           |
| 2: PIPELINE            | New DSL section, IR type, compiler, runtime handler, tool injection, tests  | **Yes**      |
| 3: FAN_OUT -> PARALLEL | Rename constants, handler, tool, traces + refactor to use INVOKE internally | No           |
| 4: Deprecation removal | Remove DELEGATE/FAN_OUT backward compat (future release)                    | No           |
