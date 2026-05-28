import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OpenAIS2SFields } from '../../components/deployments/channels/OpenAIS2SFields';
import { normalizeOpenAIRealtimeTemperature } from '../../components/deployments/channels/openai-realtime-temperature';

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

describe('OpenAIS2SFields', () => {
  test('normalizes provider-switch temperatures into the OpenAI supported range', () => {
    expect(normalizeOpenAIRealtimeTemperature(0.1)).toBe(0.6);
    expect(normalizeOpenAIRealtimeTemperature(1.8)).toBe(1.2);
    expect(normalizeOpenAIRealtimeTemperature(undefined)).toBe(0.8);
  });

  test('uses the OpenAI Realtime temperature bounds', () => {
    render(<OpenAIS2SFields config={{ s2sTemperature: 0.8 }} onChange={vi.fn()} />);

    const slider = screen.getByRole('slider', { name: /temperature/i });

    expect(slider).toHaveAttribute('min', '0.6');
    expect(slider).toHaveAttribute('max', '1.2');
    expect(slider).toHaveValue('0.8');
    expect(screen.getByText('Focused (0.6)')).toBeInTheDocument();
    expect(screen.getByText('Creative (1.2)')).toBeInTheDocument();
  });

  test('does not offer unsupported manual turn detection', () => {
    render(<OpenAIS2SFields config={{ s2sTemperature: 0.8 }} onChange={vi.fn()} />);

    expect(screen.queryByLabelText(/turn detection/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /none/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('slider', { name: /speech detection sensitivity/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/silence duration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/prefix padding/i)).toBeInTheDocument();
  });

  test('preserves explicit zero VAD numeric values from stored config', () => {
    render(
      <OpenAIS2SFields
        config={{
          s2sTemperature: 0.8,
          s2sThreshold: 0,
          s2sSilenceDuration: 0,
          s2sPrefixPadding: 0,
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('slider', { name: /speech detection sensitivity/i })).toHaveValue('0');
    expect(screen.getByLabelText(/silence duration/i)).toHaveValue(0);
    expect(screen.getByLabelText(/prefix padding/i)).toHaveValue(0);
  });

  test('shows concise VAD guidance and updates threshold config', () => {
    const onChange = vi.fn();

    render(<OpenAIS2SFields config={{ s2sTemperature: 0.8 }} onChange={onChange} />);

    expect(screen.getByText(/lower values pick up quieter speech/i)).toBeInTheDocument();
    expect(
      screen.getByText(/quiet time before openai treats the caller turn/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/audio kept before detected speech/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: /speech detection sensitivity/i }), {
      target: { value: '0.75' },
    });

    expect(onChange).toHaveBeenCalledWith('s2sThreshold', 0.75);
  });

  test('normalizes previously saved temperatures below the OpenAI minimum', async () => {
    const onChange = vi.fn();

    render(<OpenAIS2SFields config={{ s2sTemperature: 0.1 }} onChange={onChange} />);

    expect(screen.getByRole('slider', { name: /temperature/i })).toHaveValue('0.6');
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('s2sTemperature', 0.6);
    });
  });
});
