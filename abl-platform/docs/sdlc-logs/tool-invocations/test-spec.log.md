# SDLC Log: Tool Invocations - Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Skill**: `/test-spec`

## Clarifying Questions & Decisions

| #   | Question                                         | Classification | Answer / Rationale                                                                                                  |
| --- | ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | What is the current test coverage baseline?      | ANSWERED       | 66+ test files, 1,000+ test cases, 19-scenario API E2E suite. Source: existing test spec                            |
| 2   | Which FRs are highest risk?                      | DECIDED        | FR-9 (SSRF), FR-3 (secret resolution), FR-4 (confirmation) -- security-critical, failure = data exposure            |
| 3   | What external dependencies need mocking vs real? | INFERRED       | LLM, OAuth providers, sandbox backends mocked. MongoDB real (in-memory). MCP in-suite. Runtime real.                |
| 4   | What data seeding strategy is used?              | ANSWERED       | All seeding via public APIs only. No direct Mongoose model imports. Source: existing E2E suite                      |
| 5   | What auth/permission combos need E2E?            | DECIDED        | Tenant isolation (404), project isolation (404), auth profile resolution, OAuth consent. RBAC covered at unit level |
| 6   | Should resilience controls have E2E coverage?    | DECIDED        | Kept as open question -- unit-level coverage is comprehensive, E2E would require Redis infrastructure               |
| 7   | Are there cross-feature interaction scenarios?   | ANSWERED       | Guardrails (pre/post tool), attachments (preprocessing), A2A (inbound execution). All have E2E coverage.            |
| 8   | What test infrastructure is available?           | ANSWERED       | MongoMemoryServer, mock HTTP/sandbox/LLM services, in-suite MCP server, real runtime process                        |

## Files Created / Modified

| File                                               | Action    | Notes                                 |
| -------------------------------------------------- | --------- | ------------------------------------- |
| `docs/testing/tool-invocations.md`                 | Rewritten | Full spec with 13 E2E + 8 integration |
| `docs/sdlc-logs/tool-invocations/test-spec.log.md` | Created   | This file                             |

## Review Summary

### Round 1 - Coverage & Completeness

- 13 E2E test scenarios (exceeds minimum 5)
- 8 integration test scenarios (exceeds minimum 5)
- Every FR from feature spec appears in coverage matrix
- E2E scenarios specify auth context
- E2E scenarios do NOT reference mocks or direct DB access
- Integration scenarios specify service boundaries
- Security & isolation section filled with checkboxes
- Test file catalog maintained from existing inventory

### Round 2 - Alignment

- E2E scenarios cover highest-risk FRs (SSRF, secrets, confirmation, auth)
- E2E scenarios match user stories from feature spec
- Integration boundaries match data flow from feature spec
- Test infrastructure section matches existing E2E suite setup
