import type { RichContent } from '../core/types.js';

export type RichContentSupportType = keyof RichContent;

export interface RichContentSupportSpec {
  type: RichContentSupportType;
  webRenderMode: 'native' | 'fallback';
  studioPreviewMode: 'native' | 'fallback' | 'limited';
}

export const RICH_CONTENT_SUPPORT_SPECS: ReadonlyArray<RichContentSupportSpec> = [
  { type: 'markdown', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'adaptive_card', webRenderMode: 'fallback', studioPreviewMode: 'fallback' },
  { type: 'html', webRenderMode: 'native', studioPreviewMode: 'limited' },
  { type: 'slack', webRenderMode: 'fallback', studioPreviewMode: 'fallback' },
  { type: 'ag_ui', webRenderMode: 'fallback', studioPreviewMode: 'fallback' },
  { type: 'whatsapp', webRenderMode: 'fallback', studioPreviewMode: 'fallback' },
  { type: 'carousel', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'quick_replies', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'list', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'image', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'video', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'audio', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'file', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'kpi', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'table', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'chart', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'form', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'progress', webRenderMode: 'native', studioPreviewMode: 'native' },
  { type: 'feedback', webRenderMode: 'native', studioPreviewMode: 'native' },
];

export const WEB_FALLBACK_RICH_CONTENT_TYPES = RICH_CONTENT_SUPPORT_SPECS.filter(
  (spec) => spec.webRenderMode === 'fallback',
).map((spec) => spec.type);

function hasRichContentValue(
  type: RichContentSupportType,
  value: RichContent[RichContentSupportType],
): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (type === 'carousel') {
    return (
      typeof value === 'object' &&
      value !== null &&
      'cards' in value &&
      Array.isArray(value.cards) &&
      value.cards.length > 0
    );
  }

  return true;
}

export function hasRenderableRichContentPayload(richContent?: RichContent): boolean {
  if (!richContent) {
    return false;
  }

  for (const spec of RICH_CONTENT_SUPPORT_SPECS) {
    if (hasRichContentValue(spec.type, richContent[spec.type])) {
      return true;
    }
  }

  return false;
}
