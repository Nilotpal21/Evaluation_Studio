# SDLC Log: PII Detection Feature Spec

**Phase**: 1 - Feature Spec
**Date**: 2026-03-22
**Output**: `docs/features/pii-detection.md`

---

## Clarifying Questions & Decisions

### Detection Architecture

| #   | Question                                 | Classification | Answer                                                                                                                                |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What PII types are currently supported?  | ANSWERED       | 5 built-in: email, phone, SSN, credit_card, ip_address. Code: `pii-detector.ts:48-90`                                                 |
| 2   | How are custom patterns registered?      | ANSWERED       | Via `loadProjectPIIPatterns()` in `pattern-loader.ts`, loaded from DB at session init, registered as `RegexPIIRecognizer` in registry |
| 3   | What validation exists for custom regex? | ANSWERED       | Compilation check, length limit (2048), catastrophic backtracking detection in `pattern-service.ts:25-31`                             |

### Tokenization & Rendering

| #   | Question                             | Classification | Answer                                                                                                                                                               |
| --- | ------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | What consumer rendering modes exist? | ANSWERED       | 5 modes: original, masked, redacted, tokenized, random. Resolution chain: per-consumer override -> pattern default -> builtin defaults. Code: `pii-vault.ts:339-366` |
| 5   | How is vault persistence handled?    | ANSWERED       | Serialize to JSON, encrypt with AES-256-GCM via `VaultEncryptionService`, decrypt on session restore. Code: `encrypted-vault.ts`                                     |
| 6   | What are the vault capacity limits?  | ANSWERED       | 10K tokens max with oldest-first eviction (`MAX_VAULT_TOKENS = 10_000`). Code: `pii-vault.ts:22`                                                                     |

### Runtime Integration

| #   | Question                                   | Classification | Answer                                                                                                                                                                       |
| --- | ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | How is PII detection triggered at runtime? | ANSWERED       | Input: `createPIIGuardHook()` in `pii-guard.ts` wired as NLU beforeExecute hook. Output: `filterOutputPII()` in `output-pii-filter.ts` called after guardrail evaluation     |
| 8   | How does context-aware exemption work?     | ANSWERED       | `resolveGatherExemptions()` maps active gather field names to PII types via `FIELD_NAME_TO_PII_TYPE` and `ENTITY_TYPE_TO_PII_TYPE` lookup tables. Code: `pii-guard.ts:21-47` |
| 9   | What is the streaming PII buffer size?     | ANSWERED       | 40 characters trailing buffer. Code: `streaming-pii-buffer.ts:27`                                                                                                            |

### Studio UI & API

| #   | Question                                  | Classification | Answer                                                                                                                                                                          |
| --- | ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | What Studio UI exists for PII management? | ANSWERED       | `PIIProtectionTab.tsx` (project settings tab) and `PIIPatternFormDialog.tsx` (CRUD modal with live testing)                                                                     |
| 11  | What API routes exist?                    | ANSWERED       | 6 routes mounted at `/api/projects/:projectId/pii-patterns`: GET /, POST /, POST /test, GET /:id, PUT /:id, DELETE /:id. All with auth + rate limiting. Code: `pii-patterns.ts` |
| 12  | What permissions are required?            | ANSWERED       | `pii-pattern:read` for list/get/test, `pii-pattern:write` for create/update/delete. Code: `pii-patterns.ts:72,109,179,237,282,363`                                              |

### Compliance & Security

| #   | Question                          | Classification | Answer                                                                                                                                                                                                     |
| --- | --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | How is audit logging implemented? | ANSWERED       | `PIIAuditLogger` with 100-entry buffer, 5s flush interval, fire-and-forget. MongoDB adapter via `MongoDBPIIAuditStore`. TTL index for 90-day retention. Code: `pii-audit.ts`, `pii-audit-store-adapter.ts` |
| 14  | How is sandbox security enforced? | ANSWERED       | `buildSandboxedValidator()` compiles validator as `RegExp` only -- no `vm.Script`, no `eval`. Catastrophic backtracking patterns rejected. 50ms timeout logged. Code: `pattern-loader.ts:131-156`          |
| 15  | How is trace data scrubbed?       | ANSWERED       | `scrubToolCallData()` in `trace-scrubber.ts` deep-clones data, applies `redactPII()` to all string values, redacts sensitive headers and secret patterns                                                   |

---

## Files Searched

### Core Implementation

- `packages/compiler/src/platform/security/pii-detector.ts` -- core detection engine
- `packages/compiler/src/platform/security/pii-vault.ts` -- tokenization vault
- `packages/compiler/src/platform/security/pii-recognizer-registry.ts` -- pluggable recognizer registry
- `packages/compiler/src/platform/security/pii-audit.ts` -- audit logger
- `packages/compiler/src/platform/security/streaming-pii-buffer.ts` -- streaming buffer
- `packages/compiler/src/platform/security/encrypted-vault.ts` -- encrypted vault
- `packages/compiler/src/platform/security/index.ts` -- module exports
- `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts` -- guardrail provider
- `packages/compiler/src/platform/guardrails/provider-registry.ts` -- provider registry
- `packages/compiler/src/platform/guardrails/action-executors.ts` -- redact/fix/filter actions
- `packages/compiler/src/platform/guardrails/action-applier.ts` -- action application
- `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` -- context-aware PII guard
- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` -- trace scrubbing

### Runtime

- `apps/runtime/src/routes/pii-patterns.ts` -- CRUD routes
- `apps/runtime/src/repos/pii-pattern-repo.ts` -- MongoDB repository
- `apps/runtime/src/services/pii/pattern-service.ts` -- validation service
- `apps/runtime/src/services/pii/pattern-loader.ts` -- DB pattern loader
- `apps/runtime/src/services/execution/output-pii-filter.ts` -- output filter
- `apps/runtime/src/services/execution/pii-audit-singleton.ts` -- audit singleton
- `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` -- MongoDB adapter

### Database

- `packages/database/src/models/pii-pattern.model.ts` -- PIIPattern model
- `packages/database/src/models/pii-audit-log.model.ts` -- PIIAuditLog model
- `packages/database/src/models/project-runtime-config.model.ts` -- IPIIRedactionConfig

### Studio

- `apps/studio/src/components/settings/PIIProtectionTab.tsx` -- settings tab
- `apps/studio/src/components/settings/PIIPatternFormDialog.tsx` -- CRUD dialog

### Tests

- 14 test files covering unit, integration, and E2E scenarios

### Prior Design Docs

- `docs/plans/2026-03-08-pii-phase2-plan.md`
- `docs/plans/2026-03-08-pii-phase2-spec.md`
- `docs/plans/2026-03-09-pii-enhancements-design.md`

---

## Self-Audit Checklist

- [x] All 18 template sections populated
- [x] All functional requirements grounded in code evidence
- [x] All file paths verified against actual codebase
- [x] Integration matrix references real code touchpoints
- [x] Non-functional concerns include specific constants and limits from code
- [x] Gaps identified with severity and status
- [x] Test inventory matches actual test files found in codebase
- [x] No invented behavior -- all claims traceable to source files
