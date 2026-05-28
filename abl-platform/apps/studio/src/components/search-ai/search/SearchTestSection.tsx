/**
 * SearchTestSection Component
 *
 * Layout wrapper for query playground and diagnostic sidebar.
 * Two-column layout: QueryPlaygroundTab (2/3) + DiagnosticCard (1/3).
 * Includes a debug section below for resolution chain visualization.
 */

import { useState, useCallback, useEffect } from 'react';
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../ui/Button';
import { QueryPlaygroundTab } from '../QueryPlaygroundTab';
import { QueryDiagnosticCard } from './QueryDiagnosticCard';
import { ResolutionChain } from './ResolutionChain';
import { StageDetail } from './StageDetail';
import { ScoreBreakdown } from './ScoreBreakdown';
import { QueryHistory } from './QueryHistory';
import { QueryCompare } from './QueryCompare';
import { executeQuery, getIndex } from '../../../api/search-ai';
import type { QueryHistoryItem } from '../../../api/search-ai';
import { STAGE_KEYS, type PipelineDebugTrace, type PipelineStageTrace } from './debug-types';
import { useSearchTabStore } from '../../../store/search-tab-store';
import { useNavigationStore } from '../../../store/navigation-store';

interface SearchTestSectionProps {
  indexId: string;
  knowledgeBaseId: string;
}

export function SearchTestSection({ indexId, knowledgeBaseId }: SearchTestSectionProps) {
  const t = useTranslations('search_ai.debug');
  const tSearch = useTranslations('search_ai.search');
  const tHistory = useTranslations('search_ai.query_history');
  const setTab = useNavigationStore((s) => s.setTab);

  // Fetch index data for LLM config check and document count
  const { data: indexData } = useSWR(indexId ? [`/indexes/${indexId}`, indexId] : null, () =>
    getIndex(indexId),
  );
  const documentCount = indexData?.index?.documentCount ?? undefined;

  // Use the tenant's DEFAULT model (the one with the star in Model Library).
  // This is the exact model the user chose — no tier-based selection which
  // varies per use case and could show a different model (e.g., gpt-4o-mini
  // for a "fast" tier use case when the user's default is gpt-4o).
  const connectedModelName = indexData?.defaultModel?.displayName ?? null;

  // Fallback: if defaultModel not available (backend not restarted), check enhanced config.
  // Priority: balanced tier (the default) → any active use case → legacy balanced → any legacy.
  const fallbackModelName = (() => {
    if (connectedModelName) return connectedModelName;

    const enhancedLLM = indexData?.enhancedLLMConfig as Record<string, unknown> | null | undefined;
    const enhancedUseCases = enhancedLLM?.useCases as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (enhancedUseCases) {
      // Prefer balanced tier use case (matches the tenant's default model tier)
      const entries = Object.values(enhancedUseCases);
      const balanced = entries.find(
        (uc) =>
          (uc.status === 'active' || uc.status === 'fallback') &&
          uc.modelTier === 'balanced' &&
          (uc.model as Record<string, unknown> | undefined)?.displayName,
      );
      if (balanced) return (balanced.model as Record<string, unknown>).displayName as string;
      // Fall back to any active
      for (const uc of entries) {
        if (uc.status === 'active' || uc.status === 'fallback') {
          const model = uc.model as Record<string, unknown> | undefined;
          if (model?.displayName) return model.displayName as string;
        }
      }
      return null;
    }

    // Legacy fallback — prefer balanced tier model
    const resolvedLLM = indexData?.resolvedLLMConfig as Record<string, unknown> | null | undefined;
    if (!resolvedLLM) return null;
    const useCases = resolvedLLM.useCases as Record<string, Record<string, unknown>> | undefined;
    if (useCases) {
      // Find a balanced tier use case first (e.g., vision → gpt-4o, not progressiveSummarization → gpt-4o-mini)
      const ucEntries = Object.values(useCases);
      const balancedUc = ucEntries.find(
        (uc) => uc.enabled && uc.model && uc.modelTier === 'balanced',
      );
      if (balancedUc) return balancedUc.model as string;
      // Any enabled
      for (const uc of ucEntries) {
        if (uc.enabled && uc.model) return uc.model as string;
      }
    }
    return null;
  })();

  const displayModelName = connectedModelName ?? fallbackModelName;
  const hasLLMConfig = Boolean(displayModelName);

  const [selectedQueryIds, setSelectedQueryIds] = useState<Set<string>>(new Set());
  const [compareQueries, setCompareQueries] = useState<QueryHistoryItem[]>([]);

  const handleSelectQuery = useCallback((query: QueryHistoryItem) => {
    setSelectedQueryIds((prev) => {
      const next = new Set(prev);
      if (next.has(query.queryId)) {
        // Deselect
        next.delete(query.queryId);
        setCompareQueries((cq) => cq.filter((q) => q.queryId !== query.queryId));
      } else if (next.size < 2) {
        // Select (max 2)
        next.add(query.queryId);
        setCompareQueries((cq) => [...cq, query]);
      } else {
        // Replace oldest selection
        const oldest = [...next][0];
        next.delete(oldest);
        next.add(query.queryId);
        setCompareQueries((cq) => [...cq.filter((q) => q.queryId !== oldest), query]);
      }
      return next;
    });
  }, []);

  // Unified query from store — shared between playground and debug
  const debugQuery = useSearchTabStore((s) => s.query);

  const debugTrace = useSearchTabStore((s) => s.debugTrace);
  const setDebugTrace = useSearchTabStore((s) => s.setDebugTrace);
  const debugResults = useSearchTabStore((s) => s.results);
  const setDebugResults = useSearchTabStore((s) => s.setResults);

  // Auto-debug runs in parallel with every search (from QueryPlaygroundTab)
  const isAutoDebugging = useSearchTabStore((s) => s.isAutoDebugging);
  const autoDebugError = useSearchTabStore((s) => s.autoDebugError);

  // Manual "Run Debug" still supported as a re-run option
  const [isManualDebugging, setIsManualDebugging] = useState(false);
  const [manualDebugError, setManualDebugError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [openStages, setOpenStages] = useState<Set<string>>(new Set());

  // Combined loading state: either auto-debug or manual debug
  const isDebugging = isAutoDebugging || isManualDebugging;
  // Show the most recent error (manual takes priority since it's user-initiated)
  const debugError = manualDebugError ?? autoDebugError;

  const handleDebugQuery = useCallback(async () => {
    if (!debugQuery.trim()) return;
    setIsManualDebugging(true);
    setManualDebugError(null);
    try {
      const result = await executeQuery(indexId, {
        query: debugQuery,
        debug: true,
      });
      const trace = result.debugTrace as PipelineDebugTrace | undefined;
      setDebugTrace(trace ?? null);
      setDebugResults(result.results ?? null);
      // Auto-open all applied stages
      if (trace) {
        const applied = new Set<string>();
        for (const key of STAGE_KEYS) {
          if (trace.stages[key]?.applied) {
            applied.add(key);
          }
        }
        setOpenStages(applied);
        setActiveStage(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setManualDebugError(sanitizeError(message, t('debug_error_fallback')));
      setDebugTrace(null);
      setDebugResults(null);
    } finally {
      setIsManualDebugging(false);
    }
  }, [debugQuery, indexId, t]);

  // Auto-open applied stages when debugTrace arrives (from auto-debug or manual)
  useEffect(() => {
    if (debugTrace) {
      const applied = new Set<string>();
      for (const key of STAGE_KEYS) {
        if (debugTrace.stages[key]?.applied) {
          applied.add(key);
        }
      }
      setOpenStages(applied);
      setActiveStage(null);
    }
  }, [debugTrace]);

  const handleStageClick = useCallback((stageName: string) => {
    setActiveStage((prev) => (prev === stageName ? null : stageName));
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (next.has(stageName)) {
        next.delete(stageName);
      } else {
        next.add(stageName);
      }
      return next;
    });
  }, []);

  const toggleStage = useCallback((stageName: string) => {
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (next.has(stageName)) {
        next.delete(stageName);
      } else {
        next.add(stageName);
      }
      return next;
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* LLM awareness banner */}
      {indexId &&
        (hasLLMConfig ? (
          <div className="flex items-center gap-3 rounded-lg border border-success bg-success-subtle px-4 py-3">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            <p className="text-sm text-foreground flex-1">
              {displayModelName
                ? tSearch('llm_connected_with_model', { model: displayModelName })
                : tSearch('llm_connected')}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-warning bg-warning-subtle px-4 py-3">
            <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0" />
            <p className="text-sm text-foreground flex-1">{tSearch('llm_not_configured')}</p>
            <Button variant="secondary" size="sm" onClick={() => setTab('intelligence')}>
              {tSearch('configure_llm')}
            </Button>
          </div>
        ))}

      {/* Existing 2-column layout */}
      <div className="flex gap-6 h-full">
        <div className="w-2/3 min-w-0">
          <QueryPlaygroundTab indexId={indexId} documentCount={documentCount} />
        </div>
        <div className="w-1/3 min-w-0">
          <QueryDiagnosticCard indexId={indexId} knowledgeBaseId={knowledgeBaseId} />
        </div>
      </div>

      {/* Debug section — uses the shared query from the playground */}
      <div className="border-t border-default pt-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>
              <p className="text-sm text-muted mt-0.5">{t('auto_debug_description')}</p>
            </div>
            <div className="flex items-center gap-2">
              {isAutoDebugging && (
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('auto_debug_running')}
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDebugQuery}
                disabled={!debugQuery.trim() || isDebugging}
                loading={isManualDebugging}
              >
                {t('re_run_debug')}
              </Button>
            </div>
          </div>

          {/* Error message */}
          {debugError && (
            <div className="text-sm text-error bg-error-subtle rounded-lg px-4 py-2">
              {debugError}
            </div>
          )}

          {/* No data state */}
          {!debugTrace && !debugError && !isDebugging && (
            <div className="text-sm text-muted py-8 text-center">{t('no_debug_data')}</div>
          )}

          {/* Resolution chain */}
          {debugTrace && (
            <div className="space-y-4">
              <ResolutionChain
                debugTrace={debugTrace}
                activeStage={activeStage}
                onStageClick={handleStageClick}
              />

              {/* Stage details */}
              <div className="space-y-2">
                {STAGE_KEYS.filter((key) => debugTrace.stages[key]).map((key) => (
                  <StageDetail
                    key={key}
                    stageName={key}
                    stage={debugTrace.stages[key] as PipelineStageTrace & Record<string, unknown>}
                    isOpen={openStages.has(key)}
                    onToggle={() => toggleStage(key)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Score breakdown */}
          {debugResults && debugResults.length > 0 && <ScoreBreakdown results={debugResults} />}
        </div>
      </div>

      {/* Query History section */}
      <div className="border-t border-default pt-6">
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{tHistory('title')}</h3>
            <p className="text-sm text-muted mt-0.5">{tHistory('description')}</p>
          </div>
          <div className="flex gap-6">
            <div className="w-1/2 min-w-0">
              <QueryHistory
                indexId={indexId}
                onSelectQuery={handleSelectQuery}
                selectedIds={selectedQueryIds}
              />
            </div>
            <div className="w-1/2 min-w-0">
              <QueryCompare queries={compareQueries} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
