# SDLC Log: Auth Profile Phase 2 Core Auth Types LLD

**Phase**: 4 - Low-Level Design
**Date**: 2026-04-23
**Status**: Complete

---

## Clarifying Questions & Resolutions

Note: The `lld` skill normally delegates these questions to an oracle agent. For this run, answers were inferred directly from the feature spec, HLD, test spec, and current code because no explicit user request for sub-agent delegation was given.

### Implementation Strategy

1. **Q: What is the preferred implementation order?**
   - Classification: DECIDED
   - Answer: Shared contract first, runtime fail-closed checks second, SigV4 signer third, Studio exposure fourth, coverage ramp last.

2. **Q: Should this slice be behind a new feature flag?**
   - Classification: DECIDED
   - Answer: No. Safe rollout comes from phase ordering, especially not exposing `aws_iam` in Studio until the signer exists.

3. **Q: What counts as phase-1 vs later-scope here?**
   - Classification: ANSWERED
   - Source: feature spec non-goals and HLD decisions
   - Answer: Only `basic`, `custom_header`, `aws_iam`, and `mtls` are in scope. `azure_ad`, `ssh_key`, STS assume-role, and generic non-HTTP consumer support remain deferred.

### Technical Details

4. **Q: Where should the support matrix live?**
   - Classification: DECIDED
   - Answer: `packages/shared/src/validation/`, because both Studio client code and Runtime need a bundle-safe shared source of truth.

5. **Q: Which file should own final SigV4 signing?**
   - Classification: ANSWERED
   - Source: `apply-auth.ts` only shapes credentials; `http-tool-executor.ts` owns the final request
   - Answer: A new helper near the HTTP executor plus executor integration.

6. **Q: Does the IR already have a signer context seam?**
   - Classification: ANSWERED
   - Source: `packages/compiler/src/platform/ir/schema.ts`
   - Answer: No. `HttpBindingIR` has `tls_options` but no transient request-signing context, so LLD adds `sigv4_auth`.

### Risk & Dependencies

7. **Q: What is the biggest implementation risk?**
   - Classification: DECIDED
   - Answer: Dropping or misplacing the transient signing context before the executor signs the final canonical request.

8. **Q: Are there likely conflicting assumptions in ongoing code?**
   - Classification: INFERRED
   - Source: Studio still uses `PHASE1_AUTH_TYPES`; connection flows already assume `authProfileId` means reusable credentials
   - Answer: Yes. Existing Studio assumptions are the main product-behavior conflict and must be corrected explicitly.

9. **Q: What is the whole-feature definition of done?**
   - Classification: DECIDED
   - Answer: The four auth types are correctly exposed in Studio, honored or fail-closed on the supported runtime paths, and covered by targeted integration/E2E tests without overstating support for raw connections.

## Key Decisions

- 7 design decisions documented with rationale and rejected alternatives
- 5 implementation phases with measurable exit criteria
- explicit transient `sigv4_auth` contract added to the plan
- shared support matrix chosen as the single compatibility source of truth
- no persistence migration or new feature flag required

## Output Verification

- [x] Design decisions log
- [x] Key interfaces and types documented
- [x] Module boundaries mapped
- [x] File-level change map completed
- [x] Phased implementation plan with rollback per phase
- [x] Wiring checklist included
- [x] Cross-phase concerns documented
- [x] Whole-feature acceptance criteria defined
