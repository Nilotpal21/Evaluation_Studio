# Phase 3 Implementation Specifications (Part 2)

**Adaptive Pipeline Components & Testing**

---

## Task 3.5: Adaptive Pipeline Selector Design

### File Structure

```
apps/search-ai-runtime/src/services/adaptive/
├── complexity-analyzer.ts         # Task 3.6
├── pipeline-selector.ts           # Task 3.7
├── types.ts                       # Shared types
├── config.ts                      # Configuration
└── __tests__/
    ├── complexity-analyzer.test.ts
    └── pipeline-selector.test.ts
```

### Core Types (`types.ts`)

```typescript
/**
 * Query complexity profile across multiple dimensions
 */
export interface ComplexityProfile {
  /** Overall score (0-100) */
  overall: number;

  /** Lexical complexity: word count, vocabulary diversity */
  lexical: number;

  /** Structural complexity: entities, filters, operators */
  structural: number;

  /** Semantic complexity: abstract vs concrete terms */
  semantic: number;

  /** Contextual complexity: ambiguity, specificity */
  contextual: number;

  /** Additional metadata */
  metadata: {
    wordCount: number;
    uniqueWords: number;
    hasEntities: boolean;
    hasComparisons: boolean;
    hasDates: boolean;
    isQuestion: boolean;
  };
}

/**
 * Pipeline profile selection
 */
export type PipelineProfile = 'fast' | 'balanced' | 'accurate';

/**
 * Constraints that influence pipeline selection
 */
export interface PipelineConstraints {
  /** Prefer cheaper pipelines (skip expensive stages) */
  costSensitive?: boolean;

  /** Require highest accuracy (enable all stages) */
  accuracyCritical?: boolean;

  /** Maximum latency budget in milliseconds */
  maxLatencyMs?: number;

  /** Maximum cost budget per query (in dollars) */
  maxCostPerQuery?: number;
}

/**
 * Decision for which pipeline stages to enable
 */
export interface PipelineDecision {
  /** Selected profile */
  profile: PipelineProfile;

  /** Preprocessing stage selection */
  preprocessing: {
    enableSpellCorrection: boolean;
    enableSynonymExpansion: boolean;
    enableEntityExtraction: boolean;
  };

  /** Search mode selection */
  search: {
    mode: 'vector' | 'keyword' | 'hybrid';
    vectorWeight?: number; // For hybrid (0-1)
  };

  /** Reranking decision */
  reranking: {
    enabled: boolean;
    reason: string; // Why enabled/disabled
  };

  /** Latency budgets per stage (milliseconds) */
  budgets: {
    preprocessingMs: number;
    vocabularyMs: number;
    embeddingMs: number;
    searchMs: number;
    rerankingMs: number;
    totalMs: number;
  };

  /** Decision metadata */
  metadata: {
    complexity: number;
    constraints: PipelineConstraints;
    estimatedCost: number;
    estimatedLatency: number;
  };
}

/**
 * Pipeline profile configuration
 */
export interface PipelineProfileConfig {
  /** Profile name */
  name: PipelineProfile;

  /** Description */
  description: string;

  /** Complexity range for auto-selection (0-100) */
  complexityRange: {
    min: number;
    max: number;
  };

  /** Default stage enablement */
  stages: {
    spellCorrection: boolean;
    synonymExpansion: boolean;
    entityExtraction: boolean;
    reranking: boolean;
  };

  /** Search mode */
  searchMode: 'vector' | 'keyword' | 'hybrid';

  /** Latency target (milliseconds) */
  latencyTargetMs: number;

  /** Expected cost per query (dollars) */
  expectedCostPerQuery: number;
}
```

### Configuration (`config.ts`)

```typescript
/**
 * Adaptive pipeline configuration
 */
export interface AdaptivePipelineConfig {
  /** Enable adaptive selection (if false, use defaultProfile always) */
  enabled: boolean;

  /** Default profile when adaptive is disabled */
  defaultProfile: PipelineProfile;

  /** Profile configurations */
  profiles: {
    fast: PipelineProfileConfig;
    balanced: PipelineProfileConfig;
    accurate: PipelineProfileConfig;
  };

  /** Global constraints */
  globalConstraints: {
    maxLatencyMs: number;
    maxCostPerQuery: number;
  };

  /** Feature flags */
  features: {
    allowProfileOverride: boolean; // Allow user to force a profile
    trackDecisionAccuracy: boolean; // Track if selections were optimal
  };
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptivePipelineConfig = {
  enabled: true,
  defaultProfile: 'balanced',

  profiles: {
    fast: {
      name: 'fast',
      description: 'Optimized for speed, minimal processing',
      complexityRange: { min: 0, max: 30 },
      stages: {
        spellCorrection: true,
        synonymExpansion: false,
        entityExtraction: false,
        reranking: false,
      },
      searchMode: 'vector',
      latencyTargetMs: 150,
      expectedCostPerQuery: 0.0001,
    },

    balanced: {
      name: 'balanced',
      description: 'Balance between speed and accuracy',
      complexityRange: { min: 30, max: 60 },
      stages: {
        spellCorrection: true,
        synonymExpansion: true,
        entityExtraction: true,
        reranking: true, // Conditional based on complexity
      },
      searchMode: 'hybrid',
      latencyTargetMs: 300,
      expectedCostPerQuery: 0.0012,
    },

    accurate: {
      name: 'accurate',
      description: 'Maximum accuracy, full processing',
      complexityRange: { min: 60, max: 100 },
      stages: {
        spellCorrection: true,
        synonymExpansion: true,
        entityExtraction: true,
        reranking: true,
      },
      searchMode: 'hybrid',
      latencyTargetMs: 600,
      expectedCostPerQuery: 0.0023,
    },
  },

  globalConstraints: {
    maxLatencyMs: 1000,
    maxCostPerQuery: 0.01,
  },

  features: {
    allowProfileOverride: true,
    trackDecisionAccuracy: true,
  },
};
```

---

## Task 3.6: Query Complexity Analysis

### File: `complexity-analyzer.ts`

```typescript
import type { ComplexityProfile } from './types.js';
import { StructuredLogger } from '../metrics/structured-logger.js';

/**
 * Analyzes query complexity across multiple dimensions
 */
export class QueryComplexityAnalyzer {
  private logger: StructuredLogger;

  // Lexical analysis data
  private abstractTerms = new Set([
    'concept',
    'theory',
    'approach',
    'methodology',
    'framework',
    'principle',
    'strategy',
    'pattern',
    'paradigm',
    'philosophy',
    'ideology',
  ]);

  private technicalTerms = new Set([
    'algorithm',
    'architecture',
    'implementation',
    'optimization',
    'performance',
    'scalability',
    'reliability',
    'availability',
    'consistency',
    'durability',
  ]);

  private stopwords = new Set([
    'the',
    'and',
    'or',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'have',
    'has',
    'had',
    'do',
    'does',
  ]);

  constructor() {
    this.logger = new StructuredLogger({ component: 'QueryComplexityAnalyzer' });
  }

  /**
   * Analyze query complexity
   */
  analyze(query: string): ComplexityProfile {
    const lexical = this.analyzeLexicalComplexity(query);
    const structural = this.analyzeStructuralComplexity(query);
    const semantic = this.analyzeSemanticComplexity(query);
    const contextual = this.analyzeContextualComplexity(query);

    const overall = this.computeOverallScore(lexical, structural, semantic, contextual);

    const metadata = this.extractMetadata(query);

    this.logger.debug('Complexity analysis complete', {
      query: query.substring(0, 100),
      overall,
      lexical,
      structural,
      semantic,
      contextual,
    });

    return {
      overall,
      lexical,
      structural,
      semantic,
      contextual,
      metadata,
    };
  }

  /**
   * Lexical complexity: word count, vocabulary diversity, term length
   * Returns: 0-10
   */
  private analyzeLexicalComplexity(query: string): number {
    const words = this.tokenize(query);
    const contentWords = words.filter((w) => !this.stopwords.has(w.toLowerCase()));
    const uniqueWords = new Set(contentWords.map((w) => w.toLowerCase()));

    let score = 0;

    // Word count contribution (0-5 points)
    // Simple query: 1-3 words = low score
    // Complex query: 10+ words = high score
    const wordCountScore = Math.min((contentWords.length / 10) * 5, 5);
    score += wordCountScore;

    // Vocabulary diversity (0-3 points)
    // High diversity = many unique terms relative to total
    if (contentWords.length > 0) {
      const diversity = uniqueWords.size / contentWords.length;
      score += diversity * 3;
    }

    // Average word length (0-2 points)
    // Longer words = more complex vocabulary
    if (contentWords.length > 0) {
      const avgLength = contentWords.reduce((sum, w) => sum + w.length, 0) / contentWords.length;
      const lengthScore = Math.min((avgLength / 8) * 2, 2);
      score += lengthScore;
    }

    return Math.min(Math.round(score), 10);
  }

  /**
   * Structural complexity: entities, filters, operators
   * Returns: 0-10
   */
  private analyzeStructuralComplexity(query: string): number {
    let score = 0;

    // Entity patterns (0-5 points)
    const dateMatches = query.match(/\d{4}-\d{2}-\d{2}|Q[1-4]\s+\d{4}/gi) || [];
    const numberMatches = query.match(/[><]=?\s*\d+|\d+[KMB]/gi) || [];
    const emailMatches = query.match(/\S+@\S+\.\S+/g) || [];
    const urlMatches = query.match(/https?:\/\/[^\s]+/gi) || [];

    const entityCount =
      dateMatches.length + numberMatches.length + emailMatches.length + urlMatches.length;
    score += Math.min(entityCount * 1.5, 5);

    // Logical operators (0-3 points)
    const andMatches = query.match(/\bAND\b/gi) || [];
    const orMatches = query.match(/\bOR\b/gi) || [];
    const notMatches = query.match(/\bNOT\b/gi) || [];
    const operatorCount = andMatches.length + orMatches.length + notMatches.length;
    score += Math.min(operatorCount, 3);

    // Quoted phrases (0-2 points)
    const quotedMatches = query.match(/"[^"]+"/g) || [];
    score += Math.min(quotedMatches.length, 2);

    return Math.min(Math.round(score), 10);
  }

  /**
   * Semantic complexity: abstract vs concrete, conceptual depth
   * Returns: 0-10
   */
  private analyzeSemanticComplexity(query: string): number {
    const words = this.tokenize(query);
    const lowerWords = words.map((w) => w.toLowerCase());
    let score = 0;

    // Abstract concepts (0-5 points)
    const abstractCount = lowerWords.filter((w) => this.abstractTerms.has(w)).length;
    score += Math.min(abstractCount * 2, 5);

    // Technical depth (0-5 points)
    const technicalCount = lowerWords.filter((w) => this.technicalTerms.has(w)).length;
    score += Math.min(technicalCount * 2, 5);

    return Math.min(Math.round(score), 10);
  }

  /**
   * Contextual complexity: ambiguity, specificity
   * Returns: 0-10
   */
  private analyzeContextualComplexity(query: string): number {
    const words = this.tokenize(query);
    const lowerWords = words.map((w) => w.toLowerCase());
    let score = 0;

    // Ambiguous terms (0-5 points)
    const ambiguousTerms = ['it', 'this', 'that', 'thing', 'stuff', 'something', 'things'];
    const ambiguityCount = lowerWords.filter((w) => ambiguousTerms.includes(w)).length;
    score += Math.min(ambiguityCount * 2, 5);

    // Vague modifiers (0-3 points)
    const vagueModifiers = ['some', 'many', 'few', 'several', 'various', 'different'];
    const vagueCount = lowerWords.filter((w) => vagueModifiers.includes(w)).length;
    score += Math.min(vagueCount * 1.5, 3);

    // Query length penalty (0-2 points)
    // Very short queries are ambiguous
    if (words.length < 3) {
      score += 2;
    } else if (words.length < 5) {
      score += 1;
    }

    return Math.min(Math.round(score), 10);
  }

  /**
   * Compute overall complexity score (0-100)
   * Weighted combination of all dimensions
   */
  private computeOverallScore(
    lexical: number,
    structural: number,
    semantic: number,
    contextual: number,
  ): number {
    // Weights: structural and semantic matter more
    const weighted = lexical * 0.2 + structural * 0.3 + semantic * 0.3 + contextual * 0.2;

    // Scale to 0-100
    return Math.round(weighted * 10);
  }

  /**
   * Extract metadata about query characteristics
   */
  private extractMetadata(query: string): ComplexityProfile['metadata'] {
    const words = this.tokenize(query);
    const lowerWords = words.map((w) => w.toLowerCase());
    const uniqueWords = new Set(lowerWords);

    return {
      wordCount: words.length,
      uniqueWords: uniqueWords.size,
      hasEntities: /\d{4}-\d{2}-\d{2}|Q[1-4]|[><]=?\s*\d+|\S+@\S+\.\S+/.test(query),
      hasComparisons: /[><]=?\s*\d+/.test(query),
      hasDates: /\d{4}-\d{2}-\d{2}|Q[1-4]\s+\d{4}/.test(query),
      isQuestion: /^(what|when|where|who|why|how)\b/i.test(query) || query.includes('?'),
    };
  }

  /**
   * Tokenize query into words
   */
  private tokenize(query: string): string[] {
    return query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  }
}
```

### Test Cases

```typescript
describe('QueryComplexityAnalyzer', () => {
  let analyzer: QueryComplexityAnalyzer;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer();
  });

  describe('Lexical Complexity', () => {
    test('simple query has low lexical complexity', () => {
      const profile = analyzer.analyze('docker');
      expect(profile.lexical).toBeLessThan(3);
    });

    test('complex query has high lexical complexity', () => {
      const profile = analyzer.analyze(
        'comprehensive distributed optimization architecture implementation strategies',
      );
      expect(profile.lexical).toBeGreaterThan(7);
    });
  });

  describe('Structural Complexity', () => {
    test('query with entities has high structural complexity', () => {
      const profile = analyzer.analyze('logs from 2024-01-15 with errors > 100');
      expect(profile.structural).toBeGreaterThan(5);
      expect(profile.metadata.hasEntities).toBe(true);
      expect(profile.metadata.hasComparisons).toBe(true);
      expect(profile.metadata.hasDates).toBe(true);
    });

    test('query with operators has high structural complexity', () => {
      const profile = analyzer.analyze('kubernetes AND docker OR podman');
      expect(profile.structural).toBeGreaterThan(3);
    });
  });

  describe('Semantic Complexity', () => {
    test('query with abstract terms has high semantic complexity', () => {
      const profile = analyzer.analyze('framework architecture methodology approach');
      expect(profile.semantic).toBeGreaterThan(6);
    });

    test('query with concrete terms has low semantic complexity', () => {
      const profile = analyzer.analyze('find docker logs');
      expect(profile.semantic).toBeLessThan(3);
    });
  });

  describe('Overall Score', () => {
    test('simple keyword query', () => {
      const profile = analyzer.analyze('docker');
      expect(profile.overall).toBeLessThan(25);
    });

    test('moderate query', () => {
      const profile = analyzer.analyze('kubernetes pod scheduling strategies');
      expect(profile.overall).toBeGreaterThan(25);
      expect(profile.overall).toBeLessThan(65);
    });

    test('complex analytical query', () => {
      const profile = analyzer.analyze(
        'Compare optimization approaches for distributed systems with > 1000 nodes in Q1 2024',
      );
      expect(profile.overall).toBeGreaterThan(60);
    });
  });

  test('meets latency target', () => {
    const start = Date.now();
    const profile = analyzer.analyze('kubernetes deployment strategies for microservices');
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(5); // < 5ms target
  });
});
```

---

## Task 3.7: Adaptive Stage Selection

### File: `pipeline-selector.ts`

```typescript
import type {
  ComplexityProfile,
  PipelineProfile,
  PipelineConstraints,
  PipelineDecision,
  AdaptivePipelineConfig,
  PipelineProfileConfig,
} from './types.js';
import { StructuredLogger } from '../metrics/structured-logger.js';

/**
 * Selects optimal pipeline configuration based on complexity and constraints
 */
export class AdaptivePipelineSelector {
  private logger: StructuredLogger;

  constructor(private config: AdaptivePipelineConfig) {
    this.logger = new StructuredLogger({ component: 'AdaptivePipelineSelector' });
  }

  /**
   * Select pipeline configuration for a query
   */
  select(
    query: string,
    complexity: ComplexityProfile,
    constraints: PipelineConstraints = {},
  ): PipelineDecision {
    const startTime = Date.now();

    // Select profile
    const profile = this.selectProfile(complexity, constraints);
    const profileConfig = this.config.profiles[profile];

    // Select preprocessing stages
    const preprocessing = this.selectPreprocessingStages(query, complexity, profileConfig);

    // Select search mode
    const search = this.selectSearchMode(complexity, profileConfig);

    // Decide on reranking
    const reranking = this.selectReranking(complexity, constraints, profileConfig);

    // Compute budgets
    const budgets = this.computeBudgets(complexity, profileConfig);

    // Estimate cost and latency
    const estimatedCost = this.estimateCost(preprocessing, search, reranking);
    const estimatedLatency = this.estimateLatency(budgets);

    const decision: PipelineDecision = {
      profile,
      preprocessing,
      search,
      reranking,
      budgets,
      metadata: {
        complexity: complexity.overall,
        constraints,
        estimatedCost,
        estimatedLatency,
      },
    };

    const duration = Date.now() - startTime;

    this.logger.debug('Pipeline decision made', {
      query: query.substring(0, 50),
      complexity: complexity.overall,
      profile,
      preprocessingEnabled: Object.values(preprocessing).filter(Boolean).length,
      rerankingEnabled: reranking.enabled,
      durationMs: duration,
    });

    return decision;
  }

  /**
   * Select one of three profiles based on complexity and constraints
   */
  private selectProfile(
    complexity: ComplexityProfile,
    constraints: PipelineConstraints,
  ): PipelineProfile {
    const score = complexity.overall;

    // Explicit overrides
    if (constraints.costSensitive && score < 50) {
      return 'fast';
    }

    if (constraints.accuracyCritical) {
      return 'accurate';
    }

    if (constraints.maxLatencyMs && constraints.maxLatencyMs < 200) {
      return 'fast';
    }

    // Complexity-based selection
    if (score < 30) return 'fast';
    if (score < 60) return 'balanced';
    return 'accurate';
  }

  /**
   * Decide which preprocessing stages to enable
   */
  private selectPreprocessingStages(
    query: string,
    complexity: ComplexityProfile,
    profileConfig: PipelineProfileConfig,
  ): PipelineDecision['preprocessing'] {
    // Start with profile defaults
    const decision = {
      enableSpellCorrection: profileConfig.stages.spellCorrection,
      enableSynonymExpansion: profileConfig.stages.synonymExpansion,
      enableEntityExtraction: profileConfig.stages.entityExtraction,
    };

    // Override based on query characteristics

    // Spell correction: Enable if typo indicators OR simple query (quick fix)
    if (this.detectTypos(query) || complexity.overall < 30) {
      decision.enableSpellCorrection = true;
    }

    // Synonym expansion: Enable for semantic queries
    if (complexity.semantic > 5 || complexity.overall > 40) {
      decision.enableSynonymExpansion = true;
    }

    // Entity extraction: Enable if structured elements detected
    if (complexity.structural > 4 || complexity.metadata.hasEntities) {
      decision.enableEntityExtraction = true;
    }

    return decision;
  }

  /**
   * Select search mode: vector, keyword, or hybrid
   */
  private selectSearchMode(
    complexity: ComplexityProfile,
    profileConfig: PipelineProfileConfig,
  ): PipelineDecision['search'] {
    const defaultMode = profileConfig.searchMode;

    // Override based on query characteristics

    // Pure keyword queries (low semantic complexity)
    if (complexity.semantic < 3 && complexity.lexical < 4) {
      return {
        mode: 'keyword',
      };
    }

    // Complex queries benefit from hybrid
    if (complexity.overall > 40) {
      return {
        mode: 'hybrid',
        vectorWeight: 0.6, // Favor vector for semantic queries
      };
    }

    // Default to profile config
    return {
      mode: defaultMode,
      vectorWeight: defaultMode === 'hybrid' ? 0.5 : undefined,
    };
  }

  /**
   * Decide whether to enable reranking
   */
  private selectReranking(
    complexity: ComplexityProfile,
    constraints: PipelineConstraints,
    profileConfig: PipelineProfileConfig,
  ): PipelineDecision['reranking'] {
    // Cost-sensitive mode: skip reranking for simple queries
    if (constraints.costSensitive && complexity.overall < 30) {
      return {
        enabled: false,
        reason: 'Skipped for cost optimization (simple query)',
      };
    }

    // Accuracy-critical: always enable
    if (constraints.accuracyCritical) {
      return {
        enabled: true,
        reason: 'Enabled for accuracy-critical mode',
      };
    }

    // Latency-critical: skip if budget tight
    if (constraints.maxLatencyMs && constraints.maxLatencyMs < 200) {
      return {
        enabled: false,
        reason: 'Skipped for latency constraints',
      };
    }

    // Complexity-based decision
    if (complexity.overall < 30) {
      return {
        enabled: false,
        reason: 'Simple query - reranking not needed',
      };
    }

    if (complexity.overall > 50) {
      return {
        enabled: true,
        reason: 'Complex query - reranking improves accuracy',
      };
    }

    // Default to profile config
    return {
      enabled: profileConfig.stages.reranking,
      reason: 'Profile default',
    };
  }

  /**
   * Compute latency budgets for each stage
   */
  private computeBudgets(
    complexity: ComplexityProfile,
    profileConfig: PipelineProfileConfig,
  ): PipelineDecision['budgets'] {
    // Allocate more time for complex queries
    const multiplier = Math.max(0.6, complexity.overall / 50); // 0.6x to 2.0x

    return {
      preprocessingMs: Math.round(50 * multiplier),
      vocabularyMs: Math.round(20 * multiplier),
      embeddingMs: Math.round(30 * multiplier),
      searchMs: Math.round(100 * multiplier),
      rerankingMs: Math.round(150 * multiplier),
      totalMs: profileConfig.latencyTargetMs,
    };
  }

  /**
   * Estimate cost for selected configuration
   */
  private estimateCost(
    preprocessing: PipelineDecision['preprocessing'],
    search: PipelineDecision['search'],
    reranking: PipelineDecision['reranking'],
  ): number {
    let cost = 0;

    // Embedding cost (always)
    cost += 0.0001;

    // Reranking cost (if enabled)
    if (reranking.enabled) {
      cost += 0.002;
    }

    // Preprocessing has negligible cost (runs locally)

    return cost;
  }

  /**
   * Estimate latency for selected configuration
   */
  private estimateLatency(budgets: PipelineDecision['budgets']): number {
    return budgets.totalMs;
  }

  /**
   * Detect typo indicators in query
   */
  private detectTypos(query: string): boolean {
    // Simple heuristic: words not in common dictionary
    // More sophisticated: use edit distance to known terms

    const suspiciousPatterns = [
      /\w{3,}[aeiou]{3,}\w/i, // Too many vowels (e.g., "kubeernetes")
      /\w{3,}[bcdfghjklmnpqrstvwxyz]{4,}\w/i, // Too many consonants
      /(.)\1{2,}/, // Repeated characters (e.g., "dooocker")
    ];

    return suspiciousPatterns.some((pattern) => pattern.test(query));
  }
}
```

### Test Cases

```typescript
describe('AdaptivePipelineSelector', () => {
  let selector: AdaptivePipelineSelector;
  let analyzer: QueryComplexityAnalyzer;

  beforeEach(() => {
    selector = new AdaptivePipelineSelector(DEFAULT_ADAPTIVE_CONFIG);
    analyzer = new QueryComplexityAnalyzer();
  });

  describe('Profile Selection', () => {
    test('simple query selects fast profile', () => {
      const complexity = analyzer.analyze('docker');
      const decision = selector.select('docker', complexity);

      expect(decision.profile).toBe('fast');
      expect(decision.reranking.enabled).toBe(false);
    });

    test('moderate query selects balanced profile', () => {
      const complexity = analyzer.analyze('kubernetes pod scheduling');
      const decision = selector.select('kubernetes pod scheduling', complexity);

      expect(decision.profile).toBe('balanced');
    });

    test('complex query selects accurate profile', () => {
      const complexity = analyzer.analyze(
        'Compare optimization approaches for distributed systems with > 1000 nodes',
      );
      const decision = selector.select(
        'Compare optimization approaches for distributed systems with > 1000 nodes',
        complexity,
      );

      expect(decision.profile).toBe('accurate');
      expect(decision.reranking.enabled).toBe(true);
    });
  });

  describe('Constraint Overrides', () => {
    test('cost-sensitive skips reranking for simple queries', () => {
      const complexity = analyzer.analyze('find docs');
      const decision = selector.select('find docs', complexity, {
        costSensitive: true,
      });

      expect(decision.reranking.enabled).toBe(false);
      expect(decision.reranking.reason).toContain('cost');
    });

    test('accuracy-critical enables reranking always', () => {
      const complexity = analyzer.analyze('docker'); // Simple query
      const decision = selector.select('docker', complexity, {
        accuracyCritical: true,
      });

      expect(decision.reranking.enabled).toBe(true);
      expect(decision.profile).toBe('accurate');
    });

    test('latency constraints select fast profile', () => {
      const complexity = analyzer.analyze('kubernetes deployment');
      const decision = selector.select('kubernetes deployment', complexity, {
        maxLatencyMs: 150,
      });

      expect(decision.profile).toBe('fast');
      expect(decision.reranking.enabled).toBe(false);
    });
  });

  describe('Preprocessing Selection', () => {
    test('enables spell correction for query with typos', () => {
      const complexity = analyzer.analyze('kuberntes deploiment');
      const decision = selector.select('kuberntes deploiment', complexity);

      expect(decision.preprocessing.enableSpellCorrection).toBe(true);
    });

    test('enables entity extraction for structured queries', () => {
      const complexity = analyzer.analyze('logs from 2024-01-15 with errors > 100');
      const decision = selector.select('logs from 2024-01-15 with errors > 100', complexity);

      expect(decision.preprocessing.enableEntityExtraction).toBe(true);
    });

    test('enables synonym expansion for semantic queries', () => {
      const complexity = analyzer.analyze('machine learning optimization techniques');
      const decision = selector.select('machine learning optimization techniques', complexity);

      expect(decision.preprocessing.enableSynonymExpansion).toBe(true);
    });
  });

  describe('Cost Optimization', () => {
    test('fast profile has lowest cost', () => {
      const complexity = analyzer.analyze('docker');
      const decision = selector.select('docker', complexity);

      expect(decision.metadata.estimatedCost).toBeLessThan(0.001);
    });

    test('accurate profile has higher cost', () => {
      const complexity = analyzer.analyze('Compare distributed system architectures');
      const decision = selector.select('Compare distributed system architectures', complexity);

      expect(decision.metadata.estimatedCost).toBeGreaterThan(0.001);
    });
  });

  test('meets latency target', () => {
    const complexity = analyzer.analyze('kubernetes deployment strategies');
    const start = Date.now();
    const decision = selector.select('kubernetes deployment strategies', complexity);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(5); // < 5ms target
  });
});
```

---

## Task 3.8: Testing & Validation

### Test Coverage Plan

#### 1. Unit Tests (90%+ coverage)

**Preprocessing Components:**

```typescript
// apps/search-ai-runtime/src/services/preprocessing/__tests__/

describe('QueryPreprocessor', () => {
  test('runs stages in priority order');
  test('skips disabled stages');
  test('handles stage failures gracefully');
  test('accumulates metadata correctly');
  test('meets total latency budget');
});

describe('SpellCorrectionStage', () => {
  test('corrects single typo');
  test('corrects multiple typos');
  test('uses custom dictionary');
  test('skips proper nouns');
  test('preserves entities');
  test('meets latency target (< 10ms)');
});

describe('SynonymExpansionStage', () => {
  test('expands technical abbreviations');
  test('uses WordNet synonyms');
  test('respects maxSynonymsPerTerm');
  test('skips stopwords');
  test('uses custom synonyms');
  test('meets latency target (< 15ms)');
});

describe('EntityExtractionStage', () => {
  test('extracts ISO dates');
  test('extracts quarters (Q1 2024)');
  test('extracts number comparisons (> 100)');
  test('extracts currencies ($100K)');
  test('extracts emails');
  test('generates filters from entities');
  test('meets latency target (< 20ms)');
});
```

**Adaptive Pipeline Components:**

```typescript
// apps/search-ai-runtime/src/services/adaptive/__tests__/

describe('QueryComplexityAnalyzer', () => {
  test('simple query has low complexity');
  test('complex query has high complexity');
  test('detects entities in structural analysis');
  test('detects abstract terms in semantic analysis');
  test('meets latency target (< 5ms)');
});

describe('AdaptivePipelineSelector', () => {
  test('simple query selects fast profile');
  test('complex query selects accurate profile');
  test('cost-sensitive skips reranking');
  test('accuracy-critical enables all stages');
  test('latency constraints select fast profile');
  test('meets latency target (< 5ms)');
});
```

#### 2. Integration Tests

```typescript
// Full pipeline with Phase 3 enabled
describe('QueryPipeline with Phase 3', () => {
  test('preprocesses query before search', async () => {
    const pipeline = new QueryPipeline({
      preprocessor: await createQueryPreprocessor(config),
      adaptiveSelector: new AdaptivePipelineSelector(adaptiveConfig),
      // ... other components
    });

    const result = await pipeline.execute({
      query: 'kuberntes pods in Q1 2024', // Typo + entity
      topK: 10,
    });

    // Validate preprocessing happened
    expect(result.metadata.preprocessing).toBeDefined();
    expect(result.metadata.preprocessing.spellCorrections).toContainEqual(
      expect.objectContaining({ original: 'kuberntes', corrected: 'kubernetes' }),
    );
    expect(result.metadata.preprocessing.entities).toContainEqual(
      expect.objectContaining({ type: 'date', text: 'Q1 2024' }),
    );

    // Validate adaptive selection
    expect(result.metadata.pipelineProfile).toBeDefined();
  });

  test('adaptive selection saves cost for simple queries', async () => {
    // Simple query → fast profile → skip reranking
    const simpleResult = await pipeline.execute({
      query: 'docker',
      topK: 10,
    });

    // Complex query → accurate profile → enable reranking
    const complexResult = await pipeline.execute({
      query: 'Compare kubernetes deployment strategies for microservices',
      topK: 10,
    });

    expect(simpleResult.cost).toBeLessThan(complexResult.cost);
    expect(simpleResult.metadata.rerankingEnabled).toBe(false);
    expect(complexResult.metadata.rerankingEnabled).toBe(true);
  });
});
```

#### 3. Golden Dataset Validation

```typescript
// Test against golden queries with known expected behavior
const goldenQueries = [
  {
    query: 'docker',
    expectedProfile: 'fast',
    expectedReranking: false,
    expectedLatency: { max: 150 },
  },
  {
    query: 'kuberntes deploiment stratagies', // Multiple typos
    expectedCorrections: 3,
    expectedProfile: 'balanced',
  },
  {
    query: 'Q1 2024 revenue > $100K',
    expectedEntities: 2, // Date + currency
    expectedFilters: 2,
    expectedProfile: 'accurate',
  },
  // ... 50+ golden queries
];

describe('Golden Dataset Validation', () => {
  for (const golden of goldenQueries) {
    test(`Query: "${golden.query}"`, async () => {
      const result = await pipeline.execute({ query: golden.query });

      if (golden.expectedProfile) {
        expect(result.metadata.pipelineProfile).toBe(golden.expectedProfile);
      }

      if (golden.expectedCorrections) {
        expect(result.metadata.preprocessing.corrections.length).toBe(golden.expectedCorrections);
      }

      if (golden.expectedEntities) {
        expect(result.metadata.preprocessing.entities.length).toBe(golden.expectedEntities);
      }

      if (golden.expectedLatency) {
        expect(result.latency.totalMs).toBeLessThan(golden.expectedLatency.max);
      }
    });
  }
});
```

#### 4. Performance Benchmarks

```typescript
describe('Performance Benchmarks', () => {
  test('preprocessing meets total latency budget', async () => {
    const queries = [
      'simple',
      'moderate complexity query with entities',
      'very complex semantic query with multiple structured elements and abstract concepts',
    ];

    for (const query of queries) {
      const start = Date.now();
      const preprocessed = await preprocessor.preprocess(
        { query, tenantId: 'test', indexId: 'idx' },
        config,
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // P95 target
      expect(preprocessed.metrics.totalDurationMs).toBeLessThan(50); // P50 target
    }
  });

  test('adaptive selection overhead is minimal', () => {
    const queries = generateRandomQueries(1000);

    const start = Date.now();
    for (const query of queries) {
      const complexity = analyzer.analyze(query);
      const decision = selector.select(query, complexity);
    }
    const duration = Date.now() - start;

    const avgPerQuery = duration / queries.length;
    expect(avgPerQuery).toBeLessThan(5); // < 5ms per query
  });
});
```

#### 5. Cost Optimization Validation

```typescript
describe('Cost Optimization', () => {
  test('adaptive selection reduces cost by 30%+', async () => {
    const testQueries = [
      // Mix of simple and complex queries
      ...Array(300).fill('docker'), // 30% simple
      ...Array(500).fill('kubernetes deployment strategies'), // 50% moderate
      ...Array(200).fill('Compare distributed system architectures'), // 20% complex
    ];

    // Always-rerank baseline
    const alwaysRerankCost = testQueries.length * 0.0021;

    // Adaptive cost
    let adaptiveCost = 0;
    for (const query of testQueries) {
      const result = await pipeline.execute({ query });
      adaptiveCost += result.cost;
    }

    const savings = (alwaysRerankCost - adaptiveCost) / alwaysRerankCost;
    expect(savings).toBeGreaterThan(0.3); // 30%+ savings
  });
});
```

---

## Task 3.9: Deployment Plan

### Deployment Strategy

#### Phase 1: Feature Flag Setup

```typescript
// Feature flags for gradual rollout
export const Phase3FeatureFlags = {
  // Global on/off
  PREPROCESSING_ENABLED: env('PREPROCESSING_ENABLED', 'false') === 'true',
  ADAPTIVE_PIPELINE_ENABLED: env('ADAPTIVE_PIPELINE_ENABLED', 'false') === 'true',

  // Per-stage flags
  SPELL_CORRECTION_ENABLED: env('SPELL_CORRECTION_ENABLED', 'true') === 'true',
  SYNONYM_EXPANSION_ENABLED: env('SYNONYM_EXPANSION_ENABLED', 'true') === 'true',
  ENTITY_EXTRACTION_ENABLED: env('ENTITY_EXTRACTION_ENABLED', 'true') === 'true',

  // Rollout percentage (0-100)
  PHASE3_ROLLOUT_PCT: parseInt(env('PHASE3_ROLLOUT_PCT', '0'), 10),
};
```

#### Phase 2: Staging Deployment (Week 1)

**Checklist:**

- [ ] Deploy to staging with all flags enabled
- [ ] Run smoke tests (10 golden queries)
- [ ] Monitor metrics for 48 hours
- [ ] Run load test (100 QPS sustained)
- [ ] Validate preprocessing latency < 50ms (P95 < 100ms)
- [ ] Validate no MRR regression
- [ ] Validate cost savings realized

**Rollback Triggers:**

- Error rate > 1% in preprocessing stages
- P95 latency > 600ms
- MRR drops > 2%

#### Phase 3: Beta Rollout (Week 2)

**Step 1: Enable for 10% of traffic**

```bash
kubectl set env deployment/search-ai-runtime \
  PHASE3_ROLLOUT_PCT=10 \
  PREPROCESSING_ENABLED=true \
  ADAPTIVE_PIPELINE_ENABLED=true
```

**Monitoring (48 hours):**

- Track preprocessing metrics (corrections, expansions, entities)
- Compare MRR: Phase 3 vs baseline
- Monitor cost savings
- Collect user feedback

**Step 2: Increase to 50%** (if no issues)

```bash
kubectl set env deployment/search-ai-runtime PHASE3_ROLLOUT_PCT=50
```

#### Phase 4: Full Rollout (Week 3)

**Step 1: Enable for 100%**

```bash
kubectl set env deployment/search-ai-runtime PHASE3_ROLLOUT_PCT=100
```

**Post-Deployment Validation:**

- Run golden dataset (compare MRR before/after)
- Validate cost reduction 30-40% realized
- Collect user feedback (survey)
- Monitor for 1 week

### Monitoring Dashboard

**Key Metrics:**

```typescript
// Preprocessing metrics
preprocessing.totalQueries;
preprocessing.spellCorrections;
preprocessing.synonymExpansions;
preprocessing.entitiesExtracted;
preprocessing.avgLatencyMs;
preprocessing.errorRate;

// Adaptive pipeline metrics
adaptive.profileDistribution.fast;
adaptive.profileDistribution.balanced;
adaptive.profileDistribution.accurate;
adaptive.rerankingSkipRate;
adaptive.costSavingsPerDay;

// Accuracy metrics
accuracy.mrrBefore;
accuracy.mrrAfter;
accuracy.mrrDelta;

// Performance metrics
performance.p50LatencyMs;
performance.p95LatencyMs;
performance.p99LatencyMs;
```

### Rollback Plan

**Immediate Rollback (if critical issue):**

```bash
# Disable Phase 3 completely
kubectl set env deployment/search-ai-runtime \
  PREPROCESSING_ENABLED=false \
  ADAPTIVE_PIPELINE_ENABLED=false \
  PHASE3_ROLLOUT_PCT=0
```

**Partial Rollback (if specific stage problematic):**

```bash
# Disable only spell correction
kubectl set env deployment/search-ai-runtime \
  SPELL_CORRECTION_ENABLED=false
```

### Success Criteria

**Must Have (Blocking):**

- ✅ All tests passing (90%+ coverage)
- ✅ No MRR regression (≥ baseline)
- ✅ Preprocessing latency < 100ms (P95)
- ✅ Zero tenant data leakage
- ✅ Cost reduction 20%+ realized

**Target:**

- 🎯 MRR improvement +2-3%
- 🎯 Cost reduction 30-40%
- 🎯 Preprocessing accuracy: 95%+ (spell), 90%+ (entity)
- 🎯 User feedback: 80%+ positive sentiment

---

## Summary

All Phase 3 tasks now have complete implementation specifications:

**✅ Task 3.1:** Query preprocessor architecture (orchestrator, base interfaces, config)
**✅ Task 3.2:** Spell correction (SymSpell, custom dictionaries, < 10ms)
**✅ Task 3.3:** Synonym expansion (WordNet + custom, < 15ms)
**✅ Task 3.4:** Entity extraction (regex patterns, filter generation, < 20ms)
**✅ Task 3.5:** Adaptive pipeline design (types, config, profiles)
**✅ Task 3.6:** Complexity analysis (4 dimensions, 0-100 score, < 5ms)
**✅ Task 3.7:** Stage selection (profile, preprocessing, search, reranking, < 5ms)
**✅ Task 3.8:** Testing strategy (unit, integration, golden dataset, performance, cost)
**✅ Task 3.9:** Deployment plan (staging, beta, full rollout, monitoring, rollback)

**Ready to start implementation!**
