import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalPanel } from '@/lib/arch-ai/components/arch/panels/JournalPanel';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

describe('JournalPanel', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the v4 project-scoped journal endpoint inside project mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          entries: [
            {
              type: 'decision',
              phase: 'IN_PROJECT',
              content: {
                summary: 'Keep deterministic tool routing',
                rationale: 'Preserves stable multi-turn behavior.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    render(<JournalPanel sessionId="sess-9" projectId="proj-9" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/arch-ai/projects/proj-9/journal',
        expect.any(Object),
      );
    });

    expect(screen.getByText('IN_PROJECT')).toBeInTheDocument();
    expect(screen.getByText('Keep deterministic tool routing')).toBeInTheDocument();
  });
});
