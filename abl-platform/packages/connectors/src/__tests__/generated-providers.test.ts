import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceProvidersPath = resolve(__dirname, '../adapters/nango/generated/providers.json');
const distProvidersPath = resolve(__dirname, '../../dist/adapters/nango/generated/providers.json');

function readProviders(filePath: string): ProviderConfig[] {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as ProviderConfig[];
}

describe('generated Nango providers artifact', () => {
  it('ships a populated providers.json in src and dist', () => {
    const sourceProviders = readProviders(sourceProvidersPath);

    expect(sourceProviders.length).toBeGreaterThan(0);
    expect(sourceProviders.some((provider) => provider.name === 'slack')).toBe(true);

    expect(existsSync(distProvidersPath)).toBe(true);
    expect(readProviders(distProvidersPath)).toEqual(sourceProviders);
  });
});
