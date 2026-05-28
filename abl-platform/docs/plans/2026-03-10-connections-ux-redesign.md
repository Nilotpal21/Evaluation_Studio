# Connections UX Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the generic connections CRUD UI with a Vercel/Linear-style Connection Hub featuring categorized cards, inline expand panels, and a modal creation flow.

**Architecture:** Rewrite `ConnectionsPage` → `ConnectionHub` as the single-page experience. Replace `ConnectionCard` with richer cards. Replace `ConnectionCreatePage` with a modal. Remove `ConnectionDetailPage` — all detail lives in the inline expand panel. Keep all API routes, hooks, and services unchanged.

**Tech Stack:** React 18, Framer Motion (AnimatePresence + layout), Tailwind CSS, SWR, existing UI primitives (Dialog, Button, Input, Badge, EmptyState)

**Design Doc:** `docs/plans/2026-03-10-connections-ux-redesign-design.md`

---

## Task 1: Connector Category Map

**Files:**

- Create: `apps/studio/src/components/connections/connector-categories.ts`
- Test: `apps/studio/src/components/connections/__tests__/connector-categories.test.ts`

This is the foundation — maps connector names to display categories used across the hub.

**Step 1: Write the failing test**

```typescript
// apps/studio/src/components/connections/__tests__/connector-categories.test.ts
import { describe, it, expect } from 'vitest';
import {
  getConnectorCategory,
  getCategoryLabel,
  CATEGORY_ORDER,
  type ConnectorCategory,
} from '../connector-categories';

describe('connector-categories', () => {
  it('maps known connectors to categories', () => {
    expect(getConnectorCategory('slack')).toBe('communication');
    expect(getConnectorCategory('google-sheets')).toBe('storage');
    expect(getConnectorCategory('hubspot')).toBe('crm');
    expect(getConnectorCategory('openai')).toBe('ai_dev');
    expect(getConnectorCategory('notion')).toBe('productivity');
  });

  it('returns "custom" for unknown connectors', () => {
    expect(getConnectorCategory('unknown-thing')).toBe('custom');
  });

  it('returns human-readable category labels', () => {
    expect(getCategoryLabel('communication')).toBe('Communication');
    expect(getCategoryLabel('crm')).toBe('CRM & Sales');
    expect(getCategoryLabel('ai_dev')).toBe('AI & Dev');
  });

  it('CATEGORY_ORDER defines display order', () => {
    expect(CATEGORY_ORDER).toEqual([
      'communication',
      'productivity',
      'storage',
      'crm',
      'ai_dev',
      'custom',
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && npx vitest run src/components/connections/__tests__/connector-categories.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// apps/studio/src/components/connections/connector-categories.ts
export type ConnectorCategory =
  | 'communication'
  | 'productivity'
  | 'storage'
  | 'crm'
  | 'ai_dev'
  | 'custom';

export const CATEGORY_ORDER: ConnectorCategory[] = [
  'communication',
  'productivity',
  'storage',
  'crm',
  'ai_dev',
  'custom',
];

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  communication: 'Communication',
  productivity: 'Productivity',
  storage: 'Storage',
  crm: 'CRM & Sales',
  ai_dev: 'AI & Dev',
  custom: 'Custom',
};

const CONNECTOR_TO_CATEGORY: Record<string, ConnectorCategory> = {
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

export function getConnectorCategory(connectorName: string): ConnectorCategory {
  return CONNECTOR_TO_CATEGORY[connectorName] ?? 'custom';
}

export function getCategoryLabel(category: ConnectorCategory): string {
  return CATEGORY_LABELS[category];
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && npx vitest run src/components/connections/__tests__/connector-categories.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/connections/connector-categories.ts apps/studio/src/components/connections/__tests__/connector-categories.test.ts
git commit -m "feat(studio): add connector category mapping for connection hub"
```

---

## Task 2: Status Bar Component

**Files:**

- Create: `apps/studio/src/components/connections/ConnectionStatusBar.tsx`

A thin bar showing aggregate health + "New Connection" button.

**Step 1: Write the component**

```tsx
// apps/studio/src/components/connections/ConnectionStatusBar.tsx
'use client';

import { Button } from '../ui/Button';
import { Plus } from 'lucide-react';
import type { ConnectionSummary } from '../../api/connections';

interface ConnectionStatusBarProps {
  connections: ConnectionSummary[];
  onNewConnection: () => void;
}

export function ConnectionStatusBar({ connections, onNewConnection }: ConnectionStatusBarProps) {
  const active = connections.filter((c) => c.status === 'active').length;
  const expiring = connections.filter(
    (c) => c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000,
  ).length;
  const failed = connections.filter((c) => c.status === 'error' || c.status === 'revoked').length;

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} connected`);
  if (expiring > 0) parts.push(`${expiring} expiring`);
  if (failed > 0) parts.push(`${failed} failed`);

  return (
    <div className="flex items-center justify-between py-2">
      <p className="text-sm text-muted">
        {parts.length > 0 ? parts.join(' · ') : 'No connections yet'}
      </p>
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
git add apps/studio/src/components/connections/ConnectionStatusBar.tsx
git commit -m "feat(studio): add ConnectionStatusBar with aggregate health summary"
```

---

## Task 3: Connection Card V2

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionCard.tsx` (full rewrite)

Replace the existing card with the new compact, monochrome design. No action buttons on the card — only visual state.

**Step 1: Read the existing `ConnectionCard.tsx` fully**

Read: `apps/studio/src/components/connections/ConnectionCard.tsx`

**Step 2: Rewrite the component**

Rewrite `ConnectionCard.tsx` in place. Key changes:

- Remove hover action buttons (test, delete)
- Add health dot (green/amber/red/gray)
- Add agent count + relative time bottom line
- Add grayscale→color logo transition on hover
- Add `translateY(-2px)` lift on hover
- Props: `connection`, `isExpanded`, `onClick`

```tsx
// apps/studio/src/components/connections/ConnectionCard.tsx
'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { ConnectionSummary } from '../../api/connections';
import { ConnectorLogo } from './ConnectorLogo';

interface ConnectionCardProps {
  connection: ConnectionSummary;
  isExpanded: boolean;
  onClick: () => void;
  agentCount?: number;
}

function getHealthColor(connection: ConnectionSummary): string {
  if (connection.status === 'error' || connection.status === 'revoked') return 'bg-error';
  if (
    connection.expiresAt &&
    new Date(connection.expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
  )
    return 'bg-warning';
  if (connection.status === 'active') return 'bg-success';
  return 'bg-muted';
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ConnectionCard({
  connection,
  isExpanded,
  onClick,
  agentCount = 0,
}: ConnectionCardProps) {
  return (
    <motion.button
      onClick={onClick}
      className={clsx(
        'group relative w-full rounded-xl border p-4 text-left transition-colors duration-150',
        isExpanded
          ? 'border-accent bg-surface-1'
          : 'border-default bg-background hover:border-accent',
      )}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <ConnectorLogo
            name={connection.connectorName}
            className="h-8 w-8 grayscale group-hover:grayscale-0 transition-[filter] duration-150"
          />
          <div>
            <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
            <p className="text-xs text-muted">{connection.connectorName}</p>
          </div>
        </div>
        <span
          className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', getHealthColor(connection))}
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        {agentCount > 0 ? `${agentCount} agent${agentCount !== 1 ? 's' : ''}` : 'No agents'} ·{' '}
        {formatRelativeTime(connection.updatedAt)}
      </p>
    </motion.button>
  );
}
```

**Step 3: Commit**

```bash
git add apps/studio/src/components/connections/ConnectionCard.tsx
git commit -m "feat(studio): redesign ConnectionCard with health dot and compact layout"
```

---

## Task 4: Connector Logo Component

**Files:**

- Create: `apps/studio/src/components/connections/ConnectorLogo.tsx`

Renders connector brand logo. Falls back to a colored initial avatar.

**Step 1: Write the component**

```tsx
// apps/studio/src/components/connections/ConnectorLogo.tsx
'use client';

import { clsx } from 'clsx';

interface ConnectorLogoProps {
  name: string;
  className?: string;
}

/** Deterministic color from connector name */
function nameToColor(name: string): string {
  const colors = [
    'bg-blue-500/10 text-blue-500',
    'bg-purple-500/10 text-purple-500',
    'bg-green-500/10 text-green-500',
    'bg-orange-500/10 text-orange-500',
    'bg-pink-500/10 text-pink-500',
    'bg-cyan-500/10 text-cyan-500',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

export function ConnectorLogo({ name, className }: ConnectorLogoProps) {
  // Fallback: colored initial avatar
  // TODO: Replace with actual brand SVG icons per connector
  return (
    <div
      className={clsx(
        'flex items-center justify-center rounded-lg text-sm font-semibold',
        nameToColor(name),
        className,
      )}
    >
      {getInitial(name)}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/connections/ConnectorLogo.tsx
git commit -m "feat(studio): add ConnectorLogo with initial-avatar fallback"
```

---

## Task 5: Inline Expand Panel

**Files:**

- Create: `apps/studio/src/components/connections/ConnectionExpandPanel.tsx`

The expand panel that slides open below a card row showing details, usage, and actions.

**Step 1: Write the component**

```tsx
// apps/studio/src/components/connections/ConnectionExpandPanel.tsx
'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { testConnection, deleteConnection, updateConnection } from '../../api/connections';
import { sanitizeError } from '../../lib/sanitize-error';
import type { ConnectionSummary } from '../../api/connections';

interface ConnectionExpandPanelProps {
  connection: ConnectionSummary;
  projectId: string;
  onDeleted: () => void;
  onUpdated: () => void;
}

type TestState = 'idle' | 'testing' | 'success' | 'error';
type PanelMode = 'view' | 'edit' | 'confirm-disconnect';

export function ConnectionExpandPanel({
  connection,
  projectId,
  onDeleted,
  onUpdated,
}: ConnectionExpandPanelProps) {
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('view');
  const [editName, setEditName] = useState(connection.displayName);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleTest() {
    setTestState('testing');
    setTestError(null);
    try {
      await testConnection(projectId, connection.id);
      setTestState('success');
      setTimeout(() => setTestState('idle'), 2000);
    } catch (err) {
      setTestState('error');
      setTestError(sanitizeError(err));
      setTimeout(() => setTestState('idle'), 3000);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateConnection(projectId, connection.id, { displayName: editName });
      onUpdated();
      setMode('view');
    } catch {
      // stay in edit mode
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDeleting(true);
    try {
      await deleteConnection(projectId, connection.id);
      onDeleted();
    } catch {
      setDeleting(false);
    }
  }

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="overflow-hidden col-span-full"
    >
      <div className="rounded-xl border border-default bg-surface-1 p-5 mt-2 mb-4">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="text-muted">Status</span>
            <span className="ml-2">
              <Badge variant={connection.status === 'active' ? 'success' : 'error'} dot>
                {connection.status}
              </Badge>
            </span>
          </div>
          <div>
            <span className="text-muted">Auth</span>
            <span className="ml-2 text-foreground">{connection.authType}</span>
          </div>
          <div>
            <span className="text-muted">Created</span>
            <span className="ml-2 text-foreground">{formatDate(connection.createdAt)}</span>
          </div>
          {connection.expiresAt && (
            <div>
              <span className="text-muted">Expires</span>
              <span className="ml-2 text-foreground">{formatDate(connection.expiresAt)}</span>
            </div>
          )}
        </div>

        {/* TODO: "Used by" section — requires agent→connection reverse lookup API */}

        {/* Actions */}
        <div className="mt-4 border-t border-default pt-4">
          <AnimatePresence mode="wait">
            {mode === 'view' && (
              <motion.div
                key="actions"
                className="flex items-center gap-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleTest}
                  loading={testState === 'testing'}
                >
                  {testState === 'success'
                    ? '✓ Connected'
                    : testState === 'error'
                      ? '✕ Failed'
                      : 'Test Connection'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMode('edit')}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode('confirm-disconnect')}
                  className="text-destructive hover:text-destructive"
                >
                  Disconnect
                </Button>
              </motion.div>
            )}

            {mode === 'edit' && (
              <motion.div
                key="edit"
                className="space-y-3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Input
                  label="Connection name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMode('view');
                      setEditName(connection.displayName);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </motion.div>
            )}

            {mode === 'confirm-disconnect' && (
              <motion.div
                key="confirm"
                className="space-y-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <p className="text-sm text-destructive">
                  Disconnect {connection.displayName}? This cannot be undone.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="danger" size="sm" onClick={handleDisconnect} loading={deleting}>
                    Disconnect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
                    Cancel
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {testError && <p className="mt-2 text-xs text-destructive">{testError}</p>}
        </div>
      </div>
    </motion.div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/connections/ConnectionExpandPanel.tsx
git commit -m "feat(studio): add inline ConnectionExpandPanel with test/edit/disconnect"
```

---

## Task 6: Create Connection Modal

**Files:**

- Create: `apps/studio/src/components/connections/CreateConnectionModal.tsx`

Three-step modal: pick connector → configure → success. Replaces the separate create page.

**Step 1: Write the component**

This is the largest component. Key sections:

- Step 1: Connector picker with search + category grouping
- Step 2: Configure (name + auth) — reuses agent-desktop credential forms for agent_desktop category, connector auth for tools
- Step 3: Success animation

```tsx
// apps/studio/src/components/connections/CreateConnectionModal.tsx
'use client';

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ArrowLeft, Check, Search } from 'lucide-react';
import { useAvailableConnectors, type ConnectorSummary } from '../../hooks/useAvailableConnectors';
import { createConnection } from '../../api/connections';
import { getConnectorCategory, getCategoryLabel, CATEGORY_ORDER } from './connector-categories';
import { ConnectorLogo } from './ConnectorLogo';
import { getProviderDef, AGENT_DESKTOP_PROVIDERS } from './agent-desktop-registry';
import { OAuthFlowDialog } from './OAuthFlowDialog';
import { sanitizeError } from '../../lib/sanitize-error';

interface CreateConnectionModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}

type Step = 'pick' | 'configure' | 'success';

export function CreateConnectionModal({
  open,
  onClose,
  projectId,
  onCreated,
}: CreateConnectionModalProps) {
  const { connectors } = useAvailableConnectors(projectId);
  const [step, setStep] = useState<Step>('pick');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ConnectorSummary | null>(null);
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthConnector, setOauthConnector] = useState<{
    name: string;
    authorizationUrl: string;
  } | null>(null);

  function reset() {
    setStep('pick');
    setSearch('');
    setSelected(null);
    setName('');
    setCredentials({});
    setCreating(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSelect(connector: ConnectorSummary) {
    setSelected(connector);
    setName(`My ${connector.displayName}`);
    setCredentials({});
    setError(null);
    setStep('configure');
  }

  async function handleCreate() {
    if (!selected) return;
    setCreating(true);
    setError(null);
    try {
      await createConnection(projectId, {
        connectorName: selected.name,
        displayName: name,
        authType: selected.authType,
        credentials,
      });
      setStep('success');
      onCreated();
    } catch (err) {
      setError(sanitizeError(err));
    } finally {
      setCreating(false);
    }
  }

  // Group connectors by category
  const grouped = useMemo(() => {
    const filtered = (connectors ?? []).filter(
      (c) =>
        !search ||
        c.displayName.toLowerCase().includes(search.toLowerCase()) ||
        c.name.toLowerCase().includes(search.toLowerCase()),
    );
    const groups = new Map<string, ConnectorSummary[]>();
    for (const c of filtered) {
      const cat = getConnectorCategory(c.name);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => ({
      category: cat,
      label: getCategoryLabel(cat),
      connectors: groups.get(cat)!,
    }));
  }, [connectors, search]);

  // Credential fields for the selected connector
  const providerDef = selected ? getProviderDef(selected.name) : undefined;

  return (
    <>
      <Dialog open={open} onClose={handleClose} title="" maxWidth="lg">
        <AnimatePresence mode="wait">
          {step === 'pick' && (
            <motion.div
              key="pick"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <h2 className="text-lg font-semibold text-foreground mb-4">New Connection</h2>
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
                <input
                  type="text"
                  placeholder="Search connectors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-default bg-background pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  autoFocus
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto space-y-5">
                {grouped.map(({ category, label, connectors: cats }) => (
                  <div key={category}>
                    <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                      {label}
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      {cats.map((c) => (
                        <button
                          key={c.name}
                          onClick={() => handleSelect(c)}
                          className="group flex flex-col items-center gap-1.5 rounded-lg border border-default p-3 hover:border-accent transition-colors duration-150"
                        >
                          <ConnectorLogo
                            name={c.name}
                            className="h-10 w-10 grayscale group-hover:grayscale-0 transition-[filter] duration-150"
                          />
                          <span className="text-xs text-foreground text-center leading-tight">
                            {c.displayName}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {grouped.length === 0 && (
                  <p className="text-sm text-muted text-center py-8">
                    No connectors match "{search}"
                  </p>
                )}
              </div>
            </motion.div>
          )}

          {step === 'configure' && selected && (
            <motion.div
              key="configure"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={() => setStep('pick')}
                  className="text-muted hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <h2 className="text-lg font-semibold text-foreground">
                  Connect {selected.displayName}
                </h2>
              </div>

              <div className="flex items-center gap-3 mb-6">
                <ConnectorLogo name={selected.name} className="h-12 w-12" />
                <div>
                  <p className="text-sm font-medium text-foreground">{selected.displayName}</p>
                  <p className="text-xs text-muted">
                    {selected.actions?.length ?? 0} actions, {selected.triggers?.length ?? 0}{' '}
                    triggers
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <Input
                  label="Connection name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />

                {/* Auth fields */}
                {selected.authType === 'oauth2' ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      // TODO: Build authorization URL from connector metadata
                      // For now, trigger OAuth flow placeholder
                    }}
                    className="w-full"
                  >
                    Connect with {selected.displayName} →
                  </Button>
                ) : (
                  <>
                    {providerDef?.fields.map((field) => (
                      <Input
                        key={field.name}
                        label={field.label}
                        type={field.secret ? 'password' : 'text'}
                        value={credentials[field.name] ?? ''}
                        onChange={(e) =>
                          setCredentials((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                      />
                    )) ?? (
                      <Input
                        label="API Key"
                        type="password"
                        value={credentials.apiKey ?? ''}
                        onChange={(e) =>
                          setCredentials((prev) => ({ ...prev, apiKey: e.target.value }))
                        }
                      />
                    )}
                    <Button
                      variant="primary"
                      onClick={handleCreate}
                      loading={creating}
                      className="w-full"
                    >
                      Create Connection
                    </Button>
                  </>
                )}

                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>

              {/* Preview */}
              {(selected.actions?.length ?? 0) > 0 && (
                <div className="mt-6 border-t border-default pt-4">
                  <h4 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                    What you'll get
                  </h4>
                  <p className="text-xs text-muted">
                    Actions:{' '}
                    {selected.actions
                      ?.slice(0, 3)
                      .map((a) => a.displayName)
                      .join(', ')}
                    {(selected.actions?.length ?? 0) > 3 &&
                      `, +${(selected.actions?.length ?? 0) - 3} more`}
                  </p>
                  {(selected.triggers?.length ?? 0) > 0 && (
                    <p className="text-xs text-muted mt-1">
                      Triggers:{' '}
                      {selected.triggers
                        ?.slice(0, 3)
                        .map((t) => t.displayName)
                        .join(', ')}
                      {(selected.triggers?.length ?? 0) > 3 &&
                        `, +${(selected.triggers?.length ?? 0) - 3} more`}
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {step === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center py-8"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10"
              >
                <Check className="h-6 w-6 text-success" />
              </motion.div>
              <p className="mt-4 text-base font-medium text-foreground">
                {selected?.displayName} connected
              </p>
              <p className="mt-1 text-sm text-muted">Connection verified</p>
              <Button variant="primary" size="sm" onClick={handleClose} className="mt-6">
                Done
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </Dialog>

      {oauthConnector && (
        <OAuthFlowDialog
          open
          connector={oauthConnector}
          projectId={projectId}
          onSuccess={() => {
            setOauthConnector(null);
            setStep('success');
            onCreated();
          }}
          onClose={() => setOauthConnector(null)}
        />
      )}
    </>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/connections/CreateConnectionModal.tsx
git commit -m "feat(studio): add CreateConnectionModal with search, categories, and 3-step flow"
```

---

## Task 7: Connection Hub (Main Page Rewrite)

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionsPage.tsx` (full rewrite)

Replace the flat list with the Connection Hub: status bar + categorized grid + inline expand.

**Step 1: Read the existing `ConnectionsPage.tsx`**

Read: `apps/studio/src/components/connections/ConnectionsPage.tsx`

**Step 2: Rewrite the component**

```tsx
// apps/studio/src/components/connections/ConnectionsPage.tsx
'use client';

import { useState, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useConnections } from '../../hooks/useConnections';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { ConnectionCard } from './ConnectionCard';
import { ConnectionExpandPanel } from './ConnectionExpandPanel';
import { CreateConnectionModal } from './CreateConnectionModal';
import { ConnectorLogo } from './ConnectorLogo';
import { EmptyState } from '../ui/EmptyState';
import { Diamond } from 'lucide-react';
import { Button } from '../ui/Button';
import { getConnectorCategory, getCategoryLabel, CATEGORY_ORDER } from './connector-categories';
import type { ConnectionSummary } from '../../api/connections';

interface ConnectionsPageProps {
  projectId: string;
}

const POPULAR_CONNECTORS = ['slack', 'gmail', 'google-sheets', 'github'];

export function ConnectionsPage({ projectId }: ConnectionsPageProps) {
  const { connections, isLoading, refresh } = useConnections(projectId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Group connections by category
  const grouped = useMemo(() => {
    const groups = new Map<string, ConnectionSummary[]>();
    for (const c of connections) {
      const cat = getConnectorCategory(c.connectorName);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => ({
      category: cat,
      label: getCategoryLabel(cat),
      connections: groups.get(cat)!,
    }));
  }, [connections]);

  function handleToggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  // Loading skeleton
  if (isLoading && connections.length === 0) {
    return (
      <div className="space-y-4 p-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-surface-2" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-24 rounded-xl bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  // Empty state
  if (connections.length === 0) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-surface-2">
            <Diamond className="h-6 w-6 text-muted" />
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">Connect your tools</h2>
          <p className="mt-1 text-sm text-muted text-center max-w-xs">
            Link the services your agents need — CRMs, messaging, storage, and more.
          </p>
          <div className="mt-6 flex items-center gap-3">
            {POPULAR_CONNECTORS.map((name) => (
              <button
                key={name}
                onClick={() => setCreateOpen(true)}
                className="group flex flex-col items-center gap-1.5 rounded-lg border border-default p-3 hover:border-accent transition-colors duration-150"
              >
                <ConnectorLogo
                  name={name}
                  className="h-10 w-10 grayscale group-hover:grayscale-0 transition-[filter] duration-150"
                />
                <span className="text-xs text-muted">{name}</span>
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)} className="mt-4">
            Browse all connectors →
          </Button>
        </div>
        <CreateConnectionModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          projectId={projectId}
          onCreated={refresh}
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <ConnectionStatusBar connections={connections} onNewConnection={() => setCreateOpen(true)} />

      {grouped.map(({ category, label, connections: catConns }) => (
        <div key={category}>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{label}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {catConns.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                isExpanded={expandedId === conn.id}
                onClick={() => handleToggle(conn.id)}
              />
            ))}
            <AnimatePresence>
              {catConns.some((c) => c.id === expandedId) && (
                <ConnectionExpandPanel
                  connection={catConns.find((c) => c.id === expandedId)!}
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
        </div>
      ))}

      <CreateConnectionModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        onCreated={refresh}
      />
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add apps/studio/src/components/connections/ConnectionsPage.tsx
git commit -m "feat(studio): rewrite ConnectionsPage as Connection Hub with categories and inline expand"
```

---

## Task 8: Remove Detail Page & Update Routes

**Files:**

- Delete or empty: `apps/studio/src/components/connections/ConnectionDetailPage.tsx`
- Modify: `apps/studio/src/app/(app)/projects/[id]/connections/[connectionId]/page.tsx` — redirect to `/connections`

**Step 1: Check existing route file**

Read: `apps/studio/src/app/(app)/projects/[id]/connections/[connectionId]/page.tsx`

**Step 2: Replace with redirect**

Replace the detail page route with a redirect to the connections hub:

```tsx
import { redirect } from 'next/navigation';

export default function ConnectionDetailRedirect({ params }: { params: { id: string } }) {
  redirect(`/projects/${params.id}/connections`);
}
```

**Step 3: Check and update the create page route**

Read: `apps/studio/src/app/(app)/projects/[id]/connections/new/page.tsx`

Replace with redirect (creation is now a modal):

```tsx
import { redirect } from 'next/navigation';

export default function ConnectionCreateRedirect({ params }: { params: { id: string } }) {
  redirect(`/projects/${params.id}/connections`);
}
```

**Step 4: Commit**

```bash
git add apps/studio/src/app/(app)/projects/[id]/connections/
git commit -m "refactor(studio): redirect detail and create routes to connection hub"
```

---

## Task 9: Visual Polish & Prettier

**Files:**

- All new/modified files from Tasks 1-8

**Step 1: Run Prettier on all changed files**

```bash
npx prettier --write \
  apps/studio/src/components/connections/connector-categories.ts \
  apps/studio/src/components/connections/__tests__/connector-categories.test.ts \
  apps/studio/src/components/connections/ConnectionStatusBar.tsx \
  apps/studio/src/components/connections/ConnectionCard.tsx \
  apps/studio/src/components/connections/ConnectorLogo.tsx \
  apps/studio/src/components/connections/ConnectionExpandPanel.tsx \
  apps/studio/src/components/connections/CreateConnectionModal.tsx \
  apps/studio/src/components/connections/ConnectionsPage.tsx
```

**Step 2: Build check**

```bash
cd apps/studio && pnpm build
```

Fix any type errors or import issues.

**Step 3: Run existing tests**

```bash
cd apps/studio && pnpm test
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "style(studio): format connections hub components"
```

---

## Task 10: Manual Browser Verification

**Steps:**

1. Start Studio dev server: `cd apps/studio && pnpm dev`
2. Open `http://localhost:5173/projects/{projectId}/connections`
3. Verify:
   - Empty state shows diamond icon + popular connectors + "Browse all"
   - OR if connections exist: status bar shows aggregate count
   - Cards grouped by category with health dots
   - Card hover: lifts, border accent, logo colorizes
   - Card click: expand panel slides open with details + actions
   - Test button works (spinner → result)
   - "New Connection" opens modal
   - Modal: search filters, categories group, selecting opens step 2
   - Step 2: name field, auth fields, create button
   - Step 3: success checkmark animation
   - Closing modal: new card appears in grid
4. Verify `/connections/[id]` redirects to `/connections`
5. Verify `/connections/new` redirects to `/connections`

---

## Summary

| Task | Component                 | Action             |
| ---- | ------------------------- | ------------------ |
| 1    | connector-categories.ts   | Create (with test) |
| 2    | ConnectionStatusBar.tsx   | Create             |
| 3    | ConnectionCard.tsx        | Rewrite            |
| 4    | ConnectorLogo.tsx         | Create             |
| 5    | ConnectionExpandPanel.tsx | Create             |
| 6    | CreateConnectionModal.tsx | Create             |
| 7    | ConnectionsPage.tsx       | Rewrite            |
| 8    | Route redirects           | Modify             |
| 9    | Prettier + build check    | Polish             |
| 10   | Browser verification      | Manual             |
