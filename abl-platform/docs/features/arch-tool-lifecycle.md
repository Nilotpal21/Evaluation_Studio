# Feature: Arch Tool Lifecycle

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Arch AI Assistant](./arch-ai-assistant.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `integrations`
**Package(s)**: `packages/arch-ai`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/arch-tool-lifecycle.md](../testing/arch-tool-lifecycle.md)
**Last Updated**: 2026-04-13

---

## 1. Introduction / Overview

### Problem Statement

Arch AI generates tool definitions for agents during the BUILD phase of onboarding — tool names,
descriptions, endpoint shapes, and parameters are embedded in generated ABL YAML files. However,
these tool definitions have no persistence lifecycle. When the CREATE phase completes and a project
is instantiated, the tools exist only as DSL text inside ABL files. They are never materialized as
`ProjectTool` HTTP documents that the runtime, the Studio tool editor, or the agent execution
pipeline can use.

The practical consequence is that every agent developer who uses Arch AI to design their project
must manually recreate each tool in the Studio tool builder after onboarding — transcribing names,
endpoint patterns, parameter schemas, and descriptions that Arch AI already knows about. This is a
redundant multi-step workflow that breaks the promise of AI-guided project creation and causes
errors when manual transcription diverges from the generated ABL.

A second, related problem exists in the IN_PROJECT mode: Arch AI can reason about an agent's tool
requirements and propose new tools, but has no mechanism to actually read, create, update, test, or
map tools against the live `ProjectTool` catalog. The LLM context available to in-project
specialists contains no tool state — only agent ABL.

### Goal Statement

Arch Tool Lifecycle closes the gap between Arch AI's design-time tool knowledge and the platform's
runtime tool catalog. By the end of onboarding, every tool Arch designed is a real, persisted
`ProjectTool` HTTP document with correct metadata. During IN_PROJECT work, Arch AI specialists can
read, create, update, test, and map tools conversationally without leaving the Arch chat panel.

### Summary

The feature adds six Arch-callable tools (`list_project_tools`, `create_project_tool`,
`update_project_tool`, `test_project_tool`, `delete_project_tool`, `map_tool_to_agent`) and a
`BUILD:TOOLS` sub-phase. During CREATE, the coordinator automatically persists all tools identified
in the Blueprint and BUILD outputs as `ProjectTool` records. In IN_PROJECT mode, the new tools
expose the full tool CRUD+test+map surface to Arch AI specialists. The compiler gains schema-based
constraint validation so that a tool's declared parameter schema is checked against actual agent
GATHER/CONSTRAINTS usage at compile time. All tool decisions and actions are persisted to the
session journal for LLM context continuity.

---

## 2. Scope

### Goals

- Automatically persist all Arch-designed tools as `ProjectTool` HTTP documents when a project is
  created through onboarding.
- Expose a tool CRUD + test + map surface to Arch AI specialists in IN_PROJECT mode via six new
  tool definitions.
- Add a `BUILD:TOOLS` sub-phase so the LLM can iteratively refine tool designs before the
  BUILD→CREATE transition.
- Validate tool parameter schemas against agent GATHER and CONSTRAINTS usage at compile time.
- Persist all tool actions (create, update, delete, test, map) to the session journal so the LLM
  maintains context across turns.

### Non-Goals (Out of Scope)

- ABL grammar or DSL syntax changes — tool schema definitions continue to use the existing ABL
  TOOLS section format.
- Studio UI changes — the existing Studio tool builder remains the primary UI; Arch provides a
  conversational interface only.
- Tool versioning or schema migration — version history for tool definitions is deferred to a
  separate feature.
- Mock server deployment automation — generating and deploying a Vercel mock server is covered by
  the Mock Server Generation feature.
- OAuth2 or JIT auth configuration — credential and auth-profile binding is not part of the initial
  scope.
- MCP, Sandbox, SearchAI, Connector, or Workflow tool types — only HTTP tools are auto-created in
  this feature; other types remain manual.

---

## 3. User Stories

1. As an **agent developer**, I want tools designed by Arch during onboarding to automatically
   become real HTTP tools in my project so I can test and configure them without manually
   recreating each one.
2. As an **agent developer**, I want to ask Arch AI to add a new tool to my project
   conversationally and have it appear in the Studio tool list without switching contexts.
3. As an **agent developer**, I want Arch AI to run a live test against a tool endpoint from within
   the chat panel so I can validate connectivity before wiring it to an agent.
4. As an **agent developer**, I want the compiler to warn me when an agent's GATHER fields or
   CONSTRAINTS reference tool parameters that do not exist in the tool's declared schema.
5. As an **agent developer**, I want Arch AI to remember which tools it created or modified during
   a session so I do not have to repeat context across conversation turns.
6. As a **platform operator**, I want all Arch AI tool actions to be logged to the session journal
   so they are auditable and replayable when diagnosing agent behavior.

---

## 4. Functional Requirements

1. **FR-1**: The CREATE phase coordinator must extract all tool definitions from the BUILD phase
   outputs (both ABL YAML `TOOLS:` sections and Blueprint `perAgent` tool lists) and persist each
   as a `ProjectTool` HTTP document before completing project creation.
2. **FR-2**: Tool auto-creation must be idempotent — if a `ProjectTool` with the same `slug` and
   `projectId` already exists, the coordinator must update it rather than create a duplicate.
3. **FR-3**: The system must expose a `list_project_tools` Arch tool that returns all
   `ProjectTool` records scoped to the current `projectId` and `tenantId`.
4. **FR-4**: The system must expose a `create_project_tool` Arch tool that creates a new
   `ProjectTool` HTTP document and records the action in the session journal.
5. **FR-5**: The system must expose an `update_project_tool` Arch tool that modifies an existing
   `ProjectTool` record and records the action in the session journal.
6. **FR-6**: The system must expose a `test_project_tool` Arch tool that dispatches a live HTTP
   test against the tool's configured endpoint using the existing `tool-test-service` and returns
   the response, latency, and error (if any).
7. **FR-7**: The system must expose a `delete_project_tool` Arch tool with a mandatory
   confirmation gate before deletion executes.
8. **FR-8**: The system must expose a `map_tool_to_agent` Arch tool that appends a tool reference
   to an agent's ABL TOOLS section and triggers recompilation.
9. **FR-9**: The ABL compiler must validate that every parameter name referenced inside an agent's
   GATHER blocks or CONSTRAINTS checkpoints exists in the corresponding tool's declared parameter
   schema. Violations must produce a `TOOL_SCHEMA_MISMATCH` diagnostic.
10. **FR-10**: Every Arch AI tool action that mutates a `ProjectTool` record (`create`,
    `update`, `delete`, `map`) must emit a journal entry containing the tool name, action type,
    before/after diff, and the specialist that performed the action.
11. **FR-11**: The BUILD phase must support a `BUILD:TOOLS` sub-phase in which the Arch specialist
    can propose, review, and refine tool definitions before transitioning to CREATE.
12. **FR-12**: All six new Arch tools must respect tenant and project isolation — every read and
    write must include `tenantId` and `projectId` filters, and cross-project access must return a
    404 error.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level |
| -------------------------- | ------------ |
| Project lifecycle          | PRIMARY      |
| Agent lifecycle            | PRIMARY      |
| Customer experience        | SECONDARY    |
| Integrations / channels    | SECONDARY    |
| Observability / tracing    | SECONDARY    |
| Governance / controls      | SECONDARY    |
| Enterprise / compliance    | NONE         |
| Admin / operator workflows | NONE         |

### Related Feature Integration Matrix

| Related Feature                                                                            | Relationship Type | Why It Matters                                                                         | Key Touchpoints                                              | Current State |
| ------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| [Tool Invocations](./tool-invocations.md)                                                  | extends           | Auto-created tools are `ProjectTool` HTTP documents that Tool Invocations executes     | `createProjectTool` repo function, `ProjectTool` model       | STABLE        |
| [Arch AI Assistant](./arch-ai-assistant.md)                                                | extends           | This feature adds tool CRUD capabilities to the Arch chat interface                    | Phase machine, specialist router, tool definitions, journal  | ALPHA         |
| [Mock Server Generation](../superpowers/specs/2026-04-03-mock-server-generation-design.md) | shares data with  | Both features read tool definitions from BUILD outputs; mock server uses tool metadata | `ToolMeta`, `extractAllTools`, `session.metadata.mockServer` | PLANNED       |
| [Agent Development Studio](./agent-development-studio.md)                                  | shares data with  | Studio tool builder and Arch tool lifecycle operate on the same `ProjectTool` records  | `findProjectToolsByProject`, `updateProjectTool`             | STABLE        |
| [Arch AI Journal](./arch-ai-assistant.md)                                                  | emits into        | Tool mutations are recorded as journal entries for LLM context persistence             | `journal-service`, `JournalEntry`, `read_journal` tool       | ALPHA         |

---

## 6. Design Considerations

The six new Arch tools follow the established `tools-ops.ts` action-dispatch pattern:
permission check → dangerous-action gate → action switch. This pattern is already used for the
existing in-project tool surface and keeps all Arch-callable mutations behind a unified permission
layer.

The `BUILD:TOOLS` sub-phase is modelled as a coordinator-owned step rather than a separate phase,
similar to how cross-agent validation and mock-server generation are post-build finalization steps.
This avoids adding a new entry to the `ARCH_PHASES` constant and keeps the phase machine stable.

The `TOOL_SCHEMA_MISMATCH` compiler diagnostic follows the existing `CompilerDiagnostic` shape
(`{ code, message, severity, location? }`). The validation runs after tool DSL is parsed and before
IR emission, so it can be surfaced in the Studio compile panel without runtime impact.

---

## 7. Technical Considerations

- **Dual-source tool extraction** — The CREATE phase coordinator must attempt ABL YAML parsing
  first (`parseAgentBasedABL`) and fall back to Blueprint `perAgent.tools` string arrays. The same
  dual-source logic is used by the Mock Server Generator and should be shared via the existing
  `extractAllTools` function in `packages/arch-ai/src/mock-server/tool-extractor.ts`.
- **Idempotency** — Tool auto-creation during CREATE must use upsert semantics keyed on
  `(tenantId, projectId, slug)`. Without idempotency, re-running CREATE or retrying a failed
  project creation produces duplicate tools.
- **Tool test execution** — The `test_project_tool` Arch tool delegates to the existing
  `tool-test-service` in `apps/studio/src/services/tool-test-service.ts`. No new HTTP test
  infrastructure is needed.
- **Phase machine stability** — Adding `BUILD:TOOLS` as a coordinator sub-phase must not change
  the `ARCH_PHASES` constant or the `PHASE_CONFIG` record. The sub-phase is an internal coordinator
  state surfaced via a new SSE event type only.
- **LLM context window** — The session journal must include tool CRUD entries so that subsequent
  Arch turns have context about which tools exist. Journal entries must be included in the sliding
  window sent to the LLM (subject to the existing token budget logic).
- **Rollout** — Tool auto-creation in CREATE is gated on successful tool extraction. If extraction
  returns zero tools, CREATE proceeds normally with no `ProjectTool` records created and no error
  is shown to the user.

---

## 8. How to Consume

### Studio UI

Tool lifecycle actions are available conversationally through the Arch AI chat panel in IN_PROJECT
mode. Users type natural language requests such as "add a tool to look up orders" or "test the
payment endpoint." Arch AI routes the request to the appropriate specialist which calls the
relevant tool.

Auto-created tools from onboarding appear immediately in the Studio tool list
(`/projects/:projectId/tools`) after the project is created. No additional user action is needed.

### API (Studio)

The six new Arch tools are invoked through the existing Arch AI message endpoint. They are not
exposed as standalone REST routes.

| Method | Path                                     | Purpose                                      |
| ------ | ---------------------------------------- | -------------------------------------------- |
| POST   | `/api/arch-ai/sessions/:id/message`      | Send a message; Arch may call any of the 6   |
| GET    | `/api/projects/:projectId/tools`         | List tools created by Arch or manually       |
| POST   | `/api/projects/:projectId/tools`         | Existing tool creation (used by auto-create) |
| GET    | `/api/projects/:projectId/tools/:toolId` | Read a specific tool                         |
| PUT    | `/api/projects/:projectId/tools/:toolId` | Update a tool                                |
| DELETE | `/api/projects/:projectId/tools/:toolId` | Delete a tool                                |

### Admin Portal

No admin-facing changes. Tool records are scoped to projects and managed by project-level users.

### Channel / SDK / Voice / A2A / MCP Integration

Tool auto-creation is not channel-aware. The `ProjectTool` records created by Arch are identical to
those created manually and are executed through the same runtime tool invocation pipeline across all
channels.

---

## 9. Data Model

### Collections / Tables

The feature does not introduce new collections. It uses the existing `projecttools` collection via
the `ProjectTool` model:

```text
Collection: projecttools
Fields (subset relevant to this feature):
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (human-readable label)
  - slug: string (unique within project, kebab-case tool identifier)
  - toolType: string ('http' for auto-created tools)
  - description: string
  - dslContent: string (JSON-encoded tool configuration)
  - sourceHash: string
  - createdBy: string (userId of the initiating user, or 'arch-ai' for auto-created)
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, projectId: 1, slug: 1 } (unique)
```

Journal entries for tool actions are stored in the existing `archjournals` collection:

```text
Collection: archjournals
Additional entry types added by this feature:
  - type: 'tool_created' | 'tool_updated' | 'tool_deleted' | 'tool_mapped'
  - payload: { toolId, toolName, action, diff?, agentName? }
```

### Key Relationships

- Each `ProjectTool` is scoped to one project (`projectId`) and one tenant (`tenantId`).
- Journal entries reference the session (`sessionId`) and optionally the agent (`agentName`) and
  tool (`toolId`) that were involved.
- The `map_tool_to_agent` action produces an updated ABL file in `session.metadata.files` and
  writes a journal entry linking the tool to the agent.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                    | Purpose                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/arch-ai/src/mock-server/tool-extractor.ts`                    | Dual-source tool extraction (ABL YAML + Blueprint fallback)               |
| `packages/arch-ai/src/types/tools.ts`                                   | `ToolName` union (`tools_ops`, `save_tool_dsl`), `IN_PROJECT_TOOLS` array |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | BUILD:TOOLS + IN_PROJECT tool CRUD prompt guidance                        |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`      | Tool Management prompt note                                               |
| `packages/arch-ai/src/prompts/phases/in-project.ts`                     | `tools_ops` in available tools list                                       |

### Routes / Handlers

| File                                                    | Purpose                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/tool-creation-service.ts`          | NEW: Shared tool creation/update service enforcing all 9 route invariants             |
| `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`        | Tool CRUD dispatch via shared service (DSL serialization fixed)                       |
| `apps/studio/src/lib/arch-ai/tools/diagnose-project.ts` | T-01 through T-06 project-level tool diagnostics                                      |
| `apps/studio/src/lib/arch-ai/build-completion.ts`       | `handleBuildAction('tools')` — BUILD:TOOLS sub-phase entry point                      |
| `apps/studio/src/app/api/arch-ai/message/route.ts`      | `save_tool_dsl` tool, `tools_ops` registration, CREATE-time persistence, turn counter |

### UI Components

No new UI components. Arch chat panel already renders tool CRUD responses as structured content
blocks. The Studio tool list at `/projects/:projectId/tools` automatically reflects auto-created
tools.

### Jobs / Workers / Background Processes

No background jobs. Tool auto-creation during CREATE is a synchronous step in the coordinator's
finalization sequence.

### Tests

| File                                                    | Type | Coverage Focus                                              |
| ------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `packages/arch-ai/src/__tests__/tools.test.ts`          | unit | ToolName union, IN_PROJECT_TOOLS, PHASE_TOOL_MAP (19 tests) |
| `packages/arch-ai/src/__tests__/tool-extractor.test.ts` | unit | Dual-source extraction, ABL parser, blueprint fallback      |

---

## 11. Configuration

### Environment Variables

No new environment variables. Tool test execution uses the existing runtime connection settings.

### Runtime Configuration

No feature flags. Tool auto-creation is always active when Arch creates a project. The `BUILD:TOOLS`
sub-phase is enabled by default once the feature ships.

### DSL / Agent IR / Schema

Tool definitions in ABL YAML use the existing `TOOLS:` section format. No grammar changes:

```yaml
TOOLS:
  - name: lookup_order
    description: Look up order details by order ID
    endpoint: /api/lookup-order
    parameters:
      - name: order_id
        type: string
        required: true
```

The new `TOOL_SCHEMA_MISMATCH` compiler diagnostic is surfaced via the existing
`CompilerDiagnostic` shape:

```typescript
{
  code: 'TOOL_SCHEMA_MISMATCH',
  severity: 'warning',
  message: 'GATHER field "order_id" references tool "lookup_order" but parameter "order_id" is not declared in its schema',
  location: { agent: 'OrderAgent', section: 'GATHER', line: 42 }
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Every `ProjectTool` read/write includes `projectId`. Cross-project access returns 404.                             |
| Tenant isolation  | Every `ProjectTool` read/write includes `tenantId`. Cross-tenant access returns 404.                               |
| User isolation    | `createdBy` is set to the initiating `userId` (or `'arch-ai'` for coordinator-auto-created tools). Not user-owned. |

### Security & Compliance

- The six new Arch tools pass through the existing `checkToolPermission` gate in `guards.ts` before
  any mutation executes.
- Destructive actions (`delete_project_tool`) require `confirmed: true` in the tool input,
  enforced by the `isDangerousAction` check.
- All tool test executions pass through the existing SSRF protection in `tool-test-service`.
- No secrets or credentials are stored in `dslContent` — auth configuration is managed separately
  via auth profiles.

### Performance & Scalability

- Tool auto-creation during CREATE is bounded by the number of tools in a project (typical: 3–15).
  At most 15 sequential upserts per project creation — negligible latency impact.
- The `list_project_tools` Arch tool uses the existing paginated `findProjectToolsByProject` query.
  No additional indexes needed.

### Reliability & Failure Modes

- If tool auto-creation fails for one tool during CREATE, the coordinator logs the error, skips
  that tool, and continues. Project creation is not blocked by tool persistence failures.
- The `test_project_tool` Arch tool returns an error response (not an exception) when the endpoint
  is unreachable, allowing the conversation to continue.
- Tool extraction returning zero tools is not an error condition — it produces a no-op in the
  CREATE finalization.

### Observability

- Each tool auto-creation emits a `tool_created` journal entry that is queryable via `read_journal`.
- The existing `createLogger('arch-ai:tools-ops')` logger in `tools-ops.ts` covers all CRUD
  actions at `info` level.
- Tool test latency (`latencyMs`) is returned in the `test_project_tool` result and logged.

### Data Lifecycle

- `ProjectTool` records follow the project lifecycle — they are deleted in cascade when a project
  is deleted (existing behavior in the project deletion handler).
- Journal entries for tool actions are retained for the lifetime of the session (existing TTL policy).

---

## 13. Delivery Plan / Work Breakdown

1. Extend tool extractor and CREATE coordinator
   1.1 Verify `extractAllTools` covers all edge cases (no TOOLS section, malformed YAML, blueprint-only)
   1.2 Add `tool-lifecycle-ops.ts` with upsert logic calling `createProjectTool` / `updateProjectTool`
   1.3 Wire auto-creation into the CREATE phase finalization step in coordinator
   1.4 Add `createdBy: 'arch-ai'` attribution to auto-created tools
2. Add six new Arch tool definitions
   2.1 Add `LLMToolDefinition` entries in `packages/arch-ai/src/tools/definitions.ts`
   2.2 Add Zod schemas in `in-project-schemas.ts`
   2.3 Register tools in the IN_PROJECT phase tool set
   2.4 Add `map` action to existing `tools-ops.ts` dispatch
3. Add `BUILD:TOOLS` sub-phase
   3.1 Add coordinator state for `BUILD:TOOLS` entry and exit
   3.2 Emit `build_tools_start` / `build_tools_end` SSE events
   3.3 Wire specialist prompt context for tool refinement
4. Add compiler schema validation
   4.1 Implement `TOOL_SCHEMA_MISMATCH` diagnostic in ABL compiler
   4.2 Add tests for GATHER field / CONSTRAINTS parameter cross-referencing
5. Wire journal persistence
   5.1 Add `tool_created`, `tool_updated`, `tool_deleted`, `tool_mapped` journal entry types
   5.2 Emit journal entries in `tools-ops.ts` after each successful mutation
   5.3 Verify `read_journal` surfaces tool entries in LLM context
6. Tests and validation
   6.1 Unit tests for tool extractor edge cases
   6.2 Unit tests for 6 new tool definitions and schemas
   6.3 Unit test for `TOOL_SCHEMA_MISMATCH` compiler diagnostic
   6.4 E2E test: full onboarding → tool auto-create → IN_PROJECT tool CRUD

---

## 14. Success Metrics

| Metric                                                      | Baseline | Target   | How Measured                                             |
| ----------------------------------------------------------- | -------- | -------- | -------------------------------------------------------- |
| % of onboarded projects with at least one auto-created tool | 0%       | ≥ 80%    | Count `ProjectTool` records with `createdBy='arch-ai'`   |
| Manual tool recreation after Arch onboarding                | ~100%    | < 10%    | Studio analytics — tool create events after CREATE phase |
| Tool auto-creation error rate                               | N/A      | < 2%     | Journal error entries / total CREATE completions         |
| `TOOL_SCHEMA_MISMATCH` diagnostic catch rate                | 0%       | Measured | Compiler diagnostic telemetry                            |

---

## 15. Open Questions

1. Should `map_tool_to_agent` recompile the agent synchronously and return the compile result, or
   should it persist the ABL change and leave compilation to the user?
2. Should the `BUILD:TOOLS` sub-phase be gated by user approval (show proposed tools, user
   confirms before CREATE) or fully automatic?
3. When a tool is updated via `update_project_tool`, should agents currently using that tool be
   recompiled automatically, or should a warning be shown instead?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                    | Severity | Status    |
| ------- | -------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Only HTTP tool type is auto-created; MCP/Sandbox/SearchAI tools require manual setup                           | Medium   | Open      |
| GAP-002 | `TOOL_SCHEMA_MISMATCH` compiler diagnostic not implemented (FR-9 deferred)                                     | Low      | Deferred  |
| GAP-003 | Tool auto-creation during CREATE does not backfill auth profiles — credentials still need manual configuration | Medium   | Open      |
| GAP-004 | Design spec created at `docs/superpowers/specs/2026-04-12-arch-build-tool-creation-design.md`                  | Low      | Mitigated |
| GAP-005 | `map_tool_to_agent` (FR-8) deferred — use `propose_modification` to add tools to agent TOOLS sections          | Medium   | Deferred  |
| GAP-006 | Full journal entries for tool mutations (FR-10) not implemented — audit logging via `logAuditEvent` only       | Medium   | Deferred  |
| GAP-007 | E2E and integration tests not yet written — only unit tests (tools.test.ts 19/19)                              | High     | Open      |
| GAP-008 | Test spec FR numbering diverges from feature spec FR numbering — needs reconciliation                          | Low      | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                  | Coverage Type | Status     | Test File / Note                  |
| --- | ----------------------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------- |
| 1   | CREATE phase extracts tools from ABL YAML and persists as `ProjectTool` records           | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |
| 2   | CREATE phase falls back to Blueprint `perAgent` tool names when ABL has no TOOLS section  | unit          | NOT TESTED | `tool-extractor.test.ts`          |
| 3   | Tool auto-creation is idempotent — re-running CREATE does not duplicate tools             | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |
| 4   | `list_project_tools` returns only tools scoped to the current project and tenant          | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 5   | `create_project_tool` creates a record and emits a journal entry                          | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 6   | `update_project_tool` updates the record and emits a journal entry                        | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 7   | `delete_project_tool` requires confirmation and emits a journal entry                     | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 8   | `test_project_tool` returns latency and output for a reachable endpoint                   | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |
| 9   | `map_tool_to_agent` appends tool reference to agent ABL and records in journal            | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |
| 10  | Compiler emits `TOOL_SCHEMA_MISMATCH` when GATHER field references unknown tool parameter | unit          | NOT TESTED | `tool-validator.test.ts`          |
| 11  | Cross-project tool access returns 404                                                     | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 12  | Cross-tenant tool access returns 404                                                      | unit          | NOT TESTED | `arch-ai-tools-tools-ops.test.ts` |
| 13  | Journal entries for tool mutations are surfaced in `read_journal` output                  | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |
| 14  | Tool auto-creation failure for one tool does not block project creation                   | unit          | NOT TESTED | `tool-lifecycle-ops.test.ts`      |
| 15  | `BUILD:TOOLS` sub-phase emits correct SSE events and transitions to CREATE                | integration   | NOT TESTED | `arch-tool-lifecycle.e2e.test.ts` |

### Testing Notes

Unit test coverage exists for the type registry (`packages/arch-ai/src/__tests__/tools.test.ts` —
19 tests passing). This covers `ToolName` union, `IN_PROJECT_TOOLS`, `PHASE_TOOL_MAP`, and
`CLIENT_SIDE_TOOLS` with the new `tools_ops` and `save_tool_dsl` entries.

No E2E or integration tests exist yet (GAP-007). Priority for test authoring:

1. BUILD:TOOLS sub-phase flow (handleBuildAction → save_tool_dsl → completion)
2. tools_ops.create DSL round-trip validation
3. CREATE-time toolDsls persistence
4. Tool diagnosis T-01 through T-06

> Full testing details: [../testing/arch-tool-lifecycle.md](../testing/arch-tool-lifecycle.md)

---

## 18. References

- Design spec: `docs/superpowers/specs/2026-04-12-arch-build-tool-creation-design.md`
- LLD: `docs/plans/2026-04-13-arch-build-tool-creation-impl-plan.md`
- Prior design spec: `docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md`
- Mock server generation: `docs/superpowers/specs/2026-04-03-mock-server-generation-design.md`
- Mock server impl plan: `docs/superpowers/specs/2026-04-03-mock-server-impl-plan.md`
- Parent feature: `docs/features/arch-ai-assistant.md`
- Tool invocations feature: `docs/features/tool-invocations.md`
- In-project tool ops implementation: `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`
- Tool extractor: `packages/arch-ai/src/mock-server/tool-extractor.ts`
- Phase machine: `packages/arch-ai/src/coordinator/phase-machine.ts`
- Session types: `packages/arch-ai/src/types/session.ts`
