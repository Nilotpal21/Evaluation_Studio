# Codetool Sandbox Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix JS sandbox escape vulnerability and add per-tenant admin toggle for code tools (disabled by default).

**Architecture:** Three independent workstreams: (1) JS sandbox hardening in `services/codetool-sandbox/runtime_js/utils.js`, (2) OCI/container hardening in config files, (3) tenant feature gate across data model, admin API/UI, Studio UI/API, and runtime execution. Workstreams 1-2 are independent of 3.

**Tech Stack:** Node.js (sandbox runtime), TypeScript (platform), React/Next.js (Studio/Admin), MongoDB (tenant settings), Redis (config cache), gVisor OCI spec

**IMPORTANT for all agents:** Run `npx prettier --write <files>` on ALL changed files before finishing your task. lint-staged WILL silently revert your work if files aren't formatted. BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.

---

### Task 1: Add `codeToolsEnabled` to TenantFeatures Type

**Files:**

- Modify: `packages/config/src/tenant-config-types.ts:31-42`

- [ ] **Step 1: Add `codeToolsEnabled` to `TenantFeatures` interface**

In `packages/config/src/tenant-config-types.ts`, add the field to the `TenantFeatures` interface at line 42 (before the closing brace):

```typescript
export interface TenantFeatures {
  customModels: boolean;
  ssoEnabled: boolean;
  mfaEnabled: boolean;
  auditLogExport: boolean;
  dataResidency: boolean;
  customDomains: boolean;
  prioritySupport: boolean;
  advancedAnalytics: boolean;
  advancedNlu: boolean;
  archiveEnabled: boolean;
  codeToolsEnabled: boolean;
}
```

- [ ] **Step 2: Add `codeToolsEnabled: false` to all plan defaults in tenant-config.ts**

In `apps/runtime/src/services/tenant-config.ts`, add `codeToolsEnabled: false` to every plan in the `PLAN_FEATURES` record (lines 128-177). Add it as the last field in each plan object:

```typescript
// In FREE (line 139, before closing brace):
    archiveEnabled: false,
    codeToolsEnabled: false,

// In TEAM (line 151, before closing brace):
    archiveEnabled: false,
    codeToolsEnabled: false,

// In BUSINESS (line 163, before closing brace):
    archiveEnabled: true,
    codeToolsEnabled: false,

// In ENTERPRISE (line 175, before closing brace):
    archiveEnabled: true,
    codeToolsEnabled: false,
```

- [ ] **Step 3: Overlay `codeToolsEnabled` from tenant settings in `loadFromDB()`**

In `apps/runtime/src/services/tenant-config.ts`, after the `maxConcurrentSessions` overlay (line 515), add:

```typescript
// Overlay tenant code tools feature flag (admin toggle — fail-closed: absent = false)
const codeToolsEnabled = tenant?.settings?.codeToolsEnabled;
if (typeof codeToolsEnabled === 'boolean') {
  config.features.codeToolsEnabled = codeToolsEnabled;
}
```

- [ ] **Step 4: Add `codeToolsEnabled` to `ITenantSettings` interface**

In `packages/database/src/models/tenant.model.ts`, add to the `ITenantSettings` interface (line 41, before the index signature):

```typescript
export interface ITenantSettings {
  // Common settings fields (add more as discovered)
  defaultLLMProvider?: string;
  maxConcurrentSessions?: number;
  enableAuditLogging?: boolean;
  enableClickHouse?: boolean;
  allowedDomains?: string[];
  webhookUrl?: string | null;
  codeToolsEnabled?: boolean;
  // Index signature for gradual migration and extensibility
  [key: string]: unknown;
}
```

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/config/src/tenant-config-types.ts apps/runtime/src/services/tenant-config.ts packages/database/src/models/tenant.model.ts
git add packages/config/src/tenant-config-types.ts apps/runtime/src/services/tenant-config.ts packages/database/src/models/tenant.model.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(config): add codeToolsEnabled to TenantFeatures

Add codeToolsEnabled boolean to TenantFeatures type, defaulting to
false across all plan tiers. Overlays from tenant.settings in DB.
EOF
)"
```

---

### Task 2: Admin API — PATCH Tenant Settings Endpoint

**Files:**

- Modify: `apps/runtime/src/routes/platform-admin-tenants.ts`

- [ ] **Step 1: Read the existing route file to find the last route handler**

Read `apps/runtime/src/routes/platform-admin-tenants.ts` to identify imports and the location to add the new route (after the last existing handler, around line 826).

- [ ] **Step 2: Add PATCH /:tenantId/features endpoint**

Add the following route handler at the end of the route file (before the final `export`). First read the file to verify exact import patterns and `requirePlatformAdmin` usage.

```typescript
// ─── PATCH /:tenantId/features — Toggle tenant feature flags ────────────────

const PatchFeaturesSchema = z.object({
  codeToolsEnabled: z.boolean().optional(),
});

router.patch('/:tenantId/features', async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const parse = PatchFeaturesSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parse.error.message },
    });
    return;
  }

  const updates = parse.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'No feature flags provided' },
    });
    return;
  }

  try {
    const { Tenant } = await import('@agent-platform/database/models');

    // Build $set operations for settings subfields
    const setOps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setOps[`settings.${key}`] = value;
      }
    }

    const tenant = await Tenant.findOneAndUpdate({ _id: tenantId }, { $set: setOps }, { new: true })
      .lean()
      .exec();

    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    // Invalidate Redis config cache
    try {
      const { getTenantConfigService } = await import('../services/tenant-config.js');
      const configService = getTenantConfigService();
      await configService.invalidateCache(tenantId);
    } catch (cacheErr) {
      log.warn('Failed to invalidate tenant config cache', {
        tenantId,
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    log.info('Tenant feature flags updated', { tenantId, updates });

    res.json({
      success: true,
      data: { tenantId, settings: tenant.settings },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to update tenant features', { tenantId, error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update tenant features' },
    });
  }
});
```

Ensure `z` (zod) is imported at the top of the file. Read the imports to verify.

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/runtime/src/routes/platform-admin-tenants.ts
git add apps/runtime/src/routes/platform-admin-tenants.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(admin): add PATCH /:tenantId/features endpoint

Admin API to toggle per-tenant feature flags like codeToolsEnabled.
Invalidates Redis config cache on update. Protected by platform-admin
auth.
EOF
)"
```

---

### Task 3: Admin UI — Feature Toggle on Tenant Detail Page

**Files:**

- Modify: `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx`
- Modify: `apps/admin/src/app/api/tenants/[id]/route.ts` (if proxy endpoint needed)

- [ ] **Step 1: Read the admin tenant detail page**

Read `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx` fully to understand the `OverviewTab` component structure, the `useApi` hook, `ConfirmDialog` usage, and how status/plan changes work.

- [ ] **Step 2: Add a Feature Toggles section to OverviewTab**

After the Status Action Buttons section (around line 276), add a "Feature Toggles" card. Read the `TenantDetailResponse` type to verify the shape of `tenant.settings`.

```tsx
{
  /* Feature Toggles */
}
<div className="rounded-lg border border-border bg-background-subtle p-5">
  <h3 className="text-sm font-medium text-foreground-muted mb-4">Feature Toggles</h3>
  <div className="space-y-3">
    <FeatureToggle
      tenantId={tenantId}
      featureKey="codeToolsEnabled"
      label="Code Tools"
      description="Enable JavaScript/Python sandbox code execution"
      enabled={tenant?.settings?.codeToolsEnabled === true}
      onToggled={refetch}
    />
  </div>
</div>;
```

- [ ] **Step 3: Create FeatureToggle inline component**

Add a `FeatureToggle` component above `OverviewTab` in the same file:

```tsx
function FeatureToggle({
  tenantId,
  featureKey,
  label,
  description,
  enabled,
  onToggled,
}: {
  tenantId: string;
  featureKey: string;
  label: string;
  description: string;
  enabled: boolean;
  onToggled: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/features`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [featureKey]: !enabled }),
      });
      if (res.ok) {
        onToggled();
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message || `Failed to update (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-foreground-muted">{description}</div>
          {error && <div className="text-xs text-error mt-1">{error}</div>}
        </div>
        <button
          onClick={() => setShowConfirm(true)}
          disabled={updating}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-success' : 'bg-foreground-muted/30'
          } ${updating ? 'opacity-50' : ''}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <ConfirmDialog
        open={showConfirm}
        onOpenChange={(open) => {
          if (!open) setShowConfirm(false);
        }}
        title={`${enabled ? 'Disable' : 'Enable'} ${label}`}
        description={`Are you sure you want to ${enabled ? 'disable' : 'enable'} ${label} for this tenant? ${enabled ? 'Existing code tools will stop executing.' : 'This will allow code tool creation and execution.'}`}
        confirmLabel={enabled ? 'Disable' : 'Enable'}
        variant={enabled ? 'destructive' : 'default'}
        onConfirm={handleToggle}
        loading={updating}
        loadingLabel="Updating..."
      />
    </>
  );
}
```

- [ ] **Step 4: Add admin API proxy route for tenant features**

Read `apps/admin/src/app/api/tenants/[id]/route.ts` to see how it proxies to the runtime. Create or modify the proxy to forward `PATCH /api/tenants/:id/features` to the runtime's `platform-admin-tenants` endpoint.

If the admin uses a generic proxy pattern, add a new route file at `apps/admin/src/app/api/tenants/[id]/features/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, isAuthError } from '@/lib/auth';
import { runtimeFetch } from '@/lib/runtime-proxy';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('api:tenants:features');

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(request);
  if (isAuthError(auth)) return auth;

  const { id: tenantId } = await params;
  const body = await request.json();

  try {
    const res = await runtimeFetch(`/api/platform-admin/tenants/${tenantId}/features`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    log.error('Failed to proxy tenant features update', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { success: false, error: { code: 'PROXY_ERROR', message: 'Failed to update features' } },
      { status: 502 },
    );
  }
}
```

Read `apps/admin/src/lib/runtime-proxy.ts` (or equivalent) to verify the `runtimeFetch` function signature. If it doesn't exist, check how other admin API routes proxy to the runtime.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/admin/src/app/\(dashboard\)/tenants/\[id\]/page.tsx apps/admin/src/app/api/tenants/\[id\]/features/route.ts
git add apps/admin/src/app/\(dashboard\)/tenants/\[id\]/page.tsx apps/admin/src/app/api/tenants/\[id\]/features/route.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(admin): add code tools feature toggle on tenant detail page

Adds a Feature Toggles section to the admin tenant overview with a
toggle for codeToolsEnabled. Includes confirmation dialog and proxies
to runtime PATCH endpoint.
EOF
)"
```

---

### Task 4: Studio Features API — Expose `codeToolsEnabled`

**Files:**

- Modify: `apps/studio/src/app/api/features/route.ts:40`
- Modify: `apps/studio/src/hooks/use-features.ts`

- [ ] **Step 1: Add `code_tools` to FEATURE_KEYS in the features route**

In `apps/studio/src/app/api/features/route.ts`, update line 40:

```typescript
const FEATURE_KEYS = ['reusable_modules', 'code_tools'] as const;
```

Then update the feature resolution to also check `tenant.settings.codeToolsEnabled` from the DB. After the plan-features resolution loop (line 101), add:

```typescript
// Resolve code_tools from tenant settings (DB-driven, not plan-based)
try {
  const { Tenant } = await import('@agent-platform/database/models');
  const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
  features['code_tools'] = tenant?.settings?.codeToolsEnabled === true;
} catch {
  // Fail closed — code_tools stays false from buildDefaults()
}
```

- [ ] **Step 2: Update the Studio `use-features.ts` hook**

In `apps/studio/src/hooks/use-features.ts`:

```typescript
interface FeatureFlags {
  reusable_modules: boolean;
  code_tools: boolean;
}

interface UseFeatures {
  hasModules: boolean;
  hasCodeTools: boolean;
  isLoading: boolean;
}

const FALLBACK: FeatureFlags = { reusable_modules: false, code_tools: false };

// ... fetcher stays the same ...

export function useFeatures(): UseFeatures {
  const { data, isLoading } = useSWR<FeatureFlags>('/api/features', fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    fallbackData: FALLBACK,
    onErrorRetry: (_error, _key, _config, revalidate, { retryCount }) => {
      if (retryCount >= 3) return;
      setTimeout(() => revalidate({ retryCount }), 5_000);
    },
  });

  return {
    hasModules: data?.reusable_modules ?? false,
    hasCodeTools: data?.code_tools ?? false,
    isLoading,
  };
}
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/features/route.ts apps/studio/src/hooks/use-features.ts
git add apps/studio/src/app/api/features/route.ts apps/studio/src/hooks/use-features.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): expose codeToolsEnabled via features API and hook

Add code_tools to Studio features route (resolved from tenant settings
DB field, not plan tier). Extend useFeatures hook with hasCodeTools.
EOF
)"
```

---

### Task 5: Studio UI — Gate Sandbox Tool Creation/Editing

**Files:**

- Modify: `apps/studio/src/components/tools/NewToolDropdown.tsx`
- Modify: `apps/studio/src/components/tools/ToolsListPage.tsx`
- Modify: `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx`

- [ ] **Step 1: Gate sandbox option in NewToolDropdown**

Read `apps/studio/src/components/tools/NewToolDropdown.tsx` to verify current code. Update:

```typescript
import { useFeatures } from '../../hooks/use-features';

// Inside NewToolDropdown component:
export function NewToolDropdown({ onMcpSelect }: NewToolDropdownProps) {
  const { hasCodeTools } = useFeatures();
  // ... existing state ...

  const visibleOptions = TOOL_TYPE_OPTIONS.filter(
    (opt) => opt.type !== 'sandbox' || hasCodeTools,
  );

  // In the render, replace TOOL_TYPE_OPTIONS.map with visibleOptions.map:
  // {visibleOptions.map((option) => (
```

- [ ] **Step 2: Conditionally hide sandbox tab in ToolsListPage**

Read `apps/studio/src/components/tools/ToolsListPage.tsx` to verify current code. Update the tabs memo:

```typescript
import { useFeatures } from '../../hooks/use-features';

// Inside ToolsListPage:
const { hasCodeTools } = useFeatures();

const tabs = useMemo(
  () => [
    { id: 'http', label: t('list.tab_http'), count: httpCount },
    ...(hasCodeTools ? [{ id: 'sandbox', label: t('list.tab_code'), count: sandboxCount }] : []),
    { id: 'searchai', label: t('list.tab_searchai'), count: searchaiCount },
    { id: 'mcp', label: t('list.tab_mcp'), count: servers.length },
  ],
  [httpCount, sandboxCount, searchaiCount, servers.length, t, hasCodeTools],
);
```

Also update the URL tab validation (line 101) to respect the gate:

```typescript
if (tab && ['http', 'sandbox', 'mcp', 'searchai'].includes(tab)) {
  if (tab === 'sandbox' && !hasCodeTools) return;
  setActiveTab(tab as ToolTab);
}
```

- [ ] **Step 3: Gate sandbox in ToolPickerModal**

Read `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx` to verify the `createOptions` array and `TOOL_TAB_FILTERS`. Filter out the sandbox create option when disabled:

```typescript
import { useFeatures } from '../../../hooks/use-features';

// Inside the component:
const { hasCodeTools } = useFeatures();

// Filter createOptions to exclude sandbox when disabled
const filteredCreateOptions = createOptions.filter((opt) => opt.id !== 'sandbox' || hasCodeTools);
```

Also filter `TOOL_TAB_FILTERS` to hide the sandbox tab in the picker.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/components/tools/NewToolDropdown.tsx apps/studio/src/components/tools/ToolsListPage.tsx apps/studio/src/components/abl/pickers/ToolPickerModal.tsx
git add apps/studio/src/components/tools/NewToolDropdown.tsx apps/studio/src/components/tools/ToolsListPage.tsx apps/studio/src/components/abl/pickers/ToolPickerModal.tsx
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): hide sandbox tool options when code tools disabled

Gate sandbox tool creation in NewToolDropdown, ToolsListPage tab, and
ToolPickerModal based on hasCodeTools feature flag.
EOF
)"
```

---

### Task 6: Studio API — Block Sandbox Tool CRUD When Disabled

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/tools/route.ts`
- Modify: `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`
- Modify: `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`

- [ ] **Step 1: Read the three route files to understand handler patterns**

Read all three files fully. Identify where `toolType` is checked and where to insert the feature gate.

- [ ] **Step 2: Create a shared helper for checking code tools feature**

In the POST handler of `apps/studio/src/app/api/projects/[id]/tools/route.ts`, add a helper (or inline it). Use the existing `isFeatureEnabled` from `@/lib/feature-resolver` or read `tenant.settings.codeToolsEnabled` directly:

```typescript
import { ensureDb } from '@/lib/ensure-db';

async function isCodeToolsEnabled(tenantId: string): Promise<boolean> {
  try {
    await ensureDb();
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    return tenant?.settings?.codeToolsEnabled === true;
  } catch {
    return false; // Fail closed
  }
}
```

- [ ] **Step 3: Gate POST (create) in tools/route.ts**

In the POST handler, after auth validation but before tool creation, add:

```typescript
// Gate sandbox tool creation behind tenant feature flag
if (body.toolType === 'sandbox') {
  const enabled = await isCodeToolsEnabled(user.tenantId);
  if (!enabled) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'CODE_TOOLS_DISABLED',
          message: 'Code tools are not enabled for this workspace',
        },
      },
      { status: 403 },
    );
  }
}
```

- [ ] **Step 4: Gate PUT (update) in tools/[toolId]/route.ts**

In the PUT handler, after loading the existing tool, check if it's a sandbox tool and gate it:

```typescript
// Gate sandbox tool updates behind tenant feature flag
if (existingTool.toolType === 'sandbox') {
  const enabled = await isCodeToolsEnabled(user.tenantId);
  if (!enabled) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'CODE_TOOLS_DISABLED',
          message: 'Code tools are not enabled for this workspace',
        },
      },
      { status: 403 },
    );
  }
}
```

- [ ] **Step 5: Gate POST (import) in tools/import/route.ts**

In the import handler, after parsing the tool type from the import payload:

```typescript
if (parsed.toolType === 'sandbox') {
  const enabled = await isCodeToolsEnabled(user.tenantId);
  if (!enabled) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'CODE_TOOLS_DISABLED',
          message: 'Code tools are not enabled for this workspace',
        },
      },
      { status: 403 },
    );
  }
}
```

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[id\]/tools/route.ts apps/studio/src/app/api/projects/\[id\]/tools/\[toolId\]/route.ts apps/studio/src/app/api/projects/\[id\]/tools/import/route.ts
git add apps/studio/src/app/api/projects/\[id\]/tools/route.ts apps/studio/src/app/api/projects/\[id\]/tools/\[toolId\]/route.ts apps/studio/src/app/api/projects/\[id\]/tools/import/route.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): block sandbox tool CRUD when code tools disabled

Reject sandbox tool create, update, and import with 403
CODE_TOOLS_DISABLED when tenant settings.codeToolsEnabled is false.
Fail-closed on lookup errors.
EOF
)"
```

---

### Task 7: Runtime Execution Gate — Fail-Closed Check in SandboxToolExecutor

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts:104-117`

- [ ] **Step 1: Read the SandboxToolExecutor execute method**

Read `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` to understand the full `execute()` method and the `ToolExecutionError` import.

- [ ] **Step 2: Add a `featureChecker` callback to the constructor**

The compiler package should not depend on the database. Instead, accept a callback function that checks whether code tools are enabled:

```typescript
export class SandboxToolExecutor {
  private sandboxTools: Map<string, ToolDefinition>;
  private runner: SandboxRunner;
  private sessionContext?: { sessionId?: string; tenantId?: string; userId?: string };
  private secrets?: SecretsProvider;
  /** Imperative memory API injected into all sandbox/lambda tool executions */
  memoryAPI?: ToolMemoryAPI;
  /** Optional feature gate — if provided, blocks execution when it returns false */
  private featureChecker?: () => Promise<boolean>;

  constructor(config: {
    tools: ToolDefinition[];
    runner: SandboxRunner;
    sessionContext?: { sessionId?: string; tenantId?: string; userId?: string };
    secrets?: SecretsProvider;
    featureChecker?: () => Promise<boolean>;
  }) {
    this.runner = config.runner;
    this.sessionContext = config.sessionContext;
    this.secrets = config.secrets;
    this.featureChecker = config.featureChecker;
    // ... rest stays the same
  }
```

- [ ] **Step 3: Add fail-closed check at the top of execute()**

At the start of the `execute()` method (line 108), before the tool lookup:

```typescript
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    // Fail-closed feature gate — if checker provided and returns false, block execution
    if (this.featureChecker) {
      let enabled = false;
      try {
        enabled = await this.featureChecker();
      } catch {
        // Fail closed — treat errors as disabled
        enabled = false;
      }
      if (!enabled) {
        throw new ToolExecutionError({
          code: 'TOOL_EXECUTION_ERROR',
          message: 'Code tool execution is disabled for this workspace',
          toolName,
          toolType: 'sandbox',
        });
      }
    }

    const tool = this.sandboxTools.get(toolName);
    // ... rest of execute()
```

- [ ] **Step 4: Wire the featureChecker in tool-binding-executor.ts**

Read `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` to find where `SandboxToolExecutor` is instantiated (around lines 207-215 and 257-266). Pass the `featureChecker` callback:

The `ToolBindingExecutor` already has access to `tenantId` via session context. Add a `featureChecker` factory method or accept it in the constructor config. The runtime (apps/runtime) should inject the checker when creating the executor:

```typescript
// In the runtime code that creates ToolBindingExecutor, pass:
featureChecker: async () => {
  const configService = getTenantConfigService();
  const config = await configService.getConfigAsync(tenantId);
  return config.features.codeToolsEnabled;
};
```

Read `tool-binding-executor.ts` fully to find the exact injection point. The checker should flow from runtime → ToolBindingExecutor → SandboxToolExecutor.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts
git add packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(runtime): fail-closed code tools gate in SandboxToolExecutor

Add featureChecker callback to SandboxToolExecutor that blocks
execution when codeToolsEnabled is false. Fail-closed on errors.
Wired through ToolBindingExecutor from runtime tenant config.
EOF
)"
```

---

### Task 8: JS Sandbox Hardening — Allowlist `require`

**Files:**

- Modify: `services/codetool-sandbox/runtime_js/utils.js:255-355`

- [ ] **Step 1: Read the full utils.js file**

Read `services/codetool-sandbox/runtime_js/utils.js` to understand the complete `executeJavaScriptWrapper` function, the proxy-based require wrapper for HTTP modules, and how `new Function()` is called.

- [ ] **Step 2: Create `createSafeRequire` function**

Add this function before `executeJavaScriptWrapper` in `utils.js`:

```javascript
/**
 * Create a strict allowlist-based require wrapper.
 * Blocks ALL modules not explicitly allowlisted, including node: prefixed variants.
 * Replaces the vulnerable require.cache poisoning approach.
 */
function createSafeRequire(originalRequire, proxyWrappers) {
  const ALLOWED_MODULES = new Set([
    'axios',
    'http',
    'https',
    'node-fetch',
    'buffer',
    'url',
    'querystring',
    'string_decoder',
    'events',
    'util',
    'stream',
    'zlib',
    'punycode',
    'path',
  ]);

  return function safeRequire(moduleName) {
    // Strip node: prefix — require('node:fs') should be treated as require('fs')
    const normalized =
      typeof moduleName === 'string' && moduleName.startsWith('node:')
        ? moduleName.slice(5)
        : moduleName;

    if (!ALLOWED_MODULES.has(normalized)) {
      throw new Error(
        `Module '${moduleName}' is not permitted in the sandbox. ` +
          `Allowed modules: ${[...ALLOWED_MODULES].join(', ')}`,
      );
    }

    // If proxy is configured, return proxy-wrapped versions for HTTP modules
    if (proxyWrappers) {
      if (normalized === 'axios') return proxyWrappers.axios;
      if (normalized === 'http') return proxyWrappers.http;
      if (normalized === 'https') return proxyWrappers.https;
      if (normalized === 'node-fetch') return proxyWrappers.fetch;
    }

    return originalRequire(normalized);
  };
}
```

- [ ] **Step 3: Replace require.cache poisoning with `createSafeRequire` in `executeJavaScriptWrapper`**

Replace the entire security block (lines 257-311, from `// Security: Block dangerous modules` through the `requireProxy` creation) with:

```javascript
// Security: Create strict allowlist-based require
const safeRequire = createSafeRequire(require, proxyWrappers);

// Neutralize dangerous process properties before user code runs
delete process.binding;
delete process.dlopen;
delete process._linkedBinding;
delete process.mainModule;
process.env = {};
// Freeze process to prevent re-assignment of deleted properties
Object.freeze(process);

// Block eval and Function constructor re-entry
global.eval = undefined;
const OrigFunction = Function;
Object.defineProperty(Function.prototype, 'constructor', {
  get() {
    throw new Error('Function constructor is not permitted in the sandbox');
  },
  configurable: false,
});

global.require = safeRequire;
global.Buffer = Buffer;
global.console = console;
```

- [ ] **Step 4: Update global HTTP module assignments**

Replace the existing block (lines 317-330) that assigns `global.fetch`, `global.axios`, etc.:

```javascript
// Make HTTP modules available globally (via safe require)
global.fetch = safeRequire('node-fetch');
global.axios = safeRequire('axios');
global.http = safeRequire('http');
global.https = safeRequire('https');
```

- [ ] **Step 5: Update the `new Function()` call to use `safeRequire`**

Replace the existing `new Function` call (lines 341-349):

```javascript
// Create a function wrapper for the user code to handle return statements
const userFunction = new OrigFunction(
  'require',
  'Buffer',
  'console',
  `
               return (async function() {
                   ${userCode}
               })();
           `,
);

const functionResult = await userFunction(safeRequire, Buffer, console);
```

Note: We use `OrigFunction` (saved before overriding the constructor) to create the wrapper. The override only blocks _user code_ from creating new Functions.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write services/codetool-sandbox/runtime_js/utils.js
git add services/codetool-sandbox/runtime_js/utils.js
git commit -m "$(cat <<'EOF'
[ABLP-2] fix(sandbox): replace require.cache poisoning with strict allowlist

Replace vulnerable require.cache poisoning with createSafeRequire()
that blocks all modules not explicitly allowlisted. Strips node:
prefix. Deletes process.binding/dlopen/mainModule and freezes process.
Blocks eval and Function constructor re-entry.

Fixes: JS sandbox escape via require('node:fs'), process.binding('fs'),
and process.dlopen().
EOF
)"
```

---

### Task 9: OCI / Container Hardening

**Files:**

- Modify: `services/codetool-sandbox/src/config_template.json`
- Create: `services/codetool-sandbox/seccomp-profile.json`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read config_template.json fully**

Read `services/codetool-sandbox/src/config_template.json` to see all current mounts. Verify there is no existing `/tmp` or `/dev/shm` mount.

- [ ] **Step 2: Verify no `/tmp` or `/dev/shm` mounts exist**

The current mounts in `config_template.json` are:

- `/proc` (type: proc)
- `/dev` (type: tmpfs)
- `/sys` (type: sysfs, options: nosuid, noexec, nodev, ro)

If `/tmp` is NOT already mounted, it may exist as a directory in the rootfs. Since the rootfs is `readonly: true`, `/tmp` is already read-only. Verify by reading the Dockerfile to check if `/tmp` exists in the rootfs build.

- [ ] **Step 3: Ensure the rootfs build does not create a writable `/tmp`**

Read `services/codetool-sandbox/Dockerfile` to check if `/tmp` is created. Since `root.readonly = true` in the OCI config, `/tmp` on the rootfs would be read-only. However, ensure no tmpfs is mounted over it. If no `/tmp` mount exists in config_template.json, this is already secure.

If a `/tmp` mount IS found or if the rootfs has a writable `/tmp` layer, skip to Step 4. Otherwise, no changes needed to config_template.json for `/tmp`.

- [ ] **Step 4: Create seccomp profile for docker-compose**

Create `services/codetool-sandbox/seccomp-profile.json` mirroring the OCI seccomp from `config_template.json`:

Read the full `config_template.json` seccomp section and extract the syscall names. Create the Docker-format seccomp profile:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "syscalls": [
    {
      "names": [
        "brk",
        "mmap",
        "munmap",
        "mprotect",
        "mremap",
        "madvise",
        "msync",
        "read",
        "write",
        "close",
        "openat",
        "lseek",
        "pread64",
        "readv",
        "writev",
        "pwrite64",
        "ioctl",
        "fcntl",
        "flock",
        "fstat",
        "fstatat",
        "statx",
        "stat",
        "lstat",
        "newfstatat",
        "getdents64",
        "getcwd",
        "chdir",
        "fchdir",
        "access",
        "faccessat",
        "faccessat2",
        "pipe",
        "pipe2",
        "dup",
        "dup2",
        "dup3",
        "socket",
        "connect",
        "bind",
        "listen",
        "accept",
        "accept4",
        "getsockname",
        "getpeername",
        "sendto",
        "recvfrom",
        "sendmsg",
        "recvmsg",
        "sendmmsg",
        "recvmmsg",
        "setsockopt",
        "getsockopt",
        "shutdown",
        "poll",
        "ppoll",
        "select",
        "pselect6",
        "epoll_create",
        "epoll_create1",
        "epoll_ctl",
        "epoll_wait",
        "epoll_pwait",
        "eventfd",
        "eventfd2",
        "futex",
        "set_robust_list",
        "get_robust_list",
        "nanosleep",
        "clock_nanosleep",
        "clock_gettime",
        "clock_getres",
        "gettimeofday",
        "getpid",
        "gettid",
        "getuid",
        "getgid",
        "geteuid",
        "getegid",
        "getppid",
        "getpgrp",
        "getgroups",
        "sched_getaffinity",
        "sched_yield",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sigaltstack",
        "exit",
        "exit_group",
        "set_tid_address",
        "arch_prctl",
        "prctl",
        "uname",
        "getrandom",
        "mlock",
        "munlock",
        "clone",
        "clone3",
        "wait4",
        "execve",
        "unlinkat",
        "renameat",
        "mkdirat",
        "symlinkat",
        "readlinkat",
        "fchmod",
        "fchmodat",
        "fchown",
        "fchownat",
        "umask",
        "getrlimit",
        "setrlimit",
        "prlimit64",
        "tgkill",
        "tkill",
        "rseq",
        "membarrier"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Read the actual OCI config syscall list to get the exact names — the above is an approximation. Copy the exact list from `config_template.json`.

- [ ] **Step 5: Update docker-compose.yml**

Read `docker-compose.yml` to find the `codetool-sandbox` service (around line 226). Replace:

```yaml
security_opt:
  - seccomp:unconfined
```

With:

```yaml
security_opt:
  - seccomp=services/codetool-sandbox/seccomp-profile.json
```

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write services/codetool-sandbox/seccomp-profile.json docker-compose.yml
git add services/codetool-sandbox/src/config_template.json services/codetool-sandbox/seccomp-profile.json docker-compose.yml
git commit -m "$(cat <<'EOF'
[ABLP-2] fix(sandbox): harden OCI config and docker-compose seccomp

Replace seccomp:unconfined in docker-compose with custom seccomp
profile mirroring the gVisor OCI allowlist. Ensures local dev has
comparable protection to production.
EOF
)"
```

---

### Task Dependency Map

Tasks 1-7 form the **tenant feature gate** workstream (sequential — each builds on the previous).
Task 8 is the **JS sandbox hardening** workstream (independent).
Task 9 is the **OCI/container hardening** workstream (independent).

**Parallelizable groups:**

- **Group A** (Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7): Tenant feature gate, sequential
- **Group B** (Task 8): JS sandbox hardening, independent
- **Group C** (Task 9): OCI/container hardening, independent

Groups A, B, and C can run in parallel.

Within Group A, Task 1 must complete first (types). Then Tasks 2-3 (admin API/UI) and Tasks 4-6 (Studio) can run in parallel after Task 1. Task 7 (runtime execution gate) depends on Task 1.

**Refined parallel groups:**

- **Parallel Wave 1:** Task 1 (types + config)
- **Parallel Wave 2:** Task 2 + Task 4 + Task 7 + Task 8 + Task 9 (all independent after Task 1)
- **Parallel Wave 3:** Task 3 + Task 5 + Task 6 (depend on Tasks 2 and 4 respectively)
