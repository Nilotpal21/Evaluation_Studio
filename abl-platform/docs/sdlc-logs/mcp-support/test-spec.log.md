# SDLC Log: MCP Support -- Test Spec

**Phase**: Test Spec (Phase 2)
**Date**: 2026-03-22
**Status**: COMPLETE

---

## What Was Done

Re-generated the MCP Support test spec (`docs/testing/mcp-support.md`) with expanded coverage across all four layers (compiler, shared, runtime, studio). The existing test spec from 2026-03-19 was expanded with:

1. **Quick Health Dashboard**: Added compiler-level entries (MCP client protocol/transport, MCP tool executor resilience, MCP tool result normalization) and auth-profile-backed full chain status.
2. **Audit Scope**: Expanded from 3 to 4 layers, adding the compiler layer explicitly.
3. **E2E Test Scenarios**: Defined 7 mandatory E2E scenarios (E1-E7) with priorities, covering live server round-trip, auth forwarding, SSRF rejection, delete cascade, circuit breaker, inline execution, and selective import.
4. **Integration Test Scenarios**: Defined 10 integration scenarios (I1-I10) with priorities, adding circuit breaker, connection cap, SSRF enforcement, auth-profile dual-read, and result normalization tests.
5. **Coverage Map**: Added compiler layer with 6 test files, expanded shared/runtime/studio layers with complete file lists.
6. **Gaps**: Expanded from 3 to 6 gaps, adding circuit breaker E2E (GAP-004), selective import (GAP-005), and OAuth2 negative paths (GAP-006).
7. **Recommended Next Coverage Pass**: Expanded from 3 to 7 prioritized items with specific file paths and implementation approaches.
8. **Test Infrastructure Requirements**: New section defining the live MCP fixture server requirements and database setup needs.

## Key Findings

- The codebase has 12+ test files dedicated to MCP across all four layers.
- All existing tests pass according to the test inventory audit.
- The primary gap is the absence of live MCP server E2E tests -- all current tests mock the MCP protocol boundary.
- The compiler layer (protocol, client, executor) has the strongest unit coverage.
- The auth resolver covers all 5 auth modes but only at the unit level.
- Circuit breaker behavior is unit-tested in the executor but not exercised through a realistic multi-call failure/recovery sequence.

## Decisions

- DECIDED: Live MCP fixture server is the P0 prerequisite for all E2E scenarios.
- DECIDED: E2E tests should use MongoMemoryServer for database isolation (not direct model access).
- DECIDED: Circuit breaker E2E should use configurable reset periods to avoid 30s waits in tests.
- DECIDED: Auth-profile integration is P2 because the underlying dual-read mechanism is tested independently.
