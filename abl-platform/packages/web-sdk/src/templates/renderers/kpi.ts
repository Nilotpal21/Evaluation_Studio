/**
 * KPI Template Renderer
 *
 * Renders a KPI card with label, value, optional unit, trend arrow, and icon.
 */

import React from 'react';
import type { Message, KPITemplate } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { isSafeUrl } from '../utils/safe-url.js';
import { getString } from '../utils/strings.js';

/** Map trend to arrow character */
function trendArrow(trend?: 'up' | 'down' | 'flat'): string {
  switch (trend) {
    case 'up':
      return '\u2191';
    case 'down':
      return '\u2193';
    case 'flat':
      return '\u2192';
    default:
      return '';
  }
}

/** Map trend to CSS modifier class */
function trendClass(trend?: 'up' | 'down' | 'flat'): string {
  switch (trend) {
    case 'up':
      return 'rich-kpi-trend-up';
    case 'down':
      return 'rich-kpi-trend-down';
    case 'flat':
      return 'rich-kpi-trend-flat';
    default:
      return '';
  }
}

const kpiRenderer: TemplateRenderer<KPITemplate> = {
  type: 'kpi',

  extract(message: Message): KPITemplate | undefined {
    return message.richContent?.kpi;
  },

  render(data: KPITemplate, _ctx: TemplateContext): React.ReactElement {
    const children: React.ReactElement[] = [];

    if (data.icon_url && isSafeUrl(data.icon_url, { allowDataImages: true })) {
      children.push(
        React.createElement('img', {
          key: 'icon',
          className: 'rich-kpi-icon',
          src: data.icon_url,
          alt: '',
          'aria-hidden': 'true',
        }),
      );
    }

    children.push(
      React.createElement('div', { key: 'label', className: 'rich-kpi-label' }, data.label),
    );

    const valueText = data.unit ? `${data.value} ${data.unit}` : String(data.value);
    children.push(
      React.createElement('div', { key: 'value', className: 'rich-kpi-value' }, valueText),
    );

    if (data.trend) {
      children.push(
        React.createElement(
          'div',
          {
            key: 'trend',
            className: `rich-kpi-trend ${trendClass(data.trend)}`,
            'aria-label': `${getString('kpi.trend')}: ${data.trend}`,
          },
          trendArrow(data.trend),
        ),
      );
    }

    return React.createElement(
      'div',
      { className: 'rich-kpi', role: 'group', 'aria-label': `${data.label}: ${valueText}` },
      ...children,
    );
  },

  renderDOM(data: KPITemplate, _ctx: TemplateContext): HTMLElement {
    const card = document.createElement('div');
    card.className = 'rich-kpi';
    card.setAttribute('role', 'group');
    const valueText = data.unit ? `${data.value} ${data.unit}` : String(data.value);
    card.setAttribute('aria-label', `${data.label}: ${valueText}`);

    if (data.icon_url && isSafeUrl(data.icon_url, { allowDataImages: true })) {
      const icon = document.createElement('img');
      icon.className = 'rich-kpi-icon';
      icon.src = data.icon_url;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      card.appendChild(icon);
    }

    const label = document.createElement('div');
    label.className = 'rich-kpi-label';
    label.textContent = data.label;
    card.appendChild(label);

    const value = document.createElement('div');
    value.className = 'rich-kpi-value';
    value.textContent = valueText;
    card.appendChild(value);

    if (data.trend) {
      const trend = document.createElement('div');
      trend.className = `rich-kpi-trend ${trendClass(data.trend)}`;
      trend.textContent = trendArrow(data.trend);
      trend.setAttribute('aria-label', `${getString('kpi.trend')}: ${data.trend}`);
      card.appendChild(trend);
    }

    return card;
  },
};

defaultRegistry.register(kpiRenderer);

export { kpiRenderer };
