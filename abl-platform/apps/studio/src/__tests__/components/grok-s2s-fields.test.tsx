import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GrokS2SFields } from '../../components/deployments/channels/GrokS2SFields';

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, options, value, onChange }: any) => (
    <label>
      {label}
      <select
        value={value}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock('../../components/ui/Input', () => ({
  Input: ({ label, ...props }: any) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
}));

describe('GrokS2SFields', () => {
  test('does not offer unsupported manual turn detection', () => {
    render(<GrokS2SFields config={{ s2sTemperature: 1 }} onChange={vi.fn()} />);

    expect(screen.queryByLabelText(/turn detection/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /none/i })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /threshold/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/silence duration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/prefix padding/i)).toBeInTheDocument();
  });

  test('preserves explicit zero VAD numeric values from stored config', () => {
    render(
      <GrokS2SFields
        config={{
          s2sTemperature: 1,
          s2sThreshold: 0,
          s2sSilenceDuration: 0,
          s2sPrefixPadding: 0,
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('slider', { name: /threshold/i })).toHaveValue('0');
    expect(screen.getByText('Threshold: 0')).toBeInTheDocument();
    expect(screen.getByLabelText(/silence duration/i)).toHaveValue(0);
    expect(screen.getByLabelText(/prefix padding/i)).toHaveValue(0);
  });
});
