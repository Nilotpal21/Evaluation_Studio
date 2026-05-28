/**
 * ConfigDiffViewer Component
 *
 * Side-by-side diff display of config version changes.
 */

import { useTranslations } from 'next-intl';
import { Badge } from '../../../ui/Badge';

interface DiffChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  type: 'added' | 'removed' | 'changed';
}

interface ConfigDiffViewerProps {
  fromVersion: number;
  toVersion: number;
  changes: DiffChange[];
}

const typeBadgeVariant: Record<string, 'success' | 'error' | 'warning'> = {
  added: 'success',
  removed: 'error',
  changed: 'warning',
};

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function ConfigDiffViewer({ fromVersion, toVersion, changes }: ConfigDiffViewerProps) {
  const t = useTranslations('search_ai.sharepoint.config.history');

  if (changes.length === 0) {
    return <div className="p-4 text-sm text-muted text-center">{t('diff_no_changes')}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>v{fromVersion}</span>
        <span>&rarr;</span>
        <span>v{toVersion}</span>
        <span className="ml-auto">{t('diff_change_count', { count: changes.length })}</span>
      </div>

      <div className="rounded-lg border border-default overflow-hidden">
        {changes.map((change, i) => (
          <div
            key={change.path}
            className={`flex items-start gap-3 p-3 ${i > 0 ? 'border-t border-default' : ''}`}
          >
            <div className="shrink-0 pt-0.5">
              <Badge variant={typeBadgeVariant[change.type] ?? 'default'}>{change.type}</Badge>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono font-medium text-foreground">{change.path}</p>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <div className="text-xs">
                  <span className="text-muted">{t('diff_old')}:</span>
                  <pre className="text-error/80 mt-0.5 whitespace-pre-wrap break-all font-mono text-xs">
                    {formatValue(change.oldValue)}
                  </pre>
                </div>
                <div className="text-xs">
                  <span className="text-muted">{t('diff_new')}:</span>
                  <pre className="text-success/80 mt-0.5 whitespace-pre-wrap break-all font-mono text-xs">
                    {formatValue(change.newValue)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
