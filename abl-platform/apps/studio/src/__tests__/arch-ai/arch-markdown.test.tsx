import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArchMarkdown } from '@/lib/arch-ai/components/arch/chat/ArchMarkdown';

describe('ArchMarkdown', () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders fenced json blocks with the shared copy affordance', () => {
    render(<ArchMarkdown content={'```json\n{\n  "project": "LeadQualBot"\n}\n```'} />);

    expect(screen.getByText('json')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy|common\.copy/i }));

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{\n  "project": "LeadQualBot"\n}',
    );
  });

  it('renders gfm tables inside a readable table shell', () => {
    render(
      <ArchMarkdown
        content={`| Field | Value |\n| --- | --- |\n| Project | LeadQualBot |\n| Channel | Web Chat |`}
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('LeadQualBot')).toBeInTheDocument();
  });

  it('keeps unsafe links as plain text', () => {
    render(
      <ArchMarkdown content={'[Docs](https://example.com/docs) and [Bad](javascript:alert(1))'} />,
    );

    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    );
    expect(screen.queryByRole('link', { name: /bad/i })).not.toBeInTheDocument();
    expect(screen.getByText('Bad')).toBeInTheDocument();
  });
});
