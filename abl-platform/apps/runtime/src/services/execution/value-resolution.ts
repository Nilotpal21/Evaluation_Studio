/**
 * Value Resolution — Pure Functions
 *
 * Template interpolation, voice config interpolation, value path resolution,
 * SET value parsing, and nested value access. All functions are pure (no state mutation).
 */

import { createLogger } from '@abl/compiler/platform';
import { evaluateCel } from '@abl/compiler';

const log = createLogger('value-resolution');

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toTemplateDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const fromString = new Date(value);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }

  return null;
}

function applyTemplateFilter(value: unknown, filterName: string): unknown {
  switch (filterName.trim().toLowerCase()) {
    case 'upper':
      return String(value ?? '').toUpperCase();
    case 'lower':
      return String(value ?? '').toLowerCase();
    case 'json':
    case 'tojson':
      return JSON.stringify(value, null, 2);
    case 'ago': {
      const date = toTemplateDate(value);
      return date ? formatRelativeTime(date) : undefined;
    }
    default:
      return undefined;
  }
}

function resolveFilteredTemplateExpression(
  path: string,
  filterList: string,
  data: Record<string, unknown>,
): string | null {
  const initialValue = getNestedValue(data, path);
  if (initialValue === undefined) {
    log.warn('Template variable not found in data context', { path, filtered: true });
    return null;
  }

  let currentValue: unknown = initialValue;
  const filters = filterList
    .split('|')
    .map((filterName) => filterName.trim())
    .filter(Boolean);

  for (const filterName of filters) {
    const filteredValue = applyTemplateFilter(currentValue, filterName);
    if (filteredValue === undefined) {
      log.warn('Unsupported or unresolved template filter', { path, filter: filterName });
      return null;
    }
    currentValue = filteredValue;
  }

  if (Array.isArray(currentValue)) {
    return JSON.stringify(currentValue, null, 2);
  }

  return String(currentValue ?? '');
}

function isBareValuePathExpression(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+)\]|\.[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+)\])?)+$/.test(
    value,
  );
}

function resolvePathSegment(
  current: unknown,
  segment: string,
): { value: unknown; resolved: boolean } {
  const arrayMatch = segment.match(/^(\w+)\[(\d+)\]$/);
  if (arrayMatch) {
    const [, key, index] = arrayMatch;
    if (!current || typeof current !== 'object') {
      return { value: undefined, resolved: false };
    }
    const arr = (current as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) {
      return { value: undefined, resolved: false };
    }
    return { value: arr[parseInt(index, 10)], resolved: true };
  }

  if (!current || typeof current !== 'object') {
    return { value: undefined, resolved: false };
  }

  return {
    value: (current as Record<string, unknown>)[segment],
    resolved: true,
  };
}

/**
 * Interpolate template variables like {{variable}}
 */
export function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Handle {{#each array}}...{{/each}} blocks
  const eachRegex = /\{\{#each\s+(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  result = result.replace(eachRegex, (match, arrayName, content) => {
    const arr = getNestedValue(data, arrayName);
    if (!Array.isArray(arr)) return match;

    return arr
      .map((item, index) => {
        let itemContent = content;
        // Replace {{@index}}
        itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));
        // Replace {{add @index N}} - simple add helper
        itemContent = itemContent.replace(
          /\{\{add\s+@index\s+(\d+)\}\}/g,
          (_m: string, num: string) => {
            return String(index + parseInt(num));
          },
        );
        // Replace item properties {{name}}, {{price}}, etc.
        if (typeof item === 'object' && item !== null) {
          const itemObj = item as Record<string, unknown>;
          itemContent = itemContent.replace(/\{\{(\w+)\}\}/g, (_m: string, prop: string) => {
            const val = itemObj[prop];
            if (val === undefined) {
              log.warn('Template loop property not found in item', { prop, index });
            }
            return val !== undefined ? String(val) : '';
          });
        }
        return itemContent;
      })
      .join('');
  });

  // Handle {{#if variable}}...{{/if}} blocks
  const ifRegex = /\{\{#if\s+(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  result = result.replace(ifRegex, (_match, path, content) => {
    const value = getNestedValue(data, path);
    if (value) {
      return interpolateTemplate(content, data); // Recursively interpolate
    }
    return '';
  });

  // Handle filtered expressions like {{user.last_seen | ago}}.
  // Filtered placeholders fail closed instead of leaking raw template syntax.
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\s*\|\s*([^}]+)\}\}/g, (match, path, filters) => {
    const resolved = resolveFilteredTemplateExpression(path, filters, data);
    return resolved === null ? '' : resolved;
  });

  // Handle simple {{variable}} or {{variable.property}} replacements
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const value = getNestedValue(data, path);
    if (Array.isArray(value)) {
      return JSON.stringify(value, null, 2);
    }
    if (value === undefined) {
      log.warn('Template variable not found in data context', { path });
    }
    return value !== undefined ? String(value) : match;
  });

  return result;
}

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let value: unknown = data;
  for (const part of parts) {
    const resolved = resolvePathSegment(value, part);
    if (!resolved.resolved) {
      return undefined;
    }
    value = resolved.value;
  }
  return value;
}

/**
 * Interpolate voice config fields (SSML, instructions, plain_text) using the same template engine
 */
export function interpolateVoiceConfig(
  vc: import('@abl/compiler').VoiceConfigIR,
  data: Record<string, unknown>,
): import('@abl/compiler').VoiceConfigIR {
  const result: import('@abl/compiler').VoiceConfigIR = {};
  if (vc.ssml !== undefined) {
    result.ssml = interpolateTemplate(vc.ssml, data);
  }
  if (vc.instructions !== undefined) {
    result.instructions = interpolateTemplate(vc.instructions, data);
  }
  if (vc.plain_text !== undefined) {
    result.plain_text = interpolateTemplate(vc.plain_text, data);
  }
  if (vc.provider !== undefined) {
    result.provider = vc.provider;
  }
  if (vc.voice_id !== undefined) {
    result.voice_id = interpolateTemplate(vc.voice_id, data);
  }
  if (vc.speed !== undefined) {
    result.speed = vc.speed;
  }
  return result;
}

type RichContentCollectionBinding<TItem> = { from: string; template?: TItem };
type RuntimeRichContentIR = import('@abl/compiler').RichContentIR;
type RuntimeQuickReply = NonNullable<RuntimeRichContentIR['quick_replies']>[number];
type RuntimeListItem = NonNullable<RuntimeRichContentIR['list']>['items'][number];
type RuntimeTableColumn = NonNullable<RuntimeRichContentIR['table']>['columns'][number];
type RuntimeChartDataPoint = NonNullable<RuntimeRichContentIR['chart']>['data'][number];
type RuntimeCarouselCard = NonNullable<RuntimeRichContentIR['carousel']>['cards'][number];

function isRichContentCollectionBinding<TItem>(
  value: unknown,
): value is RichContentCollectionBinding<TItem> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === 'string',
  );
}

function resolveCollectionPath(binding: string, data: Record<string, unknown>): unknown {
  const templatePath = binding.trim().match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/);
  return getNestedValue(data, templatePath ? templatePath[1] : binding.trim());
}

function itemContext(item: unknown, data: Record<string, unknown>): Record<string, unknown> {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? { ...data, ...(item as Record<string, unknown>) }
    : { ...data, value: item };
}

function interpolateTextValue(value: unknown, data: Record<string, unknown>): string | undefined {
  return typeof value === 'string' ? interpolateTemplate(value, data) : undefined;
}

function interpolateStringOrNumberValue(
  value: unknown,
  data: Record<string, unknown>,
): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return interpolateTemplate(value, data);
  }

  return undefined;
}

function interpolateNumberValue(value: unknown, data: Record<string, unknown>): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const rendered = interpolateTemplate(value, data);
    const parsed = Number(rendered);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function interpolateRichContentCollection<TSourceItem, TResultItem>(
  collection: TSourceItem[] | RichContentCollectionBinding<TSourceItem> | string | undefined,
  data: Record<string, unknown>,
  interpolateItem: (item: TSourceItem, context: Record<string, unknown>) => TResultItem | undefined,
): TResultItem[] {
  if (!collection) {
    return [];
  }

  if (Array.isArray(collection)) {
    return collection
      .map((item) => interpolateItem(item, data))
      .filter((item): item is TResultItem => item !== undefined);
  }

  const source = isRichContentCollectionBinding<TSourceItem>(collection)
    ? resolveCollectionPath(collection.from, data)
    : resolveCollectionPath(collection, data);

  if (!Array.isArray(source)) {
    return [];
  }

  if (isRichContentCollectionBinding<TSourceItem>(collection) && collection.template) {
    return source
      .map((item) => interpolateItem(collection.template as TSourceItem, itemContext(item, data)))
      .filter((item): item is TResultItem => item !== undefined);
  }

  return source
    .map((item) => interpolateItem(item as TSourceItem, itemContext(item, data)))
    .filter((item): item is TResultItem => item !== undefined);
}

function interpolateQuickReply(
  qr: RuntimeQuickReply,
  data: Record<string, unknown>,
): RuntimeQuickReply | undefined {
  if (typeof qr === 'string') {
    const label = interpolateTemplate(qr, data);
    return label ? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label } : undefined;
  }

  const label = interpolateTextValue(qr.label, data);
  const id = typeof qr.id === 'string' ? interpolateTemplate(qr.id, data) : undefined;
  if (!label || !id) {
    return undefined;
  }
  return {
    id,
    label,
    icon_url: qr.icon_url,
  };
}

function interpolateListItem(
  item: RuntimeListItem,
  data: Record<string, unknown>,
): RuntimeListItem | undefined {
  if (typeof item === 'string') {
    const title = interpolateTemplate(item, data);
    return title ? { title } : undefined;
  }

  const titleSource =
    item.title ??
    (item as unknown as Record<string, unknown>).label ??
    (item as unknown as Record<string, unknown>).name ??
    (item as unknown as Record<string, unknown>).account_label;
  const title = interpolateTextValue(titleSource, data);
  if (!title) {
    return undefined;
  }

  return {
    title,
    subtitle: interpolateTextValue(item.subtitle, data),
    image_url: item.image_url,
    default_action_url: item.default_action_url,
  };
}

function interpolateActionOption(
  option: { id: string; label: string; description?: string },
  data: Record<string, unknown>,
): { id: string; label: string; description?: string } | undefined {
  if (typeof option === 'string') {
    const label = interpolateTemplate(option, data);
    return label ? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label } : undefined;
  }

  const labelSource =
    option.label ??
    (option as Record<string, unknown>).title ??
    (option as Record<string, unknown>).name;
  const label = interpolateTextValue(labelSource, data);
  const idSource = option.id ?? (option as Record<string, unknown>).value ?? labelSource;
  const id = interpolateTextValue(idSource, data);
  if (!label || !id) {
    return undefined;
  }

  return {
    id,
    label,
    description: interpolateTextValue(option.description, data),
  };
}

function interpolateActionElement(
  field: import('@abl/compiler').ActionElementIR,
  data: Record<string, unknown>,
): import('@abl/compiler').ActionElementIR | undefined {
  if (typeof field === 'string') {
    const label = interpolateTemplate(field, data);
    return label
      ? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), type: 'button', label }
      : undefined;
  }

  const labelSource =
    field.label ??
    (field as unknown as Record<string, unknown>).title ??
    (field as unknown as Record<string, unknown>).name;
  const label = interpolateTextValue(labelSource, data);
  const idSource = field.id ?? (field as unknown as Record<string, unknown>).name ?? labelSource;
  const id = interpolateTextValue(idSource, data);
  if (!label || !id) {
    return undefined;
  }

  return {
    id,
    type: field.type ?? 'input',
    label,
    value: field.value ? interpolateTemplate(field.value, data) : undefined,
    description: interpolateTextValue(field.description, data),
    options: interpolateRichContentCollection(field.options, data, interpolateActionOption),
    input_type: field.input_type,
    placeholder: interpolateTextValue(field.placeholder, data),
    required: field.required,
  };
}

export function interpolateActionSet(
  actions: import('@abl/compiler').ActionSetIR,
  data: Record<string, unknown>,
): import('@abl/compiler').ActionSetIR {
  return {
    elements: actions.elements
      .map((element) => interpolateActionElement(element, data))
      .filter(
        (element): element is import('@abl/compiler').ActionElementIR => element !== undefined,
      ),
    submit_label: actions.submit_label
      ? interpolateTemplate(actions.submit_label, data)
      : undefined,
    submit_id: actions.submit_id ? interpolateTemplate(actions.submit_id, data) : undefined,
    renderId: actions.renderId,
  };
}

function interpolateTableRow(
  row: Record<string, string | number>,
  data: Record<string, unknown>,
): Record<string, string | number> | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return undefined;
  }

  const interpolatedRow: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    const interpolatedValue = interpolateStringOrNumberValue(value, data);
    if (interpolatedValue !== undefined) {
      interpolatedRow[key] = interpolatedValue;
    }
  }

  return Object.keys(interpolatedRow).length > 0 ? interpolatedRow : undefined;
}

function interpolateTableColumn(
  column: RuntimeTableColumn,
  data: Record<string, unknown>,
): RuntimeTableColumn | undefined {
  if (typeof column === 'string') {
    const header = interpolateTemplate(column, data);
    return header ? { key: header.toLowerCase().replace(/[^a-z0-9]+/g, '_'), header } : undefined;
  }

  const key = interpolateTextValue(column.key, data);
  const header = interpolateTextValue(column.header, data);
  if (!key || !header) {
    return undefined;
  }

  return {
    key,
    header,
    align: column.align,
  };
}

function interpolateChartDataPoint(
  dp: RuntimeChartDataPoint,
  data: Record<string, unknown>,
): RuntimeChartDataPoint | undefined {
  const label = interpolateTextValue(
    dp.label ??
      (dp as unknown as Record<string, unknown>).name ??
      (dp as unknown as Record<string, unknown>).title,
    data,
  );
  const value = interpolateNumberValue(dp.value, data);
  if (!label || value === undefined) {
    return undefined;
  }

  return {
    label,
    value,
    color: dp.color,
  };
}

/**
 * Interpolate rich content format strings using the same template engine
 */
export function interpolateRichContent(
  rc: import('@abl/compiler').RichContentIR,
  data: Record<string, unknown>,
): import('@abl/compiler').RichContentIR {
  return {
    markdown: rc.markdown ? interpolateTemplate(rc.markdown, data) : undefined,
    adaptive_card: rc.adaptive_card ? interpolateTemplate(rc.adaptive_card, data) : undefined,
    html: rc.html ? interpolateTemplate(rc.html, data) : undefined,
    slack: rc.slack ? interpolateTemplate(rc.slack, data) : undefined,
    ag_ui: rc.ag_ui ? interpolateTemplate(rc.ag_ui, data) : undefined,
    whatsapp: rc.whatsapp ? interpolateTemplate(rc.whatsapp, data) : undefined,
    carousel: rc.carousel ? interpolateCarousel(rc.carousel, data) : undefined,
    // --- Tier 1: Basic Templates ---
    // Per D-7: URL fields NOT interpolated (XSS), numeric/enum fields NOT interpolated.
    // Only text fields (label, title, subtitle, caption, alt) are interpolated.
    quick_replies: rc.quick_replies
      ? interpolateRichContentCollection(rc.quick_replies, data, interpolateQuickReply)
      : undefined,
    list: rc.list
      ? {
          title: rc.list.title ? interpolateTemplate(rc.list.title, data) : undefined,
          items: interpolateRichContentCollection(rc.list.items, data, interpolateListItem),
        }
      : undefined,
    image: rc.image
      ? {
          url: rc.image.url,
          alt: rc.image.alt ? interpolateTemplate(rc.image.alt, data) : undefined,
          thumbnail_url: rc.image.thumbnail_url,
          caption: rc.image.caption ? interpolateTemplate(rc.image.caption, data) : undefined,
        }
      : undefined,
    video: rc.video
      ? {
          url: rc.video.url,
          alt: rc.video.alt ? interpolateTemplate(rc.video.alt, data) : undefined,
          thumbnail_url: rc.video.thumbnail_url,
          caption: rc.video.caption ? interpolateTemplate(rc.video.caption, data) : undefined,
        }
      : undefined,
    audio: rc.audio
      ? {
          url: rc.audio.url,
          alt: rc.audio.alt ? interpolateTemplate(rc.audio.alt, data) : undefined,
          thumbnail_url: rc.audio.thumbnail_url,
          caption: rc.audio.caption ? interpolateTemplate(rc.audio.caption, data) : undefined,
        }
      : undefined,
    file: rc.file
      ? {
          url: rc.file.url,
          filename: interpolateTemplate(rc.file.filename, data),
          size_bytes: rc.file.size_bytes,
          mime_type: rc.file.mime_type,
        }
      : undefined,
    // --- Tier 2: Data-Rich Templates ---
    kpi: rc.kpi
      ? {
          label: interpolateTemplate(rc.kpi.label, data),
          value: rc.kpi.value,
          unit: rc.kpi.unit ? interpolateTemplate(rc.kpi.unit, data) : undefined,
          trend: rc.kpi.trend,
          icon_url: rc.kpi.icon_url,
        }
      : undefined,
    table: rc.table
      ? {
          columns: interpolateRichContentCollection(rc.table.columns, data, interpolateTableColumn),
          rows: interpolateRichContentCollection(rc.table.rows, data, interpolateTableRow),
          max_visible_rows: rc.table.max_visible_rows,
        }
      : undefined,
    chart: rc.chart
      ? {
          type: rc.chart.type,
          title: rc.chart.title ? interpolateTemplate(rc.chart.title, data) : undefined,
          data: interpolateRichContentCollection(rc.chart.data, data, interpolateChartDataPoint),
        }
      : undefined,
    form: rc.form
      ? {
          title: rc.form.title ? interpolateTemplate(rc.form.title, data) : undefined,
          fields: interpolateRichContentCollection(rc.form.fields, data, interpolateActionElement),
          submit_label: rc.form.submit_label
            ? interpolateTemplate(rc.form.submit_label, data)
            : undefined,
        }
      : undefined,
    progress: rc.progress
      ? {
          label: rc.progress.label ? interpolateTemplate(rc.progress.label, data) : undefined,
          value: rc.progress.value,
          max: rc.progress.max,
          variant: rc.progress.variant,
        }
      : undefined,
    feedback: rc.feedback
      ? {
          prompt: interpolateTemplate(rc.feedback.prompt, data),
          type: rc.feedback.type,
          max: rc.feedback.max,
        }
      : undefined,
  };
}

/**
 * Interpolate carousel card fields (title, subtitle, image_url, default_action_url).
 * Button fields are interpolated against the same card context.
 */
function interpolateCarousel(
  carousel: import('@abl/compiler').CarouselIR,
  data: Record<string, unknown>,
): import('@abl/compiler').CarouselIR {
  return {
    cards: interpolateRichContentCollection(carousel.cards, data, (card, context) => {
      const title = interpolateTextValue(
        card.title ??
          (card as unknown as Record<string, unknown>).label ??
          (card as unknown as Record<string, unknown>).name,
        context,
      );
      if (!title) {
        return undefined;
      }

      return {
        title,
        subtitle: interpolateTextValue(card.subtitle, context),
        image_url: interpolateTextValue(card.image_url, context),
        default_action_url: interpolateTextValue(card.default_action_url, context),
        buttons: card.buttons
          ? card.buttons
              .map((button) => interpolateActionElement(button, context))
              .filter(
                (button): button is import('@abl/compiler').ActionElementIR => button !== undefined,
              )
          : undefined,
      };
    }) as RuntimeCarouselCard[],
  };
}

function shouldEvaluateSetWithCel(trimmed: string): boolean {
  if (trimmed.length === 0 || trimmed.includes('{{')) {
    return false;
  }

  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
    return false;
  }

  if (/^[\[{].*[\]}]$/.test(trimmed)) {
    return true;
  }

  // Array/map index access: lookup_phone_record.result[0].pin, data["key"]
  if (/\[/.test(trimmed)) {
    return true;
  }

  if (/\b(?:has|size|abl)\(/.test(trimmed)) {
    return true;
  }

  if (/\b[A-Za-z_]\w*\(/.test(trimmed)) {
    return true;
  }

  return /(?:==|!=|>=|<=|&&|\|\||\sin\s|[+\-*/%?:<>])/.test(trimmed);
}

function hasArithmeticOperatorOutsideQuotes(expression: string): boolean {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote) {
      if (char === quote && expression[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '%') {
      return true;
    }
  }

  return false;
}

function isCelNumericTypeMismatchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such overload/i.test(message) && /\b(?:double|int|uint)\b/i.test(message);
}

function isExpressionIdentifierChar(char: string | undefined): boolean {
  return typeof char === 'string' && /[A-Za-z0-9_.]/.test(char);
}

function previousNonWhitespaceChar(expression: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = expression[cursor];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return undefined;
}

function isUnaryMinus(expression: string, index: number): boolean {
  if (expression[index] !== '-') {
    return false;
  }

  const prev = previousNonWhitespaceChar(expression, index);
  return prev === undefined || /[([{:?,+\-*/%<>=!&|]/.test(prev);
}

function coerceArithmeticIntegerLiteralsToDouble(expression: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < expression.length; ) {
    const char = expression[index];

    if (quote) {
      result += char;
      if (char === quote && expression[index - 1] !== '\\') {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    const unaryMinus =
      char === '-' && /\d/.test(expression[index + 1] ?? '') && isUnaryMinus(expression, index);
    if (/\d/.test(char) || unaryMinus) {
      const tokenStart = index;
      if (unaryMinus) {
        index += 1;
      }

      while (index < expression.length && /\d/.test(expression[index] ?? '')) {
        index += 1;
      }

      const nextChar = expression[index];
      const numericToken = expression.slice(tokenStart, index);
      const previousChar = expression[tokenStart - 1];

      if (
        nextChar === '.' ||
        nextChar === 'e' ||
        nextChar === 'E' ||
        isExpressionIdentifierChar(previousChar) ||
        isExpressionIdentifierChar(nextChar)
      ) {
        result += numericToken;
        continue;
      }

      result += `${numericToken}.0`;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function tryEvaluateSetWithNumericLiteralCoercion(
  expression: string,
  context: Record<string, unknown>,
): unknown | undefined {
  if (!hasArithmeticOperatorOutsideQuotes(expression)) {
    return undefined;
  }

  const normalizedExpression = coerceArithmeticIntegerLiteralsToDouble(expression);
  if (normalizedExpression === expression) {
    return undefined;
  }

  try {
    return evaluateCel(normalizedExpression, context);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a SET value expression: preserve literal compatibility while allowing
 * CEL evaluation for computed expressions.
 */
export function resolveSetValue(rawValue: string, context: Record<string, unknown>): unknown {
  const trimmed = rawValue.trim();

  // Strip surrounding quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return interpolateTemplate(trimmed.slice(1, -1), context);
  }

  // Boolean literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;

  // Number literals
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);

  if (shouldEvaluateSetWithCel(trimmed)) {
    try {
      return evaluateCel(trimmed, context);
    } catch (err) {
      const normalizedValue = isCelNumericTypeMismatchError(err)
        ? tryEvaluateSetWithNumericLiteralCoercion(trimmed, context)
        : undefined;
      if (normalizedValue !== undefined) {
        log.debug('SET CEL evaluation recovered with numeric literal coercion', {
          expression: trimmed.slice(0, 200),
        });
        return normalizedValue;
      }
      log.debug('SET CEL evaluation failed, falling back to legacy resolution', {
        expression: trimmed.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Bare dotted identifiers are treated as value-path expressions.
  // Quote the value explicitly to store a literal like "result.user_id".
  if (isBareValuePathExpression(trimmed)) {
    return resolveValuePath(trimmed, context);
  }

  // Template interpolation (for {{var}} references)
  return interpolateTemplate(trimmed, context);
}

/**
 * Resolve a value path expression like "hotels.length" or "variable.property"
 */
export function resolveValuePath(expr: string, context: Record<string, unknown>): unknown {
  // Handle array.length
  const lengthMatch = expr.match(/^(\w+)\.length$/);
  if (lengthMatch) {
    const arr = context[lengthMatch[1]];
    if (Array.isArray(arr)) {
      return arr.length;
    } else if (arr !== undefined) {
      log.warn('Value is not an array, .length check skipped', {
        field: lengthMatch[1],
        type: typeof arr,
      });
    }
  }

  // Handle nested property access
  const parts = expr.split('.');
  let value: unknown = context;
  for (const part of parts) {
    const resolved = resolvePathSegment(value, part);
    if (!resolved.resolved) {
      return undefined;
    }
    value = resolved.value;
  }
  return value;
}
