import type { StatusOperation } from './types.js';

const GENERIC_FALLBACK_MESSAGES = ['One moment.', 'Checking now.', 'Taking a look.'];
const VOICE_GENERIC_FALLBACK_MESSAGES = [
  "I'm checking that for you.",
  'Let me check that.',
  "I'll take a quick look.",
];

const LOCALIZED_GENERIC_FALLBACK_MESSAGES: Record<string, string[]> = {
  ar: ['لحظة من فضلك.', 'جارٍ التحقق.', 'جارٍ الاطلاع.'],
  de: ['Einen Moment.', 'Prüfung läuft.', 'Kurzer Blick darauf.'],
  en: GENERIC_FALLBACK_MESSAGES,
  es: ['Un momento.', 'Revisando ahora.', 'Echando un vistazo.'],
  fr: ['Un instant.', 'Vérification en cours.', 'Examen en cours.'],
  hi: ['एक क्षण।', 'जाँच जारी है।', 'देखा जा रहा है।'],
  it: ['Un momento.', 'Verifica in corso.', 'Controllo in corso.'],
  ja: ['少々お待ちください。', '確認中です。', '内容を確認中です。'],
  ko: ['잠시만요.', '확인 중입니다.', '내용 확인 중입니다.'],
  nl: ['Een moment.', 'Controle loopt.', 'Even bekijken.'],
  pt: ['Um momento.', 'Verificando agora.', 'Analisando isso.'],
  ru: ['Одну минуту.', 'Проверка выполняется.', 'Идет просмотр.'],
  tr: ['Bir dakika.', 'Kontrol ediliyor.', 'İnceleniyor.'],
  zh: ['请稍等。', '正在确认。', '正在查看。'],
};

export interface FillerMessageLocaleOptions {
  locale?: string;
  language?: string;
  isVoiceChannel?: boolean;
}

/**
 * Static fallback messages are intentionally generic. Context should come from
 * pipeline-generated filler or LLM-authored <status> tags, not guessed tool names.
 */
export const OPERATION_MESSAGES: Record<StatusOperation, string[]> = {
  tool_call: GENERIC_FALLBACK_MESSAGES,
  reasoning: GENERIC_FALLBACK_MESSAGES,
  handoff: GENERIC_FALLBACK_MESSAGES,
  delegation: GENERIC_FALLBACK_MESSAGES,
  extraction: GENERIC_FALLBACK_MESSAGES,
  constraint_check: GENERIC_FALLBACK_MESSAGES,
  general: GENERIC_FALLBACK_MESSAGES,
};

function resolveLocalizedFallbackKey(options: FillerMessageLocaleOptions | undefined): string {
  const candidates = [options?.locale, options?.language];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim().replace(/_/g, '-');
    if (!normalized) {
      continue;
    }

    try {
      const [canonical] = Intl.getCanonicalLocales(normalized);
      const exactKey = canonical?.toLowerCase();
      const languageKey = exactKey?.split('-')[0];
      if (exactKey && LOCALIZED_GENERIC_FALLBACK_MESSAGES[exactKey]) {
        return exactKey;
      }
      if (languageKey && LOCALIZED_GENERIC_FALLBACK_MESSAGES[languageKey]) {
        return languageKey;
      }
    } catch {
      const languageKey = normalized.split('-')[0]?.toLowerCase();
      if (languageKey && LOCALIZED_GENERIC_FALLBACK_MESSAGES[languageKey]) {
        return languageKey;
      }
    }
  }

  return 'en';
}

export function getGenericFillerMessages(options?: FillerMessageLocaleOptions): readonly string[] {
  const languageKey = resolveLocalizedFallbackKey(options);
  if (options?.isVoiceChannel && languageKey === 'en') {
    return VOICE_GENERIC_FALLBACK_MESSAGES;
  }

  return LOCALIZED_GENERIC_FALLBACK_MESSAGES[languageKey];
}

export function getDefaultFillerMessage(options?: FillerMessageLocaleOptions): string {
  return getGenericFillerMessages(options)[0] ?? GENERIC_FALLBACK_MESSAGES[0];
}

/**
 * Select a generic fallback filler message.
 * Avoids repeating messages from `recentHistory` when possible.
 */
export function getFillerMessage(
  operation: StatusOperation,
  recentHistory: string[] = [],
  _toolName?: string,
  localeOptions?: FillerMessageLocaleOptions,
): string {
  const localizedPool = getGenericFillerMessages(localeOptions);
  const pool =
    localizedPool.length > 0
      ? localizedPool
      : (OPERATION_MESSAGES[operation] ?? OPERATION_MESSAGES.general);
  const available = pool.filter((message) => !recentHistory.includes(message));
  const candidates = available.length > 0 ? available : pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}
