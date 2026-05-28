/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import Anthropic from '@anthropic-ai/sdk';
import { claudeAuth } from '@activepieces/piece-claude';
// Import model list from AP piece internals so we stay in sync when AP releases new models.
import { modelOptions } from '@activepieces/piece-claude/src/lib/common/common';
import { assertSafeUrl, buildAnthropicMediaBlock } from '../security.js';

/**
 * Sanitise a string so it is a valid Anthropic tool input_schema property key.
 * Keys must match ^[a-zA-Z0-9_.-]{1,64}$
 */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 64);
}

/**
 * Extract Structured Data — URL-native image/PDF variant.
 *
 * The AP piece downloads the file and sends it as base64. Anthropic's API
 * natively accepts public HTTPS URLs, so we accept a plain URL string and
 * pass it directly — no download, no heap allocation.
 *
 * Schema sanitization (Anthropic key regex) is handled here, not in the adapter.
 */
export const extractStructuredDataAction = createAction({
  auth: claudeAuth as any,
  name: 'extract-structured-data',
  displayName: 'Extract Structured Data',
  description: 'Extract structured data from text, an image, or a PDF using a URL.',
  props: {
    model: Property.StaticDropdown({
      displayName: 'Model',
      required: true,
      defaultValue: 'claude-sonnet-4-20250514',
      options: { disabled: false, options: modelOptions as any },
    }),
    text: Property.LongText({
      displayName: 'Text',
      description: 'Text to extract structured data from.',
      required: false,
    }),
    image: Property.ShortText({
      displayName: 'Image / PDF URL',
      description: 'Public HTTPS URL of the image or PDF to extract structured data from.',
      required: false,
    }),
    prompt: Property.LongText({
      displayName: 'Guide Prompt',
      defaultValue: 'Extract the following data from the provided data.',
      required: false,
    }),
    mode: Property.StaticDropdown({
      displayName: 'Data Schema Type',
      required: true,
      defaultValue: 'simple',
      options: {
        disabled: false,
        options: [
          { label: 'Simple', value: 'simple' },
          { label: 'Advanced', value: 'advanced' },
        ],
      },
    }),
    schema: Property.DynamicProperties({
      auth: claudeAuth as any,
      displayName: 'Data Definition',
      required: true,
      refreshers: ['mode'],
      props: async ({ mode }: any): Promise<any> => {
        if (mode === 'advanced') {
          return {
            fields: Property.Json({
              displayName: 'JSON Schema',
              required: true,
              defaultValue: {
                type: 'object',
                properties: { name: { type: 'string' }, age: { type: 'number' } },
                required: ['name'],
              },
            }),
          };
        }
        return {
          fields: Property.Array({
            displayName: 'Data Definition',
            required: true,
            properties: {
              name: Property.ShortText({
                displayName: 'Name',
                description: 'Unique short name for the value to extract.',
                required: true,
              }),
              description: Property.LongText({
                displayName: 'Description',
                description: 'What this field represents.',
                required: false,
              }),
              type: Property.StaticDropdown({
                displayName: 'Type',
                required: true,
                defaultValue: 'string',
                options: {
                  disabled: false,
                  options: [
                    { label: 'Text', value: 'string' },
                    { label: 'Number', value: 'number' },
                    { label: 'Boolean', value: 'boolean' },
                  ],
                },
              }),
              isRequired: Property.Checkbox({
                displayName: 'Required',
                required: false,
                defaultValue: false,
              }),
            },
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
    const imageUrl = propsValue.image;
    if (imageUrl) assertSafeUrl(imageUrl);
    const schemaData = propsValue.schema as any;
    const mode = propsValue.mode;

    const anthropic = new Anthropic({ apiKey });

    // Build the tool input_schema from the Data Definition
    let inputSchema: Record<string, unknown>;
    if (mode === 'advanced') {
      inputSchema = schemaData?.fields ?? {};
    } else {
      const fields: Array<{
        name: string;
        description?: string;
        type: string;
        isRequired?: boolean;
      }> = Array.isArray(schemaData?.fields) ? schemaData.fields : [];

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const field of fields) {
        const key = sanitizeKey(field.name);
        properties[key] = {
          type: field.type ?? 'string',
          ...(field.description ? { description: field.description } : {}),
        };
        if (field.isRequired) required.push(key);
      }

      inputSchema = { type: 'object', properties, required };
    }

    // Build messages
    const messages: unknown[] = [];

    if (propsValue.text) {
      messages.push({ role: 'user', content: propsValue.text });
    }

    if (imageUrl) {
      messages.push({
        role: 'user',
        content: [await buildAnthropicMediaBlock(imageUrl)],
      });
    }

    if (messages.length === 0) {
      throw new Error('Provide at least one of: Text, Image / PDF URL');
    }

    const guidePrompt = propsValue.prompt ?? 'Extract the following data from the provided data.';
    messages.push({ role: 'user', content: guidePrompt });

    const response = await anthropic.messages.create({
      model,
      messages: messages as any,
      tools: [
        {
          name: 'extract_structured_data',
          description: guidePrompt,
          input_schema: inputSchema as any,
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_structured_data' },
      max_tokens: 2000,
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use') as any;
    if (!toolUse) {
      const textBlock = response.content.find((b) => b.type === 'text') as any;
      throw new Error(textBlock?.text ?? 'Failed to extract structured data from the input.');
    }

    return toolUse.input;
  },
});
