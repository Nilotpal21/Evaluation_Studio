/**
 * Pipeline Classifier
 *
 * Single LLM call to classify user intent(s) and determine
 * whether to short-circuit route or fall through to reasoning loop.
 */

import { generateText, type LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform';
import type { IntentCategory } from '@abl/compiler/platform/ir/schema.js';
import type { IntentRelationship } from '@abl/compiler/platform/nlu/types.js';
import {
  isClassifierSidecarResponse,
  type ClassifierSidecarRequest,
  type ClassifierSidecarResponse,
  type GatherInterruptCandidateSurface,
} from '@agent-platform/shared-kernel';
import type { ClassifierResult, ClassifiedIntent, PipelineConfig, OnTraceEvent } from './types.js';
import { dumpLlmTrace } from '../llm/llm-trace.js';
import type { ClassifierConversationTurn } from './runtime-contract.js';

const log = createLogger('pipeline-classifier');

/** Timeout for classifier LLM call (ms) */
export const CLASSIFIER_TIMEOUT_MS = 10_000;
const CLASSIFIER_MAX_OUTPUT_TOKENS = 400;
const DEFAULT_SIDECAR_LOCALE = 'en';
const DEFAULT_SIDECAR_THRESHOLD = 0.76;
const DEFAULT_SIDECAR_TOP_K = 3;

/** Agent scope context — goal and limitations for out-of-scope detection */
export interface AgentScopeContext {
  goal: string;
  limitations?: string[];
}

export type ClassifierMode = 'global' | 'gather_scoped';

interface BaseClassifierRequest {
  userMessage: string;
  categories: IntentCategory[];
  config: PipelineConfig;
  onTraceEvent?: OnTraceEvent;
  agentScope?: AgentScopeContext;
  recentConversation?: ClassifierConversationTurn[];
}

export interface GlobalClassifierRequest extends BaseClassifierRequest {
  mode: 'global';
}

export interface GatherScopedClassifierRequest extends BaseClassifierRequest {
  mode: 'gather_scoped';
  candidateSurface: GatherInterruptCandidateSurface;
}

export type ClassifierRequest = GlobalClassifierRequest | GatherScopedClassifierRequest;

export interface BuildClassifierSidecarRequestOptions {
  tenantId: string;
  projectId: string;
  sessionId: string;
  locale?: string;
  threshold?: number;
  topK?: number;
}

export class PipelineClassifierUnavailableError extends Error {
  readonly kind: 'timeout' | 'request_failed';

  constructor(kind: 'timeout' | 'request_failed', message: string, cause?: unknown) {
    super(message);
    this.name = 'PipelineClassifierUnavailableError';
    this.kind = kind;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function getEffectiveClassifierCategories(request: ClassifierRequest): IntentCategory[] {
  if (request.mode === 'global') {
    return request.categories;
  }

  // Gather-scoped classification is a finite-candidate contract: the runtime
  // already narrowed the interrupt surface, so the classifier must only see
  // those candidates and preserve the canonical category metadata when present.
  const categoriesByName = new Map<string, IntentCategory>();
  for (const category of request.categories) {
    const normalizedName = category.name.trim();
    if (normalizedName.length === 0) {
      continue;
    }
    categoriesByName.set(normalizedName, category);
  }

  const seenCandidates = new Set<string>();
  return request.candidateSurface.candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      if (candidate.length === 0 || seenCandidates.has(candidate)) {
        return false;
      }

      seenCandidates.add(candidate);
      return true;
    })
    .map((candidate) => categoriesByName.get(candidate) ?? { name: candidate });
}

function humanizeCategoryName(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim();
}

function buildSidecarKeywords(category: IntentCategory): string[] {
  const keywordSet = new Set<string>();
  const seedText = [category.name, category.description ?? ''];

  for (const value of seedText) {
    for (const token of value
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 3)) {
      keywordSet.add(token);
    }
  }

  return [...keywordSet];
}

/**
 * Future semantic-sidecar request builder for finite gather interrupt candidates.
 *
 * This stays on the classifier seam so runtime contract tests can lock the
 * sidecar payload without wiring the sidecar into the execution path yet.
 */
export function buildClassifierSidecarRequest(
  request: GatherScopedClassifierRequest,
  options: BuildClassifierSidecarRequestOptions,
): ClassifierSidecarRequest {
  const categories = getEffectiveClassifierCategories(request);
  const candidates = categories.map((category) => {
    const humanizedName = humanizeCategoryName(category.name);
    const phrases = [category.name, humanizedName].filter(
      (value, index, values) => value.length > 0 && values.indexOf(value) === index,
    );
    const examples = category.description ? [category.description] : [];

    return {
      id: category.name,
      phrases,
      examples,
      keywords: buildSidecarKeywords(category),
    };
  });

  return {
    text: request.userMessage,
    locale: options.locale ?? DEFAULT_SIDECAR_LOCALE,
    task: 'flow_escape',
    top_k: Math.max(1, Math.min(options.topK ?? DEFAULT_SIDECAR_TOP_K, candidates.length)),
    threshold: options.threshold ?? DEFAULT_SIDECAR_THRESHOLD,
    candidates,
    tenantId: options.tenantId,
    projectId: options.projectId,
    sessionId: options.sessionId,
  };
}

/**
 * Build the classification prompt.
 * Uses intent categories (with optional descriptions) for semantic classification.
 *
 * When `agentScope` is provided, the classifier also determines whether the
 * message is within the agent's scope using the agent's goal and limitations.
 * This is used for subsequent turns on child agents where the supervisor is
 * no longer evaluating scope.
 */
function buildClassifierPrompt(request: ClassifierRequest): string {
  const { userMessage, agentScope, recentConversation = [] } = request;
  const categories = getEffectiveClassifierCategories(request);
  let categorySection: string;
  const hasDescriptions = categories.some((c) => c.description);
  if (hasDescriptions) {
    categorySection = categories
      .map((c) => (c.description ? `  ${c.name} — "${c.description}"` : `  ${c.name}`))
      .join('\n');
  } else {
    categorySection = categories.map((c) => c.name).join(', ');
  }

  // Scope context block — only when agent goal is provided
  let scopeBlock = '';
  if (agentScope) {
    scopeBlock = `\nAgent purpose: "${agentScope.goal}"`;
    if (agentScope.limitations?.length) {
      scopeBlock += `\nAgent limitations:\n${agentScope.limitations.map((l) => `- ${l}`).join('\n')}`;
    }
    scopeBlock += '\n';
  }

  // Scope rules — only when scope detection is active
  const scopeRules = agentScope
    ? `- Set "out_of_scope": true if the message is unrelated to the agent's purpose
- Set "out_of_scope": false if the message relates to the agent's purpose (even if no category matches)`
    : '';

  // Response schema — include out_of_scope field only when scope detection is active.
  // relationship is top-level because it describes dependencies between intents,
  // not an individual intent.
  const responseSchema = agentScope
    ? '{"relationship":"<independent, dependent, ambiguous, or null>","intents":[{"category":"<category or null>","confidence":<0.0-1.0>,"summary":"<the specific sub-request>","out_of_scope":<true or false>}]}'
    : '{"relationship":"<independent, dependent, ambiguous, or null>","intents":[{"category":"<category or null>","confidence":<0.0-1.0>,"summary":"<the specific sub-request>"}]}';

  const conversationBlock =
    recentConversation.length > 0
      ? `Recent conversation context (oldest to newest):\n${recentConversation
          .map((turn) => `- ${turn.role}: "${turn.text}"`)
          .join('\n')}\n\n`
      : '';

  const gatherScopeBlock =
    request.mode === 'gather_scoped'
      ? `Gather interrupt candidate surface: ${request.candidateSurface.kind} (${request.candidateSurface.size} candidates)
Allowed candidates: ${request.candidateSurface.candidates.join(', ')}
Only choose from this finite candidate surface or return null.\n\n`
      : '';

  return `You are an intent classifier. Identify the user's intent from the categories below.
${scopeBlock}
${hasDescriptions ? `Categories:\n${categorySection}` : `Categories: ${categorySection}`}

Rules:
- Return the category that best matches the user message
- If NONE match, set category to null
- If MULTIPLE distinct intents are detected, return one entry per intent
- If MULTIPLE intents are detected, set top-level "relationship":
  - "independent" when each intent can be answered without another intent's result
  - "dependent" when a later intent cannot be answered correctly until an earlier intent's result is known
  - "ambiguous" when dependency is unclear
- Preserve the execution order of dependent intents in the intents array
- Confidence 0.0-1.0
${scopeRules}

${gatherScopeBlock}${conversationBlock}Current user message: "${userMessage}"

Respond with ONLY valid JSON (no markdown):
${responseSchema}`;
}

/**
 * Build a lookup set of known category names from the categories array.
 * Bounded by the finite number of categories defined in the agent config.
 */
export function buildKnownCategorySet(categories: IntentCategory[]): Set<string> {
  const categorySet = new Set<string>();
  for (const c of categories) {
    categorySet.add(c.name);
  }
  return categorySet;
}

/**
 * Parse classifier JSON response, validating categories against the known set.
 */
export function parseClassifierResponse(
  text: string,
  knownCategories: Set<string>,
): ClassifierResult {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');

  try {
    const parsed = JSON.parse(cleaned);
    const intents: ClassifiedIntent[] = (parsed.intents ?? [])
      .map((i: Record<string, unknown>) => {
        const rawCategory =
          typeof i.category === 'string' && i.category !== 'null' ? i.category : null;
        const category = rawCategory && knownCategories.has(rawCategory) ? rawCategory : null;
        // Drop hallucinated categories: classifier returned a string that isn't in
        // the known set. These are noise (e.g. "greeting" when no greeting category
        // exists) and poison short-circuit / multi-intent logic.
        const hallucinated = rawCategory !== null && category === null;
        if (hallucinated) {
          log.debug('dropping intent with unknown category', {
            rawCategory,
            summary: typeof i.summary === 'string' ? i.summary.slice(0, 80) : '',
          });
          return null;
        }
        const intent: ClassifiedIntent = {
          category,
          confidence: typeof i.confidence === 'number' ? Math.max(0, Math.min(1, i.confidence)) : 0,
          summary: typeof i.summary === 'string' ? i.summary : '',
        };
        // Propagate out_of_scope only when the classifier was given scope context
        if (typeof i.out_of_scope === 'boolean') {
          intent.out_of_scope = i.out_of_scope;
        }
        return intent;
      })
      .filter((i: ClassifiedIntent | null): i is ClassifiedIntent => i !== null);

    const resultIntents =
      intents.length > 0 ? intents : [{ category: null, confidence: 0, summary: 'unknown' }];
    const relationship = parseIntentRelationship(parsed.relationship, resultIntents.length);

    return {
      intents: resultIntents,
      ...(relationship ? { relationship } : {}),
    };
  } catch {
    log.warn('classifier response parse failed, falling through', { text: text.slice(0, 200) });
    return {
      intents: [{ category: null, confidence: 0, summary: 'parse_failure' }],
    };
  }
}

function parseIntentRelationship(
  value: unknown,
  intentCount: number,
): IntentRelationship | undefined {
  if (intentCount < 2) {
    return undefined;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'independent' || normalized === 'dependent' || normalized === 'ambiguous') {
      return { type: normalized, reasoning: 'classifier relationship field' };
    }
    return undefined;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    if (type === 'independent' || type === 'dependent' || type === 'ambiguous') {
      return {
        type,
        reasoning:
          typeof record.reasoning === 'string' && record.reasoning.trim()
            ? record.reasoning.trim()
            : 'classifier relationship field',
      };
    }
  }

  return undefined;
}

export function parseClassifierSidecarResponse(
  response: unknown,
  knownCategories: Set<string>,
): ClassifierResult {
  if (!isClassifierSidecarResponse(response)) {
    log.warn('classifier sidecar response parse failed, falling through');
    return {
      intents: [{ category: null, confidence: 0, summary: 'parse_failure' }],
    };
  }

  const typedResponse: ClassifierSidecarResponse = response;
  if (!typedResponse.accepted || !typedResponse.selected) {
    return {
      intents: [
        {
          category: null,
          confidence: typedResponse.top_k[0]?.score ?? 0,
          summary: 'no_match',
        },
      ],
    };
  }

  if (!knownCategories.has(typedResponse.selected.id)) {
    log.warn('classifier sidecar selected an unknown category', {
      category: typedResponse.selected.id,
    });
    return {
      intents: [{ category: null, confidence: 0, summary: 'parse_failure' }],
    };
  }

  return {
    intents: [
      {
        category: typedResponse.selected.id,
        confidence: typedResponse.selected.score,
        summary: typedResponse.selected.matched_text,
      },
    ],
  };
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

async function generateClassifierText(
  model: LanguageModel,
  prompt: string,
): Promise<GenerateTextResult> {
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(
        new PipelineClassifierUnavailableError(
          'timeout',
          `Pipeline classifier request exceeded ${CLASSIFIER_TIMEOUT_MS}ms`,
        ),
      );
    }, CLASSIFIER_TIMEOUT_MS);
  });

  const requestPromise = generateText({
    model,
    prompt,
    maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    abortSignal: abortController.signal,
  }) as Promise<GenerateTextResult>;

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof PipelineClassifierUnavailableError) {
      throw err;
    }

    if (isAbortLikeError(err)) {
      throw new PipelineClassifierUnavailableError(
        'timeout',
        `Pipeline classifier request exceeded ${CLASSIFIER_TIMEOUT_MS}ms`,
        err,
      );
    }

    throw new PipelineClassifierUnavailableError(
      'request_failed',
      'Pipeline classifier request failed',
      err,
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Check if user message contains keywords that match in-agent tool names/actions.
 * Returns matched keywords if veto should fire.
 */
export function checkKeywordVeto(
  userMessage: string,
  toolNames: string[],
  configKeywords: string[],
): string[] {
  const lowerMessage = userMessage.toLowerCase();

  // Combine tool names (split on underscore for multi-word tool names) with config keywords
  const allKeywords = new Set<string>();
  for (const tool of toolNames) {
    // "process_refund" → check "process", "refund"
    for (const part of tool.split('_')) {
      if (part.length >= 3) allKeywords.add(part.toLowerCase());
    }
  }
  for (const kw of configKeywords) {
    allKeywords.add(kw.toLowerCase());
  }

  const matched: string[] = [];
  for (const kw of allKeywords) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerMessage)) {
      matched.push(kw);
    }
  }

  return matched;
}

/**
 * Run intent classification on the user message.
 *
 * Keep gather-scoped routing on this exported entry point so runtime
 * integration tests can spy on the real classifier lane without bypassing
 * prompt construction or finite-candidate filtering.
 */
export async function classify(
  model: LanguageModel,
  request: ClassifierRequest,
): Promise<ClassifierResult> {
  const start = Date.now();
  const effectiveCategories = getEffectiveClassifierCategories(request);
  const knownCategories = buildKnownCategorySet(effectiveCategories);

  const modelId = typeof model === 'string' ? model : model.modelId;

  const prompt = buildClassifierPrompt(request);

  dumpLlmTrace('request', 'pipeline:classifier', modelId, {
    pipelinePhase: 'classify',
    classifierMode: request.mode,
    prompt,
    maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    categories: effectiveCategories.map((c) => c.name),
    ...(request.mode === 'gather_scoped'
      ? {
          candidateSurface: request.candidateSurface,
        }
      : {}),
    ...(request.agentScope
      ? {
          scopeContext: {
            goal: request.agentScope.goal,
            hasLimitations: !!request.agentScope.limitations?.length,
          },
        }
      : {}),
    recentConversationCount: request.recentConversation?.length ?? 0,
  });

  const result = await generateClassifierText(model, prompt);

  const classifierResult = parseClassifierResponse(result.text, knownCategories);
  const latencyMs = Date.now() - start;

  dumpLlmTrace('response', 'pipeline:classifier', modelId, {
    pipelinePhase: 'classify',
    latencyMs,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    finishReason: result.finishReason,
    rawText: result.text,
    intents: classifierResult.intents,
  });

  if (request.onTraceEvent) {
    request.onTraceEvent({
      type: 'pipeline_classify',
      data: {
        intents: classifierResult.intents,
        model: typeof model === 'string' ? model : model.modelId,
        latencyMs,
      },
    });
  }

  return classifierResult;
}

/**
 * Determine if the classifier result qualifies for short-circuit routing.
 * Only when: single intent + high confidence + has category + no keyword veto.
 */
export function shouldShortCircuit(
  result: ClassifierResult,
  userMessage: string,
  toolNames: string[],
  config: PipelineConfig,
): { shortCircuit: boolean; vetoKeywords?: string[] } {
  if (!config.shortCircuit.enabled) return { shortCircuit: false };

  const intents = result.intents;

  // Must be single intent with a category
  if (intents.length !== 1) return { shortCircuit: false };

  const primary = intents[0];
  if (!primary.category) return { shortCircuit: false };
  if (primary.confidence < config.shortCircuit.confidenceThreshold) return { shortCircuit: false };

  // Keyword veto check
  if (config.keywordVeto.enabled) {
    const matched = checkKeywordVeto(userMessage, toolNames, config.keywordVeto.keywords);
    if (matched.length > 0) {
      return { shortCircuit: false, vetoKeywords: matched };
    }
  }

  return { shortCircuit: true };
}
