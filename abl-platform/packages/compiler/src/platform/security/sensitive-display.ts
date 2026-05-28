/**
 * Sensitive Display Renderer
 *
 * Renders collected GatherField values according to their sensitive_display
 * and mask_config settings. Used when displaying values outside the gather
 * context (e.g. in confirmation messages, summaries, agent responses).
 */

import type { GatherField } from '../ir/schema.js';

const DEFAULT_MASK_CHAR = '*';
const DEFAULT_SHOW_FIRST = 0;
const DEFAULT_SHOW_LAST = 3;

export function renderSensitiveValue(value: unknown, field: GatherField): string {
  if (value === null || value === undefined) return '';

  const str = String(value);

  if (!field.sensitive || !field.sensitive_display) {
    return str;
  }

  switch (field.sensitive_display) {
    case 'redact':
      return '[REDACTED]';

    case 'replace':
      return `[${field.name.toUpperCase()}]`;

    case 'mask': {
      const config = field.mask_config ?? {
        show_first: DEFAULT_SHOW_FIRST,
        show_last: DEFAULT_SHOW_LAST,
        char: DEFAULT_MASK_CHAR,
      };
      if (field.pii_type === 'email' && str.includes('@')) {
        return maskEmailLocalPart(str, config.show_first, config.show_last, config.char);
      }
      return maskString(str, config.show_first, config.show_last, config.char);
    }

    default:
      return str;
  }
}

function maskString(value: string, showFirst: number, showLast: number, char: string): string {
  if (value.length <= showFirst + showLast) {
    return char.repeat(Math.max(value.length, 3));
  }

  const first = value.substring(0, showFirst);
  const last = value.substring(value.length - showLast);
  const middle = char.repeat(value.length - showFirst - showLast);

  return first + middle + last;
}

// Mask only the local part of an email, preserving `@domain`.
// show_first/show_last apply to the local part only.
function maskEmailLocalPart(
  value: string,
  showFirst: number,
  showLast: number,
  char: string,
): string {
  const atIdx = value.indexOf('@');
  if (atIdx < 0) return maskString(value, showFirst, showLast, char);
  const local = value.slice(0, atIdx);
  const domain = value.slice(atIdx);
  const masked = maskString(local, showFirst, showLast, char);
  return masked + domain;
}
