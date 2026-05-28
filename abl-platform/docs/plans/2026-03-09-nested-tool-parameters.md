# Nested Tool Parameters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow ABL tool definitions to carry structured nested parameter schemas so the LLM receives full JSON Schema with field-level types, descriptions, and required flags — not just `{type: "object"}`.

**Architecture:** Extend the `parameters:` block syntax in agent DSL tool definitions to support per-parameter metadata (type, description, required) and nested `items:` blocks for array-of-object types. Data flows: DSL → Parser (ToolParam AST) → Compiler (ToolParameter IR) → Runtime (JSON Schema for LLM). The IR already supports `properties` and `items.properties` — the gap is in the parser and compiler layers.

**Tech Stack:** TypeScript, Vitest, ABL DSL parser (recursive descent), IR compiler

---

## Context

### The Bug

When an agent DSL defines `product_search(queries: object[])`, the LLM sees:

```json
{
  "name": "product_search",
  "input_schema": {
    "type": "object",
    "properties": { "queries": { "type": "array", "items": { "type": "object" } } }
  }
}
```

No field definitions inside `items` → LLM sends `queries: [{}, {}]` → tool call fails.

### Target DSL Syntax

```yaml
TOOLS:
  product_search(queries: object[]) -> {products: object[]}
    description: |
      Search for products across the retail platform.
    parameters:
      queries:
        type: object[]
        description: "Array of search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
          namespace:
            type: string
            description: "Target namespace (afg_products, afg_automobiles, afg_offers)"
            required: true
          filter:
            type: object
            description: "Optional filters (color, price, brand, gender)"
            required: false
```

### Target LLM Schema Output

```json
{
  "name": "product_search",
  "input_schema": {
    "type": "object",
    "properties": {
      "queries": {
        "type": "array",
        "description": "Array of search queries",
        "items": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Search text" },
            "namespace": {
              "type": "string",
              "description": "Target namespace (afg_products, afg_automobiles, afg_offers)"
            },
            "filter": {
              "type": "object",
              "description": "Optional filters (color, price, brand, gender)"
            }
          },
          "required": ["query", "namespace"]
        }
      }
    },
    "required": ["queries"]
  }
}
```

### Files Overview

| Layer             | File                                                           | Change                                   |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------- |
| AST types         | `packages/core/src/types/agent-based.ts:355-362`               | Add `properties`, `items` to `ToolParam` |
| Parser shared     | `packages/core/src/parser/tool-parser-utils.ts`                | No change (signature parsing stays flat) |
| Parser tool props | `packages/core/src/parser/tool-file-parser.ts:~300`            | Add `parameters:` block handler          |
| Compiler          | `packages/compiler/src/platform/ir/compiler.ts:667-704`        | Map `properties` + `items` through       |
| IR schema         | `packages/compiler/src/platform/ir/schema.ts:579-592`          | Already done (items.properties added)    |
| Runtime           | `apps/runtime/src/services/execution/prompt-builder.ts:97-120` | Already done (handles items.properties)  |
| Tests             | `packages/core/src/__tests__/tool-file-parser.test.ts`         | Add nested params test                   |
| Tests             | `packages/core/src/__tests__/agent-based-parser.test.ts`       | Add nested params in agent DSL test      |
| Tests             | `apps/runtime/src/__tests__/prompt-builder.test.ts`            | Add object[] with nested properties test |
| E2E               | `examples/afg-blue-advisory/agents/advisor_agent.agent.abl`    | Add parameters block                     |

---

### Task 1: Extend ToolParam AST type

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:355-362`

**Step 1: Add `properties` and `items` fields to `ToolParam`**

```typescript
export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
  validate?: string;
  /** Nested object fields — present when type is 'object' and parameters: block defines sub-fields */
  properties?: ToolParam[];
  /** Array item schema — present when type ends with '[]' and parameters: block defines items: */
  items?: { type: string; properties?: ToolParam[] };
}
```

**Step 2: Verify core package compiles**

Run: `pnpm --filter @abl/core build`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add packages/core/src/types/agent-based.ts
git commit -m "feat(core): extend ToolParam AST with properties and items for nested schemas"
```

---

### Task 2: Add `parameters:` block parser to tool-file-parser

**Files:**

- Modify: `packages/core/src/parser/tool-file-parser.ts` (inside `parseToolProperties` switch/case, around line 300)
- Test: `packages/core/src/__tests__/tool-file-parser.test.ts`

**Step 1: Write the failing test**

Add to `tool-file-parser.test.ts`:

```typescript
it('parses parameters: block with nested items for object[] type', () => {
  const input = `
TOOL: product_search
VERSION: "1.0"
DESCRIPTION: "Search products"
TYPE: sandbox
RUNTIME: javascript

product_search(queries: object[]) -> {results: object[]}
  description: "Search for products"
  parameters:
    queries:
      type: object[]
      description: "Array of search queries"
      required: true
      items:
        query:
          type: string
          description: "Search text"
          required: true
        namespace:
          type: string
          description: "Target namespace"
          required: true
        filter:
          type: object
          description: "Optional filters"
          required: false

  CODE: |
    return {};
`;
  const result = parseToolFile(input);
  expect(result.errors).toHaveLength(0);
  const tool = result.tools[0];

  // Signature params should be enriched with nested schema
  const queriesParam = tool.parameters.find((p) => p.name === 'queries');
  expect(queriesParam).toBeDefined();
  expect(queriesParam!.type).toBe('object[]');
  expect(queriesParam!.description).toBe('Array of search queries');
  expect(queriesParam!.items).toBeDefined();
  expect(queriesParam!.items!.properties).toHaveLength(3);

  const queryField = queriesParam!.items!.properties!.find((p) => p.name === 'query');
  expect(queryField).toEqual({
    name: 'query',
    type: 'string',
    description: 'Search text',
    required: true,
  });

  const filterField = queriesParam!.items!.properties!.find((p) => p.name === 'filter');
  expect(filterField!.required).toBe(false);
});

it('parses parameters: block with flat object properties', () => {
  const input = `
TOOL: get_user
VERSION: "1.0"
DESCRIPTION: "Get user"
TYPE: http
ENDPOINT: "https://api.example.com/users"
METHOD: GET

get_user(filters: object) -> {user: object}
  parameters:
    filters:
      type: object
      description: "Filter criteria"
      required: true
      properties:
        name:
          type: string
          description: "User name"
          required: false
        age:
          type: integer
          description: "User age"
          required: false

  CODE: |
    return {};
`;
  const result = parseToolFile(input);
  expect(result.errors).toHaveLength(0);
  const tool = result.tools[0];

  const filtersParam = tool.parameters.find((p) => p.name === 'filters');
  expect(filtersParam).toBeDefined();
  expect(filtersParam!.properties).toHaveLength(2);
  expect(filtersParam!.properties![0]).toEqual({
    name: 'name',
    type: 'string',
    description: 'User name',
    required: false,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @abl/core test -- --run tool-file-parser`
Expected: FAIL — `items` / `properties` are undefined

**Step 3: Implement `parameters:` block handler in `parseToolProperties`**

In `packages/core/src/parser/tool-file-parser.ts`, inside the `switch (key.toLowerCase())` block (around line 295), add a new case before the default:

```typescript
case 'parameters': {
  // Parse nested parameter metadata block
  // Structure:
  //   parameters:
  //     paramName:
  //       type: string
  //       description: "..."
  //       required: true
  //       items:          (for object[] types — defines fields of each array item)
  //         fieldName:
  //           type: string
  //           ...
  //       properties:     (for object types — defines nested fields)
  //         fieldName:
  //           type: string
  //           ...
  const paramsIndent = indent;
  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const paramLine = state.lines[state.currentLine];
    const paramTrimmed = paramLine.trim();
    const paramIndentLevel = getIndent(paramLine);

    // Exit if we're back at or above the parameters: indent level
    if (paramTrimmed && paramIndentLevel <= paramsIndent) break;
    if (!paramTrimmed) { state.currentLine++; continue; }

    // Match parameter name line: "    paramName:"
    const paramNameMatch = paramTrimmed.match(/^(\w+):\s*$/);
    if (paramNameMatch) {
      const paramName = paramNameMatch[1];
      const paramBlockIndent = paramIndentLevel;
      state.currentLine++;

      // Parse sub-keys for this parameter
      let paramType: string | undefined;
      let paramDesc: string | undefined;
      let paramRequired: boolean | undefined;
      let itemsFields: ToolParam[] | undefined;
      let nestedProperties: ToolParam[] | undefined;

      while (state.currentLine < state.lines.length) {
        const subLine = state.lines[state.currentLine];
        const subTrimmed = subLine.trim();
        const subIndent = getIndent(subLine);

        if (subTrimmed && subIndent <= paramBlockIndent) break;
        if (!subTrimmed) { state.currentLine++; continue; }

        const subMatch = subTrimmed.match(/^(\w+):\s*(.*)$/);
        if (subMatch) {
          const [, subKey, subValue] = subMatch;
          switch (subKey.toLowerCase()) {
            case 'type':
              paramType = stripQuotes(subValue);
              break;
            case 'description':
              if (subValue.trim() === '|') {
                // Collect multiline description
                const descLines: string[] = [];
                const descBlockIndent = subIndent;
                while (state.currentLine + 1 < state.lines.length) {
                  const nextLine = state.lines[state.currentLine + 1];
                  const nextTrimmed = nextLine.trim();
                  const nextIndent = getIndent(nextLine);
                  if (nextTrimmed && nextIndent <= descBlockIndent) break;
                  descLines.push(nextTrimmed || '');
                  state.currentLine++;
                }
                paramDesc = descLines.join('\n').trim();
              } else {
                paramDesc = stripQuotes(subValue);
              }
              break;
            case 'required':
              paramRequired = subValue.trim().toLowerCase() === 'true';
              break;
            case 'items':
            case 'properties': {
              // Parse nested field definitions
              const nestedFields: ToolParam[] = [];
              const nestedBlockIndent = subIndent;
              state.currentLine++;

              while (state.currentLine < state.lines.length) {
                const fieldLine = state.lines[state.currentLine];
                const fieldTrimmed = fieldLine.trim();
                const fieldIndent = getIndent(fieldLine);

                if (fieldTrimmed && fieldIndent <= nestedBlockIndent) break;
                if (!fieldTrimmed) { state.currentLine++; continue; }

                // Match field name: "          fieldName:"
                const fieldNameMatch = fieldTrimmed.match(/^(\w+):\s*$/);
                if (fieldNameMatch) {
                  const fieldName = fieldNameMatch[1];
                  const fieldBlockIndent = fieldIndent;
                  state.currentLine++;

                  let fType = 'string';
                  let fDesc: string | undefined;
                  let fRequired = false;

                  while (state.currentLine < state.lines.length) {
                    const fLine = state.lines[state.currentLine];
                    const fTrimmed = fLine.trim();
                    const fIndent = getIndent(fLine);

                    if (fTrimmed && fIndent <= fieldBlockIndent) break;
                    if (!fTrimmed) { state.currentLine++; continue; }

                    const fMatch = fTrimmed.match(/^(\w+):\s*(.+)$/);
                    if (fMatch) {
                      switch (fMatch[1].toLowerCase()) {
                        case 'type': fType = stripQuotes(fMatch[2]); break;
                        case 'description': fDesc = stripQuotes(fMatch[2]); break;
                        case 'required': fRequired = fMatch[2].trim().toLowerCase() === 'true'; break;
                      }
                    }
                    state.currentLine++;
                  }

                  nestedFields.push({
                    name: fieldName,
                    type: fType,
                    description: fDesc,
                    required: fRequired,
                  });
                } else {
                  state.currentLine++;
                }
              }

              if (subKey.toLowerCase() === 'items') {
                itemsFields = nestedFields;
              } else {
                nestedProperties = nestedFields;
              }
              continue; // Don't increment — inner loop already advanced
            }
          }
        }
        state.currentLine++;
      }

      // Find and enrich the matching signature parameter
      const sigParam = result.parameters?.find(p => p.name === paramName);
      if (sigParam) {
        if (paramType) sigParam.type = paramType;
        if (paramDesc) sigParam.description = paramDesc;
        if (paramRequired !== undefined) sigParam.required = paramRequired;
        if (itemsFields && itemsFields.length > 0) {
          sigParam.items = { type: 'object', properties: itemsFields };
        }
        if (nestedProperties && nestedProperties.length > 0) {
          sigParam.properties = nestedProperties;
        }
      }
      continue; // Don't increment — inner loop already advanced
    }

    state.currentLine++;
  }
  continue; // Don't increment — the block parser already advanced past
}
```

**Important:** The `parameters:` block **enriches** the params already parsed from the signature. It doesn't replace them. Params not mentioned in the block keep their signature-inferred values.

**Step 4: Run tests**

Run: `pnpm --filter @abl/core test -- --run tool-file-parser`
Expected: All tests PASS including new ones

**Step 5: Commit**

```bash
git add packages/core/src/parser/tool-file-parser.ts packages/core/src/__tests__/tool-file-parser.test.ts
git commit -m "feat(core): add parameters: block parser for nested tool parameter schemas"
```

---

### Task 3: Wire `parameters:` parsing into agent-based-parser

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts` (around line 2039-2050)
- Test: `packages/core/src/__tests__/agent-based-parser.test.ts`

The `parseToolProperties` function from `tool-file-parser.ts` is already called at line 2039 for agent DSL tools. The `parameters` property is NOT in `TOOL_IMPLEMENTATION_PROPERTIES` (line 82-101), so it won't be rejected.

**Step 1: Write the failing test**

Add to `agent-based-parser.test.ts` (find the TOOLS section tests):

```typescript
it('parses parameters: block with nested items in agent DSL', () => {
  const dsl = `
AGENT: TestAgent
VERSION: "1.0"
DESCRIPTION: "Test"
GOAL: "Test nested params"

TOOLS:
  search(queries: object[]) -> {results: object[]}
    description: "Search with structured queries"
    parameters:
      queries:
        type: object[]
        description: "Array of search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
          namespace:
            type: string
            description: "Target namespace"
            required: true

FLOW:
  STEP main:
    ACTION: respond
`;
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);

  const tool = result.document.tools[0];
  expect(tool.name).toBe('search');
  expect(tool.description).toBe('Search with structured queries');

  const queriesParam = tool.parameters[0];
  expect(queriesParam.name).toBe('queries');
  expect(queriesParam.description).toBe('Array of search queries');
  expect(queriesParam.items).toBeDefined();
  expect(queriesParam.items!.properties).toHaveLength(2);
  expect(queriesParam.items!.properties![0].name).toBe('query');
  expect(queriesParam.items!.properties![1].name).toBe('namespace');
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @abl/core test -- --run agent-based-parser -t "nested items"`
Expected: FAIL — items is undefined

**Step 3: Verify parseToolProperties is already wired**

Check that `parseToolProperties` at line 2039 receives the `result` object that includes `parameters` from the signature. The `parameters:` case handler from Task 2 enriches `result.parameters` — confirm this is the same object.

In `agent-based-parser.ts` lines 2039-2050:

```typescript
const props = parseToolProperties(state, toolIndent);
if (props.hints) tool.hints = props.hints;
if (props.type) tool.type = props.type;
if (props.description) tool.description = props.description;
```

The `parseToolProperties` function receives `state` and `indent`. It needs access to the parsed signature parameters to enrich them. Check if the `result` variable inside `parseToolProperties` carries the parameters.

**Potential issue:** `parseToolProperties` builds its own `result` object and returns it. The `parameters:` block needs to enrich the tool's `.parameters` array. We need to either:

- Pass the existing `tool.parameters` into `parseToolProperties`, OR
- Return enriched parameters from `parseToolProperties` and merge them in the caller

**Step 3a: Modify `parseToolProperties` to accept and return parameter enrichments**

In `tool-file-parser.ts`, the function signature is:

```typescript
export function parseToolProperties(state: ParserState, baseIndent: number): ToolProperties;
```

Where `ToolProperties` is the return type. We need `parseToolProperties` to receive the signature-parsed parameters and enrich them.

Update the function signature:

```typescript
export function parseToolProperties(
  state: ParserState,
  baseIndent: number,
  signatureParams?: ToolParam[],
): ToolProperties;
```

In the `parameters:` case handler, reference `signatureParams` instead of `result.parameters`.

Then in `agent-based-parser.ts` line 2039:

```typescript
const props = parseToolProperties(state, toolIndent, tool.parameters);
```

**Step 4: Run tests**

Run: `pnpm --filter @abl/core test -- --run agent-based-parser -t "nested items"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/parser/tool-file-parser.ts packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/agent-based-parser.test.ts
git commit -m "feat(core): wire parameters: block parsing into agent DSL tool definitions"
```

---

### Task 4: Propagate nested params through the compiler

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:667-678`
- Test: `packages/compiler/src/__tests__/` (find compiler tests for tools)

**Step 1: Write the failing test**

Find the compiler test file and add:

```typescript
it('compiles tool parameters with nested properties and items', () => {
  const dsl = `
AGENT: TestAgent
VERSION: "1.0"
DESCRIPTION: "Test"
GOAL: "Test"

TOOLS:
  search(queries: object[], config: object) -> {results: object[]}
    parameters:
      queries:
        type: object[]
        description: "Search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
      config:
        type: object
        description: "Config object"
        properties:
          limit:
            type: integer
            description: "Max results"
            required: false

FLOW:
  STEP main:
    ACTION: respond
`;
  const ir = compileABLtoIR(parseAgentBasedABL(dsl).document);
  const tool = ir.tools.find((t) => t.name === 'search')!;

  const queriesParam = tool.parameters.find((p) => p.name === 'queries')!;
  expect(queriesParam.items).toBeDefined();
  expect(queriesParam.items!.properties).toHaveLength(1);
  expect(queriesParam.items!.properties![0].name).toBe('query');

  const configParam = tool.parameters.find((p) => p.name === 'config')!;
  expect(configParam.properties).toBeDefined();
  expect(configParam.properties).toHaveLength(1);
  expect(configParam.properties![0].name).toBe('limit');
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — items/properties not propagated

**Step 3: Update `compileTools` to propagate nested fields**

In `packages/compiler/src/platform/ir/compiler.ts`, update the parameter mapping (lines 671-678):

```typescript
parameters: tool.parameters.map((p) => ({
  name: p.name,
  type: p.type,
  description: p.description,
  required: p.required,
  default: p.default,
  validation: p.validate,
  // Propagate nested properties for object types
  properties: p.properties?.map(compileToolParam),
  // Propagate array item schema for object[] types
  items: p.items ? {
    type: p.items.type || 'object',
    properties: p.items.properties?.map(compileToolParam),
  } : undefined,
})),
```

Add helper function:

```typescript
function compileToolParam(p: ToolParam): ToolParameter {
  return {
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required,
    default: p.default,
    validation: p.validate,
    properties: p.properties?.map(compileToolParam),
    items: p.items
      ? {
          type: p.items.type || 'object',
          properties: p.items.properties?.map(compileToolParam),
        }
      : undefined,
  };
}
```

**Step 4: Run tests**

Run: `pnpm --filter @abl/compiler test -- --run`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/...
git commit -m "feat(compiler): propagate nested tool parameter schemas through IR compilation"
```

---

### Task 5: Add prompt-builder test for nested array item schemas

**Files:**

- Modify: `apps/runtime/src/__tests__/prompt-builder.test.ts`

**Step 1: Add test for object[] with items.properties**

```typescript
it('maps "object[]" with items.properties to array with nested object schema', () => {
  const param = {
    name: 'queries',
    type: 'object[]',
    required: true,
    items: {
      type: 'object',
      properties: [
        { name: 'query', type: 'string', description: 'Search text', required: true },
        { name: 'namespace', type: 'string', description: 'Target namespace', required: true },
        { name: 'filter', type: 'object', description: 'Optional filters', required: false },
      ],
    },
  };

  expect(ablTypeToJsonSchema('object[]', 'Array of queries', param)).toEqual({
    type: 'array',
    description: 'Array of queries',
    items: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        namespace: { type: 'string', description: 'Target namespace' },
        filter: { type: 'object', description: 'Optional filters' },
      },
      required: ['query', 'namespace'],
    },
  });
});

it('maps "object" with properties to object with nested schema', () => {
  const param = {
    name: 'config',
    type: 'object',
    required: true,
    properties: [
      { name: 'limit', type: 'integer', description: 'Max results', required: false },
      { name: 'offset', type: 'integer', description: 'Skip count', required: false },
    ],
  };

  expect(ablTypeToJsonSchema('object', 'Configuration', param)).toEqual({
    type: 'object',
    description: 'Configuration',
    properties: {
      limit: { type: 'integer', description: 'Max results' },
      offset: { type: 'integer', description: 'Skip count' },
    },
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/prompt-builder.test.ts`
Expected: All PASS (the prompt-builder code was already updated)

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/prompt-builder.test.ts
git commit -m "test(runtime): add prompt-builder tests for nested tool parameter schemas"
```

---

### Task 6: Update AFG advisor agent DSL with nested parameters

**Files:**

- Modify: `examples/afg-blue-advisory/agents/advisor_agent.agent.abl`
- Modify: `examples/afg-blue-advisory/agents/store_policy_agent.agent.abl`

**Step 1: Add parameters block to advisor agent's product_search tool**

After the `description: |` block, add:

```yaml
parameters:
  queries:
    type: object[]
    description: 'Array of search queries to execute in parallel'
    required: true
    items:
      query:
        type: string
        description: "Natural language search text (e.g. 'red sneakers for men')"
        required: true
      namespace:
        type: string
        description: "Pinecone namespace: 'afg_products' for retail, 'afg_automobiles' for cars, 'afg_offers' for offers/deals"
        required: true
      filter:
        type: object
        description: 'Optional metadata filters (color, price, brand, gender, category, isPreOwned)'
        required: false
```

**Step 2: Add parameters block to store_policy_agent's policy_search tool**

```yaml
parameters:
  query:
    type: string
    description: "Natural language policy question (e.g. 'what is the return policy for clothing?')"
    required: true
```

**Step 3: Verify compilation**

Run: `node examples/afg-blue-advisory/compile-check.mjs`
Expected: All 3 agents parse and compile without errors

**Step 4: Commit**

```bash
git add examples/afg-blue-advisory/agents/
git commit -m "feat(examples): add nested parameter schemas to AFG Blue Advisory tool definitions"
```

---

### Task 7: Run full E2E suite and verify tool calls have proper parameters

**Step 1: Rebuild all packages**

```bash
pnpm --filter @abl/core build && pnpm --filter @abl/compiler build
```

**Step 2: Run the AFG E2E tests**

```bash
npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
```

**Step 3: Verify in run report**

Check `afg-run-report.json` for:

- `product_search` called with `queries: [{query: "...", namespace: "..."}]` (NOT `[{}]`)
- `policy_search` called with `query: "..."` (NOT empty)
- All 7 tests PASS
- No tool_call_retry events caused by empty parameters

**Step 4: Compare timing against baseline**

| Scenario       | Kore.ai Baseline | ABL Runtime | Target |
| -------------- | ---------------- | ----------- | ------ |
| Greeting       | ~2s              | ~4s         | < 5s   |
| Product Search | ~3s              | TBD         | < 8s   |
| Guard Rail     | ~2s              | ~4s         | < 5s   |

---

### Task 8: Run existing test suites to verify no regressions

**Step 1: Run core parser tests**

```bash
pnpm --filter @abl/core test -- --run
```

Expected: All ~3,947 tests PASS

**Step 2: Run compiler tests**

```bash
pnpm --filter @abl/compiler test -- --run
```

Expected: All tests PASS

**Step 3: Run runtime tests (subset — prompt-builder + executor)**

```bash
npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/prompt-builder.test.ts apps/runtime/src/__tests__/executor-integration.test.ts
```

Expected: All PASS
