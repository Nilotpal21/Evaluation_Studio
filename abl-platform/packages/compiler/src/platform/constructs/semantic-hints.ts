/**
 * Semantic Extraction Hints -- builds LLM extraction instructions from gather field metadata.
 *
 * These hints are appended to field descriptions in the extraction prompt to guide
 * the LLM toward correct structured output (addresses, currency, ranges, etc.).
 *
 * Pure function -- no I/O, no runtime dependencies.
 */
import type { GatherField, FlowGatherField, GatherFieldSemantics } from '../ir/schema.js';

/** Minimal field shape accepted by buildSemanticHint (works with both GatherField and FlowGatherField) */
export type SemanticHintInput = Pick<
  GatherField | FlowGatherField,
  'semantics' | 'range' | 'list' | 'preferences'
>;

export function buildSemanticHint(field: Partial<SemanticHintInput>): string {
  const hints: string[] = [];

  // Semantic format hints
  if (field.semantics) {
    const s: GatherFieldSemantics = field.semantics;

    if (s.format === 'address' && s.components?.length) {
      hints.push(`(extract as structured address with components: ${s.components.join(', ')})`);
    } else if (s.format === 'address') {
      hints.push('(extract as structured address)');
    } else if (s.format === 'airport_code') {
      hints.push('(extract IATA airport code, e.g., LAX, JFK)');
    } else if (s.format === 'phone') {
      hints.push('(extract as phone number in E.164 format)');
    } else if (s.format === 'email') {
      hints.push('(extract as valid email address)');
    } else if (s.format === 'date') {
      hints.push('(extract as ISO 8601 date, e.g., 2024-03-15)');
    } else if (s.format === 'time') {
      hints.push('(extract as 24h time, e.g., 14:30)');
    } else if (s.format === 'datetime') {
      hints.push('(extract as ISO 8601 datetime)');
    } else if (s.format) {
      hints.push(`(extract as ${s.format})`);
    }

    if (s.unit) {
      hints.push(`(unit: ${s.unit}${s.format ? `, format: ${s.format}` : ''})`);
    }

    if (s.convert_to) {
      hints.push(`(convert to: ${s.convert_to})`);
    }

    if (s.lookup) {
      hints.push(`(valid values from: ${s.lookup})`);
    }
  }

  // Range extraction
  if (field.range) {
    hints.push('(extract as range with low/high bounds, e.g., {"low": 100, "high": 300})');
  }

  // List extraction
  if (field.list) {
    hints.push('(extract as array of values)');
  }

  // Preference categorization
  if (field.preferences) {
    hints.push(
      '(categorize into: {"accept": [...], "desire": [...], "avoid": [...], "refuse": [...]})',
    );
  }

  return hints.join(' ');
}
