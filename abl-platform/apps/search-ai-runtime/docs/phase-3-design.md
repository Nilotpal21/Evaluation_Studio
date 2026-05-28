# RFC-003 Phase 3: Query Preprocessing & Adaptive Pipeline Design

**Status:** Design Phase
**Created:** 2025-02-23
**Dependencies:** Phase 2 Complete ✅
**Estimated Duration:** 19.5 days (4 sprints)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Component 1: Query Preprocessing](#component-1-query-preprocessing)
4. [Component 2: Adaptive Pipeline](#component-2-adaptive-pipeline)
5. [Integration Points](#integration-points)
6. [Performance Targets](#performance-targets)
7. [Cost Optimization](#cost-optimization)
8. [Implementation Plan](#implementation-plan)
9. [Testing Strategy](#testing-strategy)
10. [Deployment Strategy](#deployment-strategy)

---

## Executive Summary

Phase 3 adds two major capabilities to the query pipeline:

### 1. Query Preprocessing Layer

Enhances queries before search execution through:

- **Spell Correction**: Fix typos automatically (e.g., "kuberntes" → "kubernetes")
- **Synonym Expansion**: Add related terms (e.g., "k8s" → "kubernetes")
- **Entity Extraction**: Identify structured data (dates, numbers, IDs) and convert to filters

**Value:** Improves recall by 10-15% through query enrichment

### 2. Adaptive Pipeline Selection

Dynamically selects which pipeline stages to execute based on:

- Query complexity (simple keyword vs. complex semantic)
- Cost constraints (budget-aware execution)
- Latency requirements (fast vs. accurate profiles)

**Value:** Reduces cost by 30-40% by skipping unnecessary stages (e.g., reranking for simple queries)

---

## Architecture Overview

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Query Pipeline (Phase 3)                    │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ↓
┌─────────────────────────────────────────────────────────────────┐
│  1. Query Analysis & Adaptive Selection (< 10ms)                │
│     ┌─────────────────────────────────────────────────┐         │
│     │ QueryComplexityAnalyzer                         │         │
│     │  - Lexical complexity (word count, diversity)   │         │
│     │  - Structural complexity (entities, filters)    │         │
│     │  - Semantic complexity (abstract vs concrete)   │         │
│     │  → ComplexityProfile (score 0-100)              │         │
│     └─────────────────────────────────────────────────┘         │
│                            ↓                                     │
│     ┌─────────────────────────────────────────────────┐         │
│     │ AdaptivePipelineSelector                        │         │
│     │  - Input: ComplexityProfile + Config            │         │
│     │  - Decision: Which stages to enable?            │         │
│     │  → PipelineConfig (stages + budgets)            │         │
│     └─────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. Query Preprocessing (< 50ms total)                          │
│     ┌────────────────────────────────────────┐                  │
│     │ SpellCorrectionStage (< 10ms)          │                  │
│     │  - Detect typos using edit distance    │                  │
│     │  - Use dictionary (base + custom)      │                  │
│     │  - Output: corrected query + metadata  │                  │
│     └────────────────────────────────────────┘                  │
│                            ↓                                     │
│     ┌────────────────────────────────────────┐                  │
│     │ SynonymExpansionStage (< 15ms)         │                  │
│     │  - Expand with WordNet + custom dict   │                  │
│     │  - Domain-specific synonyms            │                  │
│     │  - Output: expanded query terms        │                  │
│     └────────────────────────────────────────┘                  │
│                            ↓                                     │
│     ┌────────────────────────────────────────┐                  │
│     │ EntityExtractionStage (< 20ms)         │                  │
│     │  - Extract: dates, numbers, IDs, etc.  │                  │
│     │  - Convert to structured filters       │                  │
│     │  - Output: entities + filter hints     │                  │
│     └────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. Existing Pipeline (Phase 1 & 2)                             │
│     - Vocabulary Resolution                                      │
│     - Embedding Generation                                       │
│     - Vector Search (+ optional BM25)                            │
│     - Hybrid Fusion (if selected)                                │
│     - Reranking (if complexity warrants)                         │
└─────────────────────────────────────────────────────────────────┘
```

### Pipeline Profiles

The adaptive selector chooses one of three profiles:

| Profile      | Latency Target | When to Use              | Stages Enabled                       | Cost |
| ------------ | -------------- | ------------------------ | ------------------------------------ | ---- |
| **Fast**     | < 150ms        | Simple keyword queries   | Vector search only, skip reranking   | Low  |
| **Balanced** | < 300ms        | Most queries (default)   | Hybrid search, conditional reranking | Med  |
| **Accurate** | < 600ms        | Complex semantic queries | Full preprocessing + always rerank   | High |

---

## Component 1: Query Preprocessing

### 1.1 Architecture

```typescript
/**
 * Query Preprocessor orchestrates preprocessing stages.
 */
export class QueryPreprocessor {
  private stages: PreprocessorStage[];
  private logger: StructuredLogger;

  constructor(config: PreprocessorConfig) {
    // Initialize stages based on config
    this.stages = this.initializeStages(config);
  }

  /**
   * Run preprocessing pipeline on query.
   * Returns enriched query + metadata.
   */
  async preprocess(query: string, config: StageSelectionConfig): Promise<PreprocessedQuery> {
    const startTime = Date.now();
    const results: StageResult[] = [];

    let currentQuery = query;
    const metadata: PreprocessingMetadata = {
      originalQuery: query,
      stages: [],
    };

    // Run enabled stages in sequence
    for (const stage of this.stages) {
      if (!config.enabledStages.has(stage.name)) {
        continue; // Skip disabled stages
      }

      const stageStart = Date.now();
      const result = await stage.process(currentQuery, metadata);
      const stageDuration = Date.now() - stageStart;

      results.push({
        stage: stage.name,
        durationMs: stageDuration,
        changes: result.changes,
      });

      // Update query with stage output
      currentQuery = result.query;
      metadata.stages.push(result.metadata);
    }

    return {
      originalQuery: query,
      processedQuery: currentQuery,
      metadata: {
        ...metadata,
        totalDurationMs: Date.now() - startTime,
        stageResults: results,
      },
    };
  }
}

/**
 * Base interface for preprocessing stages.
 */
export interface PreprocessorStage {
  name: string;
  process(query: string, context: PreprocessingMetadata): Promise<StageOutput>;
}

export interface StageOutput {
  query: string; // Modified query
  changes: string[]; // List of changes made
  metadata: StageMetadata; // Stage-specific metadata
}
```

### 1.2 Spell Correction Stage

**Approach:** Use SymSpell algorithm (fast, sub-linear lookup)

```typescript
/**
 * Spell correction using SymSpell with custom dictionaries.
 */
export class SpellCorrectionStage implements PreprocessorStage {
  name = 'spell_correction';
  private symSpell: SymSpell;
  private customDictionary: Map<string, string>; // tenant-specific

  constructor(config: SpellCorrectionConfig) {
    this.symSpell = new SymSpell({
      maxEditDistance: 2, // Allow up to 2 character edits
      prefixLength: 7,
    });

    // Load base dictionary (English + technical terms)
    this.loadBaseDictionary();

    // Load custom dictionary (tenant-specific terms)
    this.customDictionary = config.customDictionary || new Map();
  }

  async process(query: string, context: PreprocessingMetadata): Promise<StageOutput> {
    const words = this.tokenize(query);
    const corrections: Array<{ original: string; corrected: string }> = [];

    for (const word of words) {
      // Skip if proper noun or entity (from previous stages)
      if (this.isProperNoun(word, context)) continue;

      // Check custom dictionary first (exact match)
      if (this.customDictionary.has(word.toLowerCase())) {
        const corrected = this.customDictionary.get(word.toLowerCase())!;
        if (corrected !== word) {
          corrections.push({ original: word, corrected });
        }
        continue;
      }

      // Use SymSpell for suggestions
      const suggestions = this.symSpell.lookup(word, {
        maxEditDistance: 2,
        includeUnknown: false,
      });

      if (suggestions.length > 0 && suggestions[0].distance > 0) {
        corrections.push({
          original: word,
          corrected: suggestions[0].term,
        });
      }
    }

    // Apply corrections
    let correctedQuery = query;
    for (const { original, corrected } of corrections) {
      correctedQuery = correctedQuery.replace(new RegExp(`\\b${original}\\b`, 'gi'), corrected);
    }

    return {
      query: correctedQuery,
      changes: corrections.map((c) => `${c.original} → ${c.corrected}`),
      metadata: {
        corrections: corrections.length,
        confidence: this.computeConfidence(corrections),
      },
    };
  }

  private tokenize(query: string): string[] {
    return query.split(/\s+/).filter((word) => word.length > 0);
  }

  private isProperNoun(word: string, context: PreprocessingMetadata): boolean {
    // Check if word is marked as entity from previous extraction
    return context.entities?.some((e) => e.text === word) || false;
  }

  private computeConfidence(corrections: Array<{ original: string; corrected: string }>): number {
    // Higher confidence if fewer corrections needed
    return corrections.length === 0 ? 1.0 : 0.9 / corrections.length;
  }
}
```

**Dictionary Management:**

```typescript
// Base dictionary: ~50K English words + 10K technical terms
const baseDictionary = [
  'kubernetes',
  'docker',
  'microservices',
  'deployment',
  // ... technical vocabulary
];

// Tenant-specific dictionary (managed via API)
interface CustomDictionary {
  tenantId: string;
  terms: Map<string, string>; // misspelling → correct term
}
```

**Performance:** SymSpell lookup is O(1) average case → ~0.1ms per word → 10ms for 100-word query

### 1.3 Synonym Expansion Stage

**Approach:** WordNet + custom synonym dictionaries

```typescript
/**
 * Synonym expansion using WordNet and domain-specific synonyms.
 */
export class SynonymExpansionStage implements PreprocessorStage {
  name = 'synonym_expansion';
  private wordNet: WordNetService;
  private customSynonyms: Map<string, string[]>; // tenant-specific

  constructor(config: SynonymExpansionConfig) {
    this.wordNet = new WordNetService();
    this.customSynonyms = config.customSynonyms || new Map();
  }

  async process(query: string, context: PreprocessingMetadata): Promise<StageOutput> {
    const words = this.tokenize(query);
    const expansions: Map<string, string[]> = new Map();

    for (const word of words) {
      // Custom synonyms take precedence
      if (this.customSynonyms.has(word.toLowerCase())) {
        expansions.set(word, this.customSynonyms.get(word.toLowerCase())!);
        continue;
      }

      // WordNet lookup
      const synsets = await this.wordNet.getSynonyms(word);
      if (synsets.length > 0) {
        // Take top 3 most relevant synonyms
        expansions.set(word, synsets.slice(0, 3));
      }
    }

    // Build expanded query
    const expandedTerms: string[] = [];
    for (const [term, synonyms] of expansions) {
      expandedTerms.push(`(${term} OR ${synonyms.join(' OR ')})`);
    }

    const expandedQuery = expandedTerms.length > 0 ? `${query} ${expandedTerms.join(' ')}` : query;

    return {
      query: expandedQuery,
      changes: Array.from(expansions.entries()).map(
        ([term, syns]) => `${term} → [${syns.join(', ')}]`,
      ),
      metadata: {
        expansions: expansions.size,
        addedTerms: Array.from(expansions.values()).flat().length,
      },
    };
  }

  private tokenize(query: string): string[] {
    return query.split(/\s+/).filter((word) => word.length > 2);
  }
}
```

**Custom Synonym Examples:**

```typescript
// Technical abbreviations
const technicalSynonyms = {
  k8s: ['kubernetes', 'k8s'],
  ml: ['machine learning', 'ML', 'artificial intelligence'],
  api: ['API', 'application programming interface', 'REST API'],
  db: ['database', 'DB', 'data store'],
};

// Domain-specific (e-commerce example)
const domainSynonyms = {
  buy: ['purchase', 'order', 'checkout'],
  cheap: ['affordable', 'budget', 'discount', 'sale'],
};
```

**Performance:** WordNet lookup with caching → ~1-2ms per word → 15ms for typical query

### 1.4 Entity Extraction Stage

**Approach:** Regex patterns + lightweight NLP

```typescript
/**
 * Entity extraction using pattern matching and NLP.
 */
export class EntityExtractionStage implements PreprocessorStage {
  name = 'entity_extraction';
  private patterns: EntityPatternSet;

  constructor(config: EntityExtractionConfig) {
    this.patterns = this.initializePatterns(config);
  }

  async process(query: string, context: PreprocessingMetadata): Promise<StageOutput> {
    const entities: ExtractedEntity[] = [];

    // Extract temporal entities
    entities.push(...this.extractDates(query));
    entities.push(...this.extractDateRanges(query));

    // Extract numeric entities
    entities.push(...this.extractNumbers(query));
    entities.push(...this.extractRanges(query));

    // Extract identifiers
    entities.push(...this.extractEmails(query));
    entities.push(...this.extractUrls(query));
    entities.push(...this.extractIds(query));

    // Extract domain-specific entities (if configured)
    entities.push(...this.extractCustomEntities(query, context));

    // Convert entities to filters
    const filters = this.entitiesToFilters(entities);

    return {
      query: query, // Original query preserved
      changes: entities.map((e) => `Extracted ${e.type}: ${e.value}`),
      metadata: {
        entities,
        filters,
        entityCount: entities.length,
      },
    };
  }

  private extractDates(query: string): ExtractedEntity[] {
    const patterns = [
      // ISO format: 2024-01-15
      /\b\d{4}-\d{2}-\d{2}\b/g,
      // US format: 01/15/2024
      /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
      // Relative: "last week", "Q1 2024"
      /\b(last|this|next)\s+(week|month|quarter|year)\b/gi,
      /\bQ[1-4]\s+\d{4}\b/g,
    ];

    const entities: ExtractedEntity[] = [];
    for (const pattern of patterns) {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        entities.push({
          type: 'date',
          value: match[0],
          position: match.index!,
          normalized: this.normalizeDate(match[0]),
        });
      }
    }
    return entities;
  }

  private extractNumbers(query: string): ExtractedEntity[] {
    const patterns = [
      // Numbers with units: "100K", "2.5M"
      /\b\d+(?:\.\d+)?[KMB]\b/gi,
      // Plain numbers with > < =
      /[><]=?\s*\d+(?:\.\d+)?/g,
      // Currency: "$100", "€50"
      /[$€£¥]\d+(?:\.\d+)?(?:[KMB])?/gi,
    ];

    const entities: ExtractedEntity[] = [];
    for (const pattern of patterns) {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        entities.push({
          type: 'number',
          value: match[0],
          position: match.index!,
          normalized: this.normalizeNumber(match[0]),
        });
      }
    }
    return entities;
  }

  private entitiesToFilters(entities: ExtractedEntity[]): StructuredFilter[] {
    const filters: StructuredFilter[] = [];

    for (const entity of entities) {
      switch (entity.type) {
        case 'date':
          filters.push({
            field: 'timestamp',
            operator: 'range',
            value: entity.normalized,
          });
          break;
        case 'number':
          if (entity.value.includes('>')) {
            filters.push({
              field: 'value',
              operator: 'gt',
              value: entity.normalized,
            });
          } else if (entity.value.includes('<')) {
            filters.push({
              field: 'value',
              operator: 'lt',
              value: entity.normalized,
            });
          }
          break;
        case 'email':
          filters.push({
            field: 'email',
            operator: 'match',
            value: entity.value,
          });
          break;
        // ... more conversions
      }
    }

    return filters;
  }

  private normalizeDate(dateStr: string): DateRange {
    // Convert "Q1 2024" → { start: "2024-01-01", end: "2024-03-31" }
    // Convert "last week" → { start: "2024-02-15", end: "2024-02-22" }
    // ... normalization logic
    return { start: '', end: '' };
  }

  private normalizeNumber(numStr: string): number {
    // Convert "100K" → 100000, "$2.5M" → 2500000
    const multipliers: Record<string, number> = { K: 1000, M: 1_000_000, B: 1_000_000_000 };
    // ... normalization logic
    return 0;
  }
}
```

**Entity Types Supported:**

| Type     | Examples                             | Converted To Filter?  |
| -------- | ------------------------------------ | --------------------- |
| Date     | "2024-01-15", "Q1 2024", "last week" | ✅ `timestamp` range  |
| Number   | "> 100", "$50K", "2.5M"              | ✅ `value` comparison |
| Email    | "user@example.com"                   | ✅ `email` match      |
| URL      | "https://example.com"                | ✅ `url` match        |
| ID       | "CUST-12345", "ORD-98765"            | ✅ Custom field match |
| Location | "San Francisco", "CA"                | ✅ `location` match   |
| Currency | "$100", "€50"                        | ✅ `price` range      |

**Performance:** Regex matching with compiled patterns → ~20ms for typical query

---

## Component 2: Adaptive Pipeline

### 2.1 Query Complexity Analysis

```typescript
/**
 * Analyzes query complexity across multiple dimensions.
 */
export class QueryComplexityAnalyzer {
  analyze(query: string): ComplexityProfile {
    return {
      overall: this.computeOverallScore(query),
      lexical: this.analyzeLexicalComplexity(query),
      structural: this.analyzeStructuralComplexity(query),
      semantic: this.analyzeSemanticComplexity(query),
      contextual: this.analyzeContextualComplexity(query),
    };
  }

  /**
   * Lexical complexity: word count, vocabulary diversity, term length
   */
  private analyzeLexicalComplexity(query: string): number {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));

    // Factors:
    const wordCount = words.length;
    const diversity = uniqueWords.size / words.length;
    const avgLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;

    // Scoring (0-10):
    let score = 0;
    score += Math.min(wordCount / 10, 5); // Max 5 points for word count
    score += diversity * 3; // Max 3 points for diversity
    score += Math.min(avgLength / 8, 2); // Max 2 points for avg length

    return Math.min(score, 10);
  }

  /**
   * Structural complexity: entities, filters, operators
   */
  private analyzeStructuralComplexity(query: string): number {
    let score = 0;

    // Count entities
    const dateMatches = query.match(/\d{4}-\d{2}-\d{2}/g) || [];
    const numberMatches = query.match(/[><]=?\s*\d+/g) || [];
    const emailMatches = query.match(/\S+@\S+\.\S+/g) || [];

    score += Math.min((dateMatches.length + numberMatches.length + emailMatches.length) * 2, 5);

    // Logical operators
    const andMatches = query.match(/\bAND\b/gi) || [];
    const orMatches = query.match(/\bOR\b/gi) || [];
    const notMatches = query.match(/\bNOT\b/gi) || [];

    score += Math.min(andMatches.length + orMatches.length + notMatches.length, 3);

    // Quoted phrases
    const quotedMatches = query.match(/"[^"]+"/g) || [];
    score += Math.min(quotedMatches.length, 2);

    return Math.min(score, 10);
  }

  /**
   * Semantic complexity: abstract vs concrete, conceptual depth
   */
  private analyzeSemanticComplexity(query: string): number {
    // Use heuristics for MVP (can add NLP model later)
    let score = 0;

    // Check for abstract concepts
    const abstractTerms = [
      'concept',
      'theory',
      'approach',
      'methodology',
      'framework',
      'principle',
    ];
    const abstractCount = abstractTerms.filter((term) => query.toLowerCase().includes(term)).length;
    score += Math.min(abstractCount * 2, 5);

    // Check for technical depth
    const technicalTerms = [
      'algorithm',
      'architecture',
      'implementation',
      'optimization',
      'performance',
    ];
    const technicalCount = technicalTerms.filter((term) =>
      query.toLowerCase().includes(term),
    ).length;
    score += Math.min(technicalCount * 2, 5);

    return Math.min(score, 10);
  }

  /**
   * Contextual complexity: ambiguity, specificity
   */
  private analyzeContextualComplexity(query: string): number {
    let score = 0;

    // Ambiguous terms (pronouns, vague references)
    const ambiguousTerms = ['it', 'this', 'that', 'thing', 'stuff', 'something'];
    const ambiguityCount = ambiguousTerms.filter((term) =>
      query.toLowerCase().split(/\s+/).includes(term),
    ).length;
    score += Math.min(ambiguityCount * 2, 5);

    // Lack of specificity (very short queries)
    if (query.split(/\s+/).length < 3) {
      score += 3;
    }

    return Math.min(score, 10);
  }

  private computeOverallScore(query: string): number {
    const profile = {
      lexical: this.analyzeLexicalComplexity(query),
      structural: this.analyzeStructuralComplexity(query),
      semantic: this.analyzeSemanticComplexity(query),
      contextual: this.analyzeContextualComplexity(query),
    };

    // Weighted average (structural and semantic matter more)
    return (
      (profile.lexical * 0.2 +
        profile.structural * 0.3 +
        profile.semantic * 0.3 +
        profile.contextual * 0.2) *
      10
    ); // Scale to 0-100
  }
}
```

**Complexity Scoring Examples:**

| Query                                             | Lexical | Structural | Semantic | Contextual | Overall | Classification |
| ------------------------------------------------- | ------- | ---------- | -------- | ---------- | ------- | -------------- |
| "find docs"                                       | 2       | 0          | 1        | 5          | 18      | Simple         |
| "kubernetes pod scheduling"                       | 4       | 0          | 6        | 2          | 36      | Moderate       |
| "Show premium customers > 100K in Q1 2024"        | 6       | 8          | 3        | 1          | 52      | Complex        |
| "Compare optimization approaches for distributed" | 7       | 2          | 9        | 4          | 63      | Very Complex   |

### 2.2 Adaptive Pipeline Selector

```typescript
/**
 * Selects optimal pipeline configuration based on complexity and constraints.
 */
export class AdaptivePipelineSelector {
  private logger: StructuredLogger;

  constructor(private config: AdaptivePipelineConfig) {
    this.logger = new StructuredLogger({ component: 'AdaptivePipelineSelector' });
  }

  /**
   * Select pipeline configuration for a query.
   */
  select(
    query: string,
    complexity: ComplexityProfile,
    constraints: PipelineConstraints,
  ): PipelineDecision {
    const decision: PipelineDecision = {
      profile: this.selectProfile(complexity, constraints),
      preprocessing: this.selectPreprocessingStages(query, complexity),
      search: this.selectSearchMode(complexity),
      reranking: this.shouldEnableReranking(complexity, constraints),
      budgets: this.computeBudgets(complexity),
    };

    this.logger.debug('Pipeline decision', {
      complexity: complexity.overall,
      decision,
    });

    return decision;
  }

  /**
   * Select one of three profiles: fast, balanced, accurate
   */
  private selectProfile(
    complexity: ComplexityProfile,
    constraints: PipelineConstraints,
  ): PipelineProfile {
    // Cost-sensitive mode: prefer fast
    if (constraints.costSensitive && complexity.overall < 50) {
      return 'fast';
    }

    // Accuracy-critical mode: prefer accurate
    if (constraints.accuracyCritical) {
      return 'accurate';
    }

    // Latency-critical mode: prefer fast
    if (constraints.maxLatencyMs && constraints.maxLatencyMs < 200) {
      return 'fast';
    }

    // Default: complexity-based selection
    if (complexity.overall < 30) return 'fast';
    if (complexity.overall > 60) return 'accurate';
    return 'balanced';
  }

  /**
   * Decide which preprocessing stages to enable.
   */
  private selectPreprocessingStages(
    query: string,
    complexity: ComplexityProfile,
  ): PreprocessingConfig {
    return {
      enableSpellCorrection: this.detectTypos(query) || complexity.overall < 30, // Simple queries benefit
      enableSynonymExpansion: complexity.semantic > 5 || complexity.overall > 40, // Complex semantic queries
      enableEntityExtraction: complexity.structural > 4, // Queries with structured elements
    };
  }

  /**
   * Decide search mode: vector, keyword, or hybrid.
   */
  private selectSearchMode(complexity: ComplexityProfile): SearchMode {
    // Pure keyword queries (low semantic complexity)
    if (complexity.semantic < 3 && complexity.lexical < 4) {
      return 'keyword';
    }

    // Complex queries benefit from hybrid
    if (complexity.overall > 40) {
      return 'hybrid';
    }

    // Default: vector search
    return 'vector';
  }

  /**
   * Decide whether to enable reranking.
   */
  private shouldEnableReranking(
    complexity: ComplexityProfile,
    constraints: PipelineConstraints,
  ): boolean {
    // Always skip if cost-sensitive and simple query
    if (constraints.costSensitive && complexity.overall < 30) {
      return false;
    }

    // Always enable if accuracy-critical
    if (constraints.accuracyCritical) {
      return true;
    }

    // Enable for complex queries
    return complexity.overall > 50;
  }

  /**
   * Compute latency budgets for each stage.
   */
  private computeBudgets(complexity: ComplexityProfile): StageBudgets {
    // Allocate more time for complex queries
    const multiplier = complexity.overall / 50; // 0.6x for simple, 2.0x for very complex

    return {
      preprocessingMs: Math.round(50 * multiplier),
      vocabularyMs: Math.round(20 * multiplier),
      embeddingMs: Math.round(30 * multiplier),
      searchMs: Math.round(100 * multiplier),
      rerankingMs: Math.round(150 * multiplier),
      totalMs: Math.round(350 * multiplier),
    };
  }

  private detectTypos(query: string): boolean {
    // Simple heuristic: words not in dictionary
    const words = query.split(/\s+/);
    const suspiciousWords = words.filter((w) => !this.isValidWord(w));
    return suspiciousWords.length > 0;
  }

  private isValidWord(word: string): boolean {
    // Check against common word list (simple check for MVP)
    // In production, use Hunspell or similar
    return word.length > 1; // Placeholder
  }
}
```

**Decision Matrix:**

| Complexity Score | Cost Mode   | Profile Selected | Preprocessing  | Reranking |
| ---------------- | ----------- | ---------------- | -------------- | --------- |
| 0-30             | Sensitive   | Fast             | Spell only     | ❌ Skip   |
| 0-30             | Normal      | Balanced         | Spell + Entity | ❌ Skip   |
| 30-60            | Sensitive   | Fast             | Spell + Entity | ❌ Skip   |
| 30-60            | Normal      | Balanced         | All stages     | ✅ Enable |
| 60-100           | Sensitive   | Balanced         | All stages     | ✅ Enable |
| 60-100           | Normal/Crit | Accurate         | All stages     | ✅ Enable |

---

## Integration Points

### 3.1 QueryPipeline Integration

```typescript
/**
 * Updated QueryPipeline with Phase 3 integration
 */
export class QueryPipeline {
  private preprocessor: QueryPreprocessor;
  private complexityAnalyzer: QueryComplexityAnalyzer;
  private pipelineSelector: AdaptivePipelineSelector;

  async execute(
    query: VectorSearchQuery,
    tenantId: string,
    callerContext: CallerContext,
  ): Promise<SearchResponse> {
    const correlationId = queryMetricsStore.startQuery();
    const startTime = Date.now();

    try {
      // PHASE 3: Analyze query complexity
      const complexityProfile = this.complexityAnalyzer.analyze(query.query);

      // PHASE 3: Select pipeline configuration
      const pipelineDecision = this.pipelineSelector.select(
        query.query,
        complexityProfile,
        this.extractConstraints(query),
      );

      this.logger.info('Pipeline configuration selected', {
        correlationId,
        complexity: complexityProfile.overall,
        profile: pipelineDecision.profile,
      });

      // PHASE 3: Preprocess query (if stages enabled)
      let processedQuery = query.query;
      let preprocessingMetadata: PreprocessingMetadata | undefined;

      if (this.shouldPreprocess(pipelineDecision)) {
        const preprocessed = await this.preprocessor.preprocess(
          query.query,
          pipelineDecision.preprocessing,
        );
        processedQuery = preprocessed.processedQuery;
        preprocessingMetadata = preprocessed.metadata;

        this.logger.info('Query preprocessing complete', {
          correlationId,
          originalQuery: query.query,
          processedQuery,
          changes: preprocessed.metadata.stageResults.length,
        });
      }

      // EXISTING PHASES: Continue with vocabulary, embedding, search, reranking
      // ... (Phase 1 & 2 logic unchanged, but use processedQuery)

      // Use pipelineDecision to conditionally enable stages:
      // - pipelineDecision.search: 'vector' | 'keyword' | 'hybrid'
      // - pipelineDecision.reranking: true | false

      return response;
    } catch (error) {
      this.logger.error('Query pipeline failed', error, { correlationId });
      throw error;
    }
  }

  private extractConstraints(query: VectorSearchQuery): PipelineConstraints {
    return {
      costSensitive: query.metadata?.costSensitive || false,
      accuracyCritical: query.metadata?.accuracyCritical || false,
      maxLatencyMs: query.metadata?.maxLatencyMs,
    };
  }

  private shouldPreprocess(decision: PipelineDecision): boolean {
    return (
      decision.preprocessing.enableSpellCorrection ||
      decision.preprocessing.enableSynonymExpansion ||
      decision.preprocessing.enableEntityExtraction
    );
  }
}
```

### 3.2 Configuration Management

```typescript
/**
 * Phase 3 configuration schema
 */
export interface Phase3Config {
  // Preprocessing
  preprocessing: {
    enabled: boolean; // Global on/off
    spellCorrection: {
      enabled: boolean;
      maxEditDistance: number;
      customDictionaries: Map<string, string>; // per-tenant
    };
    synonymExpansion: {
      enabled: boolean;
      maxSynonymsPerTerm: number;
      customSynonyms: Map<string, string[]>; // per-tenant
    };
    entityExtraction: {
      enabled: boolean;
      entityTypes: string[]; // ['date', 'number', 'email', ...]
      customPatterns: EntityPattern[]; // per-tenant
    };
  };

  // Adaptive pipeline
  adaptivePipeline: {
    enabled: boolean; // If false, use fixed profile
    defaultProfile: 'fast' | 'balanced' | 'accurate';
    costSensitiveMode: boolean; // Prefer cheaper pipelines
    profiles: {
      fast: PipelineProfileConfig;
      balanced: PipelineProfileConfig;
      accurate: PipelineProfileConfig;
    };
  };
}
```

---

## Performance Targets

| Component               | Target Latency | P95 Latency | Success Rate |
| ----------------------- | -------------- | ----------- | ------------ |
| Complexity Analysis     | < 5ms          | < 10ms      | 100%         |
| Stage Selection         | < 5ms          | < 10ms      | 100%         |
| Spell Correction        | < 10ms         | < 20ms      | 95%+         |
| Synonym Expansion       | < 15ms         | < 30ms      | 95%+         |
| Entity Extraction       | < 20ms         | < 40ms      | 90%+         |
| **Total Preprocessing** | **< 50ms**     | **< 100ms** | **95%+**     |

**End-to-End Latency by Profile:**

| Profile  | Target  | With Preprocessing | With Reranking |
| -------- | ------- | ------------------ | -------------- |
| Fast     | < 150ms | ~170ms             | N/A (skipped)  |
| Balanced | < 300ms | ~320ms             | ~430ms         |
| Accurate | < 600ms | ~620ms             | ~730ms         |

---

## Cost Optimization

### Expected Savings from Adaptive Selection

**Scenario: 1000 queries/day**

| Mode          | Reranking Rate | Rerank Cost/Query | Daily Cost | Monthly Cost | Savings    |
| ------------- | -------------- | ----------------- | ---------- | ------------ | ---------- |
| Always Rerank | 100%           | $0.002            | $2.00      | $60.00       | Baseline   |
| Adaptive      | 60%            | $0.002            | $1.20      | $36.00       | **40%** ↓  |
| Fast-Only     | 0%             | $0.000            | $0.00      | $0.00        | **100%** ↓ |

**Adaptive Selection Distribution (Expected):**

- **30%** Fast profile (skip reranking) → Simple keyword queries
- **50%** Balanced profile (conditional reranking) → Standard queries
- **20%** Accurate profile (always rerank) → Complex semantic queries

**Net Savings:** ~40% reduction in reranking costs with minimal accuracy impact (<2% MRR drop)

---

## Implementation Plan

### Phase 3.1: Query Preprocessor Design (2 days)

**Deliverables:**

- Architecture document ✅ (this document)
- Interface definitions (`PreprocessorStage`, `StageOutput`)
- Configuration schema
- Integration plan with `QueryPipeline`

### Phase 3.2: Spell Correction (2 days)

**Tasks:**

1. Integrate SymSpell library
2. Create `SpellCorrectionStage` class
3. Load base dictionary (English + technical terms)
4. Add tenant-specific dictionary management
5. Unit tests (95%+ coverage)
6. Performance validation (< 10ms target)

**Dependencies:** Phase 3.1 complete

### Phase 3.3: Synonym Expansion (2 days)

**Tasks:**

1. Integrate WordNet service
2. Create `SynonymExpansionStage` class
3. Add custom synonym dictionary management
4. Implement expansion strategies (conservative/moderate/aggressive)
5. Unit tests (95%+ coverage)
6. Performance validation (< 15ms target)

**Dependencies:** Phase 3.1 complete

### Phase 3.4: Entity Extraction (3 days)

**Tasks:**

1. Implement entity pattern matchers (dates, numbers, IDs, etc.)
2. Create `EntityExtractionStage` class
3. Add entity normalization logic
4. Integrate with filter generation
5. Add custom entity pattern support (per-tenant)
6. Unit tests (90%+ accuracy on golden dataset)
7. Performance validation (< 20ms target)

**Dependencies:** Phase 3.1 complete

### Phase 3.5: Adaptive Pipeline Design (2 days)

**Deliverables:**

- `AdaptivePipelineSelector` architecture
- `QueryComplexityAnalyzer` design
- Decision tree for stage selection
- Pipeline profile definitions (fast/balanced/accurate)
- Cost-benefit analysis

**Dependencies:** Phase 2 complete (need metrics to inform decisions)

### Phase 3.6: Complexity Analysis Implementation (2 days)

**Tasks:**

1. Create `QueryComplexityAnalyzer` class
2. Implement lexical complexity scoring
3. Implement structural complexity scoring
4. Implement semantic complexity scoring (heuristics for MVP)
5. Implement contextual complexity scoring
6. Unit tests with example queries
7. Validation: complexity correlates with query difficulty

**Dependencies:** Phase 3.5 complete

### Phase 3.7: Stage Selection Implementation (3 days)

**Tasks:**

1. Create `AdaptivePipelineSelector` class
2. Implement profile selection logic
3. Implement preprocessing stage selection
4. Implement search mode selection (vector/keyword/hybrid)
5. Implement reranking decision logic
6. Add configuration management
7. Integration with `QueryPipeline`
8. Unit tests for all decision paths
9. A/B testing framework (optional)

**Dependencies:** Phase 3.6 complete

### Phase 3.8: Testing & Validation (3 days)

**Coverage:**

- Unit tests (all components, 90%+ coverage)
- Integration tests (full pipeline with Phase 3)
- Accuracy validation (golden dataset)
- Performance benchmarks (latency targets)
- Cost optimization validation (savings targets)
- Edge case testing (empty queries, very long queries, special characters)
- Tenant isolation tests

**Dependencies:** Phase 3.1-3.7 complete

### Phase 3.9: Production Deployment (0.5 days)

**Steps:**

1. Configuration review
2. Feature flag setup
3. Staging deployment + validation
4. Gradual rollout (10% → 50% → 100%)
5. Monitoring and alerts
6. Post-deployment validation

**Dependencies:** Phase 3.8 complete + all tests passing

---

## Testing Strategy

### Unit Tests

**QueryPreprocessor:**

- Stage chaining (output of stage N feeds stage N+1)
- Error handling (stage failure doesn't break pipeline)
- Stage enable/disable based on config
- Metadata accumulation

**SpellCorrectionStage:**

- Typo detection and correction
- Custom dictionary precedence
- Proper noun preservation
- Confidence scoring

**SynonymExpansionStage:**

- Synonym lookup (WordNet + custom)
- Expansion strategy (top-N selection)
- Query reformulation (OR clauses)

**EntityExtractionStage:**

- All entity types (dates, numbers, IDs, etc.)
- Entity normalization (e.g., "Q1 2024" → date range)
- Filter conversion
- Custom entity patterns

**QueryComplexityAnalyzer:**

- Complexity scoring across all dimensions
- Edge cases (empty query, very long query, special chars)
- Score consistency (same query → same score)

**AdaptivePipelineSelector:**

- Profile selection logic
- Preprocessing stage selection
- Reranking decision logic
- Cost-sensitive mode
- Accuracy-critical mode

### Integration Tests

**End-to-End Pipeline:**

```typescript
test('full pipeline with preprocessing and adaptive selection', async () => {
  const query = 'Show me kuberntes pods in Q1 2024';
  // Typo: "kuberntes" → should correct to "kubernetes"
  // Entity: "Q1 2024" → should extract date range

  const result = await pipeline.execute({
    query,
    topK: 10,
    rerank: true, // Will be adaptive based on complexity
  });

  // Validate preprocessing happened
  expect(result.metadata.preprocessing).toBeDefined();
  expect(result.metadata.preprocessing.spellCorrections).toContain('kuberntes → kubernetes');
  expect(result.metadata.preprocessing.entities).toContainEqual({
    type: 'date',
    value: 'Q1 2024',
    normalized: { start: '2024-01-01', end: '2024-03-31' },
  });

  // Validate adaptive selection
  expect(result.metadata.pipelineProfile).toBe('balanced'); // Complex enough for balanced
  expect(result.metadata.rerankingEnabled).toBe(true); // Complexity > 50

  // Validate results
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results[0].metadata.query_match).toContain('kubernetes');
});
```

### Golden Dataset Validation

**Test Cases:**

```typescript
const goldenQueries = [
  // Simple keyword queries (should use fast profile)
  { query: 'docker', expectedProfile: 'fast', expectedReranking: false },
  { query: 'find api docs', expectedProfile: 'fast', expectedReranking: false },

  // Moderate complexity (should use balanced profile)
  { query: 'kubernetes pod scheduling', expectedProfile: 'balanced', expectedReranking: true },
  { query: 'how to deploy microservices', expectedProfile: 'balanced', expectedReranking: true },

  // Complex queries (should use accurate profile)
  {
    query: 'Compare optimization approaches for distributed systems with > 1000 nodes in Q1 2024',
    expectedProfile: 'accurate',
    expectedReranking: true,
    expectedEntities: ['number:1000', 'date:Q1 2024'],
  },

  // Queries with typos (should trigger spell correction)
  {
    query: 'kuberntes deploiment strategies',
    expectedCorrections: ['kuberntes → kubernetes', 'deploiment → deployment'],
  },

  // Queries needing synonym expansion
  {
    query: 'k8s ML pipelines',
    expectedSynonyms: ['k8s → kubernetes', 'ML → machine learning'],
  },
];
```

---

## Deployment Strategy

### Feature Flags

```typescript
export const Phase3FeatureFlags = {
  // Global on/off
  PREPROCESSING_ENABLED: process.env.PREPROCESSING_ENABLED === 'true',
  ADAPTIVE_PIPELINE_ENABLED: process.env.ADAPTIVE_PIPELINE_ENABLED === 'true',

  // Per-stage flags
  SPELL_CORRECTION_ENABLED: process.env.SPELL_CORRECTION_ENABLED === 'true',
  SYNONYM_EXPANSION_ENABLED: process.env.SYNONYM_EXPANSION_ENABLED === 'true',
  ENTITY_EXTRACTION_ENABLED: process.env.ENTITY_EXTRACTION_ENABLED === 'true',

  // Rollout percentage (0-100)
  PHASE3_ROLLOUT_PERCENTAGE: parseInt(process.env.PHASE3_ROLLOUT_PERCENTAGE || '0', 10),
};
```

### Rollout Plan

**Week 1: Internal Testing**

- Deploy to staging with all flags enabled
- Internal team testing with production-like data
- Monitor metrics: latency, accuracy, cost
- Fix any critical issues

**Week 2: Beta Rollout**

- Enable for 10% of production traffic (feature flag)
- Monitor closely for 48 hours
- Collect feedback from beta users
- Validate cost savings realized

**Week 3: Gradual Rollout**

- Increase to 50% of production traffic
- Monitor for 72 hours
- Compare metrics: before vs. after
- Validate no accuracy regression

**Week 4: Full Rollout**

- Increase to 100% of production traffic
- Continue monitoring for 1 week
- Collect user feedback
- Measure ROI (cost savings vs. effort)

### Monitoring

**Key Metrics:**

```typescript
export interface Phase3Metrics {
  // Preprocessing
  preprocessing: {
    totalQueries: number;
    spellCorrections: number;
    synonymExpansions: number;
    entitiesExtracted: number;
    avgLatencyMs: number;
    errorRate: number;
  };

  // Adaptive pipeline
  adaptive: {
    profileDistribution: {
      fast: number; // percentage
      balanced: number;
      accurate: number;
    };
    rerankingSkipRate: number; // percentage of queries that skipped reranking
    costSavings: number; // estimated $ saved per day
  };

  // Accuracy
  accuracy: {
    mrrBefore: number; // baseline MRR@10
    mrrAfter: number; // MRR@10 with Phase 3
    mrrDelta: number; // change (should be ≥ 0)
  };

  // Performance
  performance: {
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  };
}
```

**Alerts:**

- Preprocessing error rate > 5% → Page on-call
- MRR drop > 2% → Alert engineering team
- P95 latency > 800ms → Alert platform team
- Cost increase instead of decrease → Alert product team

---

## Success Metrics

### Phase 3 Success Criteria

**✅ Must Have (Blocking for Production)**

- All tests passing (90%+ coverage)
- Preprocessing latency < 50ms (P95 < 100ms)
- No MRR regression (≥ baseline)
- Cost reduction 20%+ from adaptive selection
- Zero tenant data leakage

**🎯 Target Goals**

- Spell correction accuracy: 95%+
- Entity extraction accuracy: 90%+
- Adaptive selection optimality: 90%+ (chose best profile)
- Cost reduction: 30-40%
- Recall improvement from preprocessing: 10-15%

**🌟 Stretch Goals**

- MRR improvement +2-3% (from better preprocessing)
- Cost reduction > 40%
- P95 latency < 300ms (even with preprocessing)
- User feedback: positive sentiment > 80%

---

## Appendix: Example Queries

### Query Processing Examples

**Example 1: Simple Keyword Query**

```
Input: "docker"
Complexity: 18/100 (lexical: 2, structural: 0, semantic: 1, contextual: 5)
Selected Profile: Fast

Preprocessing:
  - Spell Correction: SKIPPED (no typos)
  - Synonym Expansion: SKIPPED (complexity < 40)
  - Entity Extraction: SKIPPED (no entities)

Search: Vector only
Reranking: SKIPPED (complexity < 30, cost-sensitive)

Latency: 120ms (vs 350ms with full pipeline)
Cost: $0.0001 (embedding only, vs $0.0021 with reranking)
Savings: 95%
```

**Example 2: Moderate Semantic Query**

```
Input: "kubernetes pod scheduling"
Complexity: 52/100 (lexical: 4, structural: 0, semantic: 6, contextual: 2)
Selected Profile: Balanced

Preprocessing:
  - Spell Correction: NO CHANGES
  - Synonym Expansion: ENABLED
    → kubernetes → [k8s, container orchestration]
    → pod → [container, workload]
    → scheduling → [scheduling, placement, allocation]
  - Entity Extraction: SKIPPED (no entities)

Expanded Query: "kubernetes pod scheduling (kubernetes OR k8s OR container orchestration) (pod OR container OR workload) (scheduling OR placement OR allocation)"

Search: Hybrid (vector + BM25)
Reranking: ENABLED (complexity > 50)

Latency: 420ms
Cost: $0.0022
Accuracy: MRR improved +8% vs original query (better recall from synonyms)
```

**Example 3: Complex Query with Typo and Entities**

```
Input: "Show me kuberntes pods in Q1 2024 with > 1000 restarts"
Complexity: 74/100 (lexical: 7, structural: 8, semantic: 6, contextual: 2)
Selected Profile: Accurate

Preprocessing:
  - Spell Correction: ENABLED
    → kuberntes → kubernetes (confidence: 0.95)
  - Synonym Expansion: ENABLED
    → kubernetes → [k8s, container orchestration]
    → pods → [containers, workloads]
  - Entity Extraction: ENABLED
    → Date: "Q1 2024" → { start: "2024-01-01", end: "2024-03-31" }
    → Number: "> 1000" → { field: "restarts", operator: "gt", value: 1000 }

Processed Query: "Show me kubernetes pods in Q1 2024 with > 1000 restarts (kubernetes OR k8s) (pods OR containers)"
Filters:
  - timestamp: { gte: "2024-01-01", lte: "2024-03-31" }
  - restarts: { gt: 1000 }

Search: Hybrid (vector + BM25)
Reranking: ENABLED (complexity > 60)

Latency: 610ms
Cost: $0.0023
Accuracy: Precise results (no false positives from typo, correct date range filtering)
```

---

## Summary

Phase 3 adds intelligent query preprocessing and adaptive pipeline selection to optimize for accuracy, latency, and cost across diverse query types.

**Key Innovations:**

1. **Composable Preprocessing Pipeline** - Spell correction, synonym expansion, entity extraction
2. **Multi-Dimensional Complexity Analysis** - Lexical, structural, semantic, contextual scoring
3. **Adaptive Stage Selection** - Dynamic profile selection based on query characteristics
4. **Cost-Aware Execution** - Skip expensive stages (reranking) for simple queries

**Expected Impact:**

- **Recall:** +10-15% from preprocessing (typo correction, synonym expansion)
- **Cost:** -30-40% from adaptive selection (skip reranking for 30-40% of queries)
- **Latency:** Minimal overhead (< 50ms preprocessing, offset by skipped stages)
- **Accuracy:** Maintained or improved (no MRR regression, potential +2-3% gain)

**Next Steps:**

1. Review and approve design
2. Start implementation with Task 3.1 (design complete ✅)
3. Implement preprocessing stages (Tasks 3.2-3.4)
4. Implement adaptive pipeline (Tasks 3.5-3.7)
5. Comprehensive testing (Task 3.8)
6. Gradual production rollout (Task 3.9)

---

**End of Phase 3 Design Document**
