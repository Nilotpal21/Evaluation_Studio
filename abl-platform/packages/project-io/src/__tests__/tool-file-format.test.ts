import { describe, expect, it } from 'vitest';
import { canonicalizeToolFileContent } from '../tool-file-format.js';

describe('canonicalizeToolFileContent', () => {
  it('wraps standalone tool DSL into canonical TOOLS format', () => {
    const result = canonicalizeToolFileContent(`lookup(city: string) -> object
  type: http
  description: "Lookup weather"
  endpoint: "/weather/{city}"
  method: GET`);

    expect(result.normalized).toBe(true);
    expect(result.content).toBe(`TOOLS:
  lookup(city: string) -> object
    type: http
    description: "Lookup weather"
    endpoint: "/weather/{city}"
    method: GET`);
    expect(result.validationErrors).toEqual([]);
  });

  it('preserves canonical tool files that begin with BOMs or comments', () => {
    const content = `\uFEFF# Shared defaults

TOOLS:
  lookup(city: string) -> object
    type: http
    description: "Lookup weather"
    endpoint: "/weather/{city}"
    method: GET`;

    const result = canonicalizeToolFileContent(content);

    expect(result.normalized).toBe(false);
    expect(result.content).toBe(content);
    expect(result.validationErrors).toEqual([]);
  });

  it('strips a BOM when wrapping standalone tool DSL', () => {
    const result = canonicalizeToolFileContent(`\uFEFFlookup(city: string) -> object
  type: http
  description: "Lookup weather"
  endpoint: "/weather/{city}"
  method: GET`);

    expect(result.normalized).toBe(true);
    expect(result.content.startsWith('TOOLS:\n  lookup(')).toBe(true);
    expect(result.content.includes('\uFEFF')).toBe(false);
  });
});
