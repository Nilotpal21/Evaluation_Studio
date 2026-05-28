import type { Locale } from './types.js';

/** Native language names for locale selector UIs. */
export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'العربية',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  he: 'עברית',
  hi: 'हिन्दी',
  ja: '日本語',
  ko: '한국어',
  pt: 'Português',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  zh: '中文',
};

/** Get native language name for a locale code. */
export function localeToLanguageName(locale: Locale): string {
  return LOCALE_NAMES[locale] ?? LOCALE_NAMES[locale.split('-')[0]] ?? locale;
}

/** Extract language part from a locale code (before the hyphen). */
export function getLanguageCode(locale: Locale): string {
  return locale.split('-')[0];
}
