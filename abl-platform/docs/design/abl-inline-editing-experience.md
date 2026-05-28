# ABL DSL Inline Editing Experience — Design Document

**Status**: RFC
**Date**: 2026-03-10
**Version**: 2.0
**HTML Wireframe**: [abl-inline-editing-wireframe.html](./abl-inline-editing-wireframe.html) (open in browser)

---

## 1. Executive Summary

**Problem**: Writing YAML DSL for agents requires memorizing syntax for tools, guardrails, templates, flow steps, and other constructs. This slows development and creates syntax errors.

**Solution**: Context-aware slash commands in the ABL Monaco editor that open intelligent modals to browse, search, preview, and insert DSL constructs at the cursor position.

**Impact**: 3-5x faster agent authoring, reduced syntax errors, improved discoverability of platform features.

---

## 2. What Exists Today

### Current ABL Editor (`ABLEditor.tsx`)

The editor already has:

- Monaco Editor with custom ABL language registration
- Monarch tokenizer (legacy + YAML syntax highlighting)
- Custom dark theme (`abl-dark`)
- Hover provider (`getHoverInfo` from `@abl/language-service`)
- Completion provider (`getCompletions` with tool/agent context)
- Symbol tree sidebar (collapsible, searchable)
- Diagnostics panel (errors/warnings/info with source filters)
- Error markers on editor gutter
- Live parsing (debounced)
- Compile button
- `ToolPickerDialog` → inserts tool signature at cursor
- Keyboard shortcuts (`⌘S` save)

### Current Editor Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER: ◆ ABL Editor   agent_name                    [Save ✓] [✕]  │
├──────────────────────────────────────────────────────────────────────┤
│ TOOLBAR: ABL Editor ● Modified  [≡] [⚠] [🔧] [↺] [▶ Compile]     │
├────────────┬─────────────────────────────────────────────────────────┤
│            │                                                         │
│  SYMBOL    │  MONACO EDITOR                                         │
│  TREE      │                                                         │
│  (20%)     │  1  AGENT: Insurance_Claim_Agent                       │
│            │  2  GOAL: "Help users file claims"                     │
│  ┌───────┐ │  3                                                      │
│  │Filter │ │  4  IDENTITY:                                           │
│  └───────┘ │  5    role: "Claims Assistant"                          │
│  ▼ 🤖 Agent│  6                                                      │
│    ▼ 📁 TOO│  7  TOOLS:                                             │
│      🔧 fet│  8    fetch_policy:                                    │
│      🔧 cre│  9      description: "Get policy"                     │
│    ▼ 📁 GUA│ 10      params:                                       │
│      🛡 ssn│ 11        policyId: string                            │
│      🛡 pii│ 12      returns: object                               │
│    ▶ 📁 FLO│ 13                                                      │
│    ▶ 📁 COM│ 14  GUARDRAILS:                                        │
│            │ 15    ssn_detection:                                    │
│            │ 16      kind: input                                    │
│            │ 17      check: not_matches_pattern(...)                │
│            │ 18      action: block                                  │
│            │ 19  █                                                   │
├────────────┴─────────────────────────────────────────────────────────┤
│ STATUS: ✓ No issues                        Ln 19, Col 3 · ABL      │
└──────────────────────────────────────────────────────────────────────┘
```

### What Needs To Be Built

- Slash command detection (`/` trigger)
- DSL section detection at cursor position (context detector)
- Context-aware command palette (inline widget)
- Guardrail picker modal (new)
- Template picker modal (new)
- Preview panels for all pickers
- Indent-aware snippet generation
- Additional keyboard shortcuts

---

## 3. DSL Sections & Available Slash Commands

### All DSL Sections

Based on `AgentBasedDocument` type in `packages/core/src/types/agent-based.ts`:

| Section            | DSL Syntax                     | Slash Commands                                                      | Priority |
| ------------------ | ------------------------------ | ------------------------------------------------------------------- | -------- |
| **TOOLS**          | `TOOLS:`                       | `/tool`, `/http-tool`, `/mcp-tool`, `/lambda-tool`, `/sandbox-tool` | **P1**   |
| **GUARDRAILS**     | `GUARDRAILS:`                  | `/guardrail`, `/builtin-guard`                                      | **P1**   |
| **TEMPLATES**      | `TEMPLATES:` or `MESSAGES:`    | `/template`                                                         | **P1**   |
| **FLOW**           | `FLOW:`                        | `/step`, `/reasoning-step`, `/scripted-step`                        | P2       |
| **GATHER**         | `GATHER:`                      | `/field`                                                            | P2       |
| **MEMORY**         | `MEMORY:`                      | `/memory-var`, `/persistent`                                        | P3       |
| **CONSTRAINTS**    | `CONSTRAINTS:`                 | `/constraint`                                                       | P3       |
| **DELEGATES**      | `DELEGATE:`                    | `/delegate`                                                         | P3       |
| **HANDOFFS**       | `HANDOFF:`                     | `/handoff`                                                          | P3       |
| **ESCALATION**     | `ESCALATE:`                    | `/escalate`                                                         | P3       |
| **ERROR HANDLING** | `ON_ERROR:`                    | `/error-handler`                                                    | P3       |
| **COMPLETION**     | `COMPLETE:`                    | `/completion`                                                       | P3       |
| **Root level**     | Top of file / between sections | All commands grouped                                                | Always   |

### Nested Sections (Inside FLOW)

| Section              | Syntax                | Commands          |
| -------------------- | --------------------- | ----------------- |
| Flow Step `GATHER:`  | `GATHER:` inside step | `/field`          |
| Flow Step `CALL:`    | `CALL: tool()`        | `/tool` reference |
| Flow Step `RESPOND:` | `RESPOND: "..."`      | Edit only         |

---

## 4. Context Detection — Feasibility & Reliability

### Detection Strategy: AST Parsing + Line-Based Fallback

```typescript
function detectDSLContext(content: string, position: Position): DSLContext {
  // PRIMARY: Parse with @abl/core → walk AST to cursor
  const result = parseAgentBasedABL(content);
  if (result.document && result.errors.length === 0) {
    const node = findNodeAtPosition(result.document, position);
    return { section: inferSection(node), ... };
  }

  // FALLBACK: Search backwards for section keyword
  for (let i = position.line; i >= 0; i--) {
    if (lines[i].match(/^TOOLS:/))      return { section: 'tools', ... };
    if (lines[i].match(/^GUARDRAILS:/)) return { section: 'guardrails', ... };
    if (lines[i].match(/^TEMPLATES:/))  return { section: 'templates', ... };
    // ... etc
  }
}
```

### Reliability Matrix

| Scenario                               | Method                 | Reliability |
| -------------------------------------- | ---------------------- | ----------- |
| Cursor inside section (e.g., `TOOLS:`) | AST parsing            | **100%**    |
| Cursor after existing items            | AST node parent lookup | **100%**    |
| Cursor in nested structure (flow step) | AST tree walk          | **100%**    |
| Multi-line string context              | AST node type check    | **100%**    |
| Malformed YAML                         | Line-based fallback    | **95%**     |
| Cursor at end of file                  | Last valid section     | **95%**     |
| Cursor in comment                      | Line-based heuristic   | **85%**     |
| Empty file                             | Show all root commands | **100%**    |
| **Overall**                            | AST + fallback         | **97%**     |

### Performance

| Operation               | Target | Expected |
| ----------------------- | ------ | -------- |
| Parse DSL (1000 lines)  | <50ms  | ~30ms    |
| Find node at position   | <10ms  | ~5ms     |
| Total context detection | <50ms  | ~35ms    |

### Edge Cases

| Edge Case                       | Solution                                     |
| ------------------------------- | -------------------------------------------- |
| Cursor between sections         | Show commands for both adjacent sections     |
| Cursor inside multi-line string | Don't show commands (detect string node)     |
| Nested GATHER inside FLOW step  | Detect with AST — returns `flow.step.gather` |
| Tool import vs tool definition  | Show both `/tool` and `/import-tool`         |

---

## 5. User Experience — Interaction Flow

### Entry Points

1. **Slash Commands** (Primary): User types `/` → inline command palette
2. **Keyboard Shortcuts** (Secondary): `Ctrl+Space` → context picker, `Ctrl+Shift+T` → tools
3. **Toolbar Buttons** (Tertiary): Existing 🔧 button + new 🛡 and 📄 buttons

### Complete Flow

```
┌──────────────┐
│ User editing  │
│ DSL in Monaco │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌────────────────────────┐
│ Types "/"    │────▶│ Context Detection       │
└──────────────┘     │  Parse AST → section    │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │ Command Palette         │
                     │  Context-filtered cmds  │
                     └───────────┬────────────┘
                                 │
                   ┌─────────────┼─────────────┐
                   ▼             ▼             ▼
            ┌──────────┐ ┌──────────┐ ┌──────────┐
            │ /tool    │ │/guardrail│ │/template │
            └────┬─────┘ └────┬─────┘ └────┬─────┘
                 │            │            │
                 ▼            ▼            ▼
            ┌──────────┐ ┌──────────┐ ┌──────────┐
            │Tool Picker│ │Guard.Pick│ │Tmpl Pick │
            │  Modal    │ │  Modal   │ │  Modal   │
            └────┬─────┘ └────┬─────┘ └────┬─────┘
                 │            │            │
                 └────────────┼────────────┘
                              │
                              ▼
                   ┌────────────────────────┐
                   │ Generate YAML Snippet  │
                   │  Detect indent level   │
                   │  Escape special chars  │
                   └───────────┬────────────┘
                               │
                               ▼
                   ┌────────────────────────┐
                   │ Insert at Cursor       │
                   │  Monaco executeEdits   │
                   │  Highlight new lines   │
                   │  Trigger live parse    │
                   └────────────────────────┘
```

---

## 6. Wireframes — Command Palette

### 6A. Command Palette — TOOLS Context

When user types `/` at line 15, inside the `TOOLS:` section:

```
┌──────────────────────────────────────────────────────────────────┐
│  MONACO EDITOR                                                   │
│                                                                  │
│  7  TOOLS:                                                       │
│  8    fetch_policy:                                              │
│  9      description: "Get policy details"                       │
│ 10      params:                                                  │
│ 11        policyId: string                                       │
│ 12      returns: object                                          │
│ 13                                                               │
│ 14    /█                                                         │
│        ┌──────────────────────────────────────────┐              │
│        │ 📍 Context: TOOLS section                │              │
│        ├──────────────────────────────────────────┤              │
│        │  🔧 /tool           Add a new tool      │ ← focused   │
│        │  🌐 /http-tool      HTTP API tool       │              │
│        │  📡 /mcp-tool       MCP server tool     │              │
│        │  ⚡ /lambda-tool    Serverless function │              │
│        │  📦 /sandbox-tool   Code sandbox tool   │              │
│        ├──────────────────────────────────────────┤              │
│        │  ↑↓ Navigate  ⏎ Select  Esc Dismiss    │              │
│        └──────────────────────────────────────────┘              │
│ 15                                                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 6B. Command Palette — GUARDRAILS Context

```
┌──────────────────────────────────────────────────────────────────┐
│  MONACO EDITOR                                                   │
│                                                                  │
│ 17  GUARDRAILS:                                                  │
│ 18    ssn_detection:                                             │
│ 19      kind: input                                              │
│ 20      check: not_matches_pattern(...)                          │
│ 21      action: block                                            │
│ 22                                                               │
│ 23    /█                                                         │
│        ┌──────────────────────────────────────────┐              │
│        │ 📍 Context: GUARDRAILS section           │              │
│        ├──────────────────────────────────────────┤              │
│        │  🛡 /guardrail      Add safety guard    │ ← focused   │
│        │  ⚡ /builtin-guard  Use built-in guard  │              │
│        ├──────────────────────────────────────────┤              │
│        │  ↑↓ Navigate  ⏎ Select  Esc Dismiss    │              │
│        └──────────────────────────────────────────┘              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 6C. Command Palette — Root Level (All Commands)

```
┌──────────────────────────────────────────────────────────────────┐
│  MONACO EDITOR                                                   │
│                                                                  │
│  1  AGENT: My_Agent                                              │
│  2  GOAL: "Help users"                                           │
│  3                                                               │
│  4  /█                                                           │
│      ┌────────────────────────────────────────────────┐          │
│      │ 📍 Context: Root level — all commands          │          │
│      ├────────────────────────────────────────────────┤          │
│      │  CAPABILITIES                                   │          │
│      │  🔧 /tool           Add a new tool             │          │
│      │  🛡 /guardrail      Add safety guardrail       │          │
│      │  📄 /template       Add response template      │          │
│      │                                                 │          │
│      │  FLOW                                           │          │
│      │  🔀 /step           Add flow step              │          │
│      │  📋 /field          Add gather field           │          │
│      │                                                 │          │
│      │  MEMORY                                         │          │
│      │  💾 /memory-var     Add session variable       │          │
│      │                                                 │          │
│      │  COORDINATION                                   │          │
│      │  🤝 /handoff        Add handoff target         │          │
│      │  🚨 /escalate       Add escalation trigger     │          │
│      ├────────────────────────────────────────────────┤          │
│      │  ↑↓ Navigate  ⏎ Select  Esc Dismiss           │          │
│      └────────────────────────────────────────────────┘          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Wireframes — Picker Modals

### 7A. Tool Picker — Browse + Preview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          INSERT TOOL                          [✕]   │
├──────────────────────────────────────────────────────────────────────┤
│  🔍 Search tools...                                                 │
│  [All] [HTTP] [MCP] [Lambda] [Sandbox]                              │
├──────────────────────┬───────────────────────────────────────────────┤
│                      │                                               │
│  PROJECT TOOLS (4)   │  TOOL PREVIEW                                │
│  ┌────────────────┐  │                                               │
│  │▶fetch_customer◀│  │  🔧 fetch_customer_data            HTTP      │
│  │  HTTP          │  │  ────────────────────────────────────────     │
│  ├────────────────┤  │                                               │
│  │ create_ticket  │  │  Method:   POST                              │
│  │  MCP           │  │  Endpoint: /api/customers/{id}               │
│  ├────────────────┤  │  Timeout:  30000ms                           │
│  │ send_notif     │  │                                               │
│  │  HTTP          │  │  PARAMETERS (2)                              │
│  ├────────────────┤  │  ┌──────────────────────────────────────┐    │
│  │ validate_pol   │  │  │ customerId    string   required ✓   │    │
│  │  Sandbox       │  │  │ includeHist   boolean  optional     │    │
│  └────────────────┘  │  └──────────────────────────────────────┘    │
│                      │                                               │
│  CREATE NEW          │  RETURNS: object                             │
│  ┌────────────────┐  │  ────────────────────────────────────────     │
│  │ ➕ HTTP Tool   │  │                                               │
│  │ ➕ MCP Tool    │  │  GENERATED DSL                               │
│  │ ➕ Lambda Tool │  │  ┌────────────────────────────────────────┐  │
│  │ ➕ Sandbox Tool│  │  │  fetch_customer_data:                  │  │
│  └────────────────┘  │  │    description: "Fetch customer..."    │  │
│                      │  │    params:                              │  │
│                      │  │      customerId: string                │  │
│                      │  │      includeHistory: boolean            │  │
│                      │  │    returns: object                      │  │
│                      │  │    type: http                           │  │
│                      │  │    http:                                │  │
│                      │  │      method: POST                      │  │
│                      │  │      endpoint: "/api/customers/{id}"   │  │
│                      │  │      timeout: 30000                    │  │
│                      │  └────────────────────────────────────────┘  │
│                      │                                               │
│                      │            [📋 Copy]  [⏎ Insert at Cursor]   │
│                      │                                               │
├──────────────────────┴───────────────────────────────────────────────┤
│  ↑↓ Navigate   Tab Preview   ⏎ Insert   Esc Close                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 7B. Guardrail Picker — Built-in + Preview

```
┌──────────────────────────────────────────────────────────────────────┐
│                       INSERT GUARDRAIL                        [✕]   │
├──────────────────────────────────────────────────────────────────────┤
│  🔍 Search guardrails...                                            │
│  [All] [Input] [Output] [Both]                                      │
├──────────────────────┬───────────────────────────────────────────────┤
│                      │                                               │
│  BUILT-IN (5)        │  GUARDRAIL PREVIEW                           │
│  ┌────────────────┐  │                                               │
│  │▶detect_instr◀  │  │  🛡 detect_instruction_override              │
│  │  INPUT  BLOCK  │  │  ────────────────────────────────────────     │
│  ├────────────────┤  │                                               │
│  │ detect_role    │  │  Kind:     INPUT                             │
│  │  INPUT  BLOCK  │  │  Action:   BLOCK                             │
│  ├────────────────┤  │  Tier:     1 (local, zero LLM cost)         │
│  │ detect_sys     │  │                                               │
│  │  INPUT  BLOCK  │  │  DESCRIPTION                                 │
│  ├────────────────┤  │  Detects prompt injection attempts like      │
│  │ detect_enc     │  │  "ignore previous instructions". Uses        │
│  │  INPUT  WARN   │  │  zero-cost local CEL pattern matching.       │
│  ├────────────────┤  │                                               │
│  │ detect_cred    │  │  CHECK EXPRESSION (CEL)                      │
│  │  OUTPUT REDACT │  │  ┌────────────────────────────────────────┐  │
│  └────────────────┘  │  │ not_matches_pattern(                   │  │
│                      │  │   input.lower(),                        │  │
│  CREATE NEW          │  │   "ignore (previous|prior|all|above)    │  │
│  ┌────────────────┐  │  │    (instructions|rules|prompts)")       │  │
│  │ ➕ Input Guard │  │  └────────────────────────────────────────┘  │
│  │ ➕ Output Guard│  │                                               │
│  │ ➕ Custom CEL  │  │  EXAMPLE TRIGGERS                            │
│  │ ➕ PII Protect │  │  ┌────────────────────────────────────────┐  │
│  └────────────────┘  │  │ ❌ "ignore previous instructions"      │  │
│                      │  │ ❌ "disregard all prior rules"          │  │
│                      │  │ ✅ "what are your instructions?"        │  │
│                      │  └────────────────────────────────────────┘  │
│                      │                                               │
│                      │  GENERATED DSL                               │
│                      │  ┌────────────────────────────────────────┐  │
│                      │  │  detect_instruction_override:          │  │
│                      │  │    kind: input                         │  │
│                      │  │    check: |                            │  │
│                      │  │      not_matches_pattern(              │  │
│                      │  │        input.lower(),                  │  │
│                      │  │        "ignore (previous|prior)...")   │  │
│                      │  │    action: block                       │  │
│                      │  │    message: "Cannot process."          │  │
│                      │  └────────────────────────────────────────┘  │
│                      │                                               │
│                      │            [📋 Copy]  [⏎ Insert at Cursor]   │
│                      │                                               │
├──────────────────────┴───────────────────────────────────────────────┤
│  ↑↓ Navigate   Tab Preview   ⏎ Insert   Esc Close                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 7C. Template Picker — Format Tabs Preview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        INSERT TEMPLATE                        [✕]   │
├──────────────────────────────────────────────────────────────────────┤
│  🔍 Search templates...                                             │
│  [All] [Multi-Format] [Default Only] [Voice]                        │
├──────────────────────┬───────────────────────────────────────────────┤
│                      │                                               │
│  SYSTEM TEMPLATES (5)│  TEMPLATE PREVIEW                            │
│  ┌────────────────┐  │                                               │
│  │ greeting_formal│  │  📄 escalation_handoff                       │
│  ├────────────────┤  │  ────────────────────────────────────────     │
│  │ greeting_casual│  │                                               │
│  ├────────────────┤  │  Formats: Default, Markdown, HTML, Voice     │
│  │ error_fallback │  │                                               │
│  ├────────────────┤  │  [Default] [Markdown] [HTML] [Voice]         │
│  │▶escalation◀   │  │  ────────────────────────────────────────     │
│  │  All Formats   │  │                                               │
│  ├────────────────┤  │  ┌────────────────────────────────────────┐  │
│  │ session_timeout│  │  │ I need to connect you with a           │  │
│  └────────────────┘  │  │ specialist who can assist you           │  │
│                      │  │ further with this matter.               │  │
│  CREATE NEW          │  │                                        │  │
│  ┌────────────────┐  │  │ Please hold while I transfer you.      │  │
│  │ ➕ Multi-Format│  │  │ Your conversation history will be      │  │
│  │ ➕ Simple      │  │  │ shared so you don't need to repeat.    │  │
│  │ ➕ Voice-Only  │  │  └────────────────────────────────────────┘  │
│  └────────────────┘  │                                               │
│                      │  GENERATED DSL                               │
│                      │  ┌────────────────────────────────────────┐  │
│                      │  │  escalation_handoff:                   │  │
│                      │  │    default: |                          │  │
│                      │  │      I need to connect you with a      │  │
│                      │  │      specialist who can assist you...   │  │
│                      │  │    voice: |                             │  │
│                      │  │      Let me transfer you to someone     │  │
│                      │  │      who can help. One moment please.   │  │
│                      │  └────────────────────────────────────────┘  │
│                      │                                               │
│                      │            [📋 Copy]  [⏎ Insert at Cursor]   │
│                      │                                               │
├──────────────────────┴───────────────────────────────────────────────┤
│  ↑↓ Navigate   Tab Preview   ⏎ Insert   Esc Close                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 7D. New Tool Form (HTTP)

```
┌──────────────────────────────────────────────────────────────────┐
│  CREATE HTTP TOOL                             [← Back]    [✕]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Tool Name                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ my_new_tool                                               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Description                                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ What this tool does...                                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  HTTP Method       Endpoint                                      │
│  ┌──────────┐     ┌──────────────────────────────────────────┐  │
│  │ POST  ▼  │     │ https://api.example.com/...               │  │
│  └──────────┘     └──────────────────────────────────────────┘  │
│                                                                  │
│  Auth                      Timeout (ms)                          │
│  ┌──────────────────┐     ┌──────────────────┐                  │
│  │ Bearer Token  ▼  │     │ 30000            │                  │
│  └──────────────────┘     └──────────────────┘                  │
│                                                                  │
│  PARAMETERS                                       [+ Add Param] │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Name          Type        Required    [✕]                │   │
│  │  ┌──────────┐ ┌─────────┐ ┌───┐                          │   │
│  │  │ userId   │ │string ▼ │ │ ✓ │                          │   │
│  │  └──────────┘ └─────────┘ └───┘                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ──────────────────────────────────────────────────────────     │
│  LIVE PREVIEW                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  my_new_tool:                                             │   │
│  │    description: "What this tool does..."                  │   │
│  │    params:                                                │   │
│  │      userId: string                                       │   │
│  │    returns: object                                        │   │
│  │    type: http                                             │   │
│  │    http:                                                  │   │
│  │      method: POST                                         │   │
│  │      endpoint: "https://api.example.com/..."              │   │
│  │      auth: bearer                                         │   │
│  │      timeout: 30000                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│                             [📋 Copy]   [⏎ Insert at Cursor]    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. Wireframes — States

### 8A. Post-Insertion — Success

```
┌──────────────────────────────────────────────────────────────────┐
│  MONACO EDITOR                                                   │
│                                                                  │
│ 17  GUARDRAILS:                                                  │
│ 18    ssn_detection:                                             │
│ 19      kind: input                                              │
│ 20      check: not_matches_pattern(...)                          │
│ 21      action: block                                            │
│ 22                                                               │
│ 23 ▌  detect_instruction_override:           ← ✓ Inserted      │
│ 24 ▌    kind: input                                              │
│ 25 ▌    check: |                                                 │
│ 26 ▌      not_matches_pattern(                                   │
│ 27 ▌        input.lower(),                                       │
│ 28 ▌        "ignore (previous|prior|all)")                       │
│ 29 ▌    action: block                                            │
│ 30 ▌    message: "Cannot process."█          ← cursor here      │
│ 31                                                               │
│ 32  COMPLETE:                                                    │
│ 33    - user_satisfied                                           │
│                                                                  │
│  ── STATUS BAR ──────────────────────────────────────────────── │
│  ✓ Snippet inserted (8 lines)            Ln 30, Col 32  ⌘Z Undo│
└──────────────────────────────────────────────────────────────────┘
```

### 8B. Error State — Failed to Fetch

```
┌──────────────────────────────────────────────────────────────────┐
│                       INSERT TOOL                         [✕]   │
├──────────────────────────────────────────────────────────────────┤
│  🔍 Search tools...                                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                     ⚠️                                            │
│                     Failed to load tools                         │
│                     Could not connect to the server.             │
│                                                                  │
│                     [🔄 Retry]                                   │
│                                                                  │
│                     ── or create new ──                          │
│                     ➕ New HTTP Tool                              │
│                     ➕ New MCP Tool                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 8C. Empty Search Results

```
┌──────────────────────────────────────────────────────────────────┐
│                    INSERT GUARDRAIL                        [✕]   │
├──────────────────────────────────────────────────────────────────┤
│  🔍 nonexistent_guard                                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                     🛡                                            │
│                     No guardrails match "nonexistent_guard"      │
│                                                                  │
│                     Try a different search or create one:        │
│                     [➕ Create Custom Guardrail]                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. Technical Architecture

### Component Hierarchy

```
<ABLEditor>
  ├── <MonacoEditor>
  │     ├── Command Action Provider (registers "/" trigger)
  │     ├── useMonacoCommands hook
  │     └── DSLContextDetector
  │
  ├── <CommandPaletteWidget>       ← inline at cursor
  │     ├── Context badge
  │     ├── Filtered command list
  │     └── Keyboard nav
  │
  ├── <ToolPickerModal>            ← React Portal
  │     ├── Search + type tabs
  │     ├── Tool list + create new
  │     ├── Preview panel (split)
  │     └── Generated DSL + Insert button
  │
  ├── <GuardrailPickerModal>       ← React Portal
  │     ├── Search + kind tabs
  │     ├── Built-in + custom list
  │     ├── Preview: CEL + examples
  │     └── Generated DSL + Insert button
  │
  └── <TemplatePickerModal>        ← React Portal
        ├── Search + format tabs
        ├── System + agent templates
        ├── Preview: format tabs
        └── Generated DSL + Insert button
```

### New Files

```
apps/studio/src/components/abl/
├── commands/
│   ├── useMonacoCommands.ts         Hook: "/" trigger + keyboard shortcuts
│   ├── DSLContextDetector.ts        AST-based section detection at cursor
│   ├── SnippetGenerator.ts          Indent-aware YAML generation
│   └── CommandRegistry.ts           All slash commands + metadata
├── pickers/
│   ├── BasePickerModal.tsx          Shared: search, categories, keyboard nav
│   ├── ToolPickerModal.tsx          Enhanced tool picker with preview
│   ├── GuardrailPickerModal.tsx     Guardrail picker (NEW)
│   ├── TemplatePickerModal.tsx      Template picker (NEW)
│   └── CommandPaletteWidget.tsx     Inline command palette at cursor
```

### Key Data Types

```typescript
type DSLSection =
  | 'root'
  | 'identity'
  | 'tools'
  | 'guardrails'
  | 'templates'
  | 'flow'
  | 'flow.step'
  | 'gather'
  | 'memory'
  | 'constraints'
  | 'delegates'
  | 'handoffs'
  | 'escalation'
  | 'error_handling'
  | 'completion'
  | 'unknown';

interface DSLContext {
  section: DSLSection;
  line: number;
  column: number;
  indentLevel: number;
  availableCommands: Command[];
}

interface Command {
  id: string; // 'tool', 'guardrail', etc.
  label: string; // '/tool'
  description: string; // 'Add a new tool'
  icon: string; // emoji or LucideIcon
  availableIn: DSLSection[]; // which sections show this command
  handler: (ctx: DSLContext) => void;
}

interface GeneratedSnippet {
  content: string; // YAML text
  cursorOffset?: number; // where to place cursor after insertion
}
```

### New API Endpoint

```
GET /api/compiler/builtin-guardrails

Response:
{
  "guardrails": [
    {
      "name": "detect_instruction_override",
      "description": "Detects prompt injection attacks",
      "kind": "input",
      "check": "not_matches_pattern(input.lower(), ...)",
      "action": { "type": "block", "message": "Cannot process." },
      "category": "security",
      "examples": ["ignore previous instructions..."]
    }
  ]
}
```

Source: `packages/compiler/src/platform/guardrails/builtin-templates.ts` (5 built-in guardrails)

---

## 10. Implementation Plan

### Phase 1: Foundation (Week 1)

| Task                       | Deliverable                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `DSLContextDetector.ts`    | AST-based section detection + line-based fallback             |
| `CommandRegistry.ts`       | All commands with metadata + section filtering                |
| `SnippetGenerator.ts`      | Tool/guardrail/template YAML generation with indent detection |
| `useMonacoCommands.ts`     | Register `/` trigger, `Ctrl+Space`, keyboard shortcuts        |
| `CommandPaletteWidget.tsx` | Inline palette positioned at cursor with keyboard nav         |
| Unit tests                 | Context detection for all sections + edge cases               |

### Phase 2: Tool Picker Enhancement (Week 2)

| Task                        | Deliverable                                                    |
| --------------------------- | -------------------------------------------------------------- |
| Refactor `ToolPickerDialog` | Accept insertion callback + preview mode                       |
| `BasePickerModal.tsx`       | Shared picker: search, categories, keyboard nav, split preview |
| `ToolPickerModal.tsx`       | Enhanced picker with preview panel + create new forms          |
| New HTTP Tool form          | Name, method, endpoint, auth, params, returns                  |
| Snippet insertion           | Indent-aware insertion via `monaco.editor.executeEdits`        |

### Phase 3: Guardrail Picker (Week 3)

| Task                                   | Deliverable                                               |
| -------------------------------------- | --------------------------------------------------------- |
| `GET /api/compiler/builtin-guardrails` | New API endpoint returning 5 built-ins                    |
| `GuardrailPickerModal.tsx`             | Modal with built-in + custom + create new                 |
| Preview panel                          | CEL expression display, example triggers, action behavior |
| Snippet generation                     | CEL expression escaping, multi-line `check:`              |

### Phase 4: Template Picker (Week 4)

| Task                      | Deliverable                                  |
| ------------------------- | -------------------------------------------- | -------- |
| `TemplatePickerModal.tsx` | Modal with system + agent templates          |
| Preview panel             | Format tabs (Default/Markdown/HTML/Voice)    |
| Snippet generation        | Multi-line YAML strings with `               | ` syntax |
| Fetch templates           | `GET /api/prompt-templates?category=message` |

### Phase 5: Polish & Testing (Week 5)

| Task            | Deliverable                                              |
| --------------- | -------------------------------------------------------- |
| Keyboard nav    | Arrow keys, Tab, Enter, Escape across all pickers        |
| Error handling  | Failed fetch → retry, invalid insertion → undo           |
| E2E tests       | Playwright: type `/tool` → select → verify insertion     |
| Performance     | Cache (30s TTL), debounce search (200ms), virtual scroll |
| Toolbar buttons | Add guardrail + template buttons to ABLEditor toolbar    |

---

## 11. Keyboard Shortcuts

| Shortcut        | Action                             |
| --------------- | ---------------------------------- |
| `/` (in editor) | Open context-aware command palette |
| `Ctrl+Space`    | Open context picker directly       |
| `Ctrl+Shift+T`  | Insert tool                        |
| `Ctrl+Shift+G`  | Insert guardrail                   |
| `Ctrl+Shift+M`  | Insert template                    |
| `↑` / `↓`       | Navigate items in palette/picker   |
| `Enter`         | Select/insert item                 |
| `Tab`           | Toggle preview panel               |
| `Escape`        | Close palette/picker               |
| `Ctrl+Z`        | Undo insertion                     |

---

## 12. Testing Strategy

### Unit Tests

- Context detection returns correct section for all DSL positions
- Snippet generator produces valid YAML with correct indentation
- Command registry filters commands by section correctly
- Edge cases: malformed YAML, empty file, comments, nested structures

### Integration Tests

- Slash command opens correct picker based on context
- Picker fetches data and displays categorized items
- Preview shows correct information
- Insert generates and inserts valid snippet

### E2E Tests (Playwright)

- Type `/tool` in TOOLS section → tool picker opens → insert works
- Type `/guardrail` → select built-in → verify CEL expression
- Type `/template` → select template → verify multi-line format
- Keyboard navigation works (arrow keys, enter, escape)
- Error states handled (failed API, invalid YAML)

### Performance Targets

| Metric              | Target |
| ------------------- | ------ |
| Picker open time    | <100ms |
| Context detection   | <50ms  |
| Snippet generation  | <10ms  |
| Insertion + reparse | <200ms |

---

## 13. Open Questions

1. **Guardrail API**: Parse all project agents (simple, slow) vs dedicated endpoint (extra work, fast)?
   → Recommendation: Start with parsing, add endpoint if performance issues.

2. **Template sources**: System templates only for MVP, or also agent-specific?
   → Recommendation: System templates for MVP, agent templates in P2.

3. **Flow step picker**: Include in MVP or defer?
   → Recommendation: Defer to P2 (complex nested structure).

4. **Snippet validation**: Pre-validate before insertion or rely on live parsing?
   → Recommendation: Rely on live parsing (immediate feedback via diagnostics).

---

## 14. Future Enhancements

- **AI-Powered Generation**: Natural language → DSL snippet (`/generate tool that fetches weather`)
- **Smart Suggestions**: Auto-suggest next construct when pressing Enter after last item
- **Snippet Marketplace**: Community-contributed templates and tools
- **Collaborative Editing**: Live cursors for team editing

---

**End of Design Document**
