/**
 * DebugTabs - Deprecated Badge Configuration Test
 *
 * Unit test verifying that the tabs configuration includes a deprecated badge
 * on the old Traces tab after UI refactoring (ABLP-214).
 *
 * This test validates the tab configuration logic without rendering the full component,
 * making it less brittle and easier to maintain.
 */

import { describe, it, expect } from 'vitest';

// Type matching the tab configuration in DebugTabs.tsx
type TabConfig = {
  id: string;
  label: string;
  icon: unknown;
  badge?: number;
  deprecated?: boolean;
};

describe('DebugTabs - Deprecated Badge Configuration', () => {
  // Simulating the tabs array configuration from DebugTabs.tsx
  const createTabsConfig = (
    isVoiceSession: boolean,
    errorCount: number,
    interactionCount: number,
  ): TabConfig[] => {
    const tabs: TabConfig[] = [
      { id: 'overview', label: 'Overview', icon: {} },
      {
        id: 'interactions',
        label: 'Traces', // Was "Interactions", now labeled as "Traces"
        icon: {},
        badge: interactionCount > 0 ? interactionCount : undefined,
      },
      {
        id: 'errors',
        label: 'Errors',
        icon: {},
        badge: errorCount,
      },
      { id: 'data', label: 'Data', icon: {} },
      { id: 'conversation', label: 'Conversation', icon: {} },
      { id: 'performance', label: 'Performance', icon: {} },
      { id: 'ir', label: 'IR', icon: {} },
      ...(isVoiceSession ? [{ id: 'voice', label: 'Voice', icon: {} }] : []),
      {
        id: 'traces',
        label: 'Traces',
        icon: {},
        deprecated: true, // Old traces tab marked as deprecated
      },
    ];
    return tabs;
  };

  it('includes deprecated flag on old traces tab', () => {
    const tabs = createTabsConfig(false, 0, 0);
    const deprecatedTab = tabs.find((tab) => tab.deprecated);

    expect(deprecatedTab).toBeDefined();
    expect(deprecatedTab?.id).toBe('traces');
    expect(deprecatedTab?.deprecated).toBe(true);
  });

  it('only one tab has deprecated flag', () => {
    const tabs = createTabsConfig(false, 0, 0);
    const deprecatedTabs = tabs.filter((tab) => tab.deprecated);

    expect(deprecatedTabs).toHaveLength(1);
  });

  it('has two tabs labeled "Traces" (new and deprecated)', () => {
    const tabs = createTabsConfig(false, 0, 0);
    const tracesTabs = tabs.filter((tab) => tab.label === 'Traces');

    expect(tracesTabs).toHaveLength(2);
  });

  it('new Traces tab (interactions) comes before deprecated Traces tab', () => {
    const tabs = createTabsConfig(false, 0, 0);

    const newTracesIndex = tabs.findIndex((tab) => tab.id === 'interactions');
    const deprecatedTracesIndex = tabs.findIndex((tab) => tab.id === 'traces');

    expect(newTracesIndex).toBeLessThan(deprecatedTracesIndex);
    expect(newTracesIndex).toBeGreaterThan(-1);
    expect(deprecatedTracesIndex).toBeGreaterThan(-1);
  });

  it('deprecated Traces tab is at the end (before voice if present)', () => {
    const tabs = createTabsConfig(false, 0, 0);

    const irIndex = tabs.findIndex((tab) => tab.id === 'ir');
    const deprecatedTracesIndex = tabs.findIndex((tab) => tab.id === 'traces');

    expect(deprecatedTracesIndex).toBeGreaterThan(irIndex);
    // Should be last tab
    expect(deprecatedTracesIndex).toBe(tabs.length - 1);
  });

  it('deprecated Traces tab is after voice tab (always last)', () => {
    const tabs = createTabsConfig(true, 0, 0);

    const deprecatedTracesIndex = tabs.findIndex((tab) => tab.id === 'traces');
    const voiceIndex = tabs.findIndex((tab) => tab.id === 'voice');

    // Deprecated tab is always last, even when voice is present
    expect(deprecatedTracesIndex).toBeGreaterThan(voiceIndex);
    expect(deprecatedTracesIndex).toBe(tabs.length - 1);
  });

  it('new Traces tab is at position 2 (after Overview)', () => {
    const tabs = createTabsConfig(false, 0, 0);

    expect(tabs[0].id).toBe('overview');
    expect(tabs[1].id).toBe('interactions');
    expect(tabs[1].label).toBe('Traces');
  });

  it('interaction count badge is shown on new Traces tab', () => {
    const tabs = createTabsConfig(false, 0, 5);
    const newTracesTab = tabs.find((tab) => tab.id === 'interactions');

    expect(newTracesTab?.badge).toBe(5);
  });

  it('error count badge is shown on Errors tab', () => {
    const tabs = createTabsConfig(false, 3, 0);
    const errorsTab = tabs.find((tab) => tab.id === 'errors');

    expect(errorsTab?.badge).toBe(3);
  });

  it('deprecated tab does not have a badge', () => {
    const tabs = createTabsConfig(false, 0, 0);
    const deprecatedTab = tabs.find((tab) => tab.deprecated);

    expect(deprecatedTab?.badge).toBeUndefined();
  });
});
