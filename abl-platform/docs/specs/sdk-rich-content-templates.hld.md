# HLD: SDK Rich Content Templates

**Feature Spec**: `docs/features/sub-features/sdk-rich-content-templates.md`
**Test Spec**: `docs/testing/sub-features/sdk-rich-content-templates.md`
**Status**: IMPLEMENTED (base rollout + parity remediation complete)
**Author**: Platform team
**Date**: 2026-03-24

---

### Post-Implementation Notes (2026-04-16)

- The March rollout shipped the registry, 12 template types, Studio catalog, and runtime/compiler pass-through, but a follow-on audit found parity gaps between the shared `RichContent` contract and what web chat / Studio actually rendered.
- The current remediation adds a shared support matrix (`templates/support.ts`), a safe `channel_fallback` renderer for `adaptive_card` / `slack` / `whatsapp` / `ag_ui`, unified assistant action rendering through `RichContent`, and React validation parity for deferred `actions` / `form` submits.
- Studio now consumes the shared support metadata to expose native/fallback/limited-preview badges and to preview HTML, channel-native fallback blocks, and raw ActionSet payloads, while the catalog/insert panel separately disclose current DSL authoring modes (`supported`, `partial`, `preview_only`) based on the actual parser/compiler surface.
- Runtime/channel normalization is now implemented in `apps/runtime/src/services/channel/outcome.ts`, so web-facing surfaces synthesize fallback text when only channel-native payloads are present and forward `usedFallback` through websocket and HTTP chat paths.
- Studio component coverage now exists for catalog badges, DSL authoring disclosure, HTML sanitization, raw `actions`, fallback previews, and the `/rich-template` command path, and the SDK widget now has isolated browser regressions for the channel-native fallback path plus ActionSet button/select round-trips.
- The remaining follow-ons are narrower: broader browser coverage for KPI/media/forms/charts/quick replies, richer parser/compiler authoring support beyond `FORMATS:` / `CAROUSEL:` / the current `ACTIONS:` subset, and possible v2 contract cleanup for channel-native payloads.

## 1. Problem Statement

The Web SDK renders only 3 template types (markdown, buttons, carousel) while industry-standard SDKs ship 12-15. Existing renderers are inline in a monolithic `rich-renderer.ts` (609 lines) with no shared abstraction — adding a new type requires modifying both the vanilla DOM and React render paths, duplicating patterns for theming, action dispatch, URL validation, and error states.

This HLD defines the architecture for a pluggable `TemplateRegistry` with 12 new rich content renderers, a Studio Template Catalog for discovery, and the security/quality fixes needed to ship safely.

---

## 2. Alternatives Considered

### Option A: Inline Extension (status quo)

- **Description**: Add 12 new if/else branches to `rich-renderer.ts` and corresponding React elements in `RichMessage.tsx`. Keep all rendering logic in two files.
- **Pros**: No new abstractions. Simple to understand. Zero structural changes.
- **Cons**: Both files grow to 1500+ lines. Every new type touches both files. No way for consumers to register custom types. Duplicated URL validation, action dispatch, error handling per renderer.
- **Effort**: M

### Option B: Template Registry with Self-Registration (recommended)

- **Description**: Extract a `TemplateRegistry` singleton with `TemplateRenderer<T>` interface. Each renderer self-registers via barrel import. Both React and DOM dispatchers iterate the registry.
- **Pros**: O(1) effort to add new types (create renderer file, import in barrel). Shared `TemplateContext` for theme/action/messageId. Render order controlled by import order. Supports future customer-defined templates. Existing renderers migrate with zero behavior change.
- **Cons**: Import-order-based priority is implicit (documented in barrel file). Registry singleton means one shared instance per page load.
- **Effort**: M

### Option C: Web Components Per Template

- **Description**: Each template type is a self-contained Web Component (`<sdk-kpi-card>`, `<sdk-data-table>`, etc.) using Shadow DOM for style isolation.
- **Pros**: True encapsulation. Works in any framework. Style isolation via Shadow DOM.
- **Cons**: React integration requires wrapper components. Shadow DOM complicates theming (CSS custom properties only). Existing markdown/carousel/actions would need rewriting as Web Components. Higher bundle cost.
- **Effort**: L

### Recommendation: Option B — Template Registry

**Rationale**: The registry pattern is the right balance of extensibility and simplicity. It preserves the dual-render architecture (React + DOM) that the SDK already uses, avoids the Web Component / Shadow DOM complexity that would break theming, and makes adding new template types a single-file operation. The feature branch already implements this pattern — cherry-picking is the lowest-risk path.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Platform                          │
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐   │
│  │ Compiler  │───>│ Runtime  │───>│    WebSocket /ws/sdk  │   │
│  │ (IR emit) │    │ (interp) │    │  response_end msg     │   │
│  └──────────┘    └──────────┘    └──────────┬───────────┘   │
│                                              │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Browser (web-sdk)                         │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ChatClient│───>│TemplateRegis │───>│ TemplateRenderer[] │  │
│  │ Message   │    │ .match(msg)  │    │ .render(data,ctx)  │  │
│  └──────────┘    └──────────────┘    └───────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Registered Renderers (import order = render order):   │  │
│  │  markdown → carousel → image → video → audio → file   │  │
│  │  → list → kpi → table → chart → form → progress       │  │
│  │  → feedback → actions → quick_replies                  │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     Studio (apps/studio)                      │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │ Template Catalog    │───>│ TemplateMockProvider          │ │
│  │ /projects/:id/     │    │  + web-sdk RichContent        │ │
│  │   templates        │    │  (live preview)               │ │
│  └────────────────────┘    └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
packages/web-sdk/src/
├── core/types.ts              ← RichContent interface (MODIFY: +12 fields)
├── ui/rich-renderer.ts        ← DOM dispatcher (MODIFY: delegate to registry)
├── templates/
│   ├── types.ts               ← NEW: TemplateRenderer<T>, TemplateContext
│   ├── registry.ts            ← NEW: TemplateRegistry class (MAX=50)
│   ├── index.ts               ← NEW: barrel, import-order registration
│   ├── utils/
│   │   ├── safe-url.ts        ← NEW: extracted isSafeUrl (sanitizeHtml stays in rich-renderer.ts)
│   │   ├── strings.ts         ← NEW: SDK i18n — getString(), setStrings()
│   │   └── chart-colors.ts    ← NEW: shared DEFAULT_COLORS for chart renderers
│   └── renderers/
│       ├── markdown.ts        ← Migrated from rich-renderer.ts
│       ├── carousel.ts        ← Migrated from rich-renderer.ts
│       ├── actions.ts         ← Migrated from rich-renderer.ts
│       ├── quick-replies.ts   ← NEW (Tier 1)
│       ├── list.ts            ← NEW (Tier 1)
│       ├── image.ts           ← NEW (Tier 1)
│       ├── video.ts           ← NEW (Tier 1)
│       ├── audio.ts           ← NEW (Tier 1)
│       ├── file.ts            ← NEW (Tier 1)
│       ├── kpi.ts             ← NEW (Tier 2)
│       ├── table.ts           ← NEW (Tier 2)
│       ├── chart.ts           ← NEW (Tier 2, lazy-loaded React)
│       ├── chart-inner.tsx    ← NEW (React SVG, code-split)
│       ├── chart-inner-dom.ts ← NEW (DOM SVG, inline — renderDOM is sync)
│       ├── form.ts            ← NEW (Tier 2)
│       ├── progress.ts        ← NEW (Tier 2)
│       └── feedback.ts        ← NEW (Tier 2)
├── react/
│   └── RichContent.tsx        ← NEW: React dispatcher using registry

packages/core/src/
├── types/rich-content-ast.ts  ← NEW: 12 AST sub-type interfaces
├── types/agent-based.ts       ← RichContentAST interface (MODIFY: +12 fields, imports sub-types)

packages/compiler/src/
├── platform/ir/schema.ts      ← RichContentIR interface (MODIFY: +12 fields)

apps/runtime/src/
├── services/execution/
│   └── value-resolution.ts    ← interpolateRichContent (MODIFY: +12 type handlers)
```

### Data Flow

1. **Compiler** emits `RichContentIR` with optional template fields on step/response objects
2. **Runtime** `interpolateRichContent()` resolves `{{variable}}` placeholders — see [Interpolation Strategy](#interpolation-strategy) below
3. **WebSocket** sends `response_end` message with `richContent` and `actions` as top-level fields
4. **ChatClient** constructs `Message` object with `richContent: RichContent`
5. **Registry** `defaultRegistry.match(message)` iterates registered renderers, calls `extract(message)` on each
6. **Matched renderers** produce `ReactElement` (via `render()`) or `HTMLElement` (via `renderDOM()`)
7. **Dispatchers** (`RichContent.tsx` or `rich-renderer.ts`) compose matched results into the message bubble

### Key Design Decisions

| Decision            | Choice                                               | Rationale                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry scope      | Module-level singleton (`defaultRegistry`)           | One registry per page load; multiple widgets share renderers. Class exported for testing.                                                                                                                                                                    |
| Render order        | Import order in barrel file                          | Explicit, deterministic, easy to reorder. Documented in `templates/index.ts`.                                                                                                                                                                                |
| isSafeUrl placement | Extracted to `templates/utils/safe-url.ts`           | Avoids coupling new renderers back to the legacy `rich-renderer.ts` being refactored. `rich-renderer.ts` re-exports for backwards compatibility.                                                                                                             |
| Chart loading       | Dynamic `import()` for React; inline SVG for DOM     | React path uses `Suspense`-style loading placeholder. DOM path renders SVG inline (no code-split) since `renderDOM` is synchronous — the SVG generation module (~200 lines) is included in the DOM bundle but tree-shaken when the chart renderer is unused. |
| Form fields         | Reuse existing `ActionElement` type                  | Form inputs are buttons/selects/inputs — exactly what `ActionElement` models.                                                                                                                                                                                |
| Quick replies       | Separate `QuickReply` type (not `ActionElement`)     | Simpler interface (id + label only). Purpose-built for pill-shaped chips.                                                                                                                                                                                    |
| onAction signature  | `(actionId, value?, label?)` — adds optional `label` | Quick replies need label for display; backwards-compatible (existing callers pass 2 args).                                                                                                                                                                   |
| Theme wiring        | `TemplateContext.theme` is `{}` for this phase       | Renderers MUST NOT depend on theme values. Use CSS custom properties from host widget. Theme population deferred to theming feature.                                                                                                                         |

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | N/A — templates are stateless client-side rendering. No server-side queries, no data storage. The Studio catalog page route is scoped to `/projects/:projectId/templates` but only shows static catalog data.                                                                                                                                                                                                                                                                                                                                    |
| 2   | **Data Access Pattern** | No database access. Template data flows through the wire format only. Registry is an in-memory singleton with O(n) match scan (n<=50). Studio catalog uses static `template-catalog.ts` module.                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **API Contract**        | `RichContent` interface extended with 12 optional fields (additive, non-breaking). `isSafeUrl` extracted to `templates/utils/safe-url.ts` and re-exported from `rich-renderer.ts` for backwards compatibility. `TemplateRegistry`, `TemplateRenderer<T>`, `TemplateContext` are new public types. Error envelope: renderers return `null` for unrecognized data; no exceptions thrown during rendering.                                                                                                                                          |
| 4   | **Security Surface**    | **XSS prevention**: Every renderer accepting user-controlled URLs (`url`, `image_url`, `thumbnail_url`, `icon_url`, `default_action_url`) MUST call `isSafeUrl()` before rendering. Blocks `javascript:`, `data:` (except allowlisted images), and unknown protocols. **HTML sanitization**: Markdown renderer continues to use existing `sanitizeHtml()`. No `innerHTML` with user data in new renderers — all use `textContent` or `createElement`. **No auth changes**: This feature does not modify any auth middleware or session handling. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Malformed template data → renderer returns `null`, message renders with text/markdown only. Unknown template type → `match()` returns empty array, same fallback. Chart lazy-load failure → `.catch()` replaces loading placeholder with error message. React rendering errors → caught by error boundary at message bubble level. No user-facing error dialogs — graceful degradation. |
| 6   | **Failure Modes** | **Network**: Chart `import()` fails → error placeholder shown, other templates unaffected. **Malformed data**: Missing required fields → partial render or skip. **Registry overflow**: `register()` throws at MAX_RENDERERS=50 — development-time error only, not possible in production with fixed set.                                                                               |
| 7   | **Idempotency**   | N/A — rendering is a pure function of message data. Same input → same output. No side effects beyond DOM mutation. No server state.                                                                                                                                                                                                                                                     |
| 8   | **Observability** | Client-side only. No new trace events or server metrics. Browser DevTools for debugging. Future: consider `templateRenderError` SDK event for monitoring chart load failures and malformed data errors.                                                                                                                                                                                 |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Bundle: ~13-20KB total, zero external deps. Chart lazy-loaded (~3-4KB gzipped, loaded on demand). Registry match: O(15) per message — negligible. No render-time budget defined (pure DOM/React element creation is microseconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | **Migration Path**     | No data migration. Cherry-pick additive commits from feature branch → fix security issues → fix React hooks → add i18n. All optional fields — old SDKs ignore, old runtimes don't produce. Backend IR schema + value-resolution update is independent and can ship before or after SDK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 11  | **Rollback Plan**      | `git revert <commit-range>`. All changes are additive (new files, new optional fields, new exports). No database changes, no config changes, no env vars. Existing tests must still pass after revert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 12  | **Test Strategy**      | **Unit**: Registry, renderer, support-matrix, validation-parity, Studio catalog/page/insert/preview, `/rich-template` command flow, and HTML sanitization coverage. **Integration**: Compiler IR compilation, runtime value-resolution, runtime/channel normalization, SDK wire-format round-trip, and shared React/DOM rich-content parity. **E2E**: the browser lane now includes dedicated runtime → transport → SDK widget regressions for channel-native fallback rendering plus the current ActionSet button/select round-trips, while broader widget scenarios (KPI/media/forms/charts/quick replies) remain future expansion. **Coverage target**: all 16 FRs should eventually have automation; current shipped coverage closes FR-9/14/15/16 and leaves the broader browser matrix plus richer parser-authorable template coverage as the main explicit follow-ons. Tests use `vitest`, React Testing Library, and Playwright, with no mocking of codebase components in browser/E2E paths. |

---

## 5. Data Model

### New Collections/Tables

None. Template content is transient wire-format data — not persisted.

### Modified Collections/Tables

None. No database changes.

### Key Relationships

```
Message.richContent: RichContent  ←→  TemplateRenderer.extract(message)
    ├── .markdown?    → markdownRenderer
    ├── .carousel?    → carouselRenderer
    ├── .quick_replies? → quickRepliesRenderer
    ├── .list?        → listRenderer
    ├── .image?       → imageRenderer
    ├── .video?       → videoRenderer
    ├── .audio?       → audioRenderer
    ├── .file?        → fileRenderer
    ├── .kpi?         → kpiRenderer
    ├── .table?       → tableRenderer
    ├── .chart?       → chartRenderer
    ├── .form?        → formRenderer
    ├── .progress?    → progressRenderer
    ├── .feedback?    → feedbackRenderer
    └── .actions?     → actionsRenderer (existing ActionSet)

RichContentIR (compiler) ←mirrors→ RichContent (SDK)
    └── interpolateRichContent() resolves {{variables}} before wire
```

### Type Definitions

All types below are new and defined in `packages/web-sdk/src/core/types.ts`. The compiler IR mirrors these types in `packages/compiler/src/platform/ir/schema.ts` with identical shapes.

```typescript
// --- Tier 1 Types ---

interface QuickReply {
  id: string;
  label: string;
  icon_url?: string; // validated via isSafeUrl
}

interface ListTemplate {
  title?: string;
  items: ListItem[];
}

interface ListItem {
  title: string;
  subtitle?: string;
  image_url?: string; // validated via isSafeUrl
  default_action_url?: string; // validated via isSafeUrl
}

interface MediaContent {
  url: string; // validated via isSafeUrl
  alt?: string;
  thumbnail_url?: string; // validated via isSafeUrl
  caption?: string;
}

interface FileContent {
  url: string; // validated via isSafeUrl
  filename: string;
  size_bytes?: number;
  mime_type?: string;
}

// --- Tier 2 Types ---

interface KPITemplate {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  icon_url?: string; // validated via isSafeUrl
}

interface TableTemplate {
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  max_visible_rows?: number; // default 10, "Show more" for overflow
}

interface TableColumn {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
}

interface ChartTemplate {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  data: ChartDataPoint[];
}

interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

interface FormTemplate {
  title?: string;
  fields: ActionElement[]; // reuses existing ActionElement type
  submit_label?: string;
}

interface ProgressTemplate {
  label?: string;
  value: number; // 0-100
  max?: number; // default 100
  variant?: 'bar' | 'circle';
}

interface FeedbackTemplate {
  prompt: string;
  type: 'thumbs' | 'stars' | 'scale';
  max?: number; // for stars/scale, default 5
}
```

### Interpolation Strategy

The existing `interpolateRichContent()` handles 7 fields: 6 simple strings + carousel (with per-card interpolation). For the 12 new structured types, we follow the **same carousel pattern** — explicit per-type interpolation handlers that walk known string subfields:

| Type                      | String fields interpolated                          | Non-string fields (pass-through)                  |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `quick_replies`           | `[].label`                                          | `[].id`, `[].icon_url`                            |
| `list`                    | `title`, `items[].title`, `items[].subtitle`        | `items[].image_url`, `items[].default_action_url` |
| `image`, `video`, `audio` | `alt`, `caption`                                    | `url`, `thumbnail_url`                            |
| `file`                    | `filename`                                          | `url`, `size_bytes`, `mime_type`                  |
| `kpi`                     | `label`, `unit`                                     | `value`, `trend`, `icon_url`                      |
| `table`                   | `columns[].header`, `rows[].*` (string values only) | `columns[].key`, `columns[].align`                |
| `chart`                   | `title`, `data[].label`                             | `data[].value`, `data[].color`, `type`            |
| `form`                    | `title`, `submit_label`, `fields[].label`           | `fields[].type`, `fields[].id`                    |
| `progress`                | `label`                                             | `value`, `max`, `variant`                         |
| `feedback`                | `prompt`                                            | `type`, `max`                                     |

**Decision**: Explicit per-type handlers (not recursive walk). **Rationale**: URL fields must NOT be interpolated (prevents template injection into `href` attributes), numeric/enum fields must NOT be interpolated (prevents type coercion bugs). The carousel pattern already demonstrates this — per-field enumeration is the established pattern in this codebase.

**Note on AST→IR mapping**: `RichContentAST` (packages/core) uses camelCase field names (e.g., `quickReplies`, `imageUrl`) while `RichContentIR` (packages/compiler) uses snake_case (e.g., `quick_replies`, `image_url`). The compiler's AST-to-IR transform (`compileRichContent` or equivalent) must also be updated to map the 12 new AST fields to their IR equivalents. This is a separate code change from the SDK and runtime updates.

**Note on carousel inconsistency**: The existing `interpolateCarousel()` _does_ interpolate `image_url` and `default_action_url` — this is a pre-existing pattern predating the security hardening. New template types follow the stricter policy (no URL interpolation). The carousel is grandfathered in; a follow-up task should deprecate URL interpolation in carousel for consistency. This is logged as a known gap.

**Note on `kpi.value`**: When `value` is a `string`, it is rendered as `textContent` (not as an `href`), so interpolation is lower-risk than URL fields. However, to keep the interpolation strategy simple and consistent, `value` is pass-through for this phase. If agent developers need dynamic KPI values, they should use the `markdown` field instead or set the value at the agent runtime level before emitting.

---

## 6. API Design

### New Endpoints

None. Templates flow through existing WebSocket transport.

### Modified Endpoints

None. No HTTP API changes.

### Public Type Changes

```typescript
// packages/web-sdk/src/core/types.ts — 12 new optional fields
export interface RichContent {
  // Existing (unchanged)
  markdown?: string;
  adaptive_card?: string;
  html?: string;
  slack?: string;
  ag_ui?: string;
  whatsapp?: string;
  carousel?: Carousel;
  // NEW — Tier 1
  quick_replies?: QuickReply[];
  list?: ListTemplate;
  image?: MediaContent;
  video?: MediaContent;
  audio?: MediaContent;
  file?: FileContent;
  // NEW — Tier 2
  kpi?: KPITemplate;
  table?: TableTemplate;
  chart?: ChartTemplate;
  form?: FormTemplate;
  progress?: ProgressTemplate;
  feedback?: FeedbackTemplate;
}

// packages/web-sdk/src/templates/types.ts — NEW
export interface TemplateRenderer<T = unknown> {
  type: string;
  extract(message: Message): T | undefined;
  render(data: T, ctx: TemplateContext): React.ReactElement;
  renderDOM(data: T, ctx: TemplateContext): HTMLElement;
}

export interface TemplateContext {
  theme: Record<string, string>;
  onAction: (actionId: string, value?: string, label?: string) => void;
  messageId: string;
}
```

**`onAction` adaptation**: The existing `RenderOptions.onAction` signature is `(actionId: string, value?: string)`. `TemplateContext.onAction` adds an optional third parameter `label`. The adaptation strategy: `TemplateContext.onAction` wraps `RenderOptions.onAction`, forwarding `(actionId, value)` to the existing callback and additionally emitting a `template:action` custom event with `{ actionId, value, label }` for consumers that need the label. `RenderOptions` itself is NOT modified — this preserves backwards compatibility. The wrapper is constructed by the dispatcher (`RichContent.tsx` / `rich-renderer.ts`) when building `TemplateContext` from `RenderOptions`.

### Error Responses

N/A — no HTTP endpoints. Template rendering errors are handled client-side via graceful degradation (null return → text fallback).

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: N/A — no server-side operations
- **Rate Limiting**: N/A — client-side rendering
- **Caching**: N/A — no data fetching (except chart lazy import, which is browser-cached via standard module resolution)
- **Encryption**: N/A — template data flows over existing encrypted WebSocket transport (wss://)
- **XSS Prevention**: All URL-accepting renderers must call `isSafeUrl()`. This is the primary cross-cutting security concern and is enforced via code review + unit tests.
- **i18n**: Studio template catalog strings must use `useTranslations('studio')`. Web SDK renderer strings (e.g., "Loading chart...", "Show more") must be configurable via a new strings mechanism (to be designed in LLD).
- **Accessibility (a11y)**: Every renderer must satisfy baseline a11y requirements:
  - **Quick Replies**: Container uses `role="group"` with `aria-label="Quick replies"`. Each pill is a `<button>` with visible label text.
  - **Form**: All input fields have associated `<label>` elements via `for`/`id` linkage. Submit button is `type="submit"`.
  - **Media** (image/video/audio): `<img>` has `alt` text (from `MediaContent.alt` or fallback "Image"). `<video>` and `<audio>` use `aria-label`.
  - **Table**: Uses semantic `<table>`, `<thead>`, `<th scope="col">`, `<tbody>`. "Show more" is a `<button>`, not a link.
  - **Progress**: Uses `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`.
  - **Feedback**: Rating inputs use `role="radiogroup"` with individual `role="radio"` and `aria-label`.
  - **KPI/Chart**: Static display — `aria-label` with descriptive text (e.g., "Revenue: $1.2M, up").

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                  | Type                                                                          | Risk                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/web-sdk` existing rich-renderer.ts                | Code — `isSafeUrl`, `sanitizeHtml`, `renderMarkdown`                          | Low — stable, well-tested                                                                         |
| `packages/web-sdk` existing types (ActionElement, Carousel) | Type — form fields reuse ActionElement                                        | Low — stable interface                                                                            |
| `packages/core` AST types                                   | Type — `RichContentAST` must gain 12 new optional fields                      | Low — additive extension, mirrors SDK types                                                       |
| `packages/compiler` IR schema                               | Type — `RichContentIR` must mirror RichContent                                | Low — additive extension                                                                          |
| `apps/runtime` value-resolution                             | Code — `interpolateRichContent` must handle new fields with per-type handlers | Medium — cherry-pick includes this change, but verify completeness against interpolation strategy |
| `packages/i18n` locales                                     | Data — new translation keys for Studio catalog                                | Low — additive                                                                                    |

### Downstream (depends on this feature)

| Consumer                                  | Impact                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio` Template Catalog            | Imports web-sdk `RichContent` components for preview. Catalog page breaks if registry or renderers are removed.             |
| Future channel adapters (Slack, WhatsApp) | Will need to map `RichContent` fields to channel-specific formats. This feature defines the canonical type they'll consume. |
| Future customer-defined templates         | Will use `defaultRegistry.register()` to add custom renderers. API surface must remain stable.                              |

---

## 9. Open Questions & Decisions Needed

1. ~~Should the `onAction` callback signature be `(actionId, value?, label?)`?~~ **DECIDED**: Yes — `(actionId, value?, label?)`. Adding optional `label` is backwards-compatible; existing 2-arg callers unaffected.
2. ~~Should the Studio Template Catalog include a "Custom" category placeholder?~~ **DEFERRED**: Not in this phase. The catalog ships with built-in categories only. Custom templates are a future feature that depends on `defaultRegistry.register()` API stability.
3. ~~Should `TemplateContext.theme` be wired now?~~ **DECIDED**: No — `theme` is `{}` for this phase. Renderers must use CSS custom properties from host widget. Theme population deferred to theming feature.
4. ~~Should `interpolateRichContent` use generic iteration or explicit enumeration?~~ **DECIDED**: Explicit per-type handlers (matching the carousel pattern). URL and numeric fields must not be interpolated — per-field enumeration prevents template injection and type coercion bugs.
5. ~~Should runtime attach normalized fallback text for web-facing surfaces when only channel-native payloads are present?~~ **DECIDED**: Yes — runtime now synthesizes safe fallback summaries and forwards `usedFallback` through websocket and HTTP chat responses.
6. **OPEN**: Should channel-native payloads remain inside generic `RichContent` long-term, or move to a clearer v2 contract once older bundles age out?

---

## 10. References

- Feature spec: `docs/features/sub-features/sdk-rich-content-templates.md`
- Test spec: `docs/testing/sub-features/sdk-rich-content-templates.md`
- Feature-branch design specs (on `origin/KI0326/feature/SDK`):
  - `docs/superpowers/specs/2026-03-20-web-sdk-ui-templates-design.md`
  - `docs/superpowers/specs/2026-03-20-studio-template-catalog-design.md`
- Parent feature: `docs/features/sdk.md`
- Related: `docs/features/message-templates.md` (distinct — reusable text fragments)
