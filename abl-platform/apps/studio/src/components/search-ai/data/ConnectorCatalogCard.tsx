'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { ConnectorLogo } from '../../connections/ConnectorLogo';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Tooltip, TooltipProvider } from '../../ui/Tooltip';
import type { CatalogConnectorEntry } from './connector-catalog-registry';

interface ConnectorCatalogCardProps {
  connector: CatalogConnectorEntry;
  isConnected?: boolean;
  documentCount?: number;
  onAction: (connector: CatalogConnectorEntry) => void;
}

/** Convert registry name (underscores) to icon registry key (hyphens). */
function toIconName(name: string): string {
  return name.replace(/_/g, '-');
}

export function ConnectorCatalogCard({
  connector,
  isConnected = false,
  documentCount,
  onAction,
}: ConnectorCatalogCardProps) {
  const t = useTranslations('search_ai.connector_catalog');

  return (
    <TooltipProvider>
      <Tooltip content={connector.description} side="bottom" delay={400}>
        <div>
          <motion.div
            className={clsx(
              'relative rounded-lg border p-2.5 transition-colors duration-150 cursor-default',
              isConnected
                ? 'border-l-2 border-l-success border-t-default border-r-default border-b-default bg-background'
                : 'border-default bg-background hover:border-accent',
            )}
            whileHover={{ y: -1 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            <div className="flex items-start gap-2.5">
              <ConnectorLogo
                name={toIconName(connector.name)}
                className="h-7 w-7 shrink-0 mt-0.5"
              />
              <div className="min-w-0 flex-1">
                {/* Row 1: Name — full width, no button competing */}
                <p className="text-[13px] font-medium text-foreground truncate leading-5">
                  {connector.displayName}
                </p>
                {/* Row 2: Description + Action button */}
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <p className="text-xs text-muted truncate leading-4 flex-1 min-w-0">
                    {connector.description}
                  </p>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0"
                    onClick={() => onAction(connector)}
                  >
                    {isConnected ? t('button_manage') : t('button_connect')}
                  </Button>
                </div>
                {isConnected && (
                  <div className="mt-1.5">
                    <Badge variant="success" dot>
                      {t('status_connected')}
                      {documentCount !== undefined && documentCount !== null
                        ? ` (${documentCount})`
                        : ''}
                    </Badge>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      </Tooltip>
    </TooltipProvider>
  );
}
