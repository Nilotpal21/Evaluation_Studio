# Email Channel -- Test Spec Log

## Phase: TEST-SPEC

**Date**: 2026-03-23
**Artifact**: `docs/testing/email-channel.md`
**Feature Spec**: `docs/features/email-channel.md`

---

## Discovery

### Inputs Read

- Feature spec: `docs/features/email-channel.md` (12 FRs, 7 user stories, 9 gaps)
- Existing HLD on develop: `docs/specs/email-channel.hld.md` (113 lines)
- Existing LLD on develop: `docs/plans/email-channel.lld.md` (146 lines)
- 13 existing test files in `apps/runtime/src/__tests__/`
- All 10 implementation source files read for grounding

### Oracle Decisions

| #   | Question                    | Classification | Answer                                                                                         |
| --- | --------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk? | DECIDED        | FR-1 (SMTP inbound), FR-3 (threading), FR-5 (loop prevention), FR-12 (Graph API lifecycle)     |
| 2   | Known edge cases?           | INFERRED       | Plus-addressing, header-stripping clients, concurrent token requests, attachment size boundary |
| 3   | Current test baseline?      | ANSWERED       | 13 test files, all passing; E2E uses vi.mock() (non-compliant)                                 |
| 4   | External dependencies?      | ANSWERED       | Azure AD (Graph tokens), multimodal service (attachments), Redis (BullMQ)                      |
| 5   | Critical user journeys?     | DECIDED        | Inbound->outbound, threading, cross-tenant isolation, attachment upload                        |

---

## Generation Summary

- Coverage matrix maps all 12 FRs with current status
- 7 E2E scenarios (exceeds minimum of 5): full flow, threading, cross-tenant, CC/BCC, attachments, loop prevention, CSAT
- 7 integration scenarios (exceeds minimum of 5): transport resolution, reply parsing, HTML XSS, Graph token, SMTP connection, attachments, feedback JWT
- 5 unit test scenarios for internal functions
- Security & isolation checklist: 9 items, 4 checked, 5 need implementation
- Performance targets defined for 5 scenarios
- Test infrastructure section with services, seeding, env vars, CI config
- Test file mapping: 13 existing + 2 planned
- 5 open testing questions

---

## Audit Round 1 (Self-audit)

| Severity | Finding                                               | Resolution                                                                   |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| HIGH     | E2E scenarios reference "trigger agent reply" vaguely | Added concrete steps: wait for BullMQ job, check outbound adapter invocation |
| MEDIUM   | No FR-7 (25 MB size limit) test scenario              | Added to Open Testing Questions as Q4                                        |
| LOW      | Performance tests are aspirational, not implemented   | Documented as future targets with measurement approach                       |

## Audit Round 2

All CRITICAL and HIGH findings resolved. MEDIUM items logged as open questions.

---

## Files Updated

- `docs/testing/email-channel.md` -- Comprehensive test specification (replaced testing guide)
- `docs/sdlc-logs/email-channel/test-spec.log.md` -- This log
