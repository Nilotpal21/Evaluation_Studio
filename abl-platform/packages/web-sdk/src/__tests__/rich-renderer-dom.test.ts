/**
 * Rich Renderer DOM Tests
 *
 * Tests for renderRichMessage, renderCarousel, and renderActions
 * using jsdom environment.
 */

import { describe, test, expect, vi } from 'vitest';
import { renderRichMessage } from '../ui/rich-renderer.js';
import type { RenderOptions } from '../ui/rich-renderer.js';
import type { Message } from '../core/types.js';

// Side-effect imports: register all template renderers in defaultRegistry
import '../templates/index.js';

function createOptions(onAction = vi.fn()): RenderOptions {
  return { onAction };
}

// =============================================================================
// renderRichMessage — text body rendering
// =============================================================================

describe('renderRichMessage — text body', () => {
  test('renders markdown content into .rich-text div', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'fallback',
      timestamp: new Date(),
      richContent: { markdown: '**Hello**' },
    };
    renderRichMessage(container, msg, createOptions());
    const textEl = container.querySelector('.rich-text');
    expect(textEl).not.toBeNull();
    expect(textEl!.innerHTML).toContain('<strong>Hello</strong>');
  });

  test('renders HTML content when no markdown', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'fallback',
      timestamp: new Date(),
      richContent: { html: '<b>Bold</b>' },
    };
    renderRichMessage(container, msg, createOptions());
    const textEl = container.querySelector('.rich-text');
    expect(textEl!.innerHTML).toContain('<b>Bold</b>');
  });

  test('sanitizes unsafe HTML content before DOM insertion', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'fallback',
      timestamp: new Date(),
      richContent: {
        html: '<img src="https://img.png" onerror="alert(1)"><a href="javascript:alert(2)">Click</a>',
      },
    };
    renderRichMessage(container, msg, createOptions());

    const textEl = container.querySelector('.rich-text');
    expect(textEl!.innerHTML).not.toContain('onerror');
    expect(textEl!.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(textEl!.querySelector('a')?.getAttribute('href')).toBeNull();
  });

  test('prefers markdown over HTML when both present', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'fallback',
      timestamp: new Date(),
      richContent: { markdown: '**MD**', html: '<b>HTML</b>' },
    };
    renderRichMessage(container, msg, createOptions());
    const textEl = container.querySelector('.rich-text');
    expect(textEl!.innerHTML).toContain('<strong>MD</strong>');
    expect(textEl!.innerHTML).not.toContain('<b>HTML</b>');
  });

  test('sanitizes unsafe markdown URLs before inserting HTML', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'fallback',
      timestamp: new Date(),
      richContent: { markdown: '[Click](javascript:alert(1)) ![Img](javascript:alert(2))' },
    };
    renderRichMessage(container, msg, createOptions());

    const textEl = container.querySelector('.rich-text');
    expect(textEl!.innerHTML).not.toContain('javascript:');
    expect(textEl!.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(textEl!.querySelector('img')?.getAttribute('src')).toBeNull();
  });

  test('falls back to plain text content when no richContent', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Plain text',
      timestamp: new Date(),
    };
    renderRichMessage(container, msg, createOptions());
    const textEl = container.querySelector('.rich-text');
    expect(textEl!.textContent).toBe('Plain text');
  });

  test('renders nothing for empty message', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };
    renderRichMessage(container, msg, createOptions());
    expect(container.children.length).toBe(0);
  });
});

// =============================================================================
// renderRichMessage — carousel rendering
// =============================================================================

describe('renderRichMessage — carousel', () => {
  test('renders carousel with cards', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [
            { title: 'Card A', subtitle: 'Sub A', image_url: 'https://a.png' },
            { title: 'Card B' },
          ],
        },
      },
    };
    renderRichMessage(container, msg, createOptions());

    const carousel = container.querySelector('.rich-carousel');
    expect(carousel).not.toBeNull();

    const cards = container.querySelectorAll('.rich-carousel-card');
    expect(cards.length).toBe(2);
  });

  test('carousel card renders image when image_url present', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [{ title: 'Card', image_url: 'https://img.png' }],
        },
      },
    };
    renderRichMessage(container, msg, createOptions());

    const img = container.querySelector('.rich-carousel-image') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('https://img.png');
    expect(img.loading).toBe('lazy');
  });

  test('carousel card renders title and subtitle', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [{ title: 'Product', subtitle: '$9.99' }],
        },
      },
    };
    renderRichMessage(container, msg, createOptions());

    expect(container.querySelector('.rich-carousel-title')!.textContent).toBe('Product');
    expect(container.querySelector('.rich-carousel-subtitle')!.textContent).toBe('$9.99');
  });

  test('carousel card with buttons triggers onAction', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [
            {
              title: 'Card',
              buttons: [{ id: 'buy', type: 'button', label: 'Buy', value: 'buy_val' }],
            },
          ],
        },
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    const btn = container.querySelector('.rich-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Buy');
    btn.click();
    expect(onAction).toHaveBeenCalledWith('buy', 'buy_val');
  });

  test('carousel card buttons include message action renderId when present', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [
            {
              title: 'Card',
              buttons: [{ id: 'buy', type: 'button', label: 'Buy', value: 'buy_val' }],
            },
          ],
        },
      },
      actions: {
        elements: [],
        renderId: 'action-render-carousel-1',
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    const btn = container.querySelector('.rich-btn') as HTMLButtonElement;
    btn.click();
    expect(onAction).toHaveBeenCalledWith('buy', 'buy_val', {
      renderId: 'action-render-carousel-1',
    });
  });

  test('carousel shows nav buttons when multiple cards', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [{ title: 'A' }, { title: 'B' }],
        },
      },
    };
    renderRichMessage(container, msg, createOptions());

    const navBtns = container.querySelectorAll('.rich-carousel-nav');
    expect(navBtns.length).toBe(2);
  });

  test('carousel ignores unsafe default_action_url values', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [{ title: 'Unsafe', default_action_url: 'javascript:alert(1)' }],
        },
      },
    };

    renderRichMessage(container, msg, createOptions());

    const card = container.querySelector('.rich-carousel-card') as HTMLDivElement;
    card.click();

    expect(openSpy).not.toHaveBeenCalled();
    expect(card.style.cursor).toBe('');

    openSpy.mockRestore();
  });

  test('carousel hides nav buttons for single card', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        carousel: { cards: [{ title: 'Solo' }] },
      },
    };
    renderRichMessage(container, msg, createOptions());

    const navBtns = container.querySelectorAll('.rich-carousel-nav');
    expect(navBtns.length).toBe(0);
  });

  test('skips carousel when cards array is empty', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Text',
      timestamp: new Date(),
      richContent: { carousel: { cards: [] } },
    };
    renderRichMessage(container, msg, createOptions());
    expect(container.querySelector('.rich-carousel')).toBeNull();
  });
});

// =============================================================================
// renderRichMessage — actions rendering
// =============================================================================

describe('renderRichMessage — actions', () => {
  test('renders button actions', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Choose',
      timestamp: new Date(),
      actions: {
        elements: [
          { id: 'a', type: 'button', label: 'Option A', value: 'val_a' },
          { id: 'b', type: 'button', label: 'Option B', value: 'val_b' },
        ],
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    const textEl = container.querySelector('.rich-text');
    expect(textEl?.textContent).toBe('Choose');

    const buttons = container.querySelectorAll('.rich-btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('Option A');

    (buttons[0] as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith('a', 'val_a');
  });

  test('button gets disabled after click and falls back to id when no value', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        elements: [{ id: 'btn', type: 'button', label: 'Click' }],
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    const btn = container.querySelector('.rich-btn') as HTMLButtonElement;
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('rich-btn-clicked')).toBe(true);
    expect(onAction).toHaveBeenCalledWith('btn', 'btn');
  });

  test('renders select with options', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        elements: [
          {
            id: 'city',
            type: 'select',
            label: 'City',
            options: [
              { id: 'nyc', label: 'New York' },
              { id: 'la', label: 'Los Angeles' },
            ],
          },
        ],
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    const select = container.querySelector('.rich-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    // Placeholder + 2 options
    expect(select.options.length).toBe(3);
    expect(select.getAttribute('data-action-id')).toBe('city');
  });

  test('renders input with placeholder and type', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        elements: [
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            placeholder: 'you@example.com',
            required: true,
          },
        ],
      },
    };
    renderRichMessage(container, msg, createOptions());

    const input = container.querySelector('.rich-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('email');
    expect(input.placeholder).toBe('you@example.com');
    expect(input.required).toBe(true);
    expect(input.getAttribute('data-action-id')).toBe('email');
  });

  test('renders submit button and collects form data', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        renderId: 'render-form-1',
        elements: [
          { id: 'name', type: 'input', label: 'Name' },
          { id: 'city', type: 'select', label: 'City', options: [{ id: 'nyc', label: 'NYC' }] },
        ],
        submit_label: 'Submit',
        submit_id: 'form_submit',
      },
    };
    renderRichMessage(container, msg, createOptions(onAction));

    // Fill in form values
    const input = container.querySelector('input[data-action-id="name"]') as HTMLInputElement;
    input.value = 'Alice';
    const select = container.querySelector('select[data-action-id="city"]') as HTMLSelectElement;
    select.value = 'nyc';

    // Click submit
    const submitBtn = container.querySelector('.rich-btn-primary') as HTMLButtonElement;
    expect(submitBtn.textContent).toBe('Submit');
    submitBtn.click();

    // renderActions processes selects before inputs in DOM order,
    // so city (select) appears before name (input) in the serialized form data.
    expect(onAction).toHaveBeenCalledWith(
      'form_submit',
      JSON.stringify({ city: 'nyc', name: 'Alice' }),
      {
        formData: { city: 'nyc', name: 'Alice' },
        renderId: 'render-form-1',
      },
    );
  });

  test('defers select and input actions when a submit button is present', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        renderId: 'render-form-2',
        elements: [
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            placeholder: 'you@example.com',
          },
          {
            id: 'city',
            type: 'select',
            label: 'City',
            options: [{ id: 'nyc', label: 'NYC' }],
          },
        ],
        submit_label: 'Submit',
        submit_id: 'form_submit',
      },
    };

    renderRichMessage(container, msg, createOptions(onAction));

    const input = container.querySelector('input[data-action-id="email"]') as HTMLInputElement;
    const select = container.querySelector('select[data-action-id="city"]') as HTMLSelectElement;

    input.value = 'alice@example.com';
    select.value = 'nyc';
    select.dispatchEvent(new Event('change'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onAction).not.toHaveBeenCalled();

    const submitBtn = container.querySelector('.rich-btn-primary') as HTMLButtonElement;
    submitBtn.click();

    expect(onAction).toHaveBeenCalledWith(
      'form_submit',
      JSON.stringify({ city: 'nyc', email: 'alice@example.com' }),
      {
        formData: { city: 'nyc', email: 'alice@example.com' },
        renderId: 'render-form-2',
      },
    );
  });

  test('does not submit invalid required form inputs', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        elements: [
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            required: true,
          },
        ],
        submit_label: 'Submit',
        submit_id: 'form_submit',
      },
    };

    renderRichMessage(container, msg, createOptions(onAction));

    const input = container.querySelector('input[data-action-id="email"]') as HTMLInputElement;
    const reportValiditySpy = vi.spyOn(input, 'reportValidity');
    const submitBtn = container.querySelector('.rich-btn-primary') as HTMLButtonElement;
    submitBtn.click();

    expect(onAction).not.toHaveBeenCalled();
    expect(reportValiditySpy).toHaveBeenCalled();
  });

  test('rich form template submit includes message action renderId when present', () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        form: {
          fields: [{ id: 'email', type: 'input', label: 'Email' }],
          submit_label: 'Submit',
        },
      },
      actions: {
        elements: [],
        renderId: 'action-render-form-1',
      },
    };

    renderRichMessage(container, msg, createOptions(onAction));

    const input = container.querySelector('input[data-field-id="email"]') as HTMLInputElement;
    input.value = 'alice@example.com';
    const submitBtn = container.querySelector('.rich-form-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(onAction).toHaveBeenCalledWith(
      'form-submit',
      JSON.stringify({ email: 'alice@example.com' }),
      {
        formData: { email: 'alice@example.com' },
        renderId: 'action-render-form-1',
      },
    );
  });

  test('skips actions when elements array is empty', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Text',
      timestamp: new Date(),
      actions: { elements: [] },
    };
    renderRichMessage(container, msg, createOptions());
    expect(container.querySelector('.rich-actions')).toBeNull();
  });
});

// =============================================================================
// Combined rendering
// =============================================================================

describe('renderRichMessage — combined', () => {
  test('renders markdown + carousel + actions together', () => {
    const container = document.createElement('div');
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        markdown: '**Products:**',
        carousel: {
          cards: [{ title: 'Item 1' }, { title: 'Item 2' }],
        },
      },
      actions: {
        elements: [{ id: 'more', type: 'button', label: 'Load More' }],
      },
    };
    renderRichMessage(container, msg, createOptions());

    expect(container.querySelector('.rich-text')).not.toBeNull();
    expect(container.querySelector('.rich-carousel')).not.toBeNull();
    expect(container.querySelector('.rich-actions')).not.toBeNull();
    expect(container.children.length).toBe(3);
  });
});
