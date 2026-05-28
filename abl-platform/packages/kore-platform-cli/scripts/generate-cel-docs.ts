/**
 * Generate CEL Functions documentation from the language-service registry.
 *
 * Reads CEL_FUNCTIONS from @abl/language-service and outputs a TypeScript
 * constant with markdown content grouped by category.
 *
 * Usage: npx tsx packages/kore-platform-cli/scripts/generate-cel-docs.ts
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { CEL_FUNCTIONS } = await import('@abl/language-service');

const CATEGORY_TITLES: Record<string, string> = {
  string: 'String Functions',
  numeric: 'Numeric Functions',
  formatting: 'Formatting Functions',
  type: 'Type Functions',
  array: 'Array Functions',
  object: 'Object Functions',
  utility: 'Utility Functions',
};

const CATEGORY_ORDER = ['string', 'numeric', 'formatting', 'type', 'array', 'object', 'utility'];

// Group functions by category
const grouped = new Map<string, Array<(typeof CEL_FUNCTIONS)[number]>>();
for (const fn of CEL_FUNCTIONS) {
  const list = grouped.get(fn.category) || [];
  list.push(fn);
  grouped.set(fn.category, list);
}

// Generate markdown
const lines: string[] = [
  '# CEL Functions Reference',
  '',
  'ABL provides built-in CEL (Common Expression Language) functions for use in',
  'conditions, transitions, and computed fields.',
  '',
  `Total: ${CEL_FUNCTIONS.length} functions across ${grouped.size} categories.`,
  '',
];

for (const cat of CATEGORY_ORDER) {
  const fns = grouped.get(cat);
  if (!fns) continue;

  lines.push(`## ${CATEGORY_TITLES[cat] || cat}`);
  lines.push('');
  lines.push('| Function | Signature | Description |');
  lines.push('|----------|-----------|-------------|');

  for (const fn of fns) {
    lines.push(`| \`${fn.name}\` | \`${fn.signature}\` | ${fn.description} |`);
  }
  lines.push('');
}

lines.push('## Usage Examples');
lines.push('');
lines.push('```yaml');
lines.push('# In a transition condition:');
lines.push('transitions:');
lines.push('  - target: next_step');
lines.push('    condition: abl.length(context.items) > 0');
lines.push('');
lines.push('# In a computed field:');
lines.push('fields:');
lines.push('  formatted_name:');
lines.push('    type: string');
lines.push('    compute: abl.upper(abl.trim(context.name))');
lines.push('');
lines.push('# In a constraint:');
lines.push('constraints:');
lines.push('  - description: Only process valid amounts');
lines.push('    condition: abl.is_number(context.amount) && abl.round(context.amount, 2) > 0');
lines.push('```');

const markdown = lines.join('\n');

// Write as a TypeScript constant
const output = `/**
 * Auto-generated CEL Functions documentation.
 * DO NOT EDIT — regenerate with: npx tsx scripts/generate-cel-docs.ts
 */
export const CEL_FUNCTIONS_DOCS = \`${markdown.replace(/`/g, '\\`')}\`;
`;

const outPath = join(__dirname, '..', 'src', 'mcp', 'docs', 'cel-functions-generated.ts');
writeFileSync(outPath, output, 'utf-8');

console.log(`Generated CEL docs: ${outPath} (${markdown.length} chars)`);
