/**
 * VocabularyTestPanel Component
 *
 * Test panel for vocabulary resolution (API-6).
 * Enter a query and see which vocabulary entries match.
 */

import { useState } from 'react';
import { Play, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { EmptyState } from '../ui/EmptyState';
import { sanitizeError } from '@/lib/sanitize-error';
import { testVocabularyResolution, type VocabularyTestResult } from '../../api/search-ai';

interface VocabularyTestPanelProps {
  indexId: string;
}

export function VocabularyTestPanel({ indexId }: VocabularyTestPanelProps) {
  const t = useTranslations('search_ai.vocabulary');

  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<VocabularyTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTest = async () => {
    if (!query.trim()) return;

    setTesting(true);
    setError(null);

    try {
      const testResult = await testVocabularyResolution(indexId, query.trim());
      setResult(testResult);
    } catch (err) {
      const msg = sanitizeError(err, t('error_test'));
      setError(msg);
      setResult(null);
    } finally {
      setTesting(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTest();
    }
  };

  return (
    <div className="space-y-6">
      {/* Test Input */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('test_query_label')}
        </label>
        <div className="flex gap-2">
          <Input
            placeholder={t('test_query_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1"
          />
          <Button
            icon={<Play className="w-4 h-4" />}
            onClick={handleTest}
            loading={testing}
            disabled={!query.trim()}
          >
            {t('test_run')}
          </Button>
        </div>
        <p className="text-xs text-muted mt-1.5">{t('test_query_hint')}</p>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="error" title={t('test_error_title')}>
          {error}
        </Alert>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">
              {t('test_results_title')}
            </h3>
            <div className="text-sm text-muted">
              {t('test_results_query')}:{' '}
              <span className="font-medium text-foreground">{result.query}</span>
            </div>
          </div>

          {result.resolutions.length === 0 ? (
            <EmptyState
              icon={<AlertCircle className="w-6 h-6" />}
              title={t('test_no_matches_title')}
              description={t('test_no_matches_description')}
            />
          ) : (
            <div className="space-y-3">
              {result.resolutions.map((resolution, index) => (
                <div
                  key={`${resolution.entryId}-${index}`}
                  className="rounded-xl border border-default bg-background-elevated p-4"
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-foreground">{resolution.term}</span>
                        <Badge variant="info" className="text-xs">
                          {resolution.matchType}
                        </Badge>
                      </div>
                      <code className="text-xs text-muted bg-background-muted px-2 py-0.5 rounded">
                        {resolution.fieldRef}
                      </code>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-foreground">
                        {(resolution.confidence * 100).toFixed(0)}%
                      </div>
                      <div className="text-xs text-muted">{t('test_confidence')}</div>
                    </div>
                  </div>

                  {/* Confidence Bar */}
                  <div className="mt-3">
                    <div className="h-1.5 bg-background-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all"
                        style={{ width: `${resolution.confidence * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Summary */}
          <div className="rounded-xl border border-default bg-background-subtle p-4">
            <div className="text-sm text-muted">
              {t('test_summary', {
                count: result.resolutions.length,
                query: result.query,
              })}
            </div>
          </div>
        </div>
      )}

      {/* Empty State - No Test Run Yet */}
      {!result && !error && !testing && (
        <div className="py-12">
          <EmptyState
            icon={<Play className="w-6 h-6" />}
            title={t('test_empty_title')}
            description={t('test_empty_description')}
          />
        </div>
      )}
    </div>
  );
}
