/**
 * VersionListTab Component
 *
 * Tabbed version table with status badges, promote button, diff action.
 */

import React, { useState, useMemo } from 'react';
import {
  ArrowUpCircle,
  ArrowRight,
  GitCompare,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Wrench,
  Plus,
  Minus,
} from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import type { VersionRecord, ToolSnapshotEntry } from '../../api/versions';
import { useAgentVersions } from '../../hooks/useAgentVersions';
import { useVersionStore } from '../../store/version-store';
import { fetchVersion } from '../../api/versions';
import { springs } from '../../lib/animation';
import { DataTable, type Column } from '../ui/DataTable';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { DiffViewer } from '../ui/DiffViewer';
import { Dialog } from '../ui/Dialog';
import { VersionPromoteDialog } from './VersionPromoteDialog';

interface VersionListTabProps {
  projectId: string;
  agentName: string;
}

const STATUS_VARIANT: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  draft: 'default',
  testing: 'info',
  staged: 'warning',
  active: 'success',
  deprecated: 'error',
};

export function VersionListTab({ projectId, agentName }: VersionListTabProps) {
  const { versions, total, isLoading, error, reload, promote } = useAgentVersions(
    projectId,
    agentName,
  );
  const { showDiff, setShowDiff } = useVersionStore();

  const [promoteTarget, setPromoteTarget] = useState<VersionRecord | null>(null);
  const [isPromoting, setIsPromoting] = useState(false);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);

  // Diff state
  const [diffData, setDiffData] = useState<{
    left: string;
    right: string;
    leftLabel: string;
    rightLabel: string;
    oldSnapshot: ToolSnapshotEntry[] | null;
    newSnapshot: ToolSnapshotEntry[] | null;
  } | null>(null);

  const handlePromote = async (targetStatus: string) => {
    if (!promoteTarget) return;
    setIsPromoting(true);
    try {
      await promote(promoteTarget.version, targetStatus);
      setPromoteTarget(null);
    } finally {
      setIsPromoting(false);
    }
  };

  const handleDiff = async (version: VersionRecord, idx: number) => {
    // Diff against the next (older) version
    const olderVersion = versions[idx + 1];
    if (!olderVersion) return;

    try {
      const [current, previous] = await Promise.all([
        fetchVersion(projectId, agentName, version.version),
        fetchVersion(projectId, agentName, olderVersion.version),
      ]);
      setDiffData({
        left: previous.version.dslContent,
        right: current.version.dslContent,
        leftLabel: `v${previous.version.version}`,
        rightLabel: `v${current.version.version}`,
        oldSnapshot: previous.version.toolSnapshot ?? null,
        newSnapshot: current.version.toolSnapshot ?? null,
      });
      setShowDiff(true);
    } catch {
      // Error handled by toast in API layer
    }
  };

  const columns: Column<VersionRecord>[] = useMemo(
    () => [
      {
        key: 'version',
        label: 'Version',
        sortable: true,
        render: (v) => <span className="font-mono text-sm font-medium">v{v.version}</span>,
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        render: (v) => <Badge variant={STATUS_VARIANT[v.status] || 'default'}>{v.status}</Badge>,
      },
      {
        key: 'sourceHash',
        label: 'Hash',
        render: (v) => (
          <span className="font-mono text-xs text-muted">{v.sourceHash.slice(0, 8)}</span>
        ),
      },
      {
        key: 'changelog',
        label: 'Changelog',
        render: (v) => (
          <span className="text-sm text-muted truncate max-w-[200px] inline-block">
            {v.changelog || '—'}
          </span>
        ),
      },
      {
        key: 'createdAt',
        label: 'Created',
        sortable: true,
        render: (v) => (
          <span className="text-sm text-muted">{new Date(v.createdAt).toLocaleDateString()}</span>
        ),
      },
      {
        key: 'toolSnapshot' as keyof VersionRecord,
        label: 'Tools',
        render: (v) => {
          const snapshot = v.toolSnapshot;
          if (!snapshot || snapshot.length === 0) {
            return <span className="text-xs text-muted">—</span>;
          }
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpandedVersionId(expandedVersionId === v.id ? null : v.id);
              }}
              className="flex items-center gap-1 text-xs text-info hover:text-info/80 transition-default"
            >
              {expandedVersionId === v.id ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {snapshot.length} tool{snapshot.length !== 1 ? 's' : ''}
            </button>
          );
        },
      },
      {
        key: 'actions' as keyof VersionRecord,
        label: '',
        render: (v, idx) => (
          <div className="flex items-center gap-1 justify-end">
            {idx < versions.length - 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDiff(v, idx);
                }}
                className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                title="Compare with previous"
              >
                <GitCompare className="w-3.5 h-3.5" />
              </button>
            )}
            {v.status !== 'deprecated' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPromoteTarget(v);
                }}
                className="p-1.5 text-muted hover:text-accent rounded transition-default"
                title="Promote"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ),
      },
    ],
    [versions],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<RefreshCw className="w-6 h-6" />}
        title="Failed to load versions"
        description={error}
        action={
          <Button variant="secondary" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4 py-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {total} version{total !== 1 ? 's' : ''}
        </p>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={reload}
        >
          Refresh
        </Button>
      </div>

      {/* Table */}
      {versions.length === 0 ? (
        <EmptyState
          icon={<ArrowUpCircle className="w-6 h-6" />}
          title="No versions yet"
          description="Create the first version from the ABL Editor tab"
        />
      ) : (
        <>
          <DataTable columns={columns} data={versions} />

          {/* Expanded tool snapshot detail */}
          <ToolSnapshotPanel versions={versions} expandedVersionId={expandedVersionId} />
        </>
      )}

      {/* Promote dialog */}
      {promoteTarget && (
        <VersionPromoteDialog
          open={!!promoteTarget}
          onClose={() => setPromoteTarget(null)}
          onConfirm={handlePromote}
          version={promoteTarget.version}
          currentStatus={promoteTarget.status}
          loading={isPromoting}
        />
      )}

      {/* Diff dialog */}
      {showDiff && diffData && (
        <Dialog
          open={showDiff}
          onClose={() => {
            setShowDiff(false);
            setDiffData(null);
          }}
          maxWidth="xl"
        >
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground">Version Diff</h3>
            <ToolSnapshotDiff
              oldSnapshot={diffData.oldSnapshot}
              newSnapshot={diffData.newSnapshot}
              leftLabel={diffData.leftLabel}
              rightLabel={diffData.rightLabel}
            />
            <DiffViewer
              left={diffData.left}
              right={diffData.right}
              leftLabel={diffData.leftLabel}
              rightLabel={diffData.rightLabel}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}

// =============================================================================
// TOOL SNAPSHOT DIFF
// =============================================================================

interface ToolDiffEntry {
  kind: 'added' | 'removed' | 'changed';
  name: string;
  toolType: string;
}

function computeToolDiff(
  oldSnapshot: ToolSnapshotEntry[] | null,
  newSnapshot: ToolSnapshotEntry[] | null,
): ToolDiffEntry[] {
  const oldTools = oldSnapshot ?? [];
  const newTools = newSnapshot ?? [];

  const oldMap = new Map(oldTools.map((t) => [t.name, t]));
  const newMap = new Map(newTools.map((t) => [t.name, t]));

  const entries: ToolDiffEntry[] = [];

  for (const tool of newTools) {
    const old = oldMap.get(tool.name);
    if (!old) {
      entries.push({ kind: 'added', name: tool.name, toolType: tool.toolType });
    } else if (old.sourceHash !== tool.sourceHash) {
      entries.push({ kind: 'changed', name: tool.name, toolType: tool.toolType });
    }
  }

  for (const tool of oldTools) {
    if (!newMap.has(tool.name)) {
      entries.push({ kind: 'removed', name: tool.name, toolType: tool.toolType });
    }
  }

  return entries;
}

const DIFF_STYLES: Record<
  ToolDiffEntry['kind'],
  { row: string; icon: React.ReactNode; label: string }
> = {
  added: {
    row: 'bg-success-subtle text-success',
    icon: <Plus className="w-3 h-3" />,
    label: 'Added',
  },
  removed: {
    row: 'bg-error-subtle text-error',
    icon: <Minus className="w-3 h-3" />,
    label: 'Removed',
  },
  changed: {
    row: 'bg-warning-subtle text-warning',
    icon: <ArrowRight className="w-3 h-3" />,
    label: 'Updated',
  },
};

function ToolSnapshotDiff({
  oldSnapshot,
  newSnapshot,
  leftLabel,
  rightLabel,
}: {
  oldSnapshot: ToolSnapshotEntry[] | null;
  newSnapshot: ToolSnapshotEntry[] | null;
  leftLabel: string;
  rightLabel: string;
}) {
  const diff = useMemo(() => computeToolDiff(oldSnapshot, newSnapshot), [oldSnapshot, newSnapshot]);

  if (diff.length === 0) return null;

  return (
    <div className="rounded-lg border border-default overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 bg-background-muted border-b border-default">
        <Wrench className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-medium text-foreground">
          Tool Changes ({leftLabel} → {rightLabel})
        </span>
      </div>
      <div className="divide-y divide-border-muted">
        {diff.map((entry) => {
          const style = DIFF_STYLES[entry.kind];
          return (
            <div
              key={`${entry.kind}-${entry.name}`}
              className={clsx('flex items-center justify-between px-3 py-1.5 text-xs', style.row)}
            >
              <div className="flex items-center gap-1.5">
                {style.icon}
                <span className="font-medium font-mono">{entry.name}</span>
                <span className="opacity-60">{entry.toolType}</span>
              </div>
              <Badge
                variant={
                  entry.kind === 'added'
                    ? 'success'
                    : entry.kind === 'removed'
                      ? 'error'
                      : 'warning'
                }
              >
                {style.label}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// TOOL SNAPSHOT PANEL
// =============================================================================

function ToolSnapshotPanel({
  versions,
  expandedVersionId,
}: {
  versions: VersionRecord[];
  expandedVersionId: string | null;
}) {
  const version = expandedVersionId ? versions.find((v) => v.id === expandedVersionId) : null;
  const snapshot = version?.toolSnapshot;

  return (
    <AnimatePresence>
      {snapshot && snapshot.length > 0 && (
        <motion.div
          key={`snapshot-${expandedVersionId}`}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={springs.snappy}
          className="overflow-hidden"
        >
          <div className="p-3 rounded-lg bg-background-muted border border-default mt-2">
            <div className="flex items-center gap-1.5 mb-2">
              <Wrench className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-medium text-foreground">
                Baked Tools — v{version?.version}
              </span>
            </div>
            <div className="space-y-1">
              {snapshot.map((tool: ToolSnapshotEntry) => (
                <div
                  key={tool.projectToolId}
                  className="flex items-center justify-between text-xs py-0.5"
                >
                  <span className="text-foreground">{tool.name}</span>
                  <span className="text-muted font-mono">
                    {tool.toolType}
                    <span className="ml-1.5 opacity-60">{tool.sourceHash.slice(0, 8)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
