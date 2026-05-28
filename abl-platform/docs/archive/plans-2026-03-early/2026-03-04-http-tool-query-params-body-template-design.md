# HTTP Tool: Query Parameters, Body Template & Input Placeholder Resolution

**Date**: 2026-03-04
**Status**: Draft
**Scope**: Fix HTTP tool binding pipeline — query_params dropped, body template missing, `{{input.X}}` never resolved

---

## Motivation

The Studio UI exposes four placeholder types for HTTP tool configuration:

- `{{input.paramName}}` — tool call arguments from the LLM
- `{{secrets.KEY_NAME}}` — project secrets
- `{{env.KEY}}` — environment variables
- `{{memory.variable}}` / `{{context.X}}` — future (out of scope)

Three bugs prevent these from working:

### Bug 1: Query params silently dropped

The `query_params:` block in Studio UI is serialized to DSL and parsed back for form round-trips, but the compilation pipeline (AST → IR → runtime) has no field for it. Query params never reach the HTTP executor.

**Break point**: `HttpBindingAST` and `HttpBindingIR` both lack a `queryParams` / `query_params` field. `compileHttpBinding()` and `buildHttpBindingFromProps()` never copy it.

### Bug 2: Body template not supported

The Studio UI has a body template editor with `{{input.X}}` placeholders (JSON, form-encoded, XML, text). But `HttpToolFormData` in `packages/shared` has no `body` field, so the template is never serialized to DSL, never compiled, and never reaches runtime.

The runtime only auto-serializes remaining LLM params as `JSON.stringify(paramsCopy)` for non-GET — no template interpolation.

### Bug 3: `{{input.X}}` never resolved

`resolvePlaceholders()` in `http-tool-executor.ts` only handles `{{secrets.X}}` and `{{env.X}}`. The `{{input.X}}` pattern (documented in the Studio UI) is silently left as a literal string in headers, endpoint, query params, and body.

---

## Cross-Tool Ecosystem Audit

Before scoping the fix, all five tool types were reviewed:

| Tool Type     | Needs Fix? | Rationale                                                                                                           |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| **HTTP**      | **YES**    | Static binding config (endpoint, headers, query_params, body) requires dynamic value injection                      |
| **Sandbox**   | No         | User code directly accesses params as `$paramName` (JS) or `paramName` (Python). No config-level templates          |
| **MCP**       | No         | Params pass directly to MCP server's `callTool()`. Server credentials use encrypted blobs. Different security model |
| **Connector** | No         | Params pass to connector SDK's `action.run()`. Auth from stored encrypted connections                               |
| **Workflow**  | No         | Uses explicit `paramMapping` for param renaming. No interpolation needed                                            |

**Sandbox parameter convention** (verified against agenticai repo):

- JavaScript: `$` prefix (`$income`, `$data`) — added by `preprocessParams()` in both gvisor and lambda runners
- Python: bare names (`income`, `data`) — injected as `exec_globals` entries
- Both repos are consistent. No change needed.

---

## Design

### Layer 1: Types — Add missing fields

**`packages/core/src/types/agent-based.ts`** — `HttpBindingAST`:

```typescript
export interface HttpBindingAST {
  // ... existing fields ...
  queryParams?: Record<string, string>;
  bodyTemplate?: string;
}
```

**`packages/compiler/src/platform/ir/schema.ts`** — `HttpBindingIR`:

```typescript
export interface HttpBindingIR {
  // ... existing fields ...
  query_params?: Record<string, string>;
  body_template?: string;
}
```

**`packages/shared/src/tools/dsl-property-parser.ts`** — `HttpBindingIRLocal`:

```typescript
export interface HttpBindingIRLocal {
  // ... existing fields ...
  query_params?: Record<string, string>;
  body_template?: string;
}
```

### Layer 2: Parsing — Thread fields through pipeline

**`packages/shared/src/tools/dsl-property-parser.ts`** — `buildHttpBindingFromProps()`:

```typescript
// After existing headers parsing block:
const qpEntries = parseDslNestedBlock(dslContent, 'query_params');
if (qpEntries.length > 0) {
  binding.query_params = {};
  for (const { key, value } of qpEntries) {
    binding.query_params[key] = value;
  }
}

const bodyTemplate = extractPipeBlock(dslContent, 'body');
if (bodyTemplate) {
  binding.body_template = bodyTemplate;
}
```

**`packages/core/src/parser/tool-file-parser.ts`** — `parseToolProperties()`:

- Add `queryParams` variable alongside existing `headers`
- Handle `query_params` bare block key (same pattern as `headers:`)
- Include `queryParams` in `result.httpBinding`
- Handle `body` pipe block (same pattern as `code:`)
- Include `bodyTemplate` in `result.httpBinding`

**`packages/compiler/src/platform/ir/compiler.ts`** — `compileHttpBinding()`:

```typescript
return {
  // ... existing fields ...
  query_params: ast.queryParams,
  body_template: ast.bodyTemplate,
};
```

### Layer 3: DSL Serialization — Add body template

**`packages/shared/src/tools/serialize-tool-form-to-dsl.ts`**:

- `query_params:` block already serialized (lines 103-108) ✓
- Add `body:` pipe block serialization after query_params

**`packages/shared/src/tools/parse-dsl-to-tool-form.ts`**:

- `query_params` already parsed back (lines 293-298) ✓
- Add `body:` pipe block parsing via `extractPipeBlock()`

**`packages/shared/src/types/project-tool-form.ts`** — `HttpToolFormData`:

```typescript
export interface HttpToolFormData extends ToolFormBase {
  // ... existing fields ...
  body?: string; // Body template with {{input.X}} / {{secrets.X}} placeholders
}
```

### Layer 4: Runtime Execution — The critical fix

**`packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`**:

**4a. Add `{{input.X}}` resolver:**

```typescript
private resolveInputPlaceholders(
  value: string,
  params: Record<string, unknown>,
  consumeKeys?: Set<string>,
): string {
  return value.replace(/\{\{input\.(\w+)\}\}/g, (match, key) => {
    const val = params[key];
    if (val === undefined || val === null) return '';
    if (consumeKeys) consumeKeys.add(key);
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
}
```

**4b. Extend `resolvePlaceholders()` to accept params:**

```typescript
private async resolvePlaceholders(
  value: string,
  params?: Record<string, unknown>,
  consumeKeys?: Set<string>,
): Promise<string> {
  let result = await this.resolveSecrets(value);
  result = await this.resolveEnvVars(result);
  if (params) {
    result = this.resolveInputPlaceholders(result, params, consumeKeys);
  }
  return result;
}
```

**4c. Updated `buildRequest()` flow:**

```
1. Clone params → paramsCopy, create consumedKeys set
2. Resolve headers ({{secrets.X}}, {{env.X}}, {{input.X}}) — consumed keys tracked
3. Apply auth headers
4. Resolve endpoint URL ({{env.X}}, {{input.X}}) — consumed keys tracked
5. Substitute path params {param} (delete from paramsCopy)
6. [NEW] Resolve binding-level query_params and append to URL (all methods)
   - Each value resolved for {{secrets.X}}, {{env.X}}, {{input.X}}
   - Consumed keys tracked
7. For GET without body_template: append remaining paramsCopy as query string
8. SSRF validation on final URL
9. [NEW] If body_template exists (non-GET):
   - Resolve {{input.X}}, {{secrets.X}}, {{env.X}} in template
   - Use resolved template as body (respect Content-Type from headers)
10. Else for non-GET: delete consumed keys from paramsCopy, JSON.stringify remainder
```

Key detail: `consumedKeys` tracks which `{{input.X}}` params were used in headers, endpoint, query_params, or body_template. These are deleted from `paramsCopy` before step 10 to prevent double-inclusion in the auto-serialized body.

### Layer 5: Tests

**`packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`**:

- POST with `query_params` containing `{{secrets.API_KEY}}` — verify query string on URL
- GET with `query_params` containing `{{input.search}}` — verify query string + param consumed
- POST with `body_template` containing `{{input.X}}` — verify body is resolved template
- `{{input.X}}` in headers — verify header value resolved
- `{{input.X}}` in endpoint — verify URL resolved
- Query params + path params + body coexisting correctly
- `{{input.X}}` for missing param resolves to empty string

**`packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`**:

- Body template roundtrip (serialize → parse → same content)

**`packages/shared/src/__tests__/dsl-property-parser.test.ts`** (new or existing):

- `buildHttpBindingFromProps` with `query_params:` block
- `buildHttpBindingFromProps` with `body:` pipe block

---

## Out of Scope

- `{{memory.X}}` resolution — requires session memory access in executor
- `{{context.X}}` resolution — requires caller context propagation
- Body type negotiation (Content-Type switching based on `bodyType` field)
- Changes to non-HTTP tool types (sandbox, MCP, connector, workflow)

---

## Files Changed

| File                                                                        | Change Type | Description                                                                |
| --------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                                    | Modify      | Add `queryParams`, `bodyTemplate` to `HttpBindingAST`                      |
| `packages/compiler/src/platform/ir/schema.ts`                               | Modify      | Add `query_params`, `body_template` to `HttpBindingIR`                     |
| `packages/shared/src/tools/dsl-property-parser.ts`                          | Modify      | Add fields to `HttpBindingIRLocal`, parse in `buildHttpBindingFromProps()` |
| `packages/core/src/parser/tool-file-parser.ts`                              | Modify      | Parse `query_params:` block and `body:` pipe block                         |
| `packages/compiler/src/platform/ir/compiler.ts`                             | Modify      | Copy new fields in `compileHttpBinding()`                                  |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                   | Modify      | Add `body:` pipe block serialization                                       |
| `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                       | Modify      | Add `body:` pipe block parsing                                             |
| `packages/shared/src/types/project-tool-form.ts`                            | Modify      | Add `body` to `HttpToolFormData`                                           |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Modify      | Add `{{input.X}}` resolution, query_params, body_template                  |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`     | Modify      | Add tests for new features                                                 |
| `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`              | Modify      | Add body template roundtrip test                                           |

---

## Implementation Plan

_Merged from `2026-03-04-http-tool-query-params-body-template-plan.md`._

**Tech Stack:** TypeScript, Vitest, packages/core (AST types), packages/compiler (IR + executor), packages/shared (DSL parsing + form types)

### Task 1: Add `query_params` and `body_template` to IR types

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:559-579`
- Modify: `packages/shared/src/tools/dsl-property-parser.ts:27-36`

**Step 1: Add fields to `HttpBindingIR`**

In `packages/compiler/src/platform/ir/schema.ts`, add two fields after `headers` (line 578):

```typescript
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_template?: string;
}
```

**Step 2: Add fields to `HttpBindingIRLocal`**

In `packages/shared/src/tools/dsl-property-parser.ts`, add two fields after `headers` (line 35):

```typescript
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_template?: string;
}
```

---

### Task 2: Add `queryParams` and `bodyTemplate` to `HttpBindingAST`

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:409-428`

Add two fields after `headers` (line 425):

```typescript
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyTemplate?: string;
  rateLimit?: number;
```

---

### Task 3: Parse `query_params` and `body` in `buildHttpBindingFromProps()`

**Files:**

- Modify: `packages/shared/src/tools/dsl-property-parser.ts:301-365`
- Test: `packages/shared/src/__tests__/dsl-property-parser.test.ts`

**Step 1: Write failing tests**

Add to `packages/shared/src/__tests__/dsl-property-parser.test.ts` inside the `buildHttpBindingFromProps` describe block (after the `circuit_breaker` test around line 337):

```typescript
it('extracts query_params from nested block', () => {
  const dsl = `search(q: string) -> object
  type: http
  endpoint: "https://api.example.com/search"
  method: GET
  auth: api_key
  query_params:
    api_key: "{{secrets.API_KEY}}"
    format: json`;
  const props = parseDslProperties(dsl);
  const binding = buildHttpBindingFromProps(props, dsl);
  expect(binding.query_params).toEqual({
    api_key: '{{secrets.API_KEY}}',
    format: 'json',
  });
});

it('extracts query_params with input placeholders', () => {
  const dsl = `search(q: string) -> object
  type: http
  endpoint: "https://api.example.com/search"
  method: GET
  auth: none
  query_params:
    q: "{{input.q}}"
    limit: "10"`;
  const props = parseDslProperties(dsl);
  const binding = buildHttpBindingFromProps(props, dsl);
  expect(binding.query_params).toEqual({
    q: '{{input.q}}',
    limit: '10',
  });
});

it('extracts body from pipe block', () => {
  const dsl = `create_user(name: string, email: string) -> object
  type: http
  endpoint: "https://api.example.com/users"
  method: POST
  auth: bearer
  body: |
    {
      "name": "{{input.name}}",
      "email": "{{input.email}}",
      "api_key": "{{secrets.API_KEY}}"
    }`;
  const props = parseDslProperties(dsl);
  const binding = buildHttpBindingFromProps(props, dsl);
  expect(binding.body_template).toContain('{{input.name}}');
  expect(binding.body_template).toContain('{{input.email}}');
  expect(binding.body_template).toContain('{{secrets.API_KEY}}');
});

it('no dslContent leaves query_params and body_template undefined', () => {
  const props = {
    endpoint: 'https://api.example.com',
    method: 'GET',
    auth: 'none',
  };
  const binding = buildHttpBindingFromProps(props);
  expect(binding.query_params).toBeUndefined();
  expect(binding.body_template).toBeUndefined();
});
```

**Step 2: Implement parsing in `buildHttpBindingFromProps()`**

In `packages/shared/src/tools/dsl-property-parser.ts`, add after the `circuit_breaker` parsing block (after line 361, before `return binding`):

```typescript
const qpEntries = parseDslNestedBlock(dslContent, 'query_params');
if (qpEntries.length > 0) {
  binding.query_params = {};
  for (const { key, value } of qpEntries) {
    binding.query_params[key] = value;
  }
}

const bodyTemplate = extractPipeBlock(dslContent, 'body');
if (bodyTemplate) {
  binding.body_template = bodyTemplate;
}
```

---

### Task 4: Parse `query_params` and `body` in tool-file-parser

**Files:**

- Modify: `packages/core/src/parser/tool-file-parser.ts:203-454`
- Test: `packages/core/src/__tests__/tool-file-parser.test.ts`

**Step 1: Write failing test**

```typescript
it('parses query_params nested block into httpBinding', () => {
  const content = `TOOLS:
  search_api(q: string) -> object
    type: http
    endpoint: "https://api.example.com/search"
    method: GET
    auth: api_key
    query_params:
      api_key: "{{secrets.API_KEY}}"
      format: json`;

  const result = parseToolFile(content);
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0].httpBinding?.queryParams).toEqual({
    api_key: '{{secrets.API_KEY}}',
    format: 'json',
  });
});

it('parses body pipe block into httpBinding', () => {
  const content = `TOOLS:
  create_user(name: string) -> object
    type: http
    endpoint: "https://api.example.com/users"
    method: POST
    auth: bearer
    body: |
      {
        "name": "{{input.name}}",
        "source": "platform"
      }`;

  const result = parseToolFile(content);
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0].httpBinding?.bodyTemplate).toContain('{{input.name}}');
  expect(result.tools[0].httpBinding?.bodyTemplate).toContain('"source": "platform"');
});
```

**Step 2: Implement parsing in `parseToolProperties()`**

In `packages/core/src/parser/tool-file-parser.ts`:

- Add `queryParams` variable alongside `headers` (around line 218)
- Handle `query_params` bare block key (same pattern as `headers:`)
- Handle `body` pipe block (same pattern as `code:`)
- Include `queryParams` and `bodyTemplate` in `result.httpBinding`

---

### Task 5: Copy new fields in `compileHttpBinding()`

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:689-709`

Add after `headers: ast.headers,` (line 707):

```typescript
    headers: ast.headers,
    query_params: ast.queryParams,
    body_template: ast.bodyTemplate,
  };
```

---

### Task 6: Add `body` field to `HttpToolFormData` and DSL roundtrip

**Files:**

- Modify: `packages/shared/src/types/project-tool-form.ts:52-65`
- Modify: `packages/shared/src/tools/serialize-tool-form-to-dsl.ts:78-134`
- Modify: `packages/shared/src/tools/parse-dsl-to-tool-form.ts:316-337`
- Test: `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`

**Step 1: Write failing test**

```typescript
it('roundtrips HTTP with body template', () => {
  const form: HttpToolFormData = {
    name: 'create_user',
    toolType: 'http',
    description: 'Create a user',
    parameters: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ],
    returnType: 'object',
    endpoint: 'https://api.example.com/users',
    method: 'POST',
    auth: 'bearer',
    body: '{\n  "name": "{{input.name}}",\n  "email": "{{input.email}}"\n}',
  };

  const dsl = serializeToolFormToDsl(form);
  const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

  expect(parsed).not.toBeNull();
  expect(parsed.body).toContain('{{input.name}}');
  expect(parsed.body).toContain('{{input.email}}');
});
```

**Step 2: Add `body` field to `HttpToolFormData`**

In `packages/shared/src/types/project-tool-form.ts`:

```typescript
  queryParams?: Array<{ key: string; value: string }>;
  body?: string;
  timeout?: number;
```

**Step 3: Add body serialization to DSL**

In `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`, after the query_params block:

```typescript
if (form.body) {
  lines.push('  body: |');
  for (const bodyLine of form.body.split('\n')) {
    lines.push(`    ${bodyLine}`);
  }
}
```

**Step 4: Add body parsing from DSL**

In `packages/shared/src/tools/parse-dsl-to-tool-form.ts`, import `extractPipeBlock` and add after `queryParams` assignment:

```typescript
const body = extractPipeBlock(dslContent, 'body');
if (body) form.body = body;
```

---

### Task 7: Add `{{input.X}}` resolution and query_params/body_template to HTTP executor

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts:200-270, 461-468`
- Test: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

**Step 1: Implement `resolveInputPlaceholders()` method**

```typescript
  private resolveInputPlaceholders(
    value: string,
    params: Record<string, unknown>,
    consumedKeys?: Set<string>,
  ): string {
    return value.replace(/\{\{input\.(\w+)\}\}/g, (_match, key) => {
      const val = params[key];
      if (val === undefined || val === null) return '';
      if (consumedKeys) consumedKeys.add(key);
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
    });
  }
```

**Step 2: Update `resolvePlaceholders()` signature**

```typescript
  private async resolvePlaceholders(
    value: string,
    params?: Record<string, unknown>,
    consumedKeys?: Set<string>,
  ): Promise<string> {
    let result = await this.resolveSecrets(value);
    result = await this.resolveEnvVars(result);
    if (params) {
      result = this.resolveInputPlaceholders(result, params, consumedKeys);
    }
    return result;
  }
```

**Step 3: Rewrite `buildRequest()` method**

Updated flow:

1. Clone params, create consumedKeys set
2. Resolve headers (`{{secrets.X}}`, `{{env.X}}`, `{{input.X}}`) — consumed keys tracked
3. Apply auth headers
4. Resolve endpoint URL — consumed keys tracked
5. Substitute path params `{param}` (delete from paramsCopy)
6. Resolve binding-level query_params and append to URL (all methods)
7. Remove consumed keys from paramsCopy
8. For GET without body_template: append remaining paramsCopy as query string
9. SSRF validation on final URL
10. If body_template exists (non-GET): resolve placeholders in template
11. Else for non-GET: JSON.stringify(paramsCopy)

---

### Task 8: Build and run full test suite

1. Build all affected packages: `pnpm build --filter=@abl/core --filter=@agent-platform/shared --filter=@abl/compiler`
2. Run all affected test suites: `pnpm test --filter=@abl/core --filter=@agent-platform/shared --filter=@abl/compiler`
3. Run prettier on all changed files

---

### Summary of Files Changed

| #   | File                                                                        | Type          | What                                                                       |
| --- | --------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| 1   | `packages/compiler/src/platform/ir/schema.ts`                               | Type          | Add `query_params`, `body_template` to `HttpBindingIR`                     |
| 2   | `packages/shared/src/tools/dsl-property-parser.ts`                          | Type + Parser | Add fields to `HttpBindingIRLocal`, parse in `buildHttpBindingFromProps()` |
| 3   | `packages/core/src/types/agent-based.ts`                                    | Type          | Add `queryParams`, `bodyTemplate` to `HttpBindingAST`                      |
| 4   | `packages/core/src/parser/tool-file-parser.ts`                              | Parser        | Handle `query_params:` block and `body:` pipe block                        |
| 5   | `packages/compiler/src/platform/ir/compiler.ts`                             | Compiler      | Copy new fields in `compileHttpBinding()`                                  |
| 6   | `packages/shared/src/types/project-tool-form.ts`                            | Type          | Add `body` to `HttpToolFormData`                                           |
| 7   | `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                   | Serializer    | Add `body:` pipe block                                                     |
| 8   | `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                       | Parser        | Add `body:` pipe block + import `extractPipeBlock`                         |
| 9   | `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Runtime       | Add `{{input.X}}` resolver, query_params, body_template                    |
| 10  | `packages/shared/src/__tests__/dsl-property-parser.test.ts`                 | Test          | query_params + body_template parsing tests                                 |
| 11  | `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`              | Test          | body template roundtrip test                                               |
| 12  | `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`     | Test          | query_params, input resolution, body_template tests                        |
| 13  | `packages/core/src/__tests__/tool-file-parser.test.ts`                      | Test          | query_params + body pipe block parsing tests                               |
