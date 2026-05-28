import type { GatherFieldSemantics, ValidationRule } from '@abl/compiler';

export interface ExtractionNormalizationField {
  name: string;
  type?: string;
  semantics?: GatherFieldSemantics;
  validation?: ValidationRule;
}

export interface NormalizedInput {
  rawText: string;
  displayText: string;
  extractionText: string;
  variants: {
    spokenNumberDigits?: string;
    punctuationNormalized?: string;
  };
}

const NUMERIC_TYPES = new Set(['number', 'integer', 'float', 'phone', 'currency', 'temperature']);

const NUMERIC_FORMATS = new Set(['currency', 'temperature', 'phone', 'postal_code', 'zip']);

const SINGLE_DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const TEEN_WORDS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const MAGNITUDE_WORDS: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

const REPEATER_WORDS: Record<string, number> = {
  double: 2,
  triple: 3,
};

const SPOKEN_NUMBER_TOKENS = new Set([
  ...Object.keys(SINGLE_DIGIT_WORDS),
  ...Object.keys(TEEN_WORDS),
  ...Object.keys(TENS_WORDS),
  ...Object.keys(MAGNITUDE_WORDS),
  ...Object.keys(REPEATER_WORDS),
  'and',
  'point',
  'minus',
  'negative',
]);

export function buildNormalizedExtractionInput(
  rawText: string,
  fields: ExtractionNormalizationField[],
): NormalizedInput {
  const normalized: NormalizedInput = {
    rawText,
    displayText: rawText,
    extractionText: rawText,
    variants: {},
  };

  if (!shouldNormalizeNumericInput(fields) || rawText.trim().length === 0) {
    return normalized;
  }

  const punctuationNormalized = normalizePunctuation(rawText);
  if (punctuationNormalized !== rawText) {
    normalized.variants.punctuationNormalized = punctuationNormalized;
    normalized.extractionText = punctuationNormalized;
  }

  const spokenNumberDigits = normalizeSpokenNumbers(normalized.extractionText);
  if (spokenNumberDigits !== normalized.extractionText) {
    normalized.variants.spokenNumberDigits = spokenNumberDigits;
    normalized.extractionText = spokenNumberDigits;
  }

  return normalized;
}

function shouldNormalizeNumericInput(fields: ExtractionNormalizationField[]): boolean {
  return fields.some((field) => isNumericLikeField(field));
}

function isNumericLikeField(field: ExtractionNormalizationField): boolean {
  const normalizedType = field.type?.trim().toLowerCase();
  if (normalizedType && NUMERIC_TYPES.has(normalizedType)) {
    return true;
  }

  const normalizedFormat = field.semantics?.format?.trim().toLowerCase();
  if (normalizedFormat && NUMERIC_FORMATS.has(normalizedFormat)) {
    return true;
  }

  if (field.validation?.type === 'range') {
    return true;
  }

  if (field.validation?.type === 'pattern') {
    return /\\d|\[0-9\]|\{\d/.test(field.validation.rule);
  }

  return false;
}

function normalizePunctuation(text: string): string {
  return text
    .replace(/([A-Za-z])[-]([A-Za-z])/g, '$1 $2')
    .replace(/[,:;!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpokenNumbers(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return text;
  }

  const normalizedTokens: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const parsed = parseSpokenNumberRun(tokens, index);
    if (parsed) {
      normalizedTokens.push(parsed.value);
      index += parsed.consumed;
      continue;
    }

    normalizedTokens.push(tokens[index]);
    index += 1;
  }

  return normalizedTokens.join(' ').trim();
}

function parseSpokenNumberRun(
  tokens: string[],
  startIndex: number,
): { value: string; consumed: number } | null {
  const firstToken = normalizeToken(tokens[startIndex]);
  if (!SPOKEN_NUMBER_TOKENS.has(firstToken)) {
    return null;
  }

  let endIndex = startIndex;
  while (endIndex < tokens.length) {
    const token = normalizeToken(tokens[endIndex]);
    if (!SPOKEN_NUMBER_TOKENS.has(token)) {
      break;
    }
    endIndex += 1;
  }

  const runTokens = tokens.slice(startIndex, endIndex).map(normalizeToken);
  const normalizedValue = normalizeSpokenNumberTokens(runTokens);
  if (!normalizedValue) {
    return null;
  }

  return {
    value: normalizedValue,
    consumed: endIndex - startIndex,
  };
}

function normalizeSpokenNumberTokens(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }

  let sign = '';
  let normalizedTokens = [...tokens];
  const firstToken = normalizedTokens[0];
  if (firstToken === 'minus' || firstToken === 'negative') {
    sign = '-';
    normalizedTokens = normalizedTokens.slice(1);
  }

  if (normalizedTokens.length === 0) {
    return null;
  }

  const pointIndex = normalizedTokens.indexOf('point');
  if (pointIndex >= 0) {
    const integerPartTokens = normalizedTokens.slice(0, pointIndex);
    const fractionalTokens = normalizedTokens.slice(pointIndex + 1);
    if (fractionalTokens.length === 0) {
      return null;
    }

    const integerPart =
      integerPartTokens.length === 0 ? '0' : normalizeIntegerTokens(integerPartTokens);
    const fractionalPart = normalizeDigitSequence(fractionalTokens);
    if (!integerPart || !fractionalPart) {
      return null;
    }

    return `${sign}${integerPart}.${fractionalPart}`;
  }

  const digitSequence = normalizeDigitSequence(normalizedTokens);
  if (digitSequence) {
    return `${sign}${digitSequence}`;
  }

  const cardinalValue = normalizeCardinalSequence(normalizedTokens);
  if (cardinalValue === null) {
    return null;
  }

  return `${sign}${String(cardinalValue)}`;
}

function normalizeIntegerTokens(tokens: string[]): string | null {
  return normalizeDigitSequence(tokens) ?? normalizeCardinalSequence(tokens)?.toString() ?? null;
}

function normalizeDigitSequence(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }

  const digits: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === 'and') {
      continue;
    }

    const repeatCount = REPEATER_WORDS[token];
    if (repeatCount) {
      const nextToken = tokens[index + 1];
      const repeatedDigit = nextToken ? SINGLE_DIGIT_WORDS[nextToken] : undefined;
      if (!repeatedDigit) {
        return null;
      }
      digits.push(repeatedDigit.repeat(repeatCount));
      index += 1;
      continue;
    }

    const digit = SINGLE_DIGIT_WORDS[token];
    if (!digit) {
      return null;
    }

    digits.push(digit);
  }

  return digits.length > 0 ? digits.join('') : null;
}

function normalizeCardinalSequence(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let sawNumberToken = false;

  for (const token of tokens) {
    if (token === 'and') {
      continue;
    }

    const singleDigit = SINGLE_DIGIT_WORDS[token];
    if (singleDigit) {
      current += Number.parseInt(singleDigit, 10);
      sawNumberToken = true;
      continue;
    }

    const teen = TEEN_WORDS[token];
    if (teen !== undefined) {
      current += teen;
      sawNumberToken = true;
      continue;
    }

    const tens = TENS_WORDS[token];
    if (tens !== undefined) {
      current += tens;
      sawNumberToken = true;
      continue;
    }

    const magnitude = MAGNITUDE_WORDS[token];
    if (magnitude !== undefined) {
      sawNumberToken = true;
      if (magnitude === 100) {
        current = (current || 1) * magnitude;
      } else {
        total += (current || 1) * magnitude;
        current = 0;
      }
      continue;
    }

    return null;
  }

  if (!sawNumberToken) {
    return null;
  }

  return total + current;
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}
