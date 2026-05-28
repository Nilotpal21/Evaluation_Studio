/**
 * TriggerManager Component Tests
 *
 * Locks in the sampling-rate unit contract: props/callbacks use a fraction
 * in [0, 1]; the slider UI converts to/from whole percent (0–100).
 * The backend schema (pipeline-engine's PipelineConfig) validates
 * `samplingRate` as a fraction in [0, 1], so regressing this boundary
 * breaks every save with a non-zero rate.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TriggerEntry } from '@agent-platform/pipeline-engine';
import { TriggerManager } from '../TriggerManager';

function makeTrigger(overrides: Partial<TriggerEntry> = {}): TriggerEntry {
  return {
    id: 'batch',
    type: 'kafka',
    strategy: 'batch',
    label: 'Batch',
    description: 'Batch trigger',
    kafkaTopic: 'events.batch',
    ...overrides,
  };
}

describe('TriggerManager sampling rate', () => {
  test('displays stored fraction as whole percent', () => {
    const trigger = makeTrigger();
    render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{ batch: { samplingRate: 0.5 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={vi.fn()}
      />,
    );

    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('50');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  test('defaults to 100% when no per-trigger rate is configured', () => {
    const trigger = makeTrigger();
    render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{}}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('slider')).toHaveValue('100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  test('emits fraction (not percent) when user drags the slider', () => {
    const onSamplingRateChange = vi.fn();
    const trigger = makeTrigger();
    render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{ batch: { samplingRate: 0.5 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={onSamplingRateChange}
      />,
    );

    fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } });

    expect(onSamplingRateChange).toHaveBeenCalledWith('batch', 0.75);
  });

  test('renders boundary fractions (0 and 1) as 0% and 100%', () => {
    const trigger = makeTrigger();
    const { rerender } = render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{ batch: { samplingRate: 0 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('slider')).toHaveValue('0');
    expect(screen.getByText('0%')).toBeInTheDocument();

    rerender(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{ batch: { samplingRate: 1 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('slider')).toHaveValue('100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  test('emits boundary fractions 0 and 1 when slider is moved to extremes', () => {
    const onSamplingRateChange = vi.fn();
    const trigger = makeTrigger();
    render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={['batch']}
        triggerConfigs={{ batch: { samplingRate: 0.5 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={onSamplingRateChange}
      />,
    );

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(onSamplingRateChange).toHaveBeenLastCalledWith('batch', 0);

    fireEvent.change(slider, { target: { value: '100' } });
    expect(onSamplingRateChange).toHaveBeenLastCalledWith('batch', 1);
  });

  test('hides sampling slider when trigger is inactive', () => {
    const trigger = makeTrigger();
    render(
      <TriggerManager
        triggers={[trigger]}
        activeTriggerIds={[]}
        triggerConfigs={{ batch: { samplingRate: 0.5 } }}
        onToggleTrigger={vi.fn()}
        onSamplingRateChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});
