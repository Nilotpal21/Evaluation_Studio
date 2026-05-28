/**
 * KnowledgeGraphTab Component
 *
 * Knowledge Graph exploration tab with 4-state machine:
 *   1. Neo4j not provisioned → KGNotDeployedCard (informational)
 *   2. No models / needs onboarding → KGOnboardingCard (value prop + setup delegation)
 *   3. KG enabled, no taxonomy → KGOnboardingCard (delegates to KGTaxonomySetupCard)
 *   4. KG enabled + taxonomy exists → taxonomy summary + graph/stats/attributes view
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Network,
  FileText,
  Tag,
  TrendingUp,
  BarChart3,
  Database,
  AlertCircle,
  X,
  Play,
  MoreVertical,
  Trash2,
  RefreshCw,
  Diamond,
  Loader2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import {
  useKGStats,
  useClassifiedDocuments,
  useEntityDistribution,
  useGraphStructure,
  useKGTaxonomy,
  useKGConfigurationStatus,
} from '../../hooks/useKnowledgeGraph';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { DataTable } from '../ui/DataTable';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { KGTaxonomyTree } from './KGTaxonomyTree';
import { KGForceGraph } from './KGForceGraph';
import { KGNotDeployedCard } from './KGNotDeployedCard';
import { KGOnboardingCard } from './KGOnboardingCard';
import { triggerEnrichment, deleteTaxonomy } from '../../api/search-ai';
import type { GraphNode, SearchAIIndex } from '../../api/search-ai';
import { useNavigationStore } from '../../store/navigation-store';
import { useReviewQueue } from '../../hooks/useAttributes';
import { AttributeManagerSection } from './attributes/AttributeManagerSection';

interface KnowledgeGraphTabProps {
  indexId: string;
}

export function KnowledgeGraphTab({ indexId }: KnowledgeGraphTabProps) {
  const t = useTranslations('search_ai.kg');

  // ── State Machine: check KG enabled + taxonomy existence ─────────────
  const {
    data: indexData,
    isLoading: indexLoading,
    mutate: refreshIndex,
  } = useSWR<{ index: SearchAIIndex }>(indexId ? `/api/search-ai/indexes/${indexId}` : null);

  // Optimistic local state — set immediately on user action to avoid flicker
  const [optimisticKGEnabled, setOptimisticKGEnabled] = useState<boolean | null>(null);

  const kgConfig = indexData?.index?.llmConfig?.useCases?.knowledgeGraph;
  const kgEnabledFromServer = kgConfig?.enabled === true;
  const kgEnabled = optimisticKGEnabled ?? kgEnabledFromServer;

  // Reset optimistic override once server state confirms the expected value.
  // Guard: only reset when server matches optimistic to avoid flicker during
  // revalidateOnFocus race (server may not have persisted yet).
  useEffect(() => {
    if (optimisticKGEnabled !== null && kgEnabledFromServer === optimisticKGEnabled) {
      setOptimisticKGEnabled(null);
    }
  }, [kgEnabledFromServer, optimisticKGEnabled]);

  const hasModelConfigured = !!kgConfig?.modelId;

  const {
    taxonomy: taxonomyFromApi,
    isLoading: taxonomyLoading,
    isNotFound: taxonomyNotFound,
    refresh: refreshTaxonomy,
  } = useKGTaxonomy(indexId);

  const taxonomy = taxonomyFromApi;

  const {
    status: configStatus,
    isLoading: configLoading,
    refresh: refreshConfigStatus,
  } = useKGConfigurationStatus(indexId);

  // View mode from navigation store (supports auto-navigation from KG Hub Card)
  const kgView = useNavigationStore((s) => s.kgView);
  const setKgView = useNavigationStore((s) => s.setKgView);

  // Review queue total for attributes badge on toggle
  const { total: reviewQueueTotal } = useReviewQueue(indexId);

  // Graph state
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [includeEntityInstances, setIncludeEntityInstances] = useState(false);

  // Edge type filter for graph view
  const ALL_EDGE_TYPES = [
    'HAS_CATEGORY',
    'HAS_PRODUCT',
    'HAS_ATTRIBUTE',
    'INSTANCE_OF',
    'FOUND_IN_PRODUCT',
  ] as const;
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(new Set(ALL_EDGE_TYPES));

  const toggleEdgeType = (type: string) => {
    setVisibleEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Entity limit for graph density control
  const [entityLimit, setEntityLimit] = useState(20);

  // Statistics filters
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<number>(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

  // Actions dropdown
  const [showActions, setShowActions] = useState(false);

  // Cleanup timer for delayed SWR refresh to prevent unmount leaks
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Loading guards for async actions
  const [isEnriching, setIsEnriching] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Data fetching — fire when taxonomy exists (taxonomy existence is the true
  // indicator that KG was set up, even if llmConfig hasn't been fully propagated)
  const hasTaxonomy = (kgEnabled || !!taxonomy) && taxonomy && !taxonomyNotFound;
  const {
    stats: statsFromApi,
    isLoading: statsLoadingFromApi,
    error: statsErrorFromApi,
    refresh: refreshStats,
  } = useKGStats(hasTaxonomy ? indexId : null);
  const {
    graph: graphFromApi,
    isLoading: graphLoadingFromApi,
    error: graphErrorFromApi,
    refresh: refreshGraph,
  } = useGraphStructure(hasTaxonomy ? indexId : null, {
    productId: selectedProduct || undefined,
    includeEntityInstances,
    entityLimit,
  });
  const {
    documents: documentsFromApi,
    isLoading: docsLoadingFromApi,
    error: docsErrorFromApi,
  } = useClassifiedDocuments(hasTaxonomy ? indexId : null, {
    page,
    limit,
    productId: selectedProduct || undefined,
    department: selectedDepartment || undefined,
    minConfidence: minConfidence > 0 ? minConfidence : undefined,
    sortBy: 'confidence',
    sortOrder: 'desc',
  });
  const {
    entities: entitiesFromApi,
    isLoading: entitiesLoadingFromApi,
    error: entitiesErrorFromApi,
  } = useEntityDistribution(hasTaxonomy ? indexId : null, {
    productId: selectedProduct || undefined,
    limit: 100,
  });

  // Data aliases for downstream use
  const stats = statsFromApi;
  const statsError = statsErrorFromApi;
  const graph = graphFromApi;
  const graphLoading = graphLoadingFromApi;
  const graphError = graphErrorFromApi;
  const documents = documentsFromApi;
  const docsLoading = docsLoadingFromApi;
  const docsError = docsErrorFromApi;
  const entities = entitiesFromApi;
  const entitiesLoading = entitiesLoadingFromApi;
  const entitiesError = entitiesErrorFromApi;

  // Filtered graph data based on visible edge types
  const filteredGraphEdges = useMemo(
    () => graph?.edges.filter((e) => visibleEdgeTypes.has(e.type)) ?? [],
    [graph, visibleEdgeTypes],
  );
  const filteredGraphNodes = useMemo(() => {
    if (!graph) return [];
    const connectedNodeIds = new Set([
      ...filteredGraphEdges.map((e) => e.from),
      ...filteredGraphEdges.map((e) => e.to),
    ]);
    return graph.nodes.filter((n) => n.type === 'domain' || connectedNodeIds.has(n.id));
  }, [graph, filteredGraphEdges]);

  // Node click handler - progressive disclosure
  const handleNodeClick = (node: GraphNode) => {
    setSelectedNode(node);
    if (node.type === 'product') {
      setSelectedProduct(node.id);
      setIncludeEntityInstances(true);
    }
  };

  const handleClearSelection = () => {
    setSelectedNode(null);
    setSelectedProduct(null);
    setIncludeEntityInstances(false);
  };

  const handleRunEnrichment = async () => {
    if (isEnriching) return;
    setIsEnriching(true);
    try {
      await triggerEnrichment(indexId);
      toast.success(t('taxonomy_run_enrichment_success'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsEnriching(false);
    }
  };

  const handleDeleteTaxonomy = async () => {
    if (!confirm(t('taxonomy_delete_confirm'))) return;
    setIsDeleting(true);
    try {
      await deleteTaxonomy(indexId);
      toast.success(t('taxonomy_delete_success'));
      refreshTaxonomy();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
      setShowActions(false);
    }
  };

  const handleTaxonomySetupComplete = useCallback(() => {
    // Refresh taxonomy first
    refreshTaxonomy();
    refreshConfigStatus();
    // After taxonomy loads, refresh graph and stats (cleanup via refreshTimerRef)
    refreshTimerRef.current = setTimeout(() => {
      refreshGraph();
      refreshStats();
    }, 1000);
  }, [refreshTaxonomy, refreshConfigStatus, refreshGraph, refreshStats]);

  // First-visit completion: model auto-configured + taxonomy created in one flow
  const handleFirstVisitComplete = useCallback(() => {
    setOptimisticKGEnabled(true);
    refreshIndex();
    refreshTaxonomy();
    refreshConfigStatus();
    refreshTimerRef.current = setTimeout(() => {
      refreshGraph();
      refreshStats();
    }, 1000);
  }, [refreshIndex, refreshTaxonomy, refreshConfigStatus, refreshGraph, refreshStats]);

  // ── Loading state (initial page load only — skip when user just toggled) ──
  const isInitialLoad =
    optimisticKGEnabled === null &&
    ((indexLoading && !indexData) ||
      (configLoading && !configStatus) ||
      (taxonomyLoading && !taxonomy && !taxonomyNotFound));
  if (isInitialLoad) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="p-4">
              <div className="skeleton h-12 w-full" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // ── State 1: Environment check — Neo4j not available ──────────────────
  if (configStatus && !configStatus.environment?.available) {
    return <KGNotDeployedCard />;
  }

  // ── Config status error guard ─────────────────────────────────────────
  // If configStatus failed to load (API 500) and isn't loading, show error
  // instead of falling through to onboarding with wrong mode.
  if (!configStatus && !configLoading) {
    return (
      <div className="py-12">
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title={t('error_title')}
          description={t('error_loading_graph')}
        />
      </div>
    );
  }

  // ── State 2: No models / needs onboarding (replaces KGConfigurationWizard) ──
  // Guard: skip onboarding if taxonomy already exists (data recovery for cases
  // where taxonomy was created but index.llmConfig wasn't updated properly).
  if (!kgEnabled && !hasModelConfigured && !taxonomy) {
    const onboardingMode = configStatus?.configurationLevel === 'none' ? 'no-models' : 'ready';
    const recommendation = configStatus?.tenant?.recommendation;
    const recommendedModel = configStatus?.tenant?.models?.find(
      (m) => m.id === recommendation?.modelId,
    );
    const workspace = configStatus?.workspace;
    const siblingConfig =
      workspace?.hasKGConfigured && workspace?.configuredIndexes?.[0]
        ? {
            name: workspace.configuredIndexes[0].knowledgeBaseName,
            model: workspace.configuredIndexes[0].model?.displayName ?? '',
          }
        : null;
    return (
      <KGOnboardingCard
        indexId={indexId}
        mode={onboardingMode}
        autoConfigureModelId={configStatus?.autoConfigureModelId ?? null}
        recommendedModelName={recommendedModel?.displayName ?? null}
        siblingConfig={siblingConfig}
        onComplete={handleFirstVisitComplete}
      />
    );
  }

  // ── State 3: KG enabled, no taxonomy → onboarding with domain picker ──
  // Guard: if taxonomy is loading (e.g. after first-visit completion triggered refreshTaxonomy),
  // show skeleton instead of flashing back to onboarding.
  if (taxonomyLoading && !taxonomy && !taxonomyNotFound) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="p-4">
              <div className="skeleton h-12 w-full" />
            </Card>
          ))}
        </div>
      </div>
    );
  }
  if (taxonomyNotFound || !taxonomy) {
    const recommendation = configStatus?.tenant?.recommendation;
    const recommendedModel = configStatus?.tenant?.models?.find(
      (m) => m.id === recommendation?.modelId,
    );
    return (
      <KGOnboardingCard
        indexId={indexId}
        mode="ready"
        autoConfigureModelId={configStatus?.autoConfigureModelId ?? null}
        recommendedModelName={recommendedModel?.displayName ?? null}
        siblingConfig={null}
        onComplete={handleTaxonomySetupComplete}
      />
    );
  }

  // ── State 3: Taxonomy exists → show taxonomy summary + graph/stats ───

  // Error state from stats
  if (statsError) {
    return (
      <div className="py-12">
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title={t('error_title')}
          description={statsError}
        />
      </div>
    );
  }

  const enrichmentProgress =
    stats && stats.totalDocuments > 0 ? (stats.enrichedDocuments / stats.totalDocuments) * 100 : 0;

  // TypeScript narrowing: taxonomy is guaranteed non-null at this point
  // (early returns above exit if taxonomy is null or not found)
  if (!taxonomy) return null;

  return (
    <div className="space-y-6">
      {/* Taxonomy Summary Header */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-purple" />
              <h3 className="text-sm font-semibold">{t('taxonomy_summary_title')}</h3>
            </div>
            <Badge variant="accent">{taxonomy.taxonomy.domain.name}</Badge>
            <span className="text-xs text-muted">v{taxonomy.version}</span>
            <span className="text-xs text-muted">
              {taxonomy.statistics.productsCount} {t('taxonomy_products').toLowerCase()} /{' '}
              {taxonomy.statistics.attributesCount} {t('taxonomy_attributes').toLowerCase()}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRunEnrichment}
              disabled={isEnriching}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-default disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEnriching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {t('taxonomy_run_enrichment')}
            </button>

            {/* Actions dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowActions(!showActions)}
                className="p-1.5 rounded-md hover:bg-background-muted transition-default"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {showActions && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-background-elevated border border-default rounded-lg shadow-lg py-1">
                    <button
                      onClick={handleDeleteTaxonomy}
                      disabled={isDeleting}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-background-muted transition-default disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      {t('taxonomy_delete')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* View Mode Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 bg-background-muted rounded-lg p-1">
          <button
            onClick={() => setKgView('graph')}
            className={clsx(
              'px-4 py-2 text-sm font-medium rounded-md transition-default',
              kgView === 'graph'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <Network className="w-4 h-4 inline mr-2" />
            {t('view_graph')}
          </button>
          <button
            onClick={() => setKgView('statistics')}
            className={clsx(
              'px-4 py-2 text-sm font-medium rounded-md transition-default',
              kgView === 'statistics'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <BarChart3 className="w-4 h-4 inline mr-2" />
            {t('view_statistics')}
          </button>
          <button
            onClick={() => setKgView('attributes')}
            className={clsx(
              'px-4 py-2 text-sm font-medium rounded-md transition-default',
              kgView === 'attributes'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <Diamond className="w-4 h-4 inline mr-2" />
            {t('view_attributes')}
            {reviewQueueTotal > 0 && (
              <Badge variant="warning" className="ml-2">
                {reviewQueueTotal}
              </Badge>
            )}
          </button>
        </div>

        {/* Clear filter when product selected */}
        {selectedProduct && kgView === 'graph' && (
          <button
            onClick={handleClearSelection}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-background-elevated border border-default rounded-md hover:bg-background-muted transition-default"
          >
            <X className="w-4 h-4" />
            {t('clear_filter')}
          </button>
        )}
      </div>

      {/* Graph View */}
      {kgView === 'graph' && (
        <div className="space-y-4">
          {/* Edge type filter + density controls */}
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-muted-foreground">{t('graph_edge_filter_label')}</span>
            {ALL_EDGE_TYPES.map((type) => (
              <Toggle
                key={type}
                checked={visibleEdgeTypes.has(type)}
                onChange={() => toggleEdgeType(type)}
                label={t(`graph_edge_type_${type.toLowerCase()}`)}
              />
            ))}
            <div className="ml-auto flex items-center gap-2">
              <label className="text-xs text-muted-foreground">
                {t('graph_entity_limit_label')}
              </label>
              <Select
                value={String(entityLimit)}
                onChange={(v) => setEntityLimit(Number(v))}
                options={[
                  { value: '5', label: '5' },
                  { value: '10', label: '10' },
                  { value: '20', label: '20' },
                  { value: '50', label: '50' },
                ]}
              />
            </div>
          </div>

          {/* Force-directed graph canvas — full width */}
          {graphLoading ? (
            <Card className="p-4 h-[600px] flex items-center justify-center">
              <div className="skeleton h-full w-full" />
            </Card>
          ) : graphError ? (
            <Card className="p-4 h-[600px]">
              <EmptyState
                icon={<AlertCircle className="w-8 h-8" />}
                title={t('error_loading_graph')}
                description={graphError}
              />
            </Card>
          ) : !graph || graph.nodes.length === 0 ? (
            <Card className="p-4 h-[600px]">
              <EmptyState
                icon={<Network className="w-8 h-8" />}
                title={t('no_graph_data_title')}
                description={t('no_graph_data_description')}
              />
            </Card>
          ) : (
            <Card className="overflow-hidden border border-default">
              <KGForceGraph
                key={`${entityLimit}-${Array.from(visibleEdgeTypes).sort().join(',')}`}
                nodes={filteredGraphNodes}
                edges={filteredGraphEdges}
                onNodeClick={handleNodeClick}
                selectedNodeId={selectedNode?.id || null}
              />
            </Card>
          )}

          {/* Below: Detail sidebar + Taxonomy tree side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Left: Selected Node Details + Stats */}
            <div className="lg:col-span-1 space-y-4">
              {selectedNode ? (
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold">{t('selected_node')}</h3>
                    <button
                      onClick={handleClearSelection}
                      className="p-1 hover:bg-background-muted rounded transition-default"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-muted mb-1">{t('node_label')}</p>
                      <p className="text-sm font-medium">{selectedNode.label}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted mb-1">{t('node_type')}</p>
                      <Badge variant="default">{selectedNode.type}</Badge>
                    </div>
                    {selectedNode.properties?.documentCount !== undefined && (
                      <div>
                        <p className="text-xs text-muted mb-1">{t('node_documents')}</p>
                        <p className="text-sm font-medium">
                          {selectedNode.properties.documentCount.toLocaleString()}
                        </p>
                      </div>
                    )}
                    {selectedNode.type === 'product' && (
                      <div className="pt-3 border-t border-default">
                        <p className="text-xs text-muted mb-2">
                          {includeEntityInstances
                            ? t('toggle_entity_instances_hide')
                            : t('toggle_entity_instances_show')}
                        </p>
                      </div>
                    )}
                    {selectedNode.type === 'entity_instance' && (
                      <>
                        <div>
                          <p className="text-xs text-muted mb-1">{t('node_raw_value')}</p>
                          <p className="text-sm">{selectedNode.properties?.rawValue}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted mb-1">{t('node_normalized_value')}</p>
                          <p className="text-sm font-mono text-xs">
                            {JSON.stringify(selectedNode.properties?.normalizedValue)}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </Card>
              ) : (
                <Card className="p-4">
                  <EmptyState
                    icon={<Network className="w-6 h-6" />}
                    title={t('select_node_title')}
                    description={t('select_node_description')}
                  />
                </Card>
              )}

              {/* Statistics Summary */}
              {stats && (
                <Card className="p-4">
                  <h3 className="text-sm font-semibold mb-3">{t('statistics_title')}</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t('total_documents')}</span>
                      <span className="font-medium">{stats.totalDocuments.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t('enriched')}</span>
                      <span className="font-medium text-success">
                        {stats.enrichedDocuments.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t('products')}</span>
                      <span className="font-medium">{stats.productsDistribution.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t('avg_confidence')}</span>
                      <span className="font-medium">{(stats.avgConfidence * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                </Card>
              )}
            </div>

            {/* Right: Taxonomy Tree */}
            <div className="lg:col-span-3">
              {graph && graph.nodes.length > 0 && (
                <KGTaxonomyTree
                  nodes={graph.nodes}
                  edges={graph.edges}
                  onNodeClick={handleNodeClick}
                  selectedNodeId={selectedNode?.id || null}
                  className="max-h-[400px]"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Statistics View */}
      {kgView === 'statistics' && (
        <>
          {/* Statistics Cards */}
          {stats && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted mb-1">{t('total_documents')}</p>
                    <p className="text-2xl font-semibold">
                      {stats.totalDocuments.toLocaleString()}
                    </p>
                  </div>
                  <Database className="w-4 h-4 text-muted" />
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted mb-1">{t('enriched_documents')}</p>
                    <p className="text-2xl font-semibold text-success">
                      {stats.enrichedDocuments.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {t('enrichment_progress', { percentage: enrichmentProgress.toFixed(1) })}
                    </p>
                  </div>
                  <TrendingUp className="w-4 h-4 text-success" />
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted mb-1">{t('avg_confidence')}</p>
                    <p className="text-2xl font-semibold">
                      {(stats.avgConfidence * 100).toFixed(1)}%
                    </p>
                  </div>
                  <BarChart3 className="w-4 h-4 text-purple" />
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted mb-1">{t('unique_products')}</p>
                    <p className="text-2xl font-semibold">{stats.productsDistribution.length}</p>
                  </div>
                  <Tag className="w-4 h-4 text-accent" />
                </div>
              </Card>
            </div>
          )}

          {/* Three-Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: Products Distribution */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-4">
                <Tag className="w-4 h-4 text-accent" />
                <h3 className="text-sm font-semibold">{t('products_distribution')}</h3>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {stats?.productsDistribution.map((product) => (
                  <button
                    key={product.productId}
                    onClick={() =>
                      setSelectedProduct(
                        selectedProduct === product.productId ? null : product.productId,
                      )
                    }
                    className={clsx(
                      'w-full p-2 rounded-md transition-default text-left',
                      selectedProduct === product.productId
                        ? 'bg-accent/10 border border-accent'
                        : 'hover:bg-background-muted',
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{product.name}</span>
                      <Badge variant="default">{product.count}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-background-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent rounded-full"
                          style={{ width: `${product.percentage}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted">{product.percentage.toFixed(1)}%</span>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs text-muted">{t('confidence')}:</span>
                      <Badge variant={product.avgConfidence >= 0.8 ? 'success' : 'warning'}>
                        {(product.avgConfidence * 100).toFixed(0)}%
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </Card>

            {/* Center: Classified Documents */}
            <Card className="p-4 lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-purple" />
                  <h3 className="text-sm font-semibold">{t('classified_documents')}</h3>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={minConfidence.toString()}
                    onChange={(v) => setMinConfidence(parseFloat(v))}
                    options={[
                      { value: '0', label: t('all_confidence') },
                      { value: '0.5', label: t('confidence_50') },
                      { value: '0.7', label: t('confidence_70') },
                      { value: '0.9', label: t('confidence_90') },
                    ]}
                  />
                </div>
              </div>

              {docsLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="skeleton h-20 w-full" />
                  ))}
                </div>
              ) : docsError ? (
                <EmptyState
                  icon={<AlertCircle className="w-6 h-6" />}
                  title={t('error_loading_documents')}
                  description={docsError}
                />
              ) : !documents || documents.documents.length === 0 ? (
                <EmptyState
                  icon={<FileText className="w-6 h-6" />}
                  title={t('no_documents')}
                  description={t('no_documents_description')}
                />
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {documents.documents.map((doc) => (
                    <div
                      key={doc.documentId}
                      className="p-3 rounded-md border border-default hover:bg-background-muted transition-default"
                    >
                      <div className="flex items-start justify-between mb-1">
                        <h4 className="text-sm font-medium line-clamp-1">{doc.title}</h4>
                        <Badge
                          variant={
                            doc.confidence >= 0.8
                              ? 'success'
                              : doc.confidence >= 0.6
                                ? 'warning'
                                : 'error'
                          }
                        >
                          {(doc.confidence * 100).toFixed(0)}%
                        </Badge>
                      </div>
                      <p className="text-xs text-muted line-clamp-2 mb-2">{doc.summary}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="default">{doc.primaryProduct}</Badge>
                        {doc.department && <Badge variant="default">{doc.department}</Badge>}
                      </div>
                    </div>
                  ))}

                  {/* Pagination */}
                  {documents.pagination.totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-default">
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="px-3 py-1 text-sm rounded-md border border-default disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-muted transition-default"
                      >
                        {t('previous')}
                      </button>
                      <span className="text-sm text-muted">
                        {t('page_of', { page, total: documents.pagination.totalPages })}
                      </span>
                      <button
                        onClick={() =>
                          setPage((p) => Math.min(documents.pagination.totalPages, p + 1))
                        }
                        disabled={page === documents.pagination.totalPages}
                        className="px-3 py-1 text-sm rounded-md border border-default disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-muted transition-default"
                      >
                        {t('next')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* Entity Distribution */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <Network className="w-4 h-4 text-success" />
              <h3 className="text-sm font-semibold">{t('entity_distribution')}</h3>
              {selectedProduct && <Badge variant="accent">{t('filtered_by_product')}</Badge>}
            </div>

            {entitiesLoading ? (
              <div className="skeleton h-64 w-full" />
            ) : entitiesError ? (
              <EmptyState
                icon={<AlertCircle className="w-6 h-6" />}
                title={t('error_loading_entities')}
                description={entitiesError}
              />
            ) : !entities || entities.entities.length === 0 ? (
              <EmptyState
                icon={<Network className="w-6 h-6" />}
                title={t('no_entities')}
                description={t('no_entities_description')}
              />
            ) : (
              <DataTable
                columns={[
                  {
                    key: 'name',
                    label: t('entity_name'),
                    render: (entity) => (
                      <div>
                        <p className="text-sm font-medium">{entity.name}</p>
                        <p className="text-xs text-muted">{entity.attributeId}</p>
                      </div>
                    ),
                  },
                  {
                    key: 'dataType',
                    label: t('data_type'),
                    render: (entity) => <Badge variant="default">{entity.dataType}</Badge>,
                  },
                  {
                    key: 'count',
                    label: t('occurrences'),
                    render: (entity) => (
                      <span className="text-sm font-medium">{entity.count.toLocaleString()}</span>
                    ),
                  },
                  {
                    key: 'sampleValues',
                    label: t('sample_values'),
                    render: (entity) => (
                      <div className="flex items-center gap-1 flex-wrap">
                        {entity.sampleValues.slice(0, 3).map((value, idx) => (
                          <Badge key={idx} variant="default">
                            {value}
                          </Badge>
                        ))}
                        {entity.sampleValues.length > 3 && (
                          <span className="text-xs text-muted">
                            {t('more_values', { count: entity.sampleValues.length - 3 })}
                          </span>
                        )}
                      </div>
                    ),
                  },
                ]}
                data={entities.entities}
                emptyMessage={t('no_entities')}
              />
            )}
          </Card>
        </>
      )}

      {/* Attributes View */}
      {kgView === 'attributes' && <AttributeManagerSection indexId={indexId} />}
    </div>
  );
}
