import { describe, expect, it } from 'vitest';
import {
  extractGuardrailArchiveName,
  getGuardrailArchiveFormatFromPath,
  guardrailArchivePath,
  isGuardrailArchivePath,
  parseGuardrailArchive,
  serializeGuardrailArchive,
} from '../guardrail-projection.js';

describe('guardrail-projection', () => {
  it('recognizes both canonical guardrail archive path formats', () => {
    expect(isGuardrailArchivePath('guardrails/pii.guardrail.json')).toBe(true);
    expect(isGuardrailArchivePath('guardrails/pii.guardrail.yaml')).toBe(true);
    expect(isGuardrailArchivePath('guardrails/pii.json')).toBe(false);
  });

  it('derives archive format and name from either suffix', () => {
    expect(getGuardrailArchiveFormatFromPath('guardrails/pii.guardrail.json')).toBe('json');
    expect(getGuardrailArchiveFormatFromPath('guardrails/pii.guardrail.yaml')).toBe('yaml');
    expect(extractGuardrailArchiveName('guardrails/pii.guardrail.json')).toBe('pii');
    expect(extractGuardrailArchiveName('guardrails/pii.guardrail.yaml')).toBe('pii');
    expect(guardrailArchivePath('pii', 'yaml')).toBe('guardrails/pii.guardrail.yaml');
  });

  it('parses YAML guardrail archives into the canonical object shape', () => {
    const warnings: string[] = [];
    const parsed = parseGuardrailArchive(
      'guardrails/pii.guardrail.yaml',
      ['name: PII Filter', 'scope:', '  type: project', '  projectId: proj-1'].join('\n'),
      warnings,
    );

    expect(warnings).toHaveLength(0);
    expect(parsed).toEqual({
      name: 'PII Filter',
      scope: { type: 'project', projectId: 'proj-1' },
    });
  });

  it('serializes YAML archives deterministically', () => {
    const content = serializeGuardrailArchive(
      {
        scope: { projectId: 'proj-1', type: 'project' },
        name: 'PII Filter',
      },
      'yaml',
    );

    expect(content).toBe('name: PII Filter\nscope:\n  projectId: proj-1\n  type: project\n');
  });

  it('warns when a guardrail archive does not parse to an object', () => {
    const warnings: string[] = [];
    const parsed = parseGuardrailArchive(
      'guardrails/pii.guardrail.yaml',
      '- not-an-object',
      warnings,
    );

    expect(parsed).toBeNull();
    expect(warnings[0]).toContain('expected an object document');
  });
});
