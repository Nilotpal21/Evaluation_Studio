# agents.md — packages / project-io

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

## Lifecycle Inventory — Cross-Boundary Types

This package owns the import/export contract — every type here crosses the source-of-truth boundary (DB) ↔ on-disk archive boundary ↔ git boundary, often via Studio preview UI in between. New fields routinely get dropped at one of these handoffs. **Before changing any of these, run the Omitted-Edit Audit from `.claude/agents/pr-reviewer.md`** and verify the round-trip parity tests under `src/__tests__/`.

| Type                                                           | Defined in                                                        | Boundaries crossed                                                                                                        | Past incident                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentCompanionMetadata`, `AgentPromptLibraryRefSnapshot`      | `src/agent-companion-metadata.ts`                                 | runtime save → project-io export → archive on disk → git diff/preview → studio import → runtime load                      | ABLP-791 (16 fix commits): companion metadata silently dropped at git-export boundary; tail typing was incomplete. Round-trip tests now under `src/__tests__/project-agent-draft-metadata.test.ts`. |
| `ModuleReleaseContract`, `ModuleContractDiff`                  | `src/module-release/*`                                            | export manifest → cross-project import → upgrade preview endpoint → Studio diff UI                                        | Module export/import is the canonical pattern — round-trip tests are mandatory. 101 module tests live in this package as the safety net.                                                            |
| Layer assemblers/disassemblers (`*Assembler`, `*Disassembler`) | `src/export/layer-assemblers/`, `src/import/layer-disassemblers/` | DB ↔ archive bytes (JSON / YAML) for each project layer (channels, connections, core, evals, guardrails, prompts, search) | Schema drift between assembler write and disassembler read → silent field loss. ABLP-791 hardening sweep added many of the parity tests here.                                                       |
| Behavior profile / guardrail bundle parsers                    | `src/import/import-validator.ts`, `src/guardrail-projection.ts`   | archive on disk → canonical parser (`@abl/core/parser`) → DB                                                              | 2026-04-23 entry below: project-io must use the canonical parser, not re-implement validation. Header-only validation lets malformed DSL through.                                                   |

**Rule:** Every new field on a project-layer entity needs a round-trip parity test that goes archive → folder-reader → import-validator → DB → export → folder. String-equality on the round-trip alone is insufficient (see 2026-04-23 entry).

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-22 — Reusable Agent Modules Phase 1

**Category**: architecture
**Learning**: Module export/import operations live in project-io because they are project-level I/O: exporting a module packages DSL + metadata from a project, importing unpacks into a target project. The export produces a portable archive (JSON manifest + compressed DSL payloads), and import resolves alias conflicts and creates ModulePointer records in the target project.
**Files**: `src/module-export.ts`, `src/module-import.ts`, `src/module-manifest.ts`
**Impact**: Any new cross-project data transfer features (e.g., project cloning, template export) should follow this same pattern: manifest + compressed payloads + conflict resolution on import.

**Category**: testing
**Learning**: Project-io has 78 module-related tests covering: export manifest generation, import conflict resolution, alias rewriting during import, round-trip export→import fidelity, and cross-project isolation. Tests validate that imported modules get new IDs (no ID collision across projects) and that alias conflicts are detected before write.
**Files**: `src/__tests__/module-export.test.ts`, `src/__tests__/module-import.test.ts`, `src/__tests__/module-manifest.test.ts`
**Impact**: Round-trip tests (export→import→verify) are the most valuable pattern here — they catch serialization bugs that unit tests miss.

---

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 1

**Category**: architecture
**Learning**: Added `diffModuleContracts(current, target): ModuleContractDiff` in `src/module-release/module-contract-diff.ts`. Pure function that classifies changes between two `ModuleReleaseContract` values: removed agents/tools → breaking, new required prereqs → breaking, added agents/tools → non-breaking, metadata changes → warn. Exported from `src/module-release/index.ts`. Module test count is now 101 (was 78) with 23 contract-diff tests added.
**Files**: `src/module-release/module-contract-diff.ts`, `src/__tests__/module-contract-diff.test.ts`, `src/module-release/index.ts`
**Impact**: The diff function is used by the upgrade preview endpoint (Phase 2 Sprint 2) to show users what changes between the current and target release. Keep it pure — no DB calls, no side effects.

## 2026-04-19 — ABL Contract Hardening Phase 10B

**Category**: architecture
**Learning**: Project guardrails now have two archive serializations but still only one canonical model: `.guardrail.json` and `.guardrail.yaml` are just alternate bundle encodings of the same guardrail policy object. Keep all path detection, name extraction, parsing, and serialization in `src/guardrail-projection.ts` so import/export/schema logic cannot drift on suffix handling.
**Files**: `src/guardrail-projection.ts`, `src/export/layer-assemblers/guardrails-assembler.ts`, `src/import/layer-disassemblers/guardrails-disassembler.ts`, `src/import/entity-schemas.ts`, `src/import/folder-reader.ts`, `src/import/import-validator.ts`
**Impact**: Any future ABL-facing guardrail authoring or bundle UX should lower into this same helper-backed archive contract instead of inventing another guardrail schema or sprinkling suffix checks across the package.

## 2026-04-23 — Conversation Behavior profile imports must use the canonical parser

**Category**: architecture
**Learning**: Header-only validation is not enough for behavior-profile imports. `project-io` must call `parseBehaviorProfile()` from `@abl/core/parser` so imports reject the same malformed profile DSL that Studio routes reject, including missing `PRIORITY` / `WHEN` declarations and invalid `CONVERSATION` blocks. Otherwise project import can accept artifacts that the authoring API will never save again.
**Files**: `src/import/import-validator.ts`, `src/__tests__/import-validator-v2.test.ts`, `src/__tests__/import-profiles.test.ts`
**Impact**: Future behavior-profile or ABL archive validation should delegate to the canonical parser/compiler boundary instead of re-implementing partial syntax checks inside `project-io`.

## 2026-04-23 — Roundtrip tests should prove importability, not only string preservation

**Category**: testing
**Learning**: For new ABL sections, a `project-io` roundtrip test should not stop at `buildFileMap()` plus `readFolder()` string equality. After reading the folder back, the test should also call `validateImport()` or `importProject()` so the archived DSL proves the actual import contract rather than only confirming file passthrough.
**Files**: `src/__tests__/conversation-behavior-roundtrip.test.ts`, `src/import/folder-reader.ts`, `src/import/import-validator.ts`
**Impact**: Future archive/roundtrip tests for authoring features should always include one parser/import assertion after read-back, which catches serialization that looks correct in files but fails canonical project import.

---

**Category**: bug | gotcha
**Learning**: `AUTH_CONFIG_RE = /^\s*AUTH(?:_CONFIG)?:\s*(.+)$/gim` in `module-publish-safety.ts` was designed to match `AUTH: auth_profile_ref my-profile` patterns but also matches `auth: api_key` DSL lines. The captured value `api_key` is an auth type keyword, not a secret, but the validator had no bypass for type keywords — it only skipped `auth_profile_ref` and template patterns. When extending the `AUTH_CONFIG_RE` pattern or adding new DSL directives that follow the `auth: <value>` shape, ensure known keyword values are added to `AUTH_TYPE_KEYWORDS`. This Set is intentionally local — `VALID_AUTH_TYPES` in `project-tool-validator.ts` is not exported and the cross-package import cost exceeds the duplication cost for 6 fixed values.
**Files**: `src/module-release/module-publish-safety.ts`
**Impact**: Any new DSL auth type keyword (e.g. a phase-4 auth scheme name) must be added to `AUTH_TYPE_KEYWORDS` or publish will incorrectly block tools using that auth type in an agent context.
