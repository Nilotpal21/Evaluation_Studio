# Feature: Localization Asset Management

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Agent Development Studio](../agent-development-studio.md) / [Project Import / Export](../project-import-export.md)
**Status**: IMPLEMENTED
**Feature Area(s)**: `studio`, `project import/export`, `git integration`, `content management`
**Package(s)**: `apps/studio`, `packages/project-io`, `packages/i18n`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/localization-asset-management.md](../../testing/sub-features/localization-asset-management.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

ABLP-289’s interaction-context slice is already in place, but Studio still lacks a first-class way to manage locale-backed content assets:

- locale assets are not editable as first-class project content in Studio
- the existing Config Variables surface is the wrong mental model and API contract because it is compile-time key/value management, not locale file authoring
- Git integration did not clearly surface locale assets in local state, history, or push payloads
- export plumbing did not round-trip locale assets as real `locales/...json` files from the stored project model
- builders who need to edit translated JSON content need significantly more horizontal space than a standard narrow settings form

The result is a gap between the new runtime localization foundations and the content-authoring experience needed to maintain localized assets.

### Goal Statement

Provide a first-class Studio localization management surface, using the existing Studio design system, that lets users create, edit, delete, inspect, and publish locale JSON assets in a wide or full-screen editing workspace while aligning export and Git sync with the canonical `locales/<locale>/<asset>.json` file contract.

### Summary

Localization Asset Management introduces a dedicated `Settings > Localization` experience in Studio and treats locale files as project assets instead of generic config variables. The slice includes:

- canonical locale asset path helpers shared with project I/O
- Studio CRUD routes for locale assets stored in `ProjectConfigVariable`
- a full-width Studio editor for JSON locale files
- Git status, push, history, and export visibility for locale assets
- route/navigation/i18n wiring using the existing Studio design system

This slice intentionally does **not** implement runtime locale-aware scripted message selection. It establishes the Studio asset-management and project-I/O foundation that the runtime/content-resolution slice can build on.

### Key Capabilities

- Dedicated `Localization` settings page in Studio
- Full-width or near full-screen editing experience using existing `DetailPageShell` and `SlidePanel`
- Canonical locale asset path validation with `locales/<locale>/<asset>.json` export alignment
- First-class create/edit/delete workflows for locale JSON assets
- JSON upload and prettify actions inside the editor
- Git-aware publishing entry point from the localization workspace
- Git local-state and history visibility for locale asset changes
- Export of stored locale assets as real locale files instead of config-variable references

---

## 2. Scope

### Goals

- Add a dedicated Studio localization management page under project settings.
- Use the existing design system instead of inventing a new visual language or standalone editor shell.
- Provide a wide/full-screen JSON editing workspace for locale asset authoring.
- Store locale assets in the existing project-scoped data model without creating a new top-level collection.
- Define and reuse canonical locale asset path helpers for storage keys and exported file paths.
- Export locale assets as real `locales/<locale>/<asset>.json` files through project I/O.
- Surface locale assets through existing Git integration status/history/push workflows.
- Keep Studio route handlers tenant- and project-scoped explicitly.

### Non-Goals (Out of Scope)

- Runtime locale-aware scripted or prompt message resolution from these assets.
- A generic translation CMS covering all localized runtime content shapes.
- Bulk translation workflow features such as machine translation, vendor review queues, or completeness analytics.
- Replacing the existing project import-apply pipeline with a dedicated locale-asset staged importer in this slice.
- Editing locale assets through the Git settings page itself; Git remains the publishing/versioning path, not the primary authoring surface.

---

## 3. User Stories

1. As a **Studio builder**, I want to edit locale JSON assets directly in Studio so I do not need to upload files or edit raw repository content for every change.
2. As a **content editor**, I want a wide editing workspace so large JSON translation files are readable and editable without fighting narrow forms.
3. As a **technical team**, I want localization assets to sync through our existing Git integration so they are versioned, reviewable, and exportable with the rest of the project.
4. As a **platform engineer**, I want one canonical locale file contract shared by Studio storage and export/Git plumbing so later runtime content resolution reads a stable asset shape.

---

## 4. Functional Requirements

1. **FR-1**: Studio must expose a dedicated `Settings > Localization` page for project-scoped locale assets.
2. **FR-2**: The localization page must use the existing Studio design system and provide a full-width editing experience for locale JSON assets.
3. **FR-3**: Users must be able to list, create, update, and delete locale assets through project-scoped Studio API routes.
4. **FR-4**: Locale asset storage must reuse the project-scoped config-variable persistence model with a canonical key contract, rather than overloading the public Config Variables UI.
5. **FR-5**: Locale asset paths must be validated and normalized to a canonical relative form such as `en/_shared.json` or `fr/booking_agent.json`.
6. **FR-6**: Export/Git serialization must materialize locale assets as real `locales/<locale>/<asset>.json` files instead of generic config-variable references.
7. **FR-7**: Git integration status/history/push flows must surface locale asset changes alongside agent changes.
8. **FR-8**: The localization editor must support JSON upload and JSON prettification while enforcing object-shaped JSON content.
9. **FR-9**: Studio route handlers and queries must remain tenant- and project-scoped explicitly and return 404 for cross-scope access.
10. **FR-10**: The feature must preserve clear scope boundaries by documenting that runtime locale-aware scripted message resolution remains a follow-on slice.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                  | Impact Level | Notes                                                                 |
| --------------------- | ------------ | --------------------------------------------------------------------- |
| Studio authoring      | PRIMARY      | This slice is primarily a Studio content-management workflow          |
| Project import/export | PRIMARY      | Locale assets now participate in canonical file export                |
| Git integration       | PRIMARY      | Locale assets surface in sync status/history and push payloads        |
| Runtime execution     | SECONDARY    | This slice prepares assets for a later runtime message-resolution use |
| Governance / auditing | SECONDARY    | Git versioning and route isolation are important                      |
| Admin workflows       | NONE         | No workspace-admin-only surface is added                              |

### Related Feature Integration Matrix

| Related Feature                                                     | Relationship Type | Why It Matters                                                                    | Key Touchpoints                                                                 | Current State |
| ------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| [Project Import / Export](../project-import-export.md)              | extends           | Locale assets must export as canonical files and participate in Git sync payloads | `core-assembler.ts`, `project-exporter.ts`, `folder-builder.ts`, Git sync flows | Active        |
| [Agent Development Studio](../agent-development-studio.md)          | extends           | Localization editing is a Studio authoring workflow                               | navigation, settings pages, design-system components                            | Active        |
| [Localized Interaction Context](./localized-interaction-context.md) | complements       | Interaction-context is the runtime foundation; this slice is the content layer    | runtime follow-on will consume exported/stored locale assets                    | Active        |

---

## 6. Design Considerations (Optional)

- **Do not overload Config Variables UX**: locale assets are authored like files/content, not compile-time constants.
- **Full-width first**: large JSON translation files need more room than standard forms, so wide or full-screen editing is a hard requirement.
- **Git is publishing, not authoring**: users edit in Studio, then publish/version through the existing Git integration.
- **One canonical path contract**: storage keys, relative paths, and exported file paths must map deterministically.
- **Be explicit about scope**: this slice creates and publishes locale assets; runtime selection of localized content remains separate.

---

## 7. Technical Considerations (Optional)

- Locale assets are stored in `ProjectConfigVariable` under reserved keys with a `locale:` prefix and exported as `locales/...json` files.
- `packages/project-io` owns the canonical path conversion helpers so Studio and export/Git code do not drift.
- Studio route handlers must include explicit `tenantId` and `projectId` scoping because Studio routes do not receive ALS tenant injection.
- The editor is built from existing Studio components: `DetailPageShell`, `Card`, `Button`, `Input`, `Select`, `Textarea`, `Badge`, `DataTable`, `SlidePanel`, and `ConfirmDialog`.
- The editing surface uses Monaco only as the JSON editing pane; the layout and controls remain the project’s existing design system.
- Git push now includes locale assets in exported content and returns locale-aware sync summaries; Git status/history surfaces locale asset visibility. Pull preview also receives locale file state for diff computation, while broad import-apply for locale files remains a follow-on concern.

---

## 8. How to Consume

### Studio UI

Builders access localization management from `Project Settings > Localization`.

The page provides:

- project-level summary badges for assets/locales/shared assets
- search + locale + scope filters
- a table of locale assets with file path, locale, scope, and updated time
- a full-width slide-out JSON editor for create/edit
- Git-aware publish action

### Surface Semantics Matrix

| Asset / Entity Type | Source of Truth / Ownership            | Design-Time Surface(s)            | Editable or Read-Only? | Consumer Reference / Binding Model      | Runtime Materialization / Resolution                   | Notes                 |
| ------------------- | -------------------------------------- | --------------------------------- | ---------------------- | --------------------------------------- | ------------------------------------------------------ | --------------------- |
| Locale asset        | `ProjectConfigVariable` reserved entry | `Settings > Localization`         | Editable               | canonical relative path + reserved key  | Exported as `locales/<locale>/<asset>.json`            | Primary surface       |
| Config variable     | `ProjectConfigVariable` standard entry | `Settings > Config Variables`     | Editable               | `{{config.KEY}}` compile-time reference | compiler/runtime config resolution                     | Separate mental model |
| Git sync visibility | Git integration metadata/history       | `Settings > Git`, Localization UI | Read-only / action     | existing Git integration routes         | push/status/history reflect locale asset participation | Publishing path       |

### API (Studio)

| Method | Path                                      | Purpose                              |
| ------ | ----------------------------------------- | ------------------------------------ |
| GET    | `/api/projects/:id/localization`          | List locale assets for a project     |
| POST   | `/api/projects/:id/localization`          | Create a locale asset                |
| GET    | `/api/projects/:id/localization/:assetId` | Fetch a single locale asset          |
| PATCH  | `/api/projects/:id/localization/:assetId` | Update locale asset path/content     |
| DELETE | `/api/projects/:id/localization/:assetId` | Delete a locale asset                |
| POST   | `/api/projects/:id/git/push`              | Publish locale assets through Git    |
| GET    | `/api/projects/:id/git/status`            | Inspect local locale-asset state     |
| POST   | `/api/projects/:id/git/pull`              | Compute remote-vs-local locale diffs |

### Git Integration

- Push serializes locale assets into canonical locale files alongside exported project content.
- Status lists local locale assets as first-class local state.
- History surfaces locale file change counts from sync history.
- Localization UI links directly into Git settings when a repository is not connected.

---

## 9. Data Model

### Collections / Tables

No new top-level collection is required for this slice.

Locale assets reuse `ProjectConfigVariable` with a reserved key namespace:

```text
ProjectConfigVariable
  tenantId
  projectId
  key = "locale:<locale>/<asset>.json"
  value = stringified JSON object
  description = optional human context
  createdBy
  updatedBy
```

### Canonical Path Contract

```text
Reserved storage key: locale:en/_shared.json
Relative asset path: en/_shared.json
Export / Git file path: locales/en/_shared.json
```

### Derived Studio View Model

```text
ProjectLocalizationAsset
  id
  key
  value
  description
  relativePath
  filePath
  localeCode
  fileName
  assetName
  scope = shared | agent
  createdAt
  updatedAt
```

---

## 10. Open Questions & Follow-On Work

1. When the runtime localized-message slice is implemented, should it consume these assets directly from reserved config-variable storage or from a more explicit runtime projection?
2. Should Git pull eventually apply locale-file changes directly into Studio storage, or remain preview-only until the broader staged import/apply path supports locale assets end-to-end?
3. Should future iterations add translation completeness, placeholder validation, or agent-message-key semantics on top of the current raw JSON asset workflow?
