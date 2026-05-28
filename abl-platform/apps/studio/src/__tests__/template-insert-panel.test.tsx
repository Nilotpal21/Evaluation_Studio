import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateInsertPanel } from '@/components/templates/TemplateInsertPanel';

describe('TemplateInsertPanel', () => {
  it('renders the slide-over with template categories and entries', () => {
    render(<TemplateInsertPanel open={true} onClose={vi.fn()} onInsert={vi.fn()} />);

    expect(screen.getByText('Insert Rich Template')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Markdown' })).toBeInTheDocument();
  });

  it('inserts the selected DSL snippet and closes the panel', () => {
    const onClose = vi.fn();
    const onInsert = vi.fn();

    render(<TemplateInsertPanel open={true} onClose={onClose} onInsert={onInsert} />);

    fireEvent.click(screen.getByRole('button', { name: 'Input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Actions' }));

    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining('ACTIONS:'));
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining('BUTTON: "Approve" -> approve'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables preview-only templates that cannot be authored in DSL yet', () => {
    render(<TemplateInsertPanel open={true} onClose={vi.fn()} onInsert={vi.fn()} />);

    const quickReplies = screen.getByRole('button', { name: 'Select Quick Replies' });
    expect(quickReplies).toBeDisabled();
    expect(
      screen.getAllByText('Preview only until ABL authoring support lands.').length,
    ).toBeGreaterThan(0);
  });
});
