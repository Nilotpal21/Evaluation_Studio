'use client';

import { useParams } from 'next/navigation';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Badge } from '../../../../components/ui/badge';
import type { ConfigResponse } from '../../../../types/api';

const VALID_ENVS = ['dev', 'staging', 'prod'];
const SENSITIVE_KEYS = ['secret', 'key', 'password', 'token', 'credential', 'url'];

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s));
}

export default function EnvironmentConfigPage() {
  const params = useParams();
  const env = params.env as string;

  const { data, loading, error, refetch } = useApi<ConfigResponse>(
    VALID_ENVS.includes(env) ? `/api/config?env=${env}` : null,
  );

  if (!VALID_ENVS.includes(env)) {
    return (
      <div className="bg-error-subtle border border-error-muted rounded-[var(--radius-xl)] p-6">
        <h2 className="text-error font-bold text-lg">Invalid Environment</h2>
        <p className="text-error mt-1">
          Environment &quot;{env}&quot; is not valid. Use one of: {VALID_ENVS.join(', ')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            Configuration — <span className="uppercase">{env}</span>
          </h2>
          <p className="text-sm text-muted mt-1">View configuration for the {env} environment</p>
        </div>
        <div className="flex gap-2">
          {VALID_ENVS.map((e) => (
            <a
              key={e}
              href={`/config/${e}`}
              className={`px-4 py-2 rounded-[var(--radius-md)] text-sm font-medium transition-default ${
                e === env
                  ? 'bg-accent text-accent-foreground'
                  : 'border border-default text-muted hover:text-foreground hover:bg-background-muted'
              }`}
            >
              {e.toUpperCase()}
            </a>
          ))}
        </div>
      </div>

      <div className="mb-4 px-4 py-3 bg-info-subtle border border-info-muted rounded-[var(--radius-md)] text-sm text-info">
        Configuration is managed via GitOps. View change history in{' '}
        <a
          href={process.env.NEXT_PUBLIC_BITBUCKET_REPO_URL || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          Bitbucket
        </a>
        .
      </div>

      {loading ? (
        <SkeletonTable rows={8} />
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
            const entries = Object.entries(values as Record<string, unknown>);
            if (entries.length === 0) return null;

            return (
              <div
                key={section}
                className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden"
              >
                <div className="px-5 py-3 bg-background-subtle border-b border-border-muted">
                  <h3 className="font-semibold text-foreground capitalize">{section}</h3>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-subtle border-b border-border-muted">
                      <th className="px-5 py-2 w-1/3 font-medium">Key</th>
                      <th className="px-5 py-2 w-1/2 font-medium">Value</th>
                      <th className="px-5 py-2 w-1/6 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([key, value]) => {
                      const sensitive = isSensitive(key);
                      const displayValue = String(value ?? '');

                      return (
                        <tr
                          key={key}
                          className="border-b border-border-muted last:border-b-0 table-row-hover"
                        >
                          <td className="px-5 py-3 text-muted font-mono text-xs">{key}</td>
                          <td className="px-5 py-3 font-mono text-xs">
                            {sensitive && displayValue.includes('*') ? (
                              <span className="text-subtle">{displayValue}</span>
                            ) : (
                              <span className="text-foreground">{displayValue}</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            {sensitive && displayValue.includes('*') ? (
                              <Badge variant="default">Locked</Badge>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}

          {Object.keys(data.config).length === 0 && (
            <EmptyState title="No config keys" description={`No configuration found for ${env}`} />
          )}
        </div>
      ) : null}

      <div className="mt-6 flex gap-3">
        <a
          href={`/config/diff?left=${env}&right=${env === 'dev' ? 'staging' : 'prod'}`}
          className="px-4 py-2 bg-background-muted border border-default rounded-[var(--radius-md)] text-sm text-muted hover:text-foreground transition-default"
        >
          Compare with {env === 'dev' ? 'Staging' : 'Prod'}
        </a>
      </div>
    </div>
  );
}
