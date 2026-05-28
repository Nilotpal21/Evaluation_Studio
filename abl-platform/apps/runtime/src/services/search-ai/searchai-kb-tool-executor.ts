/**
 * SearchAI KB Tool Executor
 *
 * Handles tools with type: 'searchai' (KB-as-tool pattern).
 * Each tool represents a knowledge base and routes calls through
 * the unified search pipeline via SearchAIClient (SDK).
 *
 * On first execution per indexId:
 * 1. Fetches discovery manifest via SearchAIClient.discover()
 * 2. Builds dynamic tool description via description builder
 * 3. Caches manifest for subsequent calls
 *
 * All executions:
 * 1. Translates tool params to unified search request
 * 2. Calls SearchAIClient.unifiedSearch() (with proper auth, timeout, error handling)
 * 3. Returns results formatted for LLM consumption
 */

import type { ToolExecutor } from '@abl/compiler/platform';
import type { SearchAIBindingIR } from '@abl/compiler';
import { SearchAIClient, type SearchAIClientConfig } from '@agent-platform/search-ai-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { Citation } from '../../types/index.js';
import { signCitationToken } from '@agent-platform/shared-auth';
import { buildToolDescription, classifyKBComplexity } from './description-builder.js';

const log = createLogger('searchai-kb-tool-executor');

// ─── Speculative Search Cache ───────────────────────────────────────────────
// Pre-fires a "best guess" hybrid search with the raw user message BEFORE the
// LLM decides what to search. If the LLM's eventual tool call uses a similar
// query, we reuse the cached result — saving the entire search roundtrip
// (~200-500ms). The speculative result has a very short TTL (30s) and is
// invalidated after one use.

interface SpeculativeSearchResult {
  /**
   * Turn identifier this entry belongs to. Entries from a different turn
   * are never matched — see `consumeSpeculativeForQuery` / `checkSpeculativeCache`.
   */
  turnId: string;
  query: string;
  indexId: string;
  result: any;
  fetchedAt: number;
  searchLatencyMs: number;
}

const SPECULATIVE_CACHE_TTL_MS = 30_000; // 30 seconds
const SPECULATIVE_CACHE_MAX = 50;
/**
 * Fallback turnId used when callers haven't set one (tests, legacy call sites).
 * Entries keyed with this id cannot cross-pollinate with real turns, but they
 * can be reused by later default-turn callers — which is the intended test
 * behaviour.
 */
const DEFAULT_TURN_ID = '__no_turn__';

// ─── Types ───────────────────────────────────────────────────────────────

export interface SearchAIKBToolExecutorConfig {
  /** SearchAI runtime URL for API calls */
  runtimeUrl: string;
  /** Auth token forwarded from the agent session */
  authToken?: string;
  /** Timeout for discovery API calls (default: 5000ms) */
  discoveryTimeoutMs?: number;
  /** Timeout for search API calls (default: 30000ms) */
  searchTimeoutMs?: number;
  /**
   * User identity for RACL permission filtering.
   * When set, requests include X-Auth-Mode: user + X-User-Identity headers
   * so SearchAI applies per-user content access filters.
   * Set for sessions with identityTier >= 2 (Contact-eligible users).
   */
  userIdentity?: {
    email: string;
    name?: string;
    domain?: string;
    groups?: string[];
    idpProvider?: string;
    idpUserId?: string;
  };
}

/**
 * Callback for LLM-powered operations.
 * @deprecated No longer used — enrichment removed for latency optimization.
 * Kept for backward compatibility with existing wiring code.
 */
export type LLMChatFn = (systemPrompt: string, userContent: string) => Promise<string>;

/**
 * Conversation message type.
 * @deprecated No longer used — enrichment removed for latency optimization.
 * Kept for backward compatibility with existing wiring code.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface CachedDiscovery {
  manifest: any;
  description: string;
  /** KB complexity tier — computed once at discovery, reused for the session lifetime */
  tier: import('./description-builder.js').KBComplexityTier;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum search results to return to the LLM in normal tool loop */
const MAX_RESULTS_FOR_LLM = 10;

/** Maximum search results for KB fast path */
const MAX_RESULTS_FAST_PATH = 10;

/**
 * Minimum relevance score threshold for citation inclusion.
 * Results below this score are excluded from citations (but still sent to LLM
 * for context). This prevents low-relevance documents (e.g. unrelated resumes)
 * from appearing as citation sources.
 *
 * Score ranges depend on queryType:
 * - hybrid/semantic: 0.0–1.0 (normalized cosine similarity + BM25)
 * - structured/keyword: 0.0–∞ (raw BM25, typically 5–50+)
 *
 * 0.3 is a conservative threshold that filters clearly-irrelevant results
 * while keeping marginally-relevant ones. For structured queries we use a
 * higher threshold since BM25 scores are not normalized.
 */
const CITATION_MIN_SCORE_HYBRID = 0.3;
const CITATION_MIN_SCORE_STRUCTURED = 5.0;

// MAX_CONTENT_PER_CHUNK removed — content is sent untruncated to LLM

// ─── Executor ────────────────────────────────────────────────────────────

export class SearchAIKBToolExecutor implements ToolExecutor {
  private readonly config: SearchAIKBToolExecutorConfig;
  private readonly client: SearchAIClient;
  private readonly discoveryCache: Map<string, CachedDiscovery> = new Map();

  /** Map of tool name → SearchAIBindingIR for resolving indexId/tenantId */
  private toolBindings: Map<string, SearchAIBindingIR> = new Map();

  /** Callback to update tool description + schema in session._effectiveConfig */
  private onDescriptionReady?: (
    toolName: string,
    description: string,
    tier: import('./description-builder.js').KBComplexityTier,
  ) => void;

  /** Speculative search results — pre-fired before LLM decides.
   *  Key format: `${turnId}:${indexId}:${normalizedQuery}`.
   *  turnId is the first segment so entries from a prior turn can never be
   *  matched by a same-turn lookup (fixes cross-turn cross-pollination). */
  private speculativeCache: Map<string, SpeculativeSearchResult> = new Map();

  /** In-flight speculative search promises — avoid duplicate requests.
   *  Key format matches `speculativeCache`. */
  private speculativeInFlight: Map<string, Promise<any>> = new Map();

  /**
   * Current turn identifier set by the reasoning executor via
   * {@link setCurrentTurn}. All speculative cache writes and reads are scoped
   * by this id so two consecutive user messages (retry, rapid paste,
   * autotext) cannot consume each other's speculative results.
   */
  private currentTurnId: string = DEFAULT_TURN_ID;

  // Note: conversationHistory and llmChat removed — the agent LLM already has
  // vocabulary context in the tool description and makes its own decisions.
  // Enrichment LLM call was redundant (~7s latency for ~5% hit rate).

  constructor(config: SearchAIKBToolExecutorConfig) {
    this.config = config;

    // Build extra headers for user-mode RACL filtering
    const headers: Record<string, string> = {};
    if (config.userIdentity?.email) {
      headers['X-Auth-Mode'] = 'user';
      headers['X-User-Identity'] = JSON.stringify({
        email: config.userIdentity.email,
        name: config.userIdentity.name,
        domain: config.userIdentity.domain ?? config.userIdentity.email.split('@')[1],
        groups: config.userIdentity.groups,
        idpProvider: config.userIdentity.idpProvider ?? 'platform',
        idpUserId: config.userIdentity.idpUserId ?? config.userIdentity.email,
      });
    }

    this.client = new SearchAIClient({
      runtimeUrl: config.runtimeUrl,
      engineUrl: '',
      authToken: config.authToken,
      timeoutMs: config.searchTimeoutMs ?? 30000,
      headers,
    });
  }

  /**
   * Register a tool binding so the executor knows which indexId to use.
   */
  registerBinding(toolName: string, binding: SearchAIBindingIR): void {
    this.toolBindings.set(toolName, binding);
  }

  /**
   * Set callback for when discovery completes and tool description is ready.
   * Used to update session._effectiveConfig.tools dynamically.
   */
  setDescriptionCallback(
    cb: (
      toolName: string,
      description: string,
      tier: import('./description-builder.js').KBComplexityTier,
    ) => void,
  ): void {
    this.onDescriptionReady = cb;
  }

  /**
   * @deprecated No-op — enrichment LLM call removed for latency optimization.
   * Kept for backward compatibility with LLMWiringService.
   */
  setConversationContext(_history: ConversationTurn[]): void {
    // No-op: agent LLM handles context via tool description
  }

  /**
   * @deprecated No-op — enrichment LLM call removed for latency optimization.
   * Kept for backward compatibility with LLMWiringService.
   */
  setLLMChat(_fn: LLMChatFn): void {
    // No-op: agent LLM handles enrichment via tool description
  }

  /**
   * Scope subsequent speculative cache reads and writes to the given turn.
   *
   * The reasoning executor should call this at the start of every turn (with
   * a freshly-generated unique id) BEFORE firing the speculative search.
   * Callers that do not set a turn id all share {@link DEFAULT_TURN_ID} —
   * acceptable for isolated tests but not for production traffic where
   * consecutive turns from the same user would otherwise share a cache
   * partition and leak results across intents.
   */
  setCurrentTurn(turnId: string | null | undefined): void {
    const next = typeof turnId === 'string' && turnId.length > 0 ? turnId : DEFAULT_TURN_ID;
    if (next === this.currentTurnId) return;
    this.currentTurnId = next;
    // Proactively drop any pre-existing entries NOT belonging to the new turn
    // that have already expired, to keep the cache size bounded when turns
    // are very long-lived.
    const now = Date.now();
    for (const [key, entry] of this.speculativeCache) {
      if (now - entry.fetchedAt > SPECULATIVE_CACHE_TTL_MS) {
        this.speculativeCache.delete(key);
      }
    }
  }

  /**
   * Execute a SearchAI KB tool call.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const binding = this.toolBindings.get(toolName);
    if (!binding) {
      throw new Error(
        `SearchAI KB tool "${toolName}" has no registered binding. ` +
          `Ensure the tool is registered via registerBinding().`,
      );
    }

    const indexId = binding.indexId;

    // Discovery is NOT called here — it was already fetched at session start
    // via triggerEagerDiscovery() or load-project-tools-as-ir.ts.
    // The tool description (vocabulary, filters, endpoint) is already in the
    // LLM system prompt. Calling discover again wastes ~2s per tool call.

    // Translate params and execute search
    return this.executeSearch(indexId, params);
  }

  /**
   * Parallel execution support.
   */
  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    const results = await Promise.allSettled(
      calls.map((call) => this.execute(call.name, call.params, timeoutMs)),
    );

    return results.map((result, i) => ({
      name: calls[i].name,
      ...(result.status === 'fulfilled'
        ? { result: result.value }
        : {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }),
    }));
  }

  /**
   * Trigger eager discovery at session start so the LLM has filter/vocabulary
   * context on the very first tool call (not just the second).
   *
   * After discovery succeeds, fires a lightweight warmup search (topK:1) to
   * pre-warm the internal OpenSearch connection pool and query compilation.
   * This eliminates the 3-4s cold-start penalty on the first real search.
   * The warmup is fire-and-forget — failures don't affect session readiness.
   */
  async triggerEagerDiscovery(toolName: string): Promise<void> {
    const binding = this.toolBindings.get(toolName);
    if (!binding) return;
    await this.ensureDiscovery(toolName, binding.indexId);

    // Warmup ping: fire a minimal search to pre-warm OpenSearch connections.
    // This runs AFTER discovery (which only hits a metadata endpoint).
    // The actual search path has its own cold-start (connection pool, query
    // compilation, shard routing). A topK:1 hybrid search with a short query
    // warms all of that with negligible cost (~50-200ms when warm).
    this.client
      .unifiedSearch(binding.indexId, {
        query: '_warmup',
        queryType: 'hybrid',
        skipPreprocessing: true,
        skipVocabularyResolution: true,
        topK: 1,
      })
      .then(() => {
        log.debug('Search warmup ping completed', { indexId: binding.indexId, toolName });
      })
      .catch(() => {
        // Non-fatal — first real search will just be slightly slower
        log.debug('Search warmup ping failed (non-fatal)', { indexId: binding.indexId });
      });
  }

  // ─── Pre-Search (KB Fast Path) ──────────────────────────────────────────
  // For KB-only agents: search ALL KBs with the user message (or rephrased query)
  // BEFORE the main LLM call. Results are injected into messages so the LLM
  // just synthesizes the answer — eliminating the entire tool-call iteration.
  //
  // Timeline: rephrase LLM (0.3-0.5s) + search (in parallel, 0.2s) → inject
  // → LLM #2 synthesizes (2.5s) = ~3.0s total vs 4.1-6.8s with tool loop.

  /**
   * Execute search on ALL registered KB tools with the given query.
   * Used by the KB fast path to pre-fetch results before the main LLM call.
   *
   * Runs all searches in parallel. Returns results formatted for LLM consumption.
   * Uses speculative cache when available (near-instant for cached queries).
   *
   * @param query - The search query (raw user message or rephrased)
   * @returns Array of pre-search results, one per KB tool
   */
  async executePreSearch(query: string): Promise<
    Array<{
      toolName: string;
      indexId: string;
      formattedResult: any;
      searchLatencyMs: number;
    }>
  > {
    const results: Array<{
      toolName: string;
      indexId: string;
      formattedResult: any;
      searchLatencyMs: number;
    }> = [];

    const searches = Array.from(this.toolBindings.entries()).map(async ([toolName, binding]) => {
      const indexId = binding.indexId;
      const startMs = Date.now();

      // ── Speculative cache: match current turn's search only ──
      // fireSpeculativeSearch fires with the raw user message before classify.
      // If classify returns SEARCH (same query) or a rephrase, we look up the
      // speculative result by the raw message OR the resolved query. We must NOT
      // return results from a previous turn's speculative (different query).
      const speculativeHit = this.consumeSpeculativeForQuery(indexId, query);
      if (speculativeHit) {
        // compact=true: fewer results + truncated content for fast synthesis
        const formatted = this.formatResult(speculativeHit.result, true, indexId);
        formatted._searchLatencyMs = speculativeHit.searchLatencyMs;
        formatted._speculative = true;
        log.info('Pre-search using speculative result (query match)', {
          indexId,
          toolName,
          query: query.slice(0, 50),
          resultCount: speculativeHit.result?.results?.length ?? 0,
          searchLatencyMs: speculativeHit.searchLatencyMs,
        });
        return {
          toolName,
          indexId,
          formattedResult: formatted,
          searchLatencyMs: speculativeHit.searchLatencyMs,
        };
      }

      // Also check in-flight speculative — await only if query matches
      const inflightHit = await this.awaitSpeculativeForQuery(indexId, query);
      if (inflightHit) {
        const formatted = this.formatResult(inflightHit.result, true, indexId);
        formatted._searchLatencyMs = inflightHit.searchLatencyMs;
        formatted._speculative = true;
        log.info('Pre-search using speculative result (awaited in-flight)', {
          indexId,
          toolName,
          query: query.slice(0, 50),
          resultCount: inflightHit.result?.results?.length ?? 0,
          searchLatencyMs: inflightHit.searchLatencyMs,
        });
        return {
          toolName,
          indexId,
          formattedResult: formatted,
          searchLatencyMs: inflightHit.searchLatencyMs,
        };
      }

      // Cache miss — execute real search
      const configuredTopK = this.getConfiguredTopK(indexId);
      const result = await this.client.unifiedSearch(indexId, {
        query,
        queryType: 'hybrid',
        skipPreprocessing: true,
        skipVocabularyResolution: true,
        topK: configuredTopK,
      });

      const searchLatencyMs = Date.now() - startMs;
      const formatted = this.formatResult(result, true, indexId);
      formatted._searchLatencyMs = searchLatencyMs;

      log.info('Pre-search completed', {
        indexId,
        toolName,
        query: query.slice(0, 50),
        resultCount: result?.results?.length ?? 0,
        searchLatencyMs,
      });

      return {
        toolName,
        indexId,
        formattedResult: formatted,
        searchLatencyMs,
      };
    });

    const settled = await Promise.allSettled(searches);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        log.warn('Pre-search failed for a KB tool', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    return results;
  }

  /**
   * Execute search with a structured plan from the vocab-aware classify LLM.
   * Unlike executePreSearch (always hybrid, no filters), this passes the LLM's
   * queryType, filters, and aggregation to the search pipeline.
   *
   * Used by filtered/advanced tier KBs where the classify LLM returns:
   *   { action: "SEARCH", query, queryType, filters, aggregation }
   *
   * For simple hybrid queries with no filters, checks speculative cache first.
   */
  async executePreSearchWithPlan(plan: {
    query: string;
    queryType?: string;
    filters?: Array<{ field: string; operator: string; value: unknown }>;
    aggregation?: { field: string; function: string };
  }): Promise<
    Array<{
      toolName: string;
      indexId: string;
      formattedResult: any;
      searchLatencyMs: number;
    }>
  > {
    const results: Array<{
      toolName: string;
      indexId: string;
      formattedResult: any;
      searchLatencyMs: number;
    }> = [];

    const hasFilters = plan.filters && plan.filters.length > 0;
    const hasAggregation = !!plan.aggregation;
    const isSimpleHybrid =
      !hasFilters &&
      !hasAggregation &&
      (!plan.queryType || plan.queryType === 'hybrid' || plan.queryType === 'semantic');

    const searches = Array.from(this.toolBindings.entries()).map(async ([toolName, binding]) => {
      const indexId = binding.indexId;
      const startMs = Date.now();

      // For simple hybrid queries (no filters), check speculative cache
      if (isSimpleHybrid) {
        const speculativeHit = this.consumeSpeculativeForQuery(indexId, plan.query);
        if (speculativeHit) {
          const formatted = this.formatResult(speculativeHit.result, true, indexId);
          formatted._searchLatencyMs = speculativeHit.searchLatencyMs;
          formatted._speculative = true;
          log.info('Pre-search with plan: using speculative (no filters)', {
            indexId,
            toolName,
            query: plan.query.slice(0, 50),
            searchLatencyMs: speculativeHit.searchLatencyMs,
          });
          return {
            toolName,
            indexId,
            formattedResult: formatted,
            searchLatencyMs: speculativeHit.searchLatencyMs,
          };
        }
        // Also try in-flight
        const inflightHit = await this.awaitSpeculativeForQuery(indexId, plan.query);
        if (inflightHit) {
          const formatted = this.formatResult(inflightHit.result, true, indexId);
          formatted._searchLatencyMs = inflightHit.searchLatencyMs;
          formatted._speculative = true;
          return {
            toolName,
            indexId,
            formattedResult: formatted,
            searchLatencyMs: inflightHit.searchLatencyMs,
          };
        }
      }

      // Build search request from the plan
      const configuredTopK = this.getConfiguredTopK(indexId);
      const searchBody: Record<string, unknown> = {
        query: plan.query,
        queryType: plan.queryType || 'hybrid',
        topK: hasAggregation ? undefined : configuredTopK,
        skipPreprocessing: true,
        skipVocabularyResolution: true,
      };
      if (hasFilters) {
        searchBody.filters = plan.filters;
      }
      if (hasAggregation) {
        searchBody.aggregation = plan.aggregation;
      }

      // Remove undefined
      for (const key of Object.keys(searchBody)) {
        if (searchBody[key] === undefined) delete searchBody[key];
      }

      // ── Parallel fallback strategy ──────────────────────────────────────
      // When filters are present: fire BOTH filtered search AND hybrid (no
      // filters) in parallel. If filtered returns results → use them. If
      // empty → fallback to hybrid. Zero extra latency since both run
      // concurrently. Aggregation queries don't get fallback (empty agg is
      // valid — means "0 count").
      if (hasFilters && !hasAggregation) {
        const hybridBody: Record<string, unknown> = {
          query: plan.query,
          queryType: 'hybrid',
          topK: configuredTopK,
          skipPreprocessing: true,
          skipVocabularyResolution: true,
        };

        // Also check speculative cache for the hybrid fallback
        const speculativeHit = this.consumeSpeculativeForQuery(indexId, plan.query);

        const [filteredResult, hybridResult] = await Promise.all([
          this.client.unifiedSearch(indexId, searchBody),
          speculativeHit
            ? Promise.resolve(speculativeHit.result)
            : this.client.unifiedSearch(indexId, hybridBody),
        ]);

        const searchLatencyMs = Date.now() - startMs;
        const filteredCount = filteredResult?.results?.length ?? 0;

        let chosenResult: any;
        let usedFallback = false;

        if (filteredCount > 0) {
          chosenResult = filteredResult;
        } else {
          chosenResult = hybridResult;
          usedFallback = true;
        }

        const formatted = this.formatResult(chosenResult, true, indexId);
        formatted._searchLatencyMs = searchLatencyMs;
        if (usedFallback) {
          formatted._filterFallback = true;
        }

        log.info('Pre-search with plan completed (parallel fallback)', {
          indexId,
          toolName,
          query: plan.query.slice(0, 50),
          queryType: plan.queryType,
          filtersCount: plan.filters?.length ?? 0,
          filteredResultCount: filteredCount,
          usedFallback,
          resultCount: chosenResult?.results?.length ?? 0,
          searchLatencyMs,
        });

        return { toolName, indexId, formattedResult: formatted, searchLatencyMs };
      }

      // Non-filter path (aggregation, semantic, or hybrid without filters)
      const result = await this.client.unifiedSearch(indexId, searchBody);
      const searchLatencyMs = Date.now() - startMs;
      const formatted = this.formatResult(result, true, indexId);
      formatted._searchLatencyMs = searchLatencyMs;

      log.info('Pre-search with plan completed', {
        indexId,
        toolName,
        query: plan.query.slice(0, 50),
        queryType: plan.queryType,
        filtersCount: plan.filters?.length ?? 0,
        hasAggregation,
        resultCount: result?.results?.length ?? 0,
        searchLatencyMs,
      });

      return { toolName, indexId, formattedResult: formatted, searchLatencyMs };
    });

    const settled = await Promise.allSettled(searches);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        log.warn('Pre-search with plan failed for a KB tool', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    return results;
  }

  /**
   * Get the cached discovery manifest for a specific tool by name.
   * Used by the reasoning executor to build vocab-aware classify prompts.
   */
  /**
   * Get the indexId for a tool binding.
   */
  getIndexIdForTool(toolName: string): string | undefined {
    return this.toolBindings.get(toolName)?.indexId;
  }

  getDiscoveryManifestForTool(toolName: string): any | null {
    const binding = this.toolBindings.get(toolName);
    if (!binding) return null;
    return this.getDiscoveryManifest(binding.indexId);
  }

  /**
   * Get the cached tier for a specific tool.
   */
  getToolTier(toolName: string): import('./description-builder.js').KBComplexityTier | null {
    const binding = this.toolBindings.get(toolName);
    if (!binding) return null;
    return this.discoveryCache.get(binding.indexId)?.tier ?? null;
  }

  /**
   * Get the configured topK for a given indexId from the discovery manifest.
   * Supports both the top-level `searchDefaults` shape and the older
   * nested `kb.searchDefaults` shape returned by some fixtures/callers.
   * Falls back to MAX_RESULTS_FOR_LLM if not configured or discovery hasn't completed.
   */
  private getConfiguredTopK(indexId: string): number {
    const cached = this.discoveryCache.get(indexId);
    if (!cached) return MAX_RESULTS_FOR_LLM;
    const manifestTopK =
      cached.manifest?.searchDefaults?.topK ?? cached.manifest?.kb?.searchDefaults?.topK;
    return typeof manifestTopK === 'number' && manifestTopK >= 1 && manifestTopK <= 100
      ? manifestTopK
      : MAX_RESULTS_FOR_LLM;
  }

  private getConfiguredResponseFields(indexId?: string): string[] {
    if (!indexId) return SearchAIKBToolExecutor.DEFAULT_RESPONSE_FIELDS;
    const cached = this.discoveryCache.get(indexId);
    if (!cached) return SearchAIKBToolExecutor.DEFAULT_RESPONSE_FIELDS;
    const fields = cached.manifest?.searchDefaults?.responseFields;
    if (Array.isArray(fields) && fields.length > 0) return fields;
    return SearchAIKBToolExecutor.DEFAULT_RESPONSE_FIELDS;
  }

  /**
   * Get all registered tool bindings (used by reasoning executor to build
   * synthetic tool_use/tool_result messages for the KB fast path).
   */
  getToolBindings(): Map<string, SearchAIBindingIR> {
    return this.toolBindings;
  }

  /**
   * Get combined search instructions from all registered tool bindings.
   * Each block is prefixed with the KB name so the classify LLM can
   * disambiguate when multiple KBs have different instructions.
   */
  getSearchInstructions(): string | undefined {
    const instructions: string[] = [];
    for (const [toolName, binding] of this.toolBindings.entries()) {
      if (binding.searchInstructions) {
        const label = binding.kbName || toolName;
        instructions.push(`[${label}]: ${binding.searchInstructions}`);
      }
    }
    return instructions.length > 0 ? instructions.join('\n') : undefined;
  }

  /**
   * Consume a speculative result that matches both indexId AND the current query
   * AND the current turn id.
   *
   * Resolution order:
   *   1. Exact match on `(turnId, indexId, normalizedQuery)` — fastest path.
   *   2. Same-turn fallback: any cached entry for `(turnId, indexId)`. This
   *      covers the classify-rephrases-the-query case, where the speculative
   *      was fired with the raw user message and the planner emits a
   *      rephrased `query`. Both target the same user intent within the
   *      same turn — safe to reuse.
   *
   * Entries from other turns or expired entries are never returned; they are
   * opportunistically swept while iterating.
   *
   * One-shot: consumes (removes) the matched entry after returning.
   */
  private consumeSpeculativeForQuery(
    indexId: string,
    searchQuery: string,
  ): { result: any; searchLatencyMs: number } | null {
    const turnId = this.currentTurnId;
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const exactKey = `${turnId}:${indexId}:${normalizedSearch}`;

    const exact = this.speculativeCache.get(exactKey);
    if (exact) {
      this.speculativeCache.delete(exactKey);
      if (Date.now() - exact.fetchedAt <= SPECULATIVE_CACHE_TTL_MS) {
        return { result: exact.result, searchLatencyMs: exact.searchLatencyMs };
      }
    }

    // Same-turn fallback: any fresh entry scoped to the same turn + index.
    // Key layout `${turnId}:${indexId}:…` lets us match with a strict prefix
    // check — no heuristic similarity scoring, no wall-clock window.
    const prefix = `${turnId}:${indexId}:`;
    const now = Date.now();
    for (const [key, entry] of this.speculativeCache) {
      if (!key.startsWith(prefix)) continue;
      if (now - entry.fetchedAt > SPECULATIVE_CACHE_TTL_MS) {
        this.speculativeCache.delete(key);
        continue;
      }
      this.speculativeCache.delete(key);
      return { result: entry.result, searchLatencyMs: entry.searchLatencyMs };
    }

    return null;
  }

  /**
   * Await an in-flight speculative search that was fired in the current turn
   * for the given index. Matching is by `(turnId, indexId)` only — any query
   * in this turn's speculative set targets the same user intent, so awaiting
   * any of them is safe.
   */
  private async awaitSpeculativeForQuery(
    indexId: string,
    searchQuery: string,
  ): Promise<{ result: any; searchLatencyMs: number } | null> {
    const turnId = this.currentTurnId;
    const prefix = `${turnId}:${indexId}:`;

    for (const [key, promise] of this.speculativeInFlight) {
      if (!key.startsWith(prefix)) continue;
      try {
        const result = await promise;
        if (result) {
          const cached = this.speculativeCache.get(key);
          const searchLatencyMs = cached?.searchLatencyMs ?? 0;
          this.speculativeCache.delete(key);
          log.info('Speculative search awaited for query', {
            indexId,
            turnId,
            query: searchQuery.slice(0, 50),
            searchLatencyMs,
          });
          return { result, searchLatencyMs };
        }
      } catch {
        // Inflight failed — fall through
      }
    }
    return null;
  }

  // ─── Speculative Parallel Search ────────────────────────────────────────
  // Fire a "best guess" search with the raw user message BEFORE the LLM runs.
  // When the LLM returns a tool call with a similar query, we reuse this result
  // instead of making another search API call — saving ~200-500ms.

  /**
   * Fire a speculative search for ALL registered KB tools when a new user
   * message arrives. Called from the reasoning executor BEFORE the LLM call.
   *
   * Only fires for simple/filtered KBs where the user's raw message is likely
   * to be a good search query. Skipped for trivial input (<3 chars).
   *
   * Fire-and-forget — errors are silently swallowed. The speculative result
   * is a bonus; the real search still runs if it misses.
   */
  fireSpeculativeSearch(userMessage: string): void {
    // Skip trivial input (greetings, short acks)
    if (!userMessage || userMessage.trim().length < 5) return;

    const trimmed = userMessage.trim();
    const normalized = trimmed.toLowerCase();
    const turnId = this.currentTurnId;

    for (const [toolName, binding] of this.toolBindings.entries()) {
      const indexId = binding.indexId;
      const cacheKey = `${turnId}:${indexId}:${normalized}`;

      // Skip if already in-flight or cached for this turn
      if (this.speculativeInFlight.has(cacheKey)) continue;
      const existing = this.speculativeCache.get(cacheKey);
      if (existing && Date.now() - existing.fetchedAt < SPECULATIVE_CACHE_TTL_MS) continue;

      // Always fire — even for advanced KBs. The hybrid search with the raw
      // user message is a good baseline. If the LLM adds filters/aggregation,
      // the speculative result won't match and gets discarded. No wasted cost
      // since the search API call is cheap (~200ms) vs LLM call (~1-3s).
      const speculativeTopK = this.getConfiguredTopK(indexId);
      const startMs = Date.now();
      const promise = this.client
        .unifiedSearch(indexId, {
          query: trimmed,
          queryType: 'hybrid',
          skipPreprocessing: true,
          skipVocabularyResolution: true,
          topK: speculativeTopK,
        })
        .then((result) => {
          if (this.speculativeCache.size >= SPECULATIVE_CACHE_MAX) {
            const oldest = this.speculativeCache.keys().next().value;
            if (oldest !== undefined) this.speculativeCache.delete(oldest);
          }
          this.speculativeCache.set(cacheKey, {
            turnId,
            query: trimmed,
            indexId,
            result,
            fetchedAt: Date.now(),
            searchLatencyMs: Date.now() - startMs,
          });
          log.info('Speculative search completed', {
            indexId,
            toolName,
            turnId,
            query: trimmed.slice(0, 50),
            resultCount: result?.results?.length ?? 0,
            latencyMs: Date.now() - startMs,
          });
          return result;
        })
        .catch((err) => {
          // Speculative miss is fine — real search will run
          log.info('Speculative search failed (non-fatal)', {
            indexId,
            turnId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        })
        .finally(() => {
          this.speculativeInFlight.delete(cacheKey);
        });

      this.speculativeInFlight.set(cacheKey, promise);
    }
  }

  /**
   * Check if a speculative result for the current turn matches the LLM's
   * actual search query.
   *
   * Matching is strict:
   *   1. Exact query match within `(currentTurnId, indexId)`.
   *   2. Any fresh speculative within the same turn + index (covers the
   *      main-LLM-rephrases-the-query case without needing a substring
   *      heuristic — both target the same turn's user intent).
   *   3. Any in-flight speculative within the same turn + index — awaited.
   *
   * The previous 0.6-containment heuristic is intentionally removed: it
   * confused superstring queries ("logins" vs "login logs") and relied on
   * wall-clock windows that could cross turns.
   *
   * @returns The cached / in-flight result, or null for a cache miss.
   */
  private async checkSpeculativeCache(indexId: string, query: string): Promise<any | null> {
    const turnId = this.currentTurnId;
    const normalizedQuery = query.trim().toLowerCase();
    const exactKey = `${turnId}:${indexId}:${normalizedQuery}`;
    const exact = this.speculativeCache.get(exactKey);
    if (exact) {
      this.speculativeCache.delete(exactKey);
      if (Date.now() - exact.fetchedAt <= SPECULATIVE_CACHE_TTL_MS) {
        log.info('Speculative search HIT (exact)', {
          indexId,
          turnId,
          query: query.slice(0, 50),
        });
        return exact.result;
      }
    }

    const prefix = `${turnId}:${indexId}:`;
    const now = Date.now();
    for (const [key, entry] of this.speculativeCache) {
      if (!key.startsWith(prefix)) continue;
      if (now - entry.fetchedAt > SPECULATIVE_CACHE_TTL_MS) {
        this.speculativeCache.delete(key);
        continue;
      }
      this.speculativeCache.delete(key);
      log.info('Speculative search HIT (same turn)', {
        indexId,
        turnId,
        speculativeQuery: entry.query.slice(0, 50),
        llmQuery: query.slice(0, 50),
      });
      return entry.result;
    }

    for (const [key, promise] of this.speculativeInFlight) {
      if (!key.startsWith(prefix)) continue;
      try {
        const result = await promise;
        if (result) {
          log.info('Speculative search HIT (awaited in-flight)', { indexId, turnId });
          return result;
        }
      } catch {
        // Inflight failed — fall through to real search
      }
    }

    return null;
  }

  // ─── Discovery ─────────────────────────────────────────────────────────

  /**
   * Fetch discovery manifest on first call, build description, cache it.
   * Subsequent calls for the same indexId use the cache.
   */
  private async ensureDiscovery(toolName: string, indexId: string): Promise<void> {
    const cached = this.discoveryCache.get(indexId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return;
    }

    const discoveryStartMs = Date.now();
    try {
      const manifest = await this.client.discover(indexId);
      const binding = this.toolBindings.get(toolName);
      const description = buildToolDescription(manifest, binding?.searchInstructions);

      // Classify once at discovery — tier is stable for the session lifetime
      const complexity = classifyKBComplexity(manifest);

      this.discoveryCache.set(indexId, {
        manifest,
        description,
        tier: complexity.tier,
        fetchedAt: Date.now(),
      });

      log.info('SearchAI KB discovery completed', {
        indexId,
        toolName,
        latencyMs: Date.now() - discoveryStartMs,
        kbTier: complexity.tier,
        hasVocabulary: !!manifest.capabilities?.vocabulary?.terms?.length,
        vocabularyTermCount: manifest.capabilities?.vocabulary?.terms?.length ?? 0,
        hasFilters: complexity.hasFilters,
        filterFieldCount: complexity.filterFieldCount,
        hasSchema: !!manifest.capabilities?.schema?.fields?.length,
        schemaFieldCount: manifest.capabilities?.schema?.fields?.length ?? 0,
      });

      // Notify session to update tool description + trim schema based on tier
      if (this.onDescriptionReady) {
        this.onDescriptionReady(toolName, description, complexity.tier);
      }
    } catch (error) {
      log.warn('SearchAI KB discovery failed', {
        indexId,
        toolName,
        latencyMs: Date.now() - discoveryStartMs,
        error: error instanceof Error ? error.message : String(error),
      });

      // Discovery failure is non-fatal - tool still works with basic search
      const fallbackDescription =
        `Search this knowledge base. Discovery unavailable.\n` +
        `Valid queryType values: vector, hybrid, structured, semantic, aggregation.\n` +
        `Use "structured" with filters when the user asks to list/filter by document type, status, or metadata.\n` +
        `Use "hybrid" for best general results when the user asks conceptual questions.\n` +
        `Use "aggregation" with the aggregation parameter when the user asks to count, group, or break down items.\n` +
        `\nFILTERS: Use the "filters" parameter to narrow results by metadata. Format: [{field, operator, value}].\n` +
        `Common fields: source_type (values: pdf, docx, doc, markdown, text, json, csv, image), mime_type, language, author, status, category.\n` +
        `Operators: equals, contains, in, greater_than, less_than.\n` +
        `Example: To list PDF documents, use queryType "structured" with filters: [{"field":"source_type","operator":"equals","value":"pdf"}].\n` +
        `IMPORTANT: When the user asks for documents by type (e.g., "show PDFs", "list word docs"), ALWAYS include a source_type filter.\n` +
        `\nAGGREGATIONS: Use queryType "aggregation" with aggregation: {"field": "<field_name>", "function": "count"}.\n` +
        `Example: "how many per file type" → queryType: "aggregation", aggregation: {"field": "source_type", "function": "count"}.\n` +
        `Example: "list all authors" → queryType: "aggregation", aggregation: {"field": "author", "function": "count"}.`;

      this.discoveryCache.set(indexId, {
        manifest: null,
        description: fallbackDescription,
        tier: 'simple', // Fallback: assume simple when discovery fails
        fetchedAt: Date.now(),
      });

      if (this.onDescriptionReady) {
        this.onDescriptionReady(toolName, fallbackDescription, 'simple');
      }
    }
  }

  // ─── Search Execution ──────────────────────────────────────────────────

  /**
   * Translate tool params and call the unified search endpoint via SDK.
   * Applies context-aware query enrichment (pre) and result summarization (post).
   */
  private async executeSearch(indexId: string, params: Record<string, unknown>): Promise<unknown> {
    let query = String(params.query ?? '');
    if (!query) {
      throw new Error('SearchAI KB tool requires a "query" parameter');
    }

    // Agent flow: The agent LLM already has vocabulary context and filter fields
    // in its tool description (built by description-builder.ts). It makes its own
    // query classification and filtering decisions — no redundant enrichment LLM
    // call needed. This eliminates ~7s of latency from every search tool call.
    //
    // Previously, enrichQueryWithFilters() called gpt-4o with conversation history
    // + vocabulary to "rephrase" the query, but returned the same query ~95% of the
    // time because the agent LLM already handled this.
    const skipPreprocessing = params.skipPreprocessing ?? params.skip_preprocessing ?? true;
    const skipVocabularyResolution =
      params.skipVocabularyResolution ?? params.skip_vocabulary_resolution ?? true;
    const existingFilters = params.filters as unknown[] | undefined;
    let filters: unknown[] | undefined = existingFilters;

    // ─── Speculative Search Shortcut ─────────────────────────────────────
    // If a speculative search was pre-fired with the raw user message, check
    // whether the LLM's query is similar enough to reuse the result.
    // Only applies when: no filters (simple query), queryType is hybrid/semantic.
    const requestedQueryType = (params.queryType ?? params.query_type) as string | undefined;
    const isSimpleQuery = !existingFilters?.length && !params.aggregation;
    const speculativeCompatibleType =
      !requestedQueryType ||
      requestedQueryType === 'hybrid' ||
      requestedQueryType === 'semantic' ||
      requestedQueryType === 'vector';

    if (isSimpleQuery && speculativeCompatibleType) {
      const speculativeResult = await this.checkSpeculativeCache(indexId, query);
      if (speculativeResult) {
        log.info('Using speculative search result — saved search roundtrip', {
          indexId,
          query: query.slice(0, 50),
          resultCount: speculativeResult.results?.length ?? 0,
        });
        const formatted = this.formatResult(speculativeResult, false, indexId);
        formatted._searchLatencyMs = 0; // Instant — from speculative cache
        formatted._speculative = true;
        return formatted;
      }
    }

    // Validate and normalize queryType.
    // LLMs frequently hallucinate values like "phrase", "keyword", "fulltext", "text".
    // We normalize case, map common aliases, and default to "hybrid" for anything unknown.
    const VALID_QUERY_TYPES = new Set([
      'vector',
      'hybrid',
      'structured',
      'semantic',
      'aggregation',
    ]);
    const QUERY_TYPE_ALIASES: Record<string, string> = {
      // Common LLM hallucinations → best matching valid type
      // natural language / general queries → semantic (concept search)
      natural: 'semantic',
      'natural-language': 'semantic',
      natural_language: 'semantic',
      conversational: 'semantic',
      conceptual: 'semantic',
      // text/phrase search → hybrid (vector + BM25)
      phrase: 'hybrid',
      fulltext: 'hybrid',
      'full-text': 'hybrid',
      text: 'hybrid',
      search: 'hybrid',
      linear: 'hybrid',
      fuzzy: 'hybrid',
      match: 'hybrid',
      default: 'hybrid',
      general: 'hybrid',
      // keyword/exact term queries → structured (BM25 only, no vector)
      keyword: 'structured',
      bm25: 'structured',
      exact: 'structured',
      // filter intent → hybrid (filters work with all types, but hybrid
      // gives best results: vector relevance + BM25 + field filters)
      filter: 'hybrid',
      filtered: 'hybrid',
      // vector-specific → vector
      similarity: 'vector',
      knn: 'vector',
      embedding: 'vector',
      dense: 'vector',
      // aggregation aliases
      aggregate: 'aggregation',
      stats: 'aggregation',
      count: 'aggregation',
    };
    const DEFAULT_QUERY_TYPE = 'hybrid';

    const rawQueryType = (params.queryType ?? params.query_type) as string | undefined;
    let queryType = DEFAULT_QUERY_TYPE;
    if (rawQueryType) {
      const normalized = rawQueryType.toLowerCase().trim();
      if (VALID_QUERY_TYPES.has(normalized)) {
        queryType = normalized;
      } else if (QUERY_TYPE_ALIASES[normalized]) {
        queryType = QUERY_TYPE_ALIASES[normalized];
        log.info('Normalized invalid queryType from LLM', {
          original: rawQueryType,
          resolved: queryType,
        });
      } else {
        log.warn('Unknown queryType from LLM, defaulting to hybrid', {
          original: rawQueryType,
          defaultedTo: DEFAULT_QUERY_TYPE,
        });
      }
    }

    // Normalize filters from LLM — handle common hallucinations:
    // - {key, value} instead of {field, operator, value}
    // - "fileType"/"type"/"document_type" instead of "source_type"
    // - Missing operator (default to "equals")
    // - Uppercase values like "PDF" instead of "pdf"
    if (Array.isArray(filters) && filters.length > 0) {
      filters = filters.map((f: any) => normalizeFilter(f));
    }

    // Normalize aggregation parameter — LLMs frequently hallucinate formats:
    // - "count" (bare string) instead of {field, function}
    // - {function: "count"} missing field
    // - "count by source_type" (natural language)
    const aggregation =
      queryType === 'aggregation' ? normalizeAggregation(params.aggregation) : params.aggregation;

    // Build unified search request
    const body: Record<string, unknown> = {
      query,
      queryType,
      filters,
      aggregation,
      rerank: params.rerank ?? params.re_rank,
      topK: asNumber(params.topK ?? params.top_k) ?? this.getConfiguredTopK(indexId),
      limit: asNumber(params.limit),
      offset: asNumber(params.offset),
      skipPreprocessing,
      skipVocabularyResolution,
      debug: params.debug,
    };

    // Remove undefined values
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) {
        delete body[key];
      }
    }

    // Call unified search via SDK (inherits auth, timeout, error handling)
    const searchStartMs = Date.now();
    const result = await this.client.unifiedSearch(indexId, body);
    const searchLatencyMs = Date.now() - searchStartMs;

    // Log search metrics for observability
    log.info('SearchAI KB tool search completed', {
      indexId,
      query,
      queryType,
      filtersCount: Array.isArray(filters) ? filters.length : 0,
      filters: Array.isArray(filters) ? filters : undefined,
      totalCount: result.totalCount ?? 0,
      resultCount: result.results?.length ?? 0,
      topScore: result.results?.[0]?.score ?? null,
      searchLatencyMs,
      skipPreprocessing: !!skipPreprocessing,
      skipVocabularyResolution: !!skipVocabularyResolution,
      resolvedQueryType: result.queryType ?? queryType,
      hasDebug: !!result.debug,
    });

    // Format for LLM consumption — lean output for fast synthesis.
    // Include searchLatencyMs so it's visible in the tool_call trace output.
    const formatted = this.formatResult(result, false, indexId);
    formatted._searchLatencyMs = searchLatencyMs;
    return formatted;
  }

  private static readonly DEFAULT_RESPONSE_FIELDS: string[] = ['title', 'content'];

  /**
   * Format search results for LLM consumption.
   * Aggressively trims to minimize token usage — the synthesis LLM only
   * needs titles, scores, and enough content to answer the question.
   *
   * Budget: aim for <4K tokens (~16K chars) per tool result to keep
   * synthesis fast (<1s for short answers).
   */
  private formatResult(result: any, compact = false, indexId?: string): any {
    if (result.aggregations) {
      return {
        queryType: result.queryType || 'aggregation',
        aggregations: result.aggregations,
        totalCount: result.totalCount,
      };
    }

    const allResults = result.results || [];
    const configuredMax = indexId ? this.getConfiguredTopK(indexId) : undefined;
    const maxResults = configuredMax ?? (compact ? MAX_RESULTS_FAST_PATH : MAX_RESULTS_FOR_LLM);
    const topResults = allResults.slice(0, maxResults);
    const responseFields = this.getConfiguredResponseFields(indexId);

    return {
      queryType: result.queryType || 'hybrid',
      results: topResults.map((r: any) => {
        const meta = r.metadata ?? {};
        const canonical = meta?.canonical ?? {};
        const base: Record<string, any> = {};

        for (const field of responseFields) {
          if (field === 'title') {
            base.title = canonical.title ?? meta?.title ?? meta?.source_name ?? undefined;
          } else if (field === 'content') {
            base.content = r.content ?? '';
          } else {
            const val = canonical[field] ?? meta?.[field];
            if (val != null && val !== '') {
              base[field] = val;
            }
          }
        }

        // Citation metadata — always include for citation URL generation
        base._sourceUrl = r.source?.reference ?? undefined;
        base._documentId = r.documentId ?? undefined;
        base._sourceType = (r.source?.sourceType as 'connector' | 'upload' | 'crawled') ?? 'upload';
        /** External source URL from canonical metadata — fallback for citation URL generation */
        base._sourceKey = canonical.source_url ?? undefined;
        /** Page number from chunk metadata — used for page-level citation linking */
        base._pageNumber = meta?.pageNumber ?? undefined;
        /** Relevance score — used for citation threshold filtering */
        base._score = typeof r.score === 'number' ? r.score : undefined;

        return base;
      }),
      totalCount: result.totalCount,
      // Structured data from ClickHouse text-to-SQL enrichment (CSV/Excel queries)
      ...(result.structuredData
        ? {
            structuredData: {
              intent: result.structuredData.intent,
              results: result.structuredData.results,
              totalCount: result.structuredData.totalCount,
            },
          }
        : {}),
    };
  }

  /**
   * Strip underscore-prefixed citation metadata from formatted results before
   * sending to the LLM. The LLM should NOT see raw citation URLs — it must use
   * [1], [2] markers referencing result positions. The metadata fields are only
   * needed by buildCitationMap() which runs on the original (unstripped) result.
   *
   * IMPORTANT: Results are deduplicated by citation target here so that the
   * LLM's [N] indices match the citation list indices. Multiple chunks from the
   * same document page are merged into one result entry, while different pages
   * remain separately citeable.
   */
  stripCitationMetadataForLLM(formattedResult: any): any {
    if (!formattedResult?.results || !Array.isArray(formattedResult.results)) {
      return formattedResult;
    }

    // Deduplicate by citation target — merge content from the same page/source.
    // This ensures LLM's [1], [2]... indices match the deduplicated citation list.
    const seenDocs = new Map<string, { title: string | undefined; contents: string[] }>();
    const orderedKeys: string[] = [];

    for (let i = 0; i < formattedResult.results.length; i++) {
      const r = formattedResult.results[i];
      const docKey = buildCitationTargetKey(r, i);
      if (seenDocs.has(docKey)) {
        // Append content from additional chunks of same document
        const entry = seenDocs.get(docKey)!;
        if (r.content) entry.contents.push(r.content);
      } else {
        seenDocs.set(docKey, {
          title: r.title,
          contents: r.content ? [r.content] : [],
        });
        orderedKeys.push(docKey);
      }
    }

    return {
      ...formattedResult,
      results: orderedKeys.map((key, idx) => {
        const entry = seenDocs.get(key)!;
        return {
          resultIndex: idx + 1,
          title: entry.title,
          content: entry.contents.length > 0 ? entry.contents.join('\n\n---\n\n') : undefined,
        };
      }),
    };
  }

  /**
   * Build a citations array from formatted search results.
   * Called after formatResult() — maps result positions to source URLs.
   */
  buildCitationMap(
    formattedResult: {
      queryType?: string;
      results?: Array<{
        title?: string;
        content: string;
        _sourceUrl?: string;
        _documentId?: string;
        _sourceType?: string;
        _sourceKey?: string;
        _pageNumber?: number;
        _score?: number;
      }>;
    },
    citationConfig:
      | { enabled: boolean; linkMode?: string; linkTtlSeconds?: number; maxClicks?: number }
      | null
      | undefined,
    context?: { tenantId?: string; indexId?: string },
  ): Citation[] | undefined {
    if (citationConfig?.enabled === false) return undefined;

    const results = formattedResult.results;
    if (!results?.length) return undefined;

    // Determine relevance score threshold based on query type.
    // Results below this threshold are excluded from citations to prevent
    // irrelevant documents from being cited (e.g. wrong person's resume).
    const queryType = formattedResult.queryType ?? 'hybrid';
    const minScore =
      queryType === 'structured' || queryType === 'keyword'
        ? CITATION_MIN_SCORE_STRUCTURED
        : CITATION_MIN_SCORE_HYBRID;

    const citations: Citation[] = [];
    // Deduplicate by citation target — all chunks from the same document page
    // collapse into a single citation. This MUST match the deduplication in
    // stripCitationMetadataForLLM() so the LLM's [N] indices align with the
    // citation list shown in the UI.
    const seenCitations = new Set<string>();

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      // Skip results below relevance threshold — prevents false citations
      if (typeof r._score === 'number' && r._score < minScore) {
        log.debug('Skipping low-relevance result from citations', {
          index: i,
          score: r._score,
          minScore,
          title: r.title,
          documentId: r._documentId,
        });
        continue;
      }
      // Skip results without source info — but allow through if we have an S3
      // sourceKey that can be signed into a JWT citation URL (covers both uploads
      // AND connector-synced documents stored in S3/local storage).
      if (!r._sourceUrl && r._sourceType !== 'upload' && !r._sourceKey) continue;

      const docKey = buildCitationTargetKey(r, i);
      if (seenCitations.has(docKey)) continue;
      seenCitations.add(docKey);

      let url = r._sourceUrl ?? '';

      // For documents without a direct URL (uploads AND connector-synced S3 docs),
      // generate a JWT download URL.
      // The JWT is self-authenticating and works from ALL channels (web, Slack, Telegram).
      if (!url && r._documentId && r._sourceKey) {
        try {
          const secret = process.env.CITATION_SIGNING_SECRET || process.env.JWT_SECRET || '';
          if (secret && context?.tenantId) {
            // Default to click_limited mode — citations should work anytime (no short TTL),
            // but are exhausted after maxClicks downloads to prevent unlimited sharing.
            const linkMode =
              (citationConfig?.linkMode as 'direct' | 'time_limited' | 'click_limited') ??
              'click_limited';
            const defaultMaxClicks = 3;
            // Extract bare S3 key from full s3:// URL if needed
            let sourceKey = r._sourceKey;
            if (sourceKey.startsWith('s3://')) {
              const withoutProtocol = sourceKey.slice(5);
              const slashIdx = withoutProtocol.indexOf('/');
              sourceKey = slashIdx >= 0 ? withoutProtocol.slice(slashIdx + 1) : withoutProtocol;
            }
            // Strip leading slash — S3 keys are relative, a leading '/' causes
            // double-slash in presigned URLs (//uploads/...) → 404
            if (sourceKey.startsWith('/')) {
              sourceKey = sourceKey.slice(1);
            }
            const token = signCitationToken(
              {
                tenantId: context.tenantId,
                indexId: context.indexId ?? '',
                documentId: r._documentId,
                sourceKey,
                linkMode,
                ...(linkMode === 'click_limited'
                  ? { maxClicks: citationConfig?.maxClicks ?? defaultMaxClicks }
                  : {}),
              },
              secret,
              {
                // Click-limited mode: use a very long TTL (1 year) — expiry is by clicks, not time.
                // Time-limited mode: respect configured TTL or default 1 hour.
                expiresIn: citationConfig?.linkTtlSeconds
                  ? `${citationConfig.linkTtlSeconds}s`
                  : linkMode === 'click_limited'
                    ? '31536000s'
                    : '3600s',
              },
            );
            // Use public URL for citation links (user's browser must reach this).
            // SEARCH_AI_PUBLIC_URL includes the ingress prefix path, e.g.:
            //   https://agents-dev.kore.ai/api/search-ai
            // So the citation URL becomes: {publicUrl}/citations/{token}
            const publicUrl = process.env.SEARCH_AI_PUBLIC_URL;
            if (publicUrl) {
              url = `${publicUrl}/citations/${token}`;
            } else {
              const searchAiUrl = process.env.SEARCH_AI_URL || 'http://localhost:3005';
              url = `${searchAiUrl}/api/citations/${token}`;
            }
          }
        } catch {
          // If signing fails, skip this citation — don't break the response
          log.warn('Failed to sign citation token for upload', {
            documentId: r._documentId,
          });
        }
      }

      if (!url) continue;

      // Append #page=N fragment when pageNumber is available.
      // - Connector/crawled (direct URL): browser PDF viewer honors #page=N natively
      // - Upload (JWT download URL → 302 → S3 presigned): browsers preserve fragment
      //   across 302 redirects per RFC 7231 §7.1.2, so #page=N survives the redirect
      //   chain and the S3-served PDF opens at the correct page.
      const pageNumber =
        typeof r._pageNumber === 'number' && r._pageNumber > 0 ? r._pageNumber : undefined;
      if (pageNumber && !url.includes('#')) {
        url = `${url}#page=${pageNumber}`;
      }

      // Use sequential index for deduplicated list (not original result position)
      const citationIndex = citations.length + 1;
      citations.push({
        index: citationIndex,
        title: r.title ?? `Source ${citationIndex}`,
        url,
        sourceType: (r._sourceType as 'connector' | 'upload' | 'crawled') ?? 'upload',
        documentId: r._documentId ?? '',
        ...(pageNumber ? { pageNumber } : {}),
      });
    }

    return citations.length > 0 ? citations : undefined;
  }

  /**
   * Get the cached discovery manifest for a tool (for testing/debugging).
   */
  getDiscoveryManifest(indexId: string): any | null {
    const cached = this.discoveryCache.get(indexId);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
      this.discoveryCache.delete(indexId);
      return null;
    }
    return cached.manifest;
  }

  /**
   * Get the cached description for a tool (for testing/debugging).
   */
  getDescription(indexId: string): string | null {
    return this.discoveryCache.get(indexId)?.description ?? null;
  }

  /**
   * Get the cached KB complexity tier (classified once at discovery time).
   * Returns null if discovery hasn't completed yet.
   */
  getKBTier(indexId: string): import('./description-builder.js').KBComplexityTier | null {
    return this.discoveryCache.get(indexId)?.tier ?? null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildCitationTargetKey(
  result: {
    title?: string;
    _sourceUrl?: string;
    _documentId?: string;
    _pageNumber?: number;
  },
  index: number,
): string {
  const baseKey = result._documentId || result._sourceUrl || result.title || `idx-${index}`;
  const pageSuffix =
    typeof result._pageNumber === 'number' && result._pageNumber > 0
      ? `:page:${result._pageNumber}`
      : '';
  return `${baseKey}${pageSuffix}`;
}

/**
 * Strip heavy fields from metadata before passing to LLM.
 * Embedding vectors (1024 floats ≈ 32KB text) waste tokens and can
 * cause LLM context overflow, leading to empty responses.
 */
function stripHeavyFields(metadata: any): any {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const { vector, embedding, embeddings, ...clean } = metadata;
  return clean;
}

function asNumber(value: unknown, defaultValue?: number): number | undefined {
  if (value === undefined || value === null) return defaultValue;
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}

/**
 * Normalize a filter object from the LLM.
 * LLMs hallucinate filter formats — this handles common variations:
 * - {key, value} → {field, operator, value}
 * - "fileType"/"type"/"documentType" → "source_type"
 * - "mimeType"/"mime" → "mime_type"
 * - Missing operator → defaults to "equals"
 */
function normalizeFilter(f: Record<string, unknown>): Record<string, unknown> {
  // Normalize field name: accept "key", "name", "field"
  let field = String(f.field ?? f.key ?? f.name ?? '');

  // Handle bare key-value pair: {"source_type": "docx"} → {field: "source_type", value: "docx"}
  // LLMs often send this format instead of {field, operator, value}.
  // Detect: no "field"/"key"/"name"/"operator"/"value" keys, and exactly 1 entry with a string/array value.
  if (!field) {
    const reserved = new Set(['field', 'key', 'name', 'operator', 'op', 'value', 'val']);
    const bareEntries = Object.entries(f).filter(([k]) => !reserved.has(k));
    if (
      bareEntries.length === 1 &&
      (typeof bareEntries[0][1] === 'string' ||
        typeof bareEntries[0][1] === 'number' ||
        Array.isArray(bareEntries[0][1]))
    ) {
      field = bareEntries[0][0];
      f = { field, value: bareEntries[0][1] };
    }
  }

  if (!field) return f;

  // Map common LLM hallucinated field names to canonical names
  const FIELD_ALIASES: Record<string, string> = {
    filetype: 'source_type',
    file_type: 'source_type',
    fileType: 'source_type',
    documenttype: 'source_type',
    document_type: 'source_type',
    documentType: 'source_type',
    type: 'source_type',
    doc_type: 'source_type',
    doctype: 'source_type',
    format: 'source_type',
    extension: 'source_type',
    ext: 'source_type',
    mimetype: 'mime_type',
    mimeType: 'mime_type',
    mime: 'mime_type',
    content_type: 'mime_type',
    contentType: 'mime_type',
    lang: 'language',
    name: 'title',
    filename: 'title',
    file_name: 'title',
    fileName: 'title',
  };

  const aliasLookup = field.toLowerCase().replace(/[-\s]/g, '_');
  field = FIELD_ALIASES[aliasLookup] ?? FIELD_ALIASES[field] ?? field;

  // Normalize operator: default to "equals" if missing
  const operator = String(f.operator ?? f.op ?? 'equals');

  // Normalize value for source_type (lowercase common extensions)
  let value = f.value ?? f.val;
  if (field === 'source_type' && typeof value === 'string') {
    value = value.toLowerCase();
  }

  return { field, operator, value };
}

/**
 * Normalize the aggregation parameter from the LLM.
 * LLMs frequently hallucinate simpler formats:
 * - "count" (bare string) instead of {field: "source_type", function: "count"}
 * - {function: "count"} missing field
 * - "count by source_type" (natural language)
 * - "count" as aggregation value with no groupBy intent
 *
 * The query pipeline expects: { field: string, function: string }
 * where `field` is the groupBy field. Without `field`, it returns a flat total count.
 */
function normalizeAggregation(agg: unknown): { field: string; function: string } | undefined {
  if (!agg) return undefined;

  // Handle JSON-stringified objects from LLMs: "{\"field\": \"X\", \"function\": \"Y\"}"
  if (typeof agg === 'string' && agg.trim().startsWith('{')) {
    try {
      agg = JSON.parse(agg);
    } catch {
      // Not valid JSON — continue with string processing below
    }
  }

  // Already correct format: { field: "source_type", function: "count" }
  if (typeof agg === 'object' && !Array.isArray(agg)) {
    const obj = agg as Record<string, unknown>;
    const fn = String(obj.function ?? obj.fn ?? obj.metric ?? 'count');
    const field = obj.field ?? obj.measure ?? obj.groupBy ?? obj.group_by;

    if (field) {
      // Normalize field — handle arrays (take first)
      const resolvedField = Array.isArray(field) ? String(field[0]) : String(field);
      return { field: resolvedField, function: fn };
    }

    // Object but missing field — LLM sent {function: "count"} without specifying what to group by.
    // Default to source_type which is the most common aggregation field.
    log.info('Aggregation missing field, defaulting to source_type', {
      original: agg,
    });
    return { field: 'source_type', function: fn };
  }

  // Bare string: "count", "count by source_type", etc.
  if (typeof agg === 'string') {
    const lower = agg.toLowerCase().trim();

    // Parse "count by <field>" or "count per <field>" patterns
    const byMatch = lower.match(/^(count|sum|avg|min|max)\s+(?:by|per|of|grouped?\s*by)\s+(.+)$/);
    if (byMatch) {
      return { field: byMatch[2].trim(), function: byMatch[1] };
    }

    // Bare function name: "count" — default to source_type groupBy
    const VALID_FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);
    if (VALID_FUNCTIONS.has(lower)) {
      log.info('Aggregation bare string, defaulting groupBy to source_type', {
        original: agg,
      });
      return { field: 'source_type', function: lower };
    }

    // Treat as field name: "source_type" → count by source_type
    return { field: lower, function: 'count' };
  }

  return undefined;
}
