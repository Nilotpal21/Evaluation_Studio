# Phase 3 Implementation Specifications

**Detailed technical designs for all Phase 3 tasks**

---

## Task 3.1: Query Preprocessor Architecture

### File Structure

```
apps/search-ai-runtime/src/services/preprocessing/
├── preprocessor.ts                    # Main orchestrator
├── stages/
│   ├── base-stage.ts                  # Base interface
│   ├── spell-correction-stage.ts      # Task 3.2
│   ├── synonym-expansion-stage.ts     # Task 3.3
│   └── entity-extraction-stage.ts     # Task 3.4
├── types.ts                           # Shared types
├── config.ts                          # Configuration
└── __tests__/
    ├── preprocessor.test.ts
    └── integration.test.ts
```

### Core Types (`types.ts`)

```typescript
/**
 * Input to preprocessing pipeline
 */
export interface PreprocessingInput {
  query: string;
  tenantId: string;
  indexId: string;
  context?: {
    // Optional context from previous stages
    vocabularyEntities?: VocabularyEntity[];
    userProfile?: UserProfile;
  };
}

/**
 * Output from preprocessing pipeline
 */
export interface PreprocessedQuery {
  // Queries at different stages
  originalQuery: string;
  processedQuery: string; // Final query after all stages

  // Metadata from all stages
  metadata: PreprocessingMetadata;

  // Performance metrics
  metrics: {
    totalDurationMs: number;
    stageResults: StageResult[];
  };
}

/**
 * Metadata accumulated through preprocessing
 */
export interface PreprocessingMetadata {
  // Original input
  originalQuery: string;

  // Changes from each stage
  spellCorrections?: SpellCorrection[];
  synonymExpansions?: SynonymExpansion[];
  extractedEntities?: ExtractedEntity[];

  // Stage-specific metadata
  stages: {
    [stageName: string]: any;
  };
}

/**
 * Result from a single preprocessing stage
 */
export interface StageResult {
  stage: string;
  enabled: boolean;
  durationMs: number;
  changesCount: number;
  error?: string;
}

/**
 * Configuration for which stages to enable
 */
export interface StageSelectionConfig {
  enableSpellCorrection: boolean;
  enableSynonymExpansion: boolean;
  enableEntityExtraction: boolean;

  // Per-stage options
  spellCorrectionOptions?: SpellCorrectionOptions;
  synonymExpansionOptions?: SynonymExpansionOptions;
  entityExtractionOptions?: EntityExtractionOptions;
}
```

### Base Stage Interface (`stages/base-stage.ts`)

```typescript
/**
 * Base interface all preprocessing stages must implement
 */
export interface PreprocessorStage {
  /** Unique stage name */
  readonly name: string;

  /** Stage priority (lower = earlier in pipeline) */
  readonly priority: number;

  /**
   * Initialize stage resources (dictionaries, models, etc.)
   * Called once during service startup
   */
  initialize(): Promise<void>;

  /**
   * Process query through this stage
   * @returns Modified query + metadata
   */
  process(input: StageInput): Promise<StageOutput>;

  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;

  /**
   * Health check
   */
  isHealthy(): boolean;
}

/**
 * Input to a preprocessing stage
 */
export interface StageInput {
  query: string;
  tenantId: string;
  indexId: string;

  // Context from previous stages
  metadata: PreprocessingMetadata;

  // Stage-specific options
  options?: Record<string, any>;
}

/**
 * Output from a preprocessing stage
 */
export interface StageOutput {
  // Modified query (or original if no changes)
  query: string;

  // List of changes made
  changes: StageChange[];

  // Stage-specific metadata
  metadata: Record<string, any>;

  // Duration
  durationMs: number;
}

export interface StageChange {
  type: 'correction' | 'expansion' | 'extraction' | 'other';
  description: string;
  original?: string;
  modified?: string;
  confidence?: number;
}
```

### Main Orchestrator (`preprocessor.ts`)

```typescript
import { StructuredLogger } from '../metrics/structured-logger.js';
import type {
  PreprocessorStage,
  PreprocessingInput,
  PreprocessedQuery,
  StageSelectionConfig,
} from './types.js';

/**
 * Query Preprocessor - orchestrates preprocessing stages
 */
export class QueryPreprocessor {
  private stages: Map<string, PreprocessorStage> = new Map();
  private logger: StructuredLogger;
  private initialized = false;

  constructor(
    stages: PreprocessorStage[],
    private readonly logger: StructuredLogger = new StructuredLogger({
      component: 'QueryPreprocessor',
    }),
  ) {
    // Sort stages by priority
    const sorted = [...stages].sort((a, b) => a.priority - b.priority);

    for (const stage of sorted) {
      this.stages.set(stage.name, stage);
    }
  }

  /**
   * Initialize all stages
   * Call this during service startup
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger.info('Initializing preprocessing stages', {
      stageCount: this.stages.size,
      stages: Array.from(this.stages.keys()),
    });

    const initPromises = Array.from(this.stages.values()).map(async (stage) => {
      try {
        await stage.initialize();
        this.logger.debug(`Stage initialized: ${stage.name}`);
      } catch (error) {
        this.logger.error(`Stage initialization failed: ${stage.name}`, error);
        throw error;
      }
    });

    await Promise.all(initPromises);
    this.initialized = true;

    this.logger.info('All preprocessing stages initialized');
  }

  /**
   * Run preprocessing pipeline on a query
   */
  async preprocess(
    input: PreprocessingInput,
    config: StageSelectionConfig,
  ): Promise<PreprocessedQuery> {
    if (!this.initialized) {
      throw new Error('QueryPreprocessor not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    const stageResults: StageResult[] = [];

    let currentQuery = input.query;
    const metadata: PreprocessingMetadata = {
      originalQuery: input.query,
      stages: {},
    };

    this.logger.debug('Starting preprocessing', {
      query: input.query,
      tenantId: input.tenantId,
      indexId: input.indexId,
      enabledStages: this.getEnabledStageNames(config),
    });

    // Run stages in priority order
    for (const [stageName, stage] of this.stages) {
      const enabled = this.isStageEnabled(stageName, config);

      if (!enabled) {
        stageResults.push({
          stage: stageName,
          enabled: false,
          durationMs: 0,
          changesCount: 0,
        });
        continue;
      }

      // Run stage
      const stageStart = Date.now();
      try {
        const stageInput: StageInput = {
          query: currentQuery,
          tenantId: input.tenantId,
          indexId: input.indexId,
          metadata,
          options: this.getStageOptions(stageName, config),
        };

        const output = await stage.process(stageInput);
        const stageDuration = Date.now() - stageStart;

        // Update query
        currentQuery = output.query;

        // Accumulate metadata
        metadata.stages[stageName] = output.metadata;
        this.mergeStageMetadata(metadata, stageName, output);

        // Record result
        stageResults.push({
          stage: stageName,
          enabled: true,
          durationMs: stageDuration,
          changesCount: output.changes.length,
        });

        this.logger.debug(`Stage completed: ${stageName}`, {
          durationMs: stageDuration,
          changes: output.changes.length,
          queryChanged: output.query !== stageInput.query,
        });
      } catch (error) {
        const stageDuration = Date.now() - stageStart;

        this.logger.error(`Stage failed: ${stageName}`, error, {
          durationMs: stageDuration,
        });

        stageResults.push({
          stage: stageName,
          enabled: true,
          durationMs: stageDuration,
          changesCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });

        // Continue with next stage (preprocessing failures should not break pipeline)
      }
    }

    const totalDuration = Date.now() - startTime;

    this.logger.info('Preprocessing complete', {
      originalQuery: input.query,
      processedQuery: currentQuery,
      queryChanged: currentQuery !== input.query,
      totalDurationMs: totalDuration,
      stagesRun: stageResults.filter((r) => r.enabled).length,
      totalChanges: stageResults.reduce((sum, r) => sum + r.changesCount, 0),
    });

    return {
      originalQuery: input.query,
      processedQuery: currentQuery,
      metadata,
      metrics: {
        totalDurationMs: totalDuration,
        stageResults,
      },
    };
  }

  /**
   * Cleanup all stages
   */
  async cleanup(): Promise<void> {
    const cleanupPromises = Array.from(this.stages.values()).map((stage) =>
      stage.cleanup().catch((error) => {
        this.logger.error(`Stage cleanup failed: ${stage.name}`, error);
      }),
    );

    await Promise.all(cleanupPromises);
    this.initialized = false;
  }

  /**
   * Health check all stages
   */
  isHealthy(): boolean {
    return Array.from(this.stages.values()).every((stage) => stage.isHealthy());
  }

  // Helper methods

  private isStageEnabled(stageName: string, config: StageSelectionConfig): boolean {
    switch (stageName) {
      case 'spell_correction':
        return config.enableSpellCorrection;
      case 'synonym_expansion':
        return config.enableSynonymExpansion;
      case 'entity_extraction':
        return config.enableEntityExtraction;
      default:
        return false;
    }
  }

  private getStageOptions(
    stageName: string,
    config: StageSelectionConfig,
  ): Record<string, any> | undefined {
    switch (stageName) {
      case 'spell_correction':
        return config.spellCorrectionOptions;
      case 'synonym_expansion':
        return config.synonymExpansionOptions;
      case 'entity_extraction':
        return config.entityExtractionOptions;
      default:
        return undefined;
    }
  }

  private getEnabledStageNames(config: StageSelectionConfig): string[] {
    return Array.from(this.stages.keys()).filter((name) => this.isStageEnabled(name, config));
  }

  private mergeStageMetadata(
    metadata: PreprocessingMetadata,
    stageName: string,
    output: StageOutput,
  ): void {
    // Merge stage-specific collections
    if (stageName === 'spell_correction' && output.metadata.corrections) {
      metadata.spellCorrections = output.metadata.corrections;
    } else if (stageName === 'synonym_expansion' && output.metadata.expansions) {
      metadata.synonymExpansions = output.metadata.expansions;
    } else if (stageName === 'entity_extraction' && output.metadata.entities) {
      metadata.extractedEntities = output.metadata.entities;
    }
  }
}
```

### Configuration (`config.ts`)

```typescript
/**
 * Configuration for query preprocessing
 */
export interface PreprocessorConfig {
  // Global on/off
  enabled: boolean;

  // Stage configurations
  spellCorrection: SpellCorrectionConfig;
  synonymExpansion: SynonymExpansionConfig;
  entityExtraction: EntityExtractionConfig;

  // Performance limits
  maxTotalDurationMs: number; // Timeout for entire pipeline
  maxStageDurationMs: number; // Timeout per stage
}

export const DEFAULT_PREPROCESSOR_CONFIG: PreprocessorConfig = {
  enabled: true,

  spellCorrection: {
    enabled: true,
    maxEditDistance: 2,
    prefixLength: 7,
    dictionaryPath: './dictionaries/en_US.dict',
    customDictionaries: new Map(),
  },

  synonymExpansion: {
    enabled: true,
    maxSynonymsPerTerm: 3,
    strategy: 'conservative', // conservative | moderate | aggressive
    useWordNet: true,
    customSynonyms: new Map(),
  },

  entityExtraction: {
    enabled: true,
    entityTypes: ['date', 'number', 'email', 'url', 'currency'],
    customPatterns: [],
  },

  maxTotalDurationMs: 100, // 100ms budget total
  maxStageDurationMs: 50, // 50ms per stage max
};
```

### Factory Function

```typescript
/**
 * Create and initialize a QueryPreprocessor instance
 */
export async function createQueryPreprocessor(
  config: PreprocessorConfig,
): Promise<QueryPreprocessor> {
  const stages: PreprocessorStage[] = [];

  if (config.spellCorrection.enabled) {
    stages.push(new SpellCorrectionStage(config.spellCorrection));
  }

  if (config.synonymExpansion.enabled) {
    stages.push(new SynonymExpansionStage(config.synonymExpansion));
  }

  if (config.entityExtraction.enabled) {
    stages.push(new EntityExtractionStage(config.entityExtraction));
  }

  const preprocessor = new QueryPreprocessor(stages);
  await preprocessor.initialize();

  return preprocessor;
}
```

---

## Task 3.2: Spell Correction Implementation

### Technology Choice: SymSpell

**Why SymSpell?**

- **Fast**: O(1) lookup vs O(n²) for traditional algorithms
- **Accurate**: Handles up to 2 edit distance efficiently
- **Mature**: Battle-tested, npm package available (`symspell`)
- **Customizable**: Supports custom dictionaries

### File: `stages/spell-correction-stage.ts`

```typescript
import SymSpell from 'symspell';
import type { PreprocessorStage, StageInput, StageOutput, StageChange } from '../types.js';
import { StructuredLogger } from '../../metrics/structured-logger.js';
import * as fs from 'fs/promises';

export interface SpellCorrectionConfig {
  enabled: boolean;
  maxEditDistance: number; // 1 or 2 (2 is recommended)
  prefixLength: number; // 7 is optimal
  dictionaryPath: string; // Path to frequency dictionary
  customDictionaries: Map<string, Map<string, string>>; // Per-tenant custom terms
}

export interface SpellCorrection {
  original: string;
  corrected: string;
  confidence: number;
  editDistance: number;
}

/**
 * Spell correction using SymSpell algorithm
 */
export class SpellCorrectionStage implements PreprocessorStage {
  readonly name = 'spell_correction';
  readonly priority = 1; // Run first (before expansion)

  private symSpell: SymSpell;
  private logger: StructuredLogger;
  private healthy = false;

  // Proper nouns and technical terms to skip
  private skipTerms = new Set<string>([
    'API',
    'SDK',
    'JSON',
    'XML',
    'HTTP',
    'HTTPS',
    'REST',
    'GraphQL',
    'MongoDB',
    'PostgreSQL',
    'Redis',
    'Docker',
    'Kubernetes',
    // ... add more
  ]);

  constructor(private config: SpellCorrectionConfig) {
    this.symSpell = new SymSpell({
      maxDictionaryEditDistance: config.maxEditDistance,
      prefixLength: config.prefixLength,
    });
    this.logger = new StructuredLogger({ component: 'SpellCorrectionStage' });
  }

  async initialize(): Promise<void> {
    try {
      // Load base dictionary
      await this.loadBaseDictionary();

      // Load technical terms dictionary
      await this.loadTechnicalDictionary();

      this.healthy = true;
      this.logger.info('SpellCorrectionStage initialized');
    } catch (error) {
      this.logger.error('SpellCorrectionStage initialization failed', error);
      throw error;
    }
  }

  async process(input: StageInput): Promise<StageOutput> {
    const startTime = Date.now();
    const corrections: SpellCorrection[] = [];

    // Tokenize query
    const tokens = this.tokenize(input.query);

    // Check each token
    for (const token of tokens) {
      // Skip if:
      // - Too short
      // - Is a number
      // - Is in skip list
      // - Is an entity from previous stages
      if (this.shouldSkipToken(token, input.metadata)) {
        continue;
      }

      // Check custom dictionary first (exact match, per-tenant)
      const customDict = this.config.customDictionaries.get(input.tenantId);
      if (customDict?.has(token.text.toLowerCase())) {
        const corrected = customDict.get(token.text.toLowerCase())!;
        if (corrected !== token.text) {
          corrections.push({
            original: token.text,
            corrected,
            confidence: 1.0, // Custom dict = 100% confidence
            editDistance: 0,
          });
        }
        continue;
      }

      // Use SymSpell
      const suggestions = this.symSpell.lookup(
        token.text,
        SymSpell.Verbosity.Closest,
        this.config.maxEditDistance,
      );

      if (suggestions.length > 0) {
        const best = suggestions[0];

        // Only correct if edit distance > 0 (i.e., not in dictionary)
        if (best.distance > 0) {
          corrections.push({
            original: token.text,
            corrected: best.term,
            confidence: this.calculateConfidence(best.distance, best.count),
            editDistance: best.distance,
          });
        }
      }
    }

    // Apply corrections to query
    let correctedQuery = input.query;
    for (const correction of corrections) {
      // Use word boundary regex for accurate replacement
      const regex = new RegExp(`\\b${this.escapeRegex(correction.original)}\\b`, 'gi');
      correctedQuery = correctedQuery.replace(regex, correction.corrected);
    }

    const durationMs = Date.now() - startTime;

    const changes: StageChange[] = corrections.map((c) => ({
      type: 'correction',
      description: `Corrected typo: ${c.original} → ${c.corrected}`,
      original: c.original,
      modified: c.corrected,
      confidence: c.confidence,
    }));

    return {
      query: correctedQuery,
      changes,
      metadata: {
        corrections,
        correctionCount: corrections.length,
        avgConfidence: this.calculateAvgConfidence(corrections),
      },
      durationMs,
    };
  }

  async cleanup(): Promise<void> {
    // SymSpell doesn't need explicit cleanup
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // Private helper methods

  private async loadBaseDictionary(): Promise<void> {
    // Load frequency dictionary (format: "word frequency")
    const content = await fs.readFile(this.config.dictionaryPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const [term, freqStr] = line.split(' ');
      if (term && freqStr) {
        const frequency = parseInt(freqStr, 10);
        this.symSpell.createDictionaryEntry(term, frequency);
      }
    }

    this.logger.info('Base dictionary loaded', {
      entries: this.symSpell.wordCount(),
    });
  }

  private async loadTechnicalDictionary(): Promise<void> {
    // Add technical terms with high frequency (treated as correct)
    const technicalTerms = [
      ['kubernetes', 1000000],
      ['docker', 1000000],
      ['microservices', 500000],
      ['api', 1000000],
      ['json', 1000000],
      ['mongodb', 500000],
      ['postgresql', 500000],
      ['redis', 500000],
      // ... add more
    ];

    for (const [term, freq] of technicalTerms) {
      this.symSpell.createDictionaryEntry(term as string, freq as number);
    }

    this.logger.debug('Technical dictionary loaded', {
      terms: technicalTerms.length,
    });
  }

  private tokenize(query: string): Array<{ text: string; position: number }> {
    const tokens: Array<{ text: string; position: number }> = [];
    const regex = /\b[\w'-]+\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(query)) !== null) {
      tokens.push({
        text: match[0],
        position: match.index,
      });
    }

    return tokens;
  }

  private shouldSkipToken(
    token: { text: string; position: number },
    metadata: PreprocessingMetadata,
  ): boolean {
    const text = token.text;

    // Skip short tokens
    if (text.length < 3) return true;

    // Skip numbers
    if (/^\d+$/.test(text)) return true;

    // Skip uppercase acronyms (e.g., "API", "HTTP")
    if (/^[A-Z]+$/.test(text)) return true;

    // Skip if in skip list
    if (this.skipTerms.has(text)) return true;

    // Skip if it's an entity from previous extraction
    if (metadata.extractedEntities?.some((e) => e.text === text)) {
      return true;
    }

    return false;
  }

  private calculateConfidence(editDistance: number, frequency: number): number {
    // Higher frequency = higher confidence
    // Lower edit distance = higher confidence
    const distanceFactor = 1.0 - (editDistance / this.config.maxEditDistance) * 0.3;
    const frequencyFactor = Math.min(Math.log10(frequency + 1) / 7, 1.0);

    return distanceFactor * 0.7 + frequencyFactor * 0.3;
  }

  private calculateAvgConfidence(corrections: SpellCorrection[]): number {
    if (corrections.length === 0) return 1.0;
    return corrections.reduce((sum, c) => sum + c.confidence, 0) / corrections.length;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
```

### Dictionary Format

**Base Dictionary (`en_US.dict`):**

```
the 23135851162
of 13151942776
and 12997637966
to 12136980858
a 9081174698
in 8469404971
for 5933321709
is 4705743816
kubernetes 100000
docker 100000
...
```

Each line: `word frequency`

**Custom Dictionary API:**

```typescript
// Tenant-specific custom terms
interface CustomDictionary {
  tenantId: string;
  terms: Map<string, string>; // misspelling → correct term
}

// Example:
customDictionaries.set(
  'tenant-123',
  new Map([
    ['kubenetes', 'kubernetes'],
    ['docekr', 'docker'],
    ['pyhton', 'python'],
  ]),
);
```

### Test Cases

```typescript
describe('SpellCorrectionStage', () => {
  let stage: SpellCorrectionStage;

  beforeEach(async () => {
    stage = new SpellCorrectionStage({
      enabled: true,
      maxEditDistance: 2,
      prefixLength: 7,
      dictionaryPath: './test-data/dict.txt',
      customDictionaries: new Map(),
    });
    await stage.initialize();
  });

  test('corrects single typo', async () => {
    const input: StageInput = {
      query: 'kuberntes deployment',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: 'kuberntes deployment', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toBe('kubernetes deployment');
    expect(output.changes).toHaveLength(1);
    expect(output.changes[0].original).toBe('kuberntes');
    expect(output.changes[0].modified).toBe('kubernetes');
  });

  test('corrects multiple typos', async () => {
    const input: StageInput = {
      query: 'kuberntes deploiment stratagies',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toBe('kubernetes deployment strategies');
    expect(output.changes).toHaveLength(3);
  });

  test('skips proper nouns', async () => {
    const input: StageInput = {
      query: 'API HTTP JSON',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toBe('API HTTP JSON'); // Unchanged
    expect(output.changes).toHaveLength(0);
  });

  test('uses custom dictionary', async () => {
    const customDict = new Map([['kubes', 'kubernetes']]);
    stage = new SpellCorrectionStage({
      ...stage['config'],
      customDictionaries: new Map([['tenant-123', customDict]]),
    });
    await stage.initialize();

    const input: StageInput = {
      query: 'kubes pods',
      tenantId: 'tenant-123',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toBe('kubernetes pods');
    expect(output.metadata.corrections[0].confidence).toBe(1.0); // Custom = 100%
  });

  test('meets latency target', async () => {
    const longQuery = Array(50).fill('kubernetes').join(' ');

    const input: StageInput = {
      query: longQuery,
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.durationMs).toBeLessThan(10); // < 10ms target
  });
});
```

---

## Task 3.3: Synonym Expansion Implementation

### Technology Choice: Custom + WordNet Lite

**Approach:**

- **Custom dictionaries** for domain-specific synonyms (fast lookup)
- **WordNet Lite** for general English synonyms (pruned, essential only)
- **No heavy NLP** models (to meet latency target)

### File: `stages/synonym-expansion-stage.ts`

```typescript
import type { PreprocessorStage, StageInput, StageOutput, StageChange } from '../types.js';
import { StructuredLogger } from '../../metrics/structured-logger.js';
import * as fs from 'fs/promises';

export interface SynonymExpansionConfig {
  enabled: boolean;
  maxSynonymsPerTerm: number; // 2-3 recommended
  strategy: 'conservative' | 'moderate' | 'aggressive';
  useWordNet: boolean;
  customSynonyms: Map<string, Map<string, string[]>>; // Per-tenant synonyms
}

export interface SynonymExpansion {
  term: string;
  synonyms: string[];
  source: 'wordnet' | 'custom';
}

/**
 * Synonym expansion using WordNet + custom dictionaries
 */
export class SynonymExpansionStage implements PreprocessorStage {
  readonly name = 'synonym_expansion';
  readonly priority = 2; // After spell correction

  private wordNetSynonyms: Map<string, string[]> = new Map();
  private logger: StructuredLogger;
  private healthy = false;

  // Common technical abbreviations → full terms
  private technicalSynonyms = new Map<string, string[]>([
    ['k8s', ['kubernetes']],
    ['ml', ['machine learning', 'artificial intelligence']],
    ['ai', ['artificial intelligence', 'machine learning']],
    ['api', ['application programming interface', 'REST API', 'endpoint']],
    ['db', ['database', 'data store']],
    ['cli', ['command line', 'terminal', 'console']],
    ['ci', ['continuous integration', 'build automation']],
    ['cd', ['continuous deployment', 'continuous delivery']],
    // ... add more
  ]);

  constructor(private config: SynonymExpansionConfig) {
    this.logger = new StructuredLogger({ component: 'SynonymExpansionStage' });
  }

  async initialize(): Promise<void> {
    try {
      if (this.config.useWordNet) {
        await this.loadWordNetLite();
      }

      this.healthy = true;
      this.logger.info('SynonymExpansionStage initialized');
    } catch (error) {
      this.logger.error('SynonymExpansionStage initialization failed', error);
      throw error;
    }
  }

  async process(input: StageInput): Promise<StageOutput> {
    const startTime = Date.now();
    const expansions: SynonymExpansion[] = [];

    // Tokenize query
    const tokens = this.tokenize(input.query);

    // Find synonyms for each token
    for (const token of tokens) {
      if (this.shouldSkipToken(token)) {
        continue;
      }

      const synonyms = this.findSynonyms(token.text, input.tenantId);

      if (synonyms.length > 0) {
        expansions.push({
          term: token.text,
          synonyms,
          source: this.getSynonymSource(token.text, input.tenantId),
        });
      }
    }

    // Build expanded query
    const expandedQuery = this.buildExpandedQuery(input.query, expansions);

    const durationMs = Date.now() - startTime;

    const changes: StageChange[] = expansions.map((exp) => ({
      type: 'expansion',
      description: `Expanded: ${exp.term} → [${exp.synonyms.join(', ')}]`,
      original: exp.term,
      modified: exp.synonyms.join(' OR '),
      confidence: 0.8, // Synonym expansion is generally reliable
    }));

    return {
      query: expandedQuery,
      changes,
      metadata: {
        expansions,
        expansionCount: expansions.length,
        totalSynonymsAdded: expansions.reduce((sum, e) => sum + e.synonyms.length, 0),
      },
      durationMs,
    };
  }

  async cleanup(): Promise<void> {
    this.wordNetSynonyms.clear();
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // Private helper methods

  private async loadWordNetLite(): Promise<void> {
    // Load pruned WordNet (only most common synonyms)
    // Format: "word synonym1,synonym2,synonym3"

    const wordNetData = new Map<string, string[]>([
      // Common verbs
      ['find', ['discover', 'locate', 'search']],
      ['get', ['obtain', 'retrieve', 'fetch']],
      ['show', ['display', 'present', 'reveal']],
      ['create', ['make', 'generate', 'build']],
      ['delete', ['remove', 'destroy', 'erase']],
      ['update', ['modify', 'change', 'edit']],

      // Common nouns (domain-relevant)
      ['document', ['doc', 'file', 'page']],
      ['configuration', ['config', 'settings', 'setup']],
      ['error', ['failure', 'exception', 'bug']],
      ['service', ['daemon', 'process', 'server']],
      ['cluster', ['group', 'pool', 'ensemble']],

      // Adjectives
      ['quick', ['fast', 'rapid', 'speedy']],
      ['slow', ['sluggish', 'delayed', 'lagging']],
      ['simple', ['easy', 'basic', 'straightforward']],

      // ... add more (target ~1000 most common terms)
    ]);

    this.wordNetSynonyms = wordNetData;

    this.logger.info('WordNet Lite loaded', {
      terms: this.wordNetSynonyms.size,
    });
  }

  private tokenize(query: string): Array<{ text: string; position: number }> {
    const tokens: Array<{ text: string; position: number }> = [];
    const regex = /\b[\w'-]+\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(query)) !== null) {
      tokens.push({
        text: match[0].toLowerCase(),
        position: match.index,
      });
    }

    return tokens;
  }

  private shouldSkipToken(token: { text: string; position: number }): boolean {
    const text = token.text;

    // Skip short tokens
    if (text.length < 3) return true;

    // Skip numbers
    if (/^\d+$/.test(text)) return true;

    // Skip stopwords (they don't need expansion)
    const stopwords = new Set(['the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with']);
    if (stopwords.has(text)) return true;

    return false;
  }

  private findSynonyms(term: string, tenantId: string): string[] {
    // Check custom synonyms first (per-tenant)
    const customDict = this.config.customSynonyms.get(tenantId);
    if (customDict?.has(term)) {
      return customDict.get(term)! || [];
    }

    // Check technical synonyms
    if (this.technicalSynonyms.has(term)) {
      return this.technicalSynonyms.get(term)! || [];
    }

    // Check WordNet
    if (this.config.useWordNet && this.wordNetSynonyms.has(term)) {
      const allSynonyms = this.wordNetSynonyms.get(term)! || [];
      // Return top N synonyms based on strategy
      return allSynonyms.slice(0, this.getSynonymLimit());
    }

    return [];
  }

  private getSynonymSource(term: string, tenantId: string): 'wordnet' | 'custom' {
    const customDict = this.config.customSynonyms.get(tenantId);
    if (customDict?.has(term) || this.technicalSynonyms.has(term)) {
      return 'custom';
    }
    return 'wordnet';
  }

  private getSynonymLimit(): number {
    switch (this.config.strategy) {
      case 'conservative':
        return 2; // Only top 2 synonyms
      case 'moderate':
        return 3; // Top 3 (default)
      case 'aggressive':
        return 5; // Up to 5 synonyms
      default:
        return this.config.maxSynonymsPerTerm;
    }
  }

  private buildExpandedQuery(originalQuery: string, expansions: SynonymExpansion[]): string {
    if (expansions.length === 0) {
      return originalQuery;
    }

    // Strategy: Add OR clauses for expanded terms
    // Example: "k8s pods" → "k8s pods (k8s OR kubernetes) (pods OR containers)"

    const expansionClauses = expansions
      .map((exp) => {
        const terms = [exp.term, ...exp.synonyms];
        return `(${terms.join(' OR ')})`;
      })
      .join(' ');

    return `${originalQuery} ${expansionClauses}`;
  }
}
```

### Custom Synonym API

```typescript
// Tenant-specific synonyms
interface TenantSynonyms {
  tenantId: string;
  synonyms: Map<string, string[]>;
}

// Example:
const ecommerceSynonyms = new Map([
  ['buy', ['purchase', 'order', 'checkout']],
  ['cheap', ['affordable', 'budget', 'discount', 'sale']],
  ['expensive', ['premium', 'luxury', 'high-end']],
]);

const devOpsSynonyms = new Map([
  ['deploy', ['release', 'rollout', 'publish']],
  ['build', ['compile', 'package', 'assemble']],
  ['monitor', ['observe', 'track', 'watch']],
]);
```

### Test Cases

```typescript
describe('SynonymExpansionStage', () => {
  let stage: SynonymExpansionStage;

  beforeEach(async () => {
    stage = new SynonymExpansionStage({
      enabled: true,
      maxSynonymsPerTerm: 3,
      strategy: 'moderate',
      useWordNet: true,
      customSynonyms: new Map(),
    });
    await stage.initialize();
  });

  test('expands technical abbreviation', async () => {
    const input: StageInput = {
      query: 'k8s pods',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: 'k8s pods', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toContain('kubernetes');
    expect(output.changes).toHaveLength(1);
    expect(output.metadata.expansions[0].term).toBe('k8s');
    expect(output.metadata.expansions[0].synonyms).toContain('kubernetes');
  });

  test('expands multiple terms', async () => {
    const input: StageInput = {
      query: 'find api docs',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.changes.length).toBeGreaterThan(0);
    expect(output.query).toContain('OR'); // Has OR clauses
  });

  test('respects maxSynonymsPerTerm', async () => {
    stage = new SynonymExpansionStage({
      ...stage['config'],
      maxSynonymsPerTerm: 2,
    });
    await stage.initialize();

    const input: StageInput = {
      query: 'api',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    if (output.metadata.expansions.length > 0) {
      expect(output.metadata.expansions[0].synonyms.length).toBeLessThanOrEqual(2);
    }
  });

  test('skips stopwords', async () => {
    const input: StageInput = {
      query: 'the and or',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toBe('the and or'); // Unchanged
    expect(output.changes).toHaveLength(0);
  });

  test('uses custom synonyms', async () => {
    const customSyns = new Map([['deploy', ['release', 'rollout']]]);
    stage = new SynonymExpansionStage({
      ...stage['config'],
      customSynonyms: new Map([['tenant-123', customSyns]]),
    });
    await stage.initialize();

    const input: StageInput = {
      query: 'deploy app',
      tenantId: 'tenant-123',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.query).toContain('release');
    expect(output.query).toContain('rollout');
  });

  test('meets latency target', async () => {
    const input: StageInput = {
      query: 'find api docs quickly',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.durationMs).toBeLessThan(15); // < 15ms target
  });
});
```

---

## Task 3.4: Entity Extraction Implementation

### Technology Choice: Regex + Custom Patterns

**Approach:**

- **Regex patterns** for structured entities (dates, numbers, IDs, etc.)
- **No heavy NLP** (keeps latency low)
- **Configurable patterns** per tenant for domain-specific entities

### File: `stages/entity-extraction-stage.ts`

```typescript
import type { PreprocessorStage, StageInput, StageOutput, StageChange } from '../types.js';
import { StructuredLogger } from '../../metrics/structured-logger.js';

export interface EntityExtractionConfig {
  enabled: boolean;
  entityTypes: string[]; // ['date', 'number', 'email', 'url', 'currency', 'id']
  customPatterns: EntityPattern[]; // Tenant-specific patterns
}

export interface EntityPattern {
  name: string;
  pattern: RegExp;
  type: string;
  normalize?: (match: string) => any;
}

export interface ExtractedEntity {
  type: string;
  text: string;
  value: any; // Normalized value
  position: number;
  confidence: number;
  filter?: StructuredFilter; // Auto-generated filter
}

export interface StructuredFilter {
  field: string;
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'range' | 'match';
  value: any;
}

/**
 * Entity extraction using regex patterns
 */
export class EntityExtractionStage implements PreprocessorStage {
  readonly name = 'entity_extraction';
  readonly priority = 3; // After spell correction and synonym expansion

  private patterns: Map<string, EntityPattern[]> = new Map();
  private logger: StructuredLogger;
  private healthy = false;

  constructor(private config: EntityExtractionConfig) {
    this.logger = new StructuredLogger({ component: 'EntityExtractionStage' });
  }

  async initialize(): Promise<void> {
    try {
      // Initialize built-in patterns
      this.initializeBuiltInPatterns();

      // Add custom patterns
      for (const pattern of this.config.customPatterns) {
        this.addPattern(pattern);
      }

      this.healthy = true;
      this.logger.info('EntityExtractionStage initialized', {
        patternCount: Array.from(this.patterns.values()).flat().length,
      });
    } catch (error) {
      this.logger.error('EntityExtractionStage initialization failed', error);
      throw error;
    }
  }

  async process(input: StageInput): Promise<StageOutput> {
    const startTime = Date.now();
    const entities: ExtractedEntity[] = [];

    // Extract entities by type
    for (const type of this.config.entityTypes) {
      const typePatterns = this.patterns.get(type) || [];

      for (const pattern of typePatterns) {
        const matches = this.extractMatches(input.query, pattern);
        entities.push(...matches);
      }
    }

    // Generate filters from entities
    const filters = this.generateFilters(entities);

    const durationMs = Date.now() - startTime;

    const changes: StageChange[] = entities.map((entity) => ({
      type: 'extraction',
      description: `Extracted ${entity.type}: ${entity.text}`,
      original: entity.text,
      confidence: entity.confidence,
    }));

    return {
      query: input.query, // Original query preserved
      changes,
      metadata: {
        entities,
        filters,
        entityCount: entities.length,
        filterCount: filters.length,
      },
      durationMs,
    };
  }

  async cleanup(): Promise<void> {
    this.patterns.clear();
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // Private helper methods

  private initializeBuiltInPatterns(): void {
    // Date patterns
    this.patterns.set('date', [
      {
        name: 'iso_date',
        pattern: /\b\d{4}-\d{2}-\d{2}\b/g,
        type: 'date',
        normalize: (match) => new Date(match).toISOString(),
      },
      {
        name: 'us_date',
        pattern: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
        type: 'date',
        normalize: (match) => {
          const [month, day, year] = match.split('/').map(Number);
          return new Date(year, month - 1, day).toISOString();
        },
      },
      {
        name: 'relative_date',
        pattern: /\b(last|this|next)\s+(week|month|quarter|year)\b/gi,
        type: 'date',
        normalize: (match) => this.normalizeRelativeDate(match),
      },
      {
        name: 'quarter',
        pattern: /\bQ[1-4]\s+\d{4}\b/gi,
        type: 'date',
        normalize: (match) => this.normalizeQuarter(match),
      },
    ]);

    // Number patterns
    this.patterns.set('number', [
      {
        name: 'number_with_unit',
        pattern: /\b\d+(?:\.\d+)?[KMB]\b/gi,
        type: 'number',
        normalize: (match) => this.normalizeNumber(match),
      },
      {
        name: 'comparison',
        pattern: /[><]=?\s*\d+(?:\.\d+)?/g,
        type: 'number',
        normalize: (match) => this.parseComparison(match),
      },
    ]);

    // Currency patterns
    this.patterns.set('currency', [
      {
        name: 'currency',
        pattern: /[$€£¥]\d+(?:\.\d{2})?(?:[KMB])?/gi,
        type: 'currency',
        normalize: (match) => this.normalizeCurrency(match),
      },
    ]);

    // Email patterns
    this.patterns.set('email', [
      {
        name: 'email',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        type: 'email',
        normalize: (match) => match.toLowerCase(),
      },
    ]);

    // URL patterns
    this.patterns.set('url', [
      {
        name: 'url',
        pattern: /https?:\/\/[^\s]+/gi,
        type: 'url',
        normalize: (match) => match,
      },
    ]);

    // ID patterns (common formats)
    this.patterns.set('id', [
      {
        name: 'uuid',
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        type: 'id',
        normalize: (match) => match.toLowerCase(),
      },
      {
        name: 'prefixed_id',
        pattern: /\b[A-Z]+-\d+\b/g,
        type: 'id',
        normalize: (match) => match,
      },
    ]);
  }

  private extractMatches(query: string, pattern: EntityPattern): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    let match: RegExpExecArray | null;

    // Reset regex lastIndex
    pattern.pattern.lastIndex = 0;

    while ((match = pattern.pattern.exec(query)) !== null) {
      const text = match[0];
      const normalized = pattern.normalize ? pattern.normalize(text) : text;

      entities.push({
        type: pattern.type,
        text,
        value: normalized,
        position: match.index,
        confidence: 0.9, // High confidence for regex matches
        filter: this.createFilter(pattern.type, normalized),
      });
    }

    return entities;
  }

  private createFilter(entityType: string, value: any): StructuredFilter | undefined {
    switch (entityType) {
      case 'date':
        if (typeof value === 'object' && 'start' in value && 'end' in value) {
          return {
            field: 'timestamp',
            operator: 'range',
            value: { gte: value.start, lte: value.end },
          };
        } else {
          return {
            field: 'timestamp',
            operator: 'eq',
            value,
          };
        }

      case 'number':
        if (typeof value === 'object' && 'operator' in value) {
          return {
            field: 'value',
            operator: value.operator,
            value: value.value,
          };
        }
        return undefined;

      case 'email':
        return {
          field: 'email',
          operator: 'match',
          value,
        };

      case 'currency':
        if (typeof value === 'object') {
          return {
            field: 'price',
            operator: 'eq',
            value: value.amount,
          };
        }
        return undefined;

      default:
        return undefined;
    }
  }

  private generateFilters(entities: ExtractedEntity[]): StructuredFilter[] {
    return entities.map((e) => e.filter).filter((f): f is StructuredFilter => f !== undefined);
  }

  private addPattern(pattern: EntityPattern): void {
    const existing = this.patterns.get(pattern.type) || [];
    existing.push(pattern);
    this.patterns.set(pattern.type, existing);
  }

  // Normalization helpers

  private normalizeRelativeDate(text: string): { start: string; end: string } {
    const now = new Date();
    const lowerText = text.toLowerCase();

    if (lowerText.includes('last week')) {
      const start = new Date(now);
      start.setDate(now.getDate() - 7);
      return {
        start: start.toISOString(),
        end: now.toISOString(),
      };
    }

    if (lowerText.includes('last month')) {
      const start = new Date(now);
      start.setMonth(now.getMonth() - 1);
      return {
        start: start.toISOString(),
        end: now.toISOString(),
      };
    }

    // ... more relative date handling

    return { start: now.toISOString(), end: now.toISOString() };
  }

  private normalizeQuarter(text: string): { start: string; end: string } {
    // "Q1 2024" → { start: "2024-01-01", end: "2024-03-31" }
    const match = text.match(/Q([1-4])\s+(\d{4})/i);
    if (!match) {
      throw new Error(`Invalid quarter format: ${text}`);
    }

    const quarter = parseInt(match[1], 10);
    const year = parseInt(match[2], 10);

    const quarterStarts = [
      { month: 0, day: 1 },
      { month: 3, day: 1 },
      { month: 6, day: 1 },
      { month: 9, day: 1 },
    ];

    const quarterEnds = [
      { month: 2, day: 31 },
      { month: 5, day: 30 },
      { month: 8, day: 30 },
      { month: 11, day: 31 },
    ];

    const start = new Date(year, quarterStarts[quarter - 1].month, quarterStarts[quarter - 1].day);
    const end = new Date(year, quarterEnds[quarter - 1].month, quarterEnds[quarter - 1].day);

    return {
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  private normalizeNumber(text: string): number {
    // "100K" → 100000, "2.5M" → 2500000
    const multipliers: Record<string, number> = {
      K: 1_000,
      M: 1_000_000,
      B: 1_000_000_000,
    };

    const match = text.match(/^(\d+(?:\.\d+)?)([KMB])$/i);
    if (match) {
      const num = parseFloat(match[1]);
      const multiplier = multipliers[match[2].toUpperCase()];
      return num * multiplier;
    }

    return parseFloat(text);
  }

  private parseComparison(text: string): { operator: string; value: number } {
    // "> 100" → { operator: "gt", value: 100 }
    const match = text.match(/^([><]=?)\s*(\d+(?:\.\d+)?)$/);
    if (!match) {
      throw new Error(`Invalid comparison: ${text}`);
    }

    const operatorMap: Record<string, string> = {
      '>': 'gt',
      '>=': 'gte',
      '<': 'lt',
      '<=': 'lte',
    };

    return {
      operator: operatorMap[match[1]],
      value: parseFloat(match[2]),
    };
  }

  private normalizeCurrency(text: string): { currency: string; amount: number } {
    // "$100" → { currency: "USD", amount: 100 }
    const currencyMap: Record<string, string> = {
      $: 'USD',
      '€': 'EUR',
      '£': 'GBP',
      '¥': 'JPY',
    };

    const symbol = text[0];
    const amountStr = text.slice(1);
    const amount = this.normalizeNumber(amountStr);

    return {
      currency: currencyMap[symbol] || 'USD',
      amount,
    };
  }
}
```

### Test Cases

```typescript
describe('EntityExtractionStage', () => {
  let stage: EntityExtractionStage;

  beforeEach(async () => {
    stage = new EntityExtractionStage({
      enabled: true,
      entityTypes: ['date', 'number', 'email', 'url', 'currency', 'id'],
      customPatterns: [],
    });
    await stage.initialize();
  });

  test('extracts ISO date', async () => {
    const input: StageInput = {
      query: 'logs from 2024-01-15',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.entities).toHaveLength(1);
    expect(output.metadata.entities[0].type).toBe('date');
    expect(output.metadata.entities[0].text).toBe('2024-01-15');
  });

  test('extracts quarter', async () => {
    const input: StageInput = {
      query: 'Q1 2024 revenue',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.entities).toHaveLength(1);
    expect(output.metadata.entities[0].type).toBe('date');
    expect(output.metadata.entities[0].value).toHaveProperty('start');
    expect(output.metadata.entities[0].value.start).toContain('2024-01-01');
  });

  test('extracts number with comparison', async () => {
    const input: StageInput = {
      query: 'errors > 100',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.entities).toHaveLength(1);
    expect(output.metadata.entities[0].type).toBe('number');
    expect(output.metadata.entities[0].value).toEqual({ operator: 'gt', value: 100 });
  });

  test('extracts currency', async () => {
    const input: StageInput = {
      query: 'revenue $100K',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.entities).toHaveLength(1);
    expect(output.metadata.entities[0].type).toBe('currency');
    expect(output.metadata.entities[0].value.amount).toBe(100000);
  });

  test('extracts email', async () => {
    const input: StageInput = {
      query: 'user@example.com messages',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.entities).toHaveLength(1);
    expect(output.metadata.entities[0].type).toBe('email');
    expect(output.metadata.entities[0].text).toBe('user@example.com');
  });

  test('generates filters from entities', async () => {
    const input: StageInput = {
      query: 'logs from 2024-01-15 with errors > 100',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.metadata.filters.length).toBeGreaterThan(0);
    expect(output.metadata.filters).toContainEqual(
      expect.objectContaining({
        field: 'timestamp',
        operator: 'eq',
      }),
    );
  });

  test('meets latency target', async () => {
    const input: StageInput = {
      query: 'Q1 2024 revenue > $100K for user@example.com',
      tenantId: 'test',
      indexId: 'idx-1',
      metadata: { originalQuery: '', stages: {} },
    };

    const output = await stage.process(input);

    expect(output.durationMs).toBeLessThan(20); // < 20ms target
  });
});
```

---

Due to length constraints, I'll continue with the remaining tasks in a follow-up message. Would you like me to continue with:

- Task 3.5: Adaptive Pipeline Selector Design
- Task 3.6: Query Complexity Analysis
- Task 3.7: Adaptive Stage Selection
- Tasks 3.8 & 3.9: Testing and Deployment
