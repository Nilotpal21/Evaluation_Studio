# ABLP-612 Studio to Runtime Gap Closure LLD

## Context

Recent ON_ACTION routing work exposed follow-on drift across the Studio-to-runtime path. The runtime execution path is now stricter, but some authoring, public contract, export, and transport boundaries still allow stale or lossy behavior.

## Target Contract

- ProjectAgent `agentPath` is server-derived from `{ projectId, name }` at every write boundary below public routes.
- Public API contracts and CLI clients create agents with `name` and optional metadata only.
- Export-like surfaces do not publish drafts already marked invalid by Studio/runtime-equivalent validation.
- WebSocket and SDK `action_submit` payloads use one bounded validator and reject invalid rich form envelopes instead of silently dropping fields.

## Data-Flow Matrix

| Concern                  | Definition                              | Write Boundary            | Public Contract          | Consumption                           | Target                          |
| ------------------------ | --------------------------------------- | ------------------------- | ------------------------ | ------------------------------------- | ------------------------------- |
| `agentPath`              | `ProjectAgent` model                    | Studio repo create/update | Studio OpenAPI, CLI      | Runtime lookup/import/export metadata | Server-derived only             |
| Draft DSL readiness      | `dslValidationStatus`, `dslDiagnostics` | Studio save/import        | Export, bundle, git push | Project import/runtime working-copy   | Fail closed on explicit `error` |
| `action_submit.formData` | SDK/WebSocket message                   | Parser + SDK handler      | Web SDK/Studio transport | Runtime `_action.formData`            | Bounded object or rejected      |
| `action_submit.renderId` | Rich action render metadata             | Parser + SDK handler      | Web SDK/Studio transport | Stale-click protection                | Bounded string or rejected      |

## Implementation Slices

### Slice 1: Repository Agent Path Invariant

Tests first:

- Add repo tests proving `createProjectAgent` ignores stale caller `agentPath`.
- Add repo tests proving `updateProjectAgent` repairs/derives canonical `agentPath` on rename and rejects arbitrary path-only mutation.

Implementation:

- Import the shared canonical path builder at the Studio repository boundary.
- Derive `agentPath` during create from `projectId` and trimmed `name`.
- During update, derive from current project and next/current name whenever `name` or `agentPath` is present.

Exit criteria:

- Focused Studio repo tests pass.

### Slice 2: Public Contract and CLI Cleanup

Tests first:

- Add OpenAPI spec route test proving create/update schemas do not expose mutable `agentPath`.
- Add CLI command test proving agent creation posts only `{ name }` before optional DSL upload.

Implementation:

- Update Studio OpenAPI route definitions.
- Update CLI create request and comments.

Exit criteria:

- Focused Studio OpenAPI/API tests and CLI command tests pass.

### Slice 3: Export Readiness Gate

Tests first:

- Add export, bundle, and git-push route tests proving an agent with `dslValidationStatus: "error"` returns `409` and does not call `exportProjectV2` or push.

Implementation:

- Add a pure Studio helper that builds export-readiness issues from project agents.
- Include validation metadata in export/bundle/git-push queries.
- Return a stable error envelope with `code: "INVALID_AGENT_DRAFT"` and per-agent diagnostics.

Compatibility:

- Missing status and warning status remain exportable for legacy drafts and non-blocking warning workflows.

Exit criteria:

- Focused route tests pass.

### Slice 4: Shared Action Submit Envelope Validation

Tests first:

- Add parser tests proving non-object, array, oversized, too-deep, and unsafe-key `formData` payloads are rejected.
- Add SDK handler test proving invalid envelopes return a client-visible error and do not call `executeMessage`.

Implementation:

- Add a shared runtime WebSocket validator for `actionId`, `value`, `renderId`, and `formData`.
- Use it from both generic WebSocket parsing/handler and SDK handler.
- Preserve legacy JSON-string `value` form fallback only when it passes the shared validator.

Exit criteria:

- Focused runtime WebSocket contract and SDK handler tests pass.

## Verification Plan

- `pnpm --filter @agent-platform/studio exec vitest run ...focused studio tests...`
- `pnpm --filter @agent-platform/cli exec vitest run ...focused cli tests...`
- `pnpm --filter @agent-platform/runtime exec vitest run ...focused runtime tests...`
- Package builds for touched packages where feasible after focused tests.
- `npx prettier --write <changed files>` before final summary or commit.

## Residual Risks

- Full black-box export/import/runtime parity still needs a broader workflow E2E after this gap-closure slice.
- Legacy DB records with noncanonical paths should already be covered by migration, but this slice prevents reintroduction rather than re-running backfill.
