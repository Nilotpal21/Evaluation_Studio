import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockApiFetch = vi.fn();

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { SessionDetail } from '../../components/admin/SessionDetail';

describe('Admin SessionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('loads session metadata directly from the session detail endpoint', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: {
              id: 'sess-1',
              agentName: 'Booking_Agent',
              status: 'completed',
              channel: 'web_debug',
              estimatedCost: 0.02,
              messageCount: 3,
              errorCount: 1,
              createdAt: '2026-03-22T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            traces: [
              {
                id: 'trace-1',
                type: 'tool_call',
                timestamp: '2026-03-22T00:00:01.000Z',
                has_error: true,
                data: { tool: 'lookup_booking' },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    render(<SessionDetail sessionId="sess-1" projectId="proj-1" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1?projectId=proj-1&includeTraces=false',
      ),
    );
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/runtime/sessions?projectId=proj-1');

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/traces?projectId=proj-1&limit=200',
      ),
    );

    expect(await screen.findByText('Booking_Agent')).toBeInTheDocument();
  });
});
