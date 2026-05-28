# Mock Server Generation — Design Spec

> Auto-generate a Vercel-deployable mock API server from agent tool definitions during the Build phase. Mock server files appear in the file tree alongside agent ABL files and can be viewed/downloaded.

## Review Status

Design reviewed 2026-04-03 by GPT-5.4 Codex and Claude 4.6 Opus. All critical findings accepted and incorporated. Decisions documented below.

| #   | Review Finding                           | Decision                                      |
| --- | ---------------------------------------- | --------------------------------------------- |
| C1  | `metadata.files` cannot hold mock files  | Separate field: `session.metadata.mockServer` |
| C2  | Wrong orchestration point (gate handler) | Post-build coordinator finalization step      |
| C3  | Frontend changes understated             | Full file list in impl plan                   |
| H1  | HTTP method inference too weak           | All POST (v1 behavior)                        |
| H2  | `readFileSync` in handler template       | Modernize to `fs.promises.readFile`           |
| H3  | Mock data generation under-specified     | Deterministic placeholders, no LLM            |
| H4  | Deploy to Vercel vs download             | Download only for v0.3                        |

## Problem

Agents define TOOLS (HTTP endpoints they call), but during development those endpoints don't exist yet. Without working tool endpoints, agents can't be tested — tool calls fail at runtime. Users need a way to get working mock endpoints immediately after code generation.

## Solution

After all agents are generated and approved in the Build phase, the coordinator runs a **post-build finalization step** that:

1. **Extracts** tool definitions from generated ABL files AND Blueprint `perAgent` tool lists
2. **Generates** an OpenAPI spec from those tool definitions (all endpoints POST, reuses v1 `generateOpenAPIStub`)
3. **Generates** a Vercel mock project with handlers for each endpoint (reuses v1 `generateMockProject`)
4. **Stores** the mock server files in `session.metadata.mockServer` (separate from agent files)
5. **Displays** mock server files in the file tree (viewable like agent code)

## Architecture

```
Build Phase — Post-Build Finalization
(after last agent approved, before BUILD→CREATE transition)
  │
  ├─ Cross-agent validation (existing — compile all together)
  │
  ├─ Extract tools from ABL files + Blueprint perAgent metadata
  │    Primary: parseAgentBasedABL(code).document.tools
  │    Fallback: blueprintOutput.perAgent[name].tools (string[] of names)
  │    Output: Array<{ toolName, description, endpoint }>
  │
  ├─ generateOpenAPIStub(tools, projectSpec)
  │    Output: OpenAPI 3.0 JSON spec (all endpoints POST)
  │    (Reuses arch.service.ts:2347 logic)
  │
  ├─ generateMockProject(openapi, projectName)
  │    Output: { files: Array<{ path, content }> }
  │    Files: package.json, vercel.json, README.md, api/_schema.json,
  │           api/{endpoint}.ts (handlers), _data/{op}.json (mock responses)
  │    (Reuses arch.service.ts:2529 logic)
  │
  ├─ Store in session.metadata.mockServer
  │    { projectName, files: Array<{ path, content }>, endpointCount }
  │
  ├─ Emit file_changed SSE events for each mock file
  │    path: "mock-server/{file.path}", action: "create"
  │
  ├─ Coordinator transitions BUILD → CREATE
  │
  └─ BuildPanel file tree shows mock-server/ folder alongside agent files
```

## Implementation Details

### Tool Extraction (Dual-Source)

The Construct Expert prompt does not guarantee `TOOLS:` sections in generated ABL YAML. The extractor uses two sources:

**Primary — ABL parser:**
Parse each agent's ABL YAML via `parseAgentBasedABL`. If `document.tools` is non-empty, extract `AgentTool.name`, `AgentTool.description`, and `AgentTool.parameters`.

**Fallback — Blueprint metadata:**
When the parser returns empty tools (agent was generated without a TOOLS section), read tool names from `blueprintOutput.perAgent[agentName].tools` (`string[]`). These are name-only — no descriptions or parameters.

For each extracted tool:

- `toolName`: the tool key name
- `description`: from parser when available, otherwise derived from tool name
- `endpoint`: `/api/{toolName}` (kebab-case)
- `method`: always POST (v1 behavior — no prefix-based inference)

### Mock Response Generation (Deterministic)

No LLM calls. Mock data is generated deterministically:

1. **OpenAPI examples first:** If the generated spec includes `x-examples` or `responses.200.content.*.example`, use those.
2. **Heuristic templates by tool name:**
   - `lookup_*` / `get_*` → `{ "id": "ITEM-12345", "status": "active", "found": true }`
   - `create_*` / `submit_*` → `{ "id": "NEW-001", "status": "created", "createdAt": "2024-01-15T10:30:00Z" }`
   - `check_*` / `verify_*` → `{ "valid": true, "result": "passed" }`
   - `search_*` / `list_*` → `{ "results": [{ "id": "1", "name": "Item 1" }], "total": 1 }`
   - `update_*` / `process_*` → `{ "updated": true, "id": "ITEM-12345" }`
3. **Fallback:** `{ "success": true, "data": {} }`

### Handler Template (Async I/O)

Generated Vercel handlers use `fs.promises.readFile` instead of `readFileSync`:

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const DATA_PATH = join(process.cwd(), '_data', '{operationId}.json');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method?.toUpperCase() !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const raw = await readFile(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return res.status(200).json(data);
  } catch {
    return res.status(200).json({ success: true, data: {} });
  }
}
```

### Session Data Model

Mock server files are stored in a **separate** session metadata field, not in `metadata.files`:

```typescript
// In SessionMetadata (packages/arch-ai/src/types/session.ts)
mockServer?: {
  projectName: string;
  files: Array<{ path: string; content: string }>;
  endpointCount: number;
};
```

This ensures:

- Build exit criteria (`Object.keys(files).length`) count only agent files
- Agent review gate `generatedCount` counts only agents
- Create phase persists only agents as `ProjectAgent` records
- Mock server data is independently accessible by the UI

### Post-Build Finalization Step

The coordinator owns a finalization step that runs after the last agent is approved and before the BUILD→CREATE transition:

```
Last agent_review Accept
  │
  ├─ Coordinator detects: generatedCount >= totalAgents
  │
  ├─ Step 1: Cross-agent validation (compile all agents together)
  │    If fail → show errors, user must fix before proceeding
  │
  ├─ Step 2: Mock server generation
  │    Extract tools → generate OpenAPI → generate project
  │    Store in session.metadata.mockServer
  │    Emit file_changed events for each mock file
  │    Emit progress events: "Generating mock server (3/5 endpoints)..."
  │
  ├─ Step 3: Transition BUILD → CREATE
  │    Emit phase_transition event
  │
  └─ done
```

The gate handler itself stays simple — it just emits "approved" text and falls through. Finalization is a coordinator concern, not a gate concern.

### File Tree Display

Mock server files appear in the BuildPanel file tree under a `mock-server/` group:

```
Files (5 items)
├── 📄 Greeter.abl.yaml
├── 📄 Answers.abl.yaml
└── 📁 mock-server/
    ├── README.md
    ├── package.json
    ├── vercel.json
    ├── api/_schema.json
    ├── api/lookup-order.ts
    └── _data/lookup-order.json
```

Clicking any mock server file opens it in the code viewer. The code viewer renders TypeScript for `.ts` files, JSON for `.json` files, and Markdown for `.md` files.

### Integration with Create Phase

During project creation, the Create summary card shows:

- Agents: N
- Mock endpoints: M
- "Download Mock Server" button (zips the mock project files)

Mock server files are **not** persisted as `ProjectAgent` records. They are available for download from session metadata only.

### What We Reuse from v1

| v1 Function                 | File            | Lines     | What It Does                             | Changes During Extraction              |
| --------------------------- | --------------- | --------- | ---------------------------------------- | -------------------------------------- |
| `generateOpenAPIStub()`     | arch.service.ts | 2347-2527 | Generates OpenAPI spec from tool names   | Remove brief dependency, keep all-POST |
| `generateMockProject()`     | arch.service.ts | 2529-2636 | Generates Vercel project from OpenAPI    | Add README.md generation               |
| `extractMockResponseData()` | arch.service.ts | 2638-2659 | Extracts mock data from OpenAPI examples | No changes                             |
| `buildHandlerContent()`     | arch.service.ts | 2661-2684 | Generates Vercel API handler TypeScript  | Modernize to async I/O                 |

### What We Build New

1. **Tool extractor** — dual-source: parse ABL YAML TOOLS sections, fallback to Blueprint `perAgent` tool names
2. **Mock trigger** — post-build coordinator finalization step (after validation, before BUILD→CREATE)
3. **File tree grouping** — BuildPanel shows mock-server/ as a collapsible folder with file-type-aware rendering
4. **Integration** — wire into the existing Build → Create flow with separate metadata field
5. **Types** — `ToolMeta` interface, `MockServerOutput` interface, `SessionMetadata.mockServer` field

## Scope

- **In scope:** Tool extraction (dual-source), OpenAPI stub generation (all-POST), Vercel mock project generation, deterministic mock data, file tree display, code viewing, download
- **Out of scope:** OpenAPI import (S2-F12), deployment to Vercel, runtime integration, API key management, LLM-generated mock data, HTTP method inference

### Future: S2-F12 Interaction

When S2-F12 (API Spec Import) is implemented, if a user has imported an OpenAPI spec during Blueprint, mock generation should prefer the imported spec over generating from scratch. This prevents conflicting API definitions for the same tools. Design for this interaction will be added when S2-F12 moves to implementation.

## Dependencies

- ABL parser (`parseAgentBasedABL` from `@abl/core`) for extracting TOOLS sections
- Blueprint metadata (`blueprintOutput.perAgent[name].tools`) for fallback tool names
- v1 mock generation functions from `arch.service.ts`
- Existing BuildPanel file tree and code viewer

## Acceptance Criteria

- [ ] After all agents are approved in Build, coordinator runs finalization step
- [ ] Finalization generates mock server files and stores in `session.metadata.mockServer`
- [ ] Mock server files appear in the file tree under mock-server/ group
- [ ] Mock server files are viewable by clicking them (TypeScript handlers, JSON mock data, OpenAPI spec)
- [ ] File tree shows mock-server/ as a distinct group with appropriate file icons
- [ ] OpenAPI spec includes all tools from all generated agents
- [ ] All mock endpoints use POST method
- [ ] Each tool has a Vercel API handler that returns deterministic mock data
- [ ] Mock data uses heuristic templates by tool name (not just `{ success: true }`)
- [ ] Generated handlers use async `fs.promises.readFile`, not `readFileSync`
- [ ] Create phase summary shows mock endpoint count and "Download Mock Server" button
- [ ] Build exit criteria and agent counts are unaffected (separate metadata field)
- [ ] Files persist in session metadata across reloads
