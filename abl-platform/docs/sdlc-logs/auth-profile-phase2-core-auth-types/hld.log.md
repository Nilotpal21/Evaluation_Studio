# SDLC Log: Auth Profile Phase 2 Core Auth Types HLD

**Phase**: 3 - High-Level Design
**Date**: 2026-04-23
**Status**: Complete

---

## Clarifying Questions & Resolutions

Note: The `hld` skill normally delegates these questions to an oracle agent. For this run, answers were inferred directly from the feature spec, test spec, and current code because no explicit user request for sub-agent delegation was given.

### Architecture & Data Flow

1. **Q: What is the preferred architecture pattern?**
   - Classification: ANSWERED
   - Source: existing auth-profile persistence and runtime execution layering
   - Answer: Additive extension of the existing auth-profile stack. No new credential subsystem; use shared validation, Studio metadata, runtime resolver/middleware, and the HTTP executor.

2. **Q: Where should final `aws_iam` signing happen?**
   - Classification: DECIDED
   - Source: `apply-auth.ts` only shapes credentials; the executor owns the final request shape
   - Answer: At the HTTP executor boundary, after method, URL, query, and body are finalized.

3. **Q: How should `mtls` be modeled?**
   - Classification: ANSWERED
   - Source: current resolver -> middleware -> `tls_options` -> executor flow
   - Answer: Transport auth only. Supported on HTTPS consumers that propagate TLS client options.

### Integration & Dependencies

4. **Q: Which existing packages are the integration backbone?**
   - Classification: ANSWERED
   - Source: `packages/shared`, `apps/studio`, `apps/runtime`, `packages/compiler`
   - Answer: Shared schemas and `applyAuth()`, Studio metadata/picker surfaces, runtime tool auth resolution, and the HTTP executor.

5. **Q: Are new external dependencies required?**
   - Classification: INFERRED
   - Source: workspace already contains `@aws-sdk/signature-v4` and `aws4`
   - Answer: Probably not. The HLD assumes reuse of an existing signer dependency rather than introducing a bespoke signing implementation.

### Risk & Migration

6. **Q: What is the biggest technical risk?**
   - Classification: DECIDED
   - Answer: Shipping Studio exposure without a single source of truth for honoring support, especially for `aws_iam` and `mtls`.

7. **Q: Is a data migration required?**
   - Classification: ANSWERED
   - Source: current backend already validates and stores the four auth types
   - Answer: No. This slice is additive and contract-level, not persistence-level.

8. **Q: What is the rollback strategy?**
   - Classification: ANSWERED
   - Source: no schema changes; support is code-path driven
   - Answer: Roll back by hiding Studio exposure and/or reverting the executor signer seam. Stored profiles remain intact.

## 12 Concerns Verification

All 12 architectural concerns are addressed in the HLD:

- [x] 1. Tenant Isolation
- [x] 2. Data Access Pattern
- [x] 3. API Contract
- [x] 4. Security Surface
- [x] 5. Error Model
- [x] 6. Failure Modes
- [x] 7. Idempotency
- [x] 8. Observability
- [x] 9. Performance Budget
- [x] 10. Migration Path
- [x] 11. Rollback Plan
- [x] 12. Test Strategy

## Alternatives Considered

3 alternatives analyzed:

- [x] A: Studio exposure only
- [x] B: Additive capability matrix + executor-aware honoring
- [x] C: Separate enterprise auth subsystem

## Key Findings

- The central design need is a shared support matrix, not a new credential store.
- `aws_iam` requires a final-request execution seam; early signing would be architecturally incorrect.
- `mtls` is already materially implemented on the HTTP tool path and should stay transport-scoped.
- Raw connections remain attachable binding records and must not be treated as proof of runtime support.
