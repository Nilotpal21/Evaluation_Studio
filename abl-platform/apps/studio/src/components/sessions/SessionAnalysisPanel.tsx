/**
 * SessionAnalysisPanel Component
 *
 * Shows automated diagnostics from the session analysis API.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle, CheckCircle, Info, RefreshCw } from 'lucide-react';
import { fetchSessionAnalysis } from '../../api/usage';
import { sanitizeError } from '../../lib/sanitize-error';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';

interface SessionAnalysisPanelProps {
  projectId: string;
  sessionId: string;
}

interface AnalysisResult {
  summary?: string;
  issues?: Array<{ severity: string; message: string; detail?: string }>;
  metrics?: Record<string, string | number>;
  recommendations?: string[];
}

export function SessionAnalysisPanel({ projectId, sessionId }: SessionAnalysisPanelProps) {
  const t = useTranslations('sessions.analysis');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchSessionAnalysis(projectId, sessionId);
      setAnalysis(data.analysis as AnalysisResult);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to load analysis'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [projectId, sessionId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
        <span className="ml-2 text-sm text-muted">{t('analyzing')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-error mb-3">{error}</p>
        <Button variant="secondary" size="sm" onClick={load}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (!analysis) {
    return <div className="text-center py-12 text-sm text-muted">{t('no_analysis')}</div>;
  }

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={load}
        >
          {t('refresh')}
        </Button>
      </div>

      {/* Summary */}
      {analysis.summary && (
        <div className="p-3 rounded-lg bg-background-muted border border-default">
          <p className="text-sm text-foreground">{analysis.summary}</p>
        </div>
      )}

      {/* Issues */}
      {analysis.issues && analysis.issues.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted uppercase tracking-wider">{t('issues')}</h4>
          {analysis.issues.map((issue, i) => (
            <div
              key={i}
              className="flex items-start gap-2 p-3 rounded-lg bg-background-muted border border-default"
            >
              {issue.severity === 'error' ? (
                <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              ) : issue.severity === 'warning' ? (
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              ) : (
                <Info className="w-4 h-4 text-info shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-sm text-foreground">{issue.message}</p>
                {issue.detail && <p className="text-xs text-muted mt-1">{issue.detail}</p>}
              </div>
              <Badge
                variant={
                  issue.severity === 'error'
                    ? 'error'
                    : issue.severity === 'warning'
                      ? 'warning'
                      : 'info'
                }
                className="ml-auto shrink-0"
              >
                {issue.severity}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Metrics */}
      {analysis.metrics && Object.keys(analysis.metrics).length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted uppercase tracking-wider">
            {t('metrics')}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(analysis.metrics).map(([key, value]) => (
              <div key={key} className="p-3 rounded-lg bg-background-muted border border-default">
                <p className="text-xs text-muted">{key.replace(/_/g, ' ')}</p>
                <p className="text-sm font-medium text-foreground mt-0.5">{String(value)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {analysis.recommendations && analysis.recommendations.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted uppercase tracking-wider">
            {t('recommendations')}
          </h4>
          {analysis.recommendations.map((rec, i) => (
            <div
              key={i}
              className="flex items-start gap-2 p-3 rounded-lg bg-background-muted border border-default"
            >
              <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
              <p className="text-sm text-foreground">{rec}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
