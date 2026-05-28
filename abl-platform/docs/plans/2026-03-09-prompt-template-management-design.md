# Prompt Template Management — Design & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a project-scoped prompt template library with versioning, typed variables, template composition, and Studio UI so teams can manage reusable prompts instead of duplicating inline DSL text across agents.

**Architecture:** New `ProjectPromptTemplate` collection (tenant + project scoped), new repo/service layers in `packages/shared`, runtime routes, Studio proxy routes + UI pages, parser/compiler extensions to resolve `@template("name")` references at compile time, and a hybrid resolution model that supports runtime-resolved dynamic variables alongside compile-time frozen content.

**Tech Stack:** TypeScript, MongoDB/Mongoose, Next.js 15 (App Router), Zustand, Monaco Editor, Vitest 4.x, pnpm/Turbo

---

## Section 1: Current State

### How Prompts Work Today

1. **DSL Authoring** — Agents define prompts inline in ABL files:
   - `PERSONA:` section sets a persona description string
   - `SYSTEM_PROMPT:` section provides a custom multi-line system prompt template
   - `IDENTITY:` section bundles role, persona, expertise, and limitations
   - `GOAL:` section defines the agent's primary objective

2. **Parsing** — `packages/core/src/parser/agent-based-parser.ts` parses these sections into an `AgentBasedDocument`:
   - `doc.persona.description` (string)
   - `doc.systemPrompt` (multi-line string, optional)
   - `doc.goal.description` (string)
   - `doc.limitations[].description` (string[])

3. **Compilation** — `packages/compiler/src/platform/ir/compiler.ts` (line ~540) compiles parsed sections into IR:
   - `ir.identity.persona` — interpolated persona string
   - `ir.identity.goal` — goal string
   - `ir.identity.system_prompt.template` — either the custom `SYSTEM_PROMPT:` content or a generated template from `buildSystemPromptTemplate()`
   - `ir.identity.system_prompt.custom` — boolean flag indicating user-provided prompt

4. **Runtime Prompt Building** — `apps/runtime/src/services/execution/prompt-builder.ts`:
   - If `system_prompt.custom` is true, uses `buildCustomSystemPrompt()` which calls `interpolateTemplate()` (from `value-resolution.ts`) against session values
   - Otherwise resolves a template key (standalone/specialist/supervisor/supervisor_direct/fallback) and loads from `PromptTemplateLoader` (DB cache -> `PromptCatalog` fallback)
   - `renderTemplate()` (from `packages/shared/src/prompts/template-engine.ts`) does a single-pass render with `{{#if}}` conditionals, `{{#each}}` loops, and `{{variable}}` substitution
   - **Key insight:** The runtime already resolves `{{var}}` placeholders against session values at message time. This means some template variables are inherently dynamic (session-scoped).

5. **Platform-Level Templates** — `packages/database/src/models/prompt-template.model.ts` + `packages/shared/src/prompts/prompt-template-loader.ts`:
   - Existing `prompt_templates` collection stores platform-wide (NOT tenant/project-scoped) prompt templates keyed by strings like `system_prompt.supervisor`, `tool_description.handoff`, `message.error_default`
   - `PromptTemplateLoader` singleton caches all templates at process start, falls back to hardcoded `PromptCatalog`
   - Categories: `system_prompt`, `tool_schema`, `tool_description`, `message`, `escalation`, `pattern`

6. **Config Variable Resolution** — `apps/runtime/src/services/version-service.ts` (line ~175):
   - `VersionService.createVersion()` loads `ProjectConfigVariable` documents and passes them as `config_variables` to the compiler
   - The compiler's `resolveConfigVariables()` does a recursive tree walk replacing `{{config.KEY}}` placeholders throughout the IR
   - Config vars are compile-time only; changes require recompilation

### What's Missing

| Gap                                        | Impact                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| **No project-scoped template library**     | Teams duplicate persona/prompt text across 10+ agents  |
| **No reusable template references in DSL** | Copy-paste drift when updating shared prompts          |
| **No template versioning**                 | No rollback, no audit trail for prompt changes         |
| **No typed template variables**            | Cannot validate variable types, no schema enforcement  |
| **No Studio management UI**                | Must edit raw DSL to change any prompt content         |
| **No template composition**                | Cannot combine persona + guardrails + domain fragments |
| **No usage tracking**                      | Cannot determine which agents use a given template     |
| **No built-in template library**           | No starter templates for common agent patterns         |

---

## Section 2: Design Decisions

### Compile-Time vs. Runtime Resolution

The original design proposed pure compile-time resolution. After research, a **hybrid model** is better:

**Compile-time resolution (default):** Template content is frozen into the IR at version creation time. This is correct for:

- Persona descriptions, goals, limitations (static per agent version)
- System prompt scaffolding (structural templates)
- Constraint messages (static guardrails)

**Runtime-resolved variables (opt-in):** Some variables should resolve at runtime against session state. The runtime already does this via `interpolateTemplate()` in `buildCustomSystemPrompt()`. We preserve this by:

- Compile-time: resolve template content and static overrides into a string that may still contain `{{session_var}}` placeholders
- Runtime: existing `interpolateTemplate()` resolves remaining `{{var}}` against `session.data.values` (zero new runtime code)

This means a template like `"You are {{agent_name}}, helping {{customer_name}} with {{language}} support"` resolves `agent_name` at compile time (from override or config var) but leaves `customer_name` for runtime (resolved from session). No new runtime dependency is needed because this is how `SYSTEM_PROMPT:` already works.

### What We Are NOT Building (Scope Cuts)

The following were considered and deliberately excluded from v1:

| Feature                                                  | Why Excluded                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Template inheritance** (base -> specialization chains) | Adds complexity with marginal benefit. Composition (see Section 3) covers 90% of inheritance use cases without the diamond-problem pitfalls. Reconsider in v2 if adoption shows deep specialization patterns.                         |
| **A/B prompt testing**                                   | Requires deployment split infrastructure (traffic routing, metric collection, statistical significance). Better built as a Deployment-layer feature after the template library exists. Templates + versioning provide the foundation. |
| **Template analytics via ClickHouse**                    | Requires ClickHouse pipeline integration that does not exist yet. Usage counting (which agents reference a template) is sufficient for v1. Analytics can be added when the analytics pipeline matures.                                |
| **Prompt playground**                                    | The template preview panel (Section 6) with sample variable values covers the core need. A full playground with mock conversations is a separate feature that depends on the Chat Debugger infrastructure.                            |
| **Cross-project template sharing**                       | Adds tenant-level collection complexity. v1 uses import/export JSON to share between projects. If this becomes a top request, add a `tenant_prompt_templates` collection in v2.                                                       |

---

## Section 3: Design — Template Model

### New Collection: `project_prompt_templates`

Project-scoped template library, separate from the existing platform-wide `prompt_templates` collection.

```typescript
export interface IProjectPromptTemplate {
  _id: string;
  tenantId: string;
  projectId: string;

  /** Unique name within project, used in DSL @template("name") references */
  name: string;

  /** Display name for Studio UI */
  displayName: string;

  /** Template category */
  category: 'persona' | 'system_prompt' | 'goal' | 'guardrail' | 'fragment' | 'custom';

  /** Template content with {{variable}} placeholders */
  content: string;

  /** Declared template variables with type metadata */
  variables: TemplateVariable[];

  /** Searchable tags */
  tags: string[];

  /** Status lifecycle */
  status: 'draft' | 'active' | 'deprecated';

  /** SHA-256 hash of content for dedup */
  sourceHash: string;

  /** Whether this is a built-in template (read-only for users) */
  builtIn: boolean;

  /** Optional: names of other templates this composes (for @include refs) */
  includes: string[];

  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateVariable {
  /** Variable name as used in {{name}} */
  name: string;

  /** Variable type for validation */
  type: 'string' | 'number' | 'boolean' | 'enum';

  /** Human-readable description */
  description?: string;

  /** Default value (used when not overridden) */
  defaultValue?: string;

  /** Whether this variable must be provided */
  required: boolean;

  /** Allowed values for enum type */
  enumValues?: string[];

  /** Resolution time: 'compile' (default) or 'runtime' (resolved from session) */
  resolveAt?: 'compile' | 'runtime';
}
```

### Indexes

```
{ tenantId: 1, projectId: 1, name: 1 }             — unique compound (one active per name)
{ tenantId: 1, projectId: 1, category: 1, status: 1 } — category + status filter
{ tenantId: 1, projectId: 1, tags: 1 }               — tag search
{ tenantId: 1, projectId: 1, status: 1 }              — status filter
```

### Categories (Simplified)

The original design had 7 categories. Reduced to 6 — merging `tool_description`, `constraint_message`, and `error_handler` into `guardrail` (shared concern) and adding `fragment` for composable pieces.

| Category        | Use Case                                  | Example                                                         |
| --------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `persona`       | Reusable persona descriptions             | "Professional financial advisor with 15 years of experience..." |
| `system_prompt` | Full system prompt templates              | Multi-paragraph prompt with context sections                    |
| `goal`          | Reusable goal descriptions                | "Help customers resolve billing disputes..."                    |
| `guardrail`     | Constraints, error handling, boundaries   | "Do not discuss competitor products..."                         |
| `fragment`      | Composable building blocks for `@include` | Tone-of-voice section, compliance footer, domain context        |
| `custom`        | Catch-all for other templates             | Any reusable text snippet                                       |

### Template Variable System

Variables use `{{variable_name}}` syntax (consistent with existing `interpolateTemplate()` and `renderTemplate()`).

**Variable extraction** (automatic on save, with type annotation support):

```typescript
/**
 * Extract variables from template content.
 * Supports plain {{name}} and typed {{name:type:required}} syntax.
 * Skips control-flow constructs ({{#if}}, {{/if}}, {{#each}}, {{/each}}, {{@index}}).
 */
function extractVariables(content: string): TemplateVariable[] {
  const controlFlow = new Set(['#if', '/if', '#each', '/each', '@index']);
  const seen = new Set<string>();
  const vars: TemplateVariable[] = [];

  for (const match of content.matchAll(/\{\{([^}]+)\}\}/g)) {
    const raw = match[1].trim();
    // Skip control flow and nested paths (handled by renderTemplate)
    if (controlFlow.has(raw.split(/\s/)[0]) || raw.includes('add ')) continue;

    // Parse typed syntax: {{name:type:required}}
    const parts = raw.split(':');
    const name = parts[0].trim();
    if (seen.has(name) || !name.match(/^\w+$/)) continue;
    seen.add(name);

    vars.push({
      name,
      type: (parts[1] as TemplateVariable['type']) || 'string',
      required: parts[2] === 'required',
      resolveAt: name.startsWith('session_') ? 'runtime' : 'compile',
    });
  }
  return vars;
}
```

**Convention for runtime variables:** Variables prefixed with `session_` are runtime-resolved by default. This convention is editable in the Studio UI variable table. The rendered content in the IR will preserve `{{session_customer_name}}` as a literal placeholder for the runtime's `interpolateTemplate()` to fill.

**Resolution chain at compile time:**

1. DSL-level overrides: `@template("name", agent_name="Sales Bot", language="en")`
2. Project config variables: `{{config.KEY}}` resolved from `ProjectConfigVariable` collection
3. Template defaults: `variables[].defaultValue`
4. Variables with `resolveAt: 'runtime'` -> preserved as `{{name}}` in IR for runtime resolution
5. Unresolved compile-time required vars -> compile warning

---

## Section 4: Design — Template Composition

### The `@include` Directive

Templates can include other templates, enabling composition without inheritance complexity.

```
# Template: "customer_service_persona"
You are {{agent_name}}, a customer service representative for {{company_name}}.

@include("tone_of_voice")

@include("compliance_footer")
```

```
# Template: "tone_of_voice"
## Communication Style
- Be warm and empathetic
- Use clear, simple language
- Avoid jargon unless the customer uses it first
```

**Rules:**

- `@include("name")` is resolved recursively at compile time
- Maximum depth: 5 levels (prevents circular references)
- Circular reference detection: track visited template names, emit compile error on cycle
- Included templates must have `status: 'active'`
- Variables from included templates are merged into the parent's variable set

**Why not inheritance:** Inheritance implies override semantics (which section of the base do you override?), ordering problems (what order do you apply overrides?), and diamond dependency issues. Composition via `@include` is explicit, predictable, and debuggable — you can see exactly what gets assembled.

### Composition Resolution in Compiler

```typescript
function resolveTemplateContent(
  name: string,
  resolver: TemplateResolver,
  visited: Set<string> = new Set(),
  depth: number = 0,
): { content: string; variables: TemplateVariable[]; errors: string[] } {
  if (depth > 5)
    return { content: '', variables: [], errors: [`Max include depth exceeded at "${name}"`] };
  if (visited.has(name))
    return {
      content: '',
      variables: [],
      errors: [`Circular include: ${[...visited, name].join(' -> ')}`],
    };

  const template = resolver(name);
  if (!template) return { content: '', variables: [], errors: [`Template "${name}" not found`] };

  visited.add(name);
  const errors: string[] = [];
  const allVariables = [...template.variables];

  // Resolve @include directives
  const content = template.content.replace(
    /^@include\("([^"]+)"\)\s*$/gm,
    (_match, includeName) => {
      const included = resolveTemplateContent(includeName, resolver, new Set(visited), depth + 1);
      errors.push(...included.errors);
      allVariables.push(...included.variables);
      return included.content;
    },
  );

  return { content, variables: deduplicateVariables(allVariables), errors };
}
```

---

## Section 5: Design — Template Versioning

### Version Lifecycle

Simplified from agent versions (which have testing/staged/active):

```
draft -> active -> deprecated
```

Prompt templates are text content that does not need deployment gating.

### Version Storage

Separate `project_prompt_template_versions` collection for history, main `project_prompt_templates` collection always holds the working copy. This matches the existing `project_agents` + `agent_versions` pattern.

```typescript
export interface IProjectPromptTemplateVersion {
  _id: string;
  templateId: string; // FK to project_prompt_templates._id
  tenantId: string;
  projectId: string;
  version: number; // Monotonically increasing integer
  content: string;
  variables: TemplateVariable[];
  includes: string[];
  sourceHash: string;
  changelog?: string;
  createdBy: string;
  createdAt: Date;
}
```

### Version Creation

- Every save creates a new version (monotonically incrementing integer)
- Source hash dedup: if `SHA-256(content)` matches the latest version, skip creation and return existing (same pattern as `VersionService.createVersion()`)
- Previous active version auto-transitions to `deprecated` when a new version is promoted to `active`

### Version Comparison

- Diff view between any two versions (reuse Monaco diff editor already in Studio)
- Changelog field per version (optional, same as agent versions)

---

## Section 6: Design — Studio UI

### Navigation

New sidebar item under project navigation:

```
Project -> Agents
Project -> Tools
Project -> Prompt Templates  <-- NEW
Project -> Knowledge Bases
Project -> Settings
```

### Template List Page (`/projects/[id]/templates`)

- Header: "Prompt Templates" with Create button
- Filter bar: category dropdown, status pills, tag chips, search input
- Table view (default) with card grid toggle
- Each row/card shows: name, category badge, tag chips, status badge, included-by count, last updated
- Click -> template detail/editor
- Batch actions: export selected, deprecate selected

### Template Editor Page (`/projects/[id]/templates/[templateId]`)

Layout (two-panel):

**Left panel — Editor:**

- Monaco editor with template content
- Syntax highlighting for `{{variable}}` placeholders and `@include("name")` directives (custom Monaco decoration provider, same pattern as `ABLEditor.tsx`)
- Auto-complete for:
  - Known variables: project config vars (`{{config.X}}`), standard vars (`{{agent_name}}`, `{{goal}}`)
  - Template names in `@include("")` context (query active templates)
- `{{variable:type:required}}` typed variable syntax highlighting

**Right panel — Metadata & Preview:**

- Tabs: **Metadata** | **Preview** | **Variables** | **Versions** | **Usage**
- **Metadata tab:** Name, display name, category, tags (editable)
- **Variables tab:** Auto-extracted from content, with editable description/default/required/resolveAt fields
- **Preview tab:** Rendered template with sample variable values (user can edit sample values). Shows the fully composed result after `@include` resolution.
- **Versions tab:** Version list with timestamps, author, changelog. Diff view between versions (Monaco diff). Restore button.
- **Usage tab:** List of agents referencing this template via `@template("name")` in their DSL, with links to agent detail pages.

### Template Creation Dialog

- Name (slug, validated: `^[a-z][a-z0-9_]*$`)
- Display name
- Category (dropdown)
- Content (Monaco editor, compact)
- Option: "Start from built-in template" (dropdown of built-in templates)
- Option: "Extract from agent" (dropdown of agents, extracts persona/goal/system_prompt)

---

## Section 7: Design — DSL Integration

### New DSL Syntax

```abl
AGENT: Customer_Service_Agent
GOAL: "Help customers with billing inquiries"
PERSONA: @template("customer_service")

# With variable overrides:
PERSONA: @template("customer_service", tone="formal", language="Spanish")

# Full system prompt from template:
SYSTEM_PROMPT: @template("billing_support_v2")

# Inline remains supported (no breaking change):
PERSONA: "You are a helpful customer service agent."
```

### Parser Changes

In `packages/core/src/parser/agent-based-parser.ts`:

1. Add `@template()` reference detection in `parsePersona()` (before the existing inline match at line ~1898):

```typescript
// New: template reference — must be checked before inline match
const templateMatch = line.match(/^PERSONA:\s*@template\("([^"]+)"(?:,\s*(.+))?\)$/);
if (templateMatch) {
  const templateName = templateMatch[1];
  const overrides = templateMatch[2] ? parseTemplateOverrides(templateMatch[2]) : {};
  state.currentLine++;
  return {
    description: '',
    templateRef: { name: templateName, overrides },
  };
}
```

2. Same pattern for `SYSTEM_PROMPT:` (line ~414) and `GOAL:` sections.

3. New AST types:

```typescript
interface TemplateRef {
  name: string;
  overrides: Record<string, string>;
}
```

4. Add `templateRef?: TemplateRef` to `AgentPersona` and `AgentGoal` interfaces in the parsed document.

### Compiler Changes

In `packages/compiler/src/platform/ir/compiler.ts`:

1. Add `template_resolver` to `CompilerOptions` (line ~476):

```typescript
interface CompilerOptions {
  config_variables?: Record<string, string>;
  template_resolver?: (name: string) => {
    content: string;
    variables: TemplateVariable[];
    includes: string[];
  } | null;
}
```

2. In identity compilation block (line ~540), before setting `ir.identity`:
   - If `doc.persona.templateRef` exists, call `resolveTemplateContent()` to get composed content
   - Apply overrides from `templateRef.overrides`
   - Apply config variables (using existing `resolveConfigVariables` pattern)
   - Apply template defaults for remaining unresolved compile-time variables
   - Preserve runtime variables as `{{name}}` in the resolved string
   - Set `ir.identity.persona` to the resolved string
   - If template not found, emit compile error
   - Store `template_refs` in IR metadata for traceability

3. Same resolution for `doc.goal.templateRef` and `doc.systemPrompt` (if template ref form).

### Runtime Impact

**Minimal.** The IR contains strings that may include `{{var}}` placeholders for runtime resolution, which is exactly how `SYSTEM_PROMPT:` already works. The runtime's `buildCustomSystemPrompt()` and `interpolateTemplate()` already handle this. The only new IR metadata is `template_refs` (an array of template names used), which the runtime ignores.

### IR Metadata Extension

```typescript
// In AgentMetadata (schema.ts)
interface AgentMetadata {
  // ... existing fields
  /** Template references used during compilation (for traceability) */
  template_refs?: string[];
}
```

---

## Section 8: Design — Built-in Template Library

### Seed Templates

Shipped with the platform via seed script. Stored in `project_prompt_templates` with `builtIn: true`. Read-only; can be cloned into editable project templates.

| Name                 | Category      | Description                                             |
| -------------------- | ------------- | ------------------------------------------------------- |
| `helpful_assistant`  | persona       | General-purpose helpful assistant persona               |
| `technical_support`  | persona       | Technical support specialist persona                    |
| `customer_service`   | persona       | Customer service representative persona                 |
| `sales_advisor`      | persona       | Consultative sales advisor persona                      |
| `knowledge_worker`   | persona       | Knowledge base Q&A specialist persona                   |
| `supervisor_router`  | system_prompt | Supervisor routing system prompt with handoff context   |
| `gather_specialist`  | system_prompt | Data collection specialist with field-by-field guidance |
| `professional_tone`  | fragment      | Professional, empathetic communication style guide      |
| `compliance_footer`  | fragment      | Standard compliance and data handling disclaimer        |
| `no_competitor_talk` | guardrail     | Constraint: avoid competitor discussion                 |
| `stay_on_topic`      | guardrail     | Constraint: topic boundary enforcement                  |
| `graceful_error`     | guardrail     | Graceful error response template                        |

Built-in templates are seeded per-project on project creation (idempotent). They cannot be deleted or modified. Users clone them to customize.

### Built-in Templates Are NOT Copied Per-Project

**Design change from original:** Instead of copying 12 templates into every project, built-in templates are stored in a `tenant_builtins` pseudo-project (one set per tenant). When the compiler resolves `@template("helpful_assistant")`, it checks project templates first, then falls back to tenant builtins. This avoids N\*12 document duplication.

```typescript
// Resolution order in compiler
function resolveTemplate(name: string, projectId: string, tenantId: string) {
  // 1. Project-specific template
  const projectTemplate = projectTemplates.find((t) => t.name === name);
  if (projectTemplate) return projectTemplate;
  // 2. Tenant built-in templates
  const builtinTemplate = tenantBuiltins.find((t) => t.name === name);
  if (builtinTemplate) return builtinTemplate;
  return null;
}
```

---

## Section 9: Design — API Routes

### Runtime Endpoints

New route file: `apps/runtime/src/routes/prompt-templates.ts`

| Method | Path                                                             | Description                            |
| ------ | ---------------------------------------------------------------- | -------------------------------------- |
| GET    | `/api/projects/:projectId/prompt-templates`                      | List templates (paginated, filterable) |
| POST   | `/api/projects/:projectId/prompt-templates`                      | Create template                        |
| GET    | `/api/projects/:projectId/prompt-templates/:templateId`          | Get template by ID                     |
| PUT    | `/api/projects/:projectId/prompt-templates/:templateId`          | Update template                        |
| DELETE | `/api/projects/:projectId/prompt-templates/:templateId`          | Delete template (soft)                 |
| POST   | `/api/projects/:projectId/prompt-templates/:templateId/versions` | Create version snapshot                |
| GET    | `/api/projects/:projectId/prompt-templates/:templateId/versions` | List versions                          |
| POST   | `/api/projects/:projectId/prompt-templates/:templateId/clone`    | Clone template                         |
| POST   | `/api/projects/:projectId/prompt-templates/import`               | Bulk import from JSON                  |
| GET    | `/api/projects/:projectId/prompt-templates/export`               | Bulk export to JSON                    |
| POST   | `/api/projects/:projectId/prompt-templates/preview`              | Render template with sample values     |

### Studio Proxy Routes

New Next.js App Router routes: `apps/studio/src/app/api/projects/[id]/prompt-templates/`

| File                             | Methods          | Proxies To          |
| -------------------------------- | ---------------- | ------------------- |
| `route.ts`                       | GET, POST        | List/Create         |
| `[templateId]/route.ts`          | GET, PUT, DELETE | CRUD by ID          |
| `[templateId]/versions/route.ts` | GET, POST        | Version list/create |
| `[templateId]/clone/route.ts`    | POST             | Clone               |
| `import/route.ts`                | POST             | Bulk import         |
| `export/route.ts`                | GET              | Bulk export         |
| `preview/route.ts`               | POST             | Render preview      |

All routes use `withRouteHandler` with `requireProject: true` and appropriate permissions:

- Read: `StudioPermission.PROMPT_TEMPLATE_READ`
- Write: `StudioPermission.PROMPT_TEMPLATE_WRITE`

### Template Resolver Integration (Version Service)

The `VersionService.createVersion()` method already loads project config variables for compilation. We extend it to also load prompt templates:

```typescript
// In version-service.ts createVersion(), after config variable loading (~line 213):
let templateMap: Map<string, ResolvedTemplate> = new Map();
try {
  const templates = await findActiveProjectPromptTemplates(projectId, tenantId);
  const builtins = await findBuiltinPromptTemplates(tenantId);
  for (const t of [...builtins, ...templates]) {
    // project overrides builtins
    templateMap.set(t.name, t);
  }
} catch (err) {
  log.warn('Failed to load prompt templates for compilation', {
    projectId,
    error: (err as Error).message,
  });
}
if (templateMap.size > 0) {
  compilerOptions.template_resolver = (name: string) => templateMap.get(name) ?? null;
}
```

---

## Section 10: Test Plan

### Parser Tests

**File:** `packages/core/src/__tests__/template-ref-parser.test.ts`

| Test                                           | Description                          |
| ---------------------------------------------- | ------------------------------------ |
| `PERSONA: @template("name")`                   | Basic template reference parsing     |
| `PERSONA: @template("name", key="value")`      | Template ref with overrides          |
| `PERSONA: @template("name", k1="v1", k2="v2")` | Multiple overrides                   |
| `SYSTEM_PROMPT: @template("name")`             | System prompt template ref           |
| `GOAL: @template("name")`                      | Goal template ref                    |
| `PERSONA: "inline text"`                       | Inline text still works (regression) |
| `PERSONA: @template("")`                       | Empty template name -> parse error   |
| `PERSONA: @template("na me")`                  | Invalid template name -> parse error |

### Compiler Tests

**File:** `packages/compiler/src/__tests__/template-resolution.test.ts`

| Test                               | Description                                                          |
| ---------------------------------- | -------------------------------------------------------------------- |
| Template resolved to IR persona    | `templateRef` resolved to `ir.identity.persona`                      |
| Template with overrides            | Override variables applied                                           |
| Template with config vars          | `{{config.KEY}}` resolved                                            |
| Template with defaults             | Unset variables get defaults                                         |
| Runtime variable preserved         | `{{session_name}}` stays as literal in IR                            |
| Missing template -> error          | Compile error when template not found                                |
| Unresolved required var -> warning | Warning for unresolved required compile-time variables               |
| System prompt template             | `SYSTEM_PROMPT: @template()` resolves to `ir.identity.system_prompt` |
| `@include` composition             | Nested template assembled correctly                                  |
| `@include` circular -> error       | Circular include detected and reported                               |
| `@include` depth limit             | 6-level nesting produces error                                       |
| `template_refs` metadata           | IR metadata tracks used template names                               |

### API Route Tests

**File:** `apps/runtime/src/routes/__tests__/prompt-templates.test.ts`

| Test                               | Description                               |
| ---------------------------------- | ----------------------------------------- |
| GET list with pagination           | Returns paginated results                 |
| GET list with category filter      | Filters by category                       |
| GET list with tag filter           | Filters by tags                           |
| POST create template               | Creates with auto-extracted variables     |
| POST create duplicate name -> 409  | Unique constraint                         |
| PUT update template                | Updates content and re-extracts variables |
| DELETE template                    | Soft deletes                              |
| POST create version                | Snapshots current state                   |
| GET version list                   | Lists versions                            |
| POST clone template                | Creates copy with new name                |
| POST preview                       | Renders template with sample values       |
| Cross-tenant isolation -> 404      | Cannot access other tenant's templates    |
| Cross-project isolation -> 404     | Cannot access other project's templates   |
| Built-in template -> 403 on update | Cannot modify built-in templates          |
| Variable type validation           | Enum variable with invalid value -> 400   |

### Template Composition Tests

**File:** `packages/shared/src/__tests__/template-composition.test.ts`

| Test                      | Description                              |
| ------------------------- | ---------------------------------------- |
| Single `@include`         | Content from included template inserted  |
| Nested `@include`         | 3-level nesting resolves correctly       |
| Variables merged          | Parent and included variables combined   |
| Circular detection        | `A -> B -> A` produces error             |
| Depth exceeded            | 6 levels produces error                  |
| Missing include -> error  | `@include("nonexistent")` produces error |
| Include inactive -> error | Cannot include `deprecated` template     |

### Studio Component Tests

**File:** `apps/studio/src/components/prompt-templates/__tests__/`

| Test                     | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| TemplateListPage renders | List page with filters                                           |
| TemplateEditor renders   | Editor with Monaco                                               |
| Variable extraction      | Auto-extracts `{{var}}` and `{{var:type:required}}` from content |
| Preview rendering        | Substitutes sample values, resolves includes                     |
| Create dialog validation | Name slug validation                                             |

---

## Section 11: Implementation Plan

### Phase 1: Data Layer (2 tasks)

#### Task 1.1: Database Models

**Files:**

- Create: `packages/database/src/models/project-prompt-template.model.ts`
- Create: `packages/database/src/models/project-prompt-template-version.model.ts`
- Edit: `packages/database/src/models/index.ts` (add exports)

**Steps:**

1. Create `IProjectPromptTemplate` interface and Mongoose schema as specified in Section 3
2. Create `IProjectPromptTemplateVersion` schema (with `templateId` foreign key, see Section 5)
3. Create `TemplateVariable` sub-schema with type/resolveAt fields
4. Add compound indexes for tenant/project/name uniqueness and category/status/tag queries
5. Export from models barrel file
6. Add `COPY packages/database/package.json` to all Dockerfiles if not already present (per CLAUDE.md rule)

#### Task 1.2: Repository Layer

**Files:**

- Create: `packages/shared/src/repos/prompt-template-repo.ts`
- Edit: `packages/shared/src/repos/index.ts` (add exports)

**Steps:**

1. Implement CRUD functions following `project-tool-repo.ts` pattern:
   - `findProjectPromptTemplates(tenantId, projectId, options)` — paginated list with filters
   - `findProjectPromptTemplateById(tenantId, projectId, templateId)` — single lookup (query-level scoping)
   - `findProjectPromptTemplateByName(tenantId, projectId, name)` — name lookup
   - `findActiveProjectPromptTemplates(tenantId, projectId)` — all active templates (for compiler)
   - `findBuiltinPromptTemplates(tenantId)` — tenant builtin templates
   - `createProjectPromptTemplate(data)` — create with variable extraction
   - `updateProjectPromptTemplate(tenantId, projectId, templateId, data)` — update
   - `deleteProjectPromptTemplate(tenantId, projectId, templateId)` — soft delete
   - `createPromptTemplateVersion(data)` — snapshot to version collection
   - `listPromptTemplateVersions(tenantId, projectId, templateId, options)` — version history
   - `cloneProjectPromptTemplate(tenantId, projectId, templateId, newName)` — clone
2. All functions enforce `tenantId` + `projectId` scoping at query level (use `findOne({_id, tenantId, projectId})`, never `findById`)
3. Source hash dedup on version creation
4. Auto-extract variables with type annotations on create/update

**Dependencies:** Task 1.1

### Phase 2: Template Composition Engine (1 task)

#### Task 2.1: Composition Resolver

**Files:**

- Create: `packages/shared/src/prompts/template-composition.ts`
- Create: `packages/shared/src/__tests__/template-composition.test.ts`

**Steps:**

1. Implement `resolveTemplateContent()` function as specified in Section 4
2. Implement `extractVariables()` with typed variable support (Section 3)
3. Implement `deduplicateVariables()` — merge variables from parent + included templates
4. Add circular reference detection with visited set
5. Add depth limit (5 levels)
6. Unit tests for all composition scenarios

**Dependencies:** None

### Phase 3: Parser & Compiler (2 tasks)

#### Task 3.1: Parser — `@template()` Syntax

**Files:**

- Edit: `packages/core/src/parser/agent-based-parser.ts` — add template ref detection
- Edit: `packages/core/src/parser/types.ts` (or equivalent) — add `TemplateRef` type
- Create: `packages/core/src/__tests__/template-ref-parser.test.ts`

**Steps:**

1. Add `TemplateRef` interface: `{ name: string; overrides: Record<string, string> }`
2. Add `templateRef?: TemplateRef` to `AgentPersona` and `AgentGoal` types
3. In `parsePersona()` (line ~1897), add `@template()` detection BEFORE the existing inline match
4. In `SYSTEM_PROMPT:` parsing (line ~414), detect `@template()` on a single-line system prompt
5. Add `parseTemplateOverrides()` helper to parse `key="value"` pairs
6. Add parser tests

**Dependencies:** None (can run in parallel with Task 2.1)

#### Task 3.2: Compiler — Template Resolution

**Files:**

- Edit: `packages/compiler/src/platform/ir/compiler.ts` — resolve template refs during compilation
- Edit: `packages/compiler/src/platform/ir/schema.ts` — add `template_refs` to `AgentMetadata`
- Create: `packages/compiler/src/__tests__/template-resolution.test.ts`

**Steps:**

1. Add `template_resolver` to `CompilerOptions` interface (line ~476)
2. In identity compilation block (line ~540), check for `doc.persona.templateRef`:
   - Call `resolveTemplateContent()` from Task 2.1 to resolve composition
   - Apply overrides, config vars, defaults
   - Preserve runtime-resolved variables as literal `{{name}}` placeholders
   - Set resolved string as `persona`
   - Emit compile error if template not found, warning if unresolved required vars
   - Record template names in `ir.metadata.template_refs`
3. Same for `doc.goal.templateRef` and `doc.systemPrompt` (if template ref form)
4. Add compiler tests

**Dependencies:** Tasks 2.1, 3.1

### Phase 4: Runtime API (2 tasks)

#### Task 4.1: Runtime Routes

**Files:**

- Create: `apps/runtime/src/routes/prompt-templates.ts`
- Edit: `apps/runtime/src/routes/index.ts` (or router registration file) — mount new routes

**Steps:**

1. Implement all endpoints from Section 9 using repo functions from Task 1.2
2. Add input validation (Zod schemas) for create/update payloads, including variable type validation
3. Auto-extract variables from content on create/update
4. Add `preview` endpoint that calls `resolveTemplateContent()` + renders with sample values
5. Add audit logging via existing `logAuditEvent()` pattern
6. Register routes under `/api/projects/:projectId/prompt-templates`

**Dependencies:** Tasks 1.2, 2.1

#### Task 4.2: Version Service Integration

**Files:**

- Edit: `apps/runtime/src/services/version-service.ts` — load templates for compiler

**Steps:**

1. In `createVersion()`, after loading config variables (~line 213), load active prompt templates and tenant builtins
2. Build `template_resolver` function from loaded templates (project overrides builtins)
3. Pass to compiler options
4. Test that agent versions compiled with `@template()` resolve correctly

**Dependencies:** Tasks 1.2, 3.2

### Phase 5: Studio Backend (1 task)

#### Task 5.1: Studio Proxy Routes

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/[templateId]/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/[templateId]/versions/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/[templateId]/clone/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/import/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/export/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/prompt-templates/preview/route.ts`

**Steps:**

1. Follow existing pattern from `apps/studio/src/app/api/projects/[id]/tools/route.ts`
2. Use `withRouteHandler` with `requireProject: true`
3. Add `StudioPermission.PROMPT_TEMPLATE_READ` and `PROMPT_TEMPLATE_WRITE` to permissions enum
4. Each route calls the repo functions directly (Studio has direct DB access, no runtime proxy needed)

**Dependencies:** Task 1.2

### Phase 6: Studio UI (3 tasks)

#### Task 6.1: Template List Page

**Files:**

- Create: `apps/studio/src/components/prompt-templates/TemplateListPage.tsx`
- Create: `apps/studio/src/components/prompt-templates/TemplateCard.tsx`
- Create: `apps/studio/src/components/prompt-templates/TemplateFilters.tsx`
- Create: `apps/studio/src/app/(main)/projects/[id]/templates/page.tsx`
- Edit: `apps/studio/src/components/layout/` (sidebar nav — add Templates link)

**Steps:**

1. Create page route with project layout
2. Build `TemplateListPage` with SWR data fetching (pattern: `AgentListPage.tsx`)
3. Build filter bar: category dropdown, status pills, search input, tag chips
4. Build `TemplateCard` component: name, category badge, tags, status, included-by count
5. Add "Create Template" button -> dialog with "Start from built-in" and "Extract from agent" options
6. Add sidebar navigation entry between Tools and Knowledge Bases

**Dependencies:** Task 5.1

#### Task 6.2: Template Editor Page

**Files:**

- Create: `apps/studio/src/components/prompt-templates/TemplateEditorPage.tsx`
- Create: `apps/studio/src/components/prompt-templates/TemplatePreview.tsx`
- Create: `apps/studio/src/components/prompt-templates/VariableTable.tsx`
- Create: `apps/studio/src/app/(main)/projects/[id]/templates/[templateId]/page.tsx`
- Create: `apps/studio/src/store/prompt-template-store.ts`

**Steps:**

1. Two-panel layout: Monaco editor (left), tabbed metadata/preview/variables/versions/usage (right)
2. Monaco editor with `{{variable}}` syntax highlighting and `@include("name")` decoration (pattern: `ABLEditor.tsx`)
3. Auto-extract variables on content change (debounced, 300ms)
4. `VariableTable`: extracted variables with description, default, required toggle, type dropdown, resolveAt toggle
5. `TemplatePreview`: call preview API, show interpolated output with includes resolved
6. Zustand store for editor state (dirty tracking, save, variable extraction)
7. Save triggers version creation (via API)
8. Metadata form: name (read-only after creation), display name, category, tags

**Dependencies:** Task 6.1

#### Task 6.3: Version History & Usage Tracking

**Files:**

- Create: `apps/studio/src/components/prompt-templates/TemplateVersionHistory.tsx`
- Create: `apps/studio/src/components/prompt-templates/TemplateUsagePanel.tsx`
- Edit: `apps/studio/src/components/prompt-templates/TemplateEditorPage.tsx` (wire up tabs)

**Steps:**

1. Version history in Versions tab: list of versions (timestamp, author, changelog)
2. Version diff view using Monaco diff editor (pattern: existing diff views in Studio)
3. Restore button: creates new version from selected old version's content
4. Usage panel: query agents in project for `@template("name")` references in their DSL content
5. Show agent names with links to agent detail pages
6. Show reverse-include graph: which other templates `@include` this one

**Dependencies:** Task 6.2

### Phase 7: Seed Data & Built-in Templates (1 task)

#### Task 7.1: Seed Script

**Files:**

- Create: `packages/shared/src/prompts/builtin-templates.ts` (template content definitions)
- Create: `apps/runtime/src/seed/prompt-template-seeds.ts` (seed function)
- Edit: `apps/runtime/src/seed/index.ts` (if exists) — add template seeding

**Steps:**

1. Define built-in template content for the 12 templates listed in Section 8
2. Each template includes well-crafted content with `{{variable}}` placeholders and `@include` composition where appropriate
3. Seed function: upsert built-in templates per tenant (idempotent via `builtIn: true` + name + tenantId)
4. Call during project creation flow (or as standalone seed command)
5. Built-in templates have `status: 'active'`, `builtIn: true`

**Dependencies:** Task 1.1

### Phase 8: Import/Export (1 task)

#### Task 8.1: Import/Export

**Files:**

- Create: `packages/shared/src/prompts/template-io.ts`
- Edit: Routes from Task 4.1 (import/export endpoints)

**Steps:**

1. Export format: JSON array of `{ name, displayName, category, content, variables, tags, includes }`
2. Import: validate schema (Zod), check name conflicts, batch create
3. Import modes: skip duplicates / overwrite / rename
4. Validate `@include` references resolve within the import batch or existing project templates
5. File size limit: 1 MB

**Dependencies:** Tasks 1.2, 4.1

---

## Summary: Task Dependency Graph

```
Task 1.1 (DB Models) -----> Task 1.2 (Repo) --------+---> Task 4.1 (Routes)
                                                      +---> Task 4.2 (Version Svc)
Task 2.1 (Composition) ---> Task 3.2 (Compiler) -----+---> Task 5.1 (Studio API)
                                                      |          |
Task 3.1 (Parser) --------> Task 3.2 (Compiler)      |          +---> Task 6.1 (List UI)
                                                      |                     |
                                                      |                     +---> Task 6.2 (Editor UI)
                                                      |                               |
                                                      |                               +---> Task 6.3 (Versions UI)
                                                      |
Task 7.1 (Seeds) <--- Task 1.1                       |
Task 8.1 (Import/Export) <--- Tasks 1.2, 4.1 --------+
```

**Parallelizable:** Tasks 1.1, 2.1, and 3.1 can all start in parallel (no dependencies between them).

## Estimated Effort

| Phase                       | Tasks  | Estimate    |
| --------------------------- | ------ | ----------- |
| Phase 1: Data Layer         | 2      | 1 day       |
| Phase 2: Composition Engine | 1      | 0.5 day     |
| Phase 3: Parser & Compiler  | 2      | 1.5 days    |
| Phase 4: Runtime API        | 2      | 1 day       |
| Phase 5: Studio Backend     | 1      | 0.5 day     |
| Phase 6: Studio UI          | 3      | 2.5 days    |
| Phase 7: Seed Data          | 1      | 0.5 day     |
| Phase 8: Import/Export      | 1      | 0.5 day     |
| **Total**                   | **13** | **~8 days** |

---

## Appendix: Future Considerations (v2)

These features are deliberately deferred but should be straightforward to add given the v1 foundation:

1. **Template analytics:** When ClickHouse pipeline matures, emit `template_used` events from compilation. Dashboards show which templates are most used, which agents use them, and version adoption curves.

2. **A/B prompt testing:** Leverage Deployment environments. Create two agent versions pointing to different template versions. Split traffic at the deployment layer. Compare metrics (completion rate, CSAT, escalation rate).

3. **Cross-project sharing:** Add `tenant_prompt_templates` collection (tenant-scoped, not project-scoped). Templates can be "published" from a project to the tenant library. Other projects can import from tenant library.

4. **Template inheritance:** If composition proves insufficient, add `EXTENDS: @template("base")` syntax with section-level override markers (`@override("section_name")`). This is significantly more complex than `@include` and should only be built if real usage patterns demand it.

5. **Prompt playground:** Full mock conversation testing with template variants. Depends on Chat Debugger infrastructure. The v1 preview panel covers static rendering; playground adds multi-turn conversation simulation.
