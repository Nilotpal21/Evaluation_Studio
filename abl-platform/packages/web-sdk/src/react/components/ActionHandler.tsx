'use client';

/**
 * ActionHandler — Renders buttons, selects, and inputs from an ActionSet.
 */

import React, { useState } from 'react';
import type { ActionSet, ActionElement, ActionSubmitOptions } from '../../core/types.js';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

interface ActionHandlerProps {
  /** Set of interactive actions to render */
  actions: ActionSet;
  /** Callback when an action is triggered */
  onAction: (actionId: string, value?: string, options?: ActionSubmitOptions) => void;
}

function emitAction(
  onAction: (id: string, value?: string, options?: ActionSubmitOptions) => void,
  id: string,
  value?: string,
  renderId?: string,
): void {
  if (renderId) {
    onAction(id, value, { renderId });
  } else {
    onAction(id, value);
  }
}

function buildSubmitOptions(
  renderId: string | undefined,
  formData?: Record<string, unknown>,
): ActionSubmitOptions | undefined {
  const options = {
    ...(renderId ? { renderId } : {}),
    ...(formData ? { formData } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function validateActionInputs(container: HTMLElement): boolean {
  const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-action-id], select[data-action-id]',
  );

  for (const control of controls) {
    if (!control.checkValidity()) {
      control.reportValidity();
      return false;
    }
  }

  return true;
}

function collectActionValues(container: HTMLElement): Record<string, string> {
  const formData: Record<string, string> = {};
  const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-action-id], select[data-action-id]',
  );

  for (const control of controls) {
    const actionId = control.getAttribute('data-action-id');
    if (actionId) {
      formData[actionId] = control.value;
    }
  }

  return formData;
}

function ActionButton({
  element,
  onAction,
  renderId,
}: {
  element: ActionElement;
  onAction: (id: string, value?: string, options?: ActionSubmitOptions) => void;
  renderId?: string;
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      style: styles.actionButton,
      onClick: () => emitAction(onAction, element.id, element.value, renderId),
      title: element.description,
    },
    element.label,
  );
}

function ActionSelect({
  element,
  onAction,
  renderId,
  deferToSubmit,
}: {
  element: ActionElement;
  onAction: (id: string, value?: string, options?: ActionSubmitOptions) => void;
  renderId?: string;
  deferToSubmit: boolean;
}): React.ReactElement {
  return React.createElement(
    'select',
    {
      style: styles.actionSelect,
      'data-action-id': element.id,
      required: element.required,
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
        deferToSubmit ? undefined : emitAction(onAction, element.id, e.target.value, renderId),
      defaultValue: '',
      'aria-label': element.label,
    },
    React.createElement('option', { value: '', disabled: true }, element.label),
    ...(element.options ?? []).map((opt) =>
      React.createElement('option', { key: opt.id, value: opt.id }, opt.label),
    ),
  );
}

function ActionInput({
  element,
  onAction,
  renderId,
  deferToSubmit,
}: {
  element: ActionElement;
  onAction: (id: string, value?: string, options?: ActionSubmitOptions) => void;
  renderId?: string;
  deferToSubmit: boolean;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const strings = useStrings();

  return React.createElement(
    'div',
    { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
    React.createElement('input', {
      type: element.input_type ?? 'text',
      style: styles.actionInput,
      placeholder: element.placeholder ?? element.label,
      value,
      required: element.required,
      'data-action-id': element.id,
      'aria-label': element.label,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (!deferToSubmit && e.key === 'Enter' && value.trim()) {
          emitAction(onAction, element.id, value, renderId);
        }
      },
    }),
    deferToSubmit
      ? null
      : React.createElement(
          'button',
          {
            type: 'button',
            style: styles.actionButton,
            onClick: () => {
              if (value.trim()) {
                emitAction(onAction, element.id, value, renderId);
              }
            },
          },
          strings.actionSubmit,
        ),
  );
}

export function ActionHandler({
  actions,
  onAction,
}: ActionHandlerProps): React.ReactElement | null {
  if (!actions.elements || actions.elements.length === 0) return null;
  const deferToSubmit = Boolean(actions.submit_id);
  const submitId = actions.submit_id;

  return React.createElement(
    'div',
    { style: styles.actionContainer, 'data-testid': 'action-handler' },
    ...actions.elements.map((el) => {
      switch (el.type) {
        case 'button':
          return React.createElement(ActionButton, {
            key: el.id,
            element: el,
            onAction,
            renderId: actions.renderId,
          });
        case 'select':
          return React.createElement(ActionSelect, {
            key: el.id,
            element: el,
            onAction,
            renderId: actions.renderId,
            deferToSubmit,
          });
        case 'input':
          return React.createElement(ActionInput, {
            key: el.id,
            element: el,
            onAction,
            renderId: actions.renderId,
            deferToSubmit,
          });
        default:
          return null;
      }
    }),
    submitId && actions.submit_label
      ? React.createElement(
          'button',
          {
            key: 'submit',
            type: 'button',
            style: styles.actionButton,
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              const container = event.currentTarget.closest('[data-testid="action-handler"]');
              if (!(container instanceof HTMLElement)) return;
              if (!validateActionInputs(container)) return;
              const formData = collectActionValues(container);
              const options = buildSubmitOptions(actions.renderId, formData);
              if (options) {
                onAction(submitId, JSON.stringify(formData), options);
              } else {
                onAction(submitId, JSON.stringify(formData));
              }
            },
          },
          actions.submit_label,
        )
      : null,
  );
}
