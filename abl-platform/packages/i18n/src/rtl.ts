import type { Locale } from './types.js';

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'yi']);

export function isRTL(locale: Locale): boolean {
  const base = locale.split('-')[0].toLowerCase();
  return RTL_LOCALES.has(base);
}

export function getDirection(locale: Locale): 'ltr' | 'rtl' {
  return isRTL(locale) ? 'rtl' : 'ltr';
}

export function getTextAlign(locale: Locale): 'left' | 'right' {
  return isRTL(locale) ? 'right' : 'left';
}
