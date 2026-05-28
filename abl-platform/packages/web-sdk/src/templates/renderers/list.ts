/**
 * List Template Renderer
 *
 * Renders a list of items with optional titles, subtitles, and images.
 */

import React from 'react';
import type { Message, ListTemplate, ListItem } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

// ---------------------------------------------------------------------------
// React helpers
// ---------------------------------------------------------------------------

function renderListItemReact(item: ListItem, index: number): React.ReactElement {
  const children: React.ReactElement[] = [];

  if (item.image_url && isSafeUrl(item.image_url, { allowDataImages: true })) {
    children.push(
      React.createElement('img', {
        key: 'img',
        className: 'rich-list-image',
        src: item.image_url,
        alt: item.title,
        loading: 'lazy',
      }),
    );
  }

  const textChildren: React.ReactElement[] = [
    React.createElement('div', { key: 'title', className: 'rich-list-item-title' }, item.title),
  ];

  if (item.subtitle) {
    textChildren.push(
      React.createElement(
        'div',
        { key: 'subtitle', className: 'rich-list-item-subtitle' },
        item.subtitle,
      ),
    );
  }

  children.push(
    React.createElement('div', { key: 'text', className: 'rich-list-item-text' }, ...textChildren),
  );

  const props: Record<string, unknown> = {
    key: `item-${index}`,
    className: 'rich-list-item',
    role: 'listitem',
  };

  if (item.default_action_url && isSafeUrl(item.default_action_url)) {
    props.style = { cursor: 'pointer' };
    props.onClick = () => {
      window.open(item.default_action_url, '_blank', 'noopener');
    };
  }

  return React.createElement('div', props, ...children);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const listRenderer: TemplateRenderer<ListTemplate> = {
  type: 'list',

  extract(message: Message): ListTemplate | undefined {
    const list = message.richContent?.list;
    if (list && list.items.length > 0) {
      return list;
    }
    return undefined;
  },

  render(data: ListTemplate, _ctx: TemplateContext): React.ReactElement {
    const children: React.ReactElement[] = [];

    if (data.title) {
      children.push(
        React.createElement('div', { key: 'title', className: 'rich-list-title' }, data.title),
      );
    }

    children.push(
      React.createElement(
        'div',
        { key: 'items', className: 'rich-list-items', role: 'list' },
        ...data.items.map((item, i) => renderListItemReact(item, i)),
      ),
    );

    return React.createElement(
      'div',
      {
        className: 'rich-list',
        role: 'region',
        'aria-label': data.title ?? getString('list.label'),
      },
      ...children,
    );
  },

  renderDOM(data: ListTemplate, _ctx: TemplateContext): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rich-list';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', data.title ?? getString('list.label'));

    if (data.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'rich-list-title';
      titleEl.textContent = data.title;
      container.appendChild(titleEl);
    }

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'rich-list-items';
    itemsContainer.setAttribute('role', 'list');

    for (const item of data.items) {
      const itemEl = document.createElement('div');
      itemEl.className = 'rich-list-item';
      itemEl.setAttribute('role', 'listitem');

      if (item.image_url && isSafeUrl(item.image_url, { allowDataImages: true })) {
        const img = document.createElement('img');
        img.className = 'rich-list-image';
        img.src = item.image_url;
        img.alt = item.title;
        img.loading = 'lazy';
        itemEl.appendChild(img);
      }

      const textEl = document.createElement('div');
      textEl.className = 'rich-list-item-text';

      const titleEl = document.createElement('div');
      titleEl.className = 'rich-list-item-title';
      titleEl.textContent = item.title;
      textEl.appendChild(titleEl);

      if (item.subtitle) {
        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'rich-list-item-subtitle';
        subtitleEl.textContent = item.subtitle;
        textEl.appendChild(subtitleEl);
      }

      itemEl.appendChild(textEl);

      if (item.default_action_url && isSafeUrl(item.default_action_url)) {
        itemEl.style.cursor = 'pointer';
        itemEl.addEventListener('click', () => {
          window.open(item.default_action_url, '_blank', 'noopener');
        });
      }

      itemsContainer.appendChild(itemEl);
    }

    container.appendChild(itemsContainer);
    return container;
  },
};

defaultRegistry.register(listRenderer);

export { listRenderer };
