import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasPIIRedactionMarker, PIIRevealControls } from '@/components/session/PIIRevealControls';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  apiFetch: mockApiFetch,
}));

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

const baseProps = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  messageId: 'msg-1',
  messageContent: 'Card: [REDACTED_CARD]',
};

describe('PIIRevealControls', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('does not render reveal affordance without exact reveal permission', () => {
    render(<PIIRevealControls {...baseProps} canRevealPII={false} />);

    expect(screen.queryByRole('button', { name: 'Reveal PII' })).not.toBeInTheDocument();
  });

  it('does not render reveal affordance when the message has no redaction marker', () => {
    render(
      <PIIRevealControls
        {...baseProps}
        messageContent="This message has no redacted values."
        canRevealPII
      />,
    );

    expect(screen.queryByRole('button', { name: 'Reveal PII' })).not.toBeInTheDocument();
  });

  it('detects future custom tokenized PII markers', () => {
    const messageContent =
      'Contract {{PII:custom_contract-id_contract-pattern:33333333-3333-4333-8333-333333333333}}';

    expect(hasPIIRedactionMarker(messageContent)).toBe(true);

    render(<PIIRevealControls {...baseProps} messageContent={messageContent} canRevealPII />);

    expect(screen.getByRole('button', { name: 'Reveal PII' })).toBeInTheDocument();
  });

  it('requires a reason before submitting reveal', () => {
    render(<PIIRevealControls {...baseProps} canRevealPII />);

    fireEvent.click(screen.getByRole('button', { name: 'Reveal PII' }));

    expect(screen.getByRole('button', { name: 'Reveal' })).toBeDisabled();
  });

  it('submits a message-scoped reveal request and displays returned values ephemerally', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        revealed: [
          {
            tokenId: 'token-1',
            token: '{{PII:credit_card:token-1}}',
            piiType: 'credit_card',
            patternName: 'credit_card',
            value: '4111 1111 1111 1111',
          },
        ],
        unavailable: [],
      }),
    );

    render(<PIIRevealControls {...baseProps} canRevealPII />);

    fireEvent.click(screen.getByRole('button', { name: 'Reveal PII' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Compliance review' },
    });
    fireEvent.change(screen.getByLabelText('Ticket or case ID'), {
      target: { value: 'ABLP-535' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/pii/reveal?projectId=proj-1',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            reason: 'Compliance review',
            ticketId: 'ABLP-535',
            sourceRefs: [{ sourceMessageId: 'msg-1' }],
          }),
        }),
      ),
    );
    expect(await screen.findByText('4111 1111 1111 1111')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('4111 1111 1111 1111')).not.toBeInTheDocument());
  });

  it('clears revealed values when the selected session changes', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        revealed: [
          {
            tokenId: 'token-1',
            token: '{{PII:email:token-1}}',
            piiType: 'email',
            patternName: 'email',
            value: 'person@example.com',
          },
        ],
        unavailable: [],
      }),
    );

    const { rerender } = render(<PIIRevealControls {...baseProps} canRevealPII />);

    fireEvent.click(screen.getByRole('button', { name: 'Reveal PII' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Compliance review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));

    expect(await screen.findByText('person@example.com')).toBeInTheDocument();

    rerender(<PIIRevealControls {...baseProps} sessionId="sess-2" canRevealPII />);

    await waitFor(() => expect(screen.queryByText('person@example.com')).not.toBeInTheDocument());
  });

  it('shows not available state without exposing raw data when no token can be revealed', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        revealed: [],
        unavailable: [{ tokenId: 'token-1', status: 'expired' }],
      }),
    );

    render(<PIIRevealControls {...baseProps} canRevealPII />);

    fireEvent.click(screen.getByRole('button', { name: 'Reveal PII' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Compliance review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));

    expect(await screen.findByText('Not available for reveal')).toBeInTheDocument();
    expect(screen.queryByText('4111 1111 1111 1111')).not.toBeInTheDocument();
  });
});
