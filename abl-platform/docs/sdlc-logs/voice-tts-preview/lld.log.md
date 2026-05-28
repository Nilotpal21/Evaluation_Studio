# LLD Log — Voice TTS Preview

**Feature**: Voice TTS Preview
**Date**: 2026-04-11
**Phase**: LLD (Phase 4 of SDLC)

---

## Oracle Decisions

### Implementation Strategy

| #   | Question              | Answer                                                                                                                   | Classification |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Q1  | Implementation order? | API first (Phase 1), then Studio client + component (Phase 2), then UI integration (Phase 3), then tests (Phase 4)       | DECIDED        |
| Q2  | Existing patterns?    | Route: `custom-tts.ts`. API client: `voice.ts` (`getRuntimeUrl()`). Rate limit: `tenantRateLimit('request', overrides)`. | ANSWERED       |
| Q3  | Feature flag?         | Not needed — preview UI is inert when no TTS service instance is configured                                              | DECIDED        |
| Q4  | Phase 1 scope?        | Full endpoint: auth, rate limit, validation, both providers. No phasing of provider support — both are small.            | DECIDED        |
| Q5  | Deadlines?            | No external deadline. Internal feature exploration.                                                                      | ANSWERED       |

### Technical Details

| #   | Question                   | Answer                                                                                                                              | Classification |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q6  | Files to create vs modify? | 3 new files (route, API client, component), 3 modified files (server.ts, ConfigurationTab.tsx, VoiceServicesPage.tsx), 2 test files | ANSWERED       |
| Q7  | Testing strategy?          | Test-after — write tests in Phase 4 after all production code exists. DI for external providers.                                    | DECIDED        |
| Q8  | Type definitions?          | Zod schema in route file, TypeScript interfaces in API client and component. No shared types package needed — small surface.        | DECIDED        |
| Q9  | Database migration?        | None — reads from existing TenantServiceInstance collection                                                                         | ANSWERED       |
| Q10 | Performance-sensitive?     | No — preview is not in the call path. 5 req/min/tenant cap. Provider API latency dominates.                                         | INFERRED       |

### Risk & Dependencies

| #   | Question                   | Answer                                                                                                                                 | Classification |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q11 | Conflicting changes?       | No ongoing work touching VoiceFields in ConfigurationTab or ServiceCard in VoiceServicesPage                                           | INFERRED       |
| Q12 | Biggest impl risk?         | `resolveServiceCredentials` in "PRIVATE" comment section — risk of someone adding `private` keyword. Orpheus resolver uses it already. | INFERRED       |
| Q13 | Team dependencies?         | None — all changes are in runtime and studio, both in this repo                                                                        | ANSWERED       |
| Q14 | Monitoring before rollout? | Standard runtime request logging via `createLogger('tts-preview')`. No new dashboards needed.                                          | DECIDED        |
| Q15 | Definition of done?        | All acceptance criteria met, all tests passing, both surfaces working in dev server                                                    | DECIDED        |

---

## Audit Results

### Round 1 — Architecture Compliance

- **Result**: APPROVED
- Tenant isolation: `requireAuth` + `resolveServiceCredentials(tenantId, ...)` ✓
- Auth: `authMiddleware` from centralized module ✓
- Stateless: no data persistence ✓
- Observability: `createLogger('tts-preview')` ✓

### Round 2 — Pattern Consistency

- **Result**: APPROVED
- Route follows `custom-tts.ts` Express Router pattern ✓
- Studio API follows `voice.ts` direct runtime call pattern ✓
- Rate limiting follows existing `tenantRateLimit('request', overrides)` pattern ✓
- Error responses follow `{ success, error: { code, message } }` pattern ✓

### Round 3 — Completeness

- **Result**: APPROVED
- All 10 FRs have implementation tasks ✓
- File paths verified against codebase ✓
- Exact line numbers for integration points verified ✓
- Zod schema fields match feature spec FR-3 ✓

### Round 4 — Cross-Phase Consistency

- **Result**: APPROVED
- LLD implements HLD Option A (new route) ✓
- Test spec scenarios (E2E-1..7, INT-1..11) implementable after Phase 4 ✓
- Feature spec delivery plan maps to LLD phases ✓
- Error codes consistent across all documents ✓

### Round 5 — Final Sweep

- **Result**: APPROVED
- Each phase independently deployable ✓
- Wiring checklist: 8 items, all mapped to specific tasks ✓
- Tasks are session-sized (largest is ~120 LOC) ✓
- No TODO stubs ✓

---

## Files Created

- `docs/plans/2026-04-11-voice-tts-preview-impl-plan.md` — LLD + implementation plan
- `docs/sdlc-logs/voice-tts-preview/lld.log.md` — This log
