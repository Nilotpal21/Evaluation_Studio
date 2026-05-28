# Auth Profile — Document Index & Implementation Status

**Date:** 2026-03-17
**Purpose:** Single entry point for all auth profile documentation. Start here.

> **Implementation Roadmap:** See [AUTH-PROFILE-IMPLEMENTATION-ROADMAP.md](./AUTH-PROFILE-IMPLEMENTATION-ROADMAP.md) for the phased plan to close all gaps (5 phases, ~20-27 days).

---

## 1. Implementation Status Summary

| Feature                                                                     | Status                  | Notes                                                             |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| AuthProfile Mongoose model + CRUD API                                       | Implemented             | Phase 1 core + Runtime REST API (03-18)                           |
| OAuth flow (connector OAuth)                                                | Implemented             | Phase 1                                                           |
| Studio UI (create/edit/list profiles)                                       | Implemented             | Phase 1                                                           |
| Encryption (KMS integration)                                                | Implemented             | Phase 1                                                           |
| AuthProfileRotationJob class                                                | Implemented (NOT WIRED) | Class exists, never started in server.ts                          |
| Grace period function                                                       | Implemented (NOT WIRED) | resolveWithGracePeriod() exists, resolver calls it but tests fail |
| Name-based resolution (resolveByName)                                       | **Partial**             | Runtime has resolveByName(), cache name methods not implemented   |
| DSL auth_profile references                                                 | **Implemented**         | Parser + compiler + IR fully wired (03-18)                        |
| DSL consent/connection keywords                                             | **Implemented**         | Parser + compiler + IR fully wired (03-18, WG-4)                  |
| mTLS TLS agent wiring                                                       | Partial                 | Tests pass, applyAuth() returns tlsOptions                        |
| Bulk actions API                                                            | **Implemented**         | Project + workspace scoped, tests pass                            |
| Config variable resolution                                                  | **Implemented**         | Template preserved in IR, runtime resolves (03-18)                |
| Multi-agent auth propagation                                                | Implemented             | packages/shared, runtime handoff                                  |
| Import/export auth mapping                                                  | Implemented             | packages/project-io                                               |
| Phase 2 auth types (basic, custom_header, aws_iam, azure_ad, mtls, ssh_key) | Not Started             |                                                                   |
| Phase 3 enterprise types (digest, kerberos, SAML, hawk, ws_security)        | Not Started             |                                                                   |
| Preflight consent (GAP 3.1-3.4)                                             | **Implemented**         | WS protocol + auth gate + Studio UI wired (03-18)                 |
| JIT Auth                                                                    | **Implemented**         | Pause/resume, OAuth circuit, cleanup (03-18)                      |
| Hardening fixes                                                             | Partial                 | 3 critical pending: rotation wiring, grace period, search-ai      |
| SDKChannel secretKey encryption                                             | **Implemented**         | Encryption plugin added (03-18)                                   |
| WebSocket preflight events (WG-2)                                           | **Implemented**         | auth_required/gate_updated/gate_satisfied wired (03-18)           |
| OAuth callback JIT resolution (WG-1)                                        | **Implemented**         | handleOAuthCallback resolves paused executions (03-18)            |
| Main WS handler preflight (WG-3)                                            | **Implemented**         | Mirrors SDK handler pattern (03-18)                               |

---

## 2. Document Map

### Core Design (canonical)

| File                                           | Description                         |
| ---------------------------------------------- | ----------------------------------- |
| `docs/plans/2026-03-11-auth-profile-design.md` | Master design — THE source of truth |

### Phase Scoping

| File                                                         | Description                     |
| ------------------------------------------------------------ | ------------------------------- |
| `docs/plans/2026-03-11-auth-profile-phase1-core.md`          | Phase 1 scope (OAuth, CRUD)     |
| `docs/plans/2026-03-11-auth-profile-phase2-consolidation.md` | Phase 2 scope (more auth types) |
| `docs/plans/2026-03-11-auth-profile-phase3-enterprise.md`    | Phase 3 scope (enterprise)      |

### Implementation Plans

| File                                                               | Description                 |
| ------------------------------------------------------------------ | --------------------------- |
| `docs/plans/2026-03-11-auth-profile-implementation-plan.md`        | Phase 1 implementation plan |
| `docs/plans/2026-03-11-auth-profile-phase2-implementation-plan.md` | Phase 2 implementation plan |
| `docs/plans/2026-03-11-auth-profile-phase3-implementation-plan.md` | Phase 3 implementation plan |

### Analysis

| File                                                         | Description                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/plans/2026-03-11-auth-profile-code-changes.md`         | File change inventory                                              |
| `docs/plans/2026-03-11-auth-profile-connections-analysis.md` | Credential model analysis                                          |
| `docs/plans/2026-03-11-auth-profile-redundancy-analysis.md`  | OAuth flow deduplication (partially overlaps connections-analysis) |
| `docs/plans/2026-03-11-auth-profile-studio-ui-analysis.md`   | UI component gaps                                                  |
| `docs/plans/2026-03-11-auth-profile-test-analysis.md`        | Test impact matrix                                                 |
| `docs/plans/2026-03-11-auth-profile-setup-guide.md`          | Env var configuration                                              |

### Gap Plans (03-13)

| File                                                                     | Description                            |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `docs/plans/2026-03-13-auth-profile-gap-3.1-preflight-consent-modal.md`  | Preflight consent modal                |
| `docs/plans/2026-03-13-auth-profile-gap-3.2-partial-consent-handling.md` | Partial consent handling               |
| `docs/plans/2026-03-13-auth-profile-gap-3.3-consent-persistence.md`      | Consent persistence                    |
| `docs/plans/2026-03-13-auth-profile-gap-3.4-batch-consent-ui.md`         | Batch consent UI                       |
| `docs/plans/2026-03-13-auth-profile-infrastructure-gaps.md`              | Infrastructure gaps                    |
| `docs/plans/2026-03-13-auth-profile-deferred-types-addons.md`            | Deferred types (overlaps Phase 3 plan) |

### Current Audits (Pass 5 — authoritative)

| File                                                             | Description               |
| ---------------------------------------------------------------- | ------------------------- |
| `docs/plans/2026-03-13-auth-profile-audit-pass5-correctness.md`  | Pass 5 correctness audit  |
| `docs/plans/2026-03-13-auth-profile-audit-pass5-completeness.md` | Pass 5 completeness audit |
| `docs/plans/2026-03-13-auth-profile-audit-pass5-gaps.md`         | Pass 5 gaps audit         |

### Test Results (03-18)

| File                                                  | Description                                                |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `docs/plans/AUTH-PROFILE-E2E-CHECKLIST.md`            | E2E test checklist — 61/61 PASS, 7 suites, 6 test files    |
| `docs/plans/AUTH-PROFILE-INTEGRATION-TEST-RESULTS.md` | Full integration test results — 384 pass, 86 fail, 15 skip |
| `docs/plans/AUTH-PROFILE-IMPLEMENTATION-ROADMAP.md`   | Phased roadmap with 47 integration scenarios               |

### Wiring & JIT Auth (03-17)

| File                                                                       | Description                   |
| -------------------------------------------------------------------------- | ----------------------------- |
| `docs/superpowers/specs/2026-03-17-auth-profile-wiring-jit-auth-design.md` | Wiring + JIT auth design spec |
| `docs/superpowers/plans/2026-03-17-auth-profile-wiring-jit-auth.md`        | Wiring + JIT auth impl plan   |

### Hardening (03-17)

| File                                                   | Description                              |
| ------------------------------------------------------ | ---------------------------------------- |
| `docs/plans/2026-03-17-auth-profile-hardening-plan.md` | Security hardening (3 crit, 9 important) |

### Archived (superseded/historical)

All files in `docs/archive/auth-profile-reviews/`:

- **16 design review docs** (2026-03-11) — original multi-reviewer pass
- **6 superseded audit docs** (2026-03-13) — Pass 1 and Pass 3, replaced by Pass 5

Most valuable archived reviews:

| File                       | Why it matters               |
| -------------------------- | ---------------------------- |
| `review-feasibility.md`    | Shaped the Phase 1/2/3 split |
| `review-security.md`       | 4 CRITICAL findings          |
| `review-tenant-project.md` | Isolation findings           |

---

## 3. Redundancy Notes

Known overlaps between documents:

- **deferred-types-addons.md** overlaps heavily with **phase3-implementation-plan.md** — prefer the implementation plan for scope decisions
- **connections-analysis.md** and **redundancy-analysis.md** cover similar OAuth pattern ground
- **review-env-config.md** (archived) overlaps with **setup-guide.md** — prefer setup-guide
- **review-existing-code.md** (archived) corrects **code-changes.md** — read both if using code-changes
- **review-false-negatives.md** and **review-migration-gaps.md** (both archived) find the same plain-text secrets issue

---

## 4. Reading Order

For someone new to auth profiles, read in this order:

1. **This index** (you are here)
2. **auth-profile-design.md** — master design, covers the full vision
3. **phase1-core.md** then **phase2-consolidation.md** then **phase3-enterprise.md** — scope boundaries
4. **Gap plans 3.1-3.4** — preflight consent design (not yet implemented)
5. **wiring-jit-auth-design.md** — current gaps and wiring plan
6. **hardening-plan.md** — security fixes needed
