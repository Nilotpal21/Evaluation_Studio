/**
 * QueryPlaygroundTab Component
 *
 * Interactive search query testing with results, latency breakdown,
 * and vocabulary resolution trace.
 */

import { useState, useCallback, useMemo } from 'react';
import { Play, Zap, BookOpen, Copy, Terminal, Database, Code } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { JsonViewer } from '../ui/JsonViewer';
import { executeQuery, resolveVocabulary } from '../../api/search-ai';
import type { SearchAIQueryResult, VocabularyResolutionResult } from '../../api/search-ai';
import { useSearchTabStore } from '../../store/search-tab-store';
import { useNavigationStore } from '../../store/navigation-store';

interface QueryPlaygroundTabProps {
  indexId: string;
  /** Document count for this index, used to distinguish "no data" vs "no matches" */
  documentCount?: number;
}

function buildApiPayload(query: string, queryType: string, topK: string) {
  return {
    query: query.trim(),
    queryType,
    topK: parseInt(topK, 10) || 10,
  };
}

function buildCurlCommand(indexId: string, payload: object): string {
  const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/search-ai-runtime/search/${indexId}/query`;
  return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(payload, null, 2)}'`;
}

function scoreVariant(score: number): BadgeVariant {
  if (score >= 0.8) return 'success';
  if (score >= 0.5) return 'warning';
  return 'error';
}

function LatencyBar({ latency }: { latency: SearchAIQueryResult['latency'] }) {
  const t = useTranslations('search_ai.playground');
  const total = latency.totalMs || 1;

  // Detailed timing breakdown (when available from runtime instrumentation)
  const hasDetailedTiming =
    latency.embeddingMs !== undefined ||
    latency.opensearchMs !== undefined ||
    latency.questionParentMs !== undefined ||
    latency.dslBuildMs !== undefined;

  const segments = hasDetailedTiming
    ? [
        { label: 'Embedding', ms: latency.embeddingMs || 0, color: 'bg-error' },
        { label: 'OpenSearch', ms: latency.opensearchMs || 0, color: 'bg-info' },
        { label: 'Question→Parent', ms: latency.questionParentMs || 0, color: 'bg-success' },
        { label: 'DSL Build', ms: latency.dslBuildMs || 0, color: 'bg-accent' },
        { label: 'Vocabulary', ms: latency.vocabularyResolveMs || 0, color: 'bg-purple' },
        { label: 'Rerank', ms: latency.rerankMs || 0, color: 'bg-warning' },
      ].filter((s) => s.ms > 0)
    : [
        { label: t('latency_vocabulary'), ms: latency.vocabularyResolveMs, color: 'bg-purple' },
        { label: t('latency_vector'), ms: latency.vectorSearchMs, color: 'bg-accent' },
        { label: t('latency_filter'), ms: latency.structuredFilterMs, color: 'bg-info' },
        { label: t('latency_rerank'), ms: latency.rerankMs, color: 'bg-warning' },
      ].filter((s) => s.ms > 0);

  const nonEmbeddingTime = hasDetailedTiming
    ? (latency.opensearchMs || 0) +
      (latency.questionParentMs || 0) +
      (latency.dslBuildMs || 0) +
      (latency.vocabularyResolveMs || 0) +
      (latency.rerankMs || 0)
    : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">Search retrieval time</span>
        <span className="font-mono text-foreground">{total.toFixed(0)}ms</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden bg-background-muted">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={`${seg.color} opacity-80`}
            style={{ width: `${(seg.ms / total) * 100}%` }}
            title={`${seg.label}: ${seg.ms.toFixed(0)}ms`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${seg.color} opacity-80`} />
            <span className="text-muted">{seg.label}</span>
            <span className="font-mono text-foreground">{seg.ms.toFixed(0)}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function QueryPlaygroundTab({ indexId, documentCount }: QueryPlaygroundTabProps) {
  const t = useTranslations('search_ai.playground');
  const setTab = useNavigationStore((s) => s.setTab);

  const QUERY_TYPES = useMemo(
    () => [
      { value: 'hybrid', label: t('query_type_hybrid') },
      { value: 'vector', label: t('query_type_vector') },
      { value: 'keyword', label: t('query_type_keyword') },
    ],
    [t],
  );

  const RESOLVE_MODES = useMemo(
    () => [
      { value: 'exact', label: t('resolve_mode_exact') },
      { value: 'alias', label: t('resolve_mode_alias') },
      { value: 'fuzzy', label: t('resolve_mode_fuzzy') },
    ],
    [t],
  );

  // Persist search parameters via Zustand store across tab switches
  const query = useSearchTabStore((s) => s.query);
  const setQuery = useSearchTabStore((s) => s.setQuery);
  const queryType = useSearchTabStore((s) => s.queryType);
  const setQueryType = useSearchTabStore((s) => s.setQueryType);
  const topK = useSearchTabStore((s) => s.topK);
  const setTopK = useSearchTabStore((s) => s.setTopK);
  const resolveMode = useSearchTabStore((s) => s.resolveMode);
  const setResolveMode = useSearchTabStore((s) => s.setResolveMode);
  const skipPreprocessing = useSearchTabStore((s) => s.skipPreprocessing);
  const setSkipPreprocessing = useSearchTabStore((s) => s.setSkipPreprocessing);

  // Auto-debug store setters — debug fires in parallel with every search
  const setDebugTrace = useSearchTabStore((s) => s.setDebugTrace);
  const setDebugResults = useSearchTabStore((s) => s.setResults);
  const setIsAutoDebugging = useSearchTabStore((s) => s.setIsAutoDebugging);
  const setAutoDebugError = useSearchTabStore((s) => s.setAutoDebugError);

  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [results, setResults] = useState<SearchAIQueryResult | null>(null);
  const [vocabResult, setVocabResult] = useState<VocabularyResolutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRawContent, setShowRawContent] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setSearching(true);
    setError(null);
    setResults(null);
    setVocabResult(null);

    // Clear previous auto-debug state
    setDebugTrace(null);
    setDebugResults(null);
    setAutoDebugError(null);
    setIsAutoDebugging(true);

    // Fire search (fast path, no debug overhead) — await this for immediate results
    const searchPromise = executeQuery(indexId, {
      query: query.trim(),
      queryType: queryType as 'vector' | 'hybrid' | 'keyword',
      topK: parseInt(topK, 10) || 10,
      debug: false,
      skipPreprocessing,
    });

    // Fire debug in parallel (non-blocking) — same queryType + topK as the search
    // so the debug trace accurately reflects what the search query actually did.
    // Auto-debug is best-effort. It should never break the primary search flow
    // if the debug request throws or returns an unexpected payload shape.
    void (async () => {
      try {
        const debugResult = (await executeQuery(indexId, {
          query: query.trim(),
          queryType: queryType as 'vector' | 'hybrid' | 'keyword',
          topK: parseInt(topK, 10) || 10,
          debug: true,
          skipPreprocessing,
        })) as SearchAIQueryResult | undefined;

        setDebugTrace((debugResult?.debugTrace as any) ?? null);
        setDebugResults(debugResult?.results ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setAutoDebugError(message);
      } finally {
        setIsAutoDebugging(false);
      }
    })();

    // Await search results (appears immediately, not blocked by debug)
    try {
      const result = await searchPromise;
      setResults(result);
    } catch (err) {
      setError(sanitizeError(err, t('error_search_failed')));
    } finally {
      setSearching(false);
    }
  }, [
    indexId,
    query,
    queryType,
    topK,
    skipPreprocessing,
    setDebugTrace,
    setDebugResults,
    setIsAutoDebugging,
    setAutoDebugError,
    t,
  ]);

  const handleResolve = useCallback(async () => {
    if (!query.trim()) return;

    setResolving(true);
    setError(null);
    setVocabResult(null);

    try {
      const result = await resolveVocabulary(
        indexId,
        query.trim(),
        resolveMode as 'exact' | 'alias' | 'fuzzy',
      );
      setVocabResult(result);
    } catch (err) {
      setError(sanitizeError(err, t('error_resolve_failed')));
    } finally {
      setResolving(false);
    }
  }, [indexId, query, resolveMode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  const handleCopyApiCall = useCallback(async () => {
    const payload = buildApiPayload(query, queryType, topK);
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast.success(t('copied'));
  }, [query, queryType, topK, t]);

  const handleCopyCurl = useCallback(async () => {
    const payload = buildApiPayload(query, queryType, topK);
    await navigator.clipboard.writeText(buildCurlCommand(indexId, payload));
    toast.success(t('copied'));
  }, [indexId, query, queryType, topK, t]);

  const handleCopyRawContent = useCallback(
    async (structuredData: any) => {
      await navigator.clipboard.writeText(JSON.stringify(structuredData, null, 2));
      toast.success(t('copied'));
    },
    [t],
  );

  return (
    <div className="space-y-6">
      {/* Query Input */}
      <Card hoverable={false} padding="lg">
        <div className="space-y-4">
          <Input
            label={t('query_label')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('query_placeholder')}
          />

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <Select
              label={t('query_type_label')}
              options={QUERY_TYPES}
              value={queryType}
              onChange={setQueryType}
            />
            <Input
              label={t('top_k_label')}
              type="number"
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
              placeholder="10"
            />
            <Select
              label={t('resolve_mode_label')}
              options={RESOLVE_MODES}
              value={resolveMode}
              onChange={setResolveMode}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer group w-fit">
            <input
              type="checkbox"
              checked={!skipPreprocessing}
              onChange={(e) => setSkipPreprocessing(!e.target.checked)}
              className="h-4 w-4 rounded border-default text-accent focus:ring-border-focus cursor-pointer"
            />
            <span className="text-sm text-foreground group-hover:text-accent transition-default">
              {t('enable_preprocessing')}
            </span>
          </label>

          {queryType === 'keyword' && <p className="text-xs text-muted">{t('keyword_hint')}</p>}

          <div className="flex gap-3">
            <Button
              icon={<Play className="w-4 h-4" />}
              onClick={handleSearch}
              loading={searching}
              disabled={!query.trim()}
            >
              {t('search')}
            </Button>
            <Button
              variant="secondary"
              icon={<BookOpen className="w-4 h-4" />}
              onClick={handleResolve}
              loading={resolving}
              disabled={!query.trim()}
            >
              {t('resolve_vocabulary')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy className="w-4 h-4" />}
              onClick={handleCopyApiCall}
              disabled={!query.trim()}
            >
              {t('copy_api_call')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Terminal className="w-4 h-4" />}
              onClick={handleCopyCurl}
              disabled={!query.trim()}
            >
              {t('copy_curl')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-error bg-error-subtle p-4 text-sm text-error">
          {error}
        </div>
      )}

      {/* Vocabulary Resolution Result */}
      {vocabResult && (
        <Card hoverable={false} padding="lg">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            {t('vocabulary_resolution')}
          </h3>
          {vocabResult.resolvedTerms.length > 0 ? (
            <div className="space-y-3">
              {vocabResult.resolvedTerms.map((term, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <Badge variant="default">{term.inputTerm}</Badge>
                  <span className="text-muted">→</span>
                  <Badge variant="success">{term.matchedTerm}</Badge>
                  <Badge variant="info">{term.matchType}</Badge>
                  <Badge variant={scoreVariant(term.confidence)}>
                    {Math.round(term.confidence * 100)}%
                  </Badge>
                </div>
              ))}
              {vocabResult.unresolvedSegments.length > 0 && (
                <div className="text-xs text-muted">
                  {t('unresolved', { segments: vocabResult.unresolvedSegments.join(', ') })}
                </div>
              )}
              {vocabResult.structuredFilters.length > 0 && (
                <div className="mt-2">
                  <span className="text-xs text-muted block mb-1">{t('generated_filters')}</span>
                  <JsonViewer data={vocabResult.structuredFilters} maxDepth={3} />
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">{t('no_terms_resolved')}</p>
          )}
        </Card>
      )}

      {/* Search Results */}
      {results && (
        <div className="space-y-4">
          {/* Latency */}
          <Card hoverable={false} padding="lg">
            <LatencyBar latency={results.latency} />
          </Card>

          {/* Vocabulary Trace (from search debug) */}
          {results.vocabularyTrace && results.vocabularyTrace.resolvedTerms.length > 0 && (
            <Card hoverable={false} padding="lg">
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                {t('vocabulary_trace')}
              </h3>
              <div className="space-y-2">
                {results.vocabularyTrace.resolvedTerms.map((term, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-muted">{term.inputTerm}</span>
                    <span className="text-muted">→</span>
                    <Badge variant="success">{term.matchedTerm}</Badge>
                    <Badge variant="info">{term.matchType}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Structured Data Results (from ClickHouse text-to-SQL enrichment) — SHOWN FIRST */}
          {results.structuredData &&
            results.structuredData.results &&
            results.structuredData.results.length > 0 && (
              <Card hoverable={false} padding="lg">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    {t('structured_data_title')}
                  </h3>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Code className="w-4 h-4" />}
                      onClick={() => setShowRawContent(!showRawContent)}
                    >
                      {showRawContent ? 'Hide Raw Content' : 'Raw Content'}
                    </Button>
                    {showRawContent && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy className="w-4 h-4" />}
                        onClick={() => handleCopyRawContent(results.structuredData)}
                      >
                        Copy
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {/* Intent & execution info */}
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {results.structuredData.intent && (
                      <Badge variant="info">
                        {t('structured_data_intent', {
                          type: results.structuredData.intent.type,
                          confidence: Math.round(results.structuredData.intent.confidence * 100),
                        })}
                      </Badge>
                    )}
                    <Badge variant="default">
                      {t('structured_data_rows', {
                        count: results.structuredData.results.length,
                      })}
                    </Badge>
                    {results.structuredData.executionTimeMs > 0 && (
                      <span className="text-muted font-mono">
                        {t('structured_data_time', {
                          ms: results.structuredData.executionTimeMs,
                        })}
                      </span>
                    )}
                  </div>

                  {/* Raw Content View */}
                  {showRawContent && (
                    <div>
                      <span className="text-xs text-muted block mb-1">Raw JSON</span>
                      <JsonViewer data={results.structuredData} maxDepth={5} />
                    </div>
                  )}

                  {/* Generated SQL */}
                  {!showRawContent && results.structuredData.sqlGenerated && (
                    <div>
                      <span className="text-xs text-muted block mb-1 flex items-center gap-1">
                        <Code className="w-3 h-3" />
                        {t('structured_data_sql')}
                      </span>
                      <pre className="bg-background-muted rounded-lg p-3 text-xs font-mono text-foreground overflow-x-auto">
                        {results.structuredData.sqlGenerated}
                      </pre>
                    </div>
                  )}

                  {/* Data table */}
                  {!showRawContent &&
                    (() => {
                      const rows = results.structuredData!.results;
                      const columns = rows.length > 0 ? Object.keys(rows[0].rowData) : [];
                      if (columns.length === 0) return null;

                      return (
                        <div className="overflow-x-auto rounded-lg border border-default">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-background-muted">
                                <th className="px-3 py-2 text-left font-medium text-muted">#</th>
                                {columns.map((col) => (
                                  <th
                                    key={col}
                                    className="px-3 py-2 text-left font-medium text-muted"
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((row, rowIdx) => (
                                <tr
                                  key={rowIdx}
                                  className="border-t border-default hover:bg-background-muted/50"
                                >
                                  <td className="px-3 py-2 text-muted font-mono">{rowIdx + 1}</td>
                                  {columns.map((col) => (
                                    <td
                                      key={col}
                                      className="px-3 py-2 text-foreground max-w-[200px] truncate"
                                      title={String(row.rowData[col] ?? '')}
                                    >
                                      {String(row.rowData[col] ?? '')}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                </div>
              </Card>
            )}

          {/* Chunks Results — SHOWN AFTER STRUCTURED DATA */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              {results.totalCount !== undefined
                ? t('results_title_with_total', {
                    count: results.results.length,
                    total: results.totalCount,
                  })
                : t('results_title', { count: results.results.length })}
            </h3>
          </div>

          {results.results.length === 0 ? (
            documentCount === 0 ? (
              <EmptyState
                icon={<Play className="w-6 h-6" />}
                title={t('no_data_title')}
                description={t('no_data_description')}
                action={
                  <Button variant="secondary" onClick={() => setTab('data')}>
                    {t('go_to_data_tab')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Play className="w-6 h-6" />}
                title={t('no_matches_title')}
                description={t('no_matches_description')}
              />
            )
          ) : (
            <div className="space-y-3">
              {results.results.map((result, i) => (
                <Card key={result.chunkId || i} hoverable={false} padding="md">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={scoreVariant(result.score ?? 0)}>
                        {(result.score ?? 0).toFixed(3)}
                      </Badge>
                      {result.source && (
                        <span className="text-xs text-muted">{result.source.sourceName}</span>
                      )}
                    </div>
                    <span className="text-xs text-muted font-mono">#{i + 1}</span>
                  </div>

                  {result.content && (
                    <p className="text-sm text-foreground mb-3 whitespace-pre-wrap line-clamp-4">
                      {result.content}
                    </p>
                  )}

                  {result.metadata && Object.keys(result.metadata).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-default">
                      <span className="text-xs text-muted block mb-1">{t('metadata')}</span>
                      <JsonViewer data={result.metadata} maxDepth={2} />
                    </div>
                  )}

                  {result.source?.reference && (
                    <div className="mt-2 text-xs text-muted">
                      {t('ref', { reference: result.source.reference })}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state when nothing has been searched yet */}
      {!results && !vocabResult && !error && (
        <EmptyState
          icon={<Play className="w-6 h-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      )}
    </div>
  );
}
