/**
 * CrawlIntelligenceService — 4-phase orchestrator
 *
 * Phase 1 (MAP+INTENT): Filter sitemap URLs by user intent (1 LLM call)
 * Phase 2 (UNDERSTAND): Browse sample page with MCP tools (1-5 LLM calls)
 * Phase 3 (BUILD HANDLER): Generate extraction recipe (1 LLM call)
 * Phase 4 (REPLAY): Execute handler mechanically (0 LLM calls)
 */

import type { WorkerLLMClient, ToolUseResult } from '@agent-platform/llm';
import type { MCPClient, MCPTool, ToolCallResult } from '@abl/compiler/platform';
import type { ToolDefinition, ContentBlock } from '@abl/compiler/platform/llm/types.js';
import { createLogger } from '../logger.js';
import {
  MAP_INTENT_SYSTEM_PROMPT,
  UNDERSTAND_SYSTEM_PROMPT,
  BUILD_HANDLER_SYSTEM_PROMPT,
} from './prompts.js';
import type {
  CrawlIntent,
  IPageHandler,
  IPlaywrightStep,
  MapIntentResult,
  UnderstandResult,
  BuildHandlerResult,
  ReplayResult,
  IntelligenceLoopResult,
  OnProgressCallback,
} from './types.js';
import type { HandlerReuser } from './algorithms/handler-reuser.js';
import type { IHandlerStore } from './handler-store/interfaces.js';
import type { TemplateFingerprinter } from './algorithms/template-fingerprinter.js';

const log = createLogger('crawl-intelligence');

/** Maximum iterations for the Phase 2 tool-use loop (FIX 3: increased from 5→8) */
const MAX_UNDERSTAND_ITERATIONS = 8;

/** Iteration at which we inject "wrap up NOW" message (FIX 2: MAX-1) */
const WRAP_UP_ITERATION = MAX_UNDERSTAND_ITERATIONS - 1;

/**
 * FIX 8: Force tool use for the first N iterations.
 * Prevents LLM from "hallucinating" answers without actually browsing.
 * With toolChoice='required', the LLM MUST call navigate/get_page_content
 * before it can produce a text response.
 *
 * Set to 4 because gpt-4o-mini needs at least:
 *   iter 1: navigate (load page)
 *   iter 2: get_page_content (see what's there)
 *   iter 3: extract_elements (find specific content areas)
 *   iter 4: extract_elements (find interactive elements)
 * Only after this should auto-mode allow text responses.
 */
const FORCE_TOOL_ITERATIONS = 4;

/** Maximum sitemap URLs to include in Phase 1 prompt */
const MAX_SITEMAP_URLS = 200;

/** Maximum length for user-provided intent string (V2: prevent prompt injection via long payloads) */
const MAX_INTENT_LENGTH = 500;

/** Maximum length for user-provided URL strings */
const MAX_URL_LENGTH = 2048;

/**
 * FIX 9: Maximum chars for a single tool result in Phase 2 conversation.
 * get_page_content can return 600K+ chars for large pages. This overflows
 * gpt-4o-mini's 128K context window (~32K chars ≈ 8K tokens at 4:1 ratio).
 * We truncate tool results that go back into the conversation to keep the
 * LLM focused. The full content is still used in Phase 4 replay.
 */
const MAX_TOOL_RESULT_IN_CONTEXT = 15_000;

/** Max chars for page structure preview in partial results (F7-08) */
const PAGE_STRUCTURE_PREVIEW_LENGTH = 500;

/** Min chars in extract_elements result to consider it non-empty (F7-09) */
const MIN_CONTENT_LENGTH_THRESHOLD = 50;

/**
 * MCP tools allowed in Phase 2 (UNDERSTAND).
 * FIX 10: Added scroll + wait_for_element — enables the LLM to handle
 * lazy-loading pages (Samsung, SPAs) and content behind scroll triggers.
 * Without these, Phase 2 can navigate and see the page but can't trigger
 * dynamic content that loads on scroll/wait (intentMatch stays false).
 */
const UNDERSTAND_TOOL_ALLOWLIST = new Set([
  'navigate',
  'get_page_content',
  'extract_elements',
  'get_page_state',
  'scroll',
  'wait_for_element',
]);

/** Tool name for structured output from Phase 2 understand */
const SUBMIT_UNDERSTANDING_TOOL = 'submit_understanding';

/** Map handler step actions to MCP tool names */
const ACTION_TO_MCP_TOOL: Record<string, string> = {
  navigate: 'navigate',
  click: 'click_element',
  type: 'type_text',
  scroll: 'scroll',
  wait: 'wait_for_element',
  extract: 'extract_elements',
  execute_js: 'execute_javascript',
};

export interface CrawlIntelligenceServiceDeps {
  /** WorkerLLMClient with chatWithToolUse() support */
  llmClient: WorkerLLMClient;
  /** Connected MCP client for browser automation */
  mcpClient: MCPClient;
  /** Pre-fetched sitemap URLs, or empty */
  sitemapUrls?: string[];
  /** Optional scenario ID for Phase 2 event tracking (used by log extractor) */
  scenarioId?: string;
  /** Optional progress callback, called at each phase transition */
  onProgress?: OnProgressCallback;
  /** Optional handler reuser for template-based handler matching (skips Phase 2+3) */
  handlerReuser?: HandlerReuser;
  /** Optional persistent handler store for cross-session reuse */
  handlerStore?: IHandlerStore;
  /** Optional template fingerprinter (needed for handler registration when handlerReuser is set) */
  fingerprinter?: TemplateFingerprinter;
  /** Tenant ID for handler store operations */
  tenantId?: string;
}

export class CrawlIntelligenceService {
  private llmClient: WorkerLLMClient;
  private mcpClient: MCPClient;
  private sitemapUrls: string[];
  private scenarioId: string | undefined;
  private onProgress?: OnProgressCallback;
  private llmCallCount = 0;
  private totalTokens = 0;
  private handlerReuser?: HandlerReuser;
  private handlerStore?: IHandlerStore;
  private fingerprinter?: TemplateFingerprinter;
  private tenantId?: string;

  constructor(deps: CrawlIntelligenceServiceDeps) {
    this.llmClient = deps.llmClient;
    this.mcpClient = deps.mcpClient;
    this.sitemapUrls = deps.sitemapUrls ?? [];
    this.scenarioId = deps.scenarioId;
    this.onProgress = deps.onProgress;
    this.handlerReuser = deps.handlerReuser;
    this.handlerStore = deps.handlerStore;
    this.fingerprinter = deps.fingerprinter;
    this.tenantId = deps.tenantId;
  }

  /**
   * Run the full 4-phase intelligence loop.
   */
  async execute(intent: CrawlIntent): Promise<IntelligenceLoopResult> {
    this.llmCallCount = 0;
    this.totalTokens = 0;

    const loopStart = Date.now();
    log.info('Starting intelligence loop', { intent: intent.intent, siteUrl: intent.siteUrl });

    // Phase 1: MAP+INTENT
    await this.onProgress?.('map', 'Filtering URLs by intent');
    const p1Start = Date.now();
    const mapResult = await this.mapIntent(intent, this.sitemapUrls);
    log.info('Phase 1 complete', {
      filteredUrls: mapResult.filteredUrls.length,
      pattern: mapResult.urlPattern,
      durationMs: Date.now() - p1Start,
    });

    // ── Handler reuse check ──
    // Before Phase 2, try to reuse a stored handler by fingerprinting the page.
    // This requires navigating to the page first to get its HTML.
    let handlerReused = false;
    let handlerTemplateId: string | undefined;
    let reusedPageHtml: string | undefined;

    if (this.handlerReuser && this.fingerprinter) {
      try {
        // Navigate to the sample URL to get page HTML for fingerprinting
        await this.mcpClient.callTool('navigate', { url: intent.sampleUrl });
        const pageResult = await this.mcpClient.callTool('get_page_content', {
          includeHtml: true,
        });
        const rawText = pageResult.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');
        try {
          const parsed = JSON.parse(rawText);
          if (parsed && typeof parsed.html === 'string' && parsed.html.length > 0) {
            reusedPageHtml = parsed.html;
          }
        } catch {
          // Not JSON — use raw text as HTML fallback
          if (rawText.length > 0) {
            reusedPageHtml = rawText;
          }
        }

        if (reusedPageHtml) {
          const reuseResult = this.handlerReuser.tryReuse(reusedPageHtml);
          if (reuseResult.matched && reuseResult.handler) {
            handlerReused = true;
            handlerTemplateId = reuseResult.templateId;

            log.info('Handler reuse match found — skipping Phase 2+3', {
              templateId: reuseResult.templateId,
              llmCallsSaved: reuseResult.llmCallsSaved,
              skippedPhases: reuseResult.skippedPhases,
            });

            await this.onProgress?.('reuse', 'Reusing existing handler — 0 LLM calls');

            // Skip to Phase 4 with the reused handler
            const reuseHandlerResult = {
              handler: reuseResult.handler,
              reasoning: `Reused handler from template ${reuseResult.templateId}`,
            };

            // Synthesize a minimal understand result for the return value
            const reuseUnderstandResult: UnderstandResult = {
              pageStructure: 'Skipped — handler reused from template match',
              contentAreas: [],
              interactiveElements: [],
              suggestedKeywords: [],
              intentMatch: true,
            };

            // Phase 4: REPLAY with reused handler
            await this.onProgress?.('replay', 'Extracting content with reused handler');
            const p4Start = Date.now();
            const replayResult = await this.replay(reuseResult.handler, intent.sampleUrl);
            log.info('Phase 4 complete (reused handler)', {
              success: replayResult.success,
              contentLength: replayResult.content.body.length,
              durationMs: Date.now() - p4Start,
            });

            const totalDurationMs = Date.now() - loopStart;
            log.info('Intelligence loop complete (handler reused)', {
              llmCallCount: this.llmCallCount,
              totalTokens: this.totalTokens,
              totalDurationMs,
              handlerReused: true,
              handlerTemplateId,
            });

            return {
              intent,
              mapIntent: mapResult,
              understand: reuseUnderstandResult,
              buildHandler: reuseHandlerResult,
              replay: replayResult,
              llmCallCount: this.llmCallCount,
              totalTokens: this.totalTokens,
              handlerReused: true,
              handlerTemplateId,
            };
          }
        }
      } catch (err) {
        // Handler reuse failure should NOT block analysis — continue with normal flow
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Handler reuse check failed, continuing with normal flow', { error: msg });
      }
    }

    // Phase 2: UNDERSTAND
    await this.onProgress?.('understand', 'Browsing and analyzing page');
    const p2Start = Date.now();
    const understandResult = await this.understand(intent);
    log.info('Phase 2 complete', {
      intentMatch: understandResult.intentMatch,
      contentAreas: understandResult.contentAreas.length,
      interactiveElements: understandResult.interactiveElements?.length ?? 0,
      suggestedKeywords: understandResult.suggestedKeywords ?? [],
      pageStructurePreview: understandResult.pageStructure.slice(0, 200),
      durationMs: Date.now() - p2Start,
    });

    // Phase 3: BUILD HANDLER
    await this.onProgress?.('build_handler', 'Building extraction recipe');
    const p3Start = Date.now();
    const handlerResult = await this.buildHandler(intent, understandResult);
    log.info('Phase 3 complete', {
      steps: handlerResult.handler.steps.length,
      pattern: handlerResult.handler.urlPattern,
      durationMs: Date.now() - p3Start,
    });

    // Register handler for future reuse after Phase 3 (if reuser is available)
    if (this.handlerReuser && this.fingerprinter && !handlerReused) {
      try {
        // Get page HTML for fingerprinting if we don't already have it
        let htmlForRegistration = reusedPageHtml;
        if (!htmlForRegistration) {
          try {
            const pageResult = await this.mcpClient.callTool('get_page_content', {
              includeHtml: true,
            });
            const rawText = pageResult.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('');
            const parsed = JSON.parse(rawText);
            if (parsed && typeof parsed.html === 'string') {
              htmlForRegistration = parsed.html;
            }
          } catch {
            log.debug('Could not get page HTML for handler registration');
          }
        }

        if (htmlForRegistration) {
          const fp = this.fingerprinter.fingerprint(htmlForRegistration, intent.sampleUrl);
          this.handlerReuser.registerHandler(fp.fingerprint, handlerResult.handler, [
            intent.sampleUrl,
          ]);

          // Persist to handler store if available
          if (this.handlerStore && this.tenantId) {
            const domain = new URL(intent.sampleUrl).hostname;
            const fpHex = fp.fingerprint.toString(16).padStart(16, '0');
            this.handlerStore
              .saveHandler({
                tenantId: this.tenantId,
                domain,
                urlPattern: handlerResult.handler.urlPattern,
                fingerprint: fpHex,
                handler: handlerResult.handler,
                trainedOn: [intent.sampleUrl],
              })
              .catch((saveErr: unknown) => {
                const saveMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
                log.warn('Failed to persist handler to store', { error: saveMsg });
              });
          }

          log.info('Registered new handler for future reuse', {
            templateId: `tpl-${fp.fingerprint.toString(16).padStart(16, '0').slice(0, 8)}`,
            url: intent.sampleUrl,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to register handler for reuse', { error: msg });
      }
    }

    // Phase 4: REPLAY
    await this.onProgress?.('replay', 'Extracting content');
    const p4Start = Date.now();
    const replayResult = await this.replay(handlerResult.handler, intent.sampleUrl);
    log.info('Phase 4 complete', {
      success: replayResult.success,
      contentLength: replayResult.content.body.length,
      durationMs: Date.now() - p4Start,
    });

    const totalDurationMs = Date.now() - loopStart;
    log.info('Intelligence loop complete', {
      llmCallCount: this.llmCallCount,
      totalTokens: this.totalTokens,
      totalDurationMs,
    });

    return {
      intent,
      mapIntent: mapResult,
      understand: understandResult,
      buildHandler: handlerResult,
      replay: replayResult,
      llmCallCount: this.llmCallCount,
      totalTokens: this.totalTokens,
      handlerReused: false,
    };
  }

  /**
   * Phase 1: MAP+INTENT — filter URLs by user intent.
   * 1 LLM call, no tools.
   *
   * Security: V1 — filteredUrls are validated against input sitemap to prevent SSRF.
   * Security: V2 — intent strings are sanitized before prompt interpolation.
   */
  async mapIntent(intent: CrawlIntent, sitemapUrls: string[]): Promise<MapIntentResult> {
    const truncatedUrls = sitemapUrls.slice(0, MAX_SITEMAP_URLS);

    // ── SHORT-CIRCUIT: single URL doesn't need LLM filtering ──
    if (truncatedUrls.length <= 1) {
      log.info('Phase 1: single URL — skipping LLM call', { url: intent.sampleUrl });
      return {
        filteredUrls: truncatedUrls.length === 1 ? truncatedUrls : [intent.sampleUrl],
        intentSummary: intent.intent,
        urlPattern: intent.sampleUrl,
      };
    }
    // ── END SHORT-CIRCUIT ──

    // V2: Sanitize user-provided strings before interpolation into prompts
    const sanitizedIntent = CrawlIntelligenceService.sanitizePromptInput(
      intent.intent,
      MAX_INTENT_LENGTH,
    );
    const sanitizedSiteUrl = CrawlIntelligenceService.sanitizeUrl(intent.siteUrl);
    const sanitizedSampleUrl = CrawlIntelligenceService.sanitizeUrl(intent.sampleUrl);

    const userMessage = [
      `User intent: ${sanitizedIntent}`,
      `Site: ${sanitizedSiteUrl}`,
      `Sample URL: ${sanitizedSampleUrl}`,
      '',
      `Sitemap URLs (${truncatedUrls.length} of ${sitemapUrls.length}):`,
      ...truncatedUrls.map((u) => `- ${u}`),
    ].join('\n');

    try {
      const response = await this.llmClient.chat(MAP_INTENT_SYSTEM_PROMPT, [
        { role: 'user', content: userMessage },
      ]);
      this.llmCallCount++;
      log.debug('Phase 1 LLM response', { responsePreview: response.slice(0, 300) });

      const parsed = this.parseJson<MapIntentResult>(response, 'mapIntent');

      // V1: Validate filteredUrls are a subset of the input sitemap to prevent SSRF.
      // The LLM can hallucinate arbitrary URLs (e.g., internal metadata endpoints).
      // Only allow URLs that were in the original sitemap.
      // R1-3: Return the SITEMAP version of the URL (not the LLM's), preventing
      // subtle URL modifications (added trailing slash, case changes) from leaking through.
      const normalizedToOriginal = new Map<string, string>();
      for (const u of sitemapUrls) {
        if (typeof u === 'string') {
          normalizedToOriginal.set(u.toLowerCase().trim(), u);
        }
      }
      const rawFiltered = Array.isArray(parsed.filteredUrls) ? parsed.filteredUrls : [];
      const sanitizedFiltered: string[] = [];
      for (const u of rawFiltered) {
        if (typeof u !== 'string') {
          log.warn('Phase 1: rejected non-string entry in filteredUrls', { value: String(u) });
          continue;
        }
        const original = normalizedToOriginal.get(u.toLowerCase().trim());
        if (original) {
          sanitizedFiltered.push(original);
        } else {
          log.warn('Phase 1: rejected LLM-suggested URL not in sitemap', {
            url: u.slice(0, 200),
          });
        }
      }

      if (sanitizedFiltered.length < rawFiltered.length) {
        log.info('Phase 1: filtered out invalid URLs', {
          original: rawFiltered.length,
          valid: sanitizedFiltered.length,
          rejected: rawFiltered.length - sanitizedFiltered.length,
        });
      }

      return {
        filteredUrls: sanitizedFiltered,
        intentSummary: parsed.intentSummary || intent.intent,
        urlPattern: parsed.urlPattern || '*',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Phase 1 (mapIntent) failed', { error: msg });
      return {
        filteredUrls: [],
        intentSummary: intent.intent,
        urlPattern: '*',
      };
    }
  }

  /**
   * Phase 2: UNDERSTAND — browse sample page with MCP tools.
   * Multi-turn tool loop, max MAX_UNDERSTAND_ITERATIONS iterations.
   *
   * B1: Uses submit_understanding tool for structured output instead of JSON parsing.
   *   Wrap-up iterations (7-8) force ONLY submit_understanding with toolChoice='required'.
   *   Fallback (FIX 4): Build partial result from accumulated tool data.
   */
  async understand(intent: CrawlIntent): Promise<UnderstandResult> {
    // FIX 4: Accumulate tool results for partial extraction if max-iter hit
    const toolHistory: Array<{
      tool: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
    }> = [];

    try {
      // Get MCP tools and filter to allowed set
      const allTools = await this.mcpClient.listTools();
      const toolDefs = this.convertMcpToolsToDefinitions(
        allTools.filter((t) => UNDERSTAND_TOOL_ALLOWLIST.has(t.name)),
      );

      if (toolDefs.length === 0) {
        log.warn('No MCP tools available for UNDERSTAND phase');
        return this.fallbackUnderstandResult('no_tools');
      }

      // Add structured output tool for wrap-up
      const submitUnderstandingTool: ToolDefinition = {
        name: SUBMIT_UNDERSTANDING_TOOL,
        description:
          'Submit your page analysis results. Call this tool when you have finished analyzing the page. ' +
          'Provide your findings as the input — pageStructure, contentAreas, interactiveElements, ' +
          'suggestedKeywords, and intentMatch.',
        input_schema: {
          type: 'object',
          properties: {
            pageStructure: {
              type: 'string',
              description: 'Description of the overall page layout and key sections',
            },
            contentAreas: {
              type: 'array',
              description: 'Key content areas identified on the page',
              items: {
                type: 'object',
                properties: {
                  selector: { type: 'string', description: 'CSS selector for this content area' },
                  description: { type: 'string', description: 'What this area contains' },
                  matchesIntent: {
                    type: 'boolean',
                    description: 'Whether this area matches the user intent',
                  },
                },
                required: ['selector', 'description', 'matchesIntent'],
              },
            },
            interactiveElements: {
              type: 'array',
              description: 'Interactive elements found (accordions, tabs, modals, etc.)',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    description:
                      'Element type: accordion|tab|expandable|modal|popup|pagination|dropdown',
                  },
                  selector: {
                    type: 'string',
                    description: 'CSS selector to trigger this element',
                  },
                  description: {
                    type: 'string',
                    description: 'What happens when interacted with',
                  },
                },
                required: ['type', 'selector', 'description'],
              },
            },
            suggestedKeywords: {
              type: 'array',
              description: 'Keywords from page content relating to user intent',
              items: { type: 'string' },
            },
            intentMatch: {
              type: 'boolean',
              description: 'Whether the page matches the user intent',
            },
          },
          required: ['pageStructure', 'contentAreas', 'intentMatch'],
        },
      };
      const allToolDefs = [...toolDefs, submitUnderstandingTool];

      // V2: Sanitize user-provided strings before interpolation into prompts
      const sanitizedIntent = CrawlIntelligenceService.sanitizePromptInput(
        intent.intent,
        MAX_INTENT_LENGTH,
      );
      const sanitizedSampleUrl = CrawlIntelligenceService.sanitizeUrl(intent.sampleUrl);

      const messages: Array<{ role: string; content: string | ContentBlock[] }> = [
        {
          role: 'user',
          content: [
            `User intent: ${sanitizedIntent}`,
            `Sample URL to analyze: ${sanitizedSampleUrl}`,
            '',
            "Please navigate to the URL and analyze its structure to find content matching the user's intent.",
          ].join('\n'),
        },
      ];

      let iterations = 0;

      while (iterations < MAX_UNDERSTAND_ITERATIONS) {
        iterations++;
        await this.onProgress?.(
          'understand',
          `iteration ${iterations}/${MAX_UNDERSTAND_ITERATIONS}`,
        );
        const iterStart = Date.now();

        // FIX 2+B1: At WRAP_UP_ITERATION, inject wrap-up message to force submit_understanding
        if (iterations === WRAP_UP_ITERATION) {
          log.info('Phase 2: injecting wrap-up prompt', { iteration: iterations });
          messages.push({
            role: 'user',
            content:
              'IMPORTANT: You have used most of your available tool calls. ' +
              'Based on everything you have observed so far, call the submit_understanding tool NOW ' +
              'with your complete page analysis. Include all contentAreas, interactiveElements, ' +
              'and suggestedKeywords you have discovered.',
          });
        }

        // FIX 8+B1: Graduated tool choice strategy
        //   iterations 1-4: 'required' — MUST navigate and explore (prevents hallucination)
        //   iterations 5-6: 'auto'     — LLM decides when it has enough data
        //   iterations 7-8: 'required' — MUST call submit_understanding (structured output)
        const toolChoiceForIteration =
          iterations <= FORCE_TOOL_ITERATIONS
            ? ('required' as const)
            : iterations >= WRAP_UP_ITERATION
              ? ('required' as const)
              : undefined; // defaults to 'auto'

        // On wrap-up iterations, provide ONLY submit_understanding tool
        // This guarantees the LLM calls it (since toolChoice='required' means "must call one tool")
        const toolsForIteration =
          iterations >= WRAP_UP_ITERATION ? [submitUnderstandingTool] : allToolDefs;

        log.info('Phase 2 tool choice', {
          iteration: iterations,
          toolChoice: toolChoiceForIteration ?? 'auto',
          reason:
            iterations <= FORCE_TOOL_ITERATIONS
              ? 'force_navigation'
              : iterations >= WRAP_UP_ITERATION
                ? 'force_structured_output'
                : 'auto',
        });

        const result = await this.llmClient.chatWithToolUse(
          UNDERSTAND_SYSTEM_PROMPT,
          messages,
          toolsForIteration,
          toolChoiceForIteration ? { toolChoice: toolChoiceForIteration } : undefined,
        );
        this.llmCallCount++;
        this.trackTokens(result);

        const iterDurationMs = Date.now() - iterStart;

        // FIX 7: Enhanced logging — always log iteration details
        log.info('Phase 2 iteration', {
          iteration: iterations,
          maxIterations: MAX_UNDERSTAND_ITERATIONS,
          finishReason: result.finishReason,
          toolCallCount: result.toolCalls.length,
          toolNames: result.toolCalls.map((tc) => tc.name),
          hasText: Boolean(result.text),
          textLength: result.text?.length ?? 0,
          textPreview: result.text ? result.text.slice(0, 200) : '(none)',
          tokens: result.usage?.totalTokens,
          llmDurationMs: iterDurationMs,
          wrapUpActive: iterations >= WRAP_UP_ITERATION,
        });

        // B1: Check if LLM called submit_understanding before general event emission
        const submitCall =
          result.finishReason === 'tool-calls' && result.toolCalls.length > 0
            ? result.toolCalls.find((tc) => tc.name === SUBMIT_UNDERSTANDING_TOOL)
            : undefined;

        if (result.finishReason === 'tool-calls' && result.toolCalls.length > 0) {
          // B1: Extract structured result from submit_understanding
          if (submitCall) {
            const input = submitCall.input as Record<string, unknown>;
            log.info('Phase 2: structured output via submit_understanding', {
              iteration: iterations,
              contentAreas: Array.isArray(input.contentAreas)
                ? (input.contentAreas as unknown[]).length
                : 0,
              intentMatch: input.intentMatch,
            });

            return {
              pageStructure: (input.pageStructure as string) || 'Unknown page structure',
              contentAreas: Array.isArray(input.contentAreas)
                ? (input.contentAreas as UnderstandResult['contentAreas'])
                : [],
              interactiveElements: Array.isArray(input.interactiveElements)
                ? (input.interactiveElements as NonNullable<
                    UnderstandResult['interactiveElements']
                  >)
                : [],
              suggestedKeywords: Array.isArray(input.suggestedKeywords)
                ? (input.suggestedKeywords as string[])
                : [],
              intentMatch: Boolean(input.intentMatch),
            };
          }

          // Otherwise, execute browse tools as before
          // Build assistant message with tool_use blocks
          const assistantContent: ContentBlock[] = [];
          if (result.text) {
            assistantContent.push({ type: 'text', text: result.text });
          }
          for (const tc of result.toolCalls) {
            assistantContent.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
          messages.push({ role: 'assistant', content: assistantContent });

          // Execute tool calls via MCP
          const toolResults: ContentBlock[] = [];
          for (const tc of result.toolCalls) {
            const toolStart = Date.now();
            const toolResultText = await this.executeMcpTool(tc.name, tc.input);
            const toolDurationMs = Date.now() - toolStart;

            // FIX 4: Accumulate tool results for partial extraction
            toolHistory.push({
              tool: tc.name,
              args: tc.input,
              result: toolResultText.text,
              isError: toolResultText.isError,
            });

            // FIX 7: Enhanced tool logging
            log.info('Phase 2 tool executed', {
              iteration: iterations,
              tool: tc.name,
              args: tc.input,
              isError: toolResultText.isError,
              resultLength: toolResultText.text.length,
              resultPreview: toolResultText.text.slice(0, 200),
              durationMs: toolDurationMs,
            });

            // FIX 9: Truncate large tool results to prevent context overflow.
            // get_page_content can return 600K+ chars — overflows gpt-4o-mini's 128K context.
            // Full result is preserved in toolHistory for Phase 4 partial extraction.
            let contextContent = toolResultText.text;
            if (contextContent.length > MAX_TOOL_RESULT_IN_CONTEXT) {
              log.info('Phase 2: truncating tool result for conversation context', {
                tool: tc.name,
                originalLength: contextContent.length,
                truncatedTo: MAX_TOOL_RESULT_IN_CONTEXT,
              });
              contextContent =
                contextContent.slice(0, MAX_TOOL_RESULT_IN_CONTEXT) +
                `\n\n[... truncated from ${contextContent.length} to ${MAX_TOOL_RESULT_IN_CONTEXT} chars. Use extract_elements with specific CSS selectors to get targeted content.]`;
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: contextContent,
              is_error: toolResultText.isError,
            });
          }
          messages.push({ role: 'user', content: toolResults });
        } else {
          // Text response without tool calls — normal during 'auto' phase (iter 5-6).
          // On wrap-up (iter 7-8) this shouldn't happen since toolChoice='required',
          // but handle gracefully. Loop continues — next wrap-up iteration will
          // force structured output via submit_understanding.
          const rawText = result.text || '';
          log.info('Phase 2: text response without tool calls', {
            iteration: iterations,
            textLength: rawText.length,
            textPreview: rawText.slice(0, 200),
          });
          // Append assistant text to messages so next iteration has context
          if (rawText) {
            messages.push({ role: 'assistant', content: rawText });
          }
        }
      }

      // FIX 4: Build partial result from accumulated tool data instead of empty fallback
      if (toolHistory.length > 0) {
        log.info('Phase 2: building partial result from tool history', {
          toolCallCount: toolHistory.length,
          toolNames: toolHistory.map((t) => t.tool),
          reason: iterations >= MAX_UNDERSTAND_ITERATIONS ? 'max_iterations' : 'parse_failure',
        });
        return this.buildPartialUnderstandResult(toolHistory, intent);
      }

      log.warn('Phase 2: no tool data accumulated, returning fallback', {
        iterations,
        maxIterations: MAX_UNDERSTAND_ITERATIONS,
      });
      return this.fallbackUnderstandResult('max_iterations_no_data');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Phase 2 (understand) failed with exception', {
        error: msg,
        toolHistoryLength: toolHistory.length,
      });

      // FIX 4: Even on error, try to salvage partial results
      if (toolHistory.length > 0) {
        log.info('Phase 2: building partial result from tool history after error', {
          toolCallCount: toolHistory.length,
        });
        return this.buildPartialUnderstandResult(toolHistory, intent);
      }
      return this.fallbackUnderstandResult('error');
    }
  }

  /**
   * Phase 3: BUILD HANDLER — generate PageHandler from understanding.
   * 1 LLM call, no tools.
   */
  async buildHandler(
    intent: CrawlIntent,
    understanding: UnderstandResult,
  ): Promise<BuildHandlerResult> {
    const matchingAreas = understanding.contentAreas
      .filter((a) => a.matchesIntent)
      .map((a) => `- ${a.selector}: ${a.description}`)
      .join('\n');

    const interactiveSection =
      understanding.interactiveElements && understanding.interactiveElements.length > 0
        ? [
            '',
            `Interactive elements found (IMPORTANT — generate click/expand steps for these):`,
            ...understanding.interactiveElements.map(
              (e) => `- ${e.type}: ${e.selector} — ${e.description}`,
            ),
          ]
        : [];

    const keywordsSection =
      understanding.suggestedKeywords && understanding.suggestedKeywords.length > 0
        ? ['', `Keywords related to user intent: ${understanding.suggestedKeywords.join(', ')}`]
        : [];

    // V2: Sanitize user-provided strings before interpolation into prompts
    const sanitizedIntent = CrawlIntelligenceService.sanitizePromptInput(
      intent.intent,
      MAX_INTENT_LENGTH,
    );
    const sanitizedSampleUrl = CrawlIntelligenceService.sanitizeUrl(intent.sampleUrl);

    const userMessage = [
      `User intent: ${sanitizedIntent}`,
      `Sample URL: ${sanitizedSampleUrl}`,
      '',
      `Page structure: ${understanding.pageStructure}`,
      '',
      `Content areas matching intent:`,
      matchingAreas || '- No specific areas identified',
      '',
      `All content areas:`,
      ...understanding.contentAreas.map(
        (a) => `- ${a.selector}: ${a.description} (matches: ${a.matchesIntent})`,
      ),
      ...interactiveSection,
      ...keywordsSection,
    ].join('\n');

    try {
      const response = await this.llmClient.chat(BUILD_HANDLER_SYSTEM_PROMPT, [
        { role: 'user', content: userMessage },
      ]);
      this.llmCallCount++;
      log.debug('Phase 3 LLM response', { responsePreview: response.slice(0, 300) });

      const parsed = this.parseJson<BuildHandlerResult>(response, 'buildHandler');

      // Validate the handler has required fields
      const handler = parsed.handler;
      if (!handler || !handler.steps || !handler.extractionSelectors?.content) {
        log.warn('LLM produced incomplete handler, using defaults');
        return {
          handler: {
            urlPattern: intent.sampleUrl,
            description: intent.intent,
            steps: [
              {
                action: 'navigate',
                value: intent.sampleUrl,
                description: 'Navigate to target page',
              },
            ],
            extractionSelectors: { content: 'body' },
          },
          reasoning: 'Fallback handler — LLM output was incomplete',
        };
      }

      return {
        handler: {
          urlPattern: handler.urlPattern || intent.sampleUrl,
          description: handler.description || intent.intent,
          steps: handler.steps,
          extractionSelectors: handler.extractionSelectors,
        },
        reasoning: parsed.reasoning || 'No reasoning provided',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Phase 3 (buildHandler) failed', { error: msg });
      return {
        handler: {
          urlPattern: intent.sampleUrl,
          description: intent.intent,
          steps: [
            {
              action: 'navigate',
              value: intent.sampleUrl,
              description: 'Navigate to target page',
            },
          ],
          extractionSelectors: { content: 'body' },
        },
        reasoning: `Fallback handler due to error: ${msg}`,
      };
    }
  }

  /**
   * Phase 4: REPLAY — execute handler mechanically (no LLM).
   * Maps handler steps to MCP tool calls.
   */
  async replay(handler: IPageHandler, targetUrl: string): Promise<ReplayResult> {
    const stepResults: Array<{ step: IPlaywrightStep; success: boolean; error?: string }> = [];

    // Execute each step
    for (let i = 0; i < handler.steps.length; i++) {
      const step = handler.steps[i];
      const mcpToolName = ACTION_TO_MCP_TOOL[step.action];
      if (!mcpToolName) {
        log.warn('Replay: unknown action', { stepIndex: i, action: step.action });
        stepResults.push({
          step,
          success: false,
          error: `Unknown action: ${step.action}`,
        });
        continue;
      }

      try {
        const args = this.buildReplayToolArgs(step, targetUrl);
        const stepStart = Date.now();
        const result = await this.mcpClient.callTool(mcpToolName, args);
        const durationMs = Date.now() - stepStart;

        if (result.isError) {
          const errorText = this.extractTextFromMcpResult(result);
          log.debug('Replay step failed', {
            stepIndex: i,
            tool: mcpToolName,
            error: errorText,
            durationMs,
          });
          stepResults.push({ step, success: false, error: errorText });
        } else {
          log.debug('Replay step succeeded', { stepIndex: i, tool: mcpToolName, durationMs });
          stepResults.push({ step, success: true });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.debug('Replay step threw', { stepIndex: i, tool: mcpToolName, error: msg });
        stepResults.push({ step, success: false, error: msg });
      }
    }

    // Extract content using handler's extractionSelectors
    let title: string | undefined;
    let body = '';
    let rawHtml: string | undefined;
    let metadata: Record<string, string> | undefined;

    try {
      // Get full page content as baseline (always useful for fallback)
      const pageResult = await this.mcpClient.callTool('get_page_content', {
        includeText: true,
        includeHtml: true,
      });
      const pageContent = this.extractTextFromMcpResult(pageResult, 'get_page_content');

      // Extract raw HTML from the MCP page content result
      try {
        const rawText = pageResult.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.html === 'string' && parsed.html.length > 0) {
          rawHtml = parsed.html;
          log.info('Phase 4 raw HTML extracted', { rawHtmlLength: parsed.html.length });
        }
      } catch {
        log.debug('Could not parse raw HTML from MCP page content result', {
          contentBlockCount: pageResult.content.length,
        });
      }

      // FIX 7: Log page content availability
      log.info('Phase 4 page content retrieved', {
        pageContentLength: pageContent.length,
        contentSelector: handler.extractionSelectors.content,
        titleSelector: handler.extractionSelectors.title || '(none)',
      });

      // Extract main content via selector
      if (handler.extractionSelectors.content) {
        try {
          const contentResult = await this.mcpClient.callTool('extract_elements', {
            selector: handler.extractionSelectors.content,
          });
          body = this.extractTextFromMcpResult(contentResult, 'extract_elements');
          // FIX 5: If selector extraction returned empty, fall back to full page
          if (!body || body.trim().length === 0) {
            log.warn('Phase 4 content selector returned empty, falling back to full page', {
              selector: handler.extractionSelectors.content,
              pageContentLength: pageContent.length,
            });
            body = pageContent;
          } else {
            log.info('Phase 4 content extracted via selector', {
              selector: handler.extractionSelectors.content,
              contentLength: body.length,
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn('Phase 4 content selector extraction failed, using full page', {
            selector: handler.extractionSelectors.content,
            error: errMsg,
            pageContentLength: pageContent.length,
          });
          body = pageContent;
        }
      } else {
        body = pageContent;
      }

      // Extract title if selector provided
      if (handler.extractionSelectors.title) {
        try {
          const titleResult = await this.mcpClient.callTool('extract_elements', {
            selector: handler.extractionSelectors.title,
          });
          const titleText = this.extractTextFromMcpResult(titleResult, 'extract_elements');
          // FIX 5: Don't use empty extraction as title
          if (titleText && titleText.trim().length > 0) {
            title = titleText;
          }
          log.debug('Phase 4 title extraction', {
            selector: handler.extractionSelectors.title,
            titleLength: titleText.length,
            isEmpty: !titleText || titleText.trim().length === 0,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.debug('Title extraction failed', {
            selector: handler.extractionSelectors.title,
            error: errMsg,
          });
        }
      }

      // Extract metadata if selectors provided
      if (handler.extractionSelectors.metadata) {
        metadata = {};
        for (const [key, selector] of Object.entries(handler.extractionSelectors.metadata)) {
          try {
            const metaResult = await this.mcpClient.callTool('extract_elements', {
              selector,
            });
            const metaText = this.extractTextFromMcpResult(metaResult, 'extract_elements');
            // FIX 5: Only store non-empty metadata
            if (metaText && metaText.trim().length > 0) {
              metadata[key] = metaText;
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.debug('Metadata extraction failed', { key, selector, error: errMsg });
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Content extraction failed in replay', { error: msg });
    }

    const allStepsSucceeded = stepResults.every((r) => r.success);
    const hasContent = body.length > 0;

    return {
      content: { title, body, rawHtml, metadata },
      success: allStepsSucceeded && hasContent,
      stepResults,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert MCPTool[] to ToolDefinition[] for use with chatWithToolUse.
   *
   * Passes the raw JSON Schema through directly — jsonSchemaToZod in the
   * tool-adapters layer handles all JSON Schema patterns (anyOf, oneOf,
   * nested objects, enums, etc.). Previous version stripped properties
   * to {type, description} which lost complex schemas from Zod-based
   * MCP servers.
   */
  private convertMcpToolsToDefinitions(mcpTools: MCPTool[]): ToolDefinition[] {
    return mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description || tool.name,
      input_schema: tool.inputSchema as ToolDefinition['input_schema'],
    }));
  }

  /**
   * Execute an MCP tool and return the text result.
   * Sanitizes args to prevent common LLM mistakes (wrong timeout units, etc.)
   */
  private async executeMcpTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    try {
      const sanitizedArgs = this.sanitizeMcpArgs(name, args);
      const result = await this.mcpClient.callTool(name, sanitizedArgs);
      const text = this.extractTextFromMcpResult(result, name);
      return { text, isError: Boolean(result.isError) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('MCP tool call failed', { tool: name, error: msg });
      return { text: `Error calling ${name}: ${msg}`, isError: true };
    }
  }

  /**
   * Sanitize MCP tool arguments to fix common LLM mistakes.
   *
   * BUG FIX 1: LLMs frequently send timeout:30 (meaning 30 seconds) but
   * the MCP navigate tool expects milliseconds. We detect values <1000
   * and multiply by 1000, then clamp to [5000, 60000] range.
   */
  private sanitizeMcpArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...args };

    if (name === 'navigate' && typeof sanitized.timeout === 'number') {
      // LLMs commonly send seconds instead of milliseconds
      if (sanitized.timeout > 0 && sanitized.timeout < 1000) {
        log.debug('Correcting navigate timeout from seconds to ms', {
          original: sanitized.timeout,
          corrected: sanitized.timeout * 1000,
        });
        sanitized.timeout = sanitized.timeout * 1000;
      }
      // Enforce minimum 5s, maximum 60s
      sanitized.timeout = Math.max(5000, Math.min(60000, sanitized.timeout as number));
    }

    // Clamp wait_for_element timeout similarly
    if (name === 'wait_for_element' && typeof sanitized.timeout === 'number') {
      if (sanitized.timeout > 0 && sanitized.timeout < 1000) {
        sanitized.timeout = sanitized.timeout * 1000;
      }
      sanitized.timeout = Math.max(3000, Math.min(30000, sanitized.timeout as number));
    }

    return sanitized;
  }

  /**
   * Extract text from an MCP ToolCallResult.
   * MCP results contain content[] with text entries.
   *
   * BUG FIX 2: extract_elements returns JSON like {"elements":[{"text":"..."}]}.
   * We parse this and concatenate element texts for clean content extraction.
   */
  private extractTextFromMcpResult(result: ToolCallResult, toolName?: string): string {
    const raw = result.content
      .map((c) => {
        if (c.type === 'text') {
          return (c as { type: 'text'; text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    // FIX 6: Parse get_page_content JSON → extract .text or .title
    // get_page_content returns { url, title, html?, text?, screenshot? }
    if (toolName === 'get_page_content') {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          return parsed.text;
        }
        if (typeof parsed.title === 'string' && parsed.title.length > 0) {
          return parsed.title;
        }
      } catch (e) {
        log.debug('extractTextFromMcpResult: get_page_content JSON parse failed, returning raw', {
          error: e instanceof Error ? e.message : String(e),
          rawPreview: raw.slice(0, 100),
        });
      }
      return raw;
    }

    // FIX 5: Parse extract_elements JSON → concatenate text content
    // Also handles empty elements array (returns '' instead of raw JSON)
    if (toolName === 'extract_elements' || this.looksLikeElementsJson(raw)) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.elements)) {
          const texts = parsed.elements.map((e: { text?: string }) => e.text || '').filter(Boolean);
          if (texts.length > 0) {
            return texts.join('\n');
          }
          // FIX 5: Empty elements array → return empty string, not raw JSON
          log.debug('extract_elements returned empty array', {
            count: parsed.count ?? 0,
            toolName,
          });
          return '';
        }
      } catch (e) {
        // X2: Not valid JSON — log and return raw text
        log.debug('extractTextFromMcpResult: JSON parse failed, returning raw text', {
          error: e instanceof Error ? e.message : String(e),
          toolName,
          rawPreview: raw.slice(0, 100),
        });
      }
    }

    return raw;
  }

  /**
   * Heuristic check: does this text look like an extract_elements response?
   */
  private looksLikeElementsJson(text: string): boolean {
    return text.startsWith('{"elements":') || text.startsWith('{"elements" :');
  }

  /**
   * Build MCP tool arguments for a replay step.
   */
  private buildReplayToolArgs(step: IPlaywrightStep, targetUrl: string): Record<string, unknown> {
    switch (step.action) {
      case 'navigate':
        return { url: step.value || targetUrl };
      case 'click':
        return { selector: step.selector };
      case 'type':
        return { selector: step.selector, text: step.value };
      case 'scroll':
        // MCP scroll tool expects { direction, amount?, selector? }
        // Handler's value field maps to direction (default: 'down')
        return {
          direction: step.value || 'down',
          ...(step.selector ? { selector: step.selector } : {}),
        };
      case 'wait':
        return { selector: step.selector };
      case 'extract':
        return { selector: step.selector };
      case 'execute_js':
        // MCP execute_javascript tool expects { code: string }
        return { code: step.value };
      default:
        return {};
    }
  }

  /**
   * Track token usage from a ToolUseResult.
   */
  private trackTokens(result: ToolUseResult): void {
    if (result.usage) {
      this.totalTokens += result.usage.totalTokens;
    }
  }

  /**
   * Parse JSON from LLM response, handling common formatting issues.
   */
  private parseJson<T>(text: string, phase: string): T {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned) as T;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to parse JSON in ${phase}`, {
        error: msg,
        responsePreview: cleaned.slice(0, 200),
      });
      throw new Error(`Invalid JSON response in ${phase}: ${msg}`);
    }
  }

  /**
   * FIX 4: Build a partial UnderstandResult from accumulated MCP tool data.
   * When the LLM tool loop times out or JSON parsing fails, we can still
   * extract useful information from the tools that were executed.
   */
  private buildPartialUnderstandResult(
    toolHistory: Array<{
      tool: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
    }>,
    intent: CrawlIntent,
  ): UnderstandResult {
    let pageStructure = '';
    const contentAreas: Array<{
      selector: string;
      description: string;
      matchesIntent: boolean;
    }> = [];
    const interactiveElements: Array<{
      type: string;
      selector: string;
      description: string;
    }> = [];

    // Extract page structure from get_page_content results
    const contentResults = toolHistory.filter((t) => t.tool === 'get_page_content' && !t.isError);
    if (contentResults.length > 0) {
      const lastContent = contentResults[contentResults.length - 1].result;
      pageStructure = `Page loaded successfully. Content preview: ${lastContent.slice(0, PAGE_STRUCTURE_PREVIEW_LENGTH)}`;
    }

    // Extract content areas from extract_elements results
    const extractResults = toolHistory.filter((t) => t.tool === 'extract_elements' && !t.isError);
    for (const er of extractResults) {
      const selector = (er.args.selector as string) || 'unknown';
      const resultText = er.result;
      const hasContent =
        resultText.length > MIN_CONTENT_LENGTH_THRESHOLD && !resultText.includes('"count":0');

      if (hasContent) {
        contentAreas.push({
          selector,
          description: `Content found via ${selector} (${resultText.length} chars)`,
          matchesIntent: true, // If the LLM chose to extract it, it likely matches
        });
      }
    }

    // Check navigate results for page state
    const navResults = toolHistory.filter((t) => t.tool === 'navigate' && !t.isError);
    const pageLoaded = navResults.length > 0;

    // Detect interactive elements from page content
    if (contentResults.length > 0) {
      const pageText = contentResults[contentResults.length - 1].result.toLowerCase();
      if (pageText.includes('accordion') || pageText.includes('collapse')) {
        interactiveElements.push({
          type: 'accordion',
          selector: '.accordion, [data-accordion], .collapse',
          description: 'Accordion/collapsible elements detected in page content',
        });
      }
      if (
        pageText.includes('tab') &&
        (pageText.includes('tabpanel') || pageText.includes('tab-content'))
      ) {
        interactiveElements.push({
          type: 'tab',
          selector: '[role="tab"], .nav-tabs, .tab-content',
          description: 'Tab elements detected in page content',
        });
      }
    }

    log.info('Phase 2: partial result built from tool history', {
      pageStructureLength: pageStructure.length,
      contentAreasCount: contentAreas.length,
      interactiveElementsCount: interactiveElements.length,
      pageLoaded,
      toolsExecuted: toolHistory.length,
    });

    return {
      pageStructure: pageStructure || 'Page loaded but structure analysis incomplete',
      contentAreas,
      interactiveElements,
      suggestedKeywords: [], // Cannot infer keywords without LLM
      intentMatch: pageLoaded, // If we navigated successfully, assume content is present
    };
  }

  /**
   * Fallback result for Phase 2 when tool loop fails or times out.
   */
  private fallbackUnderstandResult(reason?: string): UnderstandResult {
    log.warn('Phase 2 returning fallback result', { reason: reason || 'unknown' });
    return {
      pageStructure: 'Unable to analyze page structure',
      contentAreas: [],
      interactiveElements: [],
      suggestedKeywords: [],
      intentMatch: false,
    };
  }

  // ---------------------------------------------------------------------------
  // V2: Input sanitization for prompt injection defense
  // ---------------------------------------------------------------------------

  /**
   * Sanitize user-provided text before interpolating into LLM prompts.
   * Strips control characters and truncates to maxLength.
   *
   * NOTE: This is defense-in-depth, not a complete prompt injection solution.
   * The real defense is output validation (V1 URL filtering) and principle-of-least-privilege
   * (Phase 2 tools are limited to UNDERSTAND_TOOL_ALLOWLIST).
   */
  static sanitizePromptInput(input: string, maxLength: number): string {
    if (!input || typeof input !== 'string') return '';

    // Strip control characters (C0 controls except \n, \t, \r)
    // eslint-disable-next-line no-control-regex
    let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Truncate
    if (sanitized.length > maxLength) {
      log.warn('Truncating user input for prompt safety', {
        originalLength: sanitized.length,
        maxLength,
      });
      sanitized = sanitized.slice(0, maxLength);
    }

    return sanitized;
  }

  /**
   * Sanitize and validate a URL string.
   * Only allows http/https schemes. Rejects internal, private, and metadata URLs.
   * EH3-01: Invalid URLs are rejected (return '') instead of passed through.
   * EH3-04: Blocks loopback, RFC 1918 private ranges, and link-local addresses.
   */
  static sanitizeUrl(url: string): string {
    if (!url || typeof url !== 'string') return '';

    let sanitized = url.trim().slice(0, MAX_URL_LENGTH);

    // Strip control characters
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Only allow http/https schemes
    try {
      const parsed = new URL(sanitized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        log.warn('Rejected non-HTTP URL', { url: sanitized.slice(0, 100) });
        return '';
      }
      // Block internal, private, and metadata endpoints (SSRF prevention)
      const hostname = parsed.hostname.toLowerCase();

      // Cloud metadata endpoints
      const blockedHosts = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];
      if (blockedHosts.includes(hostname) || hostname.endsWith('.internal')) {
        log.warn('Rejected blocked hostname (potential SSRF)', { hostname });
        return '';
      }

      // Loopback addresses
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '[::1]' ||
        hostname === '::1'
      ) {
        log.warn('Rejected loopback address (potential SSRF)', { hostname });
        return '';
      }

      // RFC 1918 private ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
      // Also link-local: 169.254.x.x
      if (CrawlIntelligenceService.isPrivateIp(hostname)) {
        log.warn('Rejected private/link-local IP (potential SSRF)', { hostname });
        return '';
      }
    } catch {
      // EH3-01: Invalid URL — reject instead of passing through.
      // A malformed URL that bypasses scheme/host checks is a security risk.
      log.warn('Rejected unparseable URL', { url: sanitized.slice(0, 100) });
      return '';
    }

    return sanitized;
  }

  /**
   * Check if a hostname is an RFC 1918 private IP or link-local address.
   */
  private static isPrivateIp(hostname: string): boolean {
    // Quick check: must start with a digit
    if (!/^\d/.test(hostname)) return false;

    const parts = hostname.split('.');
    if (parts.length !== 4) return false;

    const octets = parts.map(Number);
    if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

    // 10.0.0.0/8
    if (octets[0] === 10) return true;
    // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    // 192.168.0.0/16
    if (octets[0] === 192 && octets[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (octets[0] === 169 && octets[1] === 254) return true;

    return false;
  }
}
