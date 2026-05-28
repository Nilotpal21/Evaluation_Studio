# Feature: SDK Rich Content Templates

**Doc Type**: SUB-FEATURE
**Parent Feature**: [SDK](../sdk.md)
**Status**: BETA
**Feature Area(s)**: `customer experience`, `integrations`, `agent lifecycle`
**Package(s)**: `packages/web-sdk`, `apps/studio`, `packages/compiler`, `packages/core`, `apps/runtime`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/sdk-rich-content-templates.md](../../testing/sub-features/sdk-rich-content-templates.md)
**HLD Spec**: [docs/specs/sdk-rich-content-templates.hld.md](../../specs/sdk-rich-content-templates.hld.md)
**LLD Spec**: [docs/plans/2026-03-24-sdk-rich-content-templates-impl-plan.md](../../plans/2026-03-24-sdk-rich-content-templates-impl-plan.md)
**Last Updated**: 2026-04-16

---

## 1. Introduction / Overview

### Problem Statement

The Web SDK currently renders three template types: markdown, buttons (ActionSet), and carousel. Industry-standard chat SDKs (Intercom, Zendesk, Kore.ai, Microsoft Bot Framework) ship 12-15 template types. Agent developers must encode structured data (KPIs, tables, forms, media) as markdown text, losing interactivity and visual fidelity.

Architecturally, existing renderers are implemented inline in `rich-renderer.ts` (Vanilla DOM) with no shared abstraction. Adding each new template requires modifying the monolithic renderer file and duplicating patterns (theming, action dispatch, error states).

### Goal Statement

Provide a pluggable template registry architecture in the Web SDK that supports 12 new rich content template types with dual React and Vanilla DOM renderers, zero external dependencies, and a Studio Template Catalog for discovery and insertion — closing the feature-parity gap for GA readiness.

### Summary

This feature adds a `TemplateRegistry` abstraction to `packages/web-sdk` with self-registering `TemplateRenderer<T>` implementations. It introduces 12 new template types across two tiers:

- **Tier 1** (6 basic): Quick Replies, List, Image, Video, Audio, File
- **Tier 2** (6 data-rich): KPI Card, Table, Chart, Form, Progress Tracker, Feedback

The existing 3 renderers (markdown, carousel, actions) are migrated into the registry as Phase 0. A Studio Template Catalog page provides browsing, live preview, JSON editing, and DSL snippet insertion. Backend support includes runtime pass-through for new `richContent` fields in the value resolution pipeline and extension of the compiler IR schema.

The 2026-04-16 parity-remediation follow-on closes several post-rollout gaps: channel-native payloads (`adaptive_card`, `slack`, `whatsapp`, `ag_ui`) now render safe fallback content instead of disappearing in web chat, runtime normalizes channel-native-only responses for web-facing surfaces, assistant actions flow through a single React rendering path, React form/action validation matches the DOM renderer, Studio catalog/preview surfaces the same support modes the web SDK now advertises, the `/rich-template` command path is covered end to end, Studio now discloses current DSL authoring support (`supported`, `partial`, `preview_only`) separately from preview support, the SDK widget has isolated browser regressions for fallback plus ActionSet button/select round-trips, and the legacy DOM renderer now preserves assistant prompt text when structured actions render alongside it.

---

## 2. Scope

### Goals

- Introduce a `TemplateRegistry` with `TemplateRenderer<T>` interface supporting both React and Vanilla DOM render paths
- Migrate existing markdown, carousel, and actions renderers into the registry (Phase 0)
- Add 6 Tier 1 templates (quick replies, list, image, video, audio, file)
- Add 6 Tier 2 templates (KPI, table, chart, form, progress, feedback)
- Provide a Studio Template Catalog page with live preview and DSL insertion
- Extend the `RichContent` interface with 12 new optional fields (backwards-compatible)
- Extend `RichContentIR` in the compiler IR schema to mirror the 12 new SDK types
- Add runtime pass-through for new `richContent` fields in value resolution (`interpolateRichContent`)
- Fix XSS vulnerabilities: validate all user-controlled URLs via `isSafeUrl()`
- Fix React hooks violations in feature-branch `RichContent.tsx` and carousel renderer
- Add i18n support for all user-visible strings in template components
- Close parity gaps between the shared `RichContent` contract and what web chat / Studio preview actually render
- Unify assistant action rendering so React `actions` and `richContent + actions` messages use the same registry-based path
- Keep React required-field validation behavior aligned with the shared DOM template renderers

### Non-Goals (Out of Scope)

- Channel adapters (Slack Block Kit, WhatsApp interactive, Adaptive Cards) — deferred to separate spec; this follow-on only adds safe fallback rendering and preview for their shared payload fields
- Receipt/Invoice Card template — deprioritized from initial release
- Customer-defined template registration API — registry supports `register()` but public docs are deferred
- Template analytics (render/interaction tracking)
- `display_audio` meta-tool — audio content is rendered client-side only, not agent-driven
- `display_*` meta-tool interception in runtime — the mechanism for agents to produce templates via tool calls does not exist today and requires runtime execution pipeline changes; deferred to a follow-up
- DSL syntax blocks (`QUICK_REPLIES:`, `KPI:`, `TABLE:`, etc.) — parser and compiler recognition of template blocks requires parser/compiler changes beyond the cherry-pick scope; deferred to a follow-up
- Message Templates feature (reusable named text fragments with CRUD) — separate feature at `docs/features/message-templates.md`

---

## 3. User Stories

1. As an **end user** chatting with an agent, I want to see structured data (KPI cards, tables, charts) rendered inline in the chat so that I can understand information without leaving the conversation.
2. As an **end user**, I want to click quick-reply buttons so that I can respond to the agent without typing.
3. As an **end user**, I want to view and download media (images, videos, audio, files) inline so that I can access content the agent shares.
4. As an **agent developer**, I want to browse a template catalog in Studio so that I can discover available rich content types and their JSON/DSL structure.
5. As an **agent developer**, I want to type `/rich-template` in the DSL editor and insert a template skeleton so that I can quickly author rich responses without memorizing the schema.
6. As an **SDK maintainer**, I want a pluggable template registry so that adding new template types does not require modifying the core renderer.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a `TemplateRegistry` class that stores `TemplateRenderer<T>` instances with a maximum capacity of 50 renderers and throws an error if exceeded.
2. **FR-2**: Each `TemplateRenderer<T>` must implement `type: string`, `extract(message): T | undefined`, `render(data, ctx): ReactElement`, and `renderDOM(data, ctx): HTMLElement` methods.
3. **FR-3**: The registry `match(message)` method must return all renderers whose `extract()` returns non-undefined data, in registration order.
4. **FR-4**: The `RichContent` interface must be extended with 12 new optional fields: `quick_replies`, `list`, `image`, `video`, `audio`, `file`, `kpi`, `table`, `chart`, `form`, `progress`, `feedback`.
5. **FR-5**: All template renderers that accept user-controlled URLs (`url`, `image_url`, `thumbnail_url`, `icon_url`, `default_action_url`) must validate them via `isSafeUrl()` before rendering, rejecting `javascript:` and other unsafe protocols.
6. **FR-6**: The chart renderer must lazy-load its SVG rendering module via dynamic `import()` and display a loading indicator while the module loads, with error handling if the import fails.
7. **FR-7**: The form renderer must collect field values from `ActionElement` inputs and dispatch a single action event with all field values on form submission.
8. **FR-8**: The Studio Template Catalog page must display all templates organized by category (Content, Media, Data, Input, Feedback) with search/filter, live SDK preview, editable JSON editor, and copyable DSL snippets.
9. **FR-9**: The `/rich-template` slash command in the DSL editor must open a slide-over panel for template browsing and insertion, and the insertion surface must disclose whether a template is currently insertable, partially insertable, or preview-only based on the current ABL parser/compiler authoring surface, while the existing `/template` command remains reserved for Message Templates.
10. **FR-10**: The `RichContentIR` schema in `packages/compiler/src/platform/ir/schema.ts` must be extended with 12 new fields mirroring the SDK `RichContent` type.
11. **FR-11**: The `interpolateRichContent` function in `apps/runtime/src/services/execution/value-resolution.ts` must be updated to pass through all 12 new `richContent` fields to the wire format.
12. **FR-12**: All user-visible strings in template components (both web-sdk and Studio) must be internationalized via the i18n system.
13. **FR-13**: React template renderers must not violate React Rules of Hooks — no conditional hook calls, no hooks in non-component functions.
14. **FR-14**: Shared `RichContent` payloads that are preserved on the wire but not natively rendered in web chat (`adaptive_card`, `slack`, `whatsapp`, `ag_ui`) must render a safe fallback block instead of disappearing silently.
15. **FR-15**: React `actions` and `form` submit paths must enforce the same required-field validation rules as their DOM renderer equivalents before dispatching action events.
16. **FR-16**: Studio catalog and preview surfaces must disclose whether each template renders natively, as a fallback, or with a limited preview in web surfaces.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                             |
| -------------------------- | ------------ | ------------------------------------------------- |
| Project lifecycle          | NONE         | Templates are stateless, no project-scoped data   |
| Agent lifecycle            | SECONDARY    | Meta-tools enable agent-driven template rendering |
| Customer experience        | PRIMARY      | Rich visual content in chat widget                |
| Integrations / channels    | SECONDARY    | Wire format extension; channel adapters deferred  |
| Observability / tracing    | NONE         | No new trace events                               |
| Governance / controls      | NONE         | No new guardrails                                 |
| Enterprise / compliance    | NONE         | No PII, no persistence                            |
| Admin / operator workflows | SECONDARY    | Studio catalog for developers                     |

### Related Feature Integration Matrix

| Related Feature                                            | Relationship Type | Why It Matters                                                      | Key Touchpoints                                               | Current State   |
| ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| [SDK](../sdk.md)                                           | extends           | Templates extend the SDK's RichContent wire format                  | `packages/web-sdk/src/core/types.ts`, WebSocket message flow  | BETA            |
| [Message Templates](../message-templates.md)               | shares data with  | A message template's content could include `richContent` fields     | Runtime value resolution, compiler IR                         | ALPHA           |
| [Channels](../channels.md)                                 | emits into        | Template data flows through channel responses; adapters map formats | Channel-specific `richContent` fields (slack, whatsapp, etc.) | STABLE (subset) |
| [Agent Development Studio](../agent-development-studio.md) | configured by     | Studio Template Catalog is a Studio UI surface                      | Navigation, AppShell routing, DSL editor integration          | BETA            |

---

## 6. Design Considerations

- **Dual render paths**: Every template has both a React (`render`) and Vanilla DOM (`renderDOM`) implementation. The React path is used by the `<RichContent>` component; the DOM path is used by the `rich-renderer.ts` vanilla dispatcher.
- **Self-registration pattern**: Renderers self-register via side-effect imports in the barrel file `templates/index.ts`. Import order determines render priority.
- **Chart lazy-loading**: The chart renderer is the only template that uses dynamic `import()` to code-split the SVG generation module (~3-4KB gzipped). A loading placeholder is shown during load.
- **Studio catalog**: Uses direct import of web-sdk `RichContent` components (no iframe) within a `TemplateMockProvider` that supplies mock `TemplateContext`.
- **Accessibility**: Quick replies need `role="group"` with `aria-label`; form fields need proper `<label>` associations; media needs `alt` text.

---

## 7. Technical Considerations

- **Bundle impact**: ~13-20KB total across all phases, zero external dependencies.
- **Backwards compatibility**: All new `RichContent` fields are optional. Old SDKs ignore unknown fields. Old runtimes never send new fields. No breaking changes.
- **`isSafeUrl` must be exported**: Currently private in `rich-renderer.ts`. Must be moved to a shared utility or exported for use by all template renderers.
- **React hooks safety**: The feature-branch `RichContent.tsx` (new file at `packages/web-sdk/src/react/components/RichContent.tsx`, distinct from the existing `RichMessage.tsx` on develop) wraps `useChat()` in a try/catch — this is a hooks violation. It must use `React.useContext()` directly. The carousel renderer's `render()` method calls `React.useRef` — hooks cannot be used in plain object methods; the renderer must use a proper React component.

---

## 8. How to Consume

### Studio UI

- **Template Catalog page**: `/projects/:projectId/templates` — browse, preview, and edit templates; cards and detail panes now disclose whether a template is rendered natively, as a fallback, or with a limited preview
- **Template Insert Panel**: Triggered by `/rich-template` slash command in the DSL editor — slide-over with template browsing, DSL authoring badges, and "Insert DSL" action for currently authorable templates. Preview-only templates remain browsable but disabled for insertion. The existing `/template` command continues to open Message Templates.
- **Navigation**: "Templates" item in the project sidebar under the existing navigation

### API (Runtime)

No new HTTP endpoints. Templates flow through the existing WebSocket message transport:

| Transport | Path      | Purpose                                       |
| --------- | --------- | --------------------------------------------- |
| WebSocket | `/ws/sdk` | `response_end` messages carry `richContent.*` |

Template data flows through the existing message pipeline. When the compiler IR or runtime produces a message with `richContent.*` fields, they are passed through `interpolateRichContent` and sent to the SDK via WebSocket. Meta-tool interception (`display_*`) is deferred to a follow-up.

### API (Studio)

No new API routes. The template catalog is a client-side page using static data from `template-catalog.ts`.

### Admin Portal

N/A — templates are not admin-managed.

### Channel / SDK / Voice / A2A / MCP Integration

- **Web SDK**: Native rendering for the registry-backed template set plus safe fallback rendering for shared channel-native payloads (`adaptive_card`, `slack`, `whatsapp`, `ag_ui`)
- **Voice**: N/A — templates are visual
- **Channels**: Template data is present on the wire; channel-specific adapters remain deferred even though the shared payloads now have safe fallback behavior in web chat
- **A2A / MCP**: Agents can produce template content via meta-tools; external consumers see raw `richContent` JSON

---

## 9. Data Model

### Collections / Tables

No new database collections. Template catalog data is static (in-memory `template-catalog.ts`). Template content flows through the existing WebSocket message wire format as fields on `Message.richContent`.

### Key Relationships

- `RichContent` is a property of `Message` (wire format)
- `RichContent` fields map 1:1 to `TemplateRenderer` types in the registry
- DSL syntax blocks compile to `rich_content.*` fields in the compiler IR
- IR fields pass through runtime value resolution to the wire format

---

## 10. Key Implementation Files

All files marked **NEW** are created by cherry-picking from the feature branch. Files marked **MODIFY** exist on develop and require changes.

### Domain / Core Logic

| File                                                   | Status  | Purpose                                                   |
| ------------------------------------------------------ | ------- | --------------------------------------------------------- |
| `packages/web-sdk/src/templates/registry.ts`           | **NEW** | `TemplateRegistry` class with `match/register`            |
| `packages/web-sdk/src/templates/types.ts`              | **NEW** | `TemplateRenderer<T>` interface, `TemplateContext`        |
| `packages/web-sdk/src/templates/index.ts`              | **NEW** | Barrel file, import-order-based registration              |
| `packages/web-sdk/src/templates/utils/safe-url.ts`     | **NEW** | Extracted `isSafeUrl()` — shared URL validation           |
| `packages/web-sdk/src/templates/utils/strings.ts`      | **NEW** | SDK i18n — `getString()`, `setStrings()`, default strings |
| `packages/web-sdk/src/templates/utils/chart-colors.ts` | **NEW** | Shared `DEFAULT_COLORS` for chart renderers               |
| `packages/web-sdk/src/core/types.ts`                   | MODIFY  | Extended `RichContent` interface + 12 new type interfaces |
| `packages/web-sdk/src/ui/rich-renderer.ts`             | MODIFY  | Vanilla DOM dispatcher (rewritten to use registry)        |

### Routes / Handlers

| File                                                      | Status | Purpose                                           |
| --------------------------------------------------------- | ------ | ------------------------------------------------- |
| `apps/runtime/src/services/execution/value-resolution.ts` | MODIFY | Update `interpolateRichContent` for 12 new fields |
| `packages/compiler/src/platform/ir/schema.ts`             | MODIFY | Extend `RichContentIR` with 12 new fields         |

### UI Components

| File                                                            | Status  | Purpose                                                                                                |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `packages/web-sdk/src/templates/renderers/*.ts`                 | **NEW** | 17 renderer files: 15 registered renderers + 2 chart helpers (`chart-inner.tsx`, `chart-inner-dom.ts`) |
| `packages/web-sdk/src/react/RichContent.tsx`                    | **NEW** | React RichContent dispatcher (new file, distinct from existing `RichMessage.tsx`)                      |
| `apps/studio/src/components/templates/TemplateCatalogPage.tsx`  | **NEW** | Gallery page                                                                                           |
| `apps/studio/src/components/templates/TemplateInsertPanel.tsx`  | **NEW** | Slide-over panel                                                                                       |
| `apps/studio/src/components/templates/TemplateJsonEditor.tsx`   | **NEW** | JSON editor                                                                                            |
| `apps/studio/src/components/templates/TemplateDSLView.tsx`      | **NEW** | DSL snippet viewer                                                                                     |
| `apps/studio/src/components/templates/TemplatePreview.tsx`      | **NEW** | Live preview                                                                                           |
| `apps/studio/src/components/templates/TemplateMockProvider.tsx` | **NEW** | Mock context for preview                                                                               |
| `apps/studio/src/lib/template-catalog.ts`                       | **NEW** | Static catalog data (follows Studio `lib/` convention)                                                 |

### Post-Rollout Parity Remediation (2026-04-16)

| File                                                            | Status  | Purpose                                                                                                         |
| --------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/web-sdk/src/templates/support.ts`                     | **NEW** | Shared support matrix for native vs fallback rich-content handling across the SDK and Studio                    |
| `packages/web-sdk/src/templates/utils/structured-preview.ts`    | **NEW** | Extract readable summaries from structured channel-native payloads for safe fallback rendering                  |
| `packages/web-sdk/src/templates/renderers/channel-fallback.ts`  | **NEW** | Fallback renderer for shared channel-native payloads that do not have native web renderers                      |
| `packages/web-sdk/src/react/components/MessageList.tsx`         | MODIFY  | Unify assistant `richContent` and `actions` rendering through the registry-backed `RichContent` path            |
| `packages/web-sdk/src/templates/renderers/actions.ts`           | MODIFY  | Align React deferred-submit validation with the DOM action renderer                                             |
| `packages/web-sdk/src/templates/renderers/form.ts`              | MODIFY  | Align React form validation with the DOM form renderer                                                          |
| `packages/web-sdk/src/ui/rich-renderer.ts`                      | MODIFY  | Use the shared support matrix so legacy DOM rendering counts fallback-capable payloads as renderable content    |
| `apps/runtime/src/services/channel/outcome.ts`                  | MODIFY  | Normalize channel-native-only responses for web-facing surfaces and synthesize safe fallback summaries          |
| `apps/runtime/src/services/channel/constants.ts`                | MODIFY  | Define the shared synthesized fallback summary/diagnostic contract for normalized channel-native responses      |
| `apps/studio/src/lib/template-catalog.ts`                       | MODIFY  | Catalog entries now derive web/preview support modes from the shared support matrix                             |
| `apps/studio/src/components/templates/TemplateInsertPanel.tsx`  | MODIFY  | Surface current DSL authoring support (`supported`, `partial`, `preview_only`) and disable preview-only inserts |
| `apps/studio/src/components/templates/TemplatePreview.tsx`      | MODIFY  | Split top-level `actions` from `richContent` so Studio preview matches the message wire shape                   |
| `apps/studio/src/components/templates/TemplateMockProvider.tsx` | MODIFY  | Add HTML preview, channel-native fallback previews, and raw ActionSet preview blocks                            |
| `apps/studio/src/components/templates/TemplateCatalogPage.tsx`  | MODIFY  | Surface web/preview support badges so authors can see whether a template is native, fallback, or limited        |

### Jobs / Workers / Background Processes

N/A — no background processing.

### Tests

| File                                                                  | Type        | Coverage Focus                                              | Status                     |
| --------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- | -------------------------- |
| `packages/web-sdk/src/__tests__/template-registry.test.ts`            | unit        | Registry register/match/overflow (6 tests)                  | ✅                         |
| `packages/web-sdk/src/__tests__/template-renderers.test.ts`           | unit        | All 15 renderers, DOM + React paths (21 tests)              | ✅                         |
| `packages/web-sdk/src/__tests__/template-safe-url.test.ts`            | unit        | isSafeUrl validation across all URL fields (22 tests)       | ✅                         |
| `packages/compiler/src/__tests__/ir/rich-content-compilation.test.ts` | integration | Compiler IR schema, 12 template type compilation (31 tests) | ✅                         |
| `apps/runtime/src/__tests__/rich-content-execution.test.ts`           | integration | Runtime value resolution, all 12 template types (36 tests)  | ✅                         |
| `apps/runtime/src/services/channel/__tests__/outcome.test.ts`         | integration | Web-surface fallback synthesis and renderability detection  | ✅                         |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`          | integration | SDK websocket fallback summary propagation                  | ✅                         |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`             | integration | HTTP chat fallback summary propagation                      | ✅                         |
| `packages/web-sdk/src/__tests__/rich-content-sdk.test.ts`             | integration | SDK RichContent wire format round-trip (17 tests)           | ✅ (pre-existing, updated) |
| `packages/core/src/__tests__/rich-content-parser.test.ts`             | unit        | Core RichContent AST type parsing (17 tests)                | ✅ (pre-existing, updated) |
| `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`            | unit        | Legacy DOM widget rendering for structured-action messages  | ✅                         |
| `apps/studio/src/__tests__/template-catalog.test.ts`                  | unit        | Catalog data shape validation + DSL authoring modes         | ✅                         |
| `apps/studio/src/__tests__/template-catalog-page.test.tsx`            | unit        | Gallery page rendering + support disclosure                 | ✅                         |
| `apps/studio/src/__tests__/template-insert-panel.test.tsx`            | unit        | Slide-over panel + preview-only insertion guards            | ✅                         |
| `apps/studio/src/__tests__/abl-editor-rich-template-command.test.tsx` | unit        | `/rich-template` command dispatch + intelligent insertion   | ✅                         |
| `apps/studio/src/__tests__/template-preview.test.tsx`                 | unit        | Preview rendering for HTML, fallback, and raw ActionSet     | ✅                         |
| `apps/studio/e2e/sdk-widget.spec.ts`                                  | E2E         | Runtime → transport → SDK widget fallback + ActionSet paths | ✅                         |

---

## 11. Configuration

### Environment Variables

No new environment variables. Template rendering is entirely client-side.

### Runtime Configuration

No runtime configuration. Templates are always available when the web-sdk is loaded.

### DSL / Agent IR / Schema

DSL syntax blocks (`QUICK_REPLIES:`, `KPI:`, `TABLE:`, etc.) are deferred to a follow-up. The current scope extends `RichContentIR` in the compiler IR schema so template data flows correctly when produced by other means (runtime, meta-tools in future). The IR fields pass through to the wire format unchanged via `interpolateRichContent`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                              |
| ----------------- | ---------------------------------------------------------------------- |
| Project isolation | N/A — templates are stateless, no project-scoped data stored           |
| Tenant isolation  | N/A — template rendering is client-side only, no tenant-scoped queries |
| User isolation    | N/A — no user-owned template resources                                 |

Note: The Studio Template Catalog page is scoped to a project route (`/projects/:projectId/templates`) but only displays static catalog data — no per-project or per-tenant template storage.

### Security & Compliance

- **XSS prevention**: All renderers that accept URLs must validate via `isSafeUrl()` to block `javascript:`, `data:` (except allowlisted image data URIs), and other unsafe protocols. This is a hard requirement (FR-5).
- **HTML sanitization**: The markdown renderer uses the existing `sanitizeHtml()` allowlist-based sanitizer. No new `innerHTML` usage with user data.
- **No PII**: Template content is transient (wire format only), not persisted. No PII concerns.
- **No auth changes**: This feature does not modify any auth middleware, session tokens, or access control.

### Performance & Scalability

- **Bundle size**: ~13-20KB total, zero external dependencies
- **Chart lazy-loading**: Chart SVG module (~3-4KB) loaded on demand via `import()`
- **Registry lookup**: O(n) scan over registered renderers per message; n <= 50 (hard cap)
- **No server-side rendering**: All template rendering is client-side

### Reliability & Failure Modes

- **Unknown template type**: Registry `match()` returns empty array; the message renders with only its text/markdown content. No error thrown.
- **Malformed template data**: Individual renderers should handle missing/malformed fields gracefully (render partial content or skip).
- **Chart import failure**: Must show error state instead of infinite loading placeholder.
- **React crash isolation**: Template rendering errors should be caught by error boundaries to prevent crashing the entire chat widget.

### Observability

No new trace events or metrics. Template rendering is client-side and observed via browser dev tools. The template types rendered could be tracked via future template analytics (out of scope).

### Data Lifecycle

N/A — templates are transient wire-format data. No persistence, no TTLs, no retention.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase A — Base rollout (complete)**
   1.1 Registry architecture, 12 template types, Studio catalog, compiler IR support, and runtime interpolation pass-through shipped in the March rollout.
   1.2 Security, i18n, hooks, and chart-loading fixes from the original implementation plan remain the foundation for the feature.

2. **Phase B — Parity remediation (complete)**
   2.1 Add a shared support matrix so web chat and Studio can classify each rich-content type as native, fallback, or limited-preview.
   2.2 Add a `channel_fallback` renderer plus structured preview extraction so `adaptive_card`, `slack`, `whatsapp`, and `ag_ui` payloads no longer disappear silently in web chat.
   2.3 Unify assistant message rendering onto the registry-backed `RichContent` path so `actions`-only and `richContent + actions` messages share the same behavior.
   2.4 Align React `actions` and `form` required-field validation with the DOM renderers before submit dispatch.
   2.5 Update Studio catalog and preview to include HTML, raw `actions`, channel-native fallback previews, and visible support badges.
   2.6 Add targeted regression tests for fallback rendering, `hasRichContent()` parity, validation parity, and duplicate-action prevention.

3. **Phase C — Runtime and contract normalization (complete)**
   3.1 Runtime/channel outcome normalization now synthesizes fallback text for web-facing surfaces when only channel-native payloads are present, and forwards `usedFallback` through websocket and HTTP chat surfaces.
   3.2 Channel-native payloads remain inside generic `RichContent` for v1 compatibility; a cleaner v2 contract split is still an open design follow-up.

4. **Phase D — Coverage expansion (complete for the current authoring/browser lane)**
   4.1 Studio component tests now cover catalog badges, preview fallback behavior, HTML sanitization, raw `actions` preview rendering, and DSL authoring-mode disclosure in the catalog and insert panel.
   4.2 The `/rich-template` command path now has a dedicated regression that drives the ABL editor command palette through the insert panel and intelligent snippet insertion flow.
   4.3 Isolated-browser widget regressions now prove channel-native-only content survives runtime → transport → SDK → widget rendering without silent drops, and that the currently authorable ActionSet button/select flows round-trip through the widget.

5. **Remaining follow-up**
   5.1 Broader widget/browser coverage for KPI, media, forms, charts, and quick replies remains future expansion beyond the current fallback + ActionSet lane.
   5.2 Richer parser/compiler authoring support is still a follow-up: the current ABL surface for slash-insertable rich content is limited to `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset, so several catalog entries remain preview-only or partial for DSL insertion.
   5.3 Decide whether channel-native payloads should move out of generic `RichContent` in a future v2 contract once older bundles age out.

---

## 14. Success Metrics

| Metric                                                    | Baseline | Target | Actual | How Measured                                                           |
| --------------------------------------------------------- | -------- | ------ | ------ | ---------------------------------------------------------------------- |
| Template types supported                                  | 3        | 15     | 15     | Count of registered native renderers in the registry                   |
| Shared channel-native payloads that disappear in web chat | 4        | 0      | 0      | Fallback renderer + `hasRichContent()` regressions                     |
| React submit-path validation drifts (`actions`, `form`)   | 2        | 0      | 0      | React regression tests vs existing DOM behavior                        |
| Assistant action render paths that can diverge            | 2        | 1      | 1      | `MessageList` now routes assistant actions through `RichContent`       |
| Post-rollout parity regressions added                     | 0        | >= 6   | 30     | New tests across web-sdk, runtime, Studio, and the widget browser lane |
| External dependencies added                               | 0        | 0      | 0      | package.json diff                                                      |

---

## 15. Open Questions

1. **Decided**: Shared channel-native payloads render safe fallback blocks in web chat and Studio preview rather than disappearing silently.
2. **Decided**: Assistant messages should render `actions` through the registry-backed `RichContent` path; the legacy `ActionHandler` remains for backwards-compatible direct usage only.
3. **Decided**: Runtime should attach normalized fallback text for web-facing channels when a response contains only channel-native payloads, and forward `usedFallback` through websocket and HTTP chat surfaces.
4. **Open**: Should channel-native payloads remain inside generic `RichContent` long-term, or move to a cleaner v2 contract once older bundles age out?
5. **Deferred**: A "Custom" template category placeholder remains out of scope until customer-defined renderable registration is productized.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                    | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | Native Slack / WhatsApp / Adaptive Card channel adapters for the new template system are still deferred                        | Medium   | Open      |
| GAP-002 | Runtime still relies on client fallback when web-facing channels receive channel-native-only payloads                          | High     | Mitigated |
| GAP-003 | Shared channel-native payloads could survive transport and still render blank in web chat                                      | High     | Mitigated |
| GAP-004 | Assistant messages with both `richContent` and `actions` could render duplicate action blocks                                  | High     | Mitigated |
| GAP-005 | React deferred-submit validation drifted from the DOM renderers for `actions` and `form`                                       | Medium   | Mitigated |
| GAP-006 | Browser/widget coverage is still limited beyond the current fallback + ActionSet button/select regression lane                 | Medium   | Open      |
| GAP-007 | Studio preview still uses a simplified mock-provider approximation instead of the live runtime renderer for every payload type | Low      | Open      |
| GAP-008 | `display_audio` meta-tool and richer agent-authored DSL/template tooling remain separate follow-ons                            | Low      | Open      |

**Mitigated Items:**

- **GAP-003**: `packages/web-sdk/src/templates/renderers/channel-fallback.ts` plus `templates/support.ts` and `structured-preview.ts` now render safe fallback summaries for shared channel-native payloads in both DOM and React paths.
- **GAP-004**: `MessageList.tsx` no longer appends a second `ActionHandler` for assistant messages; assistant `actions` now render once through the registry-backed `RichContent` path.
- **GAP-005**: React submit handling in `renderers/actions.ts` and `renderers/form.ts` now validates required fields before dispatch, matching the DOM renderers' behavior.
- **GAP-002**: `apps/runtime/src/services/channel/outcome.ts` now synthesizes normalized fallback text for web-facing surfaces when only channel-native payloads are present, and `ws-sdk-handler.test.ts` plus `chat-routes.test.ts` keep websocket and HTTP propagation aligned.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                      | Coverage Type | Status  | Test File(s)                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registry register, match, overflow                                            | unit          | ✅ PASS | `web-sdk/src/__tests__/template-registry.test.ts`                                                                                                                            |
| 2   | Native renderer coverage, including markdown tables                           | unit          | ✅ PASS | `web-sdk/src/__tests__/template-renderers.test.ts`                                                                                                                           |
| 3   | Shared channel-native payloads surface fallback content                       | unit          | ✅ PASS | `web-sdk/src/__tests__/template-renderers.test.ts`, `react-components.test.tsx`                                                                                              |
| 4   | Legacy DOM `hasRichContent()` treats fallback-capable payloads as renderable  | unit          | ✅ PASS | `web-sdk/src/__tests__/rich-renderer.test.ts`                                                                                                                                |
| 5   | Assistant `richContent + actions` messages render one action block            | unit          | ✅ PASS | `web-sdk/src/__tests__/react-components.test.tsx`                                                                                                                            |
| 6   | React deferred ActionSet validation matches DOM behavior                      | unit          | ✅ PASS | `web-sdk/src/__tests__/react-components.test.tsx`                                                                                                                            |
| 7   | React form validation matches DOM behavior                                    | unit          | ✅ PASS | `web-sdk/src/__tests__/react-components.test.tsx`                                                                                                                            |
| 8   | Compiler IR schema for 12 template types                                      | integration   | ✅ PASS | `compiler/src/__tests__/ir/rich-content-compilation.test.ts`                                                                                                                 |
| 9   | Runtime value resolution for 12 template types                                | integration   | ✅ PASS | `runtime/src/__tests__/rich-content-execution.test.ts`                                                                                                                       |
| 10  | Core AST type parsing                                                         | unit          | ✅ PASS | `core/src/__tests__/rich-content-parser.test.ts`                                                                                                                             |
| 11  | SDK RichContent wire format                                                   | integration   | ✅ PASS | `web-sdk/src/__tests__/rich-content-sdk.test.ts`                                                                                                                             |
| 12  | Studio catalog badges / categories / DSL authoring disclosure                 | unit          | ✅ PASS | `apps/studio/src/__tests__/template-catalog.test.ts`, `apps/studio/src/__tests__/template-catalog-page.test.tsx`, `apps/studio/src/__tests__/template-insert-panel.test.tsx` |
| 13  | `/rich-template` command opens the insert panel and routes intelligent insert | unit          | ✅ PASS | `apps/studio/src/__tests__/abl-editor-rich-template-command.test.tsx`                                                                                                        |
| 14  | Studio preview rendering for fallback payloads and raw actions                | unit          | ✅ PASS | `apps/studio/src/__tests__/template-preview.test.tsx`                                                                                                                        |
| 15  | Legacy DOM rendering preserves assistant prompt text with structured actions  | unit          | ✅ PASS | `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`                                                                                                                   |
| 16  | Full E2E through runtime → transport → SDK widget fallback + action paths     | E2E           | ✅ PASS | `apps/studio/e2e/sdk-widget.spec.ts`                                                                                                                                         |

**Coverage summary:** the original rollout still has 115 dedicated tests across web-sdk, compiler, and runtime. The 2026-04-16 parity-remediation follow-on now adds 30 targeted tests/regressions across web-sdk, runtime, Studio component/command coverage, and the SDK widget browser lane.

### Testing Notes

The March rollout's original LLD coverage still stands for registry, renderer, compiler, and runtime pass-through behavior. The current parity-remediation slice additionally verifies:

- shared channel-native payloads no longer disappear in React or DOM render paths
- runtime/channel outcomes synthesize fallback text for web-facing surfaces when only channel-native payloads are present
- assistant `actions` rendering no longer duplicates when `richContent` and `actions` coexist on the same message
- React deferred-submit handling for `actions` and `form` matches the existing DOM validation contract
- Studio catalog, insert panel, and preview stay aligned with the shared support matrix and current DSL authoring modes, including HTML sanitization and raw `actions` preview handling
- the `/rich-template` command path now opens the insert panel and routes supported snippets through intelligent insertion
- the legacy DOM widget path preserves assistant prompt text for non-text structured payloads such as ActionSet messages
- the isolated widget browser lane now covers channel-native fallback rendering plus ActionSet button/select round-trips
- `pnpm build --filter=@agent-platform/runtime`, `pnpm build --filter=@agent-platform/web-sdk`, `pnpm build --filter=@agent-platform/studio`, targeted Vitest runs in runtime/web-sdk/Studio, and the isolated widget Playwright regression all pass for this slice

> Full testing details: [../../testing/sub-features/sdk-rich-content-templates.md](../../testing/sub-features/sdk-rich-content-templates.md)

---

## 18. References

- Design specs (feature branch): `docs/superpowers/specs/2026-03-20-web-sdk-ui-templates-design.md`, `docs/superpowers/specs/2026-03-20-studio-template-catalog-design.md`
- Implementation plans (feature branch): `docs/superpowers/plans/2026-03-20-web-sdk-ui-templates.md`, `docs/superpowers/plans/2026-03-20-studio-template-catalog.md`
- Parent feature: [docs/features/sdk.md](../sdk.md)
- Related: [docs/features/message-templates.md](../message-templates.md) (distinct feature — reusable text fragments)
- PR review findings: XSS, React hooks, i18n gaps identified in review of `KI0326/feature/SDK`
