import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { DynamicForm } from '../../components/inbox/DynamicForm';

describe('DynamicForm', () => {
  const baseField = {
    name: 'code',
    type: 'text' as const,
    label: 'Code',
    required: true,
  };

  test('keeps client-side regex validation for safe patterns', () => {
    const onSubmit = vi.fn();

    render(
      <DynamicForm
        fields={[{ ...baseField, validation: { pattern: '^[a]+$' } }]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Enter code'), {
      target: { value: 'bbb' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Code does not match the required format')).toBeInTheDocument();
  });

  test('skips unsafe patterns and lets submission proceed', () => {
    const onSubmit = vi.fn();

    render(
      <DynamicForm
        fields={[{ ...baseField, validation: { pattern: '(a+)+$' } }]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Enter code'), {
      target: { value: 'bbb' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith({ code: 'bbb' });
    expect(screen.queryByText('Code does not match the required format')).not.toBeInTheDocument();
  });

  test('skips client regex evaluation for oversized inputs', () => {
    const onSubmit = vi.fn();
    const oversizedValue = 'b'.repeat(1001);

    render(
      <DynamicForm
        fields={[{ ...baseField, validation: { pattern: '^[a]+$' } }]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Enter code'), {
      target: { value: oversizedValue },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith({ code: oversizedValue });
    expect(screen.queryByText('Code does not match the required format')).not.toBeInTheDocument();
  });
});
