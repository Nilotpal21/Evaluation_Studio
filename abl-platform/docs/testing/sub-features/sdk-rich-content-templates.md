# Testing Guide: SDK Rich Content Templates

**Feature**: [SDK Rich Content Templates](../../features/sub-features/sdk-rich-content-templates.md)
**Parent Feature**: [SDK](../../features/sdk.md)
**Status**: PARTIAL (BETA)
**Last Updated**: 2026-04-16

---

## Current State

The March rollout remains covered by 115 dedicated tests across 3 packages (`web-sdk`, `compiler`, `runtime`). The 2026-04-16 parity-remediation follow-on now adds 30 targeted feature tests/regressions across the SDK, runtime, Studio, and the isolated widget lane:

- 7 web-sdk parity regressions for channel-native fallback rendering, legacy DOM renderability detection, assistant action deduplication, React validation parity for `actions` and `form`, and DOM prompt-text preservation for structured action messages
- 5 runtime/channel normalization regressions for synthesized fallback text on web-facing surfaces
- 15 Studio component/command tests across catalog, catalog page, insert panel, preview coverage, and the `/rich-template` command path
- 3 isolated-browser SDK widget regressions that prove channel-native-only fallback rendering plus ActionSet button/select round-trips through runtime → transport → SDK → widget rendering

That closes the `/rich-template` command-automation gap and the current ActionSet/fallback browser lane for the post-rollout audit.

## Remaining Follow-Ups

1. **Broader browser scenario matrix**: add dedicated widget/browser regressions for KPI/media/forms/charts/quick replies beyond the current fallback + ActionSet button/select lane. **Status: PARTIALLY IMPLEMENTED**
2. **Broader ABL parser/compiler authoring surface**: the current slash-insertable rich-content DSL is still limited to `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset, so several catalog entries remain preview-only or partial for DSL insertion. **Status: PARTIALLY IMPLEMENTED**
3. **Named `renderables[]` follow-up**: this guide still only covers the built-in `richContent` schema. A future extension would add `message.renderables[]` so customer-defined payloads can be rendered by contract name. **Status: NOT IMPLEMENTED**

Planned `renderables[]` coverage:

1. **Custom renderable transport mapping**: send `renderables[]` on websocket `response_end`, verify `DefaultTransport` and `ChatClient` preserve the payload. **Status: NOT IMPLEMENTED**
2. **Custom renderer extraction**: register a renderer for `com.bank.account_summary.v1`, verify it matches `message.renderables[].name` and renders in both DOM and React paths. **Status: NOT IMPLEMENTED**
3. **Renderable-only response handling**: verify assistant messages with `renderables[]` but no `richContent` do not trigger empty-response fallback. **Status: NOT IMPLEMENTED**
4. **Backwards compatibility**: verify built-in `richContent` rendering still works when `renderables[]` is absent. **Status: NOT IMPLEMENTED**

---

## Coverage Matrix

| FR    | Requirement                                                | Unit | Integration | E2E | Manual |
| ----- | ---------------------------------------------------------- | ---- | ----------- | --- | ------ |
| FR-1  | TemplateRegistry with 50-cap                               | ✅   | -           | -   | -      |
| FR-2  | TemplateRenderer interface                                 | ✅   | -           | -   | -      |
| FR-3  | Registry match() ordering                                  | ✅   | -           | -   | -      |
| FR-4  | RichContent 12 new fields                                  | ✅   | ✅          | -   | -      |
| FR-5  | isSafeUrl on all URL fields                                | ✅   | -           | -   | -      |
| FR-6  | Chart lazy-load with error handling                        | ✅   | -           | -   | -      |
| FR-7  | Form submit dispatches action                              | ✅   | -           | -   | -      |
| FR-8  | Studio catalog page                                        | ✅   | -           | -   | -      |
| FR-9  | /rich-template slash command insertion                     | ✅   | -           | -   | -      |
| FR-10 | RichContentIR schema extension                             | ✅   | ✅          | -   | -      |
| FR-11 | Runtime value resolution pass-through                      | -    | ✅          | -   | -      |
| FR-12 | i18n for all strings                                       | ✅   | -           | -   | -      |
| FR-13 | React hooks compliance                                     | ✅   | -           | -   | -      |
| FR-14 | Safe fallback rendering for shared channel-native payloads | ✅   | ✅          | ✅  | -      |
| FR-15 | React/DOM validation parity for `actions` and `form`       | ✅   | -           | -   | -      |
| FR-16 | Studio support-mode disclosure                             | ✅   | -           | -   | -      |

Legend: ✅ = Covered, ❌ = Not covered / still backlog, - = Not applicable

---

## Test File Map

| Test File                                                             | Package  | Tests                      | Focus                                                                           | Status  |
| --------------------------------------------------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------- | ------- |
| `packages/web-sdk/src/__tests__/template-registry.test.ts`            | web-sdk  | 6                          | Registry register, match, overflow, MAX_RENDERERS                               | ✅ PASS |
| `packages/web-sdk/src/__tests__/template-renderers.test.ts`           | web-sdk  | 21                         | All 15 renderers DOM + React output, markdown tables, channel fallback          | ✅ PASS |
| `packages/web-sdk/src/__tests__/template-safe-url.test.ts`            | web-sdk  | 22                         | isSafeUrl validation across all URL fields                                      | ✅ PASS |
| `packages/web-sdk/src/__tests__/rich-renderer.test.ts`                | web-sdk  | +1 parity regression       | `hasRichContent()` includes fallback-capable channel-native payloads            | ✅ PASS |
| `packages/web-sdk/src/__tests__/react-components.test.tsx`            | web-sdk  | +4 parity regressions      | React fallback rendering, validation parity, and action deduplication           | ✅ PASS |
| `packages/compiler/src/__tests__/ir/rich-content-compilation.test.ts` | compiler | 31                         | 12 template types compile to correct IR                                         | ✅ PASS |
| `apps/runtime/src/__tests__/rich-content-execution.test.ts`           | runtime  | 36                         | Runtime interpolation for all 12 template types                                 | ✅ PASS |
| `apps/runtime/src/services/channel/__tests__/outcome.test.ts`         | runtime  | +3 parity regressions      | Web-surface fallback synthesis and renderability detection                      | ✅ PASS |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`          | runtime  | +1 parity regression       | SDK websocket `response_end` includes normalized fallback text                  | ✅ PASS |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`             | runtime  | +1 parity regression       | HTTP chat route includes normalized fallback text and `usedFallback`            | ✅ PASS |
| `packages/web-sdk/src/__tests__/rich-content-sdk.test.ts`             | web-sdk  | 17                         | Wire format round-trip (pre-existing, updated)                                  | ✅ PASS |
| `packages/core/src/__tests__/rich-content-parser.test.ts`             | core     | 17                         | Core AST type parsing (pre-existing, updated)                                   | ✅ PASS |
| `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`            | web-sdk  | +1 parity regression       | Legacy DOM rich renderer preserves assistant prompt text with actions           | ✅ PASS |
| `apps/studio/src/__tests__/template-catalog.test.ts`                  | studio   | 4                          | Catalog support matrix/data shape validation and DSL authoring modes            | ✅ PASS |
| `apps/studio/src/__tests__/template-catalog-page.test.tsx`            | studio   | 3                          | Catalog badges, DSL authoring disclosure, tabs, and JSON validation             | ✅ PASS |
| `apps/studio/src/__tests__/template-insert-panel.test.tsx`            | studio   | 3                          | Insert panel selection, DSL insertion, and preview-only disabling               | ✅ PASS |
| `apps/studio/src/__tests__/abl-editor-rich-template-command.test.tsx` | studio   | 1                          | `/rich-template` command dispatch through ABLEditor and intelligent insert      | ✅ PASS |
| `apps/studio/src/__tests__/template-preview.test.tsx`                 | studio   | 4                          | HTML sanitization, fallback preview, and raw ActionSet preview                  | ✅ PASS |
| `apps/studio/e2e/sdk-widget.spec.ts`                                  | studio   | 3 rich-content regressions | Runtime → transport → SDK widget fallback plus button/select action round-trips | ✅ PASS |

**Coverage summary:** 115 dedicated rollout tests remain in place, plus 30 targeted parity tests/regressions across web-sdk, runtime, Studio component/command coverage, and the SDK widget browser lane.

---

## E2E Test Scenarios

1. **Template rendering in chat widget**: Send a message with `richContent.kpi` via WebSocket, verify the KPI card renders in the chat widget DOM with correct label, value, and trend indicator. **Status: NOT IMPLEMENTED**
2. **ActionSet button interaction**: Send a message authored with the current `ACTIONS:` DSL subset, click a button, verify the runtime receives the action and the widget renders the follow-up response. **Status: ✅ COVERED** (`apps/studio/e2e/sdk-widget.spec.ts` with isolated browser stack)
3. **ActionSet select interaction**: Send a message authored with the current `ACTIONS:` DSL subset, choose an option, verify the runtime receives the selected value and the widget renders the follow-up response. **Status: ✅ COVERED** (`apps/studio/e2e/sdk-widget.spec.ts` with isolated browser stack)
4. **Quick reply interaction**: Send a message with `richContent.quick_replies`, verify buttons render, click a button, verify the action event is dispatched to the agent. **Status: NOT IMPLEMENTED** (current ABL parser/compiler authoring support does not yet expose a first-class `QUICK_REPLIES:` block)
5. **Media gallery rendering**: Send messages with `richContent.image`, `richContent.video`, `richContent.file`, verify each renders the appropriate HTML element with validated URLs. **Status: NOT IMPLEMENTED**
6. **Form submission round-trip**: Send a message with `richContent.form` containing text input and select fields, fill in values, click submit, verify the `template:action` event is dispatched with correct field values. **Status: NOT IMPLEMENTED** (browser lane still needs richer authoring or fixture coverage beyond the current `ACTIONS:` subset)
7. **Chart lazy-load with error fallback**: Send a message with `richContent.chart`, verify loading placeholder appears, then chart SVG renders. Simulate import failure, verify error placeholder is shown instead of blank space. **Status: NOT IMPLEMENTED**
8. **Channel-native fallback rendering**: Send a message with `richContent.slack` or `richContent.adaptive_card`, verify web chat renders a safe fallback summary instead of an empty bubble. **Status: ✅ COVERED** (`apps/studio/e2e/sdk-widget.spec.ts` with isolated browser stack)
9. **Deferred submit validation parity**: Send `actions` and `form` payloads with required inputs, verify invalid submits are blocked and valid submits dispatch once. **Status: NOT IMPLEMENTED** (covered today at unit level, not browser level)

---

## Integration Test Scenarios

1. **Registry dispatch integration**: Create a `Message` with multiple `richContent` fields (markdown + kpi + actions), verify the registry returns all matching renderers in correct order and each produces valid output. **Status: ✅ COVERED** (`template-renderers.test.ts`)
2. **Value resolution pass-through**: Construct a `RichContentIR` object with `kpi` and `table` fields containing `{{variable}}` placeholders, call `interpolateRichContent` with test data, verify all 12 new fields are present in the output and placeholders are resolved. **Status: ✅ COVERED** (`rich-content-execution.test.ts`)
3. **isSafeUrl integration**: Create messages with `javascript:`, `data:`, `http:`, and `https:` URLs across all template types, verify only safe URLs produce rendered elements. **Status: ✅ COVERED** (`template-safe-url.test.ts`)
4. **Backwards compatibility**: Render a `Message` with only the original 3 `richContent` fields (markdown, carousel, actions) through the new registry, verify identical output to the pre-registry renderer. **Status: ✅ COVERED** (`template-renderers.test.ts`)
5. **Compiler IR compilation**: Compile all 12 template AST types through the compiler, verify correct IR output for each. **Status: ✅ COVERED** (`rich-content-compilation.test.ts`)
6. **Parity regressions in shared web surfaces**: Render channel-native payloads, `actions`-only messages, and `richContent + actions` messages through the React and legacy DOM paths, verify fallback rendering and single action rendering behavior. **Status: ✅ COVERED** (`template-renderers.test.ts`, `rich-renderer.test.ts`, `react-components.test.tsx`)
7. **Runtime/channel normalization**: Verify web-facing channels synthesize normalized response text when the execution result contains only channel-native payloads, and that both websocket and HTTP chat surfaces forward `usedFallback`. **Status: ✅ COVERED** (`outcome.test.ts`, `ws-sdk-handler.test.ts`, `chat-routes.test.ts`)

---

## Test Infrastructure Notes

- Web SDK tests use `vitest` with `happy-dom`
- Runtime tests use `vitest` with the real value-resolution and channel outcome paths
- Compiler tests use `vitest` with the real compilation pipeline
- Studio component tests use React Testing Library and the existing `apps/studio` test harness
- SDK widget browser regression uses Playwright and can run either against an existing local Studio/Runtime stack or the isolated stack (`SDK_BROWSER_E2E_ISOLATED=true`)
- The isolated browser stack requires built `@agent-platform/runtime`, `@agent-platform/studio`, and `@agent-platform/web-sdk` artifacts, plus installed Playwright Chromium
- The isolated Studio browser stack also depends on `apps/studio/src/lib/ensure-db.ts` reattaching the DEK facade/resolver into the active model module context after `initDEKFacade()`; `apps/studio/src/__tests__/lib-sso.test.ts` guards that bootstrap seam
- Chart renderer DOM tests still need to run from `packages/web-sdk/` because of the existing happy-dom environment quirk
- Current parity-remediation verification includes `pnpm build --filter=@agent-platform/runtime`, `pnpm build --filter=@agent-platform/studio`, `pnpm build --filter=@agent-platform/web-sdk`, targeted Vitest runs in runtime/web-sdk/Studio, and the isolated widget Playwright regression

---

## Iteration Log

| Date       | What Changed                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-03-25 | Implementation complete. 115 tests passing. 5 review rounds done. Studio component tests deferred.                                                                                                                                               |
| 2026-03-26 | Post-impl sync audit: verified test counts against source (6+20+22+31+36=115), added counts for pre-existing updated test files (`rich-content-sdk`: 17, `rich-content-parser`: 17). All file paths verified to exist on `develop`.              |
| 2026-04-16 | Added 6 targeted web-sdk parity regressions for safe fallback rendering, `hasRichContent()` parity, assistant action deduplication, and React validation parity for deferred `actions` / `form` submits.                                         |
| 2026-04-16 | Added runtime/channel normalization regressions (`outcome.test.ts`, `ws-sdk-handler.test.ts`, `chat-routes.test.ts`), 4 Studio component suites (11 tests), and an isolated SDK widget browser regression for channel-native fallback rendering. |
| 2026-04-16 | Added `/rich-template` command coverage, DSL authoring-mode disclosure tests for the catalog/insert panel, a DOM prompt-text regression for structured action messages, and isolated widget button/select action round-trips.                    |
