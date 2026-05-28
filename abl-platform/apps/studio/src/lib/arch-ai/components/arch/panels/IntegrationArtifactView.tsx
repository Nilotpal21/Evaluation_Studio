'use client';

import { useEffect, useState } from 'react';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { IntegrationDraftSummary } from '@/lib/arch-ai/integration-draft-service';

interface IntegrationArtifactViewProps {
  sessionId: string | null;
  projectId: string | undefined;
}

/**
 * IntegrationArtifactView — renders integration drafts for a project as a list
 * of cards with progress pills. "Resume in chat" sets prefill metadata so the
 * chat panel picks the draft back up; "+ Add integration" sets a start_integration
 * intent for fresh setup.
 */
export function IntegrationArtifactView({ projectId }: IntegrationArtifactViewProps) {
  const setPrefillMetadata = useArchAIStore((s) => s.setPrefillMetadata);
  const [drafts, setDrafts] = useState<IntegrationDraftSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/arch-ai/projects/${projectId}/integration-drafts`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load integration drafts (${res.status})`);
        }
        return res.json();
      })
      .then((body: { drafts?: IntegrationDraftSummary[] }) => {
        if (cancelled) return;
        setDrafts(Array.isArray(body?.drafts) ? body.drafts : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDrafts([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return <div className="p-4 text-sm text-foreground-muted">Loading integrations…</div>;
  }

  return (
    <div className="p-4">
      {error && (
        <div className="mb-3 rounded-md border border-error/20 bg-error/5 p-3 text-xs text-error">
          {error}
        </div>
      )}
      {drafts.length === 0 ? (
        <div className="rounded-md border-2 border-dashed border-border p-8 text-center text-sm text-foreground-muted">
          No integrations yet. Ask Arch in chat to set one up.
        </div>
      ) : (
        <div className="space-y-2">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onResume={() =>
                setPrefillMetadata({
                  kind: 'resume_integration',
                  draftId: d.id,
                  intent: 'resume',
                })
              }
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setPrefillMetadata({ kind: 'start_integration' })}
        className="mt-3 w-full rounded-md border border-dashed border-border py-2 text-sm text-foreground-muted transition-colors hover:bg-background-muted/50 hover:text-foreground"
      >
        + Add integration
      </button>
    </div>
  );
}

function DraftCard({ draft, onResume }: { draft: IntegrationDraftSummary; onResume: () => void }) {
  const providerLabel = draft.providerKey ?? draft.title ?? 'Integration';
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm text-foreground">{providerLabel}</strong>
            <span className="text-xs text-foreground-muted">{draft.status}</span>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap gap-1">
          <Pill on={draft.authProfileIds.length > 0} label="auth" />
          <Pill on={draft.toolIds.length > 0} label="tool" />
          <Pill on={draft.targetAgentNames.length > 0} label="wired" />
          <Pill on={draft.lastTestStatus === 'pass'} label="test" />
        </div>
      </div>
      <button
        type="button"
        onClick={onResume}
        className="mt-2 text-xs text-foreground-muted underline transition-colors hover:text-foreground"
      >
        Resume in chat
      </button>
    </div>
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={
        on
          ? 'rounded px-1.5 py-0.5 text-[10px] bg-success/10 text-success'
          : 'rounded px-1.5 py-0.5 text-[10px] bg-background-muted text-foreground-muted'
      }
    >
      {label} {on ? '✓' : '—'}
    </span>
  );
}
