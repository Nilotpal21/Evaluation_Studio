import { CheckCircle2, XCircle, PlayCircle, PauseCircle, type LucideIcon } from 'lucide-react';
import { activity, type ActivityEvent } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

const eventStyle: Record<
  ActivityEvent['event'],
  { icon: LucideIcon; iconClass: string; label: string }
> = {
  completed: { icon: CheckCircle2, iconClass: 'text-success', label: 'Completed' },
  failed: { icon: XCircle, iconClass: 'text-error', label: 'Failed' },
  started: { icon: PlayCircle, iconClass: 'text-info', label: 'Started' },
  paused: { icon: PauseCircle, iconClass: 'text-warning', label: 'Paused' },
};

function fmtDuration(ms: number) {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function ActivityFeed() {
  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div>
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <p className="text-xs text-foreground-muted mt-0.5">Last 8 agent runs</p>
        </div>
        <button className="text-xs text-foreground-muted hover:text-foreground transition-colors">
          Open traces →
        </button>
      </div>

      <div className="divide-y divide-border-muted">
        {activity.map((a) => {
          const s = eventStyle[a.event];
          const Icon = s.icon;
          return (
            <div
              key={a.id}
              className="px-4 py-2.5 grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 hover:bg-background-muted/40 transition-colors text-xs"
            >
              <Icon className={cn('size-3.5 shrink-0', s.iconClass)} />
              <div className="min-w-0">
                <span className="font-mono text-foreground">{a.agent}</span>
                <span className="text-foreground-subtle"> · </span>
                <span className="text-foreground-muted">{a.project}</span>
              </div>
              <span className={cn('text-[11px] font-medium', s.iconClass)}>{s.label}</span>
              <span className="text-foreground-muted tabular-nums font-mono text-[11px]">
                {fmtDuration(a.durationMs)}
              </span>
              <span className="text-foreground-subtle text-[11px] w-12 text-right">{a.ago}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
