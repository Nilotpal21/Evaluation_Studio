# Workflow Trigger Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire API key creation into webhook trigger flow and add Async Push tab to CodeSnippets.

**Architecture:** Purely UI wiring — connect existing `WebhookKeyCreationModal` and `WebhookQuickStart` components, extend `CodeSnippets` with a 4th tab, add callback URL fields to trigger creation form. No backend changes.

**Tech Stack:** React 19, Next.js, next-intl, SWR, Tailwind CSS, Lucide icons

---

## File Map

| File                                                                  | Action | Responsibility                                                                           |
| --------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `packages/i18n/locales/en/studio.json`                                | Modify | Add 8 i18n keys under `workflows.triggers`                                               |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`      | Modify | Add `async_push` tab, accept `fullApiKey`/`callbackUrl`/`callbackAccessToken` props      |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` | Modify | Add "Generate API Key" button, forward new props to CodeSnippets                         |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`   | Modify | Wire key modal auto-open, pass API key state to TriggerCard, add callback fields to form |

---

### Task 1: Add i18n Keys

**Files:**

- Modify: `packages/i18n/locales/en/studio.json:8817` (after `key_created_name`)

- [ ] **Step 1: Add the 8 new translation keys**

In `packages/i18n/locales/en/studio.json`, inside the `workflows.triggers` object, add these keys after the existing `"key_created_name": "Webhook: {name}"` line (line 8817):

```json
      "key_created_name": "Webhook: {name}",
      "generate_api_key": "Generate API Key",
      "api_key_required": "An API key is required to call this webhook",
      "async_push_mode": "Async Push",
      "callback_url": "Callback URL",
      "callback_access_token": "Access Token",
      "callback_url_placeholder": "https://your-server.com/callback",
      "callback_config_title": "Async Push Config (Optional)",
      "callback_configured": "Callback",
      "replace_api_key": "Replace with your API key"
```

Note: `key_created_name` is the last key before the closing `}` of the `triggers` block. Change the line ending from `}` to `,` on `key_created_name` and add the new keys before the closing `}`.

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/i18n/locales/en/studio.json','utf8')); console.log('Valid JSON')"`

Expected: `Valid JSON`

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/i18n/locales/en/studio.json
git add packages/i18n/locales/en/studio.json
git commit -m "[ABLP-2] feat(i18n): add trigger gaps translation keys"
```

---

### Task 2: Extend CodeSnippets with Async Push Tab and fullApiKey Prop

**Files:**

- Modify: `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`

- [ ] **Step 1: Update the props interface**

Replace the existing `CodeSnippetsProps` interface (lines 20-24):

```tsx
interface CodeSnippetsProps {
  workflowId: string;
  apiKeyPrefix: string;
  baseUrl: string;
  fullApiKey?: string;
  callbackUrl?: string;
  callbackAccessToken?: string;
}
```

- [ ] **Step 2: Add `async_push` to `SnippetMode` and update `buildCurl`**

Replace the `SnippetMode` type and `buildCurl` function (lines 30-71):

```tsx
type SnippetMode = 'sync' | 'async' | 'async_poll' | 'async_push';

function buildCurl(
  baseUrl: string,
  workflowId: string,
  authKey: string,
  mode: SnippetMode,
  callbackUrl?: string,
  callbackAccessToken?: string,
): string {
  const encodedId = encodeURIComponent(workflowId);
  const base = `${baseUrl}/api/v1/workflows/${encodedId}/execute`;

  if (mode === 'sync') {
    return [
      `curl -X POST '${base}' \\`,
      `  -H 'Authorization: Bearer ${authKey}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"input": {}}'`,
    ].join('\n');
  }

  if (mode === 'async') {
    return [
      `curl -X POST '${base}?mode=async' \\`,
      `  -H 'Authorization: Bearer ${authKey}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"input": {}}'`,
    ].join('\n');
  }

  if (mode === 'async_push') {
    const cbUrl = callbackUrl || 'https://your-server.com/callback';
    const cbToken = callbackAccessToken || 'your-access-token';
    return [
      `curl -X POST '${base}?mode=async_push' \\`,
      `  -H 'Authorization: Bearer ${authKey}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"input": {}, "callbackUrl": "${cbUrl}", "accessToken": "${cbToken}"}'`,
    ].join('\n');
  }

  // async_poll
  return [
    `# 1. Start async execution`,
    `curl -X POST '${base}?mode=async' \\`,
    `  -H 'Authorization: Bearer ${authKey}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"input": {}}'`,
    ``,
    `# 2. Poll for result (use executionId from step 1)`,
    `curl '${baseUrl}/api/v1/workflows/${encodedId}/executions/{executionId}' \\`,
    `  -H 'Authorization: Bearer ${authKey}'`,
  ].join('\n');
}
```

- [ ] **Step 3: Update the component to use new props**

Replace the component function (lines 77-161):

```tsx
export function CodeSnippets({
  workflowId,
  apiKeyPrefix,
  baseUrl,
  fullApiKey,
  callbackUrl,
  callbackAccessToken,
}: CodeSnippetsProps) {
  const t = useTranslations('workflows.triggers');
  const [activeTab, setActiveTab] = useState<SnippetMode>('sync');
  const [copied, setCopied] = useState(false);

  const authKey = fullApiKey ? fullApiKey : apiKeyPrefix ? `${apiKeyPrefix}****...` : 'abl_****...';

  const needsKeyNote = !fullApiKey;

  const tabs: { value: SnippetMode; label: string }[] = useMemo(
    () => [
      { value: 'sync', label: t('sync_mode') },
      { value: 'async', label: t('async_mode') },
      { value: 'async_poll', label: t('async_poll_mode') },
      { value: 'async_push', label: t('async_push_mode') },
    ],
    [t],
  );

  const snippet = useMemo(
    () => buildCurl(baseUrl, workflowId, authKey, activeTab, callbackUrl, callbackAccessToken),
    [baseUrl, workflowId, authKey, activeTab, callbackUrl, callbackAccessToken],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }, [snippet]);

  return (
    <div className="space-y-2">
      {/* Replace API key note */}
      {needsKeyNote && <p className="text-xs text-warning">{t('replace_api_key')}</p>}

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-default">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => {
              setActiveTab(tab.value);
              setCopied(false);
            }}
            className={clsx(
              'px-3 py-1.5 text-xs font-medium transition-default border-b-2 -mb-px',
              activeTab === tab.value
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Code block */}
      <div className="relative">
        <pre
          className={clsx(
            'text-xs font-mono p-3 rounded-lg overflow-x-auto',
            'bg-background-muted text-foreground border border-default',
            'leading-relaxed whitespace-pre-wrap break-all',
          )}
        >
          {snippet}
        </pre>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className={clsx(
            'absolute top-2 right-2 p-1.5 rounded-md transition-fast',
            'bg-background-elevated/80 hover:bg-background-elevated',
            'text-muted hover:text-foreground border border-default',
          )}
          aria-label={t('copy_curl')}
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/components/workflows/triggers/CodeSnippets.tsx
git add apps/studio/src/components/workflows/triggers/CodeSnippets.tsx
git commit -m "[ABLP-2] feat(studio): add async push tab and fullApiKey to CodeSnippets"
```

---

### Task 3: Update WebhookQuickStart with "Generate API Key" Button

**Files:**

- Modify: `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`

- [ ] **Step 1: Add Key icon import**

Add `Key` to the lucide-react import (line 13):

```tsx
import { Copy, Check, ExternalLink, Key } from 'lucide-react';
```

- [ ] **Step 2: Add Button import**

Add after the Badge import (line 15):

```tsx
import { Button } from '../../ui/Button';
```

- [ ] **Step 3: Update the props interface**

Replace `WebhookQuickStartProps` (lines 22-31):

```tsx
interface WebhookQuickStartProps {
  workflow: { id: string; name: string };
  trigger: { id: string; config: Record<string, unknown> };
  apiKey?: {
    id: string;
    keyPrefix: string;
    isActive: boolean;
    expiresAt: string | null;
  };
  rawApiKey?: string;
  onRequestKey?: () => void;
}
```

- [ ] **Step 4: Update the component to wire new props**

Replace the component function (lines 37-120):

```tsx
export function WebhookQuickStart({
  workflow,
  trigger,
  apiKey,
  rawApiKey,
  onRequestKey,
}: WebhookQuickStartProps) {
  const t = useTranslations('workflows.triggers');
  const [copied, setCopied] = useState(false);

  const endpointUrl =
    (trigger.config.url as string | undefined) ??
    `${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/workflows/${encodeURIComponent(workflow.id)}/execute`;

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }, [endpointUrl]);

  const keyStatusVariant = apiKey?.isActive ? 'success' : 'warning';
  const keyStatusLabel = apiKey ? (apiKey.isActive ? t('key_active') : t('key_expired')) : null;

  const callbackUrl = trigger.config.callbackUrl as string | undefined;
  const callbackAccessToken = trigger.config.callbackAccessToken as string | undefined;

  return (
    <div className="space-y-4">
      {/* Section header */}
      <h3 className="text-sm font-semibold text-foreground">{t('webhook_quick_start')}</h3>

      {/* Endpoint URL */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">{t('endpoint_url')}</label>
        <div className="flex items-center gap-2">
          <code
            className={clsx(
              'flex-1 text-xs font-mono px-3 py-2 rounded-lg truncate',
              'bg-background-muted text-foreground border border-default',
            )}
          >
            {endpointUrl}
          </code>
          <button
            onClick={handleCopyUrl}
            className={clsx(
              'p-1.5 rounded-md transition-fast shrink-0',
              'hover:bg-background-muted text-muted hover:text-foreground',
            )}
            aria-label={t('copy_curl')}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* API Key status — show badge when key exists, show generate button when absent */}
      {apiKey ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">{t('api_key_status')}</span>
            <Badge variant={keyStatusVariant}>{keyStatusLabel}</Badge>
            <code className="text-xs font-mono text-muted">{apiKey.keyPrefix}...</code>
          </div>
          <button
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            aria-label={t('manage_api_keys')}
          >
            {t('manage_api_keys')}
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-warning">{t('api_key_required')}</p>
          {onRequestKey && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Key className="w-3.5 h-3.5" />}
              onClick={onRequestKey}
            >
              {t('generate_api_key')}
            </Button>
          )}
        </div>
      )}

      {/* Code snippets */}
      <CodeSnippets
        workflowId={workflow.id}
        apiKeyPrefix={apiKey?.keyPrefix ?? ''}
        baseUrl={baseUrl}
        fullApiKey={rawApiKey}
        callbackUrl={callbackUrl}
        callbackAccessToken={callbackAccessToken}
      />
    </div>
  );
}
```

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx
git add apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx
git commit -m "[ABLP-2] feat(studio): add generate API key button and callback forwarding to WebhookQuickStart"
```

---

### Task 4: Wire API Key Modal and Callback Fields in WorkflowTriggersTab

**Files:**

- Modify: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`

This is the largest task — it touches `TriggerCreationForm`, `TriggerCard`, and `WorkflowTriggersTab`.

- [ ] **Step 1: Add `Key` and `ChevronDown` icons to imports**

Add `Key` and `ChevronDown` to the lucide-react import (line 17-30):

```tsx
import {
  Plus,
  Webhook,
  Clock,
  Zap,
  Radio,
  Copy,
  Check,
  ToggleLeft,
  ToggleRight,
  Loader2,
  X,
  Plug,
  Key,
  ChevronDown,
} from 'lucide-react';
```

- [ ] **Step 2: Add `onWebhookCreated` to TriggerCreationForm**

Replace the `TriggerFormProps` interface (lines 173-178):

```tsx
interface TriggerFormProps {
  projectId: string;
  workflowId: string;
  onCreated: () => void;
  onWebhookCreated?: () => void;
  onCancel: () => void;
}
```

Update the component destructuring (line 180):

```tsx
function TriggerCreationForm({ projectId, workflowId, onCreated, onWebhookCreated, onCancel }: TriggerFormProps) {
```

- [ ] **Step 3: Add callback URL state to TriggerCreationForm**

After the existing state declarations (after line 193), add:

```tsx
const [callbackUrl, setCallbackUrl] = useState('');
const [callbackAccessToken, setCallbackAccessToken] = useState('');
const [showCallbackConfig, setShowCallbackConfig] = useState(false);
```

- [ ] **Step 4: Add callback fields to webhook config in handleSave**

In `handleSave`, after the existing `config` building and before the `try` block (around line 250-251), add a webhook config section. Replace the empty block between the `connector` else-if and the `try`:

Find this code (lines 250-252):

```tsx
    }

    try {
```

Replace with:

```tsx
    } else if (type === 'webhook') {
      if (callbackUrl.trim()) {
        try {
          new URL(callbackUrl.trim());
        } catch {
          setError('Callback URL must be a valid URL (https://... or http://...)');
          setSaving(false);
          return;
        }
        config.callbackUrl = callbackUrl.trim();
        if (callbackAccessToken.trim()) {
          config.callbackAccessToken = callbackAccessToken.trim();
        }
      }
    }

    try {
```

- [ ] **Step 5: Call `onWebhookCreated` after successful webhook creation**

In `handleSave`, replace the line `onCreated();` (line 260) with:

```tsx
onCreated();
if (type === 'webhook') {
  onWebhookCreated?.();
}
```

- [ ] **Step 6: Add `callbackUrl`, `callbackAccessToken`, and `onWebhookCreated` to handleSave deps**

Update the dependency array of `handleSave` (lines 266-277) to include the new state variables:

```tsx
  }, [
    type,
    presetConfig,
    pollingInterval,
    eventName,
    connectorName,
    triggerName,
    connectionId,
    callbackUrl,
    callbackAccessToken,
    projectId,
    workflowId,
    onCreated,
    onWebhookCreated,
  ]);
```

- [ ] **Step 7: Add callback config UI to the webhook section of the form**

Replace the webhook hint text (lines 421-425):

```tsx
{
  type === 'webhook' && (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        A webhook URL will be generated automatically after creation.
      </p>

      {/* Collapsible async push config */}
      <button
        type="button"
        onClick={() => setShowCallbackConfig((v) => !v)}
        className={clsx(
          'flex items-center gap-1.5 text-xs font-medium transition-default',
          showCallbackConfig ? 'text-accent' : 'text-muted hover:text-foreground',
        )}
      >
        <ChevronDown
          className={clsx('w-3.5 h-3.5 transition-transform', showCallbackConfig && 'rotate-180')}
        />
        Async Push Config (Optional)
      </button>

      {showCallbackConfig && (
        <div className="space-y-3 pl-5 border-l-2 border-accent/20">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">Callback URL</label>
            <input
              type="url"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="https://your-server.com/callback"
              aria-label="Callback URL"
              className={clsx(
                'w-full px-3 py-2 text-sm rounded-lg border border-default',
                'bg-background-muted text-foreground placeholder:text-muted',
                'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
              )}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">Access Token</label>
            <input
              type="password"
              value={callbackAccessToken}
              onChange={(e) => setCallbackAccessToken(e.target.value)}
              placeholder="Optional"
              aria-label="Callback access token"
              className={clsx(
                'w-full px-3 py-2 text-sm rounded-lg border border-default',
                'bg-background-muted text-foreground placeholder:text-muted',
                'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Update TriggerCard props to accept apiKey, rawApiKey, onRequestKey**

Replace the `TriggerCardProps` interface (lines 447-451):

```tsx
interface TriggerCardProps {
  trigger: WorkflowTrigger;
  projectId: string;
  onToggled: () => void;
  apiKey?: {
    id: string;
    keyPrefix: string;
    isActive: boolean;
    expiresAt: string | null;
  } | null;
  rawApiKey?: string;
  onRequestKey?: () => void;
}
```

Update the component destructuring (line 453):

```tsx
function TriggerCard({ trigger, projectId, onToggled, apiKey, rawApiKey, onRequestKey }: TriggerCardProps) {
```

- [ ] **Step 9: Add callback URL display to TriggerCard**

After the Polling trigger section (line 588), add:

```tsx
{
  /* Callback URL for async push */
}
{
  trigger.type === 'webhook' && Boolean(trigger.config.callbackUrl) && (
    <p className="mt-1 text-xs text-muted">
      Callback: <code className="font-mono">{String(trigger.config.callbackUrl)}</code>
    </p>
  );
}
```

- [ ] **Step 10: Pass new props to WebhookQuickStart in TriggerCard**

Replace the WebhookQuickStart rendering (lines 613-620):

```tsx
{
  /* Webhook quick-start panel */
}
{
  trigger.type === 'webhook' && (
    <div className="mt-4 border-t border-default pt-4">
      <WebhookQuickStart
        workflow={{ id: (trigger.config.workflowId as string) ?? '', name: '' }}
        trigger={{ id: trigger.id, config: trigger.config }}
        apiKey={apiKey ?? undefined}
        rawApiKey={rawApiKey}
        onRequestKey={onRequestKey}
      />
    </div>
  );
}
```

- [ ] **Step 11: Wire everything in the parent WorkflowTriggersTab**

Add a `handleWebhookCreated` callback after the existing `handleCancelForm` (after line 670):

```tsx
const handleWebhookCreated = useCallback(() => {
  setShowKeyModal(true);
}, []);

const handleRequestKey = useCallback(() => {
  setShowKeyModal(true);
}, []);
```

Compute the transformed API key shape (add after `handleRequestKey`, before the `if (triggers.length === 0` check):

```tsx
// Transform createdApiKey into the shape WebhookQuickStart expects
const transformedApiKey = createdApiKey
  ? {
      id: createdApiKey.id,
      keyPrefix: createdApiKey.rawKey.slice(0, 8),
      isActive: true as const,
      expiresAt: null,
    }
  : null;
```

- [ ] **Step 12: Pass `onWebhookCreated` to TriggerCreationForm (both render sites)**

In the empty-state branch (line 691-696), update:

```tsx
<TriggerCreationForm
  projectId={projectId}
  workflowId={workflow.id}
  onCreated={handleCreated}
  onWebhookCreated={handleWebhookCreated}
  onCancel={handleCancelForm}
/>
```

In the non-empty branch (lines 740-745), update:

```tsx
<TriggerCreationForm
  projectId={projectId}
  workflowId={workflow.id}
  onCreated={handleCreated}
  onWebhookCreated={handleWebhookCreated}
  onCancel={handleCancelForm}
/>
```

- [ ] **Step 13: Pass apiKey, rawApiKey, onRequestKey to TriggerCard (both render sites)**

In the trigger list (lines 750-757), update:

```tsx
{
  triggers.map((trigger) => (
    <TriggerCard
      key={trigger.id}
      trigger={trigger}
      projectId={projectId ?? ''}
      onToggled={handleToggled}
      apiKey={transformedApiKey}
      rawApiKey={createdApiKey?.rawKey}
      onRequestKey={handleRequestKey}
    />
  ));
}
```

- [ ] **Step 14: Format and commit**

```bash
npx prettier --write apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx
git add apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx
git commit -m "[ABLP-2] feat(studio): wire API key modal and async push callback fields in WorkflowTriggersTab"
```

---

### Task 5: Build Verification

- [ ] **Step 1: Run the Studio build to catch type errors**

```bash
pnpm build --filter=@agent-platform/studio
```

Expected: Build succeeds with no type errors.

- [ ] **Step 2: Fix any type errors found**

If the build fails, read the error messages and fix the issues in the relevant files. The most likely issues are:

- Missing import for `Key` or `ChevronDown`
- Unused variable `_workflowId` in WebhookQuickStart (was there to suppress lint — may need to keep or remove)
- Type mismatches in prop threading

- [ ] **Step 3: Format all changed files and commit fixes**

```bash
npx prettier --write apps/studio/src/components/workflows/triggers/CodeSnippets.tsx apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx
git add -u
git commit -m "[ABLP-2] fix(studio): resolve build errors from trigger gaps implementation"
```
