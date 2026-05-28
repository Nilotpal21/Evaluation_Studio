# SDLC Log: Environment Variables — Feature Spec

**Date:** 2026-03-22 (updated 2026-03-23)
**Phase:** Feature Spec (Phase 1)
**Artifact:** `docs/features/environment-variables.md`

## Update: 2026-03-23 — Hardening for STABLE

### Scope Change

Updated feature spec from "document existing ALPHA" to "harden for STABLE". The scope is:

- Fix all critical bugs (4 found)
- Close P1/P2 gaps (base UI, diff view, export/import)
- Achieve full E2E + integration test coverage
- **No deprecation of config variables or tool secrets** — they remain independent systems

### Oracle Decisions

| #   | Question                                               | Classification | Resolution                                                                               |
| --- | ------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------- |
| Q1  | Backward compat for {{config.KEY}} and {{secrets.KEY}} | ANSWERED       | Keep all 3 syntaxes. No deprecation. Each resolves through its own system independently. |
| Q2  | Should non-sensitive env vars skip encryption?         | DECIDED        | No. Encrypt everything at rest. `isSecret` flag controls UI masking only.                |
| Q3  | Migration strategy for config vars / tool secrets      | ANSWERED       | No migration. Systems remain independent.                                                |
| Q4  | Add rotation fields to env var model?                  | DECIDED        | Out of scope for this hardening iteration. Can be added later if needed.                 |
| Q5  | Base value UI in this iteration?                       | ANSWERED       | Yes — listed as P1 gap, required for STABLE.                                             |
| Q6  | Same persona manages config vars and env vars?         | ANSWERED       | Yes — project admin/developer. Same Studio UI, same project scope.                       |
| Q7  | Keep old API endpoints during deprecation?             | ANSWERED       | No deprecation. All existing APIs remain unchanged.                                      |
| Q8  | Merge UI for config vars and env vars?                 | ANSWERED       | No. Keep separate. Only hardening env vars.                                              |
| Q11 | Base fallback fix: EnvVarStore or SecretsProvider?     | DECIDED        | Fix in EnvVarStore (llm-wiring.ts). Two-query pattern. Provider benefits automatically.  |
| Q12 | Namespace pagination fix: $lookup or post-filter?      | DECIDED        | Use MongoDB aggregation pipeline with $lookup for pre-pagination filtering.              |
| Q13 | Namespace membership type after migration?             | ANSWERED       | No migration. `variableType: 'config'` remains for config vars, `'env'` for env vars.    |

### Critical Bugs Identified

1. **GAP-001**: Create route rejects `environment: null` — falsy check at line 120
2. **GAP-002**: Runtime EnvVarStore has no base fallback — only queries exact environment
3. **GAP-003**: Namespace pagination filters post-query — incorrect page counts
4. **GAP-004**: envVarCache cannot distinguish "not cached" from "cached undefined"

### Audit Results

**Round 1 (self-audit):**

- All 18 template sections addressed
- 7 user stories (min 3)
- 11 functional requirements (min 4)
- 7 integration matrix entries (min 2)
- 3 isolation levels addressed
- 14 test scenarios defined
- 11 gaps documented with severity
- Delivery plan has 5 parent tasks with subtasks

**Round 2 findings:** None — spec is comprehensive and code-grounded.

### Files Updated

- `docs/features/environment-variables.md` — restructured to TEMPLATE.md format, added bugs, delivery plan, success metrics

---

## Original Log: 2026-03-22

### Sources Read

1. `docs/plans/2026-03-13-environment-consistency-variable-overrides.md` — implementation plan
2. `docs/superpowers/specs/2026-03-13-environment-consistency-variable-overrides-design.md` — design spec
3. `packages/config/src/environment.ts` — canonical Environment type, VALID_ENVIRONMENTS
4. `packages/database/src/models/environment-variable.model.ts` — data model with encryption plugin
5. `packages/database/src/models/deployment-variable-snapshot.model.ts` — snapshot model
6. `apps/runtime/src/routes/environment-variables.ts` — CRUD routes
7. `apps/runtime/src/services/secrets-provider.ts` — runtime resolution chain
8. `apps/runtime/src/services/snapshot-service.ts` — snapshot with base+override dedup
9. `apps/runtime/src/services/execution/llm-wiring.ts` — EnvVarStore implementation
10. `apps/studio/src/api/environment-variables.ts` — Studio API client
11. `apps/studio/src/hooks/useEnvVars.ts` — SWR hook
12. `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` — Studio UI

### Clarifying Questions (Self-Resolved)

| #   | Question                                             | Classification | Resolution                                                                                                             |
| --- | ---------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Is base value (environment: null) fully implemented? | ANSWERED       | Model supports null, snapshot deduplicates. But create route has bug rejecting null, and runtime has no base fallback. |
| 2   | Does the secrets provider have base fallback?        | ANSWERED       | No — `getEnvVar()` queries only exact environment. Studio tool-test-service does it correctly but runtime doesn't.     |
| 3   | Are config variables in scope?                       | DECIDED        | No — config vars remain independent. No deprecation.                                                                   |
| 4   | Is dynamic environments in scope?                    | DECIDED        | No — future work (P3). Current system hardcodes three canonical environments.                                          |
| 5   | Does the Studio UI support base values?              | ANSWERED       | No — EnvironmentVariablesSection takes a single `environment: string` prop. Base value management is a P1 gap.         |

### Key Findings

1. **4 critical bugs found** — create route, base fallback, namespace pagination, cache sentinel
2. **Implementation substantially complete** — CRUD, encryption, snapshots, copy, validation, namespaces all working for non-base scenarios
3. **Base value path broken end-to-end** — can't create via API, can't resolve at runtime, no UI
4. **Studio tool-test-service is the only correct implementation** of base fallback
5. **One-active-per-env enforced** via partial unique index

### Decisions Made

- Feature remains ALPHA until bugs fixed and E2E tests pass
- No config var or tool secret deprecation
- Hardening scope: bugs + P1/P2 gaps + tests = path to STABLE
