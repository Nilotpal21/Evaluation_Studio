/**
 * BrowsePreviewPage
 *
 * Full-page orchestrator for the Browse SDK preview.
 * Fetches KB detail to get indexId, then drives taxonomy/facets/search flows.
 *
 * Two modes:
 * - Browse-first: taxonomy tree selection → facet filtering → documents
 * - Search-first: search query → results → post-search facet counts
 */

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Loader2, AlertCircle, FolderTree } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter, useParams } from 'next/navigation';
import {
  getKnowledgeBase,
  getBrowseTaxonomy,
  getBrowseFacets,
  getBrowseFacetDocuments,
  postBrowseFacetCounts,
  postBrowseInteraction,
  executeQuery,
  getSearchDiscovery,
} from '../../../api/search-ai';
import type {
  KnowledgeBaseDetail,
  SearchAIResult,
  DiscoveryFilterField,
} from '../../../api/search-ai';
import { BrowsePreviewHeader } from './BrowsePreviewHeader';
import { BrowsePreviewSidebar, type TaxonomyNode, type FacetGroup } from './BrowsePreviewSidebar';
import { BrowsePreviewResults } from './BrowsePreviewResults';
import { MetadataFilterPanel, type ActiveFilter } from './MetadataFilterPanel';
import type { BrowseDocument } from './BrowseDocumentCard';
import { EmptyState } from '../../ui/EmptyState';
import { Button } from '../../ui/Button';

// =============================================================================
// BACKEND RESPONSE TYPES (match actual backend shapes)
// =============================================================================

/** Backend taxonomy response from GET /:indexId/browse/taxonomy */
interface BackendTaxonomyResponse {
  taxonomy: {
    domain?: { id: string; name: string; version: string } | null;
    categories: Array<{ id: string; name: string; department: string }>;
    products: Array<{
      id: string;
      name: string;
      categoryId: string;
      department: string;
      subDepartment: string;
      disambiguationKeywords: string[];
      organizationSpecificNames: string[];
    }>;
    attributes: Array<{
      id: string;
      name: string;
      dataType: string;
      applicableTo: string[];
      notApplicableTo: string[];
      displayName?: string;
      tier?: string;
      aliases?: string[];
    }>;
  };
  attributeMetadata: Record<
    string,
    {
      displayName: string;
      tier: string;
      aliases: string[];
      dataType: string;
      productScope: string;
      isBeta: boolean;
    }
  >;
  documentCounts: Record<string, number>;
}

/** Backend facet response from GET /:indexId/browse/facets */
interface BackendFacetResult {
  attributeType: string;
  productType?: string;
  dataType: string;
  values: Array<{ value: string; count: number }>;
  total: number;
}

/** Backend facet-documents response from GET /:indexId/browse/facets/:attr/documents */
interface BackendFacetDocumentsResponse {
  documentIds: string[];
  total: number;
  truncated: boolean;
}

/** Backend facet-counts response from POST /:indexId/browse/facet-counts */
interface BackendFacetCountsResponse {
  facets: Array<{ attributeType: string; productType: string; count: number }>;
  total: number;
}

// =============================================================================
// TRANSFORMER: Backend taxonomy → Frontend tree
// =============================================================================

function transformTaxonomyToTree(response: BackendTaxonomyResponse): TaxonomyNode[] {
  const { taxonomy, documentCounts } = response;
  const { categories, products } = taxonomy;

  // Group products by categoryId
  const productsByCategory = new Map<string, Array<(typeof products)[number]>>();
  for (const product of products) {
    const existing = productsByCategory.get(product.categoryId) ?? [];
    existing.push(product);
    productsByCategory.set(product.categoryId, existing);
  }

  // Build tree: categories as parents, products as children
  // Only include products that have documents — hide empty products
  const hasAnyDocs = Object.values(documentCounts).some((c) => c > 0);
  return (
    categories
      .map((category) => {
        const categoryProducts = productsByCategory.get(category.id) ?? [];
        const children: TaxonomyNode[] = categoryProducts
          .map((product) => ({
            id: product.id,
            name: product.name,
            documentCount: documentCounts[product.name] ?? documentCounts[product.id] ?? 0,
          }))
          // Hide 0-count products when we have document counts from ClickHouse
          .filter((child) => !hasAnyDocs || child.documentCount > 0);
        // Category documentCount = sum of children product counts
        const categoryDocCount = children.reduce((sum, child) => sum + child.documentCount, 0);
        return {
          id: category.id,
          name: category.name,
          documentCount: categoryDocCount,
          children: children.length > 0 ? children : undefined,
        };
      })
      // Hide categories with 0 documents when we have counts
      .filter((cat) => !hasAnyDocs || cat.documentCount > 0)
  );
}

// =============================================================================
// HELPER: Dedup search results by documentId (keep highest score)
// =============================================================================

function deduplicateResults(results: SearchAIResult[]): SearchAIResult[] {
  const bestByDoc = new Map<string, SearchAIResult>();
  for (const r of results) {
    const existing = bestByDoc.get(r.documentId);
    if (!existing || r.score > existing.score) {
      bestByDoc.set(r.documentId, r);
    }
  }
  return Array.from(bestByDoc.values());
}

// =============================================================================
// HELPER: Map SearchAIResult to BrowseDocument
// =============================================================================

function mapResultToDocument(r: SearchAIResult, fallbackTitle: string): BrowseDocument {
  return {
    id: r.documentId,
    title: (r.metadata?.title as string) ?? r.source?.sourceName ?? fallbackTitle,
    summary: r.content ?? '',
    source: r.source?.sourceName ?? '',
    attributes: [],
    updatedAt: (r.metadata?.updatedAt as string) ?? new Date().toISOString(),
    sourceUrl: r.source?.reference,
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_FACET_ATTRIBUTES = 8;
const PAGE_SIZE = 12;

// =============================================================================
// COMPONENT
// =============================================================================

interface BrowsePreviewPageProps {
  kbId: string;
}

export function BrowsePreviewPage({ kbId }: BrowsePreviewPageProps) {
  const t = useTranslations('search_ai.browse');
  const router = useRouter();
  const params = useParams<{ projectId: string; kbId: string }>();

  // ─── Core state ─────────────────────────────────────────
  const [kb, setKb] = useState<KnowledgeBaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── Raw taxonomy from backend (for category→product→attribute join) ───
  const [rawTaxonomy, setRawTaxonomy] = useState<BackendTaxonomyResponse | null>(null);

  // ─── Browse state ───────────────────────────────────────
  const [taxonomy, setTaxonomy] = useState<TaxonomyNode[]>([]);
  const [facets, setFacets] = useState<FacetGroup[]>([]);
  const [documents, setDocuments] = useState<BrowseDocument[]>([]);
  const [totalDocuments, setTotalDocuments] = useState(0);

  // ─── User interaction state ─────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [activeFacets, setActiveFacets] = useState<Map<string, Set<string>>>(new Map());
  const [includeBeta, setIncludeBeta] = useState(true);
  const [sortBy, setSortBy] = useState('relevance');
  const [page, setPage] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [isTaxonomyLoaded, setIsTaxonomyLoaded] = useState(false);
  const [taxonomyError, setTaxonomyError] = useState(false);
  const [isFacetsLoading, setIsFacetsLoading] = useState(false);
  const [isDocsLoading, setIsDocsLoading] = useState(false);

  // ─── Metadata filter state (from discovery API) ────────
  const [discoveryFilterFields, setDiscoveryFilterFields] = useState<DiscoveryFilterField[]>([]);
  const [metadataFilters, setMetadataFilters] = useState<ActiveFilter[]>([]);
  // Start true so the empty-taxonomy guard waits for discovery to complete.
  // Without this, a render between taxonomy-loaded and discovery-started
  // flashes the "No taxonomy data yet" screen even when filters exist.
  const [isDiscoveryLoading, setIsDiscoveryLoading] = useState(true);

  const indexId = kb?.searchIndexId ?? null;
  const sessionIdRef = useRef(`preview-${Date.now()}`);
  const searchGenRef = useRef(0);

  // ─── Fetch KB detail ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function fetchKb() {
      try {
        const result = await getKnowledgeBase(kbId);
        if (!cancelled) {
          setKb(result.knowledgeBase);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchKb();
    return () => {
      cancelled = true;
    };
  }, [kbId]);

  // ─── Fetch discovery manifest for metadata filters ──────
  useEffect(() => {
    if (!indexId) {
      // No indexId yet (KB not loaded or failed) — stop waiting for discovery
      if (!loading) setIsDiscoveryLoading(false);
      return;
    }
    let cancelled = false;

    async function fetchDiscovery() {
      setIsDiscoveryLoading(true);
      try {
        const discovery = await getSearchDiscovery(indexId!);
        if (!cancelled && discovery?.capabilities?.filters?.available) {
          setDiscoveryFilterFields(discovery.capabilities.filters.fields);
        }
      } catch {
        // Non-critical — browse still works without metadata filters
      } finally {
        if (!cancelled) setIsDiscoveryLoading(false);
      }
    }

    fetchDiscovery();
    return () => {
      cancelled = true;
    };
  }, [indexId, loading]);

  // ─── Initial document load (show all documents on page load) ─────
  useEffect(() => {
    if (!indexId) return;
    let cancelled = false;

    async function fetchInitialDocs() {
      setIsDocsLoading(true);
      try {
        const queryResult = await executeQuery(indexId!, {
          query: '*',
          topK: PAGE_SIZE,
        });
        if (!cancelled) {
          const deduped = deduplicateResults(queryResult.results);
          const docs = deduped.map((r) => mapResultToDocument(r, t('untitled')));
          setDocuments(docs);
          setTotalDocuments(deduped.length);
        }
      } catch {
        // Non-critical — browse works without initial docs
      } finally {
        if (!cancelled) setIsDocsLoading(false);
      }
    }

    fetchInitialDocs();
    return () => {
      cancelled = true;
    };
  }, [indexId, t]);

  // ─── T-3: Fetch taxonomy and transform to tree ─────────
  useEffect(() => {
    if (!indexId) return;
    let cancelled = false;

    async function fetchTaxonomy() {
      setTaxonomyError(false);
      try {
        const result = (await getBrowseTaxonomy(indexId!, includeBeta)) as BackendTaxonomyResponse;
        if (!cancelled && result?.taxonomy) {
          // Store raw taxonomy for category→product→attribute join (T-4)
          setRawTaxonomy(result);
          // Transform to tree for sidebar rendering
          const tree = transformTaxonomyToTree(result);
          setTaxonomy(tree);
          // Auto-select the first VISIBLE category (one with documents)
          // so facets load immediately with meaningful data.
          if (tree.length > 0) {
            setSelectedCategory((prev) => prev ?? tree[0].id);
          } else if (result.taxonomy.categories?.length > 0) {
            // Fallback if no documents exist at all
            setSelectedCategory((prev) => prev ?? result.taxonomy.categories[0].id);
          }
        }
      } catch {
        // Taxonomy fetch failed — mark error so empty-state doesn't mislead
        if (!cancelled) setTaxonomyError(true);
      } finally {
        if (!cancelled) setIsTaxonomyLoaded(true);
      }
    }

    fetchTaxonomy();
    return () => {
      cancelled = true;
    };
  }, [indexId, includeBeta]);

  // ─── T-4: Fetch facets when taxonomy loads (and on category/product selection) ─
  // Loads facets immediately once taxonomy is available. If a category or product
  // is selected, scopes to those products; otherwise uses ALL products.
  useEffect(() => {
    if (!indexId || !rawTaxonomy) return;
    let cancelled = false;

    async function fetchFacets() {
      setIsFacetsLoading(true);
      try {
        const { products, attributes } = rawTaxonomy!.taxonomy;
        const attributeMetadata = rawTaxonomy!.attributeMetadata;

        // 1. Determine product scope — all products, or filtered by selection
        let scopeProducts = products;
        if (selectedCategory) {
          const byCat = products.filter((p) => p.categoryId === selectedCategory);
          if (byCat.length > 0) {
            scopeProducts = byCat;
          } else {
            const direct = products.find((p) => p.id === selectedCategory);
            if (direct) scopeProducts = [direct];
          }
        }
        const productIdSet = new Set(scopeProducts.map((p) => p.id));

        // 2. Collect all facetable attributes: taxonomy + approved from registry
        const allAttrs = [
          ...attributes.filter(
            (attr) =>
              // Empty applicableTo means "all products" per domain-definition schema
              attr.applicableTo.length === 0 ||
              attr.applicableTo.some((pid) => productIdSet.has(pid)),
          ),
        ];
        const seenKeys = new Set<string>();
        for (const attr of allAttrs) {
          seenKeys.add(attr.id);
          seenKeys.add(attr.name);
          if (attr.displayName) seenKeys.add(attr.displayName);
        }

        for (const [key, meta] of Object.entries(attributeMetadata)) {
          const colonIdx = key.indexOf(':');
          if (colonIdx < 0) continue;
          const productScope = key.slice(0, colonIdx);
          const attrId = key.slice(colonIdx + 1);
          if (seenKeys.has(attrId) || seenKeys.has(meta.displayName)) continue;
          // Always include approved/permanent attributes regardless of
          // selected category — they are user-curated and should always
          // be visible as facets. Novel/beta are category-scoped.
          const isPromoted = meta.tier === 'approved' || meta.tier === 'permanent';
          if (!isPromoted && !productIdSet.has(productScope)) continue;
          allAttrs.push({
            id: attrId,
            name: attrId,
            dataType: meta.dataType || 'string',
            applicableTo: [productScope],
            notApplicableTo: [],
            displayName: meta.displayName || attrId,
            tier: meta.tier,
            aliases: meta.aliases,
          });
          seenKeys.add(attrId);
          if (meta.displayName) seenKeys.add(meta.displayName);
        }

        // 3. Rank by tier importance and pick top N
        const ranked = allAttrs
          .map((attr) => {
            let rank = 0;
            for (const [key, meta] of Object.entries(attributeMetadata)) {
              if (key.endsWith(`:${attr.name}`) || key.endsWith(`:${attr.id}`)) {
                // Approved = highest (user explicitly promoted these)
                // Permanent = mid (system-defined from domain, may lack real data)
                // Novel/beta = lowest
                rank = meta.tier === 'approved' ? 3 : meta.tier === 'permanent' ? 2 : 1;
                break;
              }
            }
            return { attr, rank };
          })
          .sort((a, b) => b.rank - a.rank)
          .slice(0, MAX_FACET_ATTRIBUTES);

        // 4. Parallel facet calls — use attr.id for API (ClickHouse stores snake_case ids)
        // intentional: individual facet failures are non-critical, nulls filtered out below
        const facetPromises = ranked.map(async ({ attr }) => {
          // For attributes with specific product scope, pass it to the API.
          // For universal attributes (applicableTo=[]), omit product filter
          // so the backend returns values across all products.
          const prod =
            attr.applicableTo.length > 0
              ? (scopeProducts.find((p) => attr.applicableTo.includes(p.id)) ??
                products.find((p) => attr.applicableTo.includes(p.id)))
              : undefined;
          const apiAttrName = attr.id || attr.name;
          try {
            const result = (await getBrowseFacets(indexId!, apiAttrName, prod?.id)) as
              | BackendFacetResult
              | null
              | undefined;

            return {
              attribute: attr.displayName ?? attr.name,
              values: (result?.values ?? []).map((v) => ({
                ...v,
                active: false,
              })),
            } as FacetGroup;
          } catch {
            return null;
          }
        });

        const results = await Promise.all(facetPromises);
        if (!cancelled) {
          setFacets(results.filter((f): f is FacetGroup => f !== null && f.values.length > 0));
        }
      } catch (err) {
        // Facet loading is non-critical — browse still works without facets
        // eslint-disable-next-line no-console
        console.warn('[BrowsePreview] facet fetch error', err);
      } finally {
        if (!cancelled) setIsFacetsLoading(false);
      }
    }

    fetchFacets();
    return () => {
      cancelled = true;
    };
  }, [indexId, selectedCategory, rawTaxonomy]);

  // ─── T-5: Fetch documents via /query when facets are active ─
  useEffect(() => {
    if (!indexId) return;
    // Only fetch when we have active facet selections
    const hasActiveFacets = Array.from(activeFacets.values()).some((set) => set.size > 0);
    if (!hasActiveFacets) {
      // No active facet selections — keep existing documents from initial load
      // or search results. Only clear when switching away from a prior selection.
      setIsDocsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchDocuments() {
      setIsDocsLoading(true);
      try {
        // Get document IDs per attribute: OR within same attribute, AND across attributes
        const perAttributePromises: Array<Promise<Set<string>>> = [];
        for (const [attr, values] of activeFacets.entries()) {
          const attrName = resolveAttributeName(attr);
          // OR within same attribute: union all values
          const valuePromises = [...values].map((val) =>
            getBrowseFacetDocuments(indexId!, attrName, val)
              .then((result) => {
                const r = result as BackendFacetDocumentsResponse;
                return r?.documentIds ?? [];
              })
              .catch(() => [] as string[]),
          );
          perAttributePromises.push(
            Promise.all(valuePromises).then((arrays) => new Set(arrays.flat())),
          );
        }
        const perAttributeSets = await Promise.all(perAttributePromises);

        // AND across attributes: intersect the per-attribute sets
        let uniqueDocIds: string[];
        if (perAttributeSets.length === 0) {
          uniqueDocIds = [];
        } else {
          let intersection = perAttributeSets[0];
          for (let i = 1; i < perAttributeSets.length; i++) {
            intersection = new Set([...intersection].filter((id) => perAttributeSets[i].has(id)));
          }
          uniqueDocIds = [...intersection];
        }

        if (cancelled || uniqueDocIds.length === 0) {
          if (!cancelled) {
            setDocuments([]);
            setTotalDocuments(0);
          }
          return;
        }

        // Hydrate via /query with documentIds filter.
        // Wildcard query triggers auto-classification but the doc-ID filter (Stage 2.6)
        // ensures only matching documents are returned. Ranking is by OpenSearch score
        // within the filtered set. Acceptable overhead for preview page.
        const queryResult = await executeQuery(indexId!, {
          query: '*',
          documentIds: uniqueDocIds.slice(0, 50),
          topK: 50,
        });

        if (!cancelled) {
          const deduped = deduplicateResults(queryResult.results);
          const docs = deduped.map((r) => mapResultToDocument(r, t('untitled')));
          setDocuments(docs);
          setTotalDocuments(uniqueDocIds.length);
        }
      } catch {
        // Non-critical
      } finally {
        if (!cancelled) setIsDocsLoading(false);
      }
    }

    fetchDocuments();
    return () => {
      cancelled = true;
    };
    // Sort and pagination are now client-side (useMemo) — no need to re-fetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexId, activeFacets]);

  // ─── Helper: resolve display name back to raw attribute name ─
  // (facet groups use displayName, but API needs raw name)
  const resolveAttributeName = useCallback(
    (displayNameOrName: string): string => {
      if (!rawTaxonomy) return displayNameOrName;
      for (const attr of rawTaxonomy.taxonomy.attributes) {
        if (attr.displayName === displayNameOrName || attr.name === displayNameOrName) {
          // Return the snake_case id, not the display name — ClickHouse
          // stores attribute_type as the id (e.g. "price", not "Price").
          return attr.id || attr.name;
        }
      }
      return displayNameOrName;
    },
    [rawTaxonomy],
  );

  // ─── T-6: handleSearch — wire to /query ────────────────
  const handleSearch = useCallback(
    async (query: string) => {
      if (!indexId) return;
      // Increment generation to discard stale responses from prior searches
      const gen = ++searchGenRef.current;
      if (!query.trim()) {
        setIsSearching(false);
        setDocuments([]);
        setTotalDocuments(0);
        setFacets([]);
        setPage(1);
        return;
      }
      setIsSearching(true);
      setPage(1);

      try {
        // T-7: Track search interaction
        postBrowseInteraction(indexId, [
          {
            interactionType: 'search',
            sessionId: sessionIdRef.current,
            facetValue: query,
          },
        ]).catch(() => {
          /* analytics non-critical */
        });

        // Execute hybrid search query (include metadata filters if active)
        const queryResult = await executeQuery(indexId, {
          query,
          queryType: 'hybrid',
          topK: 50,
          ...(metadataFilters.length > 0 ? { filters: metadataFilters } : {}),
        });

        // Discard if a newer search or clear has fired since
        if (gen !== searchGenRef.current) return;

        // Show all matching chunks (no dedup) so users see every result
        const docs = queryResult.results.map((r) => mapResultToDocument(r, t('untitled')));
        setDocuments(docs);
        setTotalDocuments(queryResult.results.length);

        // Post-search faceting: get which attributes have data for these results
        const docIds = [...new Set(queryResult.results.map((r) => r.documentId))];
        if (docIds.length > 0) {
          try {
            const countsResult = (await postBrowseFacetCounts(
              indexId,
              docIds,
            )) as BackendFacetCountsResponse;
            if (gen !== searchGenRef.current) return;
            if (countsResult?.facets) {
              // Show attribute names with counts as badges (values not loaded — MVP limitation)
              const facetGroups: FacetGroup[] = countsResult.facets
                .filter((f) => f.count > 0)
                .slice(0, MAX_FACET_ATTRIBUTES)
                .map((f) => ({
                  attribute: f.attributeType,
                  values: [
                    {
                      value: t('facet_document_count', { count: f.count }),
                      count: f.count,
                      active: false,
                    },
                  ],
                }));
              setFacets(facetGroups);
            }
          } catch {
            // Facet counts non-critical
          }
        }
      } catch {
        // Non-critical
      } finally {
        if (gen === searchGenRef.current) setIsSearching(false);
      }
    },
    [indexId, t, metadataFilters],
  );

  // ─── Re-trigger search when metadata filters change ────
  useEffect(() => {
    if (searchQuery.trim() && indexId) {
      handleSearch(searchQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataFilters]);

  // ─── T-7: handleCategorySelect — fix interaction event ─
  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      const next = selectedCategory === categoryId ? null : categoryId;
      setSelectedCategory(next);
      setPage(1);
      // Clear search results when switching to browse mode
      setSearchQuery('');
      // Clear facets and active selections on every category change
      // Also reset loading flag to prevent stuck spinner if T-4 was mid-flight
      setFacets([]);
      setActiveFacets(new Map());
      setIsFacetsLoading(false);

      if (indexId) {
        postBrowseInteraction(indexId, [
          {
            interactionType: 'browse',
            categoryId,
            sessionId: sessionIdRef.current,
          },
        ]).catch(() => {
          /* analytics non-critical */
        });
      }
    },
    [indexId, selectedCategory],
  );

  // ─── T-7: handleFacetToggle — fix interaction event ────
  const handleFacetToggle = useCallback(
    (attribute: string, value: string) => {
      setActiveFacets((prev) => {
        const next = new Map(prev);
        const current = new Set(next.get(attribute) ?? []);
        if (current.has(value)) {
          current.delete(value);
        } else {
          current.add(value);
        }
        if (current.size === 0) {
          next.delete(attribute);
        } else {
          next.set(attribute, current);
        }
        return next;
      });
      setPage(1);

      if (indexId) {
        postBrowseInteraction(indexId, [
          {
            attributeType: resolveAttributeName(attribute),
            interactionType: 'click',
            sessionId: sessionIdRef.current,
            facetValue: value,
          },
        ]).catch(() => {
          /* analytics non-critical */
        });
      }
    },
    [indexId, resolveAttributeName],
  );

  const handleToggleBeta = useCallback(() => {
    setIncludeBeta((prev) => !prev);
  }, []);

  // ─── Derived: category pills from taxonomy ─────────────
  const categoryPills = useMemo(() => {
    return taxonomy.map((node) => ({
      id: node.id,
      name: node.name,
      active: selectedCategory === node.id,
    }));
  }, [taxonomy, selectedCategory]);

  // ─── Derived: facets with active state ──────────────────
  const facetsWithState = useMemo(() => {
    return facets.map((group) => ({
      ...group,
      values: group.values.map((v) => ({
        ...v,
        active: activeFacets.get(group.attribute)?.has(v.value) ?? false,
      })),
    }));
  }, [facets, activeFacets]);

  // ─── Derived: sorted documents (B1) ─────────────────────
  const sortedDocuments = useMemo(() => {
    if (sortBy === 'relevance') return documents;
    const sorted = [...documents];
    switch (sortBy) {
      case 'date_desc':
        sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        break;
      case 'date_asc':
        sorted.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        break;
      case 'title_asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return sorted;
  }, [documents, sortBy]);

  // ─── Derived: paginated documents (B2) ──────────────────
  const paginatedDocuments = useMemo(() => {
    return sortedDocuments.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }, [sortedDocuments, page]);

  // ─── Loading state ──────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
          <p className="text-sm text-muted">{t('loading_kb')}</p>
        </div>
      </div>
    );
  }

  // ─── Error state ────────────────────────────────────────
  if (error || !kb) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertCircle className="w-8 h-8 text-error" />
          <h2 className="text-lg font-semibold text-foreground">{t('error_title')}</h2>
          <p className="text-sm text-muted max-w-md">{error ?? t('kb_not_found')}</p>
        </div>
      </div>
    );
  }

  // ─── Empty taxonomy state (D1+D2) ──────────────────────
  // Only show guidance when taxonomy is truly empty AND no metadata filters available.
  // If we have metadata filters from discovery, show the main layout with search + filters.
  const hasMetadataFilters = discoveryFilterFields.length > 0 || isDiscoveryLoading;
  if (isTaxonomyLoaded && taxonomy.length === 0 && !taxonomyError && !hasMetadataFilters) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <EmptyState
          icon={<FolderTree className="w-6 h-6" />}
          title={t('empty_taxonomy_title')}
          description={t('empty_taxonomy_description')}
          action={
            <Button
              variant="secondary"
              onClick={() =>
                router.push(
                  `/projects/${params.projectId}/search-ai/${params.kbId}?tab=intelligence`,
                )
              }
            >
              {t('empty_taxonomy_action')}
            </Button>
          }
        />
      </div>
    );
  }

  // ─── Main layout ────────────────────────────────────────
  return (
    <div className="h-screen bg-background flex flex-col">
      <BrowsePreviewHeader
        kbName={kb.name}
        documentCount={kb.documentCount ?? 0}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearch={handleSearch}
        categories={categoryPills}
        onCategoryClick={handleCategorySelect}
        includeBeta={includeBeta}
        onToggleBeta={handleToggleBeta}
        isSearching={isSearching}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <BrowsePreviewSidebar
          taxonomy={taxonomy}
          facets={facetsWithState}
          selectedCategory={selectedCategory}
          onCategorySelect={handleCategorySelect}
          onFacetToggle={handleFacetToggle}
          includeBeta={includeBeta}
          isLoading={isFacetsLoading}
          metadataFilterSlot={
            discoveryFilterFields.length > 0 || isDiscoveryLoading ? (
              <MetadataFilterPanel
                filterFields={discoveryFilterFields}
                activeFilters={metadataFilters}
                onFiltersChange={setMetadataFilters}
                isLoading={isDiscoveryLoading}
              />
            ) : undefined
          }
        />

        <main className="flex-1 overflow-y-auto p-6">
          <BrowsePreviewResults
            documents={paginatedDocuments}
            total={sortedDocuments.length}
            page={page}
            onPageChange={setPage}
            sortBy={sortBy}
            onSortChange={setSortBy}
            includeBeta={includeBeta}
            isLoading={isDocsLoading || isSearching}
          />
        </main>
      </div>
    </div>
  );
}
