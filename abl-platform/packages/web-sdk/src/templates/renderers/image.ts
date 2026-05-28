/**
 * Image Template Renderer
 *
 * Renders an image with alt text and optional thumbnail.
 */

import React from 'react';
import type { Message, MediaContent } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

const imageRenderer: TemplateRenderer<MediaContent> = {
  type: 'image',

  extract(message: Message): MediaContent | undefined {
    return message.richContent?.image;
  },

  render(data: MediaContent, _ctx: TemplateContext): React.ReactElement {
    if (!isSafeUrl(data.url, { allowDataImages: true })) {
      return React.createElement('div', { className: 'rich-image rich-image-blocked' });
    }

    const children: React.ReactElement[] = [
      React.createElement('img', {
        key: 'img',
        className: 'rich-image-content',
        src: data.url,
        alt: data.alt ?? '',
        loading: 'lazy',
      }),
    ];

    if (data.caption) {
      children.push(
        React.createElement(
          'figcaption',
          { key: 'caption', className: 'rich-image-caption' },
          data.caption,
        ),
      );
    }

    return React.createElement(
      'figure',
      {
        className: 'rich-image',
        role: 'img',
        'aria-label': data.alt ?? data.caption ?? getString('image.label'),
      },
      ...children,
    );
  },

  renderDOM(data: MediaContent, _ctx: TemplateContext): HTMLElement {
    if (!isSafeUrl(data.url, { allowDataImages: true })) {
      const blocked = document.createElement('div');
      blocked.className = 'rich-image rich-image-blocked';
      return blocked;
    }

    const figure = document.createElement('figure');
    figure.className = 'rich-image';
    figure.setAttribute('role', 'img');
    figure.setAttribute('aria-label', data.alt ?? data.caption ?? getString('image.label'));

    const img = document.createElement('img');
    img.className = 'rich-image-content';
    img.src = data.url;
    img.alt = data.alt ?? '';
    img.loading = 'lazy';
    figure.appendChild(img);

    if (data.caption) {
      const caption = document.createElement('figcaption');
      caption.className = 'rich-image-caption';
      caption.textContent = data.caption;
      figure.appendChild(caption);
    }

    return figure;
  },
};

defaultRegistry.register(imageRenderer);

export { imageRenderer };
