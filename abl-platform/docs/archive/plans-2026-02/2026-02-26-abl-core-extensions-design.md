# ABL Core + Extensions Architecture — Design Document

**Date**: 2026-02-26 (updated 2026-02-27)
**Status**: Draft
**Authors**: Platform Architecture Team

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Competitive Landscape](#2-competitive-landscape)
3. [What ABL Solves That Competitors Cannot](#3-what-abl-solves-that-competitors-cannot)
4. [Current ABL Architecture: Functional Decomposition](#4-current-abl-architecture-functional-decomposition)
5. [Proposed Solution: Core + Extensions](#5-proposed-solution-core--extensions)
   - 5.1 ABL Core (YAML + CEL + Handlebars)
   - 5.2 Extension: Gather (Structured Information Collection)
   - 5.3 Extension: Constraints (Rule Enforcement)
   - 5.4 Extension: Scripted Flows (Deterministic Execution)
   - 5.5 Extension: Memory (Persistent Cross-Session State)
   - 5.6 Extension: Coordination (Multi-Agent)
   - 5.7 Extension: Rich Content (Multi-Format Output)
6. [Standards Adoption: YAML, CEL, and Handlebars](#6-standards-adoption-yaml-cel-and-handlebars)
7. [Python and TypeScript Builder SDKs](#7-python-and-typescript-builder-sdks)
8. [IR as the Portable Artifact](#8-ir-as-the-portable-artifact)
9. [Why the Compiler Must Stay](#9-why-the-compiler-must-stay)
10. [Dependency Graph and Progressive Adoption](#10-dependency-graph-and-progressive-adoption)
11. [Risks and Mitigations](#11-risks-and-mitigations)
12. [Phased Rollout](#12-phased-rollout)

---

## 1. Problem Statement

ABL (Agent Blueprint Language) is a proprietary DSL with 78 token types, 70 AST node types, and 97 IR interfaces. It powers a compiler pipeline (DSL → tokens → AST → IR) across ~10,600 lines of compiler code. This machinery enables the richest declarative agent definition in the market — supporting scripted flows, structured information gathering, constraint enforcement, multi-agent coordination, and hybrid reasoning — capabilities no competitor offers.

However, this richness creates three adoption challenges:

### 1.1 Surface Area Perception

A developer encountering ABL for the first time sees 78 token types, uppercase keywords, custom expression syntax, and a compilation pipeline. Even when building a simple reasoning agent (which uses ~15 tokens), the language reference documents all 78. The perceived complexity is far larger than the actual complexity for any given use case.

For comparison: a simple reasoning agent with 3 tools is ~30-50 lines of ABL. The same agent in CrewAI YAML is ~20 lines. The ABL agent is not meaningfully more complex, but it exists within a language that _also_ defines scripted flows, gather strategies, constraint evaluation, and multi-agent coordination — and the documentation, tooling, and onboarding expose all of this simultaneously.

### 1.2 Vendor Lock-In Risk

ABL is parsed by a custom recursive-descent parser, compiled by a custom compiler, and executed by a custom runtime. There is no third-party tooling, no community ecosystem, and no migration path to another platform. Enterprises evaluating ABL face legitimate concerns:

- **Non-portable skills**: ABL specialization is needed to author and maintain agents. This knowledge does not transfer to other platforms.
- **Proprietary toolchain dependency**: The parser, compiler, and runtime are tightly coupled. There is no way to use ABL definitions outside the Kore.ai ecosystem.
- **No interoperability with industry tooling**: Standard YAML/JSON editors, linters, and schema validators cannot process ABL syntax directly.

This is not a hypothetical concern. At Kony (a previous enterprise platform company), a proprietary Lua-based DSL for mobile app development faced the same resistance. Despite offering full code generation and visual tooling, large enterprises resisted adoption, and the company underwent a painful migration from Lua DSL to standardized JavaScript flows. The pattern is well-established: enterprises will trade expressiveness for portability when they perceive lock-in risk.

### 1.3 Missing Programmatic Access

Python and TypeScript are the dominant languages in the AI/ML ecosystem. Every major agent platform (LangChain, CrewAI, AutoGen, Semantic Kernel, AWS Bedrock) provides Python and/or TypeScript SDKs as the primary authoring interface. Enterprises with in-house AI teams expect to:

- Programmatically define agents, workflows, and orchestrations using familiar languages
- Integrate with ML libraries, data pipelines, and notebooks
- Leverage existing Python/TS libraries for custom logic while programming the platform via SDKs
- Extend platform capabilities with custom orchestration logic

The absence of Python/TS SDKs is a material gap that limits adoption among technical enterprises, particularly those operating in heterogeneous environments with multiple AI frameworks.

---

## 2. Competitive Landscape

The following analysis covers the five most relevant platforms in the declarative agent space. The comparison focuses on what each can and cannot express declaratively.

### 2.1 Decagon AOPs (Actions on Pages)

**Format**: Natural language procedures configured through a proprietary UI. No public schema, no version-controllable format.

**Strengths**: Accessible to non-technical users. LLM-driven execution with transparent decision tracing. Built-in guardrails for sensitive operations.

**Limitations**: No scripted flows (all LLM-driven). No structured gather with validation. No formal constraint language — guardrails are natural language suggestions, not deterministic enforcement. No multi-agent coordination primitives. No programmable definition format — cannot be diffed, compiled, or analyzed statically.

### 2.2 n8n

**Format**: JSON workflow graphs (DAG of nodes with connections).

**Strengths**: 400+ integrations. Arbitrary workflow DAGs with branching, merging, loops. LangChain-powered AI Agent node. Session memory via Redis/Postgres.

**Limitations**: Not conversational — workflow nodes process data, not multi-turn dialogues. No agent persona, goal, or behavioral definition. No structured gather states. No constraint enforcement. No multi-agent coordination. AI capabilities are bolted onto a general-purpose automation platform.

### 2.3 CrewAI

**Format**: YAML (two files: `agents.yaml` + `tasks.yaml`) plus Python glue code.

**Strengths**: Clean agent persona definition (role, goal, backstory). Task dependencies. Sequential and hierarchical orchestration. Human-in-the-loop review.

**Limitations**: Task-oriented, not conversation-oriented — no multi-turn dialogue states. YAML covers only persona; tools, LLM selection, and orchestration require Python. No structured gather, no constraint language, no conversational state management. Limited multi-agent coordination (manager-delegated only).

### 2.4 Microsoft Agent Framework (AutoGen + Semantic Kernel)

**Format**: Minimal YAML for single-agent identity. JSON serialization for teams. Python/C# for all orchestration.

**Strengths**: Richest multi-agent orchestration patterns (group chat with customizable speaker selection, handoffs, sequential, concurrent). Checkpointing for long-running processes. MCP tool integration.

**Limitations**: Declarative YAML covers only agent name, instructions, and model config. All team composition, orchestration, termination conditions, and handoffs require imperative code. No scripted flows, no gather, no constraint language. Tool serialization not yet supported in declarative format.

### 2.5 AWS Bedrock Agents

**Format**: CloudFormation YAML/JSON. OpenAPI 3.0 schemas for action groups.

**Strengths**: Most infrastructure-complete platform — IaC definitions, content-filter guardrails, knowledge bases, tracing, memory, supervisor/collaborator patterns. Full CloudFormation/CDK/Terraform support.

**Limitations**: Behavior is fully LLM-driven — no scripted flows, no explicit transitions. OpenAPI schemas define APIs but not conversational flows. Guardrails are content filters (toxicity, prompt attacks), not behavioral constraints. Multi-agent coordination is supervisor-only (no peer-to-peer handoff, no dynamic routing). No structured conversational state management.

### 2.6 Summary

| Capability                        | Decagon | n8n          | CrewAI     | MS AutoGen       | Bedrock         | **ABL**               |
| --------------------------------- | ------- | ------------ | ---------- | ---------------- | --------------- | --------------------- |
| Scripted conversational flows     | No      | No           | No         | No               | No              | **Yes**               |
| Structured gather with validation | No      | No           | No         | No               | Partial         | **Yes**               |
| Formal constraint enforcement     | No      | No           | No         | No               | Content filters | **Yes**               |
| Hybrid scripted + reasoning       | No      | No           | No         | No               | No              | **Yes**               |
| Multi-agent coordination          | No      | No           | Limited    | Rich (code-only) | Supervisor only | **Yes (declarative)** |
| Conversational state management   | Opaque  | Unstructured | No         | Limited          | Unstructured    | **Yes (typed)**       |
| Compile-time validation           | No      | No           | No         | No               | No              | **Yes**               |
| YAML/JSON-compliant format        | N/A     | Yes (JSON)   | Yes (YAML) | Partial          | Yes (CFN)       | **No**                |
| Standard expression language      | N/A     | JS           | Python     | Python/C#        | N/A             | **No (custom)**       |
| Python/TS SDK                     | N/A     | JS           | Yes        | Yes              | Yes (boto3)     | **No**                |

The bottom three rows are ABL's gaps. The top seven rows are ABL's advantages. The goal is to close the gaps without sacrificing the advantages.

---

## 3. What ABL Solves That Competitors Cannot

ABL's competitive differentiation is not its syntax — it is the **four capabilities** that no other platform offers declaratively. Any architectural change must preserve these.

### 3.1 Structured Information Gathering with Validation

ABL defines typed fields (string, number, date, enum, array) with extraction hints, validation rules (pattern, range, enum, custom, LLM-based), activation strategies (required, optional, progressive, data-driven), correction patterns, and cross-field dependencies.

This is essential for regulated industries. A claim filing agent that gathers 15 fields with date range validation, enum constraints, and required-field enforcement cannot be built on any competitor platform. The LLM can approximate it, but without guaranteed validation, audit trails, or progress tracking.

### 3.2 Declarative Constraint Enforcement

ABL constraints are formal conditions evaluated by a deterministic engine **separate from the LLM**. They support configurable actions on violation (respond, escalate, handoff, block, redact), guard semantics (conditions that are "not applicable" when prerequisites are unmet), and full tracing of which constraint fired, when, and why.

Competitors rely on natural language instructions to the LLM or content-filter guardrails. There is no **guarantee** of enforcement. ABL's constraints are deterministic — the LLM cannot override them.

### 3.3 Hybrid Scripted + Reasoning Execution

ABL is the only platform that can express: "Follow these exact 5 steps in this order, but within step 3, use the LLM to extract 4 fields from natural language and validate them against business rules."

Every competitor is either fully deterministic (n8n workflow DAG — not conversational) or fully LLM-driven (everything else). ABL uniquely supports both in the same definition, with scripted flows providing determinism and the LLM providing flexibility within each step.

### 3.4 Conversational State Management

ABL provides typed session variables (SET/CLEAR), persistent memory across sessions (per-user), remember/recall triggers (automatic memory persistence), and state that survives across agent handoffs with configurable history strategies (none, summary_only, full, last_n).

Competitors offer either opaque platform-managed state (Decagon) or unstructured key-value session memory (n8n, Bedrock). None provide typed state with lifecycle management and cross-agent continuity.

---

## 4. Current ABL Architecture: Functional Decomposition

The 78 tokens serve six cross-cutting functional systems. Understanding this decomposition is essential to the proposed solution.

### 4.1 Expression Engine (~20 tokens)

**Tokens**: `==`, `!=`, `>`, `<`, `>=`, `<=`, `AND`, `OR`, `NOT`, `IN`, `CONTAINS`, `MATCHES`, `IS`, `SET`, `LParen`, `RParen`, `True`, `False`, `Null`, `NumberLiteral`

**Built-in functions**: ~30 pure functions — `ADD`, `SUB`, `MUL`, `DIV`, `ROUND`, `UPPER`, `LOWER`, `TRIM`, `LENGTH`, `FORMAT_CURRENCY`, `MASK`, `COALESCE`, `NOW`, etc.

**Consumers**: Constraints (condition evaluation), flow branching (ON_INPUT/ON_SUCCESS/ON_FAIL), gather validation (field-level rules), completion conditions (WHEN), routing rules (handoff/delegate conditions), SET assignments (right-hand-side resolution), template `{{#if}}` blocks, guardrail checks.

This is the most cross-cutting system. Every feature that evaluates a condition, interpolates a template, or computes a derived value depends on it. This universal dependency is why expressions belong in Core rather than as a separate extension (see Section 5.1).

### 4.2 Information Gathering (~8 tokens)

**Tokens**: Gather-related identifiers, type keywords (`StringType`, `NumberType`, `DateType`, `BooleanType`, `DatetimeType`, `ArrayType`, `EnumType`), `Question`

**Consumers**: Both execution modes. Reasoning agents gather via LLM extraction; scripted agents gather via step-level collection. Both need typed fields, validation rules, prompts, extraction hints, activation strategies, and correction patterns.

### 4.3 State Management (~5 tokens)

**Tokens**: `Assignment` (for SET), identifiers (for CLEAR), `Dot` (path navigation), `LBracket`/`RBracket` (array access)

**Consumers**: Both modes. Session context mutation, memory reads/writes, variable assignment, computed values. SET and CLEAR operate on `session.data.values` at runtime.

Basic state mutation (SET/CLEAR) is fundamental to both modes and belongs in Core. Persistent cross-session memory (MEMORY section, remember/recall triggers) is an advanced capability that belongs in an extension (see Section 5.5).

### 4.4 Message Templating (~4 tokens)

**Tokens**: `StringLiteral`, `LBrace`/`RBrace` (template delimiters), interpolation syntax

**Consumers**: Both modes. RESPOND messages, voice configs, rich content (MARKDOWN, HTML, VOICE), tool parameter injection, action elements. Supports simple `{{var}}` substitution, Handlebars blocks (`{{#each}}`, `{{#if}}`), and fallback syntax (`${var|default}`).

### 4.5 Multi-Agent Coordination (~6 tokens)

**Tokens**: Identifiers and keywords for handoff/delegate/escalate, routing conditions, `Arrow`/`FatArrow`

**Consumers**: Both modes. Supervisor routing, agent-to-agent handoff with history strategies, delegation with context passing, escalation triggers with priority levels.

### 4.6 Scripted Flow Control (~10 tokens)

**Tokens**: Flow-related identifiers, step references, transition keywords (THEN, GOTO), branch keywords (ON_INPUT, ON_SUCCESS, ON_FAIL), action keywords (CALL, RESPOND, SIGNAL, CLASSIFY), `StepNumber`

**Consumers**: Scripted mode only. This is the only genuinely mode-specific token group — approximately 10-12 tokens out of 78.

### 4.7 Structural Syntax (~25 tokens)

**Tokens**: Section headers (AGENT, SUPERVISOR, TOOLS, CONSTRAINTS, etc.), `Colon`, `Comma`, `Pipe`, `Comment`, `WhiteSpace`, `NewLine`, `Identifier`, `At`, `Asterisk`

**Consumers**: Everything. These are grammar scaffolding, not feature-specific.

### 4.8 Key Insight

The 78 tokens are not "mostly for scripted flows." They serve six independent functional systems, most of which apply to both execution modes. A reasoning agent with sophisticated gather fields, validation rules, constraint handlers, state management, and multi-agent coordination can easily touch 40+ token types.

The question is not "how do we reduce the token count?" — it is "how do we ensure developers only encounter the tokens relevant to their use case?" And for the expression engine specifically: rather than reducing it, we should replace the custom syntax with an industry-standard expression language (CEL) so that expression knowledge is portable and tooling is reusable.

---

## 5. Proposed Solution: Core + Extensions

Reorganize ABL into a substantial core built on three industry standards (YAML, CEL, Handlebars) and six opt-in extensions. Each extension is a cohesive functional capability that can be adopted independently as the agent's requirements grow.

### 5.1 ABL Core (YAML + CEL + Handlebars)

**What it covers**: Agent identity, tool declarations, basic response, basic completion, CEL expressions, Handlebars templates, basic state management (SET/CLEAR).

**Standards used**:

- **YAML** for document structure — any YAML parser can load an ABL file
- **CEL (Common Expression Language)** for all conditional logic — the same expression language used in Kubernetes, Firebase, and Envoy
- **Handlebars** for message templates — widely adopted template engine with JS and Python implementations

**Approximate token count visible to authors**: ~20

**Definition surface**:

```yaml
agent: ClaimAssistant
mode: reasoning
goal: 'Help customers file insurance claims'
persona: |
  Professional and empathetic claims specialist.
  Always verify information before proceeding.
tools:
  - name: lookup_policy
    description: "Look up a customer's insurance policy by policy number"
    type: http
    parameters:
      - name: policy_number
        type: string
        required: true
    returns:
      type: object
  - name: file_claim
    description: 'File a new insurance claim'
    type: http
    parameters:
      - name: policy_id
        type: string
        required: true
      - name: incident_type
        type: string
        required: true
      - name: description
        type: string
        required: true
    returns:
      type: object
complete:
  - when: 'claim_filed == true'
    respond: 'Your claim {{claim_id}} has been filed successfully.'
set:
  - "greeting = 'Hello, ' + customer_name"
```

This is comparable in surface area to a CrewAI YAML agent or an AWS Bedrock agent definition. A developer building a simple chatbot uses only Core. The key difference from the previous proposal: expressions (CEL) and basic state (SET/CLEAR) are part of Core because they are foundational capabilities used by every extension. Since CEL is an industry standard, including it in Core does not add proprietary complexity — it adds portable, transferable skills.

**What Core includes that was previously in extensions**:

| Capability              | Rationale for inclusion in Core                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- |
| CEL expressions         | Every extension depends on expressions. CEL is a standard — not proprietary complexity. |
| Basic state (SET/CLEAR) | Fundamental to both modes. Even simple agents store computed values.                    |
| Handlebars templates    | Message interpolation is needed by every agent that responds to users.                  |

**What Core does NOT include** (these remain in extensions):

- Typed gather fields with validation and extraction (Gather extension)
- Deterministic constraint enforcement (Constraints extension)
- Step-by-step flow control (Scripted Flows extension)
- Persistent cross-session memory with remember/recall triggers (Memory extension)
- Multi-agent handoff, delegation, supervision (Coordination extension)
- Multi-format output, voice, interactive elements (Rich Content extension)

### 5.2 Extension: Gather (Structured Information Collection)

**Opt-in when**: You need to collect structured data from users with type safety, validation, and progress tracking.

**What it adds**: GATHER section with typed fields, validation rules (pattern, range, enum, custom, LLM-based), extraction hints, activation strategies (required, optional, progressive, data-driven), correction patterns, cross-field dependencies, attachment fields.

**Dependencies**: Core (CEL for validation rule conditions).

**Without this extension**: The LLM collects information naturally via conversation. No typed fields, no guaranteed validation, no progress tracking.

### 5.3 Extension: Constraints (Rule Enforcement)

**Opt-in when**: You need deterministic behavioral rules enforced outside the LLM — regulatory compliance, safety guardrails, business rules.

**What it adds**: CONSTRAINTS section with formal CEL conditions, on-fail actions (respond, escalate, handoff, block, redact), guard semantics. GUARDRAILS section for input/output safety checks with severity levels.

**Dependencies**: Core (CEL for constraint condition evaluation).

**Without this extension**: Behavioral rules are expressed in the persona/instructions only. The LLM may or may not follow them. No deterministic enforcement.

### 5.4 Extension: Scripted Flows (Deterministic Execution)

**Opt-in when**: You need deterministic step-by-step execution with explicit transitions, branching, and tool orchestration.

**What it adds**: FLOW section with named steps, THEN/GOTO transitions, ON_INPUT branching (IF/ELSE with CEL conditions), CALL (tool invocation with result handling), step-level RESPOND, ON_SUCCESS/ON_FAIL handlers, SIGNAL, CLASSIFY, digressions.

**Dependencies**: Core (CEL for branch conditions). Optionally Gather (for step-level field collection).

**Without this extension**: MODE must be `reasoning`. The LLM drives conversation flow autonomously.

### 5.5 Extension: Memory (Persistent Cross-Session State)

**Opt-in when**: You need state that persists across sessions — per-user preferences, conversation history summarization, automatic store/recall triggers.

**What it adds**: MEMORY section with persistent memory paths (per-user, per-system), remember triggers (automatic store on CEL condition), recall instructions (automatic load on event), session-scoped variables with reset policies.

**Dependencies**: Core (CEL for remember trigger conditions, SET for state mutation).

**Without this extension**: State exists only within the current session. SET/CLEAR (in Core) manage session-scoped variables. No cross-session persistence, no automatic remember/recall.

**Note**: Basic state management (SET/CLEAR on session variables) is part of Core. This extension adds the _persistence layer_ — cross-session memory with automatic triggers and lifecycle management.

### 5.6 Extension: Coordination (Multi-Agent)

**Opt-in when**: You need multiple agents working together — supervisor routing, agent-to-agent handoff, delegation, human escalation.

**What it adds**: HANDOFF (transfer to another agent with history strategy and context passing), DELEGATE (call a sub-agent and use its result), ESCALATE (route to human with priority and reason), routing rules (CEL conditions), SUPERVISOR keyword, remote agent configuration (cross-service, cross-protocol).

**Dependencies**: Core (CEL for routing conditions).

**Without this extension**: Single-agent only. No multi-agent topology.

### 5.7 Extension: Rich Content (Multi-Format Output)

**Opt-in when**: You need responses in multiple formats — markdown, HTML, voice-optimized, or with interactive elements (buttons, quick replies, carousels).

**What it adds**: FORMATS block (MARKDOWN, HTML, VOICE), voice configuration (instructions, prosody, SSML), action elements (buttons, quick replies, cards), action handlers (on-click behavior).

**Dependencies**: None beyond Core.

**Without this extension**: Plain text responses only.

---

## 6. Standards Adoption: YAML, CEL, and Handlebars

The core architectural decision is to replace ABL's proprietary syntax with three industry standards. This section details each standard adoption and the migration path.

### 6.1 YAML for Document Structure

ABL's syntax should be reformed to be valid YAML. This addresses the vendor lock-in perception without any loss of expressiveness.

#### Current Custom Syntax vs. YAML-Compliant Alternatives

| Current ABL Syntax                                      | Problem                                     | YAML-Compliant Alternative                                           |
| ------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `search_hotels(dest: string, checkin: date) -> Hotel[]` | Function signature syntax is not valid YAML | Nested YAML object with `name`, `parameters`, `returns` keys         |
| `welcome -> get_info -> confirm`                        | Arrow notation for flow sequencing          | `steps: [welcome, get_info, confirm]` as a YAML list                 |
| `CHECK: num_guests <= 10 AND destination != ""`         | Unquoted expression with operators          | `check: "num_guests <= 10 && destination != ''"` (quoted CEL string) |
| `SET: counter = ADD(counter, 1)`                        | Unquoted assignment expression              | `set: "counter = counter + 1"` (quoted CEL string)                   |
| `IF: input == "back"` / `ELSE:`                         | Edge cases with unquoted expressions        | `if: "input == 'back'"` (quoted CEL condition)                       |
| `CALL: search_hotels(param1, param2)`                   | Function call syntax                        | `call: search_hotels` with `args` sub-key                            |

#### JSON Schema for Structural Validation

Publish a JSON Schema covering all supported sections and types. This enables:

- Editor autocompletion and inline validation in VS Code, JetBrains, and any JSON Schema-aware editor
- CI/CD structural validation via standard tools (AJV, YAML Lint)
- Clear documentation of what fields exist and what values they accept

The JSON Schema handles structural validation. The compiler handles semantic validation (tool reference existence, flow graph connectivity, expression syntax, cross-agent handoff targets). Both are needed.

### 6.2 CEL for Expression Language

**Decision**: Replace ABL's custom expression engine with **CEL (Common Expression Language)** — Google's open-source expression language used in Kubernetes admission policies, Firebase security rules, and Envoy proxy.

#### Why CEL

| Criterion              | CEL                                                   | ABL Custom            | Notes                                                                                 |
| ---------------------- | ----------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| Specification          | Formal spec (cel-spec)                                | Internal grammar only | CEL has a published, versioned specification                                          |
| Implementations        | Go, Java, C++, Rust, JS (cel-js), Python (cel-python) | TypeScript only       | Critical for Python/TS SDKs — same expression semantics across all authoring surfaces |
| Enterprise recognition | Kubernetes, Firebase, Envoy, Google Cloud IAM         | Kore.ai only          | "We use CEL" is a credibility signal for enterprise buyers                            |
| Safety                 | No side effects, no I/O, sandboxed by design          | Custom sandboxing     | CEL was designed for untrusted expression evaluation                                  |
| Tooling                | Editor plugins, linters, test frameworks exist        | None                  | Reduces tooling investment                                                            |
| Custom functions       | First-class extension mechanism                       | Built-in only         | ABL domain functions register as CEL custom functions                                 |
| Transferable skills    | CEL knowledge applies to K8s, Firebase, etc.          | ABL-only knowledge    | Directly addresses vendor lock-in concern                                             |

#### Expression Migration Map

| ABL Custom Expression             | CEL Equivalent                       | Notes                              |
| --------------------------------- | ------------------------------------ | ---------------------------------- |
| `age >= 18 AND name != ""`        | `age >= 18 && name != ""`            | `AND`/`OR`/`NOT` → `&&`/`\|\|`/`!` |
| `status IN ["active", "pending"]` | `status in ["active", "pending"]`    | Same syntax                        |
| `email CONTAINS "@"`              | `email.contains("@")`                | Method syntax                      |
| `phone MATCHES "^\d{10}$"`        | `phone.matches("^\\d{10}$")`         | Method syntax                      |
| `policy_number IS SET`            | `has(policy_number)`                 | CEL built-in macro                 |
| `UPPER(name)`                     | `abl.upper(name)`                    | Registered custom function         |
| `LENGTH(items) > 0`               | `size(items) > 0`                    | CEL built-in                       |
| `ADD(price, tax)`                 | `price + tax`                        | Native arithmetic                  |
| `FORMAT_CURRENCY(amount, "USD")`  | `abl.format_currency(amount, "USD")` | Registered custom function         |
| `MASK(ssn, 4)`                    | `abl.mask(ssn, 4)`                   | Registered custom function         |
| `COALESCE(a, b)`                  | `has(a) ? a : b`                     | CEL ternary, or custom fn          |

#### ABL Custom Function Library

Domain-specific functions that don't exist in CEL natively are registered as custom functions under the `abl` namespace:

- **String**: `abl.upper()`, `abl.lower()`, `abl.trim()`, `abl.mask()`
- **Numeric**: `abl.round()`, `abl.format_currency()`, `abl.format_number()`
- **Date**: `abl.now()`, `abl.format_date()`, `abl.date_diff()`
- **Utility**: `abl.coalesce()`, `abl.default()`

These are pure functions with no side effects, consistent with CEL's safety model. The function library is versioned alongside the IR schema.

### 6.3 Handlebars for Message Templates

ABL already uses Handlebars-like syntax (`{{var}}`, `{{#if}}`, `{{#each}}`). Standardize on Handlebars explicitly:

- Use the `handlebars` npm package (JS/TS) and `pybars3` (Python) as reference implementations
- Template expressions inside `{{#if}}` blocks use CEL syntax: `{{#if "age >= 18"}}...{{/if}}`
- Simple variable interpolation remains `{{variable_name}}`
- Handlebars is well-documented, widely known, and has implementations in every major language

### 6.4 The Standards Narrative

After these adoptions, the ABL stack becomes:

| Layer               | Standard                | Proprietary              |
| ------------------- | ----------------------- | ------------------------ |
| Document structure  | YAML                    | —                        |
| Expression language | CEL                     | —                        |
| Template engine     | Handlebars              | —                        |
| Custom functions    | CEL extension mechanism | `abl.*` function library |
| Semantic validation | —                       | Compiler (AST → IR)      |
| Runtime execution   | —                       | Runtime engine           |

The narrative: "ABL uses YAML for structure, CEL for expressions, and Handlebars for templates — three industry standards. The compiler validates semantics. The runtime executes. The proprietary value is in what ABL can _express_ (gather, constraints, flows, coordination), not in how it is _written_."

---

## 7. Python and TypeScript Builder SDKs

### 7.1 Architecture

The SDKs produce the same `AgentIR` that the compiler produces. ABL DSL and the SDKs are two front-ends to the same IR back-end.

```
ABL DSL (YAML)  ──→  Compiler  ──→  AgentIR (JSON)  ──→  Runtime
                                         ↑
Python SDK  ────→  Builder API  ────────┘
                                         ↑
TypeScript SDK  →  Builder API  ────────┘
```

### 7.2 What the SDK Provides

- **Builder classes**: Programmatically construct agent definitions using typed classes, predefined functions, and enums
- **Validation**: Same semantic validation as the compiler — tool reference checks, flow graph validation, CEL expression syntax verification
- **CEL integration**: Expression strings are validated using the same CEL parser in both compiler and SDKs
- **Serialization**: Export to AgentIR JSON (for deployment) or YAML ABL (for human review)
- **Integration**: Works in notebooks, CI/CD pipelines, and custom orchestration code
- **Library interop**: Enterprises can leverage Python/TS ecosystem libraries for custom logic while using the SDK for platform integration

### 7.3 Example (Python)

```python
from abl import Agent, Tool, HttpBinding, GatherField, Constraint

agent = (
    Agent("ClaimAssistant")
    .mode("reasoning")
    .goal("Help customers file insurance claims")
    .persona("Professional and empathetic claims specialist.")
    .tool(
        Tool("lookup_policy")
        .description("Look up a customer's insurance policy")
        .parameter("policy_number", type="string", required=True)
        .returns(type="object")
        .binding(HttpBinding(method="GET", endpoint="/api/policies/{policy_number}"))
    )
    .gather(
        GatherField("policy_number")
        .prompt("What is your policy number?")
        .type("string")
        .required()
    )
    .constraint(
        # CEL expression — same syntax as YAML ABL
        Constraint("has(policy_number)")
        .on_fail("respond", "I need your policy number first.")
    )
    .complete(when="claim_filed == true", respond="Your claim has been filed successfully.")
)

ir = agent.compile()  # Returns AgentIR with full validation
```

### 7.4 Priority

Python SDK first (AI/ML ecosystem lingua franca), TypeScript SDK second (frontend and Node.js ecosystem). Both produce identical IR. Both use CEL for expression validation.

---

## 8. IR as the Portable Artifact

### 8.1 Current State

The `AgentIR` is already a JSON object with 97 typed interfaces. It is:

- The actual runtime artifact (the runtime never sees DSL text in production)
- Stored in MongoDB as `AgentVersion.irContent`
- Cached in a two-tier LRU (pod-local + Redis) keyed by content hash
- Compressed (gzip) before storage

### 8.2 Proposal

Position the IR — not the DSL — as the interoperability layer:

1. **Publish the AgentIR JSON Schema** as an open specification. Third parties can build tooling around it.
2. **Add Studio export/import at the IR level**. Enterprises can export agents as IR JSON and import from IR JSON, providing portability independent of authoring format.
3. **Version the IR schema** with semver. Breaking changes require a major version bump. Runtimes declare which IR versions they support.

This reframes the narrative: ABL is one way to produce agents. The Python SDK is another. Direct JSON authoring is a third. The IR is the standard, and it is open.

---

## 9. Why the Compiler Must Stay

A competing proposal suggests eliminating the AST/IR pipeline and having runtimes consume YAML directly. This section explains why that approach is incorrect.

### 9.1 The Compiler Is Not on the Hot Path

The runtime **already** consumes pre-compiled JSON IR, not DSL text. Compilation happens at **deploy time** only. The production request path is:

```
Session create → Load AgentIR from DB/cache → Execute
```

There is zero compilation on the request path. The IR cache hit rate is ~90%+ post-warmup (L1 pod-local LRU, 50 entries). The compiler adds no latency to production workloads.

### 9.2 What the Compiler Validates

The compiler performs semantic validation that a JSON Schema cannot express:

| Validation                     | What It Catches                                                               | JSON Schema Can Do This? |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------ |
| Flow graph connectivity        | Orphaned steps, dangling `THEN` references, unreachable steps, cycles         | No                       |
| Tool reference validity        | `call: nonexistent_tool` references a tool not declared in `tools`            | No                       |
| Cross-agent handoff targets    | `handoff: agent_x` but `agent_x` doesn't exist in the project                 | No                       |
| CEL expression syntax          | `check: "age >> 18"` (invalid operator)                                       | No                       |
| Gather field dependency graphs | Circular `depends_on` references                                              | No                       |
| Constraint condition validity  | `require: "x &&&& y"` (malformed CEL expression)                              | No                       |
| Type compatibility             | Gather field declares `type: date` but validation rule uses `pattern` (regex) | No                       |

Removing the compiler means these errors reach production and fail at runtime with cryptic messages instead of clear compile-time diagnostics with severity, location path, and machine-readable error codes.

### 9.3 What Changes

Making ABL YAML-compliant and adopting CEL changes the **first stage** of the pipeline:

```
Before:  Custom DSL text  →  Custom Lexer/Parser  →  AST  →  IR
After:   Valid YAML text   →  yaml.parse()          →  AST  →  IR
                              + CEL validation
```

The lexer becomes `yaml.parse()`. Expression validation uses the CEL parser instead of a custom expression parser. The compiler (AST → IR with semantic validation) stays. This is a net simplification — fewer custom moving parts, same correctness guarantees, better tooling.

---

## 10. Dependency Graph and Progressive Adoption

### 10.1 Extension Dependencies

```
                    ┌─────────────────────┐
                    │      ABL Core       │
                    │  (YAML + CEL +      │
                    │   Handlebars +      │
                    │   SET/CLEAR)        │
                    └──────────┬──────────┘
           ┌──────────┬───────┼────────┬───────────┐
           │          │       │        │           │
     ┌─────▼───┐ ┌────▼────┐ ┌▼──────┐ ┌▼─────────┐ ┌▼──────────┐
     │ Gather  │ │Constrai-│ │Memory │ │Coordinat-│ │Rich       │
     │         │ │nts      │ │       │ │ion       │ │Content    │
     └────┬────┘ └─────────┘ └───────┘ └──────────┘ └───────────┘
          │
    ┌─────▼──────┐
    │ Scripted   │
    │ Flows      │
    └────────────┘
```

All extensions depend only on Core. Scripted Flows optionally depends on Gather (for step-level field collection). There are no inter-extension dependencies beyond this — each extension is independently adoptable.

### 10.2 Progressive Adoption Paths

| Use Case                                 | Extensions Needed                   | Token Exposure | Standards Used        |
| ---------------------------------------- | ----------------------------------- | -------------- | --------------------- |
| Simple chatbot (3 tools, LLM-driven)     | Core only                           | ~20 tokens     | YAML, CEL, Handlebars |
| Knowledge assistant with data collection | Core + Gather                       | ~28 tokens     | + typed fields        |
| Regulated process (banking, insurance)   | Core + Gather + Constraints         | ~35 tokens     | + CEL constraints     |
| Deterministic workflow (claim filing)    | Core + Gather + Constraints + Flows | ~50 tokens     | + flow control        |
| Persistent user preferences              | Core + Memory                       | ~25 tokens     | + remember/recall     |
| Enterprise agent network                 | Core + Coordination + (any above)   | ~35-60 tokens  | + handoff/delegate    |
| Full platform capabilities               | All extensions                      | ~78 tokens     | All standards         |

The key insight: a developer building a simple chatbot encounters ~20 tokens — all backed by industry standards (YAML structure, CEL expressions, Handlebars templates). A developer building an enterprise claim-filing network encounters ~60 — the additional tokens are ABL's unique extensions, which is where the platform's differentiation lives. Both use the same language, but their window into it is proportional to their requirements.

---

## 11. Risks and Mitigations

| Risk                                                                                                       | Impact                                                 | Mitigation                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension interaction bugs (e.g., Constraints + Flows + Gather — does validation fire in the right order?) | Runtime behavior depends on extension combination      | Well-defined evaluation order already exists in the runtime: guardrails → constraints → step logic → gather → completion. Document this explicitly per combination.                                              |
| "Which extensions do I need?" confusion for new users                                                      | Adoption friction; wrong extension selection           | Arch AI recommends extensions based on use case during project creation. Extension selection is a first-class step in the onboarding wizard.                                                                     |
| Extension proliferation (too granular, too many choices)                                                   | Decision paralysis; documentation sprawl               | Cap at 6 coarse-grained extensions as defined above. Each maps to a real enterprise concern (compliance, orchestration, multi-agent, etc.). Resist splitting further.                                            |
| YAML + CEL syntax reform breaks existing ABL definitions                                                   | Migration cost for existing agents                     | Provide an automated migration tool (AST-to-YAML serializer with expression rewriting). The compiler can accept both formats during a transition period.                                                         |
| CEL adoption requires rewriting the expression evaluator                                                   | Engineering effort; potential regression in edge cases | The custom evaluator's ~30 built-in functions map cleanly to CEL native ops + custom function registration. Incremental migration with extensive test coverage. Expression semantics don't change — only syntax. |
| CEL `&&`/`\|\|` less readable than `AND`/`OR` for non-developers                                           | Accessibility concern for business analysts            | Studio provides a visual expression builder (point-and-click conditions). YAML is the developer interface; Studio UI is the analyst interface.                                                                   |
| SDK IR diverges from compiler IR                                                                           | Two sources of truth for the same artifact             | Both produce the same `AgentIR` type. Shared validation logic extracted to a `@agent-platform/ir-validation` package consumed by both compiler and SDKs. CEL validation shared across all surfaces.              |
| Open IR schema enables competitors to build compatible runtimes                                            | Loss of runtime lock-in                                | This is a feature, not a bug. Ecosystem growth increases ABL adoption. Runtime differentiation comes from execution quality (performance, observability, compliance features), not format lock-in.               |

---

## 12. Phased Rollout

### Phase 1: YAML + CEL Standards Adoption

**Status: Implementation complete** -- CEL evaluator, expression migrator, dual evaluator, YAML parser, and JSON Schema all implemented. See [CEL Migration Guide](../abl/CEL_MIGRATION_GUIDE.md) for developer-facing documentation.

- Reform ABL syntax to be valid YAML (lowercase keys, quote expressions, restructure tool signatures)
- Replace custom expression engine with CEL parser (`cel-js` for compiler, `cel-python` for SDK)
- Register ABL domain functions as CEL custom functions (`abl.upper()`, `abl.format_currency()`, etc.)
- Standardize on Handlebars for message templates
- Publish JSON Schema for structural validation
- Automated migration tool for existing ABL definitions (syntax rewrite: `AND` → `&&`, `UPPER(x)` → `abl.upper(x)`, etc.)
- Compiler accepts both old and new syntax during transition period

**Outcome**: ABL files are valid YAML. Expressions use an industry standard (CEL). Any YAML editor, linter, or schema validator works. Vendor lock-in perception eliminated for the authoring layer. The narrative becomes: "YAML + CEL + Handlebars — three standards, zero proprietary syntax."

### Phase 2: Core + Extensions Architecture

- Refactor compiler to be extension-aware (only parse/validate declared extensions)
- Extension declaration syntax (e.g., `extensions: [gather, constraints, flows]` or inferred from usage)
- Per-extension documentation, examples, and validation
- Arch AI recommends extensions during project creation

**Outcome**: Progressive complexity. Simple agents are simple. Complex agents opt into complexity explicitly.

### Phase 3: Python Builder SDK

- Python package (`abl-sdk`) that produces `AgentIR`
- Shared CEL validation between compiler and SDK (both use `cel-python`)
- Shared IR validation extracted to `@agent-platform/ir-validation`
- Notebook integration (Jupyter, Colab)
- CI/CD integration (produce IR from Python in deployment pipelines)

**Outcome**: Enterprises with Python teams can author agents programmatically. Expression syntax is identical across YAML and Python (both use CEL strings).

### Phase 4: TypeScript Builder SDK + IR Publication

- TypeScript package (`@agent-platform/sdk`) with same API surface as Python
- Publish AgentIR JSON Schema as open specification
- Studio export/import at IR level
- IR versioning with semver

**Outcome**: Full ecosystem. Three authoring paths (YAML, Python, TypeScript), one portable IR, one expression language (CEL), open schema.

Each phase is independently shippable and delivers value. Phase 1 is the priority — it addresses the two most urgent concerns (vendor lock-in perception and proprietary syntax) in a single deliverable. Phase 3 can begin in parallel once Phase 1's CEL integration stabilizes.
