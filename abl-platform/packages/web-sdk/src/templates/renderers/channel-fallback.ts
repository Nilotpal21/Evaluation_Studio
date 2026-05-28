import React from 'react';
import type { Message } from '../../core/types.js';
import { defaultRegistry } from '../registry.js';
import { WEB_FALLBACK_RICH_CONTENT_TYPES } from '../support.js';
import type { TemplateContext, TemplateRenderer } from '../types.js';
import { getString } from '../utils/strings.js';
import { extractStructuredTextPreview } from '../utils/structured-preview.js';

type ChannelFallbackType = (typeof WEB_FALLBACK_RICH_CONTENT_TYPES)[number];

interface ChannelFallbackItem {
  type: ChannelFallbackType;
  preview?: string;
}

interface ChannelFallbackData {
  items: ChannelFallbackItem[];
}

const containerStyle = {
  display: 'grid',
  gap: '8px',
  marginTop: '8px',
} as const;

const itemStyle = {
  border: '1px solid var(--border, #d0d7de)',
  borderRadius: '10px',
  padding: '10px 12px',
  background: 'var(--surface-secondary, rgba(15, 23, 42, 0.03))',
} as const;

const titleStyle = {
  fontSize: '0.85rem',
  fontWeight: 600,
  marginBottom: '4px',
} as const;

const bodyStyle = {
  fontSize: '0.8rem',
  lineHeight: 1.45,
  color: 'var(--text-secondary, #475569)',
} as const;

function getVariantTitle(type: ChannelFallbackType): string {
  return getString(`channelFallback.variant.${type}`);
}

function getVariantBody(item: ChannelFallbackItem): string {
  return item.preview ?? getString('channelFallback.description');
}

function renderItemReact(item: ChannelFallbackItem): React.ReactElement {
  return React.createElement(
    'div',
    {
      key: item.type,
      className: 'rich-channel-fallback-item',
      style: itemStyle,
    },
    React.createElement(
      'div',
      { className: 'rich-channel-fallback-title', style: titleStyle },
      getVariantTitle(item.type),
    ),
    React.createElement(
      'div',
      { className: 'rich-channel-fallback-body', style: bodyStyle },
      getVariantBody(item),
    ),
  );
}

function renderItemDOM(item: ChannelFallbackItem): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-channel-fallback-item';
  Object.assign(wrapper.style, itemStyle);

  const title = document.createElement('div');
  title.className = 'rich-channel-fallback-title';
  Object.assign(title.style, titleStyle);
  title.textContent = getVariantTitle(item.type);
  wrapper.appendChild(title);

  const body = document.createElement('div');
  body.className = 'rich-channel-fallback-body';
  Object.assign(body.style, bodyStyle);
  body.textContent = getVariantBody(item);
  wrapper.appendChild(body);

  return wrapper;
}

const channelFallbackRenderer: TemplateRenderer<ChannelFallbackData> = {
  type: 'channel_fallback',

  extract(message: Message): ChannelFallbackData | undefined {
    const items: ChannelFallbackItem[] = [];

    for (const type of WEB_FALLBACK_RICH_CONTENT_TYPES) {
      const payload = message.richContent?.[type];
      if (typeof payload !== 'string' || payload.trim().length === 0) {
        continue;
      }

      items.push({
        type,
        preview: extractStructuredTextPreview(payload),
      });
    }

    return items.length > 0 ? { items } : undefined;
  },

  render(data: ChannelFallbackData, _ctx: TemplateContext): React.ReactElement {
    return React.createElement(
      'div',
      {
        className: 'rich-channel-fallback',
        role: 'note',
        'aria-label': getString('channelFallback.label'),
        style: containerStyle,
      },
      ...data.items.map(renderItemReact),
    );
  },

  renderDOM(data: ChannelFallbackData, _ctx: TemplateContext): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rich-channel-fallback';
    container.setAttribute('role', 'note');
    container.setAttribute('aria-label', getString('channelFallback.label'));
    Object.assign(container.style, containerStyle);

    for (const item of data.items) {
      container.appendChild(renderItemDOM(item));
    }

    return container;
  },
};

defaultRegistry.register(channelFallbackRenderer);

export { channelFallbackRenderer };
