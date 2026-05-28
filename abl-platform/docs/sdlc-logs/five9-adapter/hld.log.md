# HLD Log: Five9 Agent Transfer Adapter

**Date**: 2026-03-24
**Phase**: HLD
**Artifact**: `docs/specs/five9-adapter.hld.md`

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items — no user escalation needed.

### Key Decisions

| #   | Question                         | Classification | Decision                                                                         |
| --- | -------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| Q1  | Architecture pattern             | ANSWERED       | Standalone adapter following KoreAdapter pattern (Option A)                      |
| Q2  | Data flow: request vs event      | ANSWERED       | Both: synchronous transfer initiation + async webhook for agent events           |
| Q3  | Expected scale                   | INFERRED       | Same as Kore — 1,000 concurrent sessions per tenant, <3s transfer initiation     |
| Q4  | Existing patterns to follow      | ANSWERED       | KoreAdapter, TransferSessionStore, MessageBridge, AdapterRegistry                |
| Q5  | Deployment topology              | ANSWERED       | Single runtime service, no new services needed                                   |
| Q6  | Packages affected                | ANSWERED       | packages/agent-transfer (new adapter), apps/runtime (webhook route), apps/studio |
| Q7  | External dependencies            | ANSWERED       | Five9 REST API only, native fetch, no SDK                                        |
| Q8  | API contract changes             | ANSWERED       | No new endpoints — webhook route enhanced with provider-aware pre-processing     |
| Q9  | Breaking changes                 | ANSWERED       | None — Kore path unchanged, Five9 is additive                                    |
| Q10 | Compile→deploy→execute lifecycle | ANSWERED       | Additive, no migration, opt-in via connection config                             |
| Q11 | Biggest technical risk           | ANSWERED       | Five9 webhook payload structure inferred, not validated against live API         |
| Q12 | Data migration                   | ANSWERED       | None — Redis session store reused, no MongoDB changes                            |
| Q13 | Rollback strategy                | ANSWERED       | Deploy previous version, Five9 is opt-in, orphaned sessions expire via TTL       |
| Q14 | Feature flags                    | DECIDED        | No feature flag — opt-in via connection configuration is sufficient              |
| Q15 | Blast radius                     | ANSWERED       | Webhook route change is only risk — verified by E2E-6 Kore regression test       |

## HLD Summary

- **3 alternatives considered**: Standalone adapter (recommended), Abstract base adapter, Separate microservice
- **4 architecture diagrams**: System context, component internals, transfer lifecycle data flow, webhook sequence
- **12 architectural concerns addressed**: All substantive, none hand-waved
- **No new data models**: Five9 reuses TransferSessionStore with fields in `providerData` blob
- **No new endpoints**: Webhook route enhanced with provider-aware pre-processing
- **3 open questions**: Webhook payload validation, token expiry duration, retry policy

## Audit Rounds

### Round 1: NEEDS_REVISION

**2 CRITICAL findings:**

- `transferTraceEmitter` invented name → fixed to `TraceEventEmitter` interface + `createTraceStoreAdapter()`
- Option C referenced non-existent `GenericAdapter` → replaced with "Separate microservice behind a queue"

**4 HIGH findings:**

- Redundant `conversationId` field in data model → removed, use only `providerSessionId`
- Cross-cutting concerns conflated audit logging with operational logging → separated
- Webhook signature bypass mechanism undocumented → documented with config path explanation
- Rollback plan missing Studio scenario → added independent deployment window analysis

**2 MEDIUM findings:**

- Missing Overview section (design-lint failure) → added
- Open question Q4 already decided in feature spec → removed

### Round 2: NEEDS_REVISION

**1 HIGH finding:**

- Five9 session fields listed as top-level Redis hash fields → corrected to `providerData` blob per `TransferSessionData` interface
- Feature spec residuals identified (upstream, not HLD) → fixed in feature spec

**2 MEDIUM findings:**

- Subsection numbering mismatch (3.x → 4.x) → fixed
- Webhook secret config path future note → added

### Round 3: APPROVED

**0 CRITICAL, 0 HIGH findings.**

**1 MEDIUM finding (upstream):**

- Test spec has stale HLD reference → fixed (`N/A` → actual path)

**All quality gates pass. design-lint: 95% (19 present, 1 warning, 0 missing).**

## Upstream Fixes (Feature Spec Residuals)

During HLD audit, two stale references in the feature spec were identified and fixed:

1. `docs/features/sub-features/five9-adapter.md` line 180: `conversationId` as separate Redis field → replaced with `providerData` structure
2. `docs/features/sub-features/five9-adapter.md` line 323: `transferTraceEmitter` → `TraceEventEmitter` interface

## Files Created/Modified

- `docs/specs/five9-adapter.hld.md` — HLD (new)
- `docs/testing/sub-features/five9-adapter.md` — updated HLD reference
- `docs/features/sub-features/five9-adapter.md` — fixed 2 upstream residuals
- `docs/sdlc-logs/five9-adapter/hld.log.md` — this log file
