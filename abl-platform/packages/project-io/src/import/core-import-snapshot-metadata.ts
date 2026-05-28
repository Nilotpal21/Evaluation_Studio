import { normalizeLocaleAssetRelativePath } from '../locale-files.js';

export const CORE_IMPORT_SNAPSHOT_METADATA_FILE = '.core-import-snapshot.json';

interface CoreImportSnapshotLocaleMetadataEntry {
  description: string | null;
}

interface CoreImportSnapshotMetadataV1 {
  version: 1;
  locales?: Record<string, CoreImportSnapshotLocaleMetadataEntry>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRawMetadata(files: Map<string, string> | Record<string, string>): string | undefined {
  if (files instanceof Map) {
    return files.get(CORE_IMPORT_SNAPSHOT_METADATA_FILE);
  }

  return files[CORE_IMPORT_SNAPSHOT_METADATA_FILE];
}

export function buildCoreImportSnapshotMetadata(
  locales: Array<{ relativePath: string; description: string | null }> | undefined,
): string | null {
  if (!locales || locales.length === 0) {
    return null;
  }

  const metadata: CoreImportSnapshotMetadataV1 = {
    version: 1,
    locales: Object.fromEntries(
      locales.flatMap((locale) => {
        const normalized = normalizeLocaleAssetRelativePath(locale.relativePath);
        if (!normalized) {
          return [];
        }

        return [[normalized, { description: locale.description ?? null }]];
      }),
    ),
  };

  return JSON.stringify(metadata, null, 2);
}

export function readCoreImportSnapshotLocaleDescriptions(
  files: Map<string, string> | Record<string, string>,
): Map<string, string | null> {
  const rawMetadata = readRawMetadata(files);
  if (!rawMetadata) {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return new Map();
  }

  if (!isPlainObject(parsed) || parsed.version !== 1) {
    return new Map();
  }

  const locales = parsed.locales;
  if (!isPlainObject(locales)) {
    return new Map();
  }

  const descriptions = new Map<string, string | null>();
  for (const [relativePath, entry] of Object.entries(locales)) {
    const normalized = normalizeLocaleAssetRelativePath(relativePath);
    if (!normalized || !isPlainObject(entry)) {
      continue;
    }

    const description = entry.description;
    descriptions.set(normalized, typeof description === 'string' ? description : null);
  }

  return descriptions;
}
