'use client';

/**
 * ExternalAppCatalog
 *
 * Displays a grid of connectors that have workflow triggers.
 * Fetches real connector data from the trigger catalog endpoint.
 * Each card shows the app name, trigger count, and is clickable
 * when an onSelect handler is provided.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plug } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch, handleResponse } from '../../../lib/api-client';
import { sanitizeError } from '../../../lib/sanitize-error';
import { ConnectorLogo } from '../../connections/ConnectorLogo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TriggerItem {
  name: string;
  displayName: string;
  description: string;
  strategy: string;
}

interface CatalogConnector {
  name: string;
  displayName: string;
  description: string;
  auth: { type: string };
  triggers: TriggerItem[];
}

interface CatalogResponse {
  success: boolean;
  data: CatalogConnector[];
}

interface ExternalAppCatalogProps {
  /** When provided, cards become clickable and call this with the connector name */
  onSelect?: (connectorName: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExternalAppCatalog({ onSelect }: ExternalAppCatalogProps) {
  const t = useTranslations('workflows.triggers');

  const [items, setItems] = useState<CatalogConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCatalog() {
      try {
        const response = await apiFetch('/api/connectors/triggers/catalog');
        const result = await handleResponse<CatalogResponse>(response);
        if (!cancelled) {
          setItems(result.data ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(sanitizeError(err, 'Failed to load app catalog'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [items]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-xs text-error">{error}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-8">
        <Plug className="w-6 h-6 text-muted mx-auto mb-2" />
        <p className="text-sm text-muted">{t('external_apps')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">{t('external_apps')}</h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {sortedItems.map((connector) => {
          const isClickable = Boolean(onSelect);
          const Tag = isClickable ? 'button' : 'div';
          return (
            <Tag
              key={connector.name}
              data-testid={`catalog-app-${connector.name}`}
              {...(isClickable ? { onClick: () => onSelect?.(connector.name) } : {})}
              className={clsx(
                'flex items-center gap-3 rounded-xl border border-default',
                'bg-background-elevated p-3 shadow-sm text-left',
                isClickable
                  ? 'hover:border-accent/50 hover:bg-accent/5 cursor-pointer transition-default'
                  : 'cursor-default',
              )}
            >
              <ConnectorLogo name={connector.name} className="w-9 h-9" />

              {/* Name + trigger count */}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {connector.displayName}
                </p>
                <p className="text-xs text-muted">
                  {connector.triggers.length} trigger
                  {connector.triggers.length !== 1 ? 's' : ''}
                </p>
              </div>
            </Tag>
          );
        })}
      </div>
    </div>
  );
}
