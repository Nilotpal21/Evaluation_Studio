# Studio UI Consistency Sweep Journal

JIRA: ABLP-939
Date: 2026-05-10

## Commits

- `b49d515a4d` `[ABLP-939] style(studio): fix invisible token usage and double-padding in design-system surfaces`
- `47f606f30e` `[ABLP-939] refactor(studio): replace native selects with design-system Select/FilterSelect`
- `eb06af2239` `[ABLP-939] refactor(studio): migrate hand-rolled modals to shared Dialog/ConfirmDialog`
- `e88dbc8479` `[ABLP-939] refactor(studio): migrate governance and experiments form elements to design-system primitives`
- `0ebac9784d` `[ABLP-939] refactor(studio): migrate settings form elements to design-system primitives`
- `e094577dc8` `[ABLP-939] refactor(studio): adopt shared page shells`
- `58d933c612` `[ABLP-939] refactor(studio): migrate hand-rolled tables to DataTable`
- `03864afda5` `[ABLP-939] refactor(studio): consolidate insights surface on shared primitives`
- `d561d3248b` `[ABLP-939] style(studio): polish arbitrary dimensions, typography, and icon drift`

## Deferred Items

- None intentionally deferred in C1-C8.

## Test Changes

- Updated `apps/studio/src/components/insights/__tests__/shared-components.test.tsx` to exercise the canonical `../ui/EmptyState` signature after deleting `insights/shared/EmptyState.tsx`.

## Ambiguous Decisions

- Split C4 into governance/experiments and settings commits to keep commit size manageable.
- Used `MetricCard` in Agent Transfer Insights with suffixed display values for second-based voice metrics, preserving the visible unit while removing the ad-hoc metric component.
- C8 changed the profile slide-out from `max-w-sm` to `max-w-md` to match the API keys slide-out width.

## Verification Notes

- `pnpm --filter @agent-platform/studio typecheck` passed before committing C7.
- `pnpm --filter @agent-platform/studio typecheck` passed before committing C8.
- `pnpm build --filter=@agent-platform/studio` was attempted for C7 and C8. The C7 build reached the Studio Next step and was blocked by an existing Next build lock; the fallback typecheck passed. The C8 build reached Next production compilation and Turbo was terminated with signal 15 without code diagnostics; the fallback typecheck passed.
- Final `pnpm build --filter=@agent-platform/studio` was attempted after C8. It was blocked by a separate already-running Studio build process in the same workspace holding the Next build lock.
- Final `pnpm test --filter=@agent-platform/studio` was not run because the required final build did not complete successfully first.

## Round 2 — HIGH gap closure

- `2ed4bbbca78ff72d3ce86017c3ba6a531c8fc5a4` `[ABLP-939] feat(studio): extract ToggleChip primitive and adopt in RegisterExternalAgentModal`
- `0658a4318b70bf9da526bdaa206e1487123c5e50` `[ABLP-939] refactor(studio): adopt FilterSelect in audit-filters toolbar`
- `78cd2b56f68ddd16f9a09218fe13c7f46209021a` `[ABLP-939] refactor(studio): finish AddKeyModal body migration to Input/Button primitives`

## Round 3 — MED/LOW closure

- `5b223b5612` `[ABLP-939] refactor(studio): finish governance design-system adoption`
- `2ebd2e4466` `[ABLP-939] refactor(studio): finish experiments design-system adoption`

Deferred:

- R3-C external agents polish, R3-D settings polish, R3-E layout/dialog alignment, and R3-F insights i18n remain open. Work stopped after repeated required `pnpm build --filter=@agent-platform/studio` runs reached the Studio Next build and were terminated with signal 15 during build trace collection, without TypeScript or page-generation diagnostics to fix in source.

## Round 3 — MED/LOW closure

- `5b223b5612` `[ABLP-939] refactor(studio): finish governance design-system adoption`
- `2ebd2e4466` `[ABLP-939] refactor(studio): finish experiments design-system adoption`
- `a875b06848` `[ABLP-939] refactor(studio): finish external-agents design-system adoption`
- `3b74097a41` `[ABLP-939] refactor(studio): finish settings design-system adoption`
- `e106404daa` `[ABLP-939] refactor(studio): standardize settings layouts and dialog widths`
- `1cb3f721e9` `[ABLP-939] refactor(studio): i18n at-a-glance insights tab labels`

Deferred:

- None.

## Round 4 — final closure

Closes the 4 PARTIAL items from the round-3 high-effort review plus 2 out-of-audit follow-ups.

- `fa22d9b67c` `[ABLP-939] refactor(studio): i18n handoff hint in RegisterExternalAgentModal`
- `5bdc531a3a` `[ABLP-939] refactor(studio): standardize settings form-dialog widths`
- `2bbbf3d421` `[ABLP-939] fix(studio): replace broken primary tokens in AgentPerformancePage`
- `958561b40e` `[ABLP-939] style(studio): canonicalize text-muted and border-default tokens in settings tabs`
- `30ada9ee66` `[ABLP-939] refactor(studio): adopt RuntimeConfig field-row pattern in AttachmentSettingsTab`
- `08b683acd1` `[ABLP-939] refactor(studio): adopt RuntimeConfig field-row pattern in AdvancedSettingsTab`

Deferred:

- None.

## Round 5 — Dialog width convention

Round-4's high-effort audit flagged 4 settings Dialogs still on `maxWidth="lg"` as an inconsistency. On review, each of those is a genuinely complex multi-section form, so the right call was to **document the convention rather than force uniformity**.

**Convention** (now codified in `apps/studio/src/components/ui/Dialog.tsx` JSDoc):

- `sm` / `md` — simple forms (1–3 fields, single concern). Default `md`.
- `lg` / `xl` / `2xl` — complex forms (multi-section, multi-column, code/regex blocks, browsers with scrollable lists).
- `4xl`+ — rarely needed; prefer a panel/page.

Changes in this round:

- Reverted `PIIPatternFormDialog.tsx` from `md` back to `lg`. The form has 5 sections (Basics, Detection, Redaction, Consumer Access, Live Test), so under the convention it belongs on `lg`. Round 4 had downgraded it for uniformity, which was wrong.
- Added JSDoc to `Dialog.tsx`'s `maxWidth` prop so future PRs know the rule.

Final settings dialog distribution (matches convention):

- `md` (simple): `ApiKeysTab`, `ApiKeysPage`, `PlatformKeysTab` (create + edit), `ProjectMembersTab` invite.
- `lg` (complex): `PIIPatternFormDialog` (5 sections), `AgentAssistSettingsPage` config (multi-section view + key rotation), `AgentAssistSettingsPage` add-connection (provider picker + form), `GitIntegrationTab` (provider + URL + 2-col branch/path + auth + 2-col credentials), `ModelConfigTab` add-model (catalog browser with search + scroll).

Deferred:

- None. ABLP-939 closeable.
