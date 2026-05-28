# Custom Pipeline Authoring UX Redesign

**Date:** 2026-04-24
**Status:** Approved (brainstorming phase)
**Scope:** `packages/pipeline-engine`, `apps/runtime`, `apps/studio`
**Primary users:** power authors (P1), reliability-first operators (P2)
**Related specs:**
`docs/superpowers/specs/2026-03-13-trigger-on-canvas-design.md`,
`docs/superpowers/specs/2026-04-14-unified-trigger-types-design.md`,
`docs/superpowers/specs/2026-03-12-output-schema-builder-design.md`,
`docs/superpowers/specs/2026-03-12-llm-evaluate-node-design.md`,
`docs/specs/pipeline-editor-v2.component-spec.md`

---

## 1. Problem

The custom-pipeline authoring flow has five independent classes of silent failure and three missing capabilities. Even experienced authors hit cliffs.

**Silent failures observed in the current flow:**

1. **Trigger ↔ node compatibility is not enforced at save time.** A pipeline with a `session-ended` trigger and a `read-message-window` first node saves and activates cleanly, then fails at runtime because `read-message-window` requires a `payload` field the trigger doesn't provide.
2. **Field references in node config are free text.** `LLM Evaluate`'s `userPrompt` is rendered as a raw `<textarea>` (`apps/studio/src/components/pipelines/ConfigSchemaForm.tsx:242`). Expressions like `{{steps.<id>.output.<field>}}` have no autocomplete and no validation — swapping a node type silently breaks every downstream reference.
3. **Preview capability is not surfaced and is leaky.** `findStoreTable` (`apps/runtime/src/services/pipeline-observability/previewable-pipelines-service.ts:26`) returns a table name whenever ANY `store-results` node has one, regardless of `destination`. Mongo-destination pipelines appear in the Preview dropdown then fail with `INVALID_TABLE` because the query builder requires `database.table` format for ClickHouse.
4. **Run failures surface as raw JSON.** `StepsList.tsx:89` renders a failed step's `output` via `<JsonViewer>`. No link to the offending node, no interpretation, no remediation action.
5. **Test-drawer payload templates are generic.** `PipelineTestDrawer.tsx:43` synthesises placeholder values from key names (e.g. `session-test-001`, `msg-test-001`). It does not know the nested payload shape that `user-message` / `agent-message` triggers actually carry.

**Missing capabilities the team wants:**

6. **Re-drive from failed step** — re-fire a run using its stored `triggerInput` after the user fixes the pipeline.
7. **Pipeline templates** — start from a known-good recipe rather than a blank canvas.
8. **Live dataflow preview at edit time** — click any node, see sample output from a real session, so field references can be verified before the user saves or runs.

## 2. Goals, non-goals, and success signals

### Goals (prioritised)

1. **Make invalid pipelines unrepresentable** — or, at minimum, impossible to save without an explicit override.
2. **Turn every runtime-authoring error into a save-time error.**
3. **Make iteration fast** — edit → see expected data → run → see actual data → fix → re-drive, in one session.
4. **Preserve existing pipelines** — grandfather with warnings, never break running production.

### Non-goals

- Onboarding wizards for first-time authors (P1/P2 do not need hand-holding).
- Import/export pipeline as JSON/YAML.
- Cost + latency estimation at edit time.
- Runtime engine or Restate activity-router refactor.
- A data-model unification of `definition.trigger` with `definition.nodes[0]` — the trigger-on-canvas spec already keeps these visually joined while logically separate; that pattern stays.

### Success signals

- **P1 — Power author:** authoring a new pipeline never hits a runtime error for a mistake the editor had enough information to catch. Mean time from "change upstream node" to "downstream references updated correctly" is a single session (autocomplete surfaces the mismatch immediately).
- **P2 — Reliability operator:** triaging a failed production run reaches the exact offending node in one click. Re-drive completes without hand-crafting the trigger payload.
- **Zero silent misleads on the Preview tab:** a pipeline shown in the previewable list must actually be previewable end-to-end.

## 3. Architectural spine — the contract model

Every pipeline element declares a **typed contract**. Three contract types; everything else derives from them.

### 3.1 TriggerContract

```ts
export interface TriggerContract {
  id: string; // 'session-ended', 'user-message', ...
  category: 'session' | 'message' | 'manual' | 'schedule';
  type: 'kafka' | 'manual' | 'schedule';
  kafkaTopic?: string;
  label: string;
  description: string;
  outputSchema: {
    // what a pipelineInput will contain when this trigger fires
    required: string[]; // ['tenantId', 'sessionId']
    properties: Record<string, { type: string; description: string }>;
  };
  exampleOutput: Record<string, unknown>; // realistic payload used by PipelineTestDrawer templates
}
```

**Source of truth for:** trigger picker metadata, test-drawer templates, node-compatibility checks, dataflow-preview synthetic inputs.

**60% of this already exists** in `packages/pipeline-engine/src/pipeline/trigger-templates/` and in the existing trigger registry. The missing pieces are `exampleOutput` (new field per trigger) and consumer wiring.

### 3.2 NodeContract

```ts
export interface NodeContract {
  type: string; // 'read-conversation'
  category: NodeCategory; // 'data' | 'logic' | 'integration' | 'compute' | 'action'
  label: string;
  description: string;

  /** Input requirements — what the node expects. */
  inputRequirements: {
    /** Keys the node reads directly from pipelineInput (i.e. from the trigger). */
    fromTrigger: string[]; // ['sessionId']
    /** Upstream step output fields the node reads by convention (e.g. compute-sentiment reads `transcript`). */
    fromPreviousSteps?: Record<string, string[]>;
  };

  /** Config schema (existing shape, formalised). */
  configSchema: {
    required: string[];
    properties: Record<string, ConfigField>;
  };

  /** Output schema — used by expression autocomplete for downstream nodes. */
  outputSchema: {
    properties: Record<string, { type: string; description?: string }>;
  };

  /** Allowlist of compatible trigger IDs. '*' means "works with any trigger". */
  compatibleTriggers: string[] | '*';

  /** Side-effect class — tells the dataflow-preview engine what's safe to re-execute. */
  sideEffectClass: 'pure' | 'read' | 'write' | 'external';

  /** Version bumped whenever the contract tightens. Pipelines stamp their `contractVersion` at save time. */
  contractVersion: number;

  defaultTimeout?: number;
  defaultRetries?: number;
}
```

**Source of truth for:** node palette filtering by active trigger, save-time trigger↔node validation, expression autocomplete, expression reference validation, dataflow preview eligibility.

**Relationship to `activity-metadata.ts`:** `NodeContract` is the richer successor. P1 introduces the contract shape and adapts existing `activity-metadata.ts` entries into it (no deletion). Existing fields (`name`, `description`, `configSchema`, `outputSchema`, `defaultTimeout`, `defaultRetries`) map 1:1. New fields (`inputRequirements`, `compatibleTriggers`, `sideEffectClass`, `contractVersion`) are authored per node type during P1. Once all contracts are populated and consumers switched over, `activity-metadata.ts` becomes a re-export of `NodeContract`-derived data and is deleted in a follow-up cleanup commit. During the transition (P1–P4), both shapes exist; `ContractRegistry` is the single read surface.

### 3.3 DestinationContract

```ts
export interface DestinationContract {
  id: 'clickhouse' | 'mongodb' | 'callback' | 'none';
  label: string;
  table: {
    format: 'database.table' | 'collection' | 'url' | 'none';
    regex?: RegExp;
    required: boolean;
    labelText: string; // "ClickHouse table", "MongoDB collection", "Callback URL"
  };
  previewable: boolean; // only ClickHouse is `true`
  requiresOutputSchema: boolean; // only ClickHouse is `true`
  dependentFields: Array<{
    field: string; // e.g. 'outputSchema'
    visibility: 'required' | 'optional' | 'hidden';
  }>;
}
```

**Source of truth for:** `store-results` config enum + dependent fields, preview-tab filter, table-name validation, ClickHouse DDL hints.

New concept — does not exist today in any form.

### 3.4 ContractRegistry

Single lookup surface exported from `@agent-platform/pipeline-engine/contracts`:

```ts
export class ContractRegistry {
  getTrigger(id: string): TriggerContract | undefined;
  getNode(type: string): NodeContract | undefined;
  getDestination(id: string): DestinationContract | undefined;
  listTriggers(): TriggerContract[];
  listNodes(): NodeContract[];
  listDestinations(): DestinationContract[];
}
```

Loaded once per runtime + once per Studio editor session via `GET /api/pipelines/contracts` (or the existing per-category endpoints, extended).

### 3.5 Derivation table — every IN-scope capability is a pure function of contracts

| Capability                                     | Derived from                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Trigger ↔ node save-time validation            | `Node.inputRequirements.fromTrigger` × `Trigger.outputSchema.required`              |
| Node palette filtering by active trigger       | `Node.compatibleTriggers`                                                           |
| Expression autocomplete `{{steps.X.output.*}}` | upstream `Node.outputSchema.properties`                                             |
| Expression reference validation (red squiggle) | cross-check against upstream `outputSchema`                                         |
| Destination enum + dependent fields            | `DestinationContract.table.format` + `dependentFields`                              |
| Preview tab filter                             | `DestinationContract.previewable` + `table.regex` match                             |
| Test-drawer realistic payloads                 | `TriggerContract.exampleOutput`                                                     |
| Run-failure jump-to-node                       | failed step `id` already in run record; editor URL targets that node                |
| Re-drive from failed step                      | stored `triggerInput` (already persisted per ABLP-280 Phase 1)                      |
| Pipeline templates                             | pre-wired definitions that conform to contracts (CI-validated)                      |
| Live dataflow preview                          | `sideEffectClass` gates what's safe to re-run; `outputSchema` defines display shape |

## 4. UX surfaces

### 4.1 Node palette filtering

`NodePalette.tsx` gains access to the current pipeline's active trigger(s). Nodes whose `inputRequirements.fromTrigger` are NOT satisfied by the trigger's `outputSchema.required` are rendered at reduced opacity with an inline reason (e.g. _"Requires `payload` — use with `user-message`"_). They remain draggable — the user can still override — but `validateGraphPipeline` will reject the save.

### 4.2 Expression editor and available data

Replace the plain `<textarea>` in `ConfigSchemaForm.tsx:242` with the existing Monaco integration already used in Studio, configured for expression-aware fields only:

- The editor tokenises `{{...}}` references with Handlebars syntax support.
- Autocomplete lists direct upstream `steps.<upstream-id>.output.<field>` candidates from each upstream node's `NodeContract.outputSchema.properties`.
- Markers flag unresolved node IDs or fields when the graph topology or field value changes.
- Hover/tooltips show the declared field type and description from the contract.

The right-side node config panel also renders an **Available Data** section for the selected node. This section is intentionally narrow: it only shows the selected node's direct upstream output schema, never trigger aliases or unrelated graph nodes. Clicking a field copies or inserts the canonical expression path, for example `steps.read-conversation.output.transcript`, into the currently focused expression field.

### 4.3 Store Results config

`ConfigSchemaForm` gains support for **enum fields with dependent-field rules**, driven by `DestinationContract`. The `store-results` node now separates analytics projections from document persistence:

- `destination` becomes a 4-option `<Select>` instead of a text input.
- The target field re-labels per destination: `Table` for ClickHouse, `Collection` for MongoDB, and `Callback URL` for callbacks. Placeholder, helper copy, and regex update with the selected destination.
- `storageStrategy` controls persistence: `score_and_document`, `score_only`, or `document_only`.
- `scorePath` and `scoreName` describe the single numeric score projected into ClickHouse. If `scorePath` is omitted, runtime auto-detects common fields such as `overallScore`, `score`, `rating`, `value`, or `confidence`.
- `documentPath` describes the object payload written into MongoDB.
- ClickHouse defaults to the shared `abl_platform.custom_pipeline_results` table when the table is blank. That table stores metadata plus `score_name`, `score_path`, `score_value`, and a minimal `output_json` audit payload.
- MongoDB defaults to the shared `custom_pipeline_results` collection when the collection is blank and stores the full document payload.
- Selecting Store Results in Studio shows **Save Suggestions** derived from the direct upstream output schema: numeric fields can wire the ClickHouse score, and full upstream outputs can wire the MongoDB document.

### 4.4 Preview-tab filter

`findStoreTable` in `apps/runtime/src/services/pipeline-observability/previewable-pipelines-service.ts` switches from "any store-results table" to:

```ts
function findStoreTable(def, registry): string | null {
  const storeNode = findStoreResultsNode(def);
  if (!storeNode) return null;

  const destination = registry.getDestination(storeNode.config.destination ?? 'none');
  if (!destination?.previewable) return null;

  const table = storeNode.config.table;
  if (!destination.table.regex?.test(table ?? '')) return null;

  return table;
}
```

Mongo-destination pipelines disappear from the Preview dropdown. Users who still want to inspect Mongo data get a link to project-scoped Mongo query docs (existing doc).

### 4.5 Run-failure panel

`apps/studio/src/components/pipelines/runs/StepsList.tsx` gets a small error interpreter:

```ts
const RUN_ERROR_CATALOG: Array<{
  match: RegExp;
  diagnosis: (m: RegExpExecArray) => string;
  action?: 'open-in-editor' | 'redrive' | 'docs-link';
}> = [
  {
    match: /(\w+) requires payload in pipelineInput/,
    diagnosis: (m) =>
      `${m[1]} needs a trigger that provides a message payload (user-message or agent-message). Current trigger: session-ended.`,
    action: 'open-in-editor',
  },
  {
    match: /Invalid table name: (.+)/,
    diagnosis: (m) =>
      `Table "${m[1]}" is not valid for the selected destination. ClickHouse requires database.table format.`,
    action: 'open-in-editor',
  },
  // ...
];
```

Below the parsed diagnosis, two buttons render whenever applicable:

- **Open in editor** → navigates to the pipeline editor with `?selectedNodeId=<step.id>`, which pre-selects the failing node and opens its config panel.
- **Re-drive with same input** → calls the new redrive endpoint with the run's stored `triggerInput`.

When no catalog entry matches, the raw `JsonViewer` still renders as a fallback.

### 4.6 Test drawer

`PipelineTestDrawer.tsx:43-88` (`buildStringTemplate` + `buildTemplateFromInputSchema`) is replaced by a single resolver:

```ts
function buildTestPayload(trigger: TriggerContract): Record<string, unknown> {
  return structuredClone(trigger.exampleOutput);
}
```

`exampleOutput` is authored per trigger in `packages/pipeline-engine/src/pipeline/trigger-templates/<trigger>.json`, reviewed like any other contract data.

### 4.7 Re-drive endpoint

```
POST /api/pipelines/runs/:runId/redrive
→ { success: true, runId: <newRunId> }
```

Handler loads the run record, reads its `triggerInput` and `trigger.triggerId`, and dispatches to the same `/api/pipelines/:pipelineId/test` flow under the hood. Tenant-scoped, requires the same permission as the original trigger path. Does not re-validate the pipeline against contracts — the user explicitly asked to replay the failing scenario.

### 4.8 Templates

Template storage: `packages/pipeline-engine/src/pipeline/templates/` — one JSON file per template, plus an `index.json` listing them. Each template is a full `PipelineDefinition` conformant to current `contractVersion`.

Initial template set (v1):

| Template id             | Starts from     | Nodes                                                                                   |
| ----------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `blank`                 | any trigger     | —                                                                                       |
| `evaluate-quality`      | `session-ended` | `read-conversation` → `compute-quality` → `store-results (score + document)`            |
| `per-message-guardrail` | `user-message`  | `read-message-window` → `llm-evaluate` → `store-results (Mongo document)`               |
| `llm-as-judge-scoring`  | `session-ended` | `read-conversation` → `llm-evaluate (with rubric)` → `store-results (score + document)` |

`POST /api/pipelines/templates/:id/clone` body: `{ projectId, name }`. Handler clones the template JSON, stamps `_id`, `tenantId`, `projectId`, `createdBy`, and the current `contractVersion` on each node.

CI: a lightweight test asserts every template conforms to the live `ContractRegistry`. Templates that fall out of date block the build — forcing updates when contracts change.

### 4.9 Live dataflow preview

New runtime endpoint:

```
POST /api/runtime/projects/:projectId/pipelines/:pipelineId/preview-node
Body: { nodeId: string, sampleSessionId: string }
→ { success: true, output: unknown, upstreamCached: boolean }
```

Conceptual handler flow:

1. Resolves the node's ancestors in the pipeline graph via `findReachableNodes` (in reverse).
2. For each ancestor, walks in topological order and invokes the node's activity in **preview mode** — a new flag added to `PipelineStepContext`:
   - Ancestors with `sideEffectClass: 'pure'` or `'read'` execute normally.
   - Ancestors with `sideEffectClass: 'write'` short-circuit (e.g. `store-results` returns `{ status: 'success', data: { recordsWritten: 0, skipped: 'preview' } }` without touching Mongo/ClickHouse/callbacks).
   - Ancestors with `sideEffectClass: 'external'` are cache-first: if a cached output exists for this (pipeline-hash, node, session-id), use it; otherwise short-circuit with a clear error ("Re-run in live mode to populate preview cache").
3. Returns the selected node's computed output.

Caching: Redis key `pipeline:preview:{tenantId}:{pipelineHash}:{nodeId}:{sessionId}` with 5-minute TTL. Hash includes node config so preview invalidates on edit.

Studio integration: `NodeConfigPanel` gains a `[Preview]` tab next to `[Config]`. On tab switch, fetches `POST /preview-node` with the user-selected session (a session picker reuses the existing test-drawer session search).

> **P7 requires its own sub-design before implementation.** The decisions above treat execution mechanics (in-process call vs new Restate workflow invocation vs dedicated preview worker), the exact location and shape of the `preview` context flag, per-activity preview-branch implementation cost, and tenant-isolated sample-session access are all open. P7 should enter a separate brainstorming pass after P1–P5 ship, producing its own design doc (`docs/superpowers/specs/YYYY-MM-DD-pipeline-dataflow-preview-design.md`).

## 5. Data model, APIs, and code organisation

### 5.1 New package directory

```
packages/pipeline-engine/src/pipeline/contracts/
├── trigger-contract.ts
├── node-contract.ts
├── destination-contract.ts
├── registry.ts
├── validators/
│   ├── trigger-compat.ts
│   ├── expression-refs.ts
│   └── destination-table.ts
└── templates/                 # populated in P6
    ├── index.json
    ├── evaluate-quality.json
    └── ...
```

Exported via `@agent-platform/pipeline-engine/contracts` (new barrel).

### 5.2 No Mongo schema changes

Contracts live in code, not in Mongo. Each node records the `contractVersion` it was authored against when it is saved — a new optional field on `PipelineNode`:

```ts
interface PipelineNode {
  // existing fields...
  contractVersion?: number; // absent = legacy (grandfather mode)
}
```

This is additive and does not require a migration.

### 5.3 API additions and extensions

| Route                                                              | Status                      | Purpose                                                                                                                                                                                            |
| ------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/pipelines/contracts`                                     | **new**                     | Returns `{ triggers, nodes, destinations }` as a single fetch. Studio calls this once per editor session.                                                                                          |
| `GET /api/pipelines/nodes`                                         | existing, response extended | Adds `inputRequirements`, `compatibleTriggers`, `sideEffectClass`, `contractVersion` to each node. Back-compat: legacy consumers that only read `label`/`description`/`configSchema` keep working. |
| `GET /api/pipelines/triggers`                                      | existing, response extended | Adds `exampleOutput` per trigger.                                                                                                                                                                  |
| `GET /api/pipelines/destinations`                                  | **new**                     | Destination enum and rules.                                                                                                                                                                        |
| `GET /api/pipelines/templates`                                     | **new**                     | List of available templates with summaries.                                                                                                                                                        |
| `POST /api/pipelines/templates/:id/clone`                          | **new**                     | Clone a template into a project.                                                                                                                                                                   |
| `POST /api/pipelines/runs/:runId/redrive`                          | **new**                     | Replay a run with stored `triggerInput`.                                                                                                                                                           |
| `POST /api/runtime/projects/:projectId/pipelines/:id/preview-node` | **new**                     | Compute sample output for a single node.                                                                                                                                                           |

### 5.4 Studio state additions

`usePipelineEditorStore`:

- `contracts: ContractRegistry | null` — fetched on editor open.
- `previewResults: Map<nodeId, PreviewResult>` — cached preview outputs keyed by node id.
- `validationIssues: ValidationIssue[]` — derived from contract-based validators; already partially exists, just expanded.
- `runInterpreter: ErrorCatalogEntry[]` — static import, not state.

### 5.5 Rollout strategy

Each phase that changes user-visible behaviour (P2 onward) ships behind the project's established rollout pattern — to be confirmed during LLD (likely a feature flag keyed by tenant or project; reuse existing infrastructure, do not introduce a new flag service). Contracts themselves (P1) ship without any flag: they are internal data and affect no user-visible surface.

Flag retirement: once a phase has been ON globally for one release cycle without regression, the flag is removed in a dedicated cleanup commit (one per phase).

## 6. Backwards compatibility and migration

### 6.1 Grandfather rule

Any pipeline whose nodes lack `contractVersion` is **legacy**. The editor still loads it. `validateGraphPipeline` runs contract checks in _warn_ mode instead of _error_ mode for legacy pipelines — the toolbar shows warnings but the Save button remains enabled. A one-line banner at the top of the editor says:

> This pipeline was authored before the strict contract system. Re-save to enable full validation.

Once a user saves, every node is stamped with the current `contractVersion` and strict mode applies on all subsequent saves.

**Kafka-triggered runs of legacy pipelines keep working.** The execution path does not re-validate against contracts.

### 6.2 Targeted automated migration

A one-shot script `tools/migrate-pipeline-contracts.ts` runs once when P2 is deployed. It is idempotent and makes no destructive or mutating changes to pipeline config:

1. For each `PipelineDefinition` with at least one `store-results` node missing an explicit `destination`: leave config unchanged. The new `findStoreTable` filter handles the user-visible surface.
2. For each pipeline whose trigger references a renamed/deprecated trigger: append an entry to `pipeline_config.migration_notes[]`. Reviewable via `GET /api/pipelines/:id` but not yet surfaced in a UI panel (follow-up work).

Deployment: executed manually against each environment (dev → staging → prod) by the engineer shipping P2, logged in the P2 release notes. Safe to run repeatedly — the script detects already-processed definitions via the `migration_notes` marker.

## 7. Delivery phasing

Seven independently shippable phases, ~12–13 weeks total. Each phase respects the commit discipline rules (≤40 files, ≤3 packages, additive feat commits).

| Phase                                                        | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Weeks | Depends on             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------- |
| **P1 — Contract foundation** ✅ shipped 2026-04-24           | Define 3 contract types, `ContractRegistry`, migrate `activity-metadata.ts` to `NodeContract` (additive), add `exampleOutput` to triggers, add `DestinationContract` set. Zero user-visible change.                                                                                                                                                                                                                                                                                        | 2     | —                      |
| **P2 — Save-time gates** ✅ shipped 2026-04-24               | `validateGraphPipeline` trigger↔node compat check. `findStoreTable` respects `DestinationContract.previewable`. Studio POST/PATCH wired with `ContractRegistry` + stamp `contractVersion` on save. First user-visible reliability win.                                                                                                                                                                                                                                                     | 1     | P1                     |
| **P3 — Destination UX + test drawer** ✅ shipped 2026-04-25  | `ConfigSchemaForm` dependent-field rules driven by `DestinationContract`. Test drawer uses `TriggerContract.exampleOutput`. Adds `info` ConfigField type for non-interactive inline banners. `none` destination option added. Store-results seed gains four contextual banners (ClickHouse format hint + Mongo/callback/none preview-not-supported warnings). `exampleOutput` now flows through `TriggerDefinition → ResolvedTrigger → TriggerEntry → Mongoose schema → Studio drawer`.    | 1     | P1                     |
| **P4 — Run UX + re-drive** ✅ shipped 2026-04-25             | Error interpreter catalog (10-entry regex catalog in `apps/studio/src/lib/pipeline-run-error-interpreter.ts`), "Open in editor" + "Re-drive" buttons in `StepsList`, `POST /api/pipelines/runs/:runId/redrive` endpoint, editor reads `?selectedNodeId` on mount to focus the failing node.                                                                                                                                                                                                | 1.5   | P2                     |
| **P5 — Expression editor** ✅ shipped 2026-04-25             | Monaco (already installed) replaces `<textarea>` for `expressionAware` multiline fields. Handlebars syntax highlighting for `{{...}}`. Autocomplete from upstream node `outputSchema` (ContractRegistry). Red-squiggle markers for unresolved node IDs or unknown fields. Lazy-loaded via `React.lazy` to keep Monaco out of the initial bundle. `llm-evaluate` `systemPrompt` + `userPrompt` marked `expressionAware`. Pure utility `extractExpressionRefs()` unit-tested separately.     | 3     | P1                     |
| **P6 — Templates** ✅ shipped 2026-04-25                     | 3 template JSONs (`quality-evaluator`, `llm-evaluator`, `per-message-guardrail`) + blank. `template-registry.ts` loader + `./templates` subpath export. `GET /api/pipelines/templates` + `POST /api/pipelines/templates/:id/clone`. Studio `TemplatePicker` modal replaces direct-to-editor on "New Pipeline". 9-test conformance suite blocks CI if a template fails graph validation. Fixed: `payload` added to `user-message` + `agent-message` trigger `outputSchema.required`.        | 1     | P1, P2                 |
| **P7 — Live dataflow preview** ✅ shipped 2026-04-25         | `previewNode()` service in `preview.service.ts`: minimal Restate context mock (`ctx.run` → direct call), BFS upstream path-finding, `write`/`external` nodes short-circuited. `SERVICE_HANDLERS` exported from activity-router. `POST /api/runtime/.../preview-node` route. Studio: collapsible "Preview output" section in `NodeConfigPanel` with session picker, "Run preview" button, JSON output. 7 path-finding unit tests. **No Redis cache in V1** (deferred — call is idempotent). | 3–4   | P1, P5, own sub-design |
| **P8 — Store Results analytics split** ✅ shipped 2026-04-25 | `store-results` now supports `storageStrategy`, `scorePath`, `scoreName`, and `documentPath`. ClickHouse shared-table writes are limited to one numeric score projection (`score_name`, `score_path`, `score_value`) plus metadata, while MongoDB stores full document payloads. Studio Store Results shows upstream-derived Save Suggestions to wire score/document paths without hand-typing expressions. Template Store Results nodes use the new strategy fields.                      | 1     | P1, P3, P5             |

Critical path to first reliability value: **P1 → P2 → P4** (~4.5 weeks). P5, P6, P7 run in parallel after P1.

## 8. Testing strategy

Per repo rules: minimum 5 E2E + 5 integration scenarios per feature. No mocking of internal packages. E2E tests hit real Express servers on random ports with the full middleware chain.

| Phase | Unit                                     | Integration                                                                                                                                               | E2E                                                                                                                                                        |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Contract validators (pure functions).    | Load `ContractRegistry`, assert every existing node/trigger/destination maps to a valid contract.                                                         | — (no user-visible surface)                                                                                                                                |
| P2    | Validator extensions.                    | `validateGraphPipeline` extended cases. Legacy grandfather path. `findStoreTable` filter.                                                                 | POST malformed pipeline → 400 with structured error naming offending node+field. Save legacy pipeline → warnings, no block.                                |
| P3    | Dependent-field resolution.              | `ConfigSchemaForm` rules for each destination.                                                                                                            | Change destination `clickhouse → mongodb` → preview dropdown removes pipeline. Open test drawer for each trigger → template matches `exampleOutput`.       |
| P4    | Error interpreter regex matching.        | Redrive endpoint auth + payload copy.                                                                                                                     | Failed run → Open-in-editor selects failing node via `?selectedNodeId`. Redrive creates a new run whose `triggerInput` equals the original's.              |
| P5    | Expression parser + completion provider. | Autocomplete API for a given (pipeline, node) returns expected fields.                                                                                    | Type `{{steps.X.output.` in a config field → dropdown shows upstream fields. Rename upstream node → downstream squiggle appears.                           |
| P6    | Template JSON schema validation.         | Every committed template conforms to live `ContractRegistry`.                                                                                             | Clone template → new pipeline is runnable, runs end-to-end.                                                                                                |
| P7    | Side-effect gating per class.            | Preview endpoint with `write`-class ancestor → no Mongo/ClickHouse writes. Preview with `external`-class ancestor and empty cache → clear error response. | Preview a node against a real sample session → output shape matches declared `outputSchema`. Preview caches for 5 min and invalidates on node config edit. |

## 9. Open questions

1. **Session-picker scope for dataflow preview (P7).** Should the session picker only show sessions the current user created, or any session in the project? Recommend: project-scoped, since P2 operators triage sessions they don't own. Confirm before P7 design.
2. **Contract versioning cadence.** When does `contractVersion` increment? Recommend: per node type, whenever `inputRequirements` or `compatibleTriggers` change (not on cosmetic changes). Document in `packages/pipeline-engine/agents.md` when P1 lands.
3. **Expression-aware config field opt-in.** Which existing config fields should flag `expressionAware: true` in P5? Recommend: all multiline string fields plus any field whose description mentions `{{`. Finalise during P5 design.
4. **Template localisation.** Should template `label`/`description` be wrapped in `next-intl` keys? Recommend: yes — consistent with rest of Studio. Adds minor P6 work.

## 10. Follow-ups flagged out of this effort

- Import/export pipeline as JSON/YAML.
- Cost + latency estimation at edit time.
- First-timer onboarding wizard (distinct from the power-user template picker).
- Dedicated Studio diagnostics panel for `pipeline_config.migration_notes` entries.
- Expression library (save + reuse expressions across pipelines).
