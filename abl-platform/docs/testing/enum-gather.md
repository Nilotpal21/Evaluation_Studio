# Feature Test Guide: Enum Gather Fields

**Feature**: Enum type support for GATHER fields in ABL DSL — constrained-value fields with validation and Studio UI
**Owner**: Platform Team
**Branch**: KI0326/feature/enum
**First tested**: 2026-03-25
**Last updated**: 2026-03-25
**Overall status**: STABLE

---

## Current State (as of 2026-03-25)

The enum gather feature is working end-to-end through the parser, compiler, runtime, and Studio UI. DSL files with `type: enum` and `options: [...]` parse correctly, compile to IR with `enum_values` and `validation` rules, and execute in the runtime's gather system. The LLM correctly extracts enum values from natural language, maps close approximations to valid options (e.g., "gigantic" -> "extra_large"), and rejects completely invalid values (e.g., "blue") by re-prompting with the valid options. The Studio GatherEditor displays enum tag pills correctly, supports adding values via Enter, removing via X button and Backspace, and discarding changes.

### Quick Health Dashboard

| Area                      | Status | Last Verified | Notes                                           |
| ------------------------- | ------ | ------------- | ----------------------------------------------- |
| Parser (DSL -> AST)       | PASS   | 2026-03-25    | `options` parsed into `string[]`                |
| Compiler (AST -> IR)      | PASS   | 2026-03-25    | `enum_values`, `validation.type=enum` emitted   |
| Runtime Gather Execution  | PASS   | 2026-03-25    | Enum fields extracted correctly via LLM         |
| Enum Validation (valid)   | PASS   | 2026-03-25    | Valid values accepted, close matches mapped     |
| Enum Validation (invalid) | PASS   | 2026-03-25    | Invalid values rejected, agent re-prompts       |
| Multi-field extraction    | PASS   | 2026-03-25    | All 4 fields extracted in single turn           |
| Studio GatherEditor UI    | PASS   | 2026-03-25    | Enum tags render, add/remove/backspace all work |
| UI Browser Test           | PASS   | 2026-03-25    | Playwright verified all tag interactions        |
| Unit Tests                | ---    | Not tested    | Test files exist but not run in this iteration  |

---

## Test Coverage Map

### Parser Tests

- [x] Parse `type: enum` field — `Iteration 1 (2026-03-25) PASS`
- [x] Parse `options: [val1, val2, ...]` into string array — `Iteration 1 (2026-03-25) PASS`
- [x] Enum field coexists with string/number fields — `Iteration 1 (2026-03-25) PASS`
- [ ] Empty options array — `Not tested`
- [ ] Options with special characters — `Not tested`
- [ ] Options with spaces — `Not tested`

### Compiler Tests

- [x] Emit `enum_values` array in IR — `Iteration 1 (2026-03-25) PASS`
- [x] Emit `validation.type = "enum"` — `Iteration 1 (2026-03-25) PASS`
- [x] Emit `validation.rule` as pipe-separated values — `Iteration 1 (2026-03-25) PASS`
- [x] Emit `validation.error_message` with field name and allowed values — `Iteration 1 (2026-03-25) PASS`
- [x] `extraction_hints` includes prompt — `Iteration 1 (2026-03-25) PASS`
- [ ] Non-enum field has no `enum_values` — `Not tested`
- [ ] Enum field with no options falls back gracefully — `Not tested`

### Runtime Gather Execution Tests

- [x] Valid enum value extracted from natural language — `Iteration 1 (2026-03-25) PASS`
- [x] Close approximation mapped to valid value ("gigantic" -> "extra_large") — `Iteration 1 (2026-03-25) PASS`
- [x] Completely invalid value rejected, agent re-prompts — `Iteration 1 (2026-03-25) PASS`
- [x] Multiple enum fields in same gather step — `Iteration 1 (2026-03-25) PASS`
- [x] All fields extracted in single turn — `Iteration 1 (2026-03-25) PASS`
- [x] Gather progress tracks enum values correctly — `Iteration 1 (2026-03-25) PASS`
- [ ] Enum field with default value — `Not tested`
- [ ] Enum field that is optional (not required) — `Not tested`

### Studio UI Tests

- [x] EnumTagInput component exists with tag-style pills — `Iteration 1 (2026-03-25) PASS`
- [x] Conditional render when `field.type === 'enum'` — `Iteration 1 (2026-03-25) PASS`
- [x] Add enum value via Enter key — `Iteration 1 (2026-03-25) PASS` — added "personal", appeared as pill
- [ ] Add enum value via comma — `Not tested`
- [x] Remove enum value via Backspace — `Iteration 1 (2026-03-25) PASS` — removed "extra_large" from end
- [x] Remove enum value via X button — `Iteration 1 (2026-03-25) PASS` — removed "personal" via X
- [x] Type dropdown shows "enum" — `Iteration 1 (2026-03-25) PASS` — visible in expanded field
- [x] Enum values display as styled tag pills — `Iteration 1 (2026-03-25) PASS`
- [x] Validation section shows auto-generated enum rule — `Iteration 1 (2026-03-25) PASS`
- [x] Discard button reverts unsaved enum changes — `Iteration 1 (2026-03-25) PASS`

### Integration / Edge Cases

- [ ] Enum field in multi-agent handoff — `Not tested`
- [ ] Deployment with enum fields — `Not tested`
- [ ] Concurrent sessions with enum gather — `Not tested`

---

## Open Gaps

- **GAP-002**: Unit test files not executed
  - **Severity**: Low
  - **Reason**: Test files exist in packages but were not run during this iteration

---

## Pending / Future Work

- [ ] Run unit tests: `packages/compiler/src/__tests__/gather-enum-compilation.test.ts`
- [ ] Run unit tests: `packages/core/src/__tests__/parser-enum-options.test.ts`
- [ ] Test enum in deployment pipeline (compile -> snapshot -> serve)
- [ ] Test enum field with `default` value
- [ ] Test optional enum field (required: false)
- [ ] Test enum options with spaces or special characters
- [ ] Browser UI test: full GatherEditor enum workflow

---

## Enhancement Ideas

- **ENH-001** (Iteration 1): Consider adding `multi_select` enum type (allow multiple values from options)
- **ENH-002** (Iteration 1): Studio could show a preview of enum validation rules in the agent editor

---

## Iteration Log

### Iteration 1 — 2026-03-25

**Scope**: Full end-to-end enum feature: parser, compiler IR, runtime gather, Studio UI code review
**Branch**: KI0326/feature/enum
**Duration**: ~1hr
**Tested by**: Claude Code (agent)

#### Setup

- Project: `019d1f7c-3fdc-7115-8669-0fd344b44de0`
- Agent: `pizza_order_bot` (ID: `019d1f83-ce75-7edf-9d8a-7a91302e3675`)
- Tenant: `tenant-dev-001`
- LLM: OpenAI gpt-4o (credential: `019d1fb0-daec-794e-8a99-3c1658111dc2`)

#### DSL Under Test

```
AGENT: pizza_order_bot
GATHER:
  pizza_size:
    type: enum
    prompt: What size pizza would you like?
    options: [small, medium, large, extra_large]
    required: true
  crust_type:
    type: enum
    prompt: What type of crust?
    options: [thin, regular, thick, stuffed]
    required: true
  customer_name:
    type: string
    prompt: What is your name?
    required: true
  quantity:
    type: number
    prompt: How many pizzas?
    required: true
    default: 1
FLOW:
  collect_order:
    GATHER: pizza_size, crust_type, customer_name, quantity
    REASONING: true
  confirm_order:
    RESPOND: "Order confirmed!"
    REASONING: false
```

#### Results

| #   | Test                                | Method                          | Expected                               | Actual                                                        | Status |
| --- | ----------------------------------- | ------------------------------- | -------------------------------------- | ------------------------------------------------------------- | ------ |
| 1   | Parse enum type + options           | Node script: parseAgentBasedABL | options: ["small","medium",...]        | options: ["small","medium","large","extra_large"]             | PASS   |
| 2   | Compile to IR with enum_values      | Node script: compileABLtoIR     | enum_values array in IR                | enum_values: ["small","medium","large","extra_large"]         | PASS   |
| 3   | Compile validation rule             | Node script: compileABLtoIR     | validation.rule = "small\|medium\|..." | "small\|medium\|large\|extra_large"                           | PASS   |
| 4   | Runtime: valid enum "large"         | POST /api/v1/chat/agent         | gatherProgress.pizza_size = "large"    | pizza_size: "large"                                           | PASS   |
| 5   | Runtime: valid enum "stuffed"       | POST /api/v1/chat/agent         | gatherProgress.crust_type = "stuffed"  | crust_type: "stuffed"                                         | PASS   |
| 6   | Runtime: close match "gigantic"     | POST /api/v1/chat/agent         | Maps to "extra_large"                  | pizza_size: "extra_large"                                     | PASS   |
| 7   | Runtime: invalid "blue"             | POST /api/v1/chat/agent         | Rejected, re-prompt with options       | "Here are the options: small, medium..."                      | PASS   |
| 8   | Runtime: all fields in one turn     | POST /api/v1/chat/agent         | All 4 fields gathered                  | pizza_size, crust_type, customer_name, quantity all populated | PASS   |
| 9   | Studio: EnumTagInput component      | Code review                     | Tag input with pills, add/remove       | Component at GatherEditor.tsx:72-144                          | PASS   |
| 10  | Studio: conditional render for enum | Code review                     | Shows when type === 'enum'             | Conditional at GatherEditor.tsx:723                           | PASS   |

#### Compiled IR Output (proof)

```json
{
  "name": "pizza_size",
  "type": "enum",
  "enum_values": ["small", "medium", "large", "extra_large"],
  "validation": {
    "type": "enum",
    "rule": "small|medium|large|extra_large",
    "error_message": "Invalid pizza_size. Allowed values: small, medium, large, extra_large"
  },
  "required": true,
  "extraction_hints": ["What size pizza would you like? (small, medium, large, or extra_large)"]
}
```

#### UI Test Results (Playwright)

| #   | Test                                 | Method                    | Expected                              | Actual                                                                                | Status |
| --- | ------------------------------------ | ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| 11  | Gather Fields page shows 4 fields    | Navigate to Gather Fields | 4 fields with enum/string/number tags | 4 fields: pizza_size(enum), crust_type(enum), customer_name(string), quantity(number) | PASS   |
| 12  | Expand pizza_size shows enum details | Click expand arrow        | Type=enum, tag pills, validation      | All shown correctly                                                                   | PASS   |
| 13  | Add "personal" via Enter             | Type + Enter in tag input | New tag pill appears                  | "personal" pill added, form marked Unsaved                                            | PASS   |
| 14  | Remove "personal" via X button       | Click X on "personal" tag | Tag removed                           | "personal" pill removed                                                               | PASS   |
| 15  | Remove "extra_large" via Backspace   | Focus input + Backspace   | Last tag removed                      | "extra_large" pill removed                                                            | PASS   |
| 16  | Discard reverts changes              | Click Discard button      | Original 4 tags restored              | Reverted to saved state                                                               | PASS   |

#### Gaps Found

- **GAP-002**: Unit test files not executed

---

## Test Environment

- Runtime: localhost:3112 (PM2, fork mode, `abl-runtime`)
- Studio: localhost:5173 (PM2, Next.js dev, `abl-studio`)
- MongoDB: localhost:27018 (Docker, auth: abl_admin/abl_dev_password)
- LLM: OpenAI gpt-4o via encrypted credential
- Test project: `019d1f7c-3fdc-7115-8669-0fd344b44de0`
