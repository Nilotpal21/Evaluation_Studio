/**
 * PromptTemplateLoader — Loads prompt templates from MongoDB during
 * IR compilation/resolution, caches in memory for runtime use.
 *
 * Lifecycle:
 *   1. During IR compilation/resolution (DeploymentResolver), call loadFromDB()
 *      to populate the in-memory cache. This is the ONLY time DB is hit.
 *   2. At runtime (buildSystemPrompt, buildTools), all getters read from cache.
 *      Cache reads are synchronous — zero DB latency during message processing.
 *   3. Falls back to hardcoded PromptCatalog if DB is empty or unavailable.
 *   4. Cache persists for process lifetime. Reload on redeployment or explicit call.
 */

import {
  PromptCatalog,
  type SystemPromptKey,
  type MessageKey,
  type ToolSchemaKey,
  type LLMPromptKey,
  type EscalationChannel,
} from './prompt-catalog.js';

/** Static mapping from runtime ChannelType to EscalationChannel template key */
const CHANNEL_TO_ESCALATION: Record<string, EscalationChannel> = {
  msteams: 'msteams',
  slack: 'slack',
  whatsapp: 'whatsapp',
  messenger: 'messenger',
  instagram: 'messenger',
  telegram: 'digital',
  line: 'digital',
  email: 'digital',
  vxml: 'voice',
  audiocodes: 'voice',
  korevg: 'voice',
  web: 'digital',
  digital: 'digital',
  web_chat: 'digital',
  web_debug: 'digital',
  sdk_websocket: 'digital',
  http_async: 'digital',
  ag_ui: 'digital',
};

export class PromptTemplateLoader {
  private cache = new Map<string, unknown>();
  private loaded = false;

  /** Load from DB — called during IR compilation/resolution, NOT at runtime */
  async loadFromDB(PromptTemplateModel?: any): Promise<void> {
    if (!PromptTemplateModel) {
      return;
    }
    try {
      const docs = await PromptTemplateModel.find({}).lean();
      for (const doc of docs) {
        this.cache.set(doc.key, doc.content);
      }
      this.loaded = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        '[prompt-template-loader] Failed to load from DB, using catalog fallback:',
        message,
      );
    }
  }

  /** Load from raw entries (for testing or migration) */
  loadFromEntries(entries: Array<{ key: string; content: unknown }>): void {
    for (const entry of entries) {
      this.cache.set(entry.key, entry.content);
    }
    this.loaded = true;
  }

  /** Get system prompt template */
  getSystemPrompt(key: SystemPromptKey): string {
    const cached = this.cache.get(`system_prompt.${key}`);
    if (typeof cached === 'string') return cached;
    return PromptCatalog.systemPrompt[key];
  }

  /** Get tool JSON schema */
  getToolSchema(key: ToolSchemaKey): (typeof PromptCatalog.toolSchemas)[ToolSchemaKey] {
    const cached = this.cache.get(`tool_schema.${key}`);
    if (cached && typeof cached === 'object') return cached as any;
    return PromptCatalog.toolSchemas[key];
  }

  /** Get shared description (reason, thought, thought_with_budget) */
  getSharedDescription(key: keyof typeof PromptCatalog.sharedDescriptions): string {
    const cached = this.cache.get(`tool_description.shared.${key}`);
    if (typeof cached === 'string') return cached;
    return PromptCatalog.sharedDescriptions[key];
  }

  /** Get tool description */
  getToolDescription(toolName: string, subKey?: string): string {
    const fullKey = subKey
      ? `tool_description.${toolName}.${subKey}`
      : `tool_description.${toolName}`;
    const cached = this.cache.get(fullKey);
    if (typeof cached === 'string') return cached;
    const toolDescs = (PromptCatalog.toolDescriptions as any)[toolName];
    if (!toolDescs) return '';
    return subKey ? toolDescs[subKey] || '' : typeof toolDescs === 'string' ? toolDescs : '';
  }

  /** Get default message */
  getMessage(key: MessageKey): string {
    const cached = this.cache.get(`message.${key}`);
    if (typeof cached === 'string') return cached;
    return PromptCatalog.messages[key];
  }

  /** Get LLM task prompt (entity extraction, correction detection, field validation, field inference) */
  getLLMPrompt(key: LLMPromptKey): string {
    const cached = this.cache.get(`llm_prompt.${key}`);
    if (typeof cached === 'string') return cached;
    return PromptCatalog.llmPrompts[key];
  }

  /** Get escalation template for a specific channel, falling back to plain */
  getEscalation(channel: EscalationChannel): string {
    const cached = this.cache.get(`escalation.${channel}`);
    if (typeof cached === 'string') return cached;
    // Legacy fallback: if no channel-specific DB override, check plain DB override
    // before falling back to the hardcoded catalog. This preserves behavior for
    // tenants that only have a customized escalation.plain entry.
    if (channel !== 'plain') {
      const plainCached = this.cache.get('escalation.plain');
      if (typeof plainCached === 'string') return plainCached;
    }
    return PromptCatalog.escalation[channel];
  }

  /**
   * Resolve the best escalation channel key from a runtime channel type string.
   * Maps runtime channel types (e.g. 'msteams', 'slack', 'whatsapp', 'messenger')
   * to escalation template keys, with fallback to 'digital' for web channels
   * and 'plain' for unknown channels.
   */
  resolveEscalationChannel(channelType?: string): EscalationChannel {
    if (!channelType) return 'plain';

    const mapped = CHANNEL_TO_ESCALATION[channelType];
    if (mapped) return mapped;

    // Voice channels (prefix match for voice_twilio, voice_livekit, etc.)
    if (channelType.startsWith('voice')) return 'voice';

    return 'plain';
  }

  /** Whether templates have been loaded from DB */
  get isLoaded(): boolean {
    return this.loaded;
  }
}

/** Singleton instance — initialized on first import */
export const promptTemplateLoader = new PromptTemplateLoader();
