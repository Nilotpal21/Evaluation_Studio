/**
 * Audio Template Renderer
 *
 * Renders an audio player with controls and optional caption.
 */

import React from 'react';
import type { Message, MediaContent } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

const audioRenderer: TemplateRenderer<MediaContent> = {
  type: 'audio',

  extract(message: Message): MediaContent | undefined {
    return message.richContent?.audio;
  },

  render(data: MediaContent, _ctx: TemplateContext): React.ReactElement {
    if (!isSafeUrl(data.url)) {
      return React.createElement('div', { className: 'rich-audio rich-audio-blocked' });
    }

    const children: React.ReactElement[] = [
      React.createElement('audio', {
        key: 'audio',
        className: 'rich-audio-player',
        src: data.url,
        controls: true,
        'aria-label': data.alt ?? data.caption ?? getString('audio.label'),
      }),
    ];

    if (data.caption) {
      children.push(
        React.createElement(
          'div',
          { key: 'caption', className: 'rich-audio-caption' },
          data.caption,
        ),
      );
    }

    return React.createElement('div', { className: 'rich-audio' }, ...children);
  },

  renderDOM(data: MediaContent, _ctx: TemplateContext): HTMLElement {
    if (!isSafeUrl(data.url)) {
      const blocked = document.createElement('div');
      blocked.className = 'rich-audio rich-audio-blocked';
      return blocked;
    }

    const container = document.createElement('div');
    container.className = 'rich-audio';

    const audio = document.createElement('audio');
    audio.className = 'rich-audio-player';
    audio.src = data.url;
    audio.controls = true;
    audio.setAttribute('aria-label', data.alt ?? data.caption ?? getString('audio.label'));
    container.appendChild(audio);

    if (data.caption) {
      const caption = document.createElement('div');
      caption.className = 'rich-audio-caption';
      caption.textContent = data.caption;
      container.appendChild(caption);
    }

    return container;
  },
};

defaultRegistry.register(audioRenderer);

export { audioRenderer };
