'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { authHeaders } from '@/lib/api-client';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { BusinessSection } from '../spec-document/BusinessSection';
import { ArchitectureSection } from '../spec-document/ArchitectureSection';
import { ImplementationSection } from '../spec-document/ImplementationSection';
import { DecisionsSection } from '../spec-document/DecisionsSection';

interface SpecDocumentPanelProps {
  sessionId: string;
  projectId?: string;
  disabled?: boolean;
  specFallback?: Record<string, unknown>;
  specOverride?: { projectName?: string; description?: string } | null;
}

/**
 * SpecDocumentPanel — the unified spec document viewer/editor.
 * Fetches the document on mount, then subscribes to the store for SSE-driven updates.
 * Four collapsible sections: Business, Architecture, Implementation, Decisions.
 */
export function SpecDocumentPanel({
  sessionId,
  projectId,
  disabled,
  specFallback,
  specOverride,
}: SpecDocumentPanelProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const loadedSessionIdRef = useRef<string | null>(null);
  const version = useArchAIStore((s) => s.specDocumentVersion);
  const doc = useArchAIStore((s) => s.specDocument);
  const lastCommittedSeq = useArchUIStore((s) => s.lastCommittedSeq);

  // Fetch spec document on mount and after each durable turn commit.
  // The interview flow updates the backend spec document during the turn,
  // but not every turn emits a granular spec artifact patch yet. Refetching
  // on commit keeps the panel aligned with the persisted source of truth.
  useEffect(() => {
    let cancelled = false;
    let confirmFetchTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadSpecDocument(options?: { silent?: boolean }) {
      const silent = options?.silent === true;
      if (!silent) {
        setLoading(true);
      }
      setLoadError(null);

      const url = projectId
        ? `/api/arch-ai/projects/${encodeURIComponent(projectId)}/spec-document`
        : `/api/arch-ai/sessions/${sessionId}/spec-document`;

      try {
        const res = await fetch(url, {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (!res.ok) {
          let errMsg = `Spec document request failed (${res.status})`;
          try {
            const errBody = (await res.json()) as { error?: { message?: string } };
            if (errBody?.error?.message) errMsg = errBody.error.message;
          } catch {
            // not JSON
          }
          if (!cancelled) {
            setLoadError(errMsg);
          }
          return;
        }
        const data = (await res.json()) as {
          success?: boolean;
          data?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (data.success && data.data) {
          if (!cancelled) {
            loadedSessionIdRef.current = sessionId;
            useArchAIStore.getState().setSpecDocument(data.data);
          }
        } else if (data.error?.message) {
          if (!cancelled) {
            setLoadError(data.error.message);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setLoadError(`Spec document failed to load: ${msg}`);
        }
      } finally {
        if (!cancelled && !silent) {
          setLoading(false);
        }
      }
    }

    void loadSpecDocument({
      silent:
        useArchAIStore.getState().specDocument !== null && loadedSessionIdRef.current === sessionId,
    });

    if (lastCommittedSeq >= 0) {
      confirmFetchTimer = setTimeout(() => {
        if (!cancelled) {
          void loadSpecDocument({ silent: true });
        }
      }, 600);
    }

    return () => {
      cancelled = true;
      if (confirmFetchTimer) {
        clearTimeout(confirmFetchTimer);
      }
    };
  }, [sessionId, projectId, lastCommittedSeq]);

  const handleSync = async () => {
    if (!projectId || syncing) return;
    setSyncing(true);
    try {
      const res = await fetch(`/api/arch-ai/projects/${projectId}/spec-document/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json()) as { success?: boolean; data?: Record<string, unknown> };
      if (json.success && json.data) {
        useArchAIStore.getState().setSpecDocument(json.data);
      }
    } catch {
      // Silent failure — sync is best-effort
    } finally {
      setSyncing(false);
    }
  };

  const handleDownload = async () => {
    const url = projectId
      ? `/api/arch-ai/projects/${encodeURIComponent(projectId)}/spec-document/download`
      : `/api/arch-ai/sessions/${sessionId}/spec-document/download`;

    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `spec-document-v${version}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // download failed silently
    }
  };

  if (loading) {
    return (
      <div className="px-5 py-4">
        {/* Skeleton section headers */}
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="mb-3 flex items-center gap-2 border-b border-border/40 px-4 py-3">
            <span className="h-3 w-3 animate-pulse rounded bg-foreground/8" />
            <span
              className="h-3 animate-pulse rounded bg-foreground/10"
              style={{ width: 60 + i * 20 }}
            />
            <span className="h-2 w-2 animate-pulse rounded-full bg-foreground/8" />
          </div>
        ))}
      </div>
    );
  }

  if (loadError && !doc) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-error">Could not load spec document</p>
          <p className="mt-1 text-xs text-foreground-subtle">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-foreground-muted">No spec document yet</p>
          <p className="mt-1 text-xs text-foreground-subtle">
            The spec document will be populated as the interview progresses
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <span className="flex-1 text-xs font-medium text-foreground-muted">Spec Document</span>
        {version > 0 && (
          <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted">
            v{version}
          </span>
        )}
        {projectId && (
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync from project"
            className="rounded-md p-1.5 text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', syncing && 'animate-spin')} />
          </button>
        )}
        <button
          onClick={handleDownload}
          className="rounded p-1 text-foreground-muted/60 transition-colors hover:bg-background-muted hover:text-foreground-muted"
          title="Download spec document"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto">
        <BusinessSection
          sessionId={sessionId}
          projectId={projectId}
          disabled={disabled}
          specFallback={specFallback}
          specOverride={specOverride}
        />
        <ArchitectureSection />
        <ImplementationSection />
        <DecisionsSection />
      </div>
    </div>
  );
}
