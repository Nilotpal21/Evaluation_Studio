/**
 * SearchAI-Aware Tool Executor
 *
 * Wraps an inner ToolExecutor and intercepts search tool calls (search_vector,
 * search_structured, etc.), routing them to the SearchAIToolHandler.
 * Also intercepts attachment tool calls (get_attachment, list_attachments)
 * when an AttachmentToolExecutor is provided.
 *
 * All other tool calls are delegated to the inner executor unchanged.
 *
 * This is wired in LLMWiringService.wireToolExecutor() when the session's
 * agent tools include any search tool names.
 */

import type { ToolExecutor } from '@abl/compiler/platform';
import {
  SearchAIToolHandler,
  isSearchAITool,
  type SearchAIToolName,
} from './search-ai-tool-handler.js';
import { isAttachmentTool } from '../../tools/attachment-tool-executor.js';
import type {
  AttachmentToolExecutor,
  AttachmentToolContext,
} from '../../tools/attachment-tool-executor.js';
import type { SearchAIClientConfig } from '@agent-platform/search-ai-sdk';
import { SearchAICircuitBreaker } from './search-ai-circuit-breaker.js';

export interface SearchAIAwareToolExecutorConfig {
  searchConfig: SearchAIClientConfig;
  /** Optional attachment tool executor — if not provided, attachment tools fall through to inner. */
  attachmentToolExecutor?: AttachmentToolExecutor;
  /** Required when attachmentToolExecutor is provided. */
  attachmentContext?: AttachmentToolContext;
}

export class SearchAIAwareToolExecutor implements ToolExecutor {
  private readonly inner: ToolExecutor;
  private readonly searchHandler: SearchAIToolHandler;
  private readonly attachmentExecutor?: AttachmentToolExecutor;
  private readonly attachmentContext?: AttachmentToolContext;
  private readonly circuitBreaker?: SearchAICircuitBreaker;

  constructor(
    inner: ToolExecutor,
    searchConfig: SearchAIClientConfig,
    opts?: {
      attachmentToolExecutor?: AttachmentToolExecutor;
      attachmentContext?: AttachmentToolContext;
      tenantId?: string;
    },
  ) {
    this.inner = inner;
    this.searchHandler = new SearchAIToolHandler(searchConfig);
    this.attachmentExecutor = opts?.attachmentToolExecutor;
    this.attachmentContext = opts?.attachmentContext;
    if (opts?.tenantId) {
      this.circuitBreaker = new SearchAICircuitBreaker(opts.tenantId);
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (isSearchAITool(toolName)) {
      return this.executeSearchTool(toolName, params, timeoutMs);
    }
    if (isAttachmentTool(toolName) && this.attachmentExecutor && this.attachmentContext) {
      return this.attachmentExecutor.execute(toolName, params, this.attachmentContext);
    }
    return this.inner.execute(toolName, params, timeoutMs);
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    // Split into search, attachment, and other calls
    const searchCalls: Array<{ name: SearchAIToolName; params: Record<string, unknown> }> = [];
    const attachmentCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const otherCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

    for (const call of calls) {
      if (isSearchAITool(call.name)) {
        searchCalls.push({ name: call.name as SearchAIToolName, params: call.params });
      } else if (isAttachmentTool(call.name) && this.attachmentExecutor && this.attachmentContext) {
        attachmentCalls.push(call);
      } else {
        otherCalls.push(call);
      }
    }

    // Execute all groups in parallel
    const [searchResults, attachmentResults, otherResults] = await Promise.all([
      this.executeSearchCallsParallel(searchCalls, timeoutMs),
      this.executeAttachmentCallsParallel(attachmentCalls),
      otherCalls.length > 0
        ? this.inner.executeParallel(otherCalls, timeoutMs)
        : Promise.resolve([]),
    ]);

    // Merge results preserving original call order
    const resultMap = new Map<string, { result?: unknown; error?: string }>();
    for (const r of [...searchResults, ...attachmentResults, ...otherResults]) {
      resultMap.set(r.name, r);
    }

    return calls.map((call) => ({
      name: call.name,
      ...(resultMap.get(call.name) ?? { error: 'Result not found' }),
    }));
  }

  private async executeSearchTool(
    toolName: SearchAIToolName,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const callFn = () => this.searchHandler.execute(toolName, params);

      if (this.circuitBreaker) {
        return await this.circuitBreaker.execute(toolName, callFn);
      }
      return await callFn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Search tool ${toolName} failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeSearchCallsParallel(
    calls: Array<{ name: SearchAIToolName; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    return Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.executeSearchTool(call.name, call.params, timeoutMs);
          return { name: call.name, result };
        } catch (err) {
          return { name: call.name, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  private async executeAttachmentCallsParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    if (!this.attachmentExecutor || !this.attachmentContext || calls.length === 0) {
      return [];
    }
    return Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.attachmentExecutor!.execute(
            call.name,
            call.params,
            this.attachmentContext!,
          );
          return { name: call.name, result };
        } catch (err) {
          return { name: call.name, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }
}
