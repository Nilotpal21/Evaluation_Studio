/**
 * Video Template Renderer
 *
 * Renders a video player with controls and optional caption.
 */

import React from 'react';
import type { Message, MediaContent } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

const videoRenderer: TemplateRenderer<MediaContent> = {
  type: 'video',

  extract(message: Message): MediaContent | undefined {
    return message.richContent?.video;
  },

  render(data: MediaContent, _ctx: TemplateContext): React.ReactElement {
    if (!isSafeUrl(data.url)) {
      return React.createElement('div', { className: 'rich-video rich-video-blocked' });
    }

    const children: React.ReactElement[] = [
      React.createElement('video', {
        key: 'video',
        className: 'rich-video-player',
        src: data.url,
        controls: true,
        'aria-label': data.alt ?? data.caption ?? getString('video.label'),
      }),
    ];

    if (data.caption) {
      children.push(
        React.createElement(
          'div',
          { key: 'caption', className: 'rich-video-caption' },
          data.caption,
        ),
      );
    }

    return React.createElement('div', { className: 'rich-video' }, ...children);
  },

  renderDOM(data: MediaContent, _ctx: TemplateContext): HTMLElement {
    if (!isSafeUrl(data.url)) {
      const blocked = document.createElement('div');
      blocked.className = 'rich-video rich-video-blocked';
      return blocked;
    }

    const container = document.createElement('div');
    container.className = 'rich-video';

    const video = document.createElement('video');
    video.className = 'rich-video-player';
    video.src = data.url;
    video.controls = true;
    video.setAttribute('aria-label', data.alt ?? data.caption ?? getString('video.label'));
    container.appendChild(video);

    if (data.caption) {
      const caption = document.createElement('div');
      caption.className = 'rich-video-caption';
      caption.textContent = data.caption;
      container.appendChild(caption);
    }

    return container;
  },
};

defaultRegistry.register(videoRenderer);

export { videoRenderer };
