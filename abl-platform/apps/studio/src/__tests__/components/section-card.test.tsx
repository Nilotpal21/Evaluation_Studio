/**
 * SectionCard Component Tests
 *
 * Tests for the collapsible card wrapper used by all agent detail sections.
 * Covers expand/collapse, Arch button, save status indicator, and empty state prompts.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionCard } from '../../components/agent-detail/SectionCard';

describe('SectionCard', () => {
  it('renders collapsed with title and summary', () => {
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={3}
        isExpanded={false}
        onToggle={() => {}}
        summary={<span>search, verify, cancel</span>}
      >
        <div>Editor content</div>
      </SectionCard>,
    );

    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('search, verify, cancel')).toBeInTheDocument();
    expect(screen.queryByText('Editor content')).not.toBeInTheDocument();
  });

  it('renders expanded with children', () => {
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={3}
        isExpanded={true}
        onToggle={() => {}}
        summary={<span>search, verify, cancel</span>}
      >
        <div>Editor content</div>
      </SectionCard>,
    );

    expect(screen.getByText('Editor content')).toBeInTheDocument();
  });

  it('calls onToggle when header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <SectionCard
        title="Rules"
        sectionId="RULES"
        count={2}
        isExpanded={false}
        onToggle={onToggle}
        summary={<span>2 constraints</span>}
      >
        <div>Rules editor</div>
      </SectionCard>,
    );

    fireEvent.click(screen.getByText('Rules'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('calls onArchClick when arch button is clicked', () => {
    const onArchClick = vi.fn();
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={1}
        isExpanded={false}
        onToggle={() => {}}
        onArchClick={onArchClick}
        summary={<span>search</span>}
      >
        <div>content</div>
      </SectionCard>,
    );

    const archButton = screen.getByLabelText('Ask Arch about Tools');
    fireEvent.click(archButton);
    expect(onArchClick).toHaveBeenCalled();
  });

  it('shows save status when expanded', () => {
    render(
      <SectionCard
        title="Identity"
        sectionId="IDENTITY"
        isExpanded={true}
        onToggle={() => {}}
        saveStatus="saved"
      >
        <div>Editor</div>
      </SectionCard>,
    );

    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('renders empty state when isEmpty is true', () => {
    render(
      <SectionCard
        title="Rules"
        sectionId="RULES"
        isEmpty={true}
        isExpanded={false}
        onToggle={() => {}}
        onArchClick={() => {}}
      >
        <div>Editor</div>
      </SectionCard>,
    );

    expect(screen.getByText(/No rules defined/i)).toBeInTheDocument();
    expect(screen.getByText(/Ask Arch to suggest/i)).toBeInTheDocument();
  });
});
