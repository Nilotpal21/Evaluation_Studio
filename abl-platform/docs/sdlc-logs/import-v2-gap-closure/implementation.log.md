# Import v2 Gap Closure Implementation Log

**Ticket**: ABLP-869
**Started**: 2026-05-06

## Slice 1: Strategy Parity Lock

- Added route-level parity coverage for Studio `deleteUnmatched` mapping.
- Locked default preview/apply behavior to `conflictStrategy: "merge"`.
- Locked delete-unmatched preview/apply behavior to `conflictStrategy: "replace"`.
- Added data-flow audit artifact for the request-to-import-v2 boundary.

Verification:

- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-import-conflict-strategy-parity.test.ts`
- `pnpm --filter @agent-platform/project-io build`
- `pnpm --filter @agent-platform/studio build`

Commit:

- `92fad5ffd [ABLP-869] test(studio): lock import conflict strategy mapping`

## Slice 2: Layered Revert Path

- Added a route test proving legacy snapshot revert falls back to layered rollback when the operation has no legacy snapshot.
- Added adapter tests proving superseded layered records are lifecycle-marked instead of hard-deleted during cleanup.
- Added a helper test proving completed layered operations can be reverted from stored staged/superseded ids.
- Added `reverted` as a terminal import operation phase.
- Routed `/import/revert` through layered rollback for no-snapshot import-v2 operations while preserving the legacy snapshot path.

Verification:

- `pnpm --filter @agent-platform/database build`
- `pnpm --filter @agent-platform/project-io build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-import-revert-route.test.ts src/__tests__/project-import-core-direct-apply-support.test.ts`

Commit:

- `a2c59cd7e [ABLP-869] fix(studio): revert layered import operations`

## Slice 3: Full Archive API Regression

- Added a Studio route regression for full import-v2 archives that includes all supported layers: connections, prompts, core, search, workflows, guardrails, evals, channels, and vocabulary.
- Locked preview forwarding of full layer selection, archive files, and `merge` conflict strategy into the layered v2 helper.
- Locked apply forwarding of full layer selection, preview digest, acknowledgement ids, operation id, entry agent, and model policy invalidation behavior.
- Locked blocking preview diagnostics so the UI receives preview digest, warnings, issues, and error payload for full archives.

Verification:

- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-import-full-archive-layered-v2.test.ts`

Commit:

- `131e4b027 [ABLP-869] test(studio): lock full archive layered import route`

## Slice 4: Natural-Key Merge Coverage

- Added a natural-key coverage audit for import-v2 merge behavior across supported collections.
- Added regression tests for prompt parent/child merge replacement, channel parent/webhook/widget replacement, and vocabulary singleton/compound-key replacement.
- Flagged remaining collection families that need explicit merge-key tests or index-hardening follow-ups.

Verification:

- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/layer-disassembler-natural-keys.test.ts`

Commit:

- `470d96d2e [ABLP-869] test(project-io): lock import merge natural keys`

## Slice 5: Studio Import Dialog Messaging

- Added component regression coverage for default merge-mode import messaging, explicit replace-mode propagation, and apply failure operation-status details.
- Updated the import dialog to show merge mode by default and make destructive replace behavior an explicit checkbox.
- Forwarded the selected import mode into preview and apply requests.
- Added client support for `/import/status` and surfaced failed operation status plus per-layer statuses when apply returns an operation id.
- Added blocking-issue guidance that full-project archives are supported without requiring layer selection in the dialog.

Verification:

- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/project-io-client.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/import-dialog.test.tsx`
