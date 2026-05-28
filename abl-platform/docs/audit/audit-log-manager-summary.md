# Audit Logs Manager Summary

> Historical snapshot: this manager summary reflects the audit system before the current shared Kafka -> ClickHouse migration was completed. It is useful as context for the earlier hardening work, but it should not be treated as the current architecture description. For current state, use [docs/audit/audit-log-system-deep-dive.md](./audit-log-system-deep-dive.md), [docs/features/audit-logging.md](../features/audit-logging.md), [docs/specs/audit-logging.hld.md](../specs/audit-logging.hld.md), and [docs/testing/audit-logging.md](../testing/audit-logging.md).

Date: 2026-04-15

Audience: engineering manager, architecture review, technical planning

Related references:

- `docs/features/audit-logging.md`
- `docs/specs/audit-logging.hld.md`
- `docs/audit/audit-log-system-deep-dive.md`

## Executive Verdict

The platform is clearly designed with serious audit logging in mind, and there are several strong implementations already in place. However, the current system is not yet a clean, unified, future-ready audit platform.

The best way to describe it is:

- the direction is correct
- the implementation is uneven
- some subsystems are strong
- the shared generic audit layer needs consolidation

If the question is "Do we have audit logging?" the answer is yes.

If the question is "Is the overall audit architecture fully correct, fully unified, and future-ready?" the answer is no, not yet.

## Direct Answers to the Key Questions

### 1. Is it implemented properly?

Partially.

The dedicated audit subsystems are implemented much better than the shared generic layer. The strongest pieces are:

- KMS audit
- PII audit
- connector audit
- Arch AI audit

The weakest pieces are:

- shared Mongo `audit_logs`
- generic runtime ClickHouse audit behavior
- mixed audit versus observability-only paths
- incomplete or inconsistent actor and context propagation

### 2. Is this really the correct solution?

The architectural direction is correct, but the current implementation is not yet the final correct solution.

The codebase is aiming for the right design:

- structured append-only audit events
- shared audit abstractions
- fire-and-forget writes
- specialized retention policies
- automatic auditing for sensitive model changes
- dedicated compliance-grade stores for domains like KMS and PII

That is the right foundation. The issue is that the implementation has drifted and now mixes multiple patterns that do not align cleanly.

### 3. Is it architecturally sound and future ready?

Not as a single unified platform today.

It is architecturally promising, but only partially future-ready. The domain-owned dedicated audit systems are the most sound pieces. The shared platform audit layer is where most of the architectural debt currently sits.

### 4. Will this create conflict with existing design assumptions in the code?

There are already tensions with existing design assumptions.

Examples:

- The platform assumes strong traceability, but the generic ClickHouse audit path does not preserve trace identity cleanly.
- The platform assumes strong tenant and resource isolation, but some shared audit query paths are weaker than the repo's broader isolation principles.
- The platform assumes audit logging as a compliance mechanism, but some paths called "audit" are actually logger-only, memory-only, or deletable.
- The platform assumes a canonical contract, but shared Mongo `audit_logs` contains multiple incompatible row shapes.

So this does not need to be thrown away, but it does need cleanup to avoid long-term architectural conflict.

## What Is Strong Today

These areas look like solid building blocks worth keeping:

- KMS audit
  - dedicated ClickHouse table
  - dedicated retention policy
  - clear compliance purpose
- PII audit
  - dedicated model and retention
  - explicit sensitive-access tracking
- connector audit
  - dedicated model, service, and routes
  - easier to reason about than the shared sink
- Arch AI audit
  - dedicated subsystem with its own query surfaces
- shared `AuditStore` abstraction
  - good conceptual foundation for a platform-level contract

## What Is Weak Today

These areas need architectural cleanup before they can be treated as a strong platform audit backbone:

- shared Mongo `audit_logs`
  - multiple producers
  - multiple schemas
  - inconsistent metadata encoding
- generic runtime ClickHouse audit store
  - contract mismatches
  - weak trace handling
  - tenant-query concerns
- Mongoose plugin integration
  - useful idea
  - actor propagation appears incomplete in real request flows
- contact-domain audit wiring
  - abstraction exists
  - production wiring appears incomplete
- omnichannel audit
  - memory only
  - not compliance-grade
- SearchAI logger-only "audit" paths
  - observability, not durable audit
- archive/export story
  - incomplete and needs stricter tenant-safe design

## Bottom-Line Assessment

This is not a bad design. It is an incomplete design convergence.

The codebase does not look like it made the wrong architectural bet. It looks like it started with a good platform-level audit vision, then evolved domain by domain, and now needs consolidation.

So the recommendation is:

- do not replace everything
- keep the strong dedicated subsystems
- standardize the shared contract
- separate compliance audit from operational logging
- normalize or split the shared generic sink

## Recommended Direction

The most practical future-ready direction is:

1. Keep dedicated domain-owned audit systems where they are already strong
   - KMS
   - PII
   - connector audit
   - Arch AI
2. Define one canonical audit event contract that every shared platform audit path must preserve exactly
3. Separate true audit from operational history and from application logging
4. Normalize the generic shared sink or split it into clearly typed collections
5. Make actor attribution, tenant scoping, traceability, and retention explicit and testable
6. Build one supported export/query story for compliance-grade audit data

## Priority Fixes

If we want to improve this without boiling the ocean, the best near-term priorities are:

1. Normalize shared `audit_logs` or split incompatible writers into separate collections
2. Fix generic ClickHouse contract mismatches
3. Ensure actor context is wired for plugin-generated audit rows
4. Clearly label non-durable paths as operational only
5. Finish missing wiring such as contact-domain audit
6. Add contract-level tests for tenant isolation, traceability, actor attribution, and retention behavior

## Manager-Ready Summary Statement

"I reviewed the audit logging system deeply across the docs and the actual code paths. My conclusion is that the platform has a strong audit vision and several solid implementations already, especially in KMS, PII, connector audit, and Arch AI. However, the overall system is not yet a fully unified, architecturally clean, future-ready audit platform. The main gap is the shared generic layer, where schemas, storage behavior, and guarantees are inconsistent. So this is not a rewrite situation. It is a consolidation and hardening situation. We should keep the strong domain-specific pieces, standardize the shared contract, clearly separate compliance audit from operational logging, and close the current schema and wiring gaps."

## Confidence Level

Confidence in this assessment: medium-high.

Reason:

- high confidence in the existence of the major patterns and mismatches
- high confidence in the stronger dedicated subsystems
- medium confidence on total coverage of every edge-case writer without a full runtime validation pass

This conclusion is based on source inspection and architecture review, not on a production traffic replay or full live-system verification.
