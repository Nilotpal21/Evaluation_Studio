/**
 * TemplateTypeBadge Component Tests
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TemplateTypeBadge } from '../../../components/marketplace/TemplateTypeBadge';

describe('TemplateTypeBadge', () => {
  it('renders correct label for agent type', () => {
    render(<TemplateTypeBadge type="agent" />);
    expect(screen.getByText('Agent')).toBeTruthy();
  });

  it('renders correct label for project type', () => {
    render(<TemplateTypeBadge type="project" />);
    expect(screen.getByText('Project')).toBeTruthy();
  });

  it('renders raw type string for unknown type', () => {
    render(<TemplateTypeBadge type="workflow" />);
    expect(screen.getByText('workflow')).toBeTruthy();
  });

  it('accepts size prop', () => {
    const { container } = render(<TemplateTypeBadge type="agent" size="md" />);
    expect(container.firstElementChild).toBeTruthy();
  });
});
