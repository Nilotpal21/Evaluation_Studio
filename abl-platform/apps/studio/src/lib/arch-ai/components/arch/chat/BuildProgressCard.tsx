'use client';

/**
 * BuildProgressCard — live dashboard of agents during the BUILD phase.
 *
 * Shows every agent in the current topology as a row with:
 *   - a status icon (queued / generating / ok / warning / error)
 *   - the agent name
 *   - a short status label
 *
 * Designed to pair with the parallel-generation flow: the architect emits
 * N `file_changed` + `compile_result` events in quick succession, and the
 * user watches all agents materialize at once instead of waiting for each
 * sequentially.
 *
 * Data sources (all from arch-ai-store):
 *   - buildState.agents   — unified per-agent build status (primary)
 *   - filePanelFiles      — fallback for warning details / agents not yet in buildState
 *
 * The component is purely presentational and auto-subscribes to store
 * changes — no props other than an optional filter for agent names.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { clsx } from 'clsx';
import {
  useArchAIStore,
  type BuildLogEntry,
  type BuildAgentUIStatus,
  type FilePanelFile,
} from '@/lib/arch-ai/store/arch-ai-store';

type RowStatus =
  | 'queued'
  | 'generating'
  | 'compiling'
  | 'fixing'
  | 'compiled'
  | 'warning'
  | 'error';

interface AgentRow {
  name: string;
  status: RowStatus;
  label: string;
  warningCount: number;
  fixRounds?: number;
}

function formatBuildLogEntry(entry: BuildLogEntry): string {
  const parts = [
    entry.timestamp,
    entry.eventType,
    entry.agent ? `agent=${entry.agent}` : null,
    entry.stage ? `stage=${entry.stage}` : null,
    entry.message,
  ].filter(Boolean);
  const data =
    entry.data && Object.keys(entry.data).length > 0 ? ` ${JSON.stringify(entry.data)}` : '';
  return `${parts.join(' | ')}${data}`;
}

function formatBuildLog(entries: BuildLogEntry[]): string {
  return entries.map(formatBuildLogEntry).join('\n');
}

function mapBuildStatus(status: BuildAgentUIStatus): RowStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'generating':
      return 'generating';
    case 'parsed':
      return 'compiling';
    case 'fixing':
      return 'fixing';
    case 'validated':
    case 'compiled':
      return 'compiled';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'queued';
  }
}

/** Legacy fallback: derive status from filePanelFiles when buildState has no entry. */
function deriveStatus(file: FilePanelFile | undefined): RowStatus {
  if (!file) return 'queued';
  switch (file.compileStatus) {
    case 'compiling':
      return 'compiling';
    case 'fixing':
      return 'compiling';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    case 'success':
      return 'compiled';
    case 'pending':
    default:
      return 'queued';
  }
}

function statusLabel(status: RowStatus, warningCount: number, fixRounds?: number): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'generating':
      return 'Generating\u2026';
    case 'compiling':
      return 'Compiling\u2026';
    case 'fixing':
      return 'Refining\u2026';
    case 'compiled':
      return fixRounds && fixRounds > 0 ? `Refined (${fixRounds}×)` : 'Compiled';
    case 'warning':
      if (fixRounds && fixRounds > 0) {
        return warningCount > 0
          ? `Refined (${fixRounds}×, ${warningCount} suggestion${warningCount > 1 ? 's' : ''})`
          : `Refined (${fixRounds}×)`;
      }
      return warningCount > 0
        ? `Compiled (${warningCount} warning${warningCount > 1 ? 's' : ''})`
        : 'Compiled (warnings)';
    case 'error':
      return 'Compile error';
  }
}

function StatusIcon({ status }: { status: RowStatus }) {
  // All icons share the same 14×14 box so rows align cleanly.
  const box = 'mt-0.5 flex h-[14px] w-[14px] items-center justify-center shrink-0';

  switch (status) {
    case 'queued':
      return (
        <span className={clsx(box, 'text-foreground-muted')}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
        </span>
      );
    case 'generating':
      return (
        <span className={box}>
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        </span>
      );
    case 'compiling':
      return (
        <span className={box}>
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-warning/30 border-t-warning" />
        </span>
      );
    case 'fixing':
      return (
        <span className={box}>
          <span
            className="h-3 w-3 animate-spin rounded-full border-2 border-warning/30 border-t-warning"
            style={{ animationDirection: 'reverse' }}
          />
        </span>
      );
    case 'compiled':
      return (
        <span className={clsx(box, 'text-success')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      );
    case 'warning':
      return (
        <span className={clsx(box, 'text-warning')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 1.5L11 10H1L6 1.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M6 5V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="6" cy="9" r="0.5" fill="currentColor" />
          </svg>
        </span>
      );
    case 'error':
      return (
        <span className={clsx(box, 'text-error')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 3L9 9M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
  }
}

interface BuildProgressCardProps {
  /**
   * Canonical list of agents to render, in topological build order. When
   * omitted, falls back to the keys of filePanelFiles (which is the order
   * the architect wrote them — good enough for first generation but may
   * diverge from buildOrder after edits).
   */
  topologyAgents?: string[];
}

export function BuildLogActions({ className }: { className?: string }) {
  const buildLog = useArchAIStore(useShallow((s) => s.buildState.log));
  const [copiedLog, setCopiedLog] = useState(false);
  const buildLogText = useMemo(() => formatBuildLog(buildLog), [buildLog]);
  const canExportLog = buildLogText.length > 0;
  const handleCopyLog = useCallback(async () => {
    if (!canExportLog) return;
    await navigator.clipboard.writeText(buildLogText);
    setCopiedLog(true);
    window.setTimeout(() => setCopiedLog(false), 1600);
  }, [buildLogText, canExportLog]);
  const handleDownloadLog = useCallback(() => {
    if (!canExportLog) return;
    const blob = new Blob([buildLogText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arch-build-generation-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildLogText, canExportLog]);

  if (!canExportLog) return null;

  return (
    <div
      className={clsx(
        'pointer-events-none flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        className,
      )}
      aria-label="Build generation log actions"
    >
      <button
        type="button"
        onClick={handleCopyLog}
        className="flex h-6 w-6 items-center justify-center rounded border border-border/70 bg-background/90 text-foreground-muted shadow-sm transition-colors hover:bg-background-muted hover:text-foreground"
        title={copiedLog ? 'Copied build log' : 'Copy build log'}
        aria-label={copiedLog ? 'Copied build log' : 'Copy build log'}
      >
        {copiedLog ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M2.2 6.2L4.7 8.7L9.8 3.3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="4" y="2" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="1" />
            <path
              d="M3 10H7M3 10C2.45 10 2 9.55 2 9V5C2 4.45 2.45 4 3 4"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={handleDownloadLog}
        className="flex h-6 w-6 items-center justify-center rounded border border-border/70 bg-background/90 text-foreground-muted shadow-sm transition-colors hover:bg-background-muted hover:text-foreground"
        title="Download build log"
        aria-label="Download build log"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M6 2V7M6 7L3.8 4.8M6 7L8.2 4.8"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M2.5 9.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function BuildProgressCardImpl({ topologyAgents }: BuildProgressCardProps) {
  // Shallow comparison — the store returns a new object reference on every
  // setBuildAgentStatus/updateFile call (spread syntax), but the underlying
  // keys/values are often unchanged. Without useShallow, every SSE event
  // re-renders this component and every ancestor, contributing to the
  // "Maximum update depth exceeded" cascade during BUILD streaming.
  const buildPhase = useArchAIStore((s) => s.buildState.phase);
  const buildAgents = useArchAIStore(useShallow((s) => s.buildState.agents));
  const files = useArchAIStore(useShallow((s) => s.filePanelFiles));
  const fileAgentNames = useMemo(
    () =>
      Object.entries(files)
        .filter(([, file]) => file.fileType !== 'mock' && file.fileType !== 'upload')
        .map(([name]) => name),
    [files],
  );

  const rows = useMemo<AgentRow[]>(() => {
    // The approved topology is the canonical BUILD contract. When it exists,
    // render only those agents here and treat extra generated files/statuses
    // as drift instead of inflating the progress count.
    const ordered =
      topologyAgents && topologyAgents.length > 0
        ? topologyAgents
        : Array.from(new Set<string>([...Object.keys(buildAgents), ...fileAgentNames]));

    return ordered.map((name) => {
      const agent = buildAgents[name];
      // Primary: use buildState.agents if present; fallback: filePanelFiles
      const status = agent ? mapBuildStatus(agent.status) : deriveStatus(files[name]);
      const warningCount = agent?.warnings?.length ?? files[name]?.compileWarnings?.length ?? 0;
      const fixRounds = agent?.fixRounds;
      return {
        name,
        status,
        label: statusLabel(status, warningCount, fixRounds),
        warningCount,
        fixRounds,
      };
    });
  }, [buildAgents, fileAgentNames, files, topologyAgents]);

  const unexpectedAgents = useMemo(() => {
    if (!topologyAgents || topologyAgents.length === 0) {
      return [];
    }

    const topologySet = new Set(topologyAgents);
    return Array.from(new Set([...Object.keys(buildAgents), ...fileAgentNames])).filter(
      (name) => !topologySet.has(name),
    );
  }, [buildAgents, fileAgentNames, topologyAgents]);

  if (rows.length === 0) return null;

  const compiledCount = rows.filter(
    (r) => r.status === 'compiled' || r.status === 'warning',
  ).length;
  const total = rows.length;
  const isReady =
    buildPhase === 'ready' ||
    (buildPhase === 'idle' && rows.every((row) => row.status === 'queued'));
  const title =
    buildPhase === 'complete'
      ? `Built ${total} agent${total === 1 ? '' : 's'}`
      : isReady
        ? `Ready to build ${total} agent${total === 1 ? '' : 's'}`
        : `Building ${total} agent${total === 1 ? '' : 's'}`;

  return (
    <section
      className="group relative w-full rounded-md border border-border border-l-2 border-l-accent/30 bg-background-elevated px-3 py-2.5"
      aria-label="Build progress"
    >
      <BuildLogActions className="absolute right-2 top-2" />
      <header className="mb-2 flex items-center justify-between text-xs text-foreground-muted">
        <span>{title}</span>
        <span className="pr-12">
          {compiledCount}/{total} compiled
        </span>
      </header>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.name}
            className={clsx(
              'flex items-start gap-2 text-sm leading-tight',
              row.status === 'error' && 'text-error',
            )}
          >
            <StatusIcon status={row.status} />
            <span className="flex-1 truncate font-medium">{row.name}</span>
            <span className="text-xs text-foreground-muted whitespace-nowrap">{row.label}</span>
          </li>
        ))}
      </ul>
      {unexpectedAgents.length > 0 ? (
        <p className="mt-2 text-xs text-warning">
          Unexpected generated agents outside the approved topology: {unexpectedAgents.join(', ')}
        </p>
      ) : null}
    </section>
  );
}

export const BuildProgressCard = memo(BuildProgressCardImpl);
