# LLD: Localization Asset Management

**Feature Spec**: [docs/features/sub-features/localization-asset-management.md](../features/sub-features/localization-asset-management.md)
**HLD**: [docs/specs/localization-asset-management.hld.md](../specs/localization-asset-management.hld.md)
**Test Spec**: [docs/testing/sub-features/localization-asset-management.md](../testing/sub-features/localization-asset-management.md)
**Status**: IMPLEMENTED
**Date**: 2026-04-16

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                           | Rationale                                                                       | Alternatives Rejected                           |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| D-1 | Use a dedicated Localization settings page                         | Locale assets are content files, not compile-time config constants              | Reuse Config Variables UI                       |
| D-2 | Reuse `ProjectConfigVariable` with reserved locale keys            | Avoids schema sprawl while preserving project scoping and existing indexes      | New top-level `LocaleAsset` collection          |
| D-3 | Centralize locale path conversion in `packages/project-io`         | Storage keys, file paths, and export/Git logic must stay perfectly aligned      | Duplicate helper logic in Studio and project-io |
| D-4 | Use full-width editor layout via existing design-system components | Large JSON files need significantly more horizontal space                       | Narrow settings form or modal                   |
| D-5 | Integrate with existing Git surfaces                               | Git is already the system of record for publishing/versioning project artifacts | Build a separate localization publish system    |
| D-6 | Keep runtime localized-message resolution out of this slice        | This implementation focuses on Studio authoring + project-I/O foundations       | Expand scope into runtime message overlay now   |

### Key Interfaces & Types

```typescript
interface ProjectLocalizationAsset {
  id: string;
  key: string;
  value: string;
  description: string | null;
  relativePath: string;
  filePath: string;
  localeCode: string;
  fileName: string;
  assetName: string;
  scope: 'shared' | 'agent';
  createdAt: string | null;
  updatedAt: string | null;
}
```

```typescript
interface ProjectData {
  // existing project export fields
  locales?: Map<string, string>;
}
```

### Module Boundaries

| Module                   | Responsibility                                   | Depends On                                 |
| ------------------------ | ------------------------------------------------ | ------------------------------------------ |
| `locale-files.ts`        | Canonical locale key/path/file conversions       | project-io                                 |
| `localization-assets.ts` | Studio server-side view model + storage helpers  | Studio DB helpers, project-io path helpers |
| Localization API routes  | Project-scoped CRUD boundary                     | route handler, storage helper              |
| LocalizationSettingsPage | Studio authoring UX                              | design system + localization client API    |
| Git/export plumbing      | Serialize locale assets into export/Git surfaces | project-io + Studio helper                 |

---

## 2. File-Level Change Map

### New Files

| File                                                                    | Purpose                                          | LOC Estimate |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| `packages/project-io/src/locale-files.ts`                               | Canonical locale asset key/path helper functions | 90           |
| `apps/studio/src/lib/localization-assets.ts`                            | Server-side asset mapping and list/build helpers | 140          |
| `apps/studio/src/app/api/projects/[id]/localization/route.ts`           | List/create localization assets                  | 120          |
| `apps/studio/src/app/api/projects/[id]/localization/[assetId]/route.ts` | Get/update/delete localization assets            | 190          |
| `apps/studio/src/api/localization.ts`                                   | Client API for localization assets               | 80           |
| `apps/studio/src/components/settings/LocalizationSettingsPage.tsx`      | Full-width localization workbench                | 430          |
| `docs/features/sub-features/localization-asset-management.md`           | Feature spec                                     | n/a          |
| `docs/testing/sub-features/localization-asset-management.md`            | Test spec                                        | n/a          |
| `docs/specs/localization-asset-management.hld.md`                       | HLD                                              | n/a          |
| `docs/plans/localization-asset-management.lld.md`                       | LLD                                              | n/a          |
| `docs/sdlc-logs/localization-asset-management/implementation.log.md`    | Implementation log                               | n/a          |

### Modified Files

| File                                                                | Change Description                                                                 | Risk   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| `packages/project-io/src/index.ts`                                  | Re-export locale helper functions                                                  | Low    |
| `packages/project-io/src/export/project-exporter.ts`                | Add `ProjectData.locales` and pass locale files into folder builder                | Medium |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts` | Export reserved locale config entries as `locales/...json` files                   | Medium |
| `packages/project-io/src/git/git-sync-service.ts`                   | Include locale diffs in sync changes summary                                       | Medium |
| `apps/studio/src/components/ui/SlidePanel.tsx`                      | Add `4xl` and `full` width options for wider editing                               | Low    |
| `apps/studio/src/store/navigation-store.ts`                         | Add `settings-localization` route parsing/building/breadcrumb support              | Low    |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`          | Add Localization entry in settings group                                           | Low    |
| `apps/studio/src/config/navigation.ts`                              | Expose Localization nav item for universal search                                  | Low    |
| `apps/studio/src/components/navigation/AppShell.tsx`                | Route `settings-localization` to the new page                                      | Low    |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx`       | Support localization sub-page in settings shell                                    | Low    |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`           | Include locale assets in exported Git payload and return locale-aware sync message | Medium |
| `apps/studio/src/app/api/projects/[id]/git/status/route.ts`         | Surface local locale files in Git status                                           | Medium |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`           | Pass locale files into pull diff computation                                       | Medium |
| `apps/studio/src/api/project-io.ts`                                 | Expand Git status/push client types for locale data                                | Low    |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`         | Show locale assets in local state and sync history                                 | Medium |
| `packages/i18n/locales/en/studio.json`                              | Add Localization page strings and Git locale labels                                | Low    |
| `packages/project-io/src/__tests__/core-assembler.test.ts`          | Add locale file export assertions                                                  | Medium |
| `packages/project-io/src/__tests__/project-exporter.test.ts`        | Add locale export coverage                                                         | Medium |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`        | Add locale-aware Git sync coverage                                                 | Medium |
| `apps/studio/src/__tests__/stores/navigation-store.test.ts`         | Add localization route parsing/breadcrumb coverage                                 | Low    |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`           | Add sidebar localization navigation coverage                                       | Low    |

### Deleted Files

| File | Reason                               |
| ---- | ------------------------------------ |
| N/A  | No deletions required for this slice |

---

## 3. Implementation Phases

### Phase 1: Canonical Locale Asset Helpers and Export Plumbing

**Goal**: Define one canonical locale asset path contract and feed it into export/Git.

**Tasks**:
1.1. Add `locale-files.ts` helper functions in `packages/project-io`.
1.2. Export helpers from the package root.
1.3. Extend `ProjectData` with `locales`.
1.4. Update `project-exporter.ts` and `core-assembler.ts` to emit real locale files.
1.5. Update Git sync summaries to carry locale diffs.

**Exit Criteria**:

- [x] Locale key/path/file conversions are centralized
- [x] Export emits `locales/<locale>/<asset>.json`
- [x] Reserved locale entries are excluded from `environment/config-vars.json`
- [x] Git sync summaries include locale file changes

**Test Strategy**:

- Unit coverage in project-io exporter/assembler/Git sync tests

**Rollback**: Remove `locales` from export payloads and continue treating reserved entries as inert config variables.

---

### Phase 2: Studio Storage and CRUD Routes

**Goal**: Add explicit Studio CRUD endpoints and server-side view modeling for locale assets.

**Tasks**:
2.1. Add `localization-assets.ts` helper for mapping reserved config records.
2.2. Implement `GET/POST /localization`.
2.3. Implement `GET/PATCH/DELETE /localization/:assetId`.
2.4. Enforce JSON object validation, canonical path validation, duplicate protection, and project/tenant scoping.

**Exit Criteria**:

- [x] Project-scoped localization CRUD routes exist
- [x] Invalid path/JSON returns 400
- [x] Duplicates return 409
- [x] Cross-scope asset access remains project/tenant filtered

**Test Strategy**:

- Current slice relies on code-path inspection and build verification; follow-up route tests remain planned

**Rollback**: Remove dedicated routes; data remains in existing `ProjectConfigVariable` records.

---

### Phase 3: Studio Full-Width Localization Authoring UX

**Goal**: Add the user-facing localization workbench using the existing design system.

**Tasks**:
3.1. Add client API wrapper for localization routes.
3.2. Build `LocalizationSettingsPage` with summary cards, filters, asset table, and full-width editor.
3.3. Extend `SlidePanel` width options for full-width editing.
3.4. Wire page into navigation, AppShell, and settings grouping.
3.5. Add Git-aware actions from the localization page.

**Exit Criteria**:

- [x] Localization page is reachable from project settings
- [x] Editing uses a wide/full-screen workspace
- [x] Users can create/edit/delete locale assets from Studio
- [x] JSON upload and prettify actions are available
- [x] Git-connected and Git-disconnected states are both handled

**Test Strategy**:

- Navigation store and sidebar wiring tests
- Manual verification of create/edit/delete/editor layout behavior

**Rollback**: Remove navigation entry and page component while leaving stored data intact.

---

### Phase 4: Git Surface Updates, Verification, and SDLC Sync

**Goal**: Make locale assets visible through the existing Git experience and complete the SDLC artifacts.

**Tasks**:
4.1. Add locale assets to Git push payloads and success messaging.
4.2. Expose locale assets in Git status.
4.3. Show locale-aware summaries in Git history UI.
4.4. Pass locale file state into pull diff computation.
4.5. Update i18n and SDLC docs.

**Exit Criteria**:

- [x] Git push includes locale assets
- [x] Git status shows locale assets
- [x] Git history shows locale file counts
- [x] Pull preview receives locale file state
- [x] Feature/test/HLD/LLD/log docs are in sync

**Test Strategy**:

- Unit coverage for export/Git sync helpers
- Wiring tests for Studio navigation
- Manual verification of Git/localization UI surfaces

**Rollback**: Revert Git UI/status changes while leaving export helpers and localization CRUD intact.

---

## 4. Wiring Checklist

- [x] `locale-files.ts` exported from `@agent-platform/project-io`
- [x] Legacy exporter accepts locale asset map
- [x] Core assembler exports reserved locale entries as locale files
- [x] Studio localization routes mounted and project-scoped
- [x] Localization page wired into navigation and AppShell
- [x] `SlidePanel` supports full-width layout
- [x] Git push route includes locale assets
- [x] Git status route exposes locale assets
- [x] Git pull route passes locale state for diffing
- [x] Git settings UI surfaces locale asset local state/history
- [x] Studio i18n includes localization page copy

---

## 5. Cross-Phase Concerns

### Database Migrations

No DB migration is required. The slice reuses existing `ProjectConfigVariable` storage with reserved keys.

### Feature Flags

No feature flag added. The functionality is additive and project-scoped.

### Configuration Changes

- No new environment variables
- No new external services
- No change to runtime localization behavior in this slice

---

## 6. Acceptance Criteria (Whole Feature)

- [x] Studio exposes a dedicated Localization settings page
- [x] Locale JSON editing uses a wide/full-screen workspace
- [x] Locale assets are stored and edited as first-class project assets
- [x] Export emits locale assets as `locales/...json` files
- [x] Git push/status/history surface locale assets
- [x] Navigation and i18n are wired
- [x] SDLC docs reflect the implemented slice honestly

---

## 7. Open Questions

1. Should locale asset route tests be prioritized before browser E2E, or vice versa?
2. How should locale-file import-apply be implemented when the broader project-import pipeline is extended?
3. When runtime localized message resolution lands, do we need a stricter schema than “JSON object” for some locale asset types?
