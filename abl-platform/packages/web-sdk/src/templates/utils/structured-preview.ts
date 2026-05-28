const PREVIEW_KEYS = [
  'text',
  'title',
  'subtitle',
  'label',
  'prompt',
  'description',
  'alt',
  'altText',
  'speak',
] as const;
const MAX_PREVIEW_SEGMENTS = 3;
const MAX_PREVIEW_LENGTH = 160;

function looksLikeStructuredPayload(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[');
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_PREVIEW_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_PREVIEW_LENGTH - 1)}…`;
}

function collectPreviewSegments(
  value: unknown,
  segments: string[],
  allowPlainString: boolean = false,
): void {
  if (segments.length >= MAX_PREVIEW_SEGMENTS || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (allowPlainString && normalized) {
      segments.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPreviewSegments(item, segments, allowPlainString);
      if (segments.length >= MAX_PREVIEW_SEGMENTS) {
        return;
      }
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const allowChildString = PREVIEW_KEYS.includes(key as (typeof PREVIEW_KEYS)[number]);

    if (allowChildString && typeof child === 'string' && child.trim()) {
      segments.push(child.trim());
      if (segments.length >= MAX_PREVIEW_SEGMENTS) {
        return;
      }
      continue;
    }

    collectPreviewSegments(child, segments, allowChildString);
    if (segments.length >= MAX_PREVIEW_SEGMENTS) {
      return;
    }
  }
}

export function extractStructuredTextPreview(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!looksLikeStructuredPayload(trimmed)) {
    return truncatePreview(trimmed);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const segments: string[] = [];
    collectPreviewSegments(parsed, segments);
    if (segments.length > 0) {
      return truncatePreview(segments.join(' • '));
    }
  } catch {
    return undefined;
  }

  return undefined;
}
