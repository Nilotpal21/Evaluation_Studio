# SDLC Log: PII Detection HLD

**Phase**: 3 - High-Level Design
**Date**: 2026-03-22
**Output**: `docs/specs/pii-detection.hld.md`

---

## Clarifying Questions & Decisions

### Architecture & Data Flow

| #   | Question                               | Classification | Answer                                                                                                   |
| --- | -------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | What architecture pattern is used?     | ANSWERED       | Library pattern in compiler + route/service/repo in runtime. No separate microservice.                   |
| 2   | How does data flow through the system? | ANSWERED       | Input: PII guard hook -> detect -> tokenize. Output: filter -> render per consumer. Streaming: buffer.   |
| 3   | What is the deployment topology?       | ANSWERED       | PII code is embedded in compiler package (shared) and runtime (execution layer). No separate deployment. |

### Integration & Dependencies

| #   | Question                                     | Classification | Answer                                                                                               |
| --- | -------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| 4   | Which existing services does this depend on? | ANSWERED       | Encryption service (vault persistence), MongoDB (patterns + audit), NLU pipeline (guard hook wiring) |
| 5   | External dependencies?                       | ANSWERED       | None. Entirely self-contained regex detection. No external APIs.                                     |
| 6   | Breaking changes to existing APIs?           | ANSWERED       | None. All additions are opt-in. Config defaults preserve backward compatibility.                     |

### Risk & Migration

| #   | Question                            | Classification | Answer                                                                                                                     |
| --- | ----------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 7   | What is the biggest technical risk? | DECIDED        | Regex false positives for phone detection (10-digit minimum mitigates). ReDoS via custom patterns (blocked by validation). |
| 8   | Migration requirements?             | ANSWERED       | None. Feature is additive. No schema migrations needed. Existing sessions unaffected.                                      |
| 9   | Rollback strategy?                  | DECIDED        | Disable via `pii_redaction.enabled = false`. All detection stops. No data cleanup needed.                                  |

---

## Alternatives Analysis

Three alternatives considered:

1. **Destructive redaction only** (Simple but blocks tool access -- rejected)
2. **External PII service** (Higher accuracy but adds latency + dependency -- deferred)
3. **Regex + vault + pluggable registry** (Selected -- best balance of latency, reversibility, extensibility)

Key rationale: The pluggable registry architecture allows upgrading from regex to ML detection without architectural changes. The vault approach preserves tool access while protecting other consumers.

---

## Self-Audit Checklist

- [x] Problem statement refined from feature spec
- [x] 3 alternatives considered with pros/cons/effort
- [x] System context diagram showing all components
- [x] Component diagram with file paths
- [x] Data flow documented for all 5 paths (input, output, tool, streaming, audit)
- [x] All 12 architectural concerns addressed
- [x] Data model documented
- [x] API surface documented with auth requirements
- [x] Risks identified with mitigations
- [x] Future considerations documented
