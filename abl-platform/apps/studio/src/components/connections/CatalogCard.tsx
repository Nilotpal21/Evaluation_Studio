'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { ConnectorLogo } from './ConnectorLogo';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { getAuthTypeShortLabel } from '../auth-profiles/auth-type-metadata';

export interface CatalogConnector {
  name: string;
  displayName: string;
  description?: string;
  category: string;
  authType: string;
  availableAuthTypes?: string[];
  actions: { name: string; displayName: string; description: string }[];
  triggers: { name: string; displayName: string; description: string }[];
}

const getAuthTypeLabel = getAuthTypeShortLabel;

interface CatalogCardProps {
  connector: CatalogConnector;
  /** True when at least one auth profile is configured for this integration. */
  isConfigured: boolean;
  /** Number of auth profiles configured for this integration. */
  profileCount?: number;
  onConnect: () => void;
  /** Open the integration detail side panel. Triggered when the card body is clicked. */
  onOpenDetails?: () => void;
}

export function CatalogCard({
  connector,
  isConfigured,
  profileCount = 0,
  onConnect,
  onOpenDetails,
}: CatalogCardProps) {
  const authTypes =
    connector.availableAuthTypes && connector.availableAuthTypes.length > 0
      ? connector.availableAuthTypes
      : connector.authType
        ? [connector.authType]
        : [];

  const capabilitySummary = [
    connector.actions.length > 0
      ? `${connector.actions.length} action${connector.actions.length !== 1 ? 's' : ''}`
      : null,
    connector.triggers.length > 0
      ? `${connector.triggers.length} trigger${connector.triggers.length !== 1 ? 's' : ''}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const interactive = Boolean(onOpenDetails);

  return (
    <motion.div
      className={clsx(
        'relative flex flex-col rounded-xl border p-4 transition-colors duration-150',
        isConfigured
          ? 'border-success/30 bg-background'
          : 'border-default bg-background hover:border-accent',
        interactive &&
          'cursor-pointer focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2 focus:ring-offset-background',
      )}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `View ${connector.displayName} details` : undefined}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (!onOpenDetails) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {/* Configured badge — auth profiles count, not legacy connections */}
      {isConfigured && (
        <div className="absolute top-3 right-3 flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {profileCount} profile{profileCount === 1 ? '' : 's'}
        </div>
      )}

      {/* Header: icon + name + capability */}
      <div className="flex items-center gap-3">
        <ConnectorLogo name={connector.name} className="h-11 w-11" />
        <div className="min-w-0 flex-1 pr-16">
          <p className="truncate text-sm font-semibold text-foreground">{connector.displayName}</p>
          {capabilitySummary && <p className="mt-0.5 text-xs text-muted">{capabilitySummary}</p>}
        </div>
      </div>

      {/* Description */}
      {connector.description && (
        <p className="mt-3 mb-3 text-xs text-muted line-clamp-2 leading-relaxed">
          {connector.description}
        </p>
      )}

      {/* Footer: auth method chips + Manage CTA (configured only).
          `mt-auto` keeps the footer pinned to the bottom edge so chips line up
          across cards regardless of description length. */}
      <div className="mt-auto flex items-center gap-2 pt-3 border-t border-default">
        {authTypes.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {authTypes.map((authType) => (
              <Badge key={authType} variant="default" appearance="outlined">
                {getAuthTypeLabel(authType)}
              </Badge>
            ))}
          </div>
        )}
        {isConfigured && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                onConnect();
              }}
            >
              Manage
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
