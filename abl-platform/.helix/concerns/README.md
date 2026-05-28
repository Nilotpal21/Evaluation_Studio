# Cross-Cutting Concerns Registry

This directory declares the cross-cutting concerns that Helix checks against
during audit and implementation. Each concern is a single YAML file.

The framework (in `packages/helix`) is repo-independent; the concerns here are
this repo's specificity. Moving Helix to another repo means dropping in a new
`.helix/concerns/` directory.

## Canonical Rubric

Concerns in this directory align to the 16-concern
[Change Review Rubric](../../docs/sdlc/change-review-rubric.md). Each concern
YAML declares a `rubric_concern: N` field (1–16) so registry findings, audit
reports, and model-review detectors can be reconciled with the rubric's
narrative language at review time.

The rubric is the human-facing source; the YAMLs here are the
machine-executable layer. When they disagree, update both together.

## Tiers

| Tier     | Directory   | Enforcement                         | Detector bias                                            |
| -------- | ----------- | ----------------------------------- | -------------------------------------------------------- |
| Enforced | `enforced/` | Can block commits / pipeline stages | Deterministic (grep, ast, symbol-ref, route, schema)     |
| Advisory | `advisory/` | Never blocks; produces triage cards | `model-review` allowed but must emit structured findings |

Advisory concerns do not gate merges. Their findings become triage cards
(`option_A / option_B / option_C`) that you decide on explicitly. Advisory
oracle prose is never auto-promoted to canonical findings.

## Schema

```yaml
id: tenant-isolation # kebab-case, unique, matches filename
title: Tenant Isolation # human-readable
enforcement: blocking | advisory
severity_default: critical | high | medium | low
rubric_concern: 1 # 1–16, mirrors docs/sdlc/change-review-rubric.md

# Optional rubric sections — mirror the rubric doc so reviewers and
# model-review detectors share the same language. All four are optional.
protects:
  - tenant, project, user isolation
  - non-leaky access behavior
review_when:
  - routes, middleware, auth helpers, or persistence filters change
review_questions:
  - Does every read and write carry the correct tenant and project scope?
  - Does cross-scope access fail closed with a non-leaky status?
proof_expected:
  - scoped query filters in route/service/repository
  - allow-path and deny-path tests

scope:
  globs: # files this concern applies to
    - apps/**/src/**/*.ts
    - packages/**/src/**/*.ts
  exclude: # optional
    - '**/__tests__/**'
    - '**/*.test.ts'

references: # optional, for human context
  docs:
    - CLAUDE.md#core-invariants
  tests:
    - apps/runtime/src/__tests__/*-authz.test.ts
  related_concerns:
    - project-isolation
    - user-session

detectors:
  - id: no-findById # unique within concern
    kind: grep | ast | symbol-ref | route | schema | impacted-test | script | model-review
    severity: critical # optional, overrides severity_default
    message: |
      findById skips tenant scope. Use findOne({_id, tenantId}) so
      cross-tenant access returns 404 rather than leaking existence.
    fix_hint: |
      Replace findById(id) with findOne({_id: id, tenantId: req.user.tenantId}).
    # --- kind-specific fields below ---
    pattern: '\\.findById\\(' # grep
    # multiline: false          # grep
    # query: '...'               # ast (tree-sitter query)
    # symbol: 'findOne'          # symbol-ref
    # assertion: 'called-with-tenantId-in-filter'
    # route_pattern: '/api/projects/:projectId/*'  # route
    # schema_name: 'SessionModel'  # schema
    # script: 'tools/check-x.sh'   # script
    # guidance_ref: '../prompts/isolation-review.md'  # model-review

stage_hooks: # optional — which pipeline stages consult this
  - stage: implementation
    inject_checklist: true # adds a compact rule list to the prompt
  - stage: security-audit
    as_review_lens: true # oracle gets this as a lens
  - stage: oracle-analysis
    as_review_lens: true

acceptance: # optional — cross-file invariants
  - when: 'new route handler in apps/runtime/src/routes/'
    requires: 'matching *-authz.test.ts file must exist'
```

## Authoring rules

1. **Prefer deterministic detectors.** grep, ast, symbol-ref, route, schema,
   impacted-test, script. Reach for `model-review` only when the rule truly
   cannot be expressed otherwise.
2. **`model-review` must emit structured findings.** A `model-review` detector
   must declare a JSON output schema matching the canonical finding shape —
   never freeform prose.
3. **Every detector needs a `message` and a `fix_hint`.** No silent fails.
4. **Severity semantics:**
   - `critical` — security/isolation/data-loss risk; blocks
   - `high` — architectural violation that will cause future drift; blocks in enforced tier
   - `medium` — style/consistency; warn
   - `low` — nice-to-have; advisory only
5. **Scope globs matter.** Over-broad globs make every concern match every file
   and drown findings. Narrow globs to the surfaces where the rule actually applies.
6. **Reference real evidence.** `references.tests` should point at existing tests
   that demonstrate the rule; makes the concern self-teaching.

## Current seed set (2026-04-18)

Seed of 26 concerns mapped to the 16-concern review rubric. Detectors are
placeholders where precise deterministic rules still need refinement.

**Enforced (16):** tenant-isolation, project-isolation, user-session,
session-identity, customer-contact, message-metadata, session-context,
encryption, audit-log, agent-transfer, retention, cross-pod, security,
memory-discipline, design-system, test-integrity.

**Advisory (12):** scale, localization, clean-contracts, studio-wiring,
studio-api-wiring, form-submission-resilience, omnichannel, ux-design,
onboarding-ux, reasoning-flow-parity, import-export-roundtrip,
docs-examples-consistency.

### Rubric coverage (1–16 → seed YAMLs)

| #   | Rubric concern                        | Seed YAMLs                                                          |
| --- | ------------------------------------- | ------------------------------------------------------------------- |
| 1   | Scope, Identity & Authorization       | tenant-isolation, project-isolation, user-session, session-identity |
| 2   | Session State, Metadata & Memory      | session-context, message-metadata, memory-discipline                |
| 3   | Contact & Omnichannel Continuity      | customer-contact, omnichannel                                       |
| 4   | Execution & Orchestration             | agent-transfer                                                      |
| 5   | Reasoning vs Flow Path Consistency    | reasoning-flow-parity                                               |
| 6   | Contracts & Compatibility             | clean-contracts                                                     |
| 7   | Import/Export/Round-Trip Fidelity     | import-export-roundtrip                                             |
| 8   | Security & Secret Safety              | security, encryption                                                |
| 9   | Privacy, Retention & Compliance       | retention                                                           |
| 10  | Traceability, Audit & Observability   | audit-log                                                           |
| 11  | Distributed Reliability & Scale       | cross-pod, scale                                                    |
| 12  | Activation, Deployment & Reachability | studio-wiring, studio-api-wiring                                    |
| 13  | Product UX & Design System            | design-system, ux-design, form-submission-resilience                |
| 14  | Builder UX, Onboarding & Localization | localization, onboarding-ux                                         |
| 15  | Docs, Examples & Consistency          | docs-examples-consistency                                           |
| 16  | Test Integrity & Regression Coverage  | test-integrity                                                      |

These are a starting point, not final truth. Refine iteratively as findings
surface false positives or missed cases.
