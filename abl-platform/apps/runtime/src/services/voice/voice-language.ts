import type { InteractionContextInput } from '@agent-platform/shared-kernel';

export interface NormalizedSpeechLanguageCode extends InteractionContextInput {
  language: string;
}

function canonicalizeLocale(value: string): string | null {
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(value);
    return canonicalLocale ?? null;
  } catch {
    return null;
  }
}

export function normalizeSpeechLanguageCode(
  rawLanguageCode: string | undefined,
): NormalizedSpeechLanguageCode | undefined {
  const trimmed = rawLanguageCode?.trim();
  if (!trimmed) {
    return undefined;
  }

  const canonicalLocale = canonicalizeLocale(trimmed);
  if (!canonicalLocale) {
    return undefined;
  }

  const language = canonicalLocale.split('-')[0]?.toLowerCase();
  if (!language) {
    return undefined;
  }

  return canonicalLocale.includes('-')
    ? {
        language,
        locale: canonicalLocale,
      }
    : { language };
}
