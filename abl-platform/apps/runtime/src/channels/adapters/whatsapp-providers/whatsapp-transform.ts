/**
 * Shared WhatsApp transform utilities
 *
 * Contains the common transformOutput and parseWhatsAppTemplate logic
 * used by both MetaCloudProvider and InfobipProvider. Extracted to
 * eliminate ~180 lines of duplication across providers.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type { ChannelOutput, WhatsAppTemplatePayload } from '../../types.js';

const log = createLogger('whatsapp-transform');

// =============================================================================
// WHATSAPP LIMITS
// =============================================================================

export const MAX_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const MAX_BUTTON_LABEL = 20;
export const MAX_LIST_ROW_TITLE = 24;

// =============================================================================
// SHARED TRANSFORM LOGIC
// =============================================================================

/**
 * Transform ActionSetIR into WhatsApp interactive format, or use a
 * WhatsApp message template when richContent.whatsapp is present.
 *
 * Strategy:
 * - richContent.whatsapp with template_name → WhatsApp message template
 * - ≤3 buttons → interactive buttons (reply buttons)
 * - >3 buttons or selects → interactive list
 * - Inputs → text fallback (WhatsApp doesn't support form inputs)
 */
export function transformWhatsAppOutput(
  text: string,
  actions?: ActionSetIR,
  richContent?: RichContentIR,
): ChannelOutput {
  // Check for WhatsApp template in richContent first — templates take priority
  if (richContent?.whatsapp) {
    const templateOutput = parseWhatsAppTemplate(richContent.whatsapp, text);
    if (templateOutput) return templateOutput;
  }

  if (!actions || actions.elements.length === 0) {
    return { kind: 'text', text };
  }

  const buttons = actions.elements.filter((e) => e.type === 'button');
  const selects = actions.elements.filter((e) => e.type === 'select');

  // If only buttons and ≤3, use reply buttons
  if (buttons.length > 0 && buttons.length <= MAX_BUTTONS && selects.length === 0) {
    const interactive = {
      type: 'button',
      body: { text: text || 'Please choose:' },
      action: {
        buttons: buttons.map((btn) => ({
          type: 'reply',
          reply: {
            id: btn.id.slice(0, 256),
            title: btn.label.slice(0, MAX_BUTTON_LABEL),
          },
        })),
      },
    };
    return { kind: 'whatsapp_interactive', interactive, text };
  }

  // For >3 buttons, selects, or mixed — use list
  const rows: Array<{ id: string; title: string; description?: string }> = [];

  for (const btn of buttons) {
    if (rows.length >= MAX_LIST_ROWS) break;
    rows.push({
      id: btn.id.slice(0, 200),
      title: btn.label.slice(0, MAX_LIST_ROW_TITLE),
      description: btn.description?.slice(0, 72),
    });
  }

  for (const sel of selects) {
    for (const opt of sel.options || []) {
      if (rows.length >= MAX_LIST_ROWS) break;
      rows.push({
        id: opt.id.slice(0, 200),
        title: opt.label.slice(0, MAX_LIST_ROW_TITLE),
        description: opt.description?.slice(0, 72),
      });
    }
  }

  if (rows.length === 0) {
    return { kind: 'text', text };
  }

  const interactive = {
    type: 'list',
    body: { text: text || 'Please choose:' },
    action: {
      button: (actions.submit_label || 'Options').slice(0, MAX_BUTTON_LABEL),
      sections: [
        {
          title: 'Options'.slice(0, MAX_LIST_ROW_TITLE),
          rows,
        },
      ],
    },
  };

  return { kind: 'whatsapp_interactive', interactive, text };
}

/**
 * Parse richContent.whatsapp JSON into a WhatsApp template ChannelOutput.
 * Returns null if the JSON is invalid or missing template_name, allowing
 * fallback to standard interactive/text logic.
 *
 * Expected JSON shape:
 * {
 *   "template_name": "booking_confirm",
 *   "language": "en_US",
 *   "parameters": {
 *     "header": [{ "type": "image", "image": { "link": "..." } }],
 *     "body": [{ "type": "text", "text": "John" }],
 *     "buttons": [{ "type": "quick_reply", "index": 0, "parameters": [{ "type": "payload", "payload": "confirm" }] }]
 *   }
 * }
 */
export function parseWhatsAppTemplate(
  whatsappJson: string,
  fallbackText: string,
): ChannelOutput | null {
  try {
    const parsed = JSON.parse(whatsappJson);

    if (!parsed.template_name || typeof parsed.template_name !== 'string') {
      return null;
    }

    const template: WhatsAppTemplatePayload = {
      name: parsed.template_name,
      language: { code: parsed.language || 'en_US' },
    };

    if (parsed.parameters) {
      const components: NonNullable<WhatsAppTemplatePayload['components']> = [];

      if (parsed.parameters.header) {
        components.push({
          type: 'header',
          parameters: Array.isArray(parsed.parameters.header)
            ? parsed.parameters.header
            : [parsed.parameters.header],
        });
      }

      if (parsed.parameters.body) {
        components.push({
          type: 'body',
          parameters: Array.isArray(parsed.parameters.body)
            ? parsed.parameters.body
            : [parsed.parameters.body],
        });
      }

      if (parsed.parameters.buttons) {
        const buttons = Array.isArray(parsed.parameters.buttons)
          ? parsed.parameters.buttons
          : [parsed.parameters.buttons];
        for (let i = 0; i < buttons.length; i++) {
          const btn = buttons[i];
          components.push({
            type: 'button',
            sub_type: btn.type || 'quick_reply',
            index: btn.index ?? i,
            parameters: btn.parameters
              ? Array.isArray(btn.parameters)
                ? btn.parameters
                : [btn.parameters]
              : undefined,
          });
        }
      }

      if (components.length > 0) {
        template.components = components;
      }
    }

    log.debug('WhatsApp template output generated', { templateName: template.name });
    return { kind: 'whatsapp_template', template, text: fallbackText };
  } catch (err) {
    log.warn('Failed to parse WhatsApp richContent as template', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
