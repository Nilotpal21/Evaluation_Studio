# E2E Test Framework — Low-Level Design

## What

A modular, dependency-aware E2E test framework for the ABL Platform that:

- Runs against any live environment (localhost, agents-dev.kore.ai, staging)
- Supports two flows: **Create** (full lifecycle) and **Test Existing** (smoke test current state)
- Adapts assertions based on detected configuration (LLM on/off, taxonomy exists/not, etc.)
- Logs bugs — never fixes during test runs
- Excludes from CI — manual/on-demand only
- Reusable by any team (SearchAI, Agents, Workflows, Guardrails)

## Design Decisions

| #   | Decision                                                                      | Why                                                                                                                   |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | Playwright `projects` with `dependencies` for execution ordering              | Built-in DAG resolution — run any project, prerequisites auto-run                                                     |
| D2  | Shared state via JSON file (`e2e/.test-state.json`)                           | Playwright `storageState` only handles cookies. We need kbId, indexId, feature flags                                  |
| D3  | State includes feature detection flags (`llmConfigured`, `hasTaxonomy`, etc.) | Specs adapt assertions based on what's actually configured — no if/else per flow                                      |
| D4  | Two setup phases write the same `TestState` shape                             | Downstream specs don't know or care which flow produced the state                                                     |
| D5  | Bug report is a markdown file, appended during test runs                      | Machine-parseable, human-readable, survives test crashes                                                              |
| D6  | One config file (`e2e-env.config.ts`) with all projects                       | Single entry point, `--project` flag selects what to run                                                              |
| D7  | Cleanup only deletes resources when `state.flow === 'create'`                 | Never touch existing environment data                                                                                 |
| D8  | `workers: 1` is a correctness requirement                                     | State file uses read-merge-write — concurrent workers would corrupt it (TOCTOU race)                                  |
| D9  | `tenantId` lives in `env.ts`, not `TestState`                                 | It's environment config, not test state. All API helpers already read `env.tenantId`                                  |
| D10 | Running without `--project` is invalid                                        | Both flows write to same state file — bare invocation is ambiguous. `globalSetup` validates `--project` was specified |
| D11 | Bug report written via `globalTeardown`                                       | Ensures report is written regardless of which flow ran, even if tests crash                                           |
| D12 | `.bugs-wip.json` uses JSONL format (one JSON object per line)                 | Append-only writes survive process crashes — no need to parse/rewrite entire array on each `logBug()` call            |
| D13 | Existing specs lose standalone capability after rewrite                       | Acceptable tradeoff — original standalone specs remain in git history. Framework specs are more maintainable          |

## Architecture

### Dependency Graph

```
                    ┌──────────────┐
                    │  setup-create │──── Creates KB, uploads docs
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   with-llm   │──── Configures LLM on the created KB
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   enriched   │──── Polls until enrichment completes
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
   │   search    │ │   browse    │ │ intelligence │
   └──────┬──────┘ └──────┬──────┘ └───────┬──────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼───────┐
                    │   cleanup    │──── Deletes test KB (create flow only)
                    └──────────────┘


                    ┌────────────────┐
                    │ setup-existing │──── Finds existing KB, detects config via API
                    └──────┬─────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
   │   search    │ │   browse    │ │ intelligence │
   └─────────────┘ └─────────────┘ └──────────────┘
   (no cleanup — existing data untouched)
   (bug report written via globalTeardown)


                    ┌──────────────┐
                    │  edge-cases  │──── Independent — creates/deletes its own empty KB
                    └──────────────┘
```

### File Structure

```
apps/studio/
├── e2e-env.config.ts                    # Playwright config with all project dependencies
├── e2e/
│   ├── .test-state.json                 # Runtime state (gitignored)
│   ├── helpers/
│   │   ├── env.ts                       # Environment variables
│   │   ├── auth.ts                      # Login, token, project selection
│   │   ├── api.ts                       # HTTP helpers (GET/POST/PUT/PATCH/DELETE/upload)
│   │   ├── ui.ts                        # Screenshot, wait, poll, navigate
│   │   ├── state.ts                     # NEW — TestState read/write
│   │   ├── bug-report.ts               # NEW — Bug logging (JSONL append)
│   │   ├── global-setup.ts             # NEW — Validates --project flag, creates dirs
│   │   ├── global-teardown.ts          # NEW — Writes bug report markdown
│   │   └── index.ts                     # Barrel export
│   ├── searchai/
│   │   ├── phases/
│   │   │   ├── setup-create.spec.ts     # Flow 1: login → create KB → upload docs → detect state
│   │   │   ├── setup-existing.spec.ts   # Flow 2: login → find KB → detect state from APIs
│   │   │   ├── llm-config.spec.ts       # Configure LLM (create flow only)
│   │   │   ├── wait-enrichment.spec.ts  # Poll until enrichment done
│   │   │   └── cleanup.spec.ts          # Delete test KB (create flow only)
│   │   ├── search-quality.spec.ts       # Search tests — adapts to llmConfigured
│   │   ├── browse-preview.spec.ts       # Browse tests — adapts to hasTaxonomy
│   │   ├── intelligence.spec.ts         # Fields/KG/Vocab — adapts to feature flags
│   │   └── edge-cases.spec.ts           # Empty states — self-contained
│   ├── screenshots/searchai/            # Gitignored
│   └── reports/                         # Gitignored
├── .gitignore                           # Excludes reports/, screenshots/searchai/, .test-state.json
```

## Task Decomposition

### T-1: Shared State Module (`helpers/state.ts`)

#### Files to Create

- `apps/studio/e2e/helpers/state.ts`

#### Files to Modify

- `apps/studio/e2e/helpers/index.ts` — re-export `TestState`, `saveState`, `loadState`, `clearState`

#### Interface

```ts
export interface TestState {
  // Auth
  token: string;
  projectId: string;

  // Flow metadata
  flow: 'create' | 'existing';
  timestamp: number;

  // Resources (populated by setup phase)
  kbId: string;
  kbName: string;
  indexId: string;
  sourceIds: string[]; // Array — KB may have multiple sources (manual + crawl)

  // Feature detection (populated by setup or detect phase)
  llmConfigured: boolean;
  enrichmentDone: boolean;
  documentCount: number;
  hasTaxonomy: boolean;
  hasVocabulary: boolean;
  hasFieldMappings: boolean;
  hasKnowledgeGraph: boolean;
}

export function saveState(partial: Partial<TestState>): void;
export function loadState(): TestState;
export function clearState(): void;
```

#### Behavior

- `saveState` — if file doesn't exist, creates it from the partial. If file exists, merges partial into existing state. **Flow conflict guard**: if existing `state.flow` differs from incoming `flow`, throws error ("State conflict: run clearState() or use --project to select one flow")
- `loadState` — reads file, throws if missing ("No test state found. Run setup first: --project=setup-create or --project=setup-existing")
- `clearState` — deletes file (used by cleanup/globalTeardown)
- File location: `apps/studio/e2e/.test-state.json`
- **Requires `workers: 1`** — read-merge-write is not concurrent-safe (D8)

#### Acceptance Criteria

- AC-1: `saveState({ kbId: 'x' })` then `loadState()` returns `{ kbId: 'x' }`
- AC-2: `loadState()` on missing file throws with message "Run setup first"
- AC-3: `saveState` called twice merges (doesn't overwrite unset fields)

---

### T-2: Bug Report Module (`helpers/bug-report.ts`)

#### Files to Create

- `apps/studio/e2e/helpers/bug-report.ts`

#### Files to Modify

- `apps/studio/e2e/helpers/index.ts` — re-export `Bug`, `logBug`, `getBugReport`, `writeBugReport`, `getBugCount`

#### Interface

```ts
export interface Bug {
  id: string; // Auto-generated: BUG-001, BUG-002
  severity: 'critical' | 'high' | 'medium' | 'low';
  spec: string; // Which spec found it
  step: string; // Which test step
  title: string; // One-line summary
  expected: string;
  actual: string;
  screenshot?: string; // Path to screenshot
  url?: string; // Page URL when found
  apiResponse?: { status: number; body: string }; // If API-related
}

export function logBug(bug: Omit<Bug, 'id'>): string; // Returns assigned ID
export function getBugReport(): string; // Returns full markdown
export function writeBugReport(): void; // Writes to docs/testing/reports/
export function getBugCount(): { critical: number; high: number; medium: number; low: number };
```

#### Behavior

- Auto-increments bug ID per run
- Each `logBug()` call appends one JSON line to `e2e/.bugs-wip.json` (JSONL format — D12). No in-memory list needed. Survives process crashes because each line is independently valid JSON.
- `writeBugReport()` reads the JSONL file (line by line), generates markdown, writes to `docs/testing/reports/e2e-bugs-{date}.md`. Creates the output directory if it doesn't exist (`mkdirSync({ recursive: true })`).
- `getBugReport()` and `getBugCount()` read from the JSONL file (not in-memory state)
- Called in `globalTeardown` (D11) — runs after ALL projects complete, regardless of flow

#### Output Format

```markdown
# E2E Bug Report — 2026-03-22

**Environment**: https://agents-dev.kore.ai
**Flow**: create | existing
**Total bugs**: 5 (1 critical, 2 high, 1 medium, 1 low)

## BUG-001 [CRITICAL] — Browse: taxonomy spinner stuck after category switch

- **Spec**: browse-preview.spec.ts
- **Step**: Facet interaction → category switch
- **Expected**: Spinner clears, new facets load
- **Actual**: Spinner visible indefinitely, no facets
- **Screenshot**: screenshots/searchai/browse-03-category-switch.png
- **URL**: https://agents-dev.kore.ai/projects/xxx/search-ai/yyy/browse

## BUG-002 [HIGH] — Search: no results for semantic query without LLM

...
```

---

### T-3: Feature Detection Helper

#### Files to Modify

- `apps/studio/e2e/helpers/api.ts` — add `detectFeatureState()`

#### Function Signature

```ts
export async function detectFeatureState(
  ctx: Page | APIRequestContext,
  token: string,
  indexId: string,
): Promise<Partial<TestState>>;
```

#### Behavior

Calls these APIs and returns detected flags:

1. `GET /api/search-ai/indexes/{indexId}/llm-config` (Studio proxy) → `llmConfigured`
2. `GET /api/search-ai/indexes/{indexId}/documents?limit=1` (Studio proxy — route exists at `apps/studio/src/app/api/search-ai/indexes/[id]/documents/route.ts`) → `documentCount`
3. `GET /api/search-ai/indexes/{indexId}/kg-configuration-status` (Studio proxy) → `hasKnowledgeGraph`, `hasTaxonomy`
4. `GET /api/search-ai/indexes/{indexId}/vocabulary` (Studio proxy) → `hasVocabulary`
5. `GET /api/search-ai/mappings/tab-stats?knowledgeBaseId={indexId}` (Studio proxy) → `hasFieldMappings`
6. `GET /api/search-ai/indexes/{indexId}/documents/status-summary` (Studio proxy — route at `apps/studio/src/app/api/search-ai/indexes/[id]/documents/status-summary/route.ts`) → `enrichmentDone`

**Naming notes:**

- API #5: The param is named `knowledgeBaseId` but actually accepts `SearchIndex._id`. This is a known tech debt naming inconsistency (see MEMORY.md "Naming Inconsistency" section). Pass `indexId` as the value.
- API #6: Returns `{ documentStatuses: [{_id: 'indexed', count: N}, ...], docsWithChunkErrors: N }`. Enrichment is considered done when all documents have status `indexed` and `docsWithChunkErrors === 0`.
- All 6 APIs use Studio proxy routes with cookie-based auth — no direct engine calls needed in `detectFeatureState()`. Only `uploadFile()` calls the engine directly (multipart has no Studio proxy).

#### Used by

- `setup-create.spec.ts` — after upload, detects baseline state
- `setup-existing.spec.ts` — detects everything from current environment
- `wait-enrichment.spec.ts` — polls `status-summary` then re-detects all flags

#### Acceptance Criteria

- AC-1: `detectFeatureState()` returns `llmConfigured: true` when LLM use cases are enabled on the index
- AC-2: `detectFeatureState()` returns `llmConfigured: false` on a fresh KB with no LLM config
- AC-3: `documentCount` matches actual document count in the index
- AC-4: `enrichmentDone` is true only when all documents are `indexed` status and `docsWithChunkErrors === 0`
- AC-5: `hasFieldMappings` is true when tab-stats returns `totalFields > 0`
- AC-6: All 6 API calls use appropriate auth (Studio proxy uses cookie, direct engine uses `X-Tenant-Id` header)

---

### T-4: Setup Phases

#### Files to Create

**`phases/setup-create.spec.ts`**

1. Login via `loginAndNavigateToProject()`
2. Create KB via `apiPost('/api/search-ai/knowledge-bases', ...)`
3. Get indexId from KB detail
4. Create manual source
5. Upload test documents (5 docs defined inline — matching Batch 1 from user journeys: transformer-architecture, rag-patterns, vector-databases-comparison, llm-fine-tuning-guide, ai-safety-principles)
6. Poll until ingestion completes (`documentCount >= 5`)
7. Run `detectFeatureState()` to get baseline flags
8. `saveState({ flow: 'create', kbId, indexId, sourceIds: [sourceId], ...detectedFlags })`
   - Note: `enrichmentDone` will typically be `false` here — enrichment completes asynchronously after ingestion. The `wait-enrichment` phase handles polling for completion.

**`phases/setup-existing.spec.ts`**

1. Login via `loginAndNavigateToProject()`
2. List KBs via `apiGet('/api/search-ai/knowledge-bases?projectId=...')`
3. Pick first KB (or KB matching `TEST_KB_NAME` env var if set)
4. Get indexId from KB detail
5. Run `detectFeatureState()` to detect what's configured
6. `saveState({ flow: 'existing', kbId, indexId, ...detectedFlags })`

**`phases/llm-config.spec.ts`**

1. `loadState()` — get indexId
2. `apiPatch('/api/search-ai/indexes/{indexId}/llm-config', ...)` — enable use cases
3. `saveState({ llmConfigured: true })`

**`phases/wait-enrichment.spec.ts`**

1. `loadState()` — get indexId
2. `pollUntil()` — poll `GET /api/search-ai/indexes/{indexId}/documents/status-summary` (Studio proxy). Done when: all `documentStatuses` entries have `_id === 'indexed'` and `docsWithChunkErrors === 0`. Timeout: 300_000ms (5 min) — override `env.longTimeout` default of 2 min since enrichment is slow.
3. Re-run `detectFeatureState()` to refresh all flags
4. `saveState({ enrichmentDone: true, ...detectedFlags })`

**`phases/cleanup.spec.ts`** (create flow only)

1. `loadState()`
2. If `state.flow === 'create'` → `apiDelete('/api/search-ai/knowledge-bases/{kbId}')`
3. `clearState()`

**`global-setup.ts`** (runs before ALL projects)

1. Validates that `--project` flag was specified (D10) — checks `process.argv.includes('--project')`. If no project specified, logs a warning with usage examples and throws to abort. This prevents accidental bare invocation which would run both flows against the same state file.
2. Ensures `e2e/screenshots/searchai/` and `docs/testing/reports/` directories exist (`mkdirSync({ recursive: true })`)
3. Cleans up stale `.bugs-wip.json` from previous runs
4. Registered in config as `globalSetup: './e2e/helpers/global-setup.ts'`

**`global-teardown.ts`** (runs after ALL projects, any flow)

1. Reads `.bugs-wip.json` (JSONL format — one JSON object per line, D12). If file doesn't exist (e.g., no bugs logged), generates empty report.
2. Generates markdown report, writes to `docs/testing/reports/e2e-bugs-{date}.md`
3. Cleans up temp file (`.bugs-wip.json`)
4. Registered in config as `globalTeardown: './e2e/helpers/global-teardown.ts'`

#### Acceptance Criteria

- AC-1: `setup-create` creates KB, uploads 5 docs (Batch 1), polls until ingestion done, saves state with `flow: 'create'`
- AC-2: `setup-existing` finds existing KB, detects feature state, saves with `flow: 'existing'`
- AC-3: `llm-config` enables LLM use cases via API, updates `llmConfigured: true` in state
- AC-4: `wait-enrichment` polls `status-summary` until all docs indexed, updates `enrichmentDone: true`
- AC-5: `cleanup` deletes KB only when `flow === 'create'`, clears state file
- AC-6: `cleanup` is a no-op when `flow === 'existing'`
- AC-7: `global-setup` exits with warning if no `--project` flag specified
- AC-8: `global-teardown` writes markdown report even if zero bugs were logged

---

### T-5: Test Specs (Assertion-Adaptive)

#### Pattern — every spec follows this structure:

```ts
import { test, expect } from '@playwright/test';
import { loadState, logBug, screenshot, ... } from '../helpers';

test.describe('Feature Name', () => {
  let state: TestState;

  test.beforeAll(() => {
    state = loadState();
  });

  test('scenario name', async ({ page }) => {
    // Navigate using state.kbId, state.projectId
    // Assert based on state.llmConfigured, state.hasTaxonomy, etc.
    // On unexpected behavior → logBug({ ... })
    // Screenshot at every step
  });
});
```

#### `search-quality.spec.ts`

- Reads `state.llmConfigured`
- If LLM: expects semantic matches, reranking, vocabulary resolution
- If no LLM: expects keyword-only matches, documents baseline quality
- Logs bugs for: no results, wrong ranking, errors, empty states

#### `browse-preview.spec.ts`

- Reads `state.hasTaxonomy`
- If taxonomy exists: tests category selection, facet filtering (AND/OR), sort, pagination, search, clear
- If no taxonomy: tests empty state CTA, "Go to Intelligence" button
- Tests Sprint 8 fixes regardless: B5 (no auto-search), C3 (clear), loading states

#### `intelligence.spec.ts`

- Reads `state.hasFieldMappings`, `state.hasVocabulary`, `state.hasKnowledgeGraph`
- Tests each sub-section with appropriate assertions
- Logs bugs for: missing sections, broken navigation, API errors

#### `edge-cases.spec.ts`

- Self-contained — creates its own empty KB, tests empty states, deletes it
- Does NOT depend on shared state (independent project in config)
- Tests: empty tabs, long queries, 0-byte upload, KB deletion

#### Acceptance Criteria

- AC-1: `search-quality` with `llmConfigured: false` runs keyword-only assertions, logs bugs for missing results
- AC-2: `search-quality` with `llmConfigured: true` runs semantic assertions, compares to keyword baseline
- AC-3: `browse-preview` with `hasTaxonomy: true` tests category/facet/sort/pagination/search/clear flows
- AC-4: `browse-preview` with `hasTaxonomy: false` tests empty state CTA and "Go to Intelligence" button
- AC-5: `intelligence` adapts sections based on `hasFieldMappings`, `hasVocabulary`, `hasKnowledgeGraph` flags
- AC-6: `edge-cases` creates its own KB, tests empty states, deletes it — fully independent
- AC-7: Every unexpected behavior is logged via `logBug()` (not thrown as assertion failure)

#### Migration Notes (D13)

Existing specs (`search-quality.spec.ts`, `browse-preview.spec.ts`, `intelligence.spec.ts`, `edge-cases.spec.ts`) will be rewritten to use `loadState()` instead of self-contained setup. The original standalone versions are preserved in git history at commit `81613755d`. `edge-cases.spec.ts` keeps its self-contained pattern (no migration needed).

---

### T-6: Playwright Config with Dependencies

#### Files to Modify

- `apps/studio/e2e-env.config.ts` — **full replacement** of the existing single-project config with a multi-project DAG. The old `chromium` project format is superseded.

#### Config Structure

```ts
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // REQUIRED — state file is not concurrent-safe (D8)
  timeout: 600_000,
  globalSetup: './e2e/helpers/global-setup.ts', // Validates --project, creates dirs (D10)
  globalTeardown: './e2e/helpers/global-teardown.ts', // Always writes bug report (D11)
  reporter: [['list'], ['html', { outputFolder: 'e2e/reports', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    // ─── Create Flow ───
    {
      name: 'setup-create',
      testMatch: 'searchai/phases/setup-create.spec.ts',
    },
    {
      name: 'with-llm',
      testMatch: 'searchai/phases/llm-config.spec.ts',
      dependencies: ['setup-create'],
    },
    {
      name: 'enriched',
      testMatch: 'searchai/phases/wait-enrichment.spec.ts',
      dependencies: ['with-llm'],
    },
    {
      name: 'search-create',
      testMatch: 'searchai/search-quality.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'browse-create',
      testMatch: 'searchai/browse-preview.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'intelligence-create',
      testMatch: 'searchai/intelligence.spec.ts',
      dependencies: ['enriched'],
    },
    {
      name: 'edge-cases',
      testMatch: 'searchai/edge-cases.spec.ts',
      // Independent — no dependencies on shared state
    },
    {
      name: 'cleanup',
      testMatch: 'searchai/phases/cleanup.spec.ts',
      dependencies: ['search-create', 'browse-create', 'intelligence-create'],
    },

    // ─── Existing Flow ───
    {
      name: 'setup-existing',
      testMatch: 'searchai/phases/setup-existing.spec.ts',
    },
    {
      name: 'search-existing',
      testMatch: 'searchai/search-quality.spec.ts',
      dependencies: ['setup-existing'],
    },
    {
      name: 'browse-existing',
      testMatch: 'searchai/browse-preview.spec.ts',
      dependencies: ['setup-existing'],
    },
    {
      name: 'intelligence-existing',
      testMatch: 'searchai/intelligence.spec.ts',
      dependencies: ['setup-existing'],
    },
  ],
});
```

#### Acceptance Criteria

- AC-1: `npx playwright test --config e2e-env.config.ts --project=browse-create` auto-runs: `setup-create` → `with-llm` → `enriched` → `browse-create`
- AC-2: `npx playwright test --config e2e-env.config.ts --project=browse-existing` auto-runs: `setup-existing` → `browse-existing`
- AC-3: `npx playwright test --config e2e-env.config.ts --project=cleanup` runs the full create flow chain
- AC-4: `npx playwright test --config e2e-env.config.ts --project=edge-cases` runs independently with no prerequisites
- AC-5: Bug report markdown is written to `docs/testing/reports/` after any flow completes

#### Run Commands

```bash
# Full create flow (all phases + cleanup)
npx playwright test --config e2e-env.config.ts --project=cleanup

# Full existing flow (all tests against current state)
npx playwright test --config e2e-env.config.ts --project=search-existing --project=browse-existing --project=intelligence-existing

# Single spec with auto-prerequisites (create flow)
npx playwright test --config e2e-env.config.ts --project=browse-create

# Single spec against existing data
npx playwright test --config e2e-env.config.ts --project=browse-existing

# Edge cases only (no dependencies)
npx playwright test --config e2e-env.config.ts --project=edge-cases

# Headed mode (watch browser)
npx playwright test --config e2e-env.config.ts --project=browse-create --headed
```

---

### T-7: Gitignore & CI Exclusion

#### Files to Modify

- `apps/studio/.gitignore`

#### Additions

```
e2e/.test-state.json
e2e/.bugs-wip.json
e2e/reports/
e2e/screenshots/searchai/
```

#### Additions (verify before adding — some may already exist)

Existing `.gitignore` already has `e2e/reports/` and `e2e/screenshots/searchai/`. Only add new entries if missing.

#### CI Exclusion Verification

- `apps/studio/vitest.config.ts` already excludes `e2e/**`
- No CI pipeline invokes `npx playwright test`
- `e2e-env.config.ts` has `forbidOnly: false` (CI configs use `true`)

#### Acceptance Criteria

- AC-1: `.test-state.json` and `.bugs-wip.json` are gitignored
- AC-2: `pnpm test` (vitest) does not discover any `e2e/**/*.spec.ts` files
- AC-3: No CI pipeline references `e2e-env.config.ts`

---

### T-8: Other Teams Leverage

#### How Workflow team adds specs

1. Create `apps/studio/e2e/workflows/crud.spec.ts`
2. Add project to `e2e-env.config.ts`:
   ```ts
   {
     name: 'workflow-crud',
     testMatch: 'workflows/crud.spec.ts',
     dependencies: ['setup-create'], // reuses login + project
   }
   ```
3. Import from `helpers/` — same auth, API, UI, state, bug-report utilities

#### How Agent team adds specs

Same pattern — `e2e/agents/chat.spec.ts`, depends on `setup-create` or `setup-existing`.

#### Convention

- Each team owns a subdirectory: `e2e/searchai/`, `e2e/workflows/`, `e2e/agents/`
- Phase specs go in `<team>/phases/`
- Test specs go in `<team>/`
- All share `e2e/helpers/`

---

## Implementation Order

| Phase | Task                                                                  | Depends On    | Est. Files               |
| ----- | --------------------------------------------------------------------- | ------------- | ------------------------ |
| 1     | T-1: State module                                                     | —             | 1                        |
| 1     | T-2: Bug report module                                                | —             | 1                        |
| 1     | T-3: Feature detection                                                | T-1           | 1 (modify api.ts)        |
| 2     | T-4: Setup phases (7 files: 5 specs + global-setup + global-teardown) | T-1, T-2, T-3 | 7                        |
| 2     | T-6: Config with dependencies                                         | T-4           | 1 (modify config)        |
| 3     | T-5: Test specs (4 files — rewrite 3 existing + keep edge-cases)      | T-4           | 4                        |
| 3     | T-7: Gitignore (verify existing entries, add missing)                 | —             | 1 (modify)               |
| —     | T-8: Convention doc                                                   | All           | 0 (convention, not code) |

## Out of Scope

- Fixing bugs found during testing (logged only)
- CI integration (manual/on-demand only)
- Visual regression testing (separate concern)
- Performance/load testing (k6 benchmarks exist separately)
- Migrating existing non-SearchAI Playwright specs (full-platform, tools, workflow, guardrails) to shared helpers (follow-up)
- `kb-lifecycle.spec.ts` is superseded by `setup-create.spec.ts` — can be deleted after framework is stable
- **Journeys 5+6** (web crawl, upload-with-LLM) — deferred to Phase 2 of testing. Current framework covers Journeys 1-4, 7-10. Web crawl (J6) requires external URL availability. Upload-with-LLM (J5) can be added as an optional phase between `with-llm` and `enriched` once the core framework is stable.
- **Search baseline comparison** (J3 vs J8) — create flow runs search only after LLM is configured. To compare keyword-only vs LLM-enriched results, run the existing flow against a non-LLM environment first, then create flow against an LLM environment. The framework doesn't automate this cross-environment comparison.
- **Bug reports are intentionally committed** — `docs/testing/reports/e2e-bugs-{date}.md` files are NOT gitignored. They serve as test artifacts for tracking bugs across runs.
