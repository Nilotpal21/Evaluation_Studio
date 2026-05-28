import { describe, expect, it } from 'vitest';
import { PRESETS, PRESET_NAMES, DEFAULT_PRESET } from '../presets.js';

describe('presets', () => {
  it('contains exactly 6 preset names', () => {
    expect(PRESET_NAMES).toHaveLength(6);
  });

  it('includes all expected preset names', () => {
    expect(PRESET_NAMES).toContain('auto');
    expect(PRESET_NAMES).toContain('balanced');
    expect(PRESET_NAMES).toContain('stress-negative');
    expect(PRESET_NAMES).toContain('short-simple');
    expect(PRESET_NAMES).toContain('long-complex');
    expect(PRESET_NAMES).toContain('abandonment');
  });

  it('has the default preset set to auto', () => {
    expect(DEFAULT_PRESET).toBe('auto');
  });

  it('auto preset references all five sub-profiles', () => {
    const auto = PRESETS.auto;
    expect(auto).toMatch(/balanced/i);
    expect(auto).toMatch(/stress-negative/i);
    expect(auto).toMatch(/short-simple/i);
    expect(auto).toMatch(/long-complex/i);
    expect(auto).toMatch(/abandonment/i);
  });

  it('has a non-empty string for each preset', () => {
    for (const name of PRESET_NAMES) {
      const content = PRESETS[name];
      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('has keys in PRESETS matching PRESET_NAMES', () => {
    const presetKeys = Object.keys(PRESETS).sort();
    const names = [...PRESET_NAMES].sort();
    expect(presetKeys).toEqual(names);
  });

  it('balanced preset mentions variety', () => {
    expect(PRESETS.balanced).toMatch(/variety|mix/i);
  });

  it('stress-negative preset mentions frustrated/angry', () => {
    expect(PRESETS['stress-negative']).toMatch(/frustrated|angry/i);
  });

  it('short-simple preset mentions 2-3 turns', () => {
    expect(PRESETS['short-simple']).toMatch(/2-3/);
  });

  it('long-complex preset mentions 6-10 turns', () => {
    expect(PRESETS['long-complex']).toMatch(/6-10/);
  });

  it('abandonment preset mentions 70%', () => {
    expect(PRESETS.abandonment).toMatch(/70%/);
  });
});
