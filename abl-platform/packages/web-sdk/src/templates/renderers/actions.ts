/**
 * Actions Template Renderer
 *
 * Renders interactive ActionSet elements (buttons, selects, inputs).
 * Migrated from rich-renderer.ts to the pluggable template system.
 */

import React from 'react';
import type { Message, ActionSet, ActionElement } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';

// ---------------------------------------------------------------------------
// React renderer helpers
// ---------------------------------------------------------------------------

function buildSubmitOptions(
  renderId: string | undefined,
  formData?: Record<string, unknown>,
): { renderId?: string; formData?: Record<string, unknown> } | undefined {
  const options = {
    ...(renderId ? { renderId } : {}),
    ...(formData ? { formData } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function emitAction(
  ctx: TemplateContext,
  actionId: string,
  value: string,
  options?: { renderId?: string; formData?: Record<string, unknown> },
): void {
  if (options) {
    ctx.onAction(actionId, value, options);
  } else {
    ctx.onAction(actionId, value);
  }
}

function renderButtonReact(
  el: ActionElement,
  ctx: TemplateContext,
  renderId?: string,
): React.ReactElement {
  return React.createElement(
    'button',
    {
      key: el.id,
      type: 'button',
      className: 'rich-btn',
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        emitAction(ctx, el.id, el.value ?? el.id, buildSubmitOptions(renderId));
        event.currentTarget.disabled = true;
        event.currentTarget.classList.add('rich-btn-clicked');
      },
    },
    el.label,
  );
}

function renderSelectReact(
  el: ActionElement,
  ctx: TemplateContext,
  deferToSubmit: boolean,
  renderId?: string,
): React.ReactElement {
  const children: React.ReactElement[] = [];

  if (el.label) {
    children.push(
      React.createElement(
        'label',
        { key: `${el.id}-label`, className: 'rich-select-label' },
        el.label,
      ),
    );
  }

  const optionElements = [
    React.createElement(
      'option',
      { key: 'placeholder', value: '', disabled: true },
      el.placeholder ?? el.label ?? 'Select...',
    ),
    ...(el.options ?? []).map((opt) =>
      React.createElement('option', { key: opt.id, value: opt.id }, opt.label),
    ),
  ];

  children.push(
    React.createElement(
      'select',
      {
        key: `${el.id}-select`,
        className: 'rich-select',
        'data-action-id': el.id,
        required: el.required ?? undefined,
        defaultValue: '',
        onChange: deferToSubmit
          ? undefined
          : (e: React.ChangeEvent<HTMLSelectElement>) => {
              if (e.target.value) {
                if (!e.target.checkValidity()) {
                  e.target.reportValidity();
                  return;
                }
                emitAction(ctx, el.id, e.target.value, buildSubmitOptions(renderId));
              }
            },
      },
      ...optionElements,
    ),
  );

  return React.createElement('div', { key: el.id, className: 'rich-select-wrapper' }, ...children);
}

function renderInputReact(
  el: ActionElement,
  ctx: TemplateContext,
  deferToSubmit: boolean,
  renderId?: string,
): React.ReactElement {
  const children: React.ReactElement[] = [];

  if (el.label) {
    children.push(
      React.createElement(
        'label',
        { key: `${el.id}-label`, className: 'rich-input-label' },
        el.label,
      ),
    );
  }

  children.push(
    React.createElement('input', {
      key: `${el.id}-input`,
      className: 'rich-input',
      type: el.input_type ?? 'text',
      'data-action-id': el.id,
      placeholder: el.placeholder ?? undefined,
      required: el.required ?? undefined,
      onKeyDown: deferToSubmit
        ? undefined
        : (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              const input = e.currentTarget;
              if (!input.checkValidity()) {
                input.reportValidity();
                return;
              }
              emitAction(ctx, el.id, input.value, buildSubmitOptions(renderId));
            }
          },
    }),
  );

  return React.createElement('div', { key: el.id, className: 'rich-input-wrapper' }, ...children);
}

// ---------------------------------------------------------------------------
// DOM renderer helpers (mirrors rich-renderer.ts)
// ---------------------------------------------------------------------------

function createButton(
  el: ActionElement,
  ctx: TemplateContext,
  renderId?: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'rich-btn';
  btn.textContent = el.label;
  btn.addEventListener('click', () => {
    emitAction(ctx, el.id, el.value ?? el.id, buildSubmitOptions(renderId));
    btn.disabled = true;
    btn.classList.add('rich-btn-clicked');
  });
  return btn;
}

function createSelect(
  el: ActionElement,
  ctx: TemplateContext,
  deferToSubmit: boolean,
  renderId?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-select-wrapper';

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-select-label';
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const select = document.createElement('select');
  select.className = 'rich-select';
  select.setAttribute('data-action-id', el.id);
  if (el.required) select.required = true;

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = el.placeholder ?? el.label ?? 'Select...';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const opt of el.options ?? []) {
    const option = document.createElement('option');
    option.value = opt.id;
    option.textContent = opt.label;
    select.appendChild(option);
  }

  if (!deferToSubmit) {
    select.addEventListener('change', () => {
      if (!select.value) return;
      if (!select.checkValidity()) {
        select.reportValidity();
        return;
      }
      emitAction(ctx, el.id, select.value, buildSubmitOptions(renderId));
    });
  }

  wrapper.appendChild(select);
  return wrapper;
}

function createInput(
  el: ActionElement,
  ctx: TemplateContext,
  deferToSubmit: boolean,
  renderId?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-input-wrapper';

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-input-label';
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const input = document.createElement('input');
  input.className = 'rich-input';
  input.type = el.input_type ?? 'text';
  input.setAttribute('data-action-id', el.id);
  if (el.placeholder) input.placeholder = el.placeholder;
  if (el.required) input.required = true;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !deferToSubmit) {
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      emitAction(ctx, el.id, input.value, buildSubmitOptions(renderId));
    }
  });

  wrapper.appendChild(input);
  return wrapper;
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
  const inputEls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-action-id], select[data-action-id]',
  );

  for (const el of inputEls) {
    const id = el.getAttribute('data-action-id');
    if (id) {
      formData[id] = el.value;
    }
  }

  return formData;
}

// ---------------------------------------------------------------------------
// Renderer registration
// ---------------------------------------------------------------------------

const actionsRenderer: TemplateRenderer<ActionSet> = {
  type: 'actions',

  extract(message: Message): ActionSet | undefined {
    if (message.actions && message.actions.elements?.length > 0) {
      return message.actions;
    }
    return undefined;
  },

  render(data: ActionSet, ctx: TemplateContext): React.ReactElement {
    const deferToSubmit = Boolean(data.submit_id);
    const children: React.ReactElement[] = [];

    const buttons = data.elements.filter((e) => e.type === 'button');
    const selects = data.elements.filter((e) => e.type === 'select');
    const inputs = data.elements.filter((e) => e.type === 'input');

    if (buttons.length > 0) {
      children.push(
        React.createElement(
          'div',
          { key: 'btn-group', className: 'rich-button-group' },
          ...buttons.map((btn) => renderButtonReact(btn, ctx, data.renderId)),
        ),
      );
    }

    for (const sel of selects) {
      children.push(renderSelectReact(sel, ctx, deferToSubmit, data.renderId));
    }

    for (const inp of inputs) {
      children.push(renderInputReact(inp, ctx, deferToSubmit, data.renderId));
    }

    if (data.submit_label && data.submit_id) {
      const submitId = data.submit_id;
      children.push(
        React.createElement(
          'button',
          {
            key: 'submit',
            className: 'rich-btn rich-btn-primary',
            onClick: (e: React.MouseEvent) => {
              const container = (e.target as HTMLElement).closest('.rich-actions');
              if (!(container instanceof HTMLElement)) return;
              if (!validateActionInputs(container)) {
                return;
              }
              const formData = collectActionValues(container);
              ctx.onAction(
                submitId,
                JSON.stringify(formData),
                buildSubmitOptions(data.renderId, formData),
              );
            },
          },
          data.submit_label,
        ),
      );
    }

    return React.createElement(
      'div',
      {
        className: 'rich-actions',
        role: 'group',
        'aria-label': getString('actions.label'),
        'data-testid': 'action-handler',
      },
      ...children,
    );
  },

  renderDOM(data: ActionSet, ctx: TemplateContext): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rich-actions';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', getString('actions.label'));
    const deferToSubmit = Boolean(data.submit_id);

    const buttons = data.elements.filter((e) => e.type === 'button');
    const selects = data.elements.filter((e) => e.type === 'select');
    const inputs = data.elements.filter((e) => e.type === 'input');

    if (buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'rich-button-group';
      for (const btn of buttons) {
        btnGroup.appendChild(createButton(btn, ctx, data.renderId));
      }
      container.appendChild(btnGroup);
    }

    for (const sel of selects) {
      container.appendChild(createSelect(sel, ctx, deferToSubmit, data.renderId));
    }

    for (const inp of inputs) {
      container.appendChild(createInput(inp, ctx, deferToSubmit, data.renderId));
    }

    if (data.submit_label && data.submit_id) {
      const submitId = data.submit_id;
      const submitBtn = document.createElement('button');
      submitBtn.className = 'rich-btn rich-btn-primary';
      submitBtn.textContent = data.submit_label;
      submitBtn.addEventListener('click', () => {
        if (!validateActionInputs(container)) return;
        const formData = collectActionValues(container);
        ctx.onAction(
          submitId,
          JSON.stringify(formData),
          buildSubmitOptions(data.renderId, formData),
        );
      });
      container.appendChild(submitBtn);
    }

    return container;
  },
};

defaultRegistry.register(actionsRenderer);

export { actionsRenderer };
