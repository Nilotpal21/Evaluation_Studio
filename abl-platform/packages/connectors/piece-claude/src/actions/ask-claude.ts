/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import Anthropic from '@anthropic-ai/sdk';
import { claudeAuth } from '@activepieces/piece-claude';
// Import model list from AP piece internals so we stay in sync when AP releases new models.
import { modelOptions } from '@activepieces/piece-claude/src/lib/common/common';
import { assertSafeUrl, buildAnthropicMediaBlock } from '../security.js';

const DEFAULT_TOKENS_FOR_THINKING_MODE = 1024;

/**
 * Ask Claude — URL-native image variant.
 *
 * The AP piece downloads the image and sends it as base64. Anthropic's API
 * natively accepts public HTTPS URLs via `source.type: "url"`, so we accept
 * a plain URL string and pass it directly — no download, no heap allocation.
 *
 * All other behaviour (model selection, thinkingMode, roles, retry) is
 * identical to the AP piece.
 */
export const askClaudeAction = createAction({
  auth: claudeAuth as any,
  name: 'ask_claude',
  displayName: 'Ask Claude',
  description: 'Ask Claude anything you want!',
  props: {
    model: Property.StaticDropdown({
      displayName: 'Model',
      required: true,
      defaultValue: 'claude-sonnet-4-20250514',
      options: { disabled: false, options: modelOptions as any },
    }),
    systemPrompt: Property.LongText({
      displayName: 'System Prompt',
      required: false,
      defaultValue: "You're a helpful assistant.",
    }),
    temperature: Property.Number({
      displayName: 'Temperature',
      required: false,
    }),
    maxTokens: Property.Number({
      displayName: 'Maximum Tokens',
      required: false,
    }),
    prompt: Property.LongText({
      displayName: 'Question',
      required: true,
    }),
    image: Property.ShortText({
      displayName: 'Image / PDF URL',
      required: false,
      description: 'Public HTTPS URL of the image or PDF to include as context.',
    }),
    roles: Property.Json({
      displayName: 'Roles',
      required: false,
      defaultValue: [],
    }),
    thinkingMode: Property.Checkbox({
      displayName: 'Extended Thinking Mode',
      required: false,
      defaultValue: false,
    }),
    thinkingModeParams: Property.DynamicProperties({
      auth: claudeAuth as any,
      displayName: '',
      refreshers: ['thinkingMode'],
      required: false,
      props: async ({ thinkingMode }: any): Promise<any> => {
        if (!thinkingMode) return {};
        return {
          budgetTokens: Property.Number({
            displayName: 'Budget Tokens',
            required: true,
            defaultValue: DEFAULT_TOKENS_FOR_THINKING_MODE,
          }),
        };
      },
    }),
  },
  async run({ auth, propsValue }) {
    const apiKey = (auth as any)?.secret_text as string | undefined;
    if (!apiKey) {
      throw new Error('Claude API key is not configured. Set it in the connection credentials.');
    }
    const model = propsValue.model ?? 'claude-sonnet-4-20250514';
    const maxTokens = propsValue.maxTokens ? Number(propsValue.maxTokens) : 1000;
    const temperature = propsValue.temperature ? Number(propsValue.temperature) : 0.5;
    const systemPrompt = propsValue.systemPrompt ?? 'You are a helpful assistant.';
    const imageUrl = propsValue.image;
    if (imageUrl) assertSafeUrl(imageUrl);
    const thinkingMode = propsValue.thinkingMode === true;

    const anthropic = new Anthropic({ apiKey });

    const rolesArray = Array.isArray(propsValue.roles)
      ? (propsValue.roles as Array<{ role: string; content: unknown }>)
      : [];

    const userContent: unknown[] = [{ type: 'text', text: propsValue.prompt }];
    if (imageUrl) {
      userContent.push(await buildAnthropicMediaBlock(imageUrl));
    }

    const messages: unknown[] = [...rolesArray, { role: 'user', content: userContent }];

    // Backoff: 1 s → 6 s → 36 s (throws on 4th attempt without sleeping).
    // Worst-case total wait before final throw: ~43 s — verify this stays within
    // the workflow-engine connector_action step timeout (default 60 s).
    const maxRetries = 4;
    let retries = 0;
    let response: string | undefined;

    while (retries < maxRetries) {
      try {
        if (thinkingMode) {
          const budgetTokens =
            (propsValue.thinkingModeParams as any)?.budgetTokens != null
              ? Number((propsValue.thinkingModeParams as any).budgetTokens)
              : DEFAULT_TOKENS_FOR_THINKING_MODE;
          // Extended thinking requires a model that supports it. Fall back to
          // claude-3-7-sonnet if the selected model doesn't support the feature
          // (Anthropic returns a 400 for unsupported models).
          const THINKING_CAPABLE_MODELS = [
            'claude-3-7-sonnet-20250219',
            'claude-opus-4-20250514',
            'claude-sonnet-4-20250514',
          ];
          const thinkingModel = THINKING_CAPABLE_MODELS.includes(model)
            ? model
            : 'claude-3-7-sonnet-20250219';
          const req = await anthropic.messages.create({
            model: thinkingModel,
            max_tokens: maxTokens,
            system: systemPrompt,
            thinking: { type: 'enabled', budget_tokens: budgetTokens },
            messages: messages as any,
          });
          response = (req.content.find((b) => b.type === 'text') as any)?.text?.trim();
        } else {
          const req = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            temperature,
            system: systemPrompt,
            messages: messages as any,
          });
          response = (req.content[0] as any)?.text?.trim();
        }
        break;
      } catch (e: any) {
        if (e?.type?.includes('rate_limit_error')) {
          if (retries + 1 === maxRetries) throw e;
          const delay = Math.pow(6, retries) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          retries++;
        } else {
          throw e;
        }
      }
    }

    return response;
  },
});
