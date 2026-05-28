/**
 * @vitest-environment happy-dom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigField } from '@agent-platform/pipeline-engine';
import { ConfigSchemaForm } from '../ConfigSchemaForm';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: undefined,
    error: undefined,
    isLoading: false,
  })),
}));

const qualityDimensionFields: ConfigField[] = [
  {
    name: 'dimensions',
    type: 'array',
    required: false,
    description: 'Custom evaluation dimensions. Empty uses platform defaults.',
    items: {
      type: 'object',
      properties: {
        name: {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Dimension identifier',
        },
        displayName: {
          name: 'displayName',
          type: 'string',
          required: true,
          description: 'UI label',
        },
        description: {
          name: 'description',
          type: 'string',
          required: true,
          description: 'What this dimension measures',
        },
        scale: {
          name: 'scale',
          type: 'object',
          required: true,
          description: 'Score range',
          items: {
            type: 'object',
            properties: {
              min: {
                name: 'min',
                type: 'number',
                required: true,
                description: 'Minimum score',
              },
              max: {
                name: 'max',
                type: 'number',
                required: true,
                description: 'Maximum score',
              },
            },
          },
        },
        weight: {
          name: 'weight',
          type: 'number',
          required: true,
          description: 'Relative weight in aggregate score',
        },
        criteria: {
          name: 'criteria',
          type: 'array',
          required: false,
          description: 'Scoring criteria',
          items: {
            name: 'criterion',
            type: 'string',
            required: true,
            description: 'A criterion',
          },
        },
      },
    },
  },
];

describe('ConfigSchemaForm quality dimension scale editor', () => {
  it('renders scale objects as editable min/max inputs', () => {
    const onChange = vi.fn();

    render(
      <ConfigSchemaForm
        fields={qualityDimensionFields}
        values={{
          dimensions: [
            {
              name: 'helpfulness',
              displayName: 'Helpfulness',
              description: 'Did the agent help?',
              scale: { min: 1, max: 5 },
              weight: 0.3,
              criteria: ['Customer need was addressed'],
            },
          ],
        }}
        onChange={onChange}
      />,
    );

    expect(screen.queryByDisplayValue('[object Object]')).not.toBeInTheDocument();
    expect(screen.getByText('Scale')).toBeInTheDocument();
    expect(screen.getByText('Min')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '10' } });

    expect(onChange).toHaveBeenCalledWith('dimensions', [
      expect.objectContaining({
        scale: { min: 1, max: 10 },
      }),
    ]);
  });

  it('defaults new quality dimension scale to the backend 1-5 range', () => {
    const onChange = vi.fn();

    render(
      <ConfigSchemaForm
        fields={qualityDimensionFields}
        values={{ dimensions: [] }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add entry/i }));

    expect(onChange).toHaveBeenCalledWith('dimensions', [
      expect.objectContaining({
        scale: { min: 1, max: 5 },
      }),
    ]);
  });

  it('normalizes legacy scalar scale values before editing', () => {
    const onChange = vi.fn();

    render(
      <ConfigSchemaForm
        fields={qualityDimensionFields}
        values={{
          dimensions: [
            {
              name: 'custom',
              displayName: 'Custom',
              description: 'Custom rubric',
              scale: '7',
              weight: 1,
              criteria: [],
            },
          ],
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByDisplayValue('1').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('7')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '10' } });

    expect(onChange).toHaveBeenCalledWith('dimensions', [
      expect.objectContaining({
        scale: { min: 1, max: 10 },
      }),
    ]);
  });
});
