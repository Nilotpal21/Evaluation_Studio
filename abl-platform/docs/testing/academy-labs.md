# Testing Guide: Academy Hands-On Labs

**Feature**: [Academy Hands-On Labs](../features/academy-labs.md)
**Status**: PLANNED
**Last Updated**: 2026-04-16

---

## Current State

No tests exist — this is a PLANNED feature. This document will be populated during the `/test-spec` phase.

---

## Coverage Matrix

| FR    | Requirement                                      | Unit | Integration | E2E | Manual | Status     |
| ----- | ------------------------------------------------ | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Load lab.json from content directory             |      |             |     |        | NOT TESTED |
| FR-2  | Validate lab.json against Zod schema             |      |             |     |        | NOT TESTED |
| FR-3  | Serve lab definition with stripped checks        |      |             |     |        | NOT TESTED |
| FR-4  | Verify user project access via JWT forwarding    |      |             |     |        | NOT TESTED |
| FR-5  | Fetch and evaluate project state                 |      |             |     |        | NOT TESTED |
| FR-6  | 6 check types (custom-check deferred to Phase 2) |      |             |     |        | NOT TESTED |
| FR-7  | Per-objective pass/fail with feedback            |      |             |     |        | NOT TESTED |
| FR-8  | Lab scoring and pass threshold                   |      |             |     |        | NOT TESTED |
| FR-9  | Idempotent point awards                          |      |             |     |        | NOT TESTED |
| FR-10 | Rate limiting (5/10min)                          |      |             |     |        | NOT TESTED |
| FR-11 | ModuleProgress lab field extensions              |      |             |     |        | NOT TESTED |
| FR-12 | Lab required for course completion               |      |             |     |        | NOT TESTED |
| FR-13 | Lab badge triggers                               |      |             |     |        | NOT TESTED |
| FR-14 | Lab UI in module viewer                          |      |             |     |        | NOT TESTED |
| FR-15 | Hidden check reveal after verification           |      |             |     |        | NOT TESTED |
| FR-16 | Streak tracking on lab verification              |      |             |     |        | NOT TESTED |
| FR-17 | Store labProjectId on success                    |      |             |     |        | NOT TESTED |

---

## E2E Test Scenarios (Minimum)

1. **Lab definition retrieval**: `GET /modules/:moduleId/lab` returns lab with check configs stripped and hidden checks anonymized. Auth required.
2. **Successful lab verification**: `POST /modules/:moduleId/lab/verify` with valid project → all objectives pass → points awarded → badges checked.
3. **Partial pass verification**: Verify against project missing some objectives → partial score returned → lab not passed if below threshold.
4. **Inaccessible project**: Verify with a project the user doesn't have access to → 404 returned (not 403).
5. **Rate limit enforcement**: 6 verify attempts within 10 minutes → 429 on 6th attempt.
6. **Module hasLab flag**: `GET /modules/:moduleId` returns `hasLab: true` for modules with lab.json.
7. **Idempotent point awards**: Pass lab twice → points awarded only on first pass.

---

## Integration Test Scenarios (Minimum)

1. **Lab progress persistence**: Verify lab → `labAttempts`, `labPassed`, `labBestScore` persisted correctly.
2. **Course completion with labs**: Course with lab modules → completion requires both quiz and lab passed.
3. **Badge trigger: first-lab-pass**: Complete first lab → badge awarded.
4. **Badge trigger: perfect-lab**: Score 100% on lab → badge awarded.
5. **Backward compatibility**: Existing progress documents without lab fields return correct defaults.

---

## Testing Notes

Full test scenarios will be developed during the `/test-spec` SDLC phase. E2E tests must exercise the real Academy HTTP API with auth context. Integration tests must use `mongodb-memory-server` with real content files. No mocking of platform components per CLAUDE.md test rules.
