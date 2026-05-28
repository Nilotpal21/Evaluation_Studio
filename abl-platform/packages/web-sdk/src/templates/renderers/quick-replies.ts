/**
 * Quick Replies Template Renderer
 *
 * Renders quick reply pill buttons for rapid user selection.
 */

import React from 'react';
import type { Message, QuickReply } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

const quickRepliesRenderer: TemplateRenderer<QuickReply[]> = {
  type: 'quick_replies',

  extract(message: Message): QuickReply[] | undefined {
    const replies = message.richContent?.quick_replies;
    if (replies && replies.length > 0) {
      return replies;
    }
    return undefined;
  },

  render(data: QuickReply[], ctx: TemplateContext): React.ReactElement {
    const pills = data.map((reply) => {
      const children: Array<React.ReactElement | string> = [];

      if (reply.icon_url && isSafeUrl(reply.icon_url, { allowDataImages: true })) {
        children.push(
          React.createElement('img', {
            key: `${reply.id}-icon`,
            className: 'rich-quick-reply-icon',
            src: reply.icon_url,
            alt: '',
            'aria-hidden': 'true',
          }),
        );
      }

      children.push(reply.label);

      return React.createElement(
        'button',
        {
          key: reply.id,
          className: 'rich-quick-reply',
          'aria-label': reply.label,
          onClick: () => ctx.onAction(reply.id, reply.label),
        },
        ...children,
      );
    });

    return React.createElement(
      'div',
      {
        className: 'rich-quick-replies',
        role: 'group',
        'aria-label': getString('quickReplies.label'),
      },
      ...pills,
    );
  },

  renderDOM(data: QuickReply[], ctx: TemplateContext): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rich-quick-replies';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', getString('quickReplies.label'));

    for (const reply of data) {
      const btn = document.createElement('button');
      btn.className = 'rich-quick-reply';
      btn.setAttribute('aria-label', reply.label);

      if (reply.icon_url && isSafeUrl(reply.icon_url, { allowDataImages: true })) {
        const icon = document.createElement('img');
        icon.className = 'rich-quick-reply-icon';
        icon.src = reply.icon_url;
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');
        btn.appendChild(icon);
      }

      btn.appendChild(document.createTextNode(reply.label));

      btn.addEventListener('click', () => {
        ctx.onAction(reply.id, reply.label);
      });

      container.appendChild(btn);
    }

    return container;
  },
};

defaultRegistry.register(quickRepliesRenderer);

export { quickRepliesRenderer };
