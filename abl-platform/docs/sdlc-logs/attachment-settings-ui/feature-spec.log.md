# Feature Spec Log: Attachment Settings UI

**Date**: 2026-03-22
**Phase**: FEATURE-SPEC
**Feature**: Studio Attachment Settings UI (sub-feature of Attachments)

---

## Oracle Decisions

15 questions asked across 3 categories (Scope, Users, Technical). All answered.

| #   | Category  | Question Summary       | Classification | Decision                                                                      |
| --- | --------- | ---------------------- | -------------- | ----------------------------------------------------------------------------- |
| Q1  | Scope     | Problem / pain point   | ANSWERED       | Project admins must use raw HTTP to configure attachment behavior             |
| Q2  | Scope     | Out of scope           | ANSWERED       | Tenant admin UI (GAP-003), processing pipeline config, storage backend        |
| Q3  | Scope     | New or enhancement     | ANSWERED       | Enhancement — backend exists, frontend missing                                |
| Q4  | Scope     | Priority               | ANSWERED       | Task #19 / Phase 4 Task 5, Medium severity                                    |
| Q5  | Scope     | Sub-feature or major   | DECIDED        | Sub-feature under attachments (GAP-001)                                       |
| Q6  | Users     | Primary personas       | ANSWERED       | Project admin/developer configuring settings in Studio                        |
| Q7  | Users     | User journeys          | INFERRED       | View → modify → save → reset to default → see effect                          |
| Q8  | Users     | Editable fields        | ANSWERED       | enabled, maxFileSizeBytes, allowedMimeTypes, piiPolicy, defaultProcessingMode |
| Q9  | Users     | Resolved vs overridden | DECIDED        | Show both — API returns both, critical for usability                          |
| Q10 | Users     | Reset to defaults      | DECIDED        | Yes, per-field reset via null — backend supports it                           |
| Q11 | Technical | Settings section       | DECIDED        | Settings group as `settings-attachments`                                      |
| Q12 | Technical | apiFetch vs SWR        | DECIDED        | Pattern A (direct apiFetch) — all settings tabs use this                      |
| Q13 | Technical | Proxy route            | ANSWERED       | Does not exist — must create, proxy to runtime                                |
| Q14 | Technical | i18n keys              | INFERRED       | ~25 keys in `settings.attachments` namespace                                  |
| Q15 | Technical | MIME type selector     | DECIDED        | Chip/tag editor (like TraceDimensionsTab)                                     |

## Escalations

None — all questions resolved without user input.

## Files Created

- `docs/features/sub-features/attachment-settings-ui.md` — Sub-feature spec
- `docs/testing/sub-features/attachment-settings-ui.md` — Testing guide placeholder
