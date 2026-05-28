/**
 * Template Engine — Unified renderer for prompt templates.
 *
 * Supports:
 * - {{variable}} and {{nested.path}} — simple substitution
 * - {{#if variable}}...{{/if}} — conditional blocks (truthy check)
 * - {{#each array}}...{{/each}} — iteration with {{@index}} and item properties
 *
 * Replaces both interpolateTemplate() (value-resolution.ts) and
 * interpolateMessage() (compiler/evaluator.ts) with one consistent engine.
 */

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
  context: Record<string, unknown>,
): string | null {
  const initialValue = getNestedValue(context, path);
  if (initialValue === undefined) {
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
      return null;
    }
    currentValue = filteredValue;
  }

  if (Array.isArray(currentValue)) {
    return JSON.stringify(currentValue, null, 2);
  }

  return String(currentValue ?? '');
}

/**
 * Render a template string with context values.
 *
 * Undefined variables are preserved as-is ({{name}}) so callers
 * can detect missing data. Empty string / null / false removes
 * the placeholder.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  let result = template;

  // 1. {{#each array}}...{{/each}}
  result = result.replace(
    /\{\{#each\s+(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, arrayName: string, body: string) => {
      const arr = getNestedValue(context, arrayName);
      if (!Array.isArray(arr)) return '';

      return arr
        .map((item, index) => {
          let rendered = body;
          // {{@index}}
          rendered = rendered.replace(/\{\{@index\}\}/g, String(index));
          // {{add @index N}}
          rendered = rendered.replace(/\{\{add\s+@index\s+(\d+)\}\}/g, (_m: string, num: string) =>
            String(index + parseInt(num)),
          );
          // Item properties
          if (typeof item === 'object' && item !== null) {
            const itemObj = item as Record<string, unknown>;
            rendered = rendered.replace(/\{\{(\w+)\}\}/g, (_m: string, prop: string) => {
              const val = itemObj[prop];
              return val !== undefined ? String(val) : '';
            });
          }
          return rendered;
        })
        .join('');
    },
  );

  // 2. {{#if variable}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, path: string, body: string) => {
      const value = getNestedValue(context, path);
      if (value) {
        return renderTemplate(body, context);
      }
      return '';
    },
  );

  // 3. Filtered placeholders like {{user.createdAt | ago}}
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\s*\|\s*([^}]+)\}\}/g, (_match, path, filters) => {
    const resolved = resolveFilteredTemplateExpression(path, filters, context);
    return resolved === null ? '' : resolved;
  });

  // 4. {{variable}} and {{nested.path}}
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path: string) => {
    const value = getNestedValue(context, path);
    if (value === undefined) return match; // preserve placeholder
    if (Array.isArray(value)) return JSON.stringify(value, null, 2);
    return String(value);
  });

  return result;
}

/** Get a nested value using dot-path notation */
function getNestedValue(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let value: unknown = data;
  for (const part of parts) {
    if (value && typeof value === 'object') {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return value;
}
