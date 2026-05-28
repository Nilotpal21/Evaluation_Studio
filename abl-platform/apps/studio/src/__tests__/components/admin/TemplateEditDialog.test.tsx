/**
 * TemplateEditDialog Component Tests
 *
 * Tests the edit dialog: pre-populated form fields, save/cancel buttons,
 * and loading state during save.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateEditDialog } from '../../../components/admin/TemplateEditDialog';

describe('TemplateEditDialog', () => {
  const template = {
    id: 't1',
    name: 'My Template',
    type: 'project',
    category: 'sales',
    status: 'draft',
    downloads: 10,
    createdAt: '2026-03-01T00:00:00Z',
    shortDescription: 'A short desc',
    longDescription: 'A longer description here',
    tags: ['ai', 'sales'],
    complexity: 'standard',
  };

  it('renders edit form with pre-populated fields', () => {
    render(
      <TemplateEditDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} template={template} />,
    );

    // Dialog title
    expect(screen.getByText('Edit Template')).toBeTruthy();
    // Description
    expect(screen.getByText('Update the template metadata below')).toBeTruthy();

    // Check that the name input is pre-populated
    const nameInput = document.querySelector('input');
    expect(nameInput).toBeTruthy();
    expect(nameInput?.value).toBe('My Template');
  });

  it('shows save and cancel buttons', () => {
    render(
      <TemplateEditDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} template={template} />,
    );

    expect(screen.getByText('Save Changes')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('calls onClose when cancel clicked', () => {
    const onClose = vi.fn();

    render(
      <TemplateEditDialog open={true} onClose={onClose} onSuccess={vi.fn()} template={template} />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has save button disabled when name is empty', () => {
    const emptyNameTemplate = { ...template, name: '' };

    render(
      <TemplateEditDialog
        open={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        template={emptyNameTemplate}
      />,
    );

    const saveButton = screen.getByText('Save Changes');
    expect(saveButton.closest('button')?.getAttribute('disabled')).not.toBeNull();
  });

  it('renders category and complexity selects', () => {
    render(
      <TemplateEditDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} template={template} />,
    );

    // The labels for the Select dropdowns
    expect(screen.getByText('Category')).toBeTruthy();
    expect(screen.getByText('Complexity')).toBeTruthy();
    expect(screen.getByText('Tags')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
  });
});
