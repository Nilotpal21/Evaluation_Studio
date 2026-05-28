const LOCALE_ASSET_KEY_PREFIX = 'locale:';
const LOCALE_ASSET_FILE_PREFIX = 'locales/';
const LOCALE_ASSET_FILE_EXTENSION = '.json';

const LOCALE_CODE_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;
const LOCALE_ASSET_FILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.json$/;

export interface LocaleAssetPathParts {
  localeCode: string;
  fileName: string;
  assetName: string;
  scope: 'shared' | 'agent';
}

function stripLocaleAssetPrefix(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed.startsWith(LOCALE_ASSET_FILE_PREFIX)
    ? trimmed.slice(LOCALE_ASSET_FILE_PREFIX.length)
    : trimmed;
}

export function normalizeLocaleAssetRelativePath(value: string): string | null {
  const normalized = stripLocaleAssetPrefix(value);
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.includes('..') ||
    normalized.endsWith('/')
  ) {
    return null;
  }

  const parts = normalized.split('/');
  if (parts.length !== 2) {
    return null;
  }

  const [localeCode, fileName] = parts;
  if (!LOCALE_CODE_PATTERN.test(localeCode) || !LOCALE_ASSET_FILE_NAME_PATTERN.test(fileName)) {
    return null;
  }

  return `${localeCode}/${fileName}`;
}

export function isLocaleAssetFilePath(value: string): boolean {
  return normalizeLocaleAssetRelativePath(value) !== null;
}

export function parseLocaleAssetPath(value: string): LocaleAssetPathParts | null {
  const normalized = normalizeLocaleAssetRelativePath(value);
  if (!normalized) {
    return null;
  }

  const [localeCode, fileName] = normalized.split('/');
  const assetName = fileName.slice(0, -LOCALE_ASSET_FILE_EXTENSION.length);

  return {
    localeCode,
    fileName,
    assetName,
    scope: fileName === '_shared.json' ? 'shared' : 'agent',
  };
}

export function localeAssetRelativePathToFilePath(value: string): string {
  const normalized = normalizeLocaleAssetRelativePath(value);
  if (!normalized) {
    throw new Error(`Invalid locale asset path: ${value}`);
  }

  return `${LOCALE_ASSET_FILE_PREFIX}${normalized}`;
}

export function localeAssetRelativePathToConfigKey(value: string): string {
  const normalized = normalizeLocaleAssetRelativePath(value);
  if (!normalized) {
    throw new Error(`Invalid locale asset path: ${value}`);
  }

  return `${LOCALE_ASSET_KEY_PREFIX}${normalized}`;
}

export function localeAssetConfigKeyToRelativePath(value: string): string | null {
  if (!value.startsWith(LOCALE_ASSET_KEY_PREFIX)) {
    return null;
  }

  return normalizeLocaleAssetRelativePath(value.slice(LOCALE_ASSET_KEY_PREFIX.length));
}

export function isLocaleAssetConfigKey(value: string): boolean {
  return localeAssetConfigKeyToRelativePath(value) !== null;
}

export { LOCALE_ASSET_KEY_PREFIX, LOCALE_ASSET_FILE_PREFIX, LOCALE_ASSET_FILE_EXTENSION };
