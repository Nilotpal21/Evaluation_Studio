/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import { openaiAuth } from '@activepieces/piece-openai';
import { assertSafeUrl, buildOpenAIImageContent } from '../security.js';

/**
 * Vision Prompt — URL-native variant.
 *
 * The AP piece converts the image to a base64 data URI before sending.
 * OpenAI's API natively accepts public HTTPS URLs via the `image_url` source
 * type, so we take a plain URL string and pass it directly — no download,
 * no heap allocation for the image bytes.
 */
export const visionPromptAction = createAction({
  auth: openaiAuth as any,
  name: 'vision_prompt',
  displayName: 'Vision Prompt',
  description: 'Ask GPT a question about an image using a public URL.',
  props: {
    image: Property.ShortText({
      displayName: 'Image URL',
      description: 'Public HTTPS URL of the image you want GPT to analyse.',
      required: true,
    }),
    prompt: Property.LongText({
      displayName: 'Question',
      description: 'What do you want ChatGPT to tell you about the image?',
      required: true,
    }),
    detail: Property.StaticDropdown({
      displayName: 'Detail',
      description: 'Controls how the model processes the image.',
      required: false,
      defaultValue: 'auto',
      options: {
        disabled: false,
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
          { label: 'Auto', value: 'auto' },
        ],
      },
    }),
    temperature: Property.Number({
      displayName: 'Temperature',
      required: false,
      defaultValue: 0.9,
    }),
    maxTokens: Property.Number({
      displayName: 'Maximum Tokens',
      required: false,
      defaultValue: 2048,
    }),
    topP: Property.Number({
      displayName: 'Top P',
      required: false,
      defaultValue: 1,
    }),
    frequencyPenalty: Property.Number({
      displayName: 'Frequency Penalty',
      required: false,
      defaultValue: 0,
    }),
    presencePenalty: Property.Number({
      displayName: 'Presence Penalty',
      required: false,
      defaultValue: 0.6,
    }),
    roles: Property.Json({
      displayName: 'Roles',
      required: false,
      defaultValue: [{ role: 'system', content: 'You are a helpful assistant.' }],
    }),
  },
  async run({ auth, propsValue }) {
    const apiKey = (auth as any)?.secret_text as string | undefined;
    if (!apiKey) {
      throw new Error('OpenAI API key is not configured. Set it in the connection credentials.');
    }
    const {
      image,
      prompt,
      detail,
      temperature,
      maxTokens,
      topP,
      frequencyPenalty,
      presencePenalty,
      roles,
    } = propsValue;
    assertSafeUrl(image);
    const imageContent = await buildOpenAIImageContent(image, detail ?? 'auto');

    const rolesArray = Array.isArray(roles)
      ? (roles as Array<{ role: string; content: unknown }>)
      : [];

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          ...rolesArray,
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, imageContent],
          },
        ],
        temperature: temperature ?? 0.9,
        max_tokens: maxTokens ?? 2048,
        top_p: topP ?? 1,
        frequency_penalty: frequencyPenalty ?? 0,
        presence_penalty: presencePenalty ?? 0.6,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? null;
  },
});
