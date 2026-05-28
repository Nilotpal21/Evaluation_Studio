/**
 * Web SDK Rich Content Tests
 *
 * Verifies SDK types (RichContent, ActionElement, ActionSet, Message)
 * and ChatClient handling of response_end with rich content.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  RichContent,
  ActionElement,
  ActionSet,
  Message,
  CarouselCard,
  Carousel,
} from '../core/types.js';
import type { ChatClient } from '../chat/ChatClient.js';
import '../templates/index.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

// =============================================================================
// SDK Type Shapes
// =============================================================================

describe('SDK RichContent type', () => {
  test('RichContent has all format fields including carousel', () => {
    const rc: RichContent = {
      markdown: '**bold**',
      adaptive_card: '{}',
      html: '<b>bold</b>',
      slack: '{}',
      ag_ui: '{}',
      whatsapp: '{}',
      carousel: {
        cards: [{ title: 'Card 1', subtitle: 'Sub 1', image_url: 'https://img.png' }],
      },
    };
    expect(rc.markdown).toBe('**bold**');
    expect(rc.adaptive_card).toBe('{}');
    expect(rc.html).toBe('<b>bold</b>');
    expect(rc.slack).toBe('{}');
    expect(rc.ag_ui).toBe('{}');
    expect(rc.whatsapp).toBe('{}');
    expect(rc.carousel?.cards).toHaveLength(1);
    expect(rc.carousel?.cards[0].title).toBe('Card 1');
  });

  test('RichContent with only markdown', () => {
    const rc: RichContent = { markdown: '# Hello' };
    expect(rc.markdown).toBe('# Hello');
    expect(rc.html).toBeUndefined();
  });

  test('empty RichContent is valid', () => {
    const rc: RichContent = {};
    expect(Object.keys(rc)).toHaveLength(0);
  });
});

describe('SDK ActionElement type', () => {
  test('button action element', () => {
    const el: ActionElement = {
      id: 'btn_1',
      type: 'button',
      label: 'Click Me',
      value: 'clicked',
    };
    expect(el.type).toBe('button');
    expect(el.id).toBe('btn_1');
    expect(el.label).toBe('Click Me');
  });

  test('select action element with options', () => {
    const el: ActionElement = {
      id: 'city_sel',
      type: 'select',
      label: 'City',
      options: [
        { id: 'nyc', label: 'New York' },
        { id: 'lax', label: 'Los Angeles', description: 'CA' },
      ],
    };
    expect(el.options).toHaveLength(2);
    expect(el.options![0].id).toBe('nyc');
    expect(el.options![1].description).toBe('CA');
  });

  test('input action element', () => {
    const el: ActionElement = {
      id: 'email_input',
      type: 'input',
      label: 'Email',
      input_type: 'email',
      placeholder: 'you@example.com',
      required: true,
    };
    expect(el.input_type).toBe('email');
    expect(el.required).toBe(true);
  });
});

describe('SDK ActionSet type', () => {
  test('ActionSet with button elements', () => {
    const set: ActionSet = {
      elements: [
        { id: 'btn_a', type: 'button', label: 'A' },
        { id: 'btn_b', type: 'button', label: 'B' },
      ],
    };
    expect(set.elements).toHaveLength(2);
    expect(set.submit_label).toBeUndefined();
  });

  test('ActionSet with submit', () => {
    const set: ActionSet = {
      elements: [{ id: 'name', type: 'input', label: 'Name' }],
      submit_label: 'Submit',
      submit_id: 'form_submit',
    };
    expect(set.submit_label).toBe('Submit');
    expect(set.submit_id).toBe('form_submit');
  });
});

describe('SDK Message with richContent', () => {
  test('Message includes richContent field', () => {
    const msg: Message = {
      id: 'msg_1',
      role: 'assistant',
      content: 'Hello!',
      timestamp: new Date(),
      richContent: { markdown: '**Hello!**' },
    };
    expect(msg.richContent).toBeDefined();
    expect(msg.richContent!.markdown).toBe('**Hello!**');
  });

  test('Message includes actions field', () => {
    const msg: Message = {
      id: 'msg_2',
      role: 'assistant',
      content: 'Choose one',
      timestamp: new Date(),
      actions: {
        elements: [
          { id: 'opt_a', type: 'button', label: 'A' },
          { id: 'opt_b', type: 'button', label: 'B' },
        ],
      },
    };
    expect(msg.actions).toBeDefined();
    expect(msg.actions!.elements).toHaveLength(2);
  });

  test('Message with both richContent and actions', () => {
    const msg: Message = {
      id: 'msg_3',
      role: 'assistant',
      content: 'Pick',
      timestamp: new Date(),
      richContent: { markdown: '**Pick an option:**' },
      actions: {
        elements: [{ id: 'btn_1', type: 'button', label: 'Go' }],
      },
    };
    expect(msg.richContent!.markdown).toBe('**Pick an option:**');
    expect(msg.actions!.elements[0].id).toBe('btn_1');
  });

  test('Message without richContent or actions (backward compat)', () => {
    const msg: Message = {
      id: 'msg_4',
      role: 'user',
      content: 'Hello',
      timestamp: new Date(),
    };
    expect(msg.richContent).toBeUndefined();
    expect(msg.actions).toBeUndefined();
  });

  test('Message role types are correct', () => {
    const roles: Array<'user' | 'assistant' | 'system'> = ['user', 'assistant', 'system'];
    for (const role of roles) {
      const msg: Message = { id: 'x', role, content: '', timestamp: new Date() };
      expect(msg.role).toBe(role);
    }
  });
});

describe('SDK CarouselCard type', () => {
  test('minimal card with just title', () => {
    const card: CarouselCard = { title: 'Product A' };
    expect(card.title).toBe('Product A');
    expect(card.subtitle).toBeUndefined();
    expect(card.image_url).toBeUndefined();
  });

  test('full card with all fields', () => {
    const card: CarouselCard = {
      title: 'Product A',
      subtitle: 'Best product',
      image_url: 'https://img.png',
      default_action_url: 'https://example.com',
      buttons: [{ id: 'buy', type: 'button', label: 'Buy Now', value: 'buy_a' }],
    };
    expect(card.buttons).toHaveLength(1);
    expect(card.buttons![0].label).toBe('Buy Now');
    expect(card.default_action_url).toBe('https://example.com');
  });
});

describe('SDK Carousel type', () => {
  test('carousel with multiple cards', () => {
    const carousel: Carousel = {
      cards: [
        { title: 'A' },
        { title: 'B', subtitle: 'Sub B' },
        { title: 'C', image_url: 'https://c.png' },
      ],
    };
    expect(carousel.cards).toHaveLength(3);
    expect(carousel.cards[1].subtitle).toBe('Sub B');
  });
});

describe('SDK Message with carousel richContent', () => {
  test('Message with carousel', () => {
    const msg: Message = {
      id: 'msg_carousel',
      role: 'assistant',
      content: 'Check out these products:',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [
            {
              title: 'Product 1',
              subtitle: '$29.99',
              image_url: 'https://img1.png',
              buttons: [{ id: 'buy_1', type: 'button', label: 'Buy' }],
            },
            {
              title: 'Product 2',
              subtitle: '$49.99',
              buttons: [{ id: 'buy_2', type: 'button', label: 'Buy' }],
            },
          ],
        },
      },
    };
    expect(msg.richContent?.carousel?.cards).toHaveLength(2);
    expect(msg.richContent?.carousel?.cards[0].buttons?.[0].id).toBe('buy_1');
  });
});

describe('RichMessage action wiring', () => {
  test('routes rendered action elements back through chat.submitAction', async () => {
    const { RichMessage } = await import('../react/RichMessage.js');
    const chat = {
      submitAction: vi.fn(),
    } as Pick<ChatClient, 'submitAction'> as ChatClient;
    const message: Message = {
      id: 'msg-rich-action',
      role: 'assistant',
      content: 'Choose one',
      timestamp: new Date(),
      actions: {
        elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
      },
    };

    await act(async () => {
      root.render(React.createElement(RichMessage, { message, chat }));
      await Promise.resolve();
    });

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Approve',
    );

    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chat.submitAction).toHaveBeenCalledWith('approve', 'yes');
  });
});
