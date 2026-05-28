# Tool Detail Page — Inline Editable Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the view/edit wizard toggle on the tool detail page with a single always-editable page where all configuration fields are directly editable, with a "Save Changes" button that appears when any field is modified.

**Architecture:** The current `ToolConfigView` (read-only) + `EditWizardInline` (multi-step wizard) are replaced by directly rendering the existing config form components (`HttpConfigForm`, `SandboxConfigForm`, `McpConfigForm`) on the page in always-editable mode. A new `SaveBar` component appears at the bottom when any config field is dirty. The existing inline name/description editing stays. Wizards remain for the create flow only.

**Tech Stack:** React, TypeScript, Framer Motion, next-intl, clsx, Vitest

---

### Task 1: Create the SaveBar Component

**Files:**

- Create: `apps/studio/src/components/tools/SaveBar.tsx`

**Step 1: Create SaveBar component**

This is a sticky bottom bar that appears when `isDirty` is true, with "Discard Changes" and "Save Changes" buttons.

```tsx
// apps/studio/src/components/tools/SaveBar.tsx
'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { AlertCircle } from 'lucide-react';

interface SaveBarProps {
  isDirty: boolean;
  isSaving: boolean;
  validationErrors?: Record<string, string>;
  onSave: () => void;
  onDiscard: () => void;
}

export function SaveBar({ isDirty, isSaving, validationErrors, onSave, onDiscard }: SaveBarProps) {
  const t = useTranslations('tools.detail');
  const hasErrors = validationErrors && Object.keys(validationErrors).length > 0;

  return (
    <AnimatePresence>
      {isDirty && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="sticky bottom-0 -mx-5 sm:-mx-6 px-5 sm:px-6 py-3 bg-background-elevated border-t border-default flex items-center justify-between gap-3 z-10"
        >
          <div className="flex items-center gap-2 text-sm">
            {hasErrors ? (
              <>
                <AlertCircle className="w-4 h-4 text-error" />
                <span className="text-error">{t('has_validation_errors')}</span>
              </>
            ) : (
              <span className="text-warning">{t('unsaved_changes')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onDiscard} disabled={isSaving}>
              {t('discard_changes')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onSave}
              loading={isSaving}
              disabled={hasErrors}
            >
              {t('save_changes')}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

**Step 2: Verify it compiles**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -20`

**Step 3: Commit**

```bash
git add apps/studio/src/components/tools/SaveBar.tsx
git commit -m "feat(studio): add SaveBar component for tool detail inline editing"
```

---

### Task 2: Add i18n Keys for New Strings

**Files:**

- Modify: `packages/i18n/locales/en/studio.json` — add keys under `tools.detail` namespace

**Step 1: Add new translation keys**

Add these keys to the `tools.detail` section in `packages/i18n/locales/en/studio.json`:

```json
"unsaved_changes": "Unsaved changes",
"has_validation_errors": "Fix validation errors before saving",
"discard_changes": "Discard Changes",
"save_changes": "Save Changes",
"configuration_title": "Configuration"
```

Check if `unsaved_changes`, `discard_changes`, and `save_changes` already exist first — they might. Only add missing keys.

**Step 2: Verify no JSON syntax errors**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/i18n/locales/en/studio.json', 'utf8'))"`

**Step 3: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add tool detail inline edit translation keys"
```

---

### Task 3: Add Reverse Adapters (Config → FormData) for Save

**Files:**

- Modify: `apps/studio/src/components/tools/form-adapters.ts`

The existing adapters go FormData → Config. We need the reverse direction (Config → FormData) for the save flow. The existing `handleHttpEditSave`, `handleSandboxEditSave`, `handleMcpEditSave` in ToolDetailPage already contain this logic inline — extract it into reusable functions.

**Step 1: Add httpConfigToToolForm function**

Add to `form-adapters.ts`:

```typescript
// ─── Wizard Config → Form (for save) ─────────────────────────────────────────

export function httpConfigToToolForm(
  name: string,
  description: string | null,
  config: HttpConfig,
  existingForm: HttpToolFormData | null,
): HttpToolFormData {
  return {
    name,
    toolType: 'http',
    description: description || null,
    parameters: existingForm?.parameters ?? [],
    returnType: existingForm?.returnType ?? 'object',
    endpoint: config.endpoint,
    method: config.method as HttpToolFormData['method'],
    auth: (config.authType || 'none') as HttpToolFormData['auth'],
    ...(config.authConfig && {
      authConfig: config.authConfig as HttpToolFormData['authConfig'],
    }),
    ...(config.headers?.length && { headers: config.headers }),
    ...(config.queryParams?.length && { queryParams: config.queryParams }),
    ...(config.retryCount && { retry: config.retryCount }),
    ...(config.retryDelayMs && config.retryDelayMs !== 1000 && { retryDelay: config.retryDelayMs }),
    ...(config.rateLimitPerMinute && { rateLimit: config.rateLimitPerMinute }),
    ...(config.circuitBreaker && { circuitBreaker: config.circuitBreaker }),
  };
}

export function sandboxConfigToToolForm(
  name: string,
  description: string | null,
  config: SandboxConfig,
): SandboxToolFormData {
  return {
    name,
    toolType: 'sandbox',
    description: description || null,
    parameters: (config.parameters || []).map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
    })),
    returnType: config.returnType || 'object',
    runtime: config.runtime as SandboxToolFormData['runtime'],
    code: config.codeContent,
    ...(config.memoryMb && { memoryMb: config.memoryMb }),
  };
}

export function mcpConfigToToolForm(
  name: string,
  description: string | null,
  config: McpConfig,
  existingForm: McpToolFormData | null,
): McpToolFormData {
  return {
    name,
    toolType: 'mcp',
    description: description || null,
    parameters: existingForm?.parameters ?? [],
    returnType: existingForm?.returnType ?? 'object',
    server: config.serverUrl,
    ...(config.serverToolName && { serverTool: config.serverToolName }),
  };
}
```

**Step 2: Add the missing imports at top of form-adapters.ts**

The file already imports `HttpToolFormData`, `SandboxToolFormData`, `McpToolFormData` from shared types. No new imports needed for the type side. Verify.

**Step 3: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -20`

**Step 4: Commit**

```bash
git add apps/studio/src/components/tools/form-adapters.ts
git commit -m "feat(studio): add reverse config-to-form adapters for tool save"
```

---

### Task 4: Rewrite ToolDetailPage — Remove Wizard, Add Inline Editing

This is the core task. Rewrite the configuration tab in `ToolDetailPage.tsx` to:

1. Remove `configMode` state (no view/edit toggle)
2. Remove `EditWizardInline` component usage
3. Render config forms directly, always editable
4. Track dirty state via deep comparison
5. Show `SaveBar` when dirty
6. Single unified save handler

**Files:**

- Modify: `apps/studio/src/components/tools/ToolDetailPage.tsx`

**Step 1: Replace imports**

Remove wizard imports, add new ones:

```typescript
// REMOVE these imports:
// import { HttpToolWizard } from './wizard/HttpToolWizard';
// import { SandboxToolWizard } from './wizard/SandboxToolWizard';
// import { McpToolWizard } from './wizard/McpToolWizard';

// ADD these imports:
import { HttpConfigForm, validateHttpConfig } from './HttpConfigForm';
import { SandboxConfigForm, validateSandboxConfig } from './SandboxConfigForm';
import { McpConfigForm, validateMcpConfig } from './McpConfigForm';
import { AdvancedSettingsSection } from './sections/config/AdvancedSettingsSection';
import { SaveBar } from './SaveBar';
import {
  toolFormToHttpConfig,
  toolFormToSandboxConfig,
  toolFormToMcpConfig,
  httpConfigToToolForm,
  sandboxConfigToToolForm,
  mcpConfigToToolForm,
} from './form-adapters';
```

Also add `validateSandboxConfig` export check — look at SandboxConfigForm.tsx for the export name.

**Step 2: Replace state management**

Remove:

```typescript
const [configMode, setConfigMode] = useState<'view' | 'edit'>('view');
```

Add:

```typescript
// Config editing state — always-editable
import type { AnyToolConfig, HttpConfig, SandboxConfig, McpConfig } from './shared-types';

const [editingConfig, setEditingConfig] = useState<AnyToolConfig | null>(null);
const initialConfigRef = useRef<AnyToolConfig | null>(null);
const [configErrors, setConfigErrors] = useState<Record<string, string>>({});

// Dirty check
const isDirty = useMemo(() => {
  if (!editingConfig || !initialConfigRef.current) return false;
  return JSON.stringify(editingConfig) !== JSON.stringify(initialConfigRef.current);
}, [editingConfig]);
```

**Step 3: Update loadTool to initialize config state**

After parsing DSL in `loadTool`, initialize the config:

```typescript
// Inside loadTool, after setParsedForm(form):
const toolType = tool.toolType as 'http' | 'sandbox' | 'mcp';
const form = parseDslToToolForm(dsl, toolType);
setParsedForm(form);

// Initialize editable config from parsed form
let config: AnyToolConfig | null = null;
if (form) {
  switch (form.toolType) {
    case 'http':
      config = toolFormToHttpConfig(form);
      break;
    case 'sandbox':
      config = toolFormToSandboxConfig(form);
      break;
    case 'mcp':
      config = toolFormToMcpConfig(form);
      break;
  }
}
setEditingConfig(config);
initialConfigRef.current = config ? JSON.parse(JSON.stringify(config)) : null;
```

**Step 4: Add unified save handler**

Replace the three separate `handleHttpEditSave`, `handleSandboxEditSave`, `handleMcpEditSave` with one:

```typescript
const handleConfigSave = async () => {
  if (!projectId || !toolId || !currentTool || !editingConfig || !parsedForm) return;

  // Validate
  const toolType = currentTool.toolType as 'http' | 'sandbox' | 'mcp';
  let errors: Record<string, string> = {};
  if (toolType === 'http') errors = validateHttpConfig(editingConfig as HttpConfig);
  else if (toolType === 'sandbox') errors = validateSandboxConfig(editingConfig as SandboxConfig);
  else if (toolType === 'mcp') errors = validateMcpConfig(editingConfig as McpConfig);

  if (Object.keys(errors).length > 0) {
    setConfigErrors(errors);
    return;
  }

  setSaving(true);
  setError(null);
  setConfigErrors({});

  try {
    let formData: ProjectToolFormData;
    switch (toolType) {
      case 'http':
        formData = httpConfigToToolForm(
          currentTool.name,
          currentTool.description,
          editingConfig as HttpConfig,
          parsedForm.toolType === 'http' ? parsedForm : null,
        );
        break;
      case 'sandbox':
        formData = sandboxConfigToToolForm(
          currentTool.name,
          currentTool.description,
          editingConfig as SandboxConfig,
        );
        break;
      case 'mcp':
        formData = mcpConfigToToolForm(
          currentTool.name,
          currentTool.description,
          editingConfig as McpConfig,
          parsedForm.toolType === 'mcp' ? parsedForm : null,
        );
        break;
    }

    const newDsl = serializeToolFormToDsl(formData);
    await updateTool(projectId, toolId, {
      dslContent: newDsl,
      _v: currentTool._v,
    });
    await loadTool();
    toast.success(t('tool_saved'));
  } catch (err) {
    setError(sanitizeErrors(err, 'Failed to save'));
  } finally {
    setSaving(false);
  }
};

const handleConfigDiscard = () => {
  if (initialConfigRef.current) {
    setEditingConfig(JSON.parse(JSON.stringify(initialConfigRef.current)));
    setConfigErrors({});
  }
};
```

**Step 5: Replace configuration tab JSX**

Replace the configuration tab content (the `activeSection === 'configuration'` blocks) with:

```tsx
{
  activeSection === 'configuration' && editingConfig && (
    <div className="space-y-6">
      {/* Section title */}
      <h3 className="text-sm font-semibold text-foreground">{t('configuration_title')}</h3>

      {/* Type-specific config form — always editable */}
      {currentTool.toolType === 'http' && (
        <HttpConfigForm
          config={editingConfig as HttpConfig}
          onChange={(config) => setEditingConfig(config)}
          showTemplates={false}
        />
      )}
      {currentTool.toolType === 'sandbox' && (
        <SandboxConfigForm
          config={editingConfig as SandboxConfig}
          onChange={(config) => setEditingConfig(config)}
          showTemplates={false}
        />
      )}
      {currentTool.toolType === 'mcp' && (
        <McpConfigForm
          config={editingConfig as McpConfig}
          onChange={(config) => setEditingConfig(config)}
        />
      )}

      {/* Collapsible DSL preview */}
      <details className="group">
        <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">&#9654;</span>
          {t('view_raw_dsl')}
        </summary>
        <pre className="mt-2 p-3 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
          {dslContent}
        </pre>
      </details>

      {/* Save bar — appears when config is dirty */}
      <SaveBar
        isDirty={isDirty}
        isSaving={saving}
        validationErrors={configErrors}
        onSave={handleConfigSave}
        onDiscard={handleConfigDiscard}
      />
    </div>
  );
}

{
  activeSection === 'configuration' && !editingConfig && (
    <div className="text-sm text-muted text-center py-8">
      {t('parse_failed_fallback')}
      <pre className="mt-4 p-4 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap text-left">
        {dslContent}
      </pre>
    </div>
  );
}
```

**Step 6: Remove the EditWizardInline function**

Delete the entire `EditWizardInline` function (lines ~652–758) from the bottom of the file.

**Step 7: Remove the delete button AnimatePresence guard on configMode**

The delete button currently only shows when `configMode === 'view'`. Since there's no more view/edit toggle, always show it when on the configuration tab:

Change:

```tsx
{activeSection === 'configuration' && configMode === 'view' && (
```

To:

```tsx
{activeSection === 'configuration' && (
```

**Step 8: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 9: Commit**

```bash
git add apps/studio/src/components/tools/ToolDetailPage.tsx
git commit -m "feat(studio): replace tool edit wizard with inline-editable config forms"
```

---

### Task 5: Verify SandboxConfigForm and McpConfigForm Export Validation Functions

**Files:**

- Check: `apps/studio/src/components/tools/SandboxConfigForm.tsx`
- Check: `apps/studio/src/components/tools/McpConfigForm.tsx`

**Step 1: Check that `validateSandboxConfig` and `validateMcpConfig` are exported**

Look for `export function validateSandboxConfig` in SandboxConfigForm.tsx and `export function validateMcpConfig` in McpConfigForm.tsx. If they don't exist, create them following the same pattern as `validateHttpConfig`.

For `McpConfigForm`, it has a local `validateUrl` but may not export a full `validateMcpConfig`. If missing, add:

```typescript
export function validateMcpConfig(config: McpConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  const urlErr = validateUrl(config.serverUrl || '', 'Server URL');
  if (urlErr) errors.serverUrl = urlErr;
  return errors;
}
```

For `SandboxConfigForm`, check if `validateSandboxConfig` is already exported. If not, add:

```typescript
export function validateSandboxConfig(config: SandboxConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!config.codeContent?.trim()) errors.codeContent = 'Code is required';
  if (!config.runtime) errors.runtime = 'Runtime is required';
  return errors;
}
```

**Step 2: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -20`

**Step 3: Commit (if changes were needed)**

```bash
git add apps/studio/src/components/tools/SandboxConfigForm.tsx apps/studio/src/components/tools/McpConfigForm.tsx
git commit -m "feat(studio): export validation functions from Sandbox and MCP config forms"
```

---

### Task 6: Verify End-to-End Flow and Fix Compilation Issues

**Step 1: Run full type check**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -50`

Fix any remaining type errors.

**Step 2: Run existing tests**

Run: `cd apps/studio && pnpm test -- --run 2>&1 | tail -30`

Fix any failing tests.

**Step 3: Build Studio**

Run: `pnpm build --filter studio 2>&1 | tail -30`

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix(studio): resolve compilation issues from inline edit refactor"
```

---

### Task 7: Remove Dead Code

**Files:**

- Check: `apps/studio/src/components/tools/sections/ToolConfigView.tsx` — still imported anywhere?
- Check: `apps/studio/src/components/tools/sections/ToolMetadataSection.tsx` — still imported?

**Step 1: Check if ToolConfigView is still imported elsewhere**

Run: `grep -r "ToolConfigView" apps/studio/src/ --include="*.tsx" --include="*.ts"`

If only imported in ToolDetailPage (which we removed), the component file can stay (it's not dead code if it's a reusable component) but remove the import from ToolDetailPage if still there.

**Step 2: Clean up unused imports in ToolDetailPage**

Remove any imports that are no longer used after the refactor (e.g., `ToolConfigView` import, wizard imports).

**Step 3: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -20`

**Step 4: Commit**

```bash
git add apps/studio/src/components/tools/ToolDetailPage.tsx
git commit -m "chore(studio): remove unused wizard imports from ToolDetailPage"
```
