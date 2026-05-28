# Studio Design System Analysis

**Task:** Pre-Check #58 - Explore Studio design system and existing UI patterns
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

Studio uses a **custom design system** built on **Tailwind CSS** with **Radix UI primitives**, **Zustand** for state management, and **React Hook Form** with **Zod** validation. The system features a dark theme with violet-tinted neutrals, semantic color tokens, and 37 reusable UI components.

---

## 1. Technology Stack

### UI Framework

- **React** 18.2.0
- **Next.js** (App Router)
- **TypeScript**

### Component Library

- **Radix UI** - Headless, accessible primitives
  - `@radix-ui/react-dialog` - Modals/dialogs
  - `@radix-ui/react-dropdown-menu` - Dropdowns
  - `@radix-ui/react-popover` - Popovers
  - `@radix-ui/react-tabs` - Tabs
  - `@radix-ui/react-checkbox` - Checkboxes
  - `@radix-ui/react-toggle` - Toggles
  - `@radix-ui/react-tooltip` - Tooltips

### Styling

- **Tailwind CSS** with custom design tokens
- **clsx** for conditional class names
- **Framer Motion** for animations (Dialog, modals)

### State Management

- **Zustand** 4.4.7 - Global state (auth, editor, navigation, etc.)
- **SWR** 2.4.0 - Data fetching & caching
- **Tanstack React Query** 5.90.21 - Server state management

### Forms

- **React Hook Form** 7.71.2 - Form state management
- **Zod** - Schema validation
- **@hookform/resolvers** - Zod integration

### Other Libraries

- **Lucide React** - Icon library (consistent icons)
- **Monaco Editor** - Code editing (`@monaco-editor/react`)

---

## 2. Design System - Color Palette

### Theme

**Dark theme with violet-tinted neutrals** (HSL color space)

### Semantic Color Tokens

All colors defined as CSS variables in `apps/studio/src/index.css`:

#### Background Colors

```css
--background: 260 2% 4%; /* Near black */
--background-subtle: 260 2% 7%; /* Slightly lighter */
--background-muted: 260 2% 10%; /* Card backgrounds */
--background-elevated: 260 2% 12.5%; /* Elevated surfaces */
```

**Usage:**

```tsx
<div className="bg-background-muted border border-default rounded-lg">Card</div>
```

#### Foreground Colors (Text)

```css
--foreground: 260 1% 98%; /* Primary text */
--foreground-muted: 260 2% 64%; /* Secondary text */
--foreground-subtle: 260 2% 45%; /* Tertiary text */
```

**Usage:**

```tsx
<p className="text-foreground">Primary text</p>
<p className="text-muted">Secondary text</p>
<p className="text-subtle">Tertiary text</p>
```

#### Border Colors

```css
--border: 260 2% 15%; /* Default borders */
--border-muted: 260 2% 12%; /* Subtle borders */
--border-focus: 252 56% 60%; /* Focus ring (violet) */
```

#### Accent (Primary Brand Color - Violet)

```css
--accent: 252 56% 60%;
--accent-foreground: 0 0% 100%;
--accent-muted: 252 56% 48%;
--accent-subtle: 252 40% 20%;
```

**Usage:**

```tsx
<Button variant="primary">Primary Button</Button>
// Renders with: bg-accent text-accent-foreground
```

#### Status Colors

| Color   | CSS Variable | Use Case                          |
| ------- | ------------ | --------------------------------- |
| Success | `--success`  | Success messages, positive states |
| Warning | `--warning`  | Warnings, caution states          |
| Error   | `--error`    | Errors, destructive actions       |
| Info    | `--info`     | Informational messages            |
| Purple  | `--purple`   | AI/LLM-related features           |

Each has variants: `DEFAULT`, `foreground`, `muted`, `subtle`

**Usage:**

```tsx
<Badge variant="success">Active</Badge>
<Alert variant="error">Error occurred</Alert>
<Button variant="danger">Delete</Button>
```

---

## 3. Design System - Typography

### Font Stacks

```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, monospace;
```

### Type Scale

| Size | CSS Variable  | rem   | px  | Usage                 |
| ---- | ------------- | ----- | --- | --------------------- |
| xs   | `--text-xs`   | 0.75  | 12  | Captions, labels      |
| sm   | `--text-sm`   | 0.875 | 14  | Body text (secondary) |
| base | `--text-base` | 1     | 16  | Body text (primary)   |
| lg   | `--text-lg`   | 1.125 | 18  | Subheadings           |
| xl   | `--text-xl`   | 1.25  | 20  | Headings (H3)         |
| 2xl  | `--text-2xl`  | 1.5   | 24  | Headings (H2)         |

### Line Heights

```css
--leading-tight: 1.25;
--leading-normal: 1.5;
--leading-relaxed: 1.625;
```

### Usage Examples

```tsx
<h2 className="text-2xl font-semibold text-foreground">Pipeline Configuration</h2>
<p className="text-sm text-muted leading-normal">Secondary description text</p>
<code className="font-mono text-xs">doc.contentType == 'pdf'</code>
```

---

## 4. Design System - Spacing Scale

**4px base unit**

```css
--space-0: 0px;
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
```

**Tailwind Classes:** `p-2` (8px), `p-4` (16px), `gap-2` (8px), `mt-6` (24px), etc.

---

## 5. UI Component Library

### Location

`apps/studio/src/components/ui/`

### Available Components (37 total)

| Component          | Description                       | Based On         |
| ------------------ | --------------------------------- | ---------------- |
| `Button`           | Primary, secondary, ghost, danger | HTML button      |
| `Dialog`           | Modal dialogs with animations     | Radix Dialog     |
| `Card`             | Content containers                | HTML div         |
| `Input`            | Text inputs                       | HTML input       |
| `Textarea`         | Multi-line text input             | HTML textarea    |
| `Select`           | Dropdown selector                 | Radix Select     |
| `SearchableSelect` | Select with search filtering      | Radix Select     |
| `Checkbox`         | Checkbox input                    | Radix Checkbox   |
| `Toggle`           | Toggle switch                     | Radix Toggle     |
| `DataTable`        | Sortable, filterable table        | HTML table       |
| `Pagination`       | Page navigation                   | Custom           |
| `Badge`            | Status badges                     | HTML span        |
| `Alert`            | Alert messages                    | HTML div         |
| `Tabs`             | Tab navigation                    | Radix Tabs       |
| `DropdownMenu`     | Dropdown menus                    | Radix Dropdown   |
| `Tooltip`          | Hover tooltips                    | Radix Tooltip    |
| `SlidePanel`       | Slide-out side panel              | Custom           |
| `EmptyState`       | Empty state placeholders          | HTML div         |
| `ErrorBoundary`    | Error boundary wrapper            | React            |
| `Skeleton`         | Loading skeletons                 | HTML div         |
| `PageHeader`       | Page title and actions            | HTML header      |
| `JsonViewer`       | JSON syntax highlighting          | Custom           |
| `CodeBlock`        | Code syntax highlighting          | Custom           |
| `MarkdownContent`  | Markdown rendering                | Custom           |
| `DiffViewer`       | Side-by-side diff viewer          | Custom           |
| `ConfirmDialog`    | Confirmation dialogs              | Dialog           |
| `Avatar`           | User avatars                      | HTML img         |
| `StatusDot`        | Status indicator dots             | HTML div         |
| `Breadcrumb`       | Breadcrumb navigation             | HTML nav         |
| `Sidebar`          | Application sidebar               | HTML aside       |
| `Section`          | Content sections                  | HTML section     |
| `InfoCard`         | Information cards                 | Card             |
| `SegmentedControl` | Segmented button group            | Custom           |
| `ProviderSelect`   | LLM provider selector             | SearchableSelect |
| `ThemeToggle`      | Light/dark theme toggle           | Toggle           |
| `KoreLogo`         | Application logo                  | SVG              |
| `ErrorAlert`       | Error alert messages              | Alert            |

---

## 6. Component Patterns

### Button Component

**Location:** `apps/studio/src/components/ui/Button.tsx`

```tsx
import { Button } from '@/components/ui/Button';

// Variants: primary, secondary, ghost, danger
<Button variant="primary" size="md">Save Pipeline</Button>
<Button variant="secondary" size="sm" icon={<PlusIcon />}>Add Flow</Button>
<Button variant="ghost">Cancel</Button>
<Button variant="danger">Delete</Button>

// Loading state
<Button loading>Saving...</Button>

// With icon
<Button icon={<SaveIcon />}>Save</Button>
```

**Variants:**

- `primary` - Accent background, white text
- `secondary` - Muted background, border
- `ghost` - Transparent, hover background
- `danger` - Red background (destructive actions)

**Sizes:** `xs`, `sm`, `md` (default), `lg`

### Dialog Component

**Location:** `apps/studio/src/components/ui/Dialog.tsx`

```tsx
import { Dialog } from '@/components/ui/Dialog';
import { useState } from 'react';

function MyComponent() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog
      open={isOpen}
      onClose={() => setIsOpen(false)}
      title="Configure Flow"
      description="Set up flow selection rules"
      maxWidth="lg"
    >
      <div className="space-y-4">{/* Dialog content */}</div>
    </Dialog>
  );
}
```

**Features:**

- Radix UI Dialog primitive (accessible, keyboard nav)
- Framer Motion animations (scale + fade)
- Backdrop blur
- Focus trapping
- Escape key to close
- Click outside to close

**Max Widths:** `sm`, `md` (default), `lg`, `xl`, `2xl`

### DataTable Component

**Location:** `apps/studio/src/components/ui/DataTable.tsx`

```tsx
import { DataTable, type Column } from '@/components/ui/DataTable';

const columns: Column<PipelineFlow>[] = [
  {
    key: 'name',
    label: 'Flow Name',
    render: (flow) => <span className="font-medium">{flow.name}</span>,
    sortable: true,
    sortValue: (flow) => flow.name,
  },
  {
    key: 'priority',
    label: 'Priority',
    render: (flow) => flow.priority,
    sortable: true,
    sortValue: (flow) => flow.priority,
  },
  {
    key: 'actions',
    label: 'Actions',
    render: (flow) => <Button size="xs">Edit</Button>,
  },
];

<DataTable
  columns={columns}
  data={flows}
  keyExtractor={(flow) => flow.id}
  onRowClick={(flow) => editFlow(flow)}
  emptyMessage="No flows configured"
/>;
```

**Features:**

- Sortable columns (asc/desc/none toggle)
- Row click handler
- Custom cell rendering
- Empty state
- Responsive overflow

---

## 7. Form Patterns

### React Hook Form with Zod

**Pattern:** React Hook Form + Zod resolver

**Example:** `apps/studio/src/components/search-ai/CrawlJobForm.tsx`

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

// 1. Define schema
const formSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  selectionRules: z.string().optional(),
  priority: z.coerce.number().min(1).max(100),
});

type FormData = z.infer<typeof formSchema>;

// 2. Use form hook
function MyForm() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setValue,
    watch,
  } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      priority: 10,
    },
  });

  const onSubmit = async (data: FormData) => {
    await savePipeline(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Input */}
      <div>
        <label className="text-sm font-medium text-foreground">Name</label>
        <Input {...register('name')} placeholder="Pipeline name" />
        {errors.name && <p className="text-xs text-error">{errors.name.message}</p>}
      </div>

      {/* Textarea */}
      <div>
        <label className="text-sm font-medium text-foreground">Selection Rules</label>
        <Textarea {...register('selectionRules')} rows={3} />
        {errors.selectionRules && (
          <p className="text-xs text-error">{errors.selectionRules.message}</p>
        )}
      </div>

      {/* Submit */}
      <Button type="submit" loading={isSubmitting}>
        Save Pipeline
      </Button>
    </form>
  );
}
```

### Form Layout Pattern

```tsx
<form className="space-y-6">
  {/* Form section */}
  <div className="space-y-4">
    <h3 className="text-lg font-semibold">Flow Configuration</h3>

    {/* Field group */}
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="text-sm font-medium text-foreground">Name</label>
        <Input {...register('name')} />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground">Priority</label>
        <Input type="number" {...register('priority')} />
      </div>
    </div>
  </div>

  {/* Actions */}
  <div className="flex justify-end gap-2 pt-4 border-t border-default">
    <Button variant="secondary" onClick={onCancel}>
      Cancel
    </Button>
    <Button type="submit">Save</Button>
  </div>
</form>
```

---

## 8. State Management Patterns

### Zustand Store

**Pattern:** Create store with persist middleware

**Example:** `apps/studio/src/store/auth-store.ts`

```tsx
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MyState {
  pipelines: Pipeline[];
  selectedPipelineId: string | null;

  // Actions
  setPipelines: (pipelines: Pipeline[]) => void;
  selectPipeline: (id: string) => void;
  addPipeline: (pipeline: Pipeline) => void;
  updatePipeline: (id: string, updates: Partial<Pipeline>) => void;
  deletePipeline: (id: string) => void;
}

export const usePipelineStore = create<MyState>()(
  persist(
    (set) => ({
      pipelines: [],
      selectedPipelineId: null,

      setPipelines: (pipelines) => set({ pipelines }),

      selectPipeline: (id) => set({ selectedPipelineId: id }),

      addPipeline: (pipeline) =>
        set((state) => ({
          pipelines: [...state.pipelines, pipeline],
        })),

      updatePipeline: (id, updates) =>
        set((state) => ({
          pipelines: state.pipelines.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),

      deletePipeline: (id) =>
        set((state) => ({
          pipelines: state.pipelines.filter((p) => p.id !== id),
          selectedPipelineId: state.selectedPipelineId === id ? null : state.selectedPipelineId,
        })),
    }),
    {
      name: 'pipeline-storage',
      partialize: (state) => ({
        selectedPipelineId: state.selectedPipelineId,
      }),
    },
  ),
);

// Selectors
export const selectPipelines = (state: MyState) => state.pipelines;
export const selectSelectedPipeline = (state: MyState) =>
  state.pipelines.find((p) => p.id === state.selectedPipelineId);
```

**Usage:**

```tsx
import { usePipelineStore, selectPipelines } from '@/store/pipeline-store';

function PipelineList() {
  const pipelines = usePipelineStore(selectPipelines);
  const addPipeline = usePipelineStore((state) => state.addPipeline);

  return (
    <div>
      {pipelines.map((pipeline) => (
        <div key={pipeline.id}>{pipeline.name}</div>
      ))}
      <Button onClick={() => addPipeline(newPipeline)}>Add Pipeline</Button>
    </div>
  );
}
```

### Data Fetching with SWR

**Pattern:** SWR for server state

```tsx
import useSWR from 'swr';
import { fetchPipelines } from '@/api/pipelines';

function PipelineList({ indexId }: { indexId: string }) {
  const { data, error, isLoading, mutate } = useSWR(`/pipelines/${indexId}`, () =>
    fetchPipelines(indexId),
  );

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorAlert error={error} />;

  return (
    <div>
      {data.pipelines.map((pipeline) => (
        <div key={pipeline.id}>{pipeline.name}</div>
      ))}
    </div>
  );
}
```

**SWR Patterns:**

- Automatic caching
- Revalidation on focus
- Optimistic updates with `mutate()`
- Error retry

---

## 9. Animation Patterns

### Location

`apps/studio/src/lib/animation.ts` (assumed, referenced in Dialog)

### Framer Motion Transitions

Used in Dialog component:

```tsx
import { motion, AnimatePresence } from 'framer-motion';

// Backdrop fade
<motion.div
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  exit={{ opacity: 0 }}
  transition={{ duration: 0.15 }}
/>;

// Dialog scale + fade
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0, scale: 0.95 }}
  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
/>;
```

### CSS Transitions

**Class:** `transition-default` (assumed from Button component)

```css
.transition-default {
  transition: all 150ms ease-in-out;
}
```

### Button Press Animation

**Class:** `btn-press`

```css
.btn-press:active {
  transform: scale(0.98);
}
```

---

## 10. Existing SearchAI UI

### Location

`apps/studio/src/components/search-ai/`

### Key Components

| Component                    | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| `KnowledgeBaseDashboardPage` | KB overview with stats                   |
| `KnowledgeBaseDetailPage`    | KB detail tabs (Documents, Settings, KG) |
| `DocumentsTab`               | Document list with filters/search        |
| `ConnectorsTab`              | Connector configuration                  |
| `KnowledgeGraphTab`          | KG configuration UI                      |
| `SchemaTab`                  | Field mapping schema                     |
| `SettingsTab`                | KB settings (chunking, embeddings)       |
| `QueryPlaygroundTab`         | Query testing interface                  |
| `CrawlJobForm`               | Progressive disclosure crawl form        |

### Patterns from Existing SearchAI UI

**CrawlJobForm.tsx:**

- Progressive disclosure (show options as needed)
- React Hook Form + Zod validation
- Async operations with loading states
- Error handling with friendly messages
- Save preferences pattern (remember user choices)

**DocumentsTab.tsx:**

- DataTable for document list
- Filters + search bar
- Status badges (processing, completed, failed)
- Bulk actions (select multiple, trigger actions)
- Pagination for large lists

---

## 11. Routing

**Next.js App Router**

Pages are in `apps/studio/src/app/`

**Route Structure:**

```
/[locale]/[tenant]/projects/[projectId]/...
```

**For Pipeline UI:**

```
/[locale]/[tenant]/projects/[projectId]/knowledge-base/[indexId]/pipelines
/[locale]/[tenant]/projects/[projectId]/knowledge-base/[indexId]/pipelines/[pipelineId]
```

---

## 12. Internationalization

**Library:** `next-intl`

**Usage:**

```tsx
import { useTranslations } from 'next-intl';

function MyComponent() {
  const t = useTranslations('pipeline');

  return <h1>{t('title')}</h1>; // "Pipelines"
}
```

**Translation Files:** `apps/studio/src/i18n/messages/`

---

## 13. API Integration

### API Client

**Location:** `apps/studio/src/api/`

**Pattern:** Typed API functions

```tsx
// apps/studio/src/api/pipelines.ts
export async function fetchPipelines(indexId: string): Promise<Pipeline[]> {
  const res = await fetch(`/api/projects/${projectId}/indexes/${indexId}/pipelines`);
  if (!res.ok) throw new Error('Failed to fetch pipelines');
  const data = await res.json();
  return data.pipelines;
}

export async function createPipeline(indexId: string, input: PipelineInput): Promise<Pipeline> {
  const res = await fetch(`/api/projects/${projectId}/indexes/${indexId}/pipelines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create pipeline');
  return res.json();
}
```

---

## 14. Recommendations for Pipeline UI

### Component Reuse

**✅ Use existing components:**

- `Button`, `Dialog`, `DataTable`, `Input`, `Textarea`, `Select`, `Badge`, `Alert`
- `Card` for flow cards
- `Tabs` for pipeline tabs (Flows, Settings, History)
- `SlidePanel` for flow configuration panel
- `ConfirmDialog` for destructive actions
- `EmptyState` for "No flows configured"
- `Skeleton` for loading states

### Form Patterns

**✅ Follow React Hook Form + Zod pattern:**

```tsx
const flowFormSchema = z.object({
  name: z.string().min(1).max(100),
  priority: z.coerce.number().min(1).max(100),
  selectionRules: z.string().optional(),
  stages: z.array(stageSchema).min(1),
});
```

### State Management

**✅ Use Zustand for pipeline editor state:**

- `usePipelineEditorStore` - Current pipeline being edited
- Local state (`useState`) for form fields
- SWR for fetching pipelines from API

### Styling

**✅ Use Tailwind utility classes:**

```tsx
<div className="p-6 space-y-4 bg-background-muted border border-default rounded-lg">
  <h3 className="text-lg font-semibold text-foreground">Flow Configuration</h3>
  <p className="text-sm text-muted">Configure flow selection rules</p>
</div>
```

### Layout Pattern

```tsx
<div className="flex h-screen">
  {/* Left sidebar - Flow list */}
  <div className="w-80 border-r border-default bg-background-subtle">
    <FlowList />
  </div>

  {/* Main content - Flow editor */}
  <div className="flex-1 overflow-y-auto">
    <FlowEditor />
  </div>

  {/* Right panel - Validation errors (optional) */}
  <div className="w-96 border-l border-default">
    <ValidationPanel />
  </div>
</div>
```

---

## Conclusion

**Key Decisions:**

1. ✅ Use **Radix UI** components (Dialog, DropdownMenu, Tabs, etc.)
2. ✅ Use **Tailwind CSS** with semantic color tokens
3. ✅ Use **React Hook Form + Zod** for all forms
4. ✅ Use **Zustand** for global pipeline editor state
5. ✅ Use **SWR** for data fetching (pipelines list)
6. ✅ Use **Framer Motion** for dialog animations
7. ✅ Follow **existing SearchAI UI patterns** (DocumentsTab, CrawlJobForm)
8. ✅ Use **Lucide React** icons for consistency

**Design System:**

- **Colors:** Semantic tokens (accent, success, warning, error, background, foreground, border)
- **Typography:** Inter (sans), JetBrains Mono (mono), 6-level type scale
- **Spacing:** 4px base unit, use Tailwind spacing classes
- **Components:** 37 reusable UI components ready to use

**Next:** Proceed to frontend design tasks with this foundation.

---

**Analysis complete.** Ready for design implementation.
