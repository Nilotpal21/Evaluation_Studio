import type { IntlMessageFormat as IntlMessageFormatType } from 'intl-messageformat';
import IntlMessageFormatModule from 'intl-messageformat';
import type { Locale, MessageParams } from './types.js';

// CJS interop: default import may be the module namespace or the class itself
const IntlMessageFormat =
  (IntlMessageFormatModule as unknown as { default: typeof IntlMessageFormatType }).default ??
  (IntlMessageFormatModule as unknown as typeof IntlMessageFormatType);

/**
 * Format an ICU MessageFormat template with parameters.
 */
export function formatMessage(
  template: string,
  params?: MessageParams,
  locale: Locale = 'en',
): string {
  try {
    const formatter = new IntlMessageFormat(template, locale);
    return formatter.format(params ?? {}) as string;
  } catch {
    return template;
  }
}

/**
 * Resolve a message key from locale-keyed messages with fallback chain:
 * requestedLocale -> defaultLocale -> 'en' -> key itself.
 */
export function resolveMessage(
  messages: Record<string, Record<string, string>>,
  defaultLocale: Locale,
  requestedLocale: Locale,
  key: string,
  params?: MessageParams,
): string {
  const template =
    messages[requestedLocale]?.[key] ??
    messages[defaultLocale]?.[key] ??
    messages['en']?.[key] ??
    key;

  return formatMessage(template, params, requestedLocale);
}
