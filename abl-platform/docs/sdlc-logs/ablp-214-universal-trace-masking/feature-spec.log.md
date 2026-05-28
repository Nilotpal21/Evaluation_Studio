# ABLP-214 Universal Trace Masking — Feature Spec Log

**Date**: 2026-04-09
**Phase**: Feature Spec (SDLC Phase 1)
**Jira**: https://koreteam.atlassian.net/browse/ABLP-214

---

## Oracle Decisions

| Q#  | Area  | Question                               | Classification | Answer                                                                                                                                        |
| --- | ----- | -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Scope | New capability or gap fix?             | ANSWERED       | Gap fix in existing PII Detection feature (BETA). FR-14 exists but implementation only covers tool_call.                                      |
| Q2  | Scope | Which event types scrubbed vs not?     | ANSWERED       | Only tool_call and llm_call. All others (decision, error, handoff, agent_enter/exit, constraint_check, custom, flow events) are NOT scrubbed. |
| Q3  | Scope | Enhance trace-scrubber patterns too?   | ANSWERED       | Yes — add API key, key prefix (sk-/pk-/abl*/ghp*/gho\_), and secret key name detection. Per implementation plan Phase 1.                      |
| Q4  | Scope | Stricter credit card masking?          | ANSWERED       | Yes — remove Luhn validation, mask ALL 13-19 digit sequences. Per implementation plan Phase 2.                                                |
| Q5  | Scope | Remove Studio masking in this ticket?  | DECIDED        | Yes, but as separate commit after Runtime masking is verified.                                                                                |
| Q6  | Users | Primary personas?                      | INFERRED       | Platform operator, compliance officer, project builder. End-users indirectly protected.                                                       |
| Q7  | Users | Compliance requirements?               | ANSWERED       | GDPR, CCPA, HIPAA — stated in pii-detection.md problem statement.                                                                             |
| Q8  | Users | Opt-in or opt-out?                     | ANSWERED       | Uses existing scrubPII flag. FREE/TEAM=false, BUSINESS/ENTERPRISE=true, default=true.                                                         |
| Q9  | Users | Performance budget?                    | INFERRED       | <1ms per event acceptable. O(n) with pre-compiled regex.                                                                                      |
| Q10 | Users | Scrub top-level fields or only data?   | DECIDED        | Only event.data. Top-level fields are system metadata.                                                                                        |
| Q11 | Tech  | New export or reuse scrubToolCallData? | DECIDED        | New scrubTraceEvent export for clarity. Same underlying scrubValue().                                                                         |
| Q12 | Tech  | Use existing enableScrub flag?         | ANSWERED       | Yes — already flows from tenant config into createTraceEmitter().                                                                             |
| Q13 | Tech  | Custom patterns in trace scrubbing?    | DECIDED        | Built-in only. Custom patterns for guardrail-level, not trace scrubbing.                                                                      |
| Q14 | Tech  | Double-scrubbing concern?              | ANSWERED       | Idempotent — redacting already-redacted text is a no-op. Keep existing pre-scrubbing as defense-in-depth.                                     |
| Q15 | Tech  | Phase 4 same or separate ticket?       | DECIDED        | Same ticket, separate commit.                                                                                                                 |

## AMBIGUOUS Items

None — all questions resolved from code evidence or reasonable judgment.

## Audit Results

### Round 1 (Self-audit — agent spawning unavailable)

**Result**: APPROVED

All 18 sections of TEMPLATE.md addressed. Key checks:

- 5 user stories (minimum 3 required) — PASS
- 10 functional requirements (minimum 4 required) — PASS
- Integration matrix references 4 related features (minimum 2 required) — PASS
- Non-functional concerns address tenant isolation — PASS
- Delivery plan has 4 parent tasks with numbered subtasks — PASS
- Open questions has 3 items (minimum 1 required) — PASS
- Testing section has 10 scenarios — PASS

No CRITICAL or HIGH findings.

## Files Created

- `docs/features/sub-features/universal-trace-masking.md` — feature spec
- `docs/testing/sub-features/universal-trace-masking.md` — testing guide
- `docs/sdlc-logs/ablp-214-universal-trace-masking/feature-spec.log.md` — this log

## Files Updated

- `docs/features/sub-features/README.md` — added sub-feature entry
- `docs/features/README.md` — added to Focused Sub-Feature Modules table
- `docs/testing/sub-features/README.md` — added testing guide entry
- `docs/testing/README.md` — added testing guide entry

## Files Read

- `docs/features/pii-detection.md` — existing BETA feature spec
- `docs/plans/2026-04-08-ablp-214-runtime-masking-implementation-plan.md` — implementation plan
- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` — current scrubber
- `packages/compiler/src/platform/security/pii-detector.ts` — PII patterns
- `apps/runtime/src/services/trace-emitter.ts` — emit() function (the gap)
- `apps/studio/src/services/tenant-config.ts` — scrubPII per plan
- `apps/studio/src/components/settings/PIIProtectionTab.tsx` — existing PII settings UI
