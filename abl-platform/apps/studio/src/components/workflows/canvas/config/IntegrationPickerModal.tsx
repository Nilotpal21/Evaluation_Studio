/**
 * IntegrationPickerModal Component
 *
 * Two-screen modal dialog for selecting an integration and action:
 * - Screen 1: Tile grid of available integrations with action count badges
 * - Screen 2: Action list for the selected integration with name + description
 */

'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { Dialog } from '../../../ui/Dialog';
import { ConnectorLogo } from '../../../connections/ConnectorLogo';

// ─── Types ──────────────────────────────────────────────────────────────

interface CatalogAction {
  name: string;
  displayName: string;
  description: string;
}

export interface CatalogConnector {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  /** Primary auth type for this connector (e.g. 'none', 'api_key', 'oauth2_app'). */
  authType?: string;
  /** All auth types this connector supports. */
  availableAuthTypes?: string[];
  actions: CatalogAction[];
}

export interface ActionWithProps {
  name: string;
  displayName: string;
  description: string;
  props: Array<{
    name: string;
    displayName: string;
    description?: string;
    type: string;
    required: boolean;
    defaultValue?: unknown;
    options?: Array<{ label: string; value: string | number }>;
  }>;
}

interface IntegrationPickerModalProps {
  open: boolean;
  onClose: () => void;
  catalog: CatalogConnector[];
  onSelect: (connectorId: string, actionName: string) => void;
  /** Pre-selected connector to open on Screen 2 directly */
  initialConnectorId?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export function IntegrationPickerModal({
  open,
  onClose,
  catalog,
  onSelect,
  initialConnectorId,
}: IntegrationPickerModalProps) {
  const [selectedConnector, setSelectedConnector] = useState<string | null>(
    initialConnectorId ?? null,
  );
  const [search, setSearch] = useState('');

  // Sync selectedConnector when modal re-opens or initialConnectorId changes
  useEffect(() => {
    if (open) {
      setSelectedConnector(initialConnectorId ?? null);
    }
  }, [open, initialConnectorId]);

  // Reset state when modal closes
  const handleClose = useCallback(() => {
    setSelectedConnector(initialConnectorId ?? null);
    setSearch('');
    onClose();
  }, [onClose, initialConnectorId]);

  const handleBack = useCallback(() => {
    setSelectedConnector(null);
    setSearch('');
  }, []);

  const handleSelectAction = useCallback(
    (connectorId: string, actionName: string) => {
      onSelect(connectorId, actionName);
      handleClose();
    },
    [onSelect, handleClose],
  );

  const connector = useMemo(
    () => catalog.find((c) => c.name === selectedConnector),
    [catalog, selectedConnector],
  );

  return (
    <Dialog open={open} onClose={handleClose} title="Select Integration" maxWidth="2xl">
      <div className="min-h-[400px] max-h-[600px] flex flex-col">
        {selectedConnector && connector ? (
          <ActionListScreen
            connector={connector}
            search={search}
            onSearchChange={setSearch}
            onBack={handleBack}
            onSelectAction={(actionName) => handleSelectAction(selectedConnector, actionName)}
          />
        ) : (
          <IntegrationGridScreen
            catalog={catalog}
            search={search}
            onSearchChange={setSearch}
            onSelectConnector={(name) => {
              setSelectedConnector(name);
              setSearch('');
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

// ─── Screen 1: Integration Tile Grid ─────────────────────────────────────

function IntegrationGridScreen({
  catalog,
  search,
  onSearchChange,
  onSelectConnector,
}: {
  catalog: CatalogConnector[];
  search: string;
  onSearchChange: (v: string) => void;
  onSelectConnector: (name: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!search) return catalog;
    const lower = search.toLowerCase();
    return catalog.filter(
      (c) =>
        c.displayName.toLowerCase().includes(lower) ||
        c.name.toLowerCase().includes(lower) ||
        (c.category ?? '').toLowerCase().includes(lower),
    );
  }, [catalog, search]);

  return (
    <>
      {/* Search */}
      <div className="px-1 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className={clsx(
              'w-full rounded-lg border border-default bg-background-subtle',
              'text-sm text-foreground placeholder:text-subtle',
              'py-2 pl-10 pr-3',
              'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
              'transition-default',
            )}
            placeholder="Search integrations..."
            autoFocus
          />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-1">
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-subtle">No integrations found</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {filtered.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => onSelectConnector(c.name)}
                className={clsx(
                  'flex flex-col items-center gap-2 p-4 rounded-lg border border-default',
                  'hover:border-border-focus hover:bg-background-muted',
                  'transition-default text-center group',
                )}
              >
                <ConnectorLogo name={c.name} className="w-10 h-10" />
                <span className="text-sm font-medium text-foreground truncate w-full">
                  {c.displayName}
                </span>
                <span className="text-xs text-subtle">
                  {c.actions.length} action{c.actions.length !== 1 ? 's' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Screen 2: Action List ───────────────────────────────────────────────

function ActionListScreen({
  connector,
  search,
  onSearchChange,
  onBack,
  onSelectAction,
}: {
  connector: CatalogConnector;
  search: string;
  onSearchChange: (v: string) => void;
  onBack: () => void;
  onSelectAction: (actionName: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!search) return connector.actions;
    const lower = search.toLowerCase();
    return connector.actions.filter(
      (a) =>
        a.displayName.toLowerCase().includes(lower) || a.description.toLowerCase().includes(lower),
    );
  }, [connector.actions, search]);

  return (
    <>
      {/* Header with back */}
      <div className="flex items-center gap-2 pb-3 px-1">
        <button
          type="button"
          onClick={onBack}
          className="p-1 rounded hover:bg-background-muted transition-colors text-subtle hover:text-foreground"
          aria-label="Back to integrations"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <ConnectorLogo name={connector.name} className="w-7 h-7" />
        <span className="text-sm font-semibold text-foreground">{connector.displayName}</span>
      </div>

      {/* Search */}
      <div className="px-1 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className={clsx(
              'w-full rounded-lg border border-default bg-background-subtle',
              'text-sm text-foreground placeholder:text-subtle',
              'py-2 pl-10 pr-3',
              'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
              'transition-default',
            )}
            placeholder="Search actions..."
            autoFocus
          />
        </div>
      </div>

      {/* Action list */}
      <div className="flex-1 overflow-y-auto px-1 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-subtle">No actions found</p>
          </div>
        ) : (
          filtered.map((action) => (
            <button
              key={action.name}
              type="button"
              onClick={() => onSelectAction(action.name)}
              className={clsx(
                'w-full text-left px-4 py-3 rounded-lg border border-default',
                'hover:border-border-focus hover:bg-background-muted',
                'transition-default',
              )}
            >
              <p className="text-sm font-medium text-foreground">{action.displayName}</p>
              {action.description && (
                <p className="text-xs text-subtle mt-0.5 line-clamp-2">{action.description}</p>
              )}
            </button>
          ))
        )}
      </div>
    </>
  );
}
