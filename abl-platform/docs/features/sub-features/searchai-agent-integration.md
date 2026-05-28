# Feature: SearchAI KB→Tool→Agent Integration

**Doc Type**: SUB-FEATURE
**Parent Feature**: Connectors
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`, `integrations`
**Package(s)**: `apps/search-ai`, `apps/runtime`, `apps/studio`, `packages/database`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/searchai-agent-integration.md](../../testing/sub-features/searchai-agent-integration.md)
**Last Updated**: 2026-03-18

---

## 1. Introduction / Overview

### Problem Statement

Knowledge-base creation, tool registration, agent compilation, and runtime retrieval can easily drift apart if each step has to be configured manually. Without this integration layer, users would need to duplicate SearchAI metadata into Studio tools and agent configuration, which makes KB-backed retrieval harder to adopt and easier to break.

### Goal Statement

The goal of this sub-feature is to make a SearchAI knowledge base immediately usable as an agent tool by automatically creating the linked index, seeding default pipeline state, registering a `searchai` tool, and preserving that binding through compile-time and runtime execution.

### Summary

SearchAI KB→Tool→Agent Integration is the glue that turns a SearchAI knowledge base into an agent-usable tool. When a user creates a knowledge base, the SearchAI service auto-creates the underlying `search_indexes` record, seeds a default pipeline, and upserts a `project_tools` entry of type `searchai`. From that point on, the KB is visible in Studio's tools surface and can be bound into agent DSL like any other tool.

At compile time, the tool is loaded from `project_tools` and transformed into IR with a populated `searchai_binding`. At runtime, `llm-wiring` detects the SearchAI tool, registers it with `SearchAIKBToolExecutor`, and routes tool calls through the SearchAI SDK. On first use, the executor discovers the target index, builds a richer tool description, and caches that discovery for later invocations.

This feature matters because it makes knowledge retrieval a first-class tool pattern instead of a one-off integration. Knowledge bases, tool registration, agent compilation, and query execution all stay synchronized without requiring the user to manually duplicate metadata across SearchAI, Studio, and Runtime.

---

## 2. Scope

### Goals

- Auto-create and maintain the SearchAI index, default pipeline, and generated tool when KBs are created or updated.
- Make the generated SearchAI tool visible in Studio and bindable in agent DSL without extra manual wiring.
- Preserve the generated KB binding through compile output and runtime execution.

### Non-Goals (Out of Scope)

- This sub-feature does not provide a separate admin-only management surface.
- This sub-feature does not own the broader connector framework or generic tool runtime; it relies on those parent capabilities.
- This sub-feature does not guarantee live indexed-content execution coverage in the current automated test inventory.

---

## 3. User Stories

1. As a SearchAI user, I want a new KB to appear automatically as an agent-usable tool so that I do not have to manually mirror KB metadata into Studio tools.
2. As an agent builder, I want the generated SearchAI tool to compile into a valid `searchai_binding` so that retrieval works like any other tool binding.
3. As a runtime engineer, I want SearchAI execution to stay aligned with KB and index metadata so that tool calls remain stable across create, update, and execute flows.

---

## 4. Functional Requirements

1. **FR-1**: The system must create or link a `search_indexes` record when a knowledge base is created.
2. **FR-2**: The system must auto-register or upsert a `searchai` tool in `project_tools` for the knowledge base.
3. **FR-3**: The system must expose the generated SearchAI tool through Studio tool APIs and tool-picker surfaces.
4. **FR-4**: The system must compile the generated SearchAI tool into IR with a populated `searchai_binding`.
5. **FR-5**: The system must route runtime SearchAI tool execution through `SearchAIKBToolExecutor` and the SearchAI SDK.
6. **FR-6**: The system must clean up or re-register the generated tool when KB metadata changes or the KB is removed.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                         |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | KBs, tools, and compile artifacts are all scoped to the project.              |
| Agent lifecycle            | PRIMARY      | Generated SearchAI tools participate directly in compile and runtime.         |
| Customer experience        | SECONDARY    | End users benefit indirectly when agents can retrieve KB information.         |
| Integrations / channels    | SECONDARY    | Once compiled, the tool is channel-agnostic across chat, SDK, A2A, and voice. |
| Observability / tracing    | SECONDARY    | Runtime execution inherits shared tool-call tracing.                          |
| Governance / controls      | SECONDARY    | Tool visibility and KB access depend on RBAC and project/tenant scope.        |
| Enterprise / compliance    | NONE         | This sub-feature is narrower than enterprise connector sync concerns.         |
| Admin / operator workflows | NONE         | There is no separate admin-only management surface.                           |

### Related Feature Integration Matrix

| Related Feature                                                   | Relationship Type | Why It Matters                                                            | Key Touchpoints                                 | Current State                                              |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| [Connectors](../connectors.md)                                    | extends           | SearchAI enterprise flows rely on the broader connector/auth foundation.  | discovery, recommendation, quick-setup patterns | Parent capability relationship is explicit                 |
| [Tool Invocations](../tool-invocations.md)                        | depends on        | Generated SearchAI tools execute through the shared tool invocation path. | `llm-wiring`, runtime tool execution            | Runtime integration is already wired                       |
| [Deployments & Versioning](../deployments-versioning.md)          | shares data with  | Tool snapshots and compile artifacts capture SearchAI binding metadata.   | compile output, agent versions, tool snapshots  | Tool snapshot behavior is already part of the tested chain |
| [Environment Variables & Namespaces](../environment-variables.md) | configured by     | SearchAI services still depend on runtime/engine environment settings.    | `SEARCH_AI_RUNTIME_URL`, `SEARCH_AI_ENGINE_URL` | Operationally coupled but not the primary behavior here    |

---

## 6. Design Considerations (Optional)

- The feature is intentionally low-friction: KB creation should be enough to make retrieval available to agents.
- Studio exposes the generated tool through normal tools APIs and UI surfaces rather than a dedicated SearchAI-only tool registry.
- Runtime defers discovery and richer description generation until first execution so initial registration stays lightweight.

---

## 7. Technical Considerations (Optional)

- The SearchAI engine owns KB CRUD side effects, including index creation, pipeline seeding, and tool registration.
- Runtime execution is split from design-time KB CRUD, with `SearchAIKBToolExecutor` discovering index metadata on first use and caching it for five minutes.
- Agent compilation and versioning are critical coupling points because they snapshot the generated tool and its binding metadata.

---

## 8. How to Consume

### Studio UI

The user flow spans three Studio surfaces:

- **SearchAI knowledge base UI** via components such as `KnowledgeBaseDashboardPage`, `CreateKnowledgeBaseDialog`, and `KnowledgeBaseDetailPage`
- **Tools UI** where the generated tool appears in the project tools list and detail views
- **Agent editor/tool picker** where the generated SearchAI tool can be bound into agent DSL

Studio fetches KB data through `useKnowledgeBases()` / `useKnowledgeBase()` and proxies SearchAI engine requests through its `/api/search-ai/*` routes.

### API (Runtime)

| Method | Path                                 | Purpose                                                    |
| ------ | ------------------------------------ | ---------------------------------------------------------- |
| GET    | `/api/knowledge-bases`               | List KBs for a tenant/project                              |
| POST   | `/api/knowledge-bases`               | Create KB, linked index, default pipeline, and tool        |
| GET    | `/api/knowledge-bases/:kbId`         | Fetch KB plus linked index metadata                        |
| PATCH  | `/api/knowledge-bases/:kbId`         | Rename/update KB and re-register tool                      |
| DELETE | `/api/knowledge-bases/:kbId`         | Delete KB and unregister generated tool                    |
| POST   | `/api/knowledge-bases/:kbId/rebuild` | Trigger KB rebuild on the SearchAI side                    |
| POST   | `/api/projects/:projectId/chat`      | Execute an agent that may call the generated SearchAI tool |

### API (Studio)

| Method | Path                                          | Purpose                                     |
| ------ | --------------------------------------------- | ------------------------------------------- |
| GET    | `/api/search-ai/knowledge-bases`              | Proxy KB list to SearchAI engine            |
| POST   | `/api/search-ai/knowledge-bases`              | Proxy KB create to SearchAI engine          |
| GET    | `/api/search-ai/knowledge-bases/:id`          | Proxy KB detail                             |
| PATCH  | `/api/search-ai/knowledge-bases/:id`          | Proxy KB update                             |
| DELETE | `/api/search-ai/knowledge-bases/:id`          | Proxy KB delete                             |
| POST   | `/api/search-ai/knowledge-bases/:id/rebuild`  | Proxy KB rebuild                            |
| GET    | `/api/projects/:id/tools`                     | Returns the auto-generated SearchAI tool    |
| GET    | `/api/projects/:id/tools/:toolId`             | Returns SearchAI tool detail                |
| POST   | `/api/projects/:id/agents/:agentName/compile` | Compiles agents that bind the SearchAI tool |

### Admin Portal

There is no dedicated Admin Portal surface for this feature. KB management is project-scoped through SearchAI and Studio.

### Channel Integration

Once the SearchAI tool is present in an agent's IR, it is channel-agnostic. Web, SDK, A2A, and voice executions can all trigger the same SearchAI query path through standard tool invocation.

---

## 9. Data Model

### Collections / Tables

```text
Collection: knowledge_bases
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - name: string
  - description: string | null
  - searchIndexId: string | null
  - canonicalSchemaId: string | null
  - connectorCount: number
  - status: string
  - documentCount: number
  - lastIndexedAt: Date | null
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } unique
  - { tenantId: 1, projectId: 1 }
  - { status: 1 }
Plugins:
  - tenantIsolationPlugin
```

```text
Collection: search_indexes
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - slug: string
  - name: string
  - embeddingModel: string
  - embeddingDimensions: number
  - vectorStore: { provider, collectionName, connectionConfig? }
  - searchDefaults: { topK, similarityThreshold, includeMetadata, includeContent, reranker? }
  - llmConfig: object | null
  - queryLLMConfig: object | null
  - status: string
Indexes:
  - { tenantId: 1, projectId: 1, slug: 1 } unique
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, status: 1 }
```

```text
Collection: project_tools
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - name: string
  - toolType: 'searchai'
  - description: string | null
  - dslContent: string
  - sourceHash: string
  - variableNamespaceIds: string[]
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } unique
  - { tenantId: 1, projectId: 1, toolType: 1 }
```

```text
Collection: search_pipeline_definitions
Purpose:
  - Default pipeline is seeded during KB creation so the new index can be processed without extra manual setup
```

### Key Relationships

- `knowledge_bases.searchIndexId` -> `search_indexes._id`
- SearchAI auto-registration derives a tool name from the SearchIndex slug and stores the resulting DSL in `project_tools`
- Agent compilation snapshots the generated tool into version metadata and emits `searchai_binding` in IR

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                               | Purpose                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/search-ai/src/routes/knowledge-bases.ts`                     | KB CRUD plus linked-index, tool-registration, and pipeline seeding |
| `apps/search-ai/src/services/searchai-tool-registration.ts`        | Builds SearchAI tool DSL and upserts/deletes `project_tools`       |
| `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts` | Runtime executor for KB-backed SearchAI tools                      |
| `apps/runtime/src/services/execution/llm-wiring.ts`                | Wires SearchAI executors into agent sessions                       |

### Routes / Handlers

| File                                                                      | Purpose                              |
| ------------------------------------------------------------------------- | ------------------------------------ |
| `apps/studio/src/app/api/search-ai/knowledge-bases/route.ts`              | Studio KB proxy list/create          |
| `apps/studio/src/app/api/search-ai/knowledge-bases/[id]/route.ts`         | Studio KB proxy detail/update/delete |
| `apps/studio/src/app/api/search-ai/knowledge-bases/[id]/rebuild/route.ts` | Studio KB rebuild proxy              |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts`                    | Lists auto-generated SearchAI tools  |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`           | Returns generated tool detail        |

### UI Components

| File                                                                  | Purpose                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/components/search-ai/KnowledgeBaseDashboardPage.tsx` | KB listing/dashboard surface                            |
| `apps/studio/src/components/search-ai/CreateKnowledgeBaseDialog.tsx`  | KB creation dialog                                      |
| `apps/studio/src/components/search-ai/KnowledgeBaseDetailPage.tsx`    | KB detail surface                                       |
| `apps/studio/src/components/search-ai/KBOverviewTab.tsx`              | KB overview including agent/tool context                |
| `apps/studio/src/hooks/useKnowledgeBases.ts`                          | KB list hook backed by `/api/search-ai/knowledge-bases` |
| `apps/studio/src/hooks/useKnowledgeBase.ts`                           | KB detail hook                                          |

### Tests

| File                                                                      | Type        | Count                                        |
| ------------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| `apps/runtime/src/__tests__/searchai-kb-agent-e2e.test.ts`                | e2e         | end-to-end KB -> tool -> agent compile chain |
| `apps/runtime/src/__tests__/e2e/searchai/06-kb-tool-executor.e2e.test.ts` | e2e         | executor-level SearchAI KB calls             |
| `apps/search-ai/src/__tests__/search-ai-e2e.test.ts`                      | e2e         | KB CRUD, rebuild, and linked-index behavior  |
| `apps/studio/src/__tests__/api-misc.test.ts`                              | integration | Studio proxy coverage used in test flow      |

---

## 11. Configuration

### Environment Variables

| Variable                    | Default                 | Description                                     |
| --------------------------- | ----------------------- | ----------------------------------------------- |
| `SEARCH_AI_RUNTIME_URL`     | `http://localhost:3004` | SearchAI runtime endpoint used during execution |
| `SEARCH_AI_ENGINE_URL`      | `http://localhost:3005` | SearchAI engine endpoint used for KB CRUD       |
| `SEARCHAI_CONTENT_URI`      | —                       | Content-store database connection for SearchAI  |
| `SEARCHAI_CONTENT_DATABASE` | —                       | Content-store database name for SearchAI        |

### Runtime Configuration

- New KBs default to `embeddingModel: text-embedding-3-small` and `embeddingDimensions: 1536`
- New SearchIndex records default to `vectorStore.provider = qdrant`
- Search defaults are seeded as `topK: 10`, `similarityThreshold: 0.7`, `includeMetadata: true`, `includeContent: true`
- `SearchAIKBToolExecutor` caches discovery manifests for 5 minutes per `indexId`

### DSL / Agent IR / Schema

Auto-generated SearchAI tool DSL looks like:

```text
search_kb_<slug>(query: string, queryType?: string, filters?: object[], rerank?: boolean, skipPreprocessing?: boolean, skipVocabularyResolution?: boolean) -> {results: object[], totalCount: number, queryType: string}
  type: searchai
  index_id: "<searchIndexId>"
  tenant_id: "<tenantId>"
  kb_name: "<knowledgeBaseName>"
```

During compilation, that DSL becomes a tool definition with `tool_type: "searchai"` and a populated `searchai_binding`.

---

## 12. Runtime Integration

### Lifecycle

1. `POST /api/knowledge-bases` creates the KB, auto-creates the linked SearchIndex, seeds the default pipeline, and calls `registerSearchAITool()`.
2. The generated tool is stored in `project_tools` with `toolType: "searchai"` and a DSL payload that captures `index_id`, `tenant_id`, and `kb_name`.
3. Studio and Runtime load that tool like any other project tool; agent compilation emits `searchai_binding` in the agent IR.
4. `llm-wiring` detects SearchAI bindings and registers them with `SearchAIKBToolExecutor`.
5. On first tool execution, the executor discovers the index manifest, updates the effective tool description, optionally enriches the query from conversation context, and calls the SearchAI SDK's unified search endpoint.

### Dependencies

- SearchAI engine service for KB CRUD and registration side effects
- SearchAI runtime service for query execution
- `ProjectTool` storage for generated tool definitions
- SearchAI SDK used by Runtime executors
- Versioning/compile pipeline so tool snapshots land in agent versions

### Event Flow

- KB creation logs SearchIndex creation, tool registration, and pipeline seeding
- KB update can trigger tool re-registration so the generated description stays aligned
- Tool executions emit standard tool-call traces through the shared tool invocation pipeline
- Discovery failures are non-fatal: Runtime falls back to a generic KB tool description

---

## 13. Admin Integration

There is no separate admin-specific API. KBs are project resources managed through SearchAI and Studio.

---

## 14. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Project isolation | KBs, search indexes, and generated tools must remain scoped to the owning `projectId`.                    |
| Tenant isolation  | SearchAI KB creation and runtime execution must not leak tools or bindings across tenants.                |
| User isolation    | User access still flows through RBAC and project-level tool visibility rather than direct user ownership. |

### Security & Compliance

KBs, indexes, and generated tools are tenant- and project-scoped. Runtime forwards auth tokens to SearchAI execution paths and uses the standard tool-invocation safety model for tracing and error handling.

### Performance & Scalability

KB creation performs multiple writes (KB, SearchIndex, default pipeline, tool upsert) but keeps non-critical work such as tool registration and pipeline seeding resilient to partial failure. Query execution is cached at the discovery layer to avoid rediscovering index metadata on every call.

The feature scales by separating design-time SearchAI engine concerns from execution-time SearchAI runtime concerns. Tool generation remains lightweight because it stores DSL metadata, not indexed content.

### Reliability & Failure Modes

- Tool registration and pipeline seeding are coupled to KB lifecycle and should be treated as side-effect steps that need reconciliation if partial failure occurs.
- Discovery failures are non-fatal: Runtime falls back to a generic KB tool description.
- Rename/delete flows still need broader regression coverage for re-registration and cleanup.

### Observability

Registration failures, executor discovery failures, and tool calls are logged. Downstream execution inherits Tool Invocation tracing once the SearchAI tool is called by an agent.

### Data Lifecycle

- KBs own linked `search_indexes` and default pipeline state.
- Generated `project_tools` entries should stay in sync with KB lifecycle events.
- Version snapshots preserve SearchAI bindings even after later project changes.

---

## 15. Delivery Plan / Work Breakdown

1. Harden lifecycle synchronization
   1.1 Add explicit verification for KB rename re-registration and KB delete cleanup.
   1.2 Reconcile partial-failure handling across KB, index, pipeline, and tool side effects.
2. Improve runtime proof
   2.1 Add live execution coverage against indexed KB content.
   2.2 Add cross-tenant and cross-project isolation coverage for the full KB→tool chain.
3. Strengthen agent-tool experience
   3.1 Verify stale-signature and compile-warning behavior for generated SearchAI tools.
   3.2 Add browser-level coverage for tool visibility and KB overview affordances.

---

## 16. Success Metrics

| Metric                              | Baseline                                           | Target                                                  | How Measured                               |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| KB auto-registration success        | Documented as working in current E2E flow          | New KBs consistently create matching `searchai` tools   | KB create + tool lookup verification       |
| Compile success with generated tool | Current audited path passes with 0 errors/warnings | Valid generated SearchAI tools compile cleanly          | Compile responses and version snapshots    |
| Runtime discovery efficiency        | Discovery cache exists                             | Low repeated discovery overhead per `indexId`           | Executor cache behavior and runtime traces |
| Cleanup correctness                 | Not yet fully automated                            | No orphaned generated tool after KB delete/update flows | Rename/delete regression coverage          |

---

## 17. Open Questions

1. Should KB rename/delete flows get stronger reconciliation guarantees if tool re-registration partially fails?
2. Should tenant role definitions be auto-seeded so SearchAI tool visibility does not depend on manual RBAC setup?
3. What is the desired coverage boundary for live indexed-data execution in automated environments?

---

## 18. Gaps, Known Issues & Limitations

| ID      | Description                                                                            | Severity | Status |
| ------- | -------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | New tenants may need `RoleDefinition` records seeded before tool APIs work cleanly     | Medium   | Open   |
| GAP-002 | Cross-tenant isolation for the full KB -> tool chain is documented but not live-tested | High     | Open   |
| GAP-003 | Browser-level UI coverage and live indexed-data execution are still limited            | Medium   | Open   |

---

## 19. Testing

### Coverage Checklist Summary

#### Integration

- [x] KB creation auto-registers a searchai tool with the expected DSL and metadata.
- [x] Studio tools APIs expose the generated tool correctly.
- [x] Agent compile and version creation capture tool snapshots and searchai_binding metadata.

#### E2E

- [x] The KB -> tool -> compile -> version chain is live-verified.
- [x] Role/RBAC prerequisites for tool visibility are documented and validated.
- [ ] Live agent execution against indexed KB content is not yet automated.

### E2E Test Scenarios

| #   | Scenario                                         | Status     | Test File                                                  |
| --- | ------------------------------------------------ | ---------- | ---------------------------------------------------------- |
| 1   | KB create auto-registers `searchai` tool         | PASS       | `apps/runtime/src/__tests__/searchai-kb-agent-e2e.test.ts` |
| 2   | Studio tools API returns generated SearchAI tool | PASS       | `apps/runtime/src/__tests__/searchai-kb-agent-e2e.test.ts` |
| 3   | Agent compile emits `searchai_binding`           | PASS       | `apps/runtime/src/__tests__/searchai-kb-agent-e2e.test.ts` |
| 4   | KB rename/delete re-registration and cleanup     | NOT TESTED | `docs/testing/sub-features/searchai-agent-integration.md`  |
| 5   | Live agent execution against indexed KB content  | NOT TESTED | `docs/testing/sub-features/searchai-agent-integration.md`  |

### Integration Test Scenarios

| #   | Scenario                                    | Status | Test File                                                                 |
| --- | ------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| 1   | SearchAI KB CRUD with linked index behavior | PASS   | `apps/search-ai/src/__tests__/search-ai-e2e.test.ts`                      |
| 2   | KB tool executor against SearchAI runtime   | PASS   | `apps/runtime/src/__tests__/e2e/searchai/06-kb-tool-executor.e2e.test.ts` |
| 3   | Studio proxy path used by KB flows          | PASS   | `apps/studio/src/__tests__/api-misc.test.ts`                              |

### Unit Test Coverage

| Package          | Tests                                                              | Passing            |
| ---------------- | ------------------------------------------------------------------ | ------------------ |
| `apps/search-ai` | `search-ai-e2e.test.ts` and related route coverage                 | Core flows passing |
| `apps/runtime`   | `searchai-kb-agent-e2e.test.ts`, `06-kb-tool-executor.e2e.test.ts` | Core flows passing |

> Full testing details: [docs/testing/sub-features/searchai-agent-integration.md](../../testing/sub-features/searchai-agent-integration.md)

---

## 20. References

- Testing docs: [docs/testing/sub-features/searchai-agent-integration.md](../../testing/sub-features/searchai-agent-integration.md)
- Related features: [Tool Invocations](../tool-invocations.md), [Deployments & Versioning](../deployments-versioning.md), [Environment Variables & Namespaces](../environment-variables.md)
- SearchAI route: `apps/search-ai/src/routes/knowledge-bases.ts`
- Runtime executor: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
