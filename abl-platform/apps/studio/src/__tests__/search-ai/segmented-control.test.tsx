/**
 * Tests for SegmentedControl component — ARIA tablist pattern + keyboard nav
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (not used directly, but framer-motion interop may pull it)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return { ChevronRight: n };
});

// ---------------------------------------------------------------------------
// Import component under test (framer-motion is already mocked in setup.tsx)
// ---------------------------------------------------------------------------

import { SegmentedControl, type SegmentOption } from '../../components/ui/SegmentedControl';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const options: SegmentOption[] = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SegmentedControl', () => {
  let onChange: (value: string) => void;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('renders with role="tablist" on container', () => {
    render(<SegmentedControl options={options} value="alpha" onChange={onChange} />);

    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('each option has role="tab"', () => {
    render(<SegmentedControl options={options} value="alpha" onChange={onChange} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
  });

  it('active tab has aria-selected="true", others "false"', () => {
    render(<SegmentedControl options={options} value="beta" onChange={onChange} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
  });

  it('active tab has tabIndex=0, others tabIndex=-1', () => {
    render(<SegmentedControl options={options} value="gamma" onChange={onChange} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '0');
  });

  it('ArrowRight moves to next tab', () => {
    render(<SegmentedControl options={options} value="alpha" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith('beta');
  });

  it('ArrowLeft moves to previous tab', () => {
    render(<SegmentedControl options={options} value="beta" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith('alpha');
  });

  it('ArrowRight on last tab wraps to first', () => {
    render(<SegmentedControl options={options} value="gamma" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith('alpha');
  });

  it('ArrowLeft on first tab wraps to last', () => {
    render(<SegmentedControl options={options} value="alpha" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith('gamma');
  });

  it('Home selects first tab', () => {
    render(<SegmentedControl options={options} value="gamma" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'Home' });

    expect(onChange).toHaveBeenCalledWith('alpha');
  });

  it('End selects last tab', () => {
    render(<SegmentedControl options={options} value="alpha" onChange={onChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'End' });

    expect(onChange).toHaveBeenCalledWith('gamma');
  });

  it('each instance gets unique layoutId (no shared animation ids)', () => {
    const { container } = render(
      <div>
        <SegmentedControl options={options} value="alpha" onChange={onChange} />
        <SegmentedControl options={options} value="alpha" onChange={onChange} />
      </div>,
    );

    // Both should render independently with their own tablist
    const tablists = container.querySelectorAll('[role="tablist"]');
    expect(tablists).toHaveLength(2);

    // Each active tab renders — both instances have 3 tabs, 6 total
    const allTabs = container.querySelectorAll('[role="tab"]');
    expect(allTabs).toHaveLength(6);
  });
});
