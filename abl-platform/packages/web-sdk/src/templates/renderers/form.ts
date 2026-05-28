/**
 * Form Template Renderer
 *
 * Renders a form with ActionElement fields and a submit button.
 * On submit, collects all field values and calls ctx.onAction.
 */

import React from 'react';
import type { Message, FormTemplate, ActionElement } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';

// ---------------------------------------------------------------------------
// DOM helpers — reuse patterns from actions renderer
// ---------------------------------------------------------------------------

function createFormSelect(el: ActionElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-form-field rich-select-wrapper';

  const fieldId = `rich-field-${el.id}`;

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-select-label';
    label.setAttribute('for', fieldId);
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const select = document.createElement('select');
  select.className = 'rich-select';
  select.id = fieldId;
  select.setAttribute('data-field-id', el.id);
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

  wrapper.appendChild(select);
  return wrapper;
}

function createFormInput(el: ActionElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-form-field rich-input-wrapper';

  const fieldId = `rich-field-${el.id}`;

  if (el.label) {
    const label = document.createElement('label');
    label.className = 'rich-input-label';
    label.setAttribute('for', fieldId);
    label.textContent = el.label;
    wrapper.appendChild(label);
  }

  const input = document.createElement('input');
  input.className = 'rich-input';
  input.id = fieldId;
  input.type = el.input_type ?? 'text';
  input.setAttribute('data-field-id', el.id);
  if (el.placeholder) input.placeholder = el.placeholder;
  if (el.required) input.required = true;

  wrapper.appendChild(input);
  return wrapper;
}

function createFormButton(el: ActionElement, ctx: TemplateContext): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-form-field';

  const btn = document.createElement('button');
  btn.className = 'rich-btn';
  btn.textContent = el.label;
  btn.type = 'button';
  btn.addEventListener('click', () => {
    ctx.onAction(
      el.id,
      el.value ?? el.id,
      ctx.actionRenderId ? { renderId: ctx.actionRenderId } : undefined,
    );
  });

  wrapper.appendChild(btn);
  return wrapper;
}

function collectFormValues(container: HTMLElement): Record<string, string> {
  const values: Record<string, string> = {};
  const fields = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-field-id], select[data-field-id]',
  );
  for (const field of fields) {
    const id = field.getAttribute('data-field-id');
    if (id) values[id] = field.value;
  }
  return values;
}

function validateFormFields(container: HTMLElement): boolean {
  const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[data-field-id], select[data-field-id]',
  );
  for (const control of controls) {
    if (!control.checkValidity()) {
      control.reportValidity();
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// React helpers
// ---------------------------------------------------------------------------

function renderFieldReact(el: ActionElement, ctx: TemplateContext): React.ReactElement {
  if (el.type === 'select') {
    const fieldId = `rich-field-${el.id}`;
    const options = [
      React.createElement(
        'option',
        { key: 'placeholder', value: '', disabled: true },
        el.placeholder ?? el.label ?? 'Select...',
      ),
      ...(el.options ?? []).map((opt) =>
        React.createElement('option', { key: opt.id, value: opt.id }, opt.label),
      ),
    ];

    return React.createElement(
      'div',
      { key: el.id, className: 'rich-form-field rich-select-wrapper' },
      el.label
        ? React.createElement(
            'label',
            { className: 'rich-select-label', htmlFor: fieldId },
            el.label,
          )
        : null,
      React.createElement(
        'select',
        {
          id: fieldId,
          className: 'rich-select',
          'data-field-id': el.id,
          required: el.required ?? undefined,
          defaultValue: '',
        },
        ...options,
      ),
    );
  }

  if (el.type === 'input') {
    const fieldId = `rich-field-${el.id}`;
    return React.createElement(
      'div',
      { key: el.id, className: 'rich-form-field rich-input-wrapper' },
      el.label
        ? React.createElement(
            'label',
            { className: 'rich-input-label', htmlFor: fieldId },
            el.label,
          )
        : null,
      React.createElement('input', {
        id: fieldId,
        className: 'rich-input',
        type: el.input_type ?? 'text',
        'data-field-id': el.id,
        placeholder: el.placeholder ?? undefined,
        required: el.required ?? undefined,
      }),
    );
  }

  // Button
  return React.createElement(
    'div',
    { key: el.id, className: 'rich-form-field' },
    React.createElement(
      'button',
      {
        className: 'rich-btn',
        type: 'button',
        onClick: () =>
          ctx.onAction(
            el.id,
            el.value ?? el.id,
            ctx.actionRenderId ? { renderId: ctx.actionRenderId } : undefined,
          ),
      },
      el.label,
    ),
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const formRenderer: TemplateRenderer<FormTemplate> = {
  type: 'form',

  extract(message: Message): FormTemplate | undefined {
    const form = message.richContent?.form;
    if (form && form.fields.length > 0) {
      return form;
    }
    return undefined;
  },

  render(data: FormTemplate, ctx: TemplateContext): React.ReactElement {
    const children: React.ReactElement[] = [];

    if (data.title) {
      children.push(
        React.createElement('div', { key: 'title', className: 'rich-form-title' }, data.title),
      );
    }

    for (const field of data.fields) {
      children.push(renderFieldReact(field, ctx));
    }

    children.push(
      React.createElement(
        'button',
        {
          key: 'submit',
          className: 'rich-btn rich-btn-primary rich-form-submit',
          type: 'button',
          onClick: (e: React.MouseEvent) => {
            const container = (e.target as HTMLElement).closest('.rich-form');
            if (!(container instanceof HTMLElement)) return;
            if (!validateFormFields(container)) {
              return;
            }
            const values = collectFormValues(container);
            ctx.onAction('form-submit', JSON.stringify(values), {
              formData: values,
              ...(ctx.actionRenderId ? { renderId: ctx.actionRenderId } : {}),
            });
          },
        },
        data.submit_label ?? getString('form.submit'),
      ),
    );

    return React.createElement(
      'div',
      {
        className: 'rich-form',
        role: 'form',
        'aria-label': data.title ?? getString('form.label'),
      },
      ...children,
    );
  },

  renderDOM(data: FormTemplate, ctx: TemplateContext): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rich-form';
    container.setAttribute('role', 'form');
    container.setAttribute('aria-label', data.title ?? getString('form.label'));

    if (data.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'rich-form-title';
      titleEl.textContent = data.title;
      container.appendChild(titleEl);
    }

    for (const field of data.fields) {
      if (field.type === 'select') {
        container.appendChild(createFormSelect(field));
      } else if (field.type === 'input') {
        container.appendChild(createFormInput(field));
      } else {
        container.appendChild(createFormButton(field, ctx));
      }
    }

    const submitBtn = document.createElement('button');
    submitBtn.className = 'rich-btn rich-btn-primary rich-form-submit';
    submitBtn.type = 'button';
    submitBtn.textContent = data.submit_label ?? getString('form.submit');
    submitBtn.addEventListener('click', () => {
      if (!validateFormFields(container)) return;
      const values = collectFormValues(container);
      ctx.onAction('form-submit', JSON.stringify(values), {
        formData: values,
        ...(ctx.actionRenderId ? { renderId: ctx.actionRenderId } : {}),
      });
    });
    container.appendChild(submitBtn);

    return container;
  },
};

defaultRegistry.register(formRenderer);

export { formRenderer };
