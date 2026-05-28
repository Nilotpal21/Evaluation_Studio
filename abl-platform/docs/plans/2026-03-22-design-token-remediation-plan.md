# Design Token Remediation Plan — Studio & Admin

**Date**: 2026-03-22
**Status**: Draft
**Scope**: Fix all hardcoded Tailwind styles and align both apps with the shared design token system

---

## Audit Summary

| Metric                                | Studio  | Admin   | Total   |
| ------------------------------------- | ------- | ------- | ------- |
| Files with violations                 | 49      | 18      | **67**  |
| Hardcoded palette classes             | 196     | 76      | **272** |
| `text-white` violations               | 56      | 48      | **104** |
| `bg-white` (non-toggle)               | 14      | 1       | **15**  |
| `bg-black` overlays                   | 38      | 11      | **49**  |
| Inline hex/rgb in styles              | 29      | 0       | **29**  |
| Arbitrary Tailwind hex (`bg-[#...]`)  | 4       | 0       | **4**   |
| Arbitrary Tailwind hsl (`bg-[hsl()]`) | 32      | 0       | **32**  |
| **Total violations**                  | **369** | **136** | **505** |

### Critical Design System Gaps

| Gap                                                                        | Impact                                        | Priority |
| -------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| `--orange` family missing in Admin globals.css                             | `bg-orange`, `text-orange` render transparent | P0       |
| `--purple-muted` missing in Admin globals.css                              | `text-purple-muted` renders transparent       | P0       |
| `--border-focus` wrong in Admin (`220 5% 93%` near-white vs Studio's blue) | Focus ring invisible — a11y failure           | P0       |
| No `bg-overlay` token in either app                                        | 49 modal overlays use raw `bg-black/60`       | P1       |
| Neutral hue mismatch (Studio `220` cool gray, Admin `0` pure gray)         | Visual temperature inconsistency              | P2       |
| 20 redundant utility classes in Admin globals.css                          | Dual maintenance burden                       | P2       |
| No light theme in Admin                                                    | Dark-only, blocks future theming              | P3       |

---

## Implementation Plan

### Phase 0 — Token Foundation (Pre-requisite)

**Goal**: Close all design system gaps so semantic tokens are available before code migration.

#### Task 0.1 — Add missing CSS variables to Admin globals.css

Add to `apps/admin/src/app/globals.css` `:root`:

```css
--orange: 24.6 95% 53.1%;
--orange-foreground: 0 0% 100%;
--orange-muted: 24.6 95% 40%;
--orange-subtle: 24.6 50% 15%;
--purple-muted: 262.1 83.3% 40%;
```

#### Task 0.2 — Fix `--border-focus` in Admin

Change from `220 5% 93%` to `217 91% 60%` (matching Studio's accessible blue).

#### Task 0.3 — Add `bg-overlay` utility to both globals.css files

```css
.bg-overlay {
  background-color: hsl(0 0% 0% / 0.6);
}
```

#### Task 0.4 — Add missing border/solid utility classes to Admin globals.css

Admin lacks solid-background and border utility classes that Studio has. Add:

```css
.bg-success {
  background-color: hsl(var(--success));
}
.bg-warning {
  background-color: hsl(var(--warning));
}
.bg-error {
  background-color: hsl(var(--error));
}
.bg-info {
  background-color: hsl(var(--info));
}
.bg-purple {
  background-color: hsl(var(--purple));
}
.bg-orange {
  background-color: hsl(var(--orange));
}
.bg-orange-subtle {
  background-color: hsl(var(--orange-subtle));
}
.text-orange {
  color: hsl(var(--orange));
}
.border-success {
  border-color: hsl(var(--success));
}
.border-warning {
  border-color: hsl(var(--warning));
}
.border-error {
  border-color: hsl(var(--error));
}
.border-info {
  border-color: hsl(var(--info));
}
.border-purple {
  border-color: hsl(var(--purple));
}
.border-orange {
  border-color: hsl(var(--orange));
}
```

#### Task 0.5 — Add chart color resolver utility

Create `packages/shared-ui/src/utils/chart-colors.ts`:

```ts
export function resolveTokenColor(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return `hsl(${value})`;
}
```

This enables chart libraries (Recharts) that require hex/rgb to consume CSS variables.

**Acceptance Criteria (Phase 0)**:

- [ ] `pnpm build --filter=studio --filter=admin` passes
- [ ] All semantic tokens render correctly in both apps (visual spot check)
- [ ] `--border-focus` produces a visible focus ring in Admin

---

### Phase 1 — Shared Component Migration (Highest Blast Radius)

**Goal**: Fix shared components that propagate violations to every consumer.

#### Task 1.1 — `packages/admin-ui/src/components/status-badge.tsx` (20 palette violations)

Replace `EVENT_TYPE_STYLES` map:

| Before                                                     | After                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `bg-emerald-500/15 text-emerald-400 border-emerald-500/25` | `bg-success-subtle text-success border-success`             |
| `bg-amber-500/15 text-amber-400 border-amber-500/25`       | `bg-warning-subtle text-warning border-warning`             |
| `bg-red-500/15 text-red-400 border-red-500/25`             | `bg-error-subtle text-error border-error`                   |
| `bg-blue-500/15 text-blue-400 border-blue-500/25`          | `bg-info-subtle text-info border-info`                      |
| `bg-zinc-500/15 text-zinc-400 border-zinc-500/25`          | `bg-background-elevated text-foreground-muted border-muted` |
| `bg-emerald-400` (dot)                                     | `bg-success`                                                |
| `bg-amber-400` (dot)                                       | `bg-warning`                                                |
| `bg-red-400` (dot)                                         | `bg-error`                                                  |
| `bg-blue-400` (dot)                                        | `bg-info`                                                   |
| `bg-zinc-400` (dot)                                        | `bg-foreground-muted` (or new `.bg-neutral` token)          |

#### Task 1.2 — `packages/admin-ui/src/components/metric-card.tsx` (2 violations)

| Before             | After          |
| ------------------ | -------------- |
| `text-emerald-400` | `text-success` |
| `text-red-400`     | `text-error`   |

#### Task 1.3 — `packages/admin-ui/src/components/confirm-dialog.tsx` (2 violations)

| Before                                   | After                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| `bg-black/60`                            | `bg-overlay`                                          |
| `bg-red-600 text-white hover:bg-red-700` | `bg-error text-error-foreground hover:bg-error-muted` |

#### Task 1.4 — `packages/admin-ui/src/components/date-range-picker.tsx` (1 violation)

| Before       | After                    |
| ------------ | ------------------------ |
| `text-white` | `text-accent-foreground` |

#### Task 1.5 — `apps/studio/src/components/ui/Progress.tsx` (2 violations)

| Before        | After                 |
| ------------- | --------------------- |
| `bg-gray-200` | `bg-background-muted` |
| `bg-blue-600` | `bg-accent`           |

**Acceptance Criteria (Phase 1)**:

- [ ] All shared components use only semantic tokens
- [ ] Visual regression check: badges, metric cards, dialogs, date picker, progress bar render identically
- [ ] No hardcoded palette classes in `packages/admin-ui/src/`

---

### Phase 2 — Admin App Migration

**Goal**: Eliminate all hardcoded colors from Admin pages.

#### Task 2.1 — `text-white` → `text-accent-foreground` sweep (48 instances, 14 files)

Global find-and-replace in Admin: every `text-white` paired with `bg-accent` → `text-accent-foreground`.

Files: `deals/[id]/page.tsx`, `models/page.tsx`, `tenants/[id]/page.tsx`, `secrets/page.tsx`, `resilience/page.tsx`, `config-overrides/page.tsx`, `tenants/page.tsx`, `deals/page.tsx`, `traces/[traceId]/page.tsx`, `models/[id]/page.tsx`, `secrets/rotation/page.tsx`, `traces/page.tsx`, `tenants/[id]/UsageTab.tsx`, `features/page.tsx`

#### Task 2.2 — `bg-black/60` → `bg-overlay` sweep (10 instances, 6 files)

Files: `secrets/page.tsx` (3), `deals/[id]/page.tsx` (3), `models/page.tsx`, `tenants/page.tsx`, `deals/page.tsx`, `secrets/rotation/page.tsx`

#### Task 2.3 — `features/page.tsx` color map migration (24 palette violations)

Replace `TIER_COLORS` map and toggle component with semantic tokens.

#### Task 2.4 — `traces/[traceId]/page.tsx` event type colors (13 palette violations)

Replace `EVENT_TYPE_COLORS` map with semantic tokens.

#### Task 2.5 — `deals/[id]/page.tsx` remaining violations (7 palette + error states)

#### Task 2.6 — `secrets/page.tsx` remaining violations (5 palette)

#### Task 2.7 — Remaining Admin files (4 violations across 4 files)

`traces/page.tsx` (1), `tenants/page.tsx` (1), `deals/page.tsx` (1), `secrets/rotation/page.tsx` (1)

**Acceptance Criteria (Phase 2)**:

- [ ] `grep -r "(bg|text|border)-(blue|red|green|emerald|amber|zinc|purple)-" apps/admin/src/` returns 0 matches
- [ ] `grep -r "text-white" apps/admin/src/` returns 0 matches (excluding comments)
- [ ] All Admin pages render correctly (visual spot check per page)

---

### Phase 3 — Studio High-Severity Migration

**Goal**: Fix the top 10 worst-offender Studio files.

#### Task 3.1 — `VoiceMetricsTab.tsx` (25 palette + 1 bg-black)

Replace all `text-blue-500` → `text-info`, `bg-amber-500` → `bg-warning`, `bg-green-500` → `bg-success`, `bg-gray-300 dark:bg-gray-600` → `bg-background-muted`, etc.

#### Task 3.2 — `SyncProgress.tsx` (31 palette + 2 bg-white)

Replace all `bg-white` → `bg-background-elevated`, `text-gray-*` → `text-foreground`/`text-muted`/`text-subtle`, status colors → semantic tokens.

#### Task 3.3 — `SiteSelector.tsx` (16 palette + 3 bg-white)

Same pattern: `bg-white` → `bg-background-elevated`, gray scale → semantic neutrals.

#### Task 3.4 — `PipelineCanvas.tsx` (18 palette)

Replace stage type color map with semantic tokens.

#### Task 3.5 — `GuardrailPickerModal.tsx` (11 palette)

Replace guardrail type/action color classes.

#### Task 3.6 — `PipelineGroupNode.tsx` (6 palette)

Replace blue palette → `info` semantic.

#### Task 3.7 — `PipelineEditorToolbar.tsx` (7 palette + 1 text-white)

Replace emerald → success, yellow → warning.

#### Task 3.8 — `PipelineNodeComponent.tsx` (5 palette)

Replace node type color map.

#### Task 3.9 — `NodePalette.tsx` (5 palette)

Replace palette type colors (mirrors PipelineNodeComponent).

#### Task 3.10 — `SessionHealthBanner.tsx` (4 palette + dark: variants)

Replace `bg-red-50 border-red-200 dark:bg-red-950/30` → `bg-error-subtle border-error`, same for amber → warning.

**Acceptance Criteria (Phase 3)**:

- [ ] Top 10 files have zero hardcoded palette classes
- [ ] Voice metrics, search-ai pipeline, and guardrail UIs render correctly
- [ ] Dark and light themes produce correct colors

---

### Phase 4 — Studio Medium-Severity Migration

**Goal**: Fix remaining pipeline, search-ai, insights, and editor components.

#### Task 4.1 — Search-AI pipeline components (6 files, ~30 violations)

- `ChangeEmbeddingDialog.tsx` (5)
- `TestSelectionModal.tsx` (7)
- `PipelineHeader.tsx` (3)
- `FlowDetail.tsx` (5)
- `FlowsList.tsx` (1)
- `ReindexConfirmDialog.tsx` (4)
- `RuleBuilderPanel.tsx` (1)
- `EmbeddingConfigSection.tsx` (1)

#### Task 4.2 — Search-AI non-pipeline components (5 files, ~15 violations)

- `EnterpriseConnectorWizard.tsx` (6)
- `StructuredDataSchemaDialog.tsx` (6)
- `IntelligenceCard.tsx` (3)
- `KGModelSelectionCard.tsx` (1)
- `KGWorkspaceInheritanceCard.tsx` (1)

#### Task 4.3 — Insights components (3 files, ~6 violations)

- `BreakdownTable.tsx` (3)
- `InsightKPICard.tsx` (2)
- `AtAGlancePage.tsx` (1)

#### Task 4.4 — ABL/Agent editor components (5 files, ~7 violations)

- `ToolPickerDialog.tsx` (2)
- `ToolsEditor.tsx` (1)
- `ToolsSection.tsx` (2)
- `TemplatePickerModal.tsx` (1)
- `ToolPickerModal.tsx` (1)

#### Task 4.5 — Connection/Auth components (2 files, ~7 violations)

- `ConnectorLogo.tsx` (5)
- `ConsentConnectorRow.tsx` (2)

#### Task 4.6 — Editor hex values (2 files, 4 violations)

- `HandoffsEditor.tsx`: `bg-[#6366F1]/15 text-[#6366F1]` → `bg-info/15 text-info`, `style={{ color: '#6366F1' }}` → use CSS var
- `DelegatesEditor.tsx`: `bg-[#F59E0B]/15 text-[#F59E0B]` → `bg-warning/15 text-warning`, `style={{ color: '#F59E0B' }}` → use CSS var

#### Task 4.7 — Observatory event-colors.ts (1 violation)

- `bg-green-700` → `bg-success-muted`

**Acceptance Criteria (Phase 4)**:

- [ ] All search-ai, pipeline, insights, ABL, and connection components use semantic tokens
- [ ] `grep -r "(bg|text|border)-(blue|red|green|emerald|amber|zinc|purple|pink|cyan|indigo)-" apps/studio/src/components/` returns only acceptable exceptions (SourceViewer syntax highlighting)

---

### Phase 5 — Studio Chart & Inline Style Migration

**Goal**: Fix hardcoded hex/rgb in chart components and inline styles.

#### Task 5.1 — Create chart color resolver utility (if not done in Phase 0)

#### Task 5.2 — Insights chart colors (3 files, ~21 rgb violations)

- `AtAGlancePage.tsx` (14 rgb instances)
- `BreakdownTable.tsx` (3 rgb instances)
- `InsightKPICard.tsx` (3 rgb instances)

Replace all `rgb(16 185 129)` → `resolveTokenColor('--success')`, etc.

#### Task 5.3 — Voice analytics widgets (4 files, ~20 hex violations)

- `UserExperienceWidget.tsx`
- `NetworkQualityWidget.tsx`
- `SpeechQualityWidget.tsx`
- `ResponsePerformanceWidget.tsx`

#### Task 5.4 — `AddModelDialog.tsx` arbitrary hsl values (32 instances)

Extract provider color map to a shared config using CSS variables.

#### Task 5.5 — `ManageVariableNamespacesPanel.tsx` hex badge colors (8 instances)

Replace hardcoded hex array with token-based color array.

#### Task 5.6 — `global-error.tsx` inline hex (6 instances)

**Note**: Error boundary may intentionally hardcode because CSS variables may not be loaded. Evaluate whether to keep as-is or add a `<style>` block with fallback values.

#### Task 5.7 — `app/page.tsx` inline hsl (4 instances)

Replace hardcoded `hsl(...)` with `var(--...)` references.

**Acceptance Criteria (Phase 5)**:

- [ ] No hardcoded `rgb()` in JSX (excluding test files)
- [ ] No `#[hex]` in inline styles (excluding global-error.tsx if intentional)
- [ ] Charts render correct colors from CSS variables

---

### Phase 6 — Overlay & White Sweep

**Goal**: Standardize overlays and eliminate remaining `text-white`/`bg-white` violations.

#### Task 6.1 — Studio `bg-black` → `bg-overlay` (38 instances, 36 files)

Global sweep across all modal/slide-over/panel overlay backgrounds.

#### Task 6.2 — Studio `bg-white` non-toggle (14 instances, 5 files)

- `preview/page.tsx` (6): `bg-white/20` overlay variants → evaluate
- `preview/[projectId]/page.tsx` (2): same
- `SiteSelector.tsx` (3): → `bg-background-elevated`
- `SyncProgress.tsx` (2): → `bg-background-elevated`
- `SessionHealthBanner.tsx` (1): `dark:hover:bg-white/10` → `hover:bg-foreground/10`

#### Task 6.3 — Studio `text-white` audit (56 instances, 23 files)

Categorize each as:

- On `bg-accent` → `text-accent-foreground`
- On `bg-success/error/warning` → `text-success-foreground`/etc.
- In preview widget (user-configurable) → keep
- On dark solid bg → evaluate per context

**Acceptance Criteria (Phase 6)**:

- [ ] Zero `bg-black` in non-test files (or all converted to `bg-overlay`)
- [ ] Zero `bg-white` in non-toggle contexts
- [ ] All `text-white` on semantic backgrounds use `text-*-foreground` tokens

---

### Phase 7 — Cleanup & Hardening

#### Task 7.1 — Remove redundant utility classes from Admin globals.css

Remove the 20 duplicate classes that Tailwind already generates from `base.js`.

#### Task 7.2 — Align neutral hue temperature (P2)

Decide: should Admin adopt Studio's cool gray (`220` hue) or remain pure neutral (`0` hue)? If aligning, update Admin globals.css neutral variables.

#### Task 7.3 — Add ESLint rule to prevent regression

Add `eslint-plugin-no-hardcoded-colors` or a custom rule that flags:

- `(bg|text|border)-(blue|red|green|yellow|amber|emerald|zinc|gray|slate|neutral|stone)-\d`
- `text-white`, `bg-white` (with exceptions for toggle knobs)
- `bg-[#` arbitrary hex values

#### Task 7.4 — Add PreToolUse hook for CI

Create `.claude/hooks/design-token-lint.sh` that blocks commits introducing hardcoded palette colors.

**Acceptance Criteria (Phase 7)**:

- [ ] ESLint rule catches regressions in CI
- [ ] Admin globals.css has no redundant utility class definitions
- [ ] PreToolUse hook blocks new hardcoded color introductions

---

## Test Plan

### Unit Tests (per phase)

#### Phase 0 — Token Foundation

| Test | Description                                                                       | File                                                    |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| T0.1 | Verify all CSS variables resolve in Admin                                         | `apps/admin/src/__tests__/design-tokens.test.ts`        |
| T0.2 | Verify `--orange` family renders non-transparent in Admin                         | Same                                                    |
| T0.3 | Verify `--border-focus` has sufficient contrast ratio (>= 3:1 against background) | Same                                                    |
| T0.4 | Verify `resolveTokenColor()` returns valid hsl string                             | `packages/shared-ui/src/__tests__/chart-colors.test.ts` |

#### Phase 1 — Shared Components

| Test | Description                                                    | File                                                      |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------- |
| T1.1 | StatusBadge renders all statuses with correct semantic classes | `packages/admin-ui/src/__tests__/status-badge.test.tsx`   |
| T1.2 | MetricCard trend arrows use semantic color classes             | `packages/admin-ui/src/__tests__/metric-card.test.tsx`    |
| T1.3 | ConfirmDialog overlay uses `bg-overlay`                        | `packages/admin-ui/src/__tests__/confirm-dialog.test.tsx` |
| T1.4 | ConfirmDialog destructive button uses error tokens             | Same                                                      |
| T1.5 | Progress component uses semantic bg classes                    | `apps/studio/src/__tests__/progress.test.tsx`             |

#### Phase 2 — Admin Pages

| Test | Description                                        | File                                                 |
| ---- | -------------------------------------------------- | ---------------------------------------------------- |
| T2.1 | No `text-white` in rendered Admin page classNames  | `apps/admin/src/__tests__/design-compliance.test.ts` |
| T2.2 | Features page tier badges use semantic tokens      | `apps/admin/src/__tests__/features-page.test.tsx`    |
| T2.3 | Trace detail event type badges use semantic tokens | `apps/admin/src/__tests__/trace-detail.test.tsx`     |

#### Phases 3-6 — Studio Components

| Test | Description                                            | File                                                       |
| ---- | ------------------------------------------------------ | ---------------------------------------------------------- |
| T3.1 | VoiceMetricsTab status indicators use semantic classes | `apps/studio/src/__tests__/voice-metrics-design.test.tsx`  |
| T3.2 | Pipeline node types use semantic color map             | `apps/studio/src/__tests__/pipeline-node-design.test.tsx`  |
| T3.3 | SessionHealthBanner severity uses semantic tokens      | `apps/studio/src/__tests__/session-health-design.test.tsx` |
| T5.1 | Chart components resolve colors from CSS variables     | `apps/studio/src/__tests__/chart-colors.test.tsx`          |

### Visual Regression Tests

| Test | Scope                                   | Method                |
| ---- | --------------------------------------- | --------------------- |
| VR1  | Status badges (all 10 states)           | Screenshot comparison |
| VR2  | Admin features page tier cards          | Screenshot comparison |
| VR3  | Trace detail event timeline             | Screenshot comparison |
| VR4  | Studio pipeline canvas (all node types) | Screenshot comparison |
| VR5  | Voice metrics dashboard                 | Screenshot comparison |
| VR6  | Search-AI sync progress states          | Screenshot comparison |
| VR7  | Guardrail picker modal                  | Screenshot comparison |
| VR8  | Insights charts (at-a-glance)           | Screenshot comparison |
| VR9  | Studio light theme full page            | Screenshot comparison |
| VR10 | Admin modal overlay backdrop            | Screenshot comparison |

### Accessibility Tests

| Test | Description                             | Pass Criteria                                                 |
| ---- | --------------------------------------- | ------------------------------------------------------------- |
| A1   | Focus ring visibility in Admin          | `--border-focus` contrast ratio >= 3:1 against `--background` |
| A2   | `text-accent-foreground` on `bg-accent` | Contrast ratio >= 4.5:1 (WCAG AA)                             |
| A3   | Error text on error-subtle bg           | Contrast ratio >= 4.5:1                                       |
| A4   | Success text on success-subtle bg       | Contrast ratio >= 4.5:1                                       |
| A5   | Warning text on warning-subtle bg       | Contrast ratio >= 4.5:1                                       |
| A6   | Foreground-muted on background          | Contrast ratio >= 4.5:1                                       |

---

## E2E Coverage Scenarios — Checklist

### Design Token Resolution

- [ ] **E2E-DT-01**: All CSS variables defined in `:root` resolve to valid HSL values (not empty/undefined)
- [ ] **E2E-DT-02**: Studio light theme (`[data-theme='light']`) overrides all required variables
- [ ] **E2E-DT-03**: Theme toggle (dark→light→dark) applies correct variables without flash
- [ ] **E2E-DT-04**: Admin renders with correct dark theme (no light theme flash)
- [ ] **E2E-DT-05**: `--border-focus` produces visible focus ring on keyboard navigation (Admin)
- [ ] **E2E-DT-06**: `--border-focus` produces visible focus ring on keyboard navigation (Studio, both themes)

### Shared Component Rendering

- [ ] **E2E-SC-01**: StatusBadge "healthy" state → green dot + green text on green-subtle bg
- [ ] **E2E-SC-02**: StatusBadge "degraded" state → amber dot + amber text on amber-subtle bg
- [ ] **E2E-SC-03**: StatusBadge "down" state → red dot + red text on red-subtle bg
- [ ] **E2E-SC-04**: StatusBadge "unknown" state → gray dot + muted text on muted bg
- [ ] **E2E-SC-05**: ConfirmDialog destructive action → red button, dark overlay backdrop
- [ ] **E2E-SC-06**: MetricCard positive trend → green arrow
- [ ] **E2E-SC-07**: MetricCard negative trend → red arrow
- [ ] **E2E-SC-08**: Progress bar → muted track + accent fill

### Admin Pages

- [ ] **E2E-AD-01**: Features page → tier badges render with correct semantic colors (success, info, purple, warning, neutral)
- [ ] **E2E-AD-02**: Features page → toggle switch checked state uses success color, unchecked uses elevated bg
- [ ] **E2E-AD-03**: Trace detail → event type badges render correct semantic colors per event type (llm=info, tool=purple, agent=success, handoff=warning, error=error)
- [ ] **E2E-AD-04**: Deals page → status badges use semantic colors (green/red for won/lost)
- [ ] **E2E-AD-05**: Secrets page → delete confirmation modal has dark overlay + error-colored delete button
- [ ] **E2E-AD-06**: Models page → tab selection uses accent bg + accent-foreground text (not white)
- [ ] **E2E-AD-07**: Tenants page → all action buttons use accent-foreground text on accent bg
- [ ] **E2E-AD-08**: All Admin modals → overlay backdrop uses consistent `bg-overlay` opacity

### Studio — Pipeline & Canvas

- [ ] **E2E-ST-01**: Pipeline canvas → each stage type (extraction, transformation, generation, output, enrichment, custom) renders with correct semantic color
- [ ] **E2E-ST-02**: Pipeline node component → node type colors (LLM=info, output=success, tool=orange, error=error) are semantic
- [ ] **E2E-ST-03**: Pipeline group node → selected state uses info color, unselected uses info-subtle
- [ ] **E2E-ST-04**: Pipeline editor toolbar → published badge uses success tokens, draft uses warning tokens
- [ ] **E2E-ST-05**: Node palette → each node type icon/label matches pipeline node component colors

### Studio — Search-AI

- [ ] **E2E-ST-06**: Sync progress → completed state uses success tokens (green border, green icon, green text)
- [ ] **E2E-ST-07**: Sync progress → error state uses error tokens (red border, red icon, red text)
- [ ] **E2E-ST-08**: Sync progress → in-progress state uses info tokens (blue)
- [ ] **E2E-ST-09**: Sync progress → warning state uses warning tokens (amber)
- [ ] **E2E-ST-10**: Site selector → selected site has accent border/bg, unselected has default border
- [ ] **E2E-ST-11**: Enterprise connector wizard → connection test success/failure uses success/error tokens
- [ ] **E2E-ST-12**: Pipeline header → published/draft/error/deploying status badges use correct tokens
- [ ] **E2E-ST-13**: Reindex confirm dialog → destructive confirmation uses warning/error tokens
- [ ] **E2E-ST-14**: Change embedding dialog → breaking vs non-breaking changes use error vs warning tokens

### Studio — Agent & ABL

- [ ] **E2E-ST-15**: Guardrail picker → input/output/shield guardrail types render with success/info/purple tokens
- [ ] **E2E-ST-16**: Guardrail picker → guardrail action indicators (block=red, allow=green) use semantic tokens
- [ ] **E2E-ST-17**: Handoffs editor → handoff badges use info/edge-handoff color (not hardcoded indigo hex)
- [ ] **E2E-ST-18**: Delegates editor → delegate badges use warning color (not hardcoded amber hex)
- [ ] **E2E-ST-19**: Tools section → MCP tool badges use purple tokens
- [ ] **E2E-ST-20**: Template picker → template type badges use info tokens

### Studio — Insights & Analytics

- [ ] **E2E-ST-21**: At-a-glance page → outcome chart uses semantic colors (success=resolved, warning=escalated, error=failed, muted=abandoned)
- [ ] **E2E-ST-22**: Breakdown table → progress bars use resolved semantic colors from CSS variables
- [ ] **E2E-ST-23**: KPI cards → trend arrows use success (up) / error (down) semantic colors
- [ ] **E2E-ST-24**: Voice analytics widgets → all chart colors resolve from CSS variables (no hardcoded hex)

### Studio — Session & Chat

- [ ] **E2E-ST-25**: Session health banner → error severity uses error-subtle bg + error border
- [ ] **E2E-ST-26**: Session health banner → warning severity uses warning-subtle bg + warning border
- [ ] **E2E-ST-27**: Voice metrics tab → all metric indicators use semantic status colors

### Studio — Theme Switching

- [ ] **E2E-ST-28**: Dark → light toggle: all semantic colors update (backgrounds lighten, text darkens)
- [ ] **E2E-ST-29**: Light → dark toggle: all semantic colors update (backgrounds darken, text lightens)
- [ ] **E2E-ST-30**: System preference change: detected and applied when theme is set to "system"
- [ ] **E2E-ST-31**: Theme persistence: reload page → same theme applied from localStorage
- [ ] **E2E-ST-32**: No unstyled flash during initial page load (CSS variables load before first paint)

### Studio — Overlays & Modals

- [ ] **E2E-ST-33**: All slide-over panels use `bg-overlay` backdrop (not `bg-black/60`)
- [ ] **E2E-ST-34**: All dialog modals use `bg-overlay` backdrop
- [ ] **E2E-ST-35**: Command palette overlay uses `bg-overlay` backdrop
- [ ] **E2E-ST-36**: Modal backdrop click-to-dismiss works with `bg-overlay` class

### Cross-App Consistency

- [ ] **E2E-XA-01**: Shared `status-badge` component renders identically in Studio and Admin
- [ ] **E2E-XA-02**: Error states (red) are visually consistent between Studio and Admin
- [ ] **E2E-XA-03**: Success states (green) are visually consistent between Studio and Admin
- [ ] **E2E-XA-04**: Warning states (amber) are visually consistent between Studio and Admin
- [ ] **E2E-XA-05**: Info states (blue) are visually consistent between Studio and Admin
- [ ] **E2E-XA-06**: Accent buttons render with correct foreground contrast in both apps

### Regression Prevention

- [ ] **E2E-RP-01**: ESLint rule catches new hardcoded palette class introduction
- [ ] **E2E-RP-02**: PreToolUse hook blocks commit with hardcoded color pattern
- [ ] **E2E-RP-03**: CI build fails if hardcoded palette classes are detected in non-excluded files
- [ ] **E2E-RP-04**: Grep audit script returns 0 violations for both apps

---

## Risk Assessment

| Risk                                                     | Mitigation                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Semantic token not visually identical to hardcoded value | Visual regression screenshots before/after per component                    |
| Chart libraries can't consume CSS variables              | Chart color resolver utility (Task 0.5)                                     |
| `global-error.tsx` breaks if CSS vars unavailable        | Keep hardcoded as fallback with `/* intentional: error boundary */` comment |
| Admin missing tokens causes transparent rendering        | Phase 0 must complete before any component migration                        |
| `text-accent-foreground` contrast insufficient           | Validate WCAG AA (4.5:1) in both themes before migration                    |
| Toggle knob `bg-white` wrongly migrated                  | Exclude toggle knob pattern from automated sweep                            |

---

## Timeline Estimate

| Phase     | Scope                  | Est. Tasks   |
| --------- | ---------------------- | ------------ |
| Phase 0   | Token Foundation       | 5 tasks      |
| Phase 1   | Shared Components      | 5 tasks      |
| Phase 2   | Admin App              | 7 tasks      |
| Phase 3   | Studio High-Severity   | 10 tasks     |
| Phase 4   | Studio Medium-Severity | 7 tasks      |
| Phase 5   | Charts & Inline Styles | 7 tasks      |
| Phase 6   | Overlay & White Sweep  | 3 tasks      |
| Phase 7   | Cleanup & Hardening    | 4 tasks      |
| **Total** |                        | **48 tasks** |

Phases 0-2 (foundation + admin) can be done independently from Phases 3-6 (studio), enabling parallel work.
