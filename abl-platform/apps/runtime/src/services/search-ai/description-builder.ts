/**
 * SearchAI KB Tool Description Builder
 *
 * Converts a discovery manifest (from GET /api/search/:indexId/discover)
 * into a lean LLM-readable tool description string.
 *
 * Design principle: parameter-level guidance (queryType usage, filter syntax,
 * aggregation format, reranking, preprocessing) lives in the tool's
 * input_schema param descriptions (see SEARCHAI_PARAM_DESCRIPTIONS in
 * load-project-tools-as-ir.ts). The main description carries ONLY:
 * - KB identity (name, doc count, freshness)
 * - Dynamic content that varies per KB (vocabulary terms, filter fields)
 * - Condensed search rules
 *
 * Tiered prompt strategy:
 * - SIMPLE: Documents-only KB, ≤2 vocab terms, no connectors → minimal prompt
 *   (~200 tokens). Default queryType: hybrid. No filter instructions.
 * - FILTERED: Has vocabulary/filter fields but no aggregation → medium prompt
 *   (~400 tokens). Includes filter guidance.
 * - ADVANCED: Full vocabulary, aggregation, connectors → full prompt (~600 tokens).
 *   Includes all query types, filter, and aggregation guidance.
 *
 * Target: <500 tokens for a basic KB with no vocabulary/filters.
 */

/** Maximum vocabulary terms to include in description (LLM context budget) */
const MAX_VOCAB_TERMS = 30;
/** Maximum filter fields to include */
const MAX_FILTER_FIELDS = 20;

// ─── KB Complexity Tier ─────────────────────────────────────────────────────
// Deterministic classification — no LLM needed. Inspects the manifest to decide
// which prompt tier to use. This reduces input tokens for simple KBs.

export type KBComplexityTier = 'simple' | 'filtered' | 'advanced';

/**
 * Standard auto-seeded field names that every document KB gets automatically
 * from document-upload-vocabulary-seeder.ts. These do NOT indicate a rich
 * connector KB — they exist on plain document KBs with PDFs/docs.
 *
 * Only DOMAIN-SPECIFIC vocab (status, priority, assignee, sprint, etc.)
 * should push a KB into the filtered/advanced tier.
 */
const STANDARD_AUTO_SEEDED_FIELDS = new Set([
  'title',
  'author',
  'mime_type',
  'source_type',
  'language',
  'created_date',
  'updated_date',
]);

/**
 * Classify a KB's complexity tier from its discovery manifest.
 * Pure function — no I/O, no LLM. Called once at discovery time and cached.
 *
 * Standard auto-seeded fields (mime_type, source_type, title, author) are
 * excluded when counting — they exist on ALL document KBs and don't indicate
 * a connector KB with rich domain vocabulary.
 *
 * @returns The tier + the default queryType for simple KBs
 */
export function classifyKBComplexity(manifest: any): {
  tier: KBComplexityTier;
  defaultQueryType: string;
  hasFilters: boolean;
  hasAggregation: boolean;
  vocabularyCount: number;
  filterFieldCount: number;
  domainVocabCount: number;
  domainFilterCount: number;
} {
  const caps = manifest?.capabilities || {};
  const vocabTerms = caps.vocabulary?.terms || [];
  const filterFields = caps.filters?.fields || [];
  const aggregatable = caps.aggregation?.available === true;

  const vocabularyCount = vocabTerms.length;
  const filterFieldCount = filterFields.length;

  // Count only domain-specific vocab/filters (exclude standard auto-seeded)
  const domainVocabTerms = vocabTerms.filter((t: any) => !STANDARD_AUTO_SEEDED_FIELDS.has(t.field));
  const domainFilterFields = filterFields.filter(
    (f: any) => !STANDARD_AUTO_SEEDED_FIELDS.has(f.name),
  );
  const domainVocabCount = domainVocabTerms.length;
  const domainFilterCount = domainFilterFields.length;

  const hasFilters = filterFieldCount > 0;
  const hasAggregation = aggregatable;
  // Domain-aware: only real connector vocab triggers filtered/advanced
  const hasDomainFilters = domainFilterCount > 0;
  const hasDomainVocab = domainVocabCount > 0;

  let tier: KBComplexityTier;
  let defaultQueryType: string;

  if (!hasDomainVocab && !hasDomainFilters && !hasFilters) {
    // Simple KB: no filterable fields at all (no vocab configured).
    tier = 'simple';
    defaultQueryType = 'hybrid';
  } else if (hasAggregation && (hasDomainVocab || hasDomainFilters)) {
    // Advanced KB: domain vocab + aggregation support
    tier = 'advanced';
    defaultQueryType = 'hybrid';
  } else {
    // Filtered KB: has any filterable fields (including standard ones like
    // mime_type, source_type, language). Users explicitly configured these
    // as vocabulary — show them to the agent so it can extract filters.
    tier = 'filtered';
    defaultQueryType = 'hybrid';
  }

  return {
    tier,
    defaultQueryType,
    hasFilters,
    hasAggregation,
    vocabularyCount,
    filterFieldCount,
    domainVocabCount,
    domainFilterCount,
  };
}

/**
 * Build an LLM-readable tool description from a discovery manifest.
 * Uses tiered prompts based on KB complexity to minimize input tokens.
 *
 * @param manifest - The discovery API response
 * @param searchInstructions - Optional user-defined instructions for search behavior
 * @returns A string suitable for ToolDefinition.description
 */
export function buildToolDescription(manifest: any, searchInstructions?: string): string {
  const complexity = classifyKBComplexity(manifest);
  const lines: string[] = [];

  // ─── KB identity (all tiers) ──────────────────────────────────────────
  const kb = manifest.kb || {};
  const docCount = kb.documentCount || 0;
  const lastUpdated = kb.lastUpdated ? timeAgo(new Date(kb.lastUpdated)) : null;

  lines.push(
    `Search the "${kb.name || 'Knowledge Base'}" knowledge base` +
      (docCount > 0 ? ` (${docCount.toLocaleString()} documents` : '(no documents yet') +
      (lastUpdated ? `, updated ${lastUpdated}).` : ').'),
  );
  if (kb.description) {
    lines.push(kb.description);
  }

  const caps = manifest.capabilities || {};

  // ─── Tier-based content ───────────────────────────────────────────────
  if (complexity.tier === 'simple') {
    // SIMPLE: No vocabulary/filter sections. Just identity + minimal rules.
    // ~200 tokens — fastest possible TTFT for basic document KBs.
    lines.push('');
    lines.push(
      'Use queryType "hybrid" for best results. Keep the query in its original language — never translate.',
    );
  } else {
    // FILTERED / ADVANCED: Include vocabulary and filter sections
    if (caps.vocabulary?.available) {
      buildVocabularySection(lines, caps.vocabulary);
    }
    if (caps.filters?.available) {
      buildFiltersSection(lines, caps.filters);
    }
  }

  // ─── Search Instructions (user-defined, optional) ─────────────────────
  if (searchInstructions) {
    lines.push('');
    lines.push('SEARCH INSTRUCTIONS:');
    lines.push(searchInstructions);
  }

  // ─── Rules (all tiers, but condensed for simple) ──────────────────────
  lines.push('');
  lines.push('RULES:');
  lines.push(
    '- Prefer ONE search call per topic. Only use multiple calls for unrelated topics or different knowledge bases.',
  );
  if (complexity.tier !== 'simple') {
    lines.push(
      '- In multi-turn conversations, carry forward relevant context and filters from prior turns.',
    );
  }

  return lines.join('\n');
}

// ─── Section Builders ────────────────────────────────────────────────────

function buildVocabularySection(lines: string[], vocabulary: any): void {
  const terms = vocabulary.terms || [];
  if (terms.length === 0) return;

  lines.push('');
  lines.push(`VOCABULARY (${terms.length} terms):`);
  for (const term of terms.slice(0, MAX_VOCAB_TERMS)) {
    const aliases = term.aliases?.length > 0 ? ` (aliases: ${term.aliases.join(', ')})` : '';
    const capsArr: string[] = [];
    if (term.canFilter) capsArr.push('filter');
    if (term.canAggregate) capsArr.push('aggregate');
    if (term.canSort) capsArr.push('sort');
    const capsStr = capsArr.length > 0 ? ` [${capsArr.join(', ')}]` : '';
    let valuesStr = '';
    if (term.enumMap && Object.keys(term.enumMap).length > 0) {
      const entries = Object.entries(term.enumMap).slice(0, 6);
      valuesStr = ` values: [${entries.map(([k, v]) => (k === String(v) ? k : `${k}=${v}`)).join(', ')}]`;
    } else if (term.values?.length > 0) {
      valuesStr = ` values: [${term.values.join(', ')}]`;
    }
    lines.push(`- "${term.term}"${aliases} → ${term.field}${capsStr}${valuesStr}`);
  }
  if (terms.length > MAX_VOCAB_TERMS) {
    lines.push(`  ... and ${terms.length - MAX_VOCAB_TERMS} more terms`);
  }
}

function buildFiltersSection(lines: string[], filters: any): void {
  const fields = filters.fields || [];
  if (fields.length === 0) return;

  lines.push('');
  lines.push(`FILTERS (${fields.length} fields):`);
  for (const f of fields.slice(0, MAX_FILTER_FIELDS)) {
    const typeStr = f.type || 'string';
    const sortStr = f.sortable ? ', sortable' : '';
    if (f.enumMap && Object.keys(f.enumMap).length > 0) {
      const entries = Object.entries(f.enumMap).slice(0, 6);
      const enumStr = entries.map(([k, v]) => (k === String(v) ? k : `${k}=${v}`)).join(', ');
      const more = Object.keys(f.enumMap).length > 6 ? '...' : '';
      lines.push(`- ${f.name} (${typeStr}${sortStr}): ${enumStr}${more}`);
    } else if (f.values?.length > 0) {
      const vals = f.values.slice(0, 5).join(', ');
      const more = f.values.length > 5 ? '...' : '';
      lines.push(`- ${f.name} (${typeStr}${sortStr}): ${vals}${more}`);
    } else {
      lines.push(`- ${f.name} (${typeStr}${sortStr})`);
    }
  }
  if (filters.operators?.length > 0) {
    lines.push(`Operators: ${filters.operators.join(', ')}`);
  }
}

// ─── Classify Prompt Builders ──────────────────────────────────────────────
// Tier-aware prompts for the KB fast path classify+plan LLM call.
// Simple KBs get a tiny JSON prompt (~150 tokens). Filtered/advanced KBs get
// vocabulary context so the LLM can extract filters + queryType in one call.
//
// Both tiers now emit the SAME JSON plan schema so a single parser
// (`parseClassifyPlan`) handles both paths and the call-site branching is
// about prompt size only, not response shape.

/**
 * Canonical shape the classify LLM returns (applies to both simple and
 * filtered/advanced tiers). Every field except `action` is optional.
 */
export interface ClassifyPlan {
  action: 'DIRECT' | 'SEARCH';
  response?: string;
  query?: string;
  queryType?: string;
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  aggregation?: { field: string; function: string };
}

/**
 * Parse the raw classify-LLM response into a ClassifyPlan.
 *
 * Handles three failure modes LLMs commonly produce:
 *   1. JSON wrapped in ```json fences
 *   2. Bare JSON with surrounding whitespace
 *   3. Plain-text fallback — treated as a rephrased search query
 *
 * Returns `null` only when the input is empty or unusable; any non-empty
 * text resolves to either DIRECT (if the model explicitly said so) or a
 * SEARCH plan with the text as the rephrased query.
 */
export function parseClassifyPlan(raw: string | null | undefined): ClassifyPlan | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  let jsonStr = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();

  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = jsonStr.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const action =
        parsed.action === 'DIRECT' ? 'DIRECT' : parsed.action === 'SEARCH' ? 'SEARCH' : undefined;
      if (action) {
        const plan: ClassifyPlan = { action };
        if (typeof parsed.response === 'string') plan.response = parsed.response;
        if (typeof parsed.query === 'string') plan.query = parsed.query;
        if (typeof parsed.queryType === 'string') plan.queryType = parsed.queryType;
        if (Array.isArray(parsed.filters)) {
          plan.filters = parsed.filters.filter(
            (f): f is { field: string; operator: string; value: unknown } =>
              !!f &&
              typeof f === 'object' &&
              typeof (f as any).field === 'string' &&
              typeof (f as any).operator === 'string' &&
              'value' in (f as any),
          );
        }
        if (
          parsed.aggregation &&
          typeof parsed.aggregation === 'object' &&
          typeof (parsed.aggregation as any).field === 'string' &&
          typeof (parsed.aggregation as any).function === 'string'
        ) {
          plan.aggregation = parsed.aggregation as { field: string; function: string };
        }
        return plan;
      }
    } catch {
      // Fall through to plain-text fallback
    }
  }

  // Plain-text fallback grammar used by older simple-tier prompts.
  // Kept so a model that ignores the JSON instruction still routes correctly.
  if (/^DIRECT\s*:/i.test(text)) {
    const resp = text.replace(/^DIRECT\s*:\s*/i, '').trim();
    return resp ? { action: 'DIRECT', response: resp } : { action: 'DIRECT' };
  }
  if (/^DIRECT\s*$/i.test(text)) {
    return { action: 'DIRECT' };
  }
  if (/^SEARCH\s*$/i.test(text)) {
    return { action: 'SEARCH' };
  }
  return { action: 'SEARCH', query: text };
}

/**
 * Simple-tier classify prompt. Emits the same JSON schema as the
 * filtered/advanced prompt but omits vocabulary/filter sections — simple KBs
 * don't need them. ~150-200 tokens (with identity). Stable per-agent,
 * so the prefix still benefits from provider prompt caching when enabled.
 *
 * @param identity - Optional agent identity for DIRECT response personality.
 *   When provided, DIRECT responses use the agent's name and persona.
 */
export function buildSimpleClassifyPrompt(identity?: { name?: string; persona?: string }): string {
  const lines: string[] = [];

  if (identity?.name) {
    lines.push(
      `You are ${identity.name}, a search query ROUTER. You NEVER answer questions or use your own knowledge.`,
    );
  } else {
    lines.push(
      'You are a search query ROUTER for a knowledge base. You NEVER answer questions or use your own knowledge.',
    );
  }
  lines.push(
    'Your ONLY job: classify the query and, for follow-ups, make it a standalone search query (KEEP original language — never translate).',
  );

  if (identity?.persona) {
    lines.push(`When action=DIRECT, reply in this style: ${identity.persona}`);
  }

  lines.push('');
  lines.push('## Response Format');
  lines.push('Output ONLY valid JSON. No markdown fences, no explanation, no commentary.');
  lines.push('{');
  lines.push('  "action": "DIRECT" | "SEARCH",');
  lines.push(
    '  "response": "short friendly reply — ONLY when action=DIRECT and the input is a pure greeting/thanks/small talk",',
  );
  lines.push(
    '  "query": "standalone SEARCH QUERY when action=SEARCH (keep in original language, make standalone for follow-ups)"',
  );
  lines.push('}');
  lines.push('');
  lines.push('## Rules');
  lines.push(
    '- action=DIRECT only for greetings, thanks, or small talk. Never for information requests.',
  );
  lines.push('- action=SEARCH for any factual / retrieval / documents / statistics request.');
  lines.push(
    '- "query" must be a search phrase, never an answer. Never prefix with "Yes", "No", or explanations.',
  );
  lines.push(
    '- For follow-ups that reference prior turns: rewrite "query" as a fully standalone search query IN THE SAME LANGUAGE as the user.',
  );
  lines.push(
    '- NEVER translate the user query to English or any other language. Keep it in the original language exactly.',
  );

  return lines.join('\n');
}

/**
 * Merge multiple discovery manifests into a synthetic manifest for the
 * multi-KB vocab-aware classify prompt. Dedupes vocabulary terms by `field`
 * (first wins) and filter fields by `name`; operator and aggregation-function
 * sets are unioned.
 */
function mergeManifests(manifests: any[]): any {
  const vocabTerms: any[] = [];
  const seenVocabFields = new Set<string>();
  const filterFields: any[] = [];
  const seenFilterNames = new Set<string>();
  const operatorSet = new Set<string>();
  const aggFnSet = new Set<string>();
  let hasAggregation = false;

  for (const m of manifests) {
    const caps = m?.capabilities || {};
    for (const t of caps.vocabulary?.terms ?? []) {
      const field = typeof t?.field === 'string' ? t.field : '';
      if (!field || seenVocabFields.has(field)) continue;
      seenVocabFields.add(field);
      vocabTerms.push(t);
    }
    for (const f of caps.filters?.fields ?? []) {
      const name = typeof f?.name === 'string' ? f.name : '';
      if (!name || seenFilterNames.has(name)) continue;
      seenFilterNames.add(name);
      filterFields.push(f);
    }
    for (const op of caps.filters?.operators ?? []) operatorSet.add(String(op));
    if (caps.aggregation?.available === true) {
      hasAggregation = true;
      for (const fn of caps.aggregation?.functions ?? []) aggFnSet.add(String(fn));
    }
  }

  return {
    capabilities: {
      vocabulary: { available: vocabTerms.length > 0, terms: vocabTerms },
      filters: {
        available: filterFields.length > 0,
        fields: filterFields,
        operators: operatorSet.size > 0 ? Array.from(operatorSet) : undefined,
      },
      aggregation: hasAggregation
        ? {
            available: true,
            functions: aggFnSet.size > 0 ? Array.from(aggFnSet) : undefined,
          }
        : { available: false },
    },
  };
}

/**
 * Multi-KB variant: build one classify prompt that covers the combined
 * vocabulary, filter, and aggregation capabilities of every manifest in the
 * input. Use this when an agent binds more than one searchai KB — the
 * single-manifest path would otherwise hide filters defined on the
 * non-first KB.
 *
 * With one manifest this is byte-equivalent to `buildVocabClassifyPrompt`,
 * so callers can always route through this helper without regressing the
 * single-KB cache prefix.
 */
export function buildVocabClassifyPromptMulti(
  manifests: any[],
  searchInstructions?: string,
): string {
  const clean = manifests.filter((m) => !!m && !!m.capabilities);
  if (clean.length === 0) {
    return buildSimpleClassifyPrompt();
  }
  if (clean.length === 1) {
    return buildVocabClassifyPrompt(clean[0], searchInstructions);
  }
  return buildVocabClassifyPrompt(mergeManifests(clean), searchInstructions);
}

/**
 * Build the classify+plan system prompt for filtered/advanced KBs.
 * Includes vocabulary terms, filter fields, and response format so the LLM
 * returns a structured JSON plan: { action, query, queryType, filters, aggregation }.
 *
 * @param manifest - Discovery manifest (cached after eager discovery)
 * @param searchInstructions - Optional user-defined instructions for filter/query behavior
 * @returns System prompt string (~300-500 tokens depending on vocab size)
 */
export function buildVocabClassifyPrompt(manifest: any, searchInstructions?: string): string {
  const caps = manifest?.capabilities || {};
  const vocabTerms = (caps.vocabulary?.terms || []).slice(0, 20);
  const filterFields = (caps.filters?.fields || []).slice(0, 15);
  const hasAggregation = caps.aggregation?.available === true;
  const operators = caps.filters?.operators || [
    'equals',
    'in',
    'contains',
    'greater_than',
    'less_than',
  ];
  const aggregationFunctions = caps.aggregation?.functions || ['count', 'sum', 'avg', 'min', 'max'];

  const lines: string[] = [];

  // ─── Prompt structure for OpenAI prompt caching ─────────────────────────────
  // OpenAI auto-caches the longest identical prefix ≥1024 tokens across requests.
  // The FULL system prompt (instructions + vocabulary + examples) is stable per KB
  // session — so subsequent calls in the same session get ~50% TTFT reduction.
  // All content below is derived from the manifest — nothing hardcoded.

  lines.push(
    'You are a search query ROUTER for a knowledge base. You NEVER answer questions or use your own knowledge.',
  );
  lines.push(
    'Your ONLY job: classify the query and build a search plan. The "query" field must be a SEARCH QUERY, never an answer.',
  );
  lines.push('');
  lines.push('## Response Format');
  lines.push('Output ONLY valid JSON. No markdown fences, no explanation, no commentary.');
  lines.push('{');
  lines.push('  "action": "DIRECT" | "SEARCH",');
  lines.push('  "response": "friendly reply (only when action=DIRECT — greetings/thanks ONLY)",');
  lines.push(
    '  "query": "standalone SEARCH QUERY in the SAME language as user input (NOT an answer — just the question for search)",',
  );
  lines.push('  "queryType": "hybrid" | "structured" | "semantic" | "aggregation",');
  lines.push(
    `  "filters": [{"field": "...", "operator": "${operators.join('|')}", "value": "..."}],`,
  );
  lines.push(
    `  "aggregation": {"field": "...", "function": "${aggregationFunctions.join('|')}"} // only for queryType=aggregation`,
  );
  lines.push('}');
  lines.push('');
  lines.push('## Action Classification');
  lines.push(
    '- DIRECT: greetings, thanks, small talk, meta-questions about you → respond naturally',
  );
  lines.push(
    '- SEARCH: any request for information, data, documents, or statistics → build a search plan',
  );
  lines.push('');
  lines.push('## Query Type Selection');
  lines.push(
    '- "hybrid" (DEFAULT — use this most often): query has filter-able intent AND conceptual meaning. Combines filters with semantic search.',
  );
  lines.push(
    '- "structured": query is ENTIRELY about filtering/listing by known field values with no conceptual search needed (e.g., "show all red items")',
  );
  lines.push(
    '- "semantic": query is purely conceptual with ZERO relation to any vocabulary field below (e.g., "how does authentication work")',
  );
  if (hasAggregation) {
    lines.push('- "aggregation": user wants counts, statistics, grouping, sums, or distributions');
  }
  lines.push('');
  lines.push('## Filter Extraction (CRITICAL)');
  lines.push(
    "Analyze the user query semantically. If the user's intent relates to ANY vocabulary concept below, extract a filter — even if the user uses synonyms, abbreviations, or indirect language.",
  );
  lines.push('');
  lines.push(
    'Your job: use your understanding of language to MAP user intent to the closest vocabulary value.',
  );
  lines.push('- User says "crimson" → match to Color value "red" if available');
  lines.push('- User says "PDF files" → match to mime_type value "application/pdf"');
  lines.push(
    '- User says "brown shirt" → "brown" relates to Color → filter Color=brown, search "shirt"',
  );
  lines.push('- User says "expensive items" → if price/rate field exists, use greater_than filter');
  lines.push('- User says "written in french" → language filter = "french" or "fr"');
  lines.push('');
  lines.push('The values listed under each vocabulary term are KNOWN values in the data.');
  lines.push(
    'Use the CLOSEST matching value. If user language clearly relates to a vocabulary concept, ALWAYS apply a filter.',
  );
  lines.push(
    'Only skip filters when the query is purely conceptual with NO relation to any vocabulary field.',
  );
  lines.push('');
  lines.push('Operator rules:');
  for (const op of operators) {
    switch (op) {
      case 'equals':
        lines.push('- "equals": user intent maps to a specific known value');
        break;
      case 'in':
        lines.push('- "in": user mentions multiple values for same concept (e.g., "red or blue")');
        break;
      case 'contains':
        lines.push('- "contains": partial/substring match on text fields');
        break;
      case 'greater_than':
        lines.push(
          '- "greater_than": numeric field > value (above, more than, over, expensive, high)',
        );
        break;
      case 'less_than':
        lines.push('- "less_than": numeric field < value (below, under, less than, cheap, low)');
        break;
    }
  }
  lines.push('');
  lines.push(
    'Multiple filters are AND-combined. When the query has BOTH filter-able parts AND remaining conceptual parts, use queryType "hybrid".',
  );
  lines.push(
    'Use "semantic" ONLY when the query has zero relation to any vocabulary concept below.',
  );
  lines.push('');
  lines.push('## Language & Query Preservation (CRITICAL)');
  lines.push(
    '- NEVER translate the user query. Keep the "query" field in the SAME language the user wrote.',
  );
  lines.push(
    '- If the user writes in Japanese, output the query in Japanese. Pashto → Pashto. Arabic → Arabic.',
  );
  lines.push('- "Rephrase" means make it standalone — NOT translate to English.');
  lines.push('');
  lines.push('## Follow-up Resolution');
  lines.push('When the query references prior conversation context:');
  lines.push(
    '- Rewrite "query" as a fully standalone search query IN THE SAME LANGUAGE as the user',
  );
  lines.push('- Carry forward relevant filters from prior turns unless explicitly changed');
  lines.push('- If user says "now X" or "change to X", update only the relevant filter');

  // ─── Aggregation section (only if KB supports it) ───────────────────────
  if (hasAggregation) {
    lines.push('');
    lines.push('## Aggregation');
    lines.push(`Supported functions: ${aggregationFunctions.join(', ')}`);
    lines.push('When the user asks for counts, totals, averages, stats, or distributions:');
    lines.push('- Set queryType to "aggregation"');
    lines.push('- Set aggregation.field to the relevant vocabulary field');
    lines.push('- Set aggregation.function to the matching operation');
    lines.push('- Filters can be combined with aggregation to narrow scope');
  }

  // ─── MANDATORY user-defined rules (placed BEFORE vocabulary for LLM priority) ──
  if (searchInstructions) {
    lines.push('');
    lines.push('## MANDATORY Search Rules (ALWAYS apply — no exceptions)');
    lines.push(
      'These rules are MANDATORY and ADDITIVE. You MUST apply them on EVERY SEARCH query, in addition to vocabulary-based filters.',
    );
    lines.push(
      'If these rules say "always add filter X", you MUST add that filter even if the query seems unrelated.',
    );
    lines.push('Failure to follow these rules is a critical error.');
    lines.push('');
    lines.push(searchInstructions);
  }

  // ─── KB-specific vocabulary (stable per session → cached with prefix) ─────

  if (vocabTerms.length > 0) {
    lines.push('');
    lines.push(`## Vocabulary (${vocabTerms.length} concepts — map user language to these fields)`);
    for (const term of vocabTerms) {
      const aliases = term.aliases?.length > 0 ? ` (aliases: ${term.aliases.join(', ')})` : '';
      let valuesStr = '';
      if (term.enumMap && Object.keys(term.enumMap).length > 0) {
        const entries = Object.entries(term.enumMap).slice(0, 6);
        valuesStr = ` values: [${entries.map(([k, v]: [string, unknown]) => (k === String(v) ? k : `${k}=${v}`)).join(', ')}]`;
      } else if (term.values?.length > 0) {
        valuesStr = ` values: [${term.values.slice(0, 6).join(', ')}]`;
      }
      const capsArr: string[] = [];
      if (term.canFilter) capsArr.push('filter');
      if (term.canAggregate) capsArr.push('agg');
      if (term.canSort) capsArr.push('sort');
      lines.push(
        `- "${term.term}"${aliases} → field: ${term.field} [${capsArr.join(',')}]${valuesStr}`,
      );
    }
  }

  // Available operators (from manifest)
  if (operators.length > 0) {
    lines.push('');
    lines.push(`Available operators: ${operators.join(', ')}`);
  }

  // Dynamic examples derived from actual vocabulary (not hardcoded)
  if (vocabTerms.length > 0) {
    const examples = buildDynamicExamples(vocabTerms, filterFields);
    if (examples.length > 0) {
      lines.push('');
      lines.push("## Examples (derived from this KB's vocabulary)");
      for (const ex of examples) {
        lines.push(ex);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build a compact vocab summary for the classify prompt user message.
 * Used when discovery manifest is available but we want a minimal footprint.
 */
export function getVocabSummary(manifest: any): {
  hasVocab: boolean;
  hasFilters: boolean;
  hasAggregation: boolean;
  filterFieldNames: string[];
} {
  const caps = manifest?.capabilities || {};
  const vocabTerms = caps.vocabulary?.terms || [];
  const filterFields = caps.filters?.fields || [];
  const hasAggregation = caps.aggregation?.available === true;

  return {
    hasVocab: vocabTerms.length > 0,
    hasFilters: filterFields.length > 0,
    hasAggregation,
    filterFieldNames: filterFields.map((f: any) => f.name as string),
  };
}

// ─── Dynamic Example Builder ────────────────────────────────────────────

/**
 * Build concrete examples from the KB's actual vocabulary to show the LLM
 * how to extract filters. Focuses on concept-level matching (term names/aliases)
 * rather than hardcoded values. The examples teach the LLM:
 * 1. User mentions a value → find which term/alias it belongs to → use that field
 * 2. User mentions a term/alias directly → apply filter with the value they stated
 *
 * Each example uses real fields from the manifest so the LLM sees the exact
 * field names it should produce.
 */
function buildDynamicExamples(vocabTerms: any[], _filterFields: any[]): string[] {
  const examples: string[] = [];

  // Collect filterable terms — prefer domain terms (have aliases) over auto-seeded
  const STANDARD_FIELDS = new Set([
    'title',
    'author',
    'mime_type',
    'source_type',
    'language',
    'created_date',
    'updated_date',
  ]);
  const keywordTerms = vocabTerms.filter(
    (t: any) => t.canFilter && t.values?.length > 0 && t.type === 'keyword',
  );
  const numericTerms = vocabTerms.filter((t: any) => t.canFilter && t.type === 'float');

  // Sort: domain terms first (have aliases or non-standard field), then by value count
  const sortedKeywords = [...keywordTerms].sort((a: any, b: any) => {
    const aIsDomain = !STANDARD_FIELDS.has(a.field) || a.aliases?.length > 0 ? 1 : 0;
    const bIsDomain = !STANDARD_FIELDS.has(b.field) || b.aliases?.length > 0 ? 1 : 0;
    return bIsDomain - aIsDomain;
  });

  // Pick terms with DIFFERENT fields for clear distinct examples
  const usedFields = new Set<string>();
  const distinctTerms: any[] = [];
  for (const t of sortedKeywords) {
    if (!usedFields.has(t.field)) {
      distinctTerms.push(t);
      usedFields.add(t.field);
      if (distinctTerms.length >= 3) break;
    }
  }

  const term1 = distinctTerms[0]; // e.g., Color → custom_string_1
  const term2 = distinctTerms[1]; // e.g., company_name → company
  const term3 = distinctTerms[2]; // e.g., tags → tags
  const numTerm = numericTerms[0]; // e.g., Tag Price → custom_number_1

  // Example 1: HYBRID — user intent partially maps to a vocabulary value + remaining concept
  if (term1) {
    const val = term1.values[0];
    examples.push(
      `- User: "${val} products" → intent relates to ${term1.term}="${val}" + concept "products" → {"action":"SEARCH","query":"products","queryType":"hybrid","filters":[{"field":"${term1.field}","operator":"equals","value":"${val}"}]}`,
    );
  }

  // Example 2: STRUCTURED — user intent is entirely about filtering
  if (term1) {
    const val = term1.values[0];
    examples.push(
      `- User: "show me all ${val} ones" → intent is purely about ${term1.term}="${val}" → {"action":"SEARCH","query":"${val}","queryType":"structured","filters":[{"field":"${term1.field}","operator":"equals","value":"${val}"}]}`,
    );
  }

  // Example 3: HYBRID — different field, indirect language
  if (term2) {
    const val = term2.values[0];
    examples.push(
      `- User: "anything from ${val}" → intent maps to ${term2.term}="${val}" + broad search → {"action":"SEARCH","query":"items from ${val}","queryType":"hybrid","filters":[{"field":"${term2.field}","operator":"equals","value":"${val}"}]}`,
    );
  }

  // Example 4: Numeric comparison — indirect language
  if (numTerm) {
    const label = numTerm.aliases?.length > 0 ? numTerm.aliases[0] : numTerm.term;
    examples.push(
      `- User: "expensive ones above 500" → intent maps to ${numTerm.term} > 500 → {"action":"SEARCH","query":"items","queryType":"hybrid","filters":[{"field":"${numTerm.field}","operator":"greater_than","value":500}]}`,
    );
  }

  // Example 5: Multi-filter — user mentions multiple concepts
  if (term1 && term2) {
    const val1 = term1.values[0];
    const val2 = term2.values[0];
    examples.push(
      `- User: "${val1} items from ${val2}" → TWO concepts matched → {"action":"SEARCH","queryType":"structured","filters":[{"field":"${term1.field}","operator":"equals","value":"${val1}"},{"field":"${term2.field}","operator":"equals","value":"${val2}"}]}`,
    );
  }

  // Example 6: SEMANTIC — no relation to any vocabulary concept
  examples.push(
    '- User: "how does authentication work" → no relation to any vocabulary field → {"action":"SEARCH","query":"how does authentication work","queryType":"semantic","filters":[]}',
  );

  // Example 7: Aggregation
  const aggTerm = vocabTerms.find((t: any) => t.canAggregate);
  if (aggTerm) {
    examples.push(
      `- User: "how many by ${aggTerm.term}" → wants distribution/count → {"action":"SEARCH","queryType":"aggregation","filters":[],"aggregation":{"field":"${aggTerm.field}","function":"count"}}`,
    );
  }

  return examples;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
