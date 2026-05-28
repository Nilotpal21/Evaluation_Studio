# SharePoint UX Design — Consolidated Review Findings

**Date:** 2026-03-23
**Source:** 3 parallel engineering persona reviews (PM, Eng Lead, QA) on FINAL-v2
**Purpose:** Categorized findings for decision-making. NO fixes applied yet.

---

## Review Summary

| Reviewer                  | Findings                  | CRIT  | HIGH   | MED    | LOW   |
| ------------------------- | ------------------------- | ----- | ------ | ------ | ----- |
| PM (UX Logic)             | 19                        | 0     | 5      | 9      | 5     |
| Eng Lead (Implementation) | 20                        | 4     | 7      | 7      | 2     |
| QA (Edge Cases)           | 16 gaps from 27 scenarios | 1     | 6      | 9      | 0     |
| **Total**                 | **55**                    | **5** | **18** | **25** | **7** |

---

## Category 1: UX Design Fixes (wireframe doc changes)

These are design decisions or missing wireframes — fix in DESIGN-FINAL-v2.md

### CRITICAL / HIGH

| #   | Finding                                                     | Source | Severity | Issue                                                                                                                                        |
| --- | ----------------------------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Simplified View has ZERO wireframes**                     | PM #9  | HIGH     | The DEFAULT experience for first-time users (Sarah) is never shown. All wireframes show full power-user view. Developers can't implement it. |
| 2   | **"Skip" button behavior undefined**                        | PM #4  | HIGH     | Skip appears on every proposal section but consequences are unspecified. Can you skip Connection? Permissions? What happens?                 |
| 3   | **"Modify Selection" dead-end in Simplified View**          | PM #12 | HIGH     | First-time user clicks "Modify Filters" but Scope+Filters tab is hidden. No flow for modifying scope in simplified mode.                     |
| 4   | **Permission "Enabled" misleads Standard tier**             | PM #3  | HIGH     | Default recommends "Enabled" but Standard tier gives ~70-85% accuracy. Label implies full permission-aware search.                           |
| 5   | **"Sign in with Microsoft" copy undermines recommendation** | PM #1  | HIGH     | Default labeled "for evaluating", non-default labeled "for production". Enterprise users will pick the harder path.                          |
| 6   | **Returning user defaults to Device Code**                  | PM #2  | MEDIUM   | Should default to Browser Login for self-service. Device Code is for delegation.                                                             |
| 7   | **No flow from "Approve Sync" to monitoring**               | PM #13 | MEDIUM   | After clicking Start Sync, what does the user see? No transition wireframe.                                                                  |
| 8   | **Health Check count mismatch**                             | PM #6  | LOW      | "5/7 passed" but 5 ok + 1 warn + 1 info. Is info a failure?                                                                                  |

### MEDIUM / LOW

| #   | Finding                                                      | Source | Issue                                                      |
| --- | ------------------------------------------------------------ | ------ | ---------------------------------------------------------- |
| 9   | "Accept with warnings" consequences undefined                | PM #10 | Does it persist in TOC? Block sync?                        |
| 10  | "[Learn more about group resolution]" links nowhere          | PM #8  | Dead link in wireframe                                     |
| 11  | Returning user app registration guide same as first-time     | PM #7  | Should show existing Client IDs instead                    |
| 12  | Security Review PDF content doesn't fully match Security tab | PM #14 | User Decisions Log sourced from Proposal, not Security tab |
| 13  | Delegation email omits offline_access                        | PM #15 | Minor inconsistency                                        |
| 14  | "Enabled" means different things at different tiers          | PM #5  | Same label, different accuracy                             |
| 15  | Token Expired heading vs wireframe content disagree          | PM #11 | "Expired" heading, "Expiring" content                      |

---

## Category 2: Missing Wireframes (design doc additions)

Wireframes that need to be CREATED — new content for DESIGN-FINAL-v2.md

| #   | Missing Wireframe                               | Source         | Severity | What to Create                                               |
| --- | ----------------------------------------------- | -------------- | -------- | ------------------------------------------------------------ |
| 1   | **Simplified View of every tab**                | PM #9, Eng #9  | HIGH     | Tab bar, Proposal tab, Security tab — all in simplified mode |
| 2   | **Delegate link clicked twice / already used**  | QA #3          | HIGH     | What second person sees when link already opened             |
| 3   | **Browser OAuth blocked by Conditional Access** | QA #2          | HIGH     | Error when org policy blocks popup OAuth                     |
| 4   | **Concurrent editing banner**                   | QA #4, Eng #17 | HIGH     | "Another user is editing this connector"                     |
| 5   | **Content staleness warning badge**             | QA #6          | HIGH     | "Last successful sync: 7 days ago" amber badge               |
| 6   | **Vector cleanup progress/failure**             | QA #7          | HIGH     | Progress indicator + error state for purge operation         |
| 7   | **Approve → monitoring transition**             | PM #13         | MEDIUM   | What user sees after clicking "Start Sync"                   |
| 8   | **Sites with 0 drives**                         | QA #9          | MEDIUM   | Sites discovered but no document libraries                   |
| 9   | **"Sync already in progress" state**            | QA sync #4     | LOW      | Button disabled or message when sync running                 |
| 10  | **Permission crawl failure/timeout**            | QA perm #3     | MEDIUM   | Partial permission crawl state                               |
| 11  | **Clone across different tenants**              | PM #16         | MEDIUM   | Site names don't exist in target — scope clearing UX         |
| 12  | **Public Access clone re-acknowledgment**       | PM #17         | MEDIUM   | When exactly does dialog appear during clone                 |
| 13  | **Card→table auto-switch behavior**             | Eng #15        | MEDIUM   | Mid-interaction switch, override, persistence                |

---

## Category 3: Backend / Implementation Requirements (SEPARATE doc)

These are NOT wireframe changes — they're backend systems that need to be built.

### CRITICAL (blocks implementation entirely)

| #   | Requirement                        | Source | What Needs Building                                                                                                               |
| --- | ---------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Configuration Proposal backend** | Eng #1 | ProposalModel, generation endpoints, section state machine, decisions log. NO backend exists. This is the heart of the design.    |
| 2   | **SyncRun history model**          | Eng #2 | SyncRun model with duration, doc counts, status. Currently sync history is not persisted.                                         |
| 3   | **Delegation infrastructure**      | Eng #3 | AuthDelegation model, invite URL routing, device code connection, push notifications, email sending. ZERO delegation code exists. |
| 4   | **Webhook activation**             | Eng #4 | Mount routes in server.ts, start worker, fix mock token, scheduler. Currently ALL dead code.                                      |

### HIGH

| #   | Requirement                       | Source  | What Needs Building                                               |
| --- | --------------------------------- | ------- | ----------------------------------------------------------------- |
| 5   | **Per-site sync progress**        | Eng #5  | Emit per-site events via WebSocket (currently only aggregate)     |
| 6   | **Content aggregation endpoints** | Eng #6  | MongoDB $group queries for content-type and per-site stats        |
| 7   | **Vector cleanup job**            | Eng #7  | Scheduled job to delete vectors on connector deletion (P0)        |
| 8   | **Audit event emission**          | Eng #8  | Implement onAuthEvent + ConnectorAuditEntry model                 |
| 9   | **CEL expression evaluator**      | Eng #10 | No CEL parser exists in TypeScript. Need cel-js or WASM.          |
| 10  | **Email service**                 | Eng #11 | No email infrastructure exists. 5+ wireframes show email buttons. |
| 11  | **Token health endpoint**         | Eng #12 | New GET endpoint for token expiry/refresh status                  |
| 12  | **Auto-pause on failures**        | Eng #19 | Check consecutiveFailures threshold in sync worker                |

### MEDIUM

| #   | Requirement                          | Source  |
| --- | ------------------------------------ | ------- |
| 13  | PDF generation capability            | Eng #13 |
| 14  | Config drift detection baseline      | Eng #14 |
| 15  | Simplified View preference storage   | Eng #9  |
| 16  | Test Permissions (search-as-user)    | Eng #18 |
| 17  | Discovery partial results on timeout | Eng #20 |

---

## Category 4: Edge Cases to Document (implementation notes)

Not wireframe changes — notes for developers about behavior in edge cases.

| #   | Edge Case                                           | Source           | Recommended Behavior                                            |
| --- | --------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| 1   | Wrong Client ID format                              | QA connect #1    | Inline GUID validation before submit                            |
| 2   | Tenant/Client ID mismatch                           | QA connect #2    | Specific AADSTS90002 error handling                             |
| 3   | App registration deleted (not just consent revoked) | QA connect #6    | Distinct error: "Application not found" vs "Consent revoked"    |
| 4   | Token expires during discovery                      | QA discovery #3  | Discovery worker should handle token refresh mid-operation      |
| 5   | Navigate away during discovery                      | QA discovery #4  | Save "Discovery In Progress" state to SourcesTable              |
| 6   | Modify scope but don't re-preview                   | QA proposal #1   | Stale indicator already exists — add approval gate?             |
| 7   | Browser crash during Approve & Start                | QA proposal #4   | Sync starts but UI state is stale on return                     |
| 8   | Document deleted from SP during sync                | QA sync #3       | Per-document 404 handling (currently not tracked)               |
| 9   | Delegate from wrong Azure AD tenant                 | QA delegation #5 | Specific tenant mismatch detection in delegate flow             |
| 10  | Connector creator account deactivated               | QA delegation #6 | Orphaned connector handling                                     |
| 11  | Document with no SharePoint permissions             | QA perm #1       | How "Everyone" permissions are handled in Permission-Aware mode |
| 12  | Large group (10K members)                           | QA perm #2       | Pagination + timeout handling for group resolution              |
| 13  | Scope+Filters auto-expand overlay behavior          | Eng #16          | Overlay vs push, backdrop, mobile                               |
| 14  | Concurrent editing                                  | Eng #17          | Optimistic locking or last-write-wins                           |

---

## Category 5: Security Concerns (needs discussion)

| #   | Concern                                      | Source         | Severity | Question                                                                                                                                                                                |
| --- | -------------------------------------------- | -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Delegation invite link is a bearer token** | QA CRITICAL #1 | CRITICAL | Anyone with the link can authenticate. No domain restriction, no revoke button, no access attempt audit. Should we restrict to specific email domains? Add IP logging? Make single-use? |

---

## Category 6: Deferred (future iteration)

| #   | Item                                                                 | Source | Why Defer                                  |
| --- | -------------------------------------------------------------------- | ------ | ------------------------------------------ |
| 1   | Permission mode change action from monitoring                        | PM #19 | Nice-to-have, can navigate to Security tab |
| 2   | "Edit Scope/Filters" in Overview quick actions                       | PM #18 | Can click Scope+Filters tab directly       |
| 3   | Delegation email show Permission-Aware variant as separate wireframe | PM #15 | Parenthetical note is sufficient for v1    |

---

## Eng Lead's Top Recommendation

> "Before implementation begins, produce a v1 scope document that explicitly
> separates 'shippable in v1' wireframes from 'target state' wireframes.
> The current document conflates both, which will cause implementers to either
> build too much or ship a UI that claims capabilities the backend does not have."

---

## Decision Matrix

| Category                | Count | Action                           | Owner              |
| ----------------------- | ----- | -------------------------------- | ------------------ |
| 1. UX Design Fixes      | 15    | Fix in DESIGN-FINAL-v2.md        | Design (us)        |
| 2. Missing Wireframes   | 13    | Add to DESIGN-FINAL-v2.md        | Design (us)        |
| 3. Backend Requirements | 17    | New IMPLEMENTATION-PLAN.md       | Engineering        |
| 4. Edge Cases           | 14    | Append to IMPLEMENTATION-PLAN.md | Engineering        |
| 5. Security Concerns    | 1     | Discuss before proceeding        | Product + Security |
| 6. Deferred             | 3     | Log, don't fix                   | N/A                |
