'use client';

import {
  FileText,
  Globe,
  Database,
  Cloud,
  Upload,
  PenLine,
  Plug,
  RefreshCw,
  Lock,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { KnowledgeSource, KnowledgeMode, KnowledgeStatus } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

const modeIcon: Record<KnowledgeMode, LucideIcon> = {
  upload: Upload,
  connector: Plug,
  crawl: Globe,
  authored: PenLine,
  api: Database,
};

const modeLabel: Record<KnowledgeMode, string> = {
  upload: 'Upload',
  connector: 'Connector',
  crawl: 'Crawl',
  authored: 'Authored',
  api: 'API',
};

const statusStyle: Record<KnowledgeStatus, { dot: string; text: string; bg: string; label: string }> = {
  active: { dot: 'bg-success', text: 'text-success', bg: 'bg-success-subtle', label: 'Active' },
  syncing: { dot: 'bg-info animate-pulse', text: 'text-info', bg: 'bg-info-subtle', label: 'Syncing' },
  stale: { dot: 'bg-warning', text: 'text-warning', bg: 'bg-warning-subtle', label: 'Stale' },
  deprecated: {
    dot: 'bg-foreground-subtle',
    text: 'text-foreground-muted',
    bg: 'bg-background-elevated',
    label: 'Deprecated',
  },
  error: { dot: 'bg-error', text: 'text-error', bg: 'bg-error-subtle', label: 'Error' },
};

export function SourceCard({
  source,
  onClick,
}: {
  source: KnowledgeSource;
  onClick: () => void;
}) {
  const ModeIcon = modeIcon[source.mode];
  const status = statusStyle[source.status];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left rounded-lg border bg-background-subtle hover:bg-background-muted/40 transition-colors p-4 flex flex-col gap-3',
        source.status === 'error'
          ? 'border-error/30 hover:border-error/50'
          : 'border-border-muted hover:border-border',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className={cn(
              'size-9 rounded-md border flex items-center justify-center shrink-0',
              source.status === 'error'
                ? 'border-error/30 bg-error-subtle/40 text-error'
                : 'border-border-muted bg-background-elevated text-foreground-muted',
            )}
          >
            <ModeIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight truncate">{source.name}</div>
            <div className="text-[11px] text-foreground-muted truncate">
              {source.provider ?? modeLabel[source.mode]}
              {source.scope === 'project' && (
                <>
                  <span className="text-foreground-subtle"> · </span>
                  <span className="text-purple">project</span>
                </>
              )}
              {source.scope === 'tenant' && (
                <>
                  <span className="text-foreground-subtle"> · </span>
                  <span className="text-foreground-muted">tenant-wide</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium whitespace-nowrap',
            status.bg,
            status.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', status.dot)} />
          {status.label}
        </span>
      </header>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Documents" value={source.documents.toLocaleString()} />
        <Stat label="Chunks" value={source.chunks.toLocaleString()} />
        <Stat label="Apps" value={source.appsConsuming.toString()} />
      </div>

      {source.tags.length > 0 && (
        <div className="flex items-center flex-wrap gap-1">
          {source.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-background-muted/60 border border-border-muted text-foreground-muted font-mono"
            >
              {tag}
            </span>
          ))}
          {source.tags.length > 3 && (
            <span className="text-[10px] text-foreground-subtle">+{source.tags.length - 3}</span>
          )}
          {source.sensitiveTags.includes('pii') && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning border border-warning/30 font-mono">
              <Lock className="size-2.5" />
              pii
            </span>
          )}
          {source.sensitiveTags.includes('regulator-only') && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-error-subtle text-error border border-error/30 font-mono">
              <Lock className="size-2.5" />
              regulator-only
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-auto pt-2 border-t border-border-muted text-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="size-5 rounded-full bg-info-subtle text-info text-[9px] font-medium flex items-center justify-center shrink-0">
            {source.ownerInitials}
          </span>
          <span className="text-foreground-subtle truncate">
            Last sync {source.lastSyncedAgo}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toast.success(`Sync triggered for ${source.name}`);
          }}
          className="size-6 rounded-md hover:bg-background-elevated text-foreground-muted hover:text-foreground transition-colors flex items-center justify-center shrink-0"
          aria-label="Sync now"
          title="Sync now"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta">{label}</div>
      <div className="text-xs font-semibold tabular-nums mt-0.5 font-mono">{value}</div>
    </div>
  );
}

export function getModeIcon(mode: KnowledgeMode): LucideIcon {
  return modeIcon[mode];
}
