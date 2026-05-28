# Best-Effort Import/Export Diagnostics, Canonical Identities & Strict File Contracts

**Date:** 2026-03-27
**Status:** Draft
**Scope:** `packages/project-io`, Studio import preview/apply routes, Studio agent save/edit routes, V2 export canonicalization and validation

## Problem

The current V2 flow conflates three separate concerns:

- whether we can parse enough of a bundle to build a preview
- whether the bundle is structurally safe to apply
- whether the user should see warnings or errors before proceeding

That coupling creates four failures.

1. **Real import problems are hidden in preview.**
   - Tool parse failures are collected but dropped from preview validity and UI rendering.
   - Compilation diagnostics are only run for `.agent.abl` files, so `.agent.yaml` imports get less feedback.
   - The UI only renders a subset of diagnostics and treats “has errors” as “must reject.”

2. **V2 versions the archive wrapper, but not the payload contract inside each file.**
   - The ZIP is structurally V2.
   - The contents are still passed through from storage in ways that do not satisfy the importer’s canonical file expectations.

3. **Agent identity can drift across DB name, file path, manifest key, and declared DSL/YAML name.**
   - That drift is persisted today because Studio save/edit routes update `dslContent` without enforcing name consistency.
   - Export then serializes the drift instead of normalizing it.

4. **V2 export can emit misleading file extensions.**
   - `.agent.yaml` can contain legacy ABL.
   - `.tools.abl` can contain a single-tool snippet instead of a canonical `TOOLS:` file.

## Why Non-YAML `.agent.yaml` Exists Today

V2 export currently treats `dslFormat` as a filename hint, not a hard serialization contract.

- Studio export always requests `dslFormat = 'yaml'`.
- `LayerQueryContext` only carries that flag; it does not carry a serializer or validator.
- `CoreAssembler` writes `agent.dslContent` directly to `agents/*.agent.yaml`.
- `exportProjectV2()` merges the files and returns them without validating that `.agent.yaml` contents are actually YAML.

So if the stored source text is legacy ABL, the V2 archive still gets a `.agent.yaml` filename. That is a bug in the export boundary, not an intended format feature.

## Parser/Compiler Boundary Clarification

The parser/compiler are not making the same mistake as export, but they are also not currently enforcing the export contract.

- `parseYamlABL()` is YAML-strict.
- `parseAgentBasedABL()` is content-aware. If the content looks like YAML, it delegates to the YAML parser. Otherwise it parses legacy ABL.
- `validateABL()` uses `parseAgentBasedABL()` on source text and therefore validates the content, not the file extension.

That means the parser/compiler are:

- **strict about syntax of the content they parse**
- **agnostic about whether a `.agent.yaml` file was supposed to be YAML**

This distinction is important:

- import preview should stay mostly content-aware so it can warn and proceed with imperfect external bundles
- export must become extension-aware and contract-strict at the **file** level, while remaining best-effort at the **bundle** level

## Why V2 Tool Files Still Broke

`ProjectTool.dslContent` is stored as a one-tool source snippet because Studio editing and the `ProjectTool` model are one-tool-per-document. That internal storage shape is valid for editing, but it is **not** the canonical archive contract for `.tools.abl`.

The current V2 exporter writes that internal single-tool representation directly to `tools/*.tools.abl`, while import expects `.tools.abl` to be a canonical tool-file document with a `TOOLS:` container.

The bug is not that single-tool storage exists. The bug is that V2 export confuses the internal storage contract with the external archive contract.

## Architectural Principles

1. **Best effort on both ingress and egress.**
   - Import should accept imperfect bundles, surface all issues, and let the user explicitly proceed past non-blocking problems.
   - Export should always try to produce a self-consistent bundle instead of using project health as a gate.
   - When the preferred format cannot be produced, export should downgrade to another honest representation or emit a recovery artifact.

2. **One canonical identity per entity.**
   - File paths and manifest keys are projections of identity, not competing sources of truth.

3. **File extension is a contract.**
   - `*.agent.yaml` must contain strict YAML agent source.
   - `*.agent.abl` must contain strict ABL agent source.
   - `*.tools.abl` must contain strict canonical tool-file ABL.
   - If a source cannot satisfy one of those contracts, it must be exported under a different, explicit recovery format rather than mislabeled.

4. **No silent fallbacks.**
   - Every normalization, alias resolution, stub, skip, or repair plan must be visible in preview.

5. **Semantic diagnostics and format correctness are separate concerns.**
   - A file may be syntactically serializable but still have compile warnings or errors.
   - Import should show those semantic diagnostics without forcing rejection.
   - Export should enforce per-file format correctness even if semantic diagnostics are merely warnings.

6. **Export must self-validate and degrade before failing.**
   - We should not hand users a V2 bundle that our own importer would later “repair” or partially ignore.
   - Export should only fail for infrastructure or internal unrecoverable conditions, not because user content has warnings or broken logic.

## Goals

- Make preview exhaustive and trustworthy.
- Allow users to proceed past non-blocking tool and compilation issues after explicit acknowledgement.
- Eliminate hidden fallbacks during apply.
- Define and enforce canonical agent identity rules.
- Make V2 export emit strictly correct per-file payloads without blocking export for ordinary project issues.
- Preserve user content during export even when a strict canonical file cannot be produced.
- Preserve backward compatibility for importing older imperfect bundles.

## Non-Goals

- Rejecting every import bundle with semantic compile issues.
- Rejecting export because a project has compile errors, warnings, or other ordinary authoring issues.
- Auto-fixing arbitrary user logic or unresolved references.
- Introducing partial apply by issue subset in this phase.
- Rewriting immutable historical artifacts such as prior deployments or release snapshots.

## Decision Summary

1. Introduce first-class structured issues for import and export.
2. Replace the overloaded preview `valid` semantics with `canApply`, `requiresAcknowledgement`, `issues`, and `plannedFallbacks`.
3. Keep agent parse/compile issues and tool parse issues non-blocking on import by default.
4. Require `previewDigest + acknowledgedIssueIds` for warn-and-proceed apply.
5. Define canonical persisted identity invariants for agents, tools, and `entryAgentName`.
6. Reject implicit agent renames in normal save/edit routes; add an explicit rename transaction for intentional renames.
7. Keep internal storage contracts distinct from export file contracts.
8. Make V2 export perform strict per-file serialization and validation; no “keep original DSL under `.yaml` extension” fallback.
9. When the preferred format cannot be emitted, downgrade to another strict format or a recovery artifact instead of failing user export.
10. Add export self-validation and an export report so a returned V2 archive is self-consistent and loss-aware.

## Design

## 1. Structured Issue Model

Add a shared base issue shape in `packages/project-io/src/types.ts`:

```ts
export type IssueSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticIssue {
  id: string;
  code: string;
  severity: IssueSeverity;
  blocking: boolean;
  stage: string;
  category:
    | 'input'
    | 'manifest'
    | 'identity'
    | 'integrity'
    | 'dependency'
    | 'agent_parse'
    | 'agent_compile'
    | 'agent_format'
    | 'tool_parse'
    | 'tool_format'
    | 'tool_fallback'
    | 'cross_layer'
    | 'export_contract';
  summary: string;
  detail?: string;
  file?: string;
  line?: number;
  entityType?: 'agent' | 'tool' | 'project' | 'manifest';
  entityName?: string;
  suggestedAction?: string;
}

export interface ImportIssue extends DiagnosticIssue {
  flow: 'import';
  stage: 'normalize' | 'read' | 'validate' | 'diagnose' | 'plan' | 'apply';
}

export interface ExportIssue extends DiagnosticIssue {
  flow: 'export';
  stage: 'read' | 'normalize' | 'serialize' | 'validate';
}
```

### Export outcome model

Export should report how complete the bundle is, without turning user-content problems into hard failures.

```ts
export interface ExportMaterialization {
  entityType: 'agent' | 'tool';
  entityName: string;
  status: 'canonical' | 'downgraded' | 'recovery';
  preferredFormat?: 'yaml' | 'abl';
  actualFormat?: 'yaml' | 'abl' | 'recovery';
  path: string;
  causedByIssueIds: string[];
}

export interface ExportReport {
  bundleStatus: 'complete' | 'degraded' | 'recovery';
  issues: ExportIssue[];
  materializations: ExportMaterialization[];
}
```

### Blocking vs non-blocking

`severity` answers “how serious is this for the user?”

`blocking` answers “can we still compute a deterministic and safe plan?”

This remains the key separation.

### Import blocking issues

These remain hard blockers:

- unsafe paths or path traversal
- oversized payloads
- invalid `project.json` / `abl.lock`
- ambiguous agent identity resolution
- canonical-name collisions after normalization
- missing required layer prerequisites
- unresolved mappings that make apply indeterminate

### Import non-blocking issues

These are visible but ignorable after acknowledgement:

- agent parse errors
- agent compile errors
- YAML/ABL extension-content mismatches
- tool parse failures
- legacy single-tool `.tools.abl` inputs
- manifest key vs declared agent name mismatch when resolution is unambiguous
- entry-agent alias resolution
- lockfile SHA mismatches

### Export blocking issues

User-content issues should not normally block export.

`blocking` for export is reserved for cases where the exporter cannot produce any self-consistent bundle even after downgrade or recovery handling:

- source data cannot be read
- archive packaging fails
- manifest or export report cannot be emitted
- internal export validation fails after all downgrade/recovery paths have been attempted

Semantic compile diagnostics, serialization downgrades, and recovery artifacts should all remain non-blocking export issues.

## 2. Preview Contract

Extend `ImportPreviewV2`:

```ts
export interface ImportPreviewV2 {
  canApply: boolean;
  requiresAcknowledgement: boolean;
  previewDigest: string;
  issueCounts: {
    blocking: number;
    errors: number;
    warnings: number;
    info: number;
  };
  issues: ImportIssue[];
  plannedFallbacks: ImportFallback[];

  // retained temporarily for compatibility
  valid: boolean;
  formatVersion: '1.0' | '2.0';
  layers: LayerName[];
  layerChanges: ...;
  agentChanges: ...;
  toolChanges: {
    added: string[];
    modified: string[];
    removed: string[];
    normalized?: string[];
    stubbed?: string[];
    skipped?: string[];
  };
  ...
}
```

### Semantics

- `success` means preview generation completed.
- `canApply` means there are no blocking issues.
- `requiresAcknowledgement` means apply is allowed only after explicit user confirmation.
- `valid` is kept for one release as an alias of `canApply`.

## 3. Planned Fallbacks

Preview must explicitly describe what the importer will do when it accepts imperfect input.

```ts
export interface ImportFallback {
  id: string;
  type:
    | 'normalize_legacy_tool_file'
    | 'normalize_agent_format_mismatch'
    | 'create_tool_stub'
    | 'skip_tool_file'
    | 'resolve_agent_alias'
    | 'resolve_entry_agent_alias'
    | 'canonicalize_imported_agent_identity';
  blocking: boolean;
  summary: string;
  entityName?: string;
  file?: string;
  causedByIssueIds: string[];
}
```

Examples:

- `normalize_legacy_tool_file`: a single-tool file was wrapped into an in-memory `TOOLS:` container for parsing.
- `normalize_agent_format_mismatch`: a `.agent.yaml` file actually contained strict legacy ABL and was parsed via content detection.
- `canonicalize_imported_agent_identity`: manifest key `afg_supervisor` and file stem `afg_supervisor` will be persisted as canonical agent name `AFG_Supervisor`.

## 4. Canonical Identity Model

## 4.1 Persisted agent identity invariants

Within project state, the canonical identity is:

- `ProjectAgent.name`

The following must agree with it once data is persisted or exported:

- the declared `AGENT:` / `SUPERVISOR:` name inside source text when recoverable
- `Project.entryAgentName`
- manifest agent keys
- manifest `entry_agent`

File stems are not identities. They are deterministic projections of canonical names.

### Export source of truth for persisted projects

For export of an existing project, the canonical identity source is the persisted runtime state:

- `ProjectAgent.name`
- `Project.entryAgentName`

Declared names inside authoring source are inputs to normalization, not competing identities.

That means export should:

- treat the DB/runtime name as canonical
- rewrite top-level declared names to match during serialization
- emit issues when source text previously drifted from persisted identity

This is intentionally different from external import, where we must infer canonical identity from an imperfect bundle.

## 4.2 File naming

Agent and tool file paths are derived from canonical names using a deterministic slugifier.

When two canonical names normalize to the same slug:

- do **not** use order-dependent `_2`, `_3` suffixes
- append a stable short hash derived from the canonical name

Example:

- `AFG_Supervisor` -> `agents/afg_supervisor.agent.yaml`
- conflicting second name -> `agents/afg_supervisor__7f3a.agent.yaml`

This keeps exports stable across ordering differences.

## 4.3 Write-path enforcement

Normal save/edit routes must prevent identity drift without blocking routine authoring.

### Rule

`PUT /dsl` and surgical edit routes:

- may continue to allow parse/compile-broken working content
- must **not** allow the declared top-level agent name to drift from the stored agent identity

### Implementation approach

Add a shared helper, e.g. `extractDeclaredAgentIdentity(source: string)`, that:

1. tries content-aware parse first
2. falls back to a lightweight header extraction for partially broken files

If the extracted declared name differs from the stored `ProjectAgent.name`:

- reject with `409 AGENT_RENAME_REQUIRED`
- include the current name, proposed name, and an instruction to use the explicit rename flow

This stops the current source of drift without turning the editor into a compile gate.

## 4.4 Explicit rename transaction

Introduce a dedicated rename flow, e.g. `POST /api/projects/:id/agents/:agentId/rename`.

The rename transaction should:

1. preview affected mutable project records
2. update `ProjectAgent.name`
3. rewrite the top-level declared name in the agent source
4. update `Project.entryAgentName` when it points to the renamed agent
5. update mutable project-scoped records keyed by agent name
6. AST-rewrite structured cross-agent references where safe

If safe rewrite is not possible because referring sources are too broken to analyze:

- return `409 RENAME_REQUIRES_MANUAL_REPAIR`
- enumerate impacted files

Historical immutable artifacts such as prior deployments and snapshots are not rewritten.

## 4.5 Existing drift repair

Add an audit/repair path for already-drifted projects:

- detect `ProjectAgent.name` vs declared-name mismatches
- detect `entryAgentName` that does not resolve to an existing canonical agent
- produce a repair plan
- auto-fix only when unambiguous

## 5. Import Identity Resolution for External Bundles

Import must tolerate mismatched identities on ingress, then canonicalize them before persistence.

For each imported agent file derive:

- `manifestKey`
- `fileStem`
- `declaredName`

Resolution precedence:

1. `declaredName`, when recoverable
2. `manifestKey`
3. `fileStem`

Use the first unambiguous value as the canonical persisted name.

```ts
interface ResolvedAgentIdentity {
  file: string;
  manifestKey?: string;
  fileStem: string;
  declaredName?: string;
  canonicalName: string;
  aliases: string[];
}
```

### Behavior

- If `manifestKey !== declaredName` but both clearly refer to the same file:
  - emit non-blocking `identity` issue
  - emit `resolve_agent_alias` and `canonicalize_imported_agent_identity` fallbacks
  - persist the canonical name
- Resolve `entry_agent` by alias lookup through the same map.
- If resolution is ambiguous, emit a blocking issue and disable Apply.

Apply must use resolved canonical names for:

- `ProjectAgent.name`
- agent diffing
- `Project.entryAgentName`

This removes the current split where preview and apply rely on different identity sources.

## 6. Internal Storage Contracts vs Export File Contracts

This is the core architectural correction.

## 6.1 Agent storage contract

`ProjectAgent.dslContent` is authoring source text. It may be:

- strict legacy ABL
- strict YAML ABL
- temporarily parse-broken while a user is editing

It is **not** itself an export file contract.

## 6.2 Tool storage contract

`ProjectTool.dslContent` is a one-tool authoring source snippet tied to a single `ProjectTool` record.

It is **not** the same thing as a `.tools.abl` archive file.

## 6.3 Export contracts

Archive payloads are stricter:

- `*.agent.yaml` = strict YAML agent document
- `*.agent.abl` = strict ABL agent document
- `*.tools.abl` = strict canonical tool-file document with `TOOLS:`
- `recovery/**/*.json` = explicit best-effort preservation format for source that cannot honestly satisfy a canonical file contract

Export must translate storage contracts into file contracts rather than passing text through unchanged.

## 7. Best-Effort Export Materialization

## 7.1 `dslFormat` becomes a preferred target, not a lie

In V2, `dslFormat` must no longer mean “use this extension even when content does not match.”

It should mean:

- try to serialize into the requested syntax first
- validate the result against that syntax
- if that fails, downgrade to another strict syntax when possible
- if no strict syntax can be emitted, preserve the source in a recovery artifact

The hard contract is per-file honesty, not whole-bundle uniformity.

### Manifest implications

Top-level `dsl_format` should be treated as the export preference/default, not as a guarantee that every file uses that syntax.

Add per-entity manifest metadata:

```ts
interface ManifestAgent {
  path: string;
  format: 'yaml' | 'abl' | 'recovery';
  materialization: 'canonical' | 'downgraded' | 'recovery';
  ...
}
```

When any entity differs from the preferred format, the bundle is considered `degraded` or `recovery`, and `export-report.json` records why.

## 7.2 Agent export serialization

Introduce a shared `serializeAgentForExport()` boundary.

```ts
interface AgentExportResult {
  content: string | null;
  sourceFormat?: 'abl' | 'yaml';
  actualFormat?: 'yaml' | 'abl' | 'recovery';
  materialization: 'canonical' | 'downgraded' | 'recovery';
  recoveryPayload?: Record<string, unknown>;
  issues: ExportIssue[];
}
```

Behavior:

1. Parse source text via content-aware parsing.
2. If syntax is parseable, build a normalized agent representation keyed to the canonical DB/runtime name.
3. Try to serialize to the requested target format.
4. Re-parse using the **target-format parser**, not only content auto-detection.
5. Verify the declared name matches the canonical name being exported.
6. If requested format fails but another strict agent format is possible, emit that alternate format with a downgrade warning.
7. If no strict YAML/ABL file can be emitted, write a recovery artifact that preserves raw source plus metadata.
8. Attach semantic diagnostics as warnings when serialization succeeds.

### Important distinction

The export serializer should not depend on “semantic compile success” merely to satisfy file-format correctness. If a source document is syntactically valid and can be represented in YAML/ABL, export should emit a strict file and separately report semantic warnings.

If the current serializer stack requires full compile to serialize YAML, that is a design gap. The long-term boundary should be:

- syntax normalization for serialization
- semantic compilation for warnings/errors
- best-effort downgrade/recovery when syntax normalization cannot reach the preferred target

## 7.3 Tool export serialization

Introduce a shared `serializeToolForExport()` boundary.

```ts
interface ToolExportResult {
  content: string | null;
  actualFormat?: 'abl' | 'recovery';
  materialization: 'canonical' | 'recovery';
  recoveryPayload?: Record<string, unknown>;
  issues: ExportIssue[];
}
```

Behavior:

1. Parse stored one-tool source into a canonical tool definition.
2. Serialize it into a canonical tool-file document under `TOOLS:`.
3. Re-parse with `parseToolFile()`.
4. If canonical tool-file output cannot be produced, write a recovery artifact preserving the raw tool source and metadata.

This preserves the current one-tool storage model while fixing the external V2 file contract.

## 7.4 Export self-validation

Before returning a V2 archive:

1. assemble files
2. run an in-memory export validation pass
3. optionally round-trip through the folder reader/import validator

Validation must confirm:

- every manifest path exists
- every `.agent.yaml` file parses as YAML
- every `.agent.abl` file parses as ABL
- every `.tools.abl` file parses as a canonical tool file
- every recovery artifact is declared as recovery and contains the required raw-source metadata
- manifest keys and `entry_agent` resolve to exported canonical identities
- no ambiguous collisions exist

If a canonical file fails validation, exporter must first try downgrade/recovery materialization and re-validate.

Export should only return `success: false` when it cannot produce any self-consistent bundle after those repair steps.

### Recovery artifact shape

Recovery artifacts should be explicit and importer-readable, e.g.:

- `recovery/agents/<slug>.agent.recovery.json`
- `recovery/tools/<slug>.tool.recovery.json`

Each recovery artifact should include:

- canonical entity name
- preferred export format
- raw authoring source
- detected source format, when known
- export issues that caused recovery materialization

## 8. Tolerant Import Normalization

Import should continue to accept historical and imperfect bundles.

It should also understand the best-effort recovery artifacts emitted by export, so exporting and re-importing an unhealthy project does not lose authoring content.

## 8.1 Agent format tolerance

For `.agent.yaml` inputs:

1. try YAML parse first
2. if YAML parse fails, try content-aware agent parse
3. if content is valid legacy ABL, emit non-blocking `agent_format` issue
4. continue with preview/apply after acknowledgement

Likewise, if a future `.agent.abl` contains YAML, emit a format-mismatch warning but continue if content is parseable.

## 8.2 Tool format tolerance

For `.tools.abl` inputs:

1. if content already starts with `TOOLS:`, parse as-is
2. else if the first non-empty line matches a single-tool signature, wrap it in-memory under `TOOLS:`
3. retry parse
4. emit non-blocking `tool_format` issue plus `normalize_legacy_tool_file` fallback

## 8.3 Semantic diagnostics stay non-blocking

Import preview should continue collecting:

- parse errors
- compile errors
- compile warnings

Those diagnostics do not block apply unless they make identity resolution or apply planning indeterminate.

## 8.4 Recovery artifact import

When a bundle contains recovery artifacts:

1. load the recovery metadata
2. recreate the corresponding `ProjectAgent` / `ProjectTool` with the preserved raw source
3. emit non-blocking import issues explaining that the entity came from recovery materialization
4. keep those entities out of canonical diff counts where necessary, but show them in preview

This allows export/import round-trip for unhealthy projects without pretending the recovery entities are valid canonical YAML/ABL files.

## 9. Diagnostics Collection

Preview should collect diagnostics in one pass and flatten them into `issues`.

### Agent diagnostics

Run diagnostics for both:

- `.agent.abl`
- `.agent.yaml`

Use content-aware parse and semantic validation for user feedback, but also emit format-mismatch issues when extension and actual syntax disagree.

### Tool diagnostics

Collect:

- direct tool parse errors
- legacy tool normalization warnings
- planned stub creation when no parseable standalone definition exists

### Export diagnostics

Collect:

- serialization downgrade decisions
- recovery materializations
- extension contract failures before downgrade/recovery
- manifest/path/identity inconsistencies
- self-validation failures

## 10. Apply Handshake

Change `POST /api/projects/:id/import/apply` to accept:

```ts
{
  files: Record<string, string>;
  deleteUnmatched?: boolean;
  previewDigest: string;
  acknowledgedIssueIds: string[];
}
```

Apply flow:

1. recompute preview server-side
2. compare computed digest to request digest
3. reject on blocking issues
4. reject with `409 ACK_REQUIRED` when acknowledgement is missing
5. apply using resolved canonical identities and explicit fallbacks

This guarantees “Import Anyway” applies the exact previewed bundle and exact reviewed issues.

## 11. Studio UI

## 11.1 Summary

At the top of preview, show counters for:

- Blocking
- Errors
- Warnings
- Info
- Fallbacks

Keep change counters, but visually separate them from diagnostics.

## 11.2 Preview layout

Use three sections:

1. **Import Changes**
   - agents added/modified/removed
   - tools added/modified/removed/normalized/stubbed/skipped

2. **Attention Required**
   - grouped by severity
   - message, file, entity, suggested action

3. **Importer Will Do**
   - alias resolutions
   - tool normalization
   - stub creation
   - skipped files

## 11.3 Apply behavior

Replace current gating:

- current: disable Apply when syntax errors exist
- new: disable Apply only when `!preview.canApply`

When `preview.requiresAcknowledgement` is true:

- require explicit confirmation
- change CTA to `Import Anyway`

## 12. Files to Modify

| File                                                                   | Change                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/project-io/src/types.ts`                                     | Add structured import/export issues, preview flags, fallback types                   |
| `packages/project-io/src/import/tool-extractor.ts`                     | Add legacy single-tool normalization and structured tool issues                      |
| `packages/project-io/src/import/project-importer-v2.ts`                | Build unified issues, fallback plans, canonical identity resolution, `previewDigest` |
| `packages/project-io/src/import/import-validator.ts`                   | Separate blocking safety checks from compile-like diagnostics                        |
| `packages/project-io/src/import/folder-reader.ts`                      | Provide manifest/path/header context to identity resolver                            |
| `packages/project-io/src/import/recovery-reader.ts`                    | Read recovery artifacts and map them into import issues and persisted source         |
| `packages/project-io/src/export/layer-assemblers/types.ts`             | Add serializer/validator dependencies, not just `dslFormat`                          |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts`    | Serialize agents/tools into strict export contracts                                  |
| `packages/project-io/src/export/project-exporter.ts`                   | Treat `dslFormat` as preferred target, apply downgrade/recovery, add self-validation |
| `packages/project-io/src/export/manifest-generator.ts`                 | Generate manifest from canonical identities with per-entity format/materialization   |
| `packages/project-io/src/export/export-report.ts`                      | Emit `export-report.json` with issues and materializations                           |
| `packages/project-io/src/export/folder-builder.ts`                     | Use deterministic collision-safe file naming                                         |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`        | Return unified issues, include `.agent.yaml` diagnostics                             |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`          | Enforce digest + acknowledgement handshake and canonical apply                       |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts`  | Reject implicit header renames                                                       |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts` | Reject implicit header renames for surgical edits                                    |
| `apps/studio/src/repos/project-repo.ts`                                | Support canonical identity checks and rename transaction helpers                     |
| `apps/studio/src/api/project-io.ts`                                    | Update client types for issues, fallbacks, ack flow                                  |
| `apps/studio/src/components/projects/ImportDialog.tsx`                 | Render issue groups/fallbacks and allow non-blocking proceed                         |

## 13. Test Plan

- Preview surfaces tool parse failures instead of silently dropping them.
- Preview surfaces diagnostics for `.agent.yaml` files, not only `.agent.abl`.
- Preview shows format-mismatch warnings for `.agent.yaml` files containing legacy ABL.
- Import can proceed after acknowledgement when tool parse or compile diagnostics are non-blocking.
- Ambiguous identity collisions remain blocking.
- Apply uses resolved canonical `entryAgentName`, not raw manifest value.
- Normal save/edit routes reject top-level header renames with `AGENT_RENAME_REQUIRED`.
- Export of a project with compile warnings/errors still succeeds and returns export issues.
- Requested YAML export downgrades an unrepresentable agent to strict `.agent.abl` instead of failing or lying.
- Irreducibly broken agent/tool sources are preserved in recovery artifacts instead of blocking export.
- Exported `.tools.abl` files round-trip through `parseToolFile()` with no normalization needed when materialized canonically.
- Exported `.agent.yaml` files parse as YAML; non-YAML body under `.agent.yaml` is impossible.
- Recovery artifacts can be re-imported into raw project source with non-blocking warnings.
- Export self-validation catches manifest/path/identity drift before returning the archive and forces downgrade/recovery before failure.
- Deterministic file naming is stable regardless of export ordering.

## 14. Rollout

### Phase 1: Truthful Preview

- add structured issues and fallback model
- surface tool parse errors and `.agent.yaml` diagnostics
- gate Apply on `canApply`, not raw syntax error count

### Phase 2: Canonical Identity Guardrails

- reject implicit header renames in normal save/edit routes
- add import identity resolution and canonical apply semantics
- stabilize file naming

### Phase 3: Best-Effort Strict-File Export

- add agent/tool export serializers
- make `dslFormat` a preferred target with honest per-file fallback
- add export self-validation and `export-report.json`

### Phase 4: Recovery Round-Trip and Drift Repair

- add recovery artifact export/import
- add explicit rename transaction
- add audit/repair tooling for already-drifted projects

## Open Questions

- Whether to keep `valid` for one release or remove it immediately from the client contract
- Whether to add persisted `sourceFormat` metadata for editor fidelity, or continue deriving format from content
- Whether explicit agent rename should ship in the same phase as write-path mismatch rejection, or immediately after
- Whether recovery artifacts should live in a dedicated `recovery/` layer or a top-level best-effort namespace
