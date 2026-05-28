import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateCatalogPage } from '@/components/templates/TemplateCatalogPage';

describe('TemplateCatalogPage', () => {
  it('renders category tabs and support badges for fallback-backed templates', () => {
    render(<TemplateCatalogPage />);

    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Content' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Input' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Feedback' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select Slack Block Kit' }));

    expect(screen.getAllByText('Web: Fallback').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Preview: Fallback').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ABL: Insertable').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Hello from Slack/).length).toBeGreaterThan(0);
  });

  it('surfaces DSL authoring gaps separately from preview support', () => {
    render(<TemplateCatalogPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Select Quick Replies' }));
    expect(screen.getAllByText('ABL: Preview Only').length).toBeGreaterThan(0);
    expect(screen.getByText(/ABL authoring is not available yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select Actions' }));
    expect(screen.getAllByText('ABL: Partial').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/ABL snippet only covers the authorable subset available today/i),
    ).toBeInTheDocument();
  });

  it('shows JSON validation errors in the detail panel editor', () => {
    vi.useFakeTimers();
    render(<TemplateCatalogPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Select HTML' }));
    fireEvent.change(screen.getByLabelText('JSON Editor'), {
      target: { value: '{"html":' },
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
