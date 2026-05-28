import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GoogleS2SFields } from '../../components/deployments/channels/GoogleS2SFields';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    ({
      vad_title: 'Voice Activity Detection',
      vad_description:
        'Controls when Gemini starts listening to a caller turn and how long it waits before closing that turn.',
      start_sensitivity_help:
        'Higher detects speech sooner but may trigger on noise. Lower waits for a stronger speech signal.',
      end_sensitivity_help:
        'Higher ends turns sooner for lower latency. Lower allows longer pauses before Gemini responds.',
      silence_duration_help:
        'Milliseconds of non-speech before Gemini closes the caller turn. Increase to allow pauses; decrease for faster responses.',
      prefix_padding_help:
        'Milliseconds of detected speech required before Gemini commits a speech start. Lower values catch shorter utterances but can increase false starts.',
    })[key] ?? key,
}));

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

describe('GoogleS2SFields', () => {
  test('preserves zero temperature as a valid Gemini realtime value', () => {
    render(<GoogleS2SFields config={{ s2sTemperature: 0 }} onChange={vi.fn()} />);

    expect(screen.getByRole('slider', { name: /temperature/i })).toHaveValue('0');
    expect(screen.getByText('Temperature: 0')).toBeInTheDocument();
  });

  test('prefills Gemini activity detection timing with recommended values', () => {
    render(<GoogleS2SFields config={{}} onChange={vi.fn()} />);

    expect(screen.getByLabelText(/silence duration/i)).toHaveValue(100);
    expect(screen.getByLabelText(/prefix padding/i)).toHaveValue(20);
  });

  test('exposes Gemini Live automatic activity detection controls', () => {
    const onChange = vi.fn();

    render(
      <GoogleS2SFields
        config={{
          s2sStartSensitivity: 'START_SENSITIVITY_LOW',
          s2sEndSensitivity: 'END_SENSITIVITY_HIGH',
          s2sSilenceDuration: 900,
          s2sPrefixPadding: 250,
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText(/start sensitivity/i)).toHaveValue('START_SENSITIVITY_LOW');
    expect(screen.getByLabelText(/end sensitivity/i)).toHaveValue('END_SENSITIVITY_HIGH');
    expect(screen.getByLabelText(/silence duration/i)).toHaveValue(900);
    expect(screen.getByLabelText(/prefix padding/i)).toHaveValue(250);
    expect(screen.getByText(/trigger on noise/i)).toBeInTheDocument();
    expect(screen.getByText(/lower latency/i)).toBeInTheDocument();
    expect(screen.getByText(/increase to allow pauses/i)).toBeInTheDocument();
    expect(screen.getByText(/catch shorter utterances/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/start sensitivity/i), {
      target: { value: 'START_SENSITIVITY_HIGH' },
    });
    fireEvent.change(screen.getByLabelText(/end sensitivity/i), {
      target: { value: 'END_SENSITIVITY_LOW' },
    });

    expect(onChange).toHaveBeenCalledWith('s2sStartSensitivity', 'START_SENSITIVITY_HIGH');
    expect(onChange).toHaveBeenCalledWith('s2sEndSensitivity', 'END_SENSITIVITY_LOW');
  });
});
