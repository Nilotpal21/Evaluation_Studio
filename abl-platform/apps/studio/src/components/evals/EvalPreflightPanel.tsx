/**
 * EvalPreflightPanel — Shows eval pipeline configuration health checks.
 *
 * Calls the preflight API and displays pass/fail/warn results
 * for each public readiness check.
 */

import { useState, useCallback } from 'react';
import {
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  CircleDashed,
} from 'lucide-react';
import clsx from 'clsx';
import { useProjectStore } from '@/store/project-store';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../ui/Button';

interface PreflightCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'not_checked';
  message: string;
  durationMs: number;
}

interface PreflightResult {
  overall: 'pass' | 'fail' | 'warn';
  checks: PreflightCheck[];
  timestamp: string;
}

const statusIcon = {
  pass: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
  fail: <XCircle className="w-3.5 h-3.5 text-error" />,
  warn: <AlertTriangle className="w-3.5 h-3.5 text-warning" />,
  not_checked: <CircleDashed className="w-3.5 h-3.5 text-foreground-muted" />,
};

const statusLabel = {
  pass: 'Passed',
  fail: 'Failed',
  warn: 'Warning',
  not_checked: 'Not checked',
};

export function EvalPreflightPanel() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreflight = useCallback(async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/evals/preflight`, {
        method: 'POST',
      });
      const data = (await res.json()) as {
        success: boolean;
        result?: PreflightResult;
        error?: { message: string };
      };
      if (data.success && data.result) {
        setResult(data.result);
      } else {
        setError(data.error?.message ?? 'Preflight check failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  return (
    <div className="border border-default rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Activity className="w-4 h-4 text-foreground-muted" />
          <span className="text-xs font-medium text-foreground-muted">Pipeline Health</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={runPreflight}
          disabled={loading || !currentProject}
        >
          {loading ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" />
              Checking...
            </>
          ) : (
            'Test Configuration'
          )}
        </Button>
      </div>

      {error && (
        <div className="text-xs text-error bg-error/10 rounded px-2 py-1.5 mb-2">{error}</div>
      )}

      {result && (
        <div className="space-y-1">
          <div
            className={clsx(
              'text-xs font-medium px-2 py-1 rounded',
              result.overall === 'pass' && 'text-success bg-success/10',
              result.overall === 'fail' && 'text-error bg-error/10',
              result.overall === 'warn' && 'text-warning bg-warning/10',
            )}
          >
            Overall: {statusLabel[result.overall]}
          </div>
          <div className="space-y-0.5">
            {result.checks.map((check) => (
              <div key={check.name} className="flex items-start gap-1.5 px-2 py-1">
                <div className="mt-0.5">{statusIcon[check.status]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-foreground">{check.name}</div>
                  <div className="text-xs text-foreground-muted break-words">{check.message}</div>
                </div>
                <span className="text-xs text-foreground-subtle shrink-0">
                  {check.durationMs}ms
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
