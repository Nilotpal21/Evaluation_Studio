import { describe, it, expect } from 'vitest';
import { detectFormat } from '../detect-format';

describe('detectFormat', () => {
  it('detects YAML format from colon-separated keys', () => {
    const yaml = `agent: booking\nmode: scripted\ngoal: Help users`;
    expect(detectFormat(yaml)).toBe('yaml');
  });

  it('detects legacy format from uppercase section headers', () => {
    const legacy = `AGENT: booking\nGOAL:\n  Help users book hotels
GOAL: "Handle agent tasks"`;
    expect(detectFormat(legacy)).toBe('legacy');
  });

  it('detects YAML from indented mapping style', () => {
    const yaml = `agent: test\ntools:\n  - search_hotels\n  - book_room`;
    expect(detectFormat(yaml)).toBe('yaml');
  });

  it('returns legacy for empty input', () => {
    expect(detectFormat('')).toBe('legacy');
  });

  it('detects YAML from lowercase keys', () => {
    const yaml = `agent: test\nconstraints:\n  - rule: "no profanity"`;
    expect(detectFormat(yaml)).toBe('yaml');
  });
});
