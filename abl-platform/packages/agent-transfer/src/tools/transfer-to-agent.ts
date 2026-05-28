/**
 * Transfer-to-Agent Tool
 */
import { z } from 'zod';
import type { LLMToolDefinition } from '@abl/compiler/platform';
import type { AdapterRegistry } from '../adapters/registry.js';
import {
  buildTransferContextSnapshot,
  buildTransferRoutingContext,
  type TransferContextSnapshot,
  type TransferRoutingContext,
  type VoiceCallData,
} from '../types.js';
import { isVoiceChannel } from '../voice/index.js';
import { KoreProviderConfigSchema } from '../config/schema.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('transfer-to-agent-tool');

export const TransferToAgentInputSchema = z.object({
  provider: z.string().min(1, 'Provider name is required'),
  skills: z.array(z.string()).max(50, 'Maximum 50 skills allowed').optional(),
  queueId: z.string().optional(),
  priority: z.number().int().min(0).max(10).optional(),
  metadata: z
    .record(z.unknown())
    .optional()
    .refine((val) => !val || JSON.stringify(val).length <= 16384, 'Metadata must not exceed 16KB'),
  postAgentAction: z.enum(['return', 'end']).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  kore: KoreProviderConfigSchema.optional(),
});

export type TransferToAgentInput = z.infer<typeof TransferToAgentInputSchema>;

export interface TransferToolContext {
  tenantId: string;
  projectId: string;
  agentId: string;
  contactId: string;
  sessionId: string;
  channel: string;
  language?: string;
  routing?: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  conversationSessionId?: string;
  sourceChannelType?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voiceData?: VoiceCallData;
  /** The ID of the agent initiating the transfer (source agent in multi-agent scenarios) */
  sourceAgentId?: string;
  /** Conversation history to pass to the agent desktop for context */
  conversationHistory?: Array<{ role: string; content: string; timestamp?: string }>;
  /** Pre-computed plain-text transcript for immediate display on the agent desktop.
   * Eliminates the race condition where an agent accepts before the async ML summary completes. */
  conversationSummaryForAgentTransfer?: string;
  /** End-user contact details resolved from session/contact context */
  contact?: {
    firstName?: string;
    lastName?: string;
    displayName?: string;
    email?: string;
    phone?: string;
    customerId?: string;
  };
}

export interface TransferToolResult {
  success: boolean;
  status?: string;
  conversationId?: string;
  error?: { code: string; message: string };
}

// Use canonical isVoiceChannel() from voice/index.ts — do not maintain a local set

export class TransferToAgentTool {
  private readonly adapterRegistry: AdapterRegistry;

  constructor(adapterRegistry: AdapterRegistry) {
    this.adapterRegistry = adapterRegistry;
  }

  async execute(
    input: TransferToAgentInput,
    context: TransferToolContext,
  ): Promise<TransferToolResult> {
    const parsed = TransferToAgentInputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn('Transfer input validation failed', {
        errors: parsed.error.issues.map((i) => i.message),
        tenantId: context.tenantId,
        sessionId: context.sessionId,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    const validInput = parsed.data;
    const adapter = this.adapterRegistry.get(validInput.provider);
    if (!adapter) {
      log.error('Transfer provider not found', {
        provider: validInput.provider,
        available: this.adapterRegistry.listNames(),
        tenantId: context.tenantId,
        sessionId: context.sessionId,
      });
      return {
        success: false,
        error: {
          code: 'PROVIDER_NOT_FOUND',
          message: `Transfer provider '${validInput.provider}' is not registered. Available: ${this.adapterRegistry.listNames().join(', ') || 'none'}`,
        },
      };
    }

    const routing =
      context.routing ??
      buildTransferRoutingContext({
        runtimeSessionId: context.sessionId,
        conversationSessionId: context.conversationSessionId,
        resolvedContactId: context.contactId,
        channel: context.channel,
        sourceChannelType: context.sourceChannelType ?? context.channel,
        channelConnectionId: context.channelConnectionId,
        externalSessionKey: context.externalSessionKey,
        voice: context.voiceData
          ? {
              callSid: context.voiceData.callSid,
              sipCallId: context.voiceData.sipCallId,
              gateway: context.sourceChannelType ?? context.channel,
            }
          : undefined,
      });
    const contextSnapshot = buildTransferContextSnapshot({
      ...context.contextSnapshot,
      contact: context.contextSnapshot?.contact ?? context.contact,
      interactionContext:
        context.contextSnapshot?.interactionContext ??
        (context.language ? { language: context.language } : undefined),
    });

    const payload = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      agentId: context.agentId,
      contactId: context.contactId,
      sessionId: context.sessionId,
      channel: routing.normalizedTransferChannel,
      routing,
      contextSnapshot,
      queue: validInput.queueId,
      skills: validInput.skills,
      priority: validInput.priority,
      metadata: validInput.metadata,
      postAgentAction: validInput.postAgentAction,
      language: context.language ?? contextSnapshot?.interactionContext?.language,
      sourceAgentId: context.sourceAgentId,
      customData: validInput.providerConfig,
      koreConfig: validInput.kore,
      voiceData: context.voiceData,
      conversationHistory: context.conversationHistory?.map((m) => ({
        role: (m.role === 'assistant' ? 'agent' : m.role) as 'user' | 'agent' | 'system',
        content: m.content,
        timestamp: m.timestamp ?? new Date().toISOString(),
      })),
      conversationSummaryForAgentTransfer: context.conversationSummaryForAgentTransfer,
      contact: context.contact,
    };

    log.info('Calling adapter.execute()', {
      provider: validInput.provider,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      channel: context.channel,
      queue: validInput.queueId,
    });

    let result;
    try {
      result = await adapter.execute(payload);
    } catch (err) {
      log.error('Adapter threw exception during transfer', {
        provider: validInput.provider,
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: {
          code: 'TRANSFER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (!result.success) {
      log.error('Adapter returned failure', {
        provider: validInput.provider,
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        status: result.status,
      });
      return {
        success: false,
        error: result.error ?? {
          code: 'TRANSFER_FAILED',
          message: `Transfer failed with status: ${result.status}`,
        },
      };
    }

    const isVoice = isVoiceChannel(context.channel);
    log.info('Adapter returned success', {
      provider: validInput.provider,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      providerSessionId: result.providerSessionId,
      status: isVoice ? 'waiting' : 'transferred',
    });
    return {
      success: true,
      status: isVoice ? 'waiting' : 'transferred',
      conversationId: result.providerSessionId,
    };
  }

  toToolDefinition(): LLMToolDefinition {
    return {
      name: 'transfer_to_agent',
      description:
        'Transfer the conversation to a human agent. Use when the user requests to speak with a human, or when the issue cannot be resolved by the AI agent.',
      input_schema: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'The agent desktop provider to transfer to' },
          skills: { type: 'array', description: 'Agent skills required for routing' },
          queueId: { type: 'string', description: 'Target queue ID for agent routing' },
          priority: { type: 'number', description: 'Priority level 0-10' },
          metadata: { type: 'object', description: 'Additional metadata' },
          postAgentAction: {
            type: 'string',
            description: 'What to do after the human agent disconnects',
            enum: ['return', 'end'],
          },
          providerConfig: { type: 'object', description: 'Provider-specific config overrides' },
        },
        required: ['provider'],
      },
    };
  }
}
