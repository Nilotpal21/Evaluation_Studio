---
name: studio-design-system
description: Use when working on apps/studio/ UI code, creating components, styling, or modifying visual design. Covers color tokens, typography, spacing, animations, component conventions, and theming.
---

# Studio Design System

All UI code in `apps/studio/` follows these conventions. Design tokens live in `globals.css` as CSS variables.

## Color System

HSL-based semantic tokens — never use raw colors like `blue`, `gray`, or hex values in components.

**Backgrounds**: `--background` (main), `--background-subtle` (sections), `--background-muted` (cards), `--background-elevated` (modals/popovers)

**Text**: `--foreground` (primary), `--foreground-muted` (secondary), `--foreground-subtle` (tertiary/hints)

**Borders**: `--border` (default), `--border-muted` (subtle), `--border-focus` (focus rings)

**Status colors** — each has `-foreground`, `-muted`, `-subtle` variants:

- **Accent** (Indigo 234°): Primary actions, interactive elements
- **Success** (Green 142°): Positive states, confirmations
- **Warning** (Amber 45°): Caution states
- **Error** (Red 0°): Errors, destructive actions
- **Info** (Cyan 187°): Informational states
- **Purple** (262°): AI/LLM-related elements

**Pattern**: Subtle background + saturated text for badges/tags: `bg-accent-subtle text-accent`. Use Tailwind opacity modifiers for fine control: `bg-error/10 border-error/30`.

## Typography

- **Sans**: `Space Grotesk`, `Inter`, system stack
- **Mono**: `JetBrains Mono`, `Fira Code`, `SF Mono`
- Page titles: `text-xl font-semibold`
- Section headers: `text-lg font-semibold`
- Labels: `text-sm font-medium`
- Hints/metadata: `text-xs text-muted`

## Spacing & Radius

4px base unit: `--space-1` (4px) through `--space-16` (64px). Use standard Tailwind spacing (`p-4`, `gap-2`).

**Border radius**: `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (12px), `--radius-2xl` (16px), `--radius-full` (pills/avatars)

## Shadows

Depth scale: `--shadow-xs` → `--shadow-sm` → `--shadow-md` → `--shadow-lg` → `--shadow-xl`

Semantic glow: `--shadow-glow` (accent), `--shadow-glow-success`, `--shadow-glow-error`

Cards: `shadow-sm` default, `shadow-lg` on hover. Modals: `shadow-xl`.

## Animation & Transitions

**CSS duration variables** — never hardcode durations:

- `--duration-fast`: 150ms (hovers, UI feedback)
- `--duration-normal`: 200ms (default transitions)
- `--duration-slow`: 300ms (modal/panel entrance)
- `--duration-slower`: 500ms (major layout shifts)

**Easing**: `--ease-out` (default), `--ease-spring` (bouncy), `--ease-bounce` (exaggerated)

**Tailwind utility classes** — use these, don't write custom transitions:

- `.transition-default`: All interactive properties at `--duration-normal`
- `.transition-fast`: Same at `--duration-fast`
- `.btn-press`: Active state scale(0.97) on buttons
- `.focus-ring`: Focus visible ring (2px border + 4px box-shadow)
- `.card-hover`: Lift on hover (translateY -2px + shadow-lg)
- `.icon-hover`: Scale 1.1x on hover

**Framer Motion springs** (`src/lib/animation.ts`) — all use `damping: 30`:

- `springs.snappy` (500): Tab indicators, underlines
- `springs.default` (400): Modals, pill switchers
- `springs.gentle` (300): Sidebars, panels, drawers
- `springs.soft` (200): Staggered entrances

**CSS keyframe classes**: `.animate-fade-in`, `.animate-fade-in-up`, `.animate-fade-in-scale`, `.animate-slide-in-right`, `.animate-slide-in-left`, `.animate-bounce-in`, `.animate-pulse-soft`

**Chat**: `.message-appear` (fade-in-up 200ms), `.typing-dot` (pulse with staggered delays)

## Component Conventions

**Class composition**: Always use `clsx` — never string concatenation or template literals for conditional classes:

```tsx
className={clsx('base-classes', condition && 'conditional', variantStyles[variant])}
```

**Variant/size pattern**: Define as `Record<Variant, string>` objects, compose with clsx:

```tsx
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90',
  secondary: 'bg-background-muted border border-default hover:bg-background-elevated',
  ghost: 'text-muted hover:text-foreground hover:bg-background-muted',
  danger: 'bg-error text-error-foreground hover:opacity-90',
};
```

**Icons**: `lucide-react` exclusively. Standard size: `w-4 h-4`. Use `stroke="currentColor"` for color inheritance.

**Skeleton loaders**: Use `.skeleton` (shimmer) or `.skeleton-pulse` (opacity pulse) for loading states. Pre-built variants: `SkeletonText`, `SkeletonCard`, `SkeletonChat`.

## Theming

- Three modes: `light`, `dark`, `system` — managed by `theme-store.ts` (Zustand + persist)
- Theme applied via `data-theme` attribute on `<html>`
- CSS variables redefine per `[data-theme="light"]` selector
- Smooth theme switch: `.theme-transition` class (350ms) applied briefly during toggle
- Icon swap: Sun/Moon with Framer Motion `AnimatePresence` rotation

## Rules

- **DO**: Use semantic color utilities (`text-error`, `bg-success-subtle`), CSS variables for all tokens, `transition-default` on interactive elements, `clsx` for className composition, Framer Motion springs for UI physics
- **DON'T**: Use inline styles for colors, hardcode animation durations, use raw color names (`blue`, `gray`), mix CSS keyframes + Framer Motion on the same element, skip error states on form inputs

## KB Navigation Store Pattern (verified 2026-03-17)

Studio uses a **custom Zustand navigation store** (`src/store/navigation-store.ts`, 365 lines) instead of react-router for KB detail page routing:

- URL pattern: `/projects/:projectId/search-ai/:kbId/:tab`
- Uses `history.replaceState()` — no react-router integration
- Tab parsing via regex on `window.location.pathname`
- `setActiveTab()` updates both store state and URL

**When adding new navigation levels** (e.g., section/subSection):

1. Extend `parseUrl()` to extract additional path segments
2. Add new state fields and setters to the store
3. Use `history.replaceState()` — not `window.location.href` (avoids full reload)
4. Ensure browser back/forward works with `popstate` event listener

## SWR Data Fetching Pattern

Studio uses SWR with a global fetcher (`swr-config.ts`). All data hooks return `{data, isLoading, error, refresh}`.

**Anti-patterns discovered in existing code:**

- `{ onError: () => {} }` — FieldsTab:127 silently swallows ALL SWR errors. Never do this.
- Studio typed `SearchAIIndex.llmConfig` as `unknown | null` — use proper types for LLM config
- Raw `fetch()` calls alongside SWR hooks — centralize all API calls

## Zustand Selector Patterns _(learned from Wave 4 review — 1 HIGH finding)_

**Always use atomic selectors** — never create inline objects in `useStore()`:

```tsx
// BAD — creates new object every render, causes unnecessary re-renders
const { a, b } = useStore((s) => ({ a: s.a, b: s.b }));

// GOOD — atomic selectors, stable references
const a = useStore((s) => s.a);
const b = useStore((s) => s.b);

// GOOD — useShallow for multiple fields (zustand >=4.5 required; project uses 4.5.7)
import { useShallow } from 'zustand/react/shallow';
const { a, b } = useStore(useShallow((s) => ({ a: s.a, b: s.b })));
```

## SWR Mutation & Revalidation _(learned from Wave 4 review — 1 HIGH finding)_

After every mutation (POST/PUT/DELETE), revalidate related SWR keys:

```tsx
// After a mutation, invalidate the list cache
await createItem(data);
mutate('/api/items'); // revalidate the list
mutate(`/api/items/${id}`); // revalidate the detail (if applicable)
```

Never assume SWR will automatically pick up server-side changes. The cache is client-side and stale until explicitly revalidated.

## Loading Guard Pattern _(learned from Wave 4 review — 1 HIGH finding)_

All async button handlers must disable while in-flight to prevent double-click race conditions:

```tsx
const [loading, setLoading] = useState(false);
const handleClick = async () => {
  if (loading) return;
  setLoading(true);
  try {
    await doAsyncWork();
  } finally {
    setLoading(false);
  }
};
<Button onClick={handleClick} disabled={loading}>
  {loading ? <Spinner /> : 'Submit'}
</Button>;
```

## Keyboard Shortcut Modal Awareness _(learned from Wave 4 review — 1 MEDIUM finding)_

Global keyboard shortcut handlers must check for open dialogs before executing.
Reference implementation: `src/components/search-ai/hooks/useKBShortcuts.ts` — follow this pattern for any new shortcut hooks.

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Skip if a modal/dialog is open
    if (document.querySelector('[role="dialog"]')) return;
    // ... handle shortcut
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

## Zustand Store Lifecycle Warnings

**Pipeline store (`pipeline-store.ts`)**: Has NO `persist` middleware. `reset()` on unmount wipes ALL state — unsaved drafts permanently lost. Conditional rendering (`{activeTab === 'pipeline' && <PipelineEditor />}`) triggers unmount on every tab switch.

**Pattern to follow**: Use `useBlocker` or `beforeunload` guards when stores contain unsaved drafts. Or add `persist` middleware with `sessionStorage` for cross-navigation survival.

## Error/Loading/Empty State Coverage (verified 2026-03-17)

| Component          | Loading State        | Empty State            | Error Handling              | Quality |
| ------------------ | -------------------- | ---------------------- | --------------------------- | ------- |
| PipelineEditor     | Full Skeleton layout | Custom CTA             | ErrorBoundary + Retry       | ✅ Best |
| SettingsTab        | Plain text           | Alert                  | Alert + Retry               | Good    |
| KnowledgeGraphTab  | CSS skeleton         | EmptyState             | EmptyState + AlertCircle    | Good    |
| VocabularyTab      | Plain text           | EmptyState             | EmptyState (only top-level) | OK      |
| QueryPlaygroundTab | None                 | EmptyState             | Inline error banner         | Partial |
| DocumentsTab       | None                 | EmptyState             | None (SWR unhandled)        | Poor    |
| ConnectorsTab      | None                 | EmptyState             | None                        | Poor    |
| FieldsTab          | None                 | EmptyState per sub-tab | **Silently swallowed**      | Bad     |
| KBOverviewTab      | None                 | Always renders         | Inline indexError           | Poor    |
| CrawlerTab         | Spinner              | Plain text             | Plain error text            | Minimal |

**Standard for new components**: Follow PipelineEditor pattern — Skeleton loading, ErrorBoundary wrapper, retry capability, explicit empty states.

## Key Files

| File                                        | Purpose                                                           |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `apps/studio/src/app/globals.css`           | All CSS variables, keyframes, utility classes                     |
| `apps/studio/tailwind.config.js`            | Tailwind extends with semantic colors                             |
| `apps/studio/src/lib/animation.ts`          | Spring presets and transition constants                           |
| `apps/studio/src/store/theme-store.ts`      | Theme management (Zustand)                                        |
| `apps/studio/src/store/navigation-store.ts` | KB detail page routing (custom, not react-router)                 |
| `apps/studio/src/store/pipeline-store.ts`   | Pipeline editor state (Zustand, no persist, resets on unmount)    |
| `apps/studio/src/components/ui/`            | Base UI components (Button, Card, Badge, Input, Avatar, Skeleton) |
