/**
 * NLU Engine
 *
 * Main entry point for the modular, contextual, multi-lingual NLU engine.
 * Orchestrates the full NLU pipeline: plugins → embeddings → LLM → fallback.
 */

import type {
  NLUEngineConfig,
  NLUContext,
  NLUTask,
  NLULayer,
  NLUModelLayerConfig,
  IntentResult,
  SubIntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  DigressionResult,
  LanguageResult,
  AnalysisResult,
  AnalyzeOptions,
  IntentCandidate,
  SubIntentCandidate,
  CategoryDefinition,
  EntityField,
  DigressionCandidate,
  IntentDefinition,
  EntityDefinition,
  NLUPredictionEvent,
  LLMProvider,
  NLUIRConfig,
} from './types.js';
import type { LLMClient } from '../constructs/types.js';
import type { AgentIR } from '../ir/schema.js';
import type { SimilarityMatch } from './embeddings/types.js';
import { ModelRouter } from './model-router.js';
import { NLUPluginPipeline } from './plugins.js';
import { renderTemplate, loadPromptTemplate } from './prompt-loader.js';
import { detectLanguage as detectLangLLM } from './language.js';
import {
  detectIntentFallback,
  classifyCategoryFallback,
  extractEntitiesFallback,
  detectCorrectionFallback,
  detectLanguageFallback,
} from './fallbacks.js';
import { parseJSON } from './utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('nlu-engine');

// =============================================================================
// NLU ENGINE
// =============================================================================

export class NLUEngine {
  private config: NLUEngineConfig;
  private router: ModelRouter;
  private plugins: NLUPluginPipeline;
  private embeddingIntentIndex?: EmbeddingIntentIndex;

  // Dynamic intents/categories/entities (registered at runtime)
  private dynamicIntents: IntentDefinition[] = [];
  private dynamicCategories: CategoryDefinition[] = [];
  private dynamicEntities: EntityDefinition[] = [];

  constructor(config: NLUEngineConfig) {
    this.config = config;
    this.router = new ModelRouter(config);
    this.plugins = new NLUPluginPipeline(config.plugins);
  }

  // =========================================================================
  // CORE NLU METHODS
  // =========================================================================

  /**
   * Detect primary intent from user message
   */
  async detectIntent(ctx: NLUContext, candidates: IntentCandidate[]): Promise<IntentResult> {
    const task: NLUTask = 'intent_detection';
    const startTime = Date.now();

    // 1. Plugin pre-process
    const pluginResult = await this.plugins.preProcess(ctx, task);
    if (pluginResult?.intent) {
      this.recordMetric(
        ctx,
        task,
        pluginResult.intent,
        pluginResult.confidence,
        'plugin',
        Date.now() - startTime,
        'plugin',
      );
      return { intent: pluginResult.intent, confidence: pluginResult.confidence, source: 'plugin' };
    }

    // 2. Embedding match (if available)
    if (this.embeddingIntentIndex) {
      const multiIntentConfig = this.config.multiIntent;
      const useTopN = multiIntentConfig?.enabled && this.embeddingIntentIndex.matchTopN;

      if (useTopN) {
        // Multi-intent: get top-N matches and populate alternatives
        const maxIntents = multiIntentConfig.maxIntents ?? 3;
        const altThreshold = multiIntentConfig.confidenceThreshold ?? 0.6;
        const primaryThreshold = this.config.embeddings?.threshold ?? 0.85;

        const topMatches = await this.embeddingIntentIndex.matchTopN!(ctx.userMessage, maxIntents);

        if (topMatches.length > 0 && topMatches[0].score >= primaryThreshold) {
          // Deduplicate by intent label — keep highest score per unique intent
          const seen = new Set<string>();
          const uniqueMatches: SimilarityMatch[] = [];
          for (const m of topMatches) {
            if (!seen.has(m.label)) {
              seen.add(m.label);
              uniqueMatches.push(m);
            }
          }

          const primary: IntentResult = {
            intent: uniqueMatches[0].label,
            confidence: uniqueMatches[0].score,
            source: 'embedding',
            alternatives: uniqueMatches
              .slice(1)
              .filter((m) => m.score >= altThreshold)
              .map((m) => ({ intent: m.label, confidence: m.score })),
          };

          this.recordMetric(
            ctx,
            task,
            primary.intent,
            primary.confidence,
            'embedding',
            Date.now() - startTime,
            'embedding',
          );
          return (await this.plugins.postProcess(ctx, task, primary)) as IntentResult;
        }
      } else {
        // Single-intent fallback: use original match method
        const embResult = await this.embeddingIntentIndex.match(ctx.userMessage);
        if (embResult && embResult.confidence >= (this.config.embeddings?.threshold ?? 0.85)) {
          this.recordMetric(
            ctx,
            task,
            embResult.intent,
            embResult.confidence,
            'embedding',
            Date.now() - startTime,
            'embedding',
          );
          return (await this.plugins.postProcess(ctx, task, embResult)) as IntentResult;
        }
      }
    }

    // 3. LLM-based intent detection
    const { primary, primaryLayer, fallback, fallbackLayer } = this.router.getLayerForTask(task);

    const llmResult = await this.detectIntentWithLLM(ctx, candidates, primary);
    if (llmResult && llmResult.confidence >= this.router.getConfidenceThreshold()) {
      this.recordMetric(
        ctx,
        task,
        llmResult.intent,
        llmResult.confidence,
        primaryLayer,
        Date.now() - startTime,
        primary.model,
      );
      const intentResult = { ...llmResult, source: primaryLayer };
      return (await this.plugins.postProcess(ctx, task, intentResult)) as IntentResult;
    }

    // 4. Fallback to balanced layer if available
    if (fallback && fallbackLayer) {
      const balancedResult = await this.detectIntentWithLLM(ctx, candidates, fallback);
      if (balancedResult && balancedResult.confidence >= this.router.getConfidenceThreshold()) {
        this.recordMetric(
          ctx,
          task,
          balancedResult.intent,
          balancedResult.confidence,
          fallbackLayer,
          Date.now() - startTime,
          fallback.model,
        );
        const intentResult = { ...balancedResult, source: fallbackLayer };
        return (await this.plugins.postProcess(ctx, task, intentResult)) as IntentResult;
      }
    }

    // 5. Regex/keyword fallback
    if (this.router.isFallbackEnabled()) {
      const regexResult = detectIntentFallback(ctx.userMessage, candidates);
      this.recordMetric(
        ctx,
        task,
        regexResult.intent,
        regexResult.confidence,
        'fallback',
        Date.now() - startTime,
        'regex',
      );
      return (await this.plugins.postProcess(ctx, task, regexResult)) as IntentResult;
    }

    const defaultResult: IntentResult = { intent: null, confidence: 0, source: 'fallback' };
    return (await this.plugins.postProcess(ctx, task, defaultResult)) as IntentResult;
  }

  /**
   * Detect sub-intent within current flow step
   */
  async detectSubIntent(
    ctx: NLUContext,
    parentIntent: string,
    subIntents: SubIntentCandidate[],
  ): Promise<SubIntentResult> {
    // Convert sub-intents to intent candidates for reuse
    const candidates: IntentCandidate[] = subIntents.map((s) => ({
      name: s.name,
      patterns: s.patterns || [s.name],
    }));

    // detectIntent already records its own metric, no need to double-record
    const result = await this.detectIntent(ctx, candidates);

    return {
      subIntent: result.intent,
      confidence: result.confidence,
      source: result.source,
    };
  }

  /**
   * Classify message category (greeting, farewell, confirmation, denial, escalation)
   */
  async classifyCategory(
    ctx: NLUContext,
    categories: CategoryDefinition[],
  ): Promise<CategoryResult> {
    const task: NLUTask = 'category_classification';
    const startTime = Date.now();

    // 1. Plugin pre-process
    const pluginResult = await this.plugins.preProcess(ctx, task);
    if (pluginResult?.category) {
      return {
        category: pluginResult.category,
        confidence: pluginResult.confidence,
        source: 'plugin',
      };
    }

    // 2. LLM classification
    const { primary, primaryLayer } = this.router.getLayerForTask(task);

    try {
      const template = loadPromptTemplate('category');
      const vars = this.buildTemplateVars(ctx, {
        categories: categories.map((c) => `- ${c.name}: ${c.patterns.join(', ')}`).join('\n'),
      });
      const systemPrompt = renderTemplate(template.system, vars);

      const response = await primary.provider.chat(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        { model: primary.model, timeoutMs: primary.timeoutMs ?? 2000 },
      );

      const parsed = parseJSON<{ category: string; confidence: number }>(response);
      if (parsed && parsed.category && parsed.category !== 'none') {
        this.recordMetric(
          ctx,
          task,
          parsed.category,
          parsed.confidence,
          primaryLayer,
          Date.now() - startTime,
          primary.model,
        );
        const catResult: CategoryResult = {
          category: parsed.category,
          confidence: parsed.confidence ?? 0.8,
          source: primaryLayer,
        };
        return (await this.plugins.postProcess(ctx, task, catResult)) as CategoryResult;
      }
    } catch (error) {
      log.warn('Category classification via LLM failed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Regex fallback
    if (this.router.isFallbackEnabled()) {
      const fbResult = classifyCategoryFallback(ctx.userMessage, categories);
      return (await this.plugins.postProcess(ctx, task, fbResult)) as CategoryResult;
    }

    const defaultResult: CategoryResult = { category: null, confidence: 0, source: 'fallback' };
    return (await this.plugins.postProcess(ctx, task, defaultResult)) as CategoryResult;
  }

  /**
   * Extract entities from user message
   */
  async extractEntities(ctx: NLUContext, fields: EntityField[]): Promise<EntityResult> {
    const task: NLUTask = 'entity_extraction';
    const startTime = Date.now();

    // 1. Plugin pre-process
    const pluginResult = await this.plugins.preProcess(ctx, task);
    if (pluginResult?.values) {
      return {
        values: pluginResult.values,
        missing: fields
          .filter((f) => pluginResult.values![f.name] === undefined)
          .map((f) => f.name),
        confidence: Object.fromEntries(
          Object.keys(pluginResult.values).map((k) => [k, pluginResult.confidence]),
        ),
        source: 'plugin',
      };
    }

    // 2. LLM extraction
    const { primary, primaryLayer } = this.router.getLayerForTask(task);

    try {
      const template = loadPromptTemplate('entity');
      const entityFieldsStr = fields
        .map((f) => {
          let desc = `- ${f.name} (${f.type || 'string'})`;
          if (f.prompt) desc += `: ${f.prompt}`;
          if (f.values) desc += ` [allowed: ${f.values.join(', ')}]`;
          if (f.synonyms) {
            const synStr = Object.entries(f.synonyms)
              .map(([k, v]) => `${k}=${v.join('/')}`)
              .join(', ');
            desc += ` [synonyms: ${synStr}]`;
          }
          return desc;
        })
        .join('\n');

      // Build entity definition descriptions
      const entityDefs = ctx.declaredEntities
        ?.map((e) => {
          let desc = `- ${e.name} (${e.type})`;
          if (e.values) desc += `: ${e.values.join(', ')}`;
          if (e.synonyms) {
            const synStr = Object.entries(e.synonyms)
              .map(([k, v]) => `${k}=${v.join('/')}`)
              .join('; ');
            desc += ` [synonyms: ${synStr}]`;
          }
          return desc;
        })
        .join('\n');

      const vars = this.buildTemplateVars(ctx, {
        entityFields: entityFieldsStr,
        entityDefinitions: entityDefs,
      });
      const systemPrompt = renderTemplate(template.system, vars);

      const schema = `{${fields.map((f) => `"${f.name}": "value or null"`).join(', ')}}`;

      let result: Record<string, unknown>;

      if (primary.provider.extractJson) {
        result = await primary.provider.extractJson(
          systemPrompt,
          [{ role: 'user', content: ctx.userMessage }],
          schema,
          { model: primary.model, timeoutMs: primary.timeoutMs ?? 3000 },
        );
      } else {
        const response = await primary.provider.chat(
          systemPrompt,
          [{ role: 'user', content: ctx.userMessage }],
          { model: primary.model, timeoutMs: primary.timeoutMs ?? 3000 },
        );
        result = parseJSON<Record<string, unknown>>(response) || {};
      }

      // Filter nulls
      const values: Record<string, unknown> = {};
      const confidence: Record<string, number> = {};
      for (const [key, value] of Object.entries(result)) {
        if (value !== null && value !== undefined && value !== 'null') {
          values[key] = value;
          confidence[key] = 0.8;
        }
      }

      const missing = fields.filter((f) => values[f.name] === undefined).map((f) => f.name);

      this.recordMetric(
        ctx,
        task,
        values,
        0.8,
        primaryLayer,
        Date.now() - startTime,
        primary.model,
      );
      const entityResult: EntityResult = { values, missing, confidence, source: primaryLayer };
      return (await this.plugins.postProcess(ctx, task, entityResult)) as EntityResult;
    } catch (error) {
      log.warn('Entity extraction via LLM failed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Pattern fallback
    if (this.router.isFallbackEnabled()) {
      const entityDefs = ctx.declaredEntities || [];
      const fbResult = extractEntitiesFallback(ctx.userMessage, fields, entityDefs);
      return (await this.plugins.postProcess(ctx, task, fbResult)) as EntityResult;
    }

    const defaultResult: EntityResult = {
      values: {},
      missing: fields.map((f) => f.name),
      confidence: {},
      source: 'fallback',
    };
    return (await this.plugins.postProcess(ctx, task, defaultResult)) as EntityResult;
  }

  /**
   * Detect if user is correcting a previous value
   */
  async detectCorrection(
    ctx: NLUContext,
    collected: Record<string, unknown>,
  ): Promise<CorrectionResult> {
    const task: NLUTask = 'correction_detection';
    const startTime = Date.now();

    // 1. Plugin pre-process
    const pluginResult = await this.plugins.preProcess(ctx, task);
    if (pluginResult) {
      return {
        detected: true,
        field: pluginResult.intent,
        newValue: pluginResult.values?.newValue,
        confidence: pluginResult.confidence,
        source: 'plugin',
      };
    }

    // 2. LLM detection
    const { primary, primaryLayer } = this.router.getLayerForTask(task);

    try {
      const template = loadPromptTemplate('correction');
      const vars = this.buildTemplateVars(ctx, {
        collectedData: JSON.stringify(collected, null, 2),
      });
      const systemPrompt = renderTemplate(template.system, vars);

      const response = await primary.provider.chat(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        { model: primary.model, timeoutMs: primary.timeoutMs ?? 2000 },
      );

      const parsed = parseJSON<{
        detected: boolean;
        field?: string;
        newValue?: unknown;
        confidence?: number;
      }>(response);

      if (parsed) {
        this.recordMetric(
          ctx,
          task,
          parsed,
          parsed.confidence ?? 0.8,
          primaryLayer,
          Date.now() - startTime,
          primary.model,
        );
        const corrResult: CorrectionResult = {
          detected: parsed.detected,
          field: parsed.field || undefined,
          newValue: parsed.newValue,
          oldValue: parsed.field ? collected[parsed.field] : undefined,
          confidence: parsed.confidence ?? 0.8,
          source: primaryLayer,
        };
        return (await this.plugins.postProcess(ctx, task, corrResult)) as CorrectionResult;
      }
    } catch (error) {
      log.warn('Correction detection via LLM failed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Regex fallback
    if (this.router.isFallbackEnabled()) {
      const fbResult = detectCorrectionFallback(ctx.userMessage, collected);
      return (await this.plugins.postProcess(ctx, task, fbResult)) as CorrectionResult;
    }

    const defaultResult: CorrectionResult = { detected: false, confidence: 0, source: 'fallback' };
    return (await this.plugins.postProcess(ctx, task, defaultResult)) as CorrectionResult;
  }

  /**
   * Detect digression from current flow
   */
  async detectDigression(
    ctx: NLUContext,
    digressions: DigressionCandidate[],
  ): Promise<DigressionResult> {
    const task: NLUTask = 'digression_detection';

    // Convert to intent candidates
    const candidates: IntentCandidate[] = digressions.map((d) => ({
      name: d.intent,
      patterns: d.keywords ?? [],
    }));

    const result = await this.detectIntent(ctx, candidates);

    return {
      detected: result.intent !== null,
      intent: result.intent || undefined,
      confidence: result.confidence,
      source: result.source,
    };
  }

  /**
   * Detect user's language from message
   */
  async detectLanguage(input: NLUContext | string): Promise<LanguageResult> {
    const message = typeof input === 'string' ? input : input.userMessage;
    const { primary } = this.router.getLayerForTask('language_detection');

    try {
      return await detectLangLLM(message, primary);
    } catch (error) {
      log.warn('Language detection via LLM failed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });
      return detectLanguageFallback(message);
    }
  }

  /**
   * Combined NLU pass — batches multiple tasks into single LLM call
   */
  async analyzeInput(ctx: NLUContext, options: AnalyzeOptions): Promise<AnalysisResult> {
    const result: AnalysisResult = {};

    // Try combined prompt for efficiency
    const { primary, primaryLayer } = this.router.getLayerForTask('combined_analysis');

    try {
      const template = loadPromptTemplate('combined');

      const buildParts: string[] = [];
      if (options.detectIntent && options.intents) {
        buildParts.push(
          `Intent classification from: ${options.intents.map((i) => i.name).join(', ')}`,
        );
      }
      if (options.classifyCategory && options.categories) {
        buildParts.push(
          `Category classification from: ${options.categories.map((c) => c.name).join(', ')}`,
        );
      }
      if (options.extractEntities && options.entityFields) {
        buildParts.push(
          `Entity extraction for: ${options.entityFields.map((f) => f.name).join(', ')}`,
        );
      }
      if (options.detectCorrection) {
        buildParts.push('Correction detection');
      }

      const vars = this.buildTemplateVars(ctx, {
        detectIntent: options.detectIntent ? 'true' : '',
        classifyCategory: options.classifyCategory ? 'true' : '',
        extractEntities: options.extractEntities ? 'true' : '',
        detectCorrection: options.detectCorrection ? 'true' : '',
        intents:
          options.intents?.map((i) => `- ${i.name}: ${i.patterns.join(', ')}`).join('\n') || '',
        categories:
          options.categories?.map((c) => `- ${c.name}: ${c.patterns.join(', ')}`).join('\n') || '',
        entityFields:
          options.entityFields?.map((f) => `- ${f.name} (${f.type || 'string'})`).join('\n') || '',
      });

      const systemPrompt =
        renderTemplate(template.system, vars) + '\n\nAnalyze:\n' + buildParts.join('\n');

      const response = await primary.provider.chat(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        { model: primary.model, timeoutMs: primary.timeoutMs ?? 5000 },
      );

      const parsed = parseJSON<Record<string, unknown>>(response);

      if (parsed) {
        if (options.detectIntent && parsed.intent) {
          const intentData = parsed.intent as { intent: string; confidence: number };
          result.intent = {
            intent: intentData.intent === 'none' ? null : intentData.intent,
            confidence: intentData.confidence ?? 0.8,
            source: primaryLayer,
          };
        }

        if (options.classifyCategory && parsed.category) {
          const catData = parsed.category as { category: string; confidence: number };
          result.category = {
            category: catData.category === 'none' ? null : catData.category,
            confidence: catData.confidence ?? 0.8,
            source: primaryLayer,
          };
        }

        if (options.extractEntities && parsed.entities) {
          const entities = parsed.entities as Record<string, unknown>;
          const values: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(entities)) {
            if (v !== null && v !== undefined && v !== 'null') values[k] = v;
          }
          const fieldNames = options.entityFields?.map((f) => f.name) || [];
          result.entities = {
            values,
            missing: fieldNames.filter((f) => values[f] === undefined),
            confidence: Object.fromEntries(Object.keys(values).map((k) => [k, 0.8])),
            source: primaryLayer,
          };
        }

        if (options.detectCorrection && parsed.correction) {
          const corr = parsed.correction as {
            detected: boolean;
            field?: string;
            newValue?: unknown;
          };
          result.correction = {
            detected: corr.detected,
            field: corr.field,
            newValue: corr.newValue,
            confidence: 0.8,
            source: primaryLayer,
          };
        }

        return result;
      }
    } catch (error) {
      log.warn('Combined NLU analysis failed, falling back to individual tasks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback: run individual NLU tasks
    if (options.detectIntent && options.intents) {
      result.intent = await this.detectIntent(ctx, options.intents);
    }
    if (options.classifyCategory && options.categories) {
      result.category = await this.classifyCategory(ctx, options.categories);
    }
    if (options.extractEntities && options.entityFields) {
      result.entities = await this.extractEntities(ctx, options.entityFields);
    }
    if (options.detectCorrection && options.collectedData) {
      result.correction = await this.detectCorrection(ctx, options.collectedData);
    }
    if (options.detectLanguage) {
      result.language = await this.detectLanguage(ctx.userMessage);
    }

    return result;
  }

  // =========================================================================
  // DYNAMIC INTENT/ENTITY/CATEGORY REGISTRATION
  // =========================================================================

  /**
   * Register dynamic intents at runtime (additive to ABL-declared intents)
   */
  registerIntents(intents: IntentDefinition[]): void {
    this.dynamicIntents.push(...intents);
  }

  /**
   * Remove dynamic intents
   */
  unregisterIntents(intentNames: string[]): void {
    this.dynamicIntents = this.dynamicIntents.filter((i) => !intentNames.includes(i.name));
  }

  /**
   * Register dynamic categories
   */
  registerCategories(categories: CategoryDefinition[]): void {
    this.dynamicCategories.push(...categories);
  }

  /**
   * Register dynamic entities
   */
  registerEntities(entities: EntityDefinition[]): void {
    this.dynamicEntities.push(...entities);
  }

  /**
   * Get all active intents (ABL + dynamic)
   */
  getActiveIntents(): IntentDefinition[] {
    return [...this.dynamicIntents];
  }

  /**
   * Get all active categories (ABL + dynamic)
   */
  getActiveCategories(): CategoryDefinition[] {
    return [...this.dynamicCategories];
  }

  /**
   * Get all active entities (ABL + dynamic)
   */
  getActiveEntities(): EntityDefinition[] {
    return [...this.dynamicEntities];
  }

  // =========================================================================
  // EMBEDDING INDEX
  // =========================================================================

  /**
   * Set the embedding intent index for fast matching
   */
  setEmbeddingIntentIndex(index: EmbeddingIntentIndex): void {
    this.embeddingIntentIndex = index;
  }

  // =========================================================================
  // FACTORY METHODS
  // =========================================================================

  /**
   * Zero-config: reuse agent's LLM provider at fast tier
   */
  static fromLLMClient(llmClient: LLMClient): NLUEngine {
    return new NLUEngine({
      layers: {
        fast: {
          provider: llmClient,
          model: 'default',
          timeoutMs: 3000,
          maxTokens: 256,
          temperature: 0,
        },
      },
      enableFallbacks: true,
      confidenceThreshold: 0.7,
    });
  }

  /**
   * From ABL NLU config (parsed from agent spec)
   */
  static fromAgentIR(agentIR: AgentIR & { nlu?: NLUIRConfig }, llmClient: LLMClient): NLUEngine {
    const nluConfig = agentIR.nlu;
    if (!nluConfig) {
      return NLUEngine.fromLLMClient(llmClient);
    }

    const fastModel = nluConfig.models?.fast || 'default';
    const balancedModel = nluConfig.models?.balanced;

    // Resolve multi-intent config: agent-level → project-level → undefined
    const multiIntentIR =
      agentIR.intent_handling?.multi_intent ??
      agentIR.project_runtime_config?.multi_intent ??
      undefined;

    const engine = new NLUEngine({
      layers: {
        fast: {
          provider: llmClient,
          model: fastModel,
          timeoutMs: 2000,
          maxTokens: 256,
          temperature: 0,
        },
        balanced: balancedModel
          ? {
              provider: llmClient,
              model: balancedModel,
              timeoutMs: 5000,
              maxTokens: 512,
              temperature: 0,
            }
          : undefined,
      },
      enableFallbacks: true,
      confidenceThreshold: nluConfig.evaluation?.confidenceThreshold ?? 0.7,
      multiIntent: multiIntentIR
        ? {
            enabled: multiIntentIR.enabled,
            maxIntents: multiIntentIR.max_intents,
            confidenceThreshold: multiIntentIR.confidence_threshold,
          }
        : undefined,
    });

    // Register ABL-declared intents, categories, entities
    if (nluConfig.intents) engine.registerIntents(nluConfig.intents);
    if (nluConfig.categories) engine.registerCategories(nluConfig.categories);
    if (nluConfig.entities) engine.registerEntities(nluConfig.entities);

    return engine;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Detect intent using LLM
   */
  private async detectIntentWithLLM(
    ctx: NLUContext,
    candidates: IntentCandidate[],
    layer: NLUModelLayerConfig,
  ): Promise<IntentResult | null> {
    try {
      const template = loadPromptTemplate('intent');

      const intentsList = candidates
        .map((c) => {
          let desc = `- ${c.name}: keywords=[${c.patterns.join(', ')}]`;
          if (c.examples && c.examples.length > 0) {
            desc += ` examples=[${c.examples.slice(0, 3).join('; ')}]`;
          }
          return desc;
        })
        .join('\n');

      // Build few-shot examples string
      let fewShotStr = '';
      if (ctx.fewShotExamples && ctx.fewShotExamples.length > 0) {
        fewShotStr = ctx.fewShotExamples
          .slice(0, 5) // Limit to 5 examples
          .map((e) => `User: "${e.input}" → ${e.output}`)
          .join('\n');
      }

      const vars = this.buildTemplateVars(ctx, {
        intents: intentsList,
        fewShotExamples: fewShotStr,
      });
      const systemPrompt = renderTemplate(template.system, vars);

      const response = await layer.provider.chat(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        { model: layer.model, timeoutMs: layer.timeoutMs ?? 2000 },
      );

      const parsed = parseJSON<{ intent: string; confidence: number }>(response);
      if (parsed && parsed.intent && parsed.intent !== 'none') {
        return {
          intent: parsed.intent,
          confidence: parsed.confidence ?? 0.8,
          source: 'fast', // Will be overridden by caller
        };
      }

      return { intent: null, confidence: parsed?.confidence ?? 0, source: 'fast' };
    } catch (error) {
      log.warn('Intent detection via LLM failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Build template variables from NLU context
   */
  private buildTemplateVars(
    ctx: NLUContext,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      agentGoal: ctx.agentGoal,
      agentDomain: ctx.agentDomain,
      language: ctx.detectedLanguage || ctx.sessionLanguage,
      conversationPhase: ctx.conversationPhase,
      pendingQuestion: ctx.pendingQuestion,
      collectedData: JSON.stringify(ctx.collectedData),
      missingFields: ctx.missingFields?.join(', '),
      glossary: ctx.glossary?.join(', '),
      ...extra,
    };
  }

  /**
   * Record a metric event
   */
  private recordMetric(
    ctx: NLUContext,
    task: NLUTask,
    prediction: unknown,
    confidence: number,
    layer: NLULayer | string,
    latencyMs: number,
    modelUsed: string,
  ): void {
    if (!this.config.metrics) return;

    this.config.metrics.recordPrediction({
      sessionId: ((ctx as unknown as Record<string, unknown>).sessionId as string) ?? '',
      timestamp: new Date(),
      task,
      input: ctx.userMessage,
      language: ctx.detectedLanguage || ctx.sessionLanguage || 'en',
      modelUsed,
      layerUsed: layer as NLULayer,
      prediction,
      confidence,
      latencyMs,
    });
  }
}

// =============================================================================
// EMBEDDING INTENT INDEX INTERFACE (for decoupling)
// =============================================================================

/**
 * Interface for embedding-based intent matching.
 * Implemented in embeddings/intent-index.ts
 */
export interface EmbeddingIntentIndex {
  match(message: string): Promise<IntentResult | null>;
  matchTopN?(message: string, n: number): Promise<SimilarityMatch[]>;
}
