import { describe, it, expect } from 'vitest';
import type { ArtifactTab } from '@/lib/arch-ai/store/arch-ai-store';

// Import the helper we're about to write — will fail until Task 2b.
import { ensureJournalFirst } from '@/lib/arch-ai/store/arch-ai-store';

function makeTab(type: ArtifactTab['type'], id: string): ArtifactTab {
  return { id, type, label: type, data: null, version: 1, toolCallId: '' };
}

describe('ensureJournalFirst', () => {
  it('returns empty array unchanged', () => {
    expect(ensureJournalFirst([])).toEqual([]);
  });

  it('returns array unchanged when journal is already first', () => {
    const tabs = [makeTab('journal', 'j1'), makeTab('plan', 'p1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('journal');
    expect(result).toHaveLength(2);
  });

  it('moves journal to front when it is not first', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('journal', 'j1'), makeTab('health', 'h1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('journal');
    expect(result[0].id).toBe('j1');
    expect(result).toHaveLength(3);
  });

  it('does not create a journal tab if none exists', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('health', 'h1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('plan');
    expect(result.some((t) => t.type === 'journal')).toBe(false);
  });

  it('is idempotent — calling twice gives same result', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('journal', 'j1')];
    expect(ensureJournalFirst(ensureJournalFirst(tabs))).toEqual(ensureJournalFirst(tabs));
  });
});
