/**
 * AI4W Content Transformer
 *
 * Transforms RichContentIR and ActionSetIR into markdown format
 * suitable for AI4W platform rendering. AI4W consumes markdown
 * as its primary rich text format.
 */

import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type { ChannelOutput } from '../types.js';

// =============================================================================
// RICH CONTENT → MARKDOWN
// =============================================================================

/**
 * Transform RichContentIR into a markdown string.
 * Prioritizes the `markdown` field if present, then synthesizes from
 * structured content types (carousel, quick_replies, list, table, etc.).
 */
function richContentToMarkdown(richContent: RichContentIR): string {
  // If there's an explicit markdown representation, use it
  if (richContent.markdown) {
    return richContent.markdown;
  }

  const sections: string[] = [];

  // Carousel → list of cards with links/buttons
  if (richContent.carousel?.cards) {
    for (const card of richContent.carousel.cards) {
      let cardMd = `### ${card.title}`;
      if (card.subtitle) {
        cardMd += `\n${card.subtitle}`;
      }
      if (card.image_url) {
        cardMd += `\n![${card.title}](${card.image_url})`;
      }
      if (card.default_action_url) {
        cardMd += `\n[Open](${card.default_action_url})`;
      }
      if (card.buttons?.length) {
        const buttonLines = card.buttons.map(
          (b) => `- **${b.label}**${b.value ? ` (${b.value})` : ''}`,
        );
        cardMd += '\n' + buttonLines.join('\n');
      }
      sections.push(cardMd);
    }
  }

  // Quick replies → bullet list of options
  if (richContent.quick_replies?.length) {
    const options = richContent.quick_replies.map((qr) => `- ${qr.label}`).join('\n');
    sections.push(options);
  }

  // List template
  if (richContent.list) {
    const list = richContent.list;
    if (list.title) {
      sections.push(`### ${list.title}`);
    }
    if (list.items?.length) {
      const items = list.items
        .map((item) => {
          let line = `- **${item.title}**`;
          if (item.subtitle) line += ` — ${item.subtitle}`;
          if (item.image_url) line += ` ![](${item.image_url})`;
          return line;
        })
        .join('\n');
      sections.push(items);
    }
  }

  // Table template
  if (richContent.table) {
    const table = richContent.table;
    if (table.columns?.length && table.rows?.length) {
      const headers = table.columns.map((c) => c.header);
      const keys = table.columns.map((c) => c.key);
      const headerRow = '| ' + headers.join(' | ') + ' |';
      const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
      const dataRows = table.rows
        .map((row) => '| ' + keys.map((k) => String(row[k] ?? '')).join(' | ') + ' |')
        .join('\n');
      sections.push([headerRow, separator, dataRows].join('\n'));
    }
  }

  // Image
  if (richContent.image) {
    const img = richContent.image;
    const alt = img.alt ?? 'Image';
    sections.push(`![${alt}](${img.url})${img.caption ? `\n*${img.caption}*` : ''}`);
  }

  // Video
  if (richContent.video) {
    const vid = richContent.video;
    sections.push(
      `[Video: ${vid.alt ?? vid.url}](${vid.url})${vid.caption ? `\n*${vid.caption}*` : ''}`,
    );
  }

  // Audio
  if (richContent.audio) {
    const aud = richContent.audio;
    sections.push(
      `[Audio: ${aud.alt ?? aud.url}](${aud.url})${aud.caption ? `\n*${aud.caption}*` : ''}`,
    );
  }

  // File
  if (richContent.file) {
    const f = richContent.file;
    sections.push(`[${f.filename}](${f.url})${f.mime_type ? ` (${f.mime_type})` : ''}`);
  }

  // KPI template (single metric)
  if (richContent.kpi) {
    const kpi = richContent.kpi;
    const valueStr = kpi.unit ? `${kpi.value} ${kpi.unit}` : String(kpi.value);
    const trendIcon = kpi.trend === 'up' ? ' ↑' : kpi.trend === 'down' ? ' ↓' : '';
    sections.push(`**${kpi.label}**: ${valueStr}${trendIcon}`);
  }

  // Progress template
  if (richContent.progress) {
    const p = richContent.progress;
    const label = p.label ?? 'Progress';
    const max = p.max ?? 100;
    const pct = max > 0 ? `${Math.round((p.value / max) * 100)}%` : String(p.value);
    sections.push(`**${label}**: ${pct}`);
  }

  // Form template — render as a list of fields
  if (richContent.form) {
    const form = richContent.form;
    if (form.title) {
      sections.push(`### ${form.title}`);
    }
    if (form.fields?.length) {
      const fields = form.fields
        .map(
          (f) =>
            `- **${f.label}**${f.required ? ' (required)' : ''}${f.placeholder ? ` — ${f.placeholder}` : ''}`,
        )
        .join('\n');
      sections.push(fields);
    }
  }

  // Feedback template
  if (richContent.feedback) {
    const fb = richContent.feedback;
    sections.push(`**${fb.prompt}** (${fb.type})`);
  }

  return sections.join('\n\n');
}

// =============================================================================
// ACTIONS → MARKDOWN
// =============================================================================

/**
 * Transform ActionSetIR into markdown-formatted action buttons/options.
 */
function actionsToMarkdown(actions: ActionSetIR): string {
  if (!actions.elements.length) return '';

  const lines: string[] = [];

  for (const el of actions.elements) {
    switch (el.type) {
      case 'button':
        lines.push(`- [${el.label}]${el.value ? `(${el.value})` : ''}`);
        break;
      case 'select':
        lines.push(`**${el.label}**:`);
        if (el.options?.length) {
          for (const opt of el.options) {
            lines.push(`  - ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
          }
        }
        break;
      case 'input':
        lines.push(`**${el.label}**${el.placeholder ? ` (${el.placeholder})` : ''}`);
        break;
    }
  }

  if (actions.submit_label) {
    lines.push(`\n**[${actions.submit_label}]**`);
  }

  return lines.join('\n');
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Transform text + optional rich content + optional actions into AI4W ChannelOutput.
 *
 * AI4W uses markdown as its primary rendering format. This function:
 * 1. Starts with the base text
 * 2. Appends rich content rendered as markdown
 * 3. Appends interactive actions as markdown links/lists
 */
export function transformAI4WOutput(
  text: string,
  actions?: ActionSetIR,
  richContent?: RichContentIR,
): ChannelOutput {
  const parts: string[] = [];

  if (text) {
    parts.push(text);
  }

  if (richContent) {
    const richMd = richContentToMarkdown(richContent);
    if (richMd) {
      parts.push(richMd);
    }
  }

  if (actions && actions.elements.length > 0) {
    const actionsMd = actionsToMarkdown(actions);
    if (actionsMd) {
      parts.push(actionsMd);
    }
  }

  return { kind: 'text', text: parts.join('\n\n') };
}
