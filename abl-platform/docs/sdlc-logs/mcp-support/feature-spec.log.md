# SDLC Log: MCP Support -- Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-03-22
**Status**: COMPLETE

---

## What Was Done

Re-generated the MCP Support feature spec (`docs/features/mcp-support.md`) with all 18 sections code-grounded against the current codebase. The existing feature spec from 2026-03-19 was a good foundation but was expanded with:

1. **Section 1 (Introduction)**: Added detailed package breakdown across 5 packages, expanded key capabilities list with circuit breaker, result normalization, proxy support, command allowlist, and blocked env vars.
2. **Section 2 (Scope)**: Added non-goals for MCP resources/prompts as first-class entities and bidirectional MCP.
3. **Section 3 (User Stories)**: Expanded from 3 to 7 user stories covering inline execution, circuit breaker, and operations personas.
4. **Section 4 (FRs)**: Expanded from 6 to 12 functional requirements adding circuit breaker, compiler IR, auth-profile dual-read, and per-tool testing.
5. **Section 5 (Classification)**: Added ABL Language as a related feature for compilation path.
6. **Section 7 (Technical)**: Added protocol support details, caching strategy specifics, resilience patterns, and connection limits.
7. **Section 8 (How to Consume)**: Added McpServerStatusBadge and McpToolWizard to UI components.
8. **Section 9 (Data Model)**: Added detailed field descriptions including encryption algorithm, auth profile reference, and priority semantics.
9. **Section 10 (Implementation Files)**: Added compiler-level files (protocol.ts, client.ts, server-manager.ts, mcp-tool-executor.ts), McpToolWizard, and additional test files.
10. **Section 11 (Configuration)**: Added encryption_master_key, circuit breaker config, MAX_MCP_RESULT_CHARS.
11. **Section 16 (Gaps)**: Added GAP-005 (resources/prompts not first-class) and GAP-006 (no structured audit logging).
12. **Section 17 (NFRs)**: Added circuit breaker key isolation, OAuth2 token cache caps, MCPAuditEvent interface.
13. **Section 18 (Testing)**: Added compiler-level test entries for executor and result cap tests.
14. **Section 19 (References)**: Added MCP specification URL and protocol version.

## Source Files Examined

- `packages/compiler/src/platform/mcp/protocol.ts` -- Full MCP protocol types
- `packages/compiler/src/platform/mcp/client.ts` -- Client with 3 transports, security controls
- `packages/compiler/src/platform/mcp/server-manager.ts` -- Server manager with tenant-scoped pools
- `packages/compiler/src/platform/mcp/index.ts` -- Module exports
- `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts` -- Executor with resilience
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- Tool routing
- `packages/compiler/src/platform/ir/schema.ts` -- McpBindingIR definition
- `packages/compiler/src/platform/ir/compiler.ts` -- compileMcpBinding function
- `packages/database/src/models/mcp-server-config.model.ts` -- Mongoose model
- `packages/shared/src/services/mcp-server-registry.ts` -- Registry service
- `packages/shared/src/services/mcp-auth-resolver.ts` -- Auth resolver with 5 modes
- `packages/shared/src/types/mcp-server.ts` -- Normalized types
- `packages/shared/src/repos/mcp-server-config-repo.ts` -- Repository helpers
- `apps/runtime/src/services/mcp/runtime-mcp-provider.ts` -- DB-backed provider
- `apps/runtime/src/services/mcp/inline-mcp-provider.ts` -- Inline provider
- `apps/runtime/src/services/execution/llm-wiring.ts` -- Tool binding wiring
- `apps/studio/src/services/mcp-discovery-service.ts` -- Discovery service
- `apps/studio/src/store/mcp-server-store.ts` -- Zustand store
- `apps/studio/src/api/mcp-servers.ts` -- API client
- `apps/studio/src/components/mcp-servers/McpServersListPage.tsx` -- List page
- `apps/studio/src/components/tools/McpConfigForm.tsx` -- Config form

## Decisions

- DECIDED: Feature spec covers the entire MCP stack (compiler through studio) rather than splitting by package, because MCP is a cross-cutting feature.
- DECIDED: Inline compiled execution is documented as a secondary path, not a separate feature, because it shares the same executor infrastructure.
- DECIDED: Status remains BETA because GAP-002 (no live E2E test) is HIGH severity.
