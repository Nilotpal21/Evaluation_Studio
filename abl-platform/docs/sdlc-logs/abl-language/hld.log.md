# SDLC Log: ABL Language -- HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: High-Level Design
**Feature**: ABL Language
**Slug**: abl-language

---

## Decision Log

| #   | Question                                        | Classification | Answer                                                                                                                                                        |
| --- | ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should the parser be rewritten with a grammar?  | DECIDED        | No. The regex-based parser works correctly (6,701 LOC, 25+ test files). Rewrite risk outweighs benefit. Logged as Alternative B with XL effort estimate.      |
| 2   | Should uppercase DSL be deprecated?             | DECIDED        | No. Both formats are active domain conventions per CLAUDE.md. Uppercase is not legacy.                                                                        |
| 3   | What is the preferred architecture pattern?     | ANSWERED       | Pure function library pattern. Compiler/parser/language-service are stateless libraries, not services. No database access, no network dependencies.           |
| 4   | How does tenant isolation work for compilation? | ANSWERED       | Compiler is tenant-agnostic (pure function). Isolation enforced at route level (Studio/Runtime routes scope by tenantId/projectId). Cross-tenant returns 404. |
| 5   | What is the biggest technical risk?             | DECIDED        | External dependency on `@marcbachmann/cel-js` with BigInt quirks. Mitigated by normalization wrapper in `cel-evaluator.ts`.                                   |
| 6   | Is migration needed?                            | ANSWERED       | No. This is an existing stable feature. IR schema versioning (`ir_version`) handles forward compatibility. No database migrations.                            |

## Alternatives Evaluated

| Alternative             | Description                                 | Verdict         | Rationale                                                                            |
| ----------------------- | ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| A: YAML-only            | Drop uppercase DSL                          | Rejected        | Breaking change for existing users. Uppercase is a domain convention, not legacy.    |
| B: Grammar-based parser | Replace regex scanner with Chevrotain/ANTLR | Rejected        | High rewrite risk for no functional gain. Current parser is correct and well-tested. |
| C: Current architecture | Maintain dual-parser with shared AST        | **Recommended** | Production-stable, well-tested, minimal risk.                                        |

## Files Created

- `docs/specs/abl-language.hld.md` -- HLD addressing all 12 architectural concerns
- `docs/sdlc-logs/abl-language/hld.log.md` -- This log file

## Review Summary

### Round 1 -- Full Audit

- [x] All 12 architectural concerns addressed
- [x] 3 alternatives with trade-offs evaluated
- [x] Architecture diagrams present (system context, component, sequence)
- [x] Data model complete (existing collections, in-memory structures)
- [x] API design complete (7 existing endpoints documented)
- [x] Open questions listed (5 items)

### Round 2 -- Deep Dive

- [x] Data model reviewed for correctness -- matches codebase evidence
- [x] Error model covers real failure scenarios (parse, compile, validation, timeout)
- [x] Performance budget specified (P95 < 5s for single agent)
- [x] Idempotency confirmed (pure functional, deterministic hashing)

### Round 3 -- Cross-Phase Consistency

- [x] HLD implements all 15 FRs from feature spec
- [x] Test strategy aligns with test spec scenarios (7 E2E + 7 integration)
- [x] No contradictions between feature spec and HLD
- [x] Dependency risk assessment matches known gaps (GAP-006 for CEL)
