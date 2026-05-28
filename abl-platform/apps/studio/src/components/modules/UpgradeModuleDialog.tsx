/**
 * UpgradeModuleDialog Component
 *
 * Shows a structured diff between the currently-pinned release and a target
 * release, including contract changes, prerequisite issues, and mounted symbol
 * changes. The user can review and confirm the upgrade.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ArrowUpCircle,
  Bot,
  Wrench,
  Plus,
  Minus,
} from 'lucide-react';

import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  getUpgradeDiff,
  upgradeDependency,
  type UpgradeDiff,
  type ContractDiffEntry,
} from '../../api/modules';

// =============================================================================
// TYPES
// =============================================================================

interface UpgradeModuleDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  dependencyId: string;
  targetReleaseId: string;
  targetVersion: string;
  currentVersion: string;
  onUpgradeComplete?: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

function severityBadge(
  severity: 'breaking' | 'non-breaking' | 'warn',
  t: (key: string) => string,
): React.ReactNode {
  const variantMap = {
    breaking: 'error' as const,
    'non-breaking': 'success' as const,
    warn: 'warning' as const,
  };
  const labelMap = {
    breaking: t('breaking'),
    'non-breaking': t('nonBreaking'),
    warn: t('warn'),
  };
  return <Badge variant={variantMap[severity]}>{labelMap[severity]}</Badge>;
}

function changeBadge(change: 'added' | 'removed' | 'modified'): React.ReactNode {
  if (change === 'added') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-success">
        <Plus className="w-3 h-3" />
      </span>
    );
  }
  if (change === 'removed') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-error">
        <Minus className="w-3 h-3" />
      </span>
    );
  }
  return null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function UpgradeModuleDialog({
  open,
  onClose,
  projectId,
  dependencyId,
  targetReleaseId,
  targetVersion,
  currentVersion,
  onUpgradeComplete,
}: UpgradeModuleDialogProps) {
  const t = useTranslations('modules.upgrade');

  const [diffData, setDiffData] = useState<UpgradeDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // Load diff when dialog opens
  useEffect(() => {
    if (!open || !dependencyId || !targetReleaseId) {
      setDiffData(null);
      setDiffError(null);
      return;
    }

    setDiffLoading(true);
    setDiffError(null);

    getUpgradeDiff(projectId, dependencyId, targetReleaseId)
      .then((res) => {
        if (res.success) {
          setDiffData(res.data);
        }
      })
      .catch((err) => {
        setDiffError(sanitizeError(err, t('loadError')));
      })
      .finally(() => setDiffLoading(false));
  }, [open, projectId, dependencyId, targetReleaseId, t]);

  const handleClose = useCallback(() => {
    if (!upgrading) {
      onClose();
    }
  }, [upgrading, onClose]);

  const handleUpgrade = useCallback(async () => {
    if (!diffData) return;

    setUpgrading(true);
    try {
      await upgradeDependency(projectId, dependencyId, {
        targetReleaseId,
      });
      toast.success(t('success', { version: targetVersion }));
      onClose();
      onUpgradeComplete?.();
    } catch (err) {
      toast.error(sanitizeError(err, t('error')));
    } finally {
      setUpgrading(false);
    }
  }, [
    diffData,
    projectId,
    dependencyId,
    targetReleaseId,
    targetVersion,
    t,
    onClose,
    onUpgradeComplete,
  ]);

  const hasBlockingPrereqs = (diffData?.prerequisiteIssues ?? []).some(
    (i) => i.severity === 'breaking',
  );
  const hasBreakingChanges = diffData?.diff.hasBreakingChanges ?? false;

  // Collect all non-empty diff categories for display
  const diffCategories: Array<{ label: string; entries: ContractDiffEntry[] }> = [];
  if (diffData) {
    const { diff } = diffData;
    if (diff.agents.length > 0)
      diffCategories.push({ label: t('categoryAgents'), entries: diff.agents });
    if (diff.tools.length > 0)
      diffCategories.push({ label: t('categoryTools'), entries: diff.tools });
    if (diff.configKeys.length > 0)
      diffCategories.push({ label: t('categoryConfigKeys'), entries: diff.configKeys });
    if (diff.envVars.length > 0)
      diffCategories.push({ label: t('categoryEnvVars'), entries: diff.envVars });
    if (diff.authProfiles.length > 0)
      diffCategories.push({ label: t('categoryAuthProfiles'), entries: diff.authProfiles });
    if (diff.connectors.length > 0)
      diffCategories.push({ label: t('categoryConnectors'), entries: diff.connectors });
    if (diff.mcpServers.length > 0)
      diffCategories.push({ label: t('categoryMcpServers'), entries: diff.mcpServers });
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('title')}
      description={t('description', { currentVersion, targetVersion })}
      maxWidth="lg"
    >
      {/* Loading state */}
      {diffLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
          <span className="ml-2 text-sm text-muted">{t('loading')}</span>
        </div>
      )}

      {/* Error state */}
      {diffError && (
        <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-4">
          <div className="flex items-center gap-2 text-sm text-error">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{diffError}</span>
          </div>
        </div>
      )}

      {/* Diff content */}
      {diffData && !diffLoading && (
        <div className="space-y-5">
          {/* Summary */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="default">v{currentVersion}</Badge>
            <ArrowUpCircle className="w-4 h-4 text-muted" />
            <Badge variant="accent">v{targetVersion}</Badge>
            {hasBreakingChanges && (
              <Badge variant="error" dot>
                {t('breaking')}
              </Badge>
            )}
          </div>

          {/* Contract changes */}
          <div>
            <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
              {t('contractChanges')}
            </h3>
            {diffCategories.length === 0 ? (
              <p className="text-sm text-muted">{t('noChanges')}</p>
            ) : (
              <div className="space-y-3">
                {diffCategories.map((category) => (
                  <div key={category.label}>
                    <p className="text-xs font-medium text-muted mb-1.5">{category.label}</p>
                    <div className="space-y-1">
                      {category.entries.map((entry) => (
                        <div
                          key={`${entry.name}-${entry.change}`}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted text-sm"
                        >
                          {changeBadge(entry.change)}
                          <span className="font-mono text-foreground">{entry.name}</span>
                          {severityBadge(entry.severity, t)}
                          {entry.detail && (
                            <span className="text-xs text-muted ml-auto truncate max-w-[200px]">
                              {entry.detail}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Prerequisite issues */}
          {diffData.prerequisiteIssues.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('prerequisiteIssues')}
              </h3>
              {hasBlockingPrereqs && (
                <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3 mb-2">
                  <div className="flex items-center gap-2 mb-1.5">
                    <AlertTriangle className="w-4 h-4 text-error" />
                    <span className="text-xs font-medium text-error">
                      {t('prerequisiteBlocking')}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {diffData.prerequisiteIssues
                      .filter((i) => i.severity === 'breaking')
                      .map((issue) => (
                        <li key={`${issue.type}-${issue.name}`} className="text-xs text-error">
                          {issue.type}: {issue.name}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {diffData.prerequisiteIssues.some((i) => i.severity === 'warn') && (
                <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
                  <ul className="space-y-0.5">
                    {diffData.prerequisiteIssues
                      .filter((i) => i.severity === 'warn')
                      .map((issue) => (
                        <li key={`${issue.type}-${issue.name}`} className="text-xs text-warning">
                          {issue.type}: {issue.name}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Mounted symbol changes */}
          {diffData.mountedSymbolChanges.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('mountedSymbolChanges')}
              </h3>
              <div className="space-y-1">
                {diffData.mountedSymbolChanges.map((sym) => (
                  <div
                    key={`${sym.symbolType}-${sym.name}-${sym.change}`}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    {sym.symbolType === 'agent' ? (
                      <Bot className="w-3.5 h-3.5 text-accent" />
                    ) : (
                      <Wrench className="w-3.5 h-3.5 text-info" />
                    )}
                    <span className="text-sm text-foreground font-mono">{sym.mountedName}</span>
                    <Badge variant={sym.change === 'added' ? 'success' : 'error'}>
                      {sym.change === 'added' ? t('symbolAdded') : t('symbolRemoved')}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={handleClose} disabled={upgrading}>
              {t('cancel')}
            </Button>
            <Button
              variant={hasBreakingChanges ? 'danger' : 'primary'}
              icon={<CheckCircle2 className="w-4 h-4" />}
              loading={upgrading}
              disabled={hasBlockingPrereqs}
              onClick={handleUpgrade}
            >
              {t('confirm', { version: targetVersion })}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
