/**
 * SDK i18n String Overrides
 *
 * Provides a simple string lookup mechanism for template renderers.
 * Consumers can override default strings via `setStrings()`.
 * No external dependencies — just a `Record<string, string>`.
 */

/** Maximum number of string overrides allowed */
const MAX_STRING_OVERRIDES = 100;

/**
 * Default strings used by template renderers.
 */
export const DEFAULT_STRINGS: Record<string, string> = {
  'chart.loading': 'Loading chart...',
  'chart.error': 'Failed to load chart',
  'chart.label': 'Chart',
  'chart.bar': 'Bar chart',
  'chart.line': 'Line chart',
  'chart.pie': 'Pie chart',
  'table.showMore': 'Show more',
  'table.showLess': 'Show less',
  'table.label': 'Data table',
  'file.download': 'Download',
  'progress.label': 'Progress',
  'video.label': 'Video',
  'audio.label': 'Audio',
  'image.label': 'Image',
  'carousel.label': 'Carousel',
  'carousel.previous': 'Previous',
  'carousel.next': 'Next',
  'actions.label': 'Actions',
  'feedback.submit': 'Submit',
  'feedback.label': 'Feedback',
  'feedback.thumbsUp': 'Thumbs up',
  'feedback.thumbsDown': 'Thumbs down',
  'feedback.commentPlaceholder': 'Tell us what went wrong (optional)',
  'feedback.send': 'Send',
  'feedback.skip': 'Skip',
  'list.label': 'List',
  'form.submit': 'Submit',
  'form.label': 'Form',
  'kpi.trend': 'Trend',
  'quickReplies.label': 'Quick replies',
  'channelFallback.label': 'Channel-optimized content',
  'channelFallback.description':
    'This response includes rich content optimized for another channel and is shown here in a safe fallback view.',
  'channelFallback.variant.adaptive_card': 'Adaptive Card payload',
  'channelFallback.variant.slack': 'Slack Block Kit payload',
  'channelFallback.variant.ag_ui': 'AG-UI payload',
  'channelFallback.variant.whatsapp': 'WhatsApp payload',
};

/** User-provided string overrides */
let overrides: Record<string, string> = {};

/**
 * Get a string by key.
 *
 * Returns the user override if set, else the default, else the key itself.
 */
export function getString(key: string): string {
  if (key in overrides) {
    return overrides[key];
  }
  if (key in DEFAULT_STRINGS) {
    return DEFAULT_STRINGS[key];
  }
  return key;
}

/**
 * Set string overrides for template renderers.
 *
 * Merges the provided overrides with any previously set overrides.
 * If the total number of overrides exceeds MAX_STRING_OVERRIDES (100),
 * a warning is logged and the overrides are truncated to the limit.
 */
export function setStrings(newOverrides: Record<string, string>): void {
  const merged = { ...overrides, ...newOverrides };
  const keys = Object.keys(merged);

  if (keys.length > MAX_STRING_OVERRIDES) {
    // eslint-disable-next-line no-console
    console.warn(
      `TemplateStrings: ${keys.length} overrides exceed limit of ${MAX_STRING_OVERRIDES}. Truncating to first ${MAX_STRING_OVERRIDES} entries.`,
    );
    const truncated: Record<string, string> = {};
    for (let i = 0; i < MAX_STRING_OVERRIDES; i++) {
      truncated[keys[i]] = merged[keys[i]];
    }
    overrides = truncated;
  } else {
    overrides = merged;
  }
}
