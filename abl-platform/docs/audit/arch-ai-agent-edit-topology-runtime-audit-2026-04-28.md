# Arch AI Agent Edit, Tool, Prompt, and Knowledge Runtime Audit

Date: 2026-04-28

## Scope

This audit covers the in-project Arch AI path used to create and edit agents after a project exists. It focuses on whether Arch can make intelligent, runtime-safe suggestions by understanding the full agent topology, the changed agent's dependencies, tool implementations, knowledge dependencies, auth state, and required follow-up actions.

Primary code paths audited:

- Agent read, edit, validation, apply, topology, and tool-link tools:
  - `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`
  - `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`
  - `apps/studio/src/lib/arch-ai/tools/mcp-server-ops.ts`
  - `apps/studio/src/lib/arch-ai/topology-helpers.ts`
- Live registry and compatibility path:
  - `apps/studio/src/lib/arch-ai/engine-factory.ts`
  - `apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts`
- Proposal UI persistence:
  - `apps/studio/src/lib/arch-ai/ui/proposal-artifacts.ts`
  - `apps/studio/src/lib/arch-ai/types/arch.ts`
  - `packages/arch-ai/src/types/session.ts`
- In-project prompt training:
  - `packages/arch-ai/src/prompts/phases/in-project.ts`
  - `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`
  - `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
  - `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`
- Runtime tool binding resolver:
  - `packages/shared/src/tools/resolve-tool-implementations.ts`
  - `packages/compiler/src/platform/ir/compiler.ts`

## Executive Verdict

Status after this hardening pass: **stronger, but still proof-gated for external systems**.

Arch now has server-side guardrails for the most dangerous in-project agent edit failure mode: adding a `TOOLS:` signature that compiles as ABL but has no ProjectTool implementation at runtime. It also now attaches an explicit proposal impact summary so agent edits are explained against topology, tools, impacted agents, and next validation actions instead of being treated as isolated text patches.

The important limit is external-system truth. Arch can verify that an HTTP, SearchAI, Sandbox, Workflow, or MCP ProjectTool exists and compiles into runtime bindings. It cannot honestly guarantee that a remote HTTP API, MCP server, OAuth credential, or knowledge source will succeed forever without running the relevant smoke test using current credentials. The safe user-facing contract is therefore: **no proposal is runtime-ready until project bindings resolve; production confidence requires the returned next actions such as `tools_ops test`, `mcp_server_ops test_tool`, `kb_health`, `health_check`, and `run_test`.**

## Runtime-Ready Agent Edit Contract

For any agent create or edit, Arch must follow this chain:

1. Read the target agent with `read_agent`.
2. Read the project topology with `read_topology`.
3. Inspect dependency context when relevant:
   - `tools_ops list/read` for tool signatures and implementation records.
   - `mcp_server_ops list/read/test_connection/discover_preview/import_tools/test_tool` for MCP-backed tools.
   - `kb_manage`, `kb_search`, `kb_health`, `kb_ingest`, `kb_connector`, and `kb_documents` for knowledge-backed behavior.
   - `platform_context list_agents/list_tools/list_auth_profiles/list_channels/get_summary` for project inventory.
   - `configure_model`, `read_journal`, `health_check`, and `diagnose_project` when the edit touches model choice, prior decisions, topology, gather fields, memory, flow, or constraints.
4. Use `propose_modification`, not direct mutation.
5. Accept only proposals that pass parse, full project compile, diagnostics, and ProjectTool implementation resolution.
6. Explain the proposal with impact:
   - affected agents,
   - incoming and outgoing topology edge changes,
   - tools added or removed,
   - validation warnings,
   - concrete next actions to prove runtime behavior.
7. Ask for confirmation only when the proposal is not blocked.
8. Run follow-up validation after apply when the impact says to do so.

## Changes Made in This Pass

### 1. ProjectTool Runtime Binding Validation

Before this pass, `validateProjectAgentCode()` parsed and compiled the proposed ABL with sibling agents but did not require that each tool declared in the target agent's `TOOLS:` section had a matching ProjectTool implementation. A model could add `lookup_customer(customer_id: string) -> object`, the ABL could compile in preview mode, and the runtime could still fail because no `project_tools` record existed.

The validator now extracts target tool names from the parsed ABL document and calls the existing `resolveToolImplementations()` path with:

- `tenantId`
- `projectId`
- `toolsByAgent`
- existing `findMcpServerConfigsByProject()` for MCP server config loading

If resolution returns errors, the proposal is rejected with a clear hint to create, test, or import the ProjectTool first. The compiler also receives `resolvedToolImplementations` when resolution succeeds, matching the runtime compile path.

### 2. Proposal Impact Envelope

`propose_modification` now attaches a server-generated `impact` object to both the returned proposal and the session pending mutation.

Impact includes:

- `runtimeReady`
- changed agent and declared agent name
- impacted agents
- incoming and outgoing topology before and after
- added and removed topology edges
- tools before and after
- added and removed tools
- next actions

The UI proposal normalization now preserves the impact payload, and pending mutation restoration keeps it available when the user returns to an open proposal.

### 3. Blocked Proposal Apply Protection

`apply_modification` now refuses to apply a pending mutation whose `reviewStatus` is `blocked`. This prevents a stale or exhausted repair proposal from being applied after validation already determined it is unsafe.

Blocked proposals also receive a `runtimeReady: false` impact payload, so the model and UI state can explain that the proposed edit must be repaired before confirmation or apply.

### 4. Parser-Based Topology and Tool Extraction

`read_topology` now uses the ABL parser for tool names and edges instead of relying on regex extraction. This fixes dependency understanding for:

- canonical `TOOLS:` signatures with descriptions,
- `HANDOFF` edges,
- `DELEGATE` edges using parser output `delegate.agent`,
- `ESCALATE` trigger targets.

The fallback `extractToolNames()` helper now recognizes canonical signatures such as:

```abl
TOOLS:
  lookup_customer(customer_id: string) -> object
    description: "Look up customer details"
```

and legacy dash-prefixed signatures.

### 5. Prompt Training Updated

The in-project phase prompt, generalist prompt, ABL construct expert prompt, and integration methodologist prompt now instruct Arch to:

- read the current agent and topology before editing,
- check dependency context before changing tools, knowledge, auth, model settings, flow, memory, gather fields, handoff, or delegate behavior,
- never add a `TOOLS:` signature before the matching ProjectTool or imported MCP ProjectTool exists,
- link only signatures and parameters into agents,
- keep endpoint, auth, headers, body, code, MCP server, SearchAI index, and tenant/project implementation fields in ProjectTool records,
- explain proposal impact and next actions,
- avoid confirmation for blocked proposals.

## Capability Matrix

| Capability                                                 | Status                                                    | Runtime-safety notes                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read current agent                                         | Live                                                      | `read_agent` returns stored ABL so edits can be grounded in actual code.                                                                                         |
| Read full topology                                         | Hardened                                                  | Now parser-based for handoff, delegate, escalate, and tool extraction.                                                                                           |
| Create new agent                                           | Partial-live                                              | Uses `propose_modification(isNew=true)` and validation. Runtime confidence depends on tool binding resolution and post-apply tests.                              |
| Edit existing agent                                        | Hardened                                                  | Parse, project compile, diagnostics, ProjectTool resolution, impact summary, and blocked-apply guard are now enforced.                                           |
| Link existing HTTP/Sandbox/SearchAI/Workflow tool to agent | Hardened                                                  | Agent receives only signature/description. Validator requires ProjectTool exists and compiles to IR binding.                                                     |
| Create HTTP tool                                           | Live via `tools_ops`                                      | Uses existing `createToolViaService()` with tenant, project, user, and permissions. Must run `tools_ops test` for remote API proof.                              |
| Test HTTP/Sandbox/SearchAI/Workflow tool                   | Live via `tools_ops test`                                 | Uses existing `executeToolTest()` with tenant, project, user, and tool ID.                                                                                       |
| Create SearchAI/KB-backed tool                             | Live via `tools_ops` searchai config                      | Stores SearchAI ProjectTool DSL with index binding. Requires KB health/search validation for confidence.                                                         |
| Create/manage knowledge base                               | Live in registry from prior fix                           | `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, and `kb_documents` call existing Studio/SearchAI APIs with tenant/project/user/auth context. |
| Link knowledge-backed tool to agent                        | Hardened                                                  | SearchAI tool must exist as ProjectTool before signature can be added.                                                                                           |
| Configure auth-backed MCP server                           | Live via `mcp_server_ops`                                 | Uses existing `/api/projects/:projectId/mcp-servers` APIs. Required secrets flow through `collect_secret` and are not sent to the model.                         |
| Import MCP tools                                           | Live via `mcp_server_ops import_tools`                    | Imported MCP tools become ProjectTool records. Agent linking should use `tools_ops read/list` `agentToolBlock`.                                                  |
| Test MCP server/tool                                       | Live via `mcp_server_ops test_connection` and `test_tool` | Required for real remote runtime proof. Binding existence alone is not enough.                                                                                   |
| Explain dependency impact                                  | Hardened                                                  | Proposal impact now lists affected agents, topology changes, tool changes, and next actions.                                                                     |
| Prevent unsafe apply                                       | Hardened                                                  | Blocked pending proposals cannot be applied.                                                                                                                     |

## Tool Linking Contract

Arch must not paste ProjectTool implementation code into an agent. The agent `TOOLS:` section must contain only callable signatures and optional agent-local annotations.

Allowed in agent:

```abl
TOOLS:
  get_customer(customer_id: string) -> object
    description: "Look up customer details"
```

Not allowed in agent:

- endpoint URL
- HTTP method
- headers
- body template
- auth config
- bearer tokens or secret placeholders
- MCP server config
- sandbox source code
- SearchAI index ID
- tenant ID
- project ID

Implementation fields remain in ProjectTool records created or imported through `tools_ops` and `mcp_server_ops`.

## Remaining Gaps and Honest Limits

### G1. Remote execution cannot be guaranteed from static validation alone

ProjectTool binding resolution proves the platform can compile a tool into runtime IR. It does not prove a third-party API, MCP server, OAuth grant, or network path succeeds right now. Arch must run the matching test action before telling a user the integration is production-ready.

Required next actions by dependency type:

- HTTP/Sandbox/SearchAI/Workflow tool: `tools_ops test`
- MCP server: `mcp_server_ops test_connection`
- MCP imported tool: `mcp_server_ops test_tool`
- Knowledge base: `kb_health`, and `kb_search` when retrieval quality matters
- Agent behavior: `run_test` against the changed agent
- Topology changes: `health_check` after apply

### G2. Impact payload is currently text/data for Arch, not a rich UI panel

The proposal impact is preserved in the proposal payload and pending mutation. A future UI improvement should render it in the diff panel so users can scan impacted agents and next actions without relying only on chat text.

### G3. Existing sibling agents with parse errors reduce certainty

The validator now warns when sibling agents cannot be parsed or have parse errors. This is intentionally not hidden: full topology safety is lower until those sibling agents are fixed.

### G4. Connector setup beyond ProjectTool and MCP paths needs separate coverage

Arch can create ProjectTools and MCP tools through the audited paths. If a connector requires a separate connector-specific OAuth/configuration workflow outside `auth_ops`, `tools_ops`, `mcp_server_ops`, and `kb_connector`, that workflow needs its own capability audit and tests before claiming full automation.

## Evidence Added

Regression coverage added in this pass:

- `apps/studio/src/__tests__/arch-ai/topology-helpers.test.ts`
  - verifies canonical `TOOLS:` signatures with descriptions are extracted,
  - verifies legacy dash-prefixed signatures still work.
- `apps/studio/src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`
  - verifies an agent edit declaring a tool without a ProjectTool implementation is rejected before it can become a runtime-breaking proposal.
- `apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts`
  - verifies the live `validate_agent` registry schema accepts `depth` for project runtime validation.
- `apps/studio/src/__tests__/arch-ai/v1-core-refs.test.ts`
  - verifies compat refs forward `validate_agent` depth to the in-project tool path.
- `apps/studio/src/__tests__/arch-ai/proposal-artifacts.test.ts`
  - verifies proposal restoration preserves the server-generated impact payload.

## Final Assessment

Arch is now materially safer for complex in-project agent creation and editing. It is no longer relying only on prompt discipline for the most important runtime boundary: tool signatures in agents must resolve to real ProjectTool implementations. It also has a concrete topology/tool impact payload to reason about dependency changes and follow-up validation.

User trust should still be framed correctly: Arch can make high-confidence, runtime-grounded proposals when it has inspected topology and dependency context and when validation passes. For external integrations and knowledge retrieval, "100% working" requires running the smoke tests listed in the proposal impact because those systems are outside the static compiler's control.
