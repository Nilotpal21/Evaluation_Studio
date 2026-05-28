# Phase 1: Feature Spec — Contacts Management

> **Date:** 2026-03-23
> **Feature:** #49 Contacts Management

## Summary

Generated feature spec for the Contacts Management feature by analyzing existing codebase implementation across 16 source files spanning domain, use-case, infrastructure, route, service, and WebSocket layers.

## Key Findings

- **23 functional requirements** identified (all IMPLEMENTED in code)
- **8 non-functional requirements** documented
- **8 user stories** covering admin CRUD, identity resolution, merge workflows, GDPR compliance, and SDK integration
- **10 known gaps** identified, including 2 HIGH-severity tenant isolation violations in MongoContactStore

## Audit Findings

| #   | Severity | Finding                                                       | Resolution           |
| --- | -------- | ------------------------------------------------------------- | -------------------- |
| 1   | HIGH     | `MongoContactStore.delete()` bypasses tenant isolation        | Documented as GAP-01 |
| 2   | HIGH     | `MongoContactStore.touchLastSeen()` bypasses tenant isolation | Documented as GAP-02 |
| 3   | MEDIUM   | Routes use `console.error` instead of structured logger       | Documented as GAP-03 |
| 4   | MEDIUM   | Merge routes lack RBAC permission checks                      | Documented as GAP-04 |
| 5   | HIGH     | Zero E2E tests for entire contacts feature                    | Documented as GAP-09 |

## Files Analyzed

- `packages/database/src/models/contact.model.ts` -- Mongoose schema
- `apps/runtime/src/routes/contacts.ts` -- CRUD routes (7 endpoints)
- `apps/runtime/src/routes/contact-merge.ts` -- Merge/GDPR routes (3 endpoints)
- `apps/runtime/src/routes/merge-suggestions.ts` -- Suggestion workflow (2 endpoints)
- `apps/runtime/src/contexts/contact/` -- Domain layer (16 files)
- `apps/runtime/src/services/stores/mongo-contact-store.ts` -- Legacy store
- `apps/runtime/src/services/contact-context-service.ts` -- Redis+Mongo cache
- `apps/runtime/src/websocket/sdk-handler-contact-linking.ts` -- SDK integration
- `apps/runtime/src/validation/contact-validation.ts` -- Input validation
- `apps/runtime/src/services/audit-helpers.ts` -- Audit event helpers
- `apps/runtime/src/server.ts` -- Route wiring

## Artifact

`docs/features/contacts.md`
