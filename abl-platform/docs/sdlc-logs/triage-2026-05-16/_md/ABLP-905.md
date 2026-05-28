# ABLP-905 — Issue with importing the project into workspace

- Status: To Do
- Assignee: Prasanna Arikala
- Reporter: Upendher Musham
- Priority: None
- Labels: Cigna, go-agentic-priority
- Created: 2026-05-07T18:56:52.045+0530
- Updated: 2026-05-13T10:23:24.166+0530
- Due: 2026-05-15

## Description

Importing a project archive that was created through the official Studio export fails at the preview stage with:

RUNTIME_CONFIG_SAVE_VALIDATION_FAILED:
Unrecognized key(s) in object: 'projectId', 'tenantId', 'createdBy', '\_v'

Preview shows 0 Added / 0 Modified / 0 Removed and the import cannot proceed. Re-exporting the project does not help — the issue is in the export/import contract itself.

Steps to reproduce

    - In Studio, open  project

    - Use Export Project to download the archive.

    - In another (or the same) workspace, open Import Project and select the archive.

    - Observe Failed to preview import banner with the error above and a blocking issue: “Unrecognized key(s) in object: 'projectId', 'tenantId', 'createdBy', '_v'”.

Expected

Preview succeeds; runtime config is staged for import (added/modified/unchanged as appropriate).

Actual

Preview fails on project_runtime_configs due to four unrecognized keys.

Details:

ProjectId: 019dd384-2796-7dd3-8abb-60a40e2143ce

Email: upendher.musham@kore.com

Workspace: goAgentic

Project name: Cigna Demo

Initial Analysis(May help for fixing)

Two leaks on the export side and one re-injection on the import side, against a strict Zod save-validator:

    - Exporter does not strip the custom version field or audit field. packages/project-io/src/export/layer-assemblers/assembler-utils.ts:

const DEFAULT_INTERNAL_KEYS = ['_id', '__v', 'projectId', 'tenantId', 'createdAt', 'updatedAt'];

The runtime config model defines a custom v (single underscore — not Mongoose’s \_v) and the document also carries createdBy:

// packages/database/src/models/project-runtime-config.model.ts
\_v: { type: Number, default: 1 },

Neither \_v nor createdBy is in DEFAULT_INTERNAL_KEYS, so both leak into config/runtime-config.json.

    - Importer re-injects ownership unconditionally. packages/project-io/src/import/layer-disassemblers/disassembler-utils.ts injectOwnership always sets projectId, tenantId, and createdBy on the staged record from server context.

    - Save-side validator is strict. The downstream save validator for project_runtime_configs does not recognize ownership/version fields, so it rejects all four (projectId, tenantId, createdBy, _v) with the literal Zod strict-object message.

End result: even a clean Studio export ships an archive that the same platform’s importer rejects.

## Comments (3)

### Prasanna Arikala — 2026-05-12T11:45:04.415+0530

This has been fixed in Dev

### Upendher Musham — 2026-05-12T18:57:26.434+0530

Above issue is fixed but Import/export issue is still reproducible when eval artifacts are included while exporting.

Observed behavior

    - Export project from Workspace and import into another project.

    - Import fails with schema validation errors when eval_sets, eval_scenarios, and eval_personas are part of the export.

    - Import succeeds when evals are deselected during export.

Validation errors seen(PFA)

    - eval_sets.personaModel: expected string, received null

    - eval_scenarios.expectedMilestones&#91;i&#93;: expected object, received string

    - eval_scenarios.version: expected string, received number

    - eval_personas.goals: expected array, received string

    - eval_personas.constraints: expected array, received string

Expectation

    - A direct round-trip (export -> import) across workspaces should be schema-compatible without manual edits.

Workaround

    - Deselect evals during export; import completes successfully.

Impact

    - Prevents complete project migration across workspaces when eval content is required.

Environment:

ENV: dev

Exported Project Id:019e077b-6005-7d43-8213-d87fcf6f56dd

Imported Project Id: 019e1c5a-f4db-7c27-afb2-f1f9a806e403 (same workspace) 019e1c53-0627-7a3a-bc38-9c2952981018(different workspace)

### Upendher Musham — 2026-05-12T18:58:55.711+0530

Moving this issue to ToDo. Let me know if it needs to be tracked separately — I can raise a separate ticket for it.
