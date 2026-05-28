# LLD: SDK Rich Content Templates

**Feature Spec**: `docs/features/sub-features/sdk-rich-content-templates.md`
**HLD**: `docs/specs/sdk-rich-content-templates.hld.md`
**Test Spec**: `docs/testing/sub-features/sdk-rich-content-templates.md`
**Status**: DONE (base rollout + parity remediation complete in current worktree)
**Date**: 2026-03-24

---

### Phase Status

| Phase | Name                                           | Status |
| ----- | ---------------------------------------------- | ------ |
| 1     | Registry Infrastructure + isSafeUrl Extraction | DONE   |
| 2     | Type Definitions + Migrated Renderers          | DONE   |
| 3     | Backend Schema + Interpolation                 | DONE   |
| 4     | Studio Catalog and Web-SDK Rename              | DONE   |
| 5     | Documentation Updates                          | DONE   |
| 6     | Post-Rollout Parity Remediation                | DONE   |

### Post-Implementation Notes (2026-04-16)

- The original 5 phases are complete, and the follow-on parity-remediation phase has now closed the major post-rollout gaps: shared channel-native payloads no longer disappear in web chat, assistant `actions` render through a single React path, React submit validation matches the DOM renderers, runtime synthesizes fallback text for web-facing surfaces when only channel-native payloads are present, and Studio exposes aligned support badges/preview behavior.
- The remediation work added `templates/support.ts`, `structured-preview.ts`, and `renderers/channel-fallback.ts`, routed assistant `actions` through `RichContent` in `MessageList.tsx`, implemented runtime/channel normalization in `apps/runtime/src/services/channel/outcome.ts`, and added Studio component plus isolated browser coverage for the fallback path.
- The current follow-on slice closes the `/rich-template` automation gap, truthfully discloses current DSL authoring support in the catalog/insert panel, adds widget button/select action round-trip coverage, preserves assistant prompt text in the legacy DOM widget path, and fixes the isolated Studio bootstrap path so encrypted model writes work under the browser harness.
- Remaining work from this point is narrower than the original remediation scope: broader widget/browser coverage for KPI/media/forms/charts/quick replies, richer parser/compiler authoring support beyond `FORMATS:` / `CAROUSEL:` / the current `ACTIONS:` subset, and any future v2 contract cleanup for channel-native payloads.

## 1. Design Decisions

### Decision Log

| #   | Decision                                                  | Rationale                                                                                                                                                                   | Alternatives Rejected                                                |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| D-1 | Diff-and-apply from feature branch, not `git cherry-pick` | Feature branch diverged heavily on shared files (`types.ts` removed `WebSocketLike`, made `endpoint` optional). Manual application ensures only additive changes are taken. | Mechanical `git cherry-pick` — would apply destructive type removals |
| D-2 | Two main LLD phases: SDK Core (P1) + Studio Catalog (P2)  | SDK renderers + backend schema are the core value. Studio catalog is developer convenience and can ship independently.                                                      | Single monolithic phase — too large to test incrementally            |
| D-3 | `isSafeUrl` extracted to `templates/utils/safe-url.ts`    | Avoids coupling new renderers back to `rich-renderer.ts` being refactored. Backwards-compat re-export preserved.                                                            | Export directly from `rich-renderer.ts` (feature branch approach)    |
| D-4 | Simple `Record<string, string>` for SDK i18n strings      | Zero external deps constraint. Only ~15 strings across all renderers. Consumers override via `setStrings()`.                                                                | Formal i18n framework — violates zero-deps                           |
| D-5 | `TemplateContext.onAction` wraps `RenderOptions.onAction` | Adds `label` param without modifying the existing `RenderOptions` interface. Emits `template:action` custom event for label consumers.                                      | Modify `RenderOptions.onAction` signature — breaks existing callers  |
| D-6 | Chart `renderDOM` uses inline SVG (no code-split)         | `renderDOM()` is synchronous — cannot use `import()`. SVG module (~200 lines) included in DOM bundle, tree-shaken if unused.                                                | Async DOM rendering — breaks `renderDOM` contract                    |
| D-7 | Explicit per-type interpolation handlers                  | URL fields must NOT be interpolated (XSS prevention). Numeric/enum fields must NOT be interpolated (type coercion). Matches carousel pattern.                               | Recursive walk — cannot distinguish URL from text fields             |
| D-8 | No feature flag                                           | All new `RichContent` fields are optional. Old SDKs ignore unknown fields. Rollback is `git revert`.                                                                        | Feature flag — unnecessary complexity for additive change            |

### Key Interfaces & Types

```typescript
// packages/web-sdk/src/templates/types.ts — NEW
export interface TemplateRenderer<T = unknown> {
  type: string;
  extract(message: Message): T | undefined;
  render(data: T, ctx: TemplateContext): React.ReactElement;
  renderDOM(data: T, ctx: TemplateContext): HTMLElement;
}

export interface TemplateContext {
  theme: Record<string, string>; // {} for this phase
  onAction: (actionId: string, value?: string, label?: string) => void;
  messageId: string;
}

// packages/web-sdk/src/templates/utils/strings.ts — NEW
export function getString(key: string): string;
export function setStrings(overrides: Record<string, string>): void;
```

See HLD Section 5 (Type Definitions) for the full 12 template sub-types (`QuickReply`, `ListTemplate`, `MediaContent`, `FileContent`, `KPITemplate`, `TableTemplate`, `ChartTemplate`, `FormTemplate`, `ProgressTemplate`, `FeedbackTemplate`).

### Module Boundaries

| Module                                  | Responsibility                                                             | Depends On                                   |
| --------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| `templates/registry.ts`                 | `TemplateRegistry` class — register, match, MAX_RENDERERS cap              | `templates/types.ts`                         |
| `templates/types.ts`                    | `TemplateRenderer<T>`, `TemplateContext` interfaces                        | `core/types.ts` (Message)                    |
| `templates/utils/safe-url.ts`           | `isSafeUrl()` — new public export, extracted from `rich-renderer.ts`       | None                                         |
| `templates/utils/strings.ts`            | SDK i18n — `getString()`, `setStrings()`, `DEFAULT_STRINGS`                | None                                         |
| `templates/renderers/*.ts`              | 15 self-registering renderers (3 migrated + 12 new)                        | `templates/types.ts`, `templates/utils/*`    |
| `templates/index.ts`                    | Barrel — import-order registration, exports                                | All renderers                                |
| `core/types.ts`                         | `RichContent` + 12 new sub-type interfaces                                 | None                                         |
| `ui/rich-renderer.ts`                   | DOM dispatcher — delegates to registry, re-exports `isSafeUrl`             | `templates/registry.ts`, `templates/utils/*` |
| `react/RichContent.tsx`                 | React dispatcher — delegates to registry                                   | `templates/registry.ts`                      |
| `core/types/rich-content-ast.ts` (core) | 12 new AST sub-type interfaces (extracted per Open Question 1)             | None                                         |
| `core/types/agent-based.ts` (core)      | `RichContentAST` + 12 camelCase fields, imports from `rich-content-ast.ts` | `rich-content-ast.ts`                        |
| `platform/ir/schema.ts` (compiler)      | `RichContentIR` + 12 new sub-type IR interfaces                            | None                                         |
| `platform/ir/compiler.ts` (compiler)    | `compileRichContent()` — 12 new AST→IR field mappings                      | `schema.ts`, `agent-based.ts`                |
| `value-resolution.ts` (runtime)         | `interpolateRichContent()` — 12 new per-type interpolation handlers        | `schema.ts`                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                          | Purpose                                   | LOC Estimate |
| ------------------------------------------------------------- | ----------------------------------------- | ------------ |
| `packages/web-sdk/src/templates/types.ts`                     | TemplateRenderer, TemplateContext         | 30           |
| `packages/web-sdk/src/templates/registry.ts`                  | TemplateRegistry class (MAX=50)           | 60           |
| `packages/web-sdk/src/templates/index.ts`                     | Barrel, import-order registration         | 25           |
| `packages/web-sdk/src/templates/utils/safe-url.ts`            | Extracted isSafeUrl (new public export)   | 25           |
| `packages/web-sdk/src/templates/utils/strings.ts`             | SDK i18n strings mechanism                | 25           |
| `packages/web-sdk/src/templates/renderers/markdown.ts`        | Migrated markdown renderer                | 40           |
| `packages/web-sdk/src/templates/renderers/carousel.ts`        | Migrated carousel renderer                | 80           |
| `packages/web-sdk/src/templates/renderers/actions.ts`         | Migrated actions renderer                 | 60           |
| `packages/web-sdk/src/templates/renderers/quick-replies.ts`   | Quick reply pills                         | 50           |
| `packages/web-sdk/src/templates/renderers/list.ts`            | List template                             | 60           |
| `packages/web-sdk/src/templates/renderers/image.ts`           | Image renderer                            | 40           |
| `packages/web-sdk/src/templates/renderers/video.ts`           | Video renderer                            | 40           |
| `packages/web-sdk/src/templates/renderers/audio.ts`           | Audio renderer                            | 40           |
| `packages/web-sdk/src/templates/renderers/file.ts`            | File download link                        | 35           |
| `packages/web-sdk/src/templates/renderers/kpi.ts`             | KPI card                                  | 50           |
| `packages/web-sdk/src/templates/renderers/table.ts`           | Data table with "Show more"               | 70           |
| `packages/web-sdk/src/templates/renderers/chart.ts`           | Chart dispatcher (lazy React, inline DOM) | 50           |
| `packages/web-sdk/src/templates/renderers/chart-inner.tsx`    | React SVG chart (code-split)              | 120          |
| `packages/web-sdk/src/templates/renderers/chart-inner-dom.ts` | DOM SVG chart (inline)                    | 120          |
| `packages/web-sdk/src/templates/renderers/form.ts`            | Form with ActionElement fields            | 60           |
| `packages/web-sdk/src/templates/renderers/progress.ts`        | Progress bar/circle                       | 45           |
| `packages/web-sdk/src/templates/renderers/feedback.ts`        | Thumbs/stars/scale rating                 | 55           |
| `packages/web-sdk/src/react/RichContent.tsx`                  | React dispatcher using registry           | 60           |
| `packages/web-sdk/src/__tests__/template-registry.test.ts`    | Registry register/match/overflow          | 80           |
| `packages/web-sdk/src/__tests__/template-renderers.test.ts`   | All 15 renderers DOM + React output       | 400          |
| `packages/web-sdk/src/__tests__/template-safe-url.test.ts`    | isSafeUrl integration across renderers    | 100          |
| `packages/core/src/types/rich-content-ast.ts`                 | 12 AST sub-type interfaces (per OQ-1)     | 80           |

### Modified Files

| File                                                      | Change Description                                                                                                                                              | Risk |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/web-sdk/src/core/types.ts`                      | Add 12 optional fields + 12 new type interfaces to `RichContent`                                                                                                | Low  |
| `packages/web-sdk/src/ui/rich-renderer.ts`                | Delegate `renderRichMessage` to registry; move `isSafeUrl`/`sanitizeHtml` to utils; re-export for backwards compat; update `hasRichContent` to check new fields | Med  |
| `packages/web-sdk/src/index.ts`                           | Add exports: `TemplateRegistry`, `TemplateRenderer`, `TemplateContext`, `setStrings`, `getString`, `isSafeUrl`                                                  | Low  |
| `packages/core/src/types/agent-based.ts`                  | Add 12 camelCase fields to `RichContentAST`, import + re-export sub-types from `rich-content-ast.ts`                                                            | Low  |
| `packages/compiler/src/platform/ir/schema.ts`             | Add 12 snake_case fields + sub-type IR interfaces to `RichContentIR`                                                                                            | Low  |
| `packages/compiler/src/platform/ir/compiler.ts`           | Extend `compileRichContent()` with 12 AST→IR field mappings                                                                                                     | Med  |
| `apps/runtime/src/services/execution/value-resolution.ts` | Extend `interpolateRichContent()` with 12 per-type interpolation handlers                                                                                       | Med  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Registry Infrastructure + isSafeUrl Extraction

**Goal**: Create the template registry system and extract shared utilities, establishing the foundation all renderers depend on.

**Tasks**:

1.1. Create `packages/web-sdk/src/templates/types.ts` with `TemplateRenderer<T>` and `TemplateContext` interfaces.

1.2. Create `packages/web-sdk/src/templates/registry.ts` with `TemplateRegistry` class: `register()`, `match()`, `MAX_RENDERERS = 50` cap, and exported `defaultRegistry` singleton. Note: TTL and eviction are N/A for this registry — it contains static code-registered renderers (not user data) that persist for the page lifetime. The MAX_RENDERERS cap is the only size guard needed.

1.3. Extract `isSafeUrl()` from `packages/web-sdk/src/ui/rich-renderer.ts` (currently a private, non-exported function at line 593) to `packages/web-sdk/src/templates/utils/safe-url.ts` as a **new public export**. This is NOT a backwards-compatible migration — `isSafeUrl` has never been exported. Add a convenience re-export from `rich-renderer.ts` so it co-locates with `sanitizeHtml`. Note: `sanitizeHtml` stays in `rich-renderer.ts` (it is already exported and moving it would break existing consumers).

1.4. Create `packages/web-sdk/src/templates/utils/strings.ts` with `DEFAULT_STRINGS`, `getString()`, and `setStrings()`. `setStrings()` must enforce a MAX_STRING_OVERRIDES=100 limit — log a warning and truncate if exceeded. Default strings include: `chart.loading` ("Loading chart..."), `chart.error` ("Failed to load chart"), `table.showMore` ("Show more"), `table.showLess` ("Show less"), `file.download` ("Download"), `progress.label` ("Progress"), `feedback.submit` ("Submit"), `quickReplies.label` ("Quick replies"), `form.submit` ("Submit").

1.5. Create `packages/web-sdk/src/templates/index.ts` barrel file (empty renderer imports for now — renderers added in Phase 2).

1.6. Write `packages/web-sdk/src/__tests__/template-registry.test.ts`: register, match ordering, MAX overflow, empty match returns [].

**Files Touched**:

- `packages/web-sdk/src/templates/types.ts` — NEW
- `packages/web-sdk/src/templates/registry.ts` — NEW
- `packages/web-sdk/src/templates/utils/safe-url.ts` — NEW (extracted from rich-renderer.ts)
- `packages/web-sdk/src/templates/utils/strings.ts` — NEW
- `packages/web-sdk/src/templates/index.ts` — NEW
- `packages/web-sdk/src/ui/rich-renderer.ts` — MODIFY (move isSafeUrl out, add re-export; sanitizeHtml stays in place)
- `packages/web-sdk/src/__tests__/template-registry.test.ts` — NEW

**Exit Criteria**:

- [x] `TemplateRegistry` class can register and match renderers by type
- [x] `register()` throws when MAX_RENDERERS (50) exceeded
- [x] `match()` returns matched renderers in registration order
- [x] `isSafeUrl` importable from `templates/utils/safe-url` (primary location) and re-exported from `ui/rich-renderer` (convenience co-location — this is a new public export, not a backwards-compat migration)
- [x] `pnpm build --filter=@agent-platform/web-sdk` succeeds with 0 errors
- [x] Registry unit tests pass (register, match, overflow, empty)

**Test Strategy**:

- Unit: TemplateRegistry register/match/overflow behavior, isSafeUrl protocol validation

**Rollback**: Delete `templates/` directory, restore `isSafeUrl`/`sanitizeHtml` to `rich-renderer.ts`.

---

### Phase 2: Type Definitions + Migrated Renderers

**Goal**: Extend the `RichContent` interface with 12 new fields, migrate existing 3 renderers into the registry, and add Tier 1 + Tier 2 renderers.

**Tasks**:

2.1. Add 12 new optional fields and their sub-type interfaces (`QuickReply`, `ListTemplate`, `MediaContent`, `FileContent`, `KPITemplate`, `TableTemplate`, `ChartTemplate`, `FormTemplate`, `ProgressTemplate`, `FeedbackTemplate`, plus `ListItem`, `TableColumn`, `ChartDataPoint`) to `packages/web-sdk/src/core/types.ts`. Source field shapes from HLD Section 5 Type Definitions.

2.2. Migrate the markdown rendering logic from `rich-renderer.ts` into `templates/renderers/markdown.ts` as a `TemplateRenderer<string>`. The renderer's `extract()` returns `message.richContent?.markdown`. Both `render()` and `renderDOM()` use `sanitizeHtml(renderMarkdown(data))`. Note: `renderers/markdown.ts` imports `sanitizeHtml` and `renderMarkdown` directly from `ui/rich-renderer.ts` — this is intentional and does NOT create a circular dependency (only importing from the `templates/index.ts` barrel would).

2.3. Migrate carousel rendering into `templates/renderers/carousel.ts` as `TemplateRenderer<Carousel>`. Fix the React hooks violation: extract `React.useRef` usage from the plain object `render()` method into a proper `CarouselTemplate` React function component.

2.4. Migrate actions rendering into `templates/renderers/actions.ts` as `TemplateRenderer<ActionSet>`.

2.5. Create Tier 1 renderers (source from feature branch diff, apply isSafeUrl to all URL fields):

- `templates/renderers/quick-replies.ts` — `role="group"`, `aria-label`, pill buttons, `isSafeUrl` on `icon_url`
- `templates/renderers/list.ts` — items with title/subtitle/image, `isSafeUrl` on `image_url`/`default_action_url`
- `templates/renderers/image.ts` — `<img>` with `alt`, `isSafeUrl` on `url`/`thumbnail_url`
- `templates/renderers/video.ts` — `<video>` with `aria-label`, `isSafeUrl` on `url`
- `templates/renderers/audio.ts` — `<audio>` with `aria-label`, `isSafeUrl` on `url`
- `templates/renderers/file.ts` — `<a>` download link, `isSafeUrl` on `url` (primary XSS vector)

  2.6. Create Tier 2 renderers:

- `templates/renderers/kpi.ts` — label, value, unit, trend indicator, `isSafeUrl` on `icon_url`
- `templates/renderers/table.ts` — semantic `<table>`, `<thead>`, `<th scope="col">`, "Show more" `<button>`, `max_visible_rows`
- `templates/renderers/chart.ts` — dispatcher: React uses dynamic `import('./chart-inner.tsx')` with loading placeholder; DOM calls `renderChartDOM()` directly
- `templates/renderers/chart-inner.tsx` — React SVG chart component (bar/line/pie)
- `templates/renderers/chart-inner-dom.ts` — DOM SVG chart generation (bar/line/pie)
- `templates/renderers/form.ts` — reuses `ActionElement`, collects values, dispatches action on submit
- `templates/renderers/progress.ts` — `role="progressbar"` with `aria-valuenow/min/max`, bar or circle variant
- `templates/renderers/feedback.ts` — `role="radiogroup"`, thumbs/stars/scale

  2.7. Update `templates/index.ts` barrel to import all 15 renderers in the canonical order: markdown → carousel → image → video → audio → file → list → kpi → table → chart → form → progress → feedback → actions → quick_replies.

  2.8. Create `packages/web-sdk/src/react/RichContent.tsx` — React dispatcher that calls `defaultRegistry.match(message)`, constructs `TemplateContext` from props (wrapping `onAction` to add `label` parameter), and renders matched results. Fix: use `React.useContext()` directly (no try/catch around hooks). The `onAction` wrapper emits a `template:action` custom event on `document` (not `window`) with `detail: { actionId, value, label, messageId }` — this allows consumers to listen globally without a ref to the message element. Include a test assertion for this event in `template-renderers.test.ts`.

  2.9. Rewrite `renderRichMessage()` in `rich-renderer.ts` to delegate to `defaultRegistry.match()` + `renderDOM()` calls, preserving existing fallback behavior for text-only messages. **CRITICAL**: `rich-renderer.ts` MUST import `defaultRegistry` from `'../templates/registry.js'` (NOT from `'../templates/index.js'`). Importing the barrel would create a circular dependency: `rich-renderer.ts` → `templates/index.ts` → `renderers/markdown.ts` → `rich-renderer.ts` (via `sanitizeHtml`/`renderMarkdown` imports). The barrel `templates/index.ts` is imported by the root `index.ts` to trigger renderer registration.

  2.10. Update `hasRichContent()` in `rich-renderer.ts` to check all 12 new fields. For array-typed fields (`quick_replies`), check `field && field.length > 0` (matching existing `carousel.cards.length > 0` pattern). For object-typed fields (`list`, `image`, `video`, `audio`, `file`, `kpi`, `table`, `chart`, `form`, `progress`, `feedback`), use truthiness check.

  2.11. Update `packages/web-sdk/src/index.ts` to export: `TemplateRegistry`, `defaultRegistry`, `TemplateRenderer`, `TemplateContext`, `setStrings`, `getString`, `isSafeUrl`.

  2.11b. Update `packages/web-sdk/src/react/index.ts` to export `RichContent` from `'./RichContent.js'`. This is required for Studio to import via `@agent-platform/web-sdk/react`.

  2.12. Write `packages/web-sdk/src/__tests__/template-renderers.test.ts`: test each renderer's `render()` and `renderDOM()` output, including isSafeUrl rejection for URL fields.

  2.13. Write `packages/web-sdk/src/__tests__/template-safe-url.test.ts`: integration test — construct messages with `javascript:`, `data:`, `http:`, `https:` URLs across all template types, verify only safe URLs produce rendered elements.

  2.14. Write backwards-compatibility integration test in `template-renderers.test.ts`: render a message with only the original 3 fields (markdown, carousel, actions) through the new registry, verify identical output to the pre-migration rendering path.

  2.15. Write registry dispatch integration test in `template-registry.test.ts`: construct a message with all 12 new fields + original 3, verify `defaultRegistry.match()` returns 15 matched renderers in registration order.

> **Test File Mapping** (deviation from feature spec Section 10): The feature spec lists 17 individual test files. Per LLD Open Question 2, SDK tests are consolidated into 3 files: `template-registry.test.ts` (registry + dispatch integration), `template-renderers.test.ts` (all 15 renderers + type shape `satisfies` + backwards compat), `template-safe-url.test.ts` (isSafeUrl integration). Studio keeps 4 test files per feature spec. Feature spec Section 10 will be updated in Phase 5 (Task 5.7) to reflect this consolidation.

**Files Touched**:

- `packages/web-sdk/src/core/types.ts` — MODIFY (+12 fields, +12 interfaces)
- `packages/web-sdk/src/templates/renderers/*.ts` — 18 NEW files
- `packages/web-sdk/src/templates/index.ts` — MODIFY (add all renderer imports)
- `packages/web-sdk/src/react/RichContent.tsx` — NEW
- `packages/web-sdk/src/ui/rich-renderer.ts` — MODIFY (delegate to registry, update hasRichContent)
- `packages/web-sdk/src/index.ts` — MODIFY (add exports)
- `packages/web-sdk/src/react/index.ts` — MODIFY (add RichContent export)
- `packages/web-sdk/src/__tests__/template-renderers.test.ts` — NEW
- `packages/web-sdk/src/__tests__/template-safe-url.test.ts` — NEW

**Exit Criteria**:

- [x] `RichContent` interface has all 12 new optional fields (verify with `tsc --noEmit`)
- [x] All 15 renderers registered in `defaultRegistry` (verify `defaultRegistry.match()` returns 15 for a message with all fields populated)
- [x] `isSafeUrl()` called on every renderer that accepts URL fields: file, image, video, audio, list (image_url, default_action_url), quick-replies (icon_url), kpi (icon_url), carousel React path
- [x] No React hooks violations: no conditional hooks, no hooks in non-component functions (verify carousel uses `CarouselTemplate` component, RichContent.tsx uses `useContext` directly)
- [x] `hasRichContent()` returns true for messages with any of the 12 new fields
- [x] `renderRichMessage()` delegates to registry and renders all template types
- [x] Chart renderer: React path uses `React.lazy(() => import('./chart-inner.tsx'))` with loading placeholder (`getString('chart.loading')`); DOM path uses `renderChartDOM()` inline (FR-6 exit criterion — lazy-loading verified by confirming `chart-inner.tsx` is NOT in the initial bundle, only loaded on first chart render)
- [x] `pnpm build --filter=@agent-platform/web-sdk` succeeds with 0 errors
- [x] All renderer unit tests pass (DOM + React output for each type)
- [x] isSafeUrl integration tests pass (javascript: blocked across all renderers)

**Test Strategy**:

- Unit: Each renderer's `render()` and `renderDOM()` output shape. isSafeUrl rejection per renderer.
- Integration: Multi-field message through registry dispatch.

**Rollback**: Revert types.ts to 7-field RichContent. Delete renderer files. Restore inline rendering in rich-renderer.ts.

---

### Phase 3: Backend Schema + Interpolation

**Goal**: Extend the compiler IR and runtime value-resolution to support the 12 new template types end-to-end.

**Tasks**:

3.1. Create `packages/core/src/types/rich-content-ast.ts` with 12 AST sub-type interfaces (`QuickReplyAST`, `ListTemplateAST`, `ListItemAST`, `MediaContentAST`, `FileContentAST`, `KPITemplateAST`, `TableTemplateAST`, `TableColumnAST`, `ChartTemplateAST`, `ChartDataPointAST`, `FormTemplateAST`, `ProgressTemplateAST`, `FeedbackTemplateAST`). Sub-type AST interfaces use camelCase (e.g., `ListItemAST.imageUrl`, `ListItemAST.defaultActionUrl`). Then add 12 camelCase fields to `RichContentAST` in `packages/core/src/types/agent-based.ts`, importing the sub-types from `rich-content-ast.ts` and re-exporting them:

- `quickReplies?: QuickReplyAST[]`
- `list?: ListTemplateAST`
- `image?: MediaContentAST`, `video?: MediaContentAST`, `audio?: MediaContentAST`
- `file?: FileContentAST`
- `kpi?: KPITemplateAST`, `table?: TableTemplateAST`, `chart?: ChartTemplateAST`
- `form?: FormTemplateAST`, `progress?: ProgressTemplateAST`, `feedback?: FeedbackTemplateAST`

  This matches Open Question 1 — `agent-based.ts` is already ~1000 lines, so sub-types live in a dedicated file.

  3.2. Add 12 snake_case fields + sub-type IR interfaces to `RichContentIR` in `packages/compiler/src/platform/ir/schema.ts`:

- `quick_replies?: QuickReplyIR[]`
- `list?: ListTemplateIR`
- `image?: MediaContentIR`, `video?: MediaContentIR`, `audio?: MediaContentIR`
- `file?: FileContentIR`
- `kpi?: KPITemplateIR`, `table?: TableTemplateIR`, `chart?: ChartTemplateIR`
- `form?: FormTemplateIR`, `progress?: ProgressTemplateIR`, `feedback?: FeedbackTemplateIR`
  IR sub-types mirror SDK types 1:1 (both use snake_case).

  3.3. Extend `compileRichContent()` in `packages/compiler/src/platform/ir/compiler.ts` with 12 new AST→IR mappings. For simple types (media, file, kpi, progress, feedback), this is a direct camelCase→snake_case field copy. For complex types (list, table, form), map nested sub-fields (e.g., `ast.list.items[].imageUrl` → `ir.list.items[].image_url`).

  3.4. Extend `interpolateRichContent()` in `apps/runtime/src/services/execution/value-resolution.ts` with 12 per-type interpolation handlers following the HLD Interpolation Strategy table. Use **explicit field enumeration** matching the existing pattern (lines 114-122): each new field gets a conditional line `fieldName: rc.fieldName ? interpolateFieldName(rc.fieldName, vars) : undefined`. This preserves the existing semantics where omitted fields are explicitly `undefined` (not missing keys), consistent with the HLD decision D-7 ("Explicit per-type handlers matching carousel pattern"). Add helper functions per complex type (e.g., `interpolateList()`, `interpolateTable()`, `interpolateKPI()`).

  3.5. Run `pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime --filter=@abl/core` to verify type alignment.

  3.6. Add test assertions to `packages/compiler/src/__tests__/ir/rich-content-compilation.test.ts` for the 12 new field AST→IR mappings.

  3.7. Add test assertions to `apps/runtime/src/__tests__/value-resolution.test.ts` for `interpolateRichContent`: construct IR with all 12 fields containing `{{variable}}` in text fields, verify text fields are interpolated and URL/numeric fields are pass-through.

**Files Touched**:

- `packages/core/src/types/rich-content-ast.ts` — NEW (12 AST sub-type interfaces)
- `packages/core/src/types/agent-based.ts` — MODIFY (+12 AST fields, import + re-export sub-types from rich-content-ast.ts)
- `packages/compiler/src/platform/ir/schema.ts` — MODIFY (+12 IR fields + interfaces)
- `packages/compiler/src/platform/ir/compiler.ts` — MODIFY (extend compileRichContent)
- `apps/runtime/src/services/execution/value-resolution.ts` — MODIFY (extend interpolateRichContent)
- `packages/compiler/src/__tests__/ir/rich-content-compilation.test.ts` — MODIFY (add 12-field test)
- `apps/runtime/src/__tests__/value-resolution.test.ts` — MODIFY (add 12-type interpolation test)

**Exit Criteria**:

- [x] `RichContentAST` has 12 new camelCase fields
- [x] `RichContentIR` has 12 new snake_case fields
- [x] `compileRichContent()` maps all 12 new AST fields to IR equivalents
- [x] `interpolateRichContent()` handles all 12 new types with per-field interpolation
- [x] Text fields (`label`, `title`, `prompt`, etc.) are interpolated
- [x] URL fields (`url`, `image_url`, `icon_url`, etc.) are NOT interpolated
- [x] Numeric/enum fields (`value`, `trend`, `type`, etc.) are NOT interpolated
- [x] `pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime --filter=@abl/core` succeeds
- [x] Compiler AST→IR mapping tests pass for all 12 new types
- [x] Runtime interpolation test passes — {{variables}} resolved in text fields, preserved in non-text fields

**Test Strategy**:

- Unit: compileRichContent AST→IR mapping for each new type
- Integration: interpolateRichContent with all 12 types and variable placeholders

**Rollback**: Revert the 3 modified files. Purely additive — no data migration.

---

### Phase 4: Studio Template Catalog

**Goal**: Add the Studio Template Catalog page with browsing, live preview, JSON editing, DSL snippet insertion, and `/rich-template` command integration.

**Tasks**:

4.1. Create `apps/studio/src/lib/template-catalog.ts` — static catalog data organized by category (Content, Media, Data, Input, Feedback). Each entry has: type, name, description, category, example JSON, DSL snippet. Placed in `lib/` following the existing Studio convention (not `data/`).

4.2. Create `apps/studio/src/components/templates/TemplateMockProvider.tsx` — provides a mock `TemplateContext` with `theme: {}`, no-op `onAction`, and a test `messageId`. Wraps web-sdk `RichContent` components for preview.

4.3. Create `apps/studio/src/components/templates/TemplatePreview.tsx` — renders a selected template with mock data using `TemplateMockProvider`.

4.4. Create `apps/studio/src/components/templates/TemplateJsonEditor.tsx` — editable JSON textarea for template data. Debounced validation. `maxLength` limit. `useEffect` cleanup for debounce timer.

4.5. Create `apps/studio/src/components/templates/TemplateDSLView.tsx` — DSL snippet display with copy-to-clipboard. Add `.catch()` to clipboard API call.

4.6. Create `apps/studio/src/components/templates/TemplateCatalogPage.tsx` — gallery page with category tabs, search/filter, live preview, JSON editor, DSL viewer. Uses semantic design tokens for light/dark mode.

4.7. Create `apps/studio/src/components/templates/TemplateInsertPanel.tsx` — slide-over panel for rich content template browsing and insertion. Use navigation store (not `window.history.pushState`).

4.8. Wire `TemplateCatalogPage` into Studio routing:

- Add `'templates'` to the `ProjectPage` type union in `apps/studio/src/store/navigation-store.ts`
- Add `case 'templates':` rendering entry in `apps/studio/src/components/navigation/AppShell.tsx` with import for `TemplateCatalogPage`
- Add a `NavItemDef` for "Templates" in `apps/studio/src/components/navigation/ProjectSidebar.tsx`: `{ id: 'templates', Icon: LayoutTemplate, key: 'templates' }` placed after `connections` in the top-level nav items (grouping with build-time tools). Add `LayoutTemplate` to the lucide-react import block (lines 9-51)

  4.9. Resolve `/template` command conflict. The existing `/template` command in `CommandRegistry.ts` (id: `'template'`, line 87) opens `TemplatePickerModal` (message templates — reusable text fragments). This is a **different feature** from rich content templates. Resolution: add a new `/rich-template` command (id: `'rich-template'`) in `CommandRegistry.ts` for the `TemplateInsertPanel`. The existing `/template` command for message templates is left unchanged. **CRITICAL**: The dispatch in `ABLEditor.tsx` (line 162) uses `command.id.includes('template')` to open `TemplatePickerModal`. Since `'rich-template'.includes('template')` is `true`, the new command will trigger the wrong handler. Fix: add a new `else if (command.id === 'rich-template')` branch in `ABLEditor.tsx` **BEFORE** the existing `else if (command.id.includes('template'))` check, so it matches first and opens `TemplateInsertPanel`. Exact code change:

```typescript
// ABLEditor.tsx — insert BEFORE the existing .includes('template') branch
} else if (command.id === 'rich-template') {
  setShowTemplateInsertPanel(true);
} else if (command.id.includes('template')) {
  // Existing handler for 'template', 'voice-template', etc.
  setShowTemplatePicker(true);
}
```

Note: the existing `.includes('template')` pattern also matches `'voice-template'` (CommandRegistry.ts line 101) — this is a pre-existing design choice that routes all `*-template` variants to `TemplatePickerModal`. The new `'rich-template'` exact match intercepts before this catch-all.

4.10. Add i18n translation keys under a new `"templates"` top-level key in `packages/i18n/locales/en/studio.json` for all catalog page strings. Add the nav item label under the existing `"nav"` key. Wire `useTranslations('templates')` in all Studio template components.

4.11. Write Studio component tests:

- `apps/studio/src/__tests__/template-catalog.test.ts` — catalog data shape validation
- `apps/studio/src/__tests__/template-catalog-page.test.tsx` — gallery page renders categories
- `apps/studio/src/__tests__/template-insert-panel.test.tsx` — slide-over opens and inserts
- `apps/studio/src/__tests__/template-preview.test.tsx` — preview renders all 15 types (this covers integration scenario 5: Studio catalog preview renders all 15 types through TemplateMockProvider)

**Files Touched**:

- `apps/studio/src/lib/template-catalog.ts` — NEW
- `apps/studio/src/components/templates/*.tsx` — 6 NEW files
- `apps/studio/src/store/navigation-store.ts` — MODIFY (add `'templates'` to `ProjectPage` union)
- `apps/studio/src/components/navigation/AppShell.tsx` — MODIFY (add templates case)
- `apps/studio/src/components/navigation/ProjectSidebar.tsx` — MODIFY (add nav item)
- `apps/studio/src/components/abl/commands/CommandRegistry.ts` — MODIFY (add `/rich-template` command)
- `apps/studio/src/components/abl/ABLEditor.tsx` — MODIFY (handle `rich-template` command)
- `packages/i18n/locales/en/studio.json` — MODIFY
- `apps/studio/src/__tests__/template-*.test.ts(x)` — 4 NEW test files

**Exit Criteria**:

- [x] Template Catalog page renders at `/projects/:projectId/templates` with all 15 templates organized by category
- [x] Live preview renders each template type correctly
- [x] JSON editor validates input and updates preview on change
- [x] DSL snippet copy-to-clipboard works with `.catch()` error handling
- [x] `/rich-template` command opens `TemplateInsertPanel` slide-over panel (existing `/template` for message templates unchanged)
- [x] All strings use `useTranslations('templates')` — new keys under `"templates"` object in `studio.json`. Nav item label uses existing `"nav"` namespace. No hardcoded user-facing text
- [x] Light/dark mode use semantic design tokens
- [x] `pnpm build --filter=@agent-platform/studio` succeeds
- [x] All 4 Studio component tests pass

**Test Strategy**:

- Unit: Catalog data shape, component rendering, insert panel behavior
- Integration: Studio catalog preview renders all 15 template types through TemplateMockProvider

**Rollback**: Remove Studio template components and navigation entry. Revert i18n additions.

---

### Phase 5: Verification + Cleanup

**Goal**: Full build, test suite, type-check, and formatting verification across all affected packages.

**Tasks**:

5.1. Run `pnpm build` for all affected packages and verify 0 errors.

5.2. Run `tsc --noEmit` for `packages/web-sdk`, `packages/compiler`, `packages/core`, `apps/runtime`, `apps/studio`.

5.3. Run all template tests: `pnpm test --filter=@agent-platform/web-sdk`, `pnpm test --filter=@abl/compiler`, `pnpm test --filter=@agent-platform/runtime`, `pnpm test --filter=@agent-platform/studio`.

5.4. Run `npx prettier --write` on all changed files.

5.5. Run `./tools/run-semgrep.sh` on web-sdk and studio for security scanning.

5.6. Verify FR coverage: walk through all 16 FRs and confirm each has either automated coverage or an explicitly documented gap.

5.7. Update feature spec status from ALPHA to BETA. Update test spec coverage matrix — mark all unit tests as covered. Verify feature spec path in this LLD header matches actual file location (`docs/features/sub-features/sdk-rich-content-templates.md`). Sync the following feature spec deviations:

- Section 10: `apps/studio/src/data/template-catalog.ts` → `apps/studio/src/lib/template-catalog.ts` (LLD Task 4.1 — follows Studio `lib/` convention)
- Section 10: `packages/web-sdk/src/react/components/RichContent.tsx` → `packages/web-sdk/src/react/RichContent.tsx` (LLD Task 2.8 — `react/` dir is flat, no `components/` subdir)
- Section 10: 17 test files → 3 consolidated SDK test files + 4 Studio test files (LLD Open Question 2)
- FR-9: `/template` → `/rich-template` (LLD Task 4.9 — existing `/template` command serves message templates); document the now-shipped command-trigger automation and current DSL authoring disclosure
- Gaps section: Keep the broader browser matrix and richer parser-authoring surface as follow-up items

  5.8. Verify test consolidation per Open Question 2 — `template-renderers.test.ts` should include type shape `satisfies` assertions as the first test group before renderer output tests. Confirm no stale standalone type-shape test file exists.

**Files Touched**:

- `docs/features/sub-features/sdk-rich-content-templates.md` — MODIFY (status update)
- `docs/testing/sub-features/sdk-rich-content-templates.md` — MODIFY (coverage matrix update)

**Exit Criteria**:

- [x] `pnpm build` succeeds for all affected packages (0 errors)
- [x] `tsc --noEmit` passes for all affected packages
- [x] All template tests pass (registry, renderers, safe-url, compiler, runtime, Studio component suites, `/rich-template` command coverage, and the isolated widget fallback/action E2E lane)
- [x] FR-14 / FR-15 / FR-16 parity-remediation requirements now have automated coverage
- [x] `npx prettier --check` passes on all changed files
- [x] `semgrep` reports no new security findings
- [x] Feature spec status updated to BETA
- [x] Test spec coverage matrix reflects shipped reality, including the current DSL authoring disclosure, browser coverage, and remaining broader-browser follow-up

**Test Strategy**:

- Full suite execution across all packages

**Rollback**: N/A — this phase is verification only.

---

## 4. Wiring Checklist

- [x] `TemplateRegistry` exported from `packages/web-sdk/src/templates/index.ts`
- [x] `defaultRegistry` singleton exported from barrel
- [x] All 15 renderers imported in barrel file (import-order = render-order)
- [x] `isSafeUrl` re-exported from `rich-renderer.ts` for convenience co-location with `sanitizeHtml` (not backwards compat — it was never exported before)
- [x] `TemplateRegistry`, `TemplateRenderer`, `TemplateContext`, `setStrings`, `getString`, `isSafeUrl` exported from `packages/web-sdk/src/index.ts`
- [x] `renderRichMessage()` delegates to `defaultRegistry.match()` + `renderDOM()` calls
- [x] `rich-renderer.ts` imports `defaultRegistry` from `templates/registry.ts` (NEVER from `templates/index.ts` barrel — circular dependency)
- [x] `hasRichContent()` checks all 12 new `RichContent` fields
- [x] `RichContent` exported from `packages/web-sdk/src/react/index.ts` (required for `@agent-platform/web-sdk/react` import path)
- [x] `RichContent.tsx` React component imported and used by consuming React components
- [x] `RichContentAST` new fields used by `compileRichContent()` in compiler
- [x] `RichContentIR` new fields used by `interpolateRichContent()` in runtime
- [x] Studio `TemplateCatalogPage` registered in AppShell routing
- [x] "Templates" navigation item added to project sidebar
- [x] `/rich-template` command added to `CommandRegistry.ts` (existing `/template` for message templates is unchanged)
- [x] `/rich-template` command handler wired in `ABLEditor.tsx` to open `TemplateInsertPanel`
- [x] `'templates'` added to `ProjectPage` type union in `navigation-store.ts`
- [x] `case 'templates':` added to `AppShell.tsx` page-rendering switch
- [x] "Templates" nav item added to `ProjectSidebar.tsx`
- [x] i18n keys added to `packages/i18n/locales/en/studio.json`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Template content is transient wire-format data — not persisted.

### Feature Flags

None. All new fields are optional and backwards-compatible.

### Configuration Changes

None. No new env vars, no runtime config changes.

### Package Dependency Notes

The `templates/` directory is a new module within `packages/web-sdk`. It does NOT create a new package — it's internal to `@agent-platform/web-sdk`. No `pnpm-lock.yaml` changes needed for template code. Studio imports web-sdk components directly (existing dependency).

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All 6 phases complete with exit criteria met
- [x] The post-rollout parity-remediation requirements (FR-14, FR-15, FR-16) now have automated coverage
- [x] The `/rich-template` command dispatch path now has dedicated automated coverage
- [x] Three rich-content browser scenarios from the test spec now pass (`apps/studio/e2e/sdk-widget.spec.ts`: fallback, ActionSet button, ActionSet select)
- [ ] Broader browser E2E scenarios for KPI/media/forms/charts/quick replies remain a follow-up beyond the current fallback + ActionSet lane
- [ ] Richer parser/compiler authoring support remains a follow-up beyond `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset
- [x] 7 integration test scenarios from the current test spec pass (registry dispatch, value-resolution pass-through, isSafeUrl integration, backwards compatibility, compiler IR compilation, shared web-surface parity, runtime/channel normalization)
- [x] No regressions in existing tests (`pnpm build && pnpm test`)
- [x] Zero `isSafeUrl` gaps — every renderer with URL fields validated
- [x] Zero React hooks violations — `tsc --noEmit` + manual review
- [x] All user-facing strings internationalized (Studio: `useTranslations`, SDK: `getString()`)
- [x] Feature spec updated to BETA status
- [x] Test spec coverage matrix reflects the shipped component/browser coverage and the remaining explicit automation gaps

---

## 7. Open Questions

1. **DECIDED**: AST sub-types go in a new `packages/core/src/types/rich-content-ast.ts` file, imported and re-exported from `agent-based.ts`. Rationale: `agent-based.ts` is already ~1000 lines; 12 new interfaces would push it to ~1100+. Separation keeps files focused.
2. **DECIDED**: Consolidate into `template-renderers.test.ts` with type shape validation `satisfies` assertions included as the first test group before renderer output tests. This reduces test file count and co-locates related assertions.
3. **DECIDED**: Keep `chart-inner-dom.ts` as a separate file. Consistent with `chart-inner.tsx` separation. `chart.ts` stays clean as a dispatcher (~50 lines).
