# SDLC Log: Tenant LLM Policy -- Test Spec

**Date**: 2026-03-22
**Phase**: 2 (Test Spec)
**Status**: Complete

## Clarifying Questions & Decisions

| Question                                   | Classification | Resolution                                                                       |
| ------------------------------------------ | -------------- | -------------------------------------------------------------------------------- |
| Which FRs are highest risk?                | DECIDED        | FR-2, FR-3, FR-9 (route CRUD and tenant verification) -- zero test coverage      |
| What test infrastructure exists?           | ANSWERED       | vitest, MongoMemoryServer used in some test files (search-ai integration tests)  |
| What auth test helpers exist?              | INFERRED       | Other route tests likely use JWT helpers; need to verify at implementation time  |
| Should E2E use full server or minimal app? | DECIDED        | Full middleware chain preferred for realism; defer exact setup to implementation |

## Files Created

- `docs/testing/tenant-llm-policy.md` -- test spec with coverage matrix, 8 E2E scenarios, 6 integration scenarios, 8 unit scenarios

## Scenario Counts

- E2E scenarios: 8 (exceeds minimum 5)
- Integration scenarios: 6 (exceeds minimum 5)
- Unit scenarios: 8
- Security/isolation scenarios: 7 checklist items

## Review Findings

### Round 1 -- Coverage

- All 10 FRs appear in coverage matrix
- E2E scenarios specify auth context
- No mocks or direct DB access in E2E scenarios
- Integration scenarios specify service boundaries
- Security section filled with scenario references

### Round 2 -- Alignment

- E2E scenarios map to user stories (E2E-1/2 -> US-4, E2E-5 -> US-1)
- Integration boundaries match data flow from feature spec
- Highest-risk FRs (FR-2, FR-3, FR-9) have dedicated E2E coverage

No CRITICAL or HIGH findings.
