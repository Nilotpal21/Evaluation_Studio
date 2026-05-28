# SDLC Log: MCP Support -- HLD

**Phase**: HLD (Phase 3)
**Date**: 2026-03-22
**Status**: COMPLETE

---

## What Was Done

Generated the MCP Support HLD (`docs/specs/mcp-support.hld.md`) as a new document covering all 12 architectural concerns. The HLD is code-grounded against the existing implementation across 5 packages.

### Sections Produced

1. **Problem Statement**: Defined the need for first-class MCP support with two execution paths.
2. **Alternatives Considered**: Evaluated 3 alternatives -- HTTP-only mapping, external gateway service, and current embedded architecture. Recommended current architecture.
3. **Architecture Overview**: System context diagram showing Studio, Runtime, Compiler, Shared, and Database interactions with remote MCP servers. Package responsibility matrix.
4. **Data Model**: Full `mcp_server_configs` schema with field descriptions, indexes, plugins, and relationship to `project_tools`. IR schema for `McpBindingIR`.
5. **Component Design**: 9 detailed component specifications covering MCP Client, Server Manager, Tool Executor, Runtime Provider, Inline Provider, Registry Service, Auth Resolver, Discovery Service, and Tool Binding Wiring.
6. **12 Architectural Concerns**: Resource isolation, auth, encryption, performance, scalability, observability, error handling, security, compliance, distributed systems, testing, and maintainability.
7. **API Design**: Studio API table (10 endpoints) and internal interfaces (`McpClientProvider`, `McpClient`).
8. **Sequence Diagrams**: Discovery/import flow and runtime tool execution flow with all components.
9. **Security Design**: Threat model with 12 threats and mitigations. Auth flow for MCP server connections.
10. **Migration & Rollout**: Current state assessment, path to STABLE, and backward compatibility notes.
11. **Open Architectural Questions**: 5 forward-looking questions about connection pooling, resource/prompt promotion, bidirectional MCP, event-driven refresh, and stdio in Studio.
12. **Decision Log**: 8 architectural decisions with rationale and dates.

## Source Files Examined

All files from the feature spec phase, plus:

- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- Tool routing with MCP executor
- `apps/runtime/src/services/execution/llm-wiring.ts` -- wireToolExecutor with inline/DB-backed composite
- `packages/compiler/src/platform/ir/compiler.ts` -- compileMcpBinding and inferToolHints for MCP
- `packages/shared/src/types/mcp-auth.ts` -- McpAuthConfig type definitions

## Key Architectural Observations

1. The dual execution path (DB-backed + inline) is a deliberate architectural choice that serves different deployment models (Studio-managed vs CI/compiled).
2. Circuit breaker keys include tenantId to prevent cross-tenant interference -- a critical isolation property.
3. The MCPServerManager uses a singleton pattern per process, not per request, which means MCP connections are per-pod. This is acceptable at current scale but may need a gateway at higher scale.
4. The inline provider's ephemeral connect/execute/disconnect pattern is safe for long-lived sessions but adds latency per call. This is a deliberate tradeoff for avoiding persistent connection state.
5. The discovery service's use of temporary scoped managers (`studio:<uuid>`) prevents Studio operations from corrupting runtime connection state.

## Decisions

- DECIDED: Current embedded architecture is recommended over HTTP-only mapping (loses MCP semantics) and external gateway (adds operational overhead without clear scaling need).
- DECIDED: HLD documents the existing implementation as-is rather than proposing changes, since the architecture is sound and the feature is in BETA with comprehensive coverage.
- DECIDED: Open questions are forward-looking and do not block STABLE promotion.
