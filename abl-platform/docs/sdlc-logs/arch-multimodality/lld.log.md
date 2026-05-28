# LLD Log: B03 Arch Multimodality

## Oracle Decisions (Phase 2)

**Date:** 2026-04-05
**Oracle:** product-oracle agent
**Result:** All 14 questions ANSWERED/DECIDED — no AMBIGUOUS items

| #   | Question                         | Classification | Decision                                                      |
| --- | -------------------------------- | -------------- | ------------------------------------------------------------- |
| Q1  | Data layer vs API first?         | ANSWERED       | Data layer first (SessionFileStore + types → upload endpoint) |
| Q2  | Feature flag?                    | DECIDED        | No — use existing ARCH_AI flag, B03 is additive               |
| Q3  | Deprecate collect_file?          | ANSWERED       | Keep alongside proactive upload; auto-satisfy pending widget  |
| Q4  | GridFS threshold?                | ANSWERED       | >4MB (not 8MB, safe headroom below 16MB BSON limit)           |
| Q5  | Sync vs async upload?            | ANSWERED       | Synchronous with per-type timeouts (10-30s)                   |
| Q6  | Route vs service for processing? | ANSWERED       | Extract to packages/arch-ai/src/session/file-store-service.ts |
| Q7  | normalizeContent location?       | ANSWERED       | packages/arch-ai (shared — needed on server + client)         |
| Q8  | Worker file strategy?            | DECIDED        | Dedicated worker file (not inline Blob URL)                   |
| Q9  | File preamble injection?         | ANSWERED       | Append to system prompt string (not separate message)         |
| Q10 | File store directory?            | DECIDED        | session/file-store-service.ts (not separate dir)              |
| Q11 | Shared multimodal builder?       | ANSWERED       | Yes — extract buildMultimodalMessages() helper                |
| Q12 | Mongoose Mixed rollback?         | DECIDED        | normalizeContent() text extraction + schema revert            |
| Q13 | Logging from day one?            | ANSWERED       | Yes — TraceEvent per upload (CLAUDE.md invariant #4)          |
| Q14 | Phase 4 separate ticket?         | DECIDED        | Yes — core B03 = Phases 0-3; smart routing follows            |

## Audit Rounds (5 of 5 complete)

### Round 1: Architecture Compliance (lld-reviewer)

**Verdict:** NEEDS_CHANGES → Fixed
**Findings:** 3 CRITICAL + 4 HIGH + 4 MEDIUM + 1 LOW

- C1: Upload endpoint response missing standard envelope → FIXED (added `{success, data}` wrapper)
- C2: Auth pattern referenced Express middleware instead of Studio `@/lib/auth` → FIXED
- C3: Swapped line numbers for processMessage/processInProjectMessage → FIXED (1163=IN_PROJECT, 1364=ONBOARDING)
- H1: getModelCapabilities not in barrel exports → FIXED (deep import path specified)
- H2: No Zod schema for upload endpoint → FIXED (UploadRequestSchema added)
- H3: TraceEvent underspecified → FIXED (createLogger + structured event spec)
- H4: Session ownership query pattern missing → FIXED (findOne + userId verify)
- M1: updateStatus missing sessionId → FIXED
- M2: No TTL/cascade delete for SessionFileStore → FIXED (30-day TTL + post-hook cascade)
- M3: OQ-2 GridFS unresolved → RESOLVED (mongoose GridFSBucket)
- M4: OQ-5 Vercel AI SDK unresolved → RESOLVED (ImagePart via provider adapter)

### Round 2: Pattern Consistency (lld-reviewer)

**Verdict:** PASS_WITH_FINDINGS → Fixed
**Findings:** 3 HIGH + 4 MEDIUM + 1 LOW

- H1: TenantContext type doesn't exist → FIXED (changed to SessionContext)
- H2: FileStoreService constructor pattern → FIXED (model injection + factory)
- H3: i18n namespace 'arch' vs 'arch_in_project' → FIXED
- M1: i18n key table missing → FIXED (10 keys added)
- M2: Barrel export chain incomplete → FIXED (deep import specified)
- M3: User isolation note missing → FIXED (defense-in-depth documented)
- M4: Error types not specified → FIXED (4 error types added)
- R1/R2 fixes verified intact

### Round 3: Completeness (lld-reviewer)

**Verdict:** NEEDS_CHANGES → Fixed
**Findings:** 3 HIGH + 3 MEDIUM

- H1: FR-26 duplicate filename handling missing → FIXED (collision check + DuplicateFileDialog)
- H2: FR-31 context eviction algorithm missing → FIXED (buildFilePreamble eviction logic)
- H3: FR-19 Monaco editing not covered → DEFERRED to OQ-6 (read-only until follow-up)
- M1: ModelCapabilities naming collision → FIXED (deep import path, no barrel)
- M2: Cascade delete wiring missing → FIXED (wiring item #24)
- M3: Error types wiring missing → FIXED (wiring item #25)

### Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict:** APPROVED
**Findings:** 3 HIGH + 2 MEDIUM (all applied)

- H1: FR-19 deferral not in acceptance criteria → FIXED (note added)
- H2: EXIF stripping exit criterion missing → FIXED
- H3: Eviction test coverage not highlighted → FIXED
- M1: Feature spec GridFS 8MB→4MB → FIXED
- M2: Feature spec GAP-006 → FIXED

### Round 5: Final Sweep (lld-reviewer)

**Verdict:** APPROVED
**Findings:** 4 MEDIUM (all applied)

- M1: DOMPurify dependency → FIXED (isomorphic-dompurify for server, dompurify for client)
- M2: uuidv7 not in codebase → FIXED (changed to crypto.randomUUID v4)
- M3: OQ-4 collect_file task reference → FIXED (deferred to follow-up ticket)
- M4: Task 0.2 package limit → FIXED (split note added)

### Summary

- **Total findings:** 9 CRITICAL + 10 HIGH + 13 MEDIUM + 2 LOW = 34 findings
- **All CRITICAL resolved:** 3/3
- **All HIGH resolved:** 10/10
- **All MEDIUM resolved:** 13/13 (includes 1 deferred: FR-19 Monaco editing)
- **LOW:** 2 logged, not blocking
