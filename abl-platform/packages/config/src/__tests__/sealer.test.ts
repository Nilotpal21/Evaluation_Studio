import { describe, it, expect } from 'vitest';
import { deepFreeze, sealConfig } from '../sealer.js';

describe('deepFreeze', () => {
  it('should freeze top-level properties', () => {
    const obj = { a: 1, b: 'hello' };
    const frozen = deepFreeze(obj);

    expect(() => {
      (frozen as Record<string, unknown>).a = 2;
    }).toThrow();
  });

  it('should freeze nested objects', () => {
    const obj = { nested: { value: 42 } };
    const frozen = deepFreeze(obj);

    expect(() => {
      (frozen.nested as Record<string, unknown>).value = 99;
    }).toThrow();
  });

  it('should freeze arrays', () => {
    const obj = { items: [1, 2, 3] };
    const frozen = deepFreeze(obj);

    expect(() => {
      (frozen.items as number[]).push(4);
    }).toThrow();
  });
});

describe('sealConfig', () => {
  it('should return a frozen copy in prod mode', () => {
    const config = { server: { port: 3001 } };
    const sealed = sealConfig(config, false);

    expect(sealed.server.port).toBe(3001);
    expect(() => {
      (sealed as Record<string, unknown>).server = {};
    }).toThrow();
  });

  it('should provide descriptive errors in dev mode', () => {
    const config = { server: { port: 3001 } };
    const sealed = sealConfig(config, true);

    expect(sealed.server.port).toBe(3001);
    expect(() => {
      (sealed as Record<string, unknown>).server = {};
    }).toThrow(/Cannot modify config property/);
  });

  it('should not mutate the original object', () => {
    const config = { value: 'original' };
    sealConfig(config, false);

    // Original should be unaffected
    config.value = 'modified';
    expect(config.value).toBe('modified');
  });
});
