import * as yaml from 'js-yaml';
import type { GuardrailArchiveFormat } from './types.js';

export const GUARDRAIL_JSON_SUFFIX = '.guardrail.json';
export const GUARDRAIL_YAML_SUFFIX = '.guardrail.yaml';

const GUARDRAIL_DIRECTORY_PREFIX = 'guardrails/';
const YAML_DUMP_OPTIONS = {
  lineWidth: -1,
  noRefs: true,
  sortKeys: true,
} satisfies yaml.DumpOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGuardrailArchivePath(filePath: string): boolean {
  return (
    filePath.startsWith(GUARDRAIL_DIRECTORY_PREFIX) &&
    (filePath.endsWith(GUARDRAIL_JSON_SUFFIX) || filePath.endsWith(GUARDRAIL_YAML_SUFFIX))
  );
}

export function getGuardrailArchiveFormatFromPath(filePath: string): GuardrailArchiveFormat | null {
  if (filePath.endsWith(GUARDRAIL_JSON_SUFFIX)) {
    return 'json';
  }

  if (filePath.endsWith(GUARDRAIL_YAML_SUFFIX)) {
    return 'yaml';
  }

  return null;
}

export function guardrailArchivePath(
  name: string,
  format: GuardrailArchiveFormat = 'json',
): string {
  const suffix = format === 'yaml' ? GUARDRAIL_YAML_SUFFIX : GUARDRAIL_JSON_SUFFIX;
  return `${GUARDRAIL_DIRECTORY_PREFIX}${name}${suffix}`;
}

export function extractGuardrailArchiveName(filePath: string): string | null {
  const format = getGuardrailArchiveFormatFromPath(filePath);
  if (!format || !filePath.startsWith(GUARDRAIL_DIRECTORY_PREFIX)) {
    return null;
  }

  const suffix = format === 'yaml' ? GUARDRAIL_YAML_SUFFIX : GUARDRAIL_JSON_SUFFIX;
  const relativePath = filePath.slice(GUARDRAIL_DIRECTORY_PREFIX.length, -suffix.length);

  return relativePath.length > 0 ? relativePath : null;
}

export function parseGuardrailArchive(
  filePath: string,
  content: string,
  warnings: string[],
): Record<string, unknown> | null {
  const format = getGuardrailArchiveFormatFromPath(filePath);
  if (!format) {
    warnings.push(`Skipping ${filePath}: unsupported guardrail archive format`);
    return null;
  }

  try {
    const parsed = format === 'json' ? JSON.parse(content) : yaml.load(content);
    if (!isRecord(parsed)) {
      warnings.push(`Failed to parse ${filePath}: expected an object document`);
      return null;
    }

    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown parse error';
    warnings.push(`Failed to parse ${filePath}: ${detail}`);
    return null;
  }
}

export function serializeGuardrailArchive(
  record: Record<string, unknown>,
  format: GuardrailArchiveFormat,
): string {
  if (format === 'json') {
    return JSON.stringify(record, null, 2);
  }

  return `${yaml.dump(record, YAML_DUMP_OPTIONS).trimEnd()}\n`;
}
