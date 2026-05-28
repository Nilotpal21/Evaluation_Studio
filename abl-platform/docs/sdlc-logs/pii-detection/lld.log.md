# SDLC Log: PII Detection LLD

**Phase**: 4 - Low-Level Design
**Date**: 2026-03-22
**Output**: `docs/plans/pii-detection.lld.md`

---

## Clarifying Questions & Decisions

### Architecture & Implementation

| #   | Question                                             | Classification | Answer                                                                                                                                                    |
| --- | ---------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What is the primary detection mechanism?             | ANSWERED       | Regex-based with 5 built-in patterns + Luhn/range validators. Sub-ms latency. Code: `pii-detector.ts`                                                     |
| 2   | How is tokenization implemented?                     | ANSWERED       | In-memory `PIIVault` with `{{PII:<type>:<uuid>}}` tokens. 10K max with LRU eviction. Encrypted serialization for session persistence.                     |
| 3   | What rendering modes are supported?                  | ANSWERED       | 5 modes: original, masked, redacted, tokenized, random. Resolution chain: token-level → type-level → consumer-level → default. Code: `pii-vault.ts`       |
| 4   | How are custom patterns managed?                     | ANSWERED       | Project-scoped CRUD API (6 endpoints) + Studio UI. Regex validation + catastrophic backtracking detection. Code: `pii-patterns.ts`, `pattern-service.ts`  |
| 5   | What sandbox protections exist for custom patterns?  | ANSWERED       | Regex-only validators (no vm.Script/eval). Backtracking pattern rejection via `CATASTROPHIC_BACKTRACKING_PATTERNS`. Max regex length 2048.                |
| 6   | How does streaming PII detection work?               | ANSWERED       | 40-char trailing buffer in `StreamingPIIBuffer`. Safe prefix emitted with PII redacted. Flush on stream end.                                              |
| 7   | What is the audit persistence strategy?              | ANSWERED       | Buffered in-memory (100 entries, 5s flush). Fire-and-forget async writes to MongoDB. 90-day TTL via MongoDB TTL index. Code: `pii-audit.ts`               |
| 8   | How does the recognizer registry work?               | ANSWERED       | 3 tiers (regex, ml, custom). 50 max recognizers. Built-in recognizers permanently protected. Custom loaded per-project at session init.                   |
| 9   | How is vault data encrypted for session persistence? | ANSWERED       | AES-256-GCM with tenant-scoped keys via `VaultEncryptionService` interface. Encrypt/decrypt fail-open (return null). Code: `encrypted-vault.ts`           |
| 10  | What are the key integration points?                 | ANSWERED       | Guardrails (BuiltinPIIProvider), NLU pipeline (pii-guard hook), session store (serialize/deserialize), trace system (scrubToolCallData), execution output |

### Module Boundaries

| #   | Question                                         | Classification | Answer                                                                                                                                    |
| --- | ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Where does detection code live vs. runtime code? | ANSWERED       | Detection/vault/registry in `packages/compiler/src/platform/security/`. Runtime CRUD/loading in `apps/runtime/src/services/pii/`.         |
| 12  | How are guardrails integrated?                   | ANSWERED       | `BuiltinPIIProvider` wraps `detectPII()` as Tier 1 zero-cost guardrail. Auto-registered as permanent in provider registry.                |
| 13  | What is the context-aware exemption mechanism?   | ANSWERED       | `resolveGatherExemptions()` maps active gather fields to PII types. `detectPIISelective()` detects ALL types but redacts non-exempt only. |

---

## Design Decisions Summary

7 design decisions documented in LLD:

1. **Regex over ML/NER** -- Sub-ms latency, zero dependencies, deterministic
2. **Reversible tokenization over destructive** -- Tools need original values
3. **In-memory vault over Redis/DB** -- Session-scoped, sub-ms access
4. **Regex-only validators over vm.Script** -- Security: no arbitrary JS
5. **Buffered audit over synchronous writes** -- Non-blocking request path
6. **Module-level random cache** -- Simpler, consistent across sessions
7. **40-char streaming buffer** -- Covers longest PII pattern

---

## Implementation Phases

The LLD documents 3 historical implementation phases:

- **Phase 1**: Core detection library (detector, vault, registry, audit, streaming buffer, encrypted vault)
- **Phase 2**: Runtime integration (pattern CRUD API, pattern loader, output filter, guardrail wiring, NLU guard hook)
- **Phase 3**: Studio UI + polish (PIIProtectionTab, PIIPatternFormDialog, trace scrubber, DSL examples)

All phases are marked as completed (BETA status).

---

## Gaps Identified

Key implementation gaps documented:

| Gap     | Description                                     | Severity |
| ------- | ----------------------------------------------- | -------- |
| GAP-001 | No real-server E2E tests for pattern CRUD API   | HIGH     |
| GAP-002 | Module-level random cache not session-scoped    | MEDIUM   |
| GAP-003 | No ML/NER tier wired in recognizer registry     | LOW      |
| GAP-004 | No international PII patterns (IBAN, NHS, etc.) | LOW      |

---

## Self-Audit Checklist

- [x] Design decision log with rationale and rejected alternatives
- [x] Key interfaces and types documented from source code
- [x] Module boundary table with all 14 modules and dependencies
- [x] File-level change map with LOC estimates for all implementation + test files
- [x] 3 implementation phases with task-level tracking
- [x] Wiring checklist with 17 verified integration points
- [x] Test plan covering unit, integration, E2E, and E2E gaps
- [x] Rollback strategy (4 steps)
- [x] Constants & limits reference table (12 constants with file locations)
