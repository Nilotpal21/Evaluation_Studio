'use client';

import { useApi } from '../../../hooks/use-swr-fetch';
import { SkeletonCard } from '../../../components/ui/skeleton';
import { EmptyState } from '../../../components/ui/empty-state';
import type { ConfigResponse } from '../../../types/api';

const ENVS = ['dev', 'staging', 'prod'] as const;

export default function ConfigPage() {
  const { data, loading, error, refetch } = useApi<ConfigResponse>('/api/config?env=dev');

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Configuration</h2>
          <p className="text-sm text-muted mt-1">Manage configuration across environments</p>
        </div>
        <div className="flex gap-2">
          {ENVS.map((env) => (
            <a
              key={env}
              href={`/config/${env}`}
              className="px-4 py-2 rounded-[var(--radius-md)] border border-default text-sm font-medium text-muted hover:text-foreground hover:bg-background-muted transition-default"
            >
              {env.toUpperCase()}
            </a>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-4 stagger-children">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : error ? (
        <EmptyState
          title="Failed to load configuration"
          description={error}
          action={
            <button
              onClick={refetch}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm btn-press"
            >
              Retry
            </button>
          }
        />
      ) : data ? (
        <div className="space-y-4">
          {Object.entries(data.config).map(([section, values]) => {
            // Skip scalar values (e.g. env: "dev") — only show object sections
            if (typeof values !== 'object' || values === null) {
              return (
                <div
                  key={section}
                  className="bg-background-muted border border-default rounded-[var(--radius-xl)] p-5"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-foreground capitalize">{section}</h3>
                    <span className="text-xs text-subtle">1 keys</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-2 py-1 text-xs rounded-[var(--radius-md)] bg-background-subtle text-muted font-mono">
                      {String(values)}
                    </span>
                  </div>
                </div>
              );
            }
            const keys = Object.keys(values as Record<string, unknown>);
            return (
              <div
                key={section}
                className="bg-background-muted border border-default rounded-[var(--radius-xl)] p-5"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-foreground capitalize">{section}</h3>
                  <span className="text-xs text-subtle">{keys.length} keys</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {keys.map((key) => (
                    <span
                      key={key}
                      className="px-2 py-1 text-xs rounded-[var(--radius-md)] bg-background-subtle text-muted font-mono"
                    >
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
