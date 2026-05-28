# Pass 3 Final Audit -- Complete Design Token Remediation

**Date:** 2026-03-22
**Reviewer:** LLD Reviewer Agent (Opus 4.6)
**Scope:** All studio, admin, and admin-ui components
**Branch:** develop

---

## Section 1: Violation Scorecard

| #   | Category                                        | Before (initial audit) | After Pass 3 | Delta | Remaining (genuine) | Remaining (acceptable exception)               |
| --- | ----------------------------------------------- | ---------------------- | ------------ | ----- | ------------------- | ---------------------------------------------- |
| 1   | Hardcoded Tailwind palette in Studio components | ~60+ across many files | 4            | -56+  | 0                   | 4 (SourceViewer syntax highlighting)           |
| 2   | Hardcoded palette in Studio app pages           | ~10+                   | 0            | -10+  | 0                   | 0                                              |
| 3   | Hardcoded palette in Admin                      | ~15+                   | 0            | -15+  | 0                   | 0                                              |
| 4   | Hardcoded palette in admin-ui                   | ~8+                    | 0            | -8+   | 0                   | 0                                              |
| 5   | `text-white` in Studio components (excl. tests) | ~20+ across many files | 9            | -11+  | 8 (see below)       | 1 (ConsentConnectorRow icon on bg-destructive) |
| 6   | `text-white` in Admin                           | ~5+                    | 0            | -5+   | 0                   | 0                                              |
| 7   | `bg-black/50` and `bg-black/60` overlays        | 32 files (from Pass 2) | 0            | -32   | 0                   | 0                                              |
| 8   | Arbitrary hex `[#...]` in Tailwind classes      | ~3+                    | 0            | -3+   | 0                   | 0                                              |
| 9   | Hardcoded `rgb()` in JSX                        | ~3                     | 1            | -2    | 0                   | 1 (AgentNode canvas shadow)                    |
| 10  | `dark:` prefix in Studio components             | ~8+                    | 0            | -8+   | 0                   | 0                                              |

**Summary:** All primary violation categories are at zero or at acceptable-exception-only levels, except for `text-white` in 8 instances that are a consistent pattern worth reviewing (see Section 2).

---

## Section 2: Remaining Genuine Violations

### 2.1 `bg-accent text-white` Pattern (8 occurrences across 5 files) -- MEDIUM

Every remaining `text-white` in Studio components (excluding ConsentConnectorRow) follows the exact same pattern: a selected tab/filter pill that uses `bg-accent text-white` for the active state.

| File                                                             | Line(s)       | Context                  |
| ---------------------------------------------------------------- | ------------- | ------------------------ |
| `apps/studio/src/components/abl/pickers/BasePickerModal.tsx`     | 256           | Selected tab pill        |
| `apps/studio/src/components/abl/pickers/TemplatePickerModal.tsx` | 241           | Selected format tab      |
| `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`    | 271, 283, 409 | Mode toggle + add button |
| `apps/studio/src/components/search-ai/data/ChunksTable.tsx`      | 288, 302      | Status filter pills      |
| `apps/studio/src/components/search-ai/viewer/ChunkNavigator.tsx` | 24            | Chunk index pill         |

**Assessment:** These should use `text-accent-foreground` instead of `text-white`. The `--accent-foreground` CSS variable is defined as white in the current theme, so the visual output is identical today, but `text-white` will break if a theme ever defines a dark accent color with light foreground differently. This is a correctness issue, not a visual bug.

**Fix:** Replace `text-white` with `text-accent-foreground` in all 8 occurrences. This is a safe, zero-visual-change migration.

### 2.2 Test Files Asserting Old Palette Classes (3 files) -- HIGH

Component code has been migrated, but test files still assert the pre-migration class names. These tests will **fail at runtime** because the DOM no longer contains the asserted classes.

| Test File                                                         | Line(s)       | Asserted Class                                    | Component Now Uses                                       |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `apps/studio/src/__tests__/search-ai/intelligence-cards.test.tsx` | 188, 274, 315 | `.bg-emerald-500`                                 | Semantic token (via design-tokens)                       |
| `apps/studio/src/__tests__/search-ai/intelligence-hub.test.tsx`   | 104, 119, 126 | `.bg-emerald-500`, `.bg-amber-500`, `.bg-red-500` | Semantic token                                           |
| `apps/studio/src/__tests__/agent-editor-slider.test.tsx`          | 101, 108      | `.bg-black\\/40`                                  | Still uses `bg-black/40` (correct -- this test is valid) |

**Note:** The agent-editor-slider test is actually CORRECT -- the component `AgentEditorSlider.tsx` still uses `bg-black/40` (a lighter overlay, not in the Pass 3 scope). But the intelligence-cards and intelligence-hub tests are genuinely broken.

**Fix:** Update the intelligence-cards and intelligence-hub tests to assert the new semantic class names used by the migrated components.

### 2.3 Remaining `bg-black/N` Overlays -- Lower Opacity Variants (12 files) -- LOW

These are `bg-black/40`, `bg-black/30`, `bg-black/5`, and `bg-black/80` (not the `bg-black/50` and `bg-black/60` that were targeted in Pass 3).

| Pattern       | Count | Files                                                                                                                                    |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bg-black/40` | 7     | AgentEditorSlider, ProfileModal, ApiKeysModal, VersionsSlideOver, ChatSlideOver, DslEditorOverlay, AdvancedFilterPanel, ColumnCustomizer |
| `bg-black/80` | 1     | `ui/shadcn/sheet.tsx` (shadcn default)                                                                                                   |
| `bg-black/30` | 1     | `search-ai/ConnectorDetailPanel.tsx`                                                                                                     |
| `bg-black/5`  | 1     | `ui/InfoCard.tsx` (hover effect)                                                                                                         |

**Assessment:**

- `bg-black/40` overlays: These are lighter slide-over backdrops. An `OVERLAY_BACKDROP_LIGHT` constant exists in `design-tokens/overlay.ts` but is not being used. Consider migrating to `bg-overlay/40` (a CSS class already defined in `tokens.css`) or a dedicated `bg-overlay-light` class for consistency. **Not blocking.**
- `bg-black/80` in `sheet.tsx`: This is shadcn boilerplate. Migrating shadcn primitives carries risk of breaking updates. **Acceptable exception.**
- `bg-black/30` in ConnectorDetailPanel: Should be `bg-overlay/40` or a lighter overlay token for consistency. **Low priority.**
- `hover:bg-black/5` in InfoCard: A very subtle hover darken. Acceptable as a micro-interaction. **Acceptable exception.**

---

## Section 3: Acceptable Exceptions Inventory

| File/Pattern                                                                    | Violation Type                                                         | Justification                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/abl/SourceViewer.tsx` (4 occurrences)                               | `text-yellow-300`, `text-cyan-400`, `text-yellow-400`, `text-pink-400` | **Syntax highlighting colors.** These are code-display-specific colors that intentionally do NOT map to semantic intents. Same rationale as Monaco editor themes.                    |
| `app/preview/page.tsx` and `app/preview/[projectId]/page.tsx` (~26 occurrences) | `text-white`                                                           | **Preview widget.** This is a user-facing chat widget preview with user-configurable colors. The white text is on a configurable brand-color background. Cannot use semantic tokens. |
| `app/auth/login/page.tsx`                                                       | Any palette colors                                                     | **Login page.** Brand-specific styling for the auth experience. Not part of the design system scope.                                                                                 |
| `app/global-error.tsx`                                                          | Hardcoded fallbacks                                                    | **Error boundary.** Must render without CSS variable resolution. Hardcoded colors are the correct approach for crash-time rendering.                                                 |
| `ui/shadcn/sheet.tsx`                                                           | `bg-black/80`                                                          | **shadcn primitive.** Modifying shadcn defaults creates drift from upstream. Accept as-is.                                                                                           |
| `ui/InfoCard.tsx`                                                               | `hover:bg-black/5`                                                     | **Micro-interaction.** A 5% opacity hover darken is not a semantic color. Acceptable utility usage.                                                                                  |
| `auth-profiles/ConsentConnectorRow.tsx`                                         | `text-white` on icon                                                   | Icon on `bg-destructive` badge. Should ideally be `text-destructive-foreground` but `bg-destructive` already implies white foreground in both themes. Marginal.                      |
| `canvas/nodes/AgentNode.tsx`                                                    | `rgb(0 0 0 / 0.1)` in boxShadow                                        | **Canvas drop-shadow.** Tailwind classes cannot be used in inline `boxShadow` CSS. Raw color values are required here.                                                               |
| `components/*/Toggle*` and settings toggles (12 files)                          | `bg-white` for toggle knob                                             | **Toggle switch knob.** The white circle on a colored track is a universal UI pattern. `bg-white` is intentional -- the knob is always white regardless of theme.                    |

---

## Section 4: Architecture Quality Assessment

### 4.1 design-tokens Package Structure

**Rating: GOOD**

The package is well-organized with clear separation of concerns:

```
packages/design-tokens/src/
  index.ts        -- Clean barrel export, well-documented
  intents.ts      -- Core SemanticIntent type + style registry
  color-maps.ts   -- Domain-to-intent mappings (8 domains)
  chart-colors.ts -- Runtime color resolution for chart libraries
  overlay.ts      -- Overlay backdrop constants
  tokens.css      -- Shared CSS custom property definitions
```

**Strengths:**

- The `SemanticIntent` type union is the correct abstraction level (9 intents)
- `IntentStyles` and `BadgeIntentStyles` interfaces provide structured class access
- `color-maps.ts` centralizes ALL domain-to-color decisions in one file
- The `useChartColors` hook correctly uses `useSyncExternalStore` with proper MutationObserver lifecycle (module-scoped observer, cleanup on last listener departure -- the Pass 1 issue was fixed)
- SSR-safe fallbacks in `resolveTokenColor` and `resolveAllChartColors`
- `CHART_COLOR_PALETTE` replaces hardcoded hex arrays (confirmed: ManageVariableNamespacesPanel migrated)

**Concerns:**

1. **`tokens.css` is NOT imported by Studio's `globals.css`.** The `bg-overlay` class is defined in BOTH `tokens.css` AND `globals.css`. This means `tokens.css` is currently redundant for Studio. If the intent was for `tokens.css` to be the single source and apps to import it, that chain is broken. Currently it works because `globals.css` duplicates the definition. This is not blocking but creates drift risk.

2. **`OVERLAY_BACKDROP_LIGHT` uses raw `bg-black/40`, not a token.** The overlay.ts module exports constants that themselves contain hardcoded values. This is a minor inconsistency -- the "light" variant should reference a CSS class or token.

3. **`step_thought` trace event type is missing from `TRACE_EVENT_INTENT_MAP`.** The recent commit `834d1f8bd` added `step_thought` as a trace event type, and it is used in the runtime flow-step-executor and observatory schema, but `color-maps.ts` does not map it. It will silently fall back to `'muted'`. This should be mapped -- likely to `'purple'` (reasoning/decisions) or `'accent'` (flow steps).

### 4.2 Tailwind Content Path Coverage

**Rating: GOOD**

- Studio: `tailwind.config.js` includes `../../packages/design-tokens/src/**/*.{ts,tsx}` -- correct
- Admin: `tailwind.config.ts` includes `../../packages/design-tokens/src/**/*.{ts,tsx}` -- correct
- admin-ui: No `tailwind.config` found (uses the admin app's config via shared setup) -- acceptable if admin-ui components are only rendered within the admin app

### 4.3 Dockerfile Coverage

**Rating: GOOD**

All 4 app Dockerfiles include `COPY packages/design-tokens/package.json`:

- `apps/runtime/Dockerfile` -- line 29
- `apps/studio/Dockerfile` -- line 33
- `apps/search-ai/Dockerfile` -- line 37
- `apps/admin/Dockerfile` -- line 32

### 4.4 Migration Consistency

**Rating: GOOD with one gap**

- Overlay migration (bg-black/50, bg-black/60 to bg-overlay): **Complete.** Zero remaining instances.
- text-white migration (10 specified files): **Complete.** All 10 files are clean.
- ManageVariableNamespacesPanel hex migration: **Complete.** Now uses `CHART_COLOR_PALETTE`.
- Admin app: **Fully clean.** Zero hardcoded palette colors, zero text-white, zero bg-black.
- admin-ui: **Fully clean.** Zero violations across all categories.

**Gap:** The `bg-accent text-white` pattern (8 occurrences) was not in the Pass 3 scope but represents the last systematic pattern of hardcoded white text in components.

---

## Section 5: Final Verdict

### PASS_WITH_NOTES

The Pass 3 design token remediation is **substantially complete**. All targeted violations have been resolved:

- bg-black/50 and bg-black/60 overlays: 32 files migrated to bg-overlay (0 remaining)
- text-white in 10 specified files: All migrated (0 remaining)
- ManageVariableNamespacesPanel hex array: Migrated to CHART_COLOR_PALETTE
- Admin and admin-ui: Fully clean across all violation categories
- dark: prefix: Zero remaining in Studio components
- Arbitrary hex values: Zero remaining

**Items requiring attention before merge:**

| Priority | Item                                                                                                                          | Effort |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| HIGH     | Fix 6 broken test assertions in intelligence-cards.test.tsx and intelligence-hub.test.tsx (asserting removed palette classes) | 15 min |
| MEDIUM   | Replace 8x `bg-accent text-white` with `bg-accent text-accent-foreground`                                                     | 10 min |
| LOW      | Add `step_thought` to `TRACE_EVENT_INTENT_MAP` in color-maps.ts                                                               | 2 min  |
| LOW      | Resolve tokens.css vs globals.css bg-overlay duplication                                                                      | 5 min  |

**The HIGH item (broken tests) should be fixed before merge.** The MEDIUM and LOW items can be addressed in a follow-up.

---

## Appendix: Raw Scan Results

### Scan 1 -- Hardcoded palette in Studio components

**4 occurrences in 1 file** (all in SourceViewer.tsx -- acceptable exception)

### Scan 2 -- Hardcoded palette in Studio app pages

**0 occurrences**

### Scan 3 -- Hardcoded palette in Admin

**0 occurrences**

### Scan 4 -- Hardcoded palette in admin-ui

**0 occurrences**

### Scan 5 -- text-white in Studio components

**9 occurrences in 6 files** (8 bg-accent pattern + 1 ConsentConnectorRow exception)

### Scan 6 -- text-white in Admin

**0 occurrences**

### Scan 7 -- bg-black/50 and bg-black/60 remaining

**0 occurrences** (fully migrated)

### Scan 8 -- Arbitrary hex in Tailwind classes

**0 occurrences**

### Scan 9 -- Hardcoded rgb() in JSX

**1 occurrence** (AgentNode.tsx boxShadow -- acceptable exception)

### Scan 10 -- dark: prefix in Studio components

**0 occurrences**
