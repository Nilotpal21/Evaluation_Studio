import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { copyRichTextFromRenderedMessageMock } = vi.hoisted(() => ({
  copyRichTextFromRenderedMessageMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/arch-ai/components/arch/chat/message-copy', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/arch-ai/components/arch/chat/message-copy')
  >('@/lib/arch-ai/components/arch/chat/message-copy');

  return {
    ...actual,
    copyRichTextFromRenderedMessage: copyRichTextFromRenderedMessageMock,
  };
});

import { ArchAssistantResponse } from '@/lib/arch-ai/components/arch/chat/ArchAssistantResponse';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe('ArchAssistantResponse copy menu', () => {
  beforeEach(() => {
    copyRichTextFromRenderedMessageMock.mockReset();
    copyRichTextFromRenderedMessageMock.mockResolvedValue(undefined);

    vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: MockResizeObserver,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows copied feedback after markdown copy is selected', async () => {
    const user = userEvent.setup();

    render(
      <ArchAssistantResponse
        message={{ content: '## Pattern\n\n- Route intent\n- Hand off to specialists' }}
        defaultExpanded={false}
      />,
    );

    await user.click(screen.getByLabelText('Copy message'));
    await user.click(screen.getByText('Copy as Markdown'));

    await waitFor(() =>
      expect(screen.getByLabelText('Copy message')).toHaveAttribute('title', 'Copied markdown'),
    );
  });

  it('delegates rich-text copy through the shared helper and shows feedback', async () => {
    const user = userEvent.setup();

    render(
      <ArchAssistantResponse
        message={{
          content:
            '## Pattern\n\n| Field | Value |\n| --- | --- |\n| Project | LeadQualBot |\n\n```json\n{\n  "channel": "web"\n}\n```',
        }}
        defaultExpanded={false}
      />,
    );

    await user.click(screen.getByLabelText('Copy message'));
    await user.click(screen.getByText('Copy as Rich Text'));

    await waitFor(() => expect(copyRichTextFromRenderedMessageMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByLabelText('Copy message')).toHaveAttribute('title', 'Copied rich text'),
    );
  });

  it('shows a subtle loading skeleton before the first streamed token arrives', () => {
    const { container } = render(
      <ArchAssistantResponse
        message={{
          content: '',
          isStreaming: true,
          specialist: { name: 'Builder', icon: 'code' },
        }}
        defaultExpanded={false}
      />,
    );

    expect(screen.getByRole('status', { name: 'Arch is responding' })).toBeInTheDocument();
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(screen.queryByLabelText('Copy message')).not.toBeInTheDocument();
  });
});
