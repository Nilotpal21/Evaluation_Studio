# Building the Agent Blueprint Language (ABL): A Builder's Cookbook

> How I built a declarative language for conversational AI agents — the decisions, dead ends, breakthroughs, and evolving thinking across 35+ sessions with Claude Code.

---

## Chapter 1: The Problem That Started It All

### 1.1 What I was staring at

I had Kore.ai Agent Platform v12 exports — massive JSON blobs with 16+ agents, 29 tools, orchestration prompts stuffed into a single string field. The "configuration" was really prose instructions embedded in JSON:

```json
{
  "agents": [
    {
      "name": "Password Reset Agent",
      "prompt": {
        "custom": "You are an agent that handles password resets. STEP 1 - Validate the user's role. If current role is Holder AND platform is WEB → proceed to STEP 2. STEP 2 - MUST call **generate_otp** with sessionId=... If success → proceed to STEP 3. NEVER skip steps. NEVER change step order. All communication MUST be in Spanish (Ecuadorian)..."
      }
    }
  ]
}
```

The problem was clear: this wasn't configuration, it was hope. You're hoping the LLM reads a 2000-word prose instruction and follows every step, every constraint, every routing rule. There's no validation, no static analysis, no guarantees.

### 1.2 The insight

What if agent behavior was _declared_, not _described_? Not "please follow these steps" but a machine-readable blueprint that can be:

- **Parsed** into an AST
- **Compiled** into an execution plan
- **Validated** before deployment
- **Visualized** as a state machine
- **Debugged** with real-time traces

This is the same insight that drives every DSL: SQL doesn't describe how to query a database, it declares what you want. ABL shouldn't describe how to be an agent, it should declare what the agent _is_.

---

## Chapter 2: Two Modes — The Fork That Defined Everything

### 2.1 The tension I couldn't resolve

Early on, I kept hitting the same wall: some agents need to _think_ (figure out what hotel matches your vague description), while others need to _follow steps_ (walk through an OTP verification flow in exact order). These are fundamentally different execution models.

I tried to force everything into one mode. It was ugly. Reasoning agents don't need a `FLOW` section. Scripted agents don't need open-ended `GATHER` — they collect specific fields at specific steps.

### 2.2 The decision

**Two execution modes sharing common constructs.**

|                 | Reasoning                        | Scripted                    |
| --------------- | -------------------------------- | --------------------------- |
| **Execution**   | LLM decides what to do each turn | Deterministic state machine |
| **Latency**     | ~1000-2000ms (LLM call per turn) | <500ms (pattern matching)   |
| **When to use** | Complex advisory, research       | Voice IVR, forms, OTP flows |
| **LLM usage**   | Full conversation                | Entity extraction only      |

The key insight: TOOLS, MEMORY, CONSTRAINTS, HANDOFF, DELEGATE — these work _identically_ in both execution styles. The style only changes _who decides what happens next_: the LLM or the state machine.

```
# Same tools, same constraints — different execution
# Reasoning-only (no FLOW): LLM decides when to search, what to ask
AGENT: Hotel_Search
GOAL: "Help users find and book hotels"
TOOLS: search_hotels(...)

# Flow-based (has FLOW): Fixed step sequence, deterministic
AGENT: OTP_Verification
GOAL: "Verify user identity via OTP"
FLOW: request_otp -> verify_otp -> authenticated
```

### 2.3 What this unlocked

Once I had two modes, I could stop fighting the language. Reasoning mode got GOAL-driven behavior. Scripted mode got FLOW with explicit transitions. But both shared the same parser, compiler, IR schema, and runtime infrastructure. One language, two execution strategies.

---

## Chapter 3: The Three-Layer Architecture

### 3.1 Why not just interpret the DSL directly?

My first prototype did this — parse ABL, walk the AST at runtime. It worked for simple cases but fell apart because:

1. **No optimization boundary** — you can't cache or pre-compute anything
2. **Runtime and language are coupled** — changing syntax means changing execution
3. **Can't target multiple runtimes** — what about voice? Workflow engines? Code generation?

### 3.2 The compiler insight: steal from LLVM

LLVM solved this exact problem for programming languages: source → IR → target. I did the same:

```
ABL Source (.agent.abl)
     ↓  parseAgentBasedABL()
AST (AgentBasedDocument)
     ↓  compileABLtoIR()
IR (AgentIR / SupervisorIR)  ← 50+ types, framework-agnostic
     ↓
Runtime Executor / Visualizer
```

The IR is the key innovation. It has 50+ types that represent every ABL concept in a normalized, framework-agnostic form. The IR can be:

- **Executed** by the platform runtime
- **Rendered** as a state machine graph
- **Cached** for fast startup
- **Analyzed** for conflicts and gaps

### 3.3 The types came first

I wrote `schema.ts` (2000+ lines of IR types) before writing a single line of compiler code. This is the "design by contract" approach — define the target representation, write tests against it, then implement the compiler. The types _are_ the specification.

---

## Chapter 4: Building the Parser — YAML-ish, Not YAML

### 4.1 Why not just use YAML?

I considered it. YAML would give me free parsing. But:

1. **YAML doesn't know about ABL semantics** — `WHEN:` inside a HANDOFF is different from `WHEN:` inside a FLOW step
2. **YAML's indentation rules are strict and confusing** — agents shouldn't fail because of a tab
3. **ABL has custom syntax** — `search_hotels(dest: string) -> Hotel[]` isn't valid YAML

So I built a custom parser that's _YAML-inspired_ but _domain-aware_. It knows that `TOOLS:` starts a section with function signatures. It knows that `FLOW:` contains step definitions with nested properties.

### 4.2 The section-based approach

The parser reads line by line, looking for top-level section headers:

```
AGENT: → name
GOAL: → objective
PERSONA: → multi-line description
TOOLS: → function signatures
GATHER: → field definitions
FLOW: → step definitions with transitions (presence determines execution style)
CONSTRAINTS: → runtime-checked business and checkpoint rules
GUARDRAILS: → input/output safety checks
HANDOFF: → agent-to-agent routing
...
```

> **Note**: `MODE:` is deprecated. Execution style is derived from FLOW presence — no FLOW means reasoning-only execution, FLOW means flow-based execution.

Each section has its own sub-parser. This was a conscious design choice: sections are independent. You can add a new section without touching any other parser code. When I added GUARDRAILS months after the initial parser, I added `parseGuardrailDefinitions()` and a single `else if` branch in the main loop.

### 4.3 Lesson: parse errors should be warnings, not failures

Early versions threw hard errors on unknown sections. This was terrible for iteration — you couldn't try new syntax without breaking existing files. I changed to a warnings model: unknown sections produce a warning, parsing continues. This lets the language evolve incrementally.

---

## Chapter 5: FLOW Mode — The State Machine That Learned to Be Flexible

### 5.1 The naive first version

```
FLOW:
  step1 -> step2 -> step3

  step1:
    COLLECT: destination
    THEN: step2

  step2:
    CALL: search_hotels(destination)
    THEN: step3
```

Linear. Rigid. Useless for real conversations.

### 5.2 What real conversations taught me

Users don't follow linear paths. They:

- **Provide multiple fields at once** ("I want a hotel in Paris for March 15-20, 2 guests")
- **Correct themselves** ("Actually, make that Denver, not Chicago")
- **Ask tangential questions** ("What's the weather in Paris?")
- **Want to cancel mid-flow** ("Never mind, forget it")
- **Hit retry limits** (OTP verification with 2-attempt max)

Each of these drove a language enhancement:

| User Behavior        | ABL Construct                   | When Added                |
| -------------------- | ------------------------------- | ------------------------- |
| Multi-field input    | `GATHER` within FLOW steps      | Session 8                 |
| Corrections          | `CORRECTIONS: true`             | Session 8                 |
| Tangential questions | `DIGRESSIONS`                   | Session 8                 |
| Cancel/help intents  | `global_digressions`            | Session 8                 |
| Scoped field changes | `SUB_INTENTS`                   | Session 9                 |
| Tool result branches | `ON_SUCCESS` / `ON_FAIL` blocks | Session 10                |
| Entry conditions     | `WHEN` guard on steps           | Session 35 (this session) |
| Retry limits         | `MAX_ATTEMPTS` / `ON_EXHAUSTED` | Session 35 (this session) |

### 5.3 GATHER within FLOW — the hardest design decision

The question was: how do you combine multi-field LLM extraction (GATHER's strength) with deterministic step ordering (FLOW's strength)?

```
collect_trip_info:
  GATHER:
    - destination: required
    - checkin_date: required
    - checkout_date: required
    - num_guests
      default: 2

  CORRECTIONS: true
  COMPLETE_WHEN: destination AND checkin_date AND checkout_date
  THEN: search_hotels
```

The step stays active until `COMPLETE_WHEN` is satisfied. Each user message triggers entity extraction. Fields accumulate. Corrections are detected ("actually Denver not Chicago"). The LLM is only used for extraction, not for deciding what to do next.

This is the hybrid: **LLM intelligence for understanding, state machine determinism for control flow**.

### 5.4 Digressions — exception handling for conversations

The programming analogy is try/catch. Normal flow is the try block. Digressions are catch blocks for specific intents:

```
DIGRESSIONS:
  - INTENT: "weather"
    CALL: get_weather(destination)
    RESPOND: "Weather in {{destination}}: {{forecast}}"
    RESUME: true        # ← Returns to where user left off

  - INTENT: "cancel"
    RESPOND: "Booking cancelled."
    GOTO: welcome       # ← Jumps to a different step
```

`RESUME: true` is the key innovation — the user can ask about weather mid-booking and come back to exactly where they were. Without this, every tangential question would reset the conversation.

---

## Chapter 6: Three Tiers of Safety

### 6.1 The evolution of "don't do bad things"

My first approach was simple: put everything in LIMITATIONS.

```
LIMITATIONS:
  - "Never share PII"
  - "Always validate the user first"
  - "Never skip the OTP step"
```

This doesn't work because limitations are just text in the system prompt. The LLM _might_ follow them. Or it might not. There's no enforcement.

### 6.2 The three-tier model

I realized safety needs _defense in depth_:

**Tier 1: LIMITATIONS** — Embedded in the LLM system prompt. Lightest layer. Good for behavioral guidance, refusals, and scope cues ("be professional", "respond in Spanish"), but not deterministic enforcement.

**Tier 2: CONSTRAINTS** — Runtime-checked business and checkpoint rules. The runtime evaluates the compiled constraint list every turn. Labels such as `booking_rules` help humans organize the rules, while explicit `WHEN` clauses and structural `BEFORE` checkpoints provide the real gating behavior.

```
CONSTRAINTS:
  booking_rules: # label only; runtime gating comes from the rules below
    - REQUIRE user.is_validated == true
      ON_FAIL: "You must verify your identity first."
    - REQUIRE estimated_total <= 5000 BEFORE calling book_hotel
      ON_FAIL: ESCALATE "Exceeds approval limit"
```

**Tier 3: GUARDRAILS** — Input/output inspection. Before the user's message reaches the LLM, check for PII. After the LLM responds, check for leaked sensitive data. These are automated filters.

```
GUARDRAILS:
  ssn_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: redact
```

Each tier catches what the previous one might miss. LIMITATIONS shape behavior and explain boundaries. CONSTRAINTS catch business logic violations. GUARDRAILS catch safety failures in both directions.

---

## Chapter 7: Multi-Agent Coordination — HANDOFF vs. DELEGATE

### 7.1 The two patterns

When agents need to work together, there are exactly two patterns:

**HANDOFF**: Transfer control permanently (or temporarily). Like transferring a phone call. The current agent is done; the target agent takes over.

```
HANDOFF:
  - TO: Billing_Agent
    WHEN: intent contains "payment"
    EXPECT_RETURN: false       # One-way transfer
```

**DELEGATE**: Call a sub-agent, get a result, continue. Like calling a function. The current agent stays in control.

```
DELEGATE:
  - AGENT: Price_Calculator
    WHEN: selected_hotel != null
    INPUT: {hotel: selected_hotel, nights: num_nights}
    RETURNS: {final_price: estimated_total}
    USE_RESULT: "Show pricing to user"
```

### 7.2 The supervisor pattern

For routing multiple agents, the `SUPERVISOR` keyword designates an agent as the entry-point router. Under the hood, supervisors are just agents with routing configuration — the same `AgentIR` type with `routing` and `available_agents` fields populated:

```
SUPERVISOR: Orchestrator

HANDOFF:
  - TO: Auth_Agent
    WHEN: user.validated == false
    PRIORITY: 0              # ← Evaluated first
    EXPECT_RETURN: true

  - TO: Billing_Agent
    WHEN: intent contains "payment"
    PRIORITY: 2
    EXPECT_RETURN: false
```

The unified design means all agents (including supervisors) live in a single registry. This unlocks **hierarchical composition** — a supervisor can hand off to another supervisor, which routes to leaf agents:

```
Travel_Supervisor → Hotel_Supervisor → Hotel_Search_Agent
                  → Flight_Agent
```

Runtime detects supervisors by config presence (`ir.routing?.rules?.length > 0`), not by type checks. The `PRIORITY` field controls evaluation order — without it, order depended on file position, which was fragile.

### 7.3 Context passing

The hardest part of multi-agent wasn't routing — it was context. When you hand off to another agent, what does it know? The `CONTEXT` block solved this:

```
HANDOFF:
  - TO: Billing_Agent
    WHEN: intent contains "payment"
    CONTEXT:
      pass: [user_id, booking_id, auth_token]
      summary: "User authenticated, wants to pay for booking {{booking_id}}"
    EXPECT_RETURN: true
    ON_RETURN:
      action: continue
```

The `summary` field is interpolated at handoff time — the target agent gets a natural language briefing of why it was called.

---

## Chapter 8: The MCP Integration — Making Claude Code the IDE

### 8.1 The debugging problem

I had agents defined in ABL, compiled to IR, executing at runtime. But when something went wrong, I was staring at JSON traces trying to figure out why the agent took the wrong path. Traditional debugging tools don't understand conversational AI.

### 8.2 The MCP debug server

I built an MCP server that gives Claude Code 15 debugging tools:

```
debug_connect          → Connect to running platform
debug_load_agent       → Load and start a session
debug_send_message     → Send user messages
debug_get_recent_traces → See what happened
debug_get_span_tree    → Hierarchical execution view
debug_explain_decision → Why did it make that choice?
debug_analyze_session  → Automated diagnostics
```

The breakthrough was `debug_analyze_session` — it automatically detects loops, errors, constraint violations, and tool failures, then suggests fixes. Instead of me reading traces, Claude reads them and tells me what's wrong.

### 8.3 The architect tools — from natural language to agents

The next evolution was asking: can Claude _design_ agents, not just debug them?

```
kore_architect_analyze   → "I need a hotel booking system" → architecture spec
kore_architect_generate  → spec → ABL files
kore_architect_scaffold  → project structure with docs
kore_architect_validate  → syntax checking
```

And the import pipeline:

```
kore_import_analyze  → Detect format (Agent Platform v12 / XO11)
kore_import_convert  → Generate ABL from Kore.ai exports
```

This closed the loop: design agents with Claude, debug them with Claude, import legacy systems with Claude. The language is the common ground.

---

## Chapter 9: The Import Problem — Structure from Chaos

### 9.1 What I was importing

Saludsa (health insurance) had 16 agents with prompts like:

```
**STEP 1 - Applicable Roles Validation (MANDATORY):**
●  If current role is Holder AND platform is WEB → proceed to STEP 2
●  If current role is Beneficiary → proceed to STEP 3

**STEP 2 - OTP Validation:**
●  MUST call **generate_otp** with: sessionId={{memory.sessionMeta...}}
●  Maximum 2 attempts. If exceeded → transfer to SAC
```

Plus orchestration:

```
## LEVEL 0: PRIORITY TRANSFER
If priorityTransfer is PCA, XPR → route to PCA_Transfer

## LEVEL 1: VALIDATION GATES
IF channel is whatsapp AND isUserValidated IS NOT true → Route to validation agent
```

### 9.2 The naive import

My first converter dumped everything into LIMITATIONS:

```
LIMITATIONS:
  - "STEP 1 - Applicable Roles Validation (MANDATORY): If current role is..."
  - "STEP 2 - OTP Validation: MUST call generate_otp with sessionId=..."
  - "NEVER skip steps"
  - "All communication MUST be in Spanish (Ecuadorian)"
```

This was technically correct but defeated the entire purpose of ABL. The structure was in the prompt — I was throwing it away.

### 9.3 The structured extraction approach (this session)

The key insight: these prompts have **patterns** that can be parsed with regex:

| Prompt Pattern                         | ABL Construct    | Regex                            |
| -------------------------------------- | ---------------- | -------------------------------- |
| `**STEP N - Title**`                   | FLOW step        | `STEP\s+(\d+)\s*[-–:]\s*(.+)`    |
| `MUST call **toolName**`               | CALL             | `call\s+\*\*"?([^"*]+)"?\*\*`    |
| `proceed to STEP N`                    | THEN transition  | `proceed\s+to\s+STEP\s+(\d+)`    |
| `NEVER...` / `MUST NOT...`             | CONSTRAINTS      | `^(never\|must not\|do not)`     |
| `ONLY if channel is...`                | GUARDRAILS       | `only\s+if.*channel`             |
| `## LEVEL N:`                          | HANDOFF PRIORITY | `LEVEL\s+(\d+)\s*:`              |
| `{{memory.X.Y}}`                       | MEMORY           | `\{\{memory\.([^}]+)\}\}`        |
| `all communication MUST be in Spanish` | LANGUAGE         | `communication.*be\s+in\s+(\w+)` |

Now the converter produces:

```
AGENT: Password_Reset

# Execution style derived from FLOW presence
LANGUAGE: es-EC              # ← Detected from "Spanish (Ecuadorian)"

FLOW:
  validate_role -> otp_validation -> password_reset

  validate_role:
    WHEN: user.role == "Holder" AND channel in ["WEB", "ANDROID"]
    CALL: validate_role(session_id)
    THEN: otp_validation

  otp_validation:
    CALL: generate_otp(session_id)
    MAX_ATTEMPTS: 2
    ON_EXHAUSTED: transfer_sac
    THEN: password_reset

CONSTRAINTS:
  always:
    - REQUIRE current_step_index <= last_completed_step_index + 1
      ON_FAIL: "Continue with the next required step in the reset flow."
    - REQUIRE flow_locked == false
      ON_FAIL: "Keep the scripted recovery sequence intact."
```

### 9.4 What drove the language enhancements

The import problem _forced_ four new ABL features:

1. **HANDOFF PRIORITY** — because Saludsa's LEVEL 0-4 routing has strict evaluation order
2. **Flow step WHEN guard** — because steps have entry conditions ("only if role is Holder AND channel is WEB")
3. **MAX_ATTEMPTS / ON_EXHAUSTED** — because OTP has a 2-attempt limit, the most common pattern
4. **LANGUAGE directive** — because "all communication MUST be in Spanish (Ecuadorian)" is enterprise-standard

Each enhancement was motivated by a real pattern I kept seeing in production prompts. The language grows from the bottom up, driven by what real agents actually need.

---

## Chapter 10: The Naming Evolution — DSL to ABL

### 10.1 Why rename?

"DSL" is generic. Every configuration format is a DSL. When I started talking to people about the project, "agent DSL" meant nothing — they assumed it was JSON config or YAML templates.

"Agent Blueprint Language" communicates:

- **Blueprint** — it's a plan, a design document, not just configuration
- **Language** — it has syntax, semantics, a parser, a compiler
- **Agent** — it's specifically for conversational AI agents

### 10.2 The rename scope

This wasn't cosmetic. It touched:

- 70+ source files (imports, package names, type names)
- All documentation
- Package names: `@agent-dsl/core` → `@abl/core`
- App names: `test-server` → `platform`, `test-ui` → `studio`
- File extensions: `.agent.dsl` → `.agent.abl`
- Function names: `parseAgentBasedDSL` → `parseAgentBasedABL`

Split into two namespaces:

- **`@abl/*`** — Language packages (core, compiler, analyzer, editor)
- **`@agent-platform/*`** — Runtime packages (server, studio, observatory, CLI)

### 10.3 The lesson

Name things early and name them well. The rename cost me 6 commits across 2 sessions. If I'd started with ABL, that's 6 commits I'd have for features.

---

## Chapter 11: The Observatory — Debugging Conversational AI

### 11.1 The visualization insight

Agents are state machines. Even reasoning mode agents have implicit states: "gathering information", "calling tools", "formulating response". If you can visualize these states with real-time execution highlighting, debugging becomes intuitive.

### 11.2 What I built

**State Machine View** — Dagre.js graph with:

- Nodes for each FLOW step (scripted) or tool/decision (reasoning)
- Edges for transitions (THEN, ON_FAIL, ON_INPUT)
- Real-time highlighting of the current step
- Execution heatmap showing where time is spent

**Span Tree** — Hierarchical timing like a profiler:

```
session_start (0ms)
  ├─ flow_step: welcome (12ms)
  ├─ flow_step: collect_info (3400ms)
  │   ├─ llm_call: extract_entities (820ms)
  │   └─ dsl_collect: destination = "Paris" (0ms)
  ├─ flow_step: search (1200ms)
  │   └─ tool_call: search_hotels (1180ms)
  └─ flow_step: present (15ms)
```

**Session Timeline** — Metrics dashboard showing latency, token usage, volley count.

### 11.3 The trace event system

22+ event types, emitted in real-time over WebSocket:

```
flow_step_enter/exit    — State machine transitions
llm_call               — LLM invocation with tokens, latency, stop reason
tool_call              — Tool execution with inputs/outputs
dsl_collect/gather     — Data collection events
entity_extraction      — What the LLM/regex extracted
constraint_check       — Validation results
handoff/delegate       — Inter-agent coordination
error/escalation       — Failures and human transfers
```

The key design decision: **server-side span management**. The server maintains the span stack and assigns parent IDs. The client just renders. This prevents impossible states like orphaned spans or incorrect nesting.

---

## Chapter 12: Testing Strategy — 613 Tests Without Going Broke

### 12.1 The LLM testing problem

E2E tests with real LLM calls are:

- **Slow** (~2s per call)
- **Expensive** ($0.003-0.015 per call)
- **Non-deterministic** (LLM responses vary)
- **Fragile** (API outages break CI)

### 12.2 The solution: cache everything

I built an LLM response cache with 1555 entries. Once a test runs with a real API key, the response is cached. Subsequent runs use the cache — 100% hit rate, zero API cost, deterministic results.

```
Total: 613 passing tests
- 67 core (parser, expressions, lexer) — No LLM, pure parsing
- 279 compiler (IR, graph extraction) — No LLM, pure compilation
- 156 runtime (entity extraction, condition evaluation, flows) — Cached LLM
- 111 CLI (architect, import, validate) — No LLM, local tools
- 32 skipped (require ANTHROPIC_API_KEY for first run)
```

### 12.3 The test pyramid

```
      /  32  \     E2E with real LLM (skippable)
     /  156   \    Runtime with cached LLM
    /   279    \   Compiler (pure transformation)
   /  67 + 111  \  Parser + CLI (pure parsing/generation)
```

Bottom-heavy pyramid. Most tests are fast, deterministic, and free. Only the top 32 need an API key, and even those are cached after first run.

---

## Chapter 13: The Enterprise Dimension

### 13.1 What Saludsa taught me

Saludsa is a real health insurance company in Ecuador. Their agent platform has:

- 16 specialized agents (password reset, refunds, payments, claims...)
- Multi-channel (web, WhatsApp, Android, iOS)
- Multi-role (Holder, Beneficiary, Provider)
- All communication in Ecuadorian Spanish
- PII masking requirements
- Strict step ordering with attempt limits

This is _not_ a demo. This is enterprise conversational AI with real compliance requirements. Building ABL for Saludsa forced me to think about things I'd never considered in a demo:

- **Language directives** — "respond in Spanish" can't be a LIMITATION, it needs to be a first-class directive
- **Channel guards** — "execute ONLY if channel is whatsapp" is a GUARDRAIL, not a CONSTRAINT
- **PII masking** — "STRICTLY make sure emailId and phoneNumber are masked" needs output guardrails
- **Attempt limits** — OTP with 2 tries needs MAX_ATTEMPTS, not a manual counter

### 13.2 The gap detection system

When importing Saludsa, I needed to know: what _can't_ ABL express? I built a gap detection system with 21 known gaps:

```
11 ABL gaps     (no loops, no HTTP, no timers, no file upload...)
8  AgentPlatform gaps (JS processors, voice config, PII masking...)
2  XO11 gaps    (script nodes, rich UX...)
```

Each gap has:

- **Severity**: minor (-3%), moderate (-8%), significant (-15%)
- **Alternatives**: workarounds in ABL
- **Coverage score**: `100% - sum(gap weights)`

This isn't just documentation — it's built into the import pipeline. When you import a Kore.ai export, the gap report tells you exactly what won't convert cleanly and what to do about it.

---

## Chapter 14: The Thinking Behind Tool-Assisted Development

### 14.1 Claude Code as IDE

The entire development workflow is designed around Claude Code:

1. **Design phase**: Use `kore_architect_analyze` to go from natural language use case to architecture spec
2. **Generate phase**: Use `kore_architect_generate` to produce ABL files from the spec
3. **Import phase**: Use `kore_import_convert` to migrate from existing platforms
4. **Debug phase**: Use `debug_load_agent` + `debug_send_message` to test interactively
5. **Diagnose phase**: Use `debug_analyze_session` for automated issue detection

### 14.2 Why MCP instead of a traditional CLI?

A traditional CLI gives you command-line output. MCP gives you a _conversation partner_ that understands the domain. When I ask Claude Code to "analyze this session for issues", it doesn't just dump traces — it reads them, identifies patterns (loops, failures, constraint violations), and suggests fixes in ABL syntax.

The embedded documentation (`debug_get_docs`, `debug_search_docs`) means Claude Code always has the ABL spec available. It can answer "how do I add a guardrail for PII?" by searching the docs and generating correct syntax.

### 14.3 The local vs. remote split

MCP tools are split into two categories:

- **LOCAL** (no auth): Architect, import, validate, docs — work offline, no platform needed
- **REMOTE** (auth required): Sessions, projects, traces — need a running platform

This was deliberate. You should be able to design and generate ABL files without deploying anything. The platform is for runtime testing and debugging.

---

## Chapter 15: What I'd Do Differently

### 15.1 Start with the IR, not the parser

I wrote the parser first, then the IR, then the compiler. The IR should come first because it defines what the language _means_. The parser just defines what it _looks like_. Starting with the IR forces you to think about semantics before syntax.

### 15.2 Name things right from day one

The DSL → ABL rename cost 6 commits. The test-server → platform and test-ui → studio renames cost more. Pick good names early.

### 15.3 Build the import pipeline earlier

I built the import pipeline in the last few sessions. I should have built it much earlier — real enterprise data (Saludsa) revealed patterns I never would have designed for in isolation. The STEP sequences, LEVEL routing, attempt limits, language directives — all came from staring at real prompts.

### 15.4 GUARDRAILS execution

I designed the GUARDRAILS syntax and parser, wrote 13 tests, compiled them to IR — but never wired the runtime execution. This is the right order (API first, execution later), but I should have closed the loop sooner. Parsed-but-not-executed safety features create a false sense of security.

---

## Chapter 16: The Current State

### 16.1 What exists

| Component            | Status              | Tests           |
| -------------------- | ------------------- | --------------- |
| ABL Parser           | Complete            | 67              |
| ABL Compiler → IR    | Complete            | 279             |
| Runtime Executor     | ~90% complete       | 156             |
| Observatory UI       | Complete            | —               |
| MCP Debug Server     | Complete (15 tools) | 58              |
| MCP Architect/Import | Complete (7 tools)  | 111             |
| CLI                  | Complete            | —               |
| Total                |                     | **613 passing** |

### 16.2 ABL language constructs

17 top-level sections, all parsed and compiled:

```
AGENT / SUPERVISOR    — Declaration
MODE                  — reasoning or scripted
LANGUAGE              — Locale directive (es-EC, en-US...)
GOAL                  — Objective
PERSONA               — Character/tone
LIMITATIONS           — Behavioral boundaries
TOOLS                 — External function calls
GATHER                — Information collection
MEMORY                — Session/persistent state
CONSTRAINTS           — Runtime business and checkpoint rules
GUARDRAILS            — Input/output safety filters
FLOW                  — State machine (scripted mode)
DELEGATE              — Sub-agent invocation
HANDOFF               — Agent-to-agent transfer
ESCALATE              — Human transfer
ON_START              — Initialization
ON_ERROR              — Error handling
COMPLETE              — Completion conditions
```

### 16.3 What's next

1. **Guardrails runtime execution** — Wire the parsed/compiled guardrails into actual input/output filtering
2. **Persistent memory** — Cross-session state with vector DB
3. **Multi-tenancy** — Account isolation, RBAC, workspace scoping
4. **Real tool integration** — Replace mocks with actual API calls
5. **Voice runtime** — Low-latency scripted mode for telephony

---

## Appendix: Session Timeline

| Session Range | Major Work                                                  | Key Decisions                                                    |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| 1-3           | Early prototyping, execution patterns                       | Decided to build a DSL with native runtime execution             |
| 4-6           | Parser, compiler, IR schema                                 | Three-layer architecture (DSL → IR → Runtime)                    |
| 7             | Visual test UI, WebSocket integration                       | Real-time debugging is essential                                 |
| 8-9           | Enhanced FLOW: GATHER, digressions, sub-intents             | Scripted mode needs flexibility escape hatches                   |
| 10-11         | DELEGATE, COMPLETE, CONSTRAINTS runtime                     | Multi-agent coordination is the hard problem                     |
| 12-13         | Agent Observatory, tracing architecture                     | 22+ event types, span hierarchy, real-time streaming             |
| 14-15         | Static graph extraction, visualization                      | Agents are state machines — visualize them                       |
| 16-17         | MCP debug server (15 tools)                                 | Claude Code becomes the IDE                                      |
| 18-20         | Auth, projects, dashboard, security                         | Production readiness: JWT, OAuth, audit logging                  |
| 21-23         | GUARDRAILS spec, comprehensive testing                      | Three-tier safety: LIMITATIONS < CONSTRAINTS < GUARDRAILS        |
| 24-26         | DSL → ABL rename, package restructuring                     | Names matter: @abl/_ for language, @agent-platform/_ for runtime |
| 27-28         | Enterprise roadmap, tech stack planning                     | MongoDB + ClickHouse + PostgreSQL for different workloads        |
| 29-30         | ABLGenerator, templates                                     | Generate ABL from specs, scaffolding                             |
| 31-33         | Architect + Import MCP tools (7 tools, 111 tests)           | Design agents with Claude, import from Kore.ai                   |
| 34-35         | Enhanced extraction, PRIORITY, WHEN, MAX_ATTEMPTS, LANGUAGE | Real enterprise data (Saludsa) drives language evolution         |
