# Arch Spec Generation & Vercel Mock Deploy

**Date:** 2026-02-17
**Status:** Approved
**Author:** Prasanna + Arch AI

## Problem

Users starting with a domain idea have no fast path to a working set of agents with live HTTP tools. They must manually define topology, write each agent, create tool definitions, and stand up mock backends — a multi-hour process that discourages experimentation.

## Solution

A single flow in the Ideate stage that takes a domain description and generates a complete agent spec — topology, agents with tools, OpenAPI spec, and mock API handlers — deployable to Vercel with one click.

## 1. User Flow & UI

### Entry Point

New toggle in the Ideate stage: **Interview Mode** (existing guided chat) vs **Quick Generate** (this feature).

Quick Generate presents a form:

- **Domain name** — short label (e.g., "Hotel Booking")
- **Problem statement** — one-liner describing what the agents solve
- **Details** — optional textarea for constraints, edge cases, example scenarios

### Progress Stepper

On submit, a horizontal stepper shows four stages with real-time status:

1. **Topology** — agent graph and relationships
2. **Agents** — full agent definitions with tools, flows, gather fields
3. **API Spec** — OpenAPI 3.1 for all HTTP tools
4. **Mock Data** — Vercel-deployable mock handlers with realistic sample data

Each stage transitions through: pending → running (spinner) → complete (checkmark) / error.

### Review Screen

After pipeline completion, a tabbed view:

| Tab       | Content                                              |
| --------- | ---------------------------------------------------- |
| Topology  | Visual graph (reuses TopologyCanvas)                 |
| Agents    | Accordion list — expand to see ABL preview per agent |
| API Spec  | Rendered OpenAPI (paths, schemas, example payloads)  |
| Mock Data | File tree of the generated Vercel project            |

**Action bar:**

- **Regenerate** — re-runs full pipeline with same input
- **Deploy to Vercel** — deploys mock APIs (see Section 4)
- **Import to Project** — pushes topology + agents into the current project, advances to Design stage

### Edit & Refine

Each completed stage has an **Edit** button. Clicking it opens a scoped Arch chat panel alongside the stage's tab content. The chat receives the stage's current output as context and a scoped system prompt (e.g., "You are editing the agent topology for a hotel booking domain").

**Cascade rule:** Editing stage N re-runs stages N+1 through 4 with the updated output. The UI shows downstream stages returning to "running" state. The pipeline runs uninterrupted by default — Edit is opt-in per stage.

## 2. Pipeline Architecture

### Staged Pipeline

Four sequential stages, each calling `POST /api/arch/generate`:

```
topology → agents → openapi → mocks
```

Each stage receives all prior stage results as context. The LLM call for each stage gets a purpose-built system prompt and the accumulated outputs.

### API Extensions

New `type` values on `/api/arch/generate`:

| type           | Input context               | Output                           |
| -------------- | --------------------------- | -------------------------------- |
| `openapi`      | topology + agents           | OpenAPI 3.1 spec with x-examples |
| `mock_project` | topology + agents + openapi | MockProjectBundle (file tree)    |

Existing types `topology` and `agents` remain unchanged.

### Edit Context

When a stage is being edited via chat, the request includes:

- `editingStage: string` — which stage is being refined
- `generatedSpec: object` — the current pipeline state (all stage results)

The LLM receives the current stage output and user feedback, returns a revised version of that stage's output only.

## 3. Data Flow & State Management

### Spec Generation Store

New Zustand store (`spec-generation-store.ts`), separate from arch-store:

```typescript
interface SpecGenerationStore {
  // Pipeline
  pipelineStatus: 'idle' | 'running' | 'complete' | 'error';
  currentStage: 'topology' | 'agents' | 'openapi' | 'mocks' | null;
  stageResults: {
    topology: TopologyGraph | null;
    agents: AgentIR[] | null;
    openapi: OpenAPISpec | null;
    mockProject: MockProjectBundle | null;
  };
  stageErrors: Record<string, string>;

  // Editing
  editingStage: string | null;
  editHistory: EditHistoryEntry[];

  // Actions
  startPipeline(input: SpecGenInput): void;
  updateStageResult(stage: string, result: unknown): void;
  startEditing(stage: string): void;
  commitEdit(stage: string, updatedResult: unknown): void;
  reset(): void;
}
```

### Pipeline Execution

1. `startPipeline` sets status to `running`, currentStage to `topology`
2. Each stage calls `/api/arch/generate` with its type and prior results as context
3. On success, `updateStageResult` stores the output and advances `currentStage`
4. On final stage completion, `pipelineStatus` becomes `complete`

### Cascade on Edit

`commitEdit(stage)`:

1. Updates `stageResults[stage]` with revised output
2. Clears all `stageResults` entries after that stage
3. Re-runs the pipeline from the next stage forward with updated context
4. UI reflects downstream stages returning to running state

### Integration with Existing Stores

- **arch-store:** Edit chat reuses `ArchChat` component with scoped context. `editingStage` tells ArchChat which system prompt and context to inject.
- **lifecycle-store:** "Import to Project" transforms `stageResults` into lifecycle-store format (agents added, topology updated). One-way push — spec-generation-store is discarded after import.
- **No persistence.** Pipeline state is ephemeral. The exported zip or project import is the durable artifact.

### Data Shapes

| Stage    | Input                               | Output                                                                 |
| -------- | ----------------------------------- | ---------------------------------------------------------------------- |
| topology | domain + problem + details          | `TopologyGraph` — nodes, edges, agent names, relationships             |
| agents   | topology + domain context           | `AgentIR[]` — full IR per agent with tools, flows, gather fields       |
| openapi  | agents (tool defs) + domain context | `OpenAPISpec` — paths, schemas, request/response models, x-examples    |
| mocks    | openapi + agents + domain context   | `MockProjectBundle` — Vercel project files, mock handlers, sample data |

## 4. Vercel Deploy Integration

### What Gets Deployed

A standalone Vercel project:

- `/api/[path].ts` — one serverless function per OpenAPI path, returning mock responses from co-located JSON
- `/api/_schema.json` — the generated OpenAPI spec for endpoint discovery
- `vercel.json` — route config, CORS headers (`*`), project settings
- `package.json` — minimal, no external dependencies
- `_data/[operationId].json` — mock response data per endpoint

Each handler reads its `_data` file, matches on method + path params, and returns the mock response with correct status codes and content-type. No logic beyond pattern matching.

### Deploy Flow (Vercel CLI)

1. User clicks "Deploy to Vercel" in review screen or deploy stage
2. UI calls `POST /api/arch/deploy-mocks` with `MockProjectBundle` from store
3. Backend writes bundle to a temp directory
4. Backend runs `vercel deploy --yes --token $VERCEL_TOKEN`
5. Returns deployment URL (e.g., `https://my-domain-mocks.vercel.app`)
6. UI shows live URL with Copy button

### Auth & Configuration

- Vercel token stored per-user in Studio settings (encrypted at rest, never sent to LLM)
- If no token configured, deploy button shows setup prompt linking to Vercel token creation
- Project name: `{domain}-mocks-{shortHash}` to avoid collisions

### Post-Deploy Integration

On successful deploy, UI offers "Update Agent Tools" — rewrites `http.url` base in each agent's tool definitions from placeholder (`https://api.example.com`) to the actual Vercel deployment URL. On import, agents arrive with working tool URLs pointing at live mocks.

### Error Handling

- Deploy timeout: 60s
- Token invalid/expired: surface Vercel error, prompt re-authentication
- Rate limit: show retry-after, disable button with countdown
- Network failure: error toast, bundle stays in store for retry without regeneration

## 5. Testing Strategy

### Unit Tests

- Pipeline stage sequencing — stage N completion triggers N+1 with correct context
- Cascade logic — editing stage 2 clears stages 3-4, re-triggers from 3
- Mock handler generation — given OpenAPI path with x-examples, generated function returns correct responses
- `vercel.json` generation — correct routes, CORS, rewrites
- Store actions — startPipeline, updateStageResult, commitEdit, reset

### Integration Tests

- `/api/arch/generate` with `type: 'openapi'` — agents with HTTP tools produce valid OpenAPI 3.1
- `/api/arch/generate` with `type: 'mock_project'` — OpenAPI spec produces complete MockProjectBundle
- `/api/arch/deploy-mocks` — mock Vercel CLI, verify temp dir structure and CLI args
- Edit-and-cascade — generate topology, edit it, verify agents stage receives updated topology

### E2E (Manual Smoke)

- Full pipeline: Ideate form → review screen → deploy → verify mock URL returns expected data
- Edit mid-review: modify a stage, confirm downstream stages regenerate correctly

## Non-Goals

- Runtime hosting on Vercel (only mock APIs are deployed there)
- Persistent spec drafts (ephemeral until imported or downloaded)
- Multi-user collaboration on spec generation
- Template library for common domains (possible future extension)

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Quick Generate flow in the Ideate stage that produces a full agent spec (topology, agents, OpenAPI, mock handlers) and deploys mock APIs to Vercel.

**Architecture:** New `spec-generation-store` drives a 4-stage pipeline (topology → agents → openapi → mocks). Each stage calls `/api/arch/generate` with accumulated context. A new `/api/arch/deploy-mocks` endpoint writes the bundle to disk and shells out to `vercel deploy`. The UI adds a mode toggle in IdeateStage, a pipeline progress stepper, and a tabbed review screen with per-stage edit via scoped ArchChat.

**Tech Stack:** Next.js 15 API routes, Zustand, Tailwind, Framer Motion, Lucide icons, Anthropic LLM (via `@abl/compiler` LLMClient), Vercel CLI.

**Design doc:** `docs/plans/2026-02-17-arch-spec-generation-design.md`

---

## Task 1: Add New Types

**Files:**

- Modify: `apps/studio/src/types/arch.ts`

**Step 1: Add the new types at the end of arch.ts (before the closing exports if any)**

Add after the existing type definitions (after line ~327):

```typescript
// =============================================================================
// SPEC GENERATION TYPES
// =============================================================================

/** Input for the Quick Generate pipeline */
export interface SpecGenInput {
  domain: string;
  problemStatement: string;
  details?: string;
}

/** OpenAPI 3.1 spec — lightweight shape for client-side rendering */
export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface OpenAPIOperation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: { content: Record<string, { schema: unknown; example?: unknown }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: unknown; example?: unknown }> }
  >;
  'x-examples'?: Record<string, unknown>;
}

export interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: { type: string };
  description?: string;
}

/** A file in the mock project bundle */
export interface MockProjectFile {
  path: string;
  content: string;
}

/** Complete Vercel-deployable mock project */
export interface MockProjectBundle {
  projectName: string;
  files: MockProjectFile[];
}

/** Pipeline stage identifier */
export type SpecGenStage = 'topology' | 'agents' | 'openapi' | 'mocks';

/** Pipeline stage status */
export type StageStatus = 'pending' | 'running' | 'complete' | 'error';

/** Entry in the edit history */
export interface EditHistoryEntry {
  stage: SpecGenStage;
  timestamp: string;
  summary: string;
}

/** Stage results accumulator */
export interface SpecGenStageResults {
  topology: TopologyData | null;
  agents: GeneratedAgent[] | null;
  openapi: OpenAPISpec | null;
  mockProject: MockProjectBundle | null;
}

/** Deploy result from Vercel */
export interface VercelDeployResult {
  url: string;
  projectName: string;
  deployedAt: string;
}
```

**Step 2: Extend ArchGenerateRequest to support new types**

Find the existing `ArchGenerateRequest` interface and update the `type` union:

```typescript
// Before:
export interface ArchGenerateRequest {
  projectId?: string;
  type: 'topology' | 'agents' | 'tests';
  brief: ProjectBrief;
  topology?: TopologyData;
}

// After:
export interface ArchGenerateRequest {
  projectId?: string;
  type: 'topology' | 'agents' | 'tests' | 'openapi' | 'mock_project';
  brief: ProjectBrief;
  topology?: TopologyData;
  agents?: GeneratedAgent[];
  openapi?: OpenAPISpec;
}
```

**Step 3: Extend ArchGenerateResponse**

```typescript
// Before:
export interface ArchGenerateResponse {
  topology?: TopologyData;
  agents?: GeneratedAgent[];
  completenessAnalysis?: CompletenessAnalysis;
}

// After:
export interface ArchGenerateResponse {
  topology?: TopologyData;
  agents?: GeneratedAgent[];
  completenessAnalysis?: CompletenessAnalysis;
  openapi?: OpenAPISpec;
  mockProject?: MockProjectBundle;
}
```

**Step 4: Extend ArchChatRequest context for edit mode**

Find `ArchChatRequest` and extend:

```typescript
// Add to ArchChatRequest:
export interface ArchChatRequest {
  projectId?: string;
  stage: LifecycleStage;
  messages: { role: ArchMessageRole; content: string }[];
  context?: ArchContext & {
    editingStage?: SpecGenStage;
    generatedSpec?: Partial<SpecGenStageResults>;
  };
}
```

**Step 5: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add apps/studio/src/types/arch.ts
git commit -m "feat(studio): add spec generation types (OpenAPI, MockProject, pipeline)"
```

---

## Task 2: Create Spec Generation Store

**Files:**

- Create: `apps/studio/src/store/spec-generation-store.ts`
- Test: `apps/studio/src/__tests__/spec-generation-store.test.ts`

**Step 1: Write the store tests**

Create `apps/studio/src/__tests__/spec-generation-store.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
import { useSpecGenerationStore } from '../store/spec-generation-store';

function getState() {
  return useSpecGenerationStore.getState();
}

function act(fn: () => void) {
  fn();
}

describe('spec-generation-store', () => {
  beforeEach(() => {
    getState().reset();
  });

  test('initial state is idle with null results', () => {
    const s = getState();
    expect(s.pipelineStatus).toBe('idle');
    expect(s.currentStage).toBeNull();
    expect(s.stageResults.topology).toBeNull();
    expect(s.stageResults.agents).toBeNull();
    expect(s.stageResults.openapi).toBeNull();
    expect(s.stageResults.mockProject).toBeNull();
    expect(s.editingStage).toBeNull();
  });

  test('startPipeline sets running state and stores input', () => {
    act(() =>
      getState().startPipeline({
        domain: 'Hotel Booking',
        problemStatement: 'Automate reservations',
      }),
    );
    const s = getState();
    expect(s.pipelineStatus).toBe('running');
    expect(s.currentStage).toBe('topology');
    expect(s.input?.domain).toBe('Hotel Booking');
  });

  test('updateStageResult stores result and advances stage', () => {
    act(() =>
      getState().startPipeline({
        domain: 'Test',
        problemStatement: 'Test',
      }),
    );
    const mockTopology = { nodes: [], edges: [] };
    act(() => getState().updateStageResult('topology', mockTopology));

    const s = getState();
    expect(s.stageResults.topology).toEqual(mockTopology);
    expect(s.currentStage).toBe('agents');
  });

  test('updateStageResult on final stage sets complete', () => {
    act(() => getState().startPipeline({ domain: 'T', problemStatement: 'T' }));
    act(() => getState().updateStageResult('topology', { nodes: [], edges: [] }));
    act(() => getState().updateStageResult('agents', []));
    act(() =>
      getState().updateStageResult('openapi', {
        openapi: '3.1.0',
        info: { title: 'T', version: '1.0' },
        paths: {},
      }),
    );
    act(() => getState().updateStageResult('mocks', { projectName: 'test', files: [] }));

    const s = getState();
    expect(s.pipelineStatus).toBe('complete');
    expect(s.currentStage).toBeNull();
  });

  test('setStageError marks error state', () => {
    act(() => getState().startPipeline({ domain: 'T', problemStatement: 'T' }));
    act(() => getState().setStageError('topology', 'LLM timeout'));

    const s = getState();
    expect(s.pipelineStatus).toBe('error');
    expect(s.stageErrors.topology).toBe('LLM timeout');
  });

  test('startEditing sets editingStage', () => {
    act(() => getState().startEditing('agents'));
    expect(getState().editingStage).toBe('agents');
  });

  test('stopEditing clears editingStage', () => {
    act(() => getState().startEditing('agents'));
    act(() => getState().stopEditing());
    expect(getState().editingStage).toBeNull();
  });

  test('commitEdit updates result and clears downstream stages', () => {
    act(() => getState().startPipeline({ domain: 'T', problemStatement: 'T' }));
    act(() => getState().updateStageResult('topology', { nodes: [{ id: 'a' }], edges: [] }));
    act(() => getState().updateStageResult('agents', [{ id: 'agent1' }]));
    act(() =>
      getState().updateStageResult('openapi', {
        openapi: '3.1.0',
        info: { title: 'T', version: '1.0' },
        paths: {},
      }),
    );
    act(() => getState().updateStageResult('mocks', { projectName: 'test', files: [] }));

    // Edit topology — should clear agents, openapi, mocks
    const newTopology = { nodes: [{ id: 'b' }], edges: [] };
    act(() => getState().commitEdit('topology', newTopology));

    const s = getState();
    expect(s.stageResults.topology).toEqual(newTopology);
    expect(s.stageResults.agents).toBeNull();
    expect(s.stageResults.openapi).toBeNull();
    expect(s.stageResults.mockProject).toBeNull();
    expect(s.pipelineStatus).toBe('running');
    expect(s.currentStage).toBe('agents');
    expect(s.editingStage).toBeNull();
  });

  test('commitEdit on mocks does not clear anything downstream', () => {
    act(() => getState().startPipeline({ domain: 'T', problemStatement: 'T' }));
    act(() => getState().updateStageResult('topology', { nodes: [], edges: [] }));
    act(() => getState().updateStageResult('agents', []));
    act(() =>
      getState().updateStageResult('openapi', {
        openapi: '3.1.0',
        info: { title: 'T', version: '1.0' },
        paths: {},
      }),
    );
    act(() => getState().updateStageResult('mocks', { projectName: 'old', files: [] }));

    act(() => getState().commitEdit('mocks', { projectName: 'new', files: [] }));

    const s = getState();
    expect(s.stageResults.mockProject).toEqual({ projectName: 'new', files: [] });
    expect(s.pipelineStatus).toBe('complete');
  });

  test('setDeployResult stores deploy URL', () => {
    act(() =>
      getState().setDeployResult({
        url: 'https://test.vercel.app',
        projectName: 'test-mocks',
        deployedAt: '2026-02-17T00:00:00Z',
      }),
    );
    expect(getState().deployResult?.url).toBe('https://test.vercel.app');
  });

  test('reset clears everything', () => {
    act(() => getState().startPipeline({ domain: 'T', problemStatement: 'T' }));
    act(() => getState().updateStageResult('topology', { nodes: [], edges: [] }));
    act(() => getState().setDeployResult({ url: 'x', projectName: 'x', deployedAt: 'x' }));
    act(() => getState().reset());

    const s = getState();
    expect(s.pipelineStatus).toBe('idle');
    expect(s.input).toBeNull();
    expect(s.stageResults.topology).toBeNull();
    expect(s.deployResult).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/studio && npx vitest run src/__tests__/spec-generation-store.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the store implementation**

Create `apps/studio/src/store/spec-generation-store.ts`:

```typescript
/**
 * Spec Generation Store
 *
 * Ephemeral Zustand store for the Quick Generate pipeline.
 * No persistence — results are discarded after import or navigation.
 */

import { create } from 'zustand';
import type {
  SpecGenInput,
  SpecGenStage,
  SpecGenStageResults,
  EditHistoryEntry,
  VercelDeployResult,
} from '../types/arch';

const STAGE_ORDER: SpecGenStage[] = ['topology', 'agents', 'openapi', 'mocks'];

function nextStage(current: SpecGenStage): SpecGenStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  return idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;
}

function stagesAfter(stage: SpecGenStage): SpecGenStage[] {
  const idx = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER.slice(idx + 1);
}

const STAGE_RESULT_KEY: Record<SpecGenStage, keyof SpecGenStageResults> = {
  topology: 'topology',
  agents: 'agents',
  openapi: 'openapi',
  mocks: 'mockProject',
};

interface SpecGenerationState {
  // Input
  input: SpecGenInput | null;

  // Pipeline
  pipelineStatus: 'idle' | 'running' | 'complete' | 'error';
  currentStage: SpecGenStage | null;
  stageResults: SpecGenStageResults;
  stageErrors: Record<string, string>;

  // Editing
  editingStage: SpecGenStage | null;
  editHistory: EditHistoryEntry[];

  // Deploy
  deployResult: VercelDeployResult | null;

  // Actions
  startPipeline: (input: SpecGenInput) => void;
  updateStageResult: (stage: SpecGenStage, result: unknown) => void;
  setStageError: (stage: SpecGenStage, error: string) => void;
  startEditing: (stage: SpecGenStage) => void;
  stopEditing: () => void;
  commitEdit: (stage: SpecGenStage, updatedResult: unknown) => void;
  setDeployResult: (result: VercelDeployResult) => void;
  reset: () => void;
}

const INITIAL_RESULTS: SpecGenStageResults = {
  topology: null,
  agents: null,
  openapi: null,
  mockProject: null,
};

export const useSpecGenerationStore = create<SpecGenerationState>((set) => ({
  input: null,
  pipelineStatus: 'idle',
  currentStage: null,
  stageResults: { ...INITIAL_RESULTS },
  stageErrors: {},
  editingStage: null,
  editHistory: [],
  deployResult: null,

  startPipeline: (input) =>
    set({
      input,
      pipelineStatus: 'running',
      currentStage: 'topology',
      stageResults: { ...INITIAL_RESULTS },
      stageErrors: {},
      editingStage: null,
      editHistory: [],
      deployResult: null,
    }),

  updateStageResult: (stage, result) =>
    set((state) => {
      const key = STAGE_RESULT_KEY[stage];
      const next = nextStage(stage);
      return {
        stageResults: { ...state.stageResults, [key]: result },
        currentStage: next,
        pipelineStatus: next ? 'running' : 'complete',
      };
    }),

  setStageError: (stage, error) =>
    set((state) => ({
      pipelineStatus: 'error',
      stageErrors: { ...state.stageErrors, [stage]: error },
    })),

  startEditing: (stage) => set({ editingStage: stage }),

  stopEditing: () => set({ editingStage: null }),

  commitEdit: (stage, updatedResult) =>
    set((state) => {
      const key = STAGE_RESULT_KEY[stage];
      const downstream = stagesAfter(stage);
      const clearedResults = { ...state.stageResults, [key]: updatedResult };

      for (const ds of downstream) {
        clearedResults[STAGE_RESULT_KEY[ds]] = null;
      }

      const next = downstream.length > 0 ? downstream[0] : null;
      const entry: EditHistoryEntry = {
        stage,
        timestamp: new Date().toISOString(),
        summary: `Edited ${stage}`,
      };

      return {
        stageResults: clearedResults,
        editingStage: null,
        editHistory: [...state.editHistory, entry],
        pipelineStatus: next ? 'running' : 'complete',
        currentStage: next,
      };
    }),

  setDeployResult: (result) => set({ deployResult: result }),

  reset: () =>
    set({
      input: null,
      pipelineStatus: 'idle',
      currentStage: null,
      stageResults: { ...INITIAL_RESULTS },
      stageErrors: {},
      editingStage: null,
      editHistory: [],
      deployResult: null,
    }),
}));
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/studio && npx vitest run src/__tests__/spec-generation-store.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/studio/src/store/spec-generation-store.ts apps/studio/src/__tests__/spec-generation-store.test.ts
git commit -m "feat(studio): add spec-generation-store with cascade logic"
```

---

## Task 3: Extend /api/arch/generate — OpenAPI Generation

**Files:**

- Modify: `apps/studio/src/app/api/arch/generate/route.ts`

**Step 1: Add `openapi` to the request schema validation**

Find the Zod schema for the request body (around line 20-50) and extend the `type` enum:

```typescript
// Before: type: z.enum(['topology', 'agents', 'tests']),
// After:
type: z.enum(['topology', 'agents', 'tests', 'openapi', 'mock_project']),
```

Add optional fields to the schema:

```typescript
agents: z.array(z.object({
  id: z.string(),
  name: z.string(),
  executionMode: z.string(),
  ablContent: z.string().optional(),
  tools: z.array(z.string()),
  gatherFields: z.array(z.string()),
  flowStepCount: z.number(),
})).optional(),
openapi: z.any().optional(),
```

**Step 2: Add the `generateOpenAPISpec` function**

Add a new function (after the existing `generateAgents` function):

```typescript
async function generateOpenAPISpec(
  topology: { nodes: unknown[]; edges: unknown[] },
  agents: { id: string; name: string; tools: string[]; gatherFields: string[] }[],
  brief: { domain: string; problemStatement: string },
): Promise<{ openapi: unknown } | null> {
  const llm = getArchLLMClient();
  if (!llm) return { openapi: generateOpenAPIStub(agents, brief) };

  const systemPrompt = `You are an API designer. Generate an OpenAPI 3.1.0 specification for the HTTP tools used by the agents below.

Rules:
- Every tool mentioned in the agents must have a corresponding API path
- Use RESTful conventions (GET for reads, POST for creates, PUT for updates, DELETE for deletes)
- Include realistic request/response schemas with proper types
- Add x-examples with 2-3 realistic example request/response pairs per endpoint
- Use descriptive operationId matching the tool name
- Group related endpoints logically
- Include path parameters, query parameters, and request bodies where appropriate

Return ONLY valid JSON — no markdown fences, no commentary.`;

  const userPrompt = `Domain: ${brief.domain}
Problem: ${brief.problemStatement}

Agents and their tools:
${agents.map((a) => `- ${a.name} (${a.tools.join(', ')})`).join('\n')}

Generate a complete OpenAPI 3.1.0 JSON spec.`;

  try {
    const response = await llm.chat({
      model: ARCH_GENERATE_MODEL,
      maxTokens: ARCH_GENERATE_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const parsed = parseJsonFromResponse(response.content);
    if (!parsed || !parsed.openapi) {
      console.warn('[Arch Generate] OpenAPI parse failed, using stub');
      return { openapi: generateOpenAPIStub(agents, brief) };
    }
    return { openapi: parsed };
  } catch (err) {
    console.error('[Arch Generate] OpenAPI generation failed:', err);
    return { openapi: generateOpenAPIStub(agents, brief) };
  }
}
```

**Step 3: Add the OpenAPI stub generator**

```typescript
function generateOpenAPIStub(
  agents: { name: string; tools: string[] }[],
  brief: { domain: string },
): unknown {
  const paths: Record<string, unknown> = {};

  for (const agent of agents) {
    for (const tool of agent.tools) {
      const pathName = `/${tool.replace(/_/g, '-')}`;
      paths[pathName] = {
        post: {
          operationId: tool,
          summary: `${tool.replace(/_/g, ' ')} for ${agent.name}`,
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } },
                example: { id: 'example-123' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' }, data: { type: 'object' } },
                  },
                  example: { success: true, data: {} },
                },
              },
            },
          },
          'x-examples': {
            default: {
              request: { id: 'example-123' },
              response: { success: true, data: {} },
            },
          },
        },
      };
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${brief.domain} Mock API`,
      version: '1.0.0',
      description: `Auto-generated mock API for ${brief.domain}`,
    },
    paths,
  };
}
```

**Step 4: Wire `openapi` type into the POST handler**

In the main POST handler's switch/if chain, add:

```typescript
if (body.type === 'openapi') {
  if (!body.topology || !body.agents) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'MISSING_CONTEXT',
          message: 'OpenAPI generation requires topology and agents',
        },
      },
      { status: 400 },
    );
  }
  const result = await generateOpenAPISpec(body.topology, body.agents, body.brief);
  return NextResponse.json({ success: true, data: { openapi: result?.openapi } });
}
```

**Step 5: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add apps/studio/src/app/api/arch/generate/route.ts
git commit -m "feat(studio): add OpenAPI spec generation to /api/arch/generate"
```

---

## Task 4: Extend /api/arch/generate — Mock Project Generation

**Files:**

- Modify: `apps/studio/src/app/api/arch/generate/route.ts`

**Step 1: Add the `generateMockProject` function**

```typescript
async function generateMockProject(
  openapi: Record<string, unknown>,
  agents: { name: string; tools: string[] }[],
  brief: { domain: string },
): Promise<{ mockProject: { projectName: string; files: { path: string; content: string }[] } }> {
  const domainSlug = brief.domain
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const shortHash = Date.now().toString(36).slice(-4);
  const projectName = `${domainSlug}-mocks-${shortHash}`;

  const files: { path: string; content: string }[] = [];

  // package.json
  files.push({
    path: 'package.json',
    content: JSON.stringify(
      {
        name: projectName,
        version: '1.0.0',
        private: true,
      },
      null,
      2,
    ),
  });

  // vercel.json
  files.push({
    path: 'vercel.json',
    content: JSON.stringify(
      {
        headers: [
          {
            source: '/api/(.*)',
            headers: [
              { key: 'Access-Control-Allow-Origin', value: '*' },
              { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
              { key: 'Access-Control-Allow-Headers', value: 'Content-Type,Authorization' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  });

  // OpenAPI schema
  files.push({
    path: 'api/_schema.json',
    content: JSON.stringify(openapi, null, 2),
  });

  // Generate handler + data for each path
  const paths =
    (
      openapi as {
        paths?: Record<
          string,
          Record<
            string,
            {
              operationId?: string;
              'x-examples'?: Record<string, unknown>;
              responses?: Record<string, { content?: Record<string, { example?: unknown }> }>;
            }
          >
        >;
      }
    ).paths ?? {};

  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const opId = operation.operationId ?? pathStr.replace(/\//g, '_').replace(/^_/, '');

      // Extract example response from x-examples or responses.200
      let exampleResponse: unknown = { success: true, data: {} };
      if (operation['x-examples']) {
        const first = Object.values(operation['x-examples'])[0] as
          | { response?: unknown }
          | undefined;
        if (first?.response) exampleResponse = first.response;
      } else if (operation.responses?.['200']?.content?.['application/json']?.example) {
        exampleResponse = operation.responses['200'].content['application/json'].example;
      }

      // Data file
      files.push({
        path: `_data/${opId}.json`,
        content: JSON.stringify(exampleResponse, null, 2),
      });

      // Handler file
      const handlerPath = pathStr.replace(/^\//, '').replace(/\{(\w+)\}/g, '[$1]');
      files.push({
        path: `api/${handlerPath}.ts`,
        content: `import { readFileSync } from 'fs';
import { join } from 'path';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const DATA_PATH = join(process.cwd(), '_data', '${opId}.json');

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method?.toUpperCase() !== '${method.toUpperCase()}') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
    return res.status(200).json(data);
  } catch {
    return res.status(500).json({ error: 'Mock data not found' });
  }
}
`,
      });
    }
  }

  return { mockProject: { projectName, files } };
}
```

**Step 2: Wire `mock_project` type into the POST handler**

```typescript
if (body.type === 'mock_project') {
  if (!body.openapi || !body.agents) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'MISSING_CONTEXT',
          message: 'Mock project generation requires openapi and agents',
        },
      },
      { status: 400 },
    );
  }
  const result = await generateMockProject(body.openapi, body.agents, body.brief);
  return NextResponse.json({ success: true, data: { mockProject: result.mockProject } });
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/arch/generate/route.ts
git commit -m "feat(studio): add mock project generation to /api/arch/generate"
```

---

## Task 5: Create /api/arch/deploy-mocks Endpoint

**Files:**

- Create: `apps/studio/src/app/api/arch/deploy-mocks/route.ts`

**Step 1: Write the deploy endpoint**

```typescript
/**
 * POST /api/arch/deploy-mocks
 *
 * Writes a MockProjectBundle to a temp directory and deploys to Vercel
 * via the Vercel CLI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DEPLOY_TIMEOUT_MS = 60_000;

const requestSchema = z.object({
  mockProject: z.object({
    projectName: z.string().max(100),
    files: z
      .array(
        z.object({
          path: z.string().max(500),
          content: z.string().max(100_000),
        }),
      )
      .max(200),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const body = requestSchema.parse(raw);
    const { mockProject } = body;

    // Check for Vercel token
    const vercelToken = process.env.VERCEL_TOKEN;
    if (!vercelToken) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VERCEL_TOKEN_MISSING',
            message:
              'VERCEL_TOKEN environment variable is not configured. Set it in your Studio environment to enable Vercel deployments.',
          },
        },
        { status: 400 },
      );
    }

    // Create temp directory
    const tmpId = randomBytes(8).toString('hex');
    const tmpDir = join(tmpdir(), `arch-mock-${tmpId}`);

    try {
      // Write all files
      for (const file of mockProject.files) {
        const filePath = join(tmpDir, file.path);
        const dir = join(filePath, '..');
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, file.content, 'utf-8');
      }

      // Deploy via Vercel CLI
      const { stdout, stderr } = await execAsync(
        `vercel deploy --yes --token ${vercelToken} --name ${mockProject.projectName}`,
        {
          cwd: tmpDir,
          timeout: DEPLOY_TIMEOUT_MS,
          env: { ...process.env, VERCEL_TOKEN: vercelToken },
        },
      );

      // Vercel CLI prints the deployment URL to stdout
      const url = stdout.trim().split('\n').pop()?.trim();
      if (!url || !url.startsWith('http')) {
        console.error('[deploy-mocks] Unexpected Vercel output:', stdout, stderr);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'DEPLOY_FAILED',
              message: `Vercel deploy did not return a URL. stderr: ${stderr.slice(0, 500)}`,
            },
          },
          { status: 500 },
        );
      }

      return NextResponse.json({
        success: true,
        data: {
          url,
          projectName: mockProject.projectName,
          deployedAt: new Date().toISOString(),
        },
      });
    } finally {
      // Clean up temp directory
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        console.warn('[deploy-mocks] Failed to clean up temp dir:', err),
      );
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'VALIDATION_ERROR', message: err.errors.map((e) => e.message).join(', ') },
        },
        { status: 400 },
      );
    }
    console.error('[deploy-mocks] Unexpected error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: { code: 'DEPLOY_ERROR', message } },
      { status: 500 },
    );
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/arch/deploy-mocks/route.ts
git commit -m "feat(studio): add POST /api/arch/deploy-mocks endpoint"
```

---

## Task 6: Extend API Client

**Files:**

- Modify: `apps/studio/src/api/arch.ts`

**Step 1: Add new API functions**

Append to `apps/studio/src/api/arch.ts`:

```typescript
import type {
  // ... existing imports ...
  MockProjectBundle,
  VercelDeployResult,
} from '../types/arch';

/**
 * Deploy a mock project bundle to Vercel.
 */
export async function deployMockProject(
  mockProject: MockProjectBundle,
): Promise<VercelDeployResult> {
  const response = await apiFetch('/api/arch/deploy-mocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mockProject }),
  });

  const result = await handleResponse<{ success: boolean; data: VercelDeployResult }>(response);
  return result.data;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add apps/studio/src/api/arch.ts
git commit -m "feat(studio): add deployMockProject API client function"
```

---

## Task 7: Create QuickGenerateForm Component

**Files:**

- Create: `apps/studio/src/components/spec-generation/QuickGenerateForm.tsx`

**Step 1: Write the form component**

```typescript
/**
 * QuickGenerateForm
 *
 * Domain input form for the Quick Generate pipeline.
 * Collects domain, problem statement, and optional details.
 */

import { useState } from 'react';
import { Zap, Loader2 } from 'lucide-react';
import type { SpecGenInput } from '../../types/arch';

interface QuickGenerateFormProps {
  onSubmit: (input: SpecGenInput) => void;
  isSubmitting?: boolean;
}

export function QuickGenerateForm({ onSubmit, isSubmitting }: QuickGenerateFormProps) {
  const [domain, setDomain] = useState('');
  const [problemStatement, setProblemStatement] = useState('');
  const [details, setDetails] = useState('');

  const canSubmit = domain.trim().length > 0 && problemStatement.trim().length > 0 && !isSubmitting;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      domain: domain.trim(),
      problemStatement: problemStatement.trim(),
      details: details.trim() || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-lg mx-auto space-y-5">
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent-subtle rounded-full mb-3">
          <Zap className="w-4 h-4 text-accent" />
          <span className="text-sm font-medium text-accent">Quick Generate</span>
        </div>
        <h2 className="text-lg font-semibold text-foreground">Describe your domain</h2>
        <p className="text-sm text-muted mt-1">
          We'll generate agents, tools, APIs, and mock data automatically.
        </p>
      </div>

      <div>
        <label htmlFor="qg-domain" className="block text-sm font-medium text-foreground mb-1.5">
          Domain
        </label>
        <input
          id="qg-domain"
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="e.g. Hotel Booking, Healthcare, Banking"
          maxLength={200}
          className="w-full px-3 py-2 text-sm bg-background border border-default rounded-lg text-foreground placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-default"
        />
      </div>

      <div>
        <label htmlFor="qg-problem" className="block text-sm font-medium text-foreground mb-1.5">
          Problem Statement
        </label>
        <input
          id="qg-problem"
          type="text"
          value={problemStatement}
          onChange={(e) => setProblemStatement(e.target.value)}
          placeholder="e.g. Automate customer support for hotel reservations"
          maxLength={500}
          className="w-full px-3 py-2 text-sm bg-background border border-default rounded-lg text-foreground placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-default"
        />
      </div>

      <div>
        <label htmlFor="qg-details" className="block text-sm font-medium text-foreground mb-1.5">
          Details <span className="text-subtle font-normal">(optional)</span>
        </label>
        <textarea
          id="qg-details"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Constraints, edge cases, example scenarios..."
          rows={4}
          maxLength={2000}
          className="w-full px-3 py-2 text-sm bg-background border border-default rounded-lg text-foreground placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-default resize-none"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-default disabled:opacity-50 disabled:cursor-not-allowed btn-press cursor-pointer"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Zap className="w-4 h-4" />
            Generate Full Spec
          </>
        )}
      </button>
    </form>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/spec-generation/QuickGenerateForm.tsx
git commit -m "feat(studio): add QuickGenerateForm component"
```

---

## Task 8: Create PipelineStepper Component

**Files:**

- Create: `apps/studio/src/components/spec-generation/PipelineStepper.tsx`

**Step 1: Write the pipeline stepper**

```typescript
/**
 * PipelineStepper
 *
 * Horizontal 4-stage progress indicator for the spec generation pipeline.
 * Shows pending / running / complete / error per stage.
 */

import { Check, Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import type { SpecGenStage, StageStatus } from '../../types/arch';
import { useSpecGenerationStore } from '../../store/spec-generation-store';

const STAGES: { key: SpecGenStage; label: string }[] = [
  { key: 'topology', label: 'Topology' },
  { key: 'agents', label: 'Agents' },
  { key: 'openapi', label: 'API Spec' },
  { key: 'mocks', label: 'Mock Data' },
];

const STAGE_ORDER: SpecGenStage[] = ['topology', 'agents', 'openapi', 'mocks'];

function getStageStatus(
  stage: SpecGenStage,
  currentStage: SpecGenStage | null,
  pipelineStatus: string,
  stageResults: Record<string, unknown>,
  stageErrors: Record<string, string>
): StageStatus {
  if (stageErrors[stage]) return 'error';

  const RESULT_KEY: Record<SpecGenStage, string> = {
    topology: 'topology',
    agents: 'agents',
    openapi: 'openapi',
    mocks: 'mockProject',
  };

  if (stageResults[RESULT_KEY[stage]] != null) return 'complete';
  if (currentStage === stage && pipelineStatus === 'running') return 'running';
  return 'pending';
}

export function PipelineStepper() {
  const { currentStage, pipelineStatus, stageResults, stageErrors } = useSpecGenerationStore();

  return (
    <div className="flex items-center justify-center gap-2 py-6">
      {STAGES.map((stage, i) => {
        const status = getStageStatus(stage.key, currentStage, pipelineStatus, stageResults, stageErrors);
        return (
          <div key={stage.key} className="flex items-center gap-2">
            {/* Stage indicator */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={clsx(
                  'w-8 h-8 rounded-full flex items-center justify-center transition-default',
                  status === 'complete' && 'bg-success/20 text-success',
                  status === 'running' && 'bg-accent-subtle text-accent',
                  status === 'error' && 'bg-danger/20 text-danger',
                  status === 'pending' && 'bg-background-muted text-subtle'
                )}
              >
                {status === 'complete' && <Check className="w-4 h-4" />}
                {status === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                {status === 'error' && <AlertCircle className="w-4 h-4" />}
                {status === 'pending' && (
                  <span className="text-xs font-medium">{i + 1}</span>
                )}
              </div>
              <span
                className={clsx(
                  'text-xs font-medium',
                  status === 'complete' && 'text-success',
                  status === 'running' && 'text-accent',
                  status === 'error' && 'text-danger',
                  status === 'pending' && 'text-subtle'
                )}
              >
                {stage.label}
              </span>
            </div>
            {/* Connector line */}
            {i < STAGES.length - 1 && (
              <div
                className={clsx(
                  'w-12 h-0.5 rounded-full mb-5',
                  STAGE_ORDER.indexOf(stage.key) < STAGE_ORDER.indexOf(currentStage ?? 'topology')
                    ? 'bg-success'
                    : status === 'complete'
                      ? 'bg-success'
                      : 'bg-border'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/spec-generation/PipelineStepper.tsx
git commit -m "feat(studio): add PipelineStepper component"
```

---

## Task 9: Create ReviewScreen Component

**Files:**

- Create: `apps/studio/src/components/spec-generation/ReviewScreen.tsx`

**Step 1: Write the review screen with tabs**

```typescript
/**
 * ReviewScreen
 *
 * Tabbed view of pipeline results: Topology, Agents, API Spec, Mock Data.
 * Action bar with Regenerate, Deploy to Vercel, Import to Project.
 * Per-tab Edit button opens scoped ArchChat.
 */

import { useState, useCallback } from 'react';
import { RefreshCw, Upload, ArrowRight, Pencil, X, Loader2, Copy, Check, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';
import { TopologyCanvas } from '../topology/TopologyCanvas';
import { ArchChat } from '../arch/ArchChat';
import { useSpecGenerationStore } from '../../store/spec-generation-store';
import { sendArchChat, deployMockProject } from '../../api/arch';
import type { SpecGenStage, ArchMessage, TopologyData, GeneratedAgent } from '../../types/arch';

type TabKey = 'topology' | 'agents' | 'openapi' | 'mocks';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'topology', label: 'Topology' },
  { key: 'agents', label: 'Agents' },
  { key: 'openapi', label: 'API Spec' },
  { key: 'mocks', label: 'Mock Data' },
];

interface ReviewScreenProps {
  onRegenerate: () => void;
  onImport: () => void;
}

export function ReviewScreen({ onRegenerate, onImport }: ReviewScreenProps) {
  const {
    stageResults,
    editingStage,
    startEditing,
    stopEditing,
    commitEdit,
    deployResult,
    setDeployResult,
    input,
  } = useSpecGenerationStore();

  const [activeTab, setActiveTab] = useState<TabKey>('topology');
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [editMessages, setEditMessages] = useState<ArchMessage[]>([]);
  const [editTyping, setEditTyping] = useState(false);

  const handleDeploy = useCallback(async () => {
    if (!stageResults.mockProject) return;
    setIsDeploying(true);
    setDeployError(null);
    try {
      const result = await deployMockProject(stageResults.mockProject);
      setDeployResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deploy failed';
      setDeployError(msg);
    } finally {
      setIsDeploying(false);
    }
  }, [stageResults.mockProject, setDeployResult]);

  const handleCopyUrl = useCallback(() => {
    if (!deployResult?.url) return;
    navigator.clipboard.writeText(deployResult.url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }, [deployResult]);

  const handleStartEdit = useCallback((tab: TabKey) => {
    startEditing(tab as SpecGenStage);
    setEditMessages([{
      id: 'edit-welcome',
      role: 'arch',
      content: `I'm ready to help you refine the **${tab}**. Describe what you'd like to change.`,
      timestamp: new Date().toISOString(),
      agentName: 'Arch',
    }]);
  }, [startEditing]);

  const handleEditMessage = useCallback(async (text: string) => {
    if (!editingStage) return;

    const userMsg: ArchMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setEditMessages((prev) => [...prev, userMsg]);
    setEditTyping(true);

    try {
      const response = await sendArchChat({
        stage: 'ideate',
        messages: editMessages.concat(userMsg).map((m) => ({ role: m.role, content: m.content })),
        context: {
          page: 'spec-generation',
          editingStage: editingStage as SpecGenStage,
          generatedSpec: {
            topology: stageResults.topology ?? undefined,
            agents: stageResults.agents ?? undefined,
            openapi: stageResults.openapi ?? undefined,
            mockProject: stageResults.mockProject ?? undefined,
          },
        },
      });

      const archMsg: ArchMessage = {
        id: `arch-${Date.now()}`,
        role: 'arch',
        content: response.message,
        timestamp: new Date().toISOString(),
        agentName: 'Arch',
      };
      setEditMessages((prev) => [...prev, archMsg]);

      // If the response includes updated data for the editing stage, commit it
      if (editingStage === 'topology' && response.topology) {
        commitEdit('topology', response.topology);
      }
    } catch (err) {
      console.error('[ReviewScreen] Edit chat failed:', err);
      const errorMsg: ArchMessage = {
        id: `error-${Date.now()}`,
        role: 'arch',
        content: 'Sorry, I encountered an error processing your request. Please try again.',
        timestamp: new Date().toISOString(),
        agentName: 'Arch',
      };
      setEditMessages((prev) => [...prev, errorMsg]);
    } finally {
      setEditTyping(false);
    }
  }, [editingStage, editMessages, stageResults, commitEdit]);

  const handleStopEdit = useCallback(() => {
    stopEditing();
    setEditMessages([]);
  }, [stopEditing]);

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex-shrink-0 flex items-center border-b border-default px-4">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'px-4 py-3 text-sm font-medium transition-default cursor-pointer',
              activeTab === tab.key
                ? 'text-accent border-b-2 border-accent'
                : 'text-muted hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}

        {/* Edit button for active tab */}
        <div className="ml-auto">
          {editingStage === activeTab ? (
            <button
              onClick={handleStopEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 rounded-lg transition-default cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Close Edit
            </button>
          ) : (
            <button
              onClick={() => handleStartEdit(activeTab)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 flex">
        {/* Tab content */}
        <div className={clsx('flex-1 min-w-0 overflow-auto', editingStage && 'border-r border-default')}>
          {activeTab === 'topology' && stageResults.topology && (
            <TopologyCanvas topology={stageResults.topology} />
          )}
          {activeTab === 'agents' && stageResults.agents && (
            <AgentsTab agents={stageResults.agents} />
          )}
          {activeTab === 'openapi' && stageResults.openapi && (
            <OpenAPITab spec={stageResults.openapi} />
          )}
          {activeTab === 'mocks' && stageResults.mockProject && (
            <MockDataTab files={stageResults.mockProject.files} />
          )}
        </div>

        {/* Edit chat panel */}
        {editingStage && (
          <div className="w-[340px] shrink-0 flex flex-col">
            <ArchChat
              messages={editMessages}
              isTyping={editTyping}
              onSendMessage={handleEditMessage}
              placeholder={`Describe changes to ${editingStage}...`}
              className="flex-1"
            />
          </div>
        )}
      </div>

      {/* Deploy result banner */}
      {deployResult && (
        <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 bg-success/10 border-t border-success/20">
          <span className="text-sm text-success font-medium">Deployed</span>
          <code className="text-sm font-mono text-foreground">{deployResult.url}</code>
          <button onClick={handleCopyUrl} className="p-1 rounded hover:bg-success/20 transition-default cursor-pointer">
            {copiedUrl ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-muted" />}
          </button>
          <a href={deployResult.url} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-success/20 transition-default">
            <ExternalLink className="w-4 h-4 text-muted" />
          </a>
        </div>
      )}

      {/* Deploy error */}
      {deployError && (
        <div className="flex-shrink-0 px-4 py-2 bg-danger/10 border-t border-danger/20 text-sm text-danger">
          Deploy failed: {deployError}
        </div>
      )}

      {/* Action bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-t border-default bg-background-subtle">
        <button
          onClick={onRegenerate}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted hover:text-foreground bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          Regenerate
        </button>

        <button
          onClick={handleDeploy}
          disabled={isDeploying || !stageResults.mockProject}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-foreground bg-background border border-default rounded-lg hover:bg-background-muted transition-default disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isDeploying ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          Deploy to Vercel
        </button>

        <div className="flex-1" />

        <button
          onClick={onImport}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-default btn-press cursor-pointer"
        >
          Import to Project
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// TAB CONTENT SUB-COMPONENTS
// =============================================================================

function AgentsTab({ agents }: { agents: GeneratedAgent[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="p-4 space-y-2">
      {agents.map((agent) => (
        <div key={agent.id} className="border border-default rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-background-muted transition-default cursor-pointer"
          >
            <div>
              <span className="text-sm font-medium text-foreground">{agent.name}</span>
              <span className="ml-2 text-xs text-muted">{agent.executionMode}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-subtle">
              <span>{agent.tools.length} tools</span>
              <span>{agent.gatherFields.length} fields</span>
            </div>
          </button>
          {expandedId === agent.id && agent.ablContent && (
            <div className="px-4 pb-3 border-t border-default">
              <pre className="mt-2 p-3 text-xs font-mono bg-background-muted rounded-lg overflow-x-auto whitespace-pre-wrap text-foreground">
                {agent.ablContent}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OpenAPITab({ spec }: { spec: { openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, { operationId?: string; summary?: string }>> } }) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{spec.info.title}</h3>
        <p className="text-xs text-muted">OpenAPI {spec.openapi} &middot; v{spec.info.version}</p>
      </div>
      <div className="space-y-2">
        {Object.entries(spec.paths).map(([path, methods]) =>
          Object.entries(methods).map(([method, op]) => (
            <div key={`${method}-${path}`} className="flex items-center gap-3 px-3 py-2 bg-background-muted rounded-lg">
              <span className={clsx(
                'px-2 py-0.5 text-[10px] font-bold uppercase rounded',
                method === 'get' && 'bg-success/20 text-success',
                method === 'post' && 'bg-accent-subtle text-accent',
                method === 'put' && 'bg-warning/20 text-warning',
                method === 'delete' && 'bg-danger/20 text-danger'
              )}>
                {method}
              </span>
              <code className="text-xs font-mono text-foreground">{path}</code>
              {op.summary && <span className="text-xs text-muted ml-auto">{op.summary}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MockDataTab({ files }: { files: { path: string; content: string }[] }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selected = files.find((f) => f.path === selectedFile);

  return (
    <div className="h-full flex">
      {/* File tree */}
      <div className="w-48 shrink-0 border-r border-default overflow-y-auto">
        <div className="p-2 space-y-0.5">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => setSelectedFile(file.path)}
              className={clsx(
                'w-full text-left px-2 py-1.5 text-xs font-mono rounded transition-default cursor-pointer',
                selectedFile === file.path
                  ? 'bg-accent-subtle text-accent'
                  : 'text-muted hover:text-foreground hover:bg-background-muted'
              )}
            >
              {file.path}
            </button>
          ))}
        </div>
      </div>
      {/* File content */}
      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <pre className="p-4 text-xs font-mono text-foreground whitespace-pre-wrap">
            {selected.content}
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-subtle">
            Select a file to view
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/spec-generation/ReviewScreen.tsx
git commit -m "feat(studio): add ReviewScreen with tabbed view and Vercel deploy"
```

---

## Task 10: Create SpecGenerationView Orchestrator

**Files:**

- Create: `apps/studio/src/components/spec-generation/SpecGenerationView.tsx`
- Create: `apps/studio/src/components/spec-generation/index.ts`

**Step 1: Write the orchestrator that drives the pipeline**

```typescript
/**
 * SpecGenerationView
 *
 * Orchestrates the Quick Generate flow:
 * 1. Form → collect input
 * 2. Pipeline → run 4 stages sequentially
 * 3. Review → display results with edit, deploy, import
 */

import { useCallback } from 'react';
import { QuickGenerateForm } from './QuickGenerateForm';
import { PipelineStepper } from './PipelineStepper';
import { ReviewScreen } from './ReviewScreen';
import { useSpecGenerationStore } from '../../store/spec-generation-store';
import { useLifecycleStore } from '../../store/lifecycle-store';
import { generateArtifacts } from '../../api/arch';
import type { SpecGenInput, SpecGenStage, ProjectBrief, EMPTY_BRIEF } from '../../types/arch';

const STAGE_ORDER: SpecGenStage[] = ['topology', 'agents', 'openapi', 'mocks'];

export function SpecGenerationView() {
  const {
    pipelineStatus,
    stageResults,
    input,
    startPipeline,
    updateStageResult,
    setStageError,
    reset,
  } = useSpecGenerationStore();

  const { setTopology, setGeneratedAgents, completeStage } = useLifecycleStore();

  const runPipeline = useCallback(async (specInput: SpecGenInput) => {
    startPipeline(specInput);

    // Build a minimal brief from the input
    const brief = {
      domain: specInput.domain,
      problemStatement: specInput.problemStatement,
      useCases: [],
      targetUsers: [],
      channels: [],
      tone: '',
      constraints: specInput.details ? [specInput.details] : [],
      estimatedAgents: '',
      complexity: 'medium' as const,
      uploadedFiles: [],
    };

    try {
      // Stage 1: Topology
      const topoResult = await generateArtifacts({ type: 'topology', brief });
      const topology = topoResult.topology;
      if (!topology) throw new Error('Topology generation returned empty');
      updateStageResult('topology', topology);

      // Stage 2: Agents
      const agentsResult = await generateArtifacts({ type: 'agents', brief, topology });
      const agents = agentsResult.agents;
      if (!agents) throw new Error('Agent generation returned empty');
      updateStageResult('agents', agents);

      // Stage 3: OpenAPI
      const openapiResult = await generateArtifacts({
        type: 'openapi',
        brief,
        topology,
        agents,
      });
      const openapi = openapiResult.openapi;
      if (!openapi) throw new Error('OpenAPI generation returned empty');
      updateStageResult('openapi', openapi);

      // Stage 4: Mock Project
      const mockResult = await generateArtifacts({
        type: 'mock_project',
        brief,
        topology,
        agents,
        openapi,
      });
      const mockProject = mockResult.mockProject;
      if (!mockProject) throw new Error('Mock project generation returned empty');
      updateStageResult('mocks', mockProject);
    } catch (err) {
      const currentStage = useSpecGenerationStore.getState().currentStage;
      const message = err instanceof Error ? err.message : 'Generation failed';
      if (currentStage) {
        setStageError(currentStage, message);
      }
      console.error('[SpecGenerationView] Pipeline failed:', err);
    }
  }, [startPipeline, updateStageResult, setStageError]);

  const handleRegenerate = useCallback(() => {
    if (input) {
      runPipeline(input);
    }
  }, [input, runPipeline]);

  const handleImport = useCallback(() => {
    if (stageResults.topology) {
      setTopology(stageResults.topology);
    }
    if (stageResults.agents) {
      setGeneratedAgents(stageResults.agents);
    }
    completeStage('ideate');
  }, [stageResults, setTopology, setGeneratedAgents, completeStage]);

  // Idle → show form
  if (pipelineStatus === 'idle') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <QuickGenerateForm onSubmit={runPipeline} />
      </div>
    );
  }

  // Running → show stepper
  if (pipelineStatus === 'running') {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <PipelineStepper />
        <p className="text-sm text-muted mt-4">Generating your agent spec...</p>
      </div>
    );
  }

  // Error → show stepper + retry
  if (pipelineStatus === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 gap-4">
        <PipelineStepper />
        <p className="text-sm text-danger">Generation encountered an error.</p>
        <div className="flex gap-3">
          <button
            onClick={handleRegenerate}
            className="px-4 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-default cursor-pointer"
          >
            Retry
          </button>
          <button
            onClick={reset}
            className="px-4 py-2 text-sm font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
          >
            Start Over
          </button>
        </div>
      </div>
    );
  }

  // Complete → show review
  return (
    <ReviewScreen
      onRegenerate={handleRegenerate}
      onImport={handleImport}
    />
  );
}
```

**Step 2: Create barrel export**

Create `apps/studio/src/components/spec-generation/index.ts`:

```typescript
export { QuickGenerateForm } from './QuickGenerateForm';
export { PipelineStepper } from './PipelineStepper';
export { ReviewScreen } from './ReviewScreen';
export { SpecGenerationView } from './SpecGenerationView';
```

**Step 3: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add apps/studio/src/components/spec-generation/
git commit -m "feat(studio): add SpecGenerationView orchestrator with pipeline execution"
```

---

## Task 11: Integrate into IdeateStage with Mode Toggle

**Files:**

- Modify: `apps/studio/src/components/lifecycle/IdeateStage.tsx`

**Step 1: Add mode toggle state and import**

At the top of `IdeateStage.tsx`, add:

```typescript
import { SpecGenerationView } from '../spec-generation';
```

Add local state inside the component:

```typescript
const [ideateMode, setIdeateMode] = useState<'interview' | 'quick-generate'>('interview');
```

**Step 2: Add toggle UI before the main content**

Wrap the existing layout in a conditional. Add the toggle at the top of the component's return:

```tsx
return (
  <div className="h-full flex flex-col">
    {/* Mode toggle */}
    <div className="flex-shrink-0 flex items-center justify-center gap-1 py-3 border-b border-default bg-background-subtle">
      <button
        onClick={() => setIdeateMode('interview')}
        className={clsx(
          'px-4 py-1.5 text-sm font-medium rounded-lg transition-default cursor-pointer',
          ideateMode === 'interview'
            ? 'bg-accent text-white'
            : 'text-muted hover:text-foreground hover:bg-background-muted',
        )}
      >
        Interview Mode
      </button>
      <button
        onClick={() => setIdeateMode('quick-generate')}
        className={clsx(
          'px-4 py-1.5 text-sm font-medium rounded-lg transition-default cursor-pointer',
          ideateMode === 'quick-generate'
            ? 'bg-accent text-white'
            : 'text-muted hover:text-foreground hover:bg-background-muted',
        )}
      >
        Quick Generate
      </button>
    </div>

    {/* Content */}
    {ideateMode === 'quick-generate' ? (
      <div className="flex-1 min-h-0">
        <SpecGenerationView />
      </div>
    ) : (
      <div className="flex-1 min-h-0 flex">{/* ... existing interview layout ... */}</div>
    )}
  </div>
);
```

**Step 3: Add clsx import if not already present**

Verify `clsx` is imported. If not:

```typescript
import { clsx } from 'clsx';
```

**Step 4: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add apps/studio/src/components/lifecycle/IdeateStage.tsx
git commit -m "feat(studio): add interview/quick-generate toggle to IdeateStage"
```

---

## Task 12: Add Integration Tests for Generate API

**Files:**

- Create: `apps/studio/src/__tests__/arch-generate-openapi.test.ts`

**Step 1: Write integration tests for the openapi and mock_project types**

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the arch-llm module to return null (forces stub path)
vi.mock('@/lib/arch-llm', () => ({
  getArchLLMClient: () => null,
  isArchLLMConfigured: () => false,
  ARCH_CHAT_MODEL: 'test',
  ARCH_GENERATE_MODEL: 'test',
  ARCH_CHAT_MAX_TOKENS: 2048,
  ARCH_GENERATE_MAX_TOKENS: 8192,
  ARCH_TIMEOUT_MS: 60000,
}));

describe('/api/arch/generate — openapi type', () => {
  test('stub generates valid OpenAPI 3.1 structure', async () => {
    // This tests the stub generator directly since LLM is mocked out
    const { POST } = await import('../app/api/arch/generate/route');

    const request = new Request('http://localhost/api/arch/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'openapi',
        brief: {
          domain: 'Hotel Booking',
          problemStatement: 'Test',
          useCases: [],
          targetUsers: [],
          channels: [],
          tone: '',
          constraints: [],
          estimatedAgents: '3',
          complexity: 'medium',
        },
        topology: { nodes: [], edges: [] },
        agents: [
          {
            id: 'a1',
            name: 'Booking',
            executionMode: 'reasoning',
            tools: ['check_availability', 'book_room'],
            gatherFields: [],
            flowStepCount: 3,
          },
        ],
      }),
    });

    const response = await POST(request as any);
    const json = await response.json();

    expect(json.success).toBe(true);
    expect(json.data.openapi).toBeDefined();
    expect(json.data.openapi.openapi).toBe('3.1.0');
    expect(json.data.openapi.paths).toBeDefined();
    // Should have paths for both tools
    const pathKeys = Object.keys(json.data.openapi.paths);
    expect(pathKeys.length).toBeGreaterThanOrEqual(2);
  });
});

describe('/api/arch/generate — mock_project type', () => {
  test('generates a mock project bundle with required files', async () => {
    const { POST } = await import('../app/api/arch/generate/route');

    const mockOpenAPI = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/check-availability': {
          post: {
            operationId: 'check_availability',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { example: { available: true } } },
              },
            },
          },
        },
      },
    };

    const request = new Request('http://localhost/api/arch/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mock_project',
        brief: {
          domain: 'Hotel Booking',
          problemStatement: 'Test',
          useCases: [],
          targetUsers: [],
          channels: [],
          tone: '',
          constraints: [],
          estimatedAgents: '3',
          complexity: 'medium',
        },
        agents: [
          {
            id: 'a1',
            name: 'Booking',
            executionMode: 'reasoning',
            tools: ['check_availability'],
            gatherFields: [],
            flowStepCount: 3,
          },
        ],
        openapi: mockOpenAPI,
      }),
    });

    const response = await POST(request as any);
    const json = await response.json();

    expect(json.success).toBe(true);
    expect(json.data.mockProject).toBeDefined();
    expect(json.data.mockProject.projectName).toContain('hotel-booking-mocks');
    expect(json.data.mockProject.files.length).toBeGreaterThan(0);

    const filePaths = json.data.mockProject.files.map((f: { path: string }) => f.path);
    expect(filePaths).toContain('package.json');
    expect(filePaths).toContain('vercel.json');
    expect(filePaths).toContain('api/_schema.json');
    // Should have a data file for the operation
    expect(filePaths.some((p: string) => p.startsWith('_data/'))).toBe(true);
    // Should have a handler file
    expect(filePaths.some((p: string) => p.startsWith('api/') && p.endsWith('.ts'))).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `cd apps/studio && npx vitest run src/__tests__/arch-generate-openapi.test.ts`
Expected: PASS (uses stub generators since LLM is mocked).

**Step 3: Commit**

```bash
git add apps/studio/src/__tests__/arch-generate-openapi.test.ts
git commit -m "test(studio): add integration tests for openapi and mock_project generation"
```

---

## Task 13: Final TypeScript Verification & Cleanup

**Step 1: Run full TypeScript check**

Run: `cd apps/studio && npx tsc --noEmit`
Expected: No errors.

**Step 2: Run all store tests**

Run: `cd apps/studio && npx vitest run src/__tests__/spec-generation-store.test.ts`
Expected: All pass.

**Step 3: Run all generate tests**

Run: `cd apps/studio && npx vitest run src/__tests__/arch-generate-openapi.test.ts`
Expected: All pass.

**Step 4: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "fix(studio): address type errors from spec generation integration"
```

---

## Summary

| Task | What                            | Files                                                                       |
| ---- | ------------------------------- | --------------------------------------------------------------------------- |
| 1    | Types                           | `types/arch.ts`                                                             |
| 2    | Store + tests                   | `store/spec-generation-store.ts`, `__tests__/spec-generation-store.test.ts` |
| 3    | API: openapi generation         | `app/api/arch/generate/route.ts`                                            |
| 4    | API: mock project generation    | `app/api/arch/generate/route.ts`                                            |
| 5    | API: deploy-mocks endpoint      | `app/api/arch/deploy-mocks/route.ts`                                        |
| 6    | API client extension            | `api/arch.ts`                                                               |
| 7    | QuickGenerateForm               | `components/spec-generation/QuickGenerateForm.tsx`                          |
| 8    | PipelineStepper                 | `components/spec-generation/PipelineStepper.tsx`                            |
| 9    | ReviewScreen                    | `components/spec-generation/ReviewScreen.tsx`                               |
| 10   | SpecGenerationView orchestrator | `components/spec-generation/SpecGenerationView.tsx`                         |
| 11   | IdeateStage toggle              | `components/lifecycle/IdeateStage.tsx`                                      |
| 12   | Integration tests               | `__tests__/arch-generate-openapi.test.ts`                                   |
| 13   | Final verification              | All files                                                                   |
