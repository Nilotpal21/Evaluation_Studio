/**
 * Transfer Tool Executor
 *
 * Adapts @agent-platform/agent-transfer tool classes to the ToolExecutor
 * interface used by ToolBindingExecutor. Routes tool calls like
 * "transfer_to_agent", "check_hours", "check_availability", "set_queue"
 * to the appropriate agent-transfer tool instance.
 */

import type { ToolExecutor } from '@abl/compiler';
import {
  TransferToAgentTool,
  CheckHoursTool,
  CheckAvailabilityTool,
  SetQueueTool,
  IVRMenuTool,
  IVRDigitInputTool,
  CallTransferTool,
  DeflectToChatTool,
  type TransferToolContext,
  type AdapterRegistry,
  type SmartAssistClient,
  type TraceEventEmitter,
  isVoiceChannel,
  checkRateLimit,
  type RateLimitCheckConfig,
} from '@agent-platform/agent-transfer';
import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('transfer-tool-executor');

/** Tool names recognized by this executor */
export const TRANSFER_TOOL_NAMES = new Set([
  'transfer_to_agent',
  'check_hours',
  'check_availability',
  'set_queue',
  'ivr_menu',
  'ivr_digit_input',
  'call_transfer',
  'deflect_to_chat',
]);

/** Voice-only tools that must not execute on non-voice channels */
const VOICE_ONLY_TOOLS = new Set([
  'ivr_menu',
  'ivr_digit_input',
  'call_transfer',
  'deflect_to_chat',
]);

const ADAPTER_REGISTRY_UNAVAILABLE_ERROR = {
  code: 'ADAPTER_REGISTRY_UNAVAILABLE',
  message: 'Agent transfer adapter registry is unavailable.',
} as const;

export interface TransferToolExecutorConfig {
  adapterRegistry?: AdapterRegistry | null;
  getAdapterRegistry?: () => AdapterRegistry | null | undefined;
  smartAssistClient?: SmartAssistClient | null;
  getSmartAssistClient?: () => SmartAssistClient | null | undefined;
  /** Session-scoped context injected into every transfer tool call */
  context?: TransferToolContext;
  /** Lazily resolve context per tool call when runtime state may have changed */
  getContext?: () => Promise<TransferToolContext> | TransferToolContext;
  /** Platform transfer trace emitter, resolved lazily when available */
  traceEmitter?: TraceEventEmitter | null;
  getTraceEmitter?: () => TraceEventEmitter | null | undefined;
  /** Redis client for rate limiting (optional) */
  redis?: RedisClient;
  /** Per-tenant rate limit config (optional) */
  rateLimitConfig?: RateLimitCheckConfig;
  /** Optional callback used by runtime wiring to synchronize transfer state */
  onTransferResult?: (result: {
    toolName: 'transfer_to_agent';
    success: boolean;
    context: TransferToolContext;
    result: unknown;
  }) => void;
}

export class TransferToolExecutor implements ToolExecutor {
  private transferTool?: TransferToAgentTool;
  private transferToolRegistry?: AdapterRegistry;
  private checkHoursTool?: CheckHoursTool;
  private checkAvailabilityTool?: CheckAvailabilityTool;
  private setQueueTool?: SetQueueTool;
  private smartAssistToolClient?: SmartAssistClient;
  private readonly ivrMenuTool: IVRMenuTool;
  private readonly ivrDigitInputTool: IVRDigitInputTool;
  private readonly callTransferTool: CallTransferTool;
  private readonly deflectToChatTool: DeflectToChatTool;
  private readonly adapterRegistry?: AdapterRegistry | null;
  private readonly getAdapterRegistry?: () => AdapterRegistry | null | undefined;
  private readonly smartAssistClient?: SmartAssistClient | null;
  private readonly getSmartAssistClient?: () => SmartAssistClient | null | undefined;
  private readonly context?: TransferToolContext;
  private readonly getContext?: () => Promise<TransferToolContext> | TransferToolContext;
  private readonly traceEmitter?: TraceEventEmitter | null;
  private readonly getTraceEmitter?: () => TraceEventEmitter | null | undefined;
  private readonly redis?: RedisClient;
  private readonly rateLimitConfig?: RateLimitCheckConfig;
  private readonly onTransferResult?: TransferToolExecutorConfig['onTransferResult'];

  constructor(config: TransferToolExecutorConfig) {
    this.adapterRegistry = config.adapterRegistry;
    this.getAdapterRegistry = config.getAdapterRegistry;
    this.smartAssistClient = config.smartAssistClient;
    this.getSmartAssistClient = config.getSmartAssistClient;
    this.context = config.context;
    this.getContext = config.getContext;
    this.traceEmitter = config.traceEmitter;
    this.getTraceEmitter = config.getTraceEmitter;
    this.redis = config.redis;
    this.rateLimitConfig = config.rateLimitConfig;
    this.onTransferResult = config.onTransferResult;
    this.ivrMenuTool = new IVRMenuTool();
    this.ivrDigitInputTool = new IVRDigitInputTool();
    this.callTransferTool = new CallTransferTool();
    this.deflectToChatTool = new DeflectToChatTool();

    if (!this.context && !this.getContext) {
      throw new Error('TransferToolExecutor requires either context or getContext');
    }
  }

  private async resolveContext(): Promise<TransferToolContext> {
    if (this.getContext) {
      return await this.getContext();
    }

    if (!this.context) {
      throw new Error('Transfer tool context is not configured');
    }

    return this.context;
  }

  private resolveAdapterRegistry(): AdapterRegistry | null {
    return this.getAdapterRegistry?.() ?? this.adapterRegistry ?? null;
  }

  private resolveTransferTool(): TransferToAgentTool | null {
    const registry = this.resolveAdapterRegistry();
    if (!registry) {
      return null;
    }

    if (!this.transferTool || this.transferToolRegistry !== registry) {
      this.transferTool = new TransferToAgentTool(registry);
      this.transferToolRegistry = registry;
    }

    return this.transferTool;
  }

  private resolveSmartAssistClient(): SmartAssistClient | null {
    return this.getSmartAssistClient?.() ?? this.smartAssistClient ?? null;
  }

  private ensureSmartAssistTools(): boolean {
    const client = this.resolveSmartAssistClient();
    if (!client) {
      this.smartAssistToolClient = undefined;
      this.checkHoursTool = undefined;
      this.checkAvailabilityTool = undefined;
      this.setQueueTool = undefined;
      return false;
    }

    if (this.smartAssistToolClient !== client) {
      this.smartAssistToolClient = client;
      this.checkHoursTool = new CheckHoursTool(client);
      this.checkAvailabilityTool = new CheckAvailabilityTool(client);
      this.setQueueTool = new SetQueueTool(client);
    }

    return true;
  }

  private emitTransferFailedTrace(
    context: TransferToolContext,
    provider: string,
    error: { code: string; message: string },
  ): void {
    const emitter = this.getTraceEmitter?.() ?? this.traceEmitter;
    if (!emitter) {
      return;
    }

    void Promise.resolve(
      emitter.emit({
        type: 'agent_transfer.transfer_failed',
        timestamp: Date.now(),
        data: {
          tenantId: context.tenantId,
          projectId: context.projectId ?? '',
          contactId: context.contactId,
          provider,
          channel: context.channel,
          runtimeSessionId: context.sessionId,
          errorCode: error.code,
          errorMessage: error.message,
          error: error.message,
          errorType: error.code,
        },
      }),
    ).catch((err) => {
      log.warn('Failed to emit agent transfer failure trace', {
        provider,
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    _timeoutMs: number,
  ): Promise<unknown> {
    const context = await this.resolveContext();

    // Voice-only tools must not execute on non-voice channels
    if (VOICE_ONLY_TOOLS.has(toolName) && !isVoiceChannel(context.channel)) {
      log.warn('Voice-only tool called on non-voice channel', {
        toolName,
        channel: context.channel,
      });
      return {
        success: false,
        error: {
          code: 'CHANNEL_MISMATCH',
          message: `Tool "${toolName}" is only available on voice channels, current channel: ${context.channel}`,
        },
      };
    }

    switch (toolName) {
      case 'transfer_to_agent': {
        const providerParam = (params as Record<string, unknown>).provider;
        const provider = typeof providerParam === 'string' ? providerParam : 'unknown';

        if (!context.projectId || context.projectId.trim().length === 0) {
          const blockedResult = {
            success: false,
            error: {
              code: 'PROJECT_CONTEXT_REQUIRED',
              message: 'Agent transfer requires a project-scoped session context.',
            },
          };

          log.error('Agent transfer blocked — missing project scope', {
            provider,
            tenantId: context.tenantId,
            sessionId: context.sessionId,
            contactId: context.contactId,
            channel: context.channel,
          });

          this.onTransferResult?.({
            toolName: 'transfer_to_agent',
            success: false,
            context,
            result: blockedResult,
          });

          return blockedResult;
        }

        const transferTool = this.resolveTransferTool();
        if (!transferTool) {
          const unavailableResult = {
            success: false,
            error: ADAPTER_REGISTRY_UNAVAILABLE_ERROR,
          };

          log.error('Agent transfer blocked — adapter registry unavailable', {
            provider,
            tenantId: context.tenantId,
            projectId: context.projectId,
            sessionId: context.sessionId,
            contactId: context.contactId,
            channel: context.channel,
          });

          this.emitTransferFailedTrace(context, provider, unavailableResult.error);
          this.onTransferResult?.({
            toolName: 'transfer_to_agent',
            success: false,
            context,
            result: unavailableResult,
          });

          return unavailableResult;
        }

        log.info('Agent transfer initiated', {
          provider,
          tenantId: context.tenantId,
          projectId: context.projectId,
          sessionId: context.sessionId,
          contactId: context.contactId,
          channel: context.channel,
          agentId: context.agentId,
          queue: (params as Record<string, unknown>).queueId,
          skills: (params as Record<string, unknown>).skills,
          priority: (params as Record<string, unknown>).priority,
        });

        // Rate limit only the actual transfer, not pre-check tools
        if (!this.redis) {
          log.warn('Rate limiting disabled — no Redis client configured for transfer_to_agent');
        } else {
          const rateLimitResult = await checkRateLimit(
            this.redis,
            context.tenantId,
            this.rateLimitConfig,
          );
          if (!rateLimitResult.allowed) {
            const blockedResult = {
              success: false,
              error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: `Transfer rate limit exceeded. Try again in ${Math.ceil(rateLimitResult.resetMs / 1000)}s`,
              },
            };
            log.warn('Agent transfer blocked — rate limit exceeded', {
              provider,
              tenantId: context.tenantId,
              sessionId: context.sessionId,
              remaining: rateLimitResult.remaining,
            });
            this.onTransferResult?.({
              toolName: 'transfer_to_agent',
              success: false,
              context,
              result: blockedResult,
            });
            return blockedResult;
          }
        }

        // Emit transfer_initiated trace before executing the transfer
        const initiatedEmitter = this.getTraceEmitter?.() ?? this.traceEmitter;
        if (initiatedEmitter) {
          void Promise.resolve(
            initiatedEmitter.emit({
              type: 'agent_transfer.transfer_initiated',
              timestamp: Date.now(),
              data: {
                tenantId: context.tenantId,
                projectId: context.projectId ?? '',
                contactId: context.contactId,
                provider,
                channel: context.channel,
                runtimeSessionId: context.sessionId,
                queue: (params as Record<string, unknown>).queueId as string | undefined,
                skills: (params as Record<string, unknown>).skills as string[] | undefined,
              },
            }),
          ).catch((err) =>
            log.warn('Failed to emit transfer_initiated trace', {
              provider,
              tenantId: context.tenantId,
              sessionId: context.sessionId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }

        const result = await transferTool.execute(params as any, context);
        const transferResult = result as {
          success: boolean;
          conversationId?: string;
          status?: string;
          error?: { code: string; message: string };
        };

        this.onTransferResult?.({
          toolName: 'transfer_to_agent',
          success: transferResult.success,
          context,
          result,
        });

        if (transferResult.success) {
          log.info('Agent transfer succeeded', {
            provider,
            tenantId: context.tenantId,
            projectId: context.projectId,
            sessionId: context.sessionId,
            contactId: context.contactId,
            channel: context.channel,
            conversationId: transferResult.conversationId,
            status: transferResult.status,
          });
        } else {
          if (transferResult.error) {
            this.emitTransferFailedTrace(context, provider, transferResult.error);
          }
          log.error('Agent transfer failed', {
            provider,
            tenantId: context.tenantId,
            projectId: context.projectId,
            sessionId: context.sessionId,
            contactId: context.contactId,
            channel: context.channel,
            errorCode: transferResult.error?.code,
            errorMessage: transferResult.error?.message,
          });
        }

        return result;
      }

      case 'check_hours':
        log.info('Agent transfer check_hours called', {
          tenantId: context.tenantId,
          sessionId: context.sessionId,
        });
        if (!this.ensureSmartAssistTools() || !this.checkHoursTool) {
          log.warn('check_hours failed — SmartAssist not configured', {
            tenantId: context.tenantId,
          });
          return {
            success: false,
            error: { code: 'NOT_CONFIGURED', message: 'SmartAssist not configured' },
          };
        }
        return this.checkHoursTool.execute(params as any);

      case 'check_availability':
        log.info('Agent transfer check_availability called', {
          tenantId: context.tenantId,
          sessionId: context.sessionId,
        });
        if (!this.ensureSmartAssistTools() || !this.checkAvailabilityTool) {
          log.warn('check_availability failed — SmartAssist not configured', {
            tenantId: context.tenantId,
          });
          return {
            success: false,
            error: { code: 'NOT_CONFIGURED', message: 'SmartAssist not configured' },
          };
        }
        return this.checkAvailabilityTool.execute(params as any);

      case 'set_queue':
        log.info('Agent transfer set_queue called', {
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          params,
        });
        if (!this.ensureSmartAssistTools() || !this.setQueueTool) {
          log.warn('set_queue failed — SmartAssist not configured', {
            tenantId: context.tenantId,
          });
          return {
            success: false,
            error: { code: 'NOT_CONFIGURED', message: 'SmartAssist not configured' },
          };
        }
        return this.setQueueTool.execute(params as any);

      case 'ivr_menu':
        return this.ivrMenuTool.execute(params as any);

      case 'ivr_digit_input':
        return this.ivrDigitInputTool.execute(params as any);

      case 'call_transfer':
        return this.callTransferTool.execute(params as any);

      case 'deflect_to_chat':
        return this.deflectToChatTool.execute(params as any);

      default:
        throw new Error(`Unknown transfer tool: ${toolName}`);
    }
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    return Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.execute(call.name, call.params, timeoutMs);
          return { name: call.name, result };
        } catch (err) {
          return {
            name: call.name,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }
}

/**
 * Check if a tool name is an agent-transfer tool.
 */
export function isTransferTool(toolName: string): boolean {
  return TRANSFER_TOOL_NAMES.has(toolName);
}
