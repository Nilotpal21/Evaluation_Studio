# Connector Catalog Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace flaky dynamic AP piece imports in Studio with a static connector catalog, enrich with Nango OAuth metadata, and split the connections page into connected-list + catalog-grid.

**Architecture:** A build-time script imports all 25 AP pieces in Node (not Turbopack) to extract display metadata, merges with Nango OAuth provider configs, and outputs a static `connector-catalog.json`. Studio serves this JSON directly — never imports AP piece code. The Runtime continues using `loadConnectors()` for execution.

**Tech Stack:** TypeScript, Node.js (build script), Vitest (tests), React/Tailwind/Framer Motion (UI), SWR (data fetching)

---

### Task 1: Generate Static Connector Catalog Script

**Files:**

- Create: `scripts/generate-connector-catalog.ts`
- Create: `packages/connectors/src/generated/connector-catalog.json`
- Test: `packages/connectors/src/__tests__/generate-catalog.test.ts`

**Step 1: Write the failing test**

Create `packages/connectors/src/__tests__/generate-catalog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractCatalogEntry } from '../catalog/extract-entry.js';
import type { Connector } from '../types.js';

const mockConnector: Connector = {
  name: 'test-connector',
  displayName: 'Test Connector',
  version: '1.0.0',
  description: 'A test connector',
  auth: {
    type: 'api_key',
    fields: [{ name: 'apiKey', displayName: 'API Key', required: true, sensitive: true }],
  },
  triggers: [
    {
      name: 'new_item',
      displayName: 'New Item',
      description: 'Fires on new item',
      strategy: 'webhook' as const,
      props: [],
      onEnable: async () => {},
      onDisable: async () => {},
      run: async () => [],
    },
  ],
  actions: [
    {
      name: 'create_item',
      displayName: 'Create Item',
      description: 'Creates an item',
      props: [],
      run: async () => ({}),
    },
    {
      name: 'list_items',
      displayName: 'List Items',
      description: 'Lists items',
      props: [],
      run: async () => ({}),
    },
  ],
};

describe('extractCatalogEntry', () => {
  it('extracts display metadata from a Connector', () => {
    const entry = extractCatalogEntry(mockConnector, 'productivity');
    expect(entry).toEqual({
      name: 'test-connector',
      displayName: 'Test Connector',
      version: '1.0.0',
      description: 'A test connector',
      category: 'productivity',
      authType: 'api_key',
      actions: [
        { name: 'create_item', displayName: 'Create Item', description: 'Creates an item' },
        { name: 'list_items', displayName: 'List Items', description: 'Lists items' },
      ],
      triggers: [{ name: 'new_item', displayName: 'New Item', description: 'Fires on new item' }],
    });
  });

  it('omits functions — result is JSON-serializable', () => {
    const entry = extractCatalogEntry(mockConnector, 'productivity');
    const serialized = JSON.parse(JSON.stringify(entry));
    expect(serialized).toEqual(entry);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/connectors && npx vitest run src/__tests__/generate-catalog.test.ts`
Expected: FAIL — `extractCatalogEntry` does not exist

**Step 3: Write minimal implementation**

Create `packages/connectors/src/catalog/extract-entry.ts`:

```typescript
/**
 * Extract serializable catalog metadata from a loaded Connector.
 * Strips all functions — output is safe for JSON.stringify.
 */

import type { Connector } from '../types.js';

export interface CatalogEntry {
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  authType: string;
  actions: { name: string; displayName: string; description: string }[];
  triggers: { name: string; displayName: string; description: string }[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}

export function extractCatalogEntry(connector: Connector, category: string): CatalogEntry {
  return {
    name: connector.name,
    displayName: connector.displayName,
    version: connector.version,
    description: connector.description,
    category,
    authType: connector.auth.type,
    actions: connector.actions.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      description: a.description,
    })),
    triggers: connector.triggers.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
    })),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/connectors && npx vitest run src/__tests__/generate-catalog.test.ts`
Expected: PASS

**Step 5: Write the build script**

Create `scripts/generate-connector-catalog.ts`:

```typescript
/**
 * Generate Static Connector Catalog
 *
 * Loads all AP pieces in Node (not Turbopack), extracts display metadata,
 * and writes connector-catalog.json. This file is committed to the repo
 * and served by Studio — Studio never imports AP piece code.
 *
 * Usage: pnpm connectors:generate-catalog
 * Check: pnpm connectors:generate-catalog --check
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectorRegistry } from '../packages/connectors/src/registry.js';
import { loadConnectors } from '../packages/connectors/src/loader.js';
import { extractCatalogEntry } from '../packages/connectors/src/catalog/extract-entry.js';
import type { CatalogEntry } from '../packages/connectors/src/catalog/extract-entry.js';

// Category mapping (mirrors apps/studio/src/components/connections/connector-categories.ts)
const CONNECTOR_CATEGORIES: Record<string, string> = {
  slack: 'communication',
  discord: 'communication',
  'microsoft-teams': 'communication',
  gmail: 'communication',
  twilio: 'communication',
  sendgrid: 'communication',
  notion: 'productivity',
  asana: 'productivity',
  clickup: 'productivity',
  'jira-cloud': 'productivity',
  linear: 'productivity',
  'google-calendar': 'productivity',
  'google-drive': 'storage',
  'amazon-s3': 'storage',
  'google-sheets': 'storage',
  airtable: 'storage',
  postgres: 'storage',
  hubspot: 'crm',
  salesforce: 'crm',
  pipedrive: 'crm',
  shopify: 'crm',
  stripe: 'crm',
  openai: 'ai_dev',
  claude: 'ai_dev',
  github: 'ai_dev',
  http: 'custom',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'packages', 'connectors', 'src', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'connector-catalog.json');

async function main(): Promise<void> {
  const isCheck = process.argv.includes('--check');

  // Load all connectors via the existing loader (runs in Node, not Turbopack)
  const registry = new ConnectorRegistry();
  await loadConnectors(registry);

  const connectors = registry.listConnectors();
  console.log(`Loaded ${connectors.length} connectors`);

  // Extract catalog entries
  const catalog: CatalogEntry[] = connectors.map((c) =>
    extractCatalogEntry(c, CONNECTOR_CATEGORIES[c.name] ?? 'custom'),
  );

  // Sort by category then name for deterministic output
  catalog.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const output = JSON.stringify(catalog, null, 2) + '\n';

  if (isCheck) {
    try {
      const existing = readFileSync(OUTPUT_FILE, 'utf-8');
      if (existing === output) {
        console.log('connector-catalog.json is up to date');
        process.exit(0);
      } else {
        console.error('connector-catalog.json is STALE. Run: pnpm connectors:generate-catalog');
        process.exit(1);
      }
    } catch {
      console.error('connector-catalog.json does not exist. Run: pnpm connectors:generate-catalog');
      process.exit(1);
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, output);
  console.log(`Written ${catalog.length} entries to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Failed to generate catalog:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

**Step 6: Add npm script to connectors package.json**

In `packages/connectors/package.json`, add to `"scripts"`:

```json
"generate-catalog": "tsx ../../scripts/generate-connector-catalog.ts"
```

Also add to root `package.json` scripts:

```json
"connectors:generate-catalog": "pnpm --filter @agent-platform/connectors generate-catalog"
```

**Step 7: Run the script to generate the catalog**

Run: `pnpm connectors:generate-catalog`
Expected: Creates `packages/connectors/src/generated/connector-catalog.json` with 25 entries

**Step 8: Verify the JSON is valid**

Run: `node -e "const c = require('./packages/connectors/src/generated/connector-catalog.json'); console.log(c.length + ' entries')"`
Expected: `25 entries`

**Step 9: Update build script to copy catalog JSON**

In `packages/connectors/package.json`, update `"build"` script:

```json
"build": "tsc && mkdir -p dist/adapters/nango/generated dist/generated && cp src/adapters/nango/generated/providers.json dist/adapters/nango/generated/ && cp src/generated/connector-catalog.json dist/generated/"
```

**Step 10: Commit**

```bash
git add packages/connectors/src/catalog/extract-entry.ts packages/connectors/src/__tests__/generate-catalog.test.ts scripts/generate-connector-catalog.ts packages/connectors/src/generated/connector-catalog.json packages/connectors/package.json package.json
git commit -m "[ABLP-2] feat(connectors): add static catalog generation script"
```

---

### Task 2: Enrich Catalog with Nango OAuth Metadata

**Files:**

- Modify: `scripts/generate-connector-catalog.ts`
- Modify: `packages/connectors/src/catalog/extract-entry.ts`
- Test: `packages/connectors/src/__tests__/generate-catalog.test.ts`

**Step 1: Run the Nango import to populate providers.json**

Run: `pnpm connectors:import-providers`
Expected: `packages/connectors/src/adapters/nango/generated/providers.json` populated with OAuth2 providers

**Step 2: Write the failing test for OAuth enrichment**

Add to `packages/connectors/src/__tests__/generate-catalog.test.ts`:

```typescript
import { enrichWithOAuth } from '../catalog/extract-entry.js';
import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';

describe('enrichWithOAuth', () => {
  it('merges OAuth2 config from Nango provider into catalog entry', () => {
    const entry: CatalogEntry = {
      name: 'slack',
      displayName: 'Slack',
      version: '1.0.0',
      description: 'Slack connector',
      category: 'communication',
      authType: 'oauth2',
      actions: [],
      triggers: [],
    };

    const provider: ProviderConfig = {
      name: 'slack',
      authMode: 'oauth2',
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      scopeSeparator: ',',
      defaultScopes: ['chat:write', 'channels:read'],
      pkce: false,
    };

    const enriched = enrichWithOAuth(entry, [provider]);
    expect(enriched.oauth2).toEqual({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      defaultScopes: ['chat:write', 'channels:read'],
      scopeSeparator: ',',
      pkce: false,
    });
  });

  it('skips enrichment when no matching provider exists', () => {
    const entry: CatalogEntry = {
      name: 'custom-http',
      displayName: 'HTTP',
      version: '1.0.0',
      description: 'HTTP connector',
      category: 'custom',
      authType: 'none',
      actions: [],
      triggers: [],
    };
    const enriched = enrichWithOAuth(entry, []);
    expect(enriched.oauth2).toBeUndefined();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/connectors && npx vitest run src/__tests__/generate-catalog.test.ts`
Expected: FAIL — `enrichWithOAuth` does not exist

**Step 4: Implement enrichWithOAuth**

Add to `packages/connectors/src/catalog/extract-entry.ts`:

```typescript
import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';

/**
 * Enrich a catalog entry with OAuth2 metadata from Nango provider configs.
 * Matches by connector name (exact or common aliases).
 */
export function enrichWithOAuth(entry: CatalogEntry, providers: ProviderConfig[]): CatalogEntry {
  if (entry.authType !== 'oauth2') return entry;

  const provider = providers.find(
    (p) => p.name === entry.name || p.name === entry.name.replace('-', '_'),
  );
  if (!provider || !provider.authorizationUrl || !provider.tokenUrl) return entry;

  return {
    ...entry,
    oauth2: {
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      refreshUrl: provider.refreshUrl,
      defaultScopes: provider.defaultScopes,
      scopeSeparator: provider.scopeSeparator,
      pkce: provider.pkce,
    },
  };
}
```

**Step 5: Run test to verify it passes**

Run: `cd packages/connectors && npx vitest run src/__tests__/generate-catalog.test.ts`
Expected: PASS

**Step 6: Wire enrichment into the generate script**

Update `scripts/generate-connector-catalog.ts` — after extracting catalog entries, load `providers.json` and enrich:

```typescript
import { enrichWithOAuth } from '../packages/connectors/src/catalog/extract-entry.js';
import type { ProviderConfig } from '../packages/connectors/src/adapters/nango/provider-mapper.js';

// ... after extracting catalog entries:

// Load Nango provider configs
let nangoProviders: ProviderConfig[] = [];
const providersPath = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'adapters',
  'nango',
  'generated',
  'providers.json',
);
try {
  nangoProviders = JSON.parse(readFileSync(providersPath, 'utf-8'));
  console.log(`Loaded ${nangoProviders.length} Nango OAuth2 providers`);
} catch {
  console.warn('No Nango providers.json found — skipping OAuth enrichment');
}

// Enrich catalog with OAuth metadata
const enrichedCatalog = catalog.map((entry) => enrichWithOAuth(entry, nangoProviders));
```

Use `enrichedCatalog` in the output instead of `catalog`.

**Step 7: Regenerate the catalog**

Run: `pnpm connectors:generate-catalog`
Expected: OAuth2 connectors (slack, gmail, github, etc.) now have `oauth2` field in the JSON

**Step 8: Commit**

```bash
git add packages/connectors/src/catalog/extract-entry.ts packages/connectors/src/__tests__/generate-catalog.test.ts scripts/generate-connector-catalog.ts packages/connectors/src/generated/connector-catalog.json packages/connectors/src/adapters/nango/generated/providers.json
git commit -m "[ABLP-2] feat(connectors): enrich catalog with Nango OAuth metadata"
```

---

### Task 3: Update Studio Connectors API to Serve Static Catalog

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/connectors/route.ts`
- Modify: `apps/studio/src/lib/connection-service.ts`
- Add export: `packages/connectors/package.json` (new `./catalog` export)

**Step 1: Add catalog export to connectors package**

In `packages/connectors/package.json`, add to `"exports"`:

```json
"./catalog": {
  "import": "./dist/generated/connector-catalog.json",
  "types": "./dist/catalog/extract-entry.d.ts"
}
```

**Step 2: Update the connectors API route**

Replace `apps/studio/src/app/api/projects/[id]/connectors/route.ts`:

```typescript
/**
 * GET /api/projects/:id/connectors — Static connector catalog
 *
 * Serves the pre-generated connector-catalog.json directly.
 * No dynamic imports, no registry initialization.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import catalog from '@agent-platform/connectors/catalog';

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: [
      StudioPermission.WORKFLOW_READ,
      StudioPermission.CONNECTION_READ,
      StudioPermission.CONNECTION_WRITE,
    ],
  },
  async () => {
    return NextResponse.json({ success: true, data: catalog });
  },
);
```

Note: If the JSON import doesn't work with the package export, use a direct file read:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fallback: read the JSON file directly
const catalogPath = join(
  process.cwd(),
  'node_modules',
  '@agent-platform',
  'connectors',
  'dist',
  'generated',
  'connector-catalog.json',
);
let catalog: unknown[];
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
} catch {
  catalog = [];
}
```

**Step 3: Simplify connection-service.ts — remove loadConnectors dependency**

The `connection-service.ts` singleton still needs `loadConnectors` for the `ConnectionService` (which tests connections via the registry). Keep `loadConnectors` for that purpose but remove the `ConnectorListingService` export since the API no longer uses it.

In `apps/studio/src/lib/connection-service.ts`, remove:

```typescript
// Remove these lines:
import { ConnectorListingService } from '@agent-platform/connectors/services';
let _listingService: ConnectorListingService | null = null;
// And the _listingService assignments in ensureInitialized()
// And the getConnectorListingService export
```

Update the init check to only check `_connectionService`:

```typescript
async function ensureInitialized(): Promise<void> {
  if (_connectionService) return;
  // ... rest stays the same, minus _listingService assignments
}
```

**Step 4: Verify build**

Run: `pnpm build --filter @agent-platform/connectors && pnpm build --filter @agent-platform/studio`
Expected: No errors

**Step 5: Commit**

```bash
git add apps/studio/src/app/api/projects/[id]/connectors/route.ts apps/studio/src/lib/connection-service.ts packages/connectors/package.json
git commit -m "[ABLP-2] refactor(studio): serve static connector catalog instead of dynamic registry"
```

---

### Task 4: Create CatalogCard Component

**Files:**

- Create: `apps/studio/src/components/connections/CatalogCard.tsx`
- Test: Visual verification in browser

**Step 1: Create the CatalogCard component**

Create `apps/studio/src/components/connections/CatalogCard.tsx`:

```typescript
'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { ConnectorLogo } from './ConnectorLogo';
import { Button } from '../ui/Button';

export interface CatalogConnector {
  name: string;
  displayName: string;
  description?: string;
  category: string;
  authType: string;
  actions: { name: string; displayName: string; description: string }[];
  triggers: { name: string; displayName: string; description: string }[];
}

interface CatalogCardProps {
  connector: CatalogConnector;
  isConnected: boolean;
  onConnect: () => void;
  onScrollToConnection?: () => void;
}

export function CatalogCard({ connector, isConnected, onConnect, onScrollToConnection }: CatalogCardProps) {
  return (
    <motion.div
      className={clsx(
        'relative rounded-xl border p-4 transition-colors duration-150',
        isConnected
          ? 'border-success/30 bg-background'
          : 'border-default bg-background hover:border-accent',
      )}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="flex items-start gap-3">
        <ConnectorLogo name={connector.name} className="h-8 w-8" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{connector.displayName}</p>
          <p className="text-xs text-muted mt-0.5">
            {connector.actions.length} action{connector.actions.length !== 1 ? 's' : ''}
            {connector.triggers.length > 0 &&
              ` · ${connector.triggers.length} trigger${connector.triggers.length !== 1 ? 's' : ''}`}
          </p>
        </div>
      </div>
      <div className="mt-3">
        {isConnected ? (
          <button
            onClick={onScrollToConnection}
            className="flex items-center gap-1.5 text-xs text-success hover:underline"
          >
            <Check className="h-3.5 w-3.5" />
            Connected
          </button>
        ) : (
          <Button variant="secondary" size="xs" onClick={onConnect} className="w-full">
            Connect
          </Button>
        )}
      </div>
    </motion.div>
  );
}
```

**Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/connections/CatalogCard.tsx
git add apps/studio/src/components/connections/CatalogCard.tsx
git commit -m "[ABLP-2] feat(studio): add CatalogCard component for connector catalog grid"
```

---

### Task 5: Update ConnectionStatusBar for Catalog Count

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionStatusBar.tsx`

**Step 1: Add catalogCount prop**

Update `apps/studio/src/components/connections/ConnectionStatusBar.tsx`:

```typescript
'use client';

import { Button } from '../ui/Button';
import { Plus } from 'lucide-react';
import type { ConnectionSummary } from '../../api/connections';

interface ConnectionStatusBarProps {
  connections: ConnectionSummary[];
  catalogCount: number;
  onNewConnection: () => void;
}

const EXPIRY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function ConnectionStatusBar({ connections, catalogCount, onNewConnection }: ConnectionStatusBarProps) {
  const active = connections.filter((c) => c.status === 'active').length;
  const expiring = connections.filter(
    (c) => c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < EXPIRY_THRESHOLD_MS,
  ).length;
  const failed = connections.filter((c) => c.status === 'revoked').length;

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} connected`);
  if (expiring > 0) parts.push(`${expiring} expiring`);
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${catalogCount} available`);

  return (
    <div className="flex items-center justify-between py-2">
      <p className="text-sm text-muted">{parts.join(' \u00B7 ')}</p>
      <Button
        variant="primary"
        size="sm"
        icon={<Plus className="h-4 w-4" />}
        onClick={onNewConnection}
      >
        New Connection
      </Button>
    </div>
  );
}
```

**Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/connections/ConnectionStatusBar.tsx
git add apps/studio/src/components/connections/ConnectionStatusBar.tsx
git commit -m "[ABLP-2] feat(studio): show catalog count in ConnectionStatusBar"
```

---

### Task 6: Rewrite ConnectionsPage — Top/Bottom Split Layout

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionsPage.tsx`

This is the main UI change. The page becomes:

1. Status bar (top)
2. Search input (filters both sections)
3. "My Connections" section — existing categorized connection cards with expand panels
4. "Connector Catalog" section — CatalogCard grid grouped by category

**Step 1: Rewrite ConnectionsPage**

Replace `apps/studio/src/components/connections/ConnectionsPage.tsx`:

```typescript
/**
 * ConnectionsPage — Split Layout
 *
 * Top: My Connections (compact cards with inline expand)
 * Bottom: Connector Catalog (full grid with "Connect" buttons)
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Diamond, Search } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useConnections } from '../../hooks/useConnections';
import { useAvailableConnectors } from '../../hooks/useAvailableConnectors';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { ConnectionCard } from './ConnectionCard';
import { ConnectionExpandPanel } from './ConnectionExpandPanel';
import { CatalogCard } from './CatalogCard';
import type { CatalogConnector } from './CatalogCard';
import { CreateConnectionModal } from './CreateConnectionModal';
import { ConnectorLogo } from './ConnectorLogo';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { getConnectorCategory, getCategoryLabel, CATEGORY_ORDER } from './connector-categories';
import type { ConnectionSummary } from '../../api/connections';

// =============================================================================
// CONSTANTS
// =============================================================================

const SKELETON_CARD_COUNT = 6;
const POPULAR_CONNECTORS = ['slack', 'gmail', 'google-sheets', 'github'];

// =============================================================================
// SKELETON
// =============================================================================

function ConnectionCardSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg skeleton" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-32 rounded skeleton" />
          <div className="h-3 w-20 rounded skeleton" />
        </div>
        <div className="h-2 w-2 rounded-full skeleton" />
      </div>
      <div className="h-3 w-28 rounded skeleton mt-3" />
    </div>
  );
}

function ConnectionSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
        <ConnectionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function groupByCategory<T extends { connectorName?: string; name?: string }>(
  items: T[],
  getName: (item: T) => string,
): { category: string; label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const cat = getConnectorCategory(getName(item));
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(item);
  }
  return CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => ({
    category: cat,
    label: getCategoryLabel(cat),
    items: groups.get(cat)!,
  }));
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ConnectionsPage() {
  const { projectId } = useNavigationStore();
  const { connections, isLoading, error, refresh } = useConnections(projectId);
  const { connectors: catalogConnectors, isLoading: catalogLoading } =
    useAvailableConnectors(projectId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPreselect, setCreatePreselect] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Set of connected connector names for badge display
  const connectedNames = useMemo(
    () => new Set(connections.map((c) => c.connectorName)),
    [connections],
  );

  // Filter connections by search
  const filteredConnections = useMemo(
    () =>
      connections.filter(
        (c) =>
          !searchQuery ||
          c.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.connectorName.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [connections, searchQuery],
  );

  // Filter catalog by search
  const filteredCatalog = useMemo(
    () =>
      (catalogConnectors as CatalogConnector[]).filter(
        (c) =>
          !searchQuery ||
          c.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [catalogConnectors, searchQuery],
  );

  // Group connections by category
  const connectionGroups = useMemo(
    () => groupByCategory(filteredConnections, (c) => c.connectorName),
    [filteredConnections],
  );

  // Group catalog by category
  const catalogGroups = useMemo(
    () => groupByCategory(filteredCatalog, (c) => c.name),
    [filteredCatalog],
  );

  function handleToggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const handleCatalogConnect = useCallback(
    (connectorName: string) => {
      setCreatePreselect(connectorName);
      setCreateOpen(true);
    },
    [],
  );

  function handleModalClose() {
    setCreateOpen(false);
    setCreatePreselect(null);
  }

  if (!projectId) {
    return (
      <EmptyState
        icon={<Diamond className="w-6 h-6" />}
        title="No project selected"
        description="Select a project to view its connections."
      />
    );
  }

  // Loading skeleton
  if (isLoading && connections.length === 0 && catalogLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between py-2">
          <div className="h-4 w-40 rounded skeleton" />
          <div className="h-8 w-36 rounded skeleton" />
        </div>
        <ConnectionSkeletonGrid />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Diamond className="w-6 h-6" />}
          title="Failed to load connections"
          description={error}
          action={
            <Button variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  // Full empty state — no connections, show popular + catalog
  const hasConnections = connections.length > 0;

  return (
    <div className="p-6 space-y-6">
      <ConnectionStatusBar
        connections={connections}
        catalogCount={catalogConnectors.length}
        onNewConnection={() => setCreateOpen(true)}
      />

      {/* Search — visible when there are connections or many catalog items */}
      {(hasConnections || catalogConnectors.length > 6) && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            type="text"
            placeholder="Search connections & connectors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full max-w-sm rounded-lg border border-default bg-background pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}

      {/* No search results */}
      {searchQuery && filteredConnections.length === 0 && filteredCatalog.length === 0 && (
        <EmptyState
          icon={<Search className="w-6 h-6" />}
          title="No results"
          description={`Nothing matches "${searchQuery}"`}
        />
      )}

      {/* ─── MY CONNECTIONS (top section) ──────────────────────────── */}
      {hasConnections ? (
        <section>
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4">
            My Connections
          </h2>
          {connectionGroups.map(({ category, label, items }) => (
            <div key={category} className="mb-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-muted">{label}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((conn) => (
                  <ConnectionCard
                    key={conn.id}
                    connection={conn}
                    isExpanded={expandedId === conn.id}
                    onClick={() => handleToggle(conn.id)}
                  />
                ))}
              </div>
              <AnimatePresence>
                {items.some((c) => c.id === expandedId) && (
                  <ConnectionExpandPanel
                    connection={items.find((c) => c.id === expandedId)!}
                    projectId={projectId}
                    onDeleted={() => {
                      setExpandedId(null);
                      refresh();
                    }}
                    onUpdated={refresh}
                  />
                )}
              </AnimatePresence>
            </div>
          ))}
        </section>
      ) : (
        !searchQuery && (
          <div className="flex flex-col items-center py-12">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-background-elevated">
              <Diamond className="h-6 w-6 text-muted" />
            </div>
            <p className="mt-3 text-sm text-muted">
              No connections yet — browse the catalog below to get started.
            </p>
          </div>
        )
      )}

      {/* ─── CONNECTOR CATALOG (bottom section) ───────────────────── */}
      <section>
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4">
          Connector Catalog
        </h2>
        {catalogGroups.map(({ category, label, items }) => (
          <div key={category} className="mb-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-muted">{label}</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {items.map((connector) => (
                <CatalogCard
                  key={connector.name}
                  connector={connector}
                  isConnected={connectedNames.has(connector.name)}
                  onConnect={() => handleCatalogConnect(connector.name)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <CreateConnectionModal
        open={createOpen}
        onClose={handleModalClose}
        projectId={projectId}
        onCreated={refresh}
        preselectedConnector={createPreselect}
      />
    </div>
  );
}
```

**Step 2: Update CreateConnectionModal to accept preselectedConnector**

In `apps/studio/src/components/connections/CreateConnectionModal.tsx`, add `preselectedConnector` prop:

```typescript
interface CreateConnectionModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
  preselectedConnector?: string | null;
}
```

In the component, add an effect that auto-selects when preselectedConnector changes:

```typescript
import { useState, useMemo, useEffect } from 'react';

// Inside the component:
useEffect(() => {
  if (preselectedConnector && connectors.length > 0) {
    const connector = connectors.find((c) => c.name === preselectedConnector);
    if (connector) {
      handleSelect(connector);
    }
  }
}, [preselectedConnector, connectors]);
```

**Step 3: Verify in browser**

Run: `pnpm dev --filter @agent-platform/studio`
Open: `http://localhost:5173/projects/<id>/connections`
Expected: Two sections visible — "My Connections" on top (or empty message), "Connector Catalog" below with 25 cards grouped by category. Each catalog card shows "Connect" button or checkmark badge.

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/connections/ConnectionsPage.tsx apps/studio/src/components/connections/CreateConnectionModal.tsx
git add apps/studio/src/components/connections/ConnectionsPage.tsx apps/studio/src/components/connections/CreateConnectionModal.tsx
git commit -m "[ABLP-2] feat(studio): split connections page into connected-list + catalog-grid"
```

---

### Task 7: Update useAvailableConnectors Hook for Category Support

**Files:**

- Modify: `apps/studio/src/hooks/useAvailableConnectors.ts`

The hook currently maps `auth.type` → `authType`. It should also pass through `category`, `actions`, `triggers` from the static catalog.

**Step 1: Update the ConnectorSummary interface**

In `apps/studio/src/hooks/useAvailableConnectors.ts`, update:

```typescript
export interface ConnectorSummary {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  authType?: 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom' | 'none';
  triggers?: { name: string; displayName: string; description?: string }[];
  actions?: { name: string; displayName: string; description?: string }[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}
```

Update the connector mapping in `useMemo` to pass through all fields:

```typescript
const connectors = useMemo(
  () =>
    (data?.data ?? []).map((c: any) => ({
      ...c,
      authType: c.authType ?? c.auth?.type,
    })),
  [data],
);
```

This already spreads all fields — verify that `category` and `oauth2` come through from the API. No code change needed if the spread handles it. Just verify the type includes the new fields.

**Step 2: Commit**

```bash
npx prettier --write apps/studio/src/hooks/useAvailableConnectors.ts
git add apps/studio/src/hooks/useAvailableConnectors.ts
git commit -m "[ABLP-2] feat(studio): extend ConnectorSummary type with category and OAuth fields"
```

---

### Task 8: End-to-End Verification

**Step 1: Build everything**

Run: `pnpm build --filter @agent-platform/connectors && pnpm build --filter @agent-platform/studio`
Expected: Clean builds, no errors

**Step 2: Run connector tests**

Run: `pnpm test --filter @agent-platform/connectors`
Expected: All tests pass including new `generate-catalog.test.ts`

**Step 3: Start Studio dev server**

Run: `pnpm dev --filter @agent-platform/studio`

**Step 4: Verify in browser**

1. Navigate to Connections page
2. Verify status bar shows "N connected · M available"
3. Verify "My Connections" section shows existing connections with health dots
4. Verify "Connector Catalog" section shows 25 cards grouped by category
5. Verify search filters both sections simultaneously
6. Click "Connect" on a catalog card — CreateConnectionModal opens at configure step
7. Verify already-connected connectors show checkmark badge

**Step 5: Run catalog check**

Run: `pnpm connectors:generate-catalog --check`
Expected: "connector-catalog.json is up to date"

**Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "[ABLP-2] fix(studio): catalog integration fixes from e2e verification"
```
