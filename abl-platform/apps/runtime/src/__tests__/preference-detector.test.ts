import { describe, test, expect } from 'vitest';
import {
  detectPreferencesFromText,
  mergePreferences,
} from '../services/execution/preference-detector.js';

describe('PreferenceDetector', () => {
  test('"I prefer ocean view" → desire category', () => {
    const prefs = detectPreferencesFromText('I prefer ocean view');
    expect(prefs.length).toBeGreaterThanOrEqual(1);

    const desire = prefs.find((p) => p.category === 'desire');
    expect(desire).toBeDefined();
    expect(desire!.value).toMatch(/ocean view/i);
  });

  test('"I don\'t want smoking rooms" → avoid category', () => {
    const prefs = detectPreferencesFromText("I don't want smoking rooms");
    expect(prefs.length).toBeGreaterThanOrEqual(1);

    const avoid = prefs.find((p) => p.category === 'avoid');
    expect(avoid).toBeDefined();
    expect(avoid!.value).toMatch(/smoking rooms/i);
  });

  test('"I\'m allergic to pets" → refuse category', () => {
    const prefs = detectPreferencesFromText("I'm allergic to pets");
    expect(prefs.length).toBeGreaterThanOrEqual(1);

    const refuse = prefs.find((p) => p.category === 'refuse');
    expect(refuse).toBeDefined();
    expect(refuse!.value).toMatch(/pets/i);
  });

  test('"That sounds fine" → accept category', () => {
    const prefs = detectPreferencesFromText('That sounds fine');
    expect(prefs.length).toBeGreaterThanOrEqual(1);

    const accept = prefs.find((p) => p.category === 'accept');
    expect(accept).toBeDefined();
  });

  test('Deduplication — same preference not duplicated', () => {
    const existing = detectPreferencesFromText("I don't want smoking rooms");
    const incoming = detectPreferencesFromText("I don't want smoking rooms");

    const merged = mergePreferences(existing, incoming);

    // Same value should not be duplicated
    const smokingPrefs = merged.filter((p) => p.value.toLowerCase().includes('smoking rooms'));
    expect(smokingPrefs).toHaveLength(1);
  });

  test('Category escalation — avoid upgrades to refuse', () => {
    const existing = detectPreferencesFromText("I don't want pets");
    // existing should have an 'avoid' for pets
    expect(existing.some((p) => p.category === 'avoid')).toBe(true);

    const incoming = detectPreferencesFromText("I'm allergic to pets");
    // incoming should have a 'refuse' for pets
    expect(incoming.some((p) => p.category === 'refuse')).toBe(true);

    const merged = mergePreferences(existing, incoming);

    // 'refuse' is stronger than 'avoid', so it should escalate
    const petPrefs = merged.filter((p) => p.value.toLowerCase().includes('pets'));
    expect(petPrefs).toHaveLength(1);
    expect(petPrefs[0].category).toBe('refuse');
  });

  test('Symmetric detection — both prefer and avoid detected', () => {
    const prefs = detectPreferencesFromText("I prefer ocean view. I don't want smoking rooms.");

    const desire = prefs.find((p) => p.category === 'desire');
    const avoid = prefs.find((p) => p.category === 'avoid');

    expect(desire).toBeDefined();
    expect(avoid).toBeDefined();
    expect(desire!.value).toMatch(/ocean view/i);
    expect(avoid!.value).toMatch(/smoking rooms/i);
  });

  test('No preference signals → empty result', () => {
    const prefs = detectPreferencesFromText('Hello, how are you?');
    expect(prefs).toHaveLength(0);
  });
});
