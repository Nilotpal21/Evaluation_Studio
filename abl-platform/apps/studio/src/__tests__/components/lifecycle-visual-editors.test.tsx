import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CompletionEditor } from '../../components/agent-editor/sections/CompletionEditor';
import { ErrorHandlingEditor } from '../../components/agent-editor/sections/ErrorHandlingEditor';
import type { CompletionConditionData, ErrorHandlerData } from '../../store/agent-detail-store';

describe('lifecycle visual editors', () => {
  it('preserves hidden completion metadata when editing visible fields', () => {
    const hiddenCompletion: CompletionConditionData = {
      when: 'task_complete == true',
      respond: '',
      voiceConfig: { plain_text: 'Done by voice' },
      richContent: { markdown: '### Done card' },
      actions: {
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      },
      store: '{reservation_id} -> user.completed_reservations',
    };
    const onChange = vi.fn();

    render(<CompletionEditor data={[hiddenCompletion]} onChange={onChange} readOnly={false} />);

    fireEvent.change(screen.getByDisplayValue('task_complete == true'), {
      target: { value: 'task_complete == true && customer_confirmed == true' },
    });

    expect(onChange).toHaveBeenCalledWith([
      {
        ...hiddenCompletion,
        when: 'task_complete == true && customer_confirmed == true',
      },
    ]);
  });

  it('treats completion removal as intentional deletion while preserving siblings', () => {
    const firstCompletion: CompletionConditionData = {
      when: 'first_done == true',
      respond: 'First done',
      actions: {
        elements: [{ id: 'first', type: 'button', label: 'First' }],
      },
    };
    const secondCompletion: CompletionConditionData = {
      when: 'second_done == true',
      respond: '',
      richContent: { markdown: '### Second card' },
      store: '{second_id} -> user.completed_reservations',
    };
    const onChange = vi.fn();

    render(
      <CompletionEditor
        data={[firstCompletion, secondCompletion]}
        onChange={onChange}
        readOnly={false}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('Remove condition')[0]);

    expect(onChange).toHaveBeenCalledWith([secondCompletion]);
  });

  it('preserves hidden error-handler metadata when editing visible fields', () => {
    const hiddenHandler: ErrorHandlerData = {
      type: 'tool_timeout',
      subtypes: ['transient'],
      respond: '',
      then: 'continue',
      retry: 2,
      retryDelayMs: 2500,
      retryBackoff: 'exponential',
      retryMaxDelayMs: 10000,
      backtrackTo: 'collect_info',
      voiceConfig: { plain_text: 'Retry by voice' },
      richContent: { markdown: '### Retry card' },
      actions: {
        elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
      },
    };
    const onChange = vi.fn();

    render(<ErrorHandlingEditor data={[hiddenHandler]} onChange={onChange} readOnly={false} />);

    fireEvent.change(screen.getByDisplayValue('tool_timeout'), {
      target: { value: 'tool_timeout_transient' },
    });

    expect(onChange).toHaveBeenCalledWith([
      {
        ...hiddenHandler,
        type: 'tool_timeout_transient',
      },
    ]);
  });

  it('treats error-handler removal as intentional deletion while preserving siblings', () => {
    const firstHandler: ErrorHandlerData = {
      type: 'tool_timeout',
      respond: 'Retry',
      then: 'continue',
      actions: {
        elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
      },
    };
    const secondHandler: ErrorHandlerData = {
      type: 'DEFAULT',
      respond: '',
      then: 'continue',
      voiceConfig: { plain_text: 'Default voice fallback' },
      richContent: { markdown: '### Default fallback' },
    };
    const onChange = vi.fn();

    render(
      <ErrorHandlingEditor
        data={[firstHandler, secondHandler]}
        onChange={onChange}
        readOnly={false}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('Remove handler')[0]);

    expect(onChange).toHaveBeenCalledWith([secondHandler]);
  });
});
