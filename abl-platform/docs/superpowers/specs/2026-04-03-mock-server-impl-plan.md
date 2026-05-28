# Mock Server Generation — Implementation Plan

> Three-commit implementation. All changes listed, all files identified. Reviewed and updated 2026-04-03 after design review.

## Commit Strategy

Per repo commit discipline (one concern per commit, max 3 packages):

| #   | Commit                                                                  | Scope                                              | Packages                          |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------- |
| 1   | `refactor(arch-ai): extract mock-server generator from arch.service.ts` | Pure extraction of v1 functions + new types        | `packages/arch-ai`                |
| 2   | `feat(arch-ai): add tool extractor and mock-server generation pipeline` | New dual-source extractor + orchestration function | `packages/arch-ai`                |
| 3   | `feat(studio): wire mock-server generation into Build phase and UI`     | Route wiring + UI updates + session type           | `packages/arch-ai`, `apps/studio` |

---

## Commit 1: Extract v1 Generator

### Files to Create

1. **`packages/arch-ai/src/mock-server/types.ts`**
   - `ToolMeta` — `{ toolName: string; description: string; endpoint: string; agentName: string }`
   - `MockServerOutput` — `{ projectName: string; files: Array<{ path: string; content: string }>; endpointCount: number }`
   - `OpenAPISpec` — type alias for the generated spec shape

2. **`packages/arch-ai/src/mock-server/openapi-generator.ts`**
   - `generateOpenAPIFromTools(tools: ToolMeta[], projectName: string): OpenAPISpec`
   - Adapted from v1 `generateOpenAPIStub` (arch.service.ts:2347)
   - All endpoints POST (no method inference)
   - Remove v1 `brief` dependency — take `projectName` string instead

3. **`packages/arch-ai/src/mock-server/mock-project-generator.ts`**
   - `generateMockProject(openapi: OpenAPISpec, projectName: string): MockServerOutput`
   - Adapted from v1 `generateMockProject` (arch.service.ts:2529)
   - Generates: package.json, vercel.json, README.md, api/ handlers, \_data/ mock responses
   - `buildHandlerContent()` — modernized to use `fs.promises.readFile` (not `readFileSync`)
   - `extractMockResponseData()` — unchanged from v1
   - `generateDeterministicMockData(toolName: string): unknown` — heuristic by tool name prefix
   - Carries own `MOCK_SERVER_MAX_ENDPOINTS = 100` constant

4. **`packages/arch-ai/src/mock-server/index.ts`**
   - Barrel export for types and generator functions

### Files to Modify

5. **`packages/arch-ai/src/index.ts`**
   - Add re-export: `export * from './mock-server/index.js'`

### Exit Criteria

- `pnpm build --filter=@agent-platform/arch-ai` passes
- All exported functions have correct type signatures
- No runtime dependencies on `arch.service.ts`

---

## Commit 2: Tool Extractor + Pipeline

### Files to Create

6. **`packages/arch-ai/src/mock-server/tool-extractor.ts`**
   - `extractToolsFromABL(code: string, agentName: string): ToolMeta[]` — parse ABL YAML via `parseAgentBasedABL`, extract from `document.tools`
   - `extractToolsFromBlueprint(agentName: string, toolNames: string[]): ToolMeta[]` — fallback: tool name strings from `perAgent[name].tools`
   - `extractAllTools(agentFiles: Record<string, { content: string }>, perAgent?: Record<string, { tools: string[] }>): ToolMeta[]` — dual-source: try parser first, fall back to blueprint metadata

7. **`packages/arch-ai/src/mock-server/generate-mock-server.ts`**
   - `generateMockServerArtifacts(params: { agentFiles: Record<string, { content: string }>; projectName: string; perAgent?: Record<string, { tools: string[] }> }): MockServerOutput`
   - High-level orchestration: extract tools → generate OpenAPI → generate project
   - Single entry point for the route layer

### Files to Modify

8. **`packages/arch-ai/src/mock-server/index.ts`**
   - Add exports for `extractAllTools`, `generateMockServerArtifacts`

### Exit Criteria

- `pnpm build --filter=@agent-platform/arch-ai` passes
- `generateMockServerArtifacts` called with sample agent files returns a valid `MockServerOutput`
- Extractor returns tools from both ABL parser and blueprint fallback paths

---

## Commit 3: Wire into Build Phase + UI

### Files to Modify

9. **`packages/arch-ai/src/types/session.ts`**
   - Add to `SessionMetadata`:
     ```typescript
     mockServer?: {
       projectName: string;
       files: Array<{ path: string; content: string }>;
       endpointCount: number;
     };
     ```

10. **`packages/arch-ai/src/session/session-service.ts`**
    - In `toArchSession()`: map `doc.metadata.mockServer` to the typed field

11. **`apps/studio/src/app/api/arch-ai/message/route.ts`**
    - In `agent_review` accept path: when `generatedCount >= totalAgents`, instead of emitting "done" and returning, **fall through** to a new finalization block:
      1. Cross-agent validation (existing logic, currently skipped)
      2. Call `generateMockServerArtifacts()` with agent files + blueprint perAgent
      3. Store result in `session.metadata.mockServer` via MongoDB update
      4. Emit `progress` events during generation
      5. Emit `file_changed` events for each mock file (path prefixed with `mock-server/`)
      6. Transition BUILD → CREATE, emit `phase_transition`
      7. Emit `done`

12. **`apps/studio/src/hooks/useArchChat.ts`**
    - In `file_changed` handler: detect `mock-server/` prefix in `event.path`
      - For mock files: use the full relative path as the file key, create a `mock_file` tab type (not `agent_code`)
      - For agent files: keep existing `.abl.yaml` stripping logic

13. **`apps/studio/src/store/arch-ai-store.ts`**
    - Add `'mock_file'` to `ArtifactTabType` union
    - `addFile()` for mock files: set `compileStatus` to undefined (no compilation status for mock files)

14. **`apps/studio/src/components/arch-v3/panels/IDEPanel.tsx`**
    - Separate file list into two groups: agent files and mock-server files
    - Agent files: render as `{name}.abl.yaml` (current behavior)
    - Mock files: render with actual filename from path (e.g., `package.json`, `api/lookup-order.ts`)
    - Show `📁 mock-server` collapsible header between the groups

15. **`apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`**
    - Add `'mock_file'` case to `TabContent` switch
    - `MockFileTabContent`: render path in header breadcrumb, content in `<pre>` with appropriate formatting
    - In `SummaryTabContent`: read `session.metadata.mockServer.endpointCount` and display "Mock endpoints: N" + "Download Mock Server" button
    - Add `ARTIFACT_TAB_TYPES` entry for `'mock_file'` if it should appear in the artifact panel tabs

16. **`apps/studio/src/app/arch/page.tsx`**
    - In phase effect: when entering BUILD, also check for existing `session.metadata.mockServer` (resume case) and populate mock files in the store
    - In CREATE phase: no changes needed (SummaryTabContent reads from session metadata)

### Exit Criteria

- `pnpm build --filter=@agent-platform/arch-ai --filter=studio` passes
- Build exit criteria (`phase-machine.ts`) still counts only agent files
- Agent review gate still shows correct agent counts
- Create phase persists only agents as `ProjectAgent` records
- Mock server files appear in file tree under mock-server/ group
- Clicking a mock file opens the correct tab with the right content
- Create summary shows mock endpoint count

---

## Testing (Manual — Full Flow)

After all three commits:

1. Interview → Blueprint → Build → generate agents → approve all
2. Verify: progress events show "Generating mock server..."
3. Verify: mock server files appear in file tree under mock-server/ group
4. Click `mock-server/api/lookup-order.ts` — verify TypeScript handler code renders
5. Click `mock-server/_data/lookup-order.json` — verify JSON mock data renders
6. Click `mock-server/api/_schema.json` — verify OpenAPI spec renders
7. Click `mock-server/README.md` — verify instructions render
8. Verify: agent count in review gates is correct (not inflated by mock files)
9. Proceed to Create — verify summary shows "Mock endpoints: N"
10. Verify: "Download Mock Server" button works
11. Verify: only agents are persisted as ProjectAgent records (not mock files)
12. Reload page — verify mock files still appear in file tree (session persistence)

---

## Commit Messages

### Commit 1

```
[ABLP-162] refactor(arch-ai): extract mock-server generator from arch.service.ts

Extract v1 mock generation functions into packages/arch-ai/src/mock-server/:
- generateOpenAPIFromTools() — OpenAPI spec from tool metadata (all POST)
- generateMockProject() — Vercel project files from OpenAPI
- buildHandlerContent() — async handler template (fs.promises.readFile)
- extractMockResponseData() — mock data from OpenAPI examples
- generateDeterministicMockData() — heuristic mock data by tool name
- ToolMeta, MockServerOutput, OpenAPISpec types

Pure extraction with modernized async I/O. No wiring changes.
```

### Commit 2

```
[ABLP-162] feat(arch-ai): add tool extractor and mock-server generation pipeline

Add dual-source tool extractor:
- Primary: parse ABL YAML via parseAgentBasedABL for TOOLS sections
- Fallback: read tool name strings from Blueprint perAgent metadata

Add generateMockServerArtifacts() — single entry point that orchestrates
tool extraction → OpenAPI generation → Vercel project generation.
```

### Commit 3

```
[ABLP-162] feat(studio): wire mock-server generation into Build phase and UI

Wire mock server generation into the post-build finalization step:
- After all agents approved, coordinator generates mock server artifacts
- Stores in session.metadata.mockServer (separate from agent files)
- Emits file_changed SSE events for each mock file
- Transitions BUILD → CREATE after generation completes

UI updates:
- useArchChat: detect mock-server/ prefix in file_changed events
- IDEPanel: two-group file tree (agents + mock-server folder)
- OnboardingArtifactPanel: mock file viewer + Create summary endpoint count
- arch-ai-store: mock_file tab type

Build exit criteria and Create persistence are unaffected.
```
