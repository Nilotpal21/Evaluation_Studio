/**
 * ABL Diagnostics Panel
 *
 * Bottom panel displaying diagnostics from the ABL language service.
 * Shows severity-grouped counts in a status bar and a scrollable list
 * of diagnostic rows. Clicking a row navigates the editor to that line.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { XCircle, AlertTriangle, Info, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { Diagnostic } from '@abl/language-service';

interface ABLDiagnosticsPanelProps {
  diagnostics: Diagnostic[];
  onNavigate: (line: number) => void;
  onClose: () => void;
}

const severityConfig = {
  error: {
    Icon: XCircle,
    iconClass: 'text-error',
    rowClass: 'hover:bg-error-subtle',
    label: 'error',
    badgeClass: 'text-error',
  },
  warning: {
    Icon: AlertTriangle,
    iconClass: 'text-warning',
    rowClass: 'hover:bg-warning/5',
    label: 'warning',
    badgeClass: 'text-warning',
  },
  info: {
    Icon: Info,
    iconClass: 'text-info',
    rowClass: 'hover:bg-info/5',
    label: 'info',
    badgeClass: 'text-info',
  },
  hint: {
    Icon: Info,
    iconClass: 'text-subtle',
    rowClass: 'hover:bg-background-muted',
    label: 'hint',
    badgeClass: 'text-subtle',
  },
} as const;

export function ABLDiagnosticsPanel({
  diagnostics,
  onNavigate,
  onClose,
}: ABLDiagnosticsPanelProps) {
  const t = useTranslations('abl_editor');
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const d of diagnostics) {
      if (d.severity === 'error') errors++;
      else if (d.severity === 'warning') warnings++;
      else infos++;
    }
    return { errors, warnings, infos };
  }, [diagnostics]);

  type SourceFilter = 'all' | 'syntax' | 'structural' | 'compile';
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  const filteredDiagnostics = useMemo(() => {
    if (sourceFilter === 'all') return diagnostics;
    return diagnostics.filter((d) => d.source === sourceFilter);
  }, [diagnostics, sourceFilter]);

  return (
    <div className="flex flex-col border-t border-default bg-background-subtle min-h-[300px] max-h-[300px]">
      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-default bg-background-subtle">
        <div className="flex items-center gap-4 text-xs">
          <span className="font-medium text-muted">{t('problems')}</span>

          {counts.errors > 0 && (
            <span className="flex items-center gap-1 text-error">
              <XCircle className="w-3.5 h-3.5" />
              {counts.errors}
            </span>
          )}

          {counts.warnings > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              {counts.warnings}
            </span>
          )}

          {counts.infos > 0 && (
            <span className="flex items-center gap-1 text-info">
              <Info className="w-3.5 h-3.5" />
              {counts.infos}
            </span>
          )}

          {diagnostics.length === 0 && <span className="text-subtle">{t('no_problems')}</span>}
        </div>

        <div className="flex items-center gap-1 ml-4 border-l border-default pl-4">
          {(['all', 'syntax', 'structural', 'compile'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setSourceFilter(filter)}
              className={clsx(
                'px-2 py-0.5 text-xs rounded transition-default',
                sourceFilter === filter
                  ? 'bg-accent-subtle text-accent font-medium'
                  : 'text-subtle hover:text-muted hover:bg-background-muted',
              )}
            >
              {t(`filter_${filter}`)}
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded text-muted hover:text-foreground hover:bg-background-muted transition-default"
          aria-label="Close diagnostics panel"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      {/* Diagnostic rows */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {filteredDiagnostics.length === 0 ? (
          <div className="px-3 py-4 text-xs text-subtle text-center">{t('no_diagnostics')}</div>
        ) : (
          <div className="py-0.5">
            {filteredDiagnostics.map((diagnostic, index) => {
              const config = severityConfig[diagnostic.severity] ?? severityConfig.info;
              const SeverityIcon = config.Icon;

              return (
                <button
                  key={`${diagnostic.severity}-${diagnostic.line}-${diagnostic.column}-${index}`}
                  className={clsx(
                    'w-full flex items-start gap-2 px-3 py-1 text-left transition-default cursor-pointer',
                    config.rowClass,
                  )}
                  onClick={() => onNavigate(diagnostic.line)}
                >
                  <SeverityIcon
                    className={clsx('w-3.5 h-3.5 flex-shrink-0 mt-0.5', config.iconClass)}
                  />

                  <span className="text-xs font-mono text-foreground truncate flex-1">
                    {diagnostic.message}
                  </span>

                  <span className="text-xs font-mono text-subtle flex-shrink-0">
                    [{diagnostic.line}:{diagnostic.column}]
                  </span>

                  {diagnostic.source && (
                    <span className="text-xs text-subtle flex-shrink-0">({diagnostic.source})</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ABLDiagnosticsPanel;
