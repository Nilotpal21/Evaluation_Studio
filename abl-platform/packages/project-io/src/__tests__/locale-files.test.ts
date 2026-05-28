import { describe, expect, it } from 'vitest';
import {
  isLocaleAssetConfigKey,
  isLocaleAssetFilePath,
  localeAssetConfigKeyToRelativePath,
  localeAssetRelativePathToConfigKey,
  localeAssetRelativePathToFilePath,
  normalizeLocaleAssetRelativePath,
  parseLocaleAssetPath,
} from '../locale-files.js';

describe('locale file path helpers', () => {
  it('round-trips locale asset file paths and config keys without dropping locale scope', () => {
    expect(normalizeLocaleAssetRelativePath('locales/fr/messages.json')).toBe('fr/messages.json');
    expect(localeAssetRelativePathToConfigKey('locales/fr/messages.json')).toBe(
      'locale:fr/messages.json',
    );
    expect(localeAssetConfigKeyToRelativePath('locale:fr/messages.json')).toBe('fr/messages.json');
    expect(localeAssetRelativePathToFilePath('fr/messages.json')).toBe('locales/fr/messages.json');
    expect(isLocaleAssetFilePath('locales/fr/messages.json')).toBe(true);
    expect(isLocaleAssetConfigKey('locale:fr/messages.json')).toBe(true);
  });

  it('classifies shared and agent locale assets from the normalized path', () => {
    expect(parseLocaleAssetPath('locales/en/_shared.json')).toEqual({
      localeCode: 'en',
      fileName: '_shared.json',
      assetName: '_shared',
      scope: 'shared',
    });

    expect(parseLocaleAssetPath('fr/support-agent.json')).toEqual({
      localeCode: 'fr',
      fileName: 'support-agent.json',
      assetName: 'support-agent',
      scope: 'agent',
    });
  });

  it('rejects ambiguous, traversal, nested, and non-json locale paths', () => {
    for (const invalidPath of [
      '',
      'locales/messages.json',
      'locales/en/messages.yaml',
      'locales/en/../messages.json',
      'locales/en/nested/messages.json',
      'locales/en/messages.json\0',
      'locale:en/messages.json',
    ]) {
      expect(normalizeLocaleAssetRelativePath(invalidPath), invalidPath).toBeNull();
      expect(isLocaleAssetFilePath(invalidPath), invalidPath).toBe(false);
    }
  });

  it('fails closed when converting invalid paths into persisted keys', () => {
    expect(() => localeAssetRelativePathToConfigKey('locales/messages.json')).toThrow(
      'Invalid locale asset path',
    );
    expect(() => localeAssetRelativePathToFilePath('locales/en/messages.yaml')).toThrow(
      'Invalid locale asset path',
    );
    expect(localeAssetConfigKeyToRelativePath('secret:fr/messages.json')).toBeNull();
  });
});
