# SDLC Log: Identity Verification BETA — LLD Phase

**Feature**: identity-verification
**Phase**: LLD (BETA)
**Date**: 2026-03-24
**Artifact**: `docs/plans/2026-03-24-identity-verification-beta-impl-plan.md`
**Status**: APPROVED

---

## Oracle Decisions

All 14 clarifying questions answered autonomously by product-oracle. No AMBIGUOUS items — all ANSWERED/INFERRED/DECIDED.

## Audit Rounds

| Round | Focus                   | Auditor       | Verdict        | Critical | High | Medium | Low |
| ----- | ----------------------- | ------------- | -------------- | -------- | ---- | ------ | --- |
| 1     | Architecture compliance | lld-reviewer  | NEEDS_CHANGES  | 2        | 4    | 4      | 2   |
| 2     | Pattern consistency     | lld-reviewer  | NEEDS_REVISION | 0        | 3    | 3      | 1   |
| 3     | Completeness            | lld-reviewer  | PASS           | 0        | 0    | 2      | 2   |
| 4     | Cross-phase consistency | phase-auditor | NEEDS_REVISION | 1        | 3    | 3      | 0   |
| 5     | Final sweep             | lld-reviewer  | APPROVED       | 0        | 0    | 1      | 2   |

### Key Findings Resolved

**Round 1 (CRITICAL)**:

- CRITICAL-1: EmailDeliveryAdapter hexagonal concern — clarified DI injection with local EmailSender interface
- CRITICAL-2: Missing second tool compilation path — added `compileToolDefinitionAST` in `compile-behavior-profile.ts`

**Round 1 (HIGH)**:

- HIGH-1/2: Code stripping security — specified security-first behavior (always strip when delivery configured, delivery failure returns status)
- HIGH-3: Type narrowing — changed `number` to `0 | 1 | 2` for identity tier fields
- HIGH-4: OAuth adapters missing logging — added `createLogger('oauth-adapters')`

**Round 2 (HIGH)**:

- File-Level Change Map had inconsistent types (still `number`)
- Logger import path inside compiler package must use relative `../../logger.js` not `@abl/compiler/platform`
- Middleware insertion is unconditional (independent of audit middleware success)

**Round 4 (CRITICAL)**:

- GAP-006/GAP-007 are Non-Goals in feature spec — added Scope Overrides section with justification
- API contract change for Phase 3 undocumented — added API Contract Change section
- HLD and test spec don't cover new BETA scope — added acceptance criteria requiring doc updates

### Deferred Findings

- MEDIUM: `compileToolDefinitionAST` maps a subset of fields vs `compileTools` — pre-existing tech debt, not blocking
- LOW: Open questions 1 and 3 were already decided — converted to Resolved Questions

## Design Decisions Summary

| #   | Decision                                                              | Rationale                                              |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| D-1 | Implementation order: GAP-016 → GAP-015 → GAP-007 → GAP-006           | Simple first, cross-package last                       |
| D-2 | Arctic v3 adapter classes for OAuth                                   | OAuthProviderAdapter port exists, Arctic handles PKCE  |
| D-3 | Delivery OUTSIDE verifier, in route handler                           | Preserves verifier SRP                                 |
| D-4 | VerificationDeliveryService via DI with local EmailSender interface   | Hexagonal architecture boundary                        |
| D-5 | identity_tier_required as top-level field on AgentTool/ToolDefinition | Follows confirmation/pii_access precedent              |
| D-6 | identityTierGateMiddleware in tool middleware chain                   | ToolCallerContext.identityTier already exists          |
| D-7 | Separate IDENTITY*OAUTH*\* env vars                                   | Different redirect URIs/scopes from channel/tool OAuth |
| D-8 | No feature flags; opt-in when field present                           | Same pattern as confirmation field                     |

## Learnings

- **Two tool compilation paths**: `compileTools()` (agent tools) and `compileToolDefinitionAST()` (behavior profile tools) must both be updated when adding new fields to ToolDefinition. This is a recurring pattern to watch for.
- **Compiler logger import**: Files inside `packages/compiler/src/platform/constructs/executors/` use relative `../../logger.js`, NOT the `@abl/compiler/platform` path used by consumers.
- **Middleware chain position matters**: Identity tier gate must be after audit (for logging) but before secret scrubber (for early termination). Insertion is unconditional regardless of audit middleware success.
- **Scope overrides need documentation**: When pulling Non-Goals into scope, the LLD must explicitly document the override with justification, not just add tasks silently.
