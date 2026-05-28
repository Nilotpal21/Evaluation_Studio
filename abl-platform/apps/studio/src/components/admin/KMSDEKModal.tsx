'use client';

import { useTranslations } from 'next-intl';
import { Key } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import type { KMSDEKEntry } from '../../hooks/useKMS';
import { compactNumber, formatTimestamp, humanizeProvider, providerVariant } from './kms-utils';

function statusVariant(status: KMSDEKEntry['status']): 'success' | 'warning' | 'error' | 'default' {
  switch (status) {
    case 'active':
      return 'success';
    case 'decrypt_only':
      return 'warning';
    case 'destroyed':
      return 'error';
    default:
      return 'default';
  }
}

interface KMSDEKModalProps {
  entry: KMSDEKEntry | null;
  onClose: () => void;
}

export function KMSDEKModal({ entry, onClose }: KMSDEKModalProps) {
  const t = useTranslations('admin');

  if (!entry) return null;

  const usageText = `${entry.usageCount.toLocaleString()} / ${compactNumber(entry.maxUsageCount)}`;
  const usagePercent =
    entry.maxUsageCount > 0 ? ((entry.usageCount / entry.maxUsageCount) * 100).toFixed(4) : '0';

  const scopeLabel = (value: string) => {
    switch (value) {
      case '_tenant':
        return 'Tenant Default';
      case '_project':
        return 'Project Default';
      default:
        return value;
    }
  };

  const detailCells = [
    { key: t('kms.dek_modal_scope'), value: scopeLabel(entry.projectId) },
    {
      key: t('kms.dek_modal_environment'),
      value: scopeLabel(entry.environment),
    },
    {
      key: t('kms.dek_modal_provider'),
      badge: true,
      value: humanizeProvider(entry.wrappingProvider?.providerType),
    },
    {
      key: t('kms.dek_modal_kek_key_id'),
      mono: true,
      value: entry.kekKeyId || '--',
    },
  ];

  const lifecycleCells = [
    {
      key: t('kms.dek_modal_created'),
      value: formatTimestamp(entry.createdAt),
    },
    {
      key: t('kms.dek_modal_expires'),
      value: formatTimestamp(entry.expiresAt),
    },
    {
      key: t('kms.dek_modal_retired'),
      value: formatTimestamp(entry.retiredAt),
    },
    {
      key: t('kms.dek_modal_destroyed'),
      value: formatTimestamp(entry.destroyedAt),
    },
  ];

  return (
    <Dialog open={!!entry} onClose={onClose} maxWidth="lg">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-success-subtle text-success">
            <Key className="h-[18px] w-[18px]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <code className="rounded bg-background-muted px-1.5 py-0.5 text-sm font-medium text-foreground">
                {entry.dekId}
              </code>
              <Badge variant={statusVariant(entry.status)} dot>
                {entry.status}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-foreground-subtle">
              {t('kms.dek_modal_epoch', {
                epoch: entry.epoch,
                version: entry.kekKeyVersion,
              })}
            </p>
          </div>
        </div>

        {/* Usage */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
              {t('kms.dek_modal_usage')}
            </span>
            <span className="text-sm font-semibold text-foreground">{usageText}</span>
          </div>
          <p className="text-xs text-foreground-subtle">
            {t('kms.dek_modal_usage_percent', { percent: usagePercent })}
          </p>
        </div>

        {/* Details Grid */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground-subtle">
            {t('kms.dek_modal_details')}
          </p>
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border-muted">
            {detailCells.map((cell, i) => (
              <div
                key={cell.key}
                className={`bg-background-subtle px-3.5 py-3 ${
                  i < detailCells.length - 2 ? 'border-b border-border-muted/60' : ''
                } ${i % 2 === 0 ? 'border-r border-border-muted/60' : ''}`}
              >
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                  {cell.key}
                </p>
                {cell.badge ? (
                  <Badge variant={providerVariant(entry.wrappingProvider?.providerType)}>
                    {cell.value}
                  </Badge>
                ) : (
                  <p
                    className={`text-sm font-medium text-foreground ${cell.mono ? 'font-mono text-xs' : ''}`}
                  >
                    {cell.value}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Lifecycle Grid */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground-subtle">
            {t('kms.dek_modal_lifecycle')}
          </p>
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border-muted">
            {lifecycleCells.map((cell, i) => (
              <div
                key={cell.key}
                className={`bg-background-subtle px-3.5 py-3 ${
                  i < lifecycleCells.length - 2 ? 'border-b border-border-muted/60' : ''
                } ${i % 2 === 0 ? 'border-r border-border-muted/60' : ''}`}
              >
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                  {cell.key}
                </p>
                <p
                  className={`text-sm font-medium ${cell.value === '--' ? 'text-foreground-subtle' : 'text-foreground'}`}
                >
                  {cell.value}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-border-muted pt-4">
          <Button variant="secondary" onClick={onClose}>
            {t('kms.dek_modal_close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
